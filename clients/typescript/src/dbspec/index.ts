// dbspec: the schema language of this repository (docs/dbspec.md). readDbspecFile
// reads a document file after checking its signature; parseDbspec
// validates a document against its declared document set; emitDbspec writes a
// parsed document in canonical form; dbspecManifest gives the manifest text,
// the schema text and their hashes of a document set; renderDbspec writes the
// statements of a document set in one dialect; introspectDbspec reads a
// database into a document and the objects it cannot read. parsePlan,
// emitPlan, chainPlans, diffPlan and planSteps read, write, order, diff
// and render schema plans, applyPlans, recoverPlans, rollbackPlans and
// finalizePlans apply, continue, undo and finalize them on a database, and compareSchemas lists every difference of two schemas
// (docs/plans.md). exportMermaid and importMermaid write and read
// standard Mermaid erDiagrams (docs/mermaid.md).
import { createHash } from 'node:crypto';
import { emitDocument } from './emit.js';
import type { DbspecDiagnostic, DbspecDocument } from './model.js';
import { parseDocument } from './parse.js';
import { checkSet } from './set.js';

export { renderDbspec, type DbspecDialect, type DbspecRenderResult } from './render.js';
export { DBSPEC_SIGNATURE, readDbspecBytes, readDbspecFile, type DbspecReadResult } from './file.js';
export {
  introspectDbspec,
  type DbspecIntrospection,
  type DbspecMySqlConnection,
  type DbspecPostgresConnection,
  type DbspecSqliteConnection,
  type DbspecUnsupported,
} from './introspect.js';

export {
  chainPlans,
  emitPlan,
  parsePlan,
  type DbspecChainResult,
  type DbspecColumnName,
  type DbspecColumnRename,
  type DbspecPlan,
  type DbspecPlanResult,
  type DbspecTableRename,
} from './plan.js';
export {
  applyPlans,
  DbspecApplyError,
  finalizePlans,
  recoverPlans,
  rollbackPlans,
  type DbspecApplyErrorCode,
  type DbspecApplyEvent,
  type DbspecApplyEventKind,
  type DbspecApplyHandler,
  type DbspecApplyMySqlConnection,
  type DbspecApplyPostgresConnection,
  type DbspecApplySqliteConnection,
} from './apply.js';
export { exportMermaid, importMermaid, type DbspecMermaidExport, type DbspecMermaidImport } from './mermaid.js';
export { diffPlan, type DbspecChange, type DbspecDiffResult } from './plan_diff.js';
export { compareSchemas, type DbspecComparisonResult, type DbspecDifference } from './compare.js';
export { planSteps, effectText, type DbspecPlanStepsResult, type DbspecPlanStep, type DbspecEffect, type DbspecNullCheck } from './plan_steps.js';

export type * from './model.js';

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
 * document name order, or the diagnostics of an invalid set (docs/dbspec.md,
 * "Manifest and hashes").
 */
export function dbspecManifest(documents: readonly DbspecDocument[]): DbspecManifestResult {
  if (!Array.isArray(documents)) throw new TypeError('dbspec documents must be an array of parsed documents');
  const { ordered, diagnostics } = checkSet(documents);
  if (diagnostics.length > 0) return Object.freeze({ manifest: null, diagnostics });
  let manifestText = '';
  for (const document of ordered) manifestText += emitDocument(document, 'manifest');
  // schema text는 집합의 모든 table을 이름 순으로 담은 문서 `schema` 하나이므로 문서를 나누는 방식과 무관하다.
  const tables = ordered.flatMap(d => d.tables).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const schemaText = emitDocument({ name: 'schema', uses: [], tables, diagrams: [], closingComments: [] }, 'schema');
  const manifest = Object.freeze({ manifestText, schemaText, manifestHash: textHash(manifestText), schemaHash: textHash(schemaText) });
  return Object.freeze({ manifest, diagnostics: Object.freeze([]) as readonly [] });
}
