// Requirements: none. The Rust debug setting of the test build (KSTD-5-85): make prints 0 when KIT_WORKTREE is set, as in a worktree,
// and line-tables-only when it is empty, as in main. Both cases run make in this checkout with KIT_WORKTREE given on the command line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** printed returns the value that make prints for CARGO_PROFILE_DEV_DEBUG with KIT_WORKTREE set to `value`. */
function printed(value: string): string {
  return execFileSync('make', ['-s', 'print-CARGO_PROFILE_DEV_DEBUG', `KIT_WORKTREE=${value}`], { cwd: root, encoding: 'utf8' }).trim();
}

caseTest('a set KIT_WORKTREE gives debug = 0 for the Rust test build', COMPUTE, () => {
  assert.equal(printed('1'), '0');
});

caseTest('an empty KIT_WORKTREE gives line-tables-only for the Rust test build', COMPUTE, () => {
  assert.equal(printed(''), 'line-tables-only');
});
