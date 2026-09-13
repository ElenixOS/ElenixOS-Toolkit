import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SerialPort } from 'serialport';
import type { YModemTransport } from './ymodem';

const ESH_CTRL_C = 0x03;
const ESH_YMODEM_CANCEL = 0x18;
const ESH_UART_OPEN_SETTLE_DELAY_MS = 300;
const ESH_PROMPT_RETRY_DELAY_MS = 250;
const ESH_PROMPT_TIMEOUT_MS = 5000;
/* Pace writes for receivers whose input is dispatched from a small software
 * queue. These remain configurable for receivers with hardware flow control
 * or a larger input queue. */
export const DEFAULT_UART_BAUD_RATE = 921600;
export const DEFAULT_YMODEM_UART_CHUNK_SIZE = 0;
export const DEFAULT_YMODEM_UART_CHUNK_DELAY_MS = 0;
const UART_LOCK_DIRECTORY = path.join(os.tmpdir(), 'elenixos-toolkit-uart-locks');

export type UartPortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

export interface UartTransportOptions {
	/** Set to 0 to write each YMODEM packet without host-side pacing. */
	readonly writeChunkSize?: number;
	readonly writeChunkDelayMs?: number;
}

const openUartPaths = new Set<string>();
const pendingLockReleases = new Map<string, Promise<void>>();

function getUartLockPath(uartPath: string): string {
	const lockKey = getUartPathKey(uartPath);
	const key = crypto.createHash('sha256').update(lockKey).digest('hex');
	return path.join(UART_LOCK_DIRECTORY, `${key}.lock`);
}

function getUartPathKey(uartPath: string): string {
	return uartPath.replace(/^\/dev\/(?:cu|tty)\./, '/dev/serial.');
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	}
	catch {
		return false;
	}
}

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
	await resetEshCommandLine(transport);
	await sendEmptyEshCommand(transport);
	await transport.write(Buffer.from(`ymodem recv ${destinationPath}\r`, 'utf8'));
}

async function resetEshCommandLine(transport: YModemTransport): Promise<void> {
	/* Opening a USB UART can briefly reset or reinitialize the target.  Let the
	 * command receiver settle before sending the command sequence. */
	await delay(ESH_UART_OPEN_SETTLE_DELAY_MS);
}

