// The parser functions of dbspec documents (docs/dbspec.md): parseDbspec validates a document against its declared
// document set, analyzeDbspec gives the same parse with the tokens of the text, formatDbspec gives the canonical text
// of a document with no diagnostic, and emitDbspec writes a parsed document in canonical form. This module and the
// modules it imports read no Node global and load no driver, so the browser entry (entry.ts) can export them.
import type { DbspecDiagnostic, DbspecDocument } from './model.js';
import { emitDocument } from './emit.js';
import { analyzeDocument, parseDocument, type DbspecTokenClass, type ParsedDocument } from './parse.js';

/**
 * A declaration of a parsed document (docs/dbspec.md "Declaration positions"): its kind, its path of enclosing names
 * and its own name, and the 1-based line and column, in Unicode code points, of its name token (of the keyword for a
 * setting and the primary key).
 */
export interface DbspecPosition {
  readonly kind: string;
  readonly path: readonly string[];
  readonly line: number;
  readonly column: number;
}

/**
 * The document with its positions in source order and no diagnostic, or every diagnostic in source order with no
 * document and no positions.
 */
export type DbspecParseResult =
  | { readonly document: DbspecDocument; readonly positions: readonly DbspecPosition[]; readonly diagnostics: readonly [] }
  | { readonly document: null; readonly positions: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/**
 * Parses and validates a dbspec document. `documents` maps each other document
 * name of the declared set to its text, for `use` lines. The text and every
 * document text are strings; a string that is not well-formed UTF-16 is an
 * `encoding` diagnostic.
 */
function documentSet(text: string, documents: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (typeof text !== 'string') throw new TypeError('dbspec text must be a string');
  if (documents === null || typeof documents !== 'object' || Array.isArray(documents)) {
    throw new TypeError('dbspec documents must be an object of document names to texts');
  }
  const set: Record<string, string> = {};
  Object.setPrototypeOf(set, null);
  for (const [name, source] of Object.entries(documents)) {
    if (typeof source !== 'string') throw new TypeError(`dbspec document ${name} must be a string`);
    set[name] = source;
  }
  return Object.freeze(set);
}

function frozenParse(parsed: ParsedDocument): DbspecParseResult {
  if (parsed.document !== null) {
    const positions = parsed.positions.map(p =>
      Object.freeze({ kind: p.kind, path: Object.freeze([...p.path]), line: p.line, column: p.column }),
    );
    const noDiagnostics: readonly [] = Object.freeze([]);
    return Object.freeze({ document: parsed.document, positions: Object.freeze(positions), diagnostics: noDiagnostics });
  }
  const diagnostics = parsed.diagnostics.map(d =>
    Object.freeze({ rule: d.rule, line: d.line, column: d.column, message: d.message }),
  );
  return Object.freeze({ document: null, positions: null, diagnostics: Object.freeze(diagnostics) });
}

export function parseDbspec(text: string, documents: Readonly<Record<string, string>>): DbspecParseResult {
  return frozenParse(parseDocument(text, documentSet(text, documents)));
}

/** A token of a text (docs/dbspec.md "Syntax analysis"): its 1-based line, its start and end in code points, and its class. */
export interface DbspecToken {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly class: DbspecTokenClass;
}

/**
 * The parse result of a text, unchanged, with the tokens of the text in source order. The tokens serve highlighting; a
 * declaration's place is in the positions of the parse result.
 */
export type DbspecAnalysis =
  | { readonly document: DbspecDocument; readonly positions: readonly DbspecPosition[]; readonly diagnostics: readonly []; readonly tokens: readonly DbspecToken[] }
  | { readonly document: null; readonly positions: null; readonly diagnostics: readonly DbspecDiagnostic[]; readonly tokens: readonly DbspecToken[] };

export function analyzeDbspec(text: string, documents: Readonly<Record<string, string>>): DbspecAnalysis {
  const { parsed, tokens } = analyzeDocument(text, documentSet(text, documents));
  const result = frozenParse(parsed);
  const frozenTokens = tokens.map(t => Object.freeze({ line: t.line, start: t.start, end: t.end, class: t.cls }));
  return Object.freeze({ ...result, tokens: Object.freeze(frozenTokens) });
}

/** The formatted text of a document with no diagnostic, or its diagnostics and no text (docs/dbspec.md "Formatting"). */
export type DbspecFormatResult =
  | { readonly text: string; readonly diagnostics: readonly [] }
  | { readonly text: null; readonly diagnostics: readonly DbspecDiagnostic[] };

export function formatDbspec(text: string, documents: Readonly<Record<string, string>>): DbspecFormatResult {
  const result = parseDbspec(text, documents);
  if (result.document === null) return Object.freeze({ text: null, diagnostics: result.diagnostics });
  const noDiagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({ text: emitDbspec(result.document), diagnostics: noDiagnostics });
}

/** Writes a document in canonical form: emitting a parsed canonical text returns the same text. */
export function emitDbspec(document: DbspecDocument): string {
  return emitDocument(document, 'canonical');
}

