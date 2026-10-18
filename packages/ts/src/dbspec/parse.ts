// dbspec parsing and validation (docs/dbspec.md). A document is read line by
// line into an internal form that keeps every token position, then validated
// as a whole; every diagnostic is collected and reported in source order. An
// encoding, header or limit error stops parsing.
import type {
  DbspecAction,
  DbspecCodecStage,
  DbspecDefault,
  DbspecDocument,
  DbspecRule,
  DbspecSetting,
  DbspecTable,
  DbspecType,
  DbspecStateLine,
} from './model.js';
import { typeText } from './emit.js';
import { containsWordRune } from './unicode_word.js';
import { rendererName } from './names.js';
import { present } from '../present.js';
import { meetKind } from '../meet.js';

interface RawDiagnostic {
  readonly rule: DbspecRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TABLES = 4096;
const MAX_COLUMNS = 120000;
const MAX_FOREIGN_KEYS = 20000;
const MAX_TABLE_COLUMNS = 1000;
const MAX_NAME_BYTES = 63;
const MAX_KEY_COLUMNS = 16;
const MAX_KEY_VARCHAR = 640;

const RULE_ORDER: readonly DbspecRule[] = [
  'header', 'syntax', 'order', 'name.format', 'name.length', 'name.duplicate', 'type', 'column',
  'key', 'foreign_key', 'check', 'setting', 'use', 'diagram', 'limit', 'encoding',
];
const NAME = /^[a-z][a-z0-9_]*$/;
const INTEGER = /^-?[0-9]+$/;
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
const UNSIGNED_NUMBER = /^[0-9]+(\.[0-9]+)?$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?$/;
const DATETIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?$/;
/** The kinds of the types that take no parameters. */
type PlainKind = 'i16' | 'i32' | 'i64' | 'bool' | 'f64' | 'text' | 'bytes' | 'uuid' | 'date';
const PLAIN_KINDS: readonly PlainKind[] = ['i16', 'i32', 'i64', 'bool', 'f64', 'text', 'bytes', 'uuid', 'date'];
const INTEGER_RANGES: Record<string, readonly [bigint, bigint]> = {
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
};
const STAGE_LIST: readonly DbspecCodecStage[] = ['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'];
const STAGES = new Set<string>(STAGE_LIST);
const ACTION_LIST: readonly DbspecAction[] = ['restrict', 'cascade', 'set_null'];
const ACTIONS = new Set<string>(ACTION_LIST);
const STORAGES: readonly ('files' | 'document' | 'block')[] = ['files', 'document', 'block'];
const SHAPES: readonly ('list' | 'table')[] = ['list', 'table'];
const PERIODS: readonly ('year' | 'month' | 'day')[] = ['year', 'month', 'day'];

/** The member of `values` that is `value`, or undefined when `value` is none of them. */
function member<T extends string>(values: readonly T[], value: string): T | undefined {
  return values.find(v => v === value);
}

/** The member of `values` that is `value`, which the parser has checked; throws naming `what` when it is none of them. */
function oneOf<T extends string>(values: readonly T[], value: string, what: string): T {
  return present(member(values, value), `${what} ${value}`);
}
const CONSTRAINT_WORDS = new Set(['primary', 'unique', 'index', 'foreign', 'check']);
const EXPRESSION_WORDS = new Set(['and', 'or', 'not', 'in', 'between', 'is', 'null', 'true', 'false']);
/** The words that are keywords in a value position: a default, a check literal, a coordinate and a limit count (R6, R18). */
const VALUE_WORDS = new Set(['true', 'false', 'null', 'now']);
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);
const ORDERINGS = new Set(['<', '<=', '>', '>=']);
const ARITHMETIC = new Set(['+', '-', '*', '/']);

const enum K {
  Word,
  Str,
  Punct,
  Op,
}

interface Tk {
  readonly k: K;
  readonly t: string;
  readonly s: number;
  readonly e: number;
  readonly line: number;
}

interface IColumn {
  readonly name: Tk;
  readonly type: DbspecType | null;
  readonly nullable: boolean;
  readonly identity: Tk | null;
  readonly value: DbspecDefault | null;
  readonly comments: string[];
  /** The default keyword, when the line has one. */
  readonly dflt: Tk | null;
  /** The default value token, when it was read. */
  readonly valueTok: Tk | null;
}

interface IKeyColumn {
  readonly tok: Tk;
  readonly descending: boolean;
}

interface IKey {
  readonly kw: Tk;
  readonly name: Tk | null;
  readonly cols: IKeyColumn[];
  readonly comments: string[];
}

interface IForeignKey {
  readonly name: Tk;
  readonly cols: Tk[];
  readonly table: Tk;
  readonly refs: Tk[];
  readonly onDelete: string;
  readonly onUpdate: string;
  readonly comments: string[];
}

interface ICheck {
  readonly name: Tk;
  readonly expr: Tk[];
  readonly close: Tk;
  readonly comments: string[];
  text: string;
}

type ISetting = { readonly kw: Tk; readonly comments: string[] } & (
  | { readonly kind: 'entity'; readonly name: Tk }
  | { readonly kind: 'updated' | 'soft_delete' | 'aes_version'; readonly column: Tk }
  | { readonly kind: 'select_explicit'; readonly columns: Tk[] }
  | { readonly kind: 'codec'; readonly column: Tk; readonly stages: Tk[] }
  | { readonly kind: 'blind_index'; readonly column: Tk; readonly indexColumn: Tk }
  | { readonly kind: 'navigation'; readonly foreignKey: Tk; readonly childName: Tk; readonly parentName: Tk }
  | { readonly kind: 'immutable' }
  | {
      readonly kind: 'audit';
      readonly into: Tk;
      readonly column: Tk;
      readonly references: Tk;
      readonly action: Tk;
      readonly previous: Tk;
      /** The exclude and include lists. A setting that uses both is rejected by the check. */
      readonly lists: readonly { readonly kw: Tk; readonly columns: readonly Tk[] }[];
    }
  | { readonly kind: 'markdown'; readonly column: Tk }
  | {
      readonly kind: 'store';
      readonly storage: Tk;
      readonly foreignKey: Tk | null;
      readonly shape: Tk | null;
      /** `shard <column> <period>`: the shard keyword token, the column and the period, or null without the clause. */
      readonly shard: { readonly at: Tk; readonly column: Tk; readonly period: Tk } | null;
    }
  | { readonly kind: 'key_prefix'; readonly prefix: Tk }
  | { readonly kind: 'title' | 'body' | 'order'; readonly column: Tk }
  | { readonly kind: 'checkbox'; readonly column: Tk; readonly state: Tk; readonly glyph: Tk }
  | { readonly kind: 'state_machine'; readonly column: Tk; readonly line: IStateLine }
);

/** A state_machine line after its column, with the tokens it names. */
type IStateLine =
  | { readonly form: 'initial'; readonly state: Tk }
  | { readonly form: 'terminal'; readonly state: Tk; readonly requires: Tk[] | null }
  | { readonly form: 'transition'; readonly from: Tk; readonly to: Tk; readonly requires: Tk[] | null }
  | { readonly form: 'history'; readonly table: Tk; readonly row: Tk; readonly from: Tk; readonly to: Tk; readonly at: Tk }
  | { readonly form: 'limit'; readonly state: Tk; readonly count: Tk };

/**
 * The identity of an initial, terminal or transition line and its description: a line of the same identity adds no
 * meaning, and one with another require list contradicts it, so a repeat is a `setting` error (docs/dbspec.md "Settings").
 */
function machineLine(line: Extract<IStateLine, { form: 'initial' | 'terminal' | 'transition' }>): [string, string] {
  if (line.form === 'transition') return [`transition ${line.from.t} ${line.to.t}`, `${line.from.t} -> ${line.to.t}`];
  return [`${line.form} ${line.state.t}`, `${line.form} ${line.state.t}`];
}

type IStateMachine = Extract<ISetting, { kind: 'state_machine' }>;
type ICheckbox = Extract<ISetting, { kind: 'checkbox' }>;

interface ISettings {
  readonly open: Tk;
  readonly entries: ISetting[];
  readonly comments: string[];
  closing: string[];
}

interface ITable {
  readonly kw: Tk;
  readonly name: Tk;
  readonly named: boolean;
  readonly columns: IColumn[];
  readonly colMap: Map<string, IColumn>;
  readonly pks: IKey[];
  readonly uniques: IKey[];
  readonly indexes: IKey[];
  readonly fks: IForeignKey[];
  readonly checks: ICheck[];
  settings: ISettings | null;
  readonly comments: string[];
  closing: string[];
  phase: 0 | 1 | 2;
  identity: boolean;
  /** The { that opens the block, or the table keyword when the line has none. */
  readonly open: Tk;
  /** Names of columns whose own line failed: references to them report nothing more. */
  readonly failed: Set<string>;
  /** A primary key line failed: the table's primary key columns are unknown. */
  failedPrimary: boolean;
  /** A primary key, unique or index line failed: some key's columns are unknown. */
  failedKey: boolean;
  /** Column lines of the table that had a syntax error (Go's failedLines). */
  failedLines: number;
  /** The table line failed (no name, no `{` or words after it): references to the table skip their checks (Go's failed table). */
  readonly headerFailed: boolean;
}

interface IUse {
  readonly doc: Tk;
  readonly tables: Tk[];
  readonly comments: string[];
}

interface IPlacement {
  readonly table: Tk;
  readonly x: number;
  readonly y: number;
  readonly comments: string[];
}

interface IDiagram {
  readonly open: Tk;
  readonly name: Tk;
  readonly named: boolean;
  readonly entries: IPlacement[];
  readonly comments: string[];
  closing: string[];
}

interface IDocument {
  name: string;
  /** The document name token of the header line, set when the header is valid. */
  nameTok: Tk | null;
  readonly uses: IUse[];
  readonly tables: ITable[];
  readonly diagrams: IDiagram[];
  closing: string[];
  /** Names of tables whose own line failed: references to them report nothing more. */
  readonly failed: Set<string>;
  /** The first declaration of every index, unique key, foreign key and check name. */
  readonly constraints: Map<string, Tk>;
}

interface Parsed {
  readonly diagnostics: RawDiagnostic[];
  readonly document: IDocument;
  readonly parser: DocumentParser | null;
}

interface ParseContext {
  readonly documents: Readonly<Record<string, string>>;
  readonly cache: Map<string, Parsed>;
}

/** The reserved words, which are not names (docs/dbspec.md "Names"). */
export const RESERVED: ReadonlySet<string> = new Set([
  'dbspec', 'use', 'table', 'diagram', 'primary', 'unique', 'index', 'foreign', 'check', 'settings',
  'null', 'identity', 'default', 'true', 'false', 'and', 'or', 'not', 'in', 'between', 'is',
]);

/** Whether a name matches the name rule; reserved words are not names. */
/** A name that the renderer writes for a table, with the token that writes it (docs/dbspec.md "Names"). */
interface IGeneratedName {
  readonly name: string;
  readonly at: Tk;
  /** The table and the column or setting that writes the name, for a diagnostic. */
  readonly source: string;
}

/** The renderer names of table: the type CHECK of each column that has one, and the triggers of immutable and audit. */
function generatedNamesOf(table: ITable): IGeneratedName[] {
  if (table.headerFailed || !wellFormed(table.name.t)) return [];
  const out: IGeneratedName[] = [];
  for (const c of table.columns) {
    if (c.identity !== null || c.type === null || c.type.kind === 'text' || c.type.kind === 'bytes') continue;
    if (!wellFormed(c.name.t)) continue;
    out.push({ name: rendererName(table.name.t, c.name.t), at: c.name, source: `table ${table.name.t} column ${c.name.t}` });
  }
  for (const s of table.settings?.entries ?? []) {
    const events = s.kind === 'immutable' ? ['immutable_update', 'immutable_delete'] : s.kind === 'audit' ? ['audit_insert', 'audit_update', 'audit_delete'] : [];
    for (const e of events) out.push({ name: rendererName(table.name.t, e), at: s.kw, source: `table ${table.name.t} setting ${s.kw.t}` });
  }
  return out;
}

function wellFormed(name: string): boolean {
  return NAME.test(name) && !RESERVED.has(name);
}

/** Whether a name is a dbspec name: its form and at most 63 bytes. */
export function validName(name: string): boolean {
  return wellFormed(name) && utf8Length(name) <= MAX_NAME_BYTES;
}

function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A declaration position as the parser reads it (index.ts maps it to DbspecPosition). */
interface RawPosition {
  readonly kind: string;
  readonly path: string[];
  readonly line: number;
  readonly column: number;
}

/** A successful parse with its positions, or a failed one with its diagnostics. */
export type ParsedDocument =
  | { readonly document: DbspecDocument; readonly positions: RawPosition[]; readonly diagnostics: [] }
  | { readonly document: null; readonly positions: null; readonly diagnostics: RawDiagnostic[] };

/** The identity of a setting that its repeat rule makes unique (docs/dbspec.md "Settings"), beside its keyword. */
function settingIdentity(s: ISetting): string[] {
  switch (s.kind) {
    case 'codec':
    case 'markdown':
    case 'blind_index':
      return [s.column.t];
    case 'navigation':
      return [s.foreignKey.t];
    case 'checkbox':
      return [s.column.t, s.state.t];
    case 'state_machine': {
      const line = s.line;
      if (line.form === 'transition') return ['transition', line.from.t, line.to.t];
      if (line.form === 'history') return ['history'];
      return [line.form, line.state.t];
    }
    default:
      return [];
  }
}

/** The 1-based column of a UTF-16 index: one column per Unicode code point. */
function columnOf(text: string, index: number): number {
  let column = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    column++;
  }
  return column + (index - end);
}

function codePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) i++;
    n++;
  }
  return n;
}



/** One line split as Go's lexLine splits it: the tokens before the first error, and that error. */
interface Lexed {
  readonly toks: Tk[];
  /** The UTF-16 index of the character that starts no token, or of an unterminated string's quote. */
  readonly error: { readonly index: number; readonly message: string } | null;
}

/** Go's isWordRune: `_` or `.`, or a code point of the table of unicode_word.ts (a letter or digit of Go's unicode). */
function isWordRune(cp: number): boolean {
  return cp === 95 || cp === 46 || containsWordRune(cp);
}

/** The character as Go's %q writes a rune. */
function goRune(cp: number): string {
  const escapes: Record<number, string> = { 9: '\\t', 10: '\\n', 13: '\\r', 39: "\\'", 92: '\\\\' };
  return `'${escapes[cp] ?? String.fromCodePoint(cp)}'`;
}

/** Splits one line into tokens (engine/dbspec/lex.go's lexLine); only the space separates tokens. */
function lexLine(text: string, line: number): Lexed {
  const toks: Tk[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32) {
      i++;
    } else if (c === 40 || c === 41 || c === 123 || c === 125 || c === 44) {
      toks.push({ k: K.Punct, t: present(text[i], 'text[i]'), s: i, e: i + 1, line });
      i++;
    } else if (c === 60 || c === 62) {
      const d = text.charCodeAt(i + 1);
      const two = (c === 60 && (d === 62 || d === 61)) || (c === 62 && d === 61);
      const e = two ? i + 2 : i + 1;
      toks.push({ k: K.Op, t: text.slice(i, e), s: i, e, line });
      i = e;
    } else if (c === 61 || c === 43 || c === 45 || c === 42 || c === 47) {
      toks.push({ k: K.Op, t: present(text[i], 'text[i]'), s: i, e: i + 1, line });
      i++;
    } else if (c === 39) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text.charCodeAt(j) === 39) {
          if (text.charCodeAt(j + 1) === 39) {
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return { toks, error: { index: i, message: 'string is not closed on its line' } };
      toks.push({ k: K.Str, t: text.slice(i, j), s: i, e: j, line });
      i = j;
    } else {
      const cp = present(text.codePointAt(i), 'text.codePointAt(i)');
      if (!isWordRune(cp)) return { toks, error: { index: i, message: `character ${goRune(cp)} is not allowed here` } };
      let j = i + (cp > 0xffff ? 2 : 1);
      while (j < n) {
        const d = present(text.codePointAt(j), 'text.codePointAt(j)');
        if (!isWordRune(d)) break;
        j += d > 0xffff ? 2 : 1;
      }
      toks.push({ k: K.Word, t: text.slice(i, j), s: i, e: j, line });
      i = j;
    }
  }
  return { toks, error: null };
}

/** The class of a token that the reader does not classify: a number, a string, an operator, a punctuation mark or a word. */
export type DbspecTokenClass = 'keyword' | 'type' | 'name' | 'setting' | 'number' | 'string' | 'operator' | 'punctuation' | 'comment' | 'word';

