import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules } from 'node:module';

const watch = process.argv.includes('--watch');
const testBuild = process.argv.includes('--test');

const common = {
	logLevel: 'info',
	bundle: true,
	sourcemap: false,
	minify: false,
	target: 'es2020',
	platform: 'browser',
	treeShaking: true,
};

/** Plugin bundle: CommonJS `main.js`, Obsidian provided externals. */
const plugin = {
	...common,
	entryPoints: ['src/main.ts'],
	format: 'cjs',
	outfile: 'main.js',
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtinModules,
		'node:*',
	],
};

/**
 * Test bundle: the pure core (no `obsidian` import) as ESM for Node.
 * Keeps the test target honest: if core ever reaches into Obsidian, tests fail.
 */
const tests = {
	...common,
	platform: 'node',
	entryPoints: ['src/core/index.ts'],
	format: 'esm',
	outfile: 'tests/.build/core.mjs',
};

if (watch) {
	const ctx = await esbuild.context(plugin);
	await ctx.watch();
} else {
	await esbuild.build(testBuild ? tests : plugin);
	if (!testBuild) {
		// Always keep the test bundle in sync so `npm test` never runs stale code.
		await esbuild.build(tests);
	}
}
