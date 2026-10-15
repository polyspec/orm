import { deflateSync, inflateSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Value as JsonValue, parse as orderedJsonParse, stringify as orderedJsonStringify } from '@polyspec/ordered-json';
import { isScalar, parseAllDocuments, stringify as stringifyYaml, visit } from 'yaml';
import { present } from './present.js';
import { StyledValue } from './styled_value.js';

export type CodecValue = null | boolean | number | string | CodecValue[] | { [key: string]: CodecValue };
export type EncodedValue = string | Uint8Array | null;
/** The value of a column with an ordered_json stage: an ordered-json value. */
export type { JsonValue };

/** The bytes of a plaintext: bytes as given, a scalar as the UTF-8 of its text; any other value is a CODEC_ENCODE error. */
function plainBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return Buffer.from(String(value));
  throw new CodecError('CODEC_ENCODE', `a ${typeof value} value has no plaintext`);
}

/** Returns the stable lowercase HMAC-SHA256 index for plaintext. */
export function blindIndex(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (key === '') throw new CodecError('CODEC_ENCODE', 'secret blind_index not configured');
  const input = plainBytes(value);
  return createHmac('sha256', key).update(input).digest('hex');
}

export function hostEncode(value: unknown, styles: readonly string[], aesKey: string): string | Uint8Array | null {
  if (value === null) return null;
  let current: Buffer<ArrayBufferLike> = plainBytes(value);
  let textResult = false;
  for (const style of styles) {
    switch (style) {
      case 'aes': {
        if (aesKey === '') throw new CodecError('CODEC_ENCODE', 'secret aes not configured');
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', aesV2Key(aesKey), nonce);
        cipher.setAAD(Buffer.from('ORM-AES2\0'));
        const encrypted = Buffer.concat([cipher.update(current), cipher.final()]);
        current = Buffer.concat([Buffer.from('ORM-AES2\0'), nonce, encrypted, cipher.getAuthTag()]);
        textResult = false;
        break;
      }
      case 'hex': current = Buffer.from(current.toString('hex').toUpperCase()); textResult = true; break;
      case 'ip': current = packIp(current.toString()); textResult = false; break;
      default: throw new CodecError('CODEC_UNSUPPORTED', `host style ${style}`);
    }
  }
  return textResult ? current.toString() : new Uint8Array(current);
}

export function hostDecode(raw: string | Uint8Array | null, styles: readonly string[], aesKey: string): string | null {
  if (raw === null) return null;
  let current: Buffer<ArrayBufferLike> = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
  for (let index = styles.length - 1; index >= 0; index--) {
    switch (styles[index]) {
      case 'hex': {
        const source = current.toString();
        // encoder는 대문자 hex만 쓴다.
        if (source.length % 2 !== 0 || !/^[0-9A-F]*$/.test(source)) throw new CodecError('CODEC_DECODE', 'hex: odd length or non-hex input');
        current = Buffer.from(source, 'hex');
        break;
      }
      case 'aes': {
        if (aesKey === '') throw new CodecError('CODEC_DECODE', 'secret aes not configured');
        const prefix = Buffer.from('ORM-AES2\0');
        if (!current.subarray(0, prefix.length).equals(prefix)) throw new CodecError('CODEC_DECODE', 'aes: unsupported ciphertext format');
        if (current.length < prefix.length + 12 + 16) throw new CodecError('CODEC_DECODE', 'aes: truncated v2 envelope');
        try {
          const nonce = current.subarray(prefix.length, prefix.length + 12);
          const decipher = createDecipheriv('aes-256-gcm', aesV2Key(aesKey), nonce);
          decipher.setAAD(prefix);
          decipher.setAuthTag(current.subarray(-16));
          current = Buffer.concat([decipher.update(current.subarray(prefix.length + 12, -16)), decipher.final()]);
        } catch { throw new CodecError('CODEC_DECODE', 'aes: authentication failed'); }
        break;
      }
      case 'ip': return unpackIp(current);
      default: throw new CodecError('CODEC_UNSUPPORTED', `host style ${styles[index]}`);
    }
  }
  return current.toString('utf8');
}

function aesV2Key(key: string): Buffer {
  return createHash('sha256').update('polyspec/orm/aes-256-gcm/v2\0', 'utf8').update(key, 'utf8').digest();
}