/**
 * Go's lexRecover: the tokens of a line whose character that starts no token is read as a space. The text returned is the
 * line the tokens refer to: each offending code point is one space, so its code points are those of the line.
 */
function recoverLine(text: string, line: number): { toks: Tk[]; text: string } {
  const chars = Array.from(text);
  for (let attempt = 0; attempt <= chars.length; attempt++) {
    const joined = chars.join('');
    const lexed = lexLine(joined, line);
    if (lexed.error === null) return { toks: lexed.toks, text: joined };
    chars[Array.from(joined.slice(0, lexed.error.index)).length] = ' ';
  }
  return { toks: [], text: chars.join('') };
}

function lexRecover(text: string, line: number): Tk[] {
  return recoverLine(text, line).toks;
}

/** Whether a foreign key action changes child rows (Go's propagates). */
function propagates(action: string): boolean {
  return action === 'cascade' || action === 'set_null';
}

function isWord(tok: Tk | undefined, text: string): boolean {
  return tok !== undefined && tok.k === K.Word && tok.t === text;
}

function isPunct(tok: Tk | undefined, text: string): boolean {
  return tok !== undefined && tok.k === K.Punct && tok.t === text;
}

function isOp(tok: Tk | undefined, text: string): boolean {
  return tok !== undefined && tok.k === K.Op && tok.t === text;
}

function stringValue(tok: Tk): string {
  return tok.t.slice(1, -1).replaceAll("''", "'");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sameType(a: DbspecType, b: DbspecType): boolean {
  return typeText(a) === typeText(b);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function validDate(y: string, m: string, d: string): boolean {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = present([31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1], `the days of month ${month}`);
  return day <= days;
}

function validTime(h: string, m: string, s: string): boolean {
  return Number(h) < 24 && Number(m) < 60 && Number(s) < 60;
}

function fraction(digits: string | undefined, precision: number): string | null {
  const given = digits ?? '';
  if (given.length > precision) return null;
  return precision === 0 ? '' : '.' + given.padEnd(precision, '0');
}

/** A number literal without a sign for zero or leading zeros of its integer part. */
function numberText(text: string): string {
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const whole = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+(?=[0-9])/, '');
  const part = dot < 0 ? '' : body.slice(dot);
  const zero = /^0+$/.test(whole) && /^\.?0*$/.test(part);
  return (negative && !zero ? '-' : '') + whole + part;
}

/** The shortest decimal without exponent that reads back as the same double; 0 for negative zero. */
function shortestDecimal(value: number): string {
  if (value === 0) return '0';
  const text = String(value);
  const e = text.indexOf('e');
  if (e < 0) return text;
  const negative = text.startsWith('-');
  const mantissa = text.slice(negative ? 1 : 0, e);
  const exponent = Number(text.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const point = (dot < 0 ? mantissa.length : dot) + exponent;
  let plain: string;
  if (point <= 0) plain = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) plain = digits + '0'.repeat(point - digits.length);
  else plain = digits.slice(0, point) + '.' + digits.slice(point);
  return (negative ? '-' : '') + plain;
}

/**
 * The canonical default of a column type, or the reason the literal does not fit.
 * A check literal takes the same form; a text column takes the varchar form without a length.
 */
function defaultOf(type: DbspecType, tok: Tk): DbspecDefault | string {
  const word = tok.k === K.Word ? tok.t : null;
  const text = tok.k === K.Str ? stringValue(tok) : null;
  const literal = (value: string): DbspecDefault => ({ kind: 'literal', text: value });
  switch (type.kind) {
    case 'i16':
    case 'i32':
    case 'i64': {
      if (word === null || !INTEGER.test(word)) return `default of ${type.kind} must be an integer`;
      const value = BigInt(word);
      const [min, max] = present(INTEGER_RANGES[type.kind], 'INTEGER_RANGES[type.kind]');
      if (value < min || value > max) return `default ${word} is out of the ${type.kind} range`;
      return literal(value.toString());
    }
    case 'bool':
      if (word === 'true' || word === 'false') return literal(word);
      return 'default of bool must be true or false';
    case 'decimal': {
      if (word === null || !NUMBER.test(word)) return `default of ${typeText(type)} must be a decimal number`;
      const negative = word.startsWith('-');
      const body = negative ? word.slice(1) : word;
      const dot = body.indexOf('.');
      const whole = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+/, '');
      const digits = dot < 0 ? '' : body.slice(dot + 1);
      if (digits.length > type.scale) return `default ${word} has more than ${type.scale} fraction digits`;
      if (whole.length > type.precision - type.scale) return `default ${word} does not fit ${typeText(type)}`;
      const scaled = digits.padEnd(type.scale, '0');
      const zero = /^0*$/.test(whole) && /^0*$/.test(scaled);
      return literal((negative && !zero ? '-' : '') + (whole || '0') + (type.scale > 0 ? '.' + scaled : ''));
    }
    case 'f64': {
      if (word === null || !NUMBER.test(word)) return 'default of f64 must be a decimal number';
      const value = Number(word);
      if (!Number.isFinite(value)) return `default ${word} is not a finite double`;
      return literal(shortestDecimal(value));
    }
    case 'varchar':
    case 'text':
      if (text === null) return `default of ${typeText(type)} must be a string`;
      if (text.includes('\0')) return 'default contains U+0000';
      if (type.kind === 'varchar' && codePoints(text) > type.length) return `default is longer than ${type.length} characters`;
      return literal(quote(text));
    case 'uuid':
      if (text === null || !UUID.test(text)) return 'default of uuid must be a canonical uuid string';
      return literal(quote(text.toLowerCase()));
    case 'date': {
      const m = text === null ? null : DATE.exec(text);
      if (m === null || !validDate(present(m[1], 'm[1]'), present(m[2], 'm[2]'), present(m[3], 'm[3]'))) return "default of date must be 'YYYY-MM-DD'";
      return literal(quote(present(text, 'text')));
    }
    case 'time': {
      const m = text === null ? null : TIME.exec(text);
      if (m === null || !validTime(present(m[1], 'm[1]'), present(m[2], 'm[2]'), present(m[3], 'm[3]'))) return `default of ${typeText(type)} must be 'HH:MM:SS'`;
      const f = fraction(m[4], type.precision);
      if (f === null) return `default has more than ${type.precision} fraction digits`;
      return literal(quote(`${m[1]}:${m[2]}:${m[3]}${f}`));
    }
    case 'datetime': {
      if (word === 'now') return { kind: 'now' };
      const m = text === null ? null : DATETIME.exec(text);
      if (m === null || !validDate(present(m[1], 'm[1]'), present(m[2], 'm[2]'), present(m[3], 'm[3]')) || !validTime(present(m[4], 'm[4]'), present(m[5], 'm[5]'), present(m[6], 'm[6]'))) {
        return `default of ${typeText(type)} must be now or 'YYYY-MM-DD HH:MM:SS'`;
      }
      const f = fraction(m[7], type.precision);
      if (f === null) return `default has more than ${type.precision} fraction digits`;
      return literal(quote(`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${f}`));
    }
    case 'bytes':
      return 'a bytes column has no default';
  }
}

/** The kind of value a column holds in a check, by the table that the IR validator also reads: two columns meet when their kinds are equal. */
function meetKindOf(type: DbspecType): string {
  return meetKind(type.kind, type.kind === 'decimal' ? type.scale : 0, type.kind === 'decimal' || type.kind === 'time' || type.kind === 'datetime' ? type.precision : 0);
}

/** A check operand: a column (column set) or a literal at its slot of the canonical text. */
interface Operand {
  readonly column: IColumn | null;
  readonly tok: Tk;
  readonly type: DbspecType | null;
  readonly slot: number;
}

/** The check predicate that was read. A simple predicate holds a canonical token, and the tree has no parentheses. */
type Predicate =
  | { readonly kind: 'leaf'; readonly parts: readonly string[] }
  | { readonly kind: 'logical'; readonly op: 'and' | 'or'; readonly left: Predicate; readonly right: Predicate };

/** The canonical text of a predicate. Only the parentheses that an or inside an and needs are written. */
function predicateText(p: Predicate): string {
  if (p.kind === 'logical') {
    const side = (q: Predicate): string => (p.op === 'and' && q.kind === 'logical' && q.op === 'or' ? `(${predicateText(q)})` : predicateText(q));
    return `${side(p.left)} ${p.op} ${side(p.right)}`;
  }
  let text = '';
  for (let n = 0; n < p.parts.length; n++) {
    const part = present(p.parts[n], 'p.parts[n]');
    if (n > 0 && part !== ')' && part !== ',' && p.parts[n - 1] !== '(') text += ' ';
    text += part;
  }
  return text;
}

class ExpressionSyntax {
  constructor(readonly at: Tk | null) {}
}

class DocumentParser {
  readonly diagnostics: RawDiagnostic[] = [];
  readonly document: IDocument = { name: '', nameTok: null, uses: [], tables: [], diagrams: [], closing: [], failed: new Set(), constraints: new Map() };
  private stopped = false;
  /** The settings block that reads a line: the first block of the table, or a repeated block that is not kept. */
  private settingsBlock: ISettings | null = null;
  /** A repeated settings block: its lines are parsed for syntax only and not checked (Go's detached block). */
  private detachedBlock = false;
  /** The line of the last syntax error: a line reports at most one, since the rest of it cannot be read reliably. */
  private syntaxLine = 0;
  private columnCount = 0;
  private foreignKeyCount = 0;
  /** The lines on which the reader reported a syntax diagnostic: their words are `word` (R1). An unclosed block is not one. */
  readonly abandoned = new Set<number>();
  /** The class the reader gave a word, by `line:start` (docs/dbspec.md "Syntax analysis"). */
  readonly classes = new Map<string, DbspecTokenClass>();
  /** The lines of a block whose opening line failed: read for diagnostics, with lexical classes (R20). */
  readonly lexical = new Set<number>();

  constructor(
    private readonly lines: string[],
    private readonly context: ParseContext,
    private readonly parents: readonly string[],
    /** The encoding error of the text, which stops the parse after the lines it was given (Go's splitSource). */
    private readonly encoding: RawDiagnostic | null,
  ) {}

  /** The names of this document and the documents that use it, for detecting a use cycle. */
  private get chain(): readonly string[] {
    return this.parents.length === 0 ? [this.document.name] : this.parents;
  }

  /** Gives a word the class of the position the reader consumed it at; the words of a lexical line keep their lexical class (R20). */
  private mark(tok: Tk | undefined, cls: DbspecTokenClass): void {
    if (tok === undefined || tok.k !== K.Word || this.lexical.has(tok.line)) return;
    this.classes.set(`${tok.line}:${tok.s}`, cls);
  }

  /** A value word that is a keyword (VALUE_WORDS); any other word keeps its lexical class. */
  private markValue(tok: Tk | undefined): void {
    if (tok !== undefined && VALUE_WORDS.has(tok.t)) this.mark(tok, 'keyword');
  }

  private report(rule: DbspecRule, line: number, index: number, message: string): void {
    if (rule === 'syntax') {
      this.abandoned.add(line);
      if (this.syntaxLine === line) return;
      this.syntaxLine = line;
    }
    this.diagnostics.push({ rule, line, column: columnOf(this.lines[line - 1] ?? '', index), message });
  }

  private at(rule: DbspecRule, tok: Tk, message: string): void {
    this.report(rule, tok.line, tok.s, message);
  }

  /** A line with a syntax error keeps only the syntax error after the mark (Go checks names and types only on lines with correct syntax). */
  private keepSyntaxSince(mark: number): void {
    const later = this.diagnostics.slice(mark).filter(d => d.rule === 'syntax');
    this.diagnostics.length = mark;
    this.diagnostics.push(...later);
  }

  /** An error for a block that is not closed at the end of the document. It is reported together with the other syntax errors on the same line (Go does not limit it to one per line). */
  private unclosed(tok: Tk, message: string): void {
    this.diagnostics.push({ rule: 'syntax', line: tok.line, column: columnOf(this.lines[tok.line - 1] ?? '', tok.s), message });
  }

  /** A syntax error at a token, or after the last token of the line. */
  private syntax(toks: Tk[], i: number, line: number, message: string): void {
    const tok = toks[i];
    if (tok !== undefined) this.at('syntax', tok, message);
    else this.report('syntax', line, (this.lines[line - 1] ?? '').length, message);
  }

  private stop(rule: DbspecRule, tok: Tk, message: string): void {
    this.at(rule, tok, message);
    this.stopped = true;
  }

  /** Checks a name's form and length; returns whether it can be resolved. */
  private name(tok: Tk): boolean {
    const formed = wellFormed(tok.t);
    if (!formed) {
      this.at('name.format', tok, RESERVED.has(tok.t) ? `${tok.t} is a reserved word` : `${tok.t} does not match [a-z][a-z0-9_]*`);
    }
    if (utf8Length(tok.t) > MAX_NAME_BYTES) this.at('name.length', tok, `${tok.t} is longer than 63 bytes`);
    return formed;
  }

  /**
   * Refuses a generated name of a table of the document that equals a generated
   * name of a used table or of an earlier table of the document, with
   * name.duplicate at the later name (docs/dbspec.md "Names").
   */
  private generatedNamesUnique(doc: IDocument, available: Map<string, ITable | null>): void {
    const seen = new Map<string, string>(); // generated name => the source that wrote it first
    const local = new Set<ITable>(doc.tables);
    for (const t of available.values()) {
      if (t !== null && !local.has(t)) for (const g of generatedNamesOf(t)) seen.set(g.name, `used table ${t.name.t}`);
    }
    for (const t of doc.tables) {
      if (!t.named || available.get(t.name.t) !== t) continue;
      for (const g of generatedNamesOf(t)) {
        const first = seen.get(g.name);
        if (first !== undefined) this.at('name.duplicate', g.at, `generated name ${g.name} of ${g.source} repeats the generated name of ${first}`);
        else seen.set(g.name, g.source);
      }
    }
  }

  private constraintName(tok: Tk): void {
    if (!this.name(tok)) return;
    if (this.document.constraints.has(tok.t)) this.at('name.duplicate', tok, `${tok.t} repeats an index, key, foreign key or check name`);
    else this.document.constraints.set(tok.t, tok);
  }

