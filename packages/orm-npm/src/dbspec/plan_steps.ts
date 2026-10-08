// plan의 step을 한 dialect로 쓴다 (docs/plans.md "Steps"). 기준은 Go 엔진
// (engine/dbspec/plan_steps.go)이며 statement, rollback, 효과는 Go와 같은 바이트다.
import { readCheck } from './check.js';
import type { DbspecColumn, DbspecDiagnostic, DbspecDocument, DbspecForeignKey, DbspecIndex, DbspecTable, DbspecType, DbspecUnique } from './model.js';
import { sortedBy, type DbspecPlan } from './plan.js';
import { columnOf, planDiff, sameDefault, sameType, sortedKeys, type PlanDiff } from './plan_diff.js';
import { checkOf, foreignKeyOf, hasTriggers, indexOf, renameCheck, uniqueOf, type ObjectRef } from './plan_objects.js';
import { Renderer, type DbspecDialect } from './render.js';

/**
 * How a step's statement shows that it took effect (docs/plans.md "Steps",
 * effects). The kind is table, column, index, constraint, trigger, function,
 * sequence, rows or repeat; present is the state after the statement.
 */
export interface DbspecEffect {
  readonly kind: string;
  readonly table: string;
  readonly name: string;
  readonly present: boolean;
}

/** A column that a rollback makes non-null again, by its name in the applied plan, with the SQL text of its source default or null. */
export interface DbspecNullCheck {
  readonly table: string;
  readonly column: string;
  readonly default: string | null;
}

/**
 * One step of a plan (docs/plans.md "Steps"): its statement, its rollback
 * statement or, without one, the reason in irreversible (empty for a
 * finalize step), its effect, the restore statements that replace the
 * statement and the rollback statement when restoreIf holds, the null
 * checks of its rollback and whether it is a finalize step.
 */
export interface DbspecPlanStep {
  readonly statement: string;
  readonly rollback: string;
  readonly irreversible: string;
  readonly effect: DbspecEffect;
  readonly restore: string;
  readonly rollbackRestore: string;
  readonly restoreIf: DbspecEffect | null;
  readonly nullChecks: readonly DbspecNullCheck[];
  readonly finalize: boolean;
}

/** The steps and no diagnostic, or the plan diagnostics and no steps. */
export type DbspecPlanStepsResult =
  | { readonly steps: readonly DbspecPlanStep[]; readonly diagnostics: readonly [] }
  | { readonly steps: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/** The text form of docs/plans.md "Effects", such as `present table users`. */
export function effectText(e: DbspecEffect): string {
  if (e.kind === 'repeat') return 'repeat';
  let s = `${e.present ? 'present' : 'absent'} ${e.kind}`;
  for (const n of [e.table, e.name]) if (n !== '') s += ` ${n}`;
  return s;
}

const DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'sqlite']);

/** 되돌릴 수 없는 step의 이유(docs/plans.md "Irreversible steps"). */
const IRREVERSIBLE_PRECISION = 'narrowing the precision rounds the values written since';
/** SQLite 다시 만들기의 작업 table. */
const REBUILD_TABLE = 'dbspec$rebuild';

/**
 * Writes the steps of a plan in one dialect (docs/plans.md "Steps"). The
 * source is the schema the plan starts from, null for an empty database. An
 * unknown dialect is a TypeError.
 */
export function planSteps(source: DbspecDocument | null, plan: DbspecPlan, dialect: DbspecDialect): DbspecPlanStepsResult {
  if (!DIALECTS.has(dialect)) throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  const { diff, diagnostics } = planDiff(source, plan);
  if (diff === null) return Object.freeze({ steps: null, diagnostics: Object.freeze(diagnostics) });
  const holdPrefix = `dbspec$hold$${plan.to.slice('sha256:'.length, 'sha256:'.length + 12)}$`;
  const steps = new PlanWriter(diff, new Renderer(dialect), holdPrefix).steps();
  return Object.freeze({ steps: Object.freeze(steps.map(s => Object.freeze(s))), diagnostics: Object.freeze([]) as readonly [] });
}

const present = (kind: string, table: string, name: string): DbspecEffect => Object.freeze({ kind, table, name, present: true });
const absent = (kind: string, table: string, name: string): DbspecEffect => Object.freeze({ kind, table, name, present: false });
const repeat: DbspecEffect = Object.freeze({ kind: 'repeat', table: '', name: '', present: true });

