import * as vscode from 'vscode';
import { SimulatorDebugConfigurationProvider } from './debugConfiguration';
import { DebugIntegration } from './debugIntegration';
import { SimulatorManager } from './simulatorManager';
import { SimulatorWebview } from './simulatorWebview';

export function activate(context: vscode.ExtensionContext): void {
	const debugConfigurationProvider = new SimulatorDebugConfigurationProvider();
	let manager: SimulatorManager;
	const webview = new SimulatorWebview(context.extensionUri, {
		onClosed: () => manager.webviewClosed(),
		onConnectionLost: () => manager.webviewConnectionLost(),
	});
	manager = new SimulatorManager(webview);
	const webviewSerializer = vscode.window.registerWebviewPanelSerializer('elenixosSimulator', {
		deserializeWebviewPanel: async (panel) => webview.restore(panel),
	});
	const debugIntegration = new DebugIntegration(manager);

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('lldb', debugConfigurationProvider),
		vscode.debug.registerDebugConfigurationProvider('cppdbg', debugConfigurationProvider),
		manager,
		debugIntegration,
		webviewSerializer,
		vscode.commands.registerCommand('elenixos-toolkit.openSimulator', () => manager.openManually()),
		vscode.commands.registerCommand('elenixos-toolkit.helloWorld', () => vscode.window.showInformationMessage('ElenixOS-Toolkit is ready.')),
	);
}

export function deactivate(): void {}
