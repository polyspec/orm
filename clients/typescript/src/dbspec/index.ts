// dbspec: the schema language of this repository (docs/dbspec.md). parseDbspec
// validates a document against its declared document set; emitDbspec writes a
// parsed document in canonical form; dbspecManifest gives the manifest text,
// the schema text and their hashes of a document set; renderDbspec writes the
// statements of a document set in one dialect.
import { createHash } from 'node:crypto';
import { emitDocument } from './emit.js';
import type { DbspecDocument, DbspecRule } from './model.js';
import { parseDocument } from './parse.js';

export { renderDbspec, type DbspecDialect } from './render.js';

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
  return emitDocument(document, 'canonical');
}

/** The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes"). */
export interface DbspecManifest {
  readonly manifestText: string;
  readonly schemaText: string;
  readonly manifestHash: string;
  readonly schemaHash: string;
}

/** The manifest and no diagnostic, or the diagnostics and no manifest. */
export type DbspecManifestResult =
  | { readonly manifest: DbspecManifest; readonly diagnostics: readonly [] }
  | { readonly manifest: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/** sha256: and the lower-case hexadecimal SHA-256 of the UTF-8 text. */
function textHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Returns the manifest of the document set, whose documents are taken in
 * document name order. A document name that repeats in the set is a
 * name.duplicate diagnostic at the header name of the later document.
 */
export function dbspecManifest(documents: readonly DbspecDocument[]): DbspecManifestResult {
  const ordered = [...documents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let manifestText = '';
  let schemaText = '';
  for (let i = 0; i < ordered.length; i++) {
    const document = ordered[i]!;
    if (i > 0 && ordered[i - 1]!.name === document.name) {
      const diagnostic = Object.freeze({
        rule: 'name.duplicate' as const,
        line: 1,
        column: 'dbspec 1 '.length + 1,
        message: `document ${document.name} appears twice in the document set`,
      });
      return Object.freeze({ manifest: null, diagnostics: Object.freeze([diagnostic]) });
    }
    manifestText += emitDocument(document, 'manifest');
    schemaText += emitDocument(document, 'schema');
  }
  const manifest = Object.freeze({ manifestText, schemaText, manifestHash: textHash(manifestText), schemaHash: textHash(schemaText) });
  return Object.freeze({ manifest, diagnostics: Object.freeze([]) as readonly [] });
}
