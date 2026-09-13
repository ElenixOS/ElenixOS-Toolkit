import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sendEshYModemReceiveCommand } from '../uart';
import type { YModemTransport } from '../ymodem';

const YMODEM_CAN = 0x18;

class HalfPacketReceiver implements YModemTransport {
	private readonly listeners = new Set<(data: Buffer) => void>();
	private packetLength = 1;
	private promptVisible = false;
	readonly writes: Buffer[] = [];

	async write(data: Buffer): Promise<void> {
		const copy = Buffer.from(data);
		this.writes.push(copy);
		for (const byte of copy) {
			if (this.promptVisible) {continue;}
			if (this.packetLength > 0) {
				this.packetLength++;
				if (this.packetLength === 1029) {
					/* The completed synthetic packet is rejected. The next CAN
					 * byte is then seen at packet boundary and cancels YMODEM. */
					this.packetLength = 0;
				}
				continue;
			}
			if (byte === YMODEM_CAN) {
				this.promptVisible = true;
				this.emit(Buffer.from('ESH> ', 'utf8'));
			}
		}
	}

	onData(listener: (data: Buffer) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(data: Buffer): void {
		for (const listener of this.listeners) {listener(data);}
	}
}

test('recovers an ESH receiver left halfway through a maximum YMODEM packet', async () => {
	const receiver = new HalfPacketReceiver();
	await sendEshYModemReceiveCommand(receiver, '/tmp/payload.bin');

	assert.equal(receiver.writes[0]?.[0], 0x03);
	assert.equal(receiver.writes[1]?.length, 1030);
	assert.equal(receiver.writes[1]?.subarray(0, 1029).every((byte) => byte === YMODEM_CAN), true);
	assert.equal(receiver.writes[1]?.[1029], 0x03);
	assert.equal(receiver.writes.at(-1)?.toString('utf8'), 'ymodem recv /tmp/payload.bin\r');
});
