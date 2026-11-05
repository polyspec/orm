import { deflateSync, inflateSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Value as JsonValue, parse as orderedJsonParse, stringify as orderedJsonStringify } from '@polyspec/ordered-json';
import { Document, isMap, isScalar, parseAllDocuments, visit } from 'yaml';
import { present } from './present.js';
import { StyledValue } from './styled_value.js';
import * as codes from './codes.js';
import type { CODEC_DECODE, CODEC_ENCODE, CODEC_UNSUPPORTED, CONFIG } from './codes.js';

/** The common value model of COD-16: an integer is a bigint within i64, and a float is a finite number. */
export type CodecValue = null | boolean | bigint | number | string | CodecValue[] | { [key: string]: CodecValue };
export type EncodedValue = string | Uint8Array | null;
/** The value of a column with an ordered_json stage: an ordered-json value. */
export type { JsonValue };

/** The bytes of a plaintext: bytes as given and a string as its UTF-8; a value of another kind is CODEC_ENCODE (COD-1). */
function plainBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new CodecError(codes.CODEC_ENCODE, `host input must be text or bytes, got a ${typeof value}`);
}

/** Returns the stable lowercase HMAC-SHA256 index for plaintext. */
export function blindIndex(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (key === '') throw new CodecError(codes.CONFIG, 'secret blind_index not configured');
  const input = plainBytes(value);
  return createHmac('sha256', key).update(input).digest('hex');
}

export function hostEncode(value: unknown, styles: readonly string[], aesKey: string): string | Uint8Array | null {
  if (styles.length === 0) throw new CodecError(codes.CODEC_ENCODE, 'host style list is empty');
  for (const style of styles) {
    if (style !== 'aes' && style !== 'hex' && style !== 'ip') throw new CodecError(codes.CODEC_UNSUPPORTED, `host style ${style}`);
  }
  if (value === null) return null;
  let current: Buffer<ArrayBufferLike> = plainBytes(value);
  let textResult = false;
  for (const style of styles) {
    switch (style) {
      case 'aes': {
        if (aesKey === '') throw new CodecError(codes.CONFIG, 'secret aes not configured');
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
      default: throw new CodecError(codes.CODEC_UNSUPPORTED, `host style ${style}`);
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
        // The encoder writes uppercase hex only.
        if (source.length % 2 !== 0 || !/^[0-9A-F]*$/.test(source)) throw new CodecError(codes.CODEC_DECODE, 'hex: odd length or non-hex input');
        current = Buffer.from(source, 'hex');
        break;
      }
      case 'aes': {
        if (aesKey === '') throw new CodecError(codes.CONFIG, 'secret aes not configured');
        const prefix = Buffer.from('ORM-AES2\0');
        if (!current.subarray(0, prefix.length).equals(prefix)) throw new CodecError(codes.CODEC_DECODE, 'aes: unsupported ciphertext format');
        if (current.length < prefix.length + 12 + 16) throw new CodecError(codes.CODEC_DECODE, 'aes: truncated v2 envelope');
        const nonce = current.subarray(prefix.length, prefix.length + 12);
        const decipher = createDecipheriv('aes-256-gcm', aesV2Key(aesKey), nonce);
        decipher.setAAD(prefix);
        decipher.setAuthTag(current.subarray(-16));
        const partial = decipher.update(current.subarray(prefix.length + 12, -16));
        let final: Buffer;
        try {
          final = decipher.final();
        } catch (error) {
          if (error instanceof Error && error.message === 'Unsupported state or unable to authenticate data' && !('code' in error)) {
            throw new CodecError(codes.CODEC_DECODE, 'aes: authentication failed');
          }
          throw error;
        }
        current = Buffer.concat([partial, final]);
        break;
      }
      case 'ip': return unpackIp(current);
      default: throw new CodecError(codes.CODEC_UNSUPPORTED, `host style ${styles[index]}`);
    }
  }
  return current.toString('utf8');
}

function aesV2Key(key: string): Buffer {
  return createHash('sha256').update('polyspec/orm/aes-256-gcm/v2\0', 'utf8').update(key, 'utf8').digest();
}


