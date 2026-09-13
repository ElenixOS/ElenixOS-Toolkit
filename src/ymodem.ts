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
/* Flash-backed receivers may pause while committing a packet. Match the
 * receiver-side transfer tools and allow that pause before retrying. */
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 10;
const MAX_CONTROL_QUEUE_BYTES = 4096;
const UINT32_MAX = 0xffffffff;

export interface YModemFile {
	readonly sourcePath: string;
	readonly transferName: string;
	readonly size: number;
}

export interface YModemTransport {
	write(data: Buffer): Promise<void>;
	onData(listener: (data: Buffer) => void): () => void;
	/** Serialize the whole protocol session when the physical transport is shared. */
	runExclusive?<T>(action: () => Promise<T>): Promise<T>;
}

export interface YModemProgress {
	readonly file: YModemFile;
	readonly fileIndex: number;
	readonly fileCount: number;
	readonly bytesSent: number;
	readonly totalBytes: number;
	readonly elapsedMs: number;
	readonly bytesPerSecond: number;
	readonly blockCount: number;
	readonly retransmissionCount: number;
	/** Data-block NAKs; standard YMODEM does not encode the receiver's reason. */
	readonly crcErrorCount: number;
	readonly timeoutCount: number;
}

export interface YModemTransferStats {
	readonly totalBytes: number;
	readonly elapsedMs: number;
	readonly bytesPerSecond: number;
	readonly blockCount: number;
	readonly retransmissionCount: number;
	readonly crcErrorCount: number;
	readonly timeoutCount: number;
	readonly nakCount: number;
}

export interface YModemSenderOptions {
	readonly timeoutMs?: number;
	readonly maxRetries?: number;
	readonly control?: YModemTransferControl;
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

function isControlByteTimeout(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('Timed out waiting for YMODEM control byte');
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
		readonly cleanup: () => void;
	}> = [];

	constructor(transport: YModemTransport) {
		this.unsubscribe = transport.onData((data) => this.push(data));
	}

	private readonly unsubscribe: () => void;

	waitFor(accepted: readonly number[], timeoutMs: number, signal?: AbortSignal): Promise<number> {
		if (signal?.aborted) {return Promise.reject(new Error('YMODEM transfer terminated by user.'));}
		const immediate = this.take(accepted);
		if (immediate !== undefined) {return Promise.resolve(immediate);}

		return new Promise<number>((resolve, reject) => {
			let waiter: (typeof this.waiters)[number];
			const cleanup = (): void => {
				clearTimeout(waiter.timer);
				if (signal) {signal.removeEventListener('abort', onAbort);}
			};
			const onAbort = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index < 0) {return;}
				this.waiters.splice(index, 1);
				cleanup();
				reject(new Error('YMODEM transfer terminated by user.'));
			};
			const timer = setTimeout(() => {
				const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
				if (index >= 0) {
					this.waiters.splice(index, 1);
					cleanup();
				}
				reject(new Error(`Timed out waiting for YMODEM control byte (${accepted.map((value) => `0x${value.toString(16)}`).join(', ')})`));
			}, timeoutMs);
			waiter = { accepted, resolve, reject, timer, cleanup };
			this.waiters.push(waiter);
			if (signal) {signal.addEventListener('abort', onAbort, { once: true });}
		});
	}

	dispose(): void {
		this.unsubscribe();
		for (const waiter of this.waiters) {
			waiter.cleanup();
			waiter.reject(new Error('YMODEM transport closed'));
		}
		this.waiters.length = 0;
		this.bytes.length = 0;
	}

	private push(data: Buffer): void {
		if (data.length >= MAX_CONTROL_QUEUE_BYTES) {
			this.bytes.length = 0;
			for (const value of data.subarray(data.length - MAX_CONTROL_QUEUE_BYTES)) {this.bytes.push(value);}
		} else {
			for (const value of data) {this.bytes.push(value);}
			if (this.bytes.length > MAX_CONTROL_QUEUE_BYTES) {
				this.bytes.splice(0, this.bytes.length - MAX_CONTROL_QUEUE_BYTES);
			}
		}
		this.resolveWaiter();
	}

	private resolveWaiter(): void {
		const waiter = this.waiters[0];
		if (!waiter) {return;}
		const index = this.bytes.findIndex((value) => waiter.accepted.includes(value));
		if (index < 0) {return;}
		const value = this.bytes[index];
		this.bytes.splice(0, index + 1);
		this.waiters.shift();
		waiter.cleanup();
		waiter.resolve(value);
	}

	private take(accepted: readonly number[]): number | undefined {
		const index = this.bytes.findIndex((value) => accepted.includes(value));
		if (index < 0) {return undefined;}
		const value = this.bytes[index];
		this.bytes.splice(0, index + 1);
		return value;
	}

	clear(): void {
		this.bytes.length = 0;
	}
}

export class YModemTransferControl {
	private readonly abortController = new AbortController();
	private readonly pauseWaiters = new Set<() => void>();
	private paused = false;
	private terminated = false;

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	get isTerminated(): boolean {
		return this.terminated;
	}

