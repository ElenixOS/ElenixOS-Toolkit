import { UartTransport } from './uart';

export interface EshTerminalConnection {
	readonly path: string;
	readonly baudRate: number;
}

export interface EshTerminalSessionCallbacks {
	onData: (data: Buffer) => void;
	onError: (error: Error) => void;
	onClosed: () => void;
}

/** Owns one ESH-over-UART connection and all listeners attached to it. */
export class EshTerminalSession {
	private transport: UartTransport | undefined;
	private removeDataListener: (() => void) | undefined;
	private removeErrorListener: (() => void) | undefined;
	private removeCloseListener: (() => void) | undefined;
	private operation: Promise<void> = Promise.resolve();
	private connected = false;

	constructor(private readonly callbacks: EshTerminalSessionCallbacks) {}

	isConnected(): boolean {
		return this.connected;
	}

	async connect(connection: EshTerminalConnection): Promise<void> {
		await this.close();
		this.operation = Promise.resolve();
		const transport = new UartTransport(connection.path, connection.baudRate, { writeChunkSize: 0 });
		this.transport = transport;
		this.removeDataListener = transport.onData((data) => {
			if (this.transport === transport) {this.callbacks.onData(data);}
		});
		this.removeErrorListener = transport.onError((error) => {
			if (this.transport !== transport) {return;}
			this.callbacks.onError(error);
			void this.closeTransport(transport);
		});
		this.removeCloseListener = transport.onClose(() => {
			if (this.transport !== transport) {return;}
			this.callbacks.onClosed();
			this.clearTransport(transport);
		});

		try {
			await transport.open();
			/* ESH does not necessarily replay its prompt when a host opens the
			 * already-running debug UART. Ctrl-C is a device-defined line reset and
			 * makes reconnects deterministic without implementing ESH state here. */
			await transport.write(Buffer.from([0x03]));
			this.connected = true;
		}
		catch (error) {
			await this.closeTransport(transport);
			throw error;
		}
	}

	write(data: string): Promise<void> {
		const transport = this.transport;
		if (!transport || !this.connected) {return Promise.reject(new Error('ESH terminal is not connected to a UART port.'));}
		/* Serialize writes so pasted commands and individual key events cannot
		 * overtake one another on the serial stream. */
		this.operation = this.operation.then(() => transport.write(Buffer.from(data, 'utf8')));
		return this.operation;
	}

	async close(): Promise<void> {
		const transport = this.transport;
		if (!transport) {return;}
		await this.closeTransport(transport);
	}

	private async closeTransport(transport: UartTransport): Promise<void> {
		if (this.transport !== transport) {return;}
		this.clearTransport(transport);
		try {
			await transport.close();
		}
		catch (error) {
			this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private clearTransport(transport: UartTransport): void {
		if (this.transport !== transport) {return;}
		this.removeDataListener?.();
		this.removeErrorListener?.();
		this.removeCloseListener?.();
		this.removeDataListener = undefined;
		this.removeErrorListener = undefined;
		this.removeCloseListener = undefined;
		this.transport = undefined;
		this.connected = false;
	}
}
