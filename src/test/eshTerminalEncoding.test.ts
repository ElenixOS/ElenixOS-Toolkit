import * as assert from 'assert';
import { Utf8StreamDecoder } from '../eshTerminalEncoding';

suite('ESH terminal encoding', () => {
	test('preserves UTF-8 characters split across serial chunks', () => {
		const decoder = new Utf8StreamDecoder();
		const bytes = Buffer.from('状态正常', 'utf8');
		const output = [
			decoder.decode(bytes.subarray(0, 2)),
			decoder.decode(bytes.subarray(2, 5)),
			decoder.decode(bytes.subarray(5)),
			decoder.flush(),
		].join('');
		assert.strictEqual(output, '状态正常');
	});

	test('flushes an incomplete sequence without poisoning the next stream', () => {
		const decoder = new Utf8StreamDecoder();
		assert.strictEqual(decoder.decode(Buffer.from([0xe4])), '');
		assert.strictEqual(decoder.flush(), '�');
		assert.strictEqual(decoder.decode(Buffer.from('ESH', 'utf8')) + decoder.flush(), 'ESH');
	});
});
