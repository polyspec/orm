// The Kit job context owns the run directory of one CI job. Its cases use only temporary files and start no program.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { caseTest } from '../../tests/testcase.mts';
import { cleanupContext, prepareContext } from './job-context.mts';

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

// offline is the environment of the fixture with a PATH that holds no program: the context steps start none, so a step that
// tried to start make or node fails at once instead of reaching the servers of the machine.
function offline(f: ReturnType<typeof fixture>, attempt = '2'): NodeJS.ProcessEnv {
  const empty = join(f.root, 'no-programs');
  mkdirSync(empty, { recursive: true });
  return { ...f.env, GITHUB_RUN_ATTEMPT: attempt, PATH: empty };
}

// The context of the php-ext job owns only its run directory (T645): kit runs prepare, make -k ci-targets and cleanup in one
// step (ci-setup.mjs:203-207), the targets of ci-targets start the servers and create the run databases, and the ci-targets
// node of kit stops the servers it owns, with their data in .runtime/servers, when it ends.
caseTest('the prepare of the job context creates only its marker-owned directory and writes no GITHUB_ENV (T645)', () => {
  const f = fixture();
  try {
    prepareContext('php-ext', f.root, offline(f));
    assert.deepEqual(readdirSync(f.directory), ['.kit-job-context.json']);
    assert.equal(readFileSync(f.githubEnv, 'utf8'), '', 'prepare wrote to GITHUB_ENV');
  } finally { f.dispose(); }
});

caseTest('the cleanup of the job context removes its owned directory and leaves the servers of the checkout (T645)', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.runtime/servers'), { recursive: true });
    writeFileSync(f.serverEnv, "export ORM_RUN_MYSQL_DSN='mysql://existing/test'\n");
    prepareContext('php-ext', f.root, offline(f));
    // The run directory holds the SQLite file of the decimal database of the run (scripts/check/databases.mts:178).
    writeFileSync(join(f.directory, 'decimal-case.sqlite'), '');
    cleanupContext('php-ext', f.root, offline(f));
    assert.equal(existsSync(f.directory), false);
    assert.equal(readFileSync(f.serverEnv, 'utf8'), "export ORM_RUN_MYSQL_DSN='mysql://existing/test'\n");
  } finally { f.dispose(); }
});

caseTest('the cleanup of the job context refuses a marker of another run attempt (T645)', () => {
  const f = fixture();
  try {
    prepareContext('php-ext', f.root, offline(f));
    const other = resolve(f.root, '.runtime/run/kit-php-ext-4321-3');
    mkdirSync(other, { mode: 0o700 });
    copyFileSync(join(f.directory, '.kit-job-context.json'), join(other, '.kit-job-context.json'));
    assert.throws(() => cleanupContext('php-ext', f.root, offline(f, '3')), /does not match workflow run 4321\/3/);
    assert.equal(existsSync(other), true);
  } finally { f.dispose(); }
});

