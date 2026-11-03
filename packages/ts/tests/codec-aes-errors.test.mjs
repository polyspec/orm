// The failures that a recipe cannot inject: a native decipher that throws at each phase keeps its error (FCV-2).
// Requirement: COD-6 (docs/spec).
import assert from 'node:assert/strict';
import { Decipheriv } from 'node:crypto';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { CodecError, hostDecode, hostEncode } from '../dist/index.js';

const key = 'codec-aes-errors-key';
const authMessage = 'Unsupported state or unable to authenticate data';

function envelope(plaintext = 'authenticated plaintext') {
  return Buffer.from(hostEncode(plaintext, ['aes'], key));
}

function expectAuthenticationFailure(value, decodeKey = key) {
  assert.throws(() => hostDecode(value, ['aes'], decodeKey), error =>
    error instanceof CodecError && error.code === 'CODEC_DECODE' && error.message === 'CODEC_DECODE: aes: authentication failed');
}

function withMethod(method, implementation, body) {
  const descriptor = Object.getOwnPropertyDescriptor(Decipheriv.prototype, method);
  Object.defineProperty(Decipheriv.prototype, method, { ...descriptor, value: implementation });
  try { body(); } finally { Object.defineProperty(Decipheriv.prototype, method, descriptor); }
}

const source = envelope();
const phases = ['setAAD', 'setAuthTag', 'update'];
for (const phase of phases) {
  caseTest(`${phase} preserves error identity`, COMPUTE, () => {
    const sentinel = new Error(authMessage);
    withMethod(phase, () => { throw sentinel; }, () => {
      assert.throws(() => hostDecode(source, ['aes'], key), error => error === sentinel);
    });
  });
}

caseTest('final maps only the exact code-free native authentication error', COMPUTE, () => {
  withMethod('final', () => { throw new Error(authMessage); }, () => expectAuthenticationFailure(source));
});

for (const [name, error] of [
  ['structured authentication message', Object.assign(new Error(authMessage), { code: 'ERR_INTERNAL' })],
  ['other final error', Object.assign(new Error('Unsupported state'), { code: 'ERR_CRYPTO_INVALID_STATE' })],
]) {
  caseTest(`${name} preserves error identity`, COMPUTE, () => {
    withMethod('final', () => { throw error; }, () => {
      assert.throws(() => hostDecode(source, ['aes'], key), caught => caught === error);
    });
  });
}

caseTest('plaintext from update is not returned when final fails', COMPUTE, () => {
  const partial = Buffer.from('must remain private until authentication');
  withMethod('update', () => partial, () => withMethod('final', () => { throw new Error(authMessage); }, () => {
    expectAuthenticationFailure(source);
  }));
});
