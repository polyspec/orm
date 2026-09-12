import { readFile, writeFile } from 'node:fs/promises';
import { CodecError, decodeCodec, encodeCodec, hostDecode, hostEncode, parsePoint, pointText } from '../../clients/typescript/dist/index.js';

const vectors = JSON.parse(await readFile('tests/codec/vectors.json', 'utf8')).vectors;
const aesVectors = JSON.parse(await readFile('tests/codec/aes-vectors.json', 'utf8')).vectors;
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const output = {};
let failures = 0;

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
  if (!same(decoded, vector.value)) {
    console.error(`${vector.name}: decoded ${JSON.stringify(decoded)} want ${JSON.stringify(vector.value)}`);
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
    console.error(`${vector.name}: round trip ${JSON.stringify(roundTrip)} want ${JSON.stringify(vector.value)}`);
    failures++;
  }
}

for (const [name, operation, code] of [
  ['bad JSON', () => decodeCodec(['json'], '{bad'), 'CODEC_DECODE'],
  ['bad base64', () => decodeCodec(['serialize', 'base64'], '@@@'), 'CODEC_DECODE'],
  ['serialized object', () => decodeCodec(['serialize'], 'O:8:"stdClass":0:{}'), 'CODEC_UNSUPPORTED'],
  ['bad zlib', () => decodeCodec(['serialize', 'gz'], 'not zlib'), 'CODEC_DECODE'],
  ['unknown style', () => encodeCodec(['unknown'], 'value'), 'CODEC_UNSUPPORTED'],
  ['invalid public upload file', () => encodeCodec(['curlfile', 'serialize'], { $type: 'upload_file', path: '', mime: 'text/plain', name: 'a.txt' }), 'CODEC_ENCODE'],
  ['invalid stored upload file', () => decodeCodec(['curlfile', 'serialize'], 'a:4:{s:12:"is_curl_file";b:1;s:4:"mime";s:10:"text/plain";s:4:"name";s:5:"a.txt";s:4:"path";s:0:"";}'), 'CODEC_DECODE'],
  ['invalid curlfile order', () => encodeCodec(['serialize', 'curlfile'], {}), 'CODEC_UNSUPPORTED'],
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
for (const address of ['10.1.2.3', '2001:db8::1', '::1', '::ffff:10.1.2.3']) {
  const encoded = hostEncode(address, ['ip'], '');
  const decoded = hostDecode(encoded, ['ip'], '');
  const expected = address === '::ffff:10.1.2.3' ? '10.1.2.3' : address;
  if (decoded !== expected) { console.error(`ip ${address}: ${decoded} want ${expected}`); failures++; }
}

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

await writeFile('tests/codec/out/typescript.json', `${JSON.stringify(output, null, 2)}\n`);
if (failures > 0) throw new Error(`TypeScript codec vectors: ${failures} failure(s)`);
console.log(`typescript: ${vectors.length} codec vectors passed`);
