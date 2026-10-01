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
} from './model.js';
import { typeText } from './emit.js';

export interface RawDiagnostic {
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
const PLAIN_TYPES = new Set(['i16', 'i32', 'i64', 'bool', 'f64', 'text', 'bytes', 'uuid', 'date']);
const INTEGER_RANGES: Record<string, readonly [bigint, bigint]> = {
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
};
const STAGES = new Set<string>(['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip']);
const ACTIONS = new Set<string>(['restrict', 'cascade', 'set_null']);
const CONSTRAINT_WORDS = new Set(['primary', 'unique', 'index', 'foreign', 'check']);
const EXPRESSION_WORDS = new Set(['and', 'or', 'not', 'in', 'between', 'is', 'null', 'true', 'false']);
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);

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
  readonly onDelete: DbspecAction;
  readonly onUpdate: DbspecAction;
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
  | { readonly kind: 'audit'; readonly into: Tk; readonly operation: Tk; readonly action: Tk; readonly previous: Tk }
);

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

const RESERVED = new Set([
  'dbspec', 'use', 'table', 'diagram', 'primary', 'unique', 'index', 'foreign', 'check', 'settings',
  'null', 'identity', 'default', 'true', 'false',
]);

/** Whether a name matches the name rule; reserved words are not names. */
function wellFormed(name: string): boolean {
  return NAME.test(name) && !RESERVED.has(name);
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

function isDelimiter(c: number): boolean {
  return (
    c === 32 || c === 9 || c === 40 || c === 41 || c === 123 || c === 125 || c === 44 || c === 39 ||
    c === 61 || c === 60 || c === 62 || c === 43 || c === 45 || c === 42 || c === 47
  );
}

interface Tokens {
  readonly toks: Tk[];
  /** The index of the first tab or of an unterminated string, or -1. */
  readonly bad: number;
  readonly why: string;
}

/** Tokens of one line. A tab is read as a separator after it is reported; an unterminated string ends the tokens. */
function tokenize(text: string, line: number): Tokens {
  const toks: Tk[] = [];
  const n = text.length;
  let i = 0;
  let tab = -1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9) {
      if (c === 9 && tab < 0) tab = i;
      i++;
    } else if (c === 40 || c === 41 || c === 123 || c === 125 || c === 44) {
      toks.push({ k: K.Punct, t: text[i]!, s: i, e: i + 1, line });
      i++;
    } else if (c === 39) {
      let j = i + 1;
      for (;;) {
        if (j >= n) return tab >= 0 ? { toks, bad: tab, why: 'a tab is not a separator' } : { toks, bad: i, why: 'the string is not terminated' };
        if (text.charCodeAt(j) === 39) {
          if (text.charCodeAt(j + 1) === 39) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      toks.push({ k: K.Str, t: text.slice(i, j + 1), s: i, e: j + 1, line });
      i = j + 1;
    } else if (c === 61 || c === 60 || c === 62 || c === 43 || c === 45 || c === 42 || c === 47) {
      const d = text.charCodeAt(i + 1);
      const two = (c === 60 && (d === 62 || d === 61)) || (c === 62 && d === 61);
      const e = two ? i + 2 : i + 1;
      toks.push({ k: K.Op, t: text.slice(i, e), s: i, e, line });
      i = e;
    } else {
      let j = i + 1;
      while (j < n && !isDelimiter(text.charCodeAt(j))) j++;
      toks.push({ k: K.Word, t: text.slice(i, j), s: i, e: j, line });
      i = j;
    }
  }
  return tab >= 0 ? { toks, bad: tab, why: 'a tab is not a separator' } : { toks, bad: -1, why: '' };
}

function isWord(tok: Tk | undefined, text: string): boolean {
  return tok !== undefined && tok.k === K.Word && tok.t === text;
}

function isPunct(tok: Tk | undefined, text: string): boolean {
  return tok !== undefined && tok.k === K.Punct && tok.t === text;
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
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
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

/** The canonical default of a column type, or the reason the literal does not fit. */
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
      const [min, max] = INTEGER_RANGES[type.kind]!;
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
      if (text === null) return `default of ${typeText(type)} must be a string`;
      if (text.includes('\0')) return 'default contains U+0000';
      if (codePoints(text) > type.length) return `default is longer than ${type.length} characters`;
      return literal(quote(text));
    case 'uuid':
      if (text === null || !UUID.test(text)) return 'default of uuid must be a canonical uuid string';
      return literal(quote(text.toLowerCase()));
    case 'date': {
      const m = text === null ? null : DATE.exec(text);
      if (m === null || !validDate(m[1]!, m[2]!, m[3]!)) return "default of date must be 'YYYY-MM-DD'";
      return literal(quote(text!));
    }
    case 'time': {
      const m = text === null ? null : TIME.exec(text);
      if (m === null || !validTime(m[1]!, m[2]!, m[3]!)) return `default of ${typeText(type)} must be 'HH:MM:SS'`;
      const f = fraction(m[4], type.precision);
      if (f === null) return `default has more than ${type.precision} fraction digits`;
      return literal(quote(`${m[1]}:${m[2]}:${m[3]}${f}`));
    }
    case 'datetime': {
      if (word === 'now') return { kind: 'now' };
      const m = text === null ? null : DATETIME.exec(text);
      if (m === null || !validDate(m[1]!, m[2]!, m[3]!) || !validTime(m[4]!, m[5]!, m[6]!)) {
        return `default of ${typeText(type)} must be now or 'YYYY-MM-DD HH:MM:SS'`;
      }
      const f = fraction(m[7], type.precision);
      if (f === null) return `default has more than ${type.precision} fraction digits`;
      return literal(quote(`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${f}`));
    }
    case 'text':
    case 'bytes':
      return `a ${type.kind} column has no default`;
  }
}