  parse(): void {
    if (!this.header()) return;
    const lines = this.lines;
    let state: 'top' | 'table' | 'settings' | 'diagram' = 'top';
    let phase = 0;
    let table: ITable | null = null;
    let diagram: IDiagram | null = null;
    let comments: string[] = [];
    // A block whose opening line failed keeps lexical classes in its lines until it closes (R20).
    let tableLexical = false;
    let settingsLexical = false;
    let diagramLexical = false;
    for (let n = 1; n < lines.length && !this.stopped; n++) {
      const text = present(lines[n], 'lines[n]');
      const line = n + 1;
      if ((state === 'table' && tableLexical) || (state === 'settings' && (tableLexical || settingsLexical)) || (state === 'diagram' && diagramLexical)) {
        this.lexical.add(line);
      }
      let i = 0;
      while (i < text.length && text.charCodeAt(i) === 32) i++;
      if (i === text.length) continue;
      if (text.charCodeAt(i) === 35) {
        comments.push(text.slice(i));
        continue;
      }
      const own = comments;
      comments = [];
      const lexed = lexLine(text, line);
      let toks = lexed.toks;
      if (lexed.error !== null) {
        this.report('syntax', line, lexed.error.index, lexed.error.message);
        // Reads as a token with the erroneous characters removed (Go's lexRecover): a table header on the top line also opens a table.
        toks = lexRecover(text, line);
      }
      const first = toks[0];
      if (first === undefined) continue;
      if (state === 'top') {
        if (isWord(first, 'use')) {
          this.mark(first, 'keyword');
          if (phase > 1) this.at('order', first, 'use lines come before tables and diagrams');
          else phase = 1;
          this.use(toks, line, own);
        } else if (isWord(first, 'table')) {
          this.mark(first, 'keyword');
          if (phase > 2) this.at('order', first, 'tables come before diagrams');
          else phase = 2;
          table = this.tableHeader(toks, line, own);
          tableLexical = this.abandoned.has(line);
          state = 'table';
        } else if (isWord(first, 'diagram')) {
          this.mark(first, 'keyword');
          phase = 3;
          diagram = this.diagramHeader(toks, line, own);
          diagramLexical = this.abandoned.has(line);
          state = 'diagram';
        } else {
          this.at('syntax', first, 'expected use, table or diagram');
        }
      } else if (state === 'table') {
        const t = present(table, 'table');
        if (isPunct(first, '}')) {
          if (toks.length > 1) this.syntax(toks, 1, line, 'expected the end of the line');
          t.closing = own;
          table = null;
          tableLexical = false;
          state = 'top';
        } else if (lexed.error !== null) {
          state = this.lexedTableLine(t, toks, line, own);
          if (state === 'settings') settingsLexical = this.abandoned.has(line);
        } else if (isWord(first, 'settings')) {
          this.mark(first, 'keyword');
          // Go reports the order for a keyword of a repeated block only when the line is in the correct form (only `settings {`).
          if (t.settings !== null && isPunct(toks[1], '{') && toks.length === 2) this.at('order', first, 'a table has at most one settings block');
          this.openSettingsBlock(t, { open: isPunct(toks[1], '{') ? present(toks[1], 'toks[1]') : first, entries: [], comments: own, closing: [] });
          t.phase = 2;
          if (!isPunct(toks[1], '{')) this.syntax(toks, 1, line, 'expected {');
          else if (toks.length > 2) this.syntax(toks, 2, line, 'expected the end of the line');
          settingsLexical = this.abandoned.has(line);
          state = 'settings';
        } else if (first.k === K.Word && CONSTRAINT_WORDS.has(first.t)) {
          if (t.phase === 2) this.at('order', first, 'key, index, foreign key and check lines come before settings');
          else t.phase = 1;
          this.constraint(t, toks, line, own);
        } else {
          const mark = this.diagnostics.length;
          this.column(t, toks, line, own);
          // Go does not check the name and type of a column line that has a syntax error: only the syntax error is kept for this line.
          // Go's markFailed and failedLines: the name of a column line with a syntax error is the failed name.
          if (this.syntaxLine === line) {
            this.keepSyntaxSince(mark);
            this.failColumnLine(t, first);
          }
          // Go reports the order only when a column line matches the syntax (after c.done in columnLine). It is not a line stopped by the limit either.
          else if (t.phase > 0 && !this.stopped) this.at('order', first, 'columns come before keys, indexes, foreign keys, checks and settings');
        }
      } else if (state === 'settings') {
        if (isPunct(first, '}')) {
          if (toks.length > 1) this.syntax(toks, 1, line, 'expected the end of the line');
          present(this.settingsBlock, 'this.settingsBlock').closing = own;
          settingsLexical = false;
          state = 'table';
        } else {
          this.setting(toks, line, own, lexed.error !== null);
        }
      } else {
        const d = present(diagram, 'diagram');
        if (isPunct(first, '}')) {
          if (toks.length > 1) this.syntax(toks, 1, line, 'expected the end of the line');
          d.closing = own;
          diagram = null;
          diagramLexical = false;
          state = 'top';
        } else if (lexed.error === null) {
          this.placement(d, toks, line, own);
        }
      }
    }
    if (this.stopped) return;
    // Go reports no unclosed block after an encoding error: the encoding error is the stop, after every syntax error above it.
    if (this.encoding !== null) {
      this.diagnostics.push(this.encoding);
      this.stopped = true;
      return;
    }
    // Only the innermost open block is reported (as in Go): an open settings block does not report the table's `{`.
    if (state === 'settings') this.unclosed(present(this.settingsBlock, 'this.settingsBlock').open, 'the settings block is not closed');
    else if (state === 'table') this.unclosed(present(table, 'table').open, 'the table block is not closed');
    if (state === 'diagram') this.unclosed(present(diagram, 'diagram').open, 'the diagram block is not closed');
    this.document.closing = comments;
  }

  /**
   * The header error points at the first character that departs from
   * `dbspec 1 <name>`, or one past the line end when a part is missing.
   */
  private header(): boolean {
    const text = present(this.lines[0], 'this.lines[0]');
    const fail = (offset: number): boolean => {
      this.report('header', 1, offset, 'the first line is exactly dbspec 1 <document>');
      this.stopped = true;
      return false;
    };
    const prefix = 'dbspec 1 ';
    for (let i = 0; i < prefix.length; i++) if (text[i] !== prefix[i]) return fail(i);
    let end = prefix.length;
    while (end < text.length && /[A-Za-z0-9_]/.test(present(text[end], 'text[end]'))) end++;
    if (end === prefix.length || end < text.length) return fail(end);
    const toks = lexLine(text, 1).toks;
    const name = present(toks[2], 'toks[2]');
    this.name(name);
    this.mark(toks[0], 'keyword');
    this.mark(name, 'name');
    this.document.name = name.t;
    this.document.nameTok = name;
    return true;
  }

  /** Reads `<word> (, <word>)*` up to a closing token; returns the words and the next index. */
  private list(toks: Tk[], i: number, line: number, close: string): [Tk[], number] | null {
    const words: Tk[] = [];
    for (;;) {
      const w = toks[i];
      if (w === undefined || w.k !== K.Word) {
        this.syntax(toks, i, line, 'expected a name');
        return null;
      }
      words.push(w);
      i++;
      if (isPunct(toks[i], ',')) {
        i++;
        continue;
      }
      if (isPunct(toks[i], close)) return [words, i + 1];
      this.syntax(toks, i, line, `expected , or ${close}`);
      return null;
    }
  }

  private end(toks: Tk[], i: number, line: number): boolean {
    if (i >= toks.length) return true;
    this.syntax(toks, i, line, 'expected the end of the line');
    return false;
  }

  private use(toks: Tk[], line: number, comments: string[]): void {
    for (const t of toks.slice(2)) if (t.k === K.Word) this.document.failed.add(t.t);
    const doc = toks[1];
    if (doc === undefined || doc.k !== K.Word) return this.syntax(toks, 1, line, 'expected a document name');
    if (!isPunct(toks[2], '{')) return this.syntax(toks, 2, line, 'expected {');
    const listed = this.list(toks, 3, line, '}');
    if (listed === null) return;
    if (!this.end(toks, listed[1], line)) return;
    this.name(doc);
    for (const t of listed[0]) this.name(t);
    for (const t of listed[0]) this.document.failed.delete(t.t);
    this.mark(doc, 'name');
    for (const t of listed[0]) this.mark(t, 'name');
    this.document.uses.push({ doc, tables: listed[0], comments });
  }

  private tableHeader(toks: Tk[], line: number, comments: string[]): ITable {
    const kw = present(toks[0], 'toks[0]');
    const name = toks[1];
    const named = name !== undefined && name.k === K.Word;
    const table: ITable = {
      kw,
      name: named ? name : kw,
      named,
      columns: [],
      colMap: new Map(),
      pks: [],
      uniques: [],
      indexes: [],
      fks: [],
      checks: [],
      settings: null,
      comments,
      closing: [],
      phase: 0,
      identity: false,
      open: named && isPunct(toks[2], '{') ? present(toks[2], 'toks[2]') : kw,
      failed: new Set(),
      failedPrimary: false,
      failedKey: false,
      failedLines: 0,
      headerFailed: !named || !isPunct(toks[2], '{') || toks.length > 3,
    };
    if (this.document.tables.length >= MAX_TABLES) {
      this.stop('limit', kw, `a document has at most ${MAX_TABLES} tables`);
      return table;
    }
    this.document.tables.push(table);
    if (!named) this.syntax(toks, 1, line, 'expected a table name');
    else {
      this.mark(name, 'name');
      this.name(name);
      if (!isPunct(toks[2], '{')) this.syntax(toks, 2, line, 'expected {');
      else this.end(toks, 3, line);
    }
    return table;
  }

  private diagramHeader(toks: Tk[], line: number, comments: string[]): IDiagram {
    const name = toks[1];
    const named = name !== undefined && name.k === K.Word;
    const open = named && isPunct(toks[2], '{') ? present(toks[2], 'toks[2]') : present(toks[0], 'toks[0]');
    const diagram: IDiagram = { open, name: named ? name : present(toks[0], 'toks[0]'), named, entries: [], comments, closing: [] };
    this.document.diagrams.push(diagram);
    if (!named) this.syntax(toks, 1, line, 'expected a diagram name');
    else {
      this.mark(name, 'name');
      if (this.name(name) && this.document.diagrams.some(d => d !== diagram && d.named && d.name.t === name.t)) {
        this.at('name.duplicate', name, `diagram ${name.t} repeats`);
      }
      if (!isPunct(toks[2], '{')) this.syntax(toks, 2, line, 'expected {');
      else this.end(toks, 3, line);
    }
    return diagram;
  }

  private type(tok: Tk, params: Tk[] | null): DbspecType | null {
    const kind = tok.t;
    const plain = member(PLAIN_KINDS, kind);
    if (plain !== undefined) {
      if (params !== null) {
        this.at('type', tok, `${kind} takes no parameters`);
        return null;
      }
      return { kind: plain };
    }
    const values = (params ?? []).map(p => (/^[0-9]{1,9}$/.test(p.t) ? Number(p.t) : NaN));
    const count = values.length;
    switch (kind) {
      case 'decimal': {
        const [p, s] = values;
        if (count !== 2 || !(present(p, 'p') >= 1 && present(p, 'p') <= 18) || !(present(s, 's') >= 0 && present(s, 's') <= present(p, 'p'))) {
          this.at('type', tok, 'decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p');
          return null;
        }
        return { kind, precision: present(p, 'p'), scale: present(s, 's') };
      }
      case 'varchar': {
        const [n] = values;
        if (count !== 1 || !(present(n, 'n') >= 1 && present(n, 'n') <= 16383)) {
          this.at('type', tok, 'varchar(n) needs 1 <= n <= 16383');
          return null;
        }
        return { kind, length: present(n, 'n') };
      }
      case 'time':
      case 'datetime': {
        const [p] = values;
        if (count !== 1 || !(present(p, 'p') >= 0 && present(p, 'p') <= 6)) {
          this.at('type', tok, `${kind}(p) needs 0 <= p <= 6`);
          return null;
        }
        return { kind, precision: present(p, 'p') };
      }
      default:
        this.at('type', tok, `${kind} is not a dbspec type`);
        return null;
    }
  }

  private column(table: ITable, toks: Tk[], line: number, comments: string[]): void {
    const name = present(toks[0], 'toks[0]');
    if (name.k !== K.Word) return this.syntax(toks, 0, line, 'expected a column name');
    const typeTok = toks[1];
    if (typeTok === undefined || typeTok.k !== K.Word) {
      table.failed.add(name.t);
      return this.syntax(toks, 1, line, 'expected a type');
    }
    this.mark(name, 'name');
    this.mark(typeTok, 'type');
    let i = 2;
    let params: Tk[] | null = null;
    if (isPunct(toks[i], '(')) {
      const listed = this.list(toks, i + 1, line, ')');
      if (listed === null) {
        table.failed.add(name.t);
        return;
      }
      [params, i] = listed;
    }
    this.columnCount++;
    if (table.columns.length >= MAX_TABLE_COLUMNS) return this.stop('limit', name, `a table has at most ${MAX_TABLE_COLUMNS} columns`);
    if (this.columnCount > MAX_COLUMNS) return this.stop('limit', name, `a document has at most ${MAX_COLUMNS} columns`);
    const resolvable = this.name(name);
    const type = this.type(typeTok, params);
    let nullTok: Tk | null = null;
    let identity: Tk | null = null;
    let defaultTok: Tk | null = null;
    let valueTok: Tk | null = null;
    let complete = true;
    if (isWord(toks[i], 'null')) {
      nullTok = present(toks[i], 'toks[i]');
      this.mark(nullTok, 'keyword');
      i++;
    }
    if (isWord(toks[i], 'identity')) {
      identity = present(toks[i], 'toks[i]');
      this.mark(identity, 'keyword');
      i++;
    }
    if (isWord(toks[i], 'default')) {
      defaultTok = present(toks[i], 'toks[i]');
      this.mark(defaultTok, 'keyword');
      i++;
      const v = toks[i];
      const next = toks[i + 1];
      if (v !== undefined && v.k === K.Op && v.t === '-' && next !== undefined && next.k === K.Word && next.s === v.e) {
        valueTok = { k: K.Word, t: '-' + next.t, s: v.s, e: next.e, line };
        i += 2;
      } else if (v !== undefined && (v.k === K.Word || v.k === K.Str)) {
        valueTok = v;
        this.markValue(v);
        i++;
      } else {
        this.syntax(toks, i, line, 'expected a default value');
        complete = false;
      }
    }
    if (complete) this.end(toks, i, line);
    let value: DbspecDefault | null = null;
    if (identity !== null) {
      if (type !== null && type.kind !== 'i64') this.at('column', identity, 'an identity column has the type i64');
      if (nullTok !== null) this.at('column', identity, 'an identity column cannot be null');
      if (table.identity) this.at('column', identity, 'a table has at most one identity column');
      table.identity = true;
      if (defaultTok !== null) this.at('column', defaultTok, 'an identity column has no default');
    } else if (defaultTok !== null && type !== null) {
      if (type.kind === 'text' || type.kind === 'bytes') this.at('column', defaultTok, `a ${type.kind} column has no default`);
      else if (valueTok !== null) {
        const fitted = defaultOf(type, valueTok);
        if (typeof fitted === 'string') this.at('column', valueTok, fitted);
        else value = fitted;
      }
    }
    const column: IColumn = { name, type, nullable: nullTok !== null, identity, value, comments, dflt: defaultTok, valueTok };
    table.columns.push(column);
    if (!resolvable) return;
    if (table.colMap.has(name.t)) this.at('name.duplicate', name, `column ${name.t} repeats`);
    else table.colMap.set(name.t, column);
  }

  private keyColumns(toks: Tk[], i: number, line: number, directions: boolean): [IKeyColumn[], number] | null {
    if (!isPunct(toks[i], '(')) {
      this.syntax(toks, i, line, 'expected (');
      return null;
    }
    i++;
    const cols: IKeyColumn[] = [];
    if (isPunct(toks[i], ')')) return [cols, i + 1];
    for (;;) {
      const w = toks[i];
      if (w === undefined || w.k !== K.Word) {
        this.syntax(toks, i, line, 'expected a column name');
        return null;
      }
      i++;
      let descending = false;
      if (directions && (isWord(toks[i], 'asc') || isWord(toks[i], 'desc'))) {
        this.mark(toks[i], 'keyword');
        descending = present(toks[i++], 'toks[i++]').t === 'desc';
      }
      this.mark(w, 'name');
      cols.push({ tok: w, descending });
      if (isPunct(toks[i], ',')) {
        i++;
        continue;
      }
      if (isPunct(toks[i], ')')) return [cols, i + 1];
      this.syntax(toks, i, line, 'expected , or )');
      return null;
    }
  }

  /**
   * A table line with a lex error (Go's cursor failure): `settings` opens the block, a key or foreign key line fails
   * its key or name, and a column line fails its name. Returns the next state.
   */
  private lexedTableLine(table: ITable, toks: Tk[], line: number, comments: string[]): 'table' | 'settings' {
    const first = present(toks[0], 'toks[0]');
    if (isWord(first, 'settings')) {
      this.openSettingsBlock(table, { open: isPunct(toks[1], '{') ? present(toks[1], 'toks[1]') : first, entries: [], comments, closing: [] });
      table.phase = 2;
      return 'settings';
    }
    if (first.k === K.Word && CONSTRAINT_WORDS.has(first.t)) {
      if (first.t === 'primary') table.failedPrimary = true;
      else if (first.t === 'unique' || first.t === 'index') table.failedKey = true;
      else if (first.t === 'foreign' && toks[2]?.k === K.Word) table.failed.add(toks[2].t);
      return 'table';
    }
    this.failColumnLine(table, first);
    return 'table';
  }

  /** Knows a column line that had a syntax error: its name is failed and the table has one more failed line. */
  private failColumnLine(table: ITable, first: Tk): void {
    table.failedLines++;
    if (first.k === K.Word) table.failed.add(first.t);
  }

  private constraint(table: ITable, toks: Tk[], line: number, comments: string[]): void {
    const kw = present(toks[0], 'toks[0]');
    this.mark(kw, 'keyword');
    switch (kw.t) {
      case 'primary': {
        const failed = (): void => {
          table.failedPrimary = true;
        };
        if (!isWord(toks[1], 'key')) {
          failed();
          return this.syntax(toks, 1, line, 'expected key');
        }
        this.mark(toks[1], 'keyword');
        const cols = this.keyColumns(toks, 2, line, false);
        if (cols === null || !this.end(toks, cols[1], line)) return failed();
        for (const c of cols[0]) this.name(c.tok);
        table.pks.push({ kw, name: null, cols: cols[0], comments });
        return;
      }
      case 'unique':
      case 'index': {
        const name = toks[1];
        if (name === undefined || name.k !== K.Word) {
          table.failedKey = true;
          return this.syntax(toks, 1, line, 'expected a name');
        }
        const cols = this.keyColumns(toks, 2, line, kw.t === 'index');
        if (cols === null || !this.end(toks, cols[1], line)) {
          table.failedKey = true;
          return;
        }
        this.mark(name, 'name');
        this.constraintName(name);
        for (const c of cols[0]) this.name(c.tok);
        (kw.t === 'index' ? table.indexes : table.uniques).push({ kw, name, cols: cols[0], comments });
        return;
      }
      case 'foreign': {
        // If a line fails, its name is marked as failed (Go markFailed), so that references to the setting raise no additional diagnostics.
        const failedName = toks[2];
        const before = table.fks.length;
        this.foreignKeyLine(table, toks, line, comments);
        if (table.fks.length === before && failedName !== undefined && failedName.k === K.Word) table.failed.add(failedName.t);
        return;
      }
      case 'check': {
        const name = toks[1];
        if (name === undefined || name.k !== K.Word) return this.syntax(toks, 1, line, 'expected a name');
        if (!isPunct(toks[2], '(')) return this.syntax(toks, 2, line, 'expected (');
        const close = present(toks[toks.length - 1], 'toks[toks.length - 1]');
        // Go: the rest after `(` must end with `)`; an empty expression `()` is an expression error at the `)`.
        if (toks.length < 4 || !isPunct(close, ')')) return this.syntax(toks, toks.length, line, "expected ')' at the end of the check");
        this.mark(name, 'name');
        this.constraintName(name);
        table.checks.push({ name, expr: toks.slice(3, -1), close, comments, text: '' });
        return;
      }
    }
  }