/** A step with the optional parts empty. */
function step(statement: string, rollback: string, effect: DbspecEffect, more: Partial<DbspecPlanStep> = {}): DbspecPlanStep {
  return { statement, rollback, irreversible: '', effect, restore: '', rollbackRestore: '', restoreIf: null, nullChecks: [], finalize: false, ...more };
}

/** time이나 datetime의 정밀도가 커지는지 알려 준다. */
function precisionGrows(from: DbspecType, to: DbspecType): boolean {
  return (to.kind === 'time' || to.kind === 'datetime') && (from.kind === 'time' || from.kind === 'datetime') && to.precision > from.precision;
}

class PlanWriter {
  private readonly out: DbspecPlanStep[] = [];
  /** SQLite에서 다시 만드는 target table */
  private readonly rebuilt = new Set<string>();
  /** 보관 이름: "table.column"(지우는 column, source 이름), table(지우는 table), "+table.column"(더하는 column, target 이름) */
  private readonly holds = new Map<string, string>();
  private readonly holdOrder: string[] = [];

  constructor(
    private readonly d: PlanDiff,
    private readonly r: Renderer,
    private readonly holdPrefix: string,
  ) {}

  private add(s: DbspecPlanStep): void {
    this.out.push(s);
  }

  private q(name: string): string {
    return this.r.q(name);
  }

  private hold(key: string): string {
    const h = this.holds.get(key);
    if (h === undefined) throw new Error(`no holding name for ${key}`);
    return h;
  }

  /** docs/plans.md "Hiding instead of dropping"의 순서로 보관 이름을 정한다. */
  private numberHolds(): void {
    const d = this.d;
    let n = 0;
    const next = (key: string): void => {
      n++;
      this.holds.set(key, this.holdPrefix + n);
      this.holdOrder.push(key);
    };
    for (const name of d.matched) for (const c of d.removed.get(name) ?? []) next(`${d.tableOf.get(name)!}.${c}`);
    for (const name of d.dropped) next(name);
    for (const name of d.matched) for (const c of d.added.get(name) ?? []) next(`+${name}.${c}`);
  }

