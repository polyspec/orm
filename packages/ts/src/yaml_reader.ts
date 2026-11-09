import type { CodecValue } from './codec.js';

/**
 * The YAML reader of orm (docs/spec/codec.md COD-74 to COD-80): it accepts a stream exactly when the productions of
 * chapters 5 to 9 of YAML 1.2.2 hold it and the stream holds one document, and returns the value of that document by the
 * core schema (10.3.2) in the value model of COD-29. A number in brackets names the production of YAML 1.2.2 of that
 * number. The reader reads the stream once, in its order, and throws the first error it meets (COD-80): the error of the
 * caller for a rule of COD-70, met where its node starts, and a YamlSyntaxError, which names the line and the column,
 * where the stream leaves the grammar.
 *
 * The productions are read by generators that a loop of its own drives (run), each one on a stack in the heap, so that no
 * nesting of the stream and no depth of the caller's stack decides where the reader fails: it reads 256 levels and refuses
 * a list or a map at level 257 by the rule of COD-70, whatever stack the caller left.
 */

/** The error of the reader where the stream leaves the grammar (COD-80): its line and column count from 1, the column in
 * Unicode characters, the byte order mark not counted. */
export class YamlSyntaxError extends Error {
  public constructor(public readonly line: number, public readonly column: number) {
    super(`the stream leaves the YAML 1.2.2 grammar at line ${line}, column ${column}`);
  }
}

/**
 * The value of a YAML stream, its byte order mark removed and its stream rules met (COD-75). A rule of COD-70 that the
 * stream breaks is the error that `refuse` returns for its text after `yaml: `.
 */
export function readYaml(stream: string, refuse: (rule: string) => Error): CodecValue {
  return new Reader(stream, refuse).read();
}

/** The nesting that every value stage reads (COD-70). */
const MAX_LEVELS = 256;
/** The characters of an implicit key from its first character to its `:` (COD-76, COD-77). */
const MAX_KEY = 1024;

/** The contexts of YAML 1.2.2 (4.1) that the reader reads in. */
type Context = 'block-in' | 'block-out' | 'flow-out' | 'flow-in' | 'block-key' | 'flow-key';

/** A production read by run: it yields the productions it holds and receives the value of each. */
type Task = Generator<Task, CodecValue, CodecValue>;

/** Reads a production and the productions it holds on a stack in the heap, and returns its value. */
function run(task: Task): CodecValue {
  const stack: Task[] = [task];
  let sent: CodecValue = null;
  for (;;) {
    const top = stack.at(-1);
    if (top === undefined) throw new Error('the reader has no production to read');
    const step = top.next(sent);
    if (step.done === true) {
      stack.pop();
      if (stack.length === 0) return step.value;
      sent = step.value;
    } else {
      stack.push(step.value);
      sent = null;
    }
  }
}

