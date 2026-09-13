import * as vscode from 'vscode';

export type UartMemoryMode = 'window' | 'persistent';

export interface UartTerminalConfiguration {
	readonly path: string;
	readonly baudRate: number;
}

const UART_MEMORY_MODE_SETTING = 'uartMemoryMode';
const PERSISTENT_UART_CONFIGURATION_KEY = 'elenixosToolkit.uartTerminalConfiguration';

function isUartMemoryMode(value: unknown): value is UartMemoryMode {
	return value === 'window' || value === 'persistent';
}

function parseUartTerminalConfiguration(value: unknown): UartTerminalConfiguration | undefined {
	if (!value || typeof value !== 'object') {return undefined;}
	const configuration = value as { path?: unknown; baudRate?: unknown };
	if (typeof configuration.path !== 'string' || configuration.path.length === 0) {return undefined;}
	if (typeof configuration.baudRate !== 'number' || !Number.isInteger(configuration.baudRate)
		|| configuration.baudRate < 1 || configuration.baudRate > 4_000_000) {
		return undefined;
	}
	return { path: configuration.path, baudRate: configuration.baudRate };
}

/** Owns the single source of truth for the ESH terminal's remembered UART. */
export class UartTerminalConfigurationStore {
	private windowConfiguration: UartTerminalConfiguration | undefined;
	private persistentWrite: Promise<void> = Promise.resolve();

	constructor(private readonly globalState: vscode.Memento) {}

	getRememberedConfiguration(): UartTerminalConfiguration | undefined {
		const value = this.getMemoryMode() === 'persistent'
			? this.globalState.get<unknown>(PERSISTENT_UART_CONFIGURATION_KEY)
			: this.windowConfiguration;
		return parseUartTerminalConfiguration(value);
	}

	async remember(configuration: UartTerminalConfiguration): Promise<void> {
		const normalized = parseUartTerminalConfiguration(configuration);
		if (!normalized) {return;}
		this.windowConfiguration = normalized;
		if (this.getMemoryMode() !== 'persistent') {return;}

		/* Serialize updates so a rapid manual switch cannot let an older write
		 * finish after the newer configuration. */
		this.persistentWrite = this.persistentWrite
			.catch(() => undefined)
			.then(() => this.globalState.update(PERSISTENT_UART_CONFIGURATION_KEY, normalized));
		await this.persistentWrite;
	}

	private getMemoryMode(): UartMemoryMode {
		const configured = vscode.workspace.getConfiguration('elenixosToolkit').get<unknown>(UART_MEMORY_MODE_SETTING);
		return isUartMemoryMode(configured) ? configured : 'window';
	}
}
