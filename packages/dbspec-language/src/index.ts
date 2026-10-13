// The dbspec language service: openDocument gives the diagnostics with their ranges, the tokens, the folding ranges
// and the formatted text of one document, and resolveSet gives the document set of a document through an injected
// host. The module graph is checked by tests/module-graph.test.mjs; the command line (cli/) is outside it.
export { openDocument } from './document.js';
export type { Diagnostic, DocumentAnalysis, FoldingRange, FormatResult, OpenOptions, Position, Range, Token } from './document.js';
export { resolveSet } from './set.js';
export type { ResolvedSet, ResolveError, ResolveRule, SetFileDiagnostic, SetHost, SetHostEntry } from './set.js';