  steps(): DbspecPlanStep[] {
    const d = this.d;
    const sqlite = this.r.d === 'sqlite';
    this.numberHolds();
    if (sqlite) for (const name of d.matched) if (this.sqliteRebuilds(name)) this.rebuilt.add(name);
    // 1. trigger
    for (const name of d.matched) {
      const src = d.source.get(d.tableOf.get(name)!)!;
      if (hasTriggers(src) && (d.triggers.has(name) || this.rebuilt.has(name))) this.dropTriggers(src);
    }
    for (const name of d.dropped) {
      const src = d.source.get(name)!;
      if (hasTriggers(src)) this.dropTriggers(src);
    }
    // 2. foreign key
    if (!sqlite) {
      for (const s of sortedKeys(d.dropObjects)) {
        for (const o of d.dropObjects.get(s)!) if (o.kind === 'foreign_key') this.dropObject(d.source.get(s)!, o);
      }
    }
    // 3. check, unique, index와 지우는 table의 객체
    const dropTables = new Map<string, ObjectRef[]>();
    const push = (s: string, o: ObjectRef): void => {
      const list = dropTables.get(s);
      if (list === undefined) dropTables.set(s, [o]);
      else list.push(o);
    };
    for (const [s, objects] of d.dropObjects) {
      if (sqlite && (this.rebuilt.has(this.targetName(s)) || d.dropped.includes(s))) continue;
      for (const o of objects) if (o.kind !== 'foreign_key' && !(sqlite && o.kind === 'check')) push(s, o);
    }
    for (const s of d.dropped) {
      const t = d.source.get(s)!;
      for (const u of t.uniques) push(s, { kind: 'unique', name: u.name });
      for (const x of t.indexes) push(s, { kind: 'index', name: x.name });
      if (!sqlite) for (const k of t.checks) push(s, { kind: 'check', name: k.name });
    }
    const refKey = (o: ObjectRef): string => `${o.kind}\0${o.name}`;
    for (const s of sortedKeys(dropTables)) {
      const objects = [...dropTables.get(s)!].sort((a, b) => (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0));
      for (const o of objects) this.dropObject(d.source.get(s)!, o);
    }
    const rendererChecks = new Map<string, [Map<string, string>, Map<string, string>]>();
    if (!sqlite) {
      for (const name of d.matched) {
        const src = d.source.get(d.tableOf.get(name)!)!;
        const before = this.rendererChecks(src);
        const after = this.rendererChecks(d.target.get(name)!);
        rendererChecks.set(name, [before, after]);
        for (const n of sortedKeys(before)) if (after.get(n) !== before.get(n)) this.dropRendererCheck(src.name, n, before.get(n)!);
      }
      for (const s of d.dropped) {
        const before = this.rendererChecks(d.source.get(s)!);
        for (const n of sortedKeys(before)) this.dropRendererCheck(s, n, before.get(n)!);
      }
    }
    // 4. rename
    for (const r of sortedBy(d.renamedTables, r => r.old)) {
      this.add(step(`ALTER TABLE ${this.q(r.old)} RENAME TO ${this.q(r.new)}`, `ALTER TABLE ${this.q(r.new)} RENAME TO ${this.q(r.old)}`, present('table', r.new, '')));
    }
    for (const r of sortedBy(d.renamedColumns, r => `${r.table}.${r.old}`)) {
      this.add(step(this.renameColumn(r.table, r.old, r.new), this.renameColumn(r.table, r.new, r.old), present('column', r.table, r.new)));
    }
    // 5. 지우는 column과 table을 숨긴다
    if (!sqlite) {
      for (const name of d.matched) {
        const src = d.source.get(d.tableOf.get(name)!)!;
        for (const c of d.removed.get(name) ?? []) this.hideColumn(name, columnOf(src, c)!, this.hold(`${src.name}.${c}`));
      }
    }
    for (const name of d.dropped) {
      const h = this.hold(name);
      this.add(step(`ALTER TABLE ${this.q(name)} RENAME TO ${this.q(h)}`, `ALTER TABLE ${this.q(h)} RENAME TO ${this.q(name)}`, present('table', h, '')));
    }
    // 6. create table
    for (const name of d.created) {
      const t = d.target.get(name)!;
      this.add(step(this.r.table(t)[0]!, `DROP TABLE ${this.q(name)}`, present('table', name, '')));
      this.createIndexes(t, name);
    }
    // 7. add, alter column; SQLite 다시 만들기
    for (const name of d.matched) {
      if (sqlite) {
        if (this.rebuilt.has(name)) this.rebuild(name);
        continue;
      }
      const t = d.target.get(name)!;
      const src = d.source.get(d.tableOf.get(name)!)!;
      for (const c of d.added.get(name) ?? []) {
        const h = this.hold(`+${name}.${c}`);
        this.add(
          step(`ALTER TABLE ${this.q(name)} ADD COLUMN ${this.r.column(columnOf(t, c)!)}`, this.renameColumn(name, c, h), present('column', name, c), {
            restore: this.renameColumn(name, h, c),
            restoreIf: present('column', name, h),
          }),
        );
      }
      for (const c of d.altered.get(name) ?? []) this.alterColumn(name, columnOf(src, d.columnOf.get(name)!.get(c)!)!, columnOf(t, c)!);
    }
    // 8. unique, index, check
    for (const t of sortedKeys(d.addObjects)) {
      if (this.rebuilt.has(t)) continue;
      for (const o of d.addObjects.get(t)!) if (o.kind !== 'foreign_key' && !(sqlite && o.kind === 'check')) this.addObject(t, o);
    }
    if (!sqlite) {
      for (const name of d.matched) {
        const [before, after] = rendererChecks.get(name)!;
        for (const n of sortedKeys(after)) {
          if (after.get(n) !== before.get(n)) {
            this.add(step(`ALTER TABLE ${this.q(name)} ADD CONSTRAINT ${this.q(n)} CHECK (${after.get(n)!})`, this.dropCheck(name, n), present('constraint', name, n)));
          }
        }
      }
    }
    // 9. foreign key
    if (!sqlite) {
      for (const name of d.created) {
        for (const f of sortedBy(d.target.get(name)!.foreignKeys, f => f.name)) this.addObject(name, { kind: 'foreign_key', name: f.name });
      }
      for (const t of sortedKeys(d.addObjects)) {
        for (const o of d.addObjects.get(t)!) if (o.kind === 'foreign_key') this.addObject(t, o);
      }
    }
    // 10. trigger
    for (const name of d.created) this.createTriggers(d.target.get(name)!);
    for (const name of d.matched) {
      const t = d.target.get(name)!;
      if (hasTriggers(t) && (d.triggers.has(name) || this.rebuilt.has(name))) this.createTriggers(t);
    }
    // 11. finalize
    for (const key of this.holdOrder) {
      const h = this.holds.get(key)!;
      if (key.startsWith('+')) continue;
      const dot = key.indexOf('.');
      if (dot >= 0) {
        const table = this.targetName(key.slice(0, dot));
        this.add(step(`ALTER TABLE ${this.q(table)} DROP COLUMN ${this.q(h)}`, '', absent('column', table, h), { finalize: true }));
        continue;
      }
      this.add(step(`DROP TABLE ${this.q(h)}`, '', absent('table', h, ''), { finalize: true }));
    }
    return this.out;
  }

