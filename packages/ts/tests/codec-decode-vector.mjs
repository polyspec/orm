// The shared decode vectors (tests/codec/decode-vectors.json): each vector is one case named by the vector.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { CodecError, decodeCodec, hostDecode } from '../dist/index.js';
import { check } from './codec_case.mjs';

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
