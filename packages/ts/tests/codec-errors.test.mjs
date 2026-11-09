import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { ParseError as JsonParseError, Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { CodecError, StyledValue, decode, encode } from '../dist/index.js';

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

// The cause is the failure of the reader of the bytes: the ordered-json parser of the cell, the UTF-8 decoder of a stream.
caseTest('invalid UTF-8 in JSON and YAML returns CODEC_DECODE', COMPUTE, () => {
  for (const [style, message, cause] of [
    ['ordered_json', 'json: the cell is not JSON', error => error instanceof JsonParseError && error.kind === 'invalid_utf8'],
    ['yaml', 'yaml: the stream is not UTF-8', error => error instanceof TypeError],
  ]) {
    const error = thrown(() => decode([style], new Uint8Array([0xff])));
    assert(error instanceof CodecError);
    assert.equal(error.code, 'CODEC_DECODE');
    assert.equal(error.message, `CODEC_DECODE: ${message}`);
    assert(cause(error.cause), String(error.cause));
  }
});

// The refused YAML forms are the recipe cases decode_errors; this holds the JavaScript class of the value.
caseTest('a decoded ordered_json value holds a JsonValue', COMPUTE, () => {
  const json = decode(['ordered_json'], '{"value": 2}');
  assert(json.payload() instanceof JsonValue);
  assert.equal(stringifyJson(json.payload()), '{"value":2}');
  assert.equal(decode(['yaml'], 'value: 2\n').kind, 'value');
});

// The JavaScript inputs of the ordered_json and serialize stages, which no recipe value names (COD-16, COD-21); the codec
// cases that every client shares are the codec recipe, tests/codec/codec.json (codec-none.test.mjs).
caseTest('codec/javascript-inputs', COMPUTE, () => {
  const orderedText = '{"b":1,"a":[],"c":{},"n":1.50}';
  assert.equal(encode(['ordered_json'], StyledValue.value({ b: 1, a: [], c: {}, n: parseJson('1.50') })), orderedText);
  for (const value of [Number.NaN, { a: undefined }, new Uint8Array([1])]) {
    const error = thrown(() => encode(['ordered_json'], StyledValue.value(value)));
    assert.equal(error?.code, 'CODEC_ENCODE', String(value));
  }
  const error = thrown(() => encode(['serialize'], StyledValue.value(parseJson('{}'))));
  assert(error instanceof CodecError);
  assert.equal(error.code, 'CODEC_ENCODE');
});

// A class object is written as the form that its toJSON returns, read once as JSON.stringify reads it (COD-70 `json-value`):
// a form that is again an object of a class, the object itself included, has no JSON form, and the encode refuses it
// rather than reading toJSON again.
// Requirements: COD-21, COD-70, COD-71.
caseTest('codec/to-json-forms', COMPUTE, () => {
  class Self { toJSON() { return this; } }
  class Other { toJSON() { return new Self(); } }
  for (const value of [new Self(), [new Other()], { a: new Self() }]) {
    const error = thrown(() => encode(['ordered_json'], StyledValue.value(value)));
    assert(error instanceof CodecError, String(error));
    assert.equal(error.message, 'CODEC_ENCODE: json: the value is not a JSON value');
  }
  assert.equal(encode(['ordered_json'], StyledValue.value({ at: new Date('2026-01-01T00:00:00Z') })), '{"at":"2026-01-01T00:00:00.000Z"}');
  class Shaped { toJSON() { return { b: [1], a: parseJson('1.50') }; } }
  assert.equal(encode(['ordered_json'], StyledValue.value([new Shaped()])), '[{"b":[1],"a":1.50}]');
});
