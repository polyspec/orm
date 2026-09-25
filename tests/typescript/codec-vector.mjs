import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CodecError, blindIndex, decodeCodec, encodeCodec, hostDecode, hostEncode, parsePoint, pointText } from '../../clients/typescript/dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '../../clients/typescript/node_modules/ordered-json/js/index.js';

const vectors = JSON.parse(await readFile('tests/codec/vectors.json', 'utf8')).vectors;
const aesVectors = JSON.parse(await readFile('tests/codec/aes-vectors.json', 'utf8')).vectors;
const canonical = value => {
  if (value instanceof JsonValue) return canonical(JSON.parse(stringifyJson(value)));
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const shown = value => JSON.stringify(canonical(value));
const output = {};
let failures = 0;
if (blindIndex('member@example.test', 'blind-key') !== '1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8') failures++;

for (const vector of vectors) {
  const raw = vector.encoded_b64 === null ? null : Buffer.from(vector.encoded_b64, 'base64');
  let decoded;
  try {
    decoded = decodeCodec(vector.styles, raw);
  } catch (error) {
    console.error(`${vector.name}: decode ${String(error)}`);
    failures++;
    continue;
  }
  const jsonStage = vector.styles.includes('json') || vector.styles.includes('jsons');
  if (jsonStage && decoded !== null && !(decoded instanceof JsonValue)) {
    console.error(`${vector.name}: a json stage decoded ${typeof decoded}, not an ordered-json value`);
    failures++;
  }
  if (!same(decoded, vector.value)) {
    console.error(`${vector.name}: decoded ${shown(decoded)} want ${JSON.stringify(vector.value)}`);
    failures++;
  }
  const encoded = encodeCodec(vector.styles, decoded);
  const encodedBase64 = encoded === null ? null : Buffer.from(encoded).toString('base64');
  output[vector.name] = encodedBase64;
  const integralFloat = vector.name.endsWith('/integral_float') && vector.styles.includes('serialize');
  if (vector.deterministic && !integralFloat && encodedBase64 !== vector.encoded_b64) {
    console.error(`${vector.name}: encoded ${encodedBase64} want ${vector.encoded_b64}`);
    failures++;
  }
  const roundTrip = decodeCodec(vector.styles, encoded);
  if (!same(roundTrip, vector.value)) {
    console.error(`${vector.name}: round trip ${shown(roundTrip)} want ${JSON.stringify(vector.value)}`);
    failures++;
  }
}

for (const [name, operation, code] of [
  ['bad JSON', () => decodeCodec(['json'], '{bad'), 'CODEC_DECODE'],
  ['bad base64', () => decodeCodec(['serialize', 'base64'], '@@@'), 'CODEC_DECODE'],
  ['serialized object', () => decodeCodec(['serialize'], 'O:8:"stdClass":0:{}'), 'CODEC_UNSUPPORTED'],
  ['bad zlib', () => decodeCodec(['serialize', 'gz'], 'not zlib'), 'CODEC_DECODE'],
  ['unknown style', () => encodeCodec(['unknown'], 'value'), 'CODEC_UNSUPPORTED'],
  ['unknown encode style', () => encodeCodec(['curlfile', 'serialize'], {}), 'CODEC_UNSUPPORTED'],
  ['unknown decode style', () => decodeCodec(['curlfile'], 'a:0:{}'), 'CODEC_UNSUPPORTED'],
  ['duplicate YAML key', () => decodeCodec(['yaml'], 'a: 1\na: 2\n'), 'CODEC_DECODE'],
  ['multiple YAML documents', () => decodeCodec(['yaml'], '---\na: 1\n---\na: 2\n'), 'CODEC_DECODE'],
  ['YAML alias', () => decodeCodec(['yaml'], 'a: &x [1]\nb: *x\n'), 'CODEC_DECODE'],
  ['YAML custom tag', () => decodeCodec(['yaml'], 'a: !custom value\n'), 'CODEC_DECODE'],
  ['YAML non-finite number', () => decodeCodec(['yaml'], 'value: .inf\n'), 'CODEC_DECODE'],
  ['YAML boolean map key', () => decodeCodec(['yaml'], 'true: value\n'), 'CODEC_DECODE'],
  ['invalid YAML order', () => encodeCodec(['serialize', 'yaml'], {}), 'CODEC_UNSUPPORTED'],
]) {
  try {
    operation();
    console.error(`${name}: expected ${code}`);
    failures++;
  } catch (error) {
    if (!(error instanceof CodecError) || error.code !== code) {
      console.error(`${name}: ${String(error)} want ${code}`);
      failures++;
    }
  }
}

for (const vector of aesVectors) {
  const encoded = hostEncode(vector.plain, ['aes', 'hex'], vector.key);
  const decoded = hostDecode(encoded, ['aes', 'hex'], vector.key);
  if (decoded !== vector.plain) { console.error(`aes round trip ${JSON.stringify(vector.plain)}: ${decoded}`); failures++; }
  const fixedDecoded = hostDecode(vector.envelope_hex, ['aes', 'hex'], vector.key);
  if (fixedDecoded !== vector.plain) { console.error(`aes fixed vector: ${fixedDecoded} want ${vector.plain}`); failures++; }
}
{
  const encoded = hostEncode('tamper@example.test', ['aes'], 'tamper-key');
  const tampered = new Uint8Array(encoded);
  tampered[tampered.length - 1] ^= 1;
  let rejected = false;
  try { hostDecode(tampered, ['aes'], 'tamper-key'); } catch (error) { rejected = error?.code === 'CODEC_DECODE'; }
  if (!rejected) { console.error('tampered AES ciphertext was accepted'); failures++; }
}
for (const address of ['10.1.2.3', '2001:db8::1', '::1', '::ffff:10.1.2.3']) {
  const encoded = hostEncode(address, ['ip'], '');
  const decoded = hostDecode(encoded, ['ip'], '');
  const expected = address === '::ffff:10.1.2.3' ? '10.1.2.3' : address;
  if (decoded !== expected) { console.error(`ip ${address}: ${decoded} want ${expected}`); failures++; }
}

const orderedText = '{"b":1,"a":[],"c":{},"n":1.50}';
const orderedRead = decodeCodec(['json'], orderedText);
if (!(orderedRead instanceof JsonValue) || stringifyJson(orderedRead) !== orderedText) {
  console.error(`json read: ${orderedRead instanceof JsonValue ? stringifyJson(orderedRead) : String(orderedRead)}`);
  failures++;
}
for (const [name, value] of [['ordered-json value', parseJson(orderedText)], ['common value model with a nested ordered-json value', { b: 1, a: [], c: {}, n: parseJson('1.50') }]]) {
  const written = encodeCodec(['json'], value);
  if (written !== orderedText) { console.error(`json write of ${name}: ${written}`); failures++; }
}
for (const value of [Number.NaN, { a: undefined }, new Uint8Array([1])]) {
  try { encodeCodec(['json'], value); console.error(`json write of ${String(value)}: expected CODEC_ENCODE`); failures++; }
  catch (error) { if (!(error instanceof CodecError) || error.code !== 'CODEC_ENCODE') { console.error(`json write: ${String(error)} want CODEC_ENCODE`); failures++; } }
}
try { encodeCodec(['serialize'], parseJson('{}')); console.error('serialize of an ordered-json value: expected CODEC_ENCODE'); failures++; }
catch (error) { if (!(error instanceof CodecError) || error.code !== 'CODEC_ENCODE') { console.error(`serialize of an ordered-json value: ${String(error)}`); failures++; } }
if (!same(decodeCodec(['yaml'], '1: value\n'), { 1: 'value' })) {
  console.error('YAML integer map key: expected string key');
  failures++;
}
if (!same(parsePoint('POINT(1.25 -2)'), [1.25, -2]) || !same(parsePoint('(1.25,-2)'), [1.25, -2]) || pointText([1.25, -2]) !== 'POINT(1.25 -2)') {
  console.error('point conversion failed');
  failures++;
}
if (pointText([-0, 0]) !== 'POINT(0 0)') { console.error('point negative zero normalization failed'); failures++; }
for (const [name, operation, code] of [
  ['invalid point text', () => parsePoint('POINT(1)'), 'CODEC_DECODE'],
  ['non-finite point', () => pointText([1, Number.NaN]), 'CODEC_ENCODE'],
]) {
  try { operation(); console.error(`${name}: expected ${code}`); failures++; }
  catch (error) { if (!(error instanceof CodecError) || error.code !== code) { console.error(`${name}: ${String(error)} want ${code}`); failures++; } }
}

await mkdir('tests/codec/out', { recursive: true });
await writeFile('tests/codec/out/typescript.json', `${JSON.stringify(output, null, 2)}\n`);
if (failures > 0) throw new Error(`TypeScript codec vectors: ${failures} failure(s)`);
console.log(`typescript: ${vectors.length} codec vectors passed`);
