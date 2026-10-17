import type { Assignment, Group, Item, Join, Order, Predicate, Relation, Request, RequestQuery, Subquery, OrmFunction } from '../ir.js';
import { OrmError } from '../runtime_error.js';

/**
 * The canonical form of a request for the plan cache (T169-3, the rule of packages/go/orm/canonical.go). An IN or NOT IN
 * list without a subquery pads to the next power of two by repeating its last value, which leaves the predicate
 * unchanged. Every parameter reference then gets a slot of its own in the walk of the request, and the walk visits the
 * fields in a fixed order, so the slots and the key depend only on the statement and the bucket of each list. Parameters
 * that no reference names follow the slots in their original order. The result holds the parameters in slot order.
 */
export function canonicalize(request: Request, params: readonly unknown[]): { request: Request; params: unknown[] } {
  const c = new Canonicalizer(params);
  const { manifest_hash, ir_version, kind, load, agg } = request;
  const query = c.query(request);
  const out: Request = { ...request, ...query, ir_version, manifest_hash, kind };
  if (load !== undefined) out.load = load;
  if (agg !== undefined) out.agg = agg;
  if (request.set !== undefined) out.set = c.assignments(request.set);
  if (request.on_duplicate !== undefined) out.on_duplicate = c.assignments(request.on_duplicate);
  if (request.rows !== undefined) out.rows = request.rows.map(row => c.ints(row));
  if (request.optimistic !== undefined) out.optimistic = { ...request.optimistic, p: c.index(request.optimistic.p) };
  for (let i = 0; i < params.length; i++) if (!c.used[i]) c.out.push(params[i]);
  out.n_params = c.out.length;
  return { request: out, params: c.out };
}

class Canonicalizer {
  public readonly out: unknown[] = [];
  public readonly used: boolean[];

  public constructor(private readonly params: readonly unknown[]) {
    this.used = params.map(() => false);
  }

  /** Adds one slot holding the value of parameter p and returns the slot index. */
  public index(p: number): number {
    if (!Number.isSafeInteger(p) || p < 0 || p >= this.params.length) throw new OrmError('IR_INVALID', `param index ${p} out of range (n_params ${this.params.length})`);
    this.used[p] = true;
    this.out.push(this.params[p]);
    return this.out.length - 1;
  }

  public ints(ps: readonly number[]): number[] {
    return ps.map(p => this.index(p));
  }

  /** Pads an IN list to its bucket: the slots past the last value repeat it. */
  public list(ps: readonly number[]): number[] {
    const n = ps.length;
    if (n === 0) return [];
    let bucket = 1;
    while (bucket < n) bucket <<= 1;
    const out: number[] = [];
    for (let j = 0; j < bucket; j++) out.push(this.index(ps[Math.min(j, n - 1)]!));
    return out;
  }

  public fn(f: OrmFunction): OrmFunction {
    return f.ps === undefined ? { ...f } : { ...f, ps: this.ints(f.ps) };
  }

  public subquery(s: Subquery): Subquery {
    return { ...s, query: this.query(s.query) };
  }

  public assignments(as: readonly Assignment[]): Assignment[] {
    return as.map(a => {
      const v: Assignment = { ...a };
      if (a.p !== undefined) v.p = this.index(a.p);
      if (a.plus_p !== undefined) v.plus_p = this.index(a.plus_p);
      if (a.minus_p !== undefined) v.minus_p = this.index(a.minus_p);
      return v;
    });
  }

  public groupOf(g: Group): Group {
    return { ...g, items: g.items.map((item): Item => this.item(item)) };
  }

  private item(item: Item): Item {
    const out: Item = {};
    if (item.pred !== undefined) out.pred = this.predicate(item.pred);
    if (item.group !== undefined) out.group = this.groupOf(item.group);
    if (item.joined !== undefined) out.joined = { ...item.joined };
    return out;
  }

  private predicate(p: Predicate): Predicate {
    const v: Predicate = { ...p };
    if (p.p !== undefined) v.p = this.index(p.p);
    if (p.ps !== undefined) v.ps = (p.op === 'in' || p.op === 'not_in') && p.sub === undefined ? this.list(p.ps) : this.ints(p.ps);
    if (p.fn !== undefined) v.fn = this.fn(p.fn);
    if (p.value !== undefined) v.value = this.fn(p.value);
    if (p.sub !== undefined) v.sub = this.subquery(p.sub);
    if (p.ref !== undefined) v.ref = { ...p.ref };
    if (p.cols !== undefined) v.cols = [...p.cols];
    return v;
  }

  public query(q: RequestQuery): RequestQuery {
    const out: RequestQuery = { ...q };
    if (q.columns !== undefined) {
      const cols = { ...q.columns };
      if (q.columns.add !== undefined) cols.add = [...q.columns.add];
      if (q.columns.remove !== undefined) cols.remove = [...q.columns.remove];
      if (q.columns.fn !== undefined) {
        cols.fn = {};
        for (const k of Object.keys(q.columns.fn).sort()) cols.fn[k] = { ...q.columns.fn[k]!, fn: this.fn(q.columns.fn[k]!.fn) };
      }
      if (q.columns.sub !== undefined) {
        cols.sub = {};
        for (const k of Object.keys(q.columns.sub).sort()) cols.sub[k] = this.subquery(q.columns.sub[k]!);
      }
      out.columns = cols;
    }
    if (q.on !== undefined) out.on = this.groupOf(q.on);
    if (q.where !== undefined) out.where = this.groupOf(q.where);
    if (q.joins !== undefined) out.joins = q.joins.map((j: Join) => ({ ...j, query: this.query(j.query) }));
    if (q.relations !== undefined) {
      out.relations = q.relations.map((r: Relation): Relation => {
        const v: Relation = { ...r, query: this.query(r.query) };
        if (r.keys !== undefined) v.keys = r.keys.map(k => ({ ...k }));
        return v;
      });
    }
    if (q.order !== undefined) out.order = q.order.map((o: Order) => (o.fn === undefined ? { ...o } : { ...o, fn: this.fn(o.fn) }));
    if (q.group_by !== undefined) out.group_by = [...q.group_by];
    if (q.limit !== undefined) out.limit = { ...q.limit };
    if (q.if_parent !== undefined) out.if_parent = { ...q.if_parent, p: this.index(q.if_parent.p) };
    return out;
  }
}
