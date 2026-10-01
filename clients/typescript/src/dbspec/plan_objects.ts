// plan diff의 객체, trigger, 변경 목록 (docs/plans.md "Diff").
// 기준은 Go 엔진(engine/dbspec/plan_objects.go)이다.
import { readCheck, type CheckExpr, type CheckOperand } from './check.js';
import type { DbspecCheck, DbspecForeignKey, DbspecIndex, DbspecTable, DbspecUnique } from './model.js';
import { sortedBy } from './plan.js';
import { append, renamedOr, sortedKeys, type PlanDiff } from './plan_diff.js';
import { Renderer } from './render.js';

export interface ObjectRef {
  readonly kind: 'unique' | 'index' | 'foreign_key' | 'check';
  readonly name: string;
}

function compareRef(a: ObjectRef, b: ObjectRef): number {
  const x = `${a.kind}\x00${a.name}`;
  const y = `${b.kind}\x00${b.name}`;
  return x < y ? -1 : x > y ? 1 : 0;
}

type Rename = (name: string) => string;
const same: Rename = c => c;

/**
 * Compares the uniques, indexes, foreign keys and checks of the matched tables
 * by name and definition; a source definition is read with the renames applied.
 */
export function diffObjects(d: PlanDiff, renamedFrom: ReadonlyMap<string, string>, renamedColumn: ReadonlyMap<string, ReadonlyMap<string, string>>): void {
  const targetTable = (s: string): string => renamedOr(renamedFrom, s);
  // column rename을 적용한 source 정의
  const column = (target: string, c: string): string => renamedOr(renamedColumn.get(target), c);
  const alteredColumn = new Set<string>(); // "table.column" target 이름
  const renamedCol = new Set<string>();
  for (const [t, cols] of d.altered) for (const c of cols) alteredColumn.add(`${t}.${c}`);
  for (const [t, m] of renamedColumn) for (const c of m.values()) renamedCol.add(`${t}.${c}`);
  for (const name of d.matched) {
    const src = d.source.get(d.tableOf.get(name)!)!;
    const tgt = d.target.get(name)!;
    const col: Rename = c => column(name, c);
    // 지우는 index나 unique 위의 foreign key는 MySQL이 그 index를 지우지 못하게
    // 하므로 함께 다시 만든다.
    const droppedKeys = new Set<string>();
    // unique
    for (const u of src.uniques) {
      const t = uniqueOf(tgt, u.name);
      if (t === undefined || t.columns.join(',') !== u.columns.map(col).join(',')) {
        append(d.dropObjects, src.name, { kind: 'unique', name: u.name });
        droppedKeys.add(u.columns.map(col).join(','));
      }
    }
    for (const u of tgt.uniques) {
      const s = uniqueOf(src, u.name);
      if (s === undefined || s.columns.map(col).join(',') !== u.columns.join(',')) append(d.addObjects, name, { kind: 'unique', name: u.name });
    }
    // index
    for (const x of src.indexes) {
      const t = indexOf(tgt, x.name);
      if (t === undefined || indexDef(x, col) !== indexDef(t, same)) {
        append(d.dropObjects, src.name, { kind: 'index', name: x.name });
        droppedKeys.add(x.columns.map(c => col(c.name)).join(','));
      }
    }
    for (const x of tgt.indexes) {
      const s = indexOf(src, x.name);
      if (s === undefined || indexDef(s, col) !== indexDef(x, same)) append(d.addObjects, name, { kind: 'index', name: x.name });
    }
    // foreign key
    const forcedFK = (child: string, cols: readonly string[], parent: string, refs: readonly string[]): boolean => {
      if (cols.some(c => alteredColumn.has(`${child}.${c}`))) return true;
      if (refs.some(c => alteredColumn.has(`${parent}.${c}`))) return true;
      const prefix = cols.join(',') + ',';
      for (const k of droppedKeys) if ((k + ',').startsWith(prefix)) return true;
      return false;
    };
    for (const f of src.foreignKeys) {
      const parent = targetTable(f.table);
      const cols = f.columns.map(col);
      const refs = f.references.map(c => column(parent, c));
      const t = foreignKeyOf(tgt, f.name);
      if (t === undefined || foreignKeyDef(cols, parent, refs, f) !== foreignKeyDef(t.columns, t.table, t.references, t) || forcedFK(name, cols, parent, refs)) {
        append(d.dropObjects, src.name, { kind: 'foreign_key', name: f.name });
      }
    }
    for (const f of tgt.foreignKeys) {
      const s = foreignKeyOf(src, f.name);
      let keep = false;
      if (s !== undefined) {
        const parent = targetTable(s.table);
        const cols = s.columns.map(col);
        const refs = s.references.map(c => column(parent, c));
        keep = foreignKeyDef(cols, parent, refs, s) === foreignKeyDef(f.columns, f.table, f.references, f) && !forcedFK(name, cols, parent, refs);
      }
      if (!keep) append(d.addObjects, name, { kind: 'foreign_key', name: f.name });
    }
    // check: 이름 바뀐 column이나 바뀐 column을 쓰는 check는 다시 만든다.
    const forcedCheck = (k: DbspecCheck): boolean =>
      exprColumns(checkTree(k)).some(c => renamedCol.has(`${name}.${c}`) || alteredColumn.has(`${name}.${c}`));
    for (const k of src.checks) {
      const t = checkOf(tgt, k.name);
      if (t === undefined || exprText(checkTree(k), col) !== exprText(checkTree(t), same) || forcedCheck(t)) {
        append(d.dropObjects, src.name, { kind: 'check', name: k.name });
      }
    }
    for (const k of tgt.checks) {
      const s = checkOf(src, k.name);
      if (s === undefined || exprText(checkTree(s), col) !== exprText(checkTree(k), same) || forcedCheck(k)) {
        append(d.addObjects, name, { kind: 'check', name: k.name });
      }
    }
  }
  // 지우는 table을 참조하는 남은 table의 foreign key는 target이 이미 뺐으므로
  // 위에서 지운다. 지우는 table 자신의 foreign key는 table과 함께 지운다.
  for (const name of d.dropped) {
    for (const f of d.source.get(name)!.foreignKeys) append(d.dropObjects, name, { kind: 'foreign_key', name: f.name });
  }
  for (const list of d.dropObjects.values()) list.sort(compareRef);
  for (const list of d.addObjects.values()) list.sort(compareRef);
}

