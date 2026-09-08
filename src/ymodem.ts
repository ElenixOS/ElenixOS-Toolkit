import * as fs from 'node:fs';
import * as path from 'node:path';

export const YMODEM_CRC = 0x43;
export const YMODEM_SOH = 0x01;
export const YMODEM_STX = 0x02;
export const YMODEM_EOT = 0x04;
export const YMODEM_ACK = 0x06;
export const YMODEM_NAK = 0x15;
export const YMODEM_CAN = 0x18;

const HEADER_DATA_SIZE = 128;
const PACKET_DATA_SIZE = 1024;
const PACKET_SIZE = PACKET_DATA_SIZE + 5;
const HEADER_PACKET_SIZE = HEADER_DATA_SIZE + 5;
const PADDING = 0x1a;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RETRIES = 10;
const UINT32_MAX = 0xffffffff;

export interface YModemFile {
	readonly sourcePath: string;
	readonly transferName: string;
	readonly size: number;
}

export interface YModemTransport {
	write(data: Buffer): Promise<void>;
	onData(listener: (data: Buffer) => void): () => void;
}

export interface YModemProgress {
	readonly file: YModemFile;
	readonly fileIndex: number;
	readonly fileCount: number;
	readonly bytesSent: number;
	readonly totalBytes: number;
}

export interface YModemSenderOptions {
	readonly timeoutMs?: number;
	readonly maxRetries?: number;
	onProgress?: (progress: YModemProgress) => void;
}

/** Collect regular files in deterministic YMODEM batch order. */
export async function collectYModemFiles(inputPaths: readonly string[]): Promise<YModemFile[]> {
	const files: YModemFile[] = [];
	const transferNames = new Set<string>();

	for (const inputPath of inputPaths) {
		const absolutePath = path.resolve(inputPath);
		await collectPath(absolutePath, path.basename(absolutePath), files, transferNames);
	}

	if (files.length === 0) {
		throw new Error('The selected folder does not contain any regular files.');
	}
	return files;
}

async function collectPath(
	sourcePath: string,
	transferName: string,
	files: YModemFile[],
	transferNames: Set<string>,
): Promise<void> {
	const info = await fs.promises.lstat(sourcePath);
	if (info.isSymbolicLink()) {
		throw new Error(`Symbolic links are not supported: ${sourcePath}`);
	}

	if (info.isFile()) {
		if (!Number.isSafeInteger(info.size) || info.size > UINT32_MAX) {
			throw new Error(`File is too large for YMODEM: ${sourcePath}`);
		}
		if (transferName.length === 0 || transferName.includes('\0') || transferNames.has(transferName)) {
			throw new Error(`Duplicate or invalid transfer name: ${transferName}`);
		}
		transferNames.add(transferName);
		files.push({ sourcePath, transferName: transferName.replaceAll(path.sep, '/'), size: info.size });
		return;
	}

	if (!info.isDirectory()) {
		throw new Error(`Unsupported file type: ${sourcePath}`);
	}

	const entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		await collectPath(
			path.join(sourcePath, entry.name),
			path.posix.join(transferName, entry.name),
			files,
			transferNames,
		);
	}
}

function crc16(data: Uint8Array): number {
	let crc = 0;
	for (const value of data) {
		crc ^= value << 8;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
		}
	}
	return crc;
}

function createPacket(startByte: number, block: number, data: Uint8Array, dataSize: number): Buffer {
	const packet = Buffer.alloc(dataSize + 5, startByte === YMODEM_SOH ? 0 : PADDING);
	packet[0] = startByte;
	packet[1] = block & 0xff;
	packet[2] = (~block) & 0xff;
	Buffer.from(data).subarray(0, dataSize).copy(packet, 3);
	const crc = crc16(packet.subarray(3, 3 + dataSize));
	packet.writeUInt16BE(crc, 3 + dataSize);
	return packet;
}

function createHeader(file?: YModemFile): Buffer {
	const data = Buffer.alloc(HEADER_DATA_SIZE);
	if (file) {
		const name = Buffer.from(file.transferName, 'utf8');
		const size = Buffer.from(String(file.size), 'ascii');
		if (name.length + 1 + size.length + 1 > HEADER_DATA_SIZE) {
			throw new Error(`YMODEM header is too small for: ${file.transferName}`);
		}
		name.copy(data, 0);
		size.copy(data, name.length + 1);
	}
	return createPacket(YMODEM_SOH, 0, data, HEADER_DATA_SIZE);
}

class ControlByteQueue {
	private readonly bytes: number[] = [];
	private readonly waiters: Array<{
		readonly accepted: readonly number[];
		readonly resolve: (value: number) => void;
		readonly reject: (error: Error) => void;
		readonly timer: NodeJS.Timeout;
	}> = [];

	constructor(transport: YModemTransport) {
		this.unsubscribe = transport.onData((data) => this.push(data));
	}

	private readonly unsubscribe: () => void;

