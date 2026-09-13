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

const pendingLockReleases = new Map<string, Promise<void>>();
const sharedUartPorts = new Map<string, SharedUartPort>();

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

interface PendingUartWrite {
	readonly sequence: number;
	readonly owner: UartTransport;
	readonly data: Buffer;
	readonly writeChunkSize: number;
	readonly writeChunkDelayMs: number;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

interface PendingExclusiveWrite {
	readonly owner: UartTransport;
	readonly boundary: number;
	readonly action: () => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

function getSharedUartPort(uartPath: string, baudRate: number): SharedUartPort {
	const key = getUartPathKey(uartPath);
	const existing = sharedUartPorts.get(key);
	if (existing) {
		if (existing.baudRate !== baudRate) {
			throw new Error(`UART port ${uartPath} is already configured at ${existing.baudRate} baud in this Toolkit window.`);
		}
		return existing;
	}
	const shared = new SharedUartPort(uartPath, baudRate, key);
	sharedUartPorts.set(key, shared);
	return shared;
}

/**
 * Owns the one physical SerialPort for a path. UartTransport instances are
 * lightweight logical clients, so the ESH terminal and YMODEM can share the
 * same open UART without opening the device twice.
 */
class SharedUartPort {
	private readonly clients = new Set<UartTransport>();
	private readonly port: SerialPort;
	private readonly systemLockPath: string;
	private readonly pendingWrites: PendingUartWrite[] = [];
	private readonly pendingExclusiveWrites: PendingExclusiveWrite[] = [];
	private readonly idleWaiters = new Set<() => void>();
	private referenceCount = 0;
	private nextWriteSequence = 0;
	private writeInFlight = false;
	private exclusiveOwner: UartTransport | undefined;
	private exclusiveWriteOperation: Promise<void> = Promise.resolve();
	private openOperation: Promise<void> | undefined;
	private closeOperation: Promise<void> | undefined;
	private systemLockHeld = false;

	constructor(readonly path: string, readonly baudRate: number, private readonly key: string) {
		this.systemLockPath = getUartLockPath(path);
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
			for (const client of this.clients) {client.dispatchData(data);}
		});
		/* Keep device errors from becoming uncaught EventEmitter errors, while
		 * allowing every logical client to release its own state. */
		this.port.on('error', (error: Error) => {
			for (const client of this.clients) {client.dispatchError(error);}
			if (this.port.isOpen) {void this.closePhysical().catch(() => undefined);}
			else {this.releaseSystemLock();}
		});
		this.port.on('close', () => {
			this.releaseSystemLock();
			/* A physical disconnect invalidates every logical reference. The
			 * clients are notified so sessions do not retain a dead reference. */
			const clients = [...this.clients];
			this.clients.clear();
			this.referenceCount = 0;
			for (const client of clients) {
				client.dispatchExclusive(false);
				client.dispatchClose();
			}
			this.notifyIdle();
		});
	}

	attach(client: UartTransport): void {
		this.clients.add(client);
		if (this.exclusiveOwner) {client.dispatchExclusive(client !== this.exclusiveOwner);}
	}

	detach(client: UartTransport): void {
		this.clients.delete(client);
	}

	async acquire(client: UartTransport): Promise<void> {
		this.attach(client);
		this.referenceCount++;
		try {
			await this.ensureOpen();
		}
		catch (error) {
			this.referenceCount--;
			this.detach(client);
			if (this.referenceCount === 0 && sharedUartPorts.get(this.key) === this) {
				sharedUartPorts.delete(this.key);
			}
			throw error;
		}
	}

	async release(client: UartTransport): Promise<void> {
		this.detach(client);
		if (this.referenceCount > 0) {this.referenceCount--;}
		if (this.referenceCount !== 0) {return;}
		await this.waitForIdle();
		if (this.referenceCount !== 0) {return;}
		await this.closePhysical();
		if (this.referenceCount === 0 && sharedUartPorts.get(this.key) === this) {
			sharedUartPorts.delete(this.key);
		}
	}

	write(
		owner: UartTransport,
		data: Buffer,
		writeChunkSize: number,
		writeChunkDelayMs: number,
	): Promise<void> {
		if (this.exclusiveOwner === owner) {
			const operation = this.exclusiveWriteOperation.catch(() => undefined).then(() =>
				this.writeUnlocked(data, writeChunkSize, writeChunkDelayMs));
			this.exclusiveWriteOperation = operation;
			return operation;
		}
		if (this.exclusiveOwner || this.pendingExclusiveWrites.length > 0) {
			return Promise.reject(new Error('UART is temporarily reserved for a YMODEM transfer.'));
		}

		return new Promise<void>((resolve, reject) => {
			this.pendingWrites.push({
				sequence: this.nextWriteSequence++,
				owner,
				data: Buffer.from(data),
				writeChunkSize,
				writeChunkDelayMs,
				resolve,
				reject,
			});
			this.pumpWrites();
		});
	}

	runExclusive<T>(owner: UartTransport, action: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.pendingExclusiveWrites.push({
				owner,
				boundary: this.nextWriteSequence,
				action: async () => action(),
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.pumpWrites();
		});
	}