  /** The target name of a source table. */
  private targetName(source: string): string {
    for (const [t, s] of this.d.tableOf) if (s === source) return t;
    return source;
  }

  private renameColumn(table: string, from: string, to: string): string {
    return `ALTER TABLE ${this.q(table)} RENAME COLUMN ${this.q(from)} TO ${this.q(to)}`;
  }

  /**
   * Whether SQLite rebuilds the table: its name, a column, a foreign key or a
   * check changes. Index and unique changes alone, and trigger changes
   * alone, do not rebuild.
   */
  private sqliteRebuilds(name: string): boolean {
    const d = this.d;
    if (d.tableOf.get(name) !== name || d.added.has(name) || d.removed.has(name) || d.altered.has(name)) return true;
    if (d.renamedColumns.some(r => r.table === name)) return true;
    const structural = (o: ObjectRef): boolean => o.kind === 'foreign_key' || o.kind === 'check';
    if ((d.dropObjects.get(d.tableOf.get(name)!) ?? []).some(structural)) return true;
    return (d.addObjects.get(name) ?? []).some(structural);
  }

  /** MySQL과 PostgreSQL에서 지우는 column을 nullable로 바꾸고 보관 이름으로 숨긴다. */
  private hideColumn(table: string, c: DbspecColumn, h: string): void {
    if (!c.nullable) {
      const checks = [this.nullCheck(table, h, c)];
      if (this.r.d === 'mysql') {
        this.add(
          step(`ALTER TABLE ${this.q(table)} MODIFY COLUMN ${this.r.column({ ...c, nullable: true })}`, `ALTER TABLE ${this.q(table)} MODIFY COLUMN ${this.r.column(c)}`, repeat, {
            nullChecks: checks,
          }),
        );
      } else {
        const prefix = `ALTER TABLE ${this.q(table)} ALTER COLUMN ${this.q(c.name)}`;
        this.add(step(`${prefix} DROP NOT NULL`, `${prefix} SET NOT NULL`, repeat, { nullChecks: checks }));
      }
    }
    this.add(step(this.renameColumn(table, c.name, h), this.renameColumn(table, h, c.name), present('column', table, h)));
  }

  /** source column c를 non-null로 되돌리는 rollback의 null 검사다. */
  private nullCheck(table: string, column: string, c: DbspecColumn): DbspecNullCheck {
    return Object.freeze({ table, column, default: c.default === null ? null : this.r.defaultText(c.type, c.default) });
  }

