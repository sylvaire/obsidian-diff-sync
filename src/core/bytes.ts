/** Byte helpers shared by browser (Obsidian) and Node (tests). */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(input: string): Uint8Array {
	return textEncoder.encode(input);
}

export function utf8Decode(input: Uint8Array): string {
	return textDecoder.decode(input);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function toHex(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
	return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
	const table = new Int16Array(256).fill(-1);
	for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
	return table;
})();

/** Base64 encode without Buffer/btoa so it behaves identically everywhere. */
export function base64Encode(bytes: Uint8Array): string {
	let out = '';
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out +=
			B64_ALPHABET[(n >> 18) & 63] +
			B64_ALPHABET[(n >> 12) & 63] +
			B64_ALPHABET[(n >> 6) & 63] +
			B64_ALPHABET[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i] << 16;
		out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + '==';
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out +=
			B64_ALPHABET[(n >> 18) & 63] +
			B64_ALPHABET[(n >> 12) & 63] +
			B64_ALPHABET[(n >> 6) & 63] +
			'=';
	}
	return out;
}

export function base64Decode(input: string): Uint8Array {
	let str = input.replace(/[\s\r\n]/g, '');
	if (str.length % 4 !== 0) {
		// Tolerate unpadded input.
		const pad = 4 - (str.length % 4);
		if (pad === 2 || pad === 3) str += '='.repeat(pad);
	}
	let length = str.length;
	while (length > 0 && str[length - 1] === '=') length--;

	const out = new Uint8Array((length * 6) >> 3);
	let outIndex = 0;
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < length; i++) {
		const code = str.charCodeAt(i);
		const value = code < 256 ? B64_LOOKUP[code] : -1;
		if (value < 0) throw new Error('Invalid base64 character');
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[outIndex++] = (buffer >> bits) & 0xff;
		}
	}
	return outIndex === out.length ? out : out.subarray(0, outIndex);
}
