import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countCases } from './count-cases.mts';

const pass = (name: string) => JSON.stringify({ Action: 'pass', Package: 'example.com/p', Test: name, Elapsed: 0.01 });
const run = (name: string) => JSON.stringify({ Action: 'run', Package: 'example.com/p', Test: name });

test('a go run counts its passed cases', () => {
  const output = [run('TestOne'), pass('TestOne'), run('TestTwo'), pass('TestTwo'), JSON.stringify({ Action: 'pass', Package: 'example.com/p', Elapsed: 0.02 })].join('\n');
  assert.equal(countCases('go', output), 2);
});

test('a go run that starts no case counts zero', () => {
  assert.equal(countCases('go', JSON.stringify({ Action: 'output', Package: 'example.com/p', Output: 'testing: warning: no tests to run\n' })), 0);
  assert.equal(countCases('go', ''), 0);
});

test('a reader that is not one of the five formats is refused by the command, and an empty output counts zero for every format', () => {
  for (const reader of ['node', 'cargo', 'python', 'phpunit'] as const) assert.equal(countCases(reader, ''), 0, reader);
});