async function sendEmptyEshCommand(transport: YModemTransport): Promise<void> {
	let output = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolvePrompt: (() => void) | undefined;
	let rejectPrompt: ((error: Error) => void) | undefined;
	const prompt = new Promise<void>((resolve, reject) => {
		resolvePrompt = resolve;
		rejectPrompt = reject;
	});
	const unsubscribe = transport.onData((data) => {
		output += data.toString('utf8');
		if (output.includes('ESH> ')) {resolvePrompt?.();}
	});
	timer = setTimeout(() => {
		rejectPrompt?.(new Error('Timed out waiting for the ESH prompt before starting YMODEM.'));
	}, ESH_PROMPT_TIMEOUT_MS);

	try {
		const reset = Buffer.from([ESH_YMODEM_CANCEL, ESH_YMODEM_CANCEL, ESH_CTRL_C]);
		const deadline = Date.now() + ESH_PROMPT_TIMEOUT_MS;
		while (Date.now() < deadline && !output.includes('ESH> ')) {
			await transport.write(reset);
			if (output.includes('ESH> ')) {break;}
			await Promise.race([prompt, delay(ESH_PROMPT_RETRY_DELAY_MS)]);
		}
		if (!output.includes('ESH> ')) {await prompt;}
	}
	finally {
		unsubscribe();
		if (timer !== undefined) {clearTimeout(timer);}
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
	private readonly systemLockPath: string;
	private lockHeld = false;
	private systemLockHeld = false;
	private openOperation: Promise<void> | undefined;
	private closeOperation: Promise<void> | undefined;
	private closeRequested = false;
	private writeOperation: Promise<void> = Promise.resolve();

	constructor(readonly path: string, readonly baudRate: number, options: UartTransportOptions = {}) {
		this.writeChunkSize = options.writeChunkSize ?? DEFAULT_YMODEM_UART_CHUNK_SIZE;
		this.writeChunkDelayMs = options.writeChunkDelayMs ?? DEFAULT_YMODEM_UART_CHUNK_DELAY_MS;
		this.systemLockPath = getUartLockPath(path);
		if (!Number.isInteger(this.writeChunkSize) || this.writeChunkSize < 0) {
			throw new Error('UART write chunk size must be a non-negative integer.');
		}
		if (!Number.isInteger(this.writeChunkDelayMs) || this.writeChunkDelayMs < 0) {
			throw new Error('UART write chunk delay must be a non-negative integer.');
		}
		this.port = new SerialPort({
			path,
			baudRate,
			dataBits: 8,
			parity: 'none',
			stopBits: 1,
			rtscts: false,
			xon: false,
			xoff: false,
			highWaterMark: 64 * 1024,
			autoOpen: false,
		});
		this.port.on('data', (data: Buffer) => {
			for (const listener of this.listeners) {listener(data);}
		});
		/* Keep device errors from becoming uncaught EventEmitter errors, while
		 * allowing sessions to release their own state and show a useful message. */
		this.port.on('error', (error: Error) => {
			for (const listener of this.errorListeners) {listener(error);}
			if (this.port.isOpen) {void this.close().catch(() => undefined);}
			else {this.releaseLock();}
		});
		this.port.on('close', () => {
			this.releaseLock();
			for (const listener of this.closeListeners) {listener();}
		});
	}

	open(): Promise<void> {
		if (this.port.isOpen) {return Promise.resolve();}
		if (this.openOperation) {return this.openOperation;}
		if (openUartPaths.has(getUartPathKey(this.path))) {
			return Promise.reject(new Error(`UART port is already in use by ElenixOS Toolkit: ${this.path}`));
		}
		this.closeRequested = false;
		const operation = this.openPort();
		let pendingOperation: Promise<void>;
		pendingOperation = operation.finally(() => {
			if (this.openOperation === pendingOperation) {this.openOperation = undefined;}
		});
		this.openOperation = pendingOperation;
		return pendingOperation;
	}

	private async openPort(): Promise<void> {
		await this.acquireSystemLock();
		openUartPaths.add(getUartPathKey(this.path));
		this.lockHeld = true;
		try {
			await new Promise<void>((resolve, reject) => {
				this.port.open((error) => error ? reject(error) : resolve());
			});
			if (this.closeRequested) {
				await this.closePort();
			}
		}
		catch (error) {
			this.releaseLock();
			throw error;
		}
	}

	private async acquireSystemLock(): Promise<void> {
		await pendingLockReleases.get(this.systemLockPath);
		await fs.promises.mkdir(UART_LOCK_DIRECTORY, { recursive: true });
		for (;;) {
			try {
				const handle = await fs.promises.open(this.systemLockPath, 'wx');
				await handle.writeFile(JSON.stringify({ pid: process.pid, path: this.path }));
				await handle.close();
				this.systemLockHeld = true;
				return;
			}
			catch (error) {
				const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
				if (code !== 'EEXIST') {
					throw error;
				}
				let ownerPid: number | undefined;
				try {
					const owner = JSON.parse(await fs.promises.readFile(this.systemLockPath, 'utf8')) as { pid?: unknown };
					if (typeof owner.pid === 'number' && Number.isInteger(owner.pid)) {
						ownerPid = owner.pid;
					}
				}
				catch {
					/* A concurrent creator may not have finished writing the lock. */
				}
				if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
					await fs.promises.unlink(this.systemLockPath).catch(() => undefined);
					continue;
				}
				throw new Error(`UART port is already in use by another ElenixOS Toolkit window: ${this.path}`);
			}
		}
	}

	async write(data: Buffer): Promise<void> {
		const operation = this.writeOperation.catch(() => undefined).then(() => this.writeUnlocked(data));
		this.writeOperation = operation;
		return operation;
	}

	private async writeUnlocked(data: Buffer): Promise<void> {
		if (!this.port.isOpen) {throw new Error(`UART is not open: ${this.path}`);}
		if (this.writeChunkSize === 0) {
			await this.writeChunk(data);
			return;
		}
		for (let offset = 0; offset < data.length; offset += this.writeChunkSize) {
			/* Waiting for drain after every small chunk makes the host pace itself
			 * at the UART's wire time plus the configured delay. Queue the writes
			 * one chunk at a time, then drain once after the complete packet. */
			await this.writeChunk(data.subarray(offset, offset + this.writeChunkSize), false);
			if (offset + this.writeChunkSize < data.length && this.writeChunkDelayMs > 0) {
				await delay(this.writeChunkDelayMs);
			}
		}
		await this.drain();
	}

	private writeChunk(data: Buffer, drainAfter = true): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => { this.port.off('error', onError); };
			const finish = (error?: Error | null): void => {
				if (settled) {return;}
				settled = true;
				cleanup();
				if (error) {reject(error);}
				else if (drainAfter) {this.drain().then(resolve, reject);}
				else {resolve();}
			};
			const onError = (error: Error): void => {
				if (settled) {return;}
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

	private drain(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.port.drain((error) => error ? reject(error) : resolve());
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
		if (this.closeOperation) {return this.closeOperation;}
		const pendingWrites = this.writeOperation.catch(() => undefined);
		if (this.openOperation) {
			this.closeRequested = true;
			const pendingClose = this.openOperation.catch(() => undefined).then(() => pendingWrites).then(() => this.closePort());
			let trackedClose: Promise<void>;
			trackedClose = pendingClose.finally(() => {
				if (this.closeOperation === trackedClose) {this.closeOperation = undefined;}
			});
			this.closeOperation = trackedClose;
			return trackedClose;
		}
		return pendingWrites.then(() => this.closePort());
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
			if (this.closeOperation === trackedClose) {this.closeOperation = undefined;}
		});
		this.closeOperation = trackedClose;
		return trackedClose;
	}

	private releaseLock(): void {
		if (this.lockHeld) {
			this.lockHeld = false;
			openUartPaths.delete(getUartPathKey(this.path));
		}
		if (this.systemLockHeld) {
			this.systemLockHeld = false;
			const release = fs.promises.unlink(this.systemLockPath).catch(() => undefined);
			pendingLockReleases.set(this.systemLockPath, release);
			void release.finally(() => {
				if (pendingLockReleases.get(this.systemLockPath) === release) {
					pendingLockReleases.delete(this.systemLockPath);
				}
			});
		}
	}
}
