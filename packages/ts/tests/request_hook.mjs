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

let failures = 0;
for (const [name, run] of Object.entries(cases)) {
  // INT-78: the hook of a handle receives each request right before it is planned; a handle without a hook runs the request as is.
  caseTest(`request-hook/${name}`, DATABASE, async ({ step }) => {
    const dir = await mkdtemp(join(tmpdir(), 'orm-request-hook-'));
    try { await runOn(`sqlite://${join(dir, 'hook.sqlite')}`, step, run); } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
if (failures > 0) process.exitCode = 1;