	pause(): void {
		if (!this.terminated) {this.paused = true;}
	}

	resume(): void {
		if (this.terminated) {return;}
		this.paused = false;
		for (const resolve of this.pauseWaiters) {resolve();}
		this.pauseWaiters.clear();
	}

	togglePause(): void {
		if (this.isPaused) {this.resume();}
		else {this.pause();}
	}

	terminate(): void {
		if (this.terminated) {return;}
		this.terminated = true;
		this.paused = false;
		this.abortController.abort();
	}

	throwIfTerminated(): void {
		if (this.terminated) {throw new Error('YMODEM transfer terminated by user.');}
	}

	async waitIfResumed(): Promise<void> {
		this.throwIfTerminated();
		if (!this.paused) {return;}
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				this.pauseWaiters.delete(onResume);
				reject(new Error('YMODEM transfer terminated by user.'));
			};
			const onResume = (): void => {
				this.pauseWaiters.delete(onResume);
				this.signal.removeEventListener('abort', onAbort);
				resolve();
			};
			this.pauseWaiters.add(onResume);
			this.signal.addEventListener('abort', onAbort, { once: true });
		});
		this.throwIfTerminated();
	}
}

export class YModemSender {
	private readonly timeoutMs: number;
	private readonly maxRetries: number;

	constructor(private readonly options: YModemSenderOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	}

	async send(files: readonly YModemFile[], transport: YModemTransport, prepare?: () => Promise<void>): Promise<YModemTransferStats> {
		if (transport.runExclusive) {
			return transport.runExclusive(() => this.sendUnlocked(files, transport, prepare));
		}
		return this.sendUnlocked(files, transport, prepare);
	}

	private async sendUnlocked(files: readonly YModemFile[], transport: YModemTransport, prepare?: () => Promise<void>): Promise<YModemTransferStats> {
		if (files.length === 0) {throw new Error('No files selected for YMODEM transfer.');}
		this.options.control?.throwIfTerminated();
		const queue = new ControlByteQueue(transport);
		try {
			queue.clear();
			await prepare?.();
			/* The automatic ESH preparation echoes Ctrl-U as 0x15.  When a
			 * preparation callback is used, only accept the receiver's CRC
			 * handshake here so that the echoed byte cannot be mistaken for NAK. */
			const initialControlBytes = prepare ? [YMODEM_CRC, YMODEM_CAN] : [YMODEM_CRC, YMODEM_NAK, YMODEM_CAN];
			const initialResponse = await queue.waitFor(initialControlBytes, this.timeoutMs, this.options.control?.signal);
			if (initialResponse === YMODEM_CAN) {throw new Error('YMODEM receiver cancelled transfer.');}
			const totalBytes = files.reduce((total, file) => total + file.size, 0);
			let sentBytes = 0;
			const startedAt = Date.now();
			const stats = {
				blockCount: 0,
				retransmissionCount: 0,
				crcErrorCount: 0,
				timeoutCount: 0,
				nakCount: 0,
			};

			for (let index = 0; index < files.length; index++) {
				const file = files[index];
				await this.options.control?.waitIfResumed();
				await this.sendPacketWithAck(createHeader(file), transport, queue, `header for ${file.transferName}`, stats);
				const nextResponse = await queue.waitFor([YMODEM_CRC, YMODEM_NAK, YMODEM_CAN], this.timeoutMs, this.options.control?.signal);
				if (nextResponse === YMODEM_CAN) {throw new Error('YMODEM receiver cancelled transfer.');}
				sentBytes = await this.sendFile(file, index, files.length, totalBytes, sentBytes, transport, queue, startedAt, stats);
				await this.sendEot(transport, queue, stats);
				if (index + 1 < files.length) {
					const nextResponse = await queue.waitFor([YMODEM_CRC, YMODEM_NAK, YMODEM_CAN], this.timeoutMs, this.options.control?.signal);
					if (nextResponse === YMODEM_CAN) {throw new Error('YMODEM receiver cancelled transfer.');}
				} else if (files.length === 1 && await this.waitForOptionalEndSignal(queue)) {
					/* Simple ESH receivers finish after the EOT ACK. Standard YMODEM
					 * receivers may request the final empty header instead. */
					await this.options.control?.waitIfResumed();
					await this.sendPacketWithAck(createHeader(), transport, queue, 'end-of-batch header', stats);
				}
			}

			if (files.length > 1) {
				await this.options.control?.waitIfResumed();
				await this.sendPacketWithAck(createHeader(), transport, queue, 'end-of-batch header', stats);
			}

			const elapsedMs = Math.max(1, Date.now() - startedAt);
			return {
				totalBytes,
				elapsedMs,
				bytesPerSecond: sentBytes * 1000 / elapsedMs,
				...stats,
			};
		} catch (error) {
			/* Abort even if the receiver is currently assembling a partial
			 * packet.  CAN CAN is the standard YMODEM cancel sequence; Ctrl-C
			 * is the ESH-compatible escape for a parser that has not yet
			 * returned to packet-idle state. */
			await transport.write(Buffer.from([YMODEM_CAN, YMODEM_CAN])).catch(() => undefined);
			await transport.write(Buffer.from([0x03])).catch(() => undefined);
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
		startedAt: number,
		stats: { blockCount: number; retransmissionCount: number; crcErrorCount: number; timeoutCount: number; nakCount: number },
	): Promise<number> {
		const handle = await fs.promises.open(file.sourcePath, 'r');
		let offset = 0;
		let block = 1;
		try {
			while (offset < file.size) {
				await this.options.control?.waitIfResumed();
				const buffer = Buffer.alloc(PACKET_DATA_SIZE);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
				if (bytesRead === 0) {throw new Error(`File changed while sending: ${file.sourcePath}`);}
				await this.sendPacketWithAck(
					createPacket(YMODEM_STX, block, buffer.subarray(0, bytesRead), PACKET_DATA_SIZE),
						transport,
						queue,
					`data block ${block} for ${file.transferName}`,
					stats,
					);
				stats.blockCount++;
				offset += bytesRead;
				sentBytes += bytesRead;
				const elapsedMs = Math.max(1, Date.now() - startedAt);
				this.options.onProgress?.({
					file,
					fileIndex,
					fileCount,
					bytesSent: sentBytes,
					totalBytes,
					elapsedMs,
					bytesPerSecond: sentBytes * 1000 / elapsedMs,
					blockCount: stats.blockCount,
					retransmissionCount: stats.retransmissionCount,
					crcErrorCount: stats.crcErrorCount,
					timeoutCount: stats.timeoutCount,
				});
				block = (block + 1) & 0xff;
			}
			return sentBytes;
		} finally {
			await handle.close();
		}
	}

	private async sendPacketWithAck(
		packet: Buffer,
		transport: YModemTransport,
		queue: ControlByteQueue,
		description: string,
		stats: { blockCount: number; retransmissionCount: number; crcErrorCount: number; timeoutCount: number; nakCount: number },
	): Promise<void> {
		let lastResult = 'timeout';
		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			await this.options.control?.waitIfResumed();
			if (attempt > 0) {stats.retransmissionCount++;}
			await transport.write(packet);
			try {
				const response = await queue.waitFor([YMODEM_ACK, YMODEM_NAK, YMODEM_CAN], this.timeoutMs, this.options.control?.signal);
				if (response === YMODEM_ACK) {return;}
				if (response === YMODEM_CAN) {throw new Error('YMODEM receiver cancelled transfer.');}
				lastResult = 'NAK';
				stats.nakCount++;
				if (packet[0] === YMODEM_STX) {stats.crcErrorCount++;}
			}
			catch (error) {
				if (!isControlByteTimeout(error)) {throw error;}
				lastResult = 'timeout';
				stats.timeoutCount++;
			}
		}
		throw new Error(`YMODEM receiver did not acknowledge ${description} after ${this.maxRetries} attempts (last result: ${lastResult}).`);
	}

