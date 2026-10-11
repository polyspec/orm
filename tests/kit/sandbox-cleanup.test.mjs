// The removal of a test sandbox (tests/kit/sandbox-cleanup.mjs). When the removal fails, the error names each entry that is
// still in the directory with its type and modification time, and the live processes of the test's process group, so the
// next occurrence of a race names its cause. The removal itself is not retried and not forced past an error.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeSandbox } from './sandbox-cleanup.mjs';

test('a failed removal names each entry still in the sandbox with its type and mtime, and the live processes of the group', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sandbox-cleanup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'objects'));
  writeFileSync(path.join(directory, 'objects', 'late.pack'), 'late');
  let calls = 0;
  const failing = () => {
    calls += 1;
    const error = new Error('directory not empty');
    error.code = 'ENOTEMPTY';
    throw error;
  };
  assert.throws(() => removeSandbox(directory, { remove: failing }), (error) => {
    const message = error.message;
    assert.match(message, new RegExp(`^cannot remove ${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(ENOTEMPTY: directory not empty\\); still in it: `));
    assert.match(message, /objects directory mtime \d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'the entry of a subdirectory is named with its type and mtime');
    assert.match(message, /objects\/late\.pack file mtime \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    assert.match(message, new RegExp(`live processes of this process group: .*\\b${process.pid}\\b`), 'the test process is named among the live processes');
    assert.equal(error.cause?.code, 'ENOTEMPTY', 'the original error is the cause');
    return true;
  });
  assert.equal(calls, 1, 'the removal runs once: no retry');
});

test('a removal that succeeds removes the sandbox and reports nothing', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sandbox-cleanup-'));
  writeFileSync(path.join(directory, 'file'), 'x');
  removeSandbox(directory);
  assert.equal(existsSync(directory), false);
});
