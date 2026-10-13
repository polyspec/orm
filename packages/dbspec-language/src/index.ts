// The dbspec language service: openDocument gives the diagnostics with their ranges, the tokens, the folding ranges
// and the formatted text of one document. The module graph is checked by tests/module-graph.test.mjs.
export { openDocument } from './document.js';
export type { Diagnostic, DocumentAnalysis, FoldingRange, FormatResult, OpenOptions, Position, Range, Token } from './document.js';