	private async sendEot(
		transport: YModemTransport,
		queue: ControlByteQueue,
		stats: { blockCount: number; retransmissionCount: number; crcErrorCount: number; timeoutCount: number; nakCount: number },
	): Promise<void> {
		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			await this.options.control?.waitIfResumed();
			if (attempt > 0) {stats.retransmissionCount++;}
			await transport.write(Buffer.from([YMODEM_EOT]));
			try {
				const response = await queue.waitFor([YMODEM_ACK, YMODEM_NAK, YMODEM_CAN], this.timeoutMs, this.options.control?.signal);
				if (response === YMODEM_ACK) {return;}
				if (response === YMODEM_CAN) {throw new Error('YMODEM receiver cancelled transfer.');}
				stats.nakCount++;
			}
			catch (error) {
				if (!isControlByteTimeout(error)) {throw error;}
				stats.timeoutCount++;
			}
			await this.options.control?.waitIfResumed();
			await transport.write(Buffer.from([YMODEM_EOT]));
			try {
				const secondResponse = await queue.waitFor([YMODEM_ACK, YMODEM_NAK, YMODEM_CAN], this.timeoutMs, this.options.control?.signal);
				if (secondResponse === YMODEM_ACK) {return;}
				if (secondResponse === YMODEM_CAN) {throw new Error('YMODEM receiver cancelled transfer.');}
				stats.nakCount++;
			}
			catch (error) {
				if (!isControlByteTimeout(error)) {throw error;}
				stats.timeoutCount++;
			}
		}
		throw new Error('YMODEM receiver did not finish the file.');
	}

	private async waitForOptionalEndSignal(queue: ControlByteQueue): Promise<boolean> {
		try {
			await queue.waitFor([YMODEM_CRC, YMODEM_NAK], Math.min(this.timeoutMs, 250), this.options.control?.signal);
			return true;
		} catch (error) {
			if (!isControlByteTimeout(error)) {throw error;}
			return false;
		}
	}
}
