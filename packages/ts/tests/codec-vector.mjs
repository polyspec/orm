import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { CodecError, StyledValue, blindIndex, decodeCodec, encodeCodec, hostDecode, hostEncode } from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

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
// The vectors name the Mermaid styles; json and jsons are both the ordered_json stage.
const stagesOf = styles => styles.map(style => (style === 'json' || style === 'jsons' ? 'ordered_json' : style));
// check runs the checks of one case, which push each problem they find to the list it is given, and fails the case with
// every problem.
const check = (name, body) => caseTest(name, COMPUTE, async () => {
  const wrong = [];
  await body(wrong);
  if (wrong.length > 0) throw new Error(`${name}:\n${wrong.join('\n')}`);
});

// Each codec vector (tests/codec/vectors.json) is one case named by the vector.
for (const vector of vectors) check(vector.name, wrong => {
  const raw = vector.encoded_b64 === null ? null : Buffer.from(vector.encoded_b64, 'base64');
  let decoded;
  try {
    decoded = decodeCodec(stagesOf(vector.styles), raw);
  } catch (error) {
    wrong.push(`decode ${String(error)}`);
    return;
  }
  const jsonStage = stagesOf(vector.styles).includes('ordered_json');
  const kind = raw === null ? 'sql-null' : 'value';
  if (!(decoded instanceof StyledValue) || decoded.kind !== kind) {
    wrong.push(`decoded state ${shown(decoded)} want ${kind}`);
    return;
  }
  const payload = kind === 'value' ? decoded.payload() : null;
  if (jsonStage && kind === 'value' && !(payload instanceof JsonValue)) {
    wrong.push(`a json stage decoded ${typeof decoded}, not an ordered-json value`);
  }
  if (!same(payload, vector.value)) {
    wrong.push(`decoded ${shown(payload)} want ${JSON.stringify(vector.value)}`);
  }
  const encoded = encodeCodec(stagesOf(vector.styles), decoded);
  const encodedBase64 = encoded === null ? null : Buffer.from(encoded).toString('base64');
  output[vector.name] = encodedBase64;
  const integralFloat = vector.name.endsWith('/integral_float') && vector.styles.includes('serialize');
  if (vector.deterministic && !integralFloat && encodedBase64 !== vector.encoded_b64) {
    wrong.push(`encoded ${encodedBase64} want ${vector.encoded_b64}`);
  }
  const roundTrip = decodeCodec(stagesOf(vector.styles), encoded);
  if (!(roundTrip instanceof StyledValue) || roundTrip.kind !== kind || !same(kind === 'value' ? roundTrip.payload() : null, vector.value)) {
    wrong.push(`round trip ${shown(roundTrip)} want ${JSON.stringify(vector.value)}`);
  }
});

// Each AES vector (tests/codec/aes-vectors.json) is one case named by its key.
for (const vector of aesVectors) check(vector.key, wrong => {
  const encoded = hostEncode(vector.plain, ['aes', 'hex'], vector.key);
  const decoded = hostDecode(encoded, ['aes', 'hex'], vector.key);
  if (decoded !== vector.plain) wrong.push(`aes round trip ${JSON.stringify(vector.plain)}: ${decoded}`);
  const fixedDecoded = hostDecode(vector.envelope_hex, ['aes', 'hex'], vector.key);
  if (fixedDecoded !== vector.plain) wrong.push(`aes fixed vector: ${fixedDecoded} want ${vector.plain}`);
});