  /** SQLite table을 작업 table을 거쳐 다시 만든다(docs/plans.md "Steps"). */
  private rebuild(name: string): void {
    const d = this.d;
    const t = d.target.get(name)!;
    const src = d.source.get(d.tableOf.get(name)!)!;
    const q = (n: string): string => this.q(n);
    const work = q(REBUILD_TABLE);
    const removed = d.removed.get(name) ?? [];
    const added = d.added.get(name) ?? [];
    const columns = d.columnOf.get(name)!;
    // 새 정의: target table과 보관 이름의 지우는 column
    const hiddenDropped = removed.map(c => ({ ...columnOf(src, c)!, name: this.hold(`${src.name}.${c}`) }));
    // 옛 정의: 이름 바꾸기를 적용한 source table과 보관 이름의 더하는 column
    const old = this.renamedSource(name);
    const hiddenAdded = added.map(c => ({ ...columnOf(t, c)!, name: this.hold(`+${name}.${c}`) }));
    const newCreate = (as: string): string => this.r.createTable(t, as, c => `${t.name}$${c}`, hiddenDropped);
    // sourceColumn은 옛 정의 column의 source 이름이다. 지우는 column은 이름이 그대로다.
    const sourceColumn = (c: string): string => columns.get(c) ?? c;
    const oldCreate = this.r.createTable(old, name, c => `${src.name}$${sourceColumn(c)}`, hiddenAdded);
    const newList = this.r.list([...t.columns.map(c => c.name), ...hiddenDropped.map(c => c.name)]);
    // 옛 table에서 새 정의로 옮기는 식
    const into: string[] = [];
    const from: string[] = [];
    const intoRestore: string[] = [];
    const fromRestore: string[] = [];
    for (const c of t.columns) {
      const oldName = columns.get(c.name);
      if (oldName !== undefined) {
        const e = this.copyValue(columnOf(src, oldName)!, c);
        into.push(q(c.name));
        from.push(e);
        intoRestore.push(q(c.name));
        fromRestore.push(e);
      } else {
        intoRestore.push(q(c.name));
        fromRestore.push(q(this.hold(`+${name}.${c.name}`)));
      }
    }
    removed.forEach((c, i) => {
      into.push(q(hiddenDropped[i]!.name));
      from.push(q(c));
      intoRestore.push(q(hiddenDropped[i]!.name));
      fromRestore.push(q(c));
    });
    // 새 정의에서 옛 정의로 되돌리는 식
    const backInto: string[] = [];
    const backFrom: string[] = [];
    let irreversible = '';
    const checks: DbspecNullCheck[] = [];
    for (const c of old.columns) {
      backInto.push(q(c.name));
      const sourceName = sourceColumn(c.name);
      const tc = columnOf(t, c.name);
      if (tc !== undefined && !removed.includes(sourceName)) {
        backFrom.push(q(c.name));
        if (precisionGrows(c.type, tc.type)) irreversible = IRREVERSIBLE_PRECISION;
        if (!c.nullable && tc.nullable) checks.push(this.nullCheck(name, c.name, c));
        continue;
      }
      // 지우는 column: 새 정의에서는 보관 이름이다.
      const h = this.hold(`${src.name}.${sourceName}`);
      backFrom.push(q(h));
      if (!c.nullable) checks.push(this.nullCheck(name, h, c));
    }
    // 옛 table에 숨긴 더한 column이 있으면 그 값도 되돌린다.
    const backIntoRestore = [...backInto, ...hiddenAdded.map(c => q(c.name))];
    const backFromRestore = [...backFrom, ...added.map(c => q(c))];
    const identity = t.columns.some(c => c.identity);
    const sequence = (to: string, fromName: string): string => `INSERT INTO sqlite_sequence (name, seq) SELECT '${to}', seq FROM sqlite_sequence WHERE name = '${fromName}'`;
    const unsequence = (n: string): string => `DELETE FROM sqlite_sequence WHERE name = '${n}'`;
    const qn = q(name);

    this.add(step(newCreate(REBUILD_TABLE), `DROP TABLE ${work}`, present('table', REBUILD_TABLE, '')));
    if (identity) this.add(step(sequence(REBUILD_TABLE, name), unsequence(REBUILD_TABLE), present('sequence', REBUILD_TABLE, '')));
    const copyIn = `INSERT INTO ${work} (${into.join(', ')}) SELECT ${from.join(', ')} FROM ${qn}`;
    if (hiddenAdded.length > 0) {
      this.add(
        step(copyIn, `DELETE FROM ${work}`, present('rows', REBUILD_TABLE, ''), {
          restore: `INSERT INTO ${work} (${intoRestore.join(', ')}) SELECT ${fromRestore.join(', ')} FROM ${qn}`,
          restoreIf: present('column', name, hiddenAdded[0]!.name),
        }),
      );
    } else {
      this.add(step(copyIn, `DELETE FROM ${work}`, present('rows', REBUILD_TABLE, '')));
    }
    for (const x of this.indexes(old, name)) this.add(step(x.drop, x.create, absent('index', name, x.name)));
    if (irreversible !== '') {
      this.add(step(`DELETE FROM ${qn}`, '', absent('rows', name, ''), { irreversible, nullChecks: checks }));
    } else if (hiddenAdded.length > 0) {
      this.add(
        step(`DELETE FROM ${qn}`, `INSERT INTO ${qn} (${backInto.join(', ')}) SELECT ${backFrom.join(', ')} FROM ${work}`, absent('rows', name, ''), {
          rollbackRestore: `INSERT INTO ${qn} (${backIntoRestore.join(', ')}) SELECT ${backFromRestore.join(', ')} FROM ${work}`,
          restoreIf: present('column', name, hiddenAdded[0]!.name),
          nullChecks: checks,
        }),
      );
    } else {
      this.add(step(`DELETE FROM ${qn}`, `INSERT INTO ${qn} (${backInto.join(', ')}) SELECT ${backFrom.join(', ')} FROM ${work}`, absent('rows', name, ''), { nullChecks: checks }));
    }
    if (identity) this.add(step(unsequence(name), sequence(name, REBUILD_TABLE), absent('sequence', name, '')));
    this.add(step(`DROP TABLE ${qn}`, oldCreate, absent('table', name, '')));
    this.add(step(newCreate(name), `DROP TABLE ${qn}`, present('table', name, '')));
    if (identity) this.add(step(sequence(name, REBUILD_TABLE), unsequence(name), present('sequence', name, '')));
    this.add(step(`INSERT INTO ${qn} (${newList}) SELECT ${newList} FROM ${work}`, `DELETE FROM ${qn}`, present('rows', name, '')));
    this.add(step(`DELETE FROM ${work}`, `INSERT INTO ${work} (${newList}) SELECT ${newList} FROM ${qn}`, absent('rows', REBUILD_TABLE, '')));
    if (identity) this.add(step(unsequence(REBUILD_TABLE), sequence(REBUILD_TABLE, name), absent('sequence', REBUILD_TABLE, '')));
    this.add(step(`DROP TABLE ${work}`, newCreate(REBUILD_TABLE), absent('table', REBUILD_TABLE, '')));
    this.createIndexes(t, name);
  }