class ExpressionSyntax {
  constructor(readonly at: Tk | null) {}
}

class DocumentParser {
  readonly diagnostics: RawDiagnostic[] = [];
  readonly document: IDocument = { name: '', uses: [], tables: [], diagrams: [], closing: [], failed: new Set(), constraints: new Map() };
  private stopped = false;
  /** The line of the last syntax error: a line reports at most one, since the rest of it cannot be read reliably. */
  private syntaxLine = 0;
  private columnCount = 0;
  private foreignKeyCount = 0;

  constructor(
    private readonly lines: string[],
    private readonly context: ParseContext,
    private readonly parents: readonly string[],
  ) {}

  /** The names of this document and the documents that use it, for detecting a use cycle. */
  private get chain(): readonly string[] {
    return this.parents.length === 0 ? [this.document.name] : this.parents;
  }

  private report(rule: DbspecRule, line: number, index: number, message: string): void {
    if (rule === 'syntax') {
      if (this.syntaxLine === line) return;
      this.syntaxLine = line;
    }
    this.diagnostics.push({ rule, line, column: columnOf(this.lines[line - 1] ?? '', index), message });
  }

  private at(rule: DbspecRule, tok: Tk, message: string): void {
    this.report(rule, tok.line, tok.s, message);
  }

  /** A syntax error at a token, or after the last token of the line. */
  private syntax(toks: Tk[], i: number, line: number, message: string): void {
    const tok = toks[i];
    if (tok !== undefined) this.at('syntax', tok, message);
    else this.report('syntax', line, toks.length > 0 ? toks[toks.length - 1]!.e : 0, message);
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
    for (let n = 1; n < lines.length && !this.stopped; n++) {
      const text = lines[n]!;
      const line = n + 1;
      let i = 0;
      while (i < text.length && text.charCodeAt(i) === 32) i++;
      if (i === text.length) continue;
      if (text.charCodeAt(i) === 35) {
        comments.push(text.slice(i));
        continue;
      }
      const own = comments;
      comments = [];
      const { toks, bad, why } = tokenize(text, line);
      if (bad >= 0) this.report('syntax', line, bad, why);
      const first = toks[0];
      if (first === undefined) continue;
      if (state === 'top') {
        if (isWord(first, 'use')) {
          if (phase > 1) this.at('order', first, 'use lines come before tables and diagrams');
          else phase = 1;
          this.use(toks, line, own);
        } else if (isWord(first, 'table')) {
          if (phase > 2) this.at('order', first, 'tables come before diagrams');
          else phase = 2;
          table = this.tableHeader(toks, line, own);
          state = 'table';
        } else if (isWord(first, 'diagram')) {
          phase = 3;
          diagram = this.diagramHeader(toks, line, own);
          state = 'diagram';
        } else {
          this.at('syntax', first, 'expected use, table or diagram');
        }
      } else if (state === 'table') {
        const t = table!;
        if (isPunct(first, '}')) {
          if (toks.length > 1) this.syntax(toks, 1, line, 'expected the end of the line');
          t.closing = own;
          table = null;
          state = 'top';
        } else if (isWord(first, 'settings')) {
          if (t.settings !== null) this.at('order', first, 'a table has at most one settings block');
          else t.settings = { open: isPunct(toks[1], '{') ? toks[1]! : first, entries: [], comments: own, closing: [] };
          t.phase = 2;
          if (!isPunct(toks[1], '{')) this.syntax(toks, 1, line, 'expected {');
          else if (toks.length > 2) this.syntax(toks, 2, line, 'expected the end of the line');
          state = 'settings';
        } else if (first.k === K.Word && CONSTRAINT_WORDS.has(first.t)) {
          if (t.phase === 2) this.at('order', first, 'key, index, foreign key and check lines come before settings');
          else t.phase = 1;
          this.constraint(t, toks, line, own);
        } else {
          if (t.phase > 0) this.at('order', first, 'columns come before keys, indexes, foreign keys, checks and settings');
          this.column(t, toks, line, own);
        }
      } else if (state === 'settings') {
        const t = table!;
        if (isPunct(first, '}')) {
          if (toks.length > 1) this.syntax(toks, 1, line, 'expected the end of the line');
          t.settings!.closing = own;
          state = 'table';
        } else {
          this.setting(t, toks, line, own);
        }
      } else {
        const d = diagram!;
        if (isPunct(first, '}')) {
          if (toks.length > 1) this.syntax(toks, 1, line, 'expected the end of the line');
          d.closing = own;
          diagram = null;
          state = 'top';
        } else {
          this.placement(d, toks, line, own);
        }
      }
    }
    if (this.stopped) return;
    if (state === 'settings') this.at('syntax', table!.settings!.open, 'the settings block is not closed');
    if (state === 'settings' || state === 'table') this.at('syntax', table!.open, 'the table block is not closed');
    if (state === 'diagram') this.at('syntax', diagram!.open, 'the diagram block is not closed');
    this.document.closing = comments;
  }

