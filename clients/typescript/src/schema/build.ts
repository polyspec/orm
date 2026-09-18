// The schema manifest (schema.json) derived from Mermaid diagrams: names,
// canonical types, relations, and validation. The canonical JSON form and its
// hash are identical to the reference schema builder.
import { createHash } from 'node:crypto';
import { indentJson } from '../engine/manifest.js';
import {
  byteOrder, jsonString, list, map, object, optBool, optInt, optList, optMap, optString, quoted, stringList,
} from './json.js';
import { cut, fields, trimSpace, type Diagram, type DColumn, type DEntity, type DRelation, type Directive, type OrmDirective } from './mermaid.js';

export interface SchemaRef { entity: string; column: string; }

export interface SchemaColumn {
  name: string;
  renamed_from?: string;
  type: string;
  raw: string;
  nullable?: boolean;
  default?: string | null;
  auto?: boolean;
  on_update?: boolean;
  unsigned?: boolean;
  lazy?: boolean;
  len?: number;
  precision?: number;
  scale?: number;
  enum?: string[] | null;
  styles?: string[] | null;
  blind_index?: string;
  ref?: SchemaRef | null;
  pk?: boolean;
  fk?: boolean;
  uk?: boolean;
  describe?: string;
  comment?: string;
  /** Source line; build-time only. */
  line?: number;
  /** The column declared its target with `->`; build-time only. */
  refExplicit?: boolean;
}

export interface SchemaRelKey { local: string; target: string; }

export interface SchemaRel {
  name: string;
  kind: string;
  target: string;
  keys: SchemaRelKey[] | null;
  on_delete?: string;
  foreign_key?: boolean;
}

export interface SchemaCheck { name: string; expr: string; }

export interface SchemaEntity {
  name: string;
  table: string;
  renamed_from?: string;
  comment?: string;
  pk: string[] | null;
  auto?: string;
  columns: SchemaColumn[] | null;
  relations: Record<string, SchemaRel> | null;
  unique?: string[][] | null;
  indexes?: Record<string, string[]> | null;
  fulltext?: string[][] | null;
  checks?: SchemaCheck[] | null;
  timestamps?: { created?: string; updated?: string } | null;
  soft_delete?: string;
  aes_version?: string;
  line?: number;
}

export interface SchemaOrmDirective { kind: string; name?: string; args?: Record<string, string> | null; raw: string; line?: number; }

export interface SchemaExternalFK {
  entity: string;
  columns: string[] | null;
  target_table: string;
  target_columns: string[] | null;
  name?: string;
  on_delete?: string;
  deferred?: boolean;
}

export interface SchemaManifest {
  schema_hash: string;
  order: string[] | null;
  entities: Record<string, SchemaEntity> | null;
  orm?: SchemaOrmDirective[] | null;
  external_fks?: SchemaExternalFK[] | null;
  immutable?: string[] | null;
  audit_log?: SchemaAuditLog;
  audits?: SchemaAudit[];
}

export interface SchemaAuditTable {
  table: string;
  columns: string[];
}

export interface SchemaAuditLog {
  operation: SchemaAuditTable;
  context: string;
  change: SchemaAuditTable;
}

export interface SchemaAudit {
  entity: string;
  mode: string;
  site?: string;
  redact?: string[][];
}

/** A semantic schema error with its source line (0 when unknown). */
export class SchemaBuildError extends Error {
  public constructor(public readonly line: number, public readonly detail: string) {
    super(line > 0 ? `line ${line}: ${detail}` : detail);
  }
}

// Column names follow the reserved-name rules of the model syntax
// (docs/dsl.md §9). SQL keywords are allowed because every dialect quotes
// identifiers.
export const reservedSegments = ['and', 'or', 'with', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'lk', 'lb', 'between', 'fulltext', 'tuple'];
export const reservedPrefixes = ['and', 'or', 'get', 'set', 'new', 'plus', 'minus', 'order_by', 'group_by', 'tuple', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'lk', 'lb', 'between', 'fulltext'];
export const reservedColumns = ['and', 'or', 'get', 'gets', 'gets_page', 'get_query', 'limit', 'alias', 'connect', 'create', 'creates', 'update', 'delete', 'save', 'raw', 'on', 'random'];
const reservedEntities = ['connect', 'schema_hash'];

const reTypeParen = /^([a-z]+)(?:\(([^)]*)\))?$/;
const reIdent = /^[a-z][a-z0-9_]*$/;

// ---- canonical JSON ----

function encodeRef(r: SchemaRef): string {
  return object([['entity', jsonString(r.entity)], ['column', jsonString(r.column)]]);
}

