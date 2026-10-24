import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../testcase.mts';

caseTest('the dbspec verification and TypeScript package entry recipes use the pinned Node wrapper', COMPUTE, () => {
  const makefile = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8');
  assert.match(makefile, /^\t\$\(NODE\) --test packages\/ts\/tests\/dbspec-apply-verify-errors\.mjs$/m);
  assert.match(makefile, /^\t\$\(NODE\) --conditions=orm-test --test --test-name-pattern='package-entry\/runtime-exports' packages\/ts\/tests\/statement_fault_entry\.mjs$/m);
});