  /** target table name의 source table에 이름 바꾸기를 적용한 정의다. 지우는 table을 참조하는 foreign key는 source 이름을 유지한다. */
  private renamedSource(name: string): DbspecTable {
    const d = this.d;
    const src = d.source.get(d.tableOf.get(name)!)!;
    const targetOfTable = new Map<string, string>();
    for (const [t, s] of d.tableOf) targetOfTable.set(s, t);
    const column = (table: string, c: string): string => {
      for (const [tc, sc] of d.columnOf.get(table) ?? []) if (sc === c) return tc;
      return c;
    };
    const rename = (cols: readonly string[]): string[] => cols.map(c => column(name, c));
    return {
      ...src,
      name,
      columns: src.columns.map(c => ({ ...c, name: column(name, c.name) })),
      primaryKey: { ...src.primaryKey, columns: rename(src.primaryKey.columns) },
      uniques: src.uniques.map((u): DbspecUnique => ({ ...u, columns: rename(u.columns) })),
      indexes: src.indexes.map((x): DbspecIndex => ({ ...x, columns: x.columns.map(c => ({ name: column(name, c.name), descending: c.descending })) })),
      foreignKeys: src.foreignKeys.map((f): DbspecForeignKey => {
        const parent = targetOfTable.get(f.table) ?? f.table;
        return { ...f, columns: rename(f.columns), table: parent, references: f.references.map(c => column(parent, c)) };
      }),
      checks: src.checks.map(k => ({ ...k, expression: renameCheck(k, c => column(name, c)) })),
    };
  }

  /** The SQLite rebuild copy of a source value into the target column; time and datetime append zero fraction digits. */
  private copyValue(from: DbspecColumn, to: DbspecColumn): string {
    const q = this.q(to.name);
    if (precisionGrows(from.type, to.type) && (from.type.kind === 'time' || from.type.kind === 'datetime') && (to.type.kind === 'time' || to.type.kind === 'datetime')) {
      let pad = '0'.repeat(to.type.precision - from.type.precision);
      if (from.type.precision === 0) pad = '.' + pad;
      return `${q} || '${pad}'`;
    }
    return q;
  }

