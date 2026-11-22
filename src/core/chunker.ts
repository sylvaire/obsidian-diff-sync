import { contentId, hashOfChunkIds } from './hash';

export interface ChunkerConfig {
	/** Minimum chunk size in bytes. */
	minSize: number;
	/** Target average chunk size in bytes. */
	avgSize: number;
	/** Hard maximum chunk size in bytes. */
	maxSize: number;
}

export const DEFAULT_CHUNKER: ChunkerConfig = {
	minSize: 2 * 1024,
	avgSize: 8 * 1024,
	maxSize: 32 * 1024,
};

/**
 * Deterministic gear table so every device cuts identical boundaries for
 * identical bytes without shipping a table.
 *
 * Values pass through a splitmix32 finalizer: a raw xorshift generator has very
 * poor low-bit entropy, and since the boundary test reads the low bits of the
 * rolling hash, a weak table makes the chunker miss boundaries almost entirely.
 */
const GEAR = (() => {
	const table = new Uint32Array(256);
	let state = 0x9e3779b9;
	for (let i = 0; i < 256; i++) {
		state = (state + 0x9e3779b9) >>> 0;
		let z = state;
		z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
		table[i] = (z ^ (z >>> 16)) >>> 0;
	}
	return table;
})();

export interface ChunkSpan {
	start: number;
	end: number;
}

const LF = 0x0a;

function maskFor(avgSize: number): number {
	let bits = 1;
	while (bits < 30 && 1 << bits < avgSize) bits++;
	return (1 << bits) - 1;
}

/**
 * Split a file into chunks whose boundaries are stable under edits.
 *
 * Strategy: content-defined chunking (FastCDC-style gear hash) is the default —
 * boundaries follow local content, so an insertion near the top only perturbs
 * the chunks around it.
 *
 * That breaks down for strongly periodic content: a file of one repeated line
 * (common in generated notes, tables, logs) presents the same rolling-hash
 * values at every period, so either every position is a boundary or none is.
 * The tell-tale sign is that nearly every chunk is capped at `maxSize`. When
 * that happens we switch to line-aligned fixed-size chunks: snapping boundaries
 * to newlines makes the chunks of a repeated-line file byte-identical, so an
 * edit costs one chunk instead of the whole file.
 *
 * Both strategies are deterministic and derived only from content, so two
 * devices always agree on the layout.
 */
export function chunkSpans(bytes: Uint8Array, config: ChunkerConfig = DEFAULT_CHUNKER): ChunkSpan[] {
	const n = bytes.length;
	if (n === 0) return [];

	const min = Math.max(64, Math.min(config.minSize, n));
	const max = Math.max(min, Math.min(config.maxSize, n));
	const avg = Math.max(min, config.avgSize);

	if (!looksLikeText(bytes, n)) {
		const cdc = contentDefinedSpans(bytes, n, min, max, avg);
		return isDegenerate(cdc, n, max) ? fixedSpans(n, avg) : cdc;
	}

	// Text (notes, Markdown, JSON, logs): cut on line boundaries near a fixed
	// target size.
	//
	// Benchmarks against real note shapes (tables, bullet lists, logs, repeated
	// template lines, prose) show this beats content-defined chunking by a wide
	// margin — roughly 24% vs 49% of the file re-sent per edit. Two reasons:
	// boundaries land between lines, so chunk contents are semantically whole;
	// and the resulting chunks are internally uniform, so a nearby edit dirties
	// one chunk rather than a varying, sometimes huge one.
	//
	// CDC is still used for binary data, where there are no lines to align to.
	return lineAlignedSpans(bytes, n, avg);
}

/** Uniform chunks, used when no content-derived boundary exists. */
function fixedSpans(n: number, size: number): ChunkSpan[] {
	const spans: ChunkSpan[] = [];
	for (let start = 0; start < n; start += size) {
		spans.push({ start, end: Math.min(n, start + size) });
	}
	return spans;
}

/**
 * True when the rolling hash found almost no content-derived anchors: nearly
 * every chunk was pushed to the hard maximum instead of ending on a boundary.
 *
 * Deliberately size-independent — an 80 KB file producing three max-size chunks
 * is just as degenerate as a 3 MB one, and it is exactly the size where the
 * damage is most visible (a 1-line edit then re-sends 60% of the file).
 */
function isDegenerate(spans: readonly ChunkSpan[], n: number, max: number): boolean {
	if (spans.length === 0) return false;
	// Only the final chunk may legitimately be capped (it just ends at EOF), so
	// judge the chunks that had room to cut.
	const candidates = spans.length > 1 ? spans.slice(0, -1) : spans;
	let capped = 0;
	for (const span of candidates) {
		if (span.end - span.start >= max) capped++;
	}
	if (capped > 0 && capped / candidates.length > 0.6) return true;

	// Fewer chunks than the file should need at this average size is the same
	// symptom seen from the other side.
	const expected = Math.floor(n / Math.max(1, max / 2));
	return expected >= 2 && spans.length < expected;
}

/**
 * Cheap text/binary decision: no NUL bytes and a low share of control bytes in
 * the sampled head. Markdown, config and JSON all qualify.
 */
function looksLikeText(bytes: Uint8Array, n: number): boolean {
	const sampleSize = Math.min(n, 8192);
	let control = 0;
	for (let i = 0; i < sampleSize; i++) {
		const b = bytes[i];
		if (b === 0) return false;
		// Allow tab, LF, CR; count other control characters.
		if (b < 0x20 && b !== 0x09 && b !== LF && b !== 0x0d) control++;
	}
	return control / sampleSize < 0.02;
}

