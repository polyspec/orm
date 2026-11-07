// The Kit job context owns database servers and fixtures across provider workflow steps. These cases use only temporary files and a stub command runner.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { cleanupContext, prepareContext, type ContextCommand, type ContextCommandResult } from './job-context.mts';

const repo = resolve(import.meta.dirname, '../..');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orm-job-context-'));
  mkdirSync(join(root, '.runtime/run'), { recursive: true });
  const githubEnv = join(root, 'github-env');
  writeFileSync(githubEnv, '');
  const env = { GITHUB_RUN_ID: '4321', GITHUB_RUN_ATTEMPT: '2', GITHUB_ENV: githubEnv };
  const directory = resolve(root, '.runtime/run/kit-php-ext-4321-2');
  const serverEnv = resolve(root, '.runtime/servers/env');
  return { root, githubEnv, env, directory, serverEnv, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const stub = (root: string, calls: string[], failCreate = false, decimal = true): ContextCommand => (program, args, cwd) => {
  assert.equal(cwd, root);
  calls.push(`${program} ${args.join(' ')}`);
  if (program === 'make' && args.includes('orm-test-servers')) {
    mkdirSync(join(root, '.runtime/servers'), { recursive: true });
    writeFileSync(join(root, '.runtime/servers/env'), "export ORM_RUN_MYSQL_DSN='mysql://test@localhost/test'\nexport ORM_RUN_POSTGRES_DSN='postgres://test@localhost/test'\n");
  } else if (program === 'make' && args.includes('databases-create')) {
    if (failCreate) return { status: 7, signal: null };
    const directory = args.find(value => value.startsWith('DIRECTORY='))?.slice('DIRECTORY='.length) ?? '';
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'env'), "export BENCH_SQLITE_DSN='sqlite:///tmp/bench.sqlite'\n");
    if (decimal) writeFileSync(join(directory, 'decimal-env'), "export DECIMAL_SQLITE_DSN='sqlite:///tmp/decimal.sqlite'\n");
  } else if (program === 'node' && args[1] === 'drop') {
    rmSync(args[3] ?? '', { recursive: true, force: true });
  } else if (program === 'make' && args.includes('orm-test-servers-stop')) {
    rmSync(join(root, '.runtime/servers'), { recursive: true, force: true });
  }
  return { status: 0, signal: null };
};

// prepared prepares the job context through the stub and returns the stub for its cleanup.
function prepared(f: ReturnType<typeof fixture>, calls: string[]): ContextCommand {
  const command = stub(f.root, calls);
  prepareContext('php-ext', f.root, f.env, command);
  return command;
}

// failing answers outcome to the call that matches selects and runs every call through base.
const failing = (base: ContextCommand, matches: (program: string, args: string[]) => boolean, outcome: ContextCommandResult): ContextCommand =>
  (program, args, cwd, env) => {
    const result = base(program, args, cwd, env);
    return matches(program, args) ? outcome : result;
  };

// assertTornDown checks that the cleanup stopped the servers and removed their files and the owned directory.
function assertTornDown(f: ReturnType<typeof fixture>, calls: string[]): void {
  assert.ok(calls.includes('make --no-print-directory orm-test-servers-stop'));
  assert.equal(existsSync(join(f.root, '.runtime/servers')), false);
  assert.equal(existsSync(f.directory), false);
}

caseTest('the job context prepares owned resources and exports only its run paths', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    prepareContext('php-ext', f.root, f.env, stub(f.root, calls));
    assert.deepEqual(calls, [
      'make --no-print-directory orm-test-servers',
      `make --no-print-directory databases-create SERVERS=${f.serverEnv} DIRECTORY=${f.directory} NAME=orm_kit_php_ext_4321_2`,
    ]);
    assert.deepEqual(readFileSync(f.githubEnv, 'utf8').trim().split('\n'), [
      "BENCH_SQLITE_DSN=sqlite:///tmp/bench.sqlite",
      "DECIMAL_SQLITE_DSN=sqlite:///tmp/decimal.sqlite",
      `TEST_ENV=${join(f.directory, 'env')}`,
      `STEP_RUN_DIR=${f.directory}`,
    ]);
  } finally { f.dispose(); }
});

caseTest('the job context refuses a database setup that wrote no decimal environment', COMPUTE, () => {
  const f = fixture();
  try {
    assert.throws(() => prepareContext('php-ext', f.root, f.env, stub(f.root, [], false, false)), /decimal-env was not written by the database setup/);
    assert.equal(readFileSync(f.githubEnv, 'utf8'), '');
  } finally { f.dispose(); }
});

caseTest('the job context cleanup drops fixtures, stops its servers, and removes its owned directory', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    cleanupContext('php-ext', f.root, f.env, prepared(f, calls));
    assert.deepEqual(calls.slice(-2), [
      `node scripts/check/databases.mts drop ${f.serverEnv} ${f.directory} orm_kit_php_ext_4321_2`,
      'make --no-print-directory orm-test-servers-stop',
    ]);
    assert.equal(existsSync(f.directory), false);
    assert.equal(existsSync(join(f.root, '.runtime/servers')), false);
  } finally { f.dispose(); }
});

