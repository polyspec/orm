// The test entry point of the statement fault: @polyspec/orm/testing exports failNextStatement under the condition
// orm-test only, and the package entry point exports none. The fixture cases of the fault run in
// statement_fault.mjs; this file holds the entry point's own check, so each file reports only its own cases.
//
// Usage: node --conditions=orm-test packages/ts/tests/statement_fault_entry.mjs (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { caseTest } from '../../../tests/testcase.mts';
import * as packageEntry from '../dist/index.js';
import * as testing from '@polyspec/orm/testing';

// The case's deadline: the check spawns one node process.
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';

function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

/** The test entry point exports the fault under orm-test only, and the package entry point exports none. */
function checkFaultEntry() {
  const packageRoot = new URL('..', import.meta.url).pathname;
  const load = "await import('@polyspec/orm/testing')";
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', load], { cwd: packageRoot, encoding: 'utf8' });
  check(plain.status !== 0 && plain.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'), `the test entry point resolves without the condition orm-test: status ${plain.status} ${plain.stderr}`);
  check(typeof testing.failNextStatement === 'function', '@polyspec/orm/testing does not export failNextStatement');
  check(!('failNextStatement' in packageEntry), 'the package entry point exports failNextStatement');
}

caseTest('statement-fault-entry/entry_point', CASE_DEADLINE_MS, async ({ step }) => {
  const before = failures;
  current = 'entry_point';
  step('spawn the entry point checks');
  checkFaultEntry();
  if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
});
