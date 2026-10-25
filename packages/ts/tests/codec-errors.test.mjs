import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
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

caseTest('CodecError accepts ErrorOptions without changing its formatted message', COMPUTE, () => {
  const cause = new Error('parser failure');
  const error = new CodecError('CODEC_DECODE', 'json: parser failure', { cause });
  assert.equal(error.message, 'CODEC_DECODE: json: parser failure');
  assert.equal(error.cause, cause);
  assert.equal(new CodecError('CODEC_DECODE', 'plain failure').cause, undefined);
});

// Requirements: COD-33, COD-35 (docs/spec).
caseTest('codec/malformed-json-and-yaml', COMPUTE, () => {
  for (const [style, source, prefix] of [
    ['ordered_json', '{', 'json'],
    ['yaml', 'value: [\n', 'yaml'],
  ]) {
    const error = thrown(() => decode([style], source));
    assert(error instanceof CodecError);
    assert.equal(error.code, 'CODEC_DECODE');
    assert.match(error.message, new RegExp(`^CODEC_DECODE: ${prefix}:`));
    assert(error.cause instanceof Error);
  }
});

caseTest('invalid UTF-8 in ordered JSON returns CODEC_DECODE', COMPUTE, () => {
  const error = thrown(() => decode(['ordered_json'], new Uint8Array([0xff])));
  assert(error instanceof CodecError);
  assert.equal(error.code, 'CODEC_DECODE');
  assert.match(error.message, /^CODEC_DECODE: invalid UTF-8:/);
  assert(error.cause instanceof TypeError);
});

caseTest('invalid UTF-8 in YAML returns CODEC_DECODE', COMPUTE, () => {
  const error = thrown(() => decode(['yaml'], new Uint8Array([0xff])));
  assert(error instanceof CodecError);
  assert.equal(error.code, 'CODEC_DECODE');
  assert.match(error.message, /^CODEC_DECODE: invalid UTF-8:/);
  assert(error.cause instanceof TypeError);
});

caseTest('JSON and YAML rethrow an existing CodecError by identity', COMPUTE, () => {
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

caseTest('YAML policy errors remain CODEC_DECODE and valid values still decode', COMPUTE, () => {
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
