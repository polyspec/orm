// Method names of generated models are parsed with the grammar of
// docs/dsl.md. Generation rejects names whose operator does not fit the
// column type.
import { columnOf, type Column, type Entity, type Manifest } from '../engine/manifest.js';
import { opAllowed } from '../engine/validate.js';
import { pascal, words } from '../names.js';

/** An underscore-separated segment no column name may contain. */
export const reservedSegments = ['and', 'or', 'with', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'lk', 'lb', 'between', 'fulltext', 'tuple'];
/** A prefix no column name may start with. */
export const reservedPrefixes = ['and', 'or', 'get', 'set', 'new', 'plus', 'minus', 'order_by', 'group_by', 'tuple', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'lk', 'lb', 'between', 'fulltext'];
/** Names no column may have. */
export const reservedColumns = ['and', 'or', 'get', 'gets', 'gets_page', 'get_query', 'limit', 'alias', 'connect', 'create', 'creates', 'update', 'delete', 'save', 'raw', 'on', 'random'];

/** Applies the column naming rules. */
export function checkColumnName(n: string): string | undefined {
  if (!/^[a-z][a-z0-9_]*$/.test(n)) return `column name must be snake_case: ${n}`;
  if (n.includes('__')) return `column name may not contain '__': ${n}`;
  for (const segment of n.split('_')) if (reservedSegments.includes(segment)) return `column name may not contain the segment "${segment}": ${n}`;
  if (reservedColumns.includes(n)) return `column name is a reserved method name: ${n}`;
  for (const p of reservedPrefixes) if (n === p || n.startsWith(`${p}_`)) return `column name may not start with "${p}": ${n}`;
  return undefined;
}

export function checkColumnNames(m: Manifest): void {
  for (const name of m.order) {
    for (const c of m.entities[name]!.columns) {
      const problem = checkColumnName(c.name);
      if (problem !== undefined) throw new Error(`${name}.${c.name}: ${problem}`);
    }
  }
}

/** The style stages the executor applies (aes, hex, and ip stay with the dialect). */
export function appStyles(c: Column): string[] {
  return (c.styles ?? []).filter(s => s !== 'aes' && s !== 'hex' && s !== 'ip');
}

export function numeric(c: Column): boolean {
  return appStyles(c).length === 0 && ['i32', 'i64', 'f64', 'decimal'].includes(c.type);
}

/** Columns that accept column functions. */
export function functionColumn(c: Column): boolean {
  return appStyles(c).length === 0 && (c.type === 'date' || c.type === 'datetime' || c.type === 'point');
}

export function category(c: Column): string {
  if (appStyles(c).length > 0 || c.type === 'json') return 'none';
  switch (c.type) {
    case 'i32': case 'i64': return 'int';
    case 'f64': return 'float';
    case 'decimal': return 'decimal';
    case 'bool': return 'bool';
    case 'date': case 'datetime': return 'time';
    case 'bytes': return 'bytes';
    case 'point': return 'point';
  }
  return 'string';
}

export interface ChainKey {
  conn: string;
  op: string;
  column: string;
  columns: string[];
  compare: string;
}

const leadingOps: Record<string, string> = { Ne: 'ne', Eq: '', Gt: 'gt', Lt: 'lt', Ge: 'ge', Le: 'le', Lk: 'lk', Lb: 'lb', Between: 'between' };
const compareOps: Record<string, string> = { Eq: '', Ne: 'ne', Gt: 'gt', Lt: 'lt', Ge: 'ge', Le: 'le' };
const engineOp: Record<string, string> = { '': 'eq', ne: 'not_eq', gt: 'gt', lt: 'lt', ge: 'gte', le: 'lte', lk: 'contains', lb: 'contains_binary', between: 'between' };

function key(fields: Partial<ChainKey>): ChainKey {
  return { conn: '', op: '', column: '', columns: [], compare: '', ...fields };
}

function indexColumns(e: Entity): Map<string, Column> {
  return new Map(e.columns.map(c => [pascal(c.name), c]));
}

/** The column of e (or of any entity when e is undefined) named by a PascalCase name. */
export function columnName(m: Manifest, e: Entity | undefined, name: string): string {
  const entities = e !== undefined ? [e] : m.order.map(n => m.entities[n]!);
  for (const ent of entities) for (const c of ent.columns) if (pascal(c.name) === name) return c.name;
  return '';
}

class NameError extends Error {}

function checkOp(e: Entity, c: Column, op: string, k: ChainKey): ChainKey {
  if (k.compare !== '') {
    if (!opAllowed(c, `${engineOp[op]}_col`) || appStyles(c).length > 0) throw new NameError(`${e.name}.${c.name} cannot be compared with a column`);
    return k;
  }
  let allowed = opAllowed(c, engineOp[op]!);
  if (op === '' || op === 'ne') allowed ||= opAllowed(c, 'is_null');
  if (['gt', 'lt', 'ge', 'le', ''].includes(op) && functionColumn(c)) allowed = true;
  if (!allowed) throw new NameError(`${e.name}.${c.name} does not accept the ${op === '' ? 'equality' : op} operator`);
  return k;
}

function splitWith(ix: Map<string, Column>, ws: readonly string[]): Column[] | undefined {
  const out: Column[] = [];
  let start = 0;
  for (let i = 0; i <= ws.length; i++) {
    if (i < ws.length && ws[i] !== 'With') continue;
    const c = ix.get(ws.slice(start, i).join(''));
    if (c === undefined) return undefined;
    out.push(c);
    start = i + 1;
  }
  return out;
}