function encodeColumn(c: SchemaColumn): string {
  return object([
    ['name', jsonString(c.name)],
    ['renamed_from', optString(c.renamed_from)],
    ['type', jsonString(c.type)],
    ['raw', jsonString(c.raw)],
    ['nullable', optBool(c.nullable)],
    ['default', c.default === undefined || c.default === null ? undefined : jsonString(c.default)],
    ['auto', optBool(c.auto)],
    ['on_update', optBool(c.on_update)],
    ['unsigned', optBool(c.unsigned)],
    ['lazy', optBool(c.lazy)],
    ['len', optInt(c.len)],
    ['precision', optInt(c.precision)],
    ['scale', optInt(c.scale)],
    ['enum', optList(c.enum, jsonString)],
    ['styles', optList(c.styles, jsonString)],
    ['blind_index', optString(c.blind_index)],
    ['ref', c.ref ? encodeRef(c.ref) : undefined],
    ['pk', optBool(c.pk)],
    ['fk', optBool(c.fk)],
    ['uk', optBool(c.uk)],
    ['describe', optString(c.describe)],
    ['comment', optString(c.comment)],
  ]);
}

function encodeRel(r: SchemaRel): string {
  return object([
    ['name', jsonString(r.name)],
    ['kind', jsonString(r.kind)],
    ['target', jsonString(r.target)],
    ['keys', list(r.keys, k => object([['local', jsonString(k.local)], ['target', jsonString(k.target)]]))],
    ['on_delete', optString(r.on_delete)],
    ['foreign_key', optBool(r.foreign_key)],
  ]);
}

function encodeEntity(e: SchemaEntity): string {
  return object([
    ['name', jsonString(e.name)],
    ['table', jsonString(e.table)],
    ['renamed_from', optString(e.renamed_from)],
    ['comment', optString(e.comment)],
    ['pk', stringList(e.pk)],
    ['auto', optString(e.auto)],
    ['columns', list(e.columns, encodeColumn)],
    ['relations', map(e.relations, encodeRel)],
    ['unique', optList(e.unique, stringList)],
    ['indexes', optMap(e.indexes, stringList)],
    ['fulltext', optList(e.fulltext, stringList)],
    ['checks', optList(e.checks, c => object([['name', jsonString(c.name)], ['expr', jsonString(c.expr)]]))],
    ['timestamps', e.timestamps ? object([['created', optString(e.timestamps.created)], ['updated', optString(e.timestamps.updated)]]) : undefined],
    ['soft_delete', optString(e.soft_delete)],
    ['aes_version', optString(e.aes_version)],
  ]);
}

function encodeOrm(x: SchemaOrmDirective): string {
  return object([
    ['kind', jsonString(x.kind)],
    ['name', optString(x.name)],
    ['args', optMap(x.args, jsonString)],
    ['raw', jsonString(x.raw)],
  ]);
}

function encodeExternal(fk: SchemaExternalFK): string {
  return object([
    ['entity', jsonString(fk.entity)],
    ['columns', stringList(fk.columns)],
    ['target_table', jsonString(fk.target_table)],
    ['target_columns', stringList(fk.target_columns)],
    ['name', optString(fk.name)],
    ['on_delete', optString(fk.on_delete)],
    ['deferred', optBool(fk.deferred)],
  ]);
}

/** The compact canonical JSON of a manifest. */
export function encodeManifest(m: SchemaManifest): string {
  return object([
    ['schema_hash', jsonString(m.schema_hash)],
    ['order', stringList(m.order)],
    ['entities', map(m.entities, encodeEntity)],
    ['orm', optList(m.orm, encodeOrm)],
    ['external_fks', optList(m.external_fks, encodeExternal)],
    ['immutable', optList(m.immutable, jsonString)],
    ['audit_log', m.audit_log === undefined ? undefined : object([
      ['operation', encodeAuditTable(m.audit_log.operation)],
      ['context', jsonString(m.audit_log.context)],
      ['change', encodeAuditTable(m.audit_log.change)],
    ])],
    ['audits', optList(m.audits, a => object([
      ['entity', jsonString(a.entity)],
      ['mode', jsonString(a.mode)],
      ['site', optString(a.site)],
      ['redact', optList(a.redact, path => stringList(path))],
    ]))],
  ]);
}

function encodeAuditTable(t: SchemaAuditTable): string {
  return object([['table', jsonString(t.table)], ['columns', stringList(t.columns)]]);
}

/** The SHA-256 prefix of the canonical JSON without the hash. */
export function manifestHash(m: SchemaManifest): string {
  const content = encodeManifest({ ...m, schema_hash: '' });
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** schema.json as the builder writes it, without the final newline. */
export function manifestText(m: SchemaManifest): string {
  return indentJson(encodeManifest(m));
}

/** Reads a schema.json produced by the builder and checks its hash. */
export function loadSchemaManifest(text: string): SchemaManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error((error as Error).message); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('schema.json must be a JSON object');
  const m = parsed as SchemaManifest;
  if (typeof m.schema_hash !== 'string') m.schema_hash = '';
  m.order ??= null;
  m.entities ??= null;
  const hash = manifestHash(m);
  if (hash !== m.schema_hash) throw new Error(`schema.json was edited by hand: hash ${m.schema_hash} does not match content ${hash}`);
  return m;
}

export function entityColumn(e: SchemaEntity, name: string): SchemaColumn | undefined {
  return (e.columns ?? []).find(c => c.name === name);
}

export function entitiesOf(m: SchemaManifest): Record<string, SchemaEntity> {
  return m.entities ?? {};
}

