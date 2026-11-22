/** Concurrency helper: run `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	const workers: Promise<void>[] = [];
	for (let w = 0; w < workerCount; w++) {
		workers.push(
			(async () => {
				for (;;) {
					const index = next++;
					if (index >= items.length) return;
					results[index] = await fn(items[index], index);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

export class AbortError extends Error {
	constructor() {
		super('Sync aborted');
		this.name = 'AbortError';
	}
}

export function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AbortError();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
