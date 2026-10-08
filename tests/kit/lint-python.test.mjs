// Tests of the Python lint: it runs ruff check and ruff format --check on the package that config/toolchain.json names, runs
// both steps after a failure of the first, and fails with the fix when ruff is not declared or not installed. ruff is a stub.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lint, lintSteps } from '../../scripts/kit/lint-python.mjs';

function checkout(t, { declared = true, installed = true, failing = '' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-lint-python-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/toolchain.json'), JSON.stringify(declared ? { schema: 1, ruff: { pyproject: 'packages/py/pyproject.toml' } } : { schema: 1 }));
  if (installed) {
    mkdirSync(path.join(root, 'var/tools/bin'), { recursive: true });
    const log = path.join(root, 'ruff.log');
    writeFileSync(path.join(root, 'var/tools/bin/ruff'), `#!/bin/sh
echo "ruff $*" >> "${log}"
${failing ? `case "$1 $2" in "${failing}"*) echo "found a problem" >&2; exit 1;; esac` : ''}
`);
    chmodSync(path.join(root, 'var/tools/bin/ruff'), 0o755);
  }
  return { root, calls: () => readFileSync(path.join(root, 'ruff.log'), 'utf8').split('\n').filter(Boolean) };
}

test('ruff check and ruff format --check run on the directory of the declared pyproject', (t) => {
  const { root, calls } = checkout(t);
  const output = [];
  assert.deepEqual(lint(root, text => output.push(text)), []);
  assert.deepEqual(calls(), ['ruff check packages/py', 'ruff format --check packages/py']);
});

test('the second step runs after the first failed, and both failures are named', (t) => {
  const { root, calls } = checkout(t, { failing: 'check ' });
  const failed = lint(root, () => {});
  assert.deepEqual(failed, ['ruff check packages/py']);
  assert.deepEqual(calls(), ['ruff check packages/py', 'ruff format --check packages/py']);
});

test('an undeclared ruff and a missing ruff fail with their fix', (t) => {
  assert.throws(() => lintSteps(checkout(t, { declared: false }).root), /config\/toolchain\.json declares no ruff\.pyproject/);
  assert.throws(() => lintSteps(checkout(t, { installed: false }).root), /var\/tools\/bin\/ruff is missing; run make install-tools/);
});
