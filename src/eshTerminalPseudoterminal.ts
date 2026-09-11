import * as vscode from 'vscode';
import { Utf8StreamDecoder } from './eshTerminalEncoding';
import { EshTerminalConnection, EshTerminalSession } from './eshTerminalSession';

const OUTPUT_FLUSH_DELAY_MS = 0;
const OUTPUT_FLUSH_LIMIT = 64 * 1024;

/** VS Code Terminal frontend for a device-owned ESH session. */
export class EshTerminalPseudoterminal implements vscode.Pseudoterminal, vscode.Disposable {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly decoder = new Utf8StreamDecoder();
	private readonly session: EshTerminalSession;
	private pendingOutput = '';
	private outputTimer: ReturnType<typeof setTimeout> | undefined;
	private opened = false;
	private disposed = false;

	readonly onDidWrite = this.writeEmitter.event;

	constructor() {
		this.session = new EshTerminalSession({
			onData: (data) => this.queueOutput(this.decoder.decode(data)),
			onError: (error) => {
				this.queueOutput(this.decoder.flush());
				this.queueStatus(`UART error: ${error.message}`);
			},
			onClosed: () => {
				this.queueOutput(this.decoder.flush());
				this.queueStatus('UART disconnected. Run “ElenixOS: Open ESH Terminal” to reconnect.');
			},
		});
	}

	open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
		this.opened = true;
		this.queueOutput('\x1b[90mElenixOS ESH Terminal\x1b[0m\r\n');
	}

	close(): void {
		this.opened = false;
		void this.session.close();
	}

	handleInput(data: string): void {
		if (this.disposed || !this.session.isConnected()) {
			this.queueStatus('Not connected to a UART port. Run “ElenixOS: Open ESH Terminal”.');
			return;
		}
		void this.session.write(data).catch((error: unknown) => {
			this.queueStatus(`UART write failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	setDimensions(_dimensions: vscode.TerminalDimensions): void {
		/* ESH currently has no window-size protocol. VS Code still owns terminal
		 * resizing, and all VT cursor behavior remains device-side. */
	}

	async connect(connection: EshTerminalConnection): Promise<void> {
		if (this.disposed) throw new Error('ESH terminal has been disposed.');
		await this.session.connect(connection);
	}

	isConnected(): boolean {
		return this.session.isConnected();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.outputTimer !== undefined) clearTimeout(this.outputTimer);
		this.outputTimer = undefined;
		this.pendingOutput = '';
		void this.session.close();
		this.writeEmitter.dispose();
	}

	private queueStatus(message: string): void {
		this.queueOutput(`\x1b[90m[ESH] ${message}\x1b[0m\r\n`);
	}

	private queueOutput(text: string): void {
		if (!text || this.disposed) return;
		this.pendingOutput += text;
		if (this.pendingOutput.length >= OUTPUT_FLUSH_LIMIT) {
			this.flushOutput();
			return;
		}
		if (this.opened && this.outputTimer === undefined) {
			this.outputTimer = setTimeout(() => this.flushOutput(), OUTPUT_FLUSH_DELAY_MS);
		}
	}

	private flushOutput(): void {
		if (this.outputTimer !== undefined) clearTimeout(this.outputTimer);
		this.outputTimer = undefined;
		if (!this.opened || !this.pendingOutput) return;
		const output = this.pendingOutput;
		this.pendingOutput = '';
		this.writeEmitter.fire(output);
	}
}
