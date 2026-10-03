// Plans `utils().schema().addColumns()`: the statements that add the missing
// nullable or defaulted columns of the existing tables of a manifest and
// replace the audit triggers of each changed table. The live tables of the
// manifest are read through the import, with the column facts that the catalog
// does not hold (bool, int, lazy and styles) taken from the manifest. Every
// other difference between those tables and the manifest is reported with
// SCHEMA_DIFFERS before any statement runs.
import { ddlErrorText, ddlTable, splitSQL } from './engine/ddl.js';
import type { Manifest } from './engine/manifest.js';
import { triggerObjects } from './engine/triggers.js';
import type { DriverControl } from './driver.js';
import { OrmError } from './runtime_error.js';
import { buildManifest, type SchemaColumn, type SchemaEntity, type SchemaManifest } from './schema/build.js';
import { parseDiagram, type DColumn, type Diagram } from './schema/mermaid.js';
import { alignLiveChecks } from './tools/checks.js';
import type { ToolDb, ToolDriver } from './tools/db.js';
import { renderDiff } from './tools/diff.js';
import { readTables, renderMermaid, type ImpTable } from './tools/introspect.js';

export interface AddColumnsPlan { statements: string[]; added: string[]; }

function differs(message: string, cause?: unknown): OrmError { return new OrmError('SCHEMA_DIFFERS', message, cause); }

/** The catalog reads of the import on the connection of the call. */
function catalog(driver: ToolDriver, control: DriverControl): ToolDb {
  return {
    driver,
    async query(sql, params = []) {
      return (await control(sql, params)).rows.map(row => row.map(value => Buffer.isBuffer(value) ? value.toString('utf8') : value));
    },
    async exec(sql, params = []) { return (await control(sql, params)).affected; },
    async close() {},
  };
}

/** A manifest with no tables and no triggers that keeps the hash, ORM directives and external keys of m. */
function tables(m: SchemaManifest): SchemaManifest & { order: string[]; entities: Record<string, SchemaEntity> } {
  return { ...m, order: [], entities: {}, immutable: null, audit_log: undefined, audits: [] };
}

/** The column facts of the manifest that the catalog does not hold, as the previous diagram of the import. */
function facts(want: SchemaManifest, physical: Map<string, string>): Diagram {
  const entities = (want.order ?? []).map(name => ({
    name: physical.get(name)!, comment: '', line: 0,
    columns: (want.entities![name]!.columns ?? []).map(c => ({
      name: c.name, lazy: c.lazy ?? false, bool: c.type === 'bool', styles: [...(c.styles ?? [])],
      int: c.raw.toLowerCase().startsWith('tinyint') && c.type !== 'bool' && c.name.startsWith('is_'),
    }) as DColumn),
  }));
  return { entities, relations: [], directives: [], orm: [] };
}

/** A default without its string quotes, and a number without trailing fraction zeros. */
function defaultText(d: string): string {
  if (d.length >= 2 && d.startsWith("'") && d.endsWith("'")) d = d.slice(1, -1).replaceAll("''", "'");
  if (/^-?[0-9]+\.[0-9]+$/.test(d)) d = d.replace(/0+$/, '').replace(/\.$/, '');
  return d === '-0' ? '0' : d;
}

/**
 * Replaces the default of every live column whose catalog text is equivalent
 * to the declared default with the declared text: the import reads a string
 * default with its quotes and a decimal default with the digits of its scale,
 * so a diff reports only real changes.
 */
function alignDefaults(current: SchemaManifest, declared: SchemaManifest): void {
  for (const name of declared.order ?? []) {
    const columns = new Map((declared.entities![name]!.columns ?? []).map(c => [c.name, c]));
    for (const c of current.entities![name]!.columns ?? []) {
      const d = columns.get(c.name);
      if (d !== undefined && c.default != null && d.default != null && c.default !== d.default && defaultText(c.default) === defaultText(d.default)) c.default = d.default;
    }
  }
}