caseTest('the cleanup of the job context refuses a run directory that is a symbolic link (T645)', () => {
  const f = fixture();
  try {
    prepareContext('php-ext', f.root, offline(f, '3'));
    symlinkSync(resolve(f.root, '.runtime/run/kit-php-ext-4321-3'), f.directory);
    assert.throws(() => cleanupContext('php-ext', f.root, offline(f)), /refusing to use php-ext context outside/);
    assert.equal(existsSync(resolve(f.root, '.runtime/run/kit-php-ext-4321-3')), true);
  } finally { f.dispose(); }
});
caseTest('the Kit jobs declare the context and setup targets that own their native prerequisites', () => {
  const config: unknown = JSON.parse(readFileSync(join(repo, 'config/ci.json'), 'utf8'));
  assert.ok(isRecord(config));
  assert.ok(isRecord(config.contexts));
  assert.deepEqual(config.contexts, { 'php-ext': { prepare: 'php-extension-context-prepare', cleanup: 'php-extension-context-cleanup' } });
  assert.ok(isRecord(config.setup));
  assert.deepEqual(config.setup.shared, ['orm-install-go-lease']);
  assert.ok(isRecord(config.setup.runtimes));
  // The go, php-ext, python and ts jobs build the binding crate of their runtime for its generated tests (T582-1), so each
  // installs the Rust toolchain and its crates, and the ts job the wasm-bindgen CLI of make node-package.
  assert.deepEqual(config.setup.runtimes.go, ['orm-install-go', 'orm-install-rust']);
  assert.deepEqual(config.setup.runtimes.php, ['orm-install-php']);
  // The php-ext job also runs the checks that AGENTS.md names as the enforcement of a rule and that need the servers of its context
  // and every client (T617), so it installs the Go modules, Python and the TypeScript interfaces as well.
  assert.deepEqual(config.setup.runtimes['php-ext'], ['orm-install-php-extension-runtime', 'orm-install-server-programs', 'orm-install-go-lease', 'orm-install-rust', 'orm-install-go', 'orm-install-python', 'orm-install-interfaces-typescript']);
  assert.deepEqual(config.setup.runtimes.python, ['orm-install-python', 'orm-install-rust', 'orm-install-binding-python']);
  assert.deepEqual(config.setup.runtimes.ts, ['orm-install-interfaces-typescript', 'orm-install-typescript-runtime', 'orm-install-rust', 'orm-install-wasm-bindgen']);
  assert.ok(isRecord(config.tools));
  // The error code files are generated by the Go orm-gen (orm-codes), so every job whose checks read them has Go (T339), and each job names every tool that its setup targets run through their mise shims (T614), and every tool of mise.toml that the recipes of its setup and its targets run (T631).
  assert.deepEqual(config.tools, { shared: ['go'], go: ['go'], php: ['go', 'composer'], 'php-ext': ['go', 'composer', 'uv'], python: ['go', 'uv', 'maturin'], rust: ['go'], ts: ['go', 'wasmBindgen'] });
  const makefile = readFileSync(join(repo, 'Makefile'), 'utf8');
  assert.match(makefile, /^TEST_ENV \?= \.runtime\/servers\/env$/m);
  assert.match(makefile, /^php-extension-context-prepare:\n\t\$\(NODE\) scripts\/check\/job-context\.mts prepare php-ext$/m);
  assert.match(makefile, /^php-extension-context-cleanup:\n\t\$\(NODE\) scripts\/check\/job-context\.mts cleanup php-ext$/m);
  assert.match(makefile, /^orm-install-php-extension-runtime:/m);
  assert.match(makefile, /^orm-install-typescript-runtime: orm-install-go-lease orm-codes-typescript build-ts$/m);
});

// dryRun runs make -n of target with the make of this run (MAKE) and the environment env, less the variables by which a
// calling make hands its command line and level to a sub-make: kit (target-report.mjs:25,160) and make check-run
// (scripts/check/run.mts:53-58) drop the same four, so a dry run reads the Makefile as the make of a ci-targets target does.
function dryRun(target: string, env: NodeJS.ProcessEnv = process.env, args: string[] = []): string {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES'].includes(name)));
  const dry = spawnSync(process.env.MAKE || 'make', ['-n', '--no-print-directory', target, ...args], { cwd: repo, encoding: 'utf8', env: clean });
  assert.equal(dry.status, 0, `make -n ${target} failed: ${dry.stderr}`);
  return dry.stdout;
}

