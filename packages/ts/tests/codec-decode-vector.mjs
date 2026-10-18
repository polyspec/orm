// The shared decode vectors (tests/codec/decode-vectors.json): each vector is one case named by the vector.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { CodecError, decode, hostDecode } from '../dist/index.js';
import { check } from './codec_case.mjs';

// Shared decode vectors (tests/codec/decode-vectors.json): a stored cell is decoded only from the form the encoder writes, and any other
// form is CODEC_DECODE. The host stage list without aes is read with hostDecode, which takes no key; the rest are read with decode.
const decodeVectors = JSON.parse(await readFile('tests/codec/decode-vectors.json', 'utf8')).vectors;
if (decodeVectors.length === 0) throw new Error('decode-vectors.json has no vectors');
for (const vector of decodeVectors) check(vector.name, wrong => {
  const raw = vector.stored !== undefined ? Buffer.from(vector.stored, 'utf8') : Buffer.from(vector.stored_hex, 'hex');
  const host = vector.styles.every(style => style === 'hex' || style === 'ip');
  let got;
  let code = '';
  try {
    got = host ? hostDecode(vector.stored ?? raw, vector.styles, '') : decode(vector.styles, raw).payload();
  } catch (error) {
    code = error instanceof CodecError ? error.code : String(error);
  }
  if (vector.error !== undefined ? code !== vector.error : (code !== '' || !isDeepStrictEqual(got, vector.value))) {
    wrong.push(`got ${code || JSON.stringify(got)}, want ${vector.error ?? JSON.stringify(vector.value)}`);
  }
});
