import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(new URL('../..', import.meta.url).pathname);
const parity = JSON.parse(await readFile(resolve(root, 'config/parity.json'), 'utf8')) as {
  profiles: { name: string; implementations: string[] }[];
};
const profile = (name: string) => parity.profiles.find(entry => entry.name === name)?.implementations ?? [];

test('the client profile of config/parity.json is the feature language set', () => {
  assert.deepEqual([...profile('client')].sort(), ['go', 'php', 'python', 'rust', 'typescript']);
});

// Each reader takes the language set from the client profile through clientLanguages() and writes no list of its own;
// a hand-written list here would disagree with config/parity.json as soon as the profile changes.
const readers = [
  'scripts/features/build.mts',
  'scripts/features/check.mts',
  'scripts/features/coverage.mts',
  'scripts/decimal-physical-check.mts',
  'tests/conformance/check/main.mts',
  'tests/conformance/check/result.physical.test.mts',
];
// A hand-written list is a literal array that names every client of the profile; a subset (such as implementedLanguages
// of coverage.mts, which leaves Python out by feature) is not the set this test guards.
const literalArrays = /\[([^[\]]*)\]/g;
const clientNames = ['go', 'php', 'rust', 'typescript', 'python'];
function handWrittenSet(source: string): boolean {
  for (const [, body] of source.matchAll(literalArrays)) {
    const names = new Set([...body.matchAll(/['"](\w+)['"]/g)].map(match => match[1]));
    if (clientNames.every(name => names.has(name))) return true;
  }
  return false;
}

for (const file of readers) {
  test(`${file} reads the language set from config/parity.json`, async () => {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.equal(handWrittenSet(source), false, `${file} writes its own language list`);
    assert.match(source, /clientLanguages\(\)/, `${file} does not read clientLanguages() of config/parity.json`);
  });
}
