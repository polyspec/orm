// The shared AES vectors (tests/codec/aes-vectors.json): each vector is one case named by its key.
import { readFile } from 'node:fs/promises';
import { hostDecode, hostEncode } from '../dist/index.js';
import { check } from './codec_case.mjs';

const aesVectors = JSON.parse(await readFile('tests/codec/aes-vectors.json', 'utf8')).vectors;

// Each AES vector (tests/codec/aes-vectors.json) is one case named by its key.
for (const vector of aesVectors) check(vector.key, wrong => {
  const encoded = hostEncode(vector.plain, ['aes', 'hex'], vector.key);
  const decoded = hostDecode(encoded, ['aes', 'hex'], vector.key);
  if (decoded !== vector.plain) wrong.push(`aes round trip ${JSON.stringify(vector.plain)}: ${decoded}`);
  const fixedDecoded = hostDecode(vector.envelope_hex, ['aes', 'hex'], vector.key);
  if (fixedDecoded !== vector.plain) wrong.push(`aes fixed vector: ${fixedDecoded} want ${vector.plain}`);
});

