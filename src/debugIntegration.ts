import * as vscode from 'vscode';
import { SimulatorManager } from './simulatorManager';

export class DebugIntegration implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [
		vscode.debug.onDidStartDebugSession((session) => { void this.manager.connectDebugSession(session); }),
		vscode.debug.onDidTerminateDebugSession((session) => this.manager.terminateDebugSession(session)),
	];

	constructor(private readonly manager: SimulatorManager) {
		const activeSession = vscode.debug.activeDebugSession;
		if (activeSession) {this.manager.connectDebugSession(activeSession);}
	}

	dispose(): void { for (const disposable of this.disposables) {disposable.dispose();} }
}
