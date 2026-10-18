// The physical result runners (make conformance-result-physical-check): every language's runner runs twice on each bench
// database of TEST_ENV and leaves the database state as it was, and its two outputs are equal.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after } from 'node:test';
import { caseTest } from '../../testcase.mts';
import { benchDatabases, benchDsn, lockBench } from './bench.mts';
import { openStateDatabase } from './database.mts';
import { buildRunners, languageDeadline, longError, requiredLanguages, runLanguage } from './main.mts';
import { clientLanguages } from '../../../scripts/features/languages.mts';

const resultRunnerLanguages = clientLanguages();

assert.deepEqual(resultRunnerLanguages, requiredLanguages, 'physical result runners differ from required languages');
lockBench();
const root = resolve(import.meta.dirname, '../../..');
// The built runner must remain until all language cases finish, so it is placed in the directory of the whole file. Since the build is a long task,
// it runs with no deadline (runLong).
const binaries = mkdtempSync(join(tmpdir(), 'orm-conformance-runners-'));
after(() => rmSync(binaries, { recursive: true, force: true }));
const built = await longError('conformance/build', context => buildRunners(context, root, binaries));
if (built) throw built;

for (const { driver, env } of benchDatabases) {
  for (const language of resultRunnerLanguages) {
    caseTest(`TestPhysicalResultRunners/${driver}/${language}`, languageDeadline, async context => {
      const dsn = benchDsn(env);
      const stateDB = await openStateDatabase(driver, dsn);
      const directory = mkdtempSync(join(tmpdir(), 'orm-conformance-result-'));
      try {
        await runLanguage(context, stateDB, root, { driver, dsn, selected: [] }, language, join(directory, 'first.json'), join(directory, 'repeated.json'));
      } finally {
        await stateDB.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