function packIp(value: string): Buffer {
  // The exact text only: white space around the address is CODEC_ENCODE (docs/codec.md).
  const source = value;
  const version = isIP(source);
  if (version === 4) return Buffer.from(source.split('.').map(Number));
  if (version !== 6) throw new CodecError('CODEC_ENCODE', `ip: ${JSON.stringify(source)} is not an address`);
  const halves = source.split('::');
  if (halves.length > 2) throw new CodecError('CODEC_ENCODE', `ip: ${JSON.stringify(source)} is not an address`);
  const parse = (part: string): number[] => part === '' ? [] : part.split(':').flatMap(token => {
    if (token.includes('.')) {
      const [a, b, c, d] = token.split('.').map(Number);
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new CodecError('CODEC_ENCODE', `ip: ${JSON.stringify(source)} is not an address`);
      return [(a<<8)|b, (c<<8)|d];
    }
    return [Number.parseInt(token,16)];
  });
  const left=parse(present(halves[0], 'the first half of an IPv6 address')), right=parse(halves[1]??'');
  const groups=halves.length===2?[...left,...Array.from({ length: 8-left.length-right.length }, () => 0),...right]:left;
  if(groups.length!==8)throw new CodecError('CODEC_ENCODE',`ip: ${JSON.stringify(source)} is not an address`);
  const out=Buffer.alloc(16);groups.forEach((group,index)=>out.writeUInt16BE(group,index*2));
  if(out.subarray(0,12).equals(Buffer.from([0,0,0,0,0,0,0,0,0,0,255,255])))return out.subarray(12);
  return out;
}

function unpackIp(value: Buffer): string {
  if(value.length===4)return [...value].join('.');
  if(value.length!==16)throw new CodecError('CODEC_DECODE',`ip: byte length ${value.length}`);
  const groups=Array.from({length:8},(_,index)=>value.readUInt16BE(index*2));
  let bestStart=-1,bestLength=0;
  for(let index=0;index<groups.length;){if(groups[index]!==0){index++;continue;}let end=index;while(end<groups.length&&groups[end]===0)end++;if(end-index>bestLength&&end-index>=2){bestStart=index;bestLength=end-index;}index=end;}
  if(bestStart<0)return groups.map(group=>group.toString(16)).join(':');
  const left=groups.slice(0,bestStart).map(group=>group.toString(16)).join(':');
  const right=groups.slice(bestStart+bestLength).map(group=>group.toString(16)).join(':');
  return `${left}::${right}`;
}

export class CodecError extends Error {
  public constructor(public readonly code: 'CODEC_DECODE' | 'CODEC_ENCODE' | 'CODEC_UNSUPPORTED', message: string) {
    super(`${code}: ${message}`);
  }
}

const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? utf8.encode(value) : value;
}

function string(value: Uint8Array, operation: 'decode' | 'encode'): string {
  try {
    return text.decode(value);
  } catch (error) {
    throw new CodecError(operation === 'decode' ? 'CODEC_DECODE' : 'CODEC_ENCODE', `invalid UTF-8: ${String(error)}`);
  }
}

function decodeBase64(value: Uint8Array): Uint8Array {
  // 저장 cell은 encoder가 쓰는 형태로만 decode한다: 공백, 줄바꿈, 빠진 padding, 0이 아닌 padding bit는
  // CODEC_DECODE다(docs/codec.md). 다시 encode한 text가 같아야 encoder가 쓴 형태다. byte를 그대로 읽어야
  // UTF-8 decoder가 앞의 BOM을 지우지 않는다.
  const source = Buffer.from(value).toString('latin1');
  const bytes = Buffer.from(source, 'base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(source) || bytes.toString('base64') !== source) {
    throw new CodecError('CODEC_DECODE', 'base64: bad input');
  }
  return new Uint8Array(bytes);
}

/**
 * Decodes a stored cell with the column's codec stages in reverse write
 * order. The ordered_json stage returns the ordered-json value, which keeps
 * the member order, the number text, and an empty object apart from an empty
 * array; without a value stage the value is the text of the bytes.
 */
