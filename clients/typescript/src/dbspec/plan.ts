// schema plan 문서와 plan chain (docs/plans.md "Plan document", "Chain").
// 기준은 Go 엔진(engine/dbspec/plan.go)이며 diagnostic message는 Go와 같은 바이트다.
import { dbspecManifest, parseDbspec } from './index.js';
import type { DbspecDiagnostic, DbspecDocument } from './model.js';
import { RESERVED } from './parse.js';

/** `rename table <old> <new>`. */
export interface DbspecTableRename {
  readonly old: string;
  readonly new: string;
}

/** `rename column <table>.<old> <new>`; `table` is the table's name in the target. */
export interface DbspecColumnRename {
  readonly table: string;
  readonly old: string;
  readonly new: string;
}

/** `allow drop column <table>.<name>` with the source table and column. */
export interface DbspecColumnName {
  readonly table: string;
  readonly name: string;
}

/** A parsed plan document. `from` is null for a plan that starts from an empty database. */
export interface DbspecPlan {
  readonly name: string;
  readonly from: string | null;
  readonly renameTables: readonly DbspecTableRename[];
  readonly renameColumns: readonly DbspecColumnRename[];
  readonly dropTables: readonly string[];
  readonly dropColumns: readonly DbspecColumnName[];
  /** The parsed target schema text, whose schemaHash is `to`. */
  readonly schema: DbspecDocument;
  readonly to: string;
}

/** The plan and no diagnostic, or the diagnostics of an invalid plan document and no plan. */
export type DbspecPlanResult =
  | { readonly plan: DbspecPlan; readonly diagnostics: readonly [] }
  | { readonly plan: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/** The plans in chain order and no diagnostic, or the chain diagnostics and no plans. */
export type DbspecChainResult =
  | { readonly plans: readonly DbspecPlan[]; readonly diagnostics: readonly [] }
  | { readonly plans: null; readonly diagnostics: readonly DbspecDiagnostic[] };

const NAME = '([a-z][a-z0-9_]*)';
const PLAN_HEADER = new RegExp(`^dbplan 1 ${NAME}$`);
const PLAN_FROM = /^from (empty|sha256:[0-9a-f]{64})$/;
const PLAN_RENAME_TABLE = new RegExp(`^rename table ${NAME} ${NAME}$`);
const PLAN_RENAME_COLUMN = new RegExp(`^rename column ${NAME}\\.${NAME} ${NAME}$`);
const PLAN_DROP_TABLE = new RegExp(`^allow drop table ${NAME}$`);
const PLAN_DROP_COLUMN = new RegExp(`^allow drop column ${NAME}\\.${NAME}$`);

const NO_DIAGNOSTICS = Object.freeze([]) as readonly [];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stable copy of items in key order. */
export function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compare(key(a), key(b)));
}

export function planDiagnostic(rule: 'plan' | 'chain', line: number, message: string): DbspecDiagnostic {
  return Object.freeze({ rule, line, column: 1, message });
}

function failed(line: number, message: string): DbspecPlanResult {
  return Object.freeze({ plan: null, diagnostics: Object.freeze([planDiagnostic('plan', line, message)]) });
}

function planNames(names: readonly string[]): string {
  for (const n of names) {
    if (RESERVED.has(n) || Buffer.byteLength(n, 'utf8') > 63) return `name ${JSON.stringify(n)} is reserved or longer than 63 bytes`;
  }
  return '';
}

/**
 * Parses a plan document (docs/plans.md "Plan document"). An invalid document
 * gives `plan` diagnostics at its line; a diagnostic of the target schema text
 * is located in the plan.
 */
export function parsePlan(text: string): DbspecPlanResult {
  if (typeof text !== 'string') throw new TypeError('plan text must be a string');
  if (!text.endsWith('\n')) return failed(text.split('\n').length, 'a plan ends with a line end');
  const lines = text.slice(0, -1).split('\n');
  const header = PLAN_HEADER.exec(lines[0]!);
  if (header === null || RESERVED.has(header[1]!) || Buffer.byteLength(header[1]!, 'utf8') > 63) return failed(1, 'the first line is exactly `dbplan 1 <name>`');
  const name = header[1]!;
  const fromLine = lines.length < 2 ? null : PLAN_FROM.exec(lines[1]!);
  if (fromLine === null) return failed(2, 'the second line is `from empty` or `from <schemaHash>`');
  const from = fromLine[1] === 'empty' ? null : fromLine[1]!;
  const renameTables: DbspecTableRename[] = [];
  const renameColumns: DbspecColumnRename[] = [];
  const dropTables: string[] = [];
  const dropColumns: DbspecColumnName[] = [];
  const seen = new Map<string, number>();
  const given = new Map<string, number>();
  let i = 2;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const line = lines[i]!;
    const n = i + 1;
    const at = seen.get(line);
    if (at !== undefined) return failed(n, `line ${at} repeats this line`);
    seen.set(line, n);
    let r: RegExpExecArray | null;
    if ((r = PLAN_RENAME_TABLE.exec(line)) !== null) {
      const error = planNames(r.slice(1));
      if (error !== '') return failed(n, error);
      const other = given.get(`table ${r[2]}`);
      if (other !== undefined) return failed(n, `line ${other} renames another table to ${r[2]}`);
      given.set(`table ${r[2]}`, n);
      renameTables.push(Object.freeze({ old: r[1]!, new: r[2]! }));
    } else if ((r = PLAN_RENAME_COLUMN.exec(line)) !== null) {
      const error = planNames(r.slice(1));
      if (error !== '') return failed(n, error);
      const key = `column ${r[1]}.${r[3]}`;
      const other = given.get(key);
      if (other !== undefined) return failed(n, `line ${other} renames another column to ${r[1]}.${r[3]}`);
      given.set(key, n);
      renameColumns.push(Object.freeze({ table: r[1]!, old: r[2]!, new: r[3]! }));
    } else if ((r = PLAN_DROP_TABLE.exec(line)) !== null) {
      const error = planNames(r.slice(1));
      if (error !== '') return failed(n, error);
      dropTables.push(r[1]!);
    } else if ((r = PLAN_DROP_COLUMN.exec(line)) !== null) {
      const error = planNames(r.slice(1));
      if (error !== '') return failed(n, error);
      dropColumns.push(Object.freeze({ table: r[1]!, name: r[2]! }));
    } else {
      return failed(n, 'a header line is `rename table`, `rename column`, `allow drop table` or `allow drop column`');
    }
  }
  if (i >= lines.length) return failed(i + 1, 'a blank line and the target schema text follow the header');
  const offset = i + 1;
  const schemaText = lines.slice(offset).join('\n') + '\n';
  const parsed = parseDbspec(schemaText, {});
  if (parsed.document === null) {
    const diagnostics = parsed.diagnostics.map(d => Object.freeze({ ...d, line: d.line + offset }));
    return Object.freeze({ plan: null, diagnostics: Object.freeze(diagnostics) });
  }
  const manifest = dbspecManifest([parsed.document]);
  if (manifest.manifest === null) return Object.freeze({ plan: null, diagnostics: manifest.diagnostics });
  if (manifest.manifest.schemaText !== schemaText) {
    return failed(
      offset + 1,
      'the target is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings',
    );
  }
  if (manifest.manifest.schemaHash === from) return failed(2, 'the plan starts from its own target schema');
  const plan: DbspecPlan = Object.freeze({
    name,
    from,
    renameTables: Object.freeze(renameTables),
    renameColumns: Object.freeze(renameColumns),
    dropTables: Object.freeze(dropTables),
    dropColumns: Object.freeze(dropColumns),
    schema: parsed.document,
    to: manifest.manifest.schemaHash,
  });
  return Object.freeze({ plan, diagnostics: NO_DIAGNOSTICS });
}

