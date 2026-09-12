import { deflateSync, inflateSync } from 'node:zlib';
import { isScalar, parseDocument, stringify as stringifyYaml, visit } from 'yaml';

export type UploadFileValue = { $type: 'upload_file'; path: string; mime: string; name: string };
export type CodecValue = null | boolean | number | string | CodecValue[] | { [key: string]: CodecValue };
export type EncodedValue = string | Uint8Array | null;

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
  const source = string(value, 'decode').trim();
  if (source.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) {
    throw new CodecError('CODEC_DECODE', 'base64: bad input');
  }
  return new Uint8Array(Buffer.from(source, 'base64'));
}

export function decode(styles: readonly string[], raw: string | Uint8Array | null): CodecValue {
  if (raw === null || raw.length === 0) return null;
  let current = bytes(raw);
  let value: CodecValue | undefined;
  for (let index = styles.length - 1; index >= 0; index--) {
    const style = styles[index]!;
    if (style === 'curlfile') {
      if (value === undefined) throw new CodecError('CODEC_UNSUPPORTED', 'curlfile must precede serialize on write');
      value = restoreUploadFiles(value);
      continue;
    }
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
      case 'json':
      case 'jsons':
        try {
          value = JSON.parse(string(current, 'decode')) as CodecValue;
        } catch (error) {
          throw new CodecError('CODEC_DECODE', `json: ${String(error)}`);
        }
        break;
      default:
        throw new CodecError('CODEC_UNSUPPORTED', `style ${style}`);
    }
  }
  return value ?? string(current, 'decode');
}

export function encode(styles: readonly string[], value: CodecValue): EncodedValue {
  if (value === null) return null;
  let current = new Uint8Array();
  let transformed: CodecValue = value;
  for (let index = 0; index < styles.length; index++) {
    const style = styles[index]!;
    switch (style) {
      case 'curlfile':
        if (index !== 0) throw new CodecError('CODEC_UNSUPPORTED', 'curlfile must be the first style');
        transformed = prepareUploadFiles(transformed);
        break;
      case 'serialize':
        if (index !== 0 && !(index === 1 && styles[0] === 'curlfile')) throw new CodecError('CODEC_UNSUPPORTED', 'serialize must be the first encoding style');
        current = utf8.encode(phpSerialize(transformed));
        break;
      case 'yaml':
        if (index !== 0) throw new CodecError('CODEC_UNSUPPORTED', 'yaml must be the first style');
        try {
          current = utf8.encode(stringifyYaml(validateCodecValue(transformed, 'yaml encode'), { version: '1.2', schema: 'core', sortMapEntries: true }));
        } catch (error) {
          throw new CodecError('CODEC_ENCODE', `yaml: ${String(error)}`);
        }
        break;
      case 'json':
      case 'jsons':
        if (index !== 0) throw new CodecError('CODEC_UNSUPPORTED', 'json must be the first style');
        try {
          current = utf8.encode(JSON.stringify(transformed));
        } catch (error) {
          throw new CodecError('CODEC_ENCODE', `json: ${String(error)}`);
        }
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

function decodeYaml(current: Uint8Array): CodecValue {
  try {
    const document = parseDocument(string(current, 'decode'), { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true });
    if (document.errors.length > 0) throw document.errors[0];
    if (document.warnings.length > 0) throw document.warnings[0];
    visit(document, {
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('map keys must be scalar strings');
        if (pair.key.type === 'PLAIN' && /^(?:true|false|null|~|[-+]?(?:\d+\.\d*|\.\d+)(?:e[-+]?\d+)?|[-+]?\d+e[-+]?\d+|[-+]?\.(?:inf|nan))$/i.test(pair.key.source ?? '')) {
          throw new Error('plain boolean, null, and floating-point map keys are not supported');
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
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, validateCodecValue(item, operation)]));
  }
  throw new Error(`${operation}: value type is not supported`);
}

function prepareUploadFiles(value: CodecValue): CodecValue {
  if (Array.isArray(value)) return value.map(prepareUploadFiles);
  if (value !== null && typeof value === 'object') {
    if (value.$type === 'upload_file') {
      const keys = Object.keys(value);
      if (keys.length !== 4 || typeof value.path !== 'string' || value.path === '' || typeof value.mime !== 'string' || typeof value.name !== 'string' || value.name === '') {
        throw new CodecError('CODEC_ENCODE', 'curlfile: upload_file requires non-empty path and name plus string mime');
      }
      return { is_curl_file: true, mime: value.mime, name: value.name, path: value.path };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prepareUploadFiles(item)]));
  }
  return value;
}

function restoreUploadFiles(value: CodecValue): CodecValue {
  if (Array.isArray(value)) return value.map(restoreUploadFiles);
  if (value !== null && typeof value === 'object') {
    if (value.is_curl_file === true) {
      const keys = Object.keys(value);
      if (keys.length !== 4 || typeof value.path !== 'string' || value.path === '' || typeof value.mime !== 'string' || typeof value.name !== 'string' || value.name === '') {
        throw new CodecError('CODEC_DECODE', 'curlfile: invalid stored upload file');
      }
      return { $type: 'upload_file', mime: value.mime, name: value.name, path: value.path };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreUploadFiles(item)]));
  }
  return value;
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
  const keys = Object.keys(value).sort();
  return `a:${keys.length}:{${keys.map(key => `${phpKey(key)}${phpSerialize(value[key]!)}`).join('')}}`;
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
  const mantissa = match[1]!.includes('.') ? match[1]! : `${match[1]}.0`;
  const exponent = Number(`${match[2] || '+'}${match[3]}`);
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
    if (this.index >= this.input.length) this.fail('unexpected end');
    return this.input[this.index++]!;
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
