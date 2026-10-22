import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { main as startServers, paths as serverPaths, SERVER_VARIABLES, TestServerError } from '../test-servers.mts';
import { AFTER_GROUP_CHECK, CI_PASSED_STEPS, ciPassedErrors, ciGroups, GROUP_NEEDS, chainedCommandErrors, concurrencyErrors, ownWorkflows, workflowTriggerErrors, WORKFLOW_TRIGGERS, ciMakeErrors, checkTargets, ciAfterCheckErrors, ciSetupErrors, independentTestErrors, fullSuiteRuleErrors, ciCheckTargetErrors, ciDuplicateCommandErrors, ciLeaseErrors, ciRerunErrors, ciReportPathErrors, ciServerErrors, expand, helperEnvironmentErrors, helperRunErrors, featureCommands, makeVariables, runnerErrors, runnerIdentity, stepTimeoutErrors } from './ci.mts';
import { nodeVersionErrors, npmGitSourceErrors } from './node.mts';
import { fixlessMessageErrors } from './messages.mts';
import { binExeErrors, manifestDirErrors, runFile, targetPathErrors } from './target.mts';
import { connectProbeErrors } from './probes.mts';
import { composerVersionErrors, goModulePathErrors, goVersionErrors, phpVersionErrors, rustToolchainErrors } from './toolchains.mts';
import { execFileSync } from 'node:child_process';
import { CI_SETUP, expandNeeds, GROUP_OUTPUTS, groupOutputs, groupSetupErrors, RUNNER_STEPS, stepCondition } from '../check/ci-setup.mts';
import { declaredNeeds } from '../check/inputs.mts';
import { readFeatures } from '../features/manifest.mts';
import { readComposer, readPackage } from '../json/formats.mts';
import { kitCopies } from './kit-copies.mts';
import { andLists, segments, shellSegments } from './shell.mts';
import { readWorkflow } from './workflow.mts';
import { stringify } from 'yaml';
import { scriptPathErrors, toolingLanguageErrors } from './scripts.mts';
import { detachedGroupErrors, timeFailureErrors } from './sources.mts';
import { callerEnvironmentErrors, generateRuns, scriptCommands, goRunErrors, longDeadlineErrors, makeRecipes, fixedPortErrors, runtimePathErrors, sharedTargetErrors, unpublishedOutputErrors, typescriptHolderErrors, typescriptReaderErrors, unleasedCargoErrors, nodeTestErrors, rawGoTestErrors, reachedScripts, repeatedGenerateErrors, reportingScriptErrors, recipeLines, makeTargets, rustTestCaseErrors, testEntries, unbuiltCargoTestErrors, unwrappedToolErrors } from './testcases.mts';

// yamlSteps writes steps (the values of a workflow's steps) as the list under a job's steps:, six spaces deep.
const yamlSteps = (steps: unknown[]) => stringify(steps).split('\n').map(line => line ? `      ${line}` : line).join('\n');

// The copies of @polyspec/kit (kit.copies of its package.json) are checked by make kit-check and never edited here, so the
// rules of this repository do not read them.
const copies = kitCopies(new URL('../..', import.meta.url).pathname);
const notVendored = (path: string) => !Object.hasOwn(copies, path);
const tracked = ['scripts/docs/rules.mts', 'packages/ts/package.json', 'scripts/typescript/sqlite-test.mts'];

caseTest('a script path must be a tracked file or directory', COMPUTE, () => {
  assert.deepEqual(scriptPathErrors({ 'schema:check': 'node scripts/schema/check.mts' }, tracked), [
    'package.json script schema:check names scripts/schema/check.mts, which is not a tracked file or directory',
  ]);
  assert.deepEqual(
    scriptPathErrors(
      {
        'docs:rules-check': 'node scripts/docs/rules.mts',
        'typescript:build': 'npm --prefix packages/ts run build',
        'typescript:test': 'npm run typescript:build && node scripts/typescript/sqlite-test.mts',
        'docs:dev': 'vitepress dev docs',
      },
      tracked,
    ),
    [],
  );
});

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

caseTest('the CI workflow provides every variable of make orm-test-servers', COMPUTE, () => {
  const variables = SERVER_VARIABLES;
  for (const variable of ['ORM_TEST_MYSQL_REPLICA_DSN', 'ORM_TEST_POSTGRES_REPLICA_DSN', 'ORM_TEST_PROXYSQL_DSN',
    'ORM_TEST_PGBOUNCER_DSN', 'ORM_TEST_PGBOUNCER_SINGLE_DSN', 'ORM_TEST_MYSQL_TLS_DSN', 'ORM_RUN_MYSQL_DSN', 'ORM_RUN_POSTGRES_DSN',
    'ORM_RUN_SQLITE_QUERY', 'ORM_TEST_SERVERS_LEASES'])
    assert.ok(variables.includes(variable), `${variable} is not written by scripts/test-servers.mts`);
  assert.deepEqual(ciServerErrors(workflow, SERVER_VARIABLES), []);
});

// steps and script are the two variables of a workflow's minimal form that test-servers.mts uses. Each case changes one of them.
const steps = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - name: database servers',
  '        run: make orm-test-servers',
  '      - name: checks',
  '        run: |',
  '          make repo-check',
  '          go test ./...',
  '',
].join('\n');
const script = ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_PGBOUNCER_DSN'];

caseTest('a workflow that starts the servers with make orm-test-servers passes', COMPUTE, () => {
  assert.deepEqual(ciServerErrors(steps, script), []);
});

caseTest('a workflow without make orm-test-servers names each variable it lacks', COMPUTE, () => {
  const written = steps.replace('run: make orm-test-servers', "run: 'true'").replace(
    '      - name: checks',
    '      - run: printf "export ORM_TEST_MYSQL_DSN=x" > .runtime/servers/env\n      - name: checks',
  );
  assert.deepEqual(ciServerErrors(written, script), [
    'ci.yml does not provide ORM_TEST_MYSQL_DSN, which the database checks read',
    'ci.yml does not provide ORM_TEST_PGBOUNCER_DSN, which the database checks read',
    'ci.yml does not start the database servers with make orm-test-servers',
    'ci.yml writes .runtime/servers/env; make orm-test-servers writes it',
  ]);
});

caseTest('a workflow that defines a server variable itself fails', COMPUTE, () => {
  const defined = steps.replace('    steps:', '    env:\n      ORM_TEST_MYSQL_DSN: "mysql://root@127.0.0.1:3306/orm_test"\n    steps:');
  assert.deepEqual(ciServerErrors(defined, script), ['ci.yml defines ORM_TEST_MYSQL_DSN; make orm-test-servers defines it']);
});

caseTest('a check before make orm-test-servers fails', COMPUTE, () => {
  const early = steps.replace('      - name: database servers', '      - name: early\n        run: make feature-check\n      - name: database servers');
  assert.deepEqual(ciServerErrors(early, script), ['ci.yml step "early" runs make before make orm-test-servers starts the servers']);
  // make install and that part only download, so they may come before the server.
  const install = steps.replace('      - name: database servers', '      - name: downloads\n        run: make orm-install-go\n      - name: database servers');
  assert.deepEqual(ciServerErrors(install, script), []);
});

caseTest('a workflow that creates a symbolic link fails', COMPUTE, () => {
  for (const command of ['ln -s a b', 'sudo ln -sf /usr/lib/a.so.1t64 /usr/lib/a.so.1', 'ln --symbolic a b', `node -e "fs.symlinkSync('a', 'b')"`]) {
    const linked = steps.replace('      - name: database servers', `      - name: link\n        run: ${command}\n      - name: database servers`);
    assert.deepEqual(ciServerErrors(linked, script), ['ci.yml step "link" creates a symbolic link'], command);
  }
});

// The case after make orm-check (G5.38-4) looks at the repository's workflow and, in a minimal workflow, at the summary and report declared after make orm-check
// accepts only those two steps. It rejects another command step, another action step, an upload at another path, a missing step, and
// a make orm-check without ORM_CHECK_RUN_ID.
caseTest('a workflow runs only the summary and the report upload after make orm-check', COMPUTE, () => {
  assert.deepEqual(ciAfterCheckErrors(workflows), []);
  const check = ['      - name: make orm-check', '        env:', '          ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}', '        run: make orm-check'];
  const summary = ['      - name: summary', '        if: ${{ !cancelled() }}', '        env:', '          ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}', '        run: node scripts/check/summary.mts'];
  const report = ['      - name: report', '        if: ${{ !cancelled() }}', '        uses: actions/upload-artifact@v4', '        with:', '          name: check-${{ github.run_id }}-${{ github.run_attempt }}',
    '          path: .runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}/report/', '          if-no-files-found: error'];
  const workflow = (...steps: string[][]) => ['jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v5', '      - name: install', '        run: npm ci', ...steps.flat(), ''].join('\n');
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report) }), []);
  // A step of another job is not a step of the make orm-check job (G5.98).
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, ['  docs:', '    steps:', '      - name: documentation checks', '        run: make docs-ci']) }), []);
  const fuzz = ['      - name: decoder fuzz smoke checks', '        if: ${{ !cancelled() }}', '        run: make fuzz-check'];
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, fuzz) }), [
    'ci.yml step "decoder fuzz smoke checks" runs make fuzz-check after make orm-check; make orm-check runs every check, and only the summary and the report upload follow it, so a check it lacks belongs in a target of CHECK_TARGETS',
  ]);
  // The value of a step as the workflow reads it.
  const value = (lines: string[]) => JSON.stringify(readWorkflow(['jobs:', '  test:', '    steps:', ...lines].join('\n')).jobs[0]?.steps[0]?.value);
  const everything = report.map(line => line.replace('/report/', '/'));
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, everything) }), [
    `ci.yml step "report" after make orm-check is not the declared report step: ${value(everything)} instead of ${value(report)}`,
  ]);
  const other = ['      - uses: actions/cache@v4'];
  assert.match(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, other) })[0] ?? '', /^ci\.yml step "uses: actions\/cache@v4" runs \{"uses":"actions\/cache@v4"\} after make orm-check/);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check) }), [
    `ci.yml has no summary step after make orm-check: ${value(summary)}`,
    `ci.yml has no report step after make orm-check: ${value(report)}`,
  ]);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(['      - name: make orm-check', '        run: make orm-check'], summary, report) }), [
    'ci.yml step "make orm-check" gives make orm-check no ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}, which names the report of the run',
  ]);
});

// The node case checks the repository's mise.toml, package.json, workflow and the running Node, and the minimal
// workflow, changing one at a time.
const repository = new URL('../../', import.meta.url);
const declared = readFileSync(new URL('mise.toml', repository), 'utf8');
const minimum = readPackage(join(repository.pathname, 'package.json')).engines?.['node'];
// orm's own workflows: the copies of @polyspec/kit (gates.yml and release.yml) are kit's, and kit-check holds them byte for byte (KSTD-10).
const workflows = ownWorkflows(Object.fromEntries(readdirSync(new URL('.github/workflows/', repository)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(new URL(`.github/workflows/${name}`, repository), 'utf8')])), copies);

// mise writes the tool node of mise.toml from a version, or none for an empty one.
const mise = (version: string) => version ? `[tools]\nnode = "${version}"\n` : '[tools]\n';

caseTest('the checks and every workflow run the Node of mise.toml', COMPUTE, () => {
  assert.deepEqual(Object.keys(workflows), ['.github/workflows/ci.yml', '.github/workflows/docs-pages.yml', '.github/workflows/push-gate.yml']);
  assert.deepEqual(nodeVersionErrors(declared, minimum, workflows, process.versions.node), []);
});

const archive = 'https://github.com/polyspec/ordered-json/releases/download/v0.0.2/polyspec-ordered-json-0.0.2.tgz';
const lockOf = (resolved: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'a' }, 'node_modules/@polyspec/ordered-json': { version: '0.0.2', resolved } } });

caseTest('npm dependencies from a release archive and the registry pass', COMPUTE, () => {
  assert.deepEqual(npmGitSourceErrors({
    'packages/ts/package.json': JSON.stringify({ dependencies: { '@polyspec/ordered-json': archive, pg: '^8.23.0' }, devDependencies: { '@types/node': '22.20.2' } }),
    'packages/ts/package-lock.json': lockOf(archive),
  }), []);
});

caseTest('a package.json dependency from git fails', COMPUTE, () => {
  for (const spec of ['github:polyspec/ordered-json#v0.0.1', 'git+https://github.com/polyspec/ordered-json.git#v0.0.1', 'git+ssh://git@github.com/polyspec/ordered-json.git', 'polyspec/ordered-json#v0.0.1'])
    assert.deepEqual(npmGitSourceErrors({ 'package.json': JSON.stringify({ devDependencies: { '@polyspec/ordered-json': spec } }) }), [
      `package.json devDependencies @polyspec/ordered-json is ${spec}, a git source; use the release archive URL of the GitHub tag`,
    ]);
});

caseTest('a package-lock.json entry resolved from git fails', COMPUTE, () => {
  for (const resolved of ['git+ssh://git@github.com/polyspec/ordered-json.git#f491200d3179c36afe29255b0f3ee964f6e83570', 'git://github.com/polyspec/ordered-json.git', 'ssh://git@github.com/polyspec/ordered-json.git', 'github:polyspec/ordered-json'])
    assert.deepEqual(npmGitSourceErrors({ 'packages/ts/package-lock.json': lockOf(resolved) }), [
      `packages/ts/package-lock.json resolves node_modules/@polyspec/ordered-json from ${resolved}, a git source; use the release archive URL of the GitHub tag`,
    ]);
});

const node = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: actions/setup-node@v7',
  '        with:',
  '          node-version-file: mise.toml',
  '          cache: npm',
  '      - run: npm ci',
  '',
].join('\n');

caseTest('a workflow that reads mise.toml on the declared Node passes', COMPUTE, () => {
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': node }, '26.8.1'), []);
});

caseTest('a workflow that declares node-version itself fails', COMPUTE, () => {
  const literal = node.replace('node-version-file: mise.toml', 'node-version: "22.16.0"');
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': literal }, '26.8.1'), [
    'ci.yml declares node-version itself; mise.toml declares it',
    'ci.yml does not read node-version-file mise.toml in actions/setup-node',
  ]);
  const unset = node.replace('actions/setup-node@v7', 'actions/checkout@v5');
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': unset }, '26.8.1'), [
    'ci.yml runs Node without actions/setup-node',
  ]);
});

caseTest('a Node other than that of mise.toml fails', COMPUTE, () => {
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': node }, '22.16.0'), [
    'Node 22.16.0 runs the checks; mise.toml declares 26.8.1; run make install-tools TOOLS=npm, which installs it into var/tools',
  ]);
});

caseTest('a mise.toml node that is not one exact version fails', COMPUTE, () => {
  assert.deepEqual(nodeVersionErrors(mise(''), '>=22.16.0', {}, '26.8.1'), [
    'mise.toml must declare the tool node with one exact version x.y.z, found ""',
  ]);
  assert.deepEqual(nodeVersionErrors(mise('26'), '>=22.16.0', {}, '26.8.1'), [
    'mise.toml must declare the tool node with one exact version x.y.z, found "26"',
  ]);
  assert.deepEqual(nodeVersionErrors(mise('22.12.0'), '>=22.16.0', {}, '22.12.0'), [
    'mise.toml node 22.12.0 is below package.json engines.node >=22.16.0',
  ]);
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '22.16', {}, '26.8.1'), [
    'package.json engines.node must be ">=x.y.z", found "22.16"',
  ]);
});

