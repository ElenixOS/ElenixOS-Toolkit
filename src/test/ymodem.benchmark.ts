import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
	YMODEM_ACK,
	YMODEM_CRC,
	YMODEM_EOT,
	YMODEM_NAK,
	YMODEM_SOH,
	YMODEM_STX,
	YModemSender,
	type YModemTransport,
} from '../ymodem';

const BAUD_RATE = 921600;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class WireRateReceiver implements YModemTransport {
	private readonly listeners = new Set<(data: Buffer) => void>();
	private eotCount = 0;

	start(): void {
		this.emit(Buffer.from([YMODEM_CRC]));
	}

	async write(data: Buffer): Promise<void> {
		/* 8N1 sends ten wire bits per byte. The delay models a real UART wire,
		 * while ACK generation remains immediate after the packet arrives. */
		await sleep(Math.ceil(data.length * 10_000 / BAUD_RATE));
		if (data[0] === YMODEM_EOT) {
			this.eotCount++;
			this.emit(Buffer.from(this.eotCount === 1 ? [YMODEM_NAK] : [YMODEM_ACK, YMODEM_CRC]));
			return;
		}
		if (data[0] === YMODEM_SOH || data[0] === YMODEM_STX) {
			/* Header and data are accepted as a wire-throughput benchmark. The
			 * protocol tests cover CRC, complement, padding, retries and size. */
			this.emit(Buffer.from(data[0] === YMODEM_SOH ? [YMODEM_ACK, YMODEM_CRC] : [YMODEM_ACK]));
		}
	}

	onData(listener: (data: Buffer) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(data: Buffer): void {
		for (const listener of this.listeners) {listener(data);}
	}
}

async function main(): Promise<void> {
	const size = 1024 * 1024;
	const directory = await mkdtemp(join(tmpdir(), 'elenixos-ymodem-benchmark-'));
	const sourcePath = join(directory, 'benchmark.bin');
	await writeFile(sourcePath, Buffer.alloc(size, 0xa5));
	try {
		const receiver = new WireRateReceiver();
		const startedAt = performance.now();
		const stats = await new YModemSender({ timeoutMs: 1000 }).send(
			[{ sourcePath, transferName: 'benchmark.bin', size }],
			receiver,
			async () => receiver.start(),
		);
		const wallMs = performance.now() - startedAt;
		console.log(JSON.stringify({
			baudRate: BAUD_RATE,
			blockSize: 1024,
			fileSize: stats.totalBytes,
			elapsedMs: Math.round(wallMs),
			throughputKBps: Number((stats.totalBytes / wallMs).toFixed(2)),
			blocks: stats.blockCount,
			retransmissions: stats.retransmissionCount,
			crcOrDataBlockNaks: stats.crcErrorCount,
			timeouts: stats.timeoutCount,
		}));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