function packIp(value: string): Buffer {
  // The exact text only: white space around the address, and a zone (%eth0), which isIP accepts, is CODEC_ENCODE
  // (docs/spec/codec.md COD-38).
  const source = value;
  const version = source.includes('%') ? 0 : isIP(source);
  if (version === 4) return Buffer.from(source.split('.').map(Number));
  if (version !== 6) throw new CodecError(codes.CODEC_ENCODE, `ip: ${JSON.stringify(source)} is not an address`);
  const halves = source.split('::');
  if (halves.length > 2) throw new CodecError(codes.CODEC_ENCODE, `ip: ${JSON.stringify(source)} is not an address`);
  const parse = (part: string): number[] => part === '' ? [] : part.split(':').flatMap(token => {
    if (token.includes('.')) {
      const [a, b, c, d] = token.split('.').map(Number);
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new CodecError(codes.CODEC_ENCODE, `ip: ${JSON.stringify(source)} is not an address`);
      return [(a<<8)|b, (c<<8)|d];
    }
    return [Number.parseInt(token,16)];
  });
  const left=parse(present(halves[0], 'the first half of an IPv6 address')), right=parse(halves[1]??'');
  const groups=halves.length===2?[...left,...Array.from({ length: 8-left.length-right.length }, () => 0),...right]:left;
  if(groups.length!==8)throw new CodecError(codes.CODEC_ENCODE,`ip: ${JSON.stringify(source)} is not an address`);
  const out=Buffer.alloc(16);groups.forEach((group,index)=>out.writeUInt16BE(group,index*2));
  return out;
}

function unpackIp(value: Buffer): string {
  if(value.length===4)return [...value].join('.');
  if(value.length!==16)throw new CodecError(codes.CODEC_DECODE,`ip: byte length ${value.length}`);
  const groups=Array.from({length:8},(_,index)=>value.readUInt16BE(index*2));
  let bestStart=-1,bestLength=0;
  for(let index=0;index<groups.length;){if(groups[index]!==0){index++;continue;}let end=index;while(end<groups.length&&groups[end]===0)end++;if(end-index>bestLength&&end-index>=2){bestStart=index;bestLength=end-index;}index=end;}
  // An IPv4-mapped address is ::ffff: and its dotted decimal (RFC 5952, section 5), as MySQL INET6_NTOA writes it.
  if(value.subarray(0,12).equals(Buffer.from([0,0,0,0,0,0,0,0,0,0,255,255])))return `::ffff:${[...value.subarray(12)].join('.')}`;
  if(bestStart<0)return groups.map(group=>group.toString(16)).join(':');
  const left=groups.slice(0,bestStart).map(group=>group.toString(16)).join(':');
  const right=groups.slice(bestStart+bestLength).map(group=>group.toString(16)).join(':');
  return `${left}::${right}`;
}

export class CodecError extends Error {
  public constructor(public readonly code: typeof CONFIG | typeof CODEC_DECODE | typeof CODEC_ENCODE | typeof CODEC_UNSUPPORTED, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
  }
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Whether an integer is in the i64 range of the common value model (COD-16). */
function i64(value: bigint): boolean {
  return value >= I64_MIN && value <= I64_MAX;
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
    if (error instanceof CodecError) throw error;
    throw new CodecError(operation === 'decode' ? codes.CODEC_DECODE : codes.CODEC_ENCODE, `invalid UTF-8: ${String(error)}`, { cause: error });
  }
}

function decodeBase64(value: Uint8Array): Uint8Array {
  // Decode a stored cell only in the form the encoder writes: whitespace, line breaks, missing padding, and non-zero padding bits are
  // rejected with CODEC_DECODE (docs/spec/codec.md). Re-encoding must give the same text, which is the encoder's form. The bytes must be read unchanged, so
  // the UTF-8 decoder must not strip a leading BOM.
  const source = Buffer.from(value).toString('latin1');
  const bytes = Buffer.from(source, 'base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(source) || bytes.toString('base64') !== source) {
    throw new CodecError(codes.CODEC_DECODE, 'base64: bad input');
  }
  return new Uint8Array(bytes);
}

/**
 * Refuses a style that no stage names and a value stage outside the first position, before any value or cell is read
 * (docs/spec/codec.md COD-35).
 */
function checkStyles(styles: readonly string[]): void {
  for (const [index, style] of styles.entries()) {
    switch (style) {
      case 'gz':
      case 'base64':
        break;
      case 'serialize':
      case 'yaml':
      case 'ordered_json':
        if (index !== 0) throw new CodecError(codes.CODEC_UNSUPPORTED, `${style} must be the first style`);
        break;
      default:
        throw new CodecError(codes.CODEC_UNSUPPORTED, `style ${style}`);
    }
  }
}