// The PHP and Rust cases check the repository's declarations and the running php and rustc, and change the minimal workflow one at a time.
const text = (path: string) => readFileSync(new URL(path, repository), 'utf8');
const runningPhp = execFileSync('php', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']).toString();
const runningRustc = /^rustc (\S+)/.exec(execFileSync('rustc', ['--version'], { cwd: repository }).toString())?.[1] ?? '';

caseTest('the checks and every workflow run the PHP of .php-version and the Rust of rust-toolchain.toml', COMPUTE, () => {
  const composer = readComposer(join(repository.pathname, 'packages/php/composer.json'));
  assert.deepEqual(phpVersionErrors(text('.php-version'), composer.require?.php, workflows, runningPhp), []);
  assert.deepEqual(rustToolchainErrors(text('rust-toolchain.toml'), text('Makefile'), workflows, runningRustc), []);
});

const php = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: shivammathur/setup-php@v2',
  '        with:',
  '          php-version-file: .php-version',
  '          extensions: pdo_sqlite',
  '          coverage: none',
  '      - run: composer install --working-dir=packages/php',
  '',
].join('\n');

caseTest('a workflow that declares php-version itself fails', COMPUTE, () => {
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php }, '8.5'), []);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('php-version-file: .php-version', 'php-version: "8.4"') }, '8.5'), [
    'ci.yml declares php-version itself; .php-version declares it',
    'ci.yml does not read php-version-file .php-version in shivammathur/setup-php',
    'ci.yml must set up the PHP of .php-version last, so that it is php on PATH',
  ]);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('shivammathur/setup-php@v2', 'actions/checkout@v5') }, '8.5'), [
    'ci.yml runs PHP without shivammathur/setup-php',
  ]);
});

caseTest('a workflow that sets up PHP with a coverage driver fails', COMPUTE, () => {
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('          coverage: none\n', '') }, '8.5'), [
    'ci.yml sets up PHP without coverage: none, so Xdebug or pcov can load',
  ]);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('coverage: none', 'coverage: xdebug') }, '8.5'), [
    'ci.yml sets up PHP without coverage: none, so Xdebug or pcov can load',
  ]);
});

caseTest('a PHP other than .php-version or below composer.json fails', COMPUTE, () => {
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', {}, '8.4'), ['PHP 8.4 runs the checks; .php-version declares 8.5']);
  assert.deepEqual(phpVersionErrors('8.3\n', '>=8.4', {}, '8.3'), ['.php-version 8.3 is below packages/php/composer.json require.php >=8.4']);
  assert.deepEqual(phpVersionErrors('8.5.10\n', '>=8.4', {}, '8.5'), ['.php-version must hold one release x.y and a newline, found "8.5.10\\n"']);
  assert.deepEqual(phpVersionErrors('8.5\n', '^8.4', {}, '8.5'), ['packages/php/composer.json require.php must be ">=x.y", found "^8.4"']);
});

const toolchain = '[toolchain]\nchannel = "1.98.1"\ncomponents = ["clippy", "rustfmt"]\nprofile = "minimal"\n';
const makefile = `PHYSICAL_RUST_TOOLCHAIN := $(shell sed -n 's/^channel = "\\(.*\\)"$$/\\1/p' rust-toolchain.toml)\nexport RUSTUP_TOOLCHAIN := $(PHYSICAL_RUST_TOOLCHAIN)\n`;
const rust = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - name: Rust toolchain',
  '        run: rustup toolchain install',
  '      - uses: Swatinem/rust-cache@v2',
  '      - run: (cd packages/rust && cargo test --locked)',
  '',
].join('\n');

caseTest('a workflow or Makefile that chooses a Rust toolchain itself fails', COMPUTE, () => {
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust }, '1.98.1'), []);
  const action = rust.replace('      - name: Rust toolchain\n        run: rustup toolchain install\n',
    '      - uses: dtolnay/rust-toolchain@stable\n        with:\n          components: clippy\n');
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': action }, '1.98.1'), [
    'ci.yml chooses a Rust toolchain with dtolnay/rust-toolchain; rust-toolchain.toml declares it',
    'ci.yml does not install the toolchain of rust-toolchain.toml with rustup toolchain install',
  ]);
  for (const run of ['rustup toolchain install 1.98.0', 'rustup default stable', 'cargo +nightly test']) {
    assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('cargo test --locked', `true; ${run}`).replace('run: rustup toolchain install', `run: rustup toolchain install && ${run}`) }, '1.98.1'),
      ['ci.yml chooses a Rust toolchain itself; rust-toolchain.toml declares it'], run);
  }
  assert.deepEqual(rustToolchainErrors(toolchain, 'PHYSICAL_RUST_TOOLCHAIN ?= 1.98.1\n', {}, '1.98.1'), [
    'Makefile does not read PHYSICAL_RUST_TOOLCHAIN from rust-toolchain.toml',
    'Makefile declares a Rust toolchain itself; rust-toolchain.toml declares it',
  ]);
});

caseTest('a rustc other than rust-toolchain.toml fails', COMPUTE, () => {
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, {}, '1.98.0'), ['rustc 1.98.0 runs the checks; rust-toolchain.toml declares 1.98.1']);
  assert.deepEqual(rustToolchainErrors('[toolchain]\nchannel = "stable"\ncomponents = ["clippy"]\n', makefile, {}, '1.98.1'), [
    'rust-toolchain.toml must declare one channel x.y.z under [toolchain]',
    'rust-toolchain.toml does not install rustfmt',
  ]);
});

// A PHPUnit run starts through kit's run-tests, which stops a test at its timeout (K436): no line of the Makefile starts the
// vendor PHPUnit binary itself, whether in a recipe or in a variable such as PHP_EXTENSION_TESTS.
caseTest('every PHPUnit run of the Makefile goes through run-tests', COMPUTE, () => {
  const direct = /[=;&(@\s]vendor-php\/bin\/phpunit\s/;
  assert.deepEqual(text('Makefile').split('\n').filter(line => direct.test(line)), []);
});

// The CHECK_TARGETS case checks the repository's workflow and Makefile, and the minimal workflow.
caseTest('the CI workflow runs every target of CHECK_TARGETS once', COMPUTE, () => {
  const targets = checkTargets(text('Makefile'));
  for (const target of ['ts-min-check', 'php-min-check', 'feature-coverage', 'feature-verify-rust', 'feature-verify-other', 'go-test-check'])
    assert.ok(targets.includes(target), `${target} is not in CHECK_TARGETS`);
  assert.deepEqual(ciCheckTargetErrors(workflow, text('Makefile')), []);
});

caseTest('a workflow that omits or repeats a target of CHECK_TARGETS fails', COMPUTE, () => {
  const make = 'CHECK_TARGETS = repo-check ts-min-check feature-check\n';
  const listed = steps.replace('make repo-check', 'make repo-check feature-check\n          make ts-min-check');
  assert.deepEqual(ciCheckTargetErrors(listed, make), []);
  assert.deepEqual(ciCheckTargetErrors(steps, make), [
    'ci.yml does not run ts-min-check of CHECK_TARGETS',
    'ci.yml does not run feature-check of CHECK_TARGETS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(steps.replace('make repo-check', 'make orm-check'), make), []);
  assert.deepEqual(ciCheckTargetErrors(steps.replace('make repo-check', 'make orm-check\n          make ts-min-check'), make), [
    'ci.yml step "checks" runs ts-min-check, which make orm-check runs',
  ]);
  assert.deepEqual(ciCheckTargetErrors(steps, 'CHECK =\n'), ['Makefile declares no CHECK_TARGETS']);
});

// The CI group case (G5.111) checks whether the repository's Makefile and workflow split CHECK_TARGETS exactly into groups, and the minimal
// one rejects a target missing from the Makefile and workflow, a target in two groups, a target outside CHECK_TARGETS, and a matrix other than CI_GROUPS.
caseTest('the CI groups run every target of CHECK_TARGETS in exactly one job', COMPUTE, () => {
  const makefile = text('Makefile');
  const { groups, targets } = ciGroups(makefile);
  assert.ok(groups.length > 1, 'the Makefile declares more than one CI group');
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : Number(a > b));
  assert.deepEqual(groups.flatMap(group => targets[group] ?? []).sort(byCodeUnit), [...checkTargets(makefile)].sort(byCodeUnit));
  // The group-rows-db targets each run in exactly one CI group (KSTD-10-1).
  for (const target of ['group-rows-db-go', 'group-rows-db-typescript', 'group-rows-db-python', 'group-rows-db-php', 'group-rows-db-php-extension', 'group-rows-db-rust']) {
    assert.equal(groups.flatMap(group => targets[group] ?? []).filter(name => name === target).length, 1, `${target} runs in one CI group`);
  }
  assert.ok(workflow.includes('        run: make check-run GROUP=${{ matrix.group }}\n'), 'ci.yml runs make check-run for the group of its matrix');
  assert.deepEqual(ciCheckTargetErrors(workflow, makefile), []);
});

caseTest('a CI group set that omits, repeats or adds a target of CHECK_TARGETS fails', COMPUTE, () => {
  const grouped = (matrix = '[one, two]') => `jobs:\n  test:\n    strategy:\n      matrix:\n        group: ${matrix}\n    steps:\n      - name: make orm-check\n        run: make check-run GROUP=\${{ matrix.group }}\n`;
  const make = (groups: string[]) => ['CHECK_TARGETS = a-check b-check c-check', ...groups, ''].join('\n');
  const good = make(['CI_GROUPS = one two', 'CI_TARGETS_one = a-check c-check', 'CI_TARGETS_two = b-check']);
  assert.deepEqual(ciCheckTargetErrors(grouped(), good), []);
  assert.deepEqual(ciCheckTargetErrors(grouped(), make(['CI_GROUPS = one two', 'CI_TARGETS_one = a-check b-check d-check', 'CI_TARGETS_two = b-check'])), [
    'CI groups one, two each run b-check; every target of CHECK_TARGETS runs in exactly one group',
    'no CI group runs c-check of CHECK_TARGETS; add it to one CI_TARGETS_<group>',
    'CI group one runs d-check, which is not a target of CHECK_TARGETS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(grouped('[one, three, three]'), good), [
    'ci.yml job test lists the matrix group three twice',
    'ci.yml job test has no matrix group two of CI_GROUPS, so no job runs its targets',
    'ci.yml job test has the matrix group three, which is not in CI_GROUPS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(grouped(), make(['CI_GROUPS = one two', 'CI_TARGETS_one = a-check b-check c-check', 'CI_TARGETS_three = b-check'])), [
    'Makefile CI group two declares no CI_TARGETS_two',
    'Makefile declares CI_TARGETS_three, but three is not in CI_GROUPS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(grouped(), make([])), ['ci.yml runs make check-run GROUP=${{ matrix.group }}, but the Makefile declares no CI_GROUPS']);
  assert.deepEqual(ciCheckTargetErrors(grouped().replace('    strategy:\n      matrix:\n        group: [one, two]\n', ''), good), [
    'ci.yml job test runs make check-run GROUP=${{ matrix.group }} without a matrix group: [...] of CI_GROUPS',
  ]);
  // A group job that also runs a CHECK_TARGETS target separately runs it twice.
  assert.deepEqual(ciCheckTargetErrors(grouped().replace('GROUP=${{ matrix.group }}\n', 'GROUP=${{ matrix.group }}\n      - name: again\n        run: make b-check\n'), good), [
    'ci.yml step "again" runs b-check, which make orm-check runs',
  ]);
});

// The report path case (G5.128) checks whether the report directory a CI job uploads is the directory that the runner uses, for each group of CI_GROUPS, as that job's ORM_CHECK_RUN_ID
// directory. The runner replaces `-` with `_`, so reports of a group with `-` in its name were not uploaded.
caseTest('every CI group uploads the report directory that the runner writes', COMPUTE, () => {
  assert.deepEqual(ciReportPathErrors(workflow, text('Makefile')), []);
  const make = text('Makefile').replace(/^CI_GROUPS = (.*)$/m, 'CI_GROUPS = $1 stress-x').concat('\nCI_TARGETS_stress-x = feature-stress-mysql-check\n');
  assert.deepEqual(ciReportPathErrors(workflow, make), [
    'ci.yml job test group stress-x uploads .runtime/check/ci_1_1_stress-x/report/, but the runner writes the report of ORM_CHECK_RUN_ID 1-1-stress-x to .runtime/check/ci_1_1_stress_x/report/; name the group with lowercase letters, digits and _ only',
  ]);
});

// The group setup case (G5.127) checks, for every group in CI_GROUPS, whether the group runs the target's need and the setup step of that need's setup stage requires,
// using the repository's Makefile and contracts/check-inputs.json. databases/create starts the server as a server-programs
// program, so a group of a target that declares only databases also needs the server-programs output. The output is checked in the control case,
// where the target does not look at databases: stress-db skips the server-programs setup step.
caseTest('every CI group runs the setup steps of its needs and of the setup step databases/create', COMPUTE, () => {
  assert.deepEqual(expandNeeds(['databases']), ['databases', 'go', 'node-modules', 'server-programs']);
  assert.deepEqual(expandNeeds(['rust', 'go']), ['rust', 'go']);
  const { groups, targets } = ciGroups(text('Makefile'));
  assert.ok(groups.length > 0 && groups.every(group => (targets[group]?.length ?? 0) > 0), groups.join(' '));
  const needs = declaredNeeds(repository.pathname);
  const layout = Object.fromEntries(groups.map(group => [group, targets[group] ?? []]));
  assert.deepEqual(groupSetupErrors(layout, needs), []);
  const declaredOnly = (names: readonly string[], declared: Record<string, string[]>) => {
    const wanted = new Set(names.flatMap(name => declared[name] ?? []));
    return Object.fromEntries(Object.entries(GROUP_OUTPUTS).map(([output, from]) => [output, from.filter(need => output !== 'server-programs' || need !== 'databases').some(need => wanted.has(need))]));
  };
  assert.deepEqual(groupSetupErrors({ 'stress-db': ['stress-only'] }, { 'stress-only': ['go', 'databases'] }, declaredOnly).map(line => line.replace(/ which installs.*/, '')),
    ['CI group stress-db skips the setup step server-programs,']);
  assert.deepEqual(groupSetupErrors({ 'stress-db': ['stress-only'] }, { 'stress-only': ['go', 'databases'] }), []);
});

// The CI group setup case (G5.111) checks whether the group job's setup step runs only under the condition ci-setup.mts declares, and the group-needs
// step writes the output of make ci-group-needs, and whether the summary and report after it write each group's run id and report.
caseTest('a CI group job runs each setup step under its declared condition and reports per group', COMPUTE, () => {
  assert.equal(stepCondition('go'), '${{ !cancelled() }}');
  assert.equal(stepCondition('composer'), "${{ !cancelled() && steps.group-needs.outputs.php == 'true' }}");
  assert.equal(stepCondition('servers'), "${{ !cancelled() && steps.group-needs.outputs.databases == 'true' }}");
  assert.deepEqual(groupOutputs(['a', 'b'], { a: ['go', 'composer'], b: ['databases'] }),
    { 'node-modules': true, rust: false, php: true, 'php-extension-tools': false, 'server-programs': true, databases: true, python: false, flowmark: false });
  assert.deepEqual(groupOutputs(['b'], { b: ['databases'] }),
    { 'node-modules': true, rust: false, php: false, 'php-extension-tools': false, 'server-programs': true, databases: true, python: false, flowmark: false });
  assert.deepEqual(groupOutputs(['c'], { c: ['go', 'flowmark'] }),
    { 'node-modules': false, rust: false, php: false, 'php-extension-tools': false, 'server-programs': false, databases: false, python: false, flowmark: true });
  assert.throws(() => groupOutputs(['x'], {}), /target x declares no needs in contracts\/check-inputs\.json; declare its scope and needs there/);
  const setup = { 'group-needs': null, go: 'go', composer: 'composer', servers: 'databases' };
  const runner = ['checkout'];
  const check = `      - name: make orm-check\n        if: \${{ !cancelled() }}\n        env:\n          ORM_CHECK_RUN_ID: \${{ github.run_id }}-\${{ github.run_attempt }}-\${{ matrix.group }}\n          ORM_CI_SETUP: \${{ toJSON(steps) }}\n        run: make check-run GROUP=\${{ matrix.group }}\n`;
  const after = yamlSteps(AFTER_GROUP_CHECK);
  const job = (needs: string, composer: string) => `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v5\n        id: checkout\n      - name: setup of the CI group\n        id: group-needs\n        if: \${{ !cancelled() }}\n        run: ${needs}\n      - uses: actions/setup-go@v6\n        id: go\n        if: \${{ !cancelled() }}\n      - name: install PHP dependencies\n        id: composer\n        if: ${composer}\n        run: make orm-install-php\n      - name: database servers\n        id: servers\n        if: ${stepCondition('servers')}\n        run: make orm-test-servers\n${check}${after}`;
  const good = job(GROUP_NEEDS, stepCondition('composer'));
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good }, { setup, runner }), []);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': good }), []);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': job(GROUP_NEEDS, '${{ !cancelled() }}') }, { setup, runner }), [
    `ci.yml step "install PHP dependencies" of the CI group job runs under if: \${{ !cancelled() }} instead of if: ${stepCondition('composer')}, the condition that scripts/check/ci-setup.mts declares for the step composer`,
  ]);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': job('make ci-group-needs GROUP=static >> "$GITHUB_OUTPUT"', stepCondition('composer')) }, { setup, runner }), [
    `ci.yml step "setup of the CI group" runs make ci-group-needs GROUP=static >> "$GITHUB_OUTPUT" instead of ${GROUP_NEEDS}, which writes the setup of the CI group as step outputs`,
  ]);
  // A report step that is not a per-group report, and a run id without a group, overwrite the reports of the groups.
  const shared = good.replace('name: check-${{ matrix.group }}-', 'name: check-');
  assert.match(ciAfterCheckErrors({ 'ci.yml': shared })[0] ?? '', /^ci\.yml step "report" after make orm-check is not the declared report step: /);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': good.replace('${{ github.run_attempt }}-${{ matrix.group }}\n          ORM_CI_SETUP', '${{ github.run_attempt }}\n          ORM_CI_SETUP') }), [
    'ci.yml step "make orm-check" gives make orm-check no ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.group }}, which names the report of the run',
  ]);
});

