import assert from 'node:assert/strict';
import test from 'node:test';
import { Value as JsonValue, stringify as stringifyJson } from '@polyspec/ordered-json';
import { CodecError, decode } from '../dist/index.js';

function thrown(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail('expected decode to throw');
}

test('CodecError accepts ErrorOptions without changing its formatted message', () => {
  const cause = new Error('parser failure');
  const error = new CodecError('CODEC_DECODE', 'json: parser failure', { cause });
  assert.equal(error.message, 'CODEC_DECODE: json: parser failure');
  assert.equal(error.cause, cause);
  assert.equal(new CodecError('CODEC_DECODE', 'plain failure').cause, undefined);
});

test('malformed JSON preserves the parser error as cause', () => {
  const error = thrown(() => decode(['ordered_json'], '{'));
  assert(error instanceof CodecError);
  assert.equal(error.code, 'CODEC_DECODE');
  assert.match(error.message, /^CODEC_DECODE: json:/);
  assert(error.cause instanceof Error);
});

test('malformed YAML preserves the parser error as cause', () => {
  const error = thrown(() => decode(['yaml'], 'value: [\n'));
  assert(error instanceof CodecError);
  assert.equal(error.code, 'CODEC_DECODE');
  assert.match(error.message, /^CODEC_DECODE: yaml:/);
  assert(error.cause instanceof Error);
});

test('invalid UTF-8 keeps the native decoding error as cause for JSON and YAML', () => {
  for (const style of ['ordered_json', 'yaml']) {
    const error = thrown(() => decode([style], new Uint8Array([0xff])));
    assert(error instanceof CodecError);
    assert.equal(error.code, 'CODEC_DECODE');
    assert.match(error.message, /^CODEC_DECODE: invalid UTF-8:/);
    assert(error.cause instanceof TypeError);
  }
});

test('JSON and YAML rethrow an existing CodecError by identity', () => {
  const originalDecode = TextDecoder.prototype.decode;
  const sentinel = new CodecError('CODEC_DECODE', 'UTF-8 boundary sentinel');
  try {
    TextDecoder.prototype.decode = () => { throw sentinel; };
    for (const style of ['ordered_json', 'yaml']) {
      assert.equal(thrown(() => decode([style], new Uint8Array([0x61]))), sentinel);
    }
  } finally {
    TextDecoder.prototype.decode = originalDecode;
  }
});

test('YAML policy errors remain CODEC_DECODE and valid values still decode', () => {
  for (const source of [
    'a: 1\na: 2\n',
    'a: &anchor [1]\n',
    'value: .inf\n',
  ]) {
    const error = thrown(() => decode(['yaml'], source));
    assert(error instanceof CodecError);
    assert.equal(error.code, 'CODEC_DECODE');
  }
  const json = decode(['ordered_json'], '{"value": 2}');
  assert(json.payload() instanceof JsonValue);
  assert.equal(stringifyJson(json.payload()), '{"value":2}');
  assert.equal(decode(['yaml'], 'value: 2\n').kind, 'value');
});
