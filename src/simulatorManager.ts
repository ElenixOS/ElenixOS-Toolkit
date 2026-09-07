import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { createSimulatorIpcSocketPath } from './debugConfiguration';
import { readReadyFile, waitForReadyFile, type SimulatorReadyInfo } from './ipc';
import { SimulatorWebview } from './simulatorWebview';

interface ActiveSimulator {
	kind: 'manual' | 'debug';
	id: string;
	workspacePath: string;
	socketPath: string;
	readyPath: string;
	abort: AbortController;
	websocketUrl?: string;
	readyPid?: number;
	readyWatcher?: fs.FSWatcher;
	debugSession?: vscode.DebugSession;
	process?: ChildProcess;
}

export class SimulatorManager implements vscode.Disposable {
	private active: ActiveSimulator | undefined;
	private cleanupBarrier: Promise<void> = Promise.resolve();

	constructor(private readonly webview: SimulatorWebview) {}

	async openManually(): Promise<void> {
		await this.cleanupBarrier;
		if (this.active) {
			const streamUrl = this.active.websocketUrl;
			if (streamUrl) this.webview.show(streamUrl);
			return;
		}
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspacePath) { void vscode.window.showErrorMessage('Open the ElenixOS-Simulator workspace first.'); return; }
		const configuredPath = vscode.workspace.getConfiguration('elenixosToolkit').get<string>('simulatorPath');
		const simulatorPath = configuredPath || path.join(workspacePath, 'bin', process.platform === 'win32' ? 'main.exe' : 'main');
		const socketPath = createSimulatorIpcSocketPath();
		const active: ActiveSimulator = {
			kind: 'manual', id: crypto.randomUUID(), workspacePath, socketPath, readyPath: `${socketPath}.ready`, abort: new AbortController(),
		};
		this.active = active;
		this.webview.setStatus('Starting Simulator…');