  private foreignKeyLine(table: ITable, toks: Tk[], line: number, comments: string[]): void {
    const kw = present(toks[0], 'toks[0]');
    if (!isWord(toks[1], 'key')) return this.syntax(toks, 1, line, 'expected key');
    this.mark(toks[1], 'keyword');
    const name = toks[2];
    if (name === undefined || name.k !== K.Word) return this.syntax(toks, 2, line, 'expected a name');
    this.mark(name, 'name');
    const cols = this.keyColumns(toks, 3, line, false);
    if (cols === null) return;
    let i = cols[1];
    if (!isWord(toks[i], 'references')) return this.syntax(toks, i, line, 'expected references');
    this.mark(toks[i], 'keyword');
    const target = toks[i + 1];
    if (target === undefined || target.k !== K.Word) return this.syntax(toks, i + 1, line, 'expected a table name');
    this.mark(target, 'name');
    const refs = this.keyColumns(toks, i + 2, line, false);
    if (refs === null) return;
    i = refs[1];
    const actions: Record<'delete' | 'update', string> = { delete: 'restrict', update: 'restrict' };
    const actionToks: Tk[] = [];
    for (const event of ['delete', 'update'] as const) {
      if (!isWord(toks[i], 'on') || !isWord(toks[i + 1], event)) continue;
      this.mark(toks[i], 'keyword');
      this.mark(toks[i + 1], 'keyword');
      const action = toks[i + 2];
      if (action === undefined || action.k !== K.Word) return this.syntax(toks, i + 2, line, 'expected an action');
      actions[event] = action.t;
      actionToks.push(action);
      // R3: an action that is not restrict, cascade or set_null is a word, with a semantic diagnostic.
      if (ACTIONS.has(action.t)) this.mark(action, 'keyword');
      i += 3;
    }
    if (!this.end(toks, i, line)) return;
    for (const action of actionToks) {
      if (!ACTIONS.has(action.t)) this.at('foreign_key', action, `action "${action.t}" is not restrict, cascade or set_null`);
    }
    if (this.foreignKeyCount >= MAX_FOREIGN_KEYS) return this.stop('limit', kw, `a document has at most ${MAX_FOREIGN_KEYS} foreign keys`);
    this.foreignKeyCount++;
    this.constraintName(name);
    for (const c of cols[0]) this.name(c.tok);
    this.name(target);
    for (const c of refs[0]) this.name(c.tok);
    table.fks.push({
      name,
      cols: cols[0].map(c => c.tok),
      table: target,
      refs: refs[0].map(c => c.tok),
      onDelete: actions.delete,
      onUpdate: actions.update,
      comments,
    });
    return;
  }


  /** Decides the settings block that the following lines will read: the first block is kept, and a repeated block is split off. */
  private openSettingsBlock(table: ITable, block: ISettings): void {
    this.detachedBlock = table.settings !== null;
    if (!this.detachedBlock) table.settings = block;
    this.settingsBlock = this.detachedBlock ? block : table.settings;
  }

  private setting(toks: Tk[], line: number, comments: string[], lexed = false): void {
    // The lex error of the line was already reported. Go's cursor does not check this line after that.
    if (lexed) return;
    const kw = present(toks[0], 'toks[0]');
    if (kw.k !== K.Word) return this.syntax(toks, 0, line, 'expected a setting');
    // R4: the first word of a settings line is a setting, known or not.
    this.mark(kw, 'setting');
    const words = (from: number, count: number | null): Tk[] | null => {
      const out: Tk[] = [];
      for (let i = from; i < toks.length; i++) {
        if (present(toks[i], 'toks[i]').k !== K.Word) {
          this.syntax(toks, i, line, 'expected a name');
          return null;
        }
        out.push(present(toks[i], 'toks[i]'));
      }
      if (count === null ? out.length === 0 : out.length < count) {
        this.syntax(toks, toks.length, line, 'expected a name');
        return null;
      }
      if (count !== null && out.length > count) {
        this.syntax(toks, from + count, line, 'expected the end of the line');
        return null;
      }
      return out;
    };
    let entry: ISetting | null = null;
    switch (kw.t) {
      case 'entity': {
        const w = words(1, 1);
        if (w === null) return;
        this.name(present(w[0], 'w[0]'));
        this.mark(w[0], 'name');
        entry = { kw, comments, kind: 'entity', name: present(w[0], 'w[0]') };
        break;
      }
      case 'updated':
      case 'soft_delete':
      case 'aes_version': {
        const w = words(1, 1);
        if (w === null) return;
        this.name(present(w[0], 'w[0]'));
        this.mark(w[0], 'name');
        entry = { kw, comments, kind: kw.t, column: present(w[0], 'w[0]') };
        break;
      }
      case 'select': {
        if (!isWord(toks[1], 'explicit')) return this.syntax(toks, 1, line, 'expected explicit');
        this.mark(toks[1], 'keyword');
        const w = words(2, null);
        if (w === null) return;
        for (const c of w) {
          this.mark(c, 'name');
          this.name(c);
        }
        entry = { kw, comments, kind: 'select_explicit', columns: w };
        break;
      }
      case 'codec': {
        const w = words(1, null);
        if (w === null) return;
        if (w.length < 2) return this.syntax(toks, toks.length, line, 'expected a codec stage');
        this.mark(w[0], 'name');
        this.name(present(w[0], 'w[0]'));
        const stages = w.slice(1);
        // R3: a codec stage of the known set is a keyword; another word is a word, with a semantic diagnostic.
        for (const s of stages) if (STAGES.has(s.t)) this.mark(s, 'keyword');
        if (!this.detachedBlock) for (const s of stages) if (!STAGES.has(s.t)) this.at('setting', s, `${s.t} is not a codec stage`);
        entry = { kw, comments, kind: 'codec', column: present(w[0], 'w[0]'), stages };
        break;
      }
      case 'blind_index': {
        const w = words(1, 2);
        if (w === null) return;
        for (const c of w) {
          this.mark(c, 'name');
          this.name(c);
        }
        entry = { kw, comments, kind: 'blind_index', column: present(w[0], 'w[0]'), indexColumn: present(w[1], 'w[1]') };
        break;
      }
      case 'navigation': {
        const w = words(1, 3);
        if (w === null) return;
        for (const c of w) {
          this.mark(c, 'name');
          this.name(c);
        }
        entry = { kw, comments, kind: 'navigation', foreignKey: present(w[0], 'w[0]'), childName: present(w[1], 'w[1]'), parentName: present(w[2], 'w[2]') };
        break;
      }
      case 'immutable':
        if (!this.end(toks, 1, line)) return;
        entry = { kw, comments, kind: 'immutable' };
        break;
      case 'markdown': {
        const w = words(1, 1);
        if (w === null) return;
        this.mark(w[0], 'name');
        entry = { kw, comments, kind: 'markdown', column: present(w[0], 'w[0]') };
        break;
      }
      case 'store': {
        const parsed = this.storeLine(toks, line, kw, comments);
        if (parsed === null) return;
        entry = parsed;
        break;
      }
      case 'key_prefix': {
        const prefix = toks[1];
        if (prefix === undefined || prefix.k !== K.Str) return this.syntax(toks, 1, line, 'expected a key prefix in quotes');
        if (toks.length > 2) return this.syntax(toks, 2, line, 'expected the end of the line');
        entry = { kw, comments, kind: 'key_prefix', prefix };
        break;
      }
      case 'title':
      case 'order':
      case 'body': {
        const w = words(1, 1);
        if (w === null) return;
        this.mark(w[0], 'name');
        entry = { kw, comments, kind: kw.t === 'title' ? 'title' : kw.t === 'body' ? 'body' : 'order', column: present(w[0], 'w[0]') };
        break;
      }
      case 'checkbox': {
        const column = this.settingWord(toks, 1, line, 'the state column');
        if (column === null) return;
        const state = this.settingWord(toks, 2, line, 'a state name');
        if (state === null) return;
        const glyph = toks[3];
        if (glyph === undefined || glyph.k !== K.Str) return this.syntax(toks, 3, line, 'expected a glyph in quotes');
        if (toks.length > 4) return this.syntax(toks, 4, line, 'expected the end of the line');
        entry = { kw, comments, kind: 'checkbox', column, state, glyph };
        break;
      }
      case 'state_machine': {
        const parsed = this.stateMachineLine(toks, line, kw, comments);
        if (parsed === null) return;
        entry = parsed;
        break;
      }
      case 'audit': {
        const parts: Tk[] = [];
        let i = 1;
        for (const label of ['into', 'column', 'references', 'action', 'previous']) {
          if (!isWord(toks[i], label)) return this.syntax(toks, i, line, `expected ${label}`);
          this.mark(toks[i], 'keyword');
          const w = toks[i + 1];
          if (w === undefined || w.k !== K.Word) return this.syntax(toks, i + 1, line, 'expected a name');
          this.mark(w, 'name');
          this.name(w);
          parts.push(w);
          i += 2;
        }
        const lists: { kw: Tk; columns: Tk[] }[] = [];
        while (isWord(toks[i], 'exclude') || isWord(toks[i], 'include')) {
          if (!isPunct(toks[i + 1], '(')) return this.syntax(toks, i + 1, line, 'expected (');
          const listed = this.list(toks, i + 2, line, ')');
          if (listed === null) return;
          this.mark(toks[i], 'keyword');
          for (const c of listed[0]) this.mark(c, 'name');
          lists.push({ kw: present(toks[i], 'toks[i]'), columns: listed[0] });
          i = listed[1];
        }
        if (i < toks.length) return this.syntax(toks, i, line, 'expected exclude, include or the end of the line');
        entry = { kw, comments, kind: 'audit', into: present(parts[0], 'parts[0]'), column: present(parts[1], 'parts[1]'), references: present(parts[2], 'parts[2]'), action: present(parts[3], 'parts[3]'), previous: present(parts[4], 'parts[4]'), lists };
        break;
      }
      default:
        return this.at('setting', kw, `${kw.t} is not a setting`);
    }
    present(this.settingsBlock, 'this.settingsBlock').entries.push(entry);
  }

  /** Reads a name-like word at i, or reports a syntax error there (or after the line) and returns null. */
  private settingWord(toks: Tk[], i: number, line: number, what: string): Tk | null {
    const t = toks[i];
    if (t !== undefined && t.k === K.Word) {
      this.mark(t, 'name');
      return t;
    }
    this.syntax(toks, i, line, `expected ${what}`);
    return null;
  }

  /** Reads `store files`, `store document list|table` or `store block <foreign key> list|table`. */
  private storeLine(toks: Tk[], line: number, kw: Tk, comments: string[]): ISetting | null {
    const storage = toks[1];
    if (storage === undefined || storage.k !== K.Word || !['files', 'document', 'block'].includes(storage.t)) {
      this.syntax(toks, 1, line, "expected 'files', 'document' or 'block'");
      return null;
    }
    this.mark(storage, 'keyword');
    let i = 2;
    let foreignKey: Tk | null = null;
    if (storage.t === 'block') {
      foreignKey = this.settingWord(toks, i, line, 'a foreign key name');
      if (foreignKey === null) return null;
      i++;
    }
    let shape: Tk | null = null;
    if (storage.t !== 'files') {
      const word = toks[i];
      if (word === undefined || word.k !== K.Word || (word.t !== 'list' && word.t !== 'table')) {
        this.syntax(toks, i, line, "expected 'list' or 'table'");
        return null;
      }
      this.mark(word, 'keyword');
      shape = word;
      i++;
    }
    // The shard clause is also read in a block: a shard in a block table is a setting error.
    let shard: { at: Tk; column: Tk; period: Tk } | null = null;
    const at = toks[i];
    if (at !== undefined && at.k === K.Word && at.t === 'shard') {
      this.mark(at, 'keyword');
      const column = this.settingWord(toks, i + 1, line, 'the shard column');
      if (column === null) return null;
      const period = toks[i + 2];
      if (period === undefined || period.k !== K.Word || !['year', 'month', 'day'].includes(period.t)) {
        this.syntax(toks, i + 2, line, "expected 'year', 'month' or 'day'");
        return null;
      }
      this.mark(period, 'keyword');
      shard = { at, column, period };
      i += 3;
    }
    if (i < toks.length) {
      this.syntax(toks, i, line, 'expected the end of the line');
      return null;
    }
    return { kw, comments, kind: 'store', storage, foreignKey, shape, shard };
  }

  /**
   * Reads one state_machine line, with the forms of the Go reference: a state
   * word followed by `->` is a transition, and `initial`, `terminal`, `history`
   * and `limit` are forms only when no `->` follows them.
   */
  private stateMachineLine(toks: Tk[], line: number, kw: Tk, comments: string[]): ISetting | null {
    let i = 1;
    const take = (what: string): Tk | null => {
      const t = this.settingWord(toks, i, line, what);
      if (t !== null) i++;
      return t;
    };
    const keyword = (text: string): boolean => {
      if (isWord(toks[i], text)) {
        this.mark(toks[i], 'keyword');
        i++;
        return true;
      }
      this.syntax(toks, i, line, `'${text}'`);
      return false;
    };
    const formAhead = (text: string): boolean => isWord(toks[i], text) && !isOp(toks[i + 1], '-');
    const requireList = (): Tk[] | null | undefined => {
      if (!isWord(toks[i], 'require')) return null;
      this.mark(toks[i], 'keyword');
      i++;
      if (!isPunct(toks[i], '(')) {
        this.syntax(toks, i, line, "expected '('");
        return undefined;
      }
      const listed = this.list(toks, i + 1, line, ')');
      if (listed === null) return undefined;
      i = listed[1];
      for (const w of listed[0]) this.mark(w, 'name');
      return listed[0];
    };
    const column = take('the state column');
    if (column === null) return null;
    const done = (form: IStateLine): ISetting | null => {
      if (i < toks.length) {
        this.syntax(toks, i, line, 'the end of the line');
        return null;
      }
      return { kw, comments, kind: 'state_machine', column, line: form };
    };
    if (formAhead('initial') || formAhead('terminal')) {
      const terminal = present(toks[i], 'toks[i]').t === 'terminal';
      this.mark(toks[i], 'keyword');
      i++;
      const state = take('a state name');
      if (state === null) return null;
      if (!terminal) return done({ form: 'initial', state });
      const requires = requireList();
      if (requires === undefined) return null;
      return done({ form: 'terminal', state, requires });
    }
    if (formAhead('history')) {
      this.mark(toks[i], 'keyword');
      i++;
      const table = take('the history table');
      if (table === null || !keyword('row')) return null;
      const row = take('the foreign key column');
      if (row === null || !keyword('from')) return null;
      const from = take('the from column');
      if (from === null || !keyword('to')) return null;
      const to = take('the to column');
      if (to === null || !keyword('at')) return null;
      const at = take('the at column');
      if (at === null) return null;
      return done({ form: 'history', table, row, from, to, at });
    }
    if (formAhead('limit')) {
      this.mark(toks[i], 'keyword');
      i++;
      const state = take('a state name');
      if (state === null) return null;
      const t = toks[i];
      let count: Tk;
      if (isOp(t, '-')) {
        const n = toks[i + 1];
        if (n === undefined || n.k !== K.Word || !UNSIGNED_NUMBER.test(n.t)) {
          this.syntax(toks, i + 1, line, "expected a number after '-'");
          return null;
        }
        count = { k: K.Word, t: '-' + n.t, s: present(t, 't').s, e: n.e, line };
        i += 2;
      } else if (t !== undefined && t.k === K.Word) {
        this.markValue(t);
        count = t;
        i++;
      } else {
        this.syntax(toks, i, line, 'expected a row count');
        return null;
      }
      return done({ form: 'limit', state, count });
    }
    const from = take('the from state');
    if (from === null) return null;
    if (!isOp(toks[i], '-') || !isOp(toks[i + 1], '>')) {
      this.syntax(toks, i, line, "expected '->'");
      return null;
    }
    i += 2;
    const to = take('the to state');
    if (to === null) return null;
    const requires = requireList();
    if (requires === undefined) return null;
    return done({ form: 'transition', from, to, requires });
  }

