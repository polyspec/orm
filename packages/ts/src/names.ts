// Method names of models follow the chain grammar of docs/dsl.md. A name is
// split into PascalCase words; column names never contain connector or
// operator segments, so the split is unambiguous.
import type { Entity, RuntimeModel } from './engine/model.js';
import { OrmError } from './runtime_error.js';

export interface ChainKey {
  conn: string;
  op: string;
  column: string;
  columns: string[];
  compare: string;
}

export function pascal(name: string): string {
  return name.split('_').map(part => part === '' ? '' : part[0]!.toUpperCase() + part.slice(1)).join('');
}

export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (letter, index: number) => (index > 0 ? '_' : '') + letter.toLowerCase());
}

export function upperFirst(name: string): string { return name === '' ? name : name[0]!.toUpperCase() + name.slice(1); }

export function words(name: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i < name.length; i++) {
    const c = name[i]!;
    if (c >= 'A' && c <= 'Z') {
      out.push(name.slice(start, i));
      start = i;
    }
  }
  if (start < name.length) out.push(name.slice(start));
  return out;
}

const indexes = new WeakMap<Entity, Map<string, string>>();

function columnIndex(e: Entity): Map<string, string> {
  let index = indexes.get(e);
  if (index === undefined) {
    index = new Map(e.fields.map(f => [pascal(f.name), f.name]));
    indexes.set(e, index);
  }
  return index;
}

/** Returns the column of e (or of any entity when e is undefined) named by a PascalCase name. */
export function columnName(model: RuntimeModel, e: Entity | undefined, name: string): string {
  if (e !== undefined) return columnIndex(e).get(name) ?? '';
  for (const entity of model.entities.values()) {
    const found = columnIndex(entity).get(name);
    if (found !== undefined) return found;
  }
  return '';
}

const leadingOps: Record<string, string> = { Ne: 'ne', Eq: '', Gt: 'gt', Lt: 'lt', Ge: 'ge', Le: 'le', Lk: 'lk', Lb: 'lb', Between: 'between' };
const compareOps: Record<string, string> = { Eq: '', Ne: 'ne', Gt: 'gt', Lt: 'lt', Ge: 'ge', Le: 'le' };

function key(fields: Partial<ChainKey>): ChainKey {
  return { conn: '', op: '', column: '', columns: [], compare: '', ...fields };
}

function splitWith(e: Entity, ws: readonly string[]): string[] | undefined {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= ws.length; i++) {
    if (i < ws.length && ws[i] !== 'With') continue;
    const column = columnIndex(e).get(ws.slice(start, i).join(''));
    if (column === undefined) return undefined;
    out.push(column);
    start = i + 1;
  }
  return out;
}

function parseKey(model: RuntimeModel, e: Entity, ws: readonly string[]): ChainKey {
  if (ws.length === 0) throw new OrmError('CONFIG', 'a condition key is empty');
  const text = ws.join('');
  const candidates: ChainKey[] = [];
  const errors: string[] = [];
  const whole = columnIndex(e).get(text);
  if (whole !== undefined) candidates.push(key({ column: whole }));
  const op = leadingOps[ws[0]!];
  if (op !== undefined && ws.length > 1) {
    if (ws[0] === 'Ne' && ws[1] === 'Tuple') {
      const cols = splitWith(e, ws.slice(2));
      if (cols && cols.length >= 2) candidates.push(key({ op: 'ne_tuple', columns: cols }));
      else errors.push(`a tuple needs two or more columns of ${e.name} joined by With`);
    } else {
      const column = columnIndex(e).get(ws.slice(1).join(''));
      if (column !== undefined) candidates.push(key({ op, column }));
    }
  }
  if (ws[0] === 'Tuple') {
    const cols = splitWith(e, ws.slice(1));
    if (cols && cols.length >= 2) candidates.push(key({ op: 'tuple', columns: cols }));
    else errors.push(`a tuple needs two or more columns of ${e.name} joined by With`);
  }
  for (let i = 1; i < ws.length - 1; i++) {
    const cmp = compareOps[ws[i]!];
    if (cmp === undefined) continue;
    const left = columnIndex(e).get(ws.slice(0, i).join(''));
    if (left === undefined) continue;
    const right = columnName(model, undefined, ws.slice(i + 1).join(''));
    if (right === '') {
      errors.push(`no model has the column ${ws.slice(i + 1).join('')}`);
      continue;
    }
    candidates.push(key({ op: cmp, column: left, compare: right }));
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) throw new OrmError('CONFIG', `${text} has more than one meaning`);
  throw new OrmError('CONFIG', errors.length > 0 ? `${text}: ${errors.join('; ')}` : `${text} is not a column of ${e.name}`);
}

/** Parses the chain part of a method name (PascalCase) for entity e. */
export function parseChain(model: RuntimeModel, e: Entity, name: string): ChainKey[] {
  const ws = words(name);
  if (ws.length === 0) throw new OrmError('CONFIG', 'empty condition name');
  const keys: ChainKey[] = [];
  let conn = '';
  let start = 0;
  const flush = (end: number) => {
    const parsed = parseKey(model, e, ws.slice(start, end));
    parsed.conn = conn;
    keys.push(parsed);
  };
  ws.forEach((w, i) => {
    if (w === 'And' || w === 'Or') {
      flush(i);
      conn = w.toLowerCase();
      start = i + 1;
    }
  });
  flush(ws.length);
  return keys;
}

export interface OrderKey { column: string; desc: boolean; }

export function parseOrder(e: Entity, name: string): OrderKey[] {
  const ws = words(name);
  const out: OrderKey[] = [];
  let start = 0;
  for (let i = 0; i <= ws.length; i++) {
    if (i < ws.length && ws[i] !== 'And') continue;
    const part = ws.slice(start, i);
    start = i + 1;
    const dir = part[part.length - 1];
    if (part.length < 2 || (dir !== 'Asc' && dir !== 'Desc')) throw new OrmError('CONFIG', `orderBy${name}: each key needs a column and Asc or Desc`);
    const column = columnIndex(e).get(part.slice(0, -1).join(''));
    if (column === undefined) throw new OrmError('CONFIG', `orderBy${name}: ${part.slice(0, -1).join('')} is not a column of ${e.name}`);
    out.push({ column, desc: dir === 'Desc' });
  }
  return out;
}

/** Parses <L>With<R>; an undefined entity accepts a column of any entity. */
export function splitPair(model: RuntimeModel, left: Entity | undefined, right: Entity | undefined, name: string): [string, string] {
  const ws = words(name);
  const found: Array<[string, string]> = [];
  ws.forEach((w, i) => {
    if (w !== 'With') return;
    const l = columnName(model, left, ws.slice(0, i).join(''));
    const r = columnName(model, right, ws.slice(i + 1).join(''));
    if (l !== '' && r !== '') found.push([l, r]);
  });
  if (found.length === 1) return found[0]!;
  throw new OrmError('CONFIG', found.length === 0 ? `${name} is not <column>With<column>` : `${name} has more than one meaning`);
}