export function decode(styles: readonly string[], raw: string | Uint8Array | null): StyledValue<CodecValue | JsonValue | string> {
  if (raw === null) return StyledValue.sqlNull();
  // An empty cell is CODEC_DECODE, except under a last base64 stage, whose encoder writes an empty cell for empty
  // bytes (docs/codec.md, Stage lists).
  if (raw.length === 0 && styles.at(-1) !== 'base64') throw new CodecError('CODEC_DECODE', 'styled cell is empty');
  let current = bytes(raw);
  let value: CodecValue | JsonValue | undefined;
  for (let index = styles.length - 1; index >= 0; index--) {
    const style = present(styles[index], `encoding style ${index}`);
    if (value !== undefined) throw new CodecError('CODEC_DECODE', `style ${style} after a decoded value`);
    switch (style) {
      case 'gz':
        try {
          current = new Uint8Array(inflateSync(current));
        } catch (error) {
          throw new CodecError('CODEC_DECODE', `gz: ${String(error)}`);
        }
        break;
      case 'base64':
        current = decodeBase64(current);
        break;
      case 'serialize':
        value = new PhpParser(current).parse();
        break;
      case 'yaml':
        value = decodeYaml(current);
        break;
      case 'ordered_json':
        try {
          value = orderedJsonParse(string(current, 'decode'));
        } catch (error) {
          throw new CodecError('CODEC_DECODE', `json: ${String(error)}`);
        }
        break;
      default:
        throw new CodecError('CODEC_UNSUPPORTED', `style ${style}`);
    }
  }
  return StyledValue.value(value !== undefined ? value : string(current, 'decode'));
}

/**
 * Encodes a value with the column's codec stages in write order. The
 * ordered_json stage accepts an ordered-json value, written as its compact
 * text, or the common value model, which may contain ordered-json values. A
 * first gz or base64 stage takes the value as text.
 */
export function encode(styles: readonly string[], state: StyledValue<CodecValue | JsonValue>): EncodedValue {
  return encodeStyled(styles, state);
}

/**
 * encode for a value whose payload is not yet typed: each stage checks the payload it takes, so a model's column value
 * (StyledValue of any payload) is encoded without asserting its type.
 *
 * @internal
 */
export function encodeStyled(styles: readonly string[], state: StyledValue<unknown>): EncodedValue {
  if (state.kind === 'sql-null') return null;
  let current = new Uint8Array();
  const transformed = state.payload();
  if (styles[0] === 'gz' || styles[0] === 'base64') {
    if (typeof transformed !== 'string') throw new CodecError('CODEC_ENCODE', `a first ${styles[0]} stage takes a string value`);
    current = utf8.encode(transformed);
  }
  for (const [index, style] of styles.entries()) {
    switch (style) {
      case 'serialize':
        if (index !== 0) throw new CodecError('CODEC_UNSUPPORTED', 'serialize must be the first encoding style');
        current = utf8.encode(phpSerialize(commonValue(transformed, 'serialize')));
        break;
      case 'yaml':
        if (index !== 0) throw new CodecError('CODEC_UNSUPPORTED', 'yaml must be the first style');
        try {
          current = utf8.encode(stringifyYaml(validateCodecValue(commonValue(transformed, 'yaml'), 'yaml encode'), { version: '1.2', schema: 'core', sortMapEntries: true }));
        } catch (error) {
          throw new CodecError('CODEC_ENCODE', `yaml: ${String(error)}`);
        }
        break;
      case 'ordered_json':
        if (index !== 0) throw new CodecError('CODEC_UNSUPPORTED', 'ordered_json must be the first stage');
        current = utf8.encode(transformed instanceof JsonValue ? orderedJsonStringify(transformed) : orderedJsonStringify(orderedJsonValue(transformed)));
        break;
      case 'base64':
        current = utf8.encode(Buffer.from(current).toString('base64'));
        break;
      case 'gz':
        if (index !== styles.length - 1) throw new CodecError('CODEC_UNSUPPORTED', 'gz must be the last style');
        try {
          return new Uint8Array(deflateSync(current, { level: 9 }));
        } catch (error) {
          throw new CodecError('CODEC_ENCODE', `gz: ${String(error)}`);
        }
      default:
        throw new CodecError('CODEC_UNSUPPORTED', `style ${style}`);
    }
  }
  return string(current, 'encode');
}

/** Rejects an ordered-json value for a stage that takes the common value model. */
function commonValue(value: unknown, style: string): CodecValue {
  if (value instanceof JsonValue) throw new CodecError('CODEC_ENCODE', `${style}: an ordered-json value is written only by the ordered_json stage`);
  if (!isCodecValue(value)) throw new CodecError('CODEC_ENCODE', `${style}: the value is not a codec value (null, boolean, number, string, array or plain object of them)`);
  return value;
}

