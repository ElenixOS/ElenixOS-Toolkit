import * as vscode from 'vscode';

export type UartMemoryMode = 'window' | 'persistent';

export interface UartConfiguration {
	readonly path: string;
	readonly baudRate: number;
}

const UART_MEMORY_MODE_SETTING = 'uartMemoryMode';
/* Keep the original key so upgrading from the terminal-only implementation
 * does not discard an existing persistent UART selection. */
const PERSISTENT_UART_CONFIGURATION_KEY = 'elenixosToolkit.uartTerminalConfiguration';

function isUartMemoryMode(value: unknown): value is UartMemoryMode {
	return value === 'window' || value === 'persistent';
}

function parseUartConfiguration(value: unknown): UartConfiguration | undefined {
	if (!value || typeof value !== 'object') {return undefined;}
	const configuration = value as { path?: unknown; baudRate?: unknown };
	if (typeof configuration.path !== 'string' || configuration.path.length === 0) {return undefined;}
	if (typeof configuration.baudRate !== 'number' || !Number.isInteger(configuration.baudRate)
		|| configuration.baudRate < 1 || configuration.baudRate > 4_000_000) {
		return undefined;
	}
	return { path: configuration.path, baudRate: configuration.baudRate };
}

/** Owns the single source of truth for the remembered UART configuration. */
export class UartConfigurationStore {
	private windowConfiguration: UartConfiguration | undefined;
	private persistentWrite: Promise<void> = Promise.resolve();

	constructor(private readonly globalState: vscode.Memento) {}

	getRememberedConfiguration(): UartConfiguration | undefined {
		const value = this.getMemoryMode() === 'persistent'
			? this.globalState.get<unknown>(PERSISTENT_UART_CONFIGURATION_KEY)
			: this.windowConfiguration;
		return parseUartConfiguration(value);
	}

	async remember(configuration: UartConfiguration): Promise<void> {
		const normalized = parseUartConfiguration(configuration);
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