// The ci-passed case (G5.113-2) checks whether the repository's ci.yml places job ci-passed last and takes every other job as needs, and the minimal
// workflow rejects a missing job, a job that is not last, a condition other than always(), and another step.
caseTest('the job ci-passed runs last under always() and needs every other job', COMPUTE, () => {
  assert.deepEqual(ciPassedErrors(workflow), []);
  const step = `    steps:\n${yamlSteps(CI_PASSED_STEPS)}`;
  const job = (condition: string, needs: string) => `  ci-passed:\n    if: ${condition}\n    needs: [${needs}]\n    runs-on: ubuntu-26.04-arm\n${step}`;
  const others = '  test:\n    steps:\n      - run: make orm-check\n  docs:\n    steps:\n      - run: make docs-ci\n';
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs')}`), []);
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}`), ['ci.yml has no job ci-passed, the check that the ruleset requires; add it as the last job with if: ${{ always() }} and needs: every other job']);
  assert.deepEqual(ciPassedErrors(`jobs:\n${job('${{ success() }}', 'test, pages')}${others}`), [
    'ci.yml job ci-passed is not the last job; move it after docs',
    'ci.yml job ci-passed does not run with if: ${{ always() }}, so a failed or cancelled job skips it instead of failing it',
    'ci.yml job ci-passed does not need the job docs; list every other job under needs',
    'ci.yml job ci-passed needs pages, which is no other job of ci.yml',
  ]);
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace('make ci-passed', 'echo passed')}`)[0] ?? '', /^ci\.yml job ci-passed has the steps .* instead of \[\{"uses":"actions\/checkout@v5"\}/);
  // A job without the checkout runs make where the repository is not, and make finds no Makefile.
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace('      - uses: actions/checkout@v5\n', '')}`)[0] ?? '', /^ci\.yml job ci-passed has the steps \[\{"uses":"actions\/setup-node@v7"/);
});

// The duplicate-run case checks the repository's workflow, Makefile, feature contract and the minimal workflow.
caseTest('the CI workflow does not run a verification command of feature-check again', COMPUTE, () => {
  const commands = featureCommands(readFeatures(repository.pathname));
  for (const command of ['node scripts/perf-test.mts', 'node tests/run-long.mts typescript-build -- npm run typescript:build && PATH="$HOME/.cargo/bin:$PATH" node tests/interfaces/check/main.mts --self-test'])
    assert.ok(commands.includes(command), `${command} is not a verification command of contracts/features.json`);
  assert.deepEqual(ciDuplicateCommandErrors(workflow, text('Makefile'), commands), []);
});

caseTest('a workflow that runs a verification command of feature-check again fails', COMPUTE, () => {
  const make = [
    'CHECK_TARGETS = feature-check',
    'interface-check:',
    '\tPATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test',
    'perf-check:',
    '\t$(WITH_TEST_ENV) node scripts/perf-test.mts',
    'fuzz-check:',
    "\tgo test ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest",
    '',
  ].join('\n');
  const commands = featureCommands({ features: [{ verification: [
    { id: 'interfaces', command: 'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test' },
    { id: 'perf', command: 'node scripts/perf-test.mts' },
    { id: 'elsewhere', command: 'php packages/php/tests/CodecVectorsTest.php', cwd: 'packages/php' },
  ] }] });
  assert.deepEqual(commands, ['PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test', 'node scripts/perf-test.mts']);
  const twice = steps.replace('make repo-check', 'make orm-check\n          make interface-check fuzz-check\n          node scripts/perf-test.mts\n          php packages/php/tests/CodecVectorsTest.php');
  assert.deepEqual(ciDuplicateCommandErrors(twice, make, commands), [
    'ci.yml step "checks" runs make interface-check, whose commands make orm-check runs in feature-check',
    'ci.yml step "checks" runs node scripts/perf-test.mts, which make orm-check runs in feature-check',
  ]);
  assert.deepEqual(ciDuplicateCommandErrors(steps.replace('make repo-check', 'make orm-check\n          make fuzz-check'), make, commands), []);
  // A target whose name holds a slash is a target of the Makefile too (makeTargets, T137-1-4-2-2).
  assert.deepEqual(ciDuplicateCommandErrors(steps.replace('make repo-check', 'make orm-check\n          make perf-check/run'), `${make}perf-check/run:\n\tnode scripts/perf-test.mts\n`, commands), [
    'ci.yml step "checks" runs make perf-check/run, whose commands make orm-check runs in feature-check',
  ]);
});

// The helper run case (G5.120) checks whether make orm-check runs each helper check once: the repository's Makefile, feature contract and
// scripts/check/databases.mts, and a minimal Makefile that runs a helper twice or never.
caseTest('make orm-check runs the check of every helper once', COMPUTE, () => {
  assert.deepEqual(helperRunErrors(readFeatures(repository.pathname), text('Makefile'), scriptTexts.get('scripts/check/databases.mts') ?? ''), []);
  const manifest = { features: [], helpers: [
    { id: 'plain', command: 'php tests/plain_test.php' },
    { id: 'suite', command: 'make --no-print-directory TEST_ENV="$ORM_TEST_ENV" suite-check' },
    { id: 'nested', command: 'make --no-print-directory nested-check' },
    { id: 'seed', command: 'sh scripts/seed.sh' },
    { id: 'seedts', command: 'node scripts/seedts.mts' },
    { id: 'stress', command: 'make stress-bench' },
  ] };
  const make = (suite: string, stress: string) => [
    'CHECK_TARGETS = helper-check stress-check suite-check outer-check',
    `STRESS = ${stress}`,
    `SUITE = ${suite}`,
    'helper-check:',
    '	$(WITH_TEST_ENV) node scripts/features/check.mts --run --helpers $(addprefix --without-helper ,$(STRESS) $(SUITE))',
    'stress-check:',
    '	$(WITH_TEST_ENV) node scripts/features/check.mts --run $(addprefix --helper ,$(STRESS))',
    'suite-check:',
    '	go test ./suite',
    'outer-check: nested-check',
    '	go test ./outer',
    'nested-check:',
    '	go test ./nested',
    '',
  ].join('\n');
  const setup = 'BENCH_MYSQL_DSN=x "$ROOT/scripts/seed.sh"\nBENCH_MYSQL_DSN=x node "$ROOT/scripts/seedts.mts"\n';
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts', 'stress'), setup), []);
  const twice = (id: string, places: string) => `make orm-check runs the check of helper ${id} 2 times: ${places}; run it once, and add a helper whose check a target or setup step of make orm-check runs to FEATURE_SUITE_HELPERS, which make feature-helper-check leaves out`;
  assert.deepEqual(helperRunErrors(manifest, make('suite', 'stress'), setup), [
    twice('nested', 'make helper-check; make nested-check, a target of make orm-check'),
    twice('seed', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seed.sh)'),
    twice('seedts', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seedts.mts)'),
  ]);
  // A prerequisite on a continuation line is a prerequisite too (makeTargets, T137-1-4-2-2).
  assert.deepEqual(helperRunErrors(manifest, make('suite', 'stress').replace('outer-check: nested-check', 'outer-check: suite-check \\\n  nested-check'), setup), [
    twice('nested', 'make helper-check; make nested-check, a target of make orm-check'),
    twice('seed', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seed.sh)'),
    twice('seedts', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seedts.mts)'),
  ]);
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts plain', 'stress'), setup), [
    'make orm-check runs no check of helper plain: no target of CHECK_TARGETS selects it and its command is no target or setup step of make orm-check; leave it out of FEATURE_STRESS_HELPERS and FEATURE_SUITE_HELPERS so that make feature-helper-check runs it',
  ]);
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts', 'stress').replace('--helpers $(addprefix --without-helper ,$(STRESS) $(SUITE))', '--helpers $(addprefix --without-helper ,$(SUITE))'), setup), [
    twice('stress', 'make helper-check; make stress-check'),
  ]);
});

// The helper environment case checks whether the Makefile exports the shell variables read by the make commands of helper checks: the repository's contracts/features.json and
// Makefile, and a minimal manifest that reads a variable (ORM_OWNER_TEST_ENV) that set only one execution path.
caseTest('every variable a helper make command reads is exported by the Makefile', COMPUTE, () => {
  assert.deepEqual(helperEnvironmentErrors(readFeatures(repository.pathname), text('Makefile')), []);
  const makefile = 'export ORM_TEST_ENV = $(abspath $(TEST_ENV))\nDECIMAL_ENV =\nexport DECIMAL_ENV\nexport A B\n';
  const manifest = { helpers: [
    { id: 'exported', command: 'make --no-print-directory TEST_ENV="$ORM_TEST_ENV" DECIMAL_ENV="${DECIMAL_ENV}" A="$A" B="$B" x-check' },
    { id: 'owner-only', command: 'make --no-print-directory TEST_ENV="$ORM_OWNER_TEST_ENV" x-check' },
    { id: 'script', command: 'sh scripts/x.sh "$HOME"' },
  ] };
  assert.deepEqual(helperEnvironmentErrors(manifest, makefile), [
    'contracts/features.json helper owner-only reads $ORM_OWNER_TEST_ENV, which the Makefile does not export; export it from the Makefile, as ORM_TEST_ENV and DECIMAL_ENV are, so that every make target that runs the helper passes it',
  ]);
});

// The runner case checks the repository's .github/runner and workflow, and the minimal workflow.
// A workflow among the copies of @polyspec/kit is kit's and make kit-check holds it byte for byte, so the workflow rules of this
// repository do not check it (T115). A runner other than that of kit's release.yml is a change of kit.
const vendoredFiles = copies;

caseTest('the workflow rules skip the workflows that @polyspec/kit copies', COMPUTE, () => {
  // kit copies two workflows, gates.yml and release.yml; its other copies (PRINCIPLES.md, the lint configurations, the bootstrap) are no workflows.
  assert.deepEqual(Object.keys(vendoredFiles).filter(file => file.startsWith('.github/workflows/')), ['.github/workflows/release.yml', '.github/workflows/gates.yml']);
  const all = { '.github/workflows/ci.yml': 'a', '.github/workflows/release.yml': 'b' };
  assert.deepEqual(ownWorkflows(all, vendoredFiles), { '.github/workflows/ci.yml': 'a' });
  assert.deepEqual(ownWorkflows({ 'ci.yml': 'a', 'release.yml': 'b' }, vendoredFiles), { 'ci.yml': 'a' });
  assert.throws(() => ownWorkflows(all, null), /no copies of @polyspec\/kit/);
});

// The commit identity is declared, so commits-check enforces it: config/commit-identity.json is the kit copy of this
// repository's identity, which AGENTS.md rules (KSTD-5-17).
caseTest('the repository declares its commit identity, which commits-check enforces', COMPUTE, () => {
  const identity = new URL('../../config/commit-identity.json', import.meta.url).pathname;
  assert.ok(existsSync(identity), 'config/commit-identity.json is missing; run make kit-sync to write the kit copy');
  assert.deepEqual(JSON.parse(readFileSync(identity, 'utf8')), { schema: 1, name: 'min-0-max', email: 'max@blue.tools' });
});

caseTest('the copies of @polyspec/kit are read from the installed package', COMPUTE, () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-kit-copies-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"x","private":true}');
    assert.throws(() => kitCopies(root), /@polyspec\/kit is not installed .*; run make install-tools TOOLS=npm, then make install-packages/);
    mkdirSync(join(root, 'node_modules', '@polyspec', 'kit'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@polyspec', 'kit', 'package.json'), '{"name":"@polyspec/kit","kit":{"copies":{"ruff.toml":"ruff.toml"}}}');
    assert.deepEqual(kitCopies(root), { 'ruff.toml': 'ruff.toml' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('every workflow job runs on the runner of .github/runner', COMPUTE, () => {
  assert.equal(text('.github/runner'), 'ubuntu-26.04-arm\n');
  assert.deepEqual(runnerErrors(text('.github/runner'), ownWorkflows(workflows, vendoredFiles)), []);
});

caseTest('a job on another runner fails', COMPUTE, () => {
  const job = 'jobs:\n  test:\n    runs-on: ubuntu-26.04-arm\n    steps:\n      - run: "true"\n';
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job }), []);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job.replace('ubuntu-26.04-arm', 'ubuntu-24.04') }), [
    'ci.yml job test runs on ubuntu-24.04; .github/runner declares ubuntu-26.04-arm',
  ]);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job.replace('    runs-on: ubuntu-26.04-arm\n', '') }), ['ci.yml job test declares no runs-on']);
  assert.deepEqual(runnerErrors('', {}), ['.github/runner must hold one runner label and a newline, found ""']);
  assert.deepEqual(runnerErrors('macos-26\n', {}), [
    '.github/runner macos-26 is not a Linux runner; the linux-runner checks of contracts/features.json run only there',
  ]);
});

caseTest('the lowest PHP release comes only from the php-min step', COMPUTE, () => {
  const minimum = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: lowest PHP release of the PHP client',
    '        id: php-min',
    '        run: make --no-print-directory ci-php-min-version >> "$GITHUB_OUTPUT"',
    '      - uses: shivammathur/setup-php@v2',
    '        with:',
    '          php-version: ${{ steps.php-min.outputs.version }}',
    '          coverage: none',
    '      - uses: shivammathur/setup-php@v2',
    '        with:',
    '          php-version-file: .php-version',
    '          coverage: none',
    '      - run: composer install --working-dir=packages/php',
    '',
  ].join('\n');
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum }, '8.5'), []);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum.replace('        id: php-min\n', '') }, '8.5'), [
    'ci.yml reads steps.php-min.outputs.version without the step that writes it from node scripts/php/php-min.mts',
  ]);
  const reversed = minimum.replace('          php-version: ${{ steps.php-min.outputs.version }}', '          php-version-file: .php-version#')
    .replace('          php-version-file: .php-version\n          coverage: none\n      - run', '          php-version: ${{ steps.php-min.outputs.version }}\n          coverage: none\n      - run').replace('.php-version#', '.php-version');
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': reversed }, '8.5'), [
    'ci.yml must set up the PHP of .php-version last, so that it is php on PATH',
  ]);
});

// The socket case starts the servers of a checkout whose socket folder (T135) is long. Before any server starts, start
// must fail naming the first socket path over the platform limit (Linux 107, macOS 103 bytes) and that limit, creating
// neither the socket folder nor the servers directory. That the real declaration fits for any checkout is the case of
// scripts/test-servers.test.mts.
caseTest('test-servers.mts refuses a socket path longer than the platform limit', PROCESS, async () => {
  const limits: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };
  const limit = limits[process.platform];
  assert.ok(limit !== undefined, `the socket path limit of ${process.platform} is not known`);
  const base = mkdtempSync('/tmp/orm-sock-');
  try {
    const fits = (name: string) => (folder: string) => Buffer.byteLength(join(folder, name)) <= limit;
    // The first folder puts even the shortest socket, mysql.sock, over the limit; the second only the longest,
    // proxysql-admin-pgsql.sock.
    const deep = (name: string, keep?: (folder: string) => boolean) => {
      let folder = join(base, 'sockets');
      while (fits(name)(folder)) {
        const next = join(folder, 'd');
        folder = keep && !keep(next) ? `${folder}x` : next;
      }
      return folder;
    };
    const system = process.platform === 'linux' ? 'Linux' : 'macOS';
    for (const [folder, name] of [[deep('mysql.sock'), 'mysql.sock'], [deep('proxysql-admin-pgsql.sock', fits('mysql.sock')), 'proxysql-admin-pgsql.sock']] as const) {
      const socket = join(folder, name);
      await assert.rejects(startServers(['start'], serverPaths(base, folder)),
        (error: unknown) => error instanceof TestServerError && error.status === 1 &&
          error.message === `test-servers: socket path ${socket} is ${Buffer.byteLength(socket)} bytes; ${system} allows at most ${limit}`);
      assert.equal(existsSync(join(base, 'sockets')), false, 'the socket folder was created');
      assert.equal(existsSync(join(base, '.runtime/servers')), false, 'the servers directory was created');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The shared target case checks the repository's Makefile and a minimal Makefile.
caseTest('the Makefile runs no program from the shared Rust target directory and builds there under its lease', COMPUTE, () => {
  assert.deepEqual(sharedTargetErrors(text('Makefile')), []);
  const makefile = [
    'DOCUMENT = $(CARGO_TARGET_DIR)/dbspec/stress.dbs',
    'run:',
    '\t$(RUN_LONG) rust-build/x --cwd packages/rust -- cargo build --locked --example x',
    '\tX=$(CARGO_TARGET_DIR)/debug/examples/x go test ./a',
    'copied:',
    '\t$(RUN_LONG) rust-build/y --cwd packages/rust -- $(CARGO_COPY) debug/y -- cargo build --locked --bin y',
    '\t$(RUN_LONG) rust-build/z -- $(CARGO_LEASED) cargo test --no-run --locked',
    '\t# $(CARGO_TARGET_DIR)/debug/y in a comment',
    '',
  ].join('\n');
  assert.deepEqual(sharedTargetErrors(makefile), [
    'Makefile:1 uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): DOCUMENT = $(CARGO_TARGET_DIR)/dbspec/stress.dbs',
    'Makefile:4 uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): X=$(CARGO_TARGET_DIR)/debug/examples/x go test ./a',
    'Makefile run builds into the shared Rust target directory without its lease; run the build under $(CARGO_LEASED) or $(CARGO_COPY): $(RUN_LONG) rust-build/x --cwd packages/rust -- cargo build --locked --example x',
  ]);
});

// The executable file case checks the repository's Makefile and a minimal Makefile.
caseTest('the files of one run live in its run directory and a TypeScript build holds its output', COMPUTE, () => {
  assert.deepEqual(runtimePathErrors(text('Makefile')), []);
  assert.deepEqual(typescriptHolderErrors(text('Makefile')), []);
  const makefile = [
    'TEST_ENV = .runtime/servers/env',
    'SEND_SQLITE_DSN = sqlite://$(dir $(abspath $(TEST_ENV)))send-savepoint.sqlite',
    'TIMING = .runtime/timing/dbspec.test',
    'LEASE = $(abspath .runtime/bin/lease)',
    'RUN_DIR = $(abspath .runtime/run)/$@-$$PPID',
    'X_LEASES = $(abspath .runtime/x.leases)',
    'held:',
    '\t$(HOLD_TYPESCRIPT)',
    '\t$(TSC_BUILD)',
    'bare:',
    '\tnpm run typescript:test',
    '',
  ].join('\n');
  assert.deepEqual(runtimePathErrors(makefile), [
    'Makefile:2 names a fixed file that runs would share; put the file of one run into $(RUN_DIR): SEND_SQLITE_DSN = sqlite://$(dir $(abspath $(TEST_ENV)))send-savepoint.sqlite',
    'Makefile:3 names a fixed file that runs would share; put the file of one run into $(RUN_DIR): TIMING = .runtime/timing/dbspec.test',
  ]);
  assert.deepEqual(typescriptHolderErrors(makefile), ['Makefile bare builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)']);
  // A target holds the build through a prerequisite that holds it, as ts-check/types does through ts-check/hold; a target
  // whose name holds a slash is checked like any other (T137-1-4-2-2).
  const parts = 'ts/hold: tool\n\t$(HOLD_TYPESCRIPT)\nts/types: ts/hold\n\tnpm run typescript:check\nts/later: ts/types\n\tnpm run typescript:test\nts/bare: tool\n\tnpm run typescript:test\n';
  assert.deepEqual(typescriptHolderErrors(parts), ['Makefile ts/bare builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)']);
});

// The Makefile reading case checks whether, as make reads it, each target gives back its prerequisite targets and recipe (T137-1-4-2-2).
caseTest('the Makefile reader names every target with its prerequisites and recipe', COMPUTE, () => {
  const makefile = [
    '.PHONY: a b/c',
    'A := 1',
    'a: b/c d \\',
    '  e | f',
    '\techo a \\',
    '\t  more',
    'b/c x/y: ; echo inline',
    '\techo c',
    '# comment',
    'p/%: RUN_DIR = /tmp/$@',
    'p/%:',
    '\techo $*',
    'B = 2',
    '\techo after-variable',
    'z::',
    '',
  ].join('\n');
  assert.deepEqual(makeTargets(makefile), [
    { target: '.PHONY', prerequisites: ['a', 'b/c'], commands: [] },
    { target: 'a', prerequisites: ['b/c', 'd', 'e', 'f'], commands: ['echo a \\\n  more'] },
    { target: 'b/c', prerequisites: [], commands: ['echo inline', 'echo c'] },
    { target: 'x/y', prerequisites: [], commands: ['echo inline', 'echo c'] },
    { target: 'p/%', prerequisites: [], commands: ['echo $*'] },
    { target: 'z', prerequisites: [], commands: [] },
  ]);
  assert.deepEqual(makeRecipes(makefile).map(unit => unit.name), ['Makefile a', 'Makefile b/c', 'Makefile x/y', 'Makefile p/%', 'Makefile']);
});

// The lease case checks commands outside the Makefile and a minimal unit.
caseTest('commands outside the Makefile build into the shared Rust target directory only under its lease', COMPUTE, () => {
  const { packageUnits } = runUnits();
  const commands = [...makeRecipes(text('Makefile')), ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command, dialect: unit.dialect })));
  const scripts = reachedScripts(commands, readScript, { throughLong: true });
  assert.deepEqual(unleasedCargoErrors([...featureUnits(), ...packageUnits, ...scripts]), []);
  const unit = (name: string, command: string) => ({ name, commands: [command], dialect: 'sh' as const });
  const build = (segment: string) => `x builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`;
  assert.deepEqual(unleasedCargoErrors([
    unit('x', 'node tests/run-long.mts b -- cargo build --locked'),
    unit('x', '"$LEASE" run "$CARGO_LEASES" exclusive --wait -- cargo test --no-run --locked'),
    unit('x', 'node tests/cargo-test.mts a -- cargo test --locked --test a'),
    unit('x', '"${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a'),
  ]), [build('node tests/run-long.mts b -- cargo build --locked'),
    'x runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.mts): "${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a']);
});

// The TypeScript reading case checks the repository's Makefile, a minimal Makefile, and a file.
caseTest('a target that runs code using the TypeScript build output holds it', COMPUTE, () => {
  const files = new Set(trackedFiles('*'));
  assert.deepEqual(typescriptReaderErrors(text('Makefile'), (path: string) => files.has(path) ? text(path) : undefined), []);
  // group-rows-db-typescript reads the build output, so its recipe starts by holding it (KSTD-10-2).
  const groupRowsLines = text('Makefile').split('\n');
  const groupRowsAt = groupRowsLines.indexOf('group-rows-db-typescript: typescript-build');
  assert.equal(groupRowsLines[groupRowsAt + 1], '\t$(READ_TYPESCRIPT)');
  const sources: Record<string, string> = {
    'scripts/reads.mjs': "const run = ['node', ['packages/ts/tests/db.mjs']];\n",
    'packages/ts/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n",
    'scripts/quoted.mjs': "const fixture = \"import { Db } from '../dist/index.js';\";\n",
  };
  const makefile = 'reader:\n\tnode scripts/reads.mjs\nheld:\n\t$(READ_TYPESCRIPT)\n\tnode scripts/reads.mjs\nquoted:\n\tnode --test scripts/quoted.mjs\n';
  assert.deepEqual(typescriptReaderErrors(makefile, (path: string) => sources[path]), [
    'Makefile reader runs scripts/reads.mjs, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)',
  ]);
});

// The name-only case (G5.40) does not count as reading a TypeScript test whose path is only written as a string (expected output of a fake node, stub,
// template, regular expression), but counts as reading a file that runs that path with node (a program and argument array, or the shell string of exec or spawn),
// and checks that a multi-line import also counts as reading.
caseTest('a test that only names a TypeScript test path does not read the build output', COMPUTE, () => {
  const sources: Record<string, string> = {
    'packages/ts/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n",
    'scripts/names.test.mjs': [
      "assert.deepEqual(ran, ['node packages/ts/tests/db.mjs']);",
      "assert.match(stderr, /node packages\\/ts\\/tests\\/db\\.mjs \\(exit 3\\)/);",
      "const stub = `#!/bin/sh\\necho \"node $*\" >> log # node packages/ts/tests/db.mjs`;",
      '',
    ].join('\n'),
    'scripts/array.mjs': "const run = ['node', ['packages/ts/tests/db.mjs']];\n",
    'scripts/exec-path.mjs': "spawnSync(process.execPath, ['packages/ts/tests/db.mjs', '--x']);\n",
    'scripts/shell.mjs': "execSync('node --conditions=orm-test packages/ts/tests/db.mjs');\n",
    // A multi-line import is a reading. An import example in a comment after a function body is not one.
    'packages/ts/tests/multi.mjs': "import {\n  Db,\n  OrmError as Failure,\n} from '../dist/index.js';\n",
    'scripts/multi.mjs': "const run = ['node', ['packages/ts/tests/multi.mjs']];\n",
    'scripts/comment.mjs': "export function f(a) {\n  // an import may span lines: `import {\\n  a,\\n} from '../dist/index.js'`\n}\n",
  };
  const makefile = 'names:\n\tnode --test scripts/names.test.mjs\narray:\n\tnode scripts/array.mjs\nexec-path:\n\tnode scripts/exec-path.mjs\nshell:\n\tnode scripts/shell.mjs\nmulti:\n\tnode scripts/multi.mjs\ncomment:\n\tnode scripts/comment.mjs\n';
  const reader = (target: string, file: string) => `Makefile ${target} runs ${file}, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)`;
  assert.deepEqual(typescriptReaderErrors(makefile, (path: string) => sources[path]), [
    reader('array', 'scripts/array.mjs'), reader('exec-path', 'scripts/exec-path.mjs'), reader('shell', 'scripts/shell.mjs'), reader('multi', 'scripts/multi.mjs'),
  ]);
});

