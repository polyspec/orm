import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectErrors } from './check.mjs';

const rule = { types: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'], subject_max: 50 };

test('accepts type(scope): Subject (#id)', () => {
  assert.deepEqual(subjectErrors('fix(dbspec): Let audit stand without soft_delete (#T8.1.8)', rule), []);
});

test('rejects a missing type, scope or id', () => {
  for (const subject of ['Pin Rust ORM dependency versions', 'fix: Pin versions (#T1)', 'fix(rust): Pin versions', 'perf(rust): Pin versions (#T1)']) {
    assert.match(subjectErrors(subject, rule).join('\n'), /type\(scope\): Subject \(#id\)/, subject);
  }
});

test('rejects a lower-case subject, a final period and a subject over the limit', () => {
  assert.match(subjectErrors('docs(procedure): adopt conventional commit format (#P1)', rule).join('\n'), /capital/);
  assert.match(subjectErrors('docs(schema): State the scanner scope. (#T2)', rule).join('\n'), /period/);
  assert.match(subjectErrors(`feat(dbspec): ${'A'.repeat(51)} (#T3)`, rule).join('\n'), /50 characters/);
});
