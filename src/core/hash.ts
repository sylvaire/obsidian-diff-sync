import { toHex, utf8Encode } from './bytes';

/** 128-bit truncated SHA-256; collision bound ~2^64. */
const HASH_BYTES = 16;
export const HASH_HEX_LENGTH = HASH_BYTES * 2;

function subtle(): SubtleCrypto {
	const c = (globalThis as { crypto?: Crypto }).crypto;
	if (!c || !c.subtle) throw new Error('WebCrypto is not available in this environment');
	return c.subtle;
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
	if (
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength &&
		bytes.buffer instanceof ArrayBuffer
	) {
		return bytes.buffer;
	}
	return bytes.slice().buffer as ArrayBuffer;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	const digest = await subtle().digest('SHA-256', toBufferSource(bytes));
	return new Uint8Array(digest);
}

/** Content identifier for a chunk or a whole file. Stable across devices. */
export async function contentId(bytes: Uint8Array): Promise<string> {
	return toHex((await sha256(bytes)).subarray(0, HASH_BYTES));
}

/**
 * File identity = hash over the ordered chunk ids.
 * Cheaper than re-hashing the file, and deterministic because the chunker is.
 */
export async function hashOfChunkIds(chunkIds: readonly string[]): Promise<string> {
	return contentId(utf8Encode(chunkIds.join('\n')));
}

/** sha256("") truncated: the hash of an empty chunk list. */
export const EMPTY_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb924';

export function isHashLike(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