  private header(): boolean {
    const text = this.lines[0]!;
    const { toks, bad } = tokenize(text, 1);
    if (bad >= 0 || text.startsWith(' ')) {
      this.report('header', 1, Math.max(bad, 0), 'the first line is not dbspec 1 <document>');
      this.stopped = true;
      return false;
    }
    if (!isWord(toks[0], 'dbspec')) {
      this.report('header', 1, toks[0]?.s ?? 0, 'the first line is not dbspec 1 <document>');
      this.stopped = true;
      return false;
    }
    const version = toks[1];
    if (version === undefined || version.k !== K.Word || version.t !== '1') {
      this.report('header', 1, version?.s ?? toks[0]!.e, 'the language version is not 1');
      this.stopped = true;
      return false;
    }
    const name = toks[2];
    if (name === undefined || name.k !== K.Word) {
      this.report('header', 1, name?.s ?? version.e, 'the header names no document');
      this.stopped = true;
      return false;
    }
    if (toks.length > 3) {
      this.stop('header', toks[3]!, 'the header has more than dbspec 1 <document>');
      return false;
    }
    this.name(name);
    this.document.name = name.t;
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
    this.document.uses.push({ doc, tables: listed[0], comments });
  }

  private tableHeader(toks: Tk[], line: number, comments: string[]): ITable {
    const kw = toks[0]!;
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
      open: named && isPunct(toks[2], '{') ? toks[2]! : kw,
      failed: new Set(),
    };
    if (this.document.tables.length >= MAX_TABLES) {
      this.stop('limit', kw, `a document has at most ${MAX_TABLES} tables`);
      return table;
    }
    this.document.tables.push(table);
    if (!named) this.syntax(toks, 1, line, 'expected a table name');
    else {
      this.name(name);
      if (!isPunct(toks[2], '{')) this.syntax(toks, 2, line, 'expected {');
      else this.end(toks, 3, line);
    }
    return table;
  }

  private diagramHeader(toks: Tk[], line: number, comments: string[]): IDiagram {
    const name = toks[1];
    const named = name !== undefined && name.k === K.Word;
    const open = named && isPunct(toks[2], '{') ? toks[2]! : toks[0]!;
    const diagram: IDiagram = { open, name: named ? name : toks[0]!, named, entries: [], comments, closing: [] };
    this.document.diagrams.push(diagram);
    if (!named) this.syntax(toks, 1, line, 'expected a diagram name');
    else {
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
    if (PLAIN_TYPES.has(kind)) {
      if (params !== null) {
        this.at('type', tok, `${kind} takes no parameters`);
        return null;
      }
      return { kind } as DbspecType;
    }
    const values = (params ?? []).map(p => (/^[0-9]{1,9}$/.test(p.t) ? Number(p.t) : NaN));
    const count = values.length;
    switch (kind) {
      case 'decimal': {
        const [p, s] = values;
        if (count !== 2 || !(p! >= 1 && p! <= 18) || !(s! >= 0 && s! <= p!)) {
          this.at('type', tok, 'decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p');
          return null;
        }
        return { kind, precision: p!, scale: s! };
      }
      case 'varchar': {
        const [n] = values;
        if (count !== 1 || !(n! >= 1 && n! <= 16383)) {
          this.at('type', tok, 'varchar(n) needs 1 <= n <= 16383');
          return null;
        }
        return { kind, length: n! };
      }
      case 'time':
      case 'datetime': {
        const [p] = values;
        if (count !== 1 || !(p! >= 0 && p! <= 6)) {
          this.at('type', tok, `${kind}(p) needs 0 <= p <= 6`);
          return null;
        }
        return { kind, precision: p! };
      }
      default:
        this.at('type', tok, `${kind} is not a dbspec type`);
        return null;
    }
  }

  private column(table: ITable, toks: Tk[], line: number, comments: string[]): void {
    const name = toks[0]!;
    if (name.k !== K.Word) return this.syntax(toks, 0, line, 'expected a column name');
    const typeTok = toks[1];
    if (typeTok === undefined || typeTok.k !== K.Word) {
      table.failed.add(name.t);
      return this.syntax(toks, 1, line, 'expected a type');
    }
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
    if (isWord(toks[i], 'null')) nullTok = toks[i++]!;
    if (isWord(toks[i], 'identity')) identity = toks[i++]!;
    if (isWord(toks[i], 'default')) {
      defaultTok = toks[i++]!;
      const v = toks[i];
      const next = toks[i + 1];
      if (v !== undefined && v.k === K.Op && v.t === '-' && next !== undefined && next.k === K.Word && next.s === v.e) {
        valueTok = { k: K.Word, t: '-' + next.t, s: v.s, e: next.e, line };
        i += 2;
      } else if (v !== undefined && (v.k === K.Word || v.k === K.Str)) {
        valueTok = v;
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
    const column: IColumn = { name, type, nullable: nullTok !== null, identity, value, comments };
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
      if (directions && (isWord(toks[i], 'asc') || isWord(toks[i], 'desc'))) descending = toks[i++]!.t === 'desc';
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

  private constraint(table: ITable, toks: Tk[], line: number, comments: string[]): void {
    const kw = toks[0]!;
    switch (kw.t) {
      case 'primary': {
        if (!isWord(toks[1], 'key')) return this.syntax(toks, 1, line, 'expected key');
        const cols = this.keyColumns(toks, 2, line, false);
        if (cols === null || !this.end(toks, cols[1], line)) return;
        for (const c of cols[0]) this.name(c.tok);
        table.pks.push({ kw, name: null, cols: cols[0], comments });
        return;
      }
      case 'unique':
      case 'index': {
        const name = toks[1];
        if (name === undefined || name.k !== K.Word) return this.syntax(toks, 1, line, 'expected a name');
        const cols = this.keyColumns(toks, 2, line, kw.t === 'index');
        if (cols === null || !this.end(toks, cols[1], line)) return;
        this.constraintName(name);
        for (const c of cols[0]) this.name(c.tok);
        (kw.t === 'index' ? table.indexes : table.uniques).push({ kw, name, cols: cols[0], comments });
        return;
      }
      case 'foreign': {
        if (!isWord(toks[1], 'key')) return this.syntax(toks, 1, line, 'expected key');
        const name = toks[2];
        if (name === undefined || name.k !== K.Word) return this.syntax(toks, 2, line, 'expected a name');
        const cols = this.keyColumns(toks, 3, line, false);
        if (cols === null) return;
        let i = cols[1];
        if (!isWord(toks[i], 'references')) return this.syntax(toks, i, line, 'expected references');
        const target = toks[i + 1];
        if (target === undefined || target.k !== K.Word) return this.syntax(toks, i + 1, line, 'expected a table name');
        const refs = this.keyColumns(toks, i + 2, line, false);
        if (refs === null) return;
        i = refs[1];
        const actions: Record<'delete' | 'update', DbspecAction> = { delete: 'restrict', update: 'restrict' };
        for (const event of ['delete', 'update'] as const) {
          if (!isWord(toks[i], 'on') || !isWord(toks[i + 1], event)) continue;
          const action = toks[i + 2];
          if (action === undefined || action.k !== K.Word || !ACTIONS.has(action.t)) {
            return this.syntax(toks, i + 2, line, 'expected restrict, cascade or set_null');
          }
          actions[event] = action.t as DbspecAction;
          i += 3;
        }
        if (!this.end(toks, i, line)) return;
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
      case 'check': {
        const name = toks[1];
        if (name === undefined || name.k !== K.Word) return this.syntax(toks, 1, line, 'expected a name');
        if (!isPunct(toks[2], '(')) return this.syntax(toks, 2, line, 'expected (');
        const close = toks[toks.length - 1]!;
        if (toks.length < 5 || !isPunct(close, ')')) return this.syntax(toks, toks.length < 5 ? 3 : toks.length, line, 'expected an expression in parentheses');
        this.constraintName(name);
        table.checks.push({ name, expr: toks.slice(3, -1), close, comments, text: '' });
        return;
      }
    }
  }

  private setting(table: ITable, toks: Tk[], line: number, comments: string[]): void {
    const kw = toks[0]!;
    if (kw.k !== K.Word) return this.syntax(toks, 0, line, 'expected a setting');
    const words = (from: number, count: number | null): Tk[] | null => {
      const out: Tk[] = [];
      for (let i = from; i < toks.length; i++) {
        if (toks[i]!.k !== K.Word) {
          this.syntax(toks, i, line, 'expected a name');
          return null;
        }
        out.push(toks[i]!);
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
        this.name(w[0]!);
        entry = { kw, comments, kind: 'entity', name: w[0]! };
        break;
      }
      case 'updated':
      case 'soft_delete':
      case 'aes_version': {
        const w = words(1, 1);
        if (w === null) return;
        this.name(w[0]!);
        entry = { kw, comments, kind: kw.t, column: w[0]! };
        break;
      }
      case 'select': {
        if (!isWord(toks[1], 'explicit')) return this.syntax(toks, 1, line, 'expected explicit');
        const w = words(2, null);
        if (w === null) return;
        for (const c of w) this.name(c);
        entry = { kw, comments, kind: 'select_explicit', columns: w };
        break;
      }
      case 'codec': {
        const w = words(1, null);
        if (w === null) return;
        if (w.length < 2) return this.syntax(toks, toks.length, line, 'expected a codec stage');
        this.name(w[0]!);
        const stages = w.slice(1);
        for (const s of stages) if (!STAGES.has(s.t)) this.at('setting', s, `${s.t} is not a codec stage`);
        entry = { kw, comments, kind: 'codec', column: w[0]!, stages };
        break;
      }
      case 'blind_index': {
        const w = words(1, 2);
        if (w === null) return;
        for (const c of w) this.name(c);
        entry = { kw, comments, kind: 'blind_index', column: w[0]!, indexColumn: w[1]! };
        break;
      }
      case 'navigation': {
        const w = words(1, 3);
        if (w === null) return;
        for (const c of w) this.name(c);
        entry = { kw, comments, kind: 'navigation', foreignKey: w[0]!, childName: w[1]!, parentName: w[2]! };
        break;
      }
      case 'immutable':
        if (!this.end(toks, 1, line)) return;
        entry = { kw, comments, kind: 'immutable' };
        break;
      case 'audit': {
        const parts: Tk[] = [];
        let i = 1;
        for (const label of ['into', 'operation', 'action', 'previous']) {
          if (!isWord(toks[i], label)) return this.syntax(toks, i, line, `expected ${label}`);
          const w = toks[i + 1];
          if (w === undefined || w.k !== K.Word) return this.syntax(toks, i + 1, line, 'expected a name');
          this.name(w);
          parts.push(w);
          i += 2;
        }
        if (!this.end(toks, i, line)) return;
        entry = { kw, comments, kind: 'audit', into: parts[0]!, operation: parts[1]!, action: parts[2]!, previous: parts[3]! };
        break;
      }
      default:
        return this.at('setting', kw, `${kw.t} is not a setting`);
    }
    table.settings!.entries.push(entry);
  }

  private placement(diagram: IDiagram, toks: Tk[], line: number, comments: string[]): void {
    const table = toks[0]!;
    if (table.k !== K.Word) return this.syntax(toks, 0, line, 'expected a table name');
    if (!isWord(toks[1], 'at')) return this.syntax(toks, 1, line, 'expected at');
    let i = 2;
    const coordinates: { tok: Tk; text: string }[] = [];
    for (let n = 0; n < 2; n++) {
      const v = toks[i];
      const next = toks[i + 1];
      if (v !== undefined && v.k === K.Op && v.t === '-' && next !== undefined && next.k === K.Word && next.s === v.e) {
        coordinates.push({ tok: v, text: '-' + next.t });
        i += 2;
      } else if (v !== undefined && v.k === K.Word) {
        coordinates.push({ tok: v, text: v.t });
        i++;
      } else return this.syntax(toks, i, line, 'expected a coordinate');
    }
    if (!this.end(toks, i, line)) return;
    this.name(table);
    const values: number[] = [];
    for (const c of coordinates) {
      const value = INTEGER.test(c.text) && c.text.length <= 12 ? Number(c.text) : NaN;
      if (!(value >= -2147483648 && value <= 2147483647)) {
        this.at('diagram', c.tok, `coordinate ${c.text} is not an integer from -2147483648 to 2147483647`);
      }
      values.push(value + 0);
    }
    diagram.entries.push({ table, x: values[0]!, y: values[1]!, comments });
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
        if (usedConstraints.has(t.name.t)) this.at('name.duplicate', t.name, `table ${t.name.t} repeats a constraint name of a used document`);
        continue;
      }
      const used = usedAt.get(t.name.t);
      this.at('name.duplicate', used === undefined ? t.name : later(used, t.name), `table ${t.name.t} repeats`);
    }
    for (const name of doc.failed) if (!available.has(name)) available.set(name, null);
    for (const [name, tok] of doc.constraints) {
      const table = localTables.get(name);
      if (table !== undefined) this.at('name.duplicate', later(table, tok), `${name} names both a table and a constraint`);
      else if (usedConstraints.has(name) || usedTables.has(name)) this.at('name.duplicate', tok, `${name} repeats a name of a used document`);
    }
    for (const t of doc.tables) this.validateTable(t, available);
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
      parsed = parseText(this.context.documents[name]!, this.context, [...this.chain, name]);
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
    if (table.columns.length === 0) this.at('column', table.name, 'a table has at least one column');
    if (table.pks.length === 0) this.at('key', table.name, `table ${table.name.t} has no primary key`);
    for (const extra of table.pks.slice(1)) this.at('key', extra.kw, 'a table has exactly one primary key');
    for (const pk of table.pks) this.keyLike(table, pk, true);
    for (const u of table.uniques) this.keyLike(table, u, false);
    for (const i of table.indexes) this.keyLike(table, i, false);
    const pk = table.pks[0];
    for (const column of table.columns) {
      if (column.identity === null) continue;
      const only = pk !== undefined && pk.cols.length === 1 && pk.cols[0]!.tok.t === column.name.t;
      if (!only) this.at('column', column.identity, 'an identity column is the only primary key column');
    }
    const banned = new Set<string>();
    let actionChild = false;
    for (const fk of table.fks) {
      this.foreignKey(table, fk, available);
      if (fk.onDelete !== 'restrict' || fk.onUpdate !== 'restrict') {
        actionChild = true;
        for (const c of fk.cols) banned.add(c.t);
      }
    }
    for (const check of table.checks) this.check(table, check, banned);
    if (table.settings !== null) this.settings(table, table.settings, available, actionChild);
  }

  private foreignKey(table: ITable, fk: IForeignKey, available: Map<string, ITable | null>): void {
    let resolved = true;
    const children: IColumn[] = [];
    const seen = new Set<string>();
    if (fk.cols.length === 0) {
      this.at('foreign_key', fk.name, 'a foreign key lists at least one column');
      resolved = false;
    }
    for (const c of fk.cols) {
      const column = this.lookup(table, c, 'foreign_key');
      if (column === undefined || column === null) {
        resolved = false;
        continue;
      }
      if (seen.has(c.t)) {
        this.at('foreign_key', c, `column ${c.t} repeats`);
        resolved = false;
      }
      seen.add(c.t);
      children.push(column);
    }
    if (!wellFormed(fk.table.t)) return;
    if (!available.has(fk.table.t)) {
      this.at('foreign_key', fk.table, `table ${fk.table.t} is not defined or used`);
      return;
    }
    const target = available.get(fk.table.t) ?? null;
    if (target === null) return;
    const parents: IColumn[] = [];
    for (const r of fk.refs) {
      const column = this.lookup(target, r, 'foreign_key');
      if (column === undefined || column === null) {
        resolved = false;
        continue;
      }
      parents.push(column);
    }
    if (!resolved) return;
    if (children.length !== parents.length) {
      this.at('foreign_key', fk.name, 'the foreign key lists a different number of child and referenced columns');
      return;
    }
    const refs = fk.refs.map(r => r.t).join(',');
    const keys = [...target.pks.slice(0, 1), ...target.uniques].map(k => k.cols.map(c => c.tok.t).join(','));
    if (!keys.includes(refs)) {
      this.at('foreign_key', fk.name, `the referenced columns are not the primary key or a unique key of table ${target.name.t}`);
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!.type;
      const parent = parents[i]!.type;
      if (child !== null && parent !== null && !sameType(child, parent)) {
        this.at('foreign_key', fk.name, `column ${fk.cols[i]!.t} is ${typeText(child)} but references ${typeText(parent)}`);
      }
    }
    const lead = fk.cols.map(c => c.t);
    const indexed = [...table.pks, ...table.uniques, ...table.indexes].some(
      k => k.cols.length >= lead.length && lead.every((name, i) => k.cols[i]!.tok.t === name),
    );
    if (!indexed) this.at('foreign_key', fk.name, 'no index or key of the table leads with the foreign key columns');
    if ((fk.onDelete === 'set_null' || fk.onUpdate === 'set_null') && children.some(c => !c.nullable)) {
      this.at('foreign_key', fk.name, 'set_null requires every child column to be null');
    }
  }

  private check(table: ITable, check: ICheck, banned: Set<string>): void {
    const toks = check.expr;
    const out: string[] = [];
    // An expression reports only its first diagnostic.
    let flagged = false;
    const flag = (rule: DbspecRule, tok: Tk, message: string): void => {
      if (flagged) return;
      flagged = true;
      this.at(rule, tok, message);
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
      out.push(text);
    };
    const isNumber = (tok: Tk | undefined): boolean => tok !== undefined && tok.k === K.Word && UNSIGNED_NUMBER.test(tok.t);
    const negative = (): boolean => {
      const t = peek();
      if (t === undefined || t.k !== K.Op || t.t !== '-' || !isNumber(toks[i + 1])) return false;
      i++;
      out.push(numberText('-' + take().t));
      return true;
    };
    const literal = (): void => {
      if (negative()) return;
      const t = take();
      if (t.k === K.Str) out.push(t.t);
      else if (isNumber(t)) out.push(numberText(t.t));
      else if (t.k === K.Word && (t.t === 'true' || t.t === 'false' || t.t === 'null')) out.push(t.t);
      else if (t.k === K.Word && !EXPRESSION_WORDS.has(t.t)) flag('check', t, `${t.t} is not a literal`);
      else throw new ExpressionSyntax(t);
    };
    const primary = (): void => {
      if (negative()) return;
      const t = take();
      if (isPunct(t, '(')) {
        out.push('(');
        or();
        expectPunct(')');
        return;
      }
      if (t.k === K.Str) {
        out.push(t.t);
        return;
      }
      if (t.k === K.Op && t.t === '-') {
        flag('check', t, 'unary minus applies only to a number literal');
        primary();
        return;
      }
      if (t.k !== K.Word) throw new ExpressionSyntax(t);
      if (isNumber(t)) {
        out.push(numberText(t.t));
        return;
      }
      if (t.t === 'true' || t.t === 'false' || t.t === 'null') {
        out.push(t.t);
        return;
      }
      if (EXPRESSION_WORDS.has(t.t)) throw new ExpressionSyntax(t);
      if (isPunct(peek(), '(')) {
        flag('check', t, `function ${t.t} is not in the neutral expression set`);
        i++;
        if (!isPunct(peek(), ')')) {
          or();
          while (isPunct(peek(), ',')) {
            i++;
            or();
          }
        }
        if (!isPunct(take(), ')')) throw new ExpressionSyntax(toks[i - 1]!);
        return;
      }
      if (!wellFormed(t.t)) {
        flag('check', t, `${t.t} is not in the neutral expression set`);
        return;
      }
      const column = table.colMap.get(t.t);
      if (column === undefined && table.failed.has(t.t)) {
        // The column's own line failed and was reported there.
      } else if (column === undefined) flag('check', t, `${t.t} is not a column of table ${table.name.t}`);
      else if (banned.has(t.t)) flag('check', t, `column ${t.t} belongs to a cascade or set_null foreign key`);
      out.push(t.t);
    };
    const operator = (tok: Tk | undefined, set: readonly string[]): boolean =>
      tok !== undefined && tok.k === K.Op && set.includes(tok.t);
    const mul = (): void => {
      primary();
      while (operator(peek(), ['*', '/'])) {
        out.push(take().t);
        primary();
      }
    };
    const add = (): void => {
      mul();
      while (operator(peek(), ['+', '-'])) {
        out.push(take().t);
        mul();
      }
    };
    const predicate = (): void => {
      add();
      const t = peek();
      if (t === undefined) return;
      if (t.k === K.Op && COMPARISONS.has(t.t)) {
        out.push(take().t);
        add();
        return;
      }
      let negated = false;
      if (isWord(t, 'not') && (isWord(toks[i + 1], 'in') || isWord(toks[i + 1], 'between'))) {
        out.push(take().t);
        negated = true;
      }
      const u = peek();
      if (isWord(u, 'in')) {
        out.push(take().t);
        expectPunct('(');
        literal();
        while (isPunct(peek(), ',')) {
          out.push(take().t);
          literal();
        }
        expectPunct(')');
      } else if (isWord(u, 'between')) {
        out.push(take().t);
        add();
        expectWord('and');
        add();
      } else if (!negated && isWord(u, 'is')) {
        out.push(take().t);
        if (isWord(peek(), 'not')) out.push(take().t);
        expectWord('null');
      } else if (u !== undefined && u.k === K.Word && !EXPRESSION_WORDS.has(u.t)) {
        flag('check', u, `${u.t} is not in the neutral expression set`);
        throw new ExpressionSyntax(null);
      }
    };
    const not = (): void => {
      if (isWord(peek(), 'not')) {
        out.push(take().t);
        not();
        return;
      }
      predicate();
    };
    const and = (): void => {
      not();
      while (isWord(peek(), 'and')) {
        out.push(take().t);
        not();
      }
    };
    const or = (): void => {
      and();
      while (isWord(peek(), 'or')) {
        out.push(take().t);
        and();
      }
    };
    try {
      or();
      if (i < toks.length) throw new ExpressionSyntax(toks[i]!);
    } catch (error) {
      if (!(error instanceof ExpressionSyntax)) throw error;
      if (error.at === null && i < toks.length) return;
      const at = error.at ?? check.close;
      flag('syntax', at, 'the check expression is malformed here');
      return;
    }
    let text = '';
    for (let n = 0; n < out.length; n++) {
      const part = out[n]!;
      if (n > 0 && part !== ')' && part !== ',' && out[n - 1] !== '(') text += ' ';
      text += part;
    }
    check.text = text;
  }

  private settings(table: ITable, settings: ISettings, available: Map<string, ITable | null>, actionChild: boolean): void {
    const seen = new Set<string>();
    const entries = settings.entries;
    const hasAesVersion = entries.some(s => s.kind === 'aes_version');
    const hasSoftDelete = entries.some(s => s.kind === 'soft_delete');
    const aesColumns = new Set<string>();
    for (const s of entries) if (s.kind === 'codec' && s.stages.some(stage => stage.t === 'aes')) aesColumns.add(s.column.t);
    const lookup = (tok: Tk): IColumn | null | undefined => this.lookup(table, tok, 'setting');
    for (const s of entries) {
      const key =
        s.kind === 'codec'
          ? `codec ${s.column.t}`
          : s.kind === 'navigation'
            ? `navigation ${s.foreignKey.t}`
            : s.kind === 'blind_index'
              ? `blind_index ${s.column.t}`
              : s.kind;
      if (seen.has(key)) {
        this.at('setting', s.kw, `setting ${key} repeats`);
        continue;
      }
      seen.add(key);
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
          if (wellFormed(s.foreignKey.t) && !table.fks.some(fk => fk.name.t === s.foreignKey.t)) {
            this.at('setting', s.foreignKey, `${s.foreignKey.t} is not a foreign key of table ${table.name.t}`);
          }
          break;
        case 'immutable':
          if (actionChild) this.at('setting', s.kw, 'immutable is rejected on a child of a cascade or set_null foreign key');
          break;
        case 'audit':
          this.audit(table, s, available, actionChild, hasSoftDelete);
          break;
      }
    }
  }

  /** The stage order and the storage type that the last stage needs. */
  private codec(table: ITable, s: Extract<ISetting, { kind: 'codec' }>, hasAesVersion: boolean): void {
    const column = this.lookup(table, s.column, 'setting');
    const stages = s.stages.map(stage => stage.t);
    if (stages.includes('aes') && !hasAesVersion) this.at('setting', s.kw, 'a column with the aes stage requires aes_version');
    const json = stages.indexOf('ordered_json');
    if (json > 0) this.at('setting', s.stages[json]!, 'ordered_json is the first codec stage');
    if (!column || column.type === null || !stages.every(stage => STAGES.has(stage))) return;
    const last = stages[stages.length - 1]!;
    const bytes = last === 'aes' || last === 'gz' || last === 'ip';
    const kind = column.type.kind;
    if (bytes && kind !== 'bytes') this.at('setting', s.column, `the ${last} stage stores bytes and needs a bytes column`);
    if (!bytes && kind !== 'varchar' && kind !== 'text') {
      this.at('setting', s.column, `the ${last} stage stores text and needs a varchar or text column`);
    }
  }

  private blindIndex(table: ITable, s: Extract<ISetting, { kind: 'blind_index' }>, aesColumns: Set<string>): void {
    const source = this.lookup(table, s.column, 'setting');
    if (source && !aesColumns.has(s.column.t)) this.at('setting', s.column, `column ${s.column.t} has no aes codec stage`);
    const target = this.lookup(table, s.indexColumn, 'setting');
    if (!target) return;
    const type = target.type;
    if (type !== null && !(type.kind === 'bytes' || (type.kind === 'varchar' && type.length >= 64))) {
      this.at('setting', s.indexColumn, 'the blind index column is varchar(n) with n >= 64 or bytes');
    }
    if (source && source.nullable !== target.nullable) {
      this.at('setting', s.indexColumn, 'the blind index column has the nullability of the aes column');
    }
    if (aesColumns.has(s.indexColumn.t)) this.at('setting', s.indexColumn, 'the blind index column is not aes-encoded');
    const indexed = [...table.uniques, ...table.indexes].some(k => k.cols.length === 1 && k.cols[0]!.tok.t === s.indexColumn.t);
    if (!indexed) this.at('setting', s.indexColumn, 'the blind index column is the only column of a declared index or unique key');
  }

  private audit(
    table: ITable,
    s: Extract<ISetting, { kind: 'audit' }>,
    available: Map<string, ITable | null>,
    actionChild: boolean,
    hasSoftDelete: boolean,
  ): void {
    if (actionChild) this.at('setting', s.kw, 'audit is rejected on a child of a cascade or set_null foreign key');
    if (!hasSoftDelete) this.at('setting', s.kw, 'an audited table requires soft_delete');
    const operation = this.lookup(table, s.operation, 'setting');
    if (operation && operation.type !== null && (!['i64', 'uuid'].includes(operation.type.kind) || operation.nullable)) {
      this.at('setting', s.operation, 'the operation column is a non-null i64 or uuid column');
    }
    if (!wellFormed(s.into.t)) return;
    if (!available.has(s.into.t)) {
      this.at('setting', s.into, `history table ${s.into.t} is not defined or used`);
      return;
    }
    const history = available.get(s.into.t) ?? null;
    if (history === null) return;
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
        (previous.type !== null && operation && operation.type !== null && !sameType(previous.type, operation.type))
      ) {
        this.at('setting', s.previous, 'the previous column is nullable and has the type of the operation column');
      }
    }
    const allowed = new Set([key?.name.t, s.action.t, s.previous.t]);
    for (const c of table.columns) {
      if (!wellFormed(c.name.t)) continue;
      allowed.add(c.name.t);
      const copy = history.colMap.get(c.name.t);
      if (copy === undefined) this.at('setting', s.into, `history table ${s.into.t} has no column ${c.name.t}`);
      else if (copy !== key && c.type !== null && copy.type !== null && !sameType(c.type, copy.type)) {
        this.at('setting', s.into, `history column ${c.name.t} is ${typeText(copy.type)}, not ${typeText(c.type)}`);
      }
    }
    for (const c of history.columns) {
      if (!allowed.has(c.name.t)) this.at('setting', s.into, `history table ${s.into.t} has the extra column ${c.name.t}`);
    }
  }

  build(): DbspecDocument {
    const doc = this.document;
    const freeze = Object.freeze;
    const tables = doc.tables.map((t): DbspecTable => {
      const pk = t.pks[0]!;
      const settings = t.settings;
      return freeze({
        comments: freeze(t.comments),
        name: t.name.t,
        columns: freeze(
          t.columns.map(c =>
            freeze({
              comments: freeze(c.comments),
              name: c.name.t,
              type: freeze(c.type!),
              nullable: c.nullable,
              identity: c.identity !== null,
              default: c.value === null ? null : freeze(c.value),
            }),
          ),
        ),
        primaryKey: freeze({ comments: freeze(pk.comments), columns: freeze(pk.cols.map(c => c.tok.t)) }),
        uniques: freeze(
          t.uniques.map(u => freeze({ comments: freeze(u.comments), name: u.name!.t, columns: freeze(u.cols.map(c => c.tok.t)) })),
        ),
        indexes: freeze(
          t.indexes.map(i =>
            freeze({
              comments: freeze(i.comments),
              name: i.name!.t,
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
              onDelete: fk.onDelete,
              onUpdate: fk.onUpdate,
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
      setting = { comments, kind: s.kind, column: s.column.t, stages: Object.freeze(s.stages.map(c => c.t as DbspecCodecStage)) };
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
    case 'audit':
      setting = { comments, kind: s.kind, into: s.into.t, operation: s.operation.t, action: s.action.t, previous: s.previous.t };
      break;
  }
  return Object.freeze(setting);
}

/** The first encoding error of the lines: a byte order mark, a bare CR or an unpaired surrogate. */
function encodingError(lines: string[]): RawDiagnostic | null {
  for (let n = 0; n < lines.length; n++) {
    const text = lines[n]!;
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

/** Parses and validates one document text; parents are the names of the documents that use it. */
function parseText(text: string, context: ParseContext, parents: readonly string[]): Parsed {
  const empty: IDocument = { name: '', uses: [], tables: [], diagrams: [], closing: [], failed: new Set(), constraints: new Map() };
  if (utf8Length(text) > MAX_BYTES) {
    const diagnostics: RawDiagnostic[] = [{ rule: 'limit', line: 1, column: 1, message: 'a document has at most 32 MiB' }];
    return { diagnostics, document: empty, parser: null };
  }
  const raw = text.split('\n');
  const encoding = encodingError(raw);
  if (encoding !== null) return { diagnostics: [encoding], document: empty, parser: null };
  const lines = raw.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const parser = new DocumentParser(lines, context, parents);
  parser.parse();
  if (!parser.halted) parser.validate();
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

/** The document of a text and its declared document set, or every diagnostic in source order. */
export function parseDocument(
  text: string,
  documents: Readonly<Record<string, string>>,
): { document: DbspecDocument | null; diagnostics: RawDiagnostic[] } {
  const parsed = parseText(text, { documents, cache: new Map() }, []);
  if (parsed.diagnostics.length > 0 || parsed.parser === null) return { document: null, diagnostics: parsed.diagnostics };
  return { document: parsed.parser.build(), diagnostics: [] };
}
