import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

export const IPC_VERSION = 1;
export const IPC_HEADER_SIZE = 16;
export const IPC_FRAME_META_SIZE = 16;

const MAGIC = Buffer.from('EOS1', 'ascii');
const MAX_CONTROL_PAYLOAD = 4096;
const MAX_FRAME_PAYLOAD = 4 * 1024 * 1024;

export const IpcMessageType = {
	Hello: 1,
	Frame: 2,
	Input: 3,
	HelloAck: 4,
} as const;

export type PointerAction = 'down' | 'move' | 'up';

export interface SimulatorReadyInfo {
	protocol: 'elenixos-simulator';
	version: number;
	socket: string;
	pid: number;
	width: number;
	height: number;
	format: 'rgb565-le';
	websocket: string;
}

export interface SimulatorFrame {
	width: number;
	height: number;
	stride: number;
	format: 'rgb565-le';
	pixels: Buffer;
}

export class SimulatorIpcClient extends EventEmitter {
	private socket: net.Socket | undefined;
	private receiveBuffer = Buffer.alloc(0);
	private connected = false;
	private handshakeResolve: (() => void) | undefined;
	private handshakeReject: ((error: Error) => void) | undefined;

	async connect(socketPath: string): Promise<void> {
		if (this.socket) {throw new Error('Simulator IPC client is already connected');}

		await new Promise<void>((resolve, reject) => {
			const tcpEndpoint = /^tcp:\/\/(.+):(\d+)$/.exec(socketPath);
			const socket = tcpEndpoint
				? net.createConnection({ host: tcpEndpoint[1], port: Number(tcpEndpoint[2]) })
				: net.createConnection({ path: socketPath });
			this.socket = socket;
			this.handshakeResolve = resolve;
			this.handshakeReject = reject;

			socket.once('connect', () => {
				this.writeMessage(IpcMessageType.Hello, Buffer.from('elenixos-toolkit/1', 'ascii'));
			});
			socket.on('data', (chunk: Buffer) => this.handleData(chunk));
			socket.on('error', (error: Error) => {
				if (!this.connected) {this.handshakeReject?.(error);}
				this.emit('error', error);
			});
			socket.once('close', () => {
				if (!this.connected) {this.handshakeReject?.(new Error('Simulator IPC connection closed during handshake'));}
				this.connected = false;
				this.socket = undefined;
				this.emit('closed');
			});
		});
	}

	sendInput(action: PointerAction, x: number, y: number): void {
		if (!this.socket || !this.connected) {return;}
		const payload = Buffer.alloc(9);
		payload[0] = action === 'down' ? 1 : action === 'move' ? 2 : 3;
		payload.writeInt32BE(Math.trunc(x), 1);
		payload.writeInt32BE(Math.trunc(y), 5);
		this.writeMessage(IpcMessageType.Input, payload);
	}

	dispose(): void {
		this.handshakeReject?.(new Error('Simulator IPC client disposed'));
		this.handshakeResolve = undefined;
		this.handshakeReject = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.connected = false;
		this.receiveBuffer = Buffer.alloc(0);
	}

	private writeMessage(type: number, payload: Buffer): void {
		if (!this.socket) {return;}
		const header = Buffer.alloc(IPC_HEADER_SIZE);
		MAGIC.copy(header, 0);
		header.writeUInt16BE(IPC_VERSION, 4);
		header.writeUInt16BE(type, 6);
		header.writeUInt32BE(payload.length, 8);
		header.writeUInt32BE(0, 12);
		this.socket.write(Buffer.concat([header, payload]));
	}