	waitFor(accepted: readonly number[], timeoutMs: number): Promise<number> {
		const immediate = this.take(accepted);
		if (immediate !== undefined) return Promise.resolve(immediate);

		return new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error(`Timed out waiting for YMODEM control byte (${accepted.map((value) => `0x${value.toString(16)}`).join(', ')})`));
			}, timeoutMs);
			this.waiters.push({ accepted, resolve, reject, timer });
		});
	}

	dispose(): void {
		this.unsubscribe();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error('YMODEM transport closed'));
		}
		this.waiters.length = 0;
		this.bytes.length = 0;
	}

	private push(data: Buffer): void {
		for (const value of data) this.bytes.push(value);
		this.resolveWaiter();
	}

	private resolveWaiter(): void {
		const waiter = this.waiters[0];
		if (!waiter) return;
		const index = this.bytes.findIndex((value) => waiter.accepted.includes(value));
		if (index < 0) return;
		const value = this.bytes[index];
		this.bytes.splice(0, index + 1);
		this.waiters.shift();
		clearTimeout(waiter.timer);
		waiter.resolve(value);
	}

	private take(accepted: readonly number[]): number | undefined {
		const index = this.bytes.findIndex((value) => accepted.includes(value));
		if (index < 0) return undefined;
		const value = this.bytes[index];
		this.bytes.splice(0, index + 1);
		return value;
	}

	clear(): void {
		this.bytes.length = 0;
	}
}

export class YModemSender {
	private readonly timeoutMs: number;
	private readonly maxRetries: number;

	constructor(private readonly options: YModemSenderOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	}

	async send(files: readonly YModemFile[], transport: YModemTransport, prepare?: () => Promise<void>): Promise<void> {
		if (files.length === 0) throw new Error('No files selected for YMODEM transfer.');
		const queue = new ControlByteQueue(transport);
		try {
			queue.clear();
			await prepare?.();
			await queue.waitFor([YMODEM_CRC, YMODEM_NAK], this.timeoutMs);
			const totalBytes = files.reduce((total, file) => total + file.size, 0);
			let sentBytes = 0;

			for (let index = 0; index < files.length; index++) {
				const file = files[index];
				await this.sendPacketWithAck(createHeader(file), transport, queue);
				await queue.waitFor([YMODEM_CRC, YMODEM_NAK], this.timeoutMs);
				sentBytes = await this.sendFile(file, index, files.length, totalBytes, sentBytes, transport, queue);
				await this.sendEot(transport, queue);
				if (index + 1 < files.length) {
					await queue.waitFor([YMODEM_CRC, YMODEM_NAK], this.timeoutMs);
				} else if (files.length === 1 && await this.waitForOptionalEndSignal(queue)) {
					/* Simple ESH receivers finish after the EOT ACK. Standard YMODEM
					 * receivers may request the final empty header instead. */
					await this.sendPacketWithAck(createHeader(), transport, queue);
				}
			}

			if (files.length > 1) await this.sendPacketWithAck(createHeader(), transport, queue);
		} catch (error) {
			await transport.write(Buffer.from([YMODEM_CAN, YMODEM_CAN])).catch(() => undefined);
			throw error;
		} finally {
			queue.dispose();
		}
	}

	private async sendFile(
		file: YModemFile,
		fileIndex: number,
		fileCount: number,
		totalBytes: number,
		sentBytes: number,
		transport: YModemTransport,
		queue: ControlByteQueue,
	): Promise<number> {
		const handle = await fs.promises.open(file.sourcePath, 'r');
		let offset = 0;
		let block = 1;
		try {
			while (offset < file.size) {
				const buffer = Buffer.alloc(PACKET_DATA_SIZE);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
				if (bytesRead === 0) throw new Error(`File changed while sending: ${file.sourcePath}`);
				await this.sendPacketWithAck(createPacket(YMODEM_STX, block, buffer.subarray(0, bytesRead), PACKET_DATA_SIZE), transport, queue);
				offset += bytesRead;
				sentBytes += bytesRead;
				this.options.onProgress?.({ file, fileIndex, fileCount, bytesSent: sentBytes, totalBytes });
				block = (block + 1) & 0xff;
			}
			return sentBytes;
		} finally {
			await handle.close();
		}
	}

	private async sendPacketWithAck(packet: Buffer, transport: YModemTransport, queue: ControlByteQueue): Promise<void> {
		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			await transport.write(packet);
			const response = await queue.waitFor([YMODEM_ACK, YMODEM_NAK], this.timeoutMs);
			if (response === YMODEM_ACK) return;
		}
		throw new Error('YMODEM receiver did not acknowledge the packet.');
	}

	private async sendEot(transport: YModemTransport, queue: ControlByteQueue): Promise<void> {
		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			await transport.write(Buffer.from([YMODEM_EOT]));
			const response = await queue.waitFor([YMODEM_ACK, YMODEM_NAK], this.timeoutMs);
			if (response === YMODEM_ACK) return;
			await transport.write(Buffer.from([YMODEM_EOT]));
			const secondResponse = await queue.waitFor([YMODEM_ACK, YMODEM_NAK], this.timeoutMs);
			if (secondResponse === YMODEM_ACK) return;
		}
		throw new Error('YMODEM receiver did not finish the file.');
	}

	private async waitForOptionalEndSignal(queue: ControlByteQueue): Promise<boolean> {
		try {
			await queue.waitFor([YMODEM_CRC, YMODEM_NAK], Math.min(this.timeoutMs, 250));
			return true;
		}
		catch {
			return false;
		}
	}
}
