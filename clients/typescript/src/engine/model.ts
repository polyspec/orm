// dbspec 문서 집합에서 만드는 runtime model (docs/dbspec.md "Runtime model").
// generated code는 manifest text와 manifestHash를 담고, runtime은 그 text를
// 한 번 parse해서 entity, field, key, codec stage와 setting을 얻는다.
import { dbspecManifest, parseDbspec } from '../dbspec/index.js';
import type { DbspecCodecStage, DbspecDocument, DbspecTable, DbspecType } from '../dbspec/model.js';
import { OrmError } from '../runtime_error.js';

export type FieldType = DbspecType['kind'];

/** One column of an entity. */
export interface Field {
  readonly name: string;
  readonly type: FieldType;
  readonly nullable: boolean;
  /** The automatic key: never written by an insert, its generated key is returned. */
  readonly identity: boolean;
  /** The column has a default, which an insert that omits it takes from the database. */
  readonly hasDefault: boolean;
  /**
   * default가 `now`다. sub-second clock이 없는 dialect(SQLite)는 이 column을 뺀 insert에
   * executor clock을 bind한다.
   */
  readonly defaultNow: boolean;
  /** decimal(p,s) p, time(p) and datetime(p) p, otherwise 0. */
  readonly precision: number;
  /** decimal(p,s) s, otherwise 0. */
  readonly scale: number;
  /** varchar(n) n, otherwise 0. */
  readonly length: number;
  /** The codec stages in write order. */
  readonly stages: readonly DbspecCodecStage[];
  /** The column belongs to the default select set (it is not `select explicit`). */
  readonly selected: boolean;
  readonly primary: boolean;
  /** The column is a column of a foreign key of its table. */
  readonly foreign: boolean;
  /** The blind index column of an AES column, or ''. */
  readonly blindIndex: string;
}

/** One table of the document set. */
export interface Entity {
  readonly name: string;
  readonly table: string;
  readonly fields: readonly Field[];
  readonly primaryKey: readonly string[];
  /** The identity column, or ''. */
  readonly identity: string;
  /** The columns of each unique key, in declaration order. */
  readonly uniques: readonly (readonly string[])[];
  /** The names of the indexes and unique keys. */
  readonly indexes: readonly string[];
  /** The `updated` column, or ''. */
  readonly updated: string;
  /** The `soft_delete` column, or ''. */
  readonly softDelete: string;
  /** The `aes_version` column, or ''. */
  readonly aesVersion: string;
  /** The operation column of an `audit` setting, or ''. */
  readonly auditOperation: string;
}

/** The runtime model of a document set with its manifest text and hash. */
export interface RuntimeModel {
  readonly manifestText: string;
  readonly manifestHash: string;
  /** Entities by name, documents in name order and tables in document order. */
  readonly entities: ReadonlyMap<string, Entity>;
}

const fieldIndexes = new WeakMap<Entity, ReadonlyMap<string, Field>>();

/** Returns the field of an entity, or undefined. */
export function fieldOf(e: Entity, name: string): Field | undefined {
  let index = fieldIndexes.get(e);
  if (index === undefined) {
    index = new Map(e.fields.map(f => [f.name, f]));
    fieldIndexes.set(e, index);
  }
  return index.get(name);
}

export function entityOf(m: RuntimeModel, name: string): Entity | undefined {
  return m.entities.get(name);
}

const HEADER = 'dbspec 1 ';

/** Splits the concatenated documents of a manifest text at their header lines. */
export function splitDocuments(text: string): string[] {
  if (!text.startsWith(HEADER)) throw new OrmError('SCHEMA_INVALID', 'manifest text does not start with a dbspec header');
  const out: string[] = [];
  let start = 0;
  for (let at = text.indexOf(`\n${HEADER}`); at >= 0; at = text.indexOf(`\n${HEADER}`, at + 1)) {
    out.push(text.slice(start, at + 1));
    start = at + 1;
  }
  out.push(text.slice(start));
  return out;
}

function headerName(text: string): string {
  return text.slice(HEADER.length, text.indexOf('\n'));
}

function typeSizes(t: DbspecType): { precision: number; scale: number; length: number } {
  switch (t.kind) {
    case 'decimal': return { precision: t.precision, scale: t.scale, length: 0 };
    case 'time': case 'datetime': return { precision: t.precision, scale: 0, length: 0 };
    case 'varchar': return { precision: 0, scale: 0, length: t.length };
    default: return { precision: 0, scale: 0, length: 0 };
  }
}

