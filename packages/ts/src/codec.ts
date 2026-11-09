import { deflateSync, inflateSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isUtf8 } from 'node:buffer';
import { ParseError as JsonParseError, Value as JsonValue, parse as orderedJsonParse, parseBytes as orderedJsonParseBytes, stringify as orderedJsonStringify } from '@polyspec/ordered-json';
import { Document, isAlias, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import type { Alias, ParsedNode } from 'yaml';
import { present } from './present.js';
import { StyledValue, storedValue } from './styled_value.js';
import * as codes from './codes.js';
import type { CODEC_DECODE, CODEC_ENCODE, CODEC_UNSUPPORTED, CONFIG } from './codes.js';

/** The common value model of COD-16: an integer is a bigint within i64, and a float is a finite number. */
export type CodecValue = null | boolean | bigint | number | string | CodecValue[] | { [key: string]: CodecValue };
export type EncodedValue = string | Uint8Array | null;
/** The value of a column with an ordered_json stage: an ordered-json value. */
export type { JsonValue };

/**
 * The bytes of a plaintext of a host stage or a blind index (what): bytes as given and a string as its UTF-8; a value of
 * another kind is CODEC_ENCODE `<what> input must be text or bytes`, which names no host type, and a string with a lone
 * surrogate, which has no UTF-8, is CODEC_ENCODE `<what> input is not a sequence of Unicode scalar values` (COD-1, COD-70).
 */
function plainBytes(value: unknown, what: 'host' | 'blind index'): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new CodecError(codes.CODEC_ENCODE, `${what} input is not a sequence of Unicode scalar values`);
    return Buffer.from(value);
  }
  throw new CodecError(codes.CODEC_ENCODE, `${what} input must be text or bytes`);
}

/** Returns the stable lowercase HMAC-SHA256 index for plaintext. */
export function blindIndex(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (key === '') throw new CodecError(codes.CONFIG, 'secret blind_index not configured');
  const input = plainBytes(value, 'blind index');
  return createHmac('sha256', key).update(input).digest('hex');
}

/** Refuses an empty list or a style other than aes, hex and ip before the value or the cell is read (COD-1, COD-70). */
function checkHostStyles(styles: readonly string[]): void {
  for (const style of styles) {
    if (style !== 'aes' && style !== 'hex' && style !== 'ip') throw new CodecError(codes.CODEC_UNSUPPORTED, `host style ${style}`);
  }
}

export function hostEncode(value: unknown, styles: readonly string[], aesKey: string): string | Uint8Array | null {
  if (styles.length === 0) throw new CodecError(codes.CODEC_ENCODE, 'host style list is empty');
  checkHostStyles(styles);
  if (value === null) return null;
  let current: Buffer<ArrayBufferLike> = plainBytes(value, 'host');
  let textResult = false;
  for (const style of styles) {
    switch (style) {
      case 'aes': {
        if (aesKey === '') throw new CodecError(codes.CONFIG, 'secret aes not configured');
        current = aesEncrypt(current, aesKey);
        textResult = false;
        break;
      }
      case 'hex': current = Buffer.from(current.toString('hex').toUpperCase()); textResult = true; break;
      case 'ip': current = packIp(current); textResult = false; break;
      default: throw new CodecError(codes.CODEC_UNSUPPORTED, `host style ${style}`);
    }
  }
  return textResult ? current.toString() : new Uint8Array(current);
}

const AES_PREFIX = Buffer.from('ORM-AES2\0');

/** The v2 envelope of COD-5; a failure of the cipher or of the random source is CODEC_ENCODE with its cause (COD-71). */
function aesEncrypt(plain: Buffer, aesKey: string): Buffer {
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesV2Key(aesKey), nonce);
    cipher.setAAD(AES_PREFIX);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([AES_PREFIX, nonce, encrypted, cipher.getAuthTag()]);
  } catch (error) {
    throw new CodecError(codes.CODEC_ENCODE, 'aes: the encryption failed', { cause: error });
  }
}