function hasEntity(m: SchemaManifest, name: string): boolean {
  return m.entities !== null && Object.hasOwn(m.entities, name);
}

// ---- build ----

/** Derives the manifest from parsed diagrams and validates it. */
export function buildManifest(diagrams: readonly Diagram[], allowMissingAESVersion = false): SchemaManifest {
  const m: SchemaManifest = { schema_hash: '', order: null, entities: {} };
  const entities = m.entities!;
  const orm: OrmDirective[] = [];
  for (const d of diagrams) {
    orm.push(...d.orm);
    for (const e of d.entities) {
      if (Object.hasOwn(entities, e.name)) throw new SchemaBuildError(e.line, 'duplicate entity ' + e.name);
      entities[e.name] = buildEntity(e);
      (m.order ??= []).push(e.name);
    }
  }
  if (orm.length > 0) m.orm = orm.map(x => ({ kind: x.kind, name: x.name, args: x.args, raw: x.raw, line: x.line }));
  for (const d of diagrams) {
    for (const x of d.orm) {
      if (x.kind !== 'table') continue;
      const entity = x.args.entity ?? '';
      const name = x.args.name ?? '';
      if (!Object.hasOwn(entities, entity)) throw new SchemaBuildError(x.line, '%% orm:table: unknown entity ' + entity);
      const ent = entities[entity]!;
      if (!qualifiedTableName(name)) throw new SchemaBuildError(x.line, '%% orm:table: name must be schema.table: ' + name);
      if (ent.table !== entity) throw new SchemaBuildError(x.line, '%% orm:table: duplicate entity ' + entity);
      ent.table = name;
    }
  }
  for (const d of diagrams) for (const r of d.relations) addRelation(m, r);
  for (const d of diagrams) for (const x of d.directives) addDirective(m, x);
  let firstAudit: OrmDirective | undefined;
  for (const d of diagrams) {
    for (const x of d.orm) {
      if (x.kind === 'audit_log') addAuditLog(m, x);
      else if (x.kind === 'audit') {
        firstAudit ??= x;
        addAudit(m, x);
      }
      if (x.kind === 'immutable') {
        const entity = x.args.entity ?? '';
        if (!Object.hasOwn(entities, entity)) throw new SchemaBuildError(x.line, '%% orm:immutable: unknown entity ' + entity);
        m.immutable ??= [];
        if (!m.immutable.includes(entity)) m.immutable.push(entity);
      }
      if (x.kind !== 'foreign') continue;
      (m.external_fks ??= []).push(externalFK(x, m));
    }
  }
  finishAudits(m, firstAudit);
  validate(m, allowMissingAESVersion);
  m.schema_hash = manifestHash(m);
  return m;
}

const reAuditTable = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(([^()]*)\)$/;
const reAuditContext = /^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$/;
const reAuditSegment = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The audit log tables are references like the target of %% orm:foreign: they
// may belong to another manifest installed on the same connection, so only the
// syntax and the column count are checked.
function auditTable(x: OrmDirective, option: string, width: number): SchemaAuditTable {
  const match = reAuditTable.exec(x.args[option] ?? '');
  if (!match) throw new SchemaBuildError(x.line, `%% orm:audit_log: ${option} must be table(column, ...)`);
  const columns = splitDirectiveList(match[2]!);
  if (columns.length !== width) throw new SchemaBuildError(x.line, `%% orm:audit_log: ${option} needs ${width} columns`);
  for (const column of columns) {
    if (!reAuditSegment.test(column)) throw new SchemaBuildError(x.line, `%% orm:audit_log: ${option} has an invalid column ${column}`);
  }
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) throw new SchemaBuildError(x.line, `%% orm:audit_log: ${option} repeats column ${column}`);
    seen.add(column);
  }
  return { table: match[1]!, columns };
}

function addAuditLog(m: SchemaManifest, x: OrmDirective): void {
  if (m.audit_log !== undefined) throw new SchemaBuildError(x.line, '%% orm:audit_log: declared more than once');
  for (const option of ['operation', 'context', 'change']) {
    if ((x.args[option] ?? '') === '') throw new SchemaBuildError(x.line, `%% orm:audit_log: ${option} is required`);
  }
  const operation = auditTable(x, 'operation', 2);
  const change = auditTable(x, 'change', 7);
  if (operation.table === change.table) throw new SchemaBuildError(x.line, '%% orm:audit_log: operation and change must be different tables');
  if (!reAuditContext.test(x.args.context!)) throw new SchemaBuildError(x.line, '%% orm:audit_log: invalid context ' + x.args.context);
  m.audit_log = { operation, context: x.args.context!, change };
}

