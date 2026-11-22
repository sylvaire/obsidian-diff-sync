/** Benchmark the real chunker against realistic note shapes. */
import { chunkBytes, utf8Encode } from './.build/core.mjs';

async function measure(label, text, edit) {
	const edited = edit(text);
	const bufA = utf8Encode(text);
	const bufB = utf8Encode(edited);
	const a = await chunkBytes(bufA);
	const b = await chunkBytes(bufB);
	const before = new Set(a.chunks.map((c) => c.id));
	let changed = 0;
	for (const chunk of b.chunks) {
		if (!before.has(chunk.id)) changed += chunk.end - chunk.start;
	}
	const pct = (changed / bufA.length) * 100;
	console.log(
		`${label.padEnd(14)} ${pct.toFixed(1).padStart(6)}%  ` +
			`chunks=${String(a.chunks.length).padStart(3)}  ` +
			`sizes=${a.chunks
				.slice(0, 4)
				.map((c) => c.end - c.start)
				.join(',')}`,
	);
	return pct;
}

const templated =
	'# 坚果云同步测试\n\n' +
	Array.from({ length: 1200 }, (_, i) => `第 ${i} 行：这是用于测试差分同步的中文段落内容。\n`).join('');

const prose = (() => {
	const w = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
	let s = 12345;
	const o = [];
	let len = 0;
	while (len < 120000) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		const line = `${w[s % 8]} ${s % 10000} ${w[(s >> 7) % 8]} 这是随机散文内容用于测试差分同步。\n`;
		o.push(line);
		len += line.length;
	}
	return o.join('');
})();

const md = Array.from(
	{ length: 800 },
	(_, i) => `## 小节 ${i}\n\n- 要点 ${i * 7}\n- 说明文字 ${i * 13}\n\n`,
).join('');

const table =
	'| 列A | 列B |\n|---|---|\n' +
	Array.from({ length: 1500 }, (_, i) => `| 行${i} | 值${i * 3} |\n`).join('');

const log = Array.from(
	{ length: 3000 },
	(_, i) =>
		`2026-11-13T12:${String(i % 60).padStart(2, '0')}:00Z INFO request id=${i} status=200 ms=${i % 400}\n`,
).join('');

const note =
	'# 项目周报\n\n## 本周进展\n\n本周完成了差分同步插件的核心开发，包括内容定义分块、' +
	'WebDAV 传输层、冲突处理与端到端加密。\n\n### 技术要点\n\n- 分块算法采用 FastCDC 思路\n' +
	'- 传输层通过 requestUrl 绕过 CORS\n- 冲突策略为较新者胜出并保留副本\n\n## 下周计划\n\n' +
	'1. 补充移动端支持调研\n2. 优化大文件首次上传\n3. 完善设置界面\n';

const cases = [
	['模板行 82KB', templated, (t) => t.replace('第 600 行：', '第 600 行【改】：')],
	['散文 120KB', prose, (t) => t.slice(0, 60000) + '插入的新段落\n\n' + t.slice(60000)],
	['结构MD 60KB', md, (t) => t.replace('## 小节 400', '## 小节 400（补充）')],
	['MD 开头插入', md, (t) => '# 总标题\n\n' + t],
	['MD 追加结尾', md, (t) => t + '\n## 新章节\n\n补充内容。\n'],
	['表格 30KB', table, (t) => t.replace('| 行750 | 值2250 |', '| 行750 | 值9999 |')],
	['日志 200KB', log, (t) => t.replace('request id=1500 status=200', 'request id=1500 status=ERROR')],
	['真实笔记', note.repeat(40), (t) => t.replace('## 下周计划', '## 下周计划（更新）')],
	['单行超长', 'x'.repeat(200000), (t) => t.slice(0, 100000) + 'Y' + t.slice(100000)],
];

console.log('场景            重传比例  分块数  前几块大小');
console.log('-'.repeat(66));
const scores = [];
for (const [label, text, edit] of cases) scores.push(await measure(label, text, edit));
console.log('-'.repeat(66));
console.log(`平均重传 ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}%`);