/** The plaintext of a v2 envelope; a cell that the key does not authenticate, or any other failure of the decryption, is
 * CODEC_DECODE with the failure of node:crypto as its cause (COD-70, COD-71). */
function aesDecrypt(cell: Buffer, aesKey: string): Buffer {
  if (!cell.subarray(0, AES_PREFIX.length).equals(AES_PREFIX)) throw new CodecError(codes.CODEC_DECODE, 'aes: unsupported ciphertext format');
  if (cell.length < AES_PREFIX.length + 12 + 16) throw new CodecError(codes.CODEC_DECODE, 'aes: truncated v2 envelope');
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesV2Key(aesKey), cell.subarray(AES_PREFIX.length, AES_PREFIX.length + 12));
    decipher.setAAD(AES_PREFIX);
    decipher.setAuthTag(cell.subarray(-16));
    const partial = decipher.update(cell.subarray(AES_PREFIX.length + 12, -16));
    return Buffer.concat([partial, decipher.final()]);
  } catch (error) {
    throw new CodecError(codes.CODEC_DECODE, 'aes: authentication failed', { cause: error });
  }
}

/**
 * Decodes a host cell. The plaintext is returned as its text when it is UTF-8 and as its bytes otherwise, never replaced,
 * so that the column conversion reads it (COD-69); a cell that is neither text nor bytes is CODEC_DECODE (COD-70).
 */
export function hostDecode(raw: unknown, styles: readonly string[], aesKey: string): string | Uint8Array | null {
  checkHostStyles(styles);
  if (raw === null) return null;
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) throw new CodecError(codes.CODEC_DECODE, 'cell is not bytes');
  let current: Buffer<ArrayBufferLike> = Buffer.from(raw);
  for (let index = styles.length - 1; index >= 0; index--) {
    switch (styles[index]) {
      case 'hex': {
        // The encoder writes uppercase hex only; a byte outside ASCII is no hex digit.
        const source = current.toString('latin1');
        if (source.length % 2 !== 0 || !/^[0-9A-F]*$/.test(source)) throw new CodecError(codes.CODEC_DECODE, 'hex: odd length or non-hex input');
        current = Buffer.from(source, 'hex');
        break;
      }
      case 'aes': {
        if (aesKey === '') throw new CodecError(codes.CONFIG, 'secret aes not configured');
        current = aesDecrypt(current, aesKey);
        break;
      }
      case 'ip': return unpackIp(current);
      default: throw new CodecError(codes.CODEC_UNSUPPORTED, `host style ${styles[index]}`);
    }
  }
  return isUtf8(current) ? current.toString('utf8') : new Uint8Array(current);
}

function aesV2Key(key: string): Buffer {
  return createHash('sha256').update('polyspec/orm/aes-256-gcm/v2\0', 'utf8').update(key, 'utf8').digest();
}


function packIp(value: Buffer): Buffer {
  // The exact text only: white space around the address, and a zone (%eth0), which isIP accepts, is CODEC_ENCODE
  // (docs/spec/codec.md COD-38); bytes that are not UTF-8 are no text of an address.
  if (!isUtf8(value)) throw new CodecError(codes.CODEC_ENCODE, 'ip: the text is not an address');
  const source = value.toString('utf8');
  const version = source.includes('%') ? 0 : isIP(source);
  if (version === 4) return Buffer.from(source.split('.').map(Number));
  if (version !== 6) throw new CodecError(codes.CODEC_ENCODE, 'ip: the text is not an address');
  const halves = source.split('::');
  if (halves.length > 2) throw new CodecError(codes.CODEC_ENCODE, 'ip: the text is not an address');
  const parse = (part: string): number[] => part === '' ? [] : part.split(':').flatMap(token => {
    if (token.includes('.')) {
      const [a, b, c, d] = token.split('.').map(Number);
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new CodecError(codes.CODEC_ENCODE, 'ip: the text is not an address');
      return [(a<<8)|b, (c<<8)|d];
    }
    return [Number.parseInt(token,16)];
  });
  const left=parse(present(halves[0], 'the first half of an IPv6 address')), right=parse(halves[1]??'');
  const groups=halves.length===2?[...left,...Array.from({ length: 8-left.length-right.length }, () => 0),...right]:left;
  if(groups.length!==8)throw new CodecError(codes.CODEC_ENCODE,'ip: the text is not an address');
  const out=Buffer.alloc(16);groups.forEach((group,index)=>out.writeUInt16BE(group,index*2));
  return out;
}