	private handleData(chunk: Buffer): void {
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
		while (this.receiveBuffer.length >= IPC_HEADER_SIZE) {
			if (!this.receiveBuffer.subarray(0, 4).equals(MAGIC)
				|| this.receiveBuffer.readUInt16BE(4) !== IPC_VERSION) {
				this.disposeWithError(new Error('Invalid Simulator IPC header'));
				return;
			}
			const type = this.receiveBuffer.readUInt16BE(6);
			const payloadLength = this.receiveBuffer.readUInt32BE(8);
			const maxPayload = type === IpcMessageType.Frame ? MAX_FRAME_PAYLOAD : MAX_CONTROL_PAYLOAD;
			if (payloadLength > maxPayload) {
				this.disposeWithError(new Error('Simulator IPC payload is too large'));
				return;
			}
			const messageLength = IPC_HEADER_SIZE + payloadLength;
			if (this.receiveBuffer.length < messageLength) {return;}
			const payload = this.receiveBuffer.subarray(IPC_HEADER_SIZE, messageLength);
			this.receiveBuffer = this.receiveBuffer.subarray(messageLength);
			this.handleMessage(type, payload);
		}
	}

	private handleMessage(type: number, payload: Buffer): void {
		if (type === IpcMessageType.HelloAck) {
			this.connected = true;
			this.handshakeResolve?.();
			this.handshakeResolve = undefined;
			this.handshakeReject = undefined;
			this.emit('connected');
			return;
		}
		if (type !== IpcMessageType.Frame || payload.length < IPC_FRAME_META_SIZE) {return;}
		const width = payload.readUInt32BE(0);
		const height = payload.readUInt32BE(4);
		const stride = payload.readUInt32BE(8);
		const format = payload.readUInt32BE(12);
		/* The receive buffer is replaced, rather than mutated, after parsing.
		 * Keep a view into it so a full framebuffer is not copied once more
		 * before the Webview transport.  The latest-frame queue owns the view
		 * until it is replaced or consumed. */
		const pixels = payload.subarray(IPC_FRAME_META_SIZE);
		if (format !== 1 || width <= 0 || height <= 0 || stride < width * 2 || pixels.length < stride * height) {return;}
		this.emit('frame', { width, height, stride, format: 'rgb565-le', pixels } satisfies SimulatorFrame);
	}

	private disposeWithError(error: Error): void {
		this.handshakeReject?.(error);
		this.emit('error', error);
		this.dispose();
	}
}

export async function readReadyFile(readyPath: string): Promise<SimulatorReadyInfo | undefined> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(readyPath, 'utf8')) as Partial<SimulatorReadyInfo>;
		if (parsed.protocol !== 'elenixos-simulator' || parsed.version !== IPC_VERSION
			|| typeof parsed.socket !== 'string' || typeof parsed.pid !== 'number'
			|| typeof parsed.width !== 'number' || typeof parsed.height !== 'number'
			|| parsed.format !== 'rgb565-le' || typeof parsed.websocket !== 'string'
			|| !/^ws:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/.test(parsed.websocket)) {return undefined;}
		return parsed as SimulatorReadyInfo;
	} catch {
		return undefined;
	}
}

/** Wait for the atomic Simulator ready marker, rather than polling a PID. */
export async function waitForReadyFile(readyPath: string, signal: AbortSignal): Promise<SimulatorReadyInfo> {
	const existing = await readReadyFile(readyPath);
	if (existing) {return existing;}

	return await new Promise<SimulatorReadyInfo>((resolve, reject) => {
		const directory = path.dirname(readyPath);
		const filename = path.basename(readyPath);
		let settled = false;
		let watcher: fs.FSWatcher | undefined;
		const onAbort = (): void => finish(() => reject(new Error('Simulator startup cancelled')));
		const finish = (callback: () => void): void => {
			if (settled) {return;}
			settled = true;
			watcher?.close();
			signal.removeEventListener('abort', onAbort);
			callback();
		};
		const inspect = async (): Promise<void> => {
			const ready = await readReadyFile(readyPath);
			if (ready) {finish(() => resolve(ready));}
		};

		signal.addEventListener('abort', onAbort, { once: true });
		try {
			watcher = fs.watch(directory, (_event, changedFilename) => {
				if (!changedFilename || changedFilename.toString() === filename) {void inspect();}
			});
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		void inspect();
	});
}