		/* Keep the Native process attached to the VS Code/Extension Host terminal.
		 * ESH reads stdin and writes stdout independently of the WebSocket frame
		 * path; ignoring stdio makes the Simulator look alive while silently
		 * disabling the shell. */
		const child = spawn(simulatorPath, ['--headless', '--ipc-socket', socketPath, '--ws-port', '0'], { cwd: workspacePath, stdio: 'inherit' });
		active.process = child;
		child.once('error', (error) => {
			if (this.active?.id !== active.id) return;
			this.webview.setStatus(`Simulator failed to start: ${error.message}`);
			void this.stopActive(active, false);
		});
		child.once('close', (code, signal) => {
			if (this.active?.id !== active.id) return;
			this.webview.setStatus(`Simulator stopped (${signal ?? code ?? 'unknown'})`);
			void this.stopActive(active, false);
		});
		void this.waitAndConnect(active);
	}

	async connectDebugSession(session: vscode.DebugSession): Promise<void> {
		if (!this.isSimulatorDebugSession(session) || !session.workspaceFolder) return;
		await this.cleanupBarrier;
		const configuredSocket = session.configuration.elenixosIpcSocket;
		if (typeof configuredSocket !== 'string' || configuredSocket.length === 0) {
			void vscode.window.showErrorMessage('ElenixOS debug configuration is missing elenixosIpcSocket.');
			return;
		}
		if (this.active?.kind === 'debug' && this.active.id === session.id) {
			const streamUrl = this.active.websocketUrl;
			if (streamUrl) this.webview.show(streamUrl);
			void this.refreshReady(this.active);
			return;
		}
		if (this.active) await this.stopActive(this.active);

		const socketPath = path.resolve(session.workspaceFolder.uri.fsPath, configuredSocket);
		const active: ActiveSimulator = {
			kind: 'debug', id: session.id, workspacePath: session.workspaceFolder.uri.fsPath, socketPath,
			readyPath: `${socketPath}.ready`, abort: new AbortController(), debugSession: session,
		};
		this.active = active;
		this.webview.setStatus('Waiting for Simulator ready handshake…');
		void this.waitAndConnect(active);
	}

	terminateDebugSession(session: vscode.DebugSession): void {
		if (this.active?.kind === 'debug' && this.active.id === session.id) void this.stopActive(this.active);
	}

	webviewClosed(): void {
		if (!this.active) return;
		const active = this.active;
		/* A debug adapter owns the process, but the manager still owns the IPC
		 * endpoint and must remove it when the panel goes away. */
		void this.stopActive(active);
	}

	webviewConnectionLost(): void {
		if (!this.active) return;
		/* A WebSocket close is not sufficient evidence that the Native process
		 * has died. Keep the debug session and ready marker alive so the panel
		 * can be recreated and reconnect to the same Simulator. Process exit,
		 * panel disposal, and extension disposal still own full cleanup. */
		this.webview.setStatus('Simulator disconnected; waiting for restart handshake…');
	}

	dispose(): void {
		/* Keep the WebviewPanel alive for VS Code's panel serializer.  This lets
		 * the next Extension Host activation reclaim the same Simulator window
		 * instead of opening a duplicate panel. */
		if (this.active) void this.stopActive(this.active);
	}

	private async waitAndConnect(active: ActiveSimulator): Promise<void> {
		try {
			const ready = await waitForReadyFile(active.readyPath, active.abort.signal);
			if (!this.isActive(active)) return;
			this.applyReady(active, ready);
			this.watchReadyFile(active);
			this.webview.setStatus('Connecting directly to Simulator…');
		} catch (error) {
			if (!this.isActive(active) || active.abort.signal.aborted) return;
			this.webview.setStatus(`Simulator connection failed: ${error instanceof Error ? error.message : String(error)}`);
			await this.stopActive(active);
		}
	}

	private applyReady(active: ActiveSimulator, ready: SimulatorReadyInfo): void {
		if (!ready.socket.startsWith('tcp://') && path.resolve(ready.socket) !== path.resolve(active.socketPath)) {
			throw new Error('Simulator ready socket mismatch');
		}
		active.readyPid = ready.pid;
		active.websocketUrl = ready.websocket;
		this.webview.show(ready.websocket, ready.width, ready.height);
	}

	private watchReadyFile(active: ActiveSimulator): void {
		if (active.readyWatcher) return;
		const directory = path.dirname(active.readyPath);
		const filename = path.basename(active.readyPath);
		try {
			/* The Simulator atomically replaces this marker on every start. Watch
			 * the directory instead of the file because unlink/rename would close
			 * a file-specific watcher during a debug restart. */
			active.readyWatcher = fs.watch(directory, (_event, changedFilename) => {
				if (changedFilename && changedFilename.toString() !== filename) return;
				void this.refreshReady(active);
			});
		} catch (error) {
			this.webview.setStatus(`Cannot watch Simulator restart handshake: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async refreshReady(active: ActiveSimulator): Promise<void> {
		if (!this.isActive(active) || active.abort.signal.aborted) return;
		try {
			const ready = await readReadyFile(active.readyPath);
			if (!ready || !this.isActive(active)) return;
			if (ready.pid === active.readyPid && ready.websocket === active.websocketUrl) return;

			/* A native debug restart creates a new WebSocket endpoint while keeping
			 * the same VS Code DebugSession. Rebuild only the Webview document; this
			 * preserves the existing editor tab and reconnects to the new instance. */
			this.webview.setStatus('Simulator restarted; reconnecting…');
			this.applyReady(active, ready);
		} catch (error) {
			if (this.isActive(active)) {
				this.webview.setStatus(`Simulator restart handshake failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private stopActive(active: ActiveSimulator, killProcess = true): Promise<void> {
		if (this.active?.id === active.id) this.active = undefined;
		const cleanup = this.cleanupBarrier.then(async () => {
			active.abort.abort();
			active.readyWatcher?.close();
			active.readyWatcher = undefined;
			if (killProcess && active.kind === 'debug' && active.debugSession) {
				await Promise.resolve(vscode.debug.stopDebugging(active.debugSession)).catch(() => false);
			}
			else if (killProcess && active.process && !active.process.killed) {
				if (process.platform === 'win32') active.process.kill();
				else active.process.kill('SIGTERM');
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						if (active.process && !active.process.killed) {
							if (process.platform === 'win32') active.process.kill();
							else active.process.kill('SIGKILL');
						}
						resolve();
					}, 1500);
					active.process?.once('close', () => { clearTimeout(timer); resolve(); });
				});
			}
			await Promise.all([
				fs.promises.rm(active.socketPath, { force: true }).catch(() => undefined),
				fs.promises.rm(active.readyPath, { force: true }).catch(() => undefined),
			]);
		});
		this.cleanupBarrier = cleanup.catch(() => undefined);
		return cleanup;
	}

	private isActive(active: ActiveSimulator): boolean { return this.active?.id === active.id; }

	private isSimulatorDebugSession(session: vscode.DebugSession): boolean {
		return session.configuration.elenixosSimulator === true && session.configuration.request === 'launch'
			&& typeof session.configuration.elenixosIpcSocket === 'string';
	}
}
