// The shared AES vectors (tests/codec/aes-vectors.json): each vector is one case named by its name. A vector with an
// error names the code of its op (encode, decode or blind_index) with an empty or wrong key; the others round-trip.
import { readFile } from 'node:fs/promises';
import { CodecError, blindIndex, hostDecode, hostEncode } from '../dist/index.js';
import { check } from './codec_case.mjs';

const aesVectors = JSON.parse(await readFile('tests/codec/aes-vectors.json', 'utf8')).vectors;

// The code of the error the op raises, or '' when it raises none.
const errorCode = run => {
  try {
    run();
  } catch (error) {
    return error instanceof CodecError ? error.code : String(error);
  }
  return '';
};

// Each AES vector (tests/codec/aes-vectors.json) is one case named by its name.
for (const vector of aesVectors) check(vector.name, wrong => {
  if (vector.error !== undefined) {
    const code = errorCode(() => {
      if (vector.op === 'encode') hostEncode(vector.plain, ['aes', 'hex'], vector.key);
      else if (vector.op === 'decode') hostDecode(vector.envelope_hex, ['aes', 'hex'], vector.key);
      else blindIndex(vector.plain, vector.key);
    });
    if (code !== vector.error) wrong.push(`${vector.op} with key ${JSON.stringify(vector.key)}: got ${code || 'no error'}, want ${vector.error}`);
    return;
  }
  const encoded = hostEncode(vector.plain, ['aes', 'hex'], vector.key);
  const decoded = hostDecode(encoded, ['aes', 'hex'], vector.key);
  if (decoded !== vector.plain) wrong.push(`aes round trip ${JSON.stringify(vector.plain)}: ${decoded}`);
  const fixedDecoded = hostDecode(vector.envelope_hex, ['aes', 'hex'], vector.key);
  if (fixedDecoded !== vector.plain) wrong.push(`aes fixed vector: ${fixedDecoded} want ${vector.plain}`);
});