caseTest('the job context cleanup continues after database setup fails', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    assert.throws(() => prepareContext('php-ext', f.root, f.env, stub(f.root, calls, true)), /php-ext database setup exited with 7/);
    cleanupContext('php-ext', f.root, f.env, stub(f.root, calls));
    assert.ok(calls.some(call => call.startsWith('node scripts/check/databases.mts drop ')));
    assert.ok(calls.includes('make --no-print-directory orm-test-servers-stop'));
    assert.equal(existsSync(f.directory), false);
  } finally { f.dispose(); }
});

caseTest('the job context cleanup stops partially started servers after preparation fails', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const base = stub(f.root, calls);
    const command = failing(base, (program, args) => program === 'make' && args.includes('orm-test-servers'), { status: 9, signal: null });
    assert.throws(() => prepareContext('php-ext', f.root, f.env, command), /make orm-test-servers exited with 9/);
    cleanupContext('php-ext', f.root, f.env, base);
    assertTornDown(f, calls);
  } finally { f.dispose(); }
});

caseTest('the job context cleanup reports a database drop failure after stopping servers', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const command = failing(prepared(f, calls), (program, args) => program === 'node' && args[1] === 'drop', { status: 8, signal: null });
    assert.throws(() => cleanupContext('php-ext', f.root, f.env, command), /database cleanup exited with 8/);
    assertTornDown(f, calls);
  } finally { f.dispose(); }
});

caseTest('the job context retains its files when server teardown fails', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const base = prepared(f, calls);
    const command: ContextCommand = (program, args, cwd, env) => {
      if (program === 'make' && args.includes('orm-test-servers-stop')) {
        calls.push(`${program} ${args.join(' ')}`);
        return { status: null, signal: 'SIGTERM' };
      }
      const result = base(program, args, cwd, env);
      return result;
    };
    assert.throws(() => cleanupContext('php-ext', f.root, f.env, command), /server cleanup was terminated by SIGTERM without an exit status/);
    assert.equal(existsSync(join(f.root, '.runtime/servers')), true, 'retain server-owned files when stop fails');
  } finally { f.dispose(); }
});

caseTest('the job context reports when its database environment disappears before cleanup', COMPUTE, () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const command = prepared(f, calls);
    rmSync(join(f.root, '.runtime/servers'), { recursive: true, force: true });
    assert.throws(() => cleanupContext('php-ext', f.root, f.env, command), /database cleanup cannot run because/);
    assert.equal(existsSync(f.directory), true, 'retain owned fixture files when cleanup cannot reach the database server');
  } finally { f.dispose(); }
});

caseTest('the job context refuses a server environment it did not create', COMPUTE, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.runtime/servers'), { recursive: true });
    writeFileSync(f.serverEnv, "export ORM_RUN_MYSQL_DSN='mysql://existing/test'\n");
    assert.throws(() => prepareContext('php-ext', f.root, f.env, stub(f.root, [])), /already exists; refusing to take ownership/);
    cleanupContext('php-ext', f.root, f.env, stub(f.root, []));
    assert.equal(existsSync(f.serverEnv), true);
  } finally { f.dispose(); }
});

caseTest('the Kit jobs declare the context and setup targets that own their native prerequisites', COMPUTE, () => {
  const config: unknown = JSON.parse(readFileSync(join(repo, 'config/ci.json'), 'utf8'));
  assert.ok(isRecord(config));
  assert.ok(isRecord(config.contexts));
  assert.deepEqual(config.contexts, { 'php-ext': { prepare: 'php-extension-context-prepare', cleanup: 'php-extension-context-cleanup' } });
  assert.ok(isRecord(config.setup));
  assert.deepEqual(config.setup.shared, ['orm-install-go-lease', 'orm-install-go-codes']);
  assert.ok(isRecord(config.setup.runtimes));
  assert.deepEqual(config.setup.runtimes.go, ['orm-install-go']);
  assert.deepEqual(config.setup.runtimes.php, ['orm-install-php']);
  assert.deepEqual(config.setup.runtimes['php-ext'], ['orm-install-php-extension-runtime', 'orm-install-server-programs', 'orm-install-go-lease', 'orm-install-flowmark']);
  assert.deepEqual(config.setup.runtimes.ts, ['orm-install-interfaces-typescript', 'orm-install-typescript-runtime']);
  assert.ok(isRecord(config.tools));
  // The error code files are generated by the Go orm-gen (orm-codes), so every job whose checks read them has Go (T339).
  assert.deepEqual(config.tools, { php: ['go'], 'php-ext': ['go'], python: ['go'], ts: ['go'] });
  const makefile = readFileSync(join(repo, 'Makefile'), 'utf8');
  assert.match(makefile, /^TEST_ENV \?= \.runtime\/servers\/env$/m);
  assert.match(makefile, /^php-extension-context-prepare:\n\t\$\(NODE\) scripts\/check\/job-context\.mts prepare php-ext$/m);
  assert.match(makefile, /^php-extension-context-cleanup:\n\t\$\(NODE\) scripts\/check\/job-context\.mts cleanup php-ext$/m);
  assert.match(makefile, /^orm-install-php-extension-runtime:/m);
  assert.match(makefile, /^orm-install-typescript-runtime: orm-install-go-lease orm-install-codes-typescript\n\t\$\(MAKE\) --no-print-directory build-ts$/m);
});
