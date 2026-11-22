import { base64Decode, base64Encode, utf8Decode, utf8Encode } from './bytes';

/**
 * Optional end-to-end encryption for remote blobs.
 *
 * Each chunk is sealed individually with AES-GCM under a key derived from the
 * user's passphrase, so the WebDAV provider only ever sees ciphertext. The
 * chunk id is still derived from the *plaintext*, which lets devices exchange
 * only changed chunks without revealing content (an id is just a hash).
 */

const PBKDF2_ITERATIONS = 210_000;
const IV_BYTES = 12;
const VERIFIER_TEXT = 'diff-sync-verifier-v1';

export interface KdfParams {
	salt: string;
	iterations: number;
}

export interface EncryptionConfig {
	kdf: KdfParams;
	/** Sealed VERIFIER_TEXT, used to reject a wrong passphrase early. */
	verifier: string;
}

export function createKdfParams(iterations = PBKDF2_ITERATIONS): KdfParams {
	const salt = new Uint8Array(16);
	crypto.getRandomValues(salt);
	return { salt: base64Encode(salt), iterations };
}

export async function deriveKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		'raw',
		utf8Encode(passphrase) as unknown as BufferSource,
		'PBKDF2',
		false,
		['deriveKey'],
	);
	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: base64Decode(kdf.salt) as unknown as BufferSource,
			iterations: kdf.iterations,
			hash: 'SHA-256',
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function seal(
	key: CryptoKey,
	plaintext: Uint8Array,
	associatedData?: string,
): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_BYTES);
	crypto.getRandomValues(iv);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: 'AES-GCM',
				iv: iv as unknown as BufferSource,
				...(associatedData ? { additionalData: utf8Encode(associatedData) as unknown as BufferSource } : {}),
			},
			key,
			plaintext as unknown as BufferSource,
		),
	);
	const out = new Uint8Array(IV_BYTES + ciphertext.length);
	out.set(iv, 0);
	out.set(ciphertext, IV_BYTES);
	return out;
}

export async function open(
	key: CryptoKey,
	sealed: Uint8Array,
	associatedData?: string,
): Promise<Uint8Array> {
	if (sealed.length <= IV_BYTES) throw new Error('密文长度异常');
	const iv = sealed.subarray(0, IV_BYTES);
	const ciphertext = sealed.subarray(IV_BYTES);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: iv as unknown as BufferSource,
			...(associatedData ? { additionalData: utf8Encode(associatedData) as unknown as BufferSource } : {}),
		},
		key,
		ciphertext as unknown as BufferSource,
	);
	return new Uint8Array(plaintext);
}

export async function buildEncryptionConfig(
	passphrase: string,
	iterations = PBKDF2_ITERATIONS,
): Promise<{ config: EncryptionConfig; key: CryptoKey }> {
	const kdf = createKdfParams(iterations);
	const key = await deriveKey(passphrase, kdf);
	const verifier = base64Encode(await seal(key, utf8Encode(VERIFIER_TEXT), 'verifier'));
	return { config: { kdf, verifier }, key };
}

export async function unlockEncryption(
	passphrase: string,
	config: EncryptionConfig,
): Promise<CryptoKey> {
	const key = await deriveKey(passphrase, config.kdf);
	const plaintext = utf8Decode(
		await open(key, base64Decode(config.verifier), 'verifier').catch(() => {
			throw new Error('解密失败：口令错误');
		}),
	);
	if (plaintext !== VERIFIER_TEXT) throw new Error('解密失败：口令错误');
	return key;
}
