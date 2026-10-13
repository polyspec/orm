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
import type { DbspecColumn, DbspecDiagnostic, DbspecDocument, DbspecTable, DbspecUse } from './model.js';
import { emitDocument, typeText } from './emit.js';
import { analyzeDocument, parseDocument, type DbspecTokenClass, type ParsedDocument } from './parse.js';
export type { DbspecTokenClass } from './parse.js';
import { checkSet } from './set.js';

export { renderDbspec, renderDbspecStatements, type DbspecDialect, type DbspecRenderResult, type DbspecRenderStatementsResult, type DbspecRenderedStatement } from './render.js';
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
export type { DbspecMySqlQueryResult, DbspecSqliteStatement } from './connections.js';
export { exportMermaid, importMermaid, type DbspecMermaidExport, type DbspecMermaidImport } from './mermaid.js';
export { diffPlan, type DbspecChange, type DbspecDiffResult } from './plan_diff.js';
export { compareSchemas, type DbspecComparisonResult, type DbspecDifference } from './compare.js';
export { addTablesAndColumnsSteps, installedDifferences, type DbspecAddTablesAndColumnsSteps } from './add_tables_and_columns.js';
export { planSteps, effectText, type DbspecPlanStepsResult, type DbspecPlanStep, type DbspecEffect, type DbspecNullCheck } from './plan_steps.js';

export type * from './model.js';

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
  const set: Record<string, string> = Object.create(null);
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
    return Object.freeze({ document: parsed.document, positions: Object.freeze(positions), diagnostics: Object.freeze([]) as readonly [] });
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
  return Object.freeze({ text: emitDbspec(result.document), diagnostics: Object.freeze([]) as readonly [] });
}

/** Writes a document in canonical form: emitting a parsed canonical text returns the same text. */
export function emitDbspec(document: DbspecDocument): string {
  return emitDocument(document, 'canonical');
}

/** The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes"). */
export interface DbspecManifest {
  readonly manifestText: string;
  /**
   * For each external document in name order, the tables that owned documents use, with their columns,
   * primary key and unique keys; empty without external documents.
   */
  readonly externalText: string;
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
 * "Manifest and hashes"). The manifest text holds the owned documents; the
 * external text holds, for each external document, the tables that owned
 * documents use, with their columns, primary key and unique keys; the schema
 * text holds the owned tables and a use line for each external document they
 * use; and manifestHash covers the manifest text followed by the external text.
 */
export function dbspecManifest(documents: readonly DbspecDocument[]): DbspecManifestResult {
  if (!Array.isArray(documents)) throw new TypeError('dbspec documents must be an array of parsed documents');
  const { ordered, diagnostics } = checkSet(documents);
  if (diagnostics.length > 0) return Object.freeze({ manifest: null, diagnostics });
  const used = new Map<string, string[]>();
  for (const document of ordered) {
    if (document.external === true) continue;
    for (const u of document.uses) {
      const tables = used.get(u.document) ?? [];
      for (const table of u.tables) if (!tables.includes(table)) tables.push(table);
      used.set(u.document, tables);
    }
  }
  let manifestText = '';
  let externalText = '';
  const uses: DbspecUse[] = [];
  const owned: DbspecTable[] = [];
  for (const document of ordered) {
    if (document.external === true) {
      const trimmed = externalDocument(document, used.get(document.name) ?? []);
      if (trimmed !== null) {
        externalText += emitDocument(trimmed, 'manifest');
        uses.push({ comments: [], document: document.name, tables: [...used.get(document.name)!].sort(compareText) });
      }
      continue;
    }
    manifestText += emitDocument(document, 'manifest');
    owned.push(...document.tables);
  }
  // schema text는 집합이 소유한 모든 table을 이름 순으로 담은 문서 `schema` 하나이므로 문서를 나누는 방식과 무관하다.
  // 외부 문서에서 쓰는 table은 그 문서의 use 줄로 남는다.
  const tables = owned.sort((a, b) => compareText(a.name, b.name));
  const schemaText = emitDocument({ name: 'schema', uses, tables, diagrams: [], closingComments: [] }, 'schema');
  const manifest = Object.freeze({
    manifestText, externalText, schemaText, manifestHash: textHash(manifestText + externalText), schemaHash: textHash(schemaText),
  });
  return Object.freeze({ manifest, diagnostics: Object.freeze([]) as readonly [] });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 외부 문서에서 tables의 column, primary key, unique key만 문서 순서로 담은 문서다. 그 table이 없으면 null이다. foreign
 * key, index, check, setting은 외부 문서가 소유하므로 담지 않는다.
 */
function externalDocument(document: DbspecDocument, tables: readonly string[]): DbspecDocument | null {
  const kept: DbspecTable[] = document.tables.filter(t => tables.includes(t.name)).map(t => ({
    comments: [], name: t.name, columns: t.columns, primaryKey: { comments: [], columns: t.primaryKey.columns }, uniques: t.uniques,
    indexes: [], foreignKeys: [], checks: [], settings: null, closingComments: [],
  }));
  if (kept.length === 0) return null;
  return { name: document.name, uses: [], tables: kept, diagrams: [], closingComments: [] };
}

/**
 * Checks the tables that a document set uses from external documents against the database (docs/dbspec.md
 * "External documents"). `live` is the introspected database. For every used table, in table name order, it
 * returns the differences: a missing table; per column of the external document in column order a missing
 * column, another type or another nullability; another primary key; and a unique key whose columns no live
 * unique key has. Extra live columns are not differences. A set without external documents has none.
 */
export function externalDifferences(live: DbspecDocument, documents: readonly DbspecDocument[]): string[] {
  const externals = new Map(documents.filter(d => d.external === true).map(d => [d.name, d]));
  const tables: DbspecTable[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    if (document.external === true) continue;
    for (const u of document.uses) {
      const external = externals.get(u.document);
      if (external === undefined) continue;
      for (const name of u.tables) {
        const table = external.tables.find(t => t.name === name);
        if (table !== undefined && !seen.has(name)) {
          seen.add(name);
          tables.push(table);
        }
      }
    }
  }
  tables.sort((a, b) => compareText(a.name, b.name));
  const liveTables = new Map(live.tables.map(t => [t.name, t]));
  const nullText = (nullable: boolean): string => (nullable ? 'null' : 'not null');
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((c, i) => c === b[i]);
  const out: string[] = [];
  for (const want of tables) {
    const got = liveTables.get(want.name);
    if (got === undefined) {
      out.push(`table ${want.name} does not exist`);
      continue;
    }
    for (const c of want.columns) {
      const g: DbspecColumn | undefined = got.columns.find(x => x.name === c.name);
      if (g === undefined) out.push(`column ${want.name}.${c.name} does not exist`);
      else if (typeText(g.type) !== typeText(c.type)) out.push(`column ${want.name}.${c.name} is ${typeText(g.type)}, not ${typeText(c.type)}`);
      else if (g.nullable !== c.nullable) out.push(`column ${want.name}.${c.name} is ${nullText(g.nullable)}, not ${nullText(c.nullable)}`);
    }
    if (!same(got.primaryKey.columns, want.primaryKey.columns)) {
      out.push(`table ${want.name} has the primary key (${got.primaryKey.columns.join(', ')}), not (${want.primaryKey.columns.join(', ')})`);
    }
    for (const u of want.uniques) {
      if (!got.uniques.some(g => same(g.columns, u.columns))) out.push(`table ${want.name} has no unique key (${u.columns.join(', ')})`);
    }
  }
  return out;
}