// The go run case checks a minimal unit. The whole repository is checked by the repository check.
caseTest('a go run, whose build has no step log, fails', COMPUTE, () => {
  assert.deepEqual(goRunErrors([
    { name: 'raw', commands: ['go run ./tests/interfaces/check --self-test'], dialect: 'sh' },
    { name: 'env', commands: ['PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x'], dialect: 'sh' },
    { name: 'wrapped', commands: ['node tests/go-run.mts interfaces-check ./tests/interfaces/check --self-test'], dialect: 'sh' },
  ]), [
    'raw runs go run, whose build has no step log; run it through tests/go-run.mts: go run ./tests/interfaces/check --self-test',
    'env runs go run, whose build has no step log; run it through tests/go-run.mts: PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x',
  ]);
});

// The language case checks the repository's tracked files and a minimal list.
caseTest('every tool of the repository is written in Go, PHP, Rust or TypeScript', COMPUTE, () => {
  assert.deepEqual(toolingLanguageErrors(trackedFiles('*')), []);
  assert.deepEqual(toolingLanguageErrors(['scripts/stop-process.py', 'tests/stop-process/main.go', 'scripts/a.sh', 'tools/x.rb', 'packages/php/src/Db.php']), [
    'scripts/stop-process.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tools/x.rb is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
  // the Python exemption is exactly the five places of scripts/repo/scripts.mts; nothing else is exempt
  assert.deepEqual(toolingLanguageErrors(['packages/python/src/polyspec/orm/core.py', 'packages/python/testing/interfaces/python.py', 'tests/interfaces/test_schema_utils.py',
    'packages/python/testing/conformance/runner_python.py', 'packages/python/testing/dbspec/compare/python.py']), []);
  assert.deepEqual(toolingLanguageErrors(['tests/interfaces/helper.py', 'tests/conformance/vectors.py', 'tests/dbspec/compare/other.py',
    'scripts/python_tool.py', 'packages/orm-python-old/x.py']), [
    'tests/interfaces/helper.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tests/conformance/vectors.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tests/dbspec/compare/other.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'scripts/python_tool.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'packages/orm-python-old/x.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
});

// The startLogged case starts a fake server with startLogged from test-servers.mts. Starting a server is long-running work, so it has no deadline. It writes
// a ready line and keeps running: startLogged must return before the server ends, and the lines up to the ready line appear on stderr. Only 1.5 seconds
// later does it write the ready line. It also starts a slow but normal server, and a server that ends without a ready line fails with its log. The server runs
// outside the process group of the process that started it, in its own session (G5.62). Its output goes to a file of another node process.
caseTest('startLogged waits for a ready line or an exit, with no deadline', PROCESS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-logged-'));
  try {
    const module = new URL('../test-servers.mts', import.meta.url).pathname;
    const run = (server: string) => {
      const out = join(dir, 'stdout'), err = join(dir, 'stderr');
      const code = `const { startLogged, TestServerError } = await import(${JSON.stringify(module)});
try { await startLogged(${JSON.stringify(dir)}, 'fake', 'accepting connections', 'sh', ['-c', ${JSON.stringify(server)}]); console.log('returned'); }
catch (error) { if (!(error instanceof TestServerError)) throw error; console.error(error.message); process.exitCode = 1; }`;
      const status = spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', openSync(out, 'w'), openSync(err, 'w')], timeout: 20_000 }).status;
      return { status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
    };
    const pid = () => Number(readFileSync(join(dir, 'fake.pid'), 'utf8').trim());
    const alive = () => { try { process.kill(pid(), 0); return true; } catch { return false; } };
    const ready = run('echo starting; echo now accepting connections; echo serving; exec sleep 30');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout, 'returned\n');
    assert.equal(ready.stderr, 'test-servers: fake: starting\ntest-servers: fake: now accepting connections\n');
    assert.ok(alive(), 'startLogged returned only after the server ended');
    const groupOf = (id: number) => spawnSync('ps', ['-o', 'pgid=', '-p', String(id)], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(groupOf(pid()), groupOf(process.pid), 'the server runs in the process group of the command that started it');
    assert.match(readFileSync(join(dir, 'fake.log'), 'utf8'), /^starting\nnow accepting connections\n/);
    process.kill(pid());
    rmSync(join(dir, 'fake.log'));
    // The slow server creates a marker file just before the ready line. If that file exists when startLogged returns, startLogged waited for the ready line.
    const slow = run(`echo starting; sleep 1.5; echo still starting; sleep 1; touch ${dir}/ready-marker; echo now accepting connections; exec sleep 30`);
    assert.equal(slow.status, 0, slow.stderr);
    assert.equal(slow.stdout, 'returned\n');
    assert.equal(slow.stderr, 'test-servers: fake: starting\ntest-servers: fake: still starting\ntest-servers: fake: now accepting connections\n');
    assert.ok(existsSync(join(dir, 'ready-marker')), 'startLogged returned before the slow server logged its ready line');
    assert.ok(alive(), 'startLogged returned only after the slow server ended');
    process.kill(pid());
    rmSync(join(dir, 'fake.log'));
    const exited = run('echo starting; exit 3');
    assert.equal(exited.status, 1);
    assert.equal(exited.stderr, `test-servers: fake: starting\ntest-servers: fake exited before it logged 'accepting connections'; last lines of ${dir}/fake.log:\nstarting\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The timeout case checks that the repository's workflow and the minimal workflow have no timeout-minutes on their steps and jobs.
caseTest('no workflow step or job has timeout-minutes', COMPUTE, () => {
  assert.deepEqual(stepTimeoutErrors(workflows), []);
  const plain = [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-26.04-arm',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - name: install',
    '        run: npm ci',
    '      - name: checks',
    '        run: make orm-check',
    '',
  ].join('\n');
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain }), []);
  const step = (name: string) => `ci.yml step "${name}" has timeout-minutes; a long operation gets step logs and no deadline`;
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain
    .replace('      - uses: actions/checkout@v5', '      - uses: actions/checkout@v5\n        timeout-minutes: 10')
    .replace('        run: npm ci', '        timeout-minutes: 20\n        run: npm ci')
    .replace('        run: make orm-check', '        timeout-minutes: 90\n        run: make orm-check') }),
  [step('uses: actions/checkout@v5'), step('install'), step('checks')]);
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain.replace('    runs-on:', '    timeout-minutes: 360\n    runs-on:') }), [
    'ci.yml job test has timeout-minutes, a deadline for a whole job; a long operation gets step logs and no deadline',
  ]);
});

// The lease case checks that the repository's workflow does not run, outside make, a program that reads the lease variable, and that the minimal workflow's
// step rejects running such a program (Go checker, Node script, shell script) directly. It checks that make targets
// allow a program that does not read the lease.
caseTest('a workflow step runs a program that reads the lease variables only through make', COMPUTE, () => {
  const all = execFileSync('git', ['ls-files', '-z'], { cwd: repository }).toString().split('\0').filter(Boolean).filter(notVendored);
  const read = (path: string) => all.includes(path) ? text(path) : undefined;
  assert.deepEqual(ciLeaseErrors(workflows, all, read), []);
  const files: Record<string, string> = {
    'tests/leased/main.go': 'package main\nfunc main() { _ = os.Getenv("LEASE") }\n',
    'tests/leased/main_test.go': 'package main\n',
    'tests/plain/main.go': 'package main\nfunc main() {}\n',
    'scripts/leased.mjs': "const { LEASE: lease, CARGO_LEASES: leases } = process.env;\n",
    'scripts/leased.sh': '"${LEASE:?}" run "$CARGO_LEASES" exclusive -- true\n',
    'scripts/plain.mjs': 'console.log(1);\n',
  };
  const workflow = (run: string[]) => ['jobs:', '  test:', '    steps:', '      - name: contracts', '        run: |', ...run.map((line: string) => `          ${line}`), ''].join('\n');
  const errors = ciLeaseErrors({ 'ci.yml': workflow([
    'node tests/go-run.mts leased ./tests/leased --results out',
    'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/leased',
    'node scripts/leased.mjs && sh scripts/leased.sh',
    'node tests/go-run.mts plain ./tests/plain',
    'node scripts/plain.mjs',
    'make conformance-check',
  ]) }, Object.keys(files), (path: string) => files[path]);
  const error = (program: string, file: string) => `ci.yml step "contracts" runs ${program} outside make; ${file} reads LEASE, which make exports, so the step runs it through a make target`;
  assert.deepEqual(errors, [
    error('./tests/leased', 'tests/leased/main.go'),
    error('./tests/leased', 'tests/leased/main.go'),
    error('scripts/leased.mjs', 'scripts/leased.mjs'),
    error('scripts/leased.sh', 'scripts/leased.sh'),
  ]);
});

// The target case rejects an execution command that writes packages/rust/target/ directly.
caseTest('a run command names the Rust target directory through CARGO_TARGET_DIR', COMPUTE, () => {
  assert.deepEqual(targetPathErrors({
    Makefile: '# measured packages/rust/target 10 GiB\nexport CARGO_TARGET_DIR := $(abspath packages/rust/target)\nx:\n\t$(CARGO_TARGET_DIR)/debug/integration\n',
    'scripts/a.sh': '"${CARGO_TARGET_DIR:?}/debug/integration"\n',
  }), []);
  assert.deepEqual(targetPathErrors({
    Makefile: 'x:\n\tpackages/rust/target/debug/integration\n',
    'scripts/a.mjs': "resolve(root, 'packages/rust/target/debug/integration')\n",
    'tests/b/main.go': '\t\ttarget = filepath.Join(root, "packages", "rust", "target")\n',
  }), [
    'Makefile:2 names packages/rust/target instead of CARGO_TARGET_DIR',
    'scripts/a.mjs:1 names packages/rust/target instead of CARGO_TARGET_DIR',
    'tests/b/main.go:1 names packages/rust/target instead of CARGO_TARGET_DIR',
  ]);
  assert.deepEqual(targetPathErrors({ 'tests/x/main.go': '\t// cargo builds into packages/rust/target by default\n' }), []);
  assert.ok(runFile('contracts/features.json') && runFile('tests/dbspec/compare/runners.mts'));
  assert.ok(!runFile('examples/complex/rust/main.rs') && !runFile('packages/rust/README.md') && !runFile('scripts/repo/target.mts'));
});

// The manifest directory case rejects Rust source that reads the package directory with env! at compile time.
caseTest('Rust source reads the package directory when the program runs', COMPUTE, () => {
  assert.deepEqual(manifestDirErrors({
    'packages/rust/orm/tests/a.rs': 'let dir = polyspec_orm_testcase::manifest_dir();\n// env!("CARGO_MANIFEST_DIR") was the old form\n',
    'benchmarks/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\ninclude!(concat!(env!("OUT_DIR"), "/m.rs"));\n',
  }), []);
  assert.deepEqual(manifestDirErrors({
    'packages/rust/orm/tests/a.rs': 'use std::path::PathBuf;\nlet root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");\n',
    'packages/rust/orm/src/codec.rs': '        let root = concat!(env!( "CARGO_MANIFEST_DIR" ), "/../../../tests/codec");\n',
  }), [
    'packages/rust/orm/tests/a.rs:2 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
    'packages/rust/orm/src/codec.rs:1 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
  ]);
});

// The connection probe case rejects a statement that the client runtime asks the server for when it connects.
caseTest('a client connects without a probe statement', COMPUTE, () => {
  assert.deepEqual(connectProbeErrors({
    'packages/go/orm/db.go': '\tversion := sqliteVersion\n',
    'packages/ts/src/database.ts': "    try { (await pool.reserve()).release(false); } catch (error) { throw error; }\n",
    'packages/go/orm/cancel_test.go': '\tc.Raw("", "SELECT sqlite_version()", nil)\n',
    'packages/php/src/Dbspec/SqliteCatalog.php': "SELECT sqlite_version()\n",
  }), []);
  assert.deepEqual(connectProbeErrors({
    'packages/go/orm/db.go': '\tif err := s.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version); err != nil {\n',
    'packages/php/src/Orm.php': "                    $version = (string) $pdo->query('SELECT sqlite_version()')->fetchColumn();\n",
    'packages/ts/src/database.ts': "    try { await pool.execute('SELECT 1', [], undefined, unobserved); } catch (error) { throw error; }\n",
    'packages/rust/orm/src/db.rs': '                let version: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await?;\n',
  }), [
    'packages/go/orm/db.go:1 asks the server for the SQLite version; read the library version from the driver',
    'packages/php/src/Orm.php:1 asks the server for the SQLite version; read the library version from the driver',
    'packages/ts/src/database.ts:1 sends SELECT 1 to check the connection; open a connection without a statement',
    'packages/rust/orm/src/db.rs:1 asks the server for the SQLite version; read the library version from the driver',
  ]);
});

// The program path case rejects a Rust test that reads the path of a package program with env! at compile time.
caseTest('Rust tests read the paths of package programs when they run', COMPUTE, () => {
  assert.deepEqual(binExeErrors({
    'benchmarks/rust/tests/a.rs': 'let program = &polyspec_orm_testcase::program("native");\n// env!("CARGO_BIN_EXE_native") was the old form\n',
  }), []);
  assert.deepEqual(binExeErrors({ 'benchmarks/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\n' }), [
    'benchmarks/rust/tests/b.rs:1 reads the program path at compile time with CARGO_BIN_EXE; read it when the test runs with polyspec_orm_testcase::program',
  ]);
});

// The test declaration case checks the repository's JavaScript files and a minimal file.
const trackedFiles = (pattern: string) => execFileSync('git', ['ls-files', '-z', pattern], { cwd: repository }).toString().split('\0').filter(Boolean).filter(notVendored);

// scriptTexts is the command text of each script in scripts/ (scriptCommands): the lines of shell scripts and the COMMANDS of TypeScript command scripts.
// readScript reads the path that reachedScripts follows with it, and does not read a TypeScript file that is not a command script.
const scriptTexts = await scriptCommands(repository.pathname, trackedFiles('*'));
const trackedAll = new Set(trackedFiles('*'));
const readScript = (path: string) => scriptTexts.get(path) ?? (trackedAll.has(path) && !path.endsWith('.mts') ? text(path) : undefined);
const trackedTexts = (paths: string[]) => Object.fromEntries(paths.map((path: string) => [path, text(path)]));

caseTest('every JavaScript test declares its cases with caseTest', COMPUTE, () => {
  assert.deepEqual(nodeTestErrors(trackedTexts(trackedFiles('*.mjs').filter(path => !path.startsWith('docs/')))), []);
});

caseTest('a JavaScript test that declares tests with node:test directly fails', COMPUTE, () => {
  const message = (path: string) => `${path} declares tests with node:test directly; use caseTest of tests/testcase.mts, which gives each case its deadline and RUN, PASS or FAIL line`;
  assert.deepEqual(nodeTestErrors({
    'a.test.mjs': "import { test } from 'node:test';\n",
    'b.test.mjs': "import test from 'node:test';\n",
    'c.test.mjs': "import { after, it as check } from 'node:test';\n",
    'd.test.mjs': "import { after } from 'node:test';\nimport { caseTest } from '../testcase.mts';\n",
    'tests/testcase.mts': "import test from 'node:test';\n",
  }), [message('a.test.mjs'), message('b.test.mjs'), message('c.test.mjs')]);
});

// The calling environment case (G5.119) checks that a JavaScript test does not pass the environment of the process that ran it to a child process. The make -n orm-check run
// by the CI group's job stopped after receiving the job's GROUP.
caseTest('a JavaScript test gives its child processes only the variables of the case', COMPUTE, () => {
  assert.deepEqual(callerEnvironmentErrors(trackedTexts(trackedFiles('*.test.mjs'))), []);
  // The environment names in the fixture below are assembled so that this file itself does not fall under that rule.
  const caller = ['process', 'env'].join('.');
  const spawn = 'spawn' + 'Sync';
  const spread = (at: string) => `${at} gives a child process the environment of its caller; give it isolatedEnvironment of tests/environment.mts with the variables of the case`;
  const make = (at: string) => `${at} runs make with the environment of its caller, whose GROUP, GITHUB_ACTIONS and MAKEFLAGS reach the recipe; pass env: isolatedEnvironment(...) of tests/environment.mts with the variables of the case`;
  assert.deepEqual(callerEnvironmentErrors({
    'a.test.mjs': `${spawn}('make', ['-n', 'orm-check'], { cwd: repo, encoding: 'utf8', env: { ...${caller}, GITHUB_ACTIONS: '' } });\n`,
    'b.test.mjs': `const dry = ${spawn}('make', ['-n', 'orm-check'], { cwd: repo });\nrun('sh', [], { env: ${caller} });\n`,
    'c.test.mjs': `${spawn}('make', ['-n', 'orm-check'], { env: isolatedEnvironment({ GROUP: 'static' }) });\nrun('sh', [], { env: isolatedEnvironment({ PATH: ${caller}.PATH }) });\n`,
    'd.mjs': `${spawn}('make', ['orm-check'], { env: { ...${caller} } });\n`,
  }), [spread('a.test.mjs:1'), make('b.test.mjs:1'), spread('b.test.mjs:2')]);
});

caseTest('every Rust test starts its case with the shared testcase package', COMPUTE, () => {
  assert.deepEqual(rustTestCaseErrors(trackedTexts(trackedFiles('*.rs'))), []);
});

caseTest('a Rust test without a case of its own fails', COMPUTE, () => {
  const rust = [
    '#[tokio::test]',
    'async fn started() {',
    '    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);',
    '}',
    '#[test]',
    'fn bare() {',
    '    assert!(true);',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(rustTestCaseErrors({ 'packages/rust/orm/tests/a.rs': rust }), [
    'packages/rust/orm/tests/a.rs: bare does not start its case with polyspec_orm_testcase, so it runs without a deadline or RUN line',
  ]);
});

// The case report case checks the PHP and TypeScript tests the repository runs, and a minimal file.
caseTest('every PHP and TypeScript test that a check runs reports its cases', COMPUTE, () => {
  const commands = [
    ...recipeLines(text('Makefile')).filter(line => line.recipe).map(line => ({ source: 'Makefile', command: line.text })),
    ...featureCommands(readFeatures(repository.pathname)).map(command => ({ source: 'contracts/features.json', command })),
    ...[...scriptTexts].map(([path, script]) => ({ source: path, command: script })),
    ...Object.values(readPackage(join(repository.pathname, 'package.json')).scripts ?? {}).map(command => ({ source: 'package.json', command })),
  ];
  const files = new Set(trackedFiles('*'));
  assert.ok(commands.some(({ command }) => /vendor-php\/bin\/phpunit .*packages\/php\/tests\/DecimalModelDbTest\.php/.test(command)));
  assert.deepEqual(reportingScriptErrors(commands, path => files.has(path) ? text(path) : undefined), []);
});

caseTest('a PHP test outside PHPUnit or a TypeScript test without the shared case report fails', COMPUTE, () => {
  const files: Record<string, string> = {
    'packages/php/tests/BareTest.php': "<?php\nfinal class BareTest extends PHPUnit\\Framework\\TestCase {}\n",
    'packages/ts/tests/bare.mjs': "import { Db } from '../dist/index.js';\n",
    'packages/ts/tests/cased.mjs': "import { cases } from '../../../tests/testcase.mts';\n",
    'tests/testcase.mts': '',
  };
  const read = (path: string) => files[path];
  assert.deepEqual(testEntries('. "$DECIMAL_ENV" && node --conditions=orm-test packages/ts/tests/bare.mjs --dialect mysql'), ['packages/ts/tests/bare.mjs']);
  assert.deepEqual(reportingScriptErrors([
    { source: 'Makefile', command: 'php packages/php/tests/BareTest.php && php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/BareTest.php' },
    { source: 'contracts/features.json', command: 'node --test packages/ts/tests/bare.mjs packages/ts/tests/cased.mjs' },
    { source: 'scripts/x.sh', command: 'php packages/php/tests/missing.php' },
    { source: 'scripts/y.sh', command: 'php scripts/setup.php' },
  ], read), [
    'Makefile runs packages/php/tests/BareTest.php with php, not with PHPUnit (vendor-php/bin/phpunit with the phpunit.xml.dist of its package), so it runs without a deadline or a case report',
    'contracts/features.json runs packages/ts/tests/bare.mjs, which reports no case through tests/testcase.mts, so it runs without a deadline or RUN line',
    'scripts/x.sh runs packages/php/tests/missing.php, which is not a tracked file',
  ]);
});

// The tool case checks the repository's verification commands and a minimal command.
const featureUnits = () => {
  const manifest = readFeatures(repository.pathname);
  return [...manifest.features.flatMap(feature => feature.verification
    .filter(check => (check.cwd ?? '.') === '.').map(check => ({ name: `contracts/features.json ${feature.id}/${check.id}`, commands: [check.command], dialect: 'sh' as const }))),
  ...(manifest.helpers ?? []).map(helper => ({ name: `contracts/features.json helper ${helper.id}`, commands: [helper.command], dialect: 'sh' as const }))];
};

caseTest('every build tool of a verification command runs under run-long without a deadline', COMPUTE, () => {
  assert.deepEqual(unwrappedToolErrors(featureUnits()), []);
});

caseTest('a build tool outside run-long or under a deadline fails', COMPUTE, () => {
  assert.deepEqual(segments(`a && node tests/run-long.mts x -- sh -c 'go generate ./ && git diff' || (cd b; c | d)`, 'sh'),
    ['a', `node tests/run-long.mts x -- sh -c 'go generate ./ && git diff'`, 'cd b', 'c', 'd']);
  const unit = (name: string, command: string) => ({ name, commands: [command], dialect: 'sh' as const });
  const outside = (name: string, tool: string, segment: string) => `${name} runs ${tool} outside tests/run-long.mts, so it has no RUN line or step log: ${segment}`;
  const timed = (name: string, tool: string, form: string, segment: string) => `${name} runs ${tool} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unwrappedToolErrors([
    unit('tsc', 'node packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.json --noEmit'),
    unit('generate', 'go test ./packages/go/generator && cd packages/go/model && go generate ./'),
    unit('vet', 'go vet ./packages/go/internal/conformance'),
    unit('build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration && ./integration'),
    unit('npm', 'npm run typescript:build >/dev/null'),
    unit('later', 'node tests/run-long.mts a -- go vet ./a && go vet ./b'),
    unit('wrapped', 'node tests/run-long.mts go-generate --cwd packages/go/model -- sh -c \'go generate ./ && git diff --exit-code -- .\''),
    unit('make', '$(RUN_LONG) rust-build/x --cwd packages/rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked'),
    unit('tsc-build', '$(TSC_BUILD)'),
    unit('run-case', 'node tests/run-case.mjs typescript-types 5m -- node packages/ts/node_modules/typescript/bin/tsc --noEmit'),
    unit('make-case', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd packages/rust -- cargo build --locked'),
    unit('timeout', 'node tests/run-long.mts vet -- timeout 300 go vet ./...'),
  ]), [
    outside('tsc', 'tsc', 'node packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.json --noEmit'),
    outside('generate', 'go generate', 'go generate ./'),
    outside('vet', 'go vet', 'go vet ./packages/go/internal/conformance'),
    outside('build', 'cargo build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration'),
    outside('npm', 'a TypeScript build', 'npm run typescript:build >/dev/null'),
    outside('later', 'go vet', 'go vet ./b'),
    timed('run-case', 'tsc', 'run-case.mjs', 'node tests/run-case.mjs typescript-types 5m -- node packages/ts/node_modules/typescript/bin/tsc --noEmit'),
    timed('make-case', 'cargo build', '$(RUN_CASE)', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd packages/rust -- cargo build --locked'),
    timed('timeout', 'go vet', 'timeout 300', 'node tests/run-long.mts vet -- timeout 300 go vet ./...'),
  ]);
});

// The cargo test case checks the repository's Makefile, verification commands, scripts and a minimal unit.
const runUnits = () => {
  const recipes = makeRecipes(text('Makefile'));
  const packageUnits = Object.entries(readPackage(join(repository.pathname, 'package.json')).scripts ?? {}).map(([name, command]) => ({ name: `package.json ${name}`, commands: [command], dialect: 'sh' as const }));
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command, dialect: unit.dialect })));
  return { recipes, packageUnits, scripts: reachedScripts(commands, readScript) };
};

caseTest('every cargo test run goes through cargo-test.mts', COMPUTE, () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/client-db-test.mts'));
  assert.ok(!scripts.some(unit => unit.name === 'scripts/package-check.mts'), 'package-check.sh runs under run-long');
  assert.deepEqual(unbuiltCargoTestErrors([...recipes, ...featureUnits(), ...packageUnits, ...scripts]), []);
});

caseTest('a cargo test run outside cargo-test.mts, or a build under a deadline, fails', COMPUTE, () => {
  assert.deepEqual(makeRecipes('A = 1\nx: y\n\tcd a && cargo test\n\n# c\nz:\n\techo\n').map(unit => unit.name), ['Makefile x', 'Makefile z']);
  const message = (name: string, args: string) => `${name} runs cargo test ${args} outside tests/cargo-test.mts, so it runs the test binaries of the shared Rust target directory`;
  const timed = (name: string, args: string, form: string, segment: string) => `${name} runs the build cargo test --no-run ${args} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unbuiltCargoTestErrors([
    { name: 'bare', commands: ['$(WITH_TEST_ENV) cd packages/rust && cargo +$(T) test --locked --test a -- --nocapture'], dialect: 'make' },
    { name: 'built', commands: ['$(RUN_LONG) b --cwd packages/rust -- $(CARGO_LEASED) cargo +$(T) test --no-run --locked --test a', 'cd packages/rust && cargo +$(T) test --locked --test a'], dialect: 'make' },
    { name: 'copied', commands: ['cd packages/rust && $(CARGO_TEST) c -- cargo +$(T) test --locked --test a -- --nocapture', 'node tests/cargo-test.mts d -- cargo test --locked --lib'], dialect: 'make' },
    { name: 'timed', commands: ['node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a'], dialect: 'sh' },
  ]), [message('bare', '--locked --test a'), message('built', '--locked --test a'),
    timed('timed', '--locked --test a', 'run-case.mjs', 'node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a')]);
});

caseTest('every build tool of the Makefile, package.json and the scripts runs under run-long', COMPUTE, () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/typescript/sqlite-test.mts'));
  assert.deepEqual(unwrappedToolErrors([...recipes, ...packageUnits.filter(unit => segments(unit.commands[0] ?? '', 'sh').length > 1), ...scripts]), []);
});

// The rerun case checks the repository's workflow and the minimal workflow by the runner's identity.
caseTest('the CI workflow runs no test runner outside make orm-check', COMPUTE, () => {
  assert.deepEqual(ciRerunErrors(workflow, text('Makefile')), []);
});

caseTest('a workflow that runs a test runner after make orm-check fails by identity', COMPUTE, () => {
  assert.equal(runnerIdentity('PATH="$HOME/.cargo/bin:$PATH" cargo +1.98.1 test --locked -p polyspec-orm codec'), 'cargo test');
  assert.equal(runnerIdentity("go test -v -timeout 0 ./packages/go/engine/ir -run '^$' -fuzz FuzzDecodeRequest -fuzztime=1s"), undefined);
  assert.equal(runnerIdentity('go run ./tests/interfaces/check --results tests/conformance/out'), undefined);
  assert.equal(runnerIdentity('node tests/go-test.mts -v -timeout 0 ./packages/go/engine -count=1'), 'go test');
  assert.equal(runnerIdentity('node tests/conformance/check/main.mts record --driver mysql out/go.json'), undefined);
  assert.equal(runnerIdentity('node --test tests/conformance/check/main.test.mts'), 'node test');
  assert.equal(runnerIdentity('php -d extension=x.so vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecTest.php'), 'phpunit vendor-php/bin/phpunit');
  assert.equal(runnerIdentity("node tests/run-long.mts fuzz/ir -- go test -v ./packages/go/engine/ir -run '^$' -fuzz FuzzDecodeRequest"), undefined);
  assert.equal(runnerIdentity('node tests/run-long.mts rust-build/x -- cargo test --no-run --locked'), 'cargo test');
  const make = [
    'CHECK_TARGETS = repo-check',
    'GO_TEST = go test -v -timeout 0',
    'fuzz-check:',
    "\t$(GO_TEST) ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s",
    'vet-again:',
    '\t$(GO_TEST) ./packages/go/orm -run TestCodec',
    '',
  ].join('\n');
  const again = steps.replace('make repo-check', [
    'make orm-check',
    '          make fuzz-check vet-again',
    '          go vet ./... && go test -v -timeout 0 ./...',
    '          (cd packages/rust && cargo test --locked -p polyspec-orm codec)',
    '          php packages/php/tests/CodecVectorsTest.php',
    '          node --test scripts/x.test.mjs',
    '          go run ./tests/interfaces/check --results tests/conformance/out',
  ].join('\n'));
  const message = (identity: string, via = '') => `ci.yml step "checks" runs ${identity}${via} outside make orm-check; make orm-check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`;
  assert.deepEqual(ciRerunErrors(again, make), [
    message('go test', ' through make vet-again'),
    message('go vet'),
    message('go test'),
    message('cargo test'),
    message('php packages/php/tests/CodecVectorsTest.php'),
    message('node test'),
    message('go test'),
  ]);
  assert.deepEqual(ciRerunErrors(steps.replace('make repo-check', 'make repo-check\n          go test ./...'), make), []);
});

// The generation case checks the recipe and verification commands of make orm-check, and a minimal unit.
caseTest('make orm-check runs each go generate once', COMPUTE, () => {
  const targets = new Set(checkTargets(text('Makefile')));
  const { recipes } = runUnits();
  assert.deepEqual(repeatedGenerateErrors([...recipes.filter(unit => targets.has(unit.name.replace(/^Makefile /, ''))), ...featureUnits()]), []);
});

caseTest('a go generate that make orm-check runs twice fails', COMPUTE, () => {
  assert.deepEqual(generateRuns(`$(RUN_LONG) go-model -- sh -c 'cd packages/go/model && go generate ./ && git diff --exit-code -- .'`, 'make'), ['packages/go/model']);
  assert.deepEqual(generateRuns(`go test ./packages/go/generator && node tests/run-long.mts g --cwd packages/go/model -- sh -c 'go generate ./ && git diff'`, 'sh'), ['packages/go/model']);
  assert.deepEqual(generateRuns('cd packages/go/other && go generate ./', 'sh'), ['packages/go/other']);
  assert.deepEqual(repeatedGenerateErrors([
    { name: 'Makefile go-model-check', commands: [`$(RUN_LONG) go-model -- sh -c 'cd packages/go/model && go generate ./ && git diff --exit-code -- .'`], dialect: 'make' },
    { name: 'contracts/features.json model_generation/generation-go', commands: [`node tests/run-long.mts g --cwd packages/go/model -- sh -c 'go generate ./ && git diff'`], dialect: 'sh' },
    { name: 'other', commands: ['cd packages/go/other && go generate ./'], dialect: 'sh' },
  ]), ['go generate of packages/go/model runs 2 times in make orm-check: Makefile go-model-check, contracts/features.json model_generation/generation-go']);
});

// The go test case checks the repository's Makefile (with variables resolved), verification commands, scripts and a minimal unit.
caseTest('every go test runs through go-test.mts or run-long', COMPUTE, () => {
  const makefile = text('Makefile');
  // group-rows-db-go runs its go test through go-test.mts, with its own run line and no deadline (KSTD-10-3).
  const groupRowsGo = makefile.split('\n').indexOf('group-rows-db-go:');
  assert.ok(makefile.split('\n')[groupRowsGo + 1]?.startsWith('\t$(GO_TEST) ./packages/go/model'), 'group-rows-db-go runs go test through GO_TEST');
  const variables = makeVariables(makefile);
  const { recipes, scripts } = runUnits();
  const expanded = recipes.map(unit => ({ ...unit, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(rawGoTestErrors([...expanded, ...featureUnits(), ...scripts]), []);
});

caseTest('a go test without its build step, or under a deadline, fails', COMPUTE, () => {
  const message = (name: string, segment: string) => `${name} runs go test outside tests/go-test.mts, so its compile has no RUN line or step log: ${segment}`;
  const fuzz = "$(RUN_CASE) fuzz/ir 8m -- go test -v -timeout 0 ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s";
  assert.deepEqual(rawGoTestErrors([
    { name: 'raw', commands: ['go test -v -timeout 0 ./packages/go/orm -run X -count=1'], dialect: 'sh' },
    { name: 'env', commands: ['ORM_RUN_PERF_GATE=1 go test -v ./packages/go/bench'], dialect: 'sh' },
    { name: 'wrapped', commands: ['node tests/go-test.mts -v -timeout 0 ./packages/go/engine -count=1'], dialect: 'sh' },
    { name: 'fuzz', commands: ["$(RUN_LONG) fuzz/ir -- go test -v -timeout 0 ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s"], dialect: 'make' },
    { name: 'build', commands: ['node tests/run-long.mts go-build -- go test -c -o x ./packages/go/engine/dbspec'], dialect: 'sh' },
    { name: 'timed', commands: [fuzz], dialect: 'sh' },
  ]), [message('raw', 'go test -v -timeout 0 ./packages/go/orm -run X -count=1'), message('env', 'ORM_RUN_PERF_GATE=1 go test -v ./packages/go/bench'),
    `timed runs go test under a deadline ($(RUN_CASE)); a long operation gets step logs and no deadline: ${fuzz}`]);
});

// The deadline case checks the repository's Makefile (with variables resolved), verification commands, package.json scripts, and every script,
// including those under run-long, and a minimal unit.
caseTest('no check puts a deadline on a long operation', COMPUTE, () => {
  const makefile = text('Makefile');
  const variables = makeVariables(makefile);
  const { recipes, packageUnits } = runUnits();
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command, dialect: unit.dialect })));
  const scripts = reachedScripts(commands, readScript, { throughLong: true });
  assert.ok(scripts.some(unit => unit.name === 'scripts/package-check.mts'), 'the scripts under run-long are checked');
  const expanded = recipes.map(unit => ({ ...unit, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(longDeadlineErrors([...expanded, ...featureUnits(), ...packageUnits, ...scripts]), []);
});

caseTest('a deadline on a long operation fails', COMPUTE, () => {
  const message = (name: string, form: string, segment: string) => `${name} puts a deadline (${form}) on a long operation; it gets step logs and no deadline, and only a test case has its own: ${segment}`;
  const units = {
    'run-case': 'node tests/run-case.mjs package 8m -- node scripts/package-check.mts',
    make: '$(RUN_CASE) go-fmt $(TOOL_DEADLINE) -- gofmt -l .',
    variable: 'node tests/run-long.mts x -- sh -c "sleep $(BUILD_DEADLINE)"',
    timeout: 'timeout 600 cargo build --locked',
    'go-default': 'go test ./...',
    'go-timeout': 'node tests/go-test.mts -v -timeout 10m ./packages/go/engine',
    'go-none': 'go test -timeout 0 ./...',
    'go-build': 'go test -c -o x ./packages/go/engine/dbspec',
    'go-runner': 'node tests/go-test.mts -v -timeout 0 ./packages/go/engine -count=1',
    long: 'node tests/run-long.mts rust-build/x -- cargo test --no-run --locked',
  };
  assert.deepEqual(longDeadlineErrors(Object.entries(units).map(([name, command]) => ({ name, commands: [command], dialect: 'make' as const }))), [
    message('run-case', 'run-case.mjs', units['run-case']),
    message('make', '$(RUN_CASE)', units.make),
    message('variable', '$(BUILD_DEADLINE)', units.variable),
    message('timeout', 'timeout 600', units.timeout),
    message('go-default', 'go test without -timeout 0 (the default 10m)', units['go-default']),
    message('go-timeout', 'go test -timeout 10m', units['go-timeout']),
  ]);
});

// The full suite rule case (G5.38-5) checks that AGENTS.md and AGENTS.ko.md state the rule that the full suite runs in CI after push, and do not state the earlier
// local rule.
caseTest('AGENTS states that the full suite runs on CI after a push', COMPUTE, () => {
  const read = (path: string) => readFileSync(new URL(path, repository), 'utf8');
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': read('AGENTS.md'), 'AGENTS.ko.md': read('AGENTS.ko.md') }), []);
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': 'The full suite (`make orm-check`) runs exactly once, when every active checklist\n  item is complete.', 'AGENTS.ko.md': '' }).slice(0, 2), [
    'AGENTS.md does not state the full-suite rule: "runs on GitHub CI after a push"',
    'AGENTS.md does not state the full-suite rule: "collect enough information to fix every failure it found before the next CI run"',
  ]);
  assert.ok(fullSuiteRuleErrors({ 'AGENTS.md': 'runs exactly once, when every active checklist\n  item is complete', 'AGENTS.ko.md': '' })
    .includes('AGENTS.md still states the local full-suite rule: "runs exactly once, when every active checklist   item is complete"'));
});

// The CI setup case (G5.52) checks that, when a setup step in the workflow fails, the steps after it and make orm-check still run and pass the failure on to the runner.
// A setup step without an id, as in main's workflow, a step with no condition, continue-on-error, and a make orm-check without ORM_CI_SETUP are errors.
caseTest('a workflow runs every setup step and make orm-check after a failed setup step and passes the results on', COMPUTE, () => {
  const setup = { go: 'go', rust: 'rust' };
  const runner = ['checkout'];
  const workflow = (steps: string, check: string) => `jobs:\n  test:\n    steps:\n${steps}${check}`;
  const good = workflow(`      - uses: actions/checkout@v5\n        id: checkout\n      - uses: actions/setup-go@v6\n        id: go\n        if: \${{ !cancelled() }}\n      - name: rust\n        id: rust\n        if: \${{ !cancelled() }}\n        run: rustup toolchain install\n`,
    `      - name: make orm-check\n        if: \${{ !cancelled() }}\n        env:\n          ORM_CI_SETUP: \${{ toJSON(steps) }}\n        run: make orm-check\n`);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good }, { setup, runner }), []);
  const bad = workflow(`      - uses: actions/checkout@v5\n        id: checkout\n      - uses: actions/setup-go@v6\n        with: { go-version: "1.27" }\n      - name: rust\n        id: rustup\n        continue-on-error: true\n        if: \${{ !cancelled() }}\n        run: rustup toolchain install\n`,
    `      - name: make orm-check\n        run: make orm-check\n`);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': bad }, { setup, runner }), [
    'ci.yml uses continue-on-error, which hides a failed step from the job; run later steps with if: ${{ !cancelled() }} instead',
    'ci.yml step "uses: actions/setup-go@v6" before make orm-check has no id; give it the id of what it installs in scripts/check/ci-setup.mts',
    'ci.yml step "uses: actions/setup-go@v6" does not run after a failed earlier setup step; give it if: ${{ !cancelled() }}',
    'ci.yml step "rust" has the id rustup, which scripts/check/ci-setup.mts does not map to what it installs',
    'ci.yml has no setup step with the id go of scripts/check/ci-setup.mts',
    'ci.yml has no setup step with the id rust of scripts/check/ci-setup.mts',
    'ci.yml step "make orm-check" does not run after a failed setup step; give it if: ${{ !cancelled() }}',
    'ci.yml step "make orm-check" gives make orm-check no ORM_CI_SETUP: ${{ toJSON(steps) }}, which tells the runner the failed setup steps',
  ]);
  // Each job has its own runner, so the docs job after the make orm-check job is not a setup or a later step of make orm-check (G5.98).
  const docs = `  docs:\n    steps:\n      - uses: actions/checkout@v5\n        id: checkout\n      - id: node-modules\n        if: \${{ !cancelled() }}\n        run: make install-node\n      - name: documentation checks\n        id: docs\n        if: \${{ !cancelled() }}\n        run: make docs-ci\n`;
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good + docs }, { setup, runner }), []);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good + docs.replace('        if: ${{ !cancelled() }}\n        run: make install-node', '        run: make install-node') }, { setup, runner }),
    ['ci.yml step "id: node-modules" does not run after a failed earlier step; give it if: ${{ !cancelled() ... }}']);
  const pages = `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n      - name: build\n        if: \${{ !cancelled() && steps.x.outcome == 'success' }}\n        run: make docs-build\n`;
  assert.deepEqual(ciSetupErrors({ 'pages.yml': pages }, { setup, runner }), ['pages.yml step "run: npm ci" does not run after a failed earlier step; give it if: ${{ !cancelled() ... }}']);
  const root = new URL('../..', import.meta.url).pathname;
  const workflows = Object.fromEntries(['ci.yml', 'docs-pages.yml'].map(name => [name, readFileSync(join(root, '.github/workflows', name), 'utf8')]));
  assert.deepEqual(ciSetupErrors(workflows, { setup: CI_SETUP, runner: RUNNER_STEPS }), []);
});

// The independent test case (G5.53) treats as an error a recipe with two or more separate test or lint runs, or a verification command that chains tests with `&&`.
// A second run of the same test, a line that only compiles, a line that creates input, and a build of a dependency tool are not tests.
caseTest('a recipe or a command that runs independent tests in sequence is refused', COMPUTE, () => {
  const makefile = [
    'GO_TEST = node tests/go-test.mts -v -timeout 0',
    'two:', "\t$(GO_TEST) ./a -count=1", '\tphp packages/php/tests/b_test.php',
    'again:', '\tphp packages/php/tests/b_test.php', '\tphp packages/php/tests/b_test.php',
    'built:', '\tnode tests/dbspec/stress.mts > out.dbs', '\tgo test -c -o x ./packages/go/engine', '\tnode packages/ts/node_modules/typescript/bin/tsc -p x', '\tnode --test tests/x.test.mjs',
    'linted:', '\tcargo +$(shell sed -n \'s/x/\\1/p\' f) clippy -p polyspec-orm -- -D warnings', '\tnode $(abspath tests/cargo-test.mts) y -- cargo test -p polyspec-orm',
    'parts: parts/a parts/b', 'parts/a:', "\t$(GO_TEST) ./a -count=1", 'parts/b:', '\tphp packages/php/tests/b_test.php',
  ].join('\n');
  assert.deepEqual(independentTestErrors(makefile).map(error => error.split(' runs ')[0]), ['Makefile two', 'Makefile linted']);
  assert.deepEqual(chainedCommandErrors({ features: [{ id: 'f', verification: [{ id: 'chained', command: 'node packages/ts/tests/a.mjs && node packages/ts/tests/b.mjs' }, { id: 'built', command: 'npm run typescript:build && node packages/ts/tests/a.mjs' }] }], helpers: [] }).map(error => error.split(' chains ')[0]),
    ['contracts/features.json f/chained']);
  const root = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(independentTestErrors(readFileSync(join(root, 'Makefile'), 'utf8')), []);
  assert.deepEqual(chainedCommandErrors(readFeatures(root)), []);
  // The planner target runs no test in its own recipe: its suites are parts that make -j runs together (KSTD-5-23).
  const makefileLines = readFileSync(join(root, 'Makefile'), 'utf8').split('\n');
  const plannerAt = makefileLines.findIndex(line => line.startsWith('dbspec-php-extension-check/planner:'));
  const plannerRecipe: string[] = [];
  for (let index = plannerAt + 1; index < makefileLines.length && makefileLines[index]?.startsWith('\t'); index++) plannerRecipe.push(makefileLines[index] ?? '');
  assert.deepEqual(plannerRecipe, []);
});


caseTest('a script that starts a process group of its own checks that group after it ends', COMPUTE, () => {
  assert.deepEqual(detachedGroupErrors({
    'a.mjs': "const child = spawn('go', ['test'], { detached: true });",
    'b.mjs': "const child = spawn('go', ['test'], { detached: true });\nchild.on('exit', () => endGroup(child.pid));",
    'c.mjs': "const child = spawn('go', ['test']);",
  }), ['a.mjs starts a process in a group of its own (detached: true) and never checks that group after it ends; check it with endGroup of scripts/check/step.mts and fail on what it left']);
  const root = new URL('../..', import.meta.url).pathname;
  const tracked = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: root }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(detachedGroupErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(join(root, path), 'utf8')]))), []);
});

caseTest('every CI step runs a make target', COMPUTE, () => {
  const workflow = (summary: string, extra = '') => `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v5\n      - name: install\n        run: make install-node\n${extra}      - name: summary\n        run: ${summary}\n`;
  assert.deepEqual(ciMakeErrors({ '.github/workflows/ci.yml': workflow('node scripts/check/summary.mts') }), []);
  assert.deepEqual(ciMakeErrors({ '.github/workflows/ci.yml': workflow('node scripts/check/summary.mts', '      - name: deps\n        run: |\n          npm ci\n          make orm-install-php\n') }), [
    '.github/workflows/ci.yml step "deps" runs npm ci; run it through a make target',
  ]);
  assert.deepEqual(ciMakeErrors({ '.github/workflows/docs-pages.yml': workflow('node scripts/check/summary.mts') }), [
    '.github/workflows/docs-pages.yml step "summary" runs node scripts/check/summary.mts; run it through a make target',
  ]);
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  // orm's own workflows; the copies of @polyspec/kit are kit's and kit-check holds them byte for byte (KSTD-5-24).
  assert.deepEqual(ciMakeErrors(ownWorkflows(Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [`.github/workflows/${name}`, readFileSync(join(directory, name), 'utf8')])), copies)), []);
});

caseTest('a test does not fail on a measured time above a bound', COMPUTE, () => {
  assert.deepEqual(timeFailureErrors({
    'b.rs': '    assert!(cpu < Duration::from_secs(1), "cpu {cpu:?}");\n',
    'c.test.mjs': "    assert.ok(parseMs <= PARSE_BUDGET_MS, 'slow');\n",
    'd.php': "if ($cpuMs > 10000) {\n    throw new RuntimeException('slow');\n}\n",
  }).map(error => error.split(' fails ')[0]), ['b.rs:1', 'c.test.mjs:1', 'd.php:1']);
  // Warnings, lower bounds, comparisons of two measurements, and comparisons with 0 are not failures or are correctness checks.
  assert.deepEqual(timeFailureErrors({
    'f.rs': '    assert!(waited >= Duration::from_millis(200), "too early");\n    assert!(cpu * 4 < wall, "clock");\n',
    'g.test.mjs': "    check(event.elapsed >= 0, 'negative');\n",
  }), []);
  // Go source is read by the analyzer timefailure of tests/analyzers, never by this text rule.
  assert.throws(() => timeFailureErrors({ 'a_test.go': 'package a\n' }), /timeFailureErrors reads no Go source \(a_test\.go\); go vet runs the analyzer timefailure of tests\/analyzers over it/);
});

// The trigger case (G5.98) checks that the `on:` blocks of ci.yml, push-gate.yml and docs-pages.yml match their declarations, and that other workflows do not run on push,
// pull_request or merge_group.
caseTest('every workflow runs on its declared events only', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  const actual = Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [`.github/workflows/${name}`, readFileSync(join(directory, name), 'utf8')]));
  assert.deepEqual(workflowTriggerErrors(ownWorkflows(actual, copies)), []);
  const text = (on: string[]) => `name: x\n${on.join('\n')}\n\njobs:\n  a:\n    runs-on: ubuntu\n`;
  const declared = Object.fromEntries(Object.entries(WORKFLOW_TRIGGERS).map(([path, on]) => [path, text([stringify({ on })])]));
  assert.deepEqual(workflowTriggerErrors(declared), []);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/ci.yml': text(['on:', '  pull_request:', '  push:', '    branches: [main]', '  workflow_dispatch:']) }), [
    '.github/workflows/ci.yml has the triggers {"pull_request":null,"push":{"branches":["main"]},"workflow_dispatch":null} instead of {"push":{"branches":["main"]},"workflow_dispatch":null}',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/docs-pages.yml': text(['on:', '  push:', '    branches: [main]', '  pull_request:', '  workflow_dispatch:']) }), [
    '.github/workflows/docs-pages.yml has the triggers {"push":{"branches":["main"]},"pull_request":null,"workflow_dispatch":null} instead of {"push":{"branches":["main"]},"workflow_dispatch":null}',
  ]);
  const { ['.github/workflows/push-gate.yml']: _, ...withoutGate } = declared;
  assert.deepEqual(workflowTriggerErrors({ ...withoutGate, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  pull_request:']) }), [
    '.github/workflows/push-gate.yml is missing; it runs on {"push":{"branches":["**"]}}',
    '.github/workflows/review.yml runs on pull_request; only ci.yml, push-gate.yml and docs-pages.yml run on these events',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  workflow_dispatch:']) }), []);
  // release.yml is kit's copy, so the table holds no entry for it: a run on push of a copy is not judged here (KSTD-5-25).
  assert.equal(Object.hasOwn(WORKFLOW_TRIGGERS, '.github/workflows/release.yml'), false);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/release.yml': text(['on:', '  push:', '    branches: [main]']) }), [
    '.github/workflows/release.yml runs on push; only ci.yml, push-gate.yml and docs-pages.yml run on these events',
  ]);
});

caseTest('every workflow that runs on push cancels the run of the push before it', COMPUTE, () => {
  const concurrency = 'concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n';
  const workflow = (on: string, extra = '') => `name: x\non:\n${on}\n${extra}jobs:\n  a:\n    runs-on: ubuntu\n`;
  assert.deepEqual(concurrencyErrors({ 'a.yml': workflow('  push:\n    branches: [main]', concurrency) }), []);
  assert.deepEqual(concurrencyErrors({ 'b.yml': workflow('  workflow_dispatch:') }), []);
  assert.deepEqual(concurrencyErrors({ 'c.yml': workflow('  push:', 'concurrency:\n  group: c-${{ github.ref }}\n  cancel-in-progress: false\n') }).map(error => error.split(' ')[0]), ['c.yml']);
  assert.deepEqual(concurrencyErrors({ 'd.yml': workflow('  push:') }).map(error => error.split(' ')[0]), ['d.yml']);
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  assert.deepEqual(concurrencyErrors(ownWorkflows(Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [name, readFileSync(join(directory, name), 'utf8')])), vendoredFiles)), []);
});

// mise.toml declares the one Go release (kit K127): kit's toolchain-check requires it to be the kit pin and the running go
// to be that release, and every workflow that runs Go installs it with make install-tools, never with actions/setup-go.
const goWorkflow = 'jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make install-tools\n      - run: make orm-check\n';
caseTest('every workflow runs the Go of mise.toml', COMPUTE, () => {
  assert.deepEqual(goVersionErrors({ 'ci.yml': goWorkflow }), []);
  assert.deepEqual(goVersionErrors({ 'ci.yml': goWorkflow.replace('      - run: make install-tools\n', '      - uses: actions/setup-go@v6\n        with: { go-version-file: go.mod }\n') }), [
    'ci.yml sets up Go with actions/setup-go; the Go of mise.toml is installed by make install-tools',
    'ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools',
  ]);
  assert.deepEqual(goVersionErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make orm-check\n' }), [
    'ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools',
  ]);
});

// The Go module path case (G5.113-5) checks that every go.mod in the repository declares the module path of its own directory, and rejects, in a minimal file, a root or subdirectory go.mod that declares another
// path.
caseTest('every go.mod declares the module path of its directory', COMPUTE, () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: repository }).toString().split('\0').filter(path => /(?:^|\/)go\.mod$/.test(path) && notVendored(path));
  assert.ok(paths.includes('packages/go/go.mod') && paths.includes('tests/go.mod') && paths.includes('examples/go.mod'), paths.join(' '));
  assert.deepEqual(goModulePathErrors(Object.fromEntries(paths.map(path => [path, text(path)]))), []);
  assert.deepEqual(goModulePathErrors({ 'go.mod': 'module github.com/polyspec/orm\n', 'tools/gen/go.mod': 'module github.com/polyspec/orm/tools/gen\n', 'README.md': '' }), []);
  assert.deepEqual(goModulePathErrors({ 'go.mod': 'module github.com/polyspec/orm/v2\n', 'packages/go/go.mod': 'module github.com/polyspec/orm\n', 'x/go.mod': 'go 1.27\n' }), [
    'go.mod declares the module github.com/polyspec/orm/v2; declare github.com/polyspec/orm, the path of its directory, so go get resolves it and its tags',
    'packages/go/go.mod declares the module github.com/polyspec/orm; declare github.com/polyspec/orm/packages/go, the path of its directory, so go get resolves it and its tags',
    'x/go.mod declares the module (none); declare github.com/polyspec/orm/x, the path of its directory, so go get resolves it and its tags',
  ]);
});

const MISE = '[tools]\n"http:composer" = { version = "2.10.3", url = "https://getcomposer.org/download/{{ version }}/composer.phar", bin = "composer" }\n';
caseTest('every setup-php step installs the Composer of mise.toml', COMPUTE, () => {
  const php = 'jobs:\n  test:\n    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php }, '2.10.3'), []);
  assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php.replace('          tools: composer:2.10.3\n', '') }, '2.11.0'), [
    'ci.yml sets up PHP without tools: composer:2.10.3; setup-php installs the newest Composer otherwise, so add tools: composer:2.10.3',
    'Composer 2.11.0 runs the checks; mise.toml declares 2.10.3, so its major and minor must be 2.10; run make install-tools, which installs the Composer of mise.toml, or change mise.toml together with the CI evidence of the new release',
  ]);
  assert.deepEqual(composerVersionErrors('[tools]\n', { 'ci.yml': php }, '2.10.3'), [
    'mise.toml must declare the tool http:composer with one exact Composer release x.y.z as its version, found ""; write the release that CI and the local checks run',
  ]);
});

// T70: a running Composer is accepted regardless of patch if its major and minor match the declared release.
caseTest('a running Composer with the declared major and minor passes whatever its patch', COMPUTE, () => {
  const php = 'jobs:\n  test:\n    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  for (const running of ['2.10.3', '2.10.0', '2.10.9'])
    assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php }, running), [], running);
  for (const running of ['2.9.9', '2.11.0'])
    assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php }, running), [
      `Composer ${running} runs the checks; mise.toml declares 2.10.3, so its major and minor must be 2.10; run make install-tools, which installs the Composer of mise.toml, or change mise.toml together with the CI evidence of the new release`,
    ], running);
});

caseTest('a Makefile build output is published through a temporary file', COMPUTE, () => {
  const makefile = [
    'LEASE_BUILD = go build -o $(LEASE) ./tests/lease',
    'PUBLISHED = $(PUBLISH) $(LEASE) go build -o @OUT@ ./tests/lease',
    'doc:',
    '\tnode tests/dbspec/stress.mts > $(DOC)',
    '\t$(PUBLISH) $(DOC) node tests/dbspec/stress.mts',
    '\ttest -f x || { echo "x is missing" >&2; exit 1; }',
    '\t@test -n "$(W)" || { echo "usage: make x W=<path>" >&2; exit 2; }',
    '\tsh -c "node x.mts > out.txt"',
    '\tnode packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.build.json',
    '\tnode packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.json --noEmit',
    '# go build -o $(LEASE) in a comment',
  ].join('\n');
  assert.deepEqual(unpublishedOutputErrors(makefile).map(error => error.split(', so ')[0]), [
    'Makefile:1 writes a Go build output in place',
    'Makefile:4 redirects a command into a file in place',
    'Makefile:8 redirects a command into a file in place',
    'Makefile:9 runs tsc into dist in place',
  ]);
  assert.deepEqual(unpublishedOutputErrors(readFileSync(new URL('../../Makefile', import.meta.url), 'utf8')), []);
});

caseTest('a failure message for a missing condition names its fix', COMPUTE, () => {
  // The fixture's text is built by concatenation: this file is also a check target.
  const required = ['is', 'required'].join(' ');
  const files: Record<string, string> = {
    'tests/a.mjs': `if (!dsn) throw new Error('ORM_TEST_MYSQL_DSN ${required}; database tests never skip');\n// ORM_TEST_MYSQL_DSN ${required} in a comment\n`,
    'tests/b_test.go': `\tt.Fatal("ORM_TEST_MYSQL_DSN ${required}; run the test through its make target, which reads the environment of make orm-test-servers")\n`,
    'scripts/c.sh': `: "\${BENCH_DSN:?BENCH_DSN ${required}}"\ncommand -v x >/dev/null || { echo "x ${['is', 'not', 'installed'].join(' ')}; run make orm-install-server-programs" >&2; exit 1; }\n`,
  };
  assert.deepEqual(fixlessMessageErrors(files).map(error => error.split(': a failure')[0]), ['tests/a.mjs:1', 'scripts/c.sh:1']);
});

caseTest('no Makefile or script fixes a TCP port of the test servers', COMPUTE, () => {
  const makefile = ['TEST_MYSQL_PORT = 33171', '# TEST_POSTGRES_PORT = 55471', 'orm-test-servers:', '\tnode scripts/test-servers.mts start $(TEST_MYSQL_PORT)', '\tnode scripts/test-servers.mts start'].join('\n');
  assert.deepEqual(fixedPortErrors({ Makefile: makefile, 'scripts/a.sh': 'export PGPORT=5432\nport=$(node scripts/free-ports.mts 1)\n' }).map(error => error.split(' fixes ')[0]), [
    'Makefile:1', 'Makefile:4', 'scripts/a.sh:1',
  ]);
  const tracked = execFileSync('git', ['ls-files', 'Makefile', '*.sh'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(fixedPortErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});

// The shell reader case (T137-1-4-2) checks that commands are read by the shell parser (unbash): an escaped quote outside quotes, comments, make's
// joined lines and references, workflow expressions, `&&` lists, and commands that the parser rejects.
caseTest('the checks read commands with the shell parser', COMPUTE, () => {
  // An escaped quote opens no string, so the command after the `;` is a command of its own.
  assert.deepEqual(segments("echo it\\'s; go vet ./a", 'sh'), ["echo it\\'s", 'go vet ./a']);
  assert.deepEqual(unwrappedToolErrors([{ name: 'x', commands: ["echo it\\'s; go vet ./a"], dialect: 'sh' }]),
    ['x runs go vet outside tests/run-long.mts, so it has no RUN line or step log: go vet ./a']);
  // A comment runs nothing.
  assert.deepEqual(segments('true # see go vet && go vet ./a', 'sh'), ['true']);
  assert.deepEqual(unwrappedToolErrors([{ name: 'x', commands: ['true # see go vet && go vet ./a'], dialect: 'sh' }]), []);
  // The commands of a group, a loop and an if are commands; their keywords and word lists are not.
  assert.deepEqual(segments('for f in a b; do test -f "$f" || { echo "$f is missing"; exit 1; }; done; if [ -n "$x" ]; then go vet ./a; else exit 2; fi', 'sh'),
    ['test -f "$f"', 'echo "$f is missing"', 'exit 1', '[ -n "$x" ]', 'go vet ./a', 'exit 2']);
  // make reads a recipe line that ends in a backslash with the next line, drops the prefixes @, - and +, reads $$ as $ and
  // gives each reference one word; the segment is the text of the recipe.
  assert.deepEqual(recipeLines('x:\n\t@if true; then \\\n\t  go vet ./a; \\\n\tfi\n\techo \\\\\n'),
    [{ recipe: false, text: 'x:' }, { recipe: true, text: '@if true; then \\\n  go vet ./a; \\\nfi' }, { recipe: true, text: 'echo \\\\' }, { recipe: false, text: '' }]);
  assert.deepEqual(makeRecipes('x:\n\t@if true; then \\\n\t  go vet ./a; \\\n\tfi\n').map(unit => unit.commands), [['@if true; then \\\n  go vet ./a; \\\nfi']]);
  assert.deepEqual(unwrappedToolErrors(makeRecipes('x:\n\t@if true; then \\\n\t  go vet ./a; \\\n\tfi\n')),
    ['Makefile x runs go vet outside tests/run-long.mts, so it has no RUN line or step log: go vet ./a']);
  assert.deepEqual(segments('-files=$$(gofmt -l $(GO_DIRS)); [ -z "$$files" ] || $(if $(RECORD),echo a,echo b)', 'make'),
    ['files=$$(gofmt -l $(GO_DIRS))', '[ -z "$$files" ]', '$(if $(RECORD),echo a,echo b)']);
  assert.deepEqual(shellSegments('$(RUN_LONG) x -- cargo +$(shell sed -n p f) clippy', 'make'), ['VALUE x -- cargo +VALUE clippy']);
  assert.deepEqual(segments('make check-run GROUP=${{ matrix.group }} && echo "${{ github.ref }}"', 'workflow'),
    ['make check-run GROUP=${{ matrix.group }}', 'echo "${{ github.ref }}"']);
  assert.deepEqual(andLists('a && b || c && d; e', 'sh'), [['a', 'b'], ['c', 'd']]);
  // A command the parser rejects is an error, never a guess.
  assert.throws(() => segments("sh -c 'cd packages/ts", 'sh'), /the shell parser rejects this sh command at \d+: .*: sh -c 'cd packages\/ts/);
  assert.throws(() => segments('echo $(RUN_LONG', 'make'), /the make reference at 5 never closes/);
});

// The workflow reader case (T137-1-4-2) checks that workflows are read as YAML documents: flow-form steps, timeout-minutes in action inputs,
// and a workflow that is not YAML or has no jobs.
caseTest('the checks read a workflow as a YAML document', COMPUTE, () => {
  // A step in flow style is a step.
  assert.deepEqual(ciMakeErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - { name: tests, run: go test ./... }\n' }),
    ['ci.yml step "tests" runs go test ./...; run it through a make target']);
  assert.deepEqual(ciMakeErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - { name: tests, run: make test }\n' }), []);
  // An input of an action named timeout-minutes is no deadline of the step.
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - uses: some/action@v1\n        with:\n          timeout-minutes: 5\n' }), []);
  // A step's run text is its value, with the indentation of a block scalar removed.
  assert.deepEqual(readWorkflow('jobs:\n  test:\n    steps:\n      - run: |\n          make a\n          make b\n').jobs[0]?.steps[0]?.run, 'make a\nmake b\n');
  assert.throws(() => ciMakeErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - run: make a\n     - run: go test ./...\n' }), /^Error: the workflow is no YAML document: /);
  assert.throws(() => readWorkflow('jobs:\n  a: {}\n  a: {}\n', 'x.yml'), /^Error: x\.yml is no YAML document: Map keys must be unique/);
  assert.throws(() => readWorkflow('    steps:\n      - run: make a\n', 'x.yml'), /^Error: x\.yml has no map of jobs$/);
  assert.throws(() => readWorkflow('jobs:\n  a:\n    steps:\n      - run: true\n', 'x.yml'), /^Error: x\.yml job a step 1 run is not a string$/);
});

// The run texts and the Makefile rules are read by the shell reader (scripts/repo/shell.mts) and the recipe reader
// (makeRecipes): a command is a segment the text runs, never a substring of a line (T137-1-4-2-1).
caseTest('the server checks read the commands that a step runs', COMPUTE, () => {
  const step = (run: string) => steps.replace('      - name: database servers', `      - name: other\n        run: |\n          ${run.split('\n').join('\n          ')}\n      - name: database servers`);
  // A comment and a quoted word run nothing.
  for (const run of ['# ln -s is never used here', 'echo "ln -s a b"', 'echo "x >> .runtime/servers/env"'])
    assert.deepEqual(ciServerErrors(step(run), script), [], run);
  // A redirect that a segment of a compound command makes writes the file.
  assert.deepEqual(ciServerErrors(step('if true; then echo x >> .runtime/servers/env; fi'), script), ['ci.yml writes .runtime/servers/env; make orm-test-servers writes it']);
  // A make inside a compound command runs make before the servers.
  assert.deepEqual(ciServerErrors(step('if true; then make feature-check; fi'), script), ['ci.yml step "other" runs make before make orm-test-servers starts the servers']);
  // Without make orm-test-servers, a variable is provided by a command that assigns it, never by a comment that names it.
  const none = steps.replace('run: make orm-test-servers', "run: 'true'");
  assert.deepEqual(ciServerErrors(none.replace('make repo-check', '# ORM_TEST_MYSQL_DSN and ORM_TEST_PGBOUNCER_DSN come later'), script), [
    'ci.yml does not provide ORM_TEST_MYSQL_DSN, which the database checks read',
    'ci.yml does not provide ORM_TEST_PGBOUNCER_DSN, which the database checks read',
    'ci.yml does not start the database servers with make orm-test-servers',
  ]);
  assert.deepEqual(ciServerErrors(none.replace('make repo-check', 'export ORM_TEST_MYSQL_DSN=x\n          echo "ORM_TEST_PGBOUNCER_DSN=y" >> "$GITHUB_ENV"'), script), [
    'ci.yml does not start the database servers with make orm-test-servers',
  ]);
});

caseTest('the duplicate check reads the commands that a step runs', COMPUTE, () => {
  const make = 'CHECK_TARGETS = feature-check\nperf-check:\n\t$(WITH_TEST_ENV) node scripts/perf-test.mts\n';
  const commands = ['node scripts/perf-test.mts'];
  const run = (text: string) => steps.replace('make repo-check', text);
  assert.deepEqual(ciDuplicateCommandErrors(run('set -e; node scripts/perf-test.mts'), make, commands), ['ci.yml step "checks" runs node scripts/perf-test.mts, which make orm-check runs in feature-check']);
  assert.deepEqual(ciDuplicateCommandErrors(run('make lint && make perf-check'), make, commands), ['ci.yml step "checks" runs make perf-check, whose commands make orm-check runs in feature-check']);
  assert.deepEqual(ciDuplicateCommandErrors(run('# node scripts/perf-test.mts\n          echo "make perf-check"'), make, commands), []);
});

caseTest('the toolchain checks read the commands that a step runs', COMPUTE, () => {
  const go = (run: string) => `jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: ${run}\n`;
  assert.deepEqual(goVersionErrors({ 'ci.yml': go('echo go test') }), []);
  assert.deepEqual(goVersionErrors({ 'ci.yml': go('cd a; go test ./...') }), ['ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools']);
  assert.deepEqual(goVersionErrors({ 'ci.yml': go('cd a; go test ./...\n      - run: echo "make install-tools"') }), ['ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools']);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': go('echo "php is not used"') }, '8.5'), []);
  const viaMake = rust.replace('run: rustup toolchain install', 'run: make orm-install-rust-toolchain');
  for (const recipe of ['\trustup toolchain install && rustup show\n', '\t@rustup toolchain install\n'])
    assert.deepEqual(rustToolchainErrors(toolchain, `${makefile}orm-install-rust-toolchain:\n${recipe}`, { 'ci.yml': viaMake }, '1.98.1'), [], recipe);
  for (const recipe of ['\t# rustup toolchain install\n\ttrue\n', '\techo rustup toolchain install\n'])
    assert.deepEqual(rustToolchainErrors(toolchain, `${makefile}orm-install-rust-toolchain:\n${recipe}`, { 'ci.yml': viaMake }, '1.98.1'),
      ['ci.yml does not install the toolchain of rust-toolchain.toml with rustup toolchain install'], recipe);
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('cargo test --locked', 'echo "cargo +nightly"') }, '1.98.1'), []);
});
