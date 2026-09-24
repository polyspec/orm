// The schema manifest (schema.json, docs/schema.md). The file is the
// canonical JSON written by the schema builder; its hash covers the compact
// form of the file with an empty schema_hash.
import { createHash } from 'node:crypto';
import { OrmError } from '../runtime_error.js';

export interface Column {
  readonly name: string;
  readonly type: string;
  readonly raw?: string;
  readonly nullable?: boolean;
  readonly default?: string;
  readonly auto?: boolean;
  readonly on_update?: boolean;
  readonly unsigned?: boolean;
  readonly lazy?: boolean;
  readonly len?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly enum?: readonly string[];
  readonly styles?: readonly string[];
  readonly blind_index?: string;
  readonly ref?: { readonly entity: string; readonly column: string };
  readonly pk?: boolean;
  readonly fk?: boolean;
  readonly comment?: string;
}

export interface RelationKey { readonly local: string; readonly target: string; }

export interface SchemaRelation {
  readonly name: string;
  readonly kind: string;
  readonly target: string;
  readonly keys: readonly RelationKey[];
  readonly on_delete?: string;
  readonly foreign_key?: boolean;
}

export interface Entity {
  readonly name: string;
  readonly table: string;
  readonly comment?: string;
  readonly pk: readonly string[];
  readonly auto?: string;
  readonly columns: readonly Column[];
  readonly relations: Readonly<Record<string, SchemaRelation>>;
  readonly unique?: readonly (readonly string[])[];
  readonly indexes?: Readonly<Record<string, readonly string[]>>;
  readonly fulltext?: readonly (readonly string[])[];
  readonly checks?: readonly { readonly name: string; readonly expr: string }[];
  readonly timestamps?: { readonly created?: string; readonly updated?: string };
  readonly soft_delete?: string;
  readonly aes_version?: string;
}

export interface ExternalForeignKey {
  readonly entity: string;
  readonly columns: readonly string[];
  readonly target_table: string;
  readonly target_columns: readonly string[];
  readonly name?: string;
  readonly on_delete?: string;
  readonly deferred?: boolean;
}

export interface Manifest {
  readonly schema_hash: string;
  readonly order: readonly string[];
  readonly entities: Readonly<Record<string, Entity>>;
  readonly external_fks?: readonly ExternalForeignKey[];
  readonly immutable?: readonly string[];
  readonly audit_log?: AuditLog;
  readonly audits?: readonly AuditDeclaration[];
}

/** A physical table and the ordered columns an audit directive names on it. */
export interface AuditTable {
  readonly table: string;
  readonly columns: readonly string[];
}

/** The tables audit triggers write to and the setting that carries the operation id. */
export interface AuditLog {
  readonly operation: AuditTable;
  readonly context: string;
  readonly change: AuditTable;
}

/** An audit trigger declared on one entity. */
export interface AuditDeclaration {
  readonly entity: string;
  readonly mode: 'changes' | 'operations';
  readonly service?: string;
  readonly redact?: readonly (readonly string[])[];
}

const columnIndexes = new WeakMap<Entity, Map<string, Column>>();

/** Returns the column of an entity, or undefined. */
export function columnOf(e: Entity, name: string): Column | undefined {
  let index = columnIndexes.get(e);
  if (index === undefined) {
    index = new Map(e.columns.map(c => [c.name, c]));
    columnIndexes.set(e, index);
  }
  return index.get(name);
}

export function entityOf(m: Manifest, name: string): Entity | undefined {
  return Object.hasOwn(m.entities, name) ? m.entities[name] : undefined;
}

/** A loaded manifest with its canonical text. */
export interface LoadedManifest {
  readonly manifest: Manifest;
  /** The compact canonical JSON. */
  readonly compact: string;
}

/** Removes the whitespace between JSON tokens. */
function compactJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
    out += c;
  }
  return out;
}

/** Indents compact JSON with two spaces, as the schema builder writes it. */
export function indentJson(compact: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  const newline = () => { out += '\n' + '  '.repeat(depth); };
  for (let i = 0; i < compact.length; i++) {
    const c = compact[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += compact[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    switch (c) {
      case '"': inString = true; out += c; break;
      case '{': case '[': {
        const close = c === '{' ? '}' : ']';
        if (compact[i + 1] === close) { out += c + close; i++; break; }
        out += c; depth++; newline(); break;
      }
      case '}': case ']': depth--; newline(); out += c; break;
      case ',': out += c; newline(); break;
      case ':': out += ': '; break;
      default: out += c;
    }
  }
  return out;
}

const hashPrefix = /^\{"schema_hash":"([0-9a-f]*)"/;

/** Parses schema.json and checks its hash. */
export function loadManifest(text: string): LoadedManifest {
  let manifest: Manifest;
  try { manifest = JSON.parse(text) as Manifest; } catch (error) {
    throw new OrmError('SCHEMA_INVALID', `schema.json is not JSON: ${(error as Error).message}`);
  }
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.entities !== 'object' || !Array.isArray(manifest.order)) {
    throw new OrmError('SCHEMA_INVALID', 'schema.json has no entities');
  }
  const compact = compactJson(text);
  const match = hashPrefix.exec(compact);
  if (!match) throw new OrmError('SCHEMA_INVALID', 'schema.json must start with schema_hash');
  const content = '{"schema_hash":""' + compact.slice(match[0].length);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  if (hash !== manifest.schema_hash) {
    throw new OrmError('SCHEMA_INVALID', `schema.json was edited by hand: hash ${manifest.schema_hash} does not match content ${hash}`);
  }
  return { manifest, compact };
}
