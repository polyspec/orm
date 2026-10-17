// The shared codec vectors (tests/codec/vectors.json): each vector is one case named by the vector.
import { after } from 'node:test';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { StyledValue, decode, encode, hostEncode } from '../dist/index.js';
import { Value as JsonValue } from '@polyspec/ordered-json';
import { check, same, shown, stagesOf } from './codec_case.mjs';

const vectors = JSON.parse(await readFile('tests/codec/vectors.json', 'utf8')).vectors;
const output = {};

// Each codec vector (tests/codec/vectors.json) is one case named by the vector.
for (const vector of vectors) check(vector.name, wrong => {
  if (vector.encode_error !== undefined) {
    // A vector with encode_error has no stored cell: encoding its value fails with that code.
    try {
      // A list of host stages only (ip) encodes with the host encode and no key.
      const host = vector.styles.every(style => ['aes', 'hex', 'ip'].includes(style));
      const encoded = host ? hostEncode(vector.value, vector.styles, '') : encode(stagesOf(vector.styles), StyledValue.value(vector.value));
      wrong.push(`encode gave ${shown(encoded)} want ${vector.encode_error}`);
    } catch (error) {
      if (error?.code !== vector.encode_error) wrong.push(`encode ${String(error)} want ${vector.encode_error}`);
    }
    return;
  }
  const raw = vector.encoded_b64 === null ? null : Buffer.from(vector.encoded_b64, 'base64');
  let decoded;
  try {
    decoded = decode(stagesOf(vector.styles), raw);
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
  const encoded = encode(stagesOf(vector.styles), decoded);
  const encodedBase64 = encoded === null ? null : Buffer.from(encoded).toString('base64');
  output[vector.name] = encodedBase64;
  const integralFloat = vector.name.endsWith('.integral_float') && vector.styles.includes('serialize');
  if (vector.deterministic && !integralFloat && encodedBase64 !== vector.encoded_b64) {
    wrong.push(`encoded ${encodedBase64} want ${vector.encoded_b64}`);
  }
  const roundTrip = decode(stagesOf(vector.styles), encoded);
  if (!(roundTrip instanceof StyledValue) || roundTrip.kind !== kind || !same(kind === 'value' ? roundTrip.payload() : null, vector.value)) {
    wrong.push(`round trip ${shown(roundTrip)} want ${JSON.stringify(vector.value)}`);
  }
});

// The encoded output of every codec vector goes only to the directory that ORM_CODEC_OUT (make codec-check) names; it is
// written to a temporary file and then renamed, after the cases ran.
after(async () => {
  const directory = process.env.ORM_CODEC_OUT;
  if (directory) {
    await mkdir(directory, { recursive: true });
    const temporary = `${directory}/typescript.json.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
    await rename(temporary, `${directory}/typescript.json`);
  }
});