/**
 * Marks the matched tables whose rendered trigger statements differ in any of
 * the three dialects; the source renders under its own names.
 */
export function diffTriggers(d: PlanDiff): void {
  for (const name of d.matched) {
    const src = d.source.get(d.tableOf.get(name)!)!;
    const tgt = d.target.get(name)!;
    for (const dialect of ['mysql', 'postgres', 'sqlite'] as const) {
      const r = new Renderer(dialect);
      const before = r.triggers(src);
      const after = r.triggers(tgt);
      if (before.length !== after.length || before.some((s, i) => s !== after[i])) {
        d.triggers.add(name);
        break;
      }
    }
  }
}

export function collectChanges(d: PlanDiff): void {
  const add = (kind: string, table: string, name: string): void => {
    d.changes.push({ kind, table, name });
  };
  for (const name of d.matched) {
    if (d.triggers.has(name) && hasTriggers(d.source.get(d.tableOf.get(name)!)!)) add('drop_triggers', d.tableOf.get(name)!, '');
  }
  for (const s of sortedKeys(d.dropObjects)) for (const o of d.dropObjects.get(s)!) add(`drop_${o.kind}`, s, o.name);
  for (const r of sortedBy(d.renamedTables, r => r.old)) add('rename_table', r.old, r.new);
  for (const r of sortedBy(d.renamedColumns, r => `${r.table}.${r.old}`)) add('rename_column', r.table, `${r.old} ${r.new}`);
  for (const name of d.matched) for (const c of d.removed.get(name) ?? []) add('drop_column', d.tableOf.get(name)!, c);
  for (const name of d.dropped) add('drop_table', name, '');
  for (const name of d.created) add('create_table', name, '');
  for (const name of d.matched) {
    for (const c of d.added.get(name) ?? []) add('add_column', name, c);
    for (const c of d.altered.get(name) ?? []) add('alter_column', name, c);
  }
  for (const t of sortedKeys(d.addObjects)) for (const o of d.addObjects.get(t)!) add(`add_${o.kind}`, t, o.name);
  for (const name of d.matched) {
    if (d.triggers.has(name) && hasTriggers(d.target.get(name)!)) add('create_triggers', name, '');
  }
}

/** Whether the table has the immutable or audit setting, which render triggers. */
export function hasTriggers(t: DbspecTable): boolean {
  return t.settings !== null && t.settings.settings.some(s => s.kind === 'immutable' || s.kind === 'audit');
}

export function indexDef(x: DbspecIndex, f: Rename): string {
  return x.columns.map(c => f(c.name) + (c.descending ? ' desc' : '') + ',').join('');
}

export function foreignKeyDef(cols: readonly string[], parent: string, refs: readonly string[], f: DbspecForeignKey): string {
  return `${cols.join(',')}>${parent}(${refs.join(',')})${f.onDelete}/${f.onUpdate}`;
}

export function uniqueOf(t: DbspecTable, name: string): DbspecUnique | undefined {
  return t.uniques.find(u => u.name === name);
}

export function indexOf(t: DbspecTable, name: string): DbspecIndex | undefined {
  return t.indexes.find(x => x.name === name);
}

export function foreignKeyOf(t: DbspecTable, name: string): DbspecForeignKey | undefined {
  return t.foreignKeys.find(f => f.name === name);
}

export function checkOf(t: DbspecTable, name: string): DbspecCheck | undefined {
  return t.checks.find(k => k.name === name);
}

function checkTree(k: DbspecCheck): CheckExpr {
  return readCheck(k.expression, k.name);
}

function operandColumns(e: CheckOperand): string[] {
  return e.kind === 'column' ? [e.name] : [];
}

/** The column names an expression uses. */
function exprColumns(e: CheckExpr): string[] {
  switch (e.kind) {
    case 'logical':
      return [...exprColumns(e.left), ...exprColumns(e.right)];
    case 'compare':
      return [...operandColumns(e.left), ...operandColumns(e.right)];
    case 'in':
    case 'is_null':
      return operandColumns(e.operand);
  }
}

function operandText(e: CheckOperand, f: Rename): string {
  return e.kind === 'column' ? f(e.name) : e.text;
}

/** The canonical text of an expression with its column names mapped by f; only an or inside an and takes parentheses. */
function exprText(e: CheckExpr, f: Rename): string {
  switch (e.kind) {
    case 'logical': {
      const side = (q: CheckExpr): string => (e.op === 'and' && q.kind === 'logical' && q.op === 'or' ? `(${exprText(q, f)})` : exprText(q, f));
      return `${side(e.left)} ${e.op} ${side(e.right)}`;
    }
    case 'compare':
      return `${operandText(e.left, f)} ${e.op} ${operandText(e.right, f)}`;
    case 'in':
      return `${operandText(e.operand, f)}${e.negated ? ' not' : ''} in (${e.list.join(', ')})`;
    case 'is_null':
      return `${operandText(e.operand, f)} is ${e.negated ? 'not null' : 'null'}`;
  }
}