/**
 * Cut text into line-aligned chunks whose boundaries are content-defined.
 *
 * The mask is computed over *lines*, not bytes: each line is one candidate, so
 * `avgLines` is how many lines we expect per chunk. This is what failed when the
 * mask was derived from a byte target — with ~60-byte lines, a 8 KB byte mask
 * means "8192 lines between cuts", which never happens before the cap, so every
 * chunk maxed out.
 *
 * Because the accept/reject decision reads only the candidate line's own bytes,
 * inserting a line elsewhere leaves every other decision unchanged: the layout
 * is stable under edits, while chunks still split cleanly between lines.
 */
function lineAlignedSpans(bytes: Uint8Array, n: number, size: number): ChunkSpan[] {
	// Count lines over the whole buffer: sampling the head only sees a fraction
	// of a large file and over-estimates lines-per-chunk, which collapses the
	// layout into a couple of huge chunks.
	let totalLines = 1;
	for (let i = 0; i < n; i++) if (bytes[i] === LF) totalLines++;
	const avgLineBytes = Math.max(8, Math.round(n / totalLines));

	// A single edit must not cost more than a small share of the file, so cap
	// chunk size relative to the file too: aim for ~8 chunks, while never
	// exceeding the configured target.
	const adaptiveSize = Math.max(1024, Math.min(size, Math.floor(n / 8)));
	const targetLines = Math.max(2, Math.round(adaptiveSize / avgLineBytes));

	// The mask must be *denser* than the target line count, not equal to it.
	// With a mask of exactly 1/targetLines, roughly a third of chunks time out
	// and get cut by `maxLines` instead of by content — and max-line cuts are
	// position-based, so they all shift when an edit changes the line count. A
	// denser mask (target/4 lines) makes content cuts the norm, which is what
	// keeps boundaries stable across edits.
	const mask = maskFor(Math.max(2, Math.floor(targetLines / 4)));
	const minLines = Math.max(1, Math.floor(targetLines / 4));
	const maxLines = Math.max(minLines + 1, targetLines);

	const spans: ChunkSpan[] = [];
	let start = 0;
	let lineStart = 0;
	let linesInChunk = 0;

	for (let i = 0; i <= n; i++) {
		const atEnd = i === n;
		if (!atEnd && bytes[i] !== LF) continue;

		const lineEnd = atEnd ? n : i + 1;
		linesInChunk++;
		if (lineEnd <= start) continue;

		const isLast = lineEnd >= n;
		const oversize = lineEnd - start >= adaptiveSize * 2;
		const accept =
			isLast ||
			oversize ||
			linesInChunk >= maxLines ||
			(linesInChunk >= minLines && (mix32(hashLine(bytes, lineStart, lineEnd)) & mask) === 0);

		if (accept) {
			// A single line longer than the chunk target (minified JSON, a huge
			// table row) cannot be split at a newline. Split it on byte offsets so
			// one edit still costs a bounded amount instead of the whole file.
			if (lineEnd - start > adaptiveSize * 2) {
				for (let offset = start; offset < lineEnd; offset += adaptiveSize) {
					spans.push({ start: offset, end: Math.min(lineEnd, offset + adaptiveSize) });
				}
			} else {
				spans.push({ start, end: lineEnd });
			}
			start = lineEnd;
			linesInChunk = 0;
		}
		lineStart = lineEnd;
	}

	if (start < n) spans.push({ start, end: n });
	return spans;
}

/** FNV-1a over a byte range, finalized for good low-bit behaviour. */
function hashLine(bytes: Uint8Array, start: number, end: number): number {
	let h = 0x811c9dc5;
	for (let i = start; i < end; i++) {
		h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
	}
	return mix32(h);
}

function mix32(value: number): number {
	let z = value >>> 0;
	z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
	z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
	return (z ^ (z >>> 16)) >>> 0;
}

/** FastCDC-style gear-hash chunking for binary content. */
function contentDefinedSpans(
	bytes: Uint8Array,
	n: number,
	min: number,
	max: number,
	avg: number,
): ChunkSpan[] {
	const mask = maskFor(avg);
	const spans: ChunkSpan[] = [];
	let start = 0;
	while (start < n) {
		const hardEnd = Math.min(n, start + max);
		let end = Math.min(n, start + min);
		let hash = 0;
		while (end < hardEnd) {
			hash = (((hash << 1) + GEAR[bytes[end]]) | 0) >>> 0;
			end++;
			if ((hash & mask) === 0) break;
		}
		spans.push({ start, end });
		start = end;
	}
	return spans;
}

export interface ChunkRef {
	id: string;
	start: number;
	end: number;
}

export interface ChunkedFile {
	/** Hash over the ordered chunk ids: the file's version identity. */
	hash: string;
	size: number;
	spans: ChunkSpan[];
	chunks: ChunkRef[];
}

/** Chunk a buffer and hash every chunk. */
export async function chunkBytes(
	bytes: Uint8Array,
	config: ChunkerConfig = DEFAULT_CHUNKER,
): Promise<ChunkedFile> {
	const spans = chunkSpans(bytes, config);
	const chunks: ChunkRef[] = [];
	for (const span of spans) {
		const id = await contentId(bytes.subarray(span.start, span.end));
		chunks.push({ id, start: span.start, end: span.end });
	}
	const hash = await hashOfChunkIds(chunks.map((chunk) => chunk.id));
	return { hash, size: bytes.length, spans, chunks };
}

/** Unique chunk ids in first-seen order (for upload sets, never for file layout). */
export function uniqueChunkIds(chunks: readonly ChunkRef[]): string[] {
	return [...new Set(chunks.map((chunk) => chunk.id))];
}