function entityOfTable(t: DbspecTable): Entity {
  let name = t.name;
  let updated = '';
  let softDelete = '';
  let aesVersion = '';
  let auditOperation = '';
  const explicit = new Set<string>();
  const stages = new Map<string, readonly DbspecCodecStage[]>();
  const blind = new Map<string, string>();
  for (const s of t.settings?.settings ?? []) {
    switch (s.kind) {
      case 'entity': name = s.name; break;
      case 'updated': updated = s.column; break;
      case 'soft_delete': softDelete = s.column; break;
      case 'aes_version': aesVersion = s.column; break;
      case 'select_explicit': for (const c of s.columns) explicit.add(c); break;
      case 'codec': stages.set(s.column, s.stages); break;
      case 'blind_index': blind.set(s.column, s.indexColumn); break;
      case 'audit': auditOperation = s.operation; break;
      case 'navigation': case 'immutable': break;
    }
  }
  const primary = new Set(t.primaryKey.columns);
  const foreign = new Set(t.foreignKeys.flatMap(k => k.columns));
  const fields: Field[] = t.columns.map(c => Object.freeze({
    name: c.name,
    type: c.type.kind,
    nullable: c.nullable,
    identity: c.identity,
    hasDefault: c.default !== null,
    defaultNow: c.default?.kind === 'now',
    ...typeSizes(c.type),
    stages: stages.get(c.name) ?? [],
    selected: !explicit.has(c.name),
    primary: primary.has(c.name),
    foreign: foreign.has(c.name),
    blindIndex: blind.get(c.name) ?? '',
  }));
  return Object.freeze({
    name,
    table: t.name,
    fields: Object.freeze(fields),
    primaryKey: t.primaryKey.columns,
    identity: t.columns.find(c => c.identity)?.name ?? '',
    uniques: Object.freeze(t.uniques.map(u => u.columns)),
    indexes: Object.freeze([...t.uniques.map(u => u.name), ...t.indexes.map(i => i.name)]),
    updated,
    softDelete,
    aesVersion,
    auditOperation,
  });
}

/** The runtime model of parsed documents of one document set; the set must have a manifest. */
export function modelOfDocuments(documents: readonly DbspecDocument[]): RuntimeModel {
  const result = dbspecManifest(documents);
  if (result.manifest === null) {
    const d = result.diagnostics[0]!;
    throw new OrmError('SCHEMA_INVALID', `document set: ${d.rule} at ${d.line}:${d.column}: ${d.message}`);
  }
  const entities = new Map<string, Entity>();
  for (const document of [...documents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    for (const table of document.tables) {
      const e = entityOfTable(table);
      if (entities.has(e.name)) throw new OrmError('SCHEMA_INVALID', `entity ${e.name} is declared twice in the document set`);
      entities.set(e.name, e);
    }
  }
  return Object.freeze({ manifestText: result.manifest.manifestText, manifestHash: result.manifest.manifestHash, entities });
}

/** Parses dbspec texts of one document set; each text is parsed with the others as its used documents. */
export function parseDocumentSet(texts: readonly string[]): DbspecDocument[] {
  const named: Record<string, string> = {};
  for (const text of texts) {
    if (typeof text !== 'string' || !text.startsWith(HEADER)) throw new OrmError('SCHEMA_INVALID', 'a dbspec text does not start with its header');
    named[headerName(text)] = text;
  }
  return texts.map(text => {
    const others = Object.fromEntries(Object.entries(named).filter(([name]) => name !== headerName(text)));
    const parsed = parseDbspec(text, others);
    if (parsed.document === null) {
      const d = parsed.diagnostics[0]!;
      throw new OrmError('SCHEMA_INVALID', `document ${headerName(text)}: ${d.rule} at ${d.line}:${d.column}: ${d.message}`);
    }
    return parsed.document;
  });
}

/**
 * Builds the runtime model of a manifest text and checks that the text is the
 * manifest text of its documents (SCHEMA_INVALID otherwise) and that
 * manifestHash is its hash (SCHEMA_HASH_MISMATCH otherwise).
 */
export function modelOfManifest(manifestText: string, manifestHash: string): RuntimeModel {
  const model = modelOfDocuments(parseDocumentSet(splitDocuments(manifestText)));
  if (model.manifestText !== manifestText) throw new OrmError('SCHEMA_INVALID', 'the embedded text is not the manifest text of its documents');
  if (model.manifestHash !== manifestHash) {
    throw new OrmError('SCHEMA_HASH_MISMATCH', `generated code declares manifest ${manifestHash}, its manifest text hashes to ${model.manifestHash}: generate the models again`);
  }
  return model;
}
