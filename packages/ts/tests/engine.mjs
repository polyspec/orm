// Requirements: INT-24, PRT-22.
// The ir-validate suite: each shared validation case of tests/ir/validate.json is one case of this file. The engine
// feature tests are in engine_features.mjs.
// Usage: node packages/ts/tests/engine.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { decodeRequest, validate } from '../dist/engine/validate.js';
import { parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

function code(fn) {
  try { fn(); return null; } catch (error) { return error.code ?? String(error); }
}

// Shared validation cases (tests/ir/validate.json): each request, with the schema's manifest_hash added, is given only to the validator, and
// it is checked whether it is accepted or fails with the expected error code.
const validateText = await readFile(new URL('../../../tests/ir/validate.json', import.meta.url), 'utf8');
const file = JSON.parse(validateText);
// Each request is read again as its JSON text through ordered-json, so a number keeps its literal (0.0 is not 0).
const requestTexts = parseJson(validateText).get('cases').items.map(c => stringifyJson(c.get('request')));
if (file.schema !== 'contracts/fixtures/bench/bench.dbs' || file.cases.length === 0) throw new Error('validate.json names contracts/fixtures/bench/bench.dbs and has cases');
const validated = dbspecManifest([parseDbspec(await readFile(new URL(`../../../${file.schema}`, import.meta.url), 'utf8'), {}).document]).manifest;
const validateModel = registerModel(validated.manifestText, validated.manifestHash);
for (const [index, c] of file.cases.entries()) caseTest(c.name, COMPUTE, () => {
  const got = code(() => validate(validateModel, { ...decodeRequest(requestTexts[index]), manifest_hash: validated.manifestHash }));
  if (c.valid ? got !== null : got !== c.error) throw new Error(`got ${got ?? 'valid'}, want ${c.error ?? 'valid'}`);
});