  private placement(diagram: IDiagram, toks: Tk[], line: number, comments: string[]): void {
    const table = present(toks[0], 'toks[0]');
    if (table.k !== K.Word) return this.syntax(toks, 0, line, 'expected a table name');
    if (!isWord(toks[1], 'at')) return this.syntax(toks, 1, line, 'expected at');
    this.mark(toks[1], 'keyword');
    let i = 2;
    const coordinates: { tok: Tk; text: string }[] = [];
    for (let n = 0; n < 2; n++) {
      const v = toks[i];
      const next = toks[i + 1];
      if (v !== undefined && v.k === K.Op && v.t === '-' && next !== undefined && next.k === K.Word && next.s === v.e) {
        coordinates.push({ tok: v, text: '-' + next.t });
        i += 2;
      } else if (v !== undefined && v.k === K.Word) {
        this.markValue(v);
        coordinates.push({ tok: v, text: v.t });
        i++;
      } else return this.syntax(toks, i, line, 'expected a coordinate');
    }
    if (!this.end(toks, i, line)) return;
    this.mark(table, 'name');
    this.name(table);
    const values: number[] = [];
    for (const c of coordinates) {
      const value = INTEGER.test(c.text) && c.text.length <= 12 ? Number(c.text) : NaN;
      if (!(value >= -2147483648 && value <= 2147483647)) {
        this.at('diagram', c.tok, `coordinate ${c.text} is not an integer from -2147483648 to 2147483647`);
      }
      values.push(value + 0);
    }
    diagram.entries.push({ table, x: present(values[0], 'values[0]'), y: present(values[1], 'values[1]'), comments });
  }

  // Validation of the whole document.

  validate(): void {
    const doc = this.document;
    const available = new Map<string, ITable | null>();
    const usedAt = new Map<string, Tk>();
    const usedDocuments = new Set<string>();
    const usedConstraints = new Set<string>();
    const usedTables = new Set<string>();
    for (const use of doc.uses) {
      if (!wellFormed(use.doc.t)) continue;
      if (usedDocuments.has(use.doc.t)) {
        this.at('name.duplicate', use.doc, `document ${use.doc.t} is used twice`);
        continue;
      }
      usedDocuments.add(use.doc.t);
      if (use.doc.t === doc.name) {
        this.at('use', use.doc, `document ${doc.name} uses itself`);
        continue;
      }
      const target = this.resolve(use.doc);
      if (target !== null) {
        const names = new Set<string>();
        for (const name of target.constraints.keys()) {
          if (usedConstraints.has(name) || usedTables.has(name)) names.add(name);
        }
        for (const t of target.tables) if (t.named && usedConstraints.has(t.name.t)) names.add(t.name.t);
        for (const name of names) this.at('name.duplicate', use.doc, `${name} is declared by two used documents`);
        for (const name of target.constraints.keys()) usedConstraints.add(name);
        for (const t of target.tables) if (t.named) usedTables.add(t.name.t);
      }
      const tables = target === null ? null : new Map(target.tables.filter(t => t.named).map(t => [t.name.t, t]));
      for (const t of use.tables) {
        if (!wellFormed(t.t)) continue;
        if (available.has(t.t)) {
          this.at('name.duplicate', t, `table ${t.t} is used twice`);
          continue;
        }
        const found = tables?.get(t.t);
        if (tables !== null && found === undefined) this.at('use', t, `document ${use.doc.t} does not define table ${t.t}`);
        available.set(t.t, found ?? null);
        usedAt.set(t.t, t);
      }
    }
    const later = (a: Tk, b: Tk): Tk => (a.line > b.line || (a.line === b.line && a.s > b.s) ? a : b);
    const localTables = new Map<string, Tk>();
    for (const t of doc.tables) {
      if (!t.named || !wellFormed(t.name.t)) continue;
      if (!available.has(t.name.t)) {
        available.set(t.name.t, t);
        localTables.set(t.name.t, t.name);
        if (usedConstraints.has(t.name.t) && !t.headerFailed) this.at('name.duplicate', t.name, `table ${t.name.t} repeats a constraint name of a used document`);
        continue;
      }
      // Go does not report duplicate table names for a table whose header failed (the failed table in validate.go).
      if (t.headerFailed) continue;
      const used = usedAt.get(t.name.t);
      this.at('name.duplicate', used === undefined ? t.name : later(used, t.name), `table ${t.name.t} repeats`);
    }
    for (const name of doc.failed) if (!available.has(name)) available.set(name, null);
    for (const [name, tok] of doc.constraints) {
      const table = localTables.get(name);
      if (table !== undefined) this.at('name.duplicate', tok, `${name} names both a table and a constraint`);
      else if (usedConstraints.has(name) || usedTables.has(name)) this.at('name.duplicate', tok, `${name} repeats a name of a used document`);
    }
    for (const t of doc.tables) this.validateTable(t, available);
    this.generatedNamesUnique(doc, available);
    for (const d of doc.diagrams) {
      const placed = new Set<string>();
      for (const p of d.entries) {
        if (!wellFormed(p.table.t)) continue;
        if (!available.has(p.table.t)) this.at('diagram', p.table, `table ${p.table.t} is not defined or used`);
        else if (placed.has(p.table.t)) this.at('diagram', p.table, `table ${p.table.t} repeats in the diagram`);
        placed.add(p.table.t);
      }
    }
  }

  private resolve(tok: Tk): IDocument | null {
    const name = tok.t;
    if (!Object.hasOwn(this.context.documents, name)) {
      this.at('use', tok, `document ${name} is not in the declared document set`);
      return null;
    }
    if (this.chain.includes(name)) {
      this.at('use', tok, `document ${name} uses itself through use lines`);
      return null;
    }
    let parsed = this.context.cache.get(name);
    if (parsed === undefined) {
      parsed = parseText(present(this.context.documents[name], 'this.context.documents[name]'), this.context, [...this.chain, name]);
      this.context.cache.set(name, parsed);
    }
    const first = parsed.diagnostics[0];
    if (first !== undefined) {
      this.at('use', tok, `document ${name} is invalid: ${first.rule} at line ${first.line} column ${first.column}: ${first.message}`);
      return null;
    }
    if (parsed.document.name !== name) {
      this.at('use', tok, `the declared document ${name} has the header name ${parsed.document.name}`);
      return null;
    }
    return parsed.document;
  }

  /** A column of the table, undefined for a malformed name (already reported), or null after reporting it unknown. */
  private lookup(table: ITable, tok: Tk, rule: DbspecRule, what = 'column'): IColumn | null | undefined {
    if (!wellFormed(tok.t)) return undefined;
    const column = table.colMap.get(tok.t);
    if (column === undefined) {
      if (table.failed.has(tok.t)) return undefined;
      this.at(rule, tok, `${what} ${tok.t} is not a column of table ${table.name.t}`);
      return null;
    }
    return column;
  }

  private keyLike(table: ITable, key: IKey, primary: boolean): void {
    const at = key.name ?? key.kw;
    if (key.cols.length === 0) this.at('key', at, 'a key or index lists at least one column');
    if (key.cols.length > MAX_KEY_COLUMNS) this.at('key', at, `a key or index lists at most ${MAX_KEY_COLUMNS} columns`);
    const seen = new Set<string>();
    let varchar = 0;
    for (const c of key.cols) {
      const column = this.lookup(table, c.tok, 'key');
      if (column === undefined || column === null) continue;
      if (seen.has(c.tok.t)) {
        this.at('key', c.tok, `column ${c.tok.t} repeats`);
        continue;
      }
      seen.add(c.tok.t);
      if (column.type !== null && (column.type.kind === 'text' || column.type.kind === 'bytes')) {
        this.at('key', c.tok, `a ${column.type.kind} column cannot be part of a key or index`);
      }
      if (primary && column.nullable) this.at('key', c.tok, `primary key column ${c.tok.t} is null`);
      if (column.type !== null && column.type.kind === 'varchar') varchar += column.type.length;
    }
    if (varchar > MAX_KEY_VARCHAR) this.at('key', at, `the varchar columns total ${varchar} characters, more than ${MAX_KEY_VARCHAR}`);
  }

  private validateTable(table: ITable, available: Map<string, ITable | null>): void {
    if (table.columns.length === 0 && table.failedLines === 0) this.at('column', table.name, 'a table has at least one column');
    if (table.pks.length === 0 && !table.failedPrimary) this.at('key', table.name, `table ${table.name.t} has no primary key`);
    for (const extra of table.pks.slice(1)) this.at('key', extra.kw, 'a table has exactly one primary key');
    for (const pk of table.pks) this.keyLike(table, pk, true);
    for (const u of table.uniques) this.keyLike(table, u, false);
    for (const i of table.indexes) this.keyLike(table, i, false);
    const pk = table.pks[0];
    const identity = table.columns.find(c => c.identity !== null);
    if (identity !== undefined) {
      if (pk === undefined) {
        if (!table.failedPrimary) this.at('column', present(identity.identity, 'identity.identity'), 'an identity column is the only primary key column');
      } else if (pk.cols.every(c => wellFormed(c.tok.t) && !table.failed.has(c.tok.t))) {
        const only = pk.cols.length === 1 && present(pk.cols[0], 'pk.cols[0]').tok.t === identity.name.t;
        if (!only) this.at('column', present(identity.identity, 'identity.identity'), 'an identity column is the only primary key column');
      }
    }
    const banned = new Set<string>();
    let actionChild = false;
    for (const fk of table.fks) {
      this.foreignKey(table, fk, available);
      if (propagates(fk.onDelete) || propagates(fk.onUpdate)) {
        actionChild = true;
        for (const c of fk.cols) banned.add(c.t);
      }
    }
    for (const check of table.checks) this.check(table, check, banned);
    if (table.settings !== null) this.settings(table, table.settings, available, actionChild);
  }

  private foreignKey(table: ITable, fk: IForeignKey, available: Map<string, ITable | null>): void {
    let resolved = true;
    // An unknown child keeps its place with null, to match the column order as Go's children does.
    const children: (IColumn | null)[] = [];
    const seen = new Set<string>();
    if (fk.cols.length === 0) {
      this.at('foreign_key', fk.name, 'a foreign key lists at least one column');
      resolved = false;
    }
    for (const c of fk.cols) {
      const column = this.lookup(table, c, 'foreign_key');
      if (column === undefined || column === null) {
        resolved = false;
        children.push(null);
        continue;
      }
      if (seen.has(c.t)) {
        this.at('foreign_key', c, `column ${c.t} repeats`);
        resolved = false;
      }
      seen.add(c.t);
      children.push(column);
    }
    // Go also checks the child's key and set_null even when the referenced table is missing, its name is wrong, or its header failed.
    // Only the column, pair and type checks are skipped (foreignKey in validate.go, when target is nil).
    if (!wellFormed(fk.table.t)) {
      this.foreignKeyKeyChecks(table, fk, children, resolved);
      return;
    }
    if (!available.has(fk.table.t)) {
      this.at('foreign_key', fk.table, `table ${fk.table.t} is not defined or used`);
      this.foreignKeyKeyChecks(table, fk, children, resolved);
      return;
    }
    const target = available.get(fk.table.t) ?? null;
    if (target === null) {
      this.foreignKeyKeyChecks(table, fk, children, resolved);
      return;
    }
    // Go does not check the columns, pairs and types of a target whose header failed. The child's key check is still done.
    if (target.headerFailed) {
      this.foreignKeyKeyChecks(table, fk, children, resolved);
      return;
    }
    // As in Go's foreignKey: the count check is done whether or not the child columns are known, and the pair and type checks are done when the referenced columns are all
    // known. The type check looks only at known children and stops at the first mismatch.
    const parents: (IColumn | null)[] = [];
    let referencesKnown = true;
    for (const r of fk.refs) {
      const column = this.lookup(target, r, 'foreign_key');
      if (column === undefined || column === null) {
        referencesKnown = false;
        parents.push(null);
        continue;
      }
      parents.push(column);
    }
    if (fk.cols.length !== fk.refs.length) {
      this.at('foreign_key', fk.name, 'the foreign key lists a different number of child and referenced columns');
    } else if (referencesKnown) {
      const refs = fk.refs.map(r => r.t).join(',');
      const keys = [...target.pks.slice(0, 1), ...target.uniques].map(k => k.cols.map(c => c.tok.t).join(','));
      if (!keys.includes(refs) && !target.failedKey && !target.failedPrimary) {
        this.at('foreign_key', fk.name, `the referenced columns are not the primary key or a unique key of table ${target.name.t}`);
      }
      for (let i = 0; i < children.length; i++) {
        const child = children[i]?.type ?? null;
        const parent = parents[i]?.type ?? null;
        if (child !== null && parent !== null && !sameType(child, parent)) {
          this.at('foreign_key', fk.name, `column ${present(fk.cols[i], 'fk.cols[i]').t} is ${typeText(child)} but references ${typeText(parent)}`);
          break;
        }
      }
    }
    this.foreignKeyKeyChecks(table, fk, children, resolved);
  }

  /**
   * The key and set_null check of the child columns. It does not look at the target's columns, so it is also used for a target whose header failed.
   * If known is false, the child columns are unknown or overlapping, so the index check is skipped (Go's known).
   */
  private foreignKeyKeyChecks(table: ITable, fk: IForeignKey, children: (IColumn | null)[], known: boolean): void {
    const lead = fk.cols.map(c => c.t);
    const indexed = [...table.pks, ...table.uniques, ...table.indexes].some(
      k => k.cols.length >= lead.length && lead.every((name, i) => present(k.cols[i], 'k.cols[i]').tok.t === name),
    );
    if (known && !indexed && !table.failedKey && !table.failedPrimary) this.at('foreign_key', fk.name, 'no index or key of the table leads with the foreign key columns');
    if ((fk.onDelete === 'set_null' || fk.onUpdate === 'set_null') && children.some(c => c !== null && !c.nullable)) {
      this.at('foreign_key', fk.name, 'set_null requires every child column to be null');
    }
  }

