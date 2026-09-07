import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function createSimulatorIpcSocketPath(): string {
	/* macOS and Linux Unix-domain sockets have a short sun_path limit.  The
	 * macOS os.tmpdir() commonly expands to /var/folders/... and can exceed it
	 * once the per-session UUID is appended. */
	const baseDirectory = process.platform === 'win32' ? os.tmpdir() : '/tmp';
	return path.join(baseDirectory, `eos-${crypto.randomUUID()}.sock`);
}

/**
 * Give each Native debug session its own IPC endpoint.  A fixed endpoint can
 * be removed by the cleanup of the previous session after the new process has
 * already bound it, leaving the process alive but making the ready handshake
 * impossible.  Resolving the debug configuration once also keeps the endpoint
 * identical in the Simulator arguments and in Toolkit's session metadata.
 */
export class SimulatorDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		configuration: vscode.DebugConfiguration,
	): vscode.DebugConfiguration {
		if (configuration.elenixosSimulator !== true) return configuration;

		const socketPath = createSimulatorIpcSocketPath();
		const args = Array.isArray(configuration.args) ? [...configuration.args] as unknown[] : [];
		const filteredArgs: unknown[] = [];
		for (let index = 0; index < args.length; index++) {
			const argument = args[index];
			if (argument === '--headless') continue;
			if (argument === '--ipc-socket') {
				index++;
				continue;
			}
			if (argument === '--ws-port') {
				index++;
				continue;
			}
			if (typeof argument === 'string' && argument.startsWith('--ipc-socket=')) continue;
			if (typeof argument === 'string' && argument.startsWith('--ws-port=')) continue;
			filteredArgs.push(argument);
		}

		configuration.args = [...filteredArgs, '--headless', '--ipc-socket', socketPath, '--ws-port', '0'];
		configuration.elenixosIpcSocket = socketPath;
		return configuration;
	}
}
