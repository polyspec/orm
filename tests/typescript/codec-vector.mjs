import { readFile, writeFile } from 'node:fs/promises';
import { CodecError, decodeCodec, encodeCodec } from '../../clients/typescript/dist/index.js';

const vectors = JSON.parse(await readFile('tests/codec/vectors.json', 'utf8')).vectors;
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

if (!same(decodeCodec(['yaml'], '1: value\n'), { 1: 'value' })) {
  console.error('YAML integer map key: expected string key');
  failures++;
}

await writeFile('tests/codec/out/typescript.json', `${JSON.stringify(output, null, 2)}\n`);
if (failures > 0) throw new Error(`TypeScript codec vectors: ${failures} failure(s)`);
console.log(`typescript: ${vectors.length} codec vectors passed`);
