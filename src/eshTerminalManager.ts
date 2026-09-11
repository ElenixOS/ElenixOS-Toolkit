import * as vscode from 'vscode';
import { EshTerminalConnection } from './eshTerminalSession';
import { EshTerminalPseudoterminal } from './eshTerminalPseudoterminal';
import { listUartPorts } from './uart';

interface EshPortPick extends vscode.QuickPickItem {
	path: string;
}

/** Command/UI glue for the single reusable ESH terminal instance. */
export class EshTerminalManager implements vscode.Disposable {
	private terminal: vscode.Terminal | undefined;
	private pty: EshTerminalPseudoterminal | undefined;
	private terminalCloseSubscription: vscode.Disposable | undefined;
	private disposed = false;

	async open(): Promise<void> {
		if (this.disposed) return;
		if (this.terminal && this.pty?.isConnected()) {
			this.terminal.show(true);
			return;
		}

		const connection = await this.selectConnection();
		if (!connection) return;
		const pty = this.ensureTerminal();
		this.terminal?.show(true);
		try {
			await pty.connect(connection);
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Unable to open ESH UART ${connection.path}: ${message}`);
			this.terminal?.show(true);
		}
	}

	async switchPort(): Promise<void> {
		if (this.disposed) return;
		const connection = await this.selectConnection();
		if (!connection) return;
		const pty = this.ensureTerminal();
		this.terminal?.show(true);
		try {
			await pty.connect(connection);
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Unable to switch ESH UART to ${connection.path}: ${message}`);
			this.terminal?.show(true);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.terminalCloseSubscription?.dispose();
		this.terminalCloseSubscription = undefined;
		this.pty?.dispose();
		this.pty = undefined;
		this.terminal?.dispose();
		this.terminal = undefined;
	}

	private ensureTerminal(): EshTerminalPseudoterminal {
		if (this.terminal && this.pty) return this.pty;
		/* A transient terminal can outlive an Extension Host reload in the UI,
		 * but its old pseudoterminal can no longer own a session. Reclaim stale
		 * terminals created by this feature before making the single replacement. */
		for (const existing of vscode.window.terminals) {
			if (existing.name === 'ElenixOS ESH') existing.dispose();
		}
		const pty = new EshTerminalPseudoterminal();
		const terminal = vscode.window.createTerminal({
			name: 'ElenixOS ESH',
			pty,
			iconPath: new vscode.ThemeIcon('terminal'),
			isTransient: true,
		});
		this.pty = pty;
		this.terminal = terminal;
		this.terminalCloseSubscription = vscode.window.onDidCloseTerminal((closedTerminal) => {
			if (closedTerminal !== terminal) return;
			if (this.terminal !== terminal) return;
			this.terminalCloseSubscription?.dispose();
			this.terminalCloseSubscription = undefined;
			this.pty?.dispose();
			this.pty = undefined;
			this.terminal = undefined;
		});
		return pty;
	}

	private async selectConnection(): Promise<EshTerminalConnection | undefined> {
		let ports: Awaited<ReturnType<typeof listUartPorts>>;
		try {
			ports = (await listUartPorts()).sort((left, right) => left.path.localeCompare(right.path));
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Unable to enumerate UART ports: ${message}`);
			return undefined;
		}
		if (ports.length === 0) {
			void vscode.window.showErrorMessage('No UART ports were found. Connect the ElenixOS device and try again.');
			return undefined;
		}

		const selected = await vscode.window.showQuickPick<EshPortPick>(ports.map((info) => ({
			label: info.path,
			description: info.manufacturer ?? 'UART device',
			detail: [info.serialNumber, info.vendorId && `VID ${info.vendorId}`, info.productId && `PID ${info.productId}`]
				.filter(Boolean).join(' · '),
			path: info.path,
		})), { placeHolder: 'Select the UART connected to the ElenixOS device' });
		if (!selected) return undefined;

		const configuredBaudRate = vscode.workspace.getConfiguration('elenixosToolkit').get<number>('uartBaudRate', 115200);
		const baudRateText = await vscode.window.showInputBox({
			prompt: 'ESH UART baud rate (8 data bits, no parity, 1 stop bit)',
			value: String(configuredBaudRate),
			validateInput: (value) => {
				const baudRate = Number(value.trim());
				return Number.isInteger(baudRate) && baudRate > 0 && baudRate <= 4_000_000
					? undefined : 'Enter an integer baud rate between 1 and 4000000.';
			},
		});
		if (!baudRateText) return undefined;
		return { path: selected.path, baudRate: Number(baudRateText.trim()) };
	}
}
