// The Mermaid erDiagram schema source (docs/schema.md), parsed before
// validation and name derivation.
import { quoted } from './json.js';

export interface OrmDirective {
  kind: string;
  name: string;
  args: Record<string, string>;
  raw: string;
  line: number;
}

export interface DEntity {
  name: string;
  comment: string;
  columns: DColumn[];
  line: number;
}

export interface DColumn {
  type: string;
  name: string;
  keys: string[];
  comment: string;
  dbComment: string;
  line: number;
  nullable: boolean;
  default: string | undefined;
  auto: boolean;
  onUpdate: boolean;
  unsigned: boolean;
  bool: boolean;
  int: boolean;
  lazy: boolean;
  styles: string[];
  ref: string;
  describe: string;
}

export interface DRelation {
  parent: string;
  child: string;
  cardinality: string;
  label: string;
  line: number;
  fks: string[];
  childName: string;
  parentName: string;
  onDelete: string;
}

export interface Directive {
  kind: string;
  table: string;
  columns: string[];
  name: string;
  raw: string;
  line: number;
}

export interface Diagram {
  entities: DEntity[];
  relations: DRelation[];
  directives: Directive[];
  orm: OrmDirective[];
}

/** A syntax error with its source line. */
export class SchemaParseError extends Error {
  public constructor(public readonly line: number, public readonly detail: string) {
    super(`line ${line}: ${detail}`);
  }
}

const ormDirectiveOptions: Record<string, readonly string[]> = {
  table: ['entity', 'name'],
  foreign: ['entity', 'columns', 'references', 'name', 'on_delete', 'deferred'],
  immutable: ['entity'],
  audit_log: ['operation', 'context', 'change'],
  audit: ['entity', 'mode', 'service', 'redact'],
  field: ['relation', 'fk', 'public', 'required', 'order'],
  'public-key': ['entity', 'field', 'type', 'unique', 'stable'],
  'resource-key': ['route', 'param', 'field'],
  route: [],
  path: [],
  scope: ['route', 'param', 'field'],
  filter: ['route', 'param', 'field'],
  operation: ['route', 'method'],
  permission: ['route', 'action', 'owner'],
};