  private alterColumn(table: string, from: DbspecColumn, to: DbspecColumn): void {
    const irreversible = precisionGrows(from.type, to.type) ? IRREVERSIBLE_PRECISION : '';
    const source: DbspecColumn = { ...from, name: to.name };
    const checks = !from.nullable && to.nullable ? [this.nullCheck(table, to.name, source)] : [];
    if (this.r.d === 'mysql') {
      const rollback = irreversible === '' ? `ALTER TABLE ${this.q(table)} MODIFY COLUMN ${this.r.column(source)}` : '';
      this.add(step(`ALTER TABLE ${this.q(table)} MODIFY COLUMN ${this.r.column(to)}`, rollback, repeat, { irreversible, nullChecks: checks }));
      return;
    }
    const prefix = `ALTER TABLE ${this.q(table)} ALTER COLUMN ${this.q(to.name)}`;
    const typeChanges = !sameType(from.type, to.type);
    if (typeChanges) {
      const rollback = irreversible === '' ? `${prefix} TYPE ${this.r.typeText(from.type)}` : '';
      this.add(step(`${prefix} TYPE ${this.r.typeText(to.type)}`, rollback, repeat, { irreversible }));
    }
    if (from.nullable !== to.nullable) {
      if (to.nullable) this.add(step(`${prefix} DROP NOT NULL`, `${prefix} SET NOT NULL`, repeat, { nullChecks: checks }));
      else this.add(step(`${prefix} SET NOT NULL`, `${prefix} DROP NOT NULL`, repeat));
    }
    if (!sameDefault(from.default, to.default) || (to.default !== null && typeChanges)) {
      const back = from.default === null ? `${prefix} DROP DEFAULT` : `${prefix} SET DEFAULT ${this.r.defaultText(from.type, from.default)}`;
      const forward = to.default === null ? `${prefix} DROP DEFAULT` : `${prefix} SET DEFAULT ${this.r.defaultText(to.type, to.default)}`;
      this.add(step(forward, back, repeat));
    }
  }

  /** 렌더링한 trigger statement에서 trigger 이름, CREATE TRIGGER와 PostgreSQL function을 짝짓는다. */
  private triggerParts(t: DbspecTable): { name: string; create: string; fn: string }[] {
    const out: { name: string; create: string; fn: string }[] = [];
    let fn = '';
    for (const s of this.r.triggers(t)) {
      if (s.startsWith('CREATE FUNCTION ')) {
        fn = s;
        continue;
      }
      const rest = s.slice('CREATE TRIGGER '.length);
      const quoted = rest.slice(0, rest.indexOf(' '));
      out.push({ name: quoted.slice(1, -1), create: s, fn });
      fn = '';
    }
    return out;
  }

  private dropTriggers(t: DbspecTable): void {
    for (const p of this.triggerParts(t)) {
      if (this.r.d === 'postgres') {
        this.add(step(`DROP TRIGGER ${this.q(p.name)} ON ${this.q(t.name)}`, p.create, absent('trigger', t.name, p.name)));
        this.add(step(`DROP FUNCTION ${this.q(p.name)}()`, p.fn, absent('function', '', p.name)));
        continue;
      }
      this.add(step(`DROP TRIGGER ${this.q(p.name)}`, p.create, absent('trigger', t.name, p.name)));
    }
  }

  private createTriggers(t: DbspecTable): void {
    for (const p of this.triggerParts(t)) {
      if (this.r.d === 'postgres') {
        this.add(step(p.fn, `DROP FUNCTION ${this.q(p.name)}()`, present('function', '', p.name)));
        this.add(step(p.create, `DROP TRIGGER ${this.q(p.name)} ON ${this.q(t.name)}`, present('trigger', t.name, p.name)));
        continue;
      }
      this.add(step(p.create, `DROP TRIGGER ${this.q(p.name)}`, present('trigger', t.name, p.name)));
    }
  }

  private dropCheck(table: string, name: string): string {
    return this.r.d === 'mysql' ? `ALTER TABLE ${this.q(table)} DROP CHECK ${this.q(name)}` : `ALTER TABLE ${this.q(table)} DROP CONSTRAINT ${this.q(name)}`;
  }

  private dropRendererCheck(table: string, name: string, expression: string): void {
    this.add(step(this.dropCheck(table, name), `ALTER TABLE ${this.q(table)} ADD CONSTRAINT ${this.q(name)} CHECK (${expression})`, absent('constraint', table, name)));
  }