/** The schema text of a plan's target; a plan from parsePlan always has one. */
export function planSchemaText(schema: DbspecDocument): string {
  const result = dbspecManifest([schema]);
  if (result.manifest === null) {
    throw new Error(`plan target is not a valid document set: ${result.diagnostics.map(d => d.message).join('; ')}`);
  }
  return result.manifest.schemaText;
}

/**
 * Writes a plan as its canonical document: the header lines in the order
 * rename table, rename column, allow drop table, allow drop column, each in
 * name order, then the target schema text.
 */
export function emitPlan(plan: DbspecPlan): string {
  let out = `dbplan 1 ${plan.name}\n`;
  out += plan.from === null ? 'from empty\n' : `from ${plan.from}\n`;
  for (const r of sortedBy(plan.renameTables, r => r.old)) out += `rename table ${r.old} ${r.new}\n`;
  for (const r of sortedBy(plan.renameColumns, r => `${r.table}.${r.old}`)) out += `rename column ${r.table}.${r.old} ${r.new}\n`;
  for (const t of sortedBy(plan.dropTables, t => t)) out += `allow drop table ${t}\n`;
  for (const c of sortedBy(plan.dropColumns, c => `${c.table}.${c.name}`)) out += `allow drop column ${c.table}.${c.name}\n`;
  return out + '\n' + planSchemaText(plan.schema);
}

/**
 * Orders plans into one chain from the plan `from empty` (docs/plans.md
 * "Chain"), or gives the `chain` diagnostics that name the plans.
 */
export function chainPlans(plans: readonly DbspecPlan[]): DbspecChainResult {
  if (!Array.isArray(plans)) throw new TypeError('plans must be an array of parsed plans');
  // plan이 없으면 table이 없는 database의 빈 chain이다.
  if (plans.length === 0) return Object.freeze({ plans: Object.freeze([]), diagnostics: NO_DIAGNOSTICS });
  // 빈 database에서 시작하는 plan의 key는 ''이다.
  const byFrom = new Map<string, DbspecPlan[]>();
  for (const p of plans) {
    const key = p.from ?? '';
    const list = byFrom.get(key);
    if (list === undefined) byFrom.set(key, [p]);
    else list.push(p);
  }
  const out: DbspecDiagnostic[] = [];
  for (const from of [...byFrom.keys()].sort(compare)) {
    const ps = byFrom.get(from)!;
    if (ps.length > 1) {
      const names = ps.map(p => p.name).sort(compare);
      out.push(planDiagnostic('chain', 1, `plans ${names.join(', ')} start from the same schema`));
    }
  }
  if (!byFrom.has('')) out.push(planDiagnostic('chain', 1, 'no plan starts from empty'));
  if (out.length > 0) return Object.freeze({ plans: null, diagnostics: Object.freeze(out) });
  const chain: DbspecPlan[] = [];
  const visited = new Set<DbspecPlan>();
  for (let p: DbspecPlan | undefined = byFrom.get('')![0]; p !== undefined; p = byFrom.get(p.to)?.[0]) {
    if (visited.has(p)) {
      return Object.freeze({ plans: null, diagnostics: Object.freeze([planDiagnostic('chain', 1, `plan ${p.name} closes a cycle`)]) });
    }
    visited.add(p);
    chain.push(p);
  }
  const unreached = plans.filter(p => !visited.has(p)).map(p => p.name).sort(compare);
  if (unreached.length > 0) {
    return Object.freeze({ plans: null, diagnostics: Object.freeze([planDiagnostic('chain', 1, `no chain reaches plans ${unreached.join(', ')}`)]) });
  }
  return Object.freeze({ plans: Object.freeze(chain), diagnostics: NO_DIAGNOSTICS });
}