  private check(table: ITable, check: ICheck, banned: Set<string>): void {
    const toks = check.expr;
    // The regular token of the simple predicate being read now. Parentheses, and and or stay in the tree; only the parentheses needed for output are written.
    let out: string[] = [];
    // The predicate is read first. A reading diagnostic reports only the first one, and in that case the type is not checked.
    let flagged = false;
    const flag = (rule: DbspecRule, tok: Tk, message: string): void => {
      if (flagged) return;
      flagged = true;
      this.at(rule, tok, message);
    };
    // The column and type diagnostics of a fully read predicate: report only the first, in source order.
    // R14: the tokens read before the first reading diagnostic keep their classes; the rest keep lexical classes.
    const mark = (tok: Tk | undefined, cls: DbspecTokenClass): void => {
      if (!flagged) this.mark(tok, cls);
    };
    const issues: { readonly tok: Tk; readonly message: string; readonly rule: DbspecRule }[] = [];
    const issue = (tok: Tk, message: string, rule: DbspecRule = 'check'): void => {
      issues.push({ tok, message, rule });
    };
    let i = 0;
    const peek = (): Tk | undefined => toks[i];
    const take = (): Tk => {
      const tok = toks[i];
      if (tok === undefined) throw new ExpressionSyntax(null);
      i++;
      return tok;
    };
    const expectPunct = (text: string): void => {
      const tok = take();
      if (!isPunct(tok, text)) throw new ExpressionSyntax(tok);
      out.push(text);
    };
    const expectWord = (text: string): void => {
      const tok = take();
      if (!isWord(tok, text)) throw new ExpressionSyntax(tok);
      mark(tok, 'keyword');
      out.push(text);
    };
    const isNumber = (tok: Tk | undefined): boolean => tok !== undefined && tok.k === K.Word && UNSIGNED_NUMBER.test(tok.t);
    const literalOperand = (tok: Tk, text: string): Operand => {
      out.push(text);
      return { column: null, tok, type: null, slot: out.length - 1 };
    };
    const negative = (): Operand | null => {
      const t = peek();
      if (t === undefined || t.k !== K.Op || t.t !== '-' || !isNumber(toks[i + 1])) return null;
      i++;
      const number = take();
      const tok: Tk = { k: K.Word, t: '-' + number.t, s: t.s, e: number.e, line: t.line };
      return literalOperand(tok, numberText(tok.t));
    };
    // The literals in the in list. null is an unknown operand after a diagnostic.
    const literal = (): Operand | null => {
      const signed = negative();
      if (signed !== null) return signed;
      const t = take();
      if (t.k === K.Str) return literalOperand(t, t.t);
      if (isNumber(t)) return literalOperand(t, numberText(t.t));
      if (isWord(t, 'true') || isWord(t, 'false')) {
        mark(t, 'keyword');
        return literalOperand(t, t.t);
      }
      if (isWord(t, 'null')) flag('check', t, 'the null literal is not part of a predicate');
      else if (t.k === K.Word && !EXPRESSION_WORDS.has(t.t)) flag('check', t, `${t.t} is not a literal`);
      else throw new ExpressionSyntax(t);
      out.push(t.t);
      return null;
    };
    const term = (): Operand | null => {
      const signed = negative();
      if (signed !== null) return signed;
      const t = take();
      if (t.k === K.Str) return literalOperand(t, t.t);
      if (t.k === K.Op && t.t === '-') {
        flag('check', t, 'unary minus applies only to a number literal');
        out.push('-');
        term();
        return null;
      }
      if (t.k !== K.Word) throw new ExpressionSyntax(t);
      if (isNumber(t)) return literalOperand(t, numberText(t.t));
      if (t.t === 'true' || t.t === 'false') {
        mark(t, 'keyword');
        return literalOperand(t, t.t);
      }
      if (t.t === 'null') {
        flag('check', t, 'the null literal is not part of a predicate');
        return null;
      }
      if (EXPRESSION_WORDS.has(t.t)) throw new ExpressionSyntax(t);
      if (isPunct(peek(), '(')) {
        flag('check', t, `function ${t.t} is not part of a predicate`);
        // A diagnostic has already been reported, so the arguments are skipped by matching parentheses only.
        let depth = 0;
        do {
          const u = take();
          if (isPunct(u, '(')) depth++;
          else if (isPunct(u, ')')) depth--;
        } while (depth > 0);
        return null;
      }
      // Go's ref: a malformed reference reports its name rule (format, then length) and is not resolved.
      // A column reference is a name (R13), whether it resolves or not.
      mark(t, 'name');
      if (!wellFormed(t.t)) {
        issue(t, RESERVED.has(t.t) ? `${t.t} is a reserved word` : `${t.t} does not match [a-z][a-z0-9_]*`, 'name.format');
        return null;
      }
      if (utf8Length(t.t) > MAX_NAME_BYTES) {
        issue(t, `${t.t} is longer than 63 bytes`, 'name.length');
        return null;
      }
      out.push(t.t);
      const column = table.colMap.get(t.t);
      // A column whose own line failed was reported on that line.
      if (column === undefined && table.failed.has(t.t)) return null;
      // The diagnostic of a column is chosen in source order together with the type diagnostics.
      if (column === undefined) issue(t, `${t.t} is not a column of table ${table.name.t}`);
      else if (banned.has(t.t)) issue(t, `column ${t.t} belongs to a cascade or set_null foreign key`);
      else if (column.type !== null && column.type.kind === 'bytes') issue(t, `bytes column ${t.t} is not part of a predicate`);
      else return { column, tok: t, type: column.type, slot: -1 };
      return null;
    };
    const operand = (): Operand | null => {
      let result = term();
      for (let t = peek(); t !== undefined && t.k === K.Op && ARITHMETIC.has(t.t); t = peek()) {
        flag('check', t, `arithmetic ${t.t} is not part of a predicate`);
        out.push(take().t);
        term();
        result = null;
      }
      return result;
    };
    const isBool = (o: Operand): boolean =>
      o.column !== null ? o.type !== null && o.type.kind === 'bool' : o.tok.t === 'true' || o.tok.t === 'false';
    // Checks the literal against the column's default form and converts it to the canonical form. The diagnostic is put on the literal.
    const fit = (column: Operand, value: Operand): void => {
      if (column.type === null) return;
      const fitted = defaultOf(column.type, value.tok);
      if (typeof fitted === 'string') issue(value.tok, `${value.tok.t} does not meet column ${column.tok.t}: ${fitted}`);
      else if (fitted.kind === 'literal') out[value.slot] = fitted.text;
      else issue(value.tok, `${value.tok.t} is not a literal`);
    };
    const compare = (left: Operand, op: Tk, right: Operand): void => {
      if (ORDERINGS.has(op.t) && (isBool(left) || isBool(right))) issue(op, `${op.t} does not compare bool values`);
      if (left.column !== null && right.column !== null) {
        if (left.type !== null && right.type !== null && meetKindOf(left.type) !== meetKindOf(right.type)) {
          issue(right.tok, `column ${right.tok.t} (${typeText(right.type)}) does not meet column ${left.tok.t} (${typeText(left.type)})`);
        }
      } else if (left.column !== null) fit(left, right);
      else if (right.column !== null) fit(right, left);
    };
    // The operand before in and is is a column.
    const subject = (left: Operand | null, word: Tk): Operand | null => {
      if (left !== null && left.column === null) {
        flag('check', left.tok, `${word.t} takes a column, not a literal`);
        return null;
      }
      return left;
    };
    // An operand not followed by a comparison, in, or is: reported at the operand if followed by and, or, ), or the end; otherwise at the following token.
    const alone = (start: Tk): never => {
      const next = peek();
      if (next !== undefined && !isWord(next, 'and') && !isWord(next, 'or') && !isPunct(next, ')')) {
        flag('check', next, `${next.t} is not part of a predicate`);
      } else flag('check', start, `${start.t} alone is not a predicate`);
      throw new ExpressionSyntax(null);
    };
    const predicate = (): Predicate => {
      if (isPunct(peek(), '(')) {
        take();
        const inner = or();
        if (!isPunct(take(), ')')) throw new ExpressionSyntax(present(toks[i - 1], 'toks[i - 1]'));
        return inner;
      }
      out = [];
      const start = peek();
      const left = operand();
      const t = peek();
      if (t !== undefined && t.k === K.Op && COMPARISONS.has(t.t)) {
        out.push(take().t);
        const right = operand();
        if (left !== null && right !== null && left.column === null && right.column === null) {
          flag('check', left.tok, 'a comparison has at least one column operand');
        } else if (left !== null && right !== null) compare(left, t, right);
        return { kind: 'leaf', parts: out };
      }
      const negated = isWord(t, 'not') && isWord(toks[i + 1], 'in');
      if (negated) {
        mark(t, 'keyword');
        out.push(take().t);
      }
      const u = peek();
      if (isWord(u, 'in')) {
        const column = subject(left, present(u, 'u'));
        mark(u, 'keyword');
        out.push(take().t);
        expectPunct('(');
        const values = [literal()];
        while (isPunct(peek(), ',')) {
          out.push(take().t);
          values.push(literal());
        }
        expectPunct(')');
        if (column !== null) for (const value of values) if (value !== null) fit(column, value);
        return { kind: 'leaf', parts: out };
      }
      if (isWord(u, 'is')) {
        subject(left, present(u, 'u'));
        mark(u, 'keyword');
        out.push(take().t);
        if (isWord(peek(), 'not')) {
          mark(peek(), 'keyword');
          out.push(take().t);
        }
        expectWord('null');
        return { kind: 'leaf', parts: out };
      }
      return alone(present(start, 'start'));
    };
    const and = (): Predicate => {
      let left = predicate();
      while (isWord(peek(), 'and')) {
        mark(peek(), 'keyword');
        take();
        left = { kind: 'logical', op: 'and', left, right: predicate() };
      }
      return left;
    };
    const or = (): Predicate => {
      let left = and();
      while (isWord(peek(), 'or')) {
        mark(peek(), 'keyword');
        take();
        left = { kind: 'logical', op: 'or', left, right: and() };
      }
      return left;
    };
    let tree: Predicate;
    try {
      tree = or();
      if (i < toks.length) throw new ExpressionSyntax(present(toks[i], 'toks[i]'));
    } catch (error) {
      if (!(error instanceof ExpressionSyntax)) throw error;
      flag('check', error.at ?? check.close, error.at === null ? 'the check expression ends early' : `${error.at.t} is not allowed here in a check expression`);
      return;
    }
    if (flagged) return;
    let first: (typeof issues)[number] | undefined;
    for (const found of issues) if (first === undefined || found.tok.s < first.tok.s) first = found;
    if (first !== undefined) {
      this.at(first.rule, first.tok, first.message);
      return;
    }
    check.text = predicateText(tree);
  }

  private settings(table: ITable, settings: ISettings, available: Map<string, ITable | null>, actionChild: boolean): void {
    const seen = new Set<string>();
    const entries = settings.entries;
    const hasAesVersion = entries.some(s => s.kind === 'aes_version');
    const aesColumns = new Set<string>();
    for (const s of entries) if (s.kind === 'codec' && s.stages.some(stage => stage.t === 'aes')) aesColumns.add(s.column.t);
    const lookup = (tok: Tk): IColumn | null | undefined => this.lookup(table, tok, 'setting');
    for (const s of entries) {
      // state_machine and checkbox are written on several lines, so they are excluded from the repeated check.
      if (s.kind !== 'state_machine' && s.kind !== 'checkbox') {
        const key =
          s.kind === 'codec'
            ? `codec ${s.column.t}`
            : s.kind === 'navigation'
              ? `navigation ${s.foreignKey.t}`
              : s.kind === 'blind_index'
                ? `blind_index ${s.column.t}`
                : s.kind === 'markdown'
                  ? `markdown ${s.column.t}`
                  : s.kind;
        if (seen.has(key)) {
          this.at('setting', s.kw, `setting ${key} repeats`);
          continue;
        }
        seen.add(key);
      }
      switch (s.kind) {
        case 'entity':
          break;
        case 'updated': {
          const c = lookup(s.column);
          if (c && c.type !== null && c.type.kind !== 'datetime') this.at('setting', s.column, 'updated names a datetime column');
          break;
        }
        case 'soft_delete': {
          const c = lookup(s.column);
          if (c && c.type !== null && (c.type.kind !== 'datetime' || !c.nullable)) {
            this.at('setting', s.column, 'soft_delete names a nullable datetime column');
          }
          break;
        }
        case 'select_explicit': {
          const listed = new Set<string>();
          for (const tok of s.columns) {
            if (lookup(tok) && listed.has(tok.t)) this.at('setting', tok, `column ${tok.t} repeats`);
            listed.add(tok.t);
          }
          break;
        }
        case 'codec':
          this.codec(table, s, hasAesVersion);
          break;
        case 'aes_version': {
          const c = lookup(s.column);
          if (c && c.type !== null && (!['i16', 'i32', 'i64'].includes(c.type.kind) || c.nullable)) {
            this.at('setting', s.column, 'aes_version names a non-null integer column');
          }
          if (aesColumns.size === 0) this.at('setting', s.kw, 'aes_version requires a column with the aes codec stage');
          break;
        }
        case 'blind_index':
          this.blindIndex(table, s, aesColumns);
          break;
        case 'navigation':
          if (wellFormed(s.foreignKey.t) && !table.failed.has(s.foreignKey.t) && !table.fks.some(fk => fk.name.t === s.foreignKey.t)) {
            this.at('setting', s.foreignKey, `${s.foreignKey.t} is not a foreign key of table ${table.name.t}`);
          }
          break;
        case 'markdown':
          this.checkMarkdown(table, s);
          break;
        case 'store':
          if (s.storage.t === 'block' && s.foreignKey !== null) this.checkForeignKeyName(table, s.foreignKey);
          this.checkStoreShard(table, s, entries.some(e => e.kind === 'order'));
          break;
        case 'key_prefix':
          this.checkKeyPrefix(table, s);
          break;
        case 'title':
        case 'body':
          this.checkTextColumn(table, s);
          break;
        case 'order':
          this.checkOrder(table, s);
          break;
        case 'state_machine':
          this.checkStateMachine(table, s);
          break;
        case 'immutable':
          if (actionChild) this.at('setting', s.kw, 'immutable is rejected on a child of a cascade or set_null foreign key');
          break;
        case 'audit':
          this.audit(table, s, available, actionChild);
          break;
      }
    }
    this.checkStateMachineConsistency(table, entries, available);
  }

  /** Reports a malformed name as Go's ref does; says whether the name can be resolved. */
  private ref(tok: Tk): boolean {
    if (wellFormed(tok.t)) return true;
    this.name(tok);
    return false;
  }

  /** The column that a setting names: null after a report, undefined when the name is malformed or its line failed. */
  private columnRef(table: ITable, tok: Tk): IColumn | null | undefined {
    if (!this.ref(tok)) return undefined;
    return this.lookup(table, tok, 'setting');
  }

  private checkMarkdown(table: ITable, s: Extract<ISetting, { kind: 'markdown' }>): void {
    const c = this.columnRef(table, s.column);
    if (c && c.type !== null && c.type.kind !== 'varchar' && c.type.kind !== 'text') {
      this.at('setting', s.column, `markdown needs a varchar or text column, not ${typeText(c.type)}`);
    }
  }

  /** A block store names a foreign key of the table. */
  private checkForeignKeyName(table: ITable, tok: Tk): void {
    if (!this.ref(tok) || table.failed.has(tok.t)) return;
    if (!table.fks.some(f => f.name.t === tok.t)) this.at('setting', tok, `foreign key ${tok.t} is not a foreign key of the table`);
  }

  /** The primary key is one varchar column. */
  private checkKeyPrefix(table: ITable, s: Extract<ISetting, { kind: 'key_prefix' }>): void {
    if (table.failedPrimary) return;
    const pk = table.pks;
    if (pk.length !== 1 || present(pk[0], 'pk[0]').cols.length !== 1) {
      this.at('setting', s.kw, 'key_prefix needs a single-column primary key');
      return;
    }
    const c = table.colMap.get(present(present(pk[0], 'pk[0]').cols[0], 'pk[0].cols[0]').tok.t);
    if (c !== undefined && c.type !== null && c.type.kind !== 'varchar') {
      this.at('setting', s.kw, `key_prefix needs a varchar primary key, not ${typeText(c.type)}`);
    }
  }

  /** The title and body columns are non-null varchar or text columns. */
  private checkTextColumn(table: ITable, s: Extract<ISetting, { kind: 'title' | 'body' | 'order' }>): void {
    const c = this.columnRef(table, s.column);
    if (c && ((c.type !== null && c.type.kind !== 'varchar' && c.type.kind !== 'text') || c.nullable)) {
      this.at('setting', s.column, `${s.kw.t} needs a non-null varchar or text column`);
    }
  }

  /**
   * The shard clause of store names a non-null date or datetime column; a block table, a table with a self foreign
   * key and a table with order reject it.
   */
  private checkStoreShard(table: ITable, s: Extract<ISetting, { kind: 'store' }>, order: boolean): void {
    if (s.shard === null) return;
    const c = this.columnRef(table, s.shard.column);
    if (c && ((c.type !== null && c.type.kind !== 'date' && c.type.kind !== 'datetime') || c.nullable)) {
      this.at('setting', s.shard.column, 'store shard needs a non-null date or datetime column');
    }
    if (s.storage.t === 'block') this.at('setting', s.shard.at, 'store shard is rejected on a block table');
    if (table.fks.some(fk => fk.table.t === table.name.t)) {
      this.at('setting', s.shard.at, 'store shard is rejected on a table with a self foreign key');
    }
    if (order) this.at('setting', s.shard.at, 'store shard is rejected on a table with order');
  }

  /** The order column is a non-null i32 or i64 column with no default, in no key, index or check. */
  private checkOrder(table: ITable, s: Extract<ISetting, { kind: 'title' | 'body' | 'order' }>): void {
    const c = this.columnRef(table, s.column);
    if (!c) return;
    if ((c.type !== null && c.type.kind !== 'i32' && c.type.kind !== 'i64') || c.nullable || c.dflt !== null) {
      this.at('setting', s.column, 'order needs a non-null i32 or i64 column with no default');
      return;
    }
    if (inKeyOrCheck(table, s.column.t)) this.at('setting', s.column, `order column ${s.column.t} is in a key, index or check`);
  }

  /** Each state_machine line: its column is a non-null varchar or text column, and its require list names columns. */
  private checkStateMachine(table: ITable, s: IStateMachine): void {
    const c = this.columnRef(table, s.column);
    if (c && ((c.type !== null && c.type.kind !== 'varchar' && c.type.kind !== 'text') || c.nullable)) {
      this.at('setting', s.column, 'state_machine needs a non-null varchar or text column');
    }
    if (s.line.form === 'terminal' || s.line.form === 'transition') {
      for (const ref of s.line.requires ?? []) this.columnRef(table, ref);
    }
  }

