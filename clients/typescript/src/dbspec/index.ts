// dbspec: the schema language of this repository (docs/dbspec.md). parseDbspec
// validates a document against its declared document set; emitDbspec writes a
// parsed document in canonical form.
import { emitDocument } from './emit.js';
import type { DbspecDocument, DbspecRule } from './model.js';
import { parseDocument } from './parse.js';

export type * from './model.js';

/** One SCHEMA_INVALID diagnostic: the rule, the 1-based line and column of the offending token, and a message. */
export interface DbspecDiagnostic {
  readonly rule: DbspecRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** The document and no diagnostic, or every diagnostic in source order and no document. */
export type DbspecParseResult =
  | { readonly document: DbspecDocument; readonly diagnostics: readonly [] }
  | { readonly document: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/**
 * Parses and validates a dbspec document. `documents` maps each other document
 * name of the declared set to its text, for `use` lines. The text and every
 * document text are strings; a string that is not well-formed UTF-16 is an
 * `encoding` diagnostic.
 */
export function parseDbspec(text: string, documents: Readonly<Record<string, string>>): DbspecParseResult {
  if (typeof text !== 'string') throw new TypeError('dbspec text must be a string');
  if (documents === null || typeof documents !== 'object' || Array.isArray(documents)) {
    throw new TypeError('dbspec documents must be an object of document names to texts');
  }
  const set: Record<string, string> = Object.create(null);
  for (const [name, source] of Object.entries(documents)) {
    if (typeof source !== 'string') throw new TypeError(`dbspec document ${name} must be a string`);
    set[name] = source;
  }
  const parsed = parseDocument(text, Object.freeze(set));
  if (parsed.document !== null) return Object.freeze({ document: parsed.document, diagnostics: Object.freeze([]) as readonly [] });
  const diagnostics = parsed.diagnostics.map(d =>
    Object.freeze({ rule: d.rule, line: d.line, column: d.column, message: d.message }),
  );
  return Object.freeze({ document: null, diagnostics: Object.freeze(diagnostics) });
}

/** Writes a document in canonical form: emitting a parsed canonical text returns the same text. */
export function emitDbspec(document: DbspecDocument): string {
  return emitDocument(document);
}