function required(c: SchemaColumn): boolean { return (c.auto ?? false) || (!(c.nullable ?? false) && c.default == null); }

export async function planAddColumns(driver: string, control: DriverControl, want: SchemaManifest): Promise<AddColumnsPlan> {
  const physical = new Map<string, string>();
  for (const name of want.order ?? []) {
    const table = want.entities![name]!.table;
    if (driver !== 'sqlite' && table.includes('.')) throw new OrmError('CAPABILITY_UNSUPPORTED', `addColumns reads the tables of the connected schema; table ${table} is qualified`);
    physical.set(name, ddlTable(table, driver));
  }
  const db = catalog(driver as ToolDriver, control);
  let live: ImpTable[];
  try { live = await readTables(db, new Set(physical.values())); } catch (error) {
    if (error instanceof OrmError) throw error;
    throw differs(`the existing tables of the manifest cannot be read: ${ddlErrorText(error)}`, error);
  }
  if (live.length === 0) return { statements: [], added: [] };
  let read: SchemaManifest;
  try { read = buildManifest([parseDiagram(renderMermaid(live, facts(want, physical)))], true); } catch (error) {
    throw differs(`the existing tables of the manifest cannot be read as a manifest: ${ddlErrorText(error)}`, error);
  }
  const byTable = new Map(Object.values(read.entities ?? {}).map(e => [e.table, e]));
  const current = tables(read);
  const declared = tables(want);
  for (const name of want.order ?? []) {
    const e = byTable.get(physical.get(name)!);
    if (e === undefined) continue;
    current.order.push(name);
    current.entities[name] = { ...e, name, table: want.entities![name]!.table };
    declared.order.push(name);
    declared.entities[name] = want.entities![name]!;
  }
  try { await alignLiveChecks(db, current, declared); } catch (error) {
    if (error instanceof OrmError) throw error;
    throw differs(`compare the checks of the existing tables: ${ddlErrorText(error)}`, error);
  }
  alignDefaults(current, declared);
  const expanded = tables(current);
  const added: string[] = [];
  const missing: string[] = [];
  const changed = new Set<string>();
  for (const name of declared.order) {
    const we = declared.entities[name]!;
    const liveColumns = new Map((current.entities[name]!.columns ?? []).map(c => [c.name, c]));
    const columns: SchemaColumn[] = [];
    for (const wc of we.columns ?? []) {
      const lc = liveColumns.get(wc.name);
      if (lc !== undefined) {
        columns.push(lc);
        liveColumns.delete(wc.name);
      } else if (required(wc)) {
        missing.push(`${we.table}.${wc.name}`);
      } else {
        columns.push(wc);
        added.push(`${we.table}.${wc.name}`);
        changed.add(we.table);
      }
    }
    columns.push(...liveColumns.values());
    expanded.order.push(name);
    expanded.entities[name] = { ...current.entities[name]!, columns };
  }
  if (missing.length > 0) throw differs(`addColumns adds only nullable or defaulted columns; required columns: ${missing.join(', ')}`);
  let differences: string[];
  try { differences = splitSQL(renderDiff(expanded, declared, driver, true)); } catch (error) {
    throw differs(`the existing tables differ from the manifest: ${ddlErrorText(error)}`, error);
  }
  if (differences.length > 0) throw differs(`the existing tables differ from the manifest beyond missing columns: ${differences.join(' ')}`);
  if (added.length === 0) return { statements: [], added: [] };
  let statements: string[];
  try { statements = splitSQL(renderDiff(current, expanded, driver, false)); } catch (error) {
    throw differs(`add columns: ${ddlErrorText(error)}`, error);
  }
  for (const o of triggerObjects(want as unknown as Manifest, driver)) {
    if (o.kind === 'audit' && changed.has(o.table)) statements.push(...o.create);
  }
  return { statements, added };
}