function addAudit(m: SchemaManifest, x: OrmDirective): void {
  const name = x.args.entity ?? '';
  const e = hasEntity(m, name) ? m.entities![name]! : undefined;
  if (!e) throw new SchemaBuildError(x.line, '%% orm:audit: unknown entity ' + name);
  if ((m.audits ?? []).some(a => a.entity === name)) throw new SchemaBuildError(x.line, `%% orm:audit: entity ${name} is declared more than once`);
  const mode = x.args.mode ?? '';
  if (mode !== 'changes' && mode !== 'operations') throw new SchemaBuildError(x.line, '%% orm:audit: mode must be changes or operations');
  const audit: SchemaAudit = { entity: name, mode };
  const site = x.args.site ?? '';
  if (site !== '') {
    if (!entityColumn(e, site)) throw new SchemaBuildError(x.line, `%% orm:audit: unknown column ${name}.${site}`);
    audit.site = site;
  }
  if (Object.hasOwn(x.args, 'redact')) {
    const redact: string[][] = [];
    for (const item of x.args.redact!.split(',')) {
      const path = item.split('.');
      for (const segment of path) {
        if (!reAuditSegment.test(segment)) throw new SchemaBuildError(x.line, '%% orm:audit: invalid redact path ' + item);
      }
      if (!entityColumn(e, path[0]!)) throw new SchemaBuildError(x.line, `%% orm:audit: unknown column ${name}.${path[0]}`);
      for (const previous of redact) {
        const n = Math.min(previous.length, path.length);
        if (previous.slice(0, n).every((v, i) => v === path[i])) throw new SchemaBuildError(x.line, '%% orm:audit: redact paths overlap: ' + item);
      }
      redact.push(path);
    }
    audit.redact = redact;
  }
  (m.audits ??= []).push(audit);
}

// finishAudits checks the declarations that depend on each other and sorts the
// audits by entity.
function finishAudits(m: SchemaManifest, first: OrmDirective | undefined): void {
  if ((m.audits ?? []).length === 0) return;
  if (m.audit_log === undefined) throw new SchemaBuildError(first!.line, '%% orm:audit requires %% orm:audit_log');
  for (const a of m.audits!) {
    const table = m.entities![a.entity]!.table;
    if (table === m.audit_log.operation.table || table === m.audit_log.change.table) {
      throw new SchemaBuildError(first!.line, `%% orm:audit: the audit log table ${table} cannot be audited`);
    }
  }
  m.audits!.sort((a, b) => byteOrder(a.entity, b.entity));
}

function externalFK(x: OrmDirective, m: SchemaManifest): SchemaExternalFK {
  const entity = x.args.entity ?? '';
  const e = hasEntity(m, entity) ? m.entities![entity]! : undefined;
  if (!e) throw new SchemaBuildError(x.line, '%% orm:foreign: unknown entity ' + entity);
  const columns = splitDirectiveList(x.args.columns ?? '');
  if (columns.length === 0) throw new SchemaBuildError(x.line, '%% orm:foreign: columns must not be empty');
  for (const column of columns) {
    if (!entityColumn(e, column)) throw new SchemaBuildError(x.line, `% orm:foreign: unknown column ${entity}.${column}`);
  }
  const ref = parseExternalReference(x.args.references ?? '');
  if (!ref || ref.table === '' || ref.columns.length !== columns.length) {
    throw new SchemaBuildError(x.line, '%% orm:foreign: references must be table(col,...) with matching columns');
  }
  let name = x.args.name ?? '';
  if (name === '') name = `fk_${e.table.replaceAll('.', '_')}_${columns.join('_')}`;
  const onDelete = x.args.on_delete ?? '';
  if (onDelete !== '' && onDelete !== 'cascade' && onDelete !== 'setnull') {
    throw new SchemaBuildError(x.line, '%% orm:foreign: on_delete must be cascade or setnull');
  }
  const deferredText = x.args.deferred ?? '';
  const deferred = deferredText === 'true';
  if (deferredText !== '' && deferredText !== 'true' && deferredText !== 'false') {
    throw new SchemaBuildError(x.line, '%% orm:foreign: deferred must be true or false');
  }
  return { entity, columns, target_table: ref.table, target_columns: ref.columns, name, on_delete: onDelete, deferred };
}

function splitDirectiveList(value: string): string[] {
  return value.split(',').map(trimSpace).filter(part => part !== '');
}

function parseExternalReference(value: string): { table: string; columns: string[] } | undefined {
  const open = value.lastIndexOf('(');
  if (open <= 0 || !value.endsWith(')')) return undefined;
  const table = trimSpace(value.slice(0, open));
  const columns = splitDirectiveList(value.slice(open + 1, -1));
  return table !== '' && columns.length > 0 ? { table, columns } : undefined;
}

function qualifiedTableName(name: string): boolean {
  const parts = name.split('.');
  return parts.length === 2 && reIdent.test(parts[0]!) && reIdent.test(parts[1]!);
}

