import assert from 'node:assert/strict';
import { Decipheriv } from 'node:crypto';
import test from 'node:test';
import { CodecError, hostDecode, hostEncode } from '../dist/index.js';

const key = 'codec-aes-errors-key';
const authMessage = 'Unsupported state or unable to authenticate data';
const prefixLength = Buffer.from('ORM-AES2\0').length;

function envelope(plaintext = 'authenticated plaintext') {
  return Buffer.from(hostEncode(plaintext, ['aes'], key));
}

function tamper(source, index) {
  const result = Buffer.from(source);
  result[index] ^= 1;
  return result;
}

function expectAuthenticationFailure(value, decodeKey = key) {
  assert.throws(() => hostDecode(value, ['aes'], decodeKey), error =>
    error instanceof CodecError && error.code === 'CODEC_DECODE' && error.message === 'CODEC_DECODE: aes: authentication failed');
}

test('AES decode maps authenticated envelope failures and round-trips plaintext', () => {
  const valid = envelope();
  expectAuthenticationFailure(tamper(valid, valid.length - 1));
  expectAuthenticationFailure(tamper(valid, prefixLength + 12));
  expectAuthenticationFailure(tamper(valid, prefixLength));
  expectAuthenticationFailure(valid, 'another-key');

  for (const plaintext of ['', 'plain text', '인증된 UTF-8 🔐']) {
    assert.equal(hostDecode(envelope(plaintext), ['aes'], key), plaintext);
  }

  assert.throws(() => hostDecode(envelope(), ['aes'], ''), error => error?.code === 'CONFIG');
  assert.throws(() => hostDecode('not an AES envelope', ['aes'], key), error => error?.code === 'CODEC_DECODE');
  assert.throws(() => hostDecode(Buffer.from('ORM-AES2\0short'), ['aes'], key), error => error?.code === 'CODEC_DECODE');
});

test('AES decode catches only final authentication errors', async t => {
  const source = envelope();
  const phases = ['setAAD', 'setAuthTag', 'update'];

  for (const phase of phases) {
    await t.test(`${phase} preserves error identity`, context => {
      const sentinel = new Error(authMessage);
      context.mock.method(Decipheriv.prototype, phase, () => { throw sentinel; });
      assert.throws(() => hostDecode(source, ['aes'], key), error => error === sentinel);
    });
  }

  await t.test('final maps only the exact code-free native authentication error', context => {
    context.mock.method(Decipheriv.prototype, 'final', () => { throw new Error(authMessage); });
    expectAuthenticationFailure(source);
  });

  for (const [name, error] of [
    ['structured authentication message', Object.assign(new Error(authMessage), { code: 'ERR_INTERNAL' })],
    ['other final error', Object.assign(new Error('Unsupported state'), { code: 'ERR_CRYPTO_INVALID_STATE' })],
  ]) {
    await t.test(`${name} preserves error identity`, context => {
      context.mock.method(Decipheriv.prototype, 'final', () => { throw error; });
      assert.throws(() => hostDecode(source, ['aes'], key), caught => caught === error);
    });
  }

  await t.test('plaintext from update is not returned when final fails', context => {
    const partial = Buffer.from('must remain private until authentication');
    context.mock.method(Decipheriv.prototype, 'update', () => partial);
    context.mock.method(Decipheriv.prototype, 'final', () => { throw new Error(authMessage); });
    expectAuthenticationFailure(source);
  });
});