/**
 * Decodes a stored cell with the column's codec stages in reverse write
 * order. The ordered_json stage returns the ordered-json value, which keeps
 * the member order, the number text, and an empty object apart from an empty
 * array; without a value stage the value is the text of the bytes.
 */
export function decode(styles: readonly string[], raw: string | Uint8Array | null): StyledValue<CodecValue | JsonValue | string> {
  checkStyles(styles);
  if (raw === null) return StyledValue.sqlNull();
  // An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an empty
  // cell for empty text (docs/spec/codec.md COD-14).
  if (raw.length === 0 && styles.length > 0 && styles.at(-1) !== 'base64') throw new CodecError(codes.CODEC_DECODE, 'styled cell is empty');
  let current = bytes(raw);
  let value: CodecValue | JsonValue | undefined;
  for (let index = styles.length - 1; index >= 0; index--) {
    const style = present(styles[index], `encoding style ${index}`);
    if (value !== undefined) throw new CodecError(codes.CODEC_DECODE, `style ${style} after a decoded value`);
    switch (style) {
      case 'gz':
        try {
          current = new Uint8Array(inflateSync(current));
        } catch (error) {
          throw new CodecError(codes.CODEC_DECODE, `gz: ${String(error)}`);
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
          if (error instanceof CodecError) throw error;
          throw new CodecError(codes.CODEC_DECODE, `json: ${String(error)}`, { cause: error });
        }
        break;
      default:
        throw new CodecError(codes.CODEC_UNSUPPORTED, `style ${style}`);
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
  checkStyles(styles);
  if (state.kind === 'sql-null') return null;
  let current = new Uint8Array();
  const transformed = state.payload();
  if (styles.length === 0 || styles[0] === 'gz' || styles[0] === 'base64') {
    const stage = styles.length === 0 ? 'an empty stage list' : `a first ${styles[0]} stage`;
    if (typeof transformed !== 'string') throw new CodecError(codes.CODEC_ENCODE, `${stage} takes a string value`);
    current = utf8.encode(transformed);
  }
  for (const style of styles) {
    switch (style) {
      case 'serialize':
        current = utf8.encode(phpSerialize(commonValue(transformed, 'serialize')));
        break;
      case 'yaml':
        try {
          current = utf8.encode(yamlText(validateCodecValue(commonValue(transformed, 'yaml'), 'yaml encode')));
        } catch (error) {
          throw new CodecError(codes.CODEC_ENCODE, `yaml: ${String(error)}`);
        }
        break;
      case 'ordered_json':
        current = utf8.encode(transformed instanceof JsonValue ? storedJsonText(transformed) : storedJsonText(orderedJsonValue(transformed)));
        break;
      case 'base64':
        current = utf8.encode(Buffer.from(current).toString('base64'));
        break;
      case 'gz':
        try {
          current = new Uint8Array(deflateSync(current, { level: 9 }));
        } catch (error) {
          throw new CodecError(codes.CODEC_ENCODE, `gz: ${String(error)}`);
        }
        break;
      default:
        throw new CodecError(codes.CODEC_UNSUPPORTED, `style ${style}`);
    }
  }
  return styles.at(-1) === 'gz' ? current : string(current, 'encode');
}

/**
 * Writes a common value as one YAML document. An integer is a bigint and a float a number, so a float whose text has no
 * fraction or exponent is written with one fraction digit and reads back as a float (COD-29). A string, a key or a value,
 * that holds a character outside c-printable is double-quoted, and the character is written as its escape (YAML 1.2.2,
 * 5.7): the library escapes only the characters below U+0020, and these characters come only from string content, so
 * each one left in the text is inside a double-quoted scalar.
 */
function yamlText(value: CodecValue): string {
  const document = new Document(value, { version: '1.2', schema: 'core', sortMapEntries: true });
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === 'number' && /^-?[0-9]+$/.test(JSON.stringify(node.value))) node.minFractionDigits = 1;
      if (typeof node.value === 'string' && YAML_NOT_PRINTABLE.test(node.value)) node.type = 'QUOTE_DOUBLE';
    },
  });
  return document.toString().replace(new RegExp(YAML_NOT_PRINTABLE.source, 'gu'), character => {
    const point = present(character.codePointAt(0), 'a character to escape');
    const hex = point.toString(16).toUpperCase();
    return point <= 0xff ? `\\x${hex.padStart(2, '0')}` : point <= 0xffff ? `\\u${hex.padStart(4, '0')}` : `\\U${hex.padStart(8, '0')}`;
  });
}

