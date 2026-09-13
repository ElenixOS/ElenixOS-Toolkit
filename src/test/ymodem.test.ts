import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	YMODEM_ACK,
	YMODEM_CAN,
	YMODEM_CRC,
	YMODEM_EOT,
	YMODEM_NAK,
	YMODEM_SOH,
	YMODEM_STX,
	YModemSender,
	YModemTransferControl,
	type YModemFile,
	type YModemTransport,
} from '../ymodem';

interface ReceiverOptions {
	corruptFirstDataBlock?: boolean;
	delayAckMs?: number;
	dropFirstDataBlock?: boolean;
	duplicateFirstDataBlock?: boolean;
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

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class LoopbackReceiver implements YModemTransport {
	private readonly listeners = new Set<(data: Buffer) => void>();
	private expectedBlock = 1;
	private currentSize = 0;
	private currentData = Buffer.alloc(0);
	private eotCount = 0;
	private fileCount = 0;
	private started = false;
	private corrupted = false;
	private dropped = false;
	private duplicated = false;
	readonly dataBlockLengths: number[] = [];
	readonly receivedFiles: Buffer[] = [];
	readonly writes: Buffer[] = [];

	constructor(private readonly options: ReceiverOptions = {}) {}

	start(): void {
		this.started = true;
		this.emit(Buffer.from([YMODEM_CRC]));
	}

	async write(data: Buffer): Promise<void> {
		this.writes.push(Buffer.from(data));
		if (!this.started) {throw new Error('receiver was not started');}
		if (data.length === 2 && data[0] === YMODEM_CAN && data[1] === YMODEM_CAN) {return;}
		if (data.length === 1 && data[0] === YMODEM_EOT) {
			this.eotCount++;
			if (this.eotCount === 1) {
				this.emit(Buffer.from([YMODEM_NAK]));
			} else {
				this.receivedFiles.push(this.currentData);
				this.eotCount = 0;
				this.fileCount++;
				this.emit(Buffer.from(this.fileCount === 1 ? [YMODEM_ACK] : [YMODEM_ACK, YMODEM_CRC]));
			}
			return;
		}

		if (data[0] !== YMODEM_SOH && data[0] !== YMODEM_STX) {throw new Error(`unexpected byte 0x${data[0]?.toString(16)}`);}
		const expectedLength = data[0] === YMODEM_SOH ? 133 : 1029;
		assert.equal(data.length, expectedLength);
		const dataSize = data[0] === YMODEM_SOH ? 128 : 1024;
		const receivedCrc = data.readUInt16BE(3 + dataSize);
		assert.equal((data[1] + data[2]) & 0xff, 0xff);
		if (crc16(data.subarray(3, 3 + dataSize)) !== receivedCrc) {
			this.emit(Buffer.from([YMODEM_NAK]));
			return;
		}

		if (data[0] === YMODEM_SOH) {
			const zeroHeader = data[3] === 0;
			if (zeroHeader) {
				this.emit(Buffer.from([YMODEM_ACK]));
				return;
			}
			const header = data.subarray(3, 131);
			const nameEnd = header.indexOf(0);
			const sizeStart = nameEnd + 1;
			const sizeEnd = header.indexOf(0, sizeStart);
			this.currentSize = Number(header.subarray(sizeStart, sizeEnd).toString('ascii'));
			this.currentData = Buffer.alloc(0);
			this.expectedBlock = 1;
			this.emit(Buffer.from([YMODEM_ACK, YMODEM_CRC]));
			return;
		}

		this.dataBlockLengths.push(data.length);
		const packet = Buffer.from(data);
		if (this.options.corruptFirstDataBlock && !this.corrupted) {
			this.corrupted = true;
			packet[3] ^= 0xff;
			this.emit(Buffer.from([YMODEM_NAK]));
			return;
		}
		if (this.options.dropFirstDataBlock && !this.dropped) {
			this.dropped = true;
			return;
		}

		const block = packet[1];
		if (block === ((this.expectedBlock - 1) & 0xff)) {
			this.emit(Buffer.from([YMODEM_ACK]));
			return;
		}
		assert.equal(block, this.expectedBlock);
		const remaining = Math.max(0, this.currentSize - this.currentData.length);
		const writeSize = Math.min(remaining, dataSize);
		this.currentData = Buffer.concat([this.currentData, packet.subarray(3, 3 + writeSize)]);
		this.expectedBlock = (this.expectedBlock + 1) & 0xff;
		if (this.options.duplicateFirstDataBlock && !this.duplicated) {
			this.duplicated = true;
			this.emit(Buffer.from([YMODEM_NAK]));
			return;
		}
		if (this.options.delayAckMs) {await sleep(this.options.delayAckMs);}
		this.emit(Buffer.from([YMODEM_ACK]));
	}

	onData(listener: (data: Buffer) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(data: Buffer): void {
		for (const listener of this.listeners) {listener(data);}
	}
}

function createData(size: number): Buffer {
	const data = Buffer.alloc(size);
	for (let index = 0; index < data.length; index++) {data[index] = index & 0xff;}
	return data;
}

async function withFile<T>(size: number, action: (file: YModemFile, expected: Buffer) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), 'elenixos-ymodem-'));
	const sourcePath = join(directory, 'payload.bin');
	const expected = createData(size);
	await writeFile(sourcePath, expected);
	try {
		return await action({ sourcePath, transferName: 'payload.bin', size }, expected);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function sendOne(
	file: YModemFile,
	receiver: LoopbackReceiver,
	options: { timeoutMs?: number; control?: YModemTransferControl; onProgress?: () => void } = {},
) {
	const sender = new YModemSender({
		timeoutMs: options.timeoutMs ?? 50,
		control: options.control,
		onProgress: options.onProgress,
	});
	return sender.send([file], receiver, async () => receiver.start());
}

test('uses standard 1K STX blocks and preserves a short final block', async () => {
	await withFile(2049, async (file, expected) => {
		const receiver = new LoopbackReceiver();
		const stats = await sendOne(file, receiver);
		assert.deepEqual(receiver.receivedFiles[0], expected);
		assert.deepEqual(receiver.dataBlockLengths, [1029, 1029, 1029]);
		assert.equal(stats.blockCount, 3);
		assert.equal(stats.retransmissionCount, 0);
	});
});

test('sends a 1 MB file continuously without retry', async () => {
	await withFile(1024 * 1024, async (file, expected) => {
		const receiver = new LoopbackReceiver();
		const stats = await sendOne(file, receiver);
		assert.deepEqual(receiver.receivedFiles[0], expected);
		assert.equal(stats.blockCount, 1024);
		assert.equal(stats.retransmissionCount, 0);
	});
});

test('sends a multi-megabyte file and supports block number wraparound', async () => {
	await withFile(3 * 1024 * 1024 + 7, async (file, expected) => {
		const receiver = new LoopbackReceiver();
		const stats = await sendOne(file, receiver);
		assert.deepEqual(receiver.receivedFiles[0], expected);
		assert.equal(stats.blockCount, 3073);
		assert.equal(stats.retransmissionCount, 0);
	});
});

test('retries after a CRC rejection and accepts a duplicate block', async () => {
	await withFile(1024, async (file) => {
		const crcReceiver = new LoopbackReceiver({ corruptFirstDataBlock: true });
		const crcStats = await sendOne(file, crcReceiver);
		assert.equal(crcStats.crcErrorCount, 1);
		assert.equal(crcStats.retransmissionCount, 1);

		const duplicateReceiver = new LoopbackReceiver({ duplicateFirstDataBlock: true });
		const duplicateStats = await sendOne(file, duplicateReceiver);
		assert.equal(duplicateStats.retransmissionCount, 1);
		assert.equal(duplicateReceiver.receivedFiles[0]?.length, 1024);
	});
});

test('retries a dropped block and tolerates a delayed receiver', async () => {
	await withFile(2048, async (file) => {
		const droppedReceiver = new LoopbackReceiver({ dropFirstDataBlock: true });
		const droppedStats = await sendOne(file, droppedReceiver, { timeoutMs: 20 });
		assert.equal(droppedStats.timeoutCount, 1);
		assert.equal(droppedStats.retransmissionCount, 1);

		const delayedReceiver = new LoopbackReceiver({ delayAckMs: 15 });
		const delayedStats = await sendOne(file, delayedReceiver, { timeoutMs: 100 });
		assert.equal(delayedStats.retransmissionCount, 0);
	});
});

test('cancels cleanly and sends CAN CAN', async () => {
	await withFile(4096, async (file) => {
		const receiver = new LoopbackReceiver();
		const control = new YModemTransferControl();
		await assert.rejects(
			sendOne(file, receiver, {
				control,
				onProgress: () => control.terminate(),
			}),
			/terminated by user/,
		);
		assert.ok(receiver.writes.some((data) => data.equals(Buffer.from([YMODEM_CAN, YMODEM_CAN]))));
	});
});

test('supports consecutive transfers with fresh protocol state', async () => {
	await withFile(8193, async (file, expected) => {
		for (let index = 0; index < 3; index++) {
			const receiver = new LoopbackReceiver();
			const stats = await sendOne(file, receiver);
			assert.deepEqual(receiver.receivedFiles[0], expected);
			assert.equal(stats.blockCount, 9);
		}
	});
});

test('reports file size, elapsed time, throughput and protocol counters', async () => {
	await withFile(1024, async (file) => {
		const receiver = new LoopbackReceiver();
		const stats = await sendOne(file, receiver);
		assert.equal(stats.totalBytes, 1024);
		assert.ok(stats.elapsedMs >= 1);
		assert.ok(stats.bytesPerSecond > 0);
		assert.equal(stats.nakCount, 1); // The standard EOT handshake starts with NAK.
	});
});

test('rejects malformed receiver controls only through the normal timeout path', async () => {
	const receiver: YModemTransport = {
		async write(): Promise<void> {},
		onData(listener): () => void {
			listener(Buffer.from([0x00]));
			return () => undefined;
		},
	};
	const file = { sourcePath: '/does/not/exist', transferName: 'missing', size: 1 };
	await assert.rejects(new YModemSender({ timeoutMs: 5, maxRetries: 1 }).send([file], receiver), /Timed out/);
});
