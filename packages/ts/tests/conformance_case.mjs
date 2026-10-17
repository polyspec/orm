// The conformance vectors of one dialect as node:test tests (coverage_conformance_<dialect>.mjs). The file creates a
// bench database of its own on the server of the test servers (ORM_RUN_<DIALECT>_DSN, ORM_RUN_SQLITE_QUERY), seeds it
// with scripts/bench-db.mts as make check seeds its bench databases, runs packages/ts/testing/conformance/runner_typescript.mts over
// every vector once, and makes each vector of tests/conformance a top-level test named by the vector that compares its
// output with the recorded expectation of the dialect (tests/conformance/check/main.mts load, exact JSON values). The
// database is dropped after the tests, also when one fails.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { promisify } from 'node:util';
import { describeDifference, load } from '../../../tests/conformance/check/main.mts';
import { decodeExact, equalValues } from '../../../tests/conformance/check/json.mts';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { repositoryRoot } from './coverage_case.mjs';

const RUNNER_TIMEOUT = 600_000;

/** The value of a required variable of the test-server environment; a database test never skips. */
function required(name) {
  const value = process.env[name] ?? '';
  if (value === '') throw new Error(`${name} is required; database tests never skip; run make conformance-ts-suite-check, which reads the environment of make test-servers`);
  return value;
}

/** The DSN with its database (path) replaced; the scheme, the account, the host and the query stay. */
function withDatabase(dsn, database) {
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs a command in the repository root and fails with its output when it exits other than 0. */
function run(program, args, env = {}) {
  const result = spawnSync(program, args, { cwd: repositoryRoot, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} exited with ${result.status ?? result.signal}: ${result.stderr || result.stdout}`);
}

/** Creates and seeds the bench database of the dialect; returns its DSN and the function that drops it. */
function benchDatabase(dialect) {
  const name = `orm_parity_${process.pid}_bench`;
  if (dialect === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'orm-parity-bench-'));
    const dsn = `sqlite://${directory}/bench.sqlite?${process.env.ORM_RUN_SQLITE_QUERY ?? ''}`;
    run(process.execPath, ['scripts/bench-db.mts', 'sqlite'], { BENCH_SQLITE_DSN: dsn });
    return { dsn, drop: () => rmSync(directory, { recursive: true, force: true }) };
  }
  const variable = dialect === 'mysql' ? 'ORM_RUN_MYSQL_DSN' : 'ORM_RUN_POSTGRES_DSN';
  const dsn = withDatabase(required(variable), name);
  const drop = () => {
    const url = new URL(dsn);
    if (dialect === 'mysql') {
      run('mysql', ['--no-defaults', '--protocol=TCP', '-h', url.hostname, '-P', url.port, '-u', decodeURIComponent(url.username), '-e', `DROP DATABASE IF EXISTS \`${name}\``]);
    } else {
      const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
      run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', `postgres://${credentials}${url.host}/postgres?sslmode=disable`, '-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
    }
  };
  try {
    run(process.execPath, ['scripts/bench-db.mts', dialect], { [dialect === 'mysql' ? 'BENCH_MYSQL_DSN' : 'BENCH_POSTGRES_DSN']: dsn });
  } catch (error) {
    drop();
    throw error;
  }
  return { dsn, drop };
}

/** Registers the conformance vectors of the dialect as top-level tests, each named by its vector. */
export async function conformanceSuite(dialect) {
  const vectors = load(repositoryRoot, dialect);
  const bench = benchDatabase(dialect);
  after(() => bench.drop());
  let output;
  let failure;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['packages/ts/testing/conformance/runner_typescript.mts', '--dsn', bench.dsn],
      { cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024, timeout: RUNNER_TIMEOUT });
    output = decodeExact(stdout);
    assert.ok(output instanceof Map, 'the runner prints an object of vectors');
  } catch (error) {
    failure = new Error(`runner_typescript failed: ${error.stderr || error.message}`);
  }
  for (const vector of vectors) {
    caseTest(vector.name, COMPUTE, () => {
      if (failure !== undefined) throw failure;
      assert.ok(vector.expect !== undefined && vector.expect !== null, `${vector.name} has an expectation recorded for ${dialect}`);
      const got = output.get(vector.name);
      assert.ok(got !== undefined, `the runner printed no output for ${vector.name}`);
      assert.ok(equalValues(got, vector.expect), `${vector.name} differs from its ${dialect} expectation\n${describeDifference(vector.expect, got).join('\n')}`);
    });
  }
  // A vector the runner prints that tests/conformance declares nothing for fails the file after the cases.
  after(() => {
    if (output === undefined) return;
    const declared = new Set(vectors.map(v => v.name));
    assert.deepEqual([...output.keys()].filter(name => !declared.has(name)), [], 'the runner printed undeclared vectors');
  });
}
