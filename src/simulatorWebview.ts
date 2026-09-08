import * as vscode from 'vscode';
import { getSimulatorWebviewHtml, SimulatorWebviewAssets } from './simulatorWebviewContent';

export interface SimulatorWebviewCallbacks {
	onClosed: () => void;
	onConnectionLost: () => void;
}

export class SimulatorWebview implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private currentViewId: string | undefined;
	private panelMessageSubscription: vscode.Disposable | undefined;
	private panelDisposeSubscription: vscode.Disposable | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly callbacks: SimulatorWebviewCallbacks) {}

	show(streamUrl: string, width = 390, height = 450): void {
		const viewId = this.createNonce();
		const assets: SimulatorWebviewAssets = {
			cspSource: this.panel?.webview.cspSource ?? '',
			crownUri: this.panel ? this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'SimulatorCrown.png')).toString() : '',
			sideButtonUri: this.panel ? this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'SimulatorSideButton.png')).toString() : '',
		};
		this.currentViewId = viewId;
		if (this.panel) {
			/* Recreate the document when a debug session is restarted. This gives
			 * the Webview the new per-session token and direct WebSocket endpoint. */
			this.panel.webview.html = getSimulatorWebviewHtml(viewId, width, height, streamUrl, assets);
			/* Keep the existing editor group.  Passing Beside here would create
			 * another group every time a debug session reconnects. */
			/* Keep the CodeLLDB integrated terminal focused so ESH remains
			 * immediately usable after the simulator Webview reconnects. */
			this.panel.reveal(undefined, true);
			return;
		}
		this.panel = vscode.window.createWebviewPanel('elenixosSimulator', 'ElenixOS Simulator', this.findEmptyEditorColumn(), {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		this.attachPanel(this.panel);
		const panelAssets: SimulatorWebviewAssets = {
			cspSource: this.panel.webview.cspSource,
			crownUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'SimulatorCrown.png')).toString(),
			sideButtonUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'SimulatorSideButton.png')).toString(),
		};
		this.panel.webview.html = getSimulatorWebviewHtml(viewId, width, height, streamUrl, panelAssets);
		/* Reveal the simulator without stealing focus from CodeLLDB's
		 * integrated terminal, which owns the ESH stdin stream. */
		this.panel.reveal(undefined, true);
	}

	restore(panel: vscode.WebviewPanel): void {
		if (this.panel === panel) return;
		if (this.panel) {
			/* VS Code should restore only one panel, but never create a second
			 * simulator panel if a serializer is invoked more than once. */
			panel.dispose();
			return;
		}
		this.attachPanel(panel);
	}

	setStatus(text: string): void { this.panel?.webview.postMessage({ type: 'status', text }); }

	dispose(): void {
		this.panelMessageSubscription?.dispose();
		this.panelDisposeSubscription?.dispose();
		this.panel?.dispose();
		this.panel = undefined;
	}

	private attachPanel(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		this.panelMessageSubscription = panel.webview.onDidReceiveMessage((message: unknown) => {
			if (message && typeof message === 'object'
				&& (message as { type?: string }).type === 'connectionLost'
				&& (message as { viewId?: string }).viewId === this.currentViewId) {
				this.callbacks.onConnectionLost();
			}
		}, undefined, []);
		this.panelDisposeSubscription = panel.onDidDispose(() => {
			this.panelMessageSubscription?.dispose();
			this.panelDisposeSubscription = undefined;
			this.panelMessageSubscription = undefined;
			this.panel = undefined;
			this.currentViewId = undefined;
			this.callbacks.onClosed();
		}, undefined, []);
	}

	private findEmptyEditorColumn(): vscode.ViewColumn {
		const emptyGroup = vscode.window.tabGroups.all.find((group) => group.tabs.length === 0);
		return emptyGroup?.viewColumn ?? vscode.ViewColumn.Beside;
	}

	private createNonce(): string {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let nonce = '';
		for (let i = 0; i < 32; i++) nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
		return nonce;
	}
}