	private pumpWrites(): void {
		if (this.writeInFlight || this.exclusiveOwner) {return;}
		const exclusive = this.pendingExclusiveWrites[0];
		const nextWrite = this.pendingWrites[0];
		if (exclusive && (!nextWrite || nextWrite.sequence >= exclusive.boundary)) {
			this.pendingExclusiveWrites.shift();
			this.exclusiveOwner = exclusive.owner;
			this.exclusiveWriteOperation = Promise.resolve();
			this.notifyExclusive(true);
			void this.executeExclusive(exclusive);
			return;
		}
		if (!nextWrite) {
			this.notifyIdle();
			return;
		}
		this.pendingWrites.shift();
		this.writeInFlight = true;
		void this.executeWrite(nextWrite);
	}

	private async executeWrite(write: PendingUartWrite): Promise<void> {
		try {
			await this.writeUnlocked(write.data, write.writeChunkSize, write.writeChunkDelayMs);
			write.resolve();
		}
		catch (error) {
			write.reject(error);
		}
		finally {
			this.writeInFlight = false;
			this.pumpWrites();
		}
	}

	private async executeExclusive(exclusive: PendingExclusiveWrite): Promise<void> {
		try {
			const result = await exclusive.action();
			await this.exclusiveWriteOperation.catch(() => undefined);
			exclusive.resolve(result);
		}
		catch (error) {
			await this.exclusiveWriteOperation.catch(() => undefined);
			exclusive.reject(error);
		}
		finally {
			this.exclusiveOwner = undefined;
			this.notifyExclusive(false);
			this.pumpWrites();
		}
	}

	private notifyExclusive(active: boolean): void {
		for (const client of this.clients) {client.dispatchExclusive(active && client !== this.exclusiveOwner);}
	}