/** Rejects an ordered-json value for a stage that takes the common value model. */
function commonValue(value: unknown, style: string): CodecValue {
  if (value instanceof JsonValue) throw new CodecError(codes.CODEC_ENCODE, `${style}: an ordered-json value is written only by the ordered_json stage`);
  if (!isCodecValue(value)) throw new CodecError(codes.CODEC_ENCODE, `${style}: the value is not a codec value (null, boolean, bigint, number, string, array or plain object of them)`);
  return value;
}

/** Whether `value` has the shape of a CodecValue: null, a boolean, bigint, number or string, or an array or plain object of them. */
function isCodecValue(value: unknown): value is CodecValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') return true;
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
/**
 * The stored text of a JSON text: insignificant whitespace outside the string literals is removed, and every other
 * character, the member order and the repeated member names included, stays in place (DIA-26).
 */
function compactJsonText(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const c of text) {
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/**
 * The stored text of an ordered-json value: its source text, so the member order and the repeated member names
 * survive, which the member map of stringify would collapse (DIA-26). A value without source text is stringified.
 */
function storedJsonText(value: JsonValue): string {
  const raw = value.raw;
  return raw === '' ? orderedJsonStringify(value) : compactJsonText(raw);
}

function orderedJsonValue(value: unknown): JsonValue {
  try {
    return orderedJsonParse(jsonText(value, 0));
  } catch (error) {
    if (error instanceof CodecError) throw error;
    throw new CodecError(codes.CODEC_ENCODE, `json: ${String(error)}`);
  }
}

/** A JSON string: a text that is not a sequence of Unicode scalar values, such as a lone surrogate, is no JSON text (RFC
 * 8259, 8.1), so it is CODEC_ENCODE (COD-14), where JSON.stringify would write it as an escape. */
// A surrogate code point that is not one half of a pair, read by code point (the u flag).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function jsonString(text: string): string {
  if (LONE_SURROGATE.test(text)) throw new CodecError(codes.CODEC_ENCODE, 'json: the text is not a sequence of Unicode scalar values');
  return JSON.stringify(text);
}