  /** table t를 name으로 둔 unique key와 index를 renderer 순서로 돌려준다. SQLite unique key는 unique index다. */
  private indexes(t: DbspecTable, name: string): { name: string; create: string; drop: string }[] {
    const out: { name: string; create: string; drop: string }[] = [];
    if (this.r.d === 'sqlite') {
      for (const u of sortedBy(t.uniques, u => u.name)) {
        out.push({ name: u.name, create: `CREATE UNIQUE INDEX ${this.q(u.name)} ON ${this.q(name)} (${this.r.list(u.columns)})`, drop: this.dropIndex(name, u.name) });
      }
    }
    for (const x of sortedBy(t.indexes, x => x.name)) out.push({ name: x.name, create: this.createIndex(x, name), drop: this.dropIndex(name, x.name) });
    return out;
  }

  private createIndex(x: DbspecIndex, table: string): string {
    const columns = x.columns.map(c => this.q(c.name) + (c.descending ? ' DESC' : ''));
    return `CREATE INDEX ${this.q(x.name)} ON ${this.q(table)} (${columns.join(', ')})`;
  }

  private dropIndex(table: string, name: string): string {
    return this.r.d === 'mysql' ? `DROP INDEX ${this.q(name)} ON ${this.q(table)}` : `DROP INDEX ${this.q(name)}`;
  }

  /** renderer가 CREATE TABLE 뒤에 쓰는 unique index와 index다. */
  private createIndexes(t: DbspecTable, name: string): void {
    for (const x of this.indexes(t, name)) this.add(step(x.create, x.drop, present('index', name, x.name)));
  }

  /** table t(name으로 둔)의 객체 o를 더하는 statement, 지우는 statement, 그 효과의 종류다. */
  private objectStatements(t: DbspecTable, name: string, o: ObjectRef): [string, string, string] {
    const mysql = this.r.d === 'mysql';
    switch (o.kind) {
      case 'unique': {
        const u = uniqueOf(t, o.name)!;
        if (this.r.d === 'sqlite') return [`CREATE UNIQUE INDEX ${this.q(u.name)} ON ${this.q(name)} (${this.r.list(u.columns)})`, this.dropIndex(name, u.name), 'index'];
        const create = `ALTER TABLE ${this.q(name)} ADD CONSTRAINT ${this.q(u.name)} UNIQUE (${this.r.list(u.columns)})`;
        if (mysql) return [create, `ALTER TABLE ${this.q(name)} DROP INDEX ${this.q(u.name)}`, 'index'];
        return [create, `ALTER TABLE ${this.q(name)} DROP CONSTRAINT ${this.q(u.name)}`, 'constraint'];
      }
      case 'index':
        return [this.createIndex(indexOf(t, o.name)!, name), this.dropIndex(name, o.name), 'index'];
      case 'check': {
        const k = checkOf(t, o.name)!;
        return [`ALTER TABLE ${this.q(name)} ADD CONSTRAINT ${this.q(k.name)} CHECK (${this.r.predicate(t, readCheck(k.expression, k.name))})`, this.dropCheck(name, k.name), 'constraint'];
      }
      case 'foreign_key': {
        const f = foreignKeyOf(t, o.name)!;
        const drop = mysql ? `ALTER TABLE ${this.q(name)} DROP FOREIGN KEY ${this.q(f.name)}` : `ALTER TABLE ${this.q(name)} DROP CONSTRAINT ${this.q(f.name)}`;
        return [`ALTER TABLE ${this.q(name)} ADD ${this.r.foreignKey(f)}`, drop, 'constraint'];
      }
    }
    throw new Error(`unknown object kind ${String(o.kind)}`);
  }

  /** source table t의 객체를 지우고, rollback은 source 정의로 다시 만든다. */
  private dropObject(t: DbspecTable, o: ObjectRef): void {
    const [create, drop, kind] = this.objectStatements(t, t.name, o);
    this.add(step(drop, create, absent(kind, t.name, o.name)));
  }

  private addObject(table: string, o: ObjectRef): void {
    const [create, drop, kind] = this.objectStatements(this.d.target.get(table)!, table, o);
    this.add(step(create, drop, present(kind, table, o.name)));
  }

  /** The renderer CHECK names and expressions of a table. */
  private rendererChecks(t: DbspecTable): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of t.columns) {
      const check = this.r.typeCheck(c);
      if (check !== '') out.set(`${t.name}$${c.name}`, check);
    }
    return out;
  }
}
