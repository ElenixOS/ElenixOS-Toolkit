import * as vscode from 'vscode';
import { SimulatorDebugConfigurationProvider } from './debugConfiguration';
import { DebugIntegration } from './debugIntegration';
import { SimulatorManager } from './simulatorManager';
import { SimulatorWebview } from './simulatorWebview';
import { EshTerminalManager } from './eshTerminalManager';
import { UartTerminalConfigurationStore } from './uartTerminalConfiguration';

export function activate(context: vscode.ExtensionContext): void {
	const debugConfigurationProvider = new SimulatorDebugConfigurationProvider();
	let manager: SimulatorManager;
	const webview = new SimulatorWebview(context.extensionUri, {
		onClosed: () => manager.webviewClosed(),
		onConnectionLost: () => manager.webviewConnectionLost(),
	});
	manager = new SimulatorManager(webview, context.globalState);
	const eshTerminal = new EshTerminalManager(new UartTerminalConfigurationStore(context.globalState));
	const webviewSerializer = vscode.window.registerWebviewPanelSerializer('elenixosSimulator', {
		deserializeWebviewPanel: async (panel) => webview.restore(panel),
	});
	const debugIntegration = new DebugIntegration(manager);

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('lldb', debugConfigurationProvider),
		vscode.debug.registerDebugConfigurationProvider('cppdbg', debugConfigurationProvider),
		manager,
		eshTerminal,
		debugIntegration,
		webviewSerializer,
		vscode.commands.registerCommand('elenixos-toolkit.openSimulator', () => manager.openManually()),
		vscode.commands.registerCommand('elenixos-toolkit.sendYModem', () => manager.sendYModem()),
		vscode.commands.registerCommand('elenixos-toolkit.toggleYModemPause', () => manager.toggleYModemPause()),
		vscode.commands.registerCommand('elenixos-toolkit.terminateYModem', () => manager.terminateYModem()),
		vscode.commands.registerCommand('elenixos-toolkit.openEshTerminal', () => eshTerminal.open()),
		vscode.commands.registerCommand('elenixos-toolkit.switchEshTerminalPort', () => eshTerminal.switchPort()),
		vscode.commands.registerCommand('elenixos-toolkit.helloWorld', () => vscode.window.showInformationMessage('ElenixOS-Toolkit is ready.')),
	);
}

export function deactivate(): void {}