	private async waitForIdle(): Promise<void> {
		if (!this.writeInFlight && this.pendingWrites.length === 0 && !this.exclusiveOwner && this.pendingExclusiveWrites.length === 0) {
			return;
		}
		await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	private notifyIdle(): void {
		if (this.writeInFlight || this.pendingWrites.length > 0 || this.exclusiveOwner || this.pendingExclusiveWrites.length > 0) {return;}
		for (const resolve of this.idleWaiters) {resolve();}
		this.idleWaiters.clear();
	}

	private async ensureOpen(): Promise<void> {
		if (this.closeOperation) {await this.closeOperation.catch(() => undefined);}
		if (this.port.isOpen) {return;}
		if (this.openOperation) {return this.openOperation;}
		const operation = this.openPort();
		let trackedOperation: Promise<void>;
		trackedOperation = operation.finally(() => {
			if (this.openOperation === trackedOperation) {this.openOperation = undefined;}
		});
		this.openOperation = trackedOperation;
		return trackedOperation;
	}

	private async openPort(): Promise<void> {
		await this.acquireSystemLock();
		try {
			await new Promise<void>((resolve, reject) => {
				this.port.open((error) => error ? reject(error) : resolve());
			});
		}
		catch (error) {
			this.releaseSystemLock();
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
				if (code !== 'EEXIST') {throw error;}
				let ownerPid: number | undefined;
				try {
					const owner = JSON.parse(await fs.promises.readFile(this.systemLockPath, 'utf8')) as { pid?: unknown };
					if (typeof owner.pid === 'number' && Number.isInteger(owner.pid)) {ownerPid = owner.pid;}
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

	private async writeUnlocked(data: Buffer, writeChunkSize: number, writeChunkDelayMs: number): Promise<void> {
		if (!this.port.isOpen) {throw new Error(`UART is not open: ${this.path}`);}
		if (writeChunkSize === 0) {
			await this.writeChunk(data);
			return;
		}
		for (let offset = 0; offset < data.length; offset += writeChunkSize) {
			/* Waiting for drain after every small chunk makes the host pace itself
			 * at the UART's wire time plus the configured delay. Queue the writes
			 * one chunk at a time, then drain once after the complete packet. */
			await this.writeChunk(data.subarray(offset, offset + writeChunkSize), false);
			if (offset + writeChunkSize < data.length && writeChunkDelayMs > 0) {await delay(writeChunkDelayMs);}
		}
		await this.drain();
	}

	private writeChunk(data: Buffer, drainAfter = true): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {this.port.off('error', onError);};
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
			try {this.port.write(data, finish);}
			catch (error) {onError(error instanceof Error ? error : new Error(String(error)));}
		});
	}

	private drain(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.port.drain((error) => error ? reject(error) : resolve());
		});
	}

	private async closePhysical(): Promise<void> {
		if (this.closeOperation) {return this.closeOperation;}
		if (!this.port.isOpen) {
			this.releaseSystemLock();
			return;
		}
		const operation = new Promise<void>((resolve, reject) => {
			this.port.close((error) => {
				this.releaseSystemLock();
				error ? reject(error) : resolve();
			});
		});
		let trackedOperation: Promise<void>;
		trackedOperation = operation.finally(() => {
			if (this.closeOperation === trackedOperation) {this.closeOperation = undefined;}
		});
		this.closeOperation = trackedOperation;
		return trackedOperation;
	}

	private releaseSystemLock(): void {
		if (!this.systemLockHeld) {return;}
		this.systemLockHeld = false;
		const release = fs.promises.unlink(this.systemLockPath).catch(() => undefined);
		pendingLockReleases.set(this.systemLockPath, release);
		void release.finally(() => {
			if (pendingLockReleases.get(this.systemLockPath) === release) {pendingLockReleases.delete(this.systemLockPath);}
		});
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

/** A logical UART client backed by a shared physical SerialPort. */
export class UartTransport implements YModemTransport {
	private readonly listeners = new Set<(data: Buffer) => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly exclusiveListeners = new Set<(active: boolean) => void>();
	private readonly shared: SharedUartPort;
	private readonly writeChunkSize: number;
	private readonly writeChunkDelayMs: number;
	private openOperation: Promise<void> | undefined;
	private closeOperation: Promise<void> | undefined;
	private closeRequested = false;
	private acquired = false;
	private exclusiveBusy = false;
	private writeOperation: Promise<void> = Promise.resolve();

	constructor(readonly path: string, readonly baudRate: number, options: UartTransportOptions = {}) {
		this.writeChunkSize = options.writeChunkSize ?? DEFAULT_YMODEM_UART_CHUNK_SIZE;
		this.writeChunkDelayMs = options.writeChunkDelayMs ?? DEFAULT_YMODEM_UART_CHUNK_DELAY_MS;
		if (!Number.isInteger(this.writeChunkSize) || this.writeChunkSize < 0) {
			throw new Error('UART write chunk size must be a non-negative integer.');
		}
		if (!Number.isInteger(this.writeChunkDelayMs) || this.writeChunkDelayMs < 0) {
			throw new Error('UART write chunk delay must be a non-negative integer.');
		}
		this.shared = getSharedUartPort(path, baudRate);
	}

	open(): Promise<void> {
		if (this.acquired) {return Promise.resolve();}
		if (this.openOperation) {return this.openOperation;}
		this.closeRequested = false;
		const operation = this.openTransport();
		let trackedOperation: Promise<void>;
		trackedOperation = operation.finally(() => {
			if (this.openOperation === trackedOperation) {this.openOperation = undefined;}
		});
		this.openOperation = trackedOperation;
		return trackedOperation;
	}

	private async openTransport(): Promise<void> {
		try {
			await this.shared.acquire(this);
			this.acquired = true;
		}
		catch (error) {
			this.shared.detach(this);
			throw error;
		}
	}

	async write(data: Buffer): Promise<void> {
		if (!this.acquired) {throw new Error(`UART is not open: ${this.path}`);}
		if (this.exclusiveBusy) {throw new Error('UART is temporarily reserved for a YMODEM transfer.');}
		const operation = this.writeOperation.catch(() => undefined).then(() =>
			this.shared.write(this, data, this.writeChunkSize, this.writeChunkDelayMs));
		this.writeOperation = operation;
		return operation;
	}

	/** Run a protocol transaction while other logical clients are blocked. */
	async runExclusive<T>(action: () => Promise<T>): Promise<T> {
		if (!this.acquired) {throw new Error(`UART is not open: ${this.path}`);}
		await this.writeOperation.catch(() => undefined);
		return this.shared.runExclusive(this, action);
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

	onExclusive(listener: (active: boolean) => void): () => void {
		this.exclusiveListeners.add(listener);
		if (this.exclusiveBusy) {listener(true);}
		return () => this.exclusiveListeners.delete(listener);
	}

	close(): Promise<void> {
		if (this.closeOperation) {return this.closeOperation;}
		const pendingWrites = this.writeOperation.catch(() => undefined);
		let pendingClose: Promise<void>;
		if (this.openOperation) {
			this.closeRequested = true;
			pendingClose = this.openOperation.catch(() => undefined).then(() => pendingWrites).then(() => this.closeTransport());
		}
		else {pendingClose = pendingWrites.then(() => this.closeTransport());}
		let trackedClose: Promise<void>;
		trackedClose = pendingClose.finally(() => {
			if (this.closeOperation === trackedClose) {this.closeOperation = undefined;}
		});
		this.closeOperation = trackedClose;
		return trackedClose;
	}

	private async closeTransport(): Promise<void> {
		if (!this.acquired) {
			this.shared.detach(this);
			return;
		}
		this.acquired = false;
		await this.shared.release(this);
	}

	dispatchData(data: Buffer): void {
		for (const listener of this.listeners) {listener(data);}
	}

	dispatchError(error: Error): void {
		for (const listener of this.errorListeners) {listener(error);}
	}

	dispatchExclusive(active: boolean): void {
		if (this.exclusiveBusy === active) {return;}
		this.exclusiveBusy = active;
		for (const listener of this.exclusiveListeners) {listener(active);}
	}

	dispatchClose(): void {
		this.acquired = false;
		this.dispatchExclusive(false);
		for (const listener of this.closeListeners) {listener();}
	}
}
