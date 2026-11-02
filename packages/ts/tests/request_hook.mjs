// The request hook of a connection handle (docs/operations/usage.md "Request hook") on SQLite: the shared cases of
// request_hook_run.mjs, each on a SQLite file of its own in a temporary directory that is removed when the
// case ends, also after a failure.
//
// Usage: node packages/ts/tests/request_hook.mjs (after npm run typescript:build)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { cases, runOn } from './request_hook_run.mjs';

// Requirements by case of request_hook_run.mjs (the cases that the recipe request_hook does not run, FCV-4):
// without_hook: INT-78.
// read_filter: INT-78, PRT-2.
// relation_scope: INT-78.
// restore_no_key: DIA-161.
// invalid_param: PRT-65.
// restore_rewritten_key: DIA-161.
// restore_hook_set_key: DIA-161.
// restore_rewritten_key_set_scope: DIA-161.
// reads_params: INT-78.
let failures = 0;
for (const [name, run] of Object.entries(cases)) {
  // INT-78: the hook of a handle receives each request right before it is planned; a handle without a hook runs the request as is.
  caseTest(`request-hook/${name}`, DATABASE, async ({ step }) => {
    const dir = await mkdtemp(join(tmpdir(), 'orm-request-hook-'));
    try { await runOn(`sqlite://${join(dir, 'hook.sqlite')}`, step, run); } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
if (failures > 0) process.exitCode = 1;
