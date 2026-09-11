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
/* Conservative defaults for receivers with a small software input queue.
 * They remain configurable because a target may provide hardware flow
 * control or a larger UART queue. */
const DEFAULT_YMODEM_UART_CHUNK_SIZE = 16;
const DEFAULT_YMODEM_UART_CHUNK_DELAY_MS = 20;

export type UartPortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

export interface UartTransportOptions {
	/** Set to 0 to write each YMODEM packet without host-side pacing. */
	readonly writeChunkSize?: number;
	readonly writeChunkDelayMs?: number;
}

const openUartPaths = new Set<string>();

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
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly port: SerialPort;
	private readonly writeChunkSize: number;
	private readonly writeChunkDelayMs: number;
	private lockHeld = false;
	private openOperation: Promise<void> | undefined;
	private closeOperation: Promise<void> | undefined;
	private closeRequested = false;

	constructor(readonly path: string, readonly baudRate: number, options: UartTransportOptions = {}) {
		this.writeChunkSize = options.writeChunkSize ?? DEFAULT_YMODEM_UART_CHUNK_SIZE;
		this.writeChunkDelayMs = options.writeChunkDelayMs ?? DEFAULT_YMODEM_UART_CHUNK_DELAY_MS;
		if (!Number.isInteger(this.writeChunkSize) || this.writeChunkSize < 0) {
			throw new Error('UART write chunk size must be a non-negative integer.');
		}
		if (!Number.isInteger(this.writeChunkDelayMs) || this.writeChunkDelayMs < 0) {
			throw new Error('UART write chunk delay must be a non-negative integer.');
		}
		this.port = new SerialPort({ path, baudRate, autoOpen: false });
		this.port.on('data', (data: Buffer) => {
			for (const listener of this.listeners) listener(data);
		});
		/* Keep device errors from becoming uncaught EventEmitter errors, while
		 * allowing sessions to release their own state and show a useful message. */
		this.port.on('error', (error: Error) => {
			for (const listener of this.errorListeners) listener(error);
			if (this.port.isOpen) void this.close().catch(() => undefined);
			else this.releaseLock();
		});
		this.port.on('close', () => {
			this.releaseLock();
			for (const listener of this.closeListeners) listener();
		});
	}

	open(): Promise<void> {
		if (this.port.isOpen) return Promise.resolve();
		if (this.openOperation) return this.openOperation;
		if (openUartPaths.has(this.path)) {
			return Promise.reject(new Error(`UART port is already in use by ElenixOS Toolkit: ${this.path}`));
		}
		openUartPaths.add(this.path);
		this.lockHeld = true;
		this.closeRequested = false;
		const operation = new Promise<void>((resolve, reject) => {
			this.port.open((error) => {
				if (error) {
					this.releaseLock();
					reject(error);
					return;
				}
				if (this.closeRequested) {
					this.port.close((closeError) => {
						this.releaseLock();
						closeError ? reject(closeError) : resolve();
					});
					return;
				}
				resolve();
			});
		});
		let pendingOperation: Promise<void>;
		pendingOperation = operation.finally(() => {
			if (this.openOperation === pendingOperation) this.openOperation = undefined;
		});
		this.openOperation = pendingOperation;
		return pendingOperation;
	}

	async write(data: Buffer): Promise<void> {
		if (!this.port.isOpen) return Promise.reject(new Error(`UART is not open: ${this.path}`));
		if (this.writeChunkSize === 0) {
			await this.writeChunk(data);
			return;
		}
		for (let offset = 0; offset < data.length; offset += this.writeChunkSize) {
			await this.writeChunk(data.subarray(offset, offset + this.writeChunkSize));
			if (offset + this.writeChunkSize < data.length && this.writeChunkDelayMs > 0) {
				await delay(this.writeChunkDelayMs);
			}
		}
	}

	private writeChunk(data: Buffer): Promise<void> {
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

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): Promise<void> {
		if (this.closeOperation) return this.closeOperation;
		if (this.openOperation) {
			this.closeRequested = true;
			const pendingClose = this.openOperation.catch(() => undefined).then(() => this.closePort());
			let trackedClose: Promise<void>;
			trackedClose = pendingClose.finally(() => {
				if (this.closeOperation === trackedClose) this.closeOperation = undefined;
			});
			this.closeOperation = trackedClose;
			return trackedClose;
		}
		return this.closePort();
	}

	private closePort(): Promise<void> {
		if (!this.port.isOpen) {
			this.releaseLock();
			return Promise.resolve();
		}
		const pendingClose = new Promise<void>((resolve, reject) => {
			this.port.close((error) => {
				this.releaseLock();
				error ? reject(error) : resolve();
			});
		});
		let trackedClose: Promise<void>;
		trackedClose = pendingClose.finally(() => {
			if (this.closeOperation === trackedClose) this.closeOperation = undefined;
		});
		this.closeOperation = trackedClose;
		return trackedClose;
	}

	private releaseLock(): void {
		if (!this.lockHeld) return;
		this.lockHeld = false;
		openUartPaths.delete(this.path);
	}
}
