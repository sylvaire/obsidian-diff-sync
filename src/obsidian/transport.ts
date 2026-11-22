import { requestUrl } from 'obsidian';
import { HttpResponse, HttpTransport } from '../core/webdav';

/**
 * Transport backed by Obsidian's `requestUrl`, which bypasses the renderer's
 * CORS restrictions — mandatory for third-party WebDAV servers.
 */
export const obsidianTransport: HttpTransport = async (request): Promise<HttpResponse> => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body ? copyToArrayBuffer(request.body) : undefined,
		throw: false,
	});

	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(response.headers ?? {})) {
		headers[key.toLowerCase()] = String(value);
	}

	return {
		status: response.status,
		headers,
		bytes: new Uint8Array(response.arrayBuffer ?? new ArrayBuffer(0)),
	};
};

function copyToArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
		? (data.buffer as ArrayBuffer)
		: data.slice().buffer;
}
