/** HTTP transport used by the standalone Node tests. */
export const fetchTransport = async (request) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), request.timeoutMs);
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: controller.signal,
			credentials: 'omit',
		});
		const headers = {};
		response.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		return { status: response.status, headers, bytes };
	} finally {
		clearTimeout(timer);
	}
};