/** Whether `value` has the shape of a CodecValue: null, a boolean, number or string, or an array or plain object of them. */
function isCodecValue(value: unknown): value is CodecValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every(isCodecValue);
  if (typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isCodecValue);
}

/**
 * Converts the common value model to ordered-json. Object members keep their
 * property order; nested ordered-json values are kept as they are. Non-finite
 * numbers and values outside the model return CODEC_ENCODE.
 */
function orderedJsonValue(value: unknown): JsonValue {
  try {
    return orderedJsonParse(jsonText(value, 0));
  } catch (error) {
    if (error instanceof CodecError) throw error;
    throw new CodecError('CODEC_ENCODE', `json: ${String(error)}`);
  }
}

function jsonText(value: unknown, depth: number): string {
  if (depth > 256) throw new CodecError('CODEC_ENCODE', 'json: value nesting exceeds 256 levels');
  if (value instanceof JsonValue) return orderedJsonStringify(value);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CodecError('CODEC_ENCODE', `json: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'bigint': return value.toString();
    case 'object': break;
    default: throw new CodecError('CODEC_ENCODE', `json: ${typeof value} is not a JSON value`);
  }
  if (Array.isArray(value)) return `[${value.map(item => jsonText(item, depth + 1)).join(',')}]`;
  if (value instanceof Uint8Array) throw new CodecError('CODEC_ENCODE', 'json: bytes are not a JSON value');
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON !== 'function') {
      const constructor: unknown = typeof proto === 'object' ? Reflect.get(proto, 'constructor') : undefined;
      throw new CodecError('CODEC_ENCODE', `json: ${typeof constructor === 'function' ? constructor.name : 'object'} is not a JSON value`);
    }
    return jsonText(toJSON.call(value), depth + 1);
  }
  const members: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new CodecError('CODEC_ENCODE', `json: member ${JSON.stringify(key)} is undefined`);
    members.push(`${JSON.stringify(key)}:${jsonText(item, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

function decodeYaml(current: Uint8Array): CodecValue {
  try {
    const documents = parseAllDocuments(string(current, 'decode'), { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true });
    // A stream without a document (empty, or comments only) is not a YAML value.
    if (documents.length === 0) throw new Error('no document');
    if (documents.length > 1) throw new Error('multiple documents are not supported');
    const document = present(documents[0], 'the one YAML document');
    if (document.errors.length > 0) throw document.errors[0];
    if (document.warnings.length > 0) throw document.warnings[0];
    const schema = document.schema;
    visit(document, {
      // docs/codec.md (yaml): anchors and every explicit tag, the core tags included, are refused.
      // The parser sets a node's anchor and tag only when the text writes them.
      Node(_key, node) {
        if (node.anchor !== undefined) throw new Error(`anchor &${node.anchor} is not supported`);
        if (node.tag !== undefined) throw new Error(`explicit tag ${node.tag} is not supported`);
      },
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('map keys must be scalar strings');
        // stringKeys keeps a key's value a string, so a plain key's core type is the tag the core schema
        // resolves its text to, found by the schema's own tests as the parser does for a value.
        if (pair.key.type === 'PLAIN') {
          const text = pair.key.source ?? pair.key.value;
          const tag = schema.tags.find(candidate => candidate.default === true && candidate.test?.test(text))?.tag;
          if (tag === 'tag:yaml.org,2002:bool' || tag === 'tag:yaml.org,2002:null' || tag === 'tag:yaml.org,2002:float') {
            throw new Error('plain boolean, null, and floating-point map keys are not supported');
          }
        }
      },
    });
    return validateCodecValue(document.toJS({ maxAliasCount: 0 }), 'yaml decode');
  } catch (error) {
    throw new CodecError('CODEC_DECODE', `yaml: ${String(error)}`);
  }
}

function validateCodecValue(value: unknown, operation: string): CodecValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error(`${operation}: number is outside the supported range`);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => validateCodecValue(item, operation));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, validateCodecValue(item, operation)]));
  }
  throw new Error(`${operation}: value type is not supported`);
}

