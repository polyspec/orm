// One native Go test of a feature, run for one database item of the feature with the environment that feature-check
// gives it: ORM_FEATURE_DATABASE and ORM_FEATURE_DSN come from coverage.mts (featureEnvironment and databaseDsn), so the
// parity unit and feature-check read the same values. The command prints go test -json, which the parity runner reads.
// A missing DSN is an error (databaseDsn throws); a test that runs no case fails the unit it belongs to.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { databaseDsn, featureEnvironment, databases } from '../../../scripts/features/coverage.mts';

const { values, positionals } = parseArgs({
  options: {
    database: { type: 'string' },
    'dsn-env': { type: 'string' },
    test: { type: 'string' },
    tags: { type: 'string', default: 'featurecoverage' },
  },
  allowPositionals: true,
  strict: true,
});
const database = values.database;
const test = values.test;
if (database === undefined || !databases.includes(database)) throw new Error(`--database must be one of ${databases.join(', ')}`);
if (test === undefined || test === '') throw new Error('--test names the Go test');
// go test -run matches each level by regexp. The top-level name is a Go identifier; it is escaped with the same syntax
// characters kit escapes its names with (parity-runners.mts), so no name can change the pattern it runs.
if (!/^[A-Za-z_]\w*$/.test(test)) throw new Error(`--test must be a Go identifier, got ${JSON.stringify(test)}`);
const pattern = `^(${test.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')})$`;
if (positionals.length === 0) throw new Error('give the Go package path after the options, for example ./orm');
const dsn = databaseDsn(process.env, { database, dsn_env: values['dsn-env'] });
const env = featureEnvironment(process.env, database, dsn);
// kit runs this command in the directory of the Go implementation (packages/go). The Go test runs there.
const goDirectory = resolve(import.meta.dirname, '..');
const child = spawn('go', ['test', '-json', '-count=1', '-tags', values.tags as string, '-run', pattern, ...positionals], { cwd: goDirectory, env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal !== null) throw new Error(`go test was stopped by ${signal}`);
  process.exitCode = code ?? 1;
});
