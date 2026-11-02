// dbspec checks beside the shared vectors: the manifest refuses a repeated document name, and the reader of
// tests/dbspec/cases.json refuses missing and unknown fields. The vectors themselves run in dbspec-<section>.mjs and the recipes.
//
// Usage: node --test packages/ts/tests/dbspec.mjs (after the build)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dbspecManifest } from '../dist/dbspec/index.js';
import { checkCases } from '../../../tests/dbspec/cases.mts';
import { cases, join, parsed, root, vector } from './dbspec_case.mjs';

// Requirements: DBS-99.
vector('manifest rejects a repeated document name', () => {
  const text = join(['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'], false);
  const result = dbspecManifest([parsed(text, {}), parsed(text, {})]);
  assert.equal(result.manifest, null);
  assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), [['name.duplicate', 1, 10]]);
});

// The reader of cases.json refuses a missing or an unknown section or field of the sections it keeps, naming it.
vector('cases.json reader refuses missing and unknown fields', () => {
  const text = readFileSync(new URL('tests/dbspec/cases.json', root), 'utf8');
  const manifest = cases.sets.findIndex(c => Object.hasOwn(c, 'manifest'));
  // Each mutation is refused by the schema of cases.json with the JSON Pointer of the value and the keyword of ajv.
  const mutations = [
    ['/ ', 'missingProperty":"note', v => delete v.note],
    ['/ ', 'additionalProperty":"extra', v => (v.extra = [])],
    ['/ ', 'additionalProperty":"canonical', v => (v.canonical = [])],
    ['/hashes/0 ', 'additionalProperty":"extra', v => (v.hashes[0].extra = true)],
    ['/sets/0 ', 'additionalProperty":"extra', v => (v.sets[0].extra = true)],
    [`/sets/${manifest}/manifest `, 'additionalProperty":"extra', v => (v.sets[manifest].manifest.extra = [])],
  ];
  for (const [pointer, problem, change] of mutations) {
    const value = JSON.parse(text);
    change(value);
    assert.throws(() => checkCases(value), error => error.message.split('\n').some(line => line.startsWith(`tests/dbspec/cases.json: ${pointer}`) && line.includes(problem)), pointer);
  }
});