const ws = '[\\t\\n\\f\\r ]';
const reEntityOpen = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)${ws}*\\{${ws}*$`);
const reColumn = new RegExp(`^([A-Za-z_][A-Za-z0-9_()\\[\\]]*)${ws}+([A-Za-z_][A-Za-z0-9_]*)${ws}*((?:PK|FK|UK)(?:${ws}*,${ws}*(?:PK|FK|UK))*)?${ws}*(?:"([^"]*)")?${ws}*$`);
const reRelation = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)${ws}+([|}o]{1,2}[-.]{2}[|{o]{1,2})${ws}+([A-Za-z_][A-Za-z0-9_]*)${ws}*:${ws}*([\\s\\S]*)$`);
const reDirective = new RegExp(`^%%${ws}*(unique|index|fulltext|check|blind_index|timestamps|aes_version|soft_delete|table_comment|column_comment|rename_table|rename_column)${ws}+([A-Za-z_][A-Za-z0-9_]*)${ws}*([\\s\\S]*)$`);
const reRelationNames = new RegExp(`^(?:\\(${ws}*([A-Za-z_][A-Za-z0-9_]*)?${ws}*/${ws}*([A-Za-z_][A-Za-z0-9_]*)?${ws}*\\))?${ws}*([\\s\\S]*)$`);
const reRef = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const reDirectiveIdent = /^[a-z][a-z0-9_-]*$/;
const reOrmName = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)?$/;

const styleWords = new Set(['aes', 'hex', 'gz', 'json', 'jsons', 'base64', 'serialize', 'ip', 'yaml']);

// Unicode white space: the ASCII controls, NEL, and the space separators.
const space = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const edgeSpace = new RegExp(`^[${space}]+|[${space}]+$`, 'g');
const spaceRun = new RegExp(`[${space}]+`);

export function trimSpace(s: string): string {
  return s.replace(edgeSpace, '');
}

/** Splits around runs of white space. */
export function fields(s: string): string[] {
  return s.split(spaceRun).filter(part => part !== '');
}

/** Removes the given characters from both ends. */
export function trimChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** Cuts s around the first sep. */
export function cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', false] : [s.slice(0, i), s.slice(i + sep.length), true];
}

/** Reads one .mmd file. Anything outside the documented subset is an error. */
export function parseDiagram(src: string): Diagram {
  const d: Diagram = { entities: [], relations: [], directives: [], orm: [] };
  let cur: DEntity | undefined;
  let lastOrmRoute = '';
  const seenOrm = new Set<string>();
  let seenHeader = false;
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let line = 0;
  for (const rawLine of lines) {
    line++;
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const t = trimSpace(raw);
    if (t === '') continue;
    if (t.startsWith('%%')) {
      if (t.startsWith('%% orm:')) {
        const x = parseOrmDirective(t, line);
        if (x.kind === 'route') lastOrmRoute = x.name;
        else if (x.kind === 'path') {
          if (lastOrmRoute === '') throw new SchemaParseError(line, '%% orm:path requires a preceding route');
          x.args.route = lastOrmRoute;
        }
        const identity = ormDirectiveIdentity(x);
        if (seenOrm.has(identity)) throw new SchemaParseError(line, 'duplicate ORM directive ' + identity);
        seenOrm.add(identity);
        d.orm.push(x);
        continue;
      }
      const m = reDirective.exec(t);
      if (m) d.directives.push(parseDirective(m, line));
      continue;
    }
    if (!seenHeader) {
      if (t !== 'erDiagram') throw new SchemaParseError(line, 'file must start with erDiagram');
      seenHeader = true;
      continue;
    }
    if (cur) {
      if (t === '}') { cur = undefined; continue; }
      const m = reColumn.exec(t);
      if (!m) throw new SchemaParseError(line, `bad column line in ${cur.name}: ${quoted(t)}`);
      const c: DColumn = {
        type: m[1]!, name: m[2]!, keys: [], comment: m[4] ?? '', dbComment: '', line,
        nullable: false, default: undefined, auto: false, onUpdate: false, unsigned: false, bool: false, int: false, lazy: false,
        styles: [], ref: '', describe: '',
      };
      if ((m[3] ?? '') !== '') for (const k of m[3]!.split(',')) c.keys.push(trimSpace(k));
      try { parseColumnComment(c); } catch (error) { throw new SchemaParseError(line, (error as Error).message); }
      cur.columns.push(c);
      continue;
    }
    let m = reEntityOpen.exec(t);
    if (m) {
      cur = { name: m[1]!, comment: '', columns: [], line };
      d.entities.push(cur);
      continue;
    }
    m = reRelation.exec(t);
    if (m) {
      const r: DRelation = {
        parent: m[1]!, cardinality: m[2]!, child: m[3]!, label: trimChars(trimSpace(m[4]!), '"'), line,
        fks: [], childName: '', parentName: '', onDelete: '',
      };
      try { parseLabel(r); } catch (error) { throw new SchemaParseError(line, (error as Error).message); }
      d.relations.push(r);
      continue;
    }
    throw new SchemaParseError(line, `unrecognized line: ${quoted(t)}`);
  }
  if (cur) throw new SchemaParseError(line, 'unterminated entity ' + cur.name);
  if (!seenHeader) throw new SchemaParseError(0, 'empty file');
  return d;
}

function ormDirectiveIdentity(x: OrmDirective): string {
  const arg = (key: string) => x.args[key] ?? '';
  if (x.kind === 'field' || x.kind === 'route') return `${x.kind}:${x.name}`;
  if (x.kind === 'path') return `${x.kind}:${arg('route')}`;
  if (arg('route') !== '') return `${x.kind}:${arg('route')}:${arg('param')}:${arg('method')}:${arg('action')}`;
  if (x.kind === 'public-key') return `${x.kind}:${arg('entity')}.${arg('field')}`;
  if (x.kind === 'resource-key') return `${x.kind}:${arg('route')}:${arg('param')}`;
  return `${x.kind}:${x.raw}`;
}

const spaceChar = new RegExp(`^[${space}]$`);

/** Splits directive options on white space outside parentheses. */
function optionFields(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0 && spaceChar.test(ch)) {
      if (current !== '') { out.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

function parseOrmDirective(text: string, number: number): OrmDirective {
  const body = trimSpace(text.startsWith('%% orm:') ? text.slice('%% orm:'.length) : text);
  if (body === '') throw new SchemaParseError(number, '%% orm:<kind> requires a directive kind');
  const parts = optionFields(body);
  const kind = parts[0]!;
  if (!reDirectiveIdent.test(kind)) throw new SchemaParseError(number, 'invalid ORM directive kind ' + kind);
  if (!Object.hasOwn(ormDirectiveOptions, kind)) throw new SchemaParseError(number, 'unknown ORM directive ' + kind);
  const allowed = ormDirectiveOptions[kind]!;
  const x: OrmDirective = { kind, name: '', args: {}, raw: body, line: number };
  let positional = parts.slice(1);
  if (positional.length > 0 && !positional[0]!.includes('=')) {
    if (!reOrmName.test(positional[0]!) && kind !== 'path') throw new SchemaParseError(number, 'invalid ORM directive identifier ' + positional[0]);
    x.name = positional[0]!;
    positional = positional.slice(1);
  }
  for (const token of positional) {
    const [key, value, found] = cut(token, '=');
    if (!found || !reDirectiveIdent.test(key) || value === '') throw new SchemaParseError(number, `% orm:${kind} requires key=value options`);
    if (!allowed.includes(key)) throw new SchemaParseError(number, `% orm:${kind}: unknown option ${key}`);
    if (Object.hasOwn(x.args, key)) throw new SchemaParseError(number, `% orm:${kind}: duplicate option ${key}`);
    x.args[key] = value;
  }
  return x;
}

function parseColumnComment(c: DColumn): void {
  const words = fields(c.comment);
  const desc: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '?') c.nullable = true;
    else if (w.startsWith('=')) c.default = w.slice(1);
    else if (w === 'auto') c.auto = true;
    else if (w === 'onupdate') c.onUpdate = true;
    else if (w === 'unsigned') c.unsigned = true;
    else if (w === 'bool') c.bool = true;
    else if (w === 'int') c.int = true;
    else if (w === 'lazy') c.lazy = true;
    else if (w === '->') {
      if (i + 1 >= words.length || !reRef.test(words[i + 1]!)) throw new Error(`column ${c.name}: '->' must be followed by table.column`);
      c.ref = words[i + 1]!;
      i++;
    } else if (w.includes(',')) {
      // a style pipeline written compactly: "aes,hex"
      const parts = w.split(',');
      if (!parts.every(s => styleWords.has(s))) { desc.push(w); continue; }
      c.styles.push(...parts);
    } else if (styleWords.has(w)) c.styles.push(w);
    else desc.push(w);
  }
  c.describe = desc.join(' ');
  if (c.bool && c.int) throw new Error(`column ${c.name}: bool and int are exclusive`);
}

function parseLabel(r: DRelation): void {
  if (r.label === '') throw new Error(`relation ${r.parent} -> ${r.child}: label must name the FK column`);
  let rest = r.label;
  if (rest.startsWith('(')) {
    const close = rest.indexOf(')');
    if (close < 0) throw new Error(`relation ${r.parent} -> ${r.child}: bad label ${quoted(r.label)}`);
    for (let value of rest.slice(1, close).split(',')) {
      value = trimSpace(value);
      if (!reDirectiveIdent.test(value)) throw new Error(`relation ${r.parent} -> ${r.child}: bad FK column ${quoted(value)}`);
      r.fks.push(value);
    }
    rest = trimSpace(rest.slice(close + 1));
  } else {
    const words = fields(rest);
    if (words.length === 0 || !reDirectiveIdent.test(words[0]!)) throw new Error(`relation ${r.parent} -> ${r.child}: bad label ${quoted(r.label)}`);
    r.fks = [words[0]!];
    rest = trimSpace(rest.startsWith(words[0]!) ? rest.slice(words[0]!.length) : rest);
  }
  const m = reRelationNames.exec(rest);
  if (!m) throw new Error(`relation ${r.parent} -> ${r.child}: bad label ${quoted(r.label)}`);
  r.childName = m[1] ?? '';
  r.parentName = m[2] ?? '';
  for (const w of fields(m[3] ?? '')) {
    if (w === 'cascade' || w === 'setnull') r.onDelete = w;
    else throw new Error(`relation ${r.parent} -> ${r.child}: unknown label word ${quoted(w)}`);
  }
}

function parseDirective(m: RegExpExecArray, line: number): Directive {
  const d: Directive = { kind: m[1]!, table: m[2]!, columns: [], name: '', raw: trimSpace(m[3] ?? ''), line };
  switch (d.kind) {
    case 'unique': case 'index': case 'fulltext': {
      const open = d.raw.indexOf('(');
      const close = d.raw.lastIndexOf(')');
      if (open !== 0 || close < 0) throw new SchemaParseError(line, `%% ${d.kind} ${d.table}: expected (col, …)`);
      for (let c of d.raw.slice(1, close).split(',')) {
        c = trimSpace(c);
        if (c === '') throw new SchemaParseError(line, `%% ${d.kind} ${d.table}: empty column`);
        d.columns.push(c);
      }
      d.name = trimSpace(d.raw.slice(close + 1));
      if (d.kind !== 'index' && d.name !== '') throw new SchemaParseError(line, `%% ${d.kind}: only index takes a name`);
      break;
    }
    case 'check': {
      const [name, body, ok] = cut(d.raw, ':');
      if (!ok || !reDirectiveIdent.test(trimSpace(name)) || trimSpace(body) === '') throw new SchemaParseError(line, '%% check <table> <name> : <expression>');
      d.name = trimSpace(name);
      d.raw = trimSpace(body);
      break;
    }
    case 'timestamps':
      d.columns = fields(d.raw);
      if (d.columns.length !== 2) throw new SchemaParseError(line, '%% timestamps <table> <created> <updated>');
      break;
    case 'aes_version':
      d.columns = fields(d.raw);
      if (d.columns.length !== 1 || !reDirectiveIdent.test(d.columns[0]!)) throw new SchemaParseError(line, '%% aes_version <table> <version_column>');
      break;
    case 'soft_delete':
      d.columns = fields(d.raw);
      if (d.columns.length !== 1) throw new SchemaParseError(line, '%% soft_delete <table> <nullable_datetime_column>');
      break;
    case 'blind_index':
      d.columns = fields(d.raw);
      if (d.columns.length !== 2 || !reDirectiveIdent.test(d.columns[0]!) || !reDirectiveIdent.test(d.columns[1]!)) {
        throw new SchemaParseError(line, '%% blind_index <table> <encrypted_column> <index_column>');
      }
      break;
    case 'table_comment':
      if (d.raw === '' || !d.raw.startsWith('"') || !d.raw.endsWith('"')) throw new SchemaParseError(line, '%% table_comment <table> "text"');
      d.raw = trimChars(d.raw, '"');
      break;
    case 'column_comment': {
      const parts = fields(d.raw);
      const text = parts.length >= 1 ? trimSpace(d.raw.slice(parts[0]!.length)) : '';
      if (parts.length < 2 || !text.startsWith('"') || !text.endsWith('"')) throw new SchemaParseError(line, '%% column_comment <table> <column> "text"');
      d.columns = [parts[0]!];
      d.raw = trimChars(text, '"');
      break;
    }
    case 'rename_table': {
      const parts = fields(d.raw);
      if (parts.length !== 1 || !reDirectiveIdent.test(parts[0]!)) throw new SchemaParseError(line, '%% rename_table <new_table> <old_table>');
      d.name = parts[0]!;
      break;
    }
    case 'rename_column': {
      const parts = fields(d.raw);
      if (parts.length !== 2 || !reDirectiveIdent.test(parts[0]!) || !reDirectiveIdent.test(parts[1]!)) {
        throw new SchemaParseError(line, '%% rename_column <table> <new_column> <old_column>');
      }
      d.columns = [parts[0]!];
      d.name = parts[1]!;
      break;
    }
  }
  return d;
}