function buildEntity(e: DEntity): SchemaEntity {
  if (!reIdent.test(e.name)) throw new SchemaBuildError(e.line, 'entity name must be snake_case: ' + e.name);
  if (reservedEntities.includes(e.name)) throw new SchemaBuildError(e.line, 'entity name is reserved by the generated models: ' + e.name);
  const ent: SchemaEntity = { name: e.name, table: e.name, comment: e.comment, pk: null, columns: null, relations: {}, line: e.line };
  const cols = new Map<string, SchemaColumn>();
  for (const dc of e.columns) {
    const nameError = checkColumnName(dc.name);
    if (nameError) throw new SchemaBuildError(dc.line, nameError);
    if (cols.has(dc.name)) throw new SchemaBuildError(dc.line, `duplicate column ${e.name}.${dc.name}`);
    let c: SchemaColumn;
    try { c = buildColumn(dc); } catch (error) { throw new SchemaBuildError(dc.line, (error as Error).message); }
    for (const k of dc.keys) {
      if (k === 'PK') { c.pk = true; (ent.pk ??= []).push(c.name); }
      else if (k === 'FK') c.fk = true;
      else if (k === 'UK') { c.uk = true; (ent.unique ??= []).push([c.name]); }
    }
    if (c.auto) {
      if ((ent.auto ?? '') !== '') throw new SchemaBuildError(dc.line, 'two auto columns in ' + e.name);
      ent.auto = c.name;
    }
    (ent.columns ??= []).push(c);
    cols.set(c.name, c);
  }
  if (!ent.pk || ent.pk.length === 0) throw new SchemaBuildError(e.line, `entity ${e.name} has no PK`);
  // The conventional version column; an explicit %% aes_version may replace it.
  if (cols.has('aes_key_version')) ent.aes_version = 'aes_key_version';
  // Timestamps by convention; %% timestamps overrides.
  if (cols.has('created_ts') || cols.has('updated_ts')) {
    ent.timestamps = {};
    if (cols.has('created_ts')) ent.timestamps.created = 'created_ts';
    if (cols.has('updated_ts')) ent.timestamps.updated = 'updated_ts';
  }
  return ent;
}

/** Returns the naming-rule violation of a column name, or undefined. */
export function checkColumnName(n: string): string | undefined {
  if (!reIdent.test(n)) return `column name must be snake_case: ${n}`;
  if (n.includes('__')) return `column name may not contain '__': ${n}`;
  for (const segment of n.split('_')) {
    if (reservedSegments.includes(segment)) return `column name may not contain the segment ${quoted(segment)}: ${n}`;
  }
  if (reservedColumns.includes(n)) return `column name is a reserved method name: ${n}`;
  for (const p of reservedPrefixes) {
    if (n === p || n.startsWith(p + '_')) return `column name may not start with ${quoted(p)}: ${n}`;
  }
  return undefined;
}

function atoi(s: string): number | undefined {
  return /^[+-]?[0-9]+$/.test(s) ? Number(s) : undefined;
}

function buildColumn(dc: DColumn): SchemaColumn {
  const c: SchemaColumn = {
    name: dc.name, type: '', raw: dc.type, nullable: dc.nullable, default: dc.default, auto: dc.auto,
    on_update: dc.onUpdate, unsigned: dc.unsigned, lazy: dc.lazy, styles: dc.styles.length > 0 ? [...dc.styles] : null,
    describe: dc.describe, comment: dc.dbComment, line: dc.line,
  };
  const m = reTypeParen.exec(dc.type.toLowerCase());
  if (!m) throw new Error(`column ${dc.name}: bad type ${quoted(dc.type)}`);
  const base = m[1]!;
  const arg = m[2] ?? '';
  switch (base) {
    case 'tinyint': case 'smallint': case 'mediumint': case 'int': case 'integer':
      c.type = dc.unsigned ? 'i64' : 'i32';
      if (base === 'tinyint' && (dc.bool || (dc.name.startsWith('is_') && !dc.int))) c.type = 'bool';
      break;
    case 'bigint': c.type = 'i64'; break;
    case 'float': case 'double': case 'real': c.type = 'f64'; break;
    case 'decimal': case 'numeric': {
      c.type = 'decimal';
      if (arg !== '') {
        const [p, s, ok] = cut(arg, '_');
        const precision = atoi(p);
        if (precision === undefined) throw new Error(`column ${dc.name}: decimal precision ${quoted(arg)}`);
        c.precision = precision;
        if (ok) {
          const scale = atoi(s);
          if (scale === undefined) throw new Error(`column ${dc.name}: decimal scale ${quoted(arg)}`);
          c.scale = scale;
        }
      }
      break;
    }
    case 'varchar': case 'char': {
      c.type = 'string';
      if (arg === '') throw new Error(`column ${dc.name}: ${base} requires a positive length`);
      const n = atoi(arg);
      if (n === undefined || n < 1) throw new Error(`column ${dc.name}: ${base} requires a positive length, got ${quoted(arg)}`);
      c.len = n;
      break;
    }
    case 'uuid': c.type = 'string'; break;
    case 'text': case 'tinytext': case 'mediumtext': case 'longtext': c.type = 'text'; break;
    case 'blob': case 'tinyblob': case 'mediumblob': case 'longblob': case 'varbinary': case 'binary':
      c.type = 'bytes';
      if (arg !== '') c.len = atoi(arg) ?? 0;
      break;
    case 'date': c.type = 'date'; break;
    case 'time': c.type = 'time'; break;
    case 'datetime': case 'timestamp':
      c.type = 'datetime';
      if (arg !== '') c.precision = atoi(arg) ?? 0;
      break;
    case 'jsontext': c.type = 'jsontext'; break;
    case 'json': throw new SchemaBuildError(dc.line, `column ${dc.name}: type json is not supported; use jsontext, which stores the ordered-json text`);
    case 'enum':
      c.type = 'enum';
      if (arg === '') throw new Error(`column ${dc.name}: enum needs values enum(a_b_c)`);
      c.enum = arg.split('_');
      break;
    case 'point': c.type = 'point'; break;
    case 'bool': case 'boolean': c.type = 'bool'; break;
    default: throw new Error(`column ${dc.name}: unsupported type ${quoted(dc.type)}`);
  }
  // Styles from the column name when none are written.
  if (!c.styles || c.styles.length === 0) {
    const n = dc.name;
    if (n.startsWith('aes_hex_')) c.styles = ['aes', 'hex'];
    else if (n.startsWith('aes_') && n !== 'aes_key_version') c.styles = ['aes'];
    else if (n.startsWith('gz_')) c.styles = ['serialize', 'gz'];
    else if (n.startsWith('jsons_')) c.styles = ['jsons'];
    else if (n.startsWith('json_')) c.styles = ['json'];
    else if (n.startsWith('yaml_')) c.styles = ['yaml'];
    else if (n.startsWith('base64_')) c.styles = ['serialize', 'base64'];
    else if (n.startsWith('serialize_')) c.styles = ['serialize'];
    else if (n === 'ip') c.styles = ['ip'];
  }
  const styles = c.styles ?? [];
  if (styles.length === 1 && styles[0] === 'ip') c.type = 'inet';
  if (c.type === 'jsontext' && styles.length === 0) c.styles = ['json'];
  // The AES version is plaintext metadata outside the default projection.
  if (dc.name === 'aes_key_version') c.lazy = true;
  // Large or encoded columns are lazy by default; aes_hex stays eager.
  if (!c.lazy && !dc.lazy) {
    const s = c.styles ?? [];
    if (c.type === 'text' || c.type === 'bytes') c.lazy = true;
    else if (s.length > 0 && !(s.length === 2 && s[0] === 'aes' && s[1] === 'hex') && s[0] !== 'ip') c.lazy = true;
  }
  if (dc.ref !== '') {
    const [entity, column] = cut(dc.ref, '.');
    c.ref = { entity, column };
    c.refExplicit = true;
    c.fk = true;
  }
  return c;
}