function jsonText(value: unknown, depth: number): string {
  if (depth > 256) throw new CodecError(codes.CODEC_ENCODE, 'json: value nesting exceeds 256 levels');
  if (value instanceof JsonValue) return storedJsonText(value);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return jsonString(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CodecError(codes.CODEC_ENCODE, `json: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'bigint': return value.toString();
    case 'object': break;
    default: throw new CodecError(codes.CODEC_ENCODE, `json: ${typeof value} is not a JSON value`);
  }
  if (Array.isArray(value)) return `[${value.map(item => jsonText(item, depth + 1)).join(',')}]`;
  if (value instanceof Uint8Array) throw new CodecError(codes.CODEC_ENCODE, 'json: bytes are not a JSON value');
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON !== 'function') {
      const constructor: unknown = typeof proto === 'object' ? Reflect.get(proto, 'constructor') : undefined;
      throw new CodecError(codes.CODEC_ENCODE, `json: ${typeof constructor === 'function' ? constructor.name : 'object'} is not a JSON value`);
    }
    return jsonText(toJSON.call(value), depth + 1);
  }
  const members: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new CodecError(codes.CODEC_ENCODE, `json: member ${JSON.stringify(key)} is undefined`);
    members.push(`${jsonString(key)}:${jsonText(item, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

// A character outside c-printable (YAML 1.2.2, 5.1), or a byte order mark, which is the encoding mark at the start of the
// stream (5.2) and never content.
const YAML_NOT_PRINTABLE = /[^\t\n\r\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufefe\uff00-\ufffd\u{10000}-\u{10ffff}]/u;

function decodeYaml(current: Uint8Array): CodecValue {
  try {
    const source = string(current, 'decode');
    const stream = source.startsWith('\ufeff') ? source.slice(1) : source;
    const refused = YAML_NOT_PRINTABLE.exec(stream);
    if (refused !== null) {
      throw new CodecError(codes.CODEC_DECODE, `yaml: character U+${present(refused[0].codePointAt(0), 'the refused character').toString(16).toUpperCase().padStart(4, '0')} at ${refused.index} is not printable`);
    }
    const documents = parseAllDocuments(stream, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true, intAsBigInt: true });
    // A stream without a document (empty, or comments only) is not a YAML value.
    if (documents.length === 0) throw new Error('no document');
    if (documents.length > 1) throw new Error('multiple documents are not supported');
    const document = present(documents[0], 'the one YAML document');
    if (document.errors.length > 0) throw document.errors[0];
    if (document.warnings.length > 0) throw document.warnings[0];
    const schema = document.schema;
    visit(document, {
      // docs/spec/codec.md (yaml): anchors and every explicit tag, the core tags included, are refused.
      // The parser sets a node's anchor and tag only when the text writes them.
      Node(_key, node) {
        if (node.anchor !== undefined) throw new Error(`anchor &${node.anchor} is not supported`);
        if (node.tag !== undefined) throw new Error(`explicit tag ${node.tag} is not supported`);
        // docs/spec/codec.md (yaml): an integral key is its decimal string, and two keys of one string are duplicates.
        if (isMap(node)) {
          const keys = new Set<string>();
          for (const pair of node.items) {
            const key = pair.key;
            if (!isScalar(key) || typeof key.value !== 'string') continue;
            let name: string = key.value;
            if (key.type === 'PLAIN') {
              const text = key.source ?? name;
              const tag = schema.tags.find(candidate => candidate.default === true && candidate.test?.test(text))?.tag;
              if (tag === 'tag:yaml.org,2002:int') key.value = name = BigInt(text).toString();
            }
            if (keys.has(name)) throw new Error(`duplicate map key ${name}`);
            keys.add(name);
          }
        }
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
    if (error instanceof CodecError) throw error;
    throw new CodecError(codes.CODEC_DECODE, `yaml: ${String(error)}`, { cause: error });
  }
}

function validateCodecValue(value: unknown, operation: string): CodecValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    if (!i64(value)) throw new Error(`${operation}: integer ${value} is outside the i64 range`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${operation}: number ${value} is not finite`);
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
  if (typeof value === 'bigint') {
    if (!i64(value)) throw new CodecError(codes.CODEC_ENCODE, `integer ${value} is outside the i64 range`);
    return `i:${value};`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CodecError(codes.CODEC_ENCODE, `number ${value} is not finite`);
    return `d:${phpFloat(value)};`;
  }
  if (typeof value === 'string') return `s:${utf8.encode(value).length}:"${value}";`;
  if (Array.isArray(value)) {
    return `a:${value.length}:{${value.map((item, index) => `i:${index};${phpSerialize(item)}`).join('')}}`;
  }
  const entries = Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `a:${entries.length}:{${entries.map(([key, item]) => `${phpKey(key)}${phpSerialize(item)}`).join('')}}`;
}

function phpKey(key: string): string {
  if (/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(key) && i64(BigInt(key))) return `i:${key};`;
  return `s:${utf8.encode(key).length}:"${key}";`;
}

/**
 * The PHP serialize float notation: the shortest digits (serialize_precision -1), in the exponent form E followed by a
 * signed exponent when the decimal exponent is below -4 or above 16, and in fixed notation otherwise (zend_gcvt with
 * precision 17); a mantissa of one digit is followed by .0.
 */
function phpFloat(value: number): string {
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const match = present(/^([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/.exec(Math.abs(value).toExponential()), 'the exponent form of a float');
  const lead = present(match[1], 'the first digit of a float');
  const digits = `${lead}${match[2] ?? ''}`;
  const exponent = Number(match[3]);
  if (exponent < -4 || exponent > 16) return `${sign}${lead}.${match[2] ?? '0'}E${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
  const point = exponent + 1;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
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
    throw new CodecError(codes.CODEC_DECODE, `serialize: ${message} at ${this.index}`);
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
        const raw = this.until(59);
        if (!/^[+-]?[0-9]+$/.test(raw)) this.fail('bad int');
        const value = BigInt(raw);
        if (!i64(value)) this.fail(`integer ${raw} is outside the i64 range`);
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
        throw new CodecError(codes.CODEC_UNSUPPORTED, `serialize: objects and references are not supported (${type})`);
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
      if (typeof key !== 'bigint' && typeof key !== 'string') this.fail('array key must be int or string');
      if (typeof key !== 'bigint' || key !== BigInt(index)) sequential = false;
      entries.push([String(key), this.value()]);
    }
    this.expect(125);
    if (sequential) return entries.map(([, value]) => value);
    return Object.fromEntries(entries);
  }
}