// The test servers and the run databases of the php-ext job are started inside make -k ci-targets (T645), not by the
// prepare of its context: prepare ran make orm-test-servers from its own node, the servers named the parent of that make,
// the prepare node, as their owner (Makefile:2115), and stopped when it ended, before the first target read them. A target
// that reads the servers reaches orm-test-servers and databases-create as plain make prerequisites, so the make of the
// target runs their recipes, and the owner is the parent of that make, the ci-targets node of kit, which lives until the
// last target ends (T612). A target reads the servers when its dry run holds their shared lease (WITH_TEST_ENV names
// ORM_TEST_SERVERS_LEASES); the targets are those of the php-ext job, kit's gate first (config/ci.json).
caseTest('each php-ext target that reads the servers starts them and creates the run databases as its make prerequisites (T645)', () => {
  const makefile = readFileSync(join(repo, 'Makefile'), 'utf8');
  const config = JSON.parse(readFileSync(join(repo, 'config/ci.json'), 'utf8')) as { targets: { runtimes: Record<string, string[]> } };
  const targets = ['kit-gates-runtime-php-ext', ...(config.targets.runtimes['php-ext'] ?? [])];
  const readers = targets.filter(target => dryRun(target).includes('ORM_TEST_SERVERS_LEASES'));
  assert.ok(readers.length > 0, 'no php-ext target reads the servers');
  // The prerequisites of a target are those of all its rule lines; a line that only sets a variable of the target
  // (<target>: [export] NAME [:?+]=) is no rule line. The order holds by dependencies, not by the order of a list, so it
  // also holds under make -j: a target reaches databases-create, which depends on orm-test-servers.
  const prerequisites = (target: string): string[] => [...makefile.matchAll(new RegExp(`^${target}:(?!\\s*(?:export\\s+)?[A-Za-z_][A-Za-z0-9_]*\\s*[:?+]?=)([^\\n]*)$`, 'gm'))]
    .flatMap(rule => (rule[1] ?? '').replace(/##.*$/, '').trim().split(/\s+/).filter(Boolean));
  const reaches = (from: string, goal: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return prerequisites(from).some(next => next === goal || reaches(next, goal, seen));
  };
  assert.ok(prerequisites('databases-create').includes('orm-test-servers'), `databases-create does not depend on orm-test-servers: ${prerequisites('databases-create').join(' ')}`);
  for (const target of readers) assert.ok(reaches(target, 'databases-create'), `${target} reads the servers but does not depend on databases-create`);
});

caseTest('the prepare of the job context starts no servers and creates no databases (T645)', () => {
  const f = fixture();
  try {
    assert.doesNotThrow(() => prepareContext('php-ext', f.root, offline(f)), 'prepare started a program');
    assert.equal(existsSync(join(f.root, '.runtime/servers')), false, 'prepare started the servers');
    assert.equal(existsSync(join(f.directory, 'env')), false, 'prepare created the run databases');
  } finally { f.dispose(); }
});

// Outside a kit job there is no run context (RUNTIME, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT) and no run database: a target that
// reads the servers reaches databases-create locally too, and it says so and makes nothing (T645, FCV-24). The case runs the
// recipe of databases-create alone, with its prerequisites taken as made (-o), so it starts no server and builds nothing.
caseTest('databases-create with no run context and no DIRECTORY says so and makes no database (T645)', () => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES', 'RUNTIME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'SERVERS', 'DIRECTORY', 'NAME'].includes(name)));
  const made = spawnSync(process.env.MAKE || 'make', ['--no-print-directory', '-o', 'orm-test-servers', '-o', 'typescript-current', '-o', 'lease-tool', 'databases-create'], { cwd: repo, encoding: 'utf8', env: clean });
  assert.equal(made.status, 0, `databases-create without a run context failed: ${made.stdout}${made.stderr}`);
  assert.match(made.stdout, /no run database is made/);
});

// databases-create runs once per target that reads the servers, so each create keeps the databases of its run that the
// server already holds and creates only the missing ones, judged by the names the server lists (T645).
caseTest('databases-create keeps the databases of its run that exist and creates only the missing ones (T645)', async () => {
  const databases: Record<string, unknown> = await import('./databases.mts');
  const plan = databases['databasesToCreate'];
  assert.equal(typeof plan, 'function', 'scripts/check/databases.mts exports no databasesToCreate');
  const toCreate = plan as (existing: string[], wanted: string[]) => string[];
  const wanted = ['orm_kit_php_ext_4321_2_bench', 'orm_kit_php_ext_4321_2_decimal'];
  assert.deepEqual(toCreate(['mysql', 'other_bench'], wanted), wanted);
  assert.deepEqual(toCreate(['mysql', 'orm_kit_php_ext_4321_2_bench'], wanted), ['orm_kit_php_ext_4321_2_decimal']);
  assert.deepEqual(toCreate(['orm_kit_php_ext_4321_2_decimal', 'orm_kit_php_ext_4321_2_bench'], wanted), [], 'a second create changes something');
});