// The value checks that no vector file holds run as one case.
check('codec values', wrong => {
  if (blindIndex('member@example.test', 'blind-key') !== '1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8') wrong.push('blind index');
  for (const [name, operation, code] of [
    ['bad JSON', () => decodeCodec(['ordered_json'], '{bad'), 'CODEC_DECODE'],
    ['bad base64', () => decodeCodec(['serialize', 'base64'], '@@@'), 'CODEC_DECODE'],
    ['serialized object', () => decodeCodec(['serialize'], 'O:8:"stdClass":0:{}'), 'CODEC_UNSUPPORTED'],
    ['bad zlib', () => decodeCodec(['serialize', 'gz'], 'not zlib'), 'CODEC_DECODE'],
    ['unknown style', () => encodeCodec(['unknown'], StyledValue.value('value')), 'CODEC_UNSUPPORTED'],
    ['unknown encode style', () => encodeCodec(['filepart', 'serialize'], StyledValue.value({})), 'CODEC_UNSUPPORTED'],
    ['unknown decode style', () => decodeCodec(['filepart'], 'a:0:{}'), 'CODEC_UNSUPPORTED'],
    ['duplicate YAML key', () => decodeCodec(['yaml'], 'a: 1\na: 2\n'), 'CODEC_DECODE'],
    ['multiple YAML documents', () => decodeCodec(['yaml'], '---\na: 1\n---\na: 2\n'), 'CODEC_DECODE'],
    ['YAML alias', () => decodeCodec(['yaml'], 'a: &x [1]\nb: *x\n'), 'CODEC_DECODE'],
    ['YAML custom tag', () => decodeCodec(['yaml'], 'a: !custom value\n'), 'CODEC_DECODE'],
    ['YAML non-finite number', () => decodeCodec(['yaml'], 'value: .inf\n'), 'CODEC_DECODE'],
    ['YAML boolean map key', () => decodeCodec(['yaml'], 'true: value\n'), 'CODEC_DECODE'],
    ['invalid YAML order', () => encodeCodec(['serialize', 'yaml'], StyledValue.value({})), 'CODEC_UNSUPPORTED'],
  ]) {
    try {
      operation();
      wrong.push(`${name}: expected ${code}`);
    } catch (error) {
      if (!(error instanceof CodecError) || error.code !== code) {
        wrong.push(`${name}: ${String(error)} want ${code}`);
      }
    }
  }

  {
    const encoded = hostEncode('tamper@example.test', ['aes'], 'tamper-key');
    const tampered = new Uint8Array(encoded);
    tampered[tampered.length - 1] ^= 1;
    let rejected = false;
    try { hostDecode(tampered, ['aes'], 'tamper-key'); } catch (error) { rejected = error?.code === 'CODEC_DECODE'; }
    if (!rejected) { wrong.push('tampered AES ciphertext was accepted'); }
  }
  for (const address of ['10.1.2.3', '2001:db8::1', '::1', '::ffff:10.1.2.3']) {
    const encoded = hostEncode(address, ['ip'], '');
    const decoded = hostDecode(encoded, ['ip'], '');
    const expected = address === '::ffff:10.1.2.3' ? '10.1.2.3' : address;
    if (decoded !== expected) { wrong.push(`ip ${address}: ${decoded} want ${expected}`); }
  }

  const orderedText = '{"b":1,"a":[],"c":{},"n":1.50}';
  const orderedRead = decodeCodec(['ordered_json'], orderedText);
  if (!(orderedRead instanceof StyledValue) || orderedRead.kind !== 'value' || !(orderedRead.payload() instanceof JsonValue) || stringifyJson(orderedRead.payload()) !== orderedText) {
    wrong.push(`json read: ${orderedRead instanceof StyledValue && orderedRead.kind === 'value' ? stringifyJson(orderedRead.payload()) : String(orderedRead)}`);
  }
  for (const [name, value] of [['ordered-json value', parseJson(orderedText)], ['common value model with a nested ordered-json value', { b: 1, a: [], c: {}, n: parseJson('1.50') }]]) {
    const written = encodeCodec(['ordered_json'], StyledValue.value(value));
    if (written !== orderedText) { wrong.push(`json write of ${name}: ${written}`); }
  }
  for (const value of [Number.NaN, { a: undefined }, new Uint8Array([1])]) {
    try { encodeCodec(['ordered_json'], StyledValue.value(value)); wrong.push(`json write of ${String(value)}: expected CODEC_ENCODE`); }
    catch (error) { if (error?.code !== 'CODEC_ENCODE') { wrong.push(`json write: ${String(error)} want CODEC_ENCODE`); } }
  }
  try { encodeCodec(['serialize'], StyledValue.value(parseJson('{}'))); wrong.push('serialize of an ordered-json value: expected CODEC_ENCODE'); }
  catch (error) { if (!(error instanceof CodecError) || error.code !== 'CODEC_ENCODE') { wrong.push(`serialize of an ordered-json value: ${String(error)}`); } }
  if (!same(decodeCodec(['yaml'], '1: value\n').payload(), { 1: 'value' })) {
    wrong.push('YAML integer map key: expected string key');
  }
  for (const [name, stage] of [['gz', 'gz'], ['base64', 'base64']]) {
    const written = encodeCodec([stage], StyledValue.value('stored text'));
    const read = decodeCodec([stage], written);
    if (read.kind !== 'value' || read.payload() !== 'stored text') { wrong.push(`${name} of a string: ${String(read.payload())}`); }
    try { encodeCodec([stage], StyledValue.value({ a: 1 })); wrong.push(`${name} of a map: expected CODEC_ENCODE`); }
    catch (error) { if (!(error instanceof CodecError) || error.code !== 'CODEC_ENCODE') { wrong.push(`${name} of a map: ${String(error)}`); } }
  }

});

// The encoded output of every codec vector goes only to the directory that ORM_CODEC_OUT (make codec-check) names; it is
// written to a temporary file and then renamed.
check('codec output', async () => {
  const directory = process.env.ORM_CODEC_OUT;
  if (directory) {
    await mkdir(directory, { recursive: true });
    const temporary = `${directory}/typescript.json.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
    await rename(temporary, `${directory}/typescript.json`);
  }
});

// 공유 decode vector(tests/codec/decode-vectors.json): 저장 cell은 encoder가 쓰는 형태로만 decode되고 그 밖의
// 형태는 CODEC_DECODE다. aes가 없는 host stage 목록은 key 없는 hostDecode로, 나머지는 decodeCodec로 읽는다.
const decodeVectors = JSON.parse(await readFile('tests/codec/decode-vectors.json', 'utf8')).vectors;
if (decodeVectors.length === 0) throw new Error('decode-vectors.json has no vectors');
for (const vector of decodeVectors) check(vector.name, wrong => {
  const raw = vector.stored !== undefined ? Buffer.from(vector.stored, 'utf8') : Buffer.from(vector.stored_hex, 'hex');
  const host = vector.styles.every(style => style === 'hex' || style === 'ip');
  let got;
  let code = '';
  try {
    got = host ? hostDecode(vector.stored ?? raw, vector.styles, '') : decodeCodec(vector.styles, raw).payload();
  } catch (error) {
    code = error instanceof CodecError ? error.code : String(error);
  }
  if (vector.error !== undefined ? code !== vector.error : (code !== '' || !isDeepStrictEqual(got, vector.value))) {
    wrong.push(`got ${code || JSON.stringify(got)}, want ${vector.error ?? JSON.stringify(vector.value)}`);
  }
});
