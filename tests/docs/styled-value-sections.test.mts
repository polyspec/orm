// The styled value type of docs/spec/codec.md and docs/spec/dbspec.md names the value of every client: a styled column is
// a StyledValue of each language, and the Go, TypeScript and Python sections state its type.
//
// Usage: node --test tests/docs/styled-value-sections.test.mts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseTest } from '../testcase.mts';

const TIMEOUT = 15000;
const root = new URL('../..', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(root, file), 'utf8');

caseTest('docs/spec/codec.md states the StyledValue of the TypeScript and Python codecs', TIMEOUT, () => {
  const codec = read('docs/spec/codec.md');
  assert.match(codec, /^The Go JSON codec returns `orm\.StyledValue`/m, 'the Go section is the reference of the other sections');
  assert.match(codec, /^The TypeScript codec returns `StyledValue<T>`/m, 'docs/spec/codec.md lacks the TypeScript StyledValue section');
  assert.match(codec, /^The Python codec returns `polyspec\.orm\.StyledValue`/m, 'docs/spec/codec.md lacks the Python StyledValue section');
});

caseTest('docs/spec/dbspec.md states the styled column value of TypeScript and Python', TIMEOUT, () => {
  const fields = read('docs/spec/dbspec.md').split('\n').find(line => line.startsWith('- **Fields.**'));
  assert.ok(fields !== undefined, 'docs/spec/dbspec.md has no Fields bullet');
  assert.match(fields, /styled values stay unwrapped/, 'the Fields bullet names the styled value of Go');
  assert.match(fields, /TypeScript `T \| null`/, 'the Fields bullet names the TypeScript nullable type');
  assert.match(fields, /TypeScript `StyledValue<T>`/, 'the Fields bullet lacks the TypeScript styled value type');
  assert.match(fields, /Python `polyspec\.orm\.StyledValue`/, 'the Fields bullet lacks the Python styled value type');
});
