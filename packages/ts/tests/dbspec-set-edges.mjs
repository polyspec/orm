// The set reader beside its shared vectors (tests/dbspec/set-files.json, which dbspec-set.mjs runs): parseSet takes a
// Uint8Array and a string, and the edges of the token scan and the normal form that the vectors do not spell.
//
// Usage: node --test packages/ts/tests/dbspec-set-edges.mjs (after the build)
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest } from '../../../tests/testcase.mts';
import { readDbspecSet } from '../dist/dbspec/index.js';
import { parseSet as browserParseSet } from '../dist/dbspec/entry.js';

const TIMEOUT = 15000;

caseTest('set-files parseSet takes a Uint8Array and a string', TIMEOUT, () => {
  assert.throws(() => browserParseSet('{}', 'dbspec-set.json'), TypeError);
  assert.throws(() => browserParseSet(new Uint8Array(), 1), TypeError);
  assert.throws(() => readDbspecSet(1), TypeError);
});

// Edges of the token scan and the normal form that the shared vectors do not spell: each text is a set file at
// `app/dbspec-set.json` and gives no error (null) or the one rule.
const edges = [
  ['a paired surrogate escape', '{"schema": 1, "documents": ["\\ud83d\\ude00.dbs"]}', null],
  ['a lone low surrogate escape', '{"schema": 1, "documents": ["\\ude00.dbs"]}', 'set.json'],
  ['a high surrogate escape before a character', '{"schema": 1, "documents": ["\\ud83dx.dbs"]}', 'set.json'],
  ['an escaped backslash before u', '{"schema": 1, "documents": ["a\\\\ud800.dbs"]}', 'set.path'],
  ['a key repeated through an escape', '{"schema": 1, "\\u0073chema": 1, "documents": ["shop.dbs"]}', 'set.key'],
  ['a key repeated in a nested object', '{"schema": {"a": 1, "a": 2}, "documents": ["shop.dbs"]}', 'set.key'],
  ['the same key in two nested objects', '{"schema": 1, "documents": ["shop.dbs"], "x": [{"a": 1}, {"a": 1}]}', 'set.key'],
  ['a string value equal to a key', '{"schema": 1, "documents": ["schema"]}', 'set.path'],
  ['schema -1', '{"schema": -1, "documents": ["shop.dbs"]}', 'set.schema'],
  ['schema 10e-1', '{"schema": 10e-1, "documents": ["shop.dbs"]}', null],
  ['schema 1.0000000000000000001, a double of 1', '{"schema": 1.0000000000000000001, "documents": ["shop.dbs"]}', null],
  ['schema NaN', '{"schema": NaN, "documents": ["shop.dbs"]}', 'set.json'],
  ['schema Infinity', '{"schema": Infinity, "documents": ["shop.dbs"]}', 'set.json'],
  ['a lone surrogate before a repeated key', '{"schema": 1, "schema": 1, "documents": ["\\ud800.dbs"]}', 'set.json'],
  ['schema null', '{"schema": null, "documents": ["shop.dbs"]}', 'set.schema'],
  ['documents null', '{"schema": 1, "documents": null}', 'set.key'],
  ['external of a number', '{"schema": 1, "documents": ["shop.dbs"], "external": [1]}', 'set.key'],
  ['external leading dot-dots', '{"schema": 1, "documents": ["shop.dbs"], "external": ["../../a/b.dbs"]}', null],
  ['external of only dot-dots', '{"schema": 1, "documents": ["shop.dbs"], "external": [".."]}', 'set.path'],
  ['a last segment .dbs', '{"schema": 1, "documents": [".dbs"]}', null],
  ['a device with an upper superscript', '{"schema": 1, "documents": ["lpt\\u00b3.dbs"]}', 'set.path'],
  ['COM10 is no device', '{"schema": 1, "documents": ["COM10.dbs"]}', null],
  ['a device as a directory', '{"schema": 1, "documents": ["aux/x.dbs"]}', 'set.path'],
  ['a colon', '{"schema": 1, "documents": ["a:b.dbs"]}', 'set.path'],
  ['U+001F', '{"schema": 1, "documents": ["a\\u001fb.dbs"]}', 'set.path'],
  ['NUL', '{"schema": 1, "documents": ["a\\u0000b.dbs"]}', 'set.path'],
  ['an empty path', '{"schema": 1, "documents": [""]}', 'set.path'],
  ['an empty set file', '', 'set.json'],
];
for (const [name, text, rule] of edges) {
  caseTest(`set-files edge ${name}`, TIMEOUT, () => {
    const result = browserParseSet(new TextEncoder().encode(text), 'app/dbspec-set.json');
    assert.deepEqual(result.errors.map(e => e.rule), rule === null ? [] : [rule]);
  });
}

caseTest('set-files edge unknown keys in code-point order', TIMEOUT, () => {
  const result = browserParseSet(new TextEncoder().encode('{"\\uffff": 1, "\\ud83d\\ude00": 1, "b": 1, "schema": 1, "documents": ["a.dbs"]}'), 'dbspec-set.json');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /"b", "￿", "\u{1f600}"/u);
});

caseTest('set-files edge the joined path keeps the written path and an empty prefix', TIMEOUT, () => {
  const result = browserParseSet(new TextEncoder().encode('{"schema": 1, "documents": ["a.dbs"], "external": ["../b/c.dbs"]}'), 'dbspec-set.json');
  assert.deepEqual([...result.documents, ...result.external].map(p => [p.written, p.path]), [['a.dbs', 'a.dbs'], ['../b/c.dbs', '../b/c.dbs']]);
});

caseTest('set-files edge a set path relative to the working directory', TIMEOUT, () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-ts-set-'));
  writeFileSync(join(root, 'dbspec-set.json'), '{"schema": 1, "documents": ["a.dbs"]}', 'utf8');
  writeFileSync(join(root, 'a.dbs'), 'dbspec 1 a\n', 'utf8');
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const result = readDbspecSet('dbspec-set.json');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.documents.map(f => f.path), ['a.dbs']);
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
