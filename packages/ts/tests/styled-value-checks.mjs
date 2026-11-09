// The checks of a styled value in TypeScript: a setter refuses a value that JSON cannot hold as given by the rules of
// COD-70, and the value is checked again when it is encoded and refused by the JSON output, so an input object that
// changed after its assignment fails then, while payload() and the array form return it unchecked. The test of COD-21
// and COD-73 (docs/spec/codec.md).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Author, CodecError, OrmError, StyledValue, connect } from '../dist/index.js';
import { installBench } from './bench-set.mjs';
import { COMPUTE, DATABASE, caseTest } from '../../../tests/testcase.mts';

/** The orm code of what f throws or rejects with, or null when it completes. */
async function code(f) {
  try {
    await f();
    return null;
  } catch (error) {
    if (error instanceof OrmError || error instanceof CodecError) return error.code;
    throw error;
  }
}

caseTest('styled value checks: a setter refuses what JSON would change', COMPUTE, async () => {
  const wrong = [];
  const sparse = [1, 2, 3];
  delete sparse[1];
  for (const [name, value] of [
    ['an undefined member', { a: undefined }],
    ['a missing array index', sparse],
    ['a non-finite number', { a: Number.NaN }],
    ['an infinite number', [Number.POSITIVE_INFINITY]],
    ['a function member', { a: () => 1 }],
    ['a symbol member', { a: Symbol('a') }],
  ]) {
    const got = await code(() => new Author().setJsonSetting(StyledValue.value(value)));
    if (got !== 'CODEC_ENCODE') wrong.push(`${name}: ${got}, want CODEC_ENCODE`);
  }
  const accepted = await code(() => new Author().setJsonSetting(StyledValue.value({ a: 1, b: [1, null, 'x'] })));
  if (accepted !== null) wrong.push(`a JSON value: ${accepted}, want no error`);
  if (wrong.length > 0) throw new Error(wrong.join('\n'));
});

caseTest('styled value checks: a changed input fails the JSON output and is read unchecked', COMPUTE, async () => {
  const wrong = [];
  for (const [name, change, text] of [
    ['an undefined member', input => { input.a = undefined; }, 'a value that JSON has no form for'],
    ['a non-finite number', input => { input.a = Number.NaN; }, 'a number that is not finite'],
  ]) {
    const input = { a: 1 };
    const model = new Author().setJsonSetting(StyledValue.value(input));
    change(input);
    for (const [output, read] of [['toJSONText', () => model.toJSONText()], ['JSON.stringify', () => JSON.stringify(model)]]) {
      try {
        read();
        wrong.push(`${name}: ${output} wrote the value`);
      } catch (error) {
        const want = `CODEC_ENCODE: author.json_setting: JSON output cannot write ${text}`;
        if (!(error instanceof OrmError) || error.message !== want) wrong.push(`${name}: ${output} ${error}, want ${want}`);
      }
    }
    // The array form holds the value that payload() returns unchecked (COD-27, COD-73).
    if (model.toArray().json_setting.value !== input) wrong.push(`${name}: toArray() is not the stored value`);
  }
  if (wrong.length > 0) throw new Error(wrong.join('\n'));
});

const work = await mkdtemp(join(tmpdir(), 'orm-ts-styled-checks-'));
after(() => rm(work, { recursive: true, force: true }));

caseTest('styled value checks: a changed input fails when it is read for encoding', DATABASE, async () => {
  const db = await connect(`sqlite://${join(work, 'encode.sqlite')}`);
  try {
    await installBench(db);
    const input = { a: 1 };
    const model = new Author().connect(db).setName('styled').setUserSeq(1).setServiceSeq(1).setServiceRegionSeq(1).setServiceMemberSeq(1)
      .setStartDt('2026-06-01 00:00:00').setEndDt('2026-06-01 00:00:00').setJsonSetting(StyledValue.value(input));
    input.a = Number.NaN;
    const got = await code(() => model.create());
    if (got !== 'CODEC_ENCODE') throw new Error(`create after the input changed: ${got}, want CODEC_ENCODE`);
    const rows = await new Author().connect(db).name('styled').getCount();
    if (rows !== 0) throw new Error(`the refused create wrote ${rows} row(s)`);
  } finally { await db.close(); }
});