function tupleKey(e: Entity, ix: Map<string, Column>, ws: readonly string[], op: string): ChainKey {
  const cols = splitWith(ix, ws);
  if (!cols || cols.length < 2) throw new NameError(`a tuple needs two or more columns of ${e.name} joined by With`);
  for (const c of cols) if (appStyles(c).length > 0 || !opAllowed(c, 'in')) throw new NameError(`${e.name}.${c.name} cannot be used in a tuple`);
  return key({ op, columns: cols.map(c => c.name) });
}

function fulltextKey(e: Entity, ix: Map<string, Column>, ws: readonly string[], op: string): ChainKey {
  const cols = splitWith(ix, ws);
  if (!cols || cols.length === 0) throw new NameError(`full-text columns of ${e.name} are not valid`);
  const names = cols.map(c => c.name);
  if ((e.fulltext ?? []).some(index => index.length === names.length && index.every((c, i) => c === names[i]))) return key({ op, columns: names });
  throw new NameError(`${e.name} has no full-text index on ${names.join(', ')}`);
}

function parseKey(m: Manifest, e: Entity, ix: Map<string, Column>, ws: readonly string[]): ChainKey {
  if (ws.length === 0) throw new NameError('a condition key is empty');
  const text = ws.join('');
  const candidates: ChainKey[] = [];
  const errors: string[] = [];
  const attempt = (fn: () => ChainKey) => {
    try { candidates.push(fn()); } catch (error) {
      if (!(error instanceof NameError)) throw error;
      errors.push(error.message);
    }
  };
  const whole = ix.get(text);
  if (whole) attempt(() => checkOp(e, whole, '', key({ column: whole.name })));
  const op = leadingOps[ws[0]!];
  if (op !== undefined && ws.length > 1) {
    if (ws[0] === 'Ne' && ws[1] === 'Tuple') attempt(() => tupleKey(e, ix, ws.slice(2), 'ne_tuple'));
    else {
      const c = ix.get(ws.slice(1).join(''));
      if (c) attempt(() => checkOp(e, c, op, key({ op, column: c.name })));
    }
  }
  if (ws[0] === 'Tuple') attempt(() => tupleKey(e, ix, ws.slice(1), 'tuple'));
  if (ws[0] === 'Fulltext') {
    attempt(() => fulltextKey(e, ix, ws.slice(1), 'fulltext'));
    if (ws.length > 1 && ws[1] === 'Boolean') attempt(() => fulltextKey(e, ix, ws.slice(2), 'fulltext_boolean'));
  }
  for (let i = 1; i < ws.length - 1; i++) {
    const cmp = compareOps[ws[i]!];
    if (cmp === undefined) continue;
    const left = ix.get(ws.slice(0, i).join(''));
    if (!left) continue;
    const right = ws.slice(i + 1).join('');
    const compare = columnName(m, undefined, right);
    if (compare === '') {
      errors.push(`no model has the column ${right}`);
      continue;
    }
    attempt(() => checkOp(e, left, cmp, key({ op: cmp, column: left.name, compare })));
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) throw new NameError(errors.length > 0 ? `${text}: ${errors.join('; ')}` : `${text} is not a column of ${e.name}`);
  throw new NameError(`${text} has more than one meaning`);
}

/** Parses the chain part of a method name; undefined when the name is not valid. */
export function parseChain(m: Manifest, e: Entity, name: string): ChainKey[] | undefined {
  const ws = words(name);
  if (ws.length === 0) return undefined;
  const ix = indexColumns(e);
  const keys: ChainKey[] = [];
  let conn = '';
  let start = 0;
  try {
    const flush = (end: number) => {
      const k = parseKey(m, e, ix, ws.slice(start, end));
      k.conn = conn;
      keys.push(k);
    };
    ws.forEach((w, i) => {
      if (w === 'And' || w === 'Or') {
        flush(i);
        conn = w.toLowerCase();
        start = i + 1;
      }
    });
    flush(ws.length);
  } catch (error) {
    if (error instanceof NameError) return undefined;
    throw error;
  }
  return keys;
}

/** Reports whether an orderBy chain is valid. */
export function validOrder(e: Entity, name: string): boolean {
  const ix = indexColumns(e);
  const ws = words(name);
  let start = 0;
  for (let i = 0; i <= ws.length; i++) {
    if (i < ws.length && ws[i] !== 'And') continue;
    const part = ws.slice(start, i);
    start = i + 1;
    if (part.length < 2) return false;
    const dir = part[part.length - 1];
    if (dir !== 'Asc' && dir !== 'Desc') return false;
    if (!ix.has(part.slice(0, -1).join(''))) return false;
  }
  return true;
}

/** Parses <L>With<R>; an undefined entity accepts a column of any entity. */
export function splitPair(m: Manifest, left: Entity | undefined, right: Entity | undefined, name: string): [string, string] | undefined {
  const ws = words(name);
  const found: Array<[string, string]> = [];
  ws.forEach((w, i) => {
    if (w !== 'With') return;
    const l = ws.slice(0, i).join('');
    const r = ws.slice(i + 1).join('');
    if (l === '' || r === '') return;
    const lc = columnName(m, left, l);
    const rc = columnName(m, right, r);
    if (lc !== '' && rc !== '') found.push([lc, rc]);
  });
  return found.length === 1 ? found[0] : undefined;
}

export { columnOf, pascal };
