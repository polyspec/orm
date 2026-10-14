// The exact JSON of the conformance checker: a parser that keeps each number as its text and refuses a repeated object key,
// a comparison of two values in which numbers are equal when they are the same rational number, and the encoding of
// encoding/json of Go (sorted keys, HTML escapes, two-space indent) in which the vector expectations are recorded. The
// records stay byte for byte what the Go checker wrote, so the recorded files do not change with the port.

/** A JSON number as its text; two numbers are equal when they are the same rational number. */
export class JsonNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** An exact JSON value; an object keeps the order of its keys in the document. */
export type Json = null | boolean | string | JsonNumber | Json[] | JsonObject;
export type JsonObject = Map<string, Json>;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class Parser {
  readonly text: string;
  index = 0;
  constructor(text: string) {
    this.text = text;
  }

  fail(what: string): never {
    throw new Error(`invalid JSON at offset ${this.index}: ${what}`);
  }

  space(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index] ?? '')) this.index++;
  }

  value(): Json {
    this.space();
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(word, this.index)) {
        this.index += word.length;
        return value;
      }
    }
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (!match) this.fail(char === undefined ? 'unexpected end' : `unexpected ${JSON.stringify(char)}`);
    this.index += match[0].length;
    return new JsonNumber(match[0]);
  }

  object(): JsonObject {
    this.index++;
    const object: JsonObject = new Map();
    this.space();
    if (this.text[this.index] === '}') {
      this.index++;
      return object;
    }
    for (;;) {
      this.space();
      if (this.text[this.index] !== '"') this.fail('JSON object key is not text');
      const key = this.string();
      if (object.has(key)) throw new Error(`duplicate JSON object key ${JSON.stringify(key)}`);
      this.space();
      if (this.text[this.index] !== ':') this.fail('expected a colon');
      this.index++;
      object.set(key, this.value());
      this.space();
      const next = this.text[this.index++];
      if (next === '}') return object;
      if (next !== ',') this.fail('expected a comma or the end of the object');
    }
  }

  array(): Json[] {
    this.index++;
    const array: Json[] = [];
    this.space();
    if (this.text[this.index] === ']') {
      this.index++;
      return array;
    }
    for (;;) {
      array.push(this.value());
      this.space();
      const next = this.text[this.index++];
      if (next === ']') return array;
      if (next !== ',') this.fail('expected a comma or the end of the array');
    }
  }

  // string reads a string; like Go, an escaped surrogate that does not form a pair decodes to U+FFFD.
  string(): string {
    this.index++;
    let out = '';
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) this.fail('unterminated string');
      if (char === '"') {
        this.index++;
        return out;
      }
      if (char < ' ') this.fail('control character in a string');
      if (char !== '\\') {
        out += char;
        this.index++;
        continue;
      }
      const escape = this.text[this.index + 1];
      this.index += 2;
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escape !== undefined && escape in simple) {
        out += simple[escape];
        continue;
      }
      if (escape !== 'u') this.fail('invalid escape');
      const unit = this.hex();
      if (unit >= 0xd800 && unit < 0xdc00 && this.text.startsWith('\\u', this.index)) {
        const saved = this.index;
        this.index += 2;
        const low = this.hex();
        if (low >= 0xdc00 && low < 0xe000) {
          out += String.fromCharCode(unit, low);
          continue;
        }
        this.index = saved;
      }
      out += unit >= 0xd800 && unit < 0xe000 ? '�' : String.fromCharCode(unit);
    }
  }

  hex(): number {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail('invalid \\u escape');
    this.index += 4;
    return Number.parseInt(digits, 16);
  }
}

/** decodeExact is the one JSON value of the text; a repeated key, an invalid number or a second value throws. */
export function decodeExact(text: string): Json {
  const parser = new Parser(text);
  const value = parser.value();
  parser.space();
  if (parser.index !== text.length) throw new Error('multiple JSON values');
  return value;
}

// rational is the canonical form of a number: its digits without leading or trailing zeros and the power of ten, so two
// numbers are the same rational number exactly when their forms are equal (big.Rat of Go compares the same way).
function rational(text: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!match) throw new Error(`invalid JSON number ${JSON.stringify(text)}`);
  const fraction = match[3] ?? '';
  let digits = `${match[2] ?? ''}${fraction}`.replace(/^0+/, '');
  if (digits === '') return '0';
  let exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length);
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing);
  exponent += BigInt(trailing);
  return `${match[1]}${digits}e${exponent}`;
}

/** equalValues is whether two exact values are equal: numbers as rationals, objects regardless of key order. */
export function equalValues(left: Json, right: Json): boolean {
  if (left instanceof JsonNumber || right instanceof JsonNumber) {
    return left instanceof JsonNumber && right instanceof JsonNumber && rational(left.text) === rational(right.text);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equalValues(item, right[index] ?? null));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left) {
      const other = right.get(key);
      if (other === undefined || !equalValues(value, other)) return false;
    }
    return true;
  }
  return left === right;
}

/** equalJSON is whether two JSON texts hold equal values; a text that is not exact JSON throws. */
export function equalJSON(left: string, right: string): boolean {
  return equalValues(decodeExact(left), decodeExact(right));
}

// byteOrder sorts keys as Go sorts the keys of a map: by the bytes of their UTF-8 encoding.
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

// quote encodes a string as encoding/json does: the HTML characters <, > and & and the line separators U+2028 and U+2029
// are escaped, control characters use \b, \f, \n, \r, \t or \u00XX.
export function quote(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20 || char === '<' || char === '>' || char === '&' || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code >= 0xd800 && code < 0xe000) out += '\\ufffd';
    else out += char;
  }
  return `${out}"`;
}

/**
 * encode writes a value as encoding/json does: `indent` set gives the form of MarshalIndent with that indent, otherwise
 * the compact form; `sorted` orders object keys by bytes as a Go map does, otherwise the document order stays (a
 * json.RawMessage).
 */
export function encode(value: Json, { indent, sorted }: { indent?: string; sorted: boolean }, depth = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return quote(value);
  if (value instanceof JsonNumber) return value.text;
  const inner = indent === undefined ? '' : `\n${indent.repeat(depth + 1)}`;
  const outer = indent === undefined ? '' : `\n${indent.repeat(depth)}`;
  const colon = indent === undefined ? ':' : ': ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map(item => `${inner}${encode(item, { ...(indent === undefined ? {} : { indent }), sorted }, depth + 1)}`).join(',')}${outer}]`;
  }
  if (value.size === 0) return '{}';
  const keys = [...value.keys()];
  if (sorted) keys.sort(byteOrder);
  return `{${keys.map(key => `${inner}${quote(key)}${colon}${encode(value.get(key) ?? null, { ...(indent === undefined ? {} : { indent }), sorted }, depth + 1)}`).join(',')}${outer}}`;
}

/** canon re-encodes JSON text with sorted keys, a two-space indent and unchanged number text; invalid JSON throws. */
export function canon(text: string): string {
  return encode(decodeExact(text), { indent: '  ', sorted: true });
}

/** compact writes a value on one line with sorted keys. */
export function compact(value: Json | undefined): string {
  return value === undefined ? 'null' : encode(value, { sorted: true });
}
