// The statement runner rule of the interfaces spec (T345): a public statement runner is public API, stated once in
// docs/spec/interfaces.md and its Korean twin, and every runtime implements it unless a declared exception with its reason says otherwise.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest } from '../../tests/testcase.mts';

const root = new URL('../../', import.meta.url);
const english = readFileSync(new URL('docs/spec/interfaces.md', root), 'utf8');
const korean = readFileSync(new URL('docs/spec/interfaces.ko.md', root), 'utf8');

// rule returns the text of the INT-150 bullet: from its ID to the next bullet or heading.
function rule(text: string): string {
  const start = text.indexOf('**INT-150**');
  assert.notEqual(start, -1, 'the spec states INT-150');
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(- \*\*INT-|## |### )/);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
}

caseTest('the statement runner rule is stated once in each interfaces spec', () => {
  const en = rule(english);
  const ko = rule(korean);
  assert.equal(english.split('**INT-150**').length - 1, 1, 'INT-150 is stated once in the English spec');
  assert.equal(korean.split('**INT-150**').length - 1, 1, 'INT-150 is stated once in the Korean spec');
  assert.match(en, /public API/, 'the rule states that the statement runner is public API');
  assert.match(en, /every runtime/, 'every runtime implements the statement runner');
  assert.match(en, /`utils\(\)\.run\(fn\)`/, 'the one public statement runner is utils().run(fn) in every runtime');
  assert.match(en, /opens a transaction when none is active/, 'utils().run(fn) opens a transaction when none is active');
  assert.match(en, /joins the active transaction/, 'utils().run(fn) joins the active transaction otherwise');
  assert.match(en, /`run\(kind, tables, sql, params\)`/, 'the frame statement has the TypeScript TxFrame.run order in every runtime');
  assert.match(en, /fails with `CONFIG`/, 'a statement that is not text fails with CONFIG');
  assert.match(en, /exception/, 'the rule declares its exceptions');
  assert.match(en, /none is declared/, 'the rule states that no exception is declared');
  assert.doesNotMatch(en, /breaking change/, 'the TypeScript TxFrame.run signature is unchanged');
  assert.match(ko, /public API/, 'the Korean rule states the public API term');
  assert.match(ko, /`utils\(\)\.run\(fn\)`/, 'the Korean rule names utils().run(fn)');
  assert.match(ko, /예외/, 'the Korean rule declares its exceptions');
  assert.match(ko, /사유/, 'the Korean rule states the reason of an exception');
  assert.match(en, /Ruling \(T345\)/, 'the English rule states the frame-call ruling');
  assert.match(en, /`\(kind, tables, sql, params\)`/, 'the ruling names the TypeScript positional order');
  assert.match(ko, /판정\(T345\)/, 'the Korean rule states the frame-call ruling');
});
