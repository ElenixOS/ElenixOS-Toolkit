import { SerialPort } from 'serialport';
import type { YModemTransport } from './ymodem';

const ESH_CTRL_C = 0x03;
const ESH_CTRL_U = 0x15;
const ESH_YMODEM_CANCEL = 0x18;
const ESH_ESCAPE = 0x1b;
const ESH_ARROW_RIGHT = 0x43;
const ESH_BACKSPACE = 0x08;
const ESH_LINE_CAPACITY = 127;
const ESH_CLEAR_CHUNK_SIZE = 16;
const ESH_CLEAR_CHUNK_DELAY_MS = 5;

export type UartPortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

export async function listUartPorts(): Promise<UartPortInfo[]> {
	return SerialPort.list();
}

/**
 * Cancel a stale YMODEM session, clear the ESH editable line, and start a
 * receive command. Ctrl-C/Ctrl-U are supported by current ESH builds; the
 * cursor-editing sequence remains as a compatibility fallback for older ones.
 */
export async function sendEshYModemReceiveCommand(transport: YModemTransport, destinationPath: string): Promise<void> {
	if (!destinationPath || /[\u0000\r\n\t ]/.test(destinationPath)) {
		throw new Error('The ESH receive path must not contain whitespace or control characters.');
	}

	/* Ctrl-C aborts a current ESH/YMODEM operation. CAN CAN preserves the same
	 * cancellation behavior on older firmware, while Ctrl-U clears command mode. */
	await transport.write(Buffer.from([ESH_CTRL_C]));
	await delay(10);
	await transport.write(Buffer.from([ESH_YMODEM_CANCEL, ESH_YMODEM_CANCEL]));
	await delay(10);
	await transport.write(Buffer.from([ESH_CTRL_U]));
	await delay(10);

	const moveToEnd = Buffer.alloc(ESH_LINE_CAPACITY * 3);
	for (let index = 0; index < ESH_LINE_CAPACITY; index++) {
		const offset = index * 3;
		moveToEnd[offset] = ESH_ESCAPE;
		moveToEnd[offset + 1] = 0x5b;
		moveToEnd[offset + 2] = ESH_ARROW_RIGHT;
	}
	await writeInChunks(transport, moveToEnd);
	await writeInChunks(transport, Buffer.alloc(ESH_LINE_CAPACITY, ESH_BACKSPACE));
	await transport.write(Buffer.from(`ymodem recv ${destinationPath}\r`, 'utf8'));
}

async function writeInChunks(transport: YModemTransport, data: Buffer): Promise<void> {
	for (let offset = 0; offset < data.length; offset += ESH_CLEAR_CHUNK_SIZE) {
		await transport.write(data.subarray(offset, offset + ESH_CLEAR_CHUNK_SIZE));
		if (offset + ESH_CLEAR_CHUNK_SIZE < data.length) await delay(ESH_CLEAR_CHUNK_DELAY_MS);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A raw UART byte transport used by the YMODEM sender. */
export class UartTransport implements YModemTransport {
	private readonly listeners = new Set<(data: Buffer) => void>();
	private readonly port: SerialPort;

	constructor(readonly path: string, readonly baudRate: number) {
		this.port = new SerialPort({ path, baudRate, autoOpen: false });
		this.port.on('data', (data: Buffer) => {
			for (const listener of this.listeners) listener(data);
		});
		/* Keep device errors from becoming uncaught EventEmitter errors. Individual
		 * open/write operations also install a one-shot listener and reject. */
		this.port.on('error', () => undefined);
	}

	open(): Promise<void> {
		if (this.port.isOpen) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.port.open((error) => error ? reject(error) : resolve());
		});
	}

	write(data: Buffer): Promise<void> {
		if (!this.port.isOpen) return Promise.reject(new Error(`UART is not open: ${this.path}`));
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => { this.port.off('error', onError); };
			const finish = (error?: Error | null): void => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else this.port.drain((drainError) => drainError ? reject(drainError) : resolve());
			};
			const onError = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};

			this.port.once('error', onError);
			try {
				this.port.write(data, finish);
			}
			catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	onData(listener: (data: Buffer) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): Promise<void> {
		if (!this.port.isOpen) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.port.close((error) => error ? reject(error) : resolve());
		});
	}
}
