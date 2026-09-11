/** Decode serial byte chunks without breaking a multi-byte UTF-8 character. */
export class Utf8StreamDecoder {
	private decoder = new TextDecoder('utf-8');

	decode(data: Uint8Array): string {
		return this.decoder.decode(data, { stream: true });
	}

	flush(): string {
		const result = this.decoder.decode();
		this.decoder = new TextDecoder('utf-8');
		return result;
	}
}