  /**
   * Checks the state_machine lines against each other: one column per table,
   * one history line, initial and terminal states that agree with the
   * transitions, limit lines, the default of the state column, and checkbox lines.
   */
  private checkStateMachineConsistency(table: ITable, entries: ISetting[], available: Map<string, ITable | null>): void {
    let column = '';
    const states = new Set<string>();
    const initials = new Set<string>();
    const terminals = new Set<string>();
    const lines: IStateMachine[] = [];
    const limits: IStateMachine[] = [];
    let history: IStateMachine | null = null;
    const requires: Tk[] = [];
    const boxes: ICheckbox[] = [];
    // The identity of an initial, terminal or transition line: its form and states, never its require list.
    const seen = new Set<string>();
    for (const s of entries) {
      if (s.kind === 'checkbox') {
        boxes.push(s);
        continue;
      }
      if (s.kind !== 'state_machine') continue;
      if (column === '') column = s.column.t;
      else if (s.column.t !== column) {
        this.at('setting', s.column, `state_machine repeats for ${s.column.t}; a table holds one machine`);
      }
      const line = s.line;
      if (line.form === 'history') {
        if (history !== null) {
          this.at('setting', s.kw, 'state_machine repeats history');
          continue;
        }
        history = s;
        continue;
      }
      if (line.form === 'limit') {
        limits.push(s);
        continue;
      }
      // A line of another column already reports that a table holds one machine; it is no line of this one.
      if (s.column.t === column) {
        const [key, what] = machineLine(line);
        if (seen.has(key)) {
          this.at('setting', s.kw, `state_machine repeats ${what}`);
          continue;
        }
        seen.add(key);
      }
      lines.push(s);
      if (line.form === 'transition' || line.form === 'terminal') requires.push(...(line.requires ?? []));
      if (line.form === 'initial') {
        initials.add(line.state.t);
        states.add(line.state.t);
      } else if (line.form === 'terminal') {
        terminals.add(line.state.t);
        states.add(line.state.t);
      } else if (line.form === 'transition') {
        states.add(line.from.t);
        states.add(line.to.t);
      }
    }
    for (const s of lines) {
      const line = s.line;
      if (line.form === 'initial' && terminals.has(line.state.t)) {
        this.at('setting', s.kw, `an initial state ${line.state.t} is also terminal`);
      } else if (line.form === 'transition' && terminals.has(line.from.t)) {
        this.at('setting', s.kw, `a transition leaves the terminal state ${line.from.t}`);
      }
    }
    this.checkLimits(limits, states);
    if (history !== null) this.checkHistory(table, history, table.colMap.get(column), requires, available);
    const c = table.colMap.get(column);
    if (c !== undefined && c.valueTok !== null) {
      const value = c.valueTok.k === K.Str ? stringValue(c.valueTok) : c.valueTok.t;
      if (!initials.has(value)) {
        this.at('setting', c.valueTok, `the default ${value} of the state column is not an initial state`);
      }
    }
    this.checkCheckboxes(table, column, states, boxes);
  }

  /** Each limit names a state of the machine once, with a positive row count that fits 64 bits. */
  private checkLimits(lines: IStateMachine[], states: Set<string>): void {
    const seen = new Set<string>();
    for (const s of lines) {
      if (s.line.form !== 'limit') continue;
      const state = s.line.state;
      if (!states.has(state.t)) this.at('setting', state, `limit names state ${state.t} outside the state set`);
      else if (seen.has(state.t)) this.at('setting', state, `limit repeats for state ${state.t}`);
      seen.add(state.t);
      const count = s.line.count;
      const n = /^-?[0-9]+$/.test(count.t) ? BigInt(count.t) : BigInt(0);
      if (n < BigInt(1) || n > BigInt('9223372036854775807')) {
        this.at('setting', count, `limit needs a positive row count, not ${count.t}`);
      }
    }
  }

  /**
   * The history line names a history table that has a foreign key to this
   * table, a from and a to column of the state type, an at column of
   * datetime(6), a nullable column of each required column's type, and no
   * column the line leaves out; it declares no title or body.
   */
  private checkHistory(
    table: ITable,
    s: IStateMachine,
    state: IColumn | undefined,
    requires: Tk[],
    available: Map<string, ITable | null>,
  ): void {
    if (s.line.form !== 'history') return;
    const line = s.line;
    const name = line.table;
    if (!this.ref(name)) return;
    if (!available.has(name.t)) {
      this.at('setting', name, `history table ${name.t} is not a table of this document or a used table`);
      return;
    }
    const h = available.get(name.t) ?? null;
    if (h === null) return;
    if (state === undefined || state.type === null) return;
    const stateType = state.type;
    const row = line.row;
    if (!h.fks.some(f => f.cols.length === 1 && present(f.cols[0], 'f.cols[0]').t === row.t && f.table.t === table.name.t)) {
      this.at('setting', name, `history table ${name.t} has no foreign key of ${row.t} to table ${table.name.t}`);
    }
    const named = new Set<string>([row.t]);
    const typed = (ref: Tk, want: DbspecType): void => {
      named.add(ref.t);
      const c = h.colMap.get(ref.t);
      if (c === undefined) {
        if (!h.failed.has(ref.t)) this.at('setting', name, `history table ${name.t} has no column ${ref.t}`);
      } else if (c.type !== null && !sameType(c.type, want)) {
        this.at('setting', name, `history column ${ref.t} has type ${typeText(c.type)}, not ${typeText(want)}`);
      }
    };
    typed(line.from, stateType);
    typed(line.to, stateType);
    typed(line.at, { kind: 'datetime', precision: 6 });
    for (const r of requires) {
      named.add(r.t);
      const c = table.colMap.get(r.t);
      if (c === undefined || c.type === null) continue;
      const hc = h.colMap.get(r.t);
      if (hc === undefined) {
        if (!h.failed.has(r.t)) this.at('setting', name, `history table ${name.t} has no column ${r.t} of the required column`);
      } else if (!hc.nullable || (hc.type !== null && !sameType(hc.type, c.type))) {
        this.at('setting', name, `history column ${r.t} is not a nullable ${typeText(c.type)} column`);
      }
    }
    for (const k of h.pks) for (const c of k.cols) named.add(c.tok.t);
    for (const c of h.columns) {
      if (!named.has(c.name.t)) {
        this.at('setting', name, `history table ${name.t} has column ${c.name.t}, which the history line does not name`);
      }
    }
    for (const e of h.settings?.entries ?? []) {
      if (e.kind === 'title' || e.kind === 'body') {
        this.at('setting', name, `history table ${name.t} declares ${e.kind}, which a history table does not`);
      }
    }
  }

  /**
   * The checkbox lines name the machine's column, one state of the machine
   * each, one glyph character each with no glyph repeated, and every state
   * has one.
   */
  private checkCheckboxes(table: ITable, column: string, states: Set<string>, boxes: ICheckbox[]): void {
    if (boxes.length === 0) return;
    const first = present(boxes[0], 'boxes[0]');
    if (column === '') {
      this.at('setting', first.column, `checkbox needs a state_machine on column ${first.column.t}`);
      return;
    }
    const covered = new Set<string>();
    const glyphs = new Set<string>();
    for (const b of boxes) {
      if (!this.columnRef(table, b.column)) continue;
      if (b.column.t !== column) {
        this.at('setting', b.column, `checkbox names column ${b.column.t}, but the state_machine column is ${column}`);
        continue;
      }
      if (!states.has(b.state.t)) this.at('setting', b.state, `checkbox names state ${b.state.t} outside the state set`);
      else if (covered.has(b.state.t)) this.at('setting', b.state, `checkbox repeats for state ${b.state.t}`);
      covered.add(b.state.t);
      const glyph = stringValue(b.glyph);
      if (Array.from(glyph).length !== 1) this.at('setting', b.glyph, 'a checkbox glyph is one character');
      else if (glyphs.has(glyph)) this.at('setting', b.glyph, `checkbox glyph ${glyph} repeats`);
      glyphs.add(glyph);
    }
    for (const state of [...states].sort()) {
      if (!covered.has(state)) this.at('setting', first.kw, `checkbox does not cover state ${state}`);
    }
  }

  /** The stage order and the storage type that the last stage needs. */
  private codec(table: ITable, s: Extract<ISetting, { kind: 'codec' }>, hasAesVersion: boolean): void {
    const column = this.lookup(table, s.column, 'setting');
    const stages = s.stages.map(stage => stage.t);
    if (stages.includes('aes') && !hasAesVersion) this.at('setting', s.kw, 'a column with the aes stage requires aes_version');
    const json = stages.indexOf('ordered_json');
    if (json > 0) this.at('setting', present(s.stages[json], 's.stages[json]'), 'ordered_json is the first codec stage');
    if (!column || column.type === null || !stages.every(stage => STAGES.has(stage))) return;
    const last = present(stages[stages.length - 1], 'stages[stages.length - 1]');
    const bytes = last === 'aes' || last === 'gz' || last === 'ip';
    const kind = column.type.kind;
    if (bytes && kind !== 'bytes') this.at('setting', s.column, `the ${last} stage stores bytes and needs a bytes column`);
    if (!bytes && kind !== 'varchar' && kind !== 'text') {
      this.at('setting', s.column, `the ${last} stage stores text and needs a varchar or text column`);
    }
  }

  private blindIndex(table: ITable, s: Extract<ISetting, { kind: 'blind_index' }>, aesColumns: Set<string>): void {
    const source = this.lookup(table, s.column, 'setting');
    if (source && !aesColumns.has(s.column.t)) this.at('setting', s.kw, `column ${s.column.t} has no aes codec stage`);
    const target = this.lookup(table, s.indexColumn, 'setting');
    if (!target) return;
    const type = target.type;
    const indexed = [...table.uniques, ...table.indexes].some(k => k.cols.length === 1 && present(k.cols[0], 'k.cols[0]').tok.t === s.indexColumn.t);
    if (aesColumns.has(s.indexColumn.t)) this.at('setting', s.indexColumn, 'the blind index column is not aes-encoded');
    else if (type !== null && !(type.kind === 'varchar' && type.length >= 64)) this.at('setting', s.indexColumn, 'the blind index column is varchar(n) with n >= 64');
    else if (source && source.nullable !== target.nullable) this.at('setting', s.indexColumn, 'the blind index column has the nullability of the aes column');
    else if (!table.failedKey && !indexed) this.at('setting', s.indexColumn, 'the blind index column is the only column of a declared index or unique key');
  }

  private audit(
    table: ITable,
    s: Extract<ISetting, { kind: 'audit' }>,
    available: Map<string, ITable | null>,
    actionChild: boolean,
  ): void {
    if (actionChild) this.at('setting', s.kw, 'audit is rejected on a child of a cascade or set_null foreign key');
    const column = this.lookup(table, s.column, 'setting');
    if (column && column.nullable) this.at('setting', s.column, 'the audit column is a non-null column');
    const recorded = this.auditLists(table, s);
    this.auditRecord(table, s, column ?? undefined, available);
    if (!wellFormed(s.into.t)) return;
    if (!available.has(s.into.t)) {
      this.at('setting', s.into, `history table ${s.into.t} is not defined or used`);
      return;
    }
    const history = available.get(s.into.t) ?? null;
    if (history === null) return;
    // Go does not check the columns of a history table whose header failed (audit in settings.go).
    if (history.headerFailed) return;
    if (history === table) {
      this.at('setting', s.into, 'a table is not its own history table');
      return;
    }
    if (history.settings?.entries.some(e => e.kind === 'audit')) this.at('setting', s.into, `history table ${s.into.t} is audited itself`);
    const key = history.columns.find(c => c.identity !== null);
    if (key === undefined || key.type === null || key.type.kind !== 'i64') {
      this.at('setting', s.into, `history table ${s.into.t} has no i64 identity primary key`);
    }
    const action = wellFormed(s.action.t) ? history.colMap.get(s.action.t) : undefined;
    if (wellFormed(s.action.t)) {
      if (action === undefined) this.at('setting', s.action, `${s.action.t} is not a column of history table ${s.into.t}`);
      else if ((action.type !== null && typeText(action.type) !== 'varchar(8)') || action.nullable) {
        this.at('setting', s.action, 'the action column is a non-null varchar(8)');
      }
    }
    if (wellFormed(s.previous.t)) {
      const previous = history.colMap.get(s.previous.t);
      if (previous === undefined) this.at('setting', s.previous, `${s.previous.t} is not a column of history table ${s.into.t}`);
      else if (
        !previous.nullable ||
        (previous.type !== null && column && column.type !== null && !sameType(previous.type, column.type))
      ) {
        this.at('setting', s.previous, 'the previous column is nullable and has the type of the audit column');
      }
    }
    // A setting that uses both lists does not determine which columns are recorded, so the columns of the history table are not checked.
    if (recorded === null) return;
    const allowed = new Set([key?.name.t, s.action.t, s.previous.t]);
    for (const c of table.columns) {
      if (!wellFormed(c.name.t) || !recorded(c.name.t)) continue;
      allowed.add(c.name.t);
      const copy = history.colMap.get(c.name.t);
      if (copy === undefined) this.at('setting', s.into, `history table ${s.into.t} has no column ${c.name.t}`);
      else if (copy !== key && c.type !== null && copy.type !== null && !sameType(c.type, copy.type)) {
        this.at('setting', s.into, `history column ${c.name.t} is ${typeText(copy.type)}, not ${typeText(c.type)}`);
      }
    }
    for (const c of history.columns) {
      if (allowed.has(c.name.t)) continue;
      if (wellFormed(c.name.t) && table.colMap.has(c.name.t)) this.at('setting', s.into, `history table ${s.into.t} has column ${c.name.t}, which table ${table.name.t} does not record`);
      else this.at('setting', s.into, `history table ${s.into.t} has the extra column ${c.name.t}`);
    }
  }

  /**
   * Checks the audit's exclude or include list, and returns a function that reports whether a column is recorded
   * (docs/dbspec.md "Audit"). If both lists are used, it rejects at the keyword of the second list and returns null.
   * The columns of a list are columns of the table, appear only once, and are not audit columns. Audit columns are
   * always recorded, so they are not written in either list.
   */
  private auditLists(table: ITable, s: Extract<ISetting, { kind: 'audit' }>): ((column: string) => boolean) | null {
    if (s.lists.length > 1) {
      this.at('setting', present(s.lists[1], 's.lists[1]').kw, 'audit names its recorded columns by exclude or by include, not both');
      return null;
    }
    const listed = new Set<string>();
    for (const list of s.lists) {
      for (const tok of list.columns) {
        if (listed.has(tok.t)) {
          this.at('setting', tok, `column ${tok.t} repeats in audit ${list.kw.t}`);
          continue;
        }
        if (tok.t === s.column.t) this.at('setting', tok, `the audit column ${tok.t} is always recorded and is not listed in exclude or include`);
        else if (this.name(tok)) this.lookup(table, tok, 'setting');
        listed.add(tok.t);
      }
    }
    const audited = s.column.t;
    if (s.lists.length === 1 && present(s.lists[0], 's.lists[0]').kw.t === 'include') return column => column === audited || listed.has(column);
    return column => column === audited || !listed.has(column);
  }

  /**
   * Checks the audit record table. That table is another table of this document or of a used document, not the history table, and
   * is not itself audited; it has one primary key column, and its type is the type of the audit column. The audit
   * column is the only column of the declared foreign key that points to that primary key with restrict. So for audit records
   * the database rejects audit column values that have no row.
   */
  private auditRecord(table: ITable, s: Extract<ISetting, { kind: 'audit' }>, column: IColumn | undefined, available: Map<string, ITable | null>): void {
    const ref = s.references;
    if (!wellFormed(ref.t)) return;
    if (!available.has(ref.t)) {
      this.at('setting', ref, `audit record table ${ref.t} is not a table of this document or a used table`);
      return;
    }
    const record = available.get(ref.t) ?? null;
    if (record === null) return;
    // Go does not check the key of an audit record table whose header failed (auditRecord in settings.go).
    if (record.headerFailed) return;
    if (record === table) {
      this.at('setting', ref, 'a table cannot record its audits in itself');
      return;
    }
    if (ref.t === s.into.t) {
      this.at('setting', ref, 'the audit record table is another table than the history table');
      return;
    }
    if (record.settings?.entries.some(e => e.kind === 'audit')) this.at('setting', ref, `audit record table ${ref.t} is audited itself`);
    if (record.pks.length !== 1 || present(record.pks[0], 'record.pks[0]').cols.length !== 1) {
      if (!record.failedPrimary) this.at('setting', ref, `audit record table ${ref.t} needs a primary key of one column`);
      return;
    }
    const key = present(present(record.pks[0], 'record.pks[0]').cols[0], 'record.pks[0].cols[0]').tok.t;
    const pk = record.colMap.get(key);
    if (column === undefined || pk === undefined) return;
    if (pk.type !== null && column.type !== null && !sameType(pk.type, column.type)) {
      this.at('setting', s.column, `the audit column has type ${typeText(column.type)}, not the type ${typeText(pk.type)} of the primary key of ${ref.t}`);
      return;
    }
    const declared = table.fks.some(fk => fk.cols.length === 1 && present(fk.cols[0], 'fk.cols[0]').t === s.column.t && fk.table.t === ref.t
      && fk.refs.length === 1 && present(fk.refs[0], 'fk.refs[0]').t === key && fk.onDelete === 'restrict' && fk.onUpdate === 'restrict');
    if (!declared && !table.failedKey) {
      this.at('setting', s.column, `the audit column needs the foreign key (${s.column.t}) references ${ref.t} (${key}) on delete restrict on update restrict`);
    }
  }