const isWhite = (ch: string): boolean => ch === ' ' || ch === '\t';
const isBreakOrEnd = (ch: string): boolean => ch === '\n' || ch === '';
const isWhiteOrEnd = (ch: string): boolean => isWhite(ch) || isBreakOrEnd(ch);
/** `c-flow-indicator` [23]. */
const isFlowIndicator = (ch: string): boolean => ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}';
/** `ns-char` [34]: the stream holds only c-printable characters (COD-66), and a byte order mark after the start is refused. */
const isNsChar = (ch: string): boolean => ch !== '' && !isWhite(ch) && ch !== '\n';
/** `c-indicator` [22]. */
const INDICATORS = new Set(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`']);
const isFlowContext = (ctx: Context): boolean => ctx === 'flow-in' || ctx === 'flow-key';
const isKeyContext = (ctx: Context): boolean => ctx === 'block-key' || ctx === 'flow-key';
/** `ns-word-char` [38]. */
const isWordChar = (ch: string): boolean => /^[0-9A-Za-z-]$/u.test(ch);
const isHex = (ch: string): boolean => /^[0-9A-Fa-f]$/u.test(ch);
/** `ns-uri-char` [39] without the escape `%`, which uriChars reads. */
const isUriChar = (ch: string): boolean => isWordChar(ch) || "#;/?:@&=+$,_.!~*'()[]".includes(ch) && ch !== '';
/** `ns-tag-char` [40] without the escape `%`. */
const isTagChar = (ch: string): boolean => isUriChar(ch) && ch !== '!' && !isFlowIndicator(ch);

/** The escapes of a double-quoted scalar that stand for one character (5.7, COD-78). */
const ESCAPES = new Map([
  ['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['\t', '\t'], ['n', '\n'], ['v', '\v'], ['f', '\f'], ['r', '\r'],
  ['e', '\x1b'], [' ', ' '], ['"', '"'], ['/', '/'], ['\\', '\\'], ['N', '\x85'], ['_', '\xa0'], ['L', ' '], ['P', ' '],
]);
/** The escapes of a double-quoted scalar followed by the hex digits of a code point, by their number of digits. */
const HEX_ESCAPES = new Map([['x', 2], ['u', 4], ['U', 8]]);

// The core schema (10.3.2) by its regular expressions, each matched against the whole text of a plain scalar (COD-79).
const CORE_NULL = /^(?:null|Null|NULL|~|)$/u;
const CORE_TRUE = /^(?:true|True|TRUE)$/u;
const CORE_FALSE = /^(?:false|False|FALSE)$/u;
const CORE_INT = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/u;
const CORE_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/u;
const CORE_INFINITY = /^[-+]?(?:\.inf|\.Inf|\.INF)$/u;
const CORE_NAN = /^(?:\.nan|\.NaN|\.NAN)$/u;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** The members of a map in the order of the stream; a key such as `__proto__` is an own member. */
function setMember(members: { [key: string]: CodecValue }, key: string, value: CodecValue): void {
  Object.defineProperty(members, key, { value, enumerable: true, writable: true, configurable: true });
}

class Reader {
  /** The characters of the stream, each line break one LF (COD-75). */
  private readonly c: string[];
  private readonly len: number;
  /** The line and the column of each place of the stream, each from 0. */
  private readonly lines: Int32Array;
  private readonly columns: Int32Array;
  /** The place of the next character. */
  private p = 0;
  /** The end of what the reader reads: the stream, or the 1025 characters of a read ahead for an implicit key. */
  private limit: number;
  /** Whether the reader reads ahead over a node for its `:`: it then meets no rule of a node and builds no value. */
  private dry = false;
  /** Whether the last node of a read ahead was a JSON-like node, a flow collection or a quoted scalar, after its properties. */
  private dryJson = false;

  public constructor(stream: string, private readonly refuse: (rule: string) => Error) {
    // CR LF and CR are each one line break, and inside scalar content one LF (COD-75).
    this.c = Array.from(stream.replace(/\r\n?/gu, '\n'));
    this.len = this.c.length;
    this.limit = this.len;
    this.lines = new Int32Array(this.len + 1);
    this.columns = new Int32Array(this.len + 1);
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i <= this.len; i++) {
      this.lines[i] = line;
      this.columns[i] = i - lineStart;
      if (this.c[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }
  }

  /** The integer of a plain scalar that CORE_INT matched: decimal with a sign and leading zeros, octal or hexadecimal. */
  private coreInteger(text: string): bigint {
    const value = text.startsWith('0o') || text.startsWith('0x') ? BigInt(text) : BigInt(text.replace(/^\+/u, ''));
    if (value < I64_MIN || value > I64_MAX) throw this.refuse('integer is outside the i64 range');
    return value;
  }

  /** The value of a plain scalar by the core schema (COD-79). */
  private plainValue(text: string): CodecValue {
    if (CORE_NULL.test(text)) return null;
    if (CORE_TRUE.test(text)) return true;
    if (CORE_FALSE.test(text)) return false;
    if (CORE_INT.test(text)) return this.coreInteger(text);
    if (CORE_FLOAT.test(text)) {
      // Number reads a decimal text as the binary64 nearest to its exact value, a tie to the even one.
      const value = Number(text);
      if (!Number.isFinite(value)) throw this.refuse('number is not finite');
      return value;
    }
    if (CORE_INFINITY.test(text) || CORE_NAN.test(text)) throw this.refuse('number is not finite');
    return text;
  }

  /** The key of a plain scalar (COD-79): an integer is its decimal text, and a null, a bool or a float is no key. */
  private plainKey(text: string): string {
    if (CORE_NULL.test(text) || CORE_TRUE.test(text) || CORE_FALSE.test(text)) throw this.refuse('map keys must be strings or integers');
    if (CORE_INT.test(text)) return this.coreInteger(text).toString();
    if (CORE_FLOAT.test(text) || CORE_INFINITY.test(text) || CORE_NAN.test(text)) throw this.refuse('map keys must be strings or integers');
    return text;
  }

  /** A key already read in its map is the rule yaml-duplicate, met at the key that repeats it (COD-70). */
  private addKey(seen: Set<string>, key: string): void {
    if (seen.has(key)) throw this.refuse('duplicate map key');
    seen.add(key);
  }

  /** The error of the reader at the place `at`, where the stream leaves the grammar (COD-80). */
  private leave(at: number): YamlSyntaxError {
    const i = Math.min(at, this.len);
    return new YamlSyntaxError((this.lines[i] ?? 0) + 1, (this.columns[i] ?? 0) + 1);
  }

  /** The character at `i`, or '' at the end of what the reader reads. */
  private at(i: number): string {
    return i < this.limit ? (this.c[i] ?? '') : '';
  }

  private col(i: number): number {
    return this.columns[Math.min(i, this.len)] ?? 0;
  }

  private slice(from: number, to: number): string {
    return this.c.slice(from, to).join('');
  }

  private skipWhite(i: number): number {
    while (isWhite(this.at(i))) i++;
    return i;
  }

  private spaces(i: number): number {
    let k = 0;
    while (this.at(i + k) === ' ') k++;
    return k;
  }

  /** A document marker, `---` or `...` at the start of a line before white space, a line break or the end (`c-forbidden` [206]). */
  private isMarker(i: number): boolean {
    if (this.col(i) !== 0) return false;
    const ch = this.at(i);
    return (ch === '-' || ch === '.') && this.at(i + 1) === ch && this.at(i + 2) === ch && isWhiteOrEnd(this.at(i + 3));
  }

  /** A `#` that starts a comment: one that starts a line or follows white space ([75]). */
  private commentAt(i: number): boolean {
    return this.at(i) === '#' && (this.col(i) === 0 || isWhite(this.at(i - 1)));
  }

  /** The line break or the end of the stream after white space and a comment from `i` (`s-b-comment` [77]), or -1. */
  private commentEnd(i: number): number {
    let q = this.skipWhite(i);
    if (this.commentAt(q)) while (!isBreakOrEnd(this.at(q))) q++;
    return isBreakOrEnd(this.at(q)) ? q : -1;
  }

  /** The start of the first line from the line start `i` that is not a comment line or a line of white space (`l-comment` [78]). */
  private skipCommentLines(i: number): number {
    while (i < this.len && !this.isMarker(i)) {
      const e = this.commentEnd(i);
      if (e < 0) return i;
      i = e < this.len ? e + 1 : e;
    }
    return i;
  }

  /** The start of the next content line after the rest of the line from `i` and the comment lines (`s-l-comments` [79]), or -1. */
  private lineComments(i: number): number {
    const e = this.commentEnd(i);
    if (e < 0) return -1;
    return this.skipCommentLines(e < this.len ? e + 1 : e);
  }

  /**
   * The place after `s-separate(n,c)` [80] from `i`, or -1 where nothing separates. In a key context it is white space on
   * the line; elsewhere it may span comment lines, and the line after them is indented by n spaces (`s-flow-line-prefix`
   * [69]): a marker or a line indented less leaves the grammar there, since only a flow collection or a flow scalar reads on.
   */
  private separate(n: number, ctx: Context, i: number): number {
    const q = this.skipWhite(i);
    const lineEnds = isBreakOrEnd(this.at(q)) || this.commentAt(q);
    if (isKeyContext(ctx) || !lineEnds) return q > i ? q : -1;
    const e = this.lineComments(i);
    if (e >= this.len) return e;
    if (this.isMarker(e)) throw this.leave(e);
    const k = this.spaces(e);
    if (k < n) throw this.leave(e + k);
    return this.skipWhite(e + n);
  }

  /** Moves past an optional `s-separate(n,c)`. */
  private optionalSeparate(n: number, ctx: Context): void {
    const q = this.separate(n, ctx, this.p);
    if (q >= 0) this.p = q;
  }

  /** `ns-plain-safe(c)` [129]. */
  private isPlainSafe(ch: string, ctx: Context): boolean {
    return isNsChar(ch) && !(isFlowContext(ctx) && isFlowIndicator(ch));
  }

  /** `ns-plain-first(c)` [126] at `i`. */
  private isPlainFirst(i: number, ctx: Context): boolean {
    const ch = this.at(i);
    if (!isNsChar(ch)) return false;
    if (!INDICATORS.has(ch)) return true;
    return (ch === '-' || ch === '?' || ch === ':') && this.isPlainSafe(this.at(i + 1), ctx);
  }

  /** `ns-plain-char(c)` [130] at `i`. */
  private isPlainChar(i: number, ctx: Context): boolean {
    const ch = this.at(i);
    if (ch === ':') return this.isPlainSafe(this.at(i + 1), ctx);
    if (ch === '#') return isNsChar(this.at(i - 1));
    return this.isPlainSafe(ch, ctx);
  }

  /** The end of the text of a plain scalar on its line from its first character at `i` (`nb-ns-plain-in-line` [132]). */
  private plainLineEnd(i: number, ctx: Context): number {
    let e = i + 1;
    for (;;) {
      const j = this.skipWhite(e);
      if (!this.isPlainChar(j, ctx)) return e;
      e = j + 1;
    }
  }

  /** Meets the rules of a list or a map where it starts: its nesting rule, then the rule of a key that is a collection. */
  private collectionStart(level: number, key: boolean): void {
    if (this.dry) return;
    if (level > MAX_LEVELS) throw this.refuse('value nesting exceeds 256 levels');
    if (key) throw this.refuse('map keys must be scalar strings');
  }

  /** The value of an empty node (`e-node` [106]), a null, which is no key (COD-79). */
  private emptyNode(key: boolean): CodecValue {
    if (key && !this.dry) throw this.refuse('map keys must be strings or integers');
    return null;
  }

  /** The key that a key node returned: a string, or a null in a read ahead. */
  private keyName(value: CodecValue): string {
    if (this.dry) return '';
    if (typeof value !== 'string') throw new Error('a key node of the reader returned no string');
    return value;
  }

  /**
   * Whether the node at `s` is an implicit key: a node on one line, followed on that line by `:` within 1024 characters
   * from its first character, and after a plain key by white space, a line break, the end, or in a flow sequence a flow
   * indicator (COD-76, COD-77, [154], [155]). The reader reads ahead over the node, meeting no rule; a node over which the
   * read ahead leaves the grammar is no key (COD-80).
   */
  private implicitKeyAt(s: number, ctx: 'block-key' | 'flow-key'): boolean {
    const saved = { p: this.p, limit: this.limit };
    this.dry = true;
    this.limit = Math.min(this.len, s + MAX_KEY + 1);
    this.p = s;
    let colon = -1;
    let json = false;
    try {
      run(this.flowNode(0, ctx, 0, true));
      const q = this.skipWhite(this.p);
      if (q - s <= MAX_KEY && this.at(q) === ':') {
        colon = q;
        json = this.dryJson;
      }
    } catch (error) {
      if (!(error instanceof YamlSyntaxError)) throw error;
      // The read ahead left the grammar inside the node, so the node is no key.
      colon = -1;
    } finally {
      this.dry = false;
      this.limit = saved.limit;
      this.p = saved.p;
    }
    if (colon < 0) return false;
    const next = this.at(colon + 1);
    if (ctx === 'flow-key') return json || !this.isPlainSafe(next, 'flow-in');
    return isWhiteOrEnd(next);
  }

  /** The value of the stream: its one document (COD-75). */
  public read(): CodecValue {
    let p = this.skipPrefix(0);
    if (p >= this.len) throw this.refuse('no document');
    if (this.at(p) === '%') p = this.directives(p);
    else if (this.isMarker(p) && this.at(p) === '-') p += 3;
    this.p = p;
    const value = run(this.blockNode(-1, 'block-in', 1, false));
    p = this.skipCommentLines(this.p);
    while (p < this.len) {
      if (!this.isMarker(p)) throw this.leave(p);
      // A second document is met where it starts: at its `---`, or after a `...` at its first character (COD-75).
      if (this.at(p) === '-') throw this.refuse('multiple documents are not supported');
      const e = this.commentEnd(p + 3);
      if (e < 0) throw this.leave(this.skipWhite(p + 3));
      p = this.skipCommentLines(e < this.len ? e + 1 : e);
      if (p < this.len && !(this.isMarker(p) && this.at(p) === '.')) throw this.refuse('multiple documents are not supported');
    }
    return value;
  }

  /** The start of the first document after comment lines and document end markers (`l-document-prefix` [202]). */
  private skipPrefix(p: number): number {
    for (;;) {
      p = this.skipCommentLines(p);
      if (!(this.isMarker(p) && this.at(p) === '.')) return p;
      const e = this.commentEnd(p + 3);
      if (e < 0) throw this.leave(this.skipWhite(p + 3));
      p = e < this.len ? e + 1 : e;
    }
  }

  /**
   * The directives of a document and its `---` (`l-directive-document` [209]), returning the place after the `---`: one
   * `%YAML 1.2`, `%TAG` directives of distinct handles, and no other directive (COD-75).
   */
  private directives(p: number): number {
    let version = false;
    const handles = new Set<string>();
    for (;;) {
      let i = p + 1;
      while (isNsChar(this.at(i))) i++;
      const name = this.slice(p + 1, i);
      if (name === 'YAML') {
        if (version) throw this.leave(p);
        version = true;
        i = this.directiveSeparate(i);
        const major = i;
        while (/^[0-9]$/u.test(this.at(i))) i++;
        const majorText = this.slice(major, i);
        if (majorText === '' || this.at(i) !== '.') throw this.leave(i);
        const minor = ++i;
        while (/^[0-9]$/u.test(this.at(i))) i++;
        const minorText = this.slice(minor, i);
        if (minorText === '') throw this.leave(i);
        if (majorText.replace(/^0+(?=.)/u, '') !== '1' || minorText.replace(/^0+(?=.)/u, '') !== '2') throw this.leave(major);
      } else if (name === 'TAG') {
        i = this.directiveSeparate(i);
        const handle = i;
        i = this.tagHandle(i);
        const handleText = this.slice(handle, i);
        if (handles.has(handleText)) throw this.leave(handle);
        handles.add(handleText);
        i = this.directiveSeparate(i);
        // `ns-tag-prefix` [93]: a local prefix `!` with URI characters, or a global one that starts with a tag character.
        const prefix = i;
        if (this.at(i) === '!') i = this.uriChars(i + 1);
        else {
          i = this.uriChars(i, true);
          if (i === prefix) throw this.leave(i);
          i = this.uriChars(i);
        }
      } else {
        throw this.leave(p);
      }
      const e = this.commentEnd(i);
      if (e < 0 || !isWhiteOrEnd(this.at(i))) throw this.leave(i);
      p = this.skipCommentLines(e < this.len ? e + 1 : e);
      if (this.at(p) === '%') continue;
      if (this.isMarker(p) && this.at(p) === '-') return p + 3;
      throw this.leave(p);
    }
  }

  /** The white space between the parts of a directive. */
  private directiveSeparate(i: number): number {
    const q = this.skipWhite(i);
    if (q === i) throw this.leave(i);
    return q;
  }

  /** The end of a tag handle at `i` (`c-tag-handle` [89]): `!`, `!!` or `!word!`. */
  private tagHandle(i: number): number {
    if (this.at(i) !== '!') throw this.leave(i);
    let j = i + 1;
    while (isWordChar(this.at(j))) j++;
    if (this.at(j) === '!') return j + 1;
    if (j === i + 1) return j;
    throw this.leave(j);
  }

  /** The end of URI characters from `i`, each `%` followed by two hex digits; with `first`, at most one tag character. */
  private uriChars(i: number, first = false): number {
    for (;;) {
      const ch = this.at(i);
      if (ch === '%') {
        if (!isHex(this.at(i + 1)) || !isHex(this.at(i + 2))) throw this.leave(i);
        i += 3;
      } else if (first ? isTagChar(ch) : isUriChar(ch)) {
        i++;
      } else {
        return i;
      }
      if (first) return i;
    }
  }

  /** The end of tag characters from `i` (`ns-tag-char` [40] and its escapes). */
  private tagChars(i: number): number {
    for (;;) {
      const ch = this.at(i);
      if (ch === '%') {
        if (!isHex(this.at(i + 1)) || !isHex(this.at(i + 2))) throw this.leave(i);
        i += 3;
      } else if (isTagChar(ch)) {
        i++;
      } else {
        return i;
      }
    }
  }

  /**
   * `s-l+block-node(n,c)` [196] at this.p, which is a line start, the start of the document, or the place right after an
   * indicator or a `---`; it returns at the start of the next content line or the end of the stream.
   */
  private *blockNode(n: number, ctx: 'block-in' | 'block-out', level: number, key: boolean): Task {
    if (this.col(this.p) !== 0) {
      const q = this.skipWhite(this.p);
      if (!(isBreakOrEnd(this.at(q)) || this.commentAt(q))) {
        // A node on the line of its indicator: a block scalar or a flow node, never a block collection ([200]).
        this.p = q;
        return yield this.lineNode(n, level, key);
      }
      this.p = this.lineComments(this.p);
    }
    const p = this.p;
    if (p >= this.len || this.isMarker(p)) return this.emptyNode(key);
    const k = this.spaces(p);
    const s = p + k;
    const ch = this.at(s);
    // A block sequence more indented than its parent, or at the indentation of the key whose value it is (`seq-space` [201]).
    if (ch === '-' && isWhiteOrEnd(this.at(s + 1)) && (k > n || (ctx === 'block-out' && k === n))) {
      this.collectionStart(level, key);
      this.p = s;
      return yield this.blockSequence(k, level);
    }
    if (k > n && (((ch === '?' || ch === ':') && isWhiteOrEnd(this.at(s + 1))) || this.implicitKeyAt(s, 'block-key'))) {
      this.collectionStart(level, key);
      this.p = s;
      return yield this.blockMapping(k, level);
    }
    // A block scalar or a flow node after `s-separate(n+1,c)` [80], on a line indented by n + 1 spaces.
    if (k >= n + 1) {
      this.p = this.skipWhite(p + n + 1);
      return yield this.lineNode(n, level, key);
    }
    return this.emptyNode(key);
  }

  /** A block scalar or a flow node in a block (`s-l+flow-in-block(n)` [197]) at this.p, then the comments after it. */
  private *lineNode(n: number, level: number, key: boolean): Task {
    const ch = this.at(this.p);
    if (ch === '|' || ch === '>') {
      const value = this.blockScalar(n, ch === '>');
      this.p = this.skipCommentLines(this.p);
      return value;
    }
    const value = yield this.flowNode(n + 1, 'flow-out', level, key);
    const e = this.lineComments(this.p);
    if (e < 0) throw this.leave(this.skipWhite(this.p));
    this.p = e;
    return value;
  }

  /**
   * `s-l+block-indented(n,c)` [185] right after the indicator `-`, `?` or `:`: a compact sequence or a compact mapping on
   * that line after spaces, or a block node.
   */
  private *blockIndented(n: number, ctx: 'block-in' | 'block-out', level: number, key: boolean): Task {
    const m = this.spaces(this.p);
    const s = this.p + m;
    const ch = this.at(s);
    if (m > 0) {
      if (ch === '-' && isWhiteOrEnd(this.at(s + 1))) {
        this.collectionStart(level, key);
        this.p = s;
        return yield this.blockSequence(this.col(s), level);
      }
      if (((ch === '?' || ch === ':') && isWhiteOrEnd(this.at(s + 1))) || this.implicitKeyAt(s, 'block-key')) {
        this.collectionStart(level, key);
        this.p = s;
        return yield this.blockMapping(this.col(s), level);
      }
    }
    return yield this.blockNode(n, ctx, level, key);
  }

  /** Whether the line at this.p holds an entry of a block collection at column `col` that starts with `ch` (or any ns-char). */
  private entryAt(col: number, sequence: boolean): boolean {
    const p = this.p;
    if (p >= this.len || this.isMarker(p) || this.spaces(p) !== col) return false;
    const ch = this.at(p + col);
    return sequence ? ch === '-' && isWhiteOrEnd(this.at(p + col + 1)) : isNsChar(ch);
  }

  /** `l+block-sequence` [183] and `ns-l-compact-sequence` [186]: entries at column `col`, this.p at the first `-`. */
  private *blockSequence(col: number, level: number): Task {
    const items: CodecValue[] = [];
    for (;;) {
      this.p += 1;
      const item = yield this.blockIndented(col, 'block-in', level + 1, false);
      if (!this.dry) items.push(item);
      if (!this.entryAt(col, true)) return items;
      this.p += col;
    }
  }

  /** `l+block-mapping` [187] and `ns-l-compact-mapping` [195]: entries at column `col`, this.p at the first one. */
  private *blockMapping(col: number, level: number): Task {
    const members: { [key: string]: CodecValue } = {};
    const seen = new Set<string>();
    for (;;) {
      const s = this.p;
      const ch = this.at(s);
      let name: string;
      let value: CodecValue = null;
      if (ch === '?' && isWhiteOrEnd(this.at(s + 1))) {
        // An explicit entry ([189] to [191]): its key, then a value after a `:` that starts a line at its indentation.
        this.p = s + 1;
        name = this.keyName(yield this.blockIndented(col, 'block-out', level + 1, true));
        this.addKey(seen, name);
        const q = this.p;
        if (q < this.len && !this.isMarker(q) && this.spaces(q) === col && this.at(q + col) === ':' && isWhiteOrEnd(this.at(q + col + 1))) {
          this.p = q + col + 1;
          value = yield this.blockIndented(col, 'block-out', level + 1, false);
        }
      } else {
        if (ch === ':' && isWhiteOrEnd(this.at(s + 1))) {
          // An empty key is the empty plain scalar, a null, which is no key (COD-76).
          throw this.refuse('map keys must be strings or integers');
        }
        if (!this.implicitKeyAt(s, 'block-key')) {
          // No key: the rules of the nodes of the line are met in their order before the place where it leaves the grammar.
          yield this.flowNode(0, 'block-key', level + 1, false);
          throw this.leave(this.p);
        }
        name = this.keyName(yield this.flowNode(0, 'block-key', level + 1, true));
        this.addKey(seen, name);
        this.p = this.skipWhite(this.p) + 1;
        value = yield this.blockNode(col, 'block-out', level + 1, false);
      }
      setMember(members, name, value);
      if (!this.entryAt(col, false)) return members;
      this.p += col;
    }
  }

  /** `ns-flow-node(n,c)` [161] at this.p, which is its first character: a key returns its string (COD-79). */
  private *flowNode(n: number, ctx: Context, level: number, key: boolean): Task {
    const s = this.p;
    const ch = this.at(s);
    if (ch === '&' || ch === '!' || ch === '*') {
      // A property or an alias is its rule where a node may start, whatever follows it (COD-79).
      if (!this.dry) throw this.refuse(ch === '&' ? 'anchors are not supported' : ch === '!' ? 'explicit tags are not supported' : 'aliases are not supported');
      return yield this.dryProperties(n, ctx);
    }
    if (ch === '[' || ch === '{') {
      this.collectionStart(level, key);
      const value = yield ch === '[' ? this.flowSequence(n, ctx, level) : this.flowMapping(n, ctx, level);
      this.dryJson = true;
      return value;
    }
    if (ch === "'" || ch === '"') {
      const value = ch === "'" ? this.singleQuoted(n, ctx) : this.doubleQuoted(n, ctx);
      this.dryJson = true;
      return value;
    }
    if (!this.isPlainFirst(s, ctx)) throw this.leave(s);
    const text = this.plain(n, ctx);
    this.dryJson = false;
    if (this.dry) return null;
    return key ? this.plainKey(text) : this.plainValue(text);
  }

  /**
   * The properties of a node and its content in a read ahead, which reads them by their grammar ([96] to [104]): an alias,
   * or a tag and an anchor in either order, then the content after white space or an empty node.
   */
  private *dryProperties(n: number, ctx: Context): Task {
    if (this.at(this.p) === '*') {
      this.p = this.anchorName(this.p + 1);
      this.dryJson = false;
      return null;
    }
    const first = this.at(this.p);
    this.p = first === '!' ? this.tag(this.p) : this.anchorName(this.p + 1);
    const between = this.separate(n, ctx, this.p);
    const second = first === '!' ? '&' : '!';
    if (between >= 0 && this.at(between) === second) this.p = second === '!' ? this.tag(between) : this.anchorName(between + 1);
    const q = this.separate(n, ctx, this.p);
    const ch = this.at(q);
    if (q >= 0 && (ch === '[' || ch === '{' || ch === "'" || ch === '"' || this.isPlainFirst(q, ctx))) {
      this.p = q;
      return yield this.flowNode(n, ctx, 0, false);
    }
    this.dryJson = false;
    return null;
  }

  /** The end of an anchor name from `i` (`ns-anchor-name` [103]), one character at least. */
  private anchorName(i: number): number {
    let j = i;
    while (isNsChar(this.at(j)) && !isFlowIndicator(this.at(j))) j++;
    if (j === i) throw this.leave(i);
    return j;
  }

  /** The end of a tag at `i` (`c-ns-tag-property` [97]): verbatim, a shorthand, or the non-specific `!`. */
  private tag(i: number): number {
    if (this.at(i + 1) === '<') {
      const j = this.uriChars(i + 2);
      if (j === i + 2 || this.at(j) !== '>') throw this.leave(j);
      return j + 1;
    }
    let j = i + 1;
    while (isWordChar(this.at(j))) j++;
    if (this.at(j) === '!') {
      const end = this.tagChars(j + 1);
      if (end === j + 1) throw this.leave(end);
      return end;
    }
    return this.tagChars(i + 1);
  }

  /** `c-flow-sequence(n,c)` [137] at its `[`. */
  private *flowSequence(n: number, ctx: Context, level: number): Task {
    const inner: Context = isKeyContext(ctx) ? 'flow-key' : 'flow-in';
    const items: CodecValue[] = [];
    this.p += 1;
    this.optionalSeparate(n, inner);
    for (;;) {
      const ch = this.at(this.p);
      if (ch === ']') break;
      if (ch === ',' || ch === '') throw this.leave(this.p);
      const item = yield this.flowSequenceEntry(n, inner, level + 1);
      if (!this.dry) items.push(item);
      this.optionalSeparate(n, inner);
      const next = this.at(this.p);
      if (next === ']') break;
      if (next !== ',') throw this.leave(this.p);
      this.p += 1;
      this.optionalSeparate(n, inner);
    }
    this.p += 1;
    return this.dry ? null : items;
  }

  /**
   * `ns-flow-seq-entry(n,c)` [139]: a flow pair, a map of one pair at `level` ([150]), or a flow node. A pair starts with
   * `?`, with an empty key, or with an implicit key, which the reader reads ahead for; a read ahead takes a node followed by
   * a `:` as a pair, since its key holds no implicit key that a rule would meet.
   */
  private *flowSequenceEntry(n: number, ctx: Context, level: number): Task {
    const s = this.p;
    const ch = this.at(s);
    const members: { [key: string]: CodecValue } = {};
    if (ch === '?' && (isWhite(this.at(s + 1)) || this.at(s + 1) === '\n')) {
      this.collectionStart(level, false);
      this.p = s + 1;
      this.optionalSeparate(n, ctx);
      const entry = yield this.flowMapExplicitEntry(n, ctx, level, members, new Set());
      return this.dry ? null : entry;
    }
    if (ch === ':' && !this.isPlainSafe(this.at(s + 1), ctx)) {
      this.collectionStart(level, false);
      return yield this.flowMapImplicitEntry(n, ctx, level, members, new Set());
    }
    if (this.dry) {
      yield this.flowNode(n, ctx, level, false);
      const json = this.dryJson;
      const q = this.skipWhite(this.p);
      if (this.at(q) === ':' && (json || !this.isPlainSafe(this.at(q + 1), ctx))) {
        this.p = q + 1;
        yield this.flowValue(n, ctx, level + 1, json);
      }
      return null;
    }
    if (!this.implicitKeyAt(s, 'flow-key')) return yield this.flowNode(n, ctx, level, false);
    this.collectionStart(level, false);
    const json = this.isJsonStart(s);
    const name = this.keyName(yield this.flowNode(n, 'flow-key', level + 1, true));
    this.p = this.skipWhite(this.p) + 1;
    setMember(members, name, yield this.flowValue(n, ctx, level + 1, json));
    return members;
  }

  /** Whether the node at `s` is a JSON-like node, a flow collection or a quoted scalar. */
  private isJsonStart(s: number): boolean {
    const ch = this.at(s);
    return ch === '[' || ch === '{' || ch === "'" || ch === '"';
  }

  /**
   * The value after the `:` of a flow entry (`c-ns-flow-map-separate-value` [147], `c-ns-flow-map-adjacent-value` [149]):
   * a node after white space, or after a JSON-like key also adjacent to the `:`, or an empty node.
   */
  private *flowValue(n: number, ctx: Context, level: number, json: boolean): Task {
    const q = this.separate(n, ctx, this.p);
    if (q >= 0) this.p = q;
    const ch = this.at(this.p);
    if (ch === ',' || ch === ']' || ch === '}' || ch === '' || (q < 0 && !json)) return null;
    return yield this.flowNode(n, ctx, level, false);
  }

  /** `ns-flow-map-explicit-entry(n,c)` [143] after `?`: an implicit entry, or an empty key and an empty value. */
  private *flowMapExplicitEntry(n: number, ctx: Context, level: number, members: { [key: string]: CodecValue }, seen: Set<string>): Task {
    const ch = this.at(this.p);
    if (ch === ',' || ch === ']' || ch === '}') {
      this.emptyNode(true);
      return members;
    }
    return yield this.flowMapImplicitEntry(n, ctx, level, members, seen);
  }

  /**
   * `ns-flow-map-implicit-entry(n,c)` [144] of the map `members` at `level`: a key, which every node that starts the entry
   * is (COD-80), or an empty key, then a value after `:` or an empty value. The key may span lines as its style allows.
   */
  private *flowMapImplicitEntry(n: number, ctx: Context, level: number, members: { [key: string]: CodecValue }, seen: Set<string>): Task {
    const s = this.p;
    let name: string;
    let json = false;
    if (this.at(s) === ':' && !this.isPlainSafe(this.at(s + 1), ctx)) {
      this.emptyNode(true);
      name = '';
    } else {
      json = this.isJsonStart(s);
      name = this.keyName(yield this.flowNode(n, ctx, level + 1, true));
      if (this.dry) json = this.dryJson;
    }
    if (!this.dry) this.addKey(seen, name);
    const q = this.separate(n, ctx, this.p);
    const colon = q >= 0 ? q : this.p;
    let value: CodecValue = null;
    if (this.at(colon) === ':' && (json || this.p === s || !this.isPlainSafe(this.at(colon + 1), ctx))) {
      this.p = colon + 1;
      value = yield this.flowValue(n, ctx, level + 1, json);
    }
    if (!this.dry) setMember(members, name, value);
    return this.dry ? null : members;
  }

  /** `c-flow-mapping(n,c)` [140] at its `{`. */
  private *flowMapping(n: number, ctx: Context, level: number): Task {
    const inner: Context = isKeyContext(ctx) ? 'flow-key' : 'flow-in';
    const members: { [key: string]: CodecValue } = {};
    const seen = new Set<string>();
    this.p += 1;
    this.optionalSeparate(n, inner);
    for (;;) {
      const ch = this.at(this.p);
      if (ch === '}') break;
      if (ch === ',' || ch === '') throw this.leave(this.p);
      if (ch === '?' && (isWhite(this.at(this.p + 1)) || this.at(this.p + 1) === '\n')) {
        this.p += 1;
        this.optionalSeparate(n, inner);
        yield this.flowMapExplicitEntry(n, inner, level, members, seen);
      } else {
        yield this.flowMapImplicitEntry(n, inner, level, members, seen);
      }
      this.optionalSeparate(n, inner);
      const next = this.at(this.p);
      if (next === '}') break;
      if (next !== ',') throw this.leave(this.p);
      this.p += 1;
      this.optionalSeparate(n, inner);
    }
    this.p += 1;
    return this.dry ? null : members;
  }

  /**
   * A plain scalar ([131] to [135]) at this.p, its first character checked: one line in a key context, else its lines
   * folded (6.5), each next line indented by n spaces, not a marker, and starting with a plain character (COD-78).
   */
  private plain(n: number, ctx: Context): string {
    let end = this.plainLineEnd(this.p, ctx);
    let text = this.slice(this.p, end);
    if (!isKeyContext(ctx)) {
      for (;;) {
        const q = this.skipWhite(end);
        if (this.at(q) !== '\n') break;
        let r = q + 1;
        let empty = 0;
        let next = -1;
        while (r < this.len) {
          const k = this.spaces(r);
          const u = this.skipWhite(r + k);
          if (this.at(u) === '\n' || u >= this.len) {
            // An empty line (`l-empty` [70]): fewer than n spaces, or n spaces and white space.
            if (!(k >= n || u === r + k) || u >= this.len) break;
            empty++;
            r = u + 1;
            continue;
          }
          if (!this.isMarker(r) && k >= n && this.isPlainChar(u, ctx) && this.at(u) !== '#') next = u;
          break;
        }
        if (next < 0) break;
        const lineEnd = this.plainLineEnd(next, ctx);
        text += (empty === 0 ? ' ' : '\n'.repeat(empty)) + this.slice(next, lineEnd);
        end = lineEnd;
      }
    }
    this.p = end;
    return text;
  }

  /**
   * The line break of a flow scalar at `i` and the lines after it: the empty lines (`l-empty` [70]), counted, and the
   * prefix of the next line, indented by n spaces (`s-flow-line-prefix` [69]); a marker, the end of the stream or a line
   * indented less leaves the grammar.
   */
  private flowBreak(i: number, n: number): { at: number; empty: number } {
    let r = i + 1;
    let empty = 0;
    for (;;) {
      if (r >= this.len || this.isMarker(r)) throw this.leave(r);
      const k = this.spaces(r);
      const u = this.skipWhite(r + k);
      if (this.at(u) === '\n') {
        if (!(k >= n || u === r + k)) throw this.leave(r + k);
        empty++;
        r = u + 1;
        continue;
      }
      if (u >= this.len) throw this.leave(u);
      if (k < n) throw this.leave(r + k);
      return { at: u, empty };
    }
  }

  /** `c-single-quoted(n,c)` [120] at its `'`: the escape `''`, and lines folded as a plain scalar's (COD-78). */
  private singleQuoted(n: number, ctx: Context): string {
    let i = this.p + 1;
    let out = '';
    // The length of out without the white space at the end of its line, which a line break removes.
    let keep = 0;
    for (;;) {
      const ch = this.at(i);
      if (ch === '') throw this.leave(i);
      if (ch === "'") {
        if (this.at(i + 1) !== "'") break;
        out += "'";
        keep = out.length;
        i += 2;
      } else if (ch === '\n') {
        if (isKeyContext(ctx)) throw this.leave(i);
        const fold = this.flowBreak(i, n);
        out = out.slice(0, keep) + (fold.empty === 0 ? ' ' : '\n'.repeat(fold.empty));
        keep = out.length;
        i = fold.at;
      } else {
        out += ch;
        if (!isWhite(ch)) keep = out.length;
        i++;
      }
    }
    this.p = i + 1;
    return out;
  }

  /** `c-double-quoted(n,c)` [109] at its `"`: the escapes of 5.7 and lines folded or joined by an escaped break (COD-78). */
  private doubleQuoted(n: number, ctx: Context): string {
    let i = this.p + 1;
    let out = '';
    let keep = 0;
    for (;;) {
      const ch = this.at(i);
      if (ch === '') throw this.leave(i);
      if (ch === '"') break;
      if (ch === '\\') {
        const e = this.at(i + 1);
        if (e === '\n') {
          // An escaped line break (`s-double-escaped` [112]) keeps the white space before it and adds no space.
          if (isKeyContext(ctx)) throw this.leave(i + 1);
          const fold = this.flowBreak(i + 1, n);
          out += '\n'.repeat(fold.empty);
          i = fold.at;
        } else if (ESCAPES.has(e)) {
          out += ESCAPES.get(e) ?? '';
          i += 2;
        } else {
          const digits = HEX_ESCAPES.get(e);
          if (digits === undefined) throw this.leave(i + 1);
          let hex = '';
          for (let d = 0; d < digits; d++) {
            const h = this.at(i + 2 + d);
            if (!isHex(h)) throw this.leave(i + 2 + d);
            hex += h;
          }
          const point = Number.parseInt(hex, 16);
          // A surrogate or a number above U+10FFFF is no Unicode scalar value (COD-78).
          if ((point >= 0xd800 && point <= 0xdfff) || point > 0x10ffff) throw this.leave(i);
          out += String.fromCodePoint(point);
          i += 2 + digits;
        }
        keep = out.length;
      } else if (ch === '\n') {
        if (isKeyContext(ctx)) throw this.leave(i);
        const fold = this.flowBreak(i, n);
        out = out.slice(0, keep) + (fold.empty === 0 ? ' ' : '\n'.repeat(fold.empty));
        keep = out.length;
        i = fold.at;
      } else {
        out += ch;
        if (!isWhite(ch)) keep = out.length;
        i++;
      }
    }
    this.p = i + 1;
    return out;
  }

  /**
   * A literal or folded block scalar ([162] to [182]) at its indicator, whose parent is indented by n spaces: its header,
   * its content indentation, given or detected (8.1.1.1), its lines, and its chomping (8.1.1.2). It returns at the start
   * of the first line that is not part of it.
   */
  private blockScalar(n: number, folded: boolean): string {
    let i = this.p + 1;
    let indicator = 0;
    let chomp: 'strip' | 'clip' | 'keep' = 'clip';
    for (let part = 0; part < 2; part++) {
      const ch = this.at(i);
      if (indicator === 0 && /^[1-9]$/u.test(ch)) indicator = Number(ch);
      else if (chomp === 'clip' && (ch === '-' || ch === '+')) chomp = ch === '-' ? 'strip' : 'keep';
      else break;
      i++;
    }
    const headerEnd = this.commentEnd(i);
    if (headerEnd < 0 || !isWhiteOrEnd(this.at(i))) throw this.leave(i);
    let r = headerEnd < this.len ? headerEnd + 1 : headerEnd;
    let indent: number;
    if (indicator > 0) {
      indent = n + indicator;
    } else {
      // The spaces of the first line that is not empty; a leading empty line with more spaces leaves the grammar.
      let widest = 0;
      let widestAt = r;
      let detected = -1;
      for (let j = r; j < this.len;) {
        const k = this.spaces(j);
        if (this.at(j + k) === '\n') {
          if (k > widest) {
            widest = k;
            widestAt = j + k;
          }
          j = j + k + 1;
          continue;
        }
        if (j + k < this.len) detected = k;
        break;
      }
      if (detected > n) {
        if (widest > detected) throw this.leave(widestAt);
        indent = detected;
      } else {
        indent = Math.max(n + 1, widest);
      }
    }
    const lines: Array<{ text: string | null; broken: boolean }> = [];
    while (r < this.len && !this.isMarker(r)) {
      const k = this.spaces(r);
      let le = r + k;
      while (!isBreakOrEnd(this.at(le))) le++;
      const blank = le === r + k;
      if (blank && k <= indent) {
        // An empty line counts only with its line break.
        if (le >= this.len) break;
        lines.push({ text: null, broken: true });
      } else if (k < indent) {
        break;
      } else {
        lines.push({ text: this.slice(r + indent, le), broken: le < this.len });
      }
      r = le < this.len ? le + 1 : le;
    }
    this.p = r;
    let last = -1;
    lines.forEach((line, index) => {
      if (line.text !== null) last = index;
    });
    let body = '';
    let previous: boolean | null = null;
    let empty = 0;
    for (let j = 0; j <= last; j++) {
      const text = lines[j]?.text ?? null;
      if (text === null) {
        empty++;
        continue;
      }
      if (!folded) {
        body += (previous === null ? '' : '\n') + '\n'.repeat(empty) + text;
      } else {
        // Folding (6.5, [175] to [181]): a break between two lines that start with no white space is a space, or the
        // empty lines after it; around a more-indented line every break is kept.
        const spaced = isWhite(text.charAt(0));
        if (previous === null) body += '\n'.repeat(empty);
        else if (!previous && !spaced) body += empty === 0 ? ' ' : '\n'.repeat(empty);
        else body += '\n' + '\n'.repeat(empty);
        body += text;
      }
      previous = isWhite(text.charAt(0));
      empty = 0;
    }
    const trailing = lines.length - last - 1;
    if (last < 0) return chomp === 'keep' ? '\n'.repeat(trailing) : '';
    const finalBreak = lines[last]?.broken === true ? '\n' : '';
    if (chomp === 'strip') return body;
    if (chomp === 'clip') return body + finalBreak;
    return body + finalBreak + '\n'.repeat(trailing);
  }
}
