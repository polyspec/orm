// Requirements: INT-78.
// Runs only the local SQLite request-hook case that reads a bound INSERT assignment value.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCase, DATABASE } from '../../../tests/testcase.mts';
import { cases, runOn } from './request_hook_run.mjs';

const passed = await runCase('request-hook-reads-params [sqlite]', DATABASE, async ({ step }) => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-request-hook-reads-params-'));
  try {
    await runOn(`sqlite://${join(dir, 'hook.sqlite')}`, step, cases.reads_params);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
if (!passed) process.exitCode = 1;
