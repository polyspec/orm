// authenticated_encryption coverage: contracts/fixtures/authenticated_encryption.json 의 AES envelope
// 복호화, 암호화 왕복, 변조와 다른 key 의 거부, blind index 를 client 의 codec 함수로 확인한다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blindIndex, hostDecode, hostEncode } from '../dist/index.js';
import { repositoryRoot, runCases } from './coverage_case.mjs';

const fixture = JSON.parse(await readFile(join(repositoryRoot, 'contracts/fixtures/authenticated_encryption.json'), 'utf8'));

/** The fixture case of an ID with its operation. */
function fixtureCase(id, operation) {
  const found = fixture.cases.filter(c => c.id === id);
  assert.equal(found.length, 1, `authenticated_encryption.json holds case ${id} once`);
  assert.equal(found[0].operation, operation, `operation of case ${id}`);
  return found[0];
}

/** Decrypts an envelope given in hexadecimal. */
const decrypt = (input) => hostDecode(new Uint8Array(Buffer.from(input.envelope_hex, 'hex')), ['aes'], input.key);

/** Asserts that decrypting the envelope of a case fails with the expected code. */
function rejected(id) {
  const c = fixtureCase(id, 'aes_decrypt');
  assert.throws(() => decrypt(c.input), error => error?.code === c.expected.error, `${id} fails with ${c.expected.error}`);
}

await runCases('coverage_authenticated_encryption.mjs', {
  async aes_envelope_decrypt() {
    const c = fixtureCase('aes_envelope_decrypt', 'aes_decrypt');
    assert.equal(decrypt(c.input), c.expected.plain, 'decrypted plaintext');
  },

  async aes_round_trip() {
    const c = fixtureCase('aes_round_trip', 'aes_encrypt_decrypt');
    const envelope = hostEncode(c.input.plain, ['aes'], c.input.key);
    assert.ok(envelope instanceof Uint8Array, 'the envelope is bytes');
    const prefix = Buffer.from(c.expected.prefix_hex, 'hex');
    assert.equal(Buffer.from(envelope.subarray(0, prefix.length)).toString('hex').toUpperCase(), c.expected.prefix_hex, 'envelope prefix');
    assert.equal(envelope.length, c.expected.envelope_bytes, 'envelope length');
    assert.equal(hostDecode(envelope, ['aes'], c.input.key), c.expected.plain, 'round trip plaintext');
  },

  async aes_tamper_rejected() { rejected('aes_tamper_rejected'); },

  async aes_wrong_key_rejected() { rejected('aes_wrong_key_rejected'); },

  async blind_index_vector() {
    const c = fixtureCase('blind_index_vector', 'blind_index');
    assert.equal(blindIndex(c.input.plain, c.input.key), c.expected.index, 'blind index');
  },
}, 60_000);
