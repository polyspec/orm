// The codec value checks that no vector file holds, as one case.
import { CodecError, StyledValue, blindIndex, decodeCodec, encodeCodec, hostDecode, hostEncode } from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { check, same } from './codec_case.mjs';

// The value checks that no vector file holds run as one case.
check('codec values', wrong => {
  if (blindIndex('member@example.test', 'blind-key') !== '1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8') wrong.push('blind index');
  for (const [name, operation, code] of [
    ['bad JSON', () => decodeCodec(['ordered_json'], '{bad'), 'CODEC_DECODE'],
    ['bad base64', () => decodeCodec(['serialize', 'base64'], '@@@'), 'CODEC_DECODE'],
    ['serialized object', () => decodeCodec(['serialize'], 'O:8:"stdClass":0:{}'), 'CODEC_UNSUPPORTED'],
    ['bad zlib', () => decodeCodec(['serialize', 'gz'], 'not zlib'), 'CODEC_DECODE'],
    ['unknown style', () => encodeCodec(['unknown'], StyledValue.value('value')), 'CODEC_UNSUPPORTED'],
    ['unknown encode style', () => encodeCodec(['filepart', 'serialize'], StyledValue.value({})), 'CODEC_UNSUPPORTED'],
    ['unknown decode style', () => decodeCodec(['filepart'], 'a:0:{}'), 'CODEC_UNSUPPORTED'],
    ['duplicate YAML key', () => decodeCodec(['yaml'], 'a: 1\na: 2\n'), 'CODEC_DECODE'],
    ['multiple YAML documents', () => decodeCodec(['yaml'], '---\na: 1\n---\na: 2\n'), 'CODEC_DECODE'],
    ['YAML alias', () => decodeCodec(['yaml'], 'a: &x [1]\nb: *x\n'), 'CODEC_DECODE'],
    ['YAML custom tag', () => decodeCodec(['yaml'], 'a: !custom value\n'), 'CODEC_DECODE'],
    ['YAML non-finite number', () => decodeCodec(['yaml'], 'value: .inf\n'), 'CODEC_DECODE'],
    ['YAML boolean map key', () => decodeCodec(['yaml'], 'true: value\n'), 'CODEC_DECODE'],
    ['invalid YAML order', () => encodeCodec(['serialize', 'yaml'], StyledValue.value({})), 'CODEC_UNSUPPORTED'],
  ]) {
    try {
      operation();
      wrong.push(`${name}: expected ${code}`);
    } catch (error) {
      if (!(error instanceof CodecError) || error.code !== code) {
        wrong.push(`${name}: ${String(error)} want ${code}`);
      }
    }
  }

  {
    const encoded = hostEncode('tamper@example.test', ['aes'], 'tamper-key');
    const tampered = new Uint8Array(encoded);
    tampered[tampered.length - 1] ^= 1;
    let rejected = false;
    try { hostDecode(tampered, ['aes'], 'tamper-key'); } catch (error) { rejected = error?.code === 'CODEC_DECODE'; }
    if (!rejected) { wrong.push('tampered AES ciphertext was accepted'); }
  }
  for (const address of ['10.1.2.3', '2001:db8::1', '::1', '::ffff:10.1.2.3']) {
    const encoded = hostEncode(address, ['ip'], '');
    const decoded = hostDecode(encoded, ['ip'], '');
    const expected = address === '::ffff:10.1.2.3' ? '10.1.2.3' : address;
    if (decoded !== expected) { wrong.push(`ip ${address}: ${decoded} want ${expected}`); }
  }

  const orderedText = '{"b":1,"a":[],"c":{},"n":1.50}';
  const orderedRead = decodeCodec(['ordered_json'], orderedText);
  if (!(orderedRead instanceof StyledValue) || orderedRead.kind !== 'value' || !(orderedRead.payload() instanceof JsonValue) || stringifyJson(orderedRead.payload()) !== orderedText) {
    wrong.push(`json read: ${orderedRead instanceof StyledValue && orderedRead.kind === 'value' ? stringifyJson(orderedRead.payload()) : String(orderedRead)}`);
  }
  for (const [name, value] of [['ordered-json value', parseJson(orderedText)], ['common value model with a nested ordered-json value', { b: 1, a: [], c: {}, n: parseJson('1.50') }]]) {
    const written = encodeCodec(['ordered_json'], StyledValue.value(value));
    if (written !== orderedText) { wrong.push(`json write of ${name}: ${written}`); }
  }
  for (const value of [Number.NaN, { a: undefined }, new Uint8Array([1])]) {
    try { encodeCodec(['ordered_json'], StyledValue.value(value)); wrong.push(`json write of ${String(value)}: expected CODEC_ENCODE`); }
    catch (error) { if (error?.code !== 'CODEC_ENCODE') { wrong.push(`json write: ${String(error)} want CODEC_ENCODE`); } }
  }
  try { encodeCodec(['serialize'], StyledValue.value(parseJson('{}'))); wrong.push('serialize of an ordered-json value: expected CODEC_ENCODE'); }
  catch (error) { if (!(error instanceof CodecError) || error.code !== 'CODEC_ENCODE') { wrong.push(`serialize of an ordered-json value: ${String(error)}`); } }
  if (!same(decodeCodec(['yaml'], '1: value\n').payload(), { 1: 'value' })) {
    wrong.push('YAML integer map key: expected string key');
  }
  for (const [name, stage] of [['gz', 'gz'], ['base64', 'base64']]) {
    const written = encodeCodec([stage], StyledValue.value('stored text'));
    const read = decodeCodec([stage], written);
    if (read.kind !== 'value' || read.payload() !== 'stored text') { wrong.push(`${name} of a string: ${String(read.payload())}`); }
    try { encodeCodec([stage], StyledValue.value({ a: 1 })); wrong.push(`${name} of a map: expected CODEC_ENCODE`); }
    catch (error) { if (!(error instanceof CodecError) || error.code !== 'CODEC_ENCODE') { wrong.push(`${name} of a map: ${String(error)}`); } }
  }

});