function addRelation(m: SchemaManifest, r: DRelation): void {
  const entities = m.entities!;
  if (!Object.hasOwn(entities, r.parent)) throw new SchemaBuildError(r.line, 'relation references unknown entity ' + r.parent);
  if (!Object.hasOwn(entities, r.child)) throw new SchemaBuildError(r.line, 'relation references unknown entity ' + r.child);
  const parent = entities[r.parent]!;
  const child = entities[r.child]!;
  const parentPK = parent.pk ?? [];
  if (r.fks.length !== parentPK.length) {
    throw new SchemaBuildError(r.line, `relation ${r.parent} -> ${r.child}: ${r.fks.length} FK columns do not match ${parentPK.length} target PK columns`);
  }
  let overlapping = false;
  r.fks.forEach((name, i) => {
    const fk = entityColumn(child, name);
    if (!fk) throw new SchemaBuildError(r.line, `relation ${r.parent} -> ${r.child}: FK column ${name} not in ${r.child}`);
    fk.fk = true;
    if (!fk.ref) fk.ref = { entity: parent.name, column: parentPK[i]! };
    else if (fk.ref.entity !== parent.name || fk.ref.column !== parentPK[i]) {
      if (fk.refExplicit) {
        throw new SchemaBuildError(r.line, `relation ${r.parent} -> ${r.child}: FK column ${name} references ${fk.ref.entity}.${fk.ref.column}, expected ${parent.name}.${parentPK[i]}`);
      }
      overlapping = true;
    }
  });
  // The right side of the cardinality token is the child side.
  const childMany = r.cardinality.endsWith('{');
  let childName = r.childName;
  if (childName === '') {
    if (r.fks.length !== 1) throw new SchemaBuildError(r.line, `relation ${r.parent} -> ${r.child}: composite relation must name both sides`);
    const fk = r.fks[0]!;
    childName = trimSuffix(trimSuffix(fk, '_seq'), '_id');
    if (childName === fk) {
      throw new SchemaBuildError(r.line, `relation ${r.parent} -> ${r.child}: cannot derive a name from FK ${fk}; write (child / parent) in the label`);
    }
  }
  let parentName = r.parentName;
  if (parentName === '') {
    const base = child.name.startsWith(parent.name + '_') ? child.name.slice(parent.name.length + 1) : child.name;
    parentName = childMany ? plural(base) : base;
  }
  child.relations ??= {};
  parent.relations ??= {};
  if (Object.hasOwn(child.relations, childName)) throw new SchemaBuildError(r.line, `relation name ${child.name}.${childName} already used; name the sides in the label`);
  if (Object.hasOwn(parent.relations, parentName)) throw new SchemaBuildError(r.line, `relation name ${parent.name}.${parentName} already used; name the sides in the label`);
  child.relations[childName] = {
    name: childName, kind: 'one', target: parent.name,
    keys: r.fks.map((fk, i) => ({ local: fk, target: parentPK[i]! })), on_delete: r.onDelete, foreign_key: overlapping,
  };
  parent.relations[parentName] = {
    name: parentName, kind: childMany ? 'many' : 'one', target: child.name,
    keys: r.fks.map((fk, i) => ({ local: parentPK[i]!, target: fk })), on_delete: r.onDelete,
  };
}

function trimSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

export function plural(s: string): string {
  if (s.endsWith('y') && s.length > 1 && !'aeiou'.includes(s[s.length - 2]!)) return s.slice(0, -1) + 'ies';
  if (s.endsWith('s') || s.endsWith('x') || s.endsWith('ch') || s.endsWith('sh')) return s + 'es';
  return s + 's';
}

function sameList(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function addDirective(m: SchemaManifest, x: Directive): void {
  const entities = m.entities!;
  if (!Object.hasOwn(entities, x.table)) throw new SchemaBuildError(x.line, `%% ${x.kind}: unknown entity ${x.table}`);
  const ent = entities[x.table]!;
  for (const c of x.columns) {
    if (!entityColumn(ent, c)) throw new SchemaBuildError(x.line, `%% ${x.kind} ${x.table}: unknown column ${c}`);
  }
  switch (x.kind) {
    case 'table_comment': ent.comment = x.raw; break;
    case 'column_comment': entityColumn(ent, x.columns[0]!)!.comment = x.raw; break;
    case 'rename_table':
      if ((ent.renamed_from ?? '') !== '') throw new SchemaBuildError(x.line, 'rename_table declared twice for ' + ent.name);
      ent.renamed_from = x.name;
      break;
    case 'rename_column': {
      const column = entityColumn(ent, x.columns[0]!)!;
      if ((column.renamed_from ?? '') !== '') throw new SchemaBuildError(x.line, `rename_column declared twice for ${ent.name}.${column.name}`);
      column.renamed_from = x.name;
      break;
    }
    case 'unique': (ent.unique ??= []).push(x.columns); break;
    case 'index': {
      ent.indexes ??= {};
      const name = x.name !== '' ? x.name : 'ix_' + x.columns.join('_');
      if (Object.hasOwn(ent.indexes, name)) throw new SchemaBuildError(x.line, 'duplicate index name ' + name);
      ent.indexes[name] = x.columns;
      break;
    }
    case 'fulltext': (ent.fulltext ??= []).push(x.columns); break;
    case 'check': {
      if ((ent.checks ?? []).some(c => c.name === x.name)) throw new SchemaBuildError(x.line, `check ${x.name} declared twice`);
      if (entityColumn(ent, x.name)) throw new SchemaBuildError(x.line, `check ${x.name} collides with a column`);
      for (const col of backtickNames(x.raw)) {
        if (!entityColumn(ent, col)) throw new SchemaBuildError(x.line, `check ${x.name}: unknown column \`${col}\``);
      }
      (ent.checks ??= []).push({ name: x.name, expr: x.raw });
      break;
    }
    case 'timestamps': ent.timestamps = { created: x.columns[0]!, updated: x.columns[1]! }; break;
    case 'aes_version':
      if ((ent.aes_version ?? '') !== '' && ent.aes_version !== 'aes_key_version') throw new SchemaBuildError(x.line, 'aes version declared twice for ' + ent.name);
      if (!entityColumn(ent, x.columns[0]!)) throw new SchemaBuildError(x.line, `aes version column ${x.columns[0]} is unknown`);
      ent.aes_version = x.columns[0]!;
      break;
    case 'soft_delete': {
      if ((ent.soft_delete ?? '') !== '') throw new SchemaBuildError(x.line, 'soft_delete declared twice for ' + ent.name);
      const c = entityColumn(ent, x.columns[0]!);
      if (!c) throw new SchemaBuildError(x.line, `soft_delete column ${x.columns[0]} is unknown`);
      if (c.type !== 'datetime' || !c.nullable) throw new SchemaBuildError(x.line, `soft_delete column ${x.columns[0]} must be a nullable datetime`);
      ent.soft_delete = x.columns[0]!;
      break;
    }
    case 'blind_index': {
      const encrypted = entityColumn(ent, x.columns[0]!)!;
      const index = entityColumn(ent, x.columns[1]!)!;
      if (encrypted === index) throw new SchemaBuildError(x.line, 'blind index source and target must differ');
      if (!(encrypted.styles ?? []).includes('aes')) throw new SchemaBuildError(x.line, `blind index source ${encrypted.name} is not an AES column`);
      if ((index.styles ?? []).includes('aes')) throw new SchemaBuildError(x.line, `blind index target ${index.name} must not be an AES column`);
      if (index.type !== 'string' && index.type !== 'bytes') throw new SchemaBuildError(x.line, `blind index target ${index.name} must be string or bytes`);
      if (index.type === 'string' && (index.len ?? 0) < 64) throw new SchemaBuildError(x.line, `blind index target ${index.name} must hold 64 hexadecimal characters`);
      if (Boolean(encrypted.nullable) !== Boolean(index.nullable)) {
        throw new SchemaBuildError(x.line, `blind index target ${index.name} nullability must match source ${encrypted.name}`);
      }
      const indexed = Object.values(ent.indexes ?? {}).some(columns => sameList(columns, [index.name]));
      if (!indexed) throw new SchemaBuildError(x.line, `blind index target ${index.name} requires a declared single-column index`);
      if ((encrypted.blind_index ?? '') !== '') throw new SchemaBuildError(x.line, `blind index source ${encrypted.name} is declared twice`);
      if ((ent.columns ?? []).some(col => col.blind_index === index.name)) throw new SchemaBuildError(x.line, `blind index target ${index.name} is declared twice`);
      encrypted.blind_index = index.name;
      break;
    }
  }
}

function validate(m: SchemaManifest, allowMissingAESVersion: boolean): void {
  const entities = m.entities!;
  const order = m.order ?? [];
  const renamedTables = new Map<string, string>();
  for (const name of order) {
    const e = entities[name]!;
    const line = e.line ?? 0;
    const renamedFrom = e.renamed_from ?? '';
    if (renamedFrom !== '') {
      if (renamedFrom === e.name) throw new SchemaBuildError(line, 'rename_table source equals target ' + e.name);
      const target = renamedTables.get(renamedFrom);
      if (target) throw new SchemaBuildError(line, `rename_table source ${renamedFrom} is used by ${target} and ${e.name}`);
      renamedTables.set(renamedFrom, e.name);
    }
    const columns = e.columns ?? [];
    const targetColumns = new Set(columns.map(c => c.name));
    const renamedColumns = new Map<string, string>();
    for (const c of columns) {
      const from = c.renamed_from ?? '';
      if (from === '') continue;
      const cl = c.line ?? 0;
      if (from === c.name) throw new SchemaBuildError(cl, `rename_column source equals target ${e.name}.${c.name}`);
      if (targetColumns.has(from)) throw new SchemaBuildError(cl, `rename_column source ${e.name}.${from} remains a target column`);
      const target = renamedColumns.get(from);
      if (target) throw new SchemaBuildError(cl, `rename_column source ${e.name}.${from} is used by ${target} and ${c.name}`);
      renamedColumns.set(from, c.name);
    }
  }
  for (const name of order) {
    const e = entities[name]!;
    const line = e.line ?? 0;
    const columns = e.columns ?? [];
    for (const c of columns) {
      if ((c.styles ?? [])[0] === 'aes') {
        const version = entityColumn(e, e.aes_version ?? '');
        if (!version || version.nullable || (version.type !== 'i32' && version.type !== 'i64')) {
          if (allowMissingAESVersion && !version) continue;
          throw new SchemaBuildError(line, `${e.name}.${c.name} requires a non-null integer aes version column`);
        }
      }
    }
    for (const [rn, r] of Object.entries(e.relations ?? {})) {
      if (entityColumn(e, rn)) throw new SchemaBuildError(line, `relation name ${e.name}.${rn} collides with a column; name the sides in the label`);
      if (!Object.hasOwn(entities, r.target)) throw new SchemaBuildError(line, 'relation target missing: ' + r.target);
    }
    for (const c of columns) {
      if (!c.ref) continue;
      const t = Object.hasOwn(entities, c.ref.entity) ? entities[c.ref.entity] : undefined;
      if (!t || !entityColumn(t, c.ref.column)) {
        throw new SchemaBuildError(c.line ?? 0, `${e.name}.${c.name} -> ${c.ref.entity}.${c.ref.column}: target does not exist`);
      }
    }
    if (e.timestamps) {
      for (const ts of [e.timestamps.created ?? '', e.timestamps.updated ?? '']) {
        if (ts !== '' && !entityColumn(e, ts)) throw new SchemaBuildError(line, `timestamps column missing: ${e.name}.${ts}`);
      }
    }
    const seen = new Set<string>();
    for (const u of e.unique ?? []) {
      const k = u.join(',');
      if (seen.has(k)) throw new SchemaBuildError(line, `duplicate unique ${e.name} (${k})`);
      seen.add(k);
    }
  }
}

/** Non-fatal findings: FK columns without a relationship line. */
export function manifestWarnings(m: SchemaManifest): string[] {
  const out: string[] = [];
  for (const name of m.order ?? []) {
    const e = m.entities![name]!;
    for (const c of e.columns ?? []) {
      if (c.fk && !c.ref) out.push(`${e.name}.${c.name} is FK but has no relationship line or '-> table.column'`);
    }
  }
  return out;
}

/** The `quoted` identifiers of an expression fragment. */
function backtickNames(frag: string): string[] {
  const out: string[] = [];
  for (;;) {
    const i = frag.indexOf('`');
    if (i < 0) return out;
    const j = frag.indexOf('`', i + 1);
    if (j < 0) return out;
    out.push(frag.slice(i + 1, j));
    frag = frag.slice(j + 1);
  }
}

