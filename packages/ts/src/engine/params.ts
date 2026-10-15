// request parameter가 채우는 slot이다. IR executor message는 각 parameter를 그 slot type의 form으로 쓰므로
// (docs/protocol.md §5 Parameters) client가 여기서 type을 읽는다.
import type { Assignment, Group, Predicate, Request, RequestQuery } from '../ir.js';
import { present } from '../present.js';
import { valueFunctionUnits } from './dialect.js';
import { entityOf, fieldOf, type Entity, type Field, type RuntimeModel } from './model.js';

/**
 * One slot that a request parameter fills: the slot's logical type, a dbspec
 * type kind, and for a column slot the compared or assigned column with its
 * precision, scale, length and nullability.
 */
export interface ParamUse {
  readonly type: string;
  readonly column?: Field;
}

/**
 * Lists the uses of each parameter of a validated request, by parameter index:
 * the compared or assigned column; a column function's result; i32, or f64 for
 * seconds, for the interval of a relative time function; text for contains and
 * contains_binary; the parent column for if_parent; the column for optimistic.
 */
export function paramUses(m: RuntimeModel, r: Request): ParamUse[][] {
  const u = new ParamUses(m, r.n_params);
  const ent = entityOf(m, r.entity);
  u.query(r, undefined);
  if (ent !== undefined) {
    for (const a of r.set ?? []) u.assign(ent, a);
    for (const a of r.on_duplicate ?? []) u.assign(ent, a);
    const set = r.set ?? [];
    for (const row of r.rows ?? []) row.forEach((i, j) => u.column(i, fieldOf(ent, present(set[j], `the assignment of row value ${j + 1}`).column)));
    if (r.optimistic) u.column(r.optimistic.p, fieldOf(ent, r.optimistic.column));
  }
  return u.out;
}

class ParamUses {
  public readonly out: ParamUse[][];

  public constructor(private readonly m: RuntimeModel, n: number) {
    this.out = Array.from({ length: n }, () => []);
  }

  private add(i: number, use: ParamUse): void {
    this.out[i]?.push(use);
  }

  public column(i: number, f: Field | undefined): void {
    if (f !== undefined) this.add(i, { type: f.type, column: f });
  }

  public assign(ent: Entity, a: Assignment): void {
    const f = fieldOf(ent, a.column);
    for (const p of [a.p, a.plus_p, a.minus_p]) if (p !== undefined) this.column(p, f);
  }

  /** q를 걷는다. relation 자식이면 parent가 그 부모 entity다. */
  public query(q: RequestQuery, parent: Entity | undefined): void {
    const ent = entityOf(this.m, q.entity);
    if (ent === undefined) return;
    this.group(q.on, ent);
    this.group(q.where, ent);
    if (q.if_parent && parent !== undefined) this.column(q.if_parent.p, fieldOf(parent, q.if_parent.column));
    for (const s of Object.values(q.columns?.sub ?? {})) this.query(s.query, undefined);
    for (const j of q.joins ?? []) this.query(j.query, undefined);
    for (const rel of q.relations ?? []) this.query(rel.query, ent);
  }

  private group(g: Group | undefined, ent: Entity): void {
    for (const item of g?.items ?? []) {
      if (item.pred) this.pred(item.pred, ent);
      else if (item.group) this.group(item.group, ent);
    }
  }

  private pred(p: Predicate, ent: Entity): void {
    if (p.sub) this.query(p.sub.query, undefined);
    if (p.op === 'tuple_in' || p.op === 'tuple_not_in') {
      const cols = p.cols ?? [];
      if (cols.length > 0) (p.ps ?? []).forEach((i, k) => this.column(i, fieldOf(ent, present(cols[k % cols.length], `tuple column ${k % cols.length + 1}`))));
      return;
    }
    const f = fieldOf(ent, p.column ?? '');
    if (p.value !== undefined) for (const i of p.value.ps ?? []) this.add(i, { type: intervalType(p.value.name) });
    if (p.op === 'contains' || p.op === 'contains_binary') {
      if (p.p !== undefined) this.add(p.p, { type: 'text' });
      return;
    }
    const slots = p.p !== undefined ? [p.p, ...p.ps ?? []] : p.ps ?? [];
    for (const i of slots) {
      if (p.fn) {
        const t = functionType(p.fn.name, f);
        if (f !== undefined && t === f.type) this.column(i, f);
        else this.add(i, { type: t });
        continue;
      }
      this.column(i, f);
    }
  }
}

/** The type of a column function's result on column f: the type of a parameter compared with it and of the output column it selects. */
export function functionType(name: string, f: Field | undefined): string {
  switch (name) {
    case 'day_of_week': case 'year': case 'month': return 'i64';
    case 'date': return 'date';
  }
  return f?.type ?? 'text';
}

/** The type of the interval of a relative time function: seconds take a fraction, the other units an integer. */
function intervalType(name: string): string {
  return valueFunctionUnits[name] === 'second' ? 'f64' : 'i32';
}