function unpackIp(value: Buffer): string {
  if(value.length===4)return [...value].join('.');
  if(value.length!==16)throw new CodecError(codes.CODEC_DECODE,'ip: the cell is not 4 or 16 packed bytes');
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

/** The text of UTF-8 bytes; bytes that are not UTF-8 are the CODEC_DECODE of the rule that reads them, with the failure of
 * the decoder as its cause (COD-70, COD-71). */
function string(value: Uint8Array, rule: string): string {
  try {
    return text.decode(value);
  } catch (error) {
    throw new CodecError(codes.CODEC_DECODE, rule, { cause: error });
  }
}

/** The nesting that the ordered-json parser reads, and that every value stage reads and writes (COD-70). */
const MAX_LEVELS = 256;

/** Whether the ordered-json parser refused a text for its nesting. */
function nestingRefused(error: unknown): boolean {
  return error instanceof JsonParseError && error.kind === 'maximum_depth_exceeded';
}

/**
 * The ordered-json value of a cell (COD-70 `json-cell`, `json-depth-read`), with the failure of the parser as its cause
 * (COD-71). The bytes are met in their order, so a cell that is not UTF-8 is `json-depth-read` when the text before its
 * first byte that is not UTF-8 already nests deeper than 256 levels.
 */
function decodeJson(cell: Uint8Array): JsonValue {
  try {
    return orderedJsonParseBytes(cell);
  } catch (error) {
    if (nestingRefused(error)) throw new CodecError(codes.CODEC_DECODE, 'json: value nesting exceeds 256 levels', { cause: error });
    if (error instanceof JsonParseError && error.kind === 'invalid_utf8') {
      try {
        orderedJsonParse(text.decode(cell.subarray(0, error.offset)));
      } catch (prefix) {
        if (nestingRefused(prefix)) throw new CodecError(codes.CODEC_DECODE, 'json: value nesting exceeds 256 levels', { cause: prefix });
      }
    }
    throw new CodecError(codes.CODEC_DECODE, 'json: the cell is not JSON', { cause: error });
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
  const cell: unknown = raw;
  if (typeof cell !== 'string' && !(cell instanceof Uint8Array)) throw new CodecError(codes.CODEC_DECODE, 'cell is not bytes');
  // An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an empty
  // cell for empty text (docs/spec/codec.md COD-14).
  if (raw.length === 0 && styles.length > 0 && styles.at(-1) !== 'base64') throw new CodecError(codes.CODEC_DECODE, 'styled cell is empty');
  let current = typeof raw === 'string' ? utf8.encode(raw) : raw;
  // A value stage is only the first style (checkStyles), which a decode applies last, so no stage follows a value.
  for (let index = styles.length - 1; index >= 0; index--) {
    const style = present(styles[index], `encoding style ${index}`);
    switch (style) {
      case 'gz':
        try {
          current = new Uint8Array(inflateSync(current));
        } catch (error) {
          throw new CodecError(codes.CODEC_DECODE, 'gz: bad zlib stream', { cause: error });
        }
        break;
      case 'base64':
        current = decodeBase64(current);
        break;
      case 'serialize':
        return StyledValue.value(new PhpParser(current).parse());
      case 'yaml':
        return StyledValue.value(decodeYaml(current));
      case 'ordered_json':
        return StyledValue.value(decodeJson(current));
      default:
        throw new CodecError(codes.CODEC_UNSUPPORTED, `style ${style}`);
    }
  }
  return StyledValue.value(string(current, 'decoded text is not valid UTF-8'));
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
 * (StyledValue of any payload) is encoded without asserting its type. The value is read as it was given, and the stage
 * refuses it by its own rules of COD-70.
 *
 * @internal
 */
export function encodeStyled(styles: readonly string[], state: StyledValue<unknown>): EncodedValue {
  checkStyles(styles);
  if (state.kind === 'sql-null') return null;
  let current = new Uint8Array();
  const transformed = storedValue(state);
  const first = styles[0];
  if (first === undefined || first === 'gz' || first === 'base64') {
    const stage = first === undefined ? 'an empty stage list' : `a first ${first} stage`;
    if (typeof transformed !== 'string') throw new CodecError(codes.CODEC_ENCODE, `${stage} takes a string value`);
    if (LONE_SURROGATE.test(transformed)) throw new CodecError(codes.CODEC_ENCODE, `${first === undefined ? '' : `${first}: `}the text is not a sequence of Unicode scalar values`);
    current = utf8.encode(transformed);
  }
  for (const style of styles) {
    switch (style) {
      case 'serialize':
        current = utf8.encode(phpSerialize(commonValue(transformed, 'serialize')));
        break;
      case 'yaml':
        current = utf8.encode(yamlStage(commonValue(transformed, 'yaml')));
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
          throw new CodecError(codes.CODEC_ENCODE, 'gz: the compression failed', { cause: error });
        }
        break;
      default:
        throw new CodecError(codes.CODEC_UNSUPPORTED, `style ${style}`);
    }
  }
  // Every stage before the last writes the UTF-8 of Unicode scalar values or base64 text, so the text of the cell is
  // the UTF-8 that the stages wrote (COD-72).
  return styles.at(-1) === 'gz' ? current : Buffer.from(current).toString('utf8');
}

/**
 * The yaml stage of an encode: the text of a value that the common value model holds, which is read back once written
 * (COD-70 `yaml-text`, `yaml-read-back`), each failure with the failure of the library as its cause (COD-71).
 */
function yamlStage(value: CodecValue): string {
  let written: string;
  try {
    written = yamlText(value);
  } catch (error) {
    throw new CodecError(codes.CODEC_ENCODE, 'yaml: the value has no YAML text', { cause: error });
  }
  try {
    decodeYaml(utf8.encode(written));
  } catch (error) {
    throw new CodecError(codes.CODEC_ENCODE, 'yaml: the written text does not read back as the value', { cause: error });
  }
  return written;
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

/**
 * The value of a serialize or yaml stage, which takes the common value model of COD-16: an ordered-json value is written
 * only by the ordered_json stage, and each node is checked in the order that the stage writes it, an object by its sorted
 * keys, so that the first rule that the stage meets is the error (COD-70).
 */
function commonValue(value: unknown, style: 'serialize' | 'yaml'): CodecValue {
  if (value instanceof JsonValue) throw new CodecError(codes.CODEC_ENCODE, `${style}: an ordered-json value is written only by the ordered_json stage`);
  checkCommonValue(value, style, new Set(), 1);
  return value;
}

/** Checks a node that a list or a map at `level` would be, the outermost one at level 1 (COD-70). */
function checkCommonValue(value: unknown, style: 'serialize' | 'yaml', ancestors: Set<object>, level: number): asserts value is CodecValue {
  const refused = (rule: string): CodecError => new CodecError(codes.CODEC_ENCODE, `${style}: ${rule}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'bigint') {
    if (!i64(value)) throw refused('integer is outside the i64 range');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw refused('number is not finite');
    return;
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw refused('the text is not a sequence of Unicode scalar values');
    return;
  }
  if (typeof value !== 'object') throw refused('the value is not a codec value');
  const list = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  // Only a list and a plain map are lists and maps of the model; the nesting rule of a level comes before the rules of
  // the node (COD-70).
  if (!list && proto !== Object.prototype && proto !== null) throw refused('the value is not a codec value');
  if (level > MAX_LEVELS) throw refused('value nesting exceeds 256 levels');
  // A list or a map whose members a stage would leave out, a cycle among them, is no value of the model.
  if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0) throw refused('the value is not a codec value');
  ancestors.add(value);
  if (list) {
    if (Object.keys(value).length !== value.length) throw refused('the value is not a codec value');
    for (const item of value) checkCommonValue(item, style, ancestors, level + 1);
  } else {
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) throw refused('the value is not a codec value');
    for (const [key, item] of sortedEntries(value)) {
      if (LONE_SURROGATE.test(key)) throw refused('the text is not a sequence of Unicode scalar values');
      checkCommonValue(item, style, ancestors, level + 1);
    }
  }
  ancestors.delete(value);
}

/** The order of map keys in which serialize and yaml write the members. */
const byKey = ([x]: [string, unknown], [y]: [string, unknown]): number => (x < y ? -1 : x > y ? 1 : 0);

/** The members of a map in the order of their keys. */
function sortedEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value).sort(byKey);
}

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
  const source = jsonText(value, 0);
  try {
    return orderedJsonParse(source);
  } catch (error) {
    throw new CodecError(codes.CODEC_ENCODE, 'json: the value has no JSON text', { cause: error });
  }
}

/** A JSON string: a text that is not a sequence of Unicode scalar values, such as a lone surrogate, is no JSON text (RFC
 * 8259, 8.1), so it is CODEC_ENCODE (COD-64), where JSON.stringify would write it as an escape. */
// A surrogate code point that is not one half of a pair, read by code point (the u flag).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function jsonString(text: string): string {
  if (LONE_SURROGATE.test(text)) throw new CodecError(codes.CODEC_ENCODE, 'json: the text is not a sequence of Unicode scalar values');
  return JSON.stringify(text);
}

/** The levels of the lists and maps of a JSON text, the outermost one level 1. */
function jsonTextLevels(source: string): number {
  let levels = 0;
  let open = 0;
  let inString = false;
  let escaped = false;
  for (const c of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') levels = Math.max(levels, ++open);
    else if (c === ']' || c === '}') open--;
  }
  return levels;
}

/**
 * The JSON text of a value, each node checked in its order (COD-70). depth is the number of lists and maps around the
 * node, so a list or a map is at level depth + 1, and the lists and maps of an ordered-json value at its place count from
 * there.
 */
function jsonText(value: unknown, depth: number): string {
  if (value instanceof JsonValue) {
    const stored = storedJsonText(value);
    if (depth + jsonTextLevels(stored) > MAX_LEVELS) throw new CodecError(codes.CODEC_ENCODE, 'json: value nesting exceeds 256 levels');
    return stored;
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return jsonString(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CodecError(codes.CODEC_ENCODE, 'json: non-finite number');
      return JSON.stringify(value);
    case 'bigint': return value.toString();
    case 'object': break;
    default: throw new CodecError(codes.CODEC_ENCODE, 'json: the value is not a JSON value');
  }
  const list = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (!list && proto !== Object.prototype && proto !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (value instanceof Uint8Array || typeof toJSON !== 'function') {
      throw new CodecError(codes.CODEC_ENCODE, 'json: the value is not a JSON value');
    }
    // The JSON form of the object stands at its place.
    return jsonText(toJSON.call(value), depth);
  }
  // The nesting rule of a list or a map comes before its own rules (COD-70).
  if (depth >= MAX_LEVELS) throw new CodecError(codes.CODEC_ENCODE, 'json: value nesting exceeds 256 levels');
  // A list or a map whose members the text would leave out is no JSON value.
  if (Object.getOwnPropertySymbols(value).length > 0) throw new CodecError(codes.CODEC_ENCODE, 'json: the value is not a JSON value');
  if (list) {
    if (Object.keys(value).length !== value.length) throw new CodecError(codes.CODEC_ENCODE, 'json: the value is not a JSON value');
    return `[${(value as unknown[]).map(item => jsonText(item, depth + 1)).join(',')}]`;
  }
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) throw new CodecError(codes.CODEC_ENCODE, 'json: the value is not a JSON value');
  const members: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new CodecError(codes.CODEC_ENCODE, 'json: a member is undefined');
    members.push(`${jsonString(key)}:${jsonText(item, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

// A character outside c-printable (YAML 1.2.2, 5.1), or a byte order mark, which is the encoding mark at the start of the
// stream (5.2) and never content.
const YAML_NOT_PRINTABLE = /[^\t\n\r\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufefe\uff00-\ufffd\u{10000}-\u{10ffff}]/u;

/**
 * The value of a YAML stream (COD-29, COD-70): the stream rules (UTF-8, c-printable) before its parse, then the nodes of
 * the one document in their order, each refused by its rule, and a failure of the library as `yaml-parse` with that
 * failure as its cause (COD-71). The parser keeps each key as the node it reads, so a key that is not a string or an
 * integer is refused by its kind, and duplicates are found here by the decimal string of an integral key.
 */
function decodeYaml(current: Uint8Array): CodecValue {
  const source = string(current, 'yaml: the stream is not UTF-8');
  const stream = source.startsWith('\ufeff') ? source.slice(1) : source;
  if (YAML_NOT_PRINTABLE.test(stream)) throw new CodecError(codes.CODEC_DECODE, 'yaml: the stream holds a character that is not printable');
  const documents = yamlDocuments(stream);
  // A stream without a document (empty, or comments only) is not a YAML value.
  const document = documents[0];
  if (document === undefined) throw yamlRule('no document');
  // Each document is met before the next, so the rules of the first come before the start of a second (COD-70).
  const value = yamlValue(document.contents, 1);
  const failure = document.errors[0] ?? document.warnings[0];
  if (failure !== undefined) throw new CodecError(codes.CODEC_DECODE, 'yaml: the stream does not parse', { cause: failure });
  if (documents.length > 1) throw yamlRule('multiple documents are not supported');
  return value;
}

/**
 * The documents of a YAML stream. The parser keeps each key as the node it reads, so that a key that is not a string or
 * an integer is refused by its kind, and duplicates are found by yamlValue; a failure of the library is yaml-parse.
 */
function yamlDocuments(stream: string) {
  try {
    return parseAllDocuments(stream, { version: '1.2', schema: 'core', strict: true, uniqueKeys: false, stringKeys: false, intAsBigInt: true });
  } catch (error) {
    throw new CodecError(codes.CODEC_DECODE, 'yaml: the stream does not parse', { cause: error });
  }
}

/** A rule of the yaml stage that a node of the document breaks. */
function yamlRule(rule: string): CodecError {
  return new CodecError(codes.CODEC_DECODE, `yaml: ${rule}`);
}

/**
 * The value of a node of a YAML document, its nodes read in their order, each node where it starts (COD-70): first an
 * alias, an anchor and an explicit tag, the core tags included (the parser sets a node's anchor and tag only when the
 * text writes them), then the nesting rule of its level, where a sequence or a mapping at `level` is refused past 256
 * levels, then its own rules: an integer is within i64 and a float is finite. A key comes before its value: a collection
 * is no key, a plain key that the core schema reads as a boolean, a null or a float is no key, and an integral key is its
 * decimal string, so two keys of one string are duplicates (COD-29). The parsed nodes are the four kinds of the library
 * and the empty node, each handled.
 */
function yamlValue(node: ParsedNode | null, level: number): CodecValue {
  if (node === null) return null;
  yamlNodeStart(node, level);
  if (isScalar(node)) return yamlScalar(node.value);
  if (isSeq(node)) return node.items.map(item => yamlValue(item, level + 1));
  const members: { [key: string]: CodecValue } = {};
  const seen = new Set<string>();
  for (const pair of node.items) {
    const key = pair.key;
    if (key !== null) yamlNodeStart(key, level + 1);
    if (!isScalar(key)) throw yamlRule('map keys must be scalar strings');
    const name: unknown = key.value;
    if (typeof name !== 'string' && typeof name !== 'bigint') throw yamlRule('map keys must be strings or integers');
    if (typeof name === 'bigint' && !i64(name)) throw yamlRule('integer is outside the i64 range');
    const text = String(name);
    if (seen.has(text)) throw yamlRule('duplicate map key');
    seen.add(text);
    Object.defineProperty(members, text, { value: yamlValue(pair.value, level + 1), enumerable: true, writable: true, configurable: true });
  }
  return members;
}

/** The rules of a node that are met where it starts: an alias, its anchor, its tag, and for a sequence or a mapping the
 * nesting rule of its level. */
function yamlNodeStart(node: ParsedNode, level: number): asserts node is Exclude<ParsedNode, Alias.Parsed> {
  if (isAlias(node)) throw yamlRule('aliases are not supported');
  if (node.anchor !== undefined) throw yamlRule('anchors are not supported');
  if (node.tag !== undefined) throw yamlRule('explicit tags are not supported');
  if (!isScalar(node) && level > MAX_LEVELS) throw yamlRule('value nesting exceeds 256 levels');
}

/** The value of a scalar of the core schema read with intAsBigInt: a null, a boolean, a string, a bigint or a number. */
function yamlScalar(value: unknown): CodecValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    if (!i64(value)) throw yamlRule('integer is outside the i64 range');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw yamlRule('number is not finite');
    return value;
  }
  // The core schema resolves a scalar only to the five kinds above; a value of another kind is the library's own, which
  // the stage does not read (COD-72).
  throw new CodecError(codes.CODEC_DECODE, 'yaml: the stream does not parse', { cause: new TypeError(`the YAML library read a scalar as ${typeof value}`) });
}

/** The serialize text of a value that commonValue checked. */
function phpSerialize(value: CodecValue): string {
  if (value === null) return 'N;';
  if (typeof value === 'boolean') return value ? 'b:1;' : 'b:0;';
  if (typeof value === 'bigint') return `i:${value};`;
  if (typeof value === 'number') return `d:${phpFloat(value)};`;
  if (typeof value === 'string') return `s:${utf8.encode(value).length}:"${value}";`;
  if (Array.isArray(value)) {
    return `a:${value.length}:{${value.map((item, index) => `i:${index};${phpSerialize(item)}`).join('')}}`;
  }
  const entries = Object.entries(value).sort(byKey);
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

// The d field of the PHP grammar: an optional sign, digits with an optional fraction or a fraction alone, and an optional
// exponent (COD-70 `serialize-float`).
const PHP_FLOAT = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * The reader of a serialize cell (COD-16, COD-70). Each refusal is the one text of its rule, which names no position: a
 * value that starts at the end of the cell is `unexpected end`, and a delimiter that the grammar needs, at the end of the
 * cell or not, is `expected <delimiter>`. A field is read as its bytes, so a byte that is not UTF-8 is a field of a bad
 * form, and only the bytes of a string are read as UTF-8.
 */
class PhpParser {
  private index = 0;
  /** The number of a fields around the value being read. */
  private depth = 0;

  public constructor(private readonly input: Uint8Array) {}

  public parse(): CodecValue {
    const value = this.value();
    if (this.index !== this.input.length) this.fail('trailing data');
    return value;
  }

  private fail(rule: string): never {
    throw new CodecError(codes.CODEC_DECODE, `serialize: ${rule}`);
  }

  /** The type letter of the value that starts here. */
  private type(): string {
    const byte = this.input[this.index];
    if (byte === undefined) this.fail('unexpected end');
    this.index++;
    return String.fromCharCode(byte);
  }

  private expect(expected: number): void {
    if (this.input[this.index] !== expected) this.fail(`expected ${String.fromCharCode(expected)}`);
    this.index++;
  }

  /** The bytes of a field up to its delimiter, as latin1 text so that each byte is one character. */
  private until(delimiter: number): string {
    const start = this.index;
    while (this.index < this.input.length && this.input[this.index] !== delimiter) this.index++;
    if (this.index >= this.input.length) this.fail(`expected ${String.fromCharCode(delimiter)}`);
    const result = Buffer.from(this.input.subarray(start, this.index)).toString('latin1');
    this.index++;
    return result;
  }

  private int(): bigint {
    this.expect(58);
    const raw = this.until(59);
    if (!/^[+-]?[0-9]+$/.test(raw)) this.fail('bad int');
    const value = BigInt(raw);
    if (!i64(value)) this.fail('integer is outside the i64 range');
    return value;
  }

  private string(): string {
    this.expect(58);
    const field = this.until(58);
    if (!/^[0-9]+$/.test(field)) this.fail('bad string length');
    const length = Number(field);
    this.expect(34);
    if (this.index + length > this.input.length) this.fail('string overruns input');
    const bytes = this.input.subarray(this.index, this.index + length);
    if (!isUtf8(bytes)) this.fail('string is not valid UTF-8');
    this.index += length;
    this.expect(34);
    this.expect(59);
    return Buffer.from(bytes).toString('utf8');
  }

  private value(): CodecValue {
    const type = this.type();
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
      case 'i':
        return this.int();
      case 'd': {
        this.expect(58);
        const raw = this.until(59);
        if (raw === 'NAN' || raw === 'INF' || raw === '-INF') this.fail('non-finite float');
        if (!PHP_FLOAT.test(raw)) this.fail('bad float');
        const value = Number(raw);
        if (!Number.isFinite(value)) this.fail('non-finite float');
        return value;
      }
      case 's':
        return this.string();
      case 'a':
        // The nesting rule of a level is met where its a field starts, before its length (COD-70).
        if (this.depth >= MAX_LEVELS) this.fail('value nesting exceeds 256 levels');
        return this.array();
      case 'O':
      case 'C':
      case 'r':
      case 'R':
        throw new CodecError(codes.CODEC_UNSUPPORTED, 'serialize: objects and references are not supported');
      default:
        this.fail('unknown type');
    }
  }

  private array(): CodecValue {
    this.expect(58);
    const field = this.until(58);
    if (!/^[0-9]+$/.test(field)) this.fail('bad array length');
    const count = Number(field);
    this.expect(123);
    const entries: Array<[string, CodecValue]> = [];
    // An integer key is its decimal string, so i:1; and s:1:"1"; are one key (COD-70 `serialize-duplicate`).
    const seen = new Set<string>();
    let sequential = true;
    this.depth++;
    for (let index = 0; index < count; index++) {
      // A key is an int or a string, told by its type letter before its field is read.
      const type = this.type();
      if (type !== 'i' && type !== 's') this.fail('array key must be int or string');
      const key = type === 'i' ? this.int() : this.string();
      const name = String(key);
      if (seen.has(name)) this.fail('duplicate array key');
      seen.add(name);
      if (typeof key !== 'bigint' || key !== BigInt(index)) sequential = false;
      entries.push([name, this.value()]);
    }
    this.depth--;
    this.expect(125);
    if (sequential) return entries.map(([, value]) => value);
    return Object.fromEntries(entries);
  }
}