function phpSerialize(value: CodecValue): string {
  if (value === null) return 'N;';
  if (typeof value === 'boolean') return value ? 'b:1;' : 'b:0;';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CodecError('CODEC_ENCODE', `number ${value} is not finite`);
    return Number.isSafeInteger(value) ? `i:${value};` : `d:${phpFloat(value)};`;
  }
  if (typeof value === 'string') return `s:${utf8.encode(value).length}:"${value}";`;
  if (Array.isArray(value)) {
    return `a:${value.length}:{${value.map((item, index) => `i:${index};${phpSerialize(item)}`).join('')}}`;
  }
  const entries = Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `a:${entries.length}:{${entries.map(([key, item]) => `${phpKey(key)}${phpSerialize(item)}`).join('')}}`;
}

function phpKey(key: string): string {
  if (/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(key)) {
    const number = Number(key);
    if (Number.isSafeInteger(number)) return `i:${number};`;
  }
  return `s:${utf8.encode(key).length}:"${key}";`;
}

function phpFloat(value: number): string {
  const source = value.toString();
  const match = /^(.+?)e([+-]?)([0-9]+)$/i.exec(source);
  if (!match) return source;
  const significand = present(match[1], 'the significand of an exponent float');
  const mantissa = significand.includes('.') ? significand : `${significand}.0`;
  const exponent = Number(`${match[2] || '+'}${present(match[3], 'the exponent of an exponent float')}`);
  return `${mantissa}E${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
}

class PhpParser {
  private index = 0;

  public constructor(private readonly input: Uint8Array) {}

  public parse(): CodecValue {
    const value = this.value();
    if (this.index !== this.input.length) this.fail('trailing data');
    return value;
  }

  private fail(message: string): never {
    throw new CodecError('CODEC_DECODE', `serialize: ${message} at ${this.index}`);
  }

  private byte(): number {
    const byte = this.input[this.index];
    if (byte === undefined) this.fail('unexpected end');
    this.index++;
    return byte;
  }

  private expect(expected: number): void {
    if (this.byte() !== expected) this.fail(`expected ${String.fromCharCode(expected)}`);
  }

  private until(delimiter: number): string {
    const start = this.index;
    while (this.index < this.input.length && this.input[this.index] !== delimiter) this.index++;
    if (this.index >= this.input.length) this.fail(`expected ${String.fromCharCode(delimiter)}`);
    const result = string(this.input.subarray(start, this.index), 'decode');
    this.index++;
    return result;
  }

  private value(): CodecValue {
    const type = String.fromCharCode(this.byte());
    switch (type) {
      case 'N':
        this.expect(59);
        return null;
      case 'b': {
        this.expect(58);
        const raw = this.until(59);
        if (raw !== '0' && raw !== '1') this.fail('bad bool');
        return raw === '1';
      }
      case 'i': {
        this.expect(58);
        const value = Number(this.until(59));
        if (!Number.isSafeInteger(value)) this.fail('bad or unsafe int');
        return value;
      }
      case 'd': {
        this.expect(58);
        const raw = this.until(59);
        const value = Number(raw);
        if (!Number.isFinite(value)) this.fail('non-finite float');
        return value;
      }
      case 's': {
        this.expect(58);
        const length = Number(this.until(58));
        if (!Number.isSafeInteger(length) || length < 0) this.fail('bad string length');
        this.expect(34);
        if (this.index + length > this.input.length) this.fail('string overruns input');
        const value = string(this.input.subarray(this.index, this.index + length), 'decode');
        this.index += length;
        this.expect(34);
        this.expect(59);
        return value;
      }
      case 'a':
        return this.array();
      case 'O':
      case 'C':
      case 'r':
      case 'R':
        throw new CodecError('CODEC_UNSUPPORTED', `serialize: objects and references are not supported (${type})`);
      default:
        this.fail(`unknown type ${type}`);
    }
  }

  private array(): CodecValue {
    this.expect(58);
    const count = Number(this.until(58));
    if (!Number.isSafeInteger(count) || count < 0) this.fail('bad array length');
    this.expect(123);
    const entries: Array<[string, CodecValue]> = [];
    let sequential = true;
    for (let index = 0; index < count; index++) {
      const key = this.value();
      if (typeof key !== 'number' && typeof key !== 'string') this.fail('array key must be int or string');
      if (typeof key !== 'number' || key !== index) sequential = false;
      entries.push([String(key), this.value()]);
    }
    this.expect(125);
    if (sequential) return entries.map(([, value]) => value);
    return Object.fromEntries(entries);
  }
}
