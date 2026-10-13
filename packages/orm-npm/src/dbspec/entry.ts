// The browser-safe entry of dbspec (docs/editor.md "Layers"), exported by @polyspec/orm as the "./dbspec" subpath.
// Its modules import no `node:` module, read no Node global (Buffer, process, __dirname, require) and load no driver,
// so it runs in a browser as in Node. The module-graph test packages/orm-npm/tests/browser-entry.mjs checks this.
export { analyzeDbspec, emitDbspec, formatDbspec, parseDbspec, type DbspecAnalysis, type DbspecFormatResult, type DbspecParseResult, type DbspecPosition, type DbspecToken } from './document.js';
export { readDbspecBytes, type DbspecReadResult } from './read_bytes.js';
export { parseSet, type DbspecSetError, type DbspecSetParseResult, type DbspecSetPath, type DbspecSetRule } from './set_file.js';
export type { DbspecTokenClass } from './parse.js';
export type * from './model.js';
