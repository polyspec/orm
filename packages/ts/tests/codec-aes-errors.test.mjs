// The failures that a recipe cannot inject: a native cipher or decipher that throws at each phase is the error of its rule,
// which keeps the failure of node:crypto as its cause and names nothing of it (COD-70 aes-encrypt and aes-auth, COD-71).
import assert from 'node:assert/strict';
import { Cipheriv, Decipheriv } from 'node:crypto';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { CodecError, hostDecode, hostEncode } from '../dist/index.js';

const key = 'codec-aes-errors-key';

function envelope(plaintext = 'authenticated plaintext') {
  return Buffer.from(hostEncode(plaintext, ['aes'], key));
}

// expectRule asserts the code and the whole text of the rule, and the cause: the given failure, or any error.
function expectRule(operation, code, message, cause) {
  assert.throws(operation, error =>
    error instanceof CodecError && error.code === code && error.message === `${code}: ${message}`
      && (cause === undefined ? error.cause instanceof Error : error.cause === cause));
}

function withMethod(prototype, method, implementation, body) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  Object.defineProperty(prototype, method, { ...descriptor, value: implementation });
  try { body(); } finally { Object.defineProperty(prototype, method, descriptor); }
}

const source = envelope();
for (const phase of ['setAAD', 'setAuthTag', 'update', 'final']) {
  caseTest(`a decipher failure at ${phase} is aes: authentication failed with its cause`, COMPUTE, () => {
    const failure = Object.assign(new Error('native failure'), { code: 'ERR_CRYPTO_INVALID_STATE' });
    withMethod(Decipheriv.prototype, phase, () => { throw failure; }, () => {
      expectRule(() => hostDecode(source, ['aes'], key), 'CODEC_DECODE', 'aes: authentication failed', failure);
    });
  });
}

caseTest('a cell that the key does not authenticate keeps the failure of the decipher as its cause', COMPUTE, () => {
  expectRule(() => hostDecode(source, ['aes'], 'another key'), 'CODEC_DECODE', 'aes: authentication failed');
});

caseTest('plaintext from update is not returned when final fails', COMPUTE, () => {
  const partial = Buffer.from('must remain private until authentication');
  const failure = new Error('Unsupported state or unable to authenticate data');
  withMethod(Decipheriv.prototype, 'update', () => partial, () => withMethod(Decipheriv.prototype, 'final', () => { throw failure; }, () => {
    expectRule(() => hostDecode(source, ['aes'], key), 'CODEC_DECODE', 'aes: authentication failed', failure);
  }));
});

for (const phase of ['setAAD', 'update', 'final', 'getAuthTag']) {
  caseTest(`a cipher failure at ${phase} is aes: the encryption failed with its cause`, COMPUTE, () => {
    const failure = new Error('native failure');
    withMethod(Cipheriv.prototype, phase, () => { throw failure; }, () => {
      expectRule(() => hostEncode('plaintext', ['aes'], key), 'CODEC_ENCODE', 'aes: the encryption failed', failure);
    });
  });
}
