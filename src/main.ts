/**
 * Plugin entry point.
 *
 * Obsidian loads `main.js` and instantiates its default export; the
 * implementation lives in `obsidian/main.ts` so the core stays importable by
 * the Node test harness without pulling in the `obsidian` module.
 */
export { default } from './obsidian/main';