  /**
   * The declaration positions of the document in source order (docs/dbspec.md "Declaration positions"), read from the
   * tokens before build() drops them. A successful parse has every name that a position needs; a missing one is an
   * internal error, never a skipped position.
   */
  positions(): RawPosition[] {
    const doc = this.document;
    const out: RawPosition[] = [];
    const add = (kind: string, at: Tk, path: string[]): void => {
      out.push({ kind, path, line: at.line, column: columnOf(present(this.lines[at.line - 1], 'this.lines[at.line - 1]'), at.s) });
    };
    const keyName = (k: IKey): Tk => {
      if (k.name === null) throw new Error('a unique or index of a successful parse has no name');
      return k.name;
    };
    if (doc.nameTok === null) throw new Error('a successful parse has no header name token');
    add('document', doc.nameTok, [doc.name]);
    for (const u of doc.uses) {
      add('use', u.doc, [u.doc.t]);
      for (const t of u.tables) add('use_table', t, [u.doc.t, t.t]);
    }
    for (const t of doc.tables) {
      const table = t.name.t;
      add('table', t.name, [table]);
      for (const c of t.columns) add('column', c.name, [table, c.name.t]);
      for (const k of t.pks) add('constraint', k.kw, [table, 'primary key']);
      for (const k of [...t.uniques, ...t.indexes]) add('constraint', keyName(k), [table, keyName(k).t]);
      for (const f of t.fks) add('constraint', f.name, [table, f.name.t]);
      for (const c of t.checks) add('constraint', c.name, [table, c.name.t]);
      for (const s of t.settings?.entries ?? []) add('setting', s.kw, [table, s.kw.t, ...settingIdentity(s)]);
    }
    for (const g of doc.diagrams) {
      add('diagram', g.name, [g.name.t]);
      for (const e of g.entries) add('diagram_entry', e.table, [g.name.t, e.table.t]);
    }
    return out.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  build(): DbspecDocument {
    const doc = this.document;
    const freeze = Object.freeze;
    const tables = doc.tables.map((t): DbspecTable => {
      const pk = present(t.pks[0], 't.pks[0]');
      const settings = t.settings;
      return freeze({
        comments: freeze(t.comments),
        name: t.name.t,
        columns: freeze(
          t.columns.map(c =>
            freeze({
              comments: freeze(c.comments),
              name: c.name.t,
              type: freeze(present(c.type, 'c.type')),
              nullable: c.nullable,
              identity: c.identity !== null,
              default: c.value === null ? null : freeze(c.value),
            }),
          ),
        ),
        primaryKey: freeze({ comments: freeze(pk.comments), columns: freeze(pk.cols.map(c => c.tok.t)) }),
        uniques: freeze(
          t.uniques.map(u => freeze({ comments: freeze(u.comments), name: present(u.name, 'u.name').t, columns: freeze(u.cols.map(c => c.tok.t)) })),
        ),
        indexes: freeze(
          t.indexes.map(i =>
            freeze({
              comments: freeze(i.comments),
              name: present(i.name, 'i.name').t,
              columns: freeze(i.cols.map(c => freeze({ name: c.tok.t, descending: c.descending }))),
            }),
          ),
        ),
        foreignKeys: freeze(
          t.fks.map(fk =>
            freeze({
              comments: freeze(fk.comments),
              name: fk.name.t,
              columns: freeze(fk.cols.map(c => c.t)),
              table: fk.table.t,
              references: freeze(fk.refs.map(c => c.t)),
              onDelete: oneOf(ACTION_LIST, fk.onDelete, 'the foreign key action'),
              onUpdate: oneOf(ACTION_LIST, fk.onUpdate, 'the foreign key action'),
            }),
          ),
        ),
        checks: freeze(t.checks.map(c => freeze({ comments: freeze(c.comments), name: c.name.t, expression: c.text }))),
        settings:
          settings === null || settings.entries.length === 0
            ? null
            : freeze({
                comments: freeze(settings.comments),
                settings: freeze(settings.entries.map(settingOf)),
                closingComments: freeze(settings.closing),
              }),
        closingComments: freeze(
          settings !== null && settings.entries.length === 0 ? [...settings.comments, ...settings.closing, ...t.closing] : t.closing,
        ),
      });
    });
    return freeze({
      name: doc.name,
      uses: freeze(doc.uses.map(u => freeze({ comments: freeze(u.comments), document: u.doc.t, tables: freeze(u.tables.map(t => t.t)) }))),
      tables: freeze(tables),
      diagrams: freeze(
        doc.diagrams.map(d =>
          freeze({
            comments: freeze(d.comments),
            name: d.name.t,
            placements: freeze(d.entries.map(p => freeze({ comments: freeze(p.comments), table: p.table.t, x: p.x, y: p.y }))),
            closingComments: freeze(d.closing),
          }),
        ),
      ),
      closingComments: freeze(doc.closing),
    });
  }

  get halted(): boolean {
    return this.stopped;
  }
}

/** Whether a key, index, foreign key or check of the table names the column. */
function inKeyOrCheck(table: ITable, column: string): boolean {
  const keys = [...table.pks, ...table.uniques, ...table.indexes];
  return (
    keys.some(k => k.cols.some(c => c.tok.t === column)) ||
    table.fks.some(f => f.cols.some(c => c.t === column)) ||
    table.checks.some(ch => ch.expr.some(t => t.k === K.Word && t.t === column))
  );
}

function stateLineOf(line: IStateLine): DbspecStateLine {
  const names = (list: Tk[] | null): readonly string[] | null => (list === null ? null : Object.freeze(list.map(c => c.t)));
  switch (line.form) {
    case 'initial':
      return Object.freeze({ form: 'initial', state: line.state.t });
    case 'terminal':
      return Object.freeze({ form: 'terminal', state: line.state.t, requires: names(line.requires) });
    case 'transition':
      return Object.freeze({ form: 'transition', from: line.from.t, to: line.to.t, requires: names(line.requires) });
    case 'history':
      return Object.freeze({ form: 'history', table: line.table.t, row: line.row.t, from: line.from.t, to: line.to.t, at: line.at.t });
    case 'limit':
      return Object.freeze({ form: 'limit', state: line.state.t, count: BigInt(line.count.t).toString() });
  }
}

function settingOf(s: ISetting): DbspecSetting {
  const comments = Object.freeze(s.comments);
  let setting: DbspecSetting;
  switch (s.kind) {
    case 'entity':
      setting = { comments, kind: s.kind, name: s.name.t };
      break;
    case 'updated':
    case 'soft_delete':
    case 'aes_version':
      setting = { comments, kind: s.kind, column: s.column.t };
      break;
    case 'select_explicit':
      setting = { comments, kind: s.kind, columns: Object.freeze(s.columns.map(c => c.t)) };
      break;
    case 'codec':
      setting = { comments, kind: s.kind, column: s.column.t, stages: Object.freeze(s.stages.map(c => oneOf(STAGE_LIST, c.t, 'the codec stage'))) };
      break;
    case 'blind_index':
      setting = { comments, kind: s.kind, column: s.column.t, indexColumn: s.indexColumn.t };
      break;
    case 'navigation':
      setting = { comments, kind: s.kind, foreignKey: s.foreignKey.t, childName: s.childName.t, parentName: s.parentName.t };
      break;
    case 'immutable':
      setting = { comments, kind: s.kind };
      break;
    case 'markdown':
      setting = { comments, kind: s.kind, column: s.column.t };
      break;
    case 'store':
      setting = {
        comments,
        kind: s.kind,
        storage: oneOf(STORAGES, s.storage.t, 'the store storage'),
        foreignKey: s.foreignKey?.t ?? null,
        shape: s.shape === null ? null : oneOf(SHAPES, s.shape.t, 'the store shape'),
        shard: s.shard === null ? null : { column: s.shard.column.t, period: oneOf(PERIODS, s.shard.period.t, 'the shard period') },
      };
      break;
    case 'key_prefix':
      setting = { comments, kind: s.kind, prefix: stringValue(s.prefix) };
      break;
    case 'title':
    case 'body':
    case 'order':
      setting = { comments, kind: s.kind, column: s.column.t };
      break;
    case 'checkbox':
      setting = { comments, kind: s.kind, column: s.column.t, state: s.state.t, glyph: stringValue(s.glyph) };
      break;
    case 'state_machine':
      setting = { comments, kind: s.kind, column: s.column.t, line: stateLineOf(s.line) };
      break;
    case 'audit':
      setting = {
        comments,
        kind: s.kind,
        into: s.into.t,
        column: s.column.t,
        references: s.references.t,
        action: s.action.t,
        previous: s.previous.t,
        exclude: listOf(s, 'exclude'),
        include: listOf(s, 'include'),
      };
      break;
  }
  return Object.freeze(setting);
}

/** The exclude or include list of the audit setting, or null if there is none. */
function listOf(s: Extract<ISetting, { kind: 'audit' }>, kind: 'exclude' | 'include'): readonly string[] | null {
  const list = s.lists.find(l => l.kw.t === kind);
  return list === undefined ? null : Object.freeze(list.columns.map(c => c.t));
}

/** The first encoding error of the lines: a byte order mark, a bare CR or an unpaired surrogate. */
function encodingError(lines: string[]): RawDiagnostic | null {
  for (let n = 0; n < lines.length; n++) {
    const text = present(lines[n], 'lines[n]');
    const last = n === lines.length - 1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let message: string | null = null;
      if (c === 0xfeff && n === 0 && i === 0) message = 'the text starts with a byte order mark';
      else if (c === 13 && (last || i !== text.length - 1)) message = 'the text has a bare CR';
      else if (c >= 0xd800 && c <= 0xdbff) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) i++;
        else message = 'the text has an unpaired UTF-16 surrogate and is not valid UTF-8';
      } else if (c >= 0xdc00 && c <= 0xdfff) message = 'the text has an unpaired UTF-16 surrogate and is not valid UTF-8';
      if (message !== null) return { rule: 'encoding', line: n + 1, column: columnOf(text, i), message };
    }
  }
  return null;
}

/**
 * Parses one document text and, unless `validate` is false, validates it; parents are the names of the documents that
 * use it.
 */
function parseText(text: string, context: ParseContext, parents: readonly string[], validate = true): Parsed {
  const empty: IDocument = { name: '', nameTok: null, uses: [], tables: [], diagrams: [], closing: [], failed: new Set(), constraints: new Map() };
  if (utf8Length(text) > MAX_BYTES) {
    const diagnostics: RawDiagnostic[] = [{ rule: 'limit', line: 1, column: 1, message: 'a document has at most 32 MiB' }];
    return { diagnostics, document: empty, parser: null };
  }
  const raw = text.split('\n');
  const encoding = encodingError(raw);
  // Go parses the complete lines before an encoding error, then reports it; the offending line and the rest are not read.
  const complete = encoding === null ? raw.length : encoding.line - 1;
  if (encoding !== null && complete === 0) return { diagnostics: [encoding], document: empty, parser: null };
  const lines = raw.slice(0, complete).map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const parser = new DocumentParser(lines, context, parents, encoding);
  parser.parse();
  if (validate && !parser.halted) parser.validate();
  // A stopping error comes after the diagnostics found before it; the others
  // are ordered by line, column and the order of the rule table.
  const found = parser.diagnostics.slice();
  const stop = parser.halted ? found.pop() : undefined;
  const rank = (d: RawDiagnostic): number => RULE_ORDER.indexOf(d.rule);
  const diagnostics = found
    .map((d, order) => ({ d, order }))
    .sort((a, b) => a.d.line - b.d.line || a.d.column - b.d.column || rank(a.d) - rank(b.d) || a.order - b.order)
    .map(x => x.d);
  if (stop !== undefined) diagnostics.push(stop);
  return { diagnostics, document: parser.document, parser };
}

function resultOf(parsed: Parsed): ParsedDocument {
  if (parsed.diagnostics.length > 0 || parsed.parser === null) {
    return { document: null, positions: null, diagnostics: parsed.diagnostics };
  }
  return { document: parsed.parser.build(), positions: parsed.parser.positions(), diagnostics: [] };
}

/** The document of a text and its declared document set, or every diagnostic in source order. */
export function parseDocument(text: string, documents: Readonly<Record<string, string>>): ParsedDocument {
  return resultOf(parseText(text, { documents, cache: new Map() }, []));
}

/**
 * The document name that the header step of the parser reads from a text (Go's parseStructure name), or '' when the
 * header fails. It reads the structure only and validates nothing, so it needs no document set.
 */
export function headerName(text: string): string {
  return parseText(text, { documents: {}, cache: new Map() }, [], false).document.name;
}

/** A token of a text: its 1-based line, its start and end in code points on the line, and its class. */
export interface RawToken {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly cls: DbspecTokenClass;
}

/** Code points of a text, as Array.from counts them: an offending character and a surrogate pair each count once. */
function codePointCount(text: string): number {
  return Array.from(text).length;
}

/** The class of a lexed token of a line that the reader read (or of a line it did not read, with `read` false). */
function classOf(tok: Tk, line: number, parser: DocumentParser | null, read: boolean, abandoned: boolean): DbspecTokenClass {
  if (tok.k === K.Str) return 'string';
  if (tok.k === K.Punct) return 'punctuation';
  if (tok.k === K.Op) return 'operator';
  if (read && !abandoned) {
    const marked = present(parser, 'parser').classes.get(`${line}:${tok.s}`);
    if (marked !== undefined) return marked;
  }
  return UNSIGNED_NUMBER.test(tok.t) ? 'number' : 'word';
}

/**
 * The tokens of a text (docs/dbspec.md "Syntax analysis"), from the parse of the same text. The lines the reader read
 * take the classes it gave; a line it did not read, after a stop, keeps lexical classes. A limit stop gives no tokens.
 */
function tokensOf(text: string, parsed: Parsed): RawToken[] {
  const { diagnostics, parser } = parsed;
  if (diagnostics.some(d => d.rule === 'limit')) return [];
  const last = diagnostics[diagnostics.length - 1];
  const headerStop = parser !== null && parser.halted && last?.rule === 'header';
  const encoding = diagnostics.find(d => d.rule === 'encoding');
  // The lines before the encoding stop line were read; the header stop reads none.
  const readBefore = parser === null || headerStop ? 0 : encoding === undefined ? Infinity : encoding.line;
  const raw = text.split('\n');
  const tokens: RawToken[] = [];
  for (let n = 0; n < raw.length; n++) {
    const line = n + 1;
    // A CR before an LF is part of the line end; a bare CR is an offending character (R22).
    const content = n < raw.length - 1 && present(raw[n], 'raw[n]').endsWith('\r') ? present(raw[n], 'raw[n]').slice(0, -1) : present(raw[n], 'raw[n]');
    let i = 0;
    while (i < content.length && content.charCodeAt(i) === 32) i++;
    if (i === content.length) continue;
    if (content.charCodeAt(i) === 35) {
      tokens.push({ line, start: i, end: codePointCount(content), cls: 'comment' });
      continue;
    }
    const read = line < readBefore;
    const lexed = lexLine(content, line);
    const recovered = lexed.error === null ? { toks: lexed.toks, text: content } : recoverLine(content, line);
    const abandoned = read && present(parser, 'parser').abandoned.has(line);
    for (const tok of recovered.toks) {
      tokens.push({
        line,
        start: codePointCount(recovered.text.slice(0, tok.s)),
        end: codePointCount(recovered.text.slice(0, tok.e)),
        cls: classOf(tok, line, read ? parser : null, read, abandoned),
      });
    }
  }
  return tokens;
}

/** The parse result of a text together with its tokens: the result is the one parseDocument gives. */
export function analyzeDocument(text: string, documents: Readonly<Record<string, string>>): { parsed: ParsedDocument; tokens: RawToken[] } {
  const parsed = parseText(text, { documents, cache: new Map() }, []);
  return { parsed: resultOf(parsed), tokens: tokensOf(text, parsed) };
}
