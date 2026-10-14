import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { main as startServers, paths as serverPaths, SERVER_VARIABLES, TestServerError } from '../test-servers.mts';
import { AFTER_GROUP_CHECK, CI_PASSED_STEP, CI_PASSED_STEPS, ciPassedErrors, ciGroups, GROUP_NEEDS, chainedCommandErrors, concurrencyErrors, ownWorkflows, workflowTriggerErrors, WORKFLOW_TRIGGERS, ciMakeErrors, checkTargets, ciAfterCheckErrors, ciSetupErrors, independentTestErrors, fullSuiteRuleErrors, ciCheckTargetErrors, ciDuplicateCommandErrors, ciLeaseErrors, ciRerunErrors, ciReportPathErrors, ciServerErrors, expand, helperEnvironmentErrors, helperRunErrors, featureCommands, makeVariables, runnerErrors, runnerIdentity, stepTimeoutErrors } from './ci.mts';
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
import { scriptPathErrors, toolingLanguageErrors } from './scripts.mts';
import { callerPathErrors, deferredExitErrors, detachedGroupErrors, timeFailureErrors } from './gosource.mts';
import { callerEnvironmentErrors, generateRuns, scriptCommands, goRunErrors, goTestCaseErrors, longDeadlineErrors, makeRecipes, fixedPortErrors, runtimePathErrors, sharedTargetErrors, unpublishedOutputErrors, typescriptHolderErrors, typescriptReaderErrors, unleasedCargoErrors, nodeTestErrors, rawGoTestErrors, reachedScripts, repeatedGenerateErrors, reportingScriptErrors, rustTestCaseErrors, segments, testEntries, unbuiltCargoTestErrors, unwrappedToolErrors } from './testcases.mts';

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

caseTest('the CI workflow provides every variable of make test-servers', COMPUTE, () => {
  const variables = SERVER_VARIABLES;
  for (const variable of ['ORM_TEST_MYSQL_REPLICA_DSN', 'ORM_TEST_POSTGRES_REPLICA_DSN', 'ORM_TEST_PROXYSQL_DSN',
    'ORM_TEST_PGBOUNCER_DSN', 'ORM_TEST_PGBOUNCER_SINGLE_DSN', 'ORM_TEST_MYSQL_TLS_DSN', 'ORM_RUN_MYSQL_DSN', 'ORM_RUN_POSTGRES_DSN',
    'ORM_RUN_SQLITE_QUERY', 'ORM_TEST_SERVERS_LEASES'])
    assert.ok(variables.includes(variable), `${variable} is not written by scripts/test-servers.mts`);
  assert.deepEqual(ciServerErrors(workflow, SERVER_VARIABLES), []);
});

// steps와 script는 workflow의 최소 형태와 test-servers.mts가 쓰는 변수 둘이다. 각 case는 그 하나를 바꾼다.
const steps = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - name: database servers',
  '        run: make test-servers',
  '      - name: checks',
  '        run: |',
  '          make repo-check',
  '          go test ./...',
  '',
].join('\n');
const script = ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_PGBOUNCER_DSN'];

caseTest('a workflow that starts the servers with make test-servers passes', COMPUTE, () => {
  assert.deepEqual(ciServerErrors(steps, script), []);
});

caseTest('a workflow without make test-servers names each variable it lacks', COMPUTE, () => {
  const written = steps.replace('run: make test-servers', 'run: true').replace(
    '      - name: checks',
    '      - run: printf "export ORM_TEST_MYSQL_DSN=x" > .runtime/servers/env\n      - name: checks',
  );
  assert.deepEqual(ciServerErrors(written, script), [
    'ci.yml does not provide ORM_TEST_PGBOUNCER_DSN, which the database checks read',
    'ci.yml does not start the database servers with make test-servers',
    'ci.yml writes .runtime/servers/env; make test-servers writes it',
  ]);
});

caseTest('a workflow that defines a server variable itself fails', COMPUTE, () => {
  const defined = steps.replace('    steps:', '    env:\n      ORM_TEST_MYSQL_DSN: "mysql://root@127.0.0.1:3306/orm_test"\n    steps:');
  assert.deepEqual(ciServerErrors(defined, script), ['ci.yml defines ORM_TEST_MYSQL_DSN; make test-servers defines it']);
});

caseTest('a check before make test-servers fails', COMPUTE, () => {
  const early = steps.replace('      - name: database servers', '      - name: early\n        run: make feature-check\n      - name: database servers');
  assert.deepEqual(ciServerErrors(early, script), ['ci.yml step "early" runs make before make test-servers starts the servers']);
  // make install과 그 부분은 download만 하므로 server보다 앞서도 된다.
  const install = steps.replace('      - name: database servers', '      - name: downloads\n        run: make install-go install-node-min\n      - name: database servers');
  assert.deepEqual(ciServerErrors(install, script), []);
});

caseTest('a workflow that creates a symbolic link fails', COMPUTE, () => {
  for (const command of ['ln -s a b', 'sudo ln -sf /usr/lib/a.so.1t64 /usr/lib/a.so.1', 'ln --symbolic a b', `node -e "fs.symlinkSync('a', 'b')"`]) {
    const linked = steps.replace('      - name: database servers', `      - name: link\n        run: ${command}\n      - name: database servers`);
    assert.deepEqual(ciServerErrors(linked, script), ['ci.yml step "link" creates a symbolic link'], command);
  }
});

// make check 뒤 case(G5.38-4)는 저장소의 workflow를 보고, 최소 workflow에서 make check 뒤에 선언된 summary와 report
// 두 step만 받아들이는지 확인한다. 다른 명령 step, 다른 action step, 다른 path의 upload, 빠진 step, ORM_CHECK_RUN_ID
// 없는 make check는 거부한다.
caseTest('a workflow runs only the summary and the report upload after make check', COMPUTE, () => {
  assert.deepEqual(ciAfterCheckErrors(workflows), []);
  const check = ['      - name: make check', '        env:', '          ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}', '        run: make check'];
  const summary = ['      - name: summary', '        if: ${{ !cancelled() }}', '        env:', '          ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}', '        run: node scripts/check/summary.mts'];
  const report = ['      - name: report', '        if: ${{ !cancelled() }}', '        uses: actions/upload-artifact@v4', '        with:', '          name: check-${{ github.run_id }}-${{ github.run_attempt }}',
    '          path: .runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}/report/', '          if-no-files-found: error'];
  const workflow = (...steps: string[][]) => ['jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v5', '      - name: install', '        run: npm ci', ...steps.flat(), ''].join('\n');
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report) }), []);
  // 다른 job의 step은 make check job의 step이 아니다(G5.98).
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, ['  docs:', '    steps:', '      - name: documentation checks', '        run: make docs-ci']) }), []);
  const fuzz = ['      - name: decoder fuzz smoke checks', '        if: ${{ !cancelled() }}', '        run: make fuzz-check'];
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, fuzz) }), [
    'ci.yml step "decoder fuzz smoke checks" runs make fuzz-check after make check; make check runs every check, and only the summary and the report upload follow it, so a check it lacks belongs in a target of CHECK_TARGETS',
  ]);
  const everything = report.map(line => line.replace('/report/', '/'));
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, everything) }), [
    `ci.yml step "report" after make check is not the declared report step: ${everything.map(line => line.trim()).join(' | ')} instead of ${report.map(line => line.trim()).join(' | ')}`,
  ]);
  const other = ['      - uses: actions/cache@v4'];
  assert.match(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, other) })[0] ?? '', /^ci\.yml step "uses: actions\/cache@v4" runs - uses: actions\/cache@v4 after make check/);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(check) }), [
    `ci.yml has no summary step after make check: ${summary.map(line => line.trim()).join(' | ')}`,
    `ci.yml has no report step after make check: ${report.map(line => line.trim()).join(' | ')}`,
  ]);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': workflow(['      - name: make check', '        run: make check'], summary, report) }), [
    'ci.yml step "make check" gives make check no ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}, which names the report of the run',
  ]);
});

// node case는 저장소의 .node-version, package.json, workflow와 실행 중인 Node를 검사하고, 최소
// workflow를 하나씩 바꾼다.
const repository = new URL('../../', import.meta.url);
const declared = readFileSync(new URL('.node-version', repository), 'utf8');
const minimum = readPackage(join(repository.pathname, 'package.json')).engines?.['node'];
const workflows = Object.fromEntries(readdirSync(new URL('.github/workflows/', repository)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(new URL(`.github/workflows/${name}`, repository), 'utf8')]));

caseTest('the checks and every workflow run the Node of .node-version', COMPUTE, () => {
  assert.deepEqual(Object.keys(workflows), ['.github/workflows/ci.yml', '.github/workflows/docs-pages.yml', '.github/workflows/push-gate.yml', '.github/workflows/release.yml']);
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
  '          node-version-file: .node-version',
  '          cache: npm',
  '      - run: npm ci',
  '',
].join('\n');

caseTest('a workflow that reads .node-version on the declared Node passes', COMPUTE, () => {
  assert.deepEqual(nodeVersionErrors('26.8.1\n', '>=22.16.0', { 'ci.yml': node }, '26.8.1'), []);
});

caseTest('a workflow that declares node-version itself fails', COMPUTE, () => {
  const literal = node.replace('node-version-file: .node-version', 'node-version: "22.16.0"');
  assert.deepEqual(nodeVersionErrors('26.8.1\n', '>=22.16.0', { 'ci.yml': literal }, '26.8.1'), [
    'ci.yml declares node-version itself; .node-version declares it',
    'ci.yml does not read node-version-file .node-version in actions/setup-node',
  ]);
  const unset = node.replace('actions/setup-node@v7', 'actions/checkout@v5');
  assert.deepEqual(nodeVersionErrors('26.8.1\n', '>=22.16.0', { 'ci.yml': unset }, '26.8.1'), [
    'ci.yml runs Node without actions/setup-node',
  ]);
});

caseTest('a Node other than .node-version fails', COMPUTE, () => {
  assert.deepEqual(nodeVersionErrors('26.8.1\n', '>=22.16.0', { 'ci.yml': node }, '22.16.0'), [
    'Node 22.16.0 runs the checks; .node-version declares 26.8.1',
  ]);
});

caseTest('a .node-version that is not one exact supported version fails', COMPUTE, () => {
  assert.deepEqual(nodeVersionErrors('', '>=22.16.0', {}, '26.8.1'), [
    '.node-version must hold one exact version x.y.z and a newline, found ""',
  ]);
  assert.deepEqual(nodeVersionErrors('26\n', '>=22.16.0', {}, '26.8.1'), [
    '.node-version must hold one exact version x.y.z and a newline, found "26\\n"',
  ]);
  assert.deepEqual(nodeVersionErrors('22.12.0\n', '>=22.16.0', {}, '22.12.0'), [
    '.node-version 22.12.0 is below package.json engines.node >=22.16.0',
  ]);
  assert.deepEqual(nodeVersionErrors('26.8.1\n', '22.16', {}, '26.8.1'), [
    'package.json engines.node must be ">=x.y.z", found "22.16"',
  ]);
});

// PHP와 Rust case는 저장소의 선언과 실행 중인 php, rustc를 검사하고, 최소 workflow를 하나씩 바꾼다.
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

// CHECK_TARGETS case는 저장소의 workflow와 Makefile, 그리고 최소 workflow를 검사한다.
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
  assert.deepEqual(ciCheckTargetErrors(steps.replace('make repo-check', 'make check'), make), []);
  assert.deepEqual(ciCheckTargetErrors(steps.replace('make repo-check', 'make check\n          make ts-min-check'), make), [
    'ci.yml step "checks" runs ts-min-check, which make check runs',
  ]);
  assert.deepEqual(ciCheckTargetErrors(steps, 'CHECK =\n'), ['Makefile declares no CHECK_TARGETS']);
});

// CI group case(G5.111)는 저장소의 Makefile과 workflow가 CHECK_TARGETS를 group으로 정확히 나누는지 보고, 최소
// Makefile과 workflow에서 빠진 target, 두 group의 target, CHECK_TARGETS 밖의 target, CI_GROUPS와 다른 matrix를 거부한다.
caseTest('the CI groups run every target of CHECK_TARGETS in exactly one job', COMPUTE, () => {
  const makefile = text('Makefile');
  const { groups, targets } = ciGroups(makefile);
  assert.ok(groups.length > 1, 'the Makefile declares more than one CI group');
  assert.deepEqual(groups.flatMap(group => targets[group]).sort(), [...checkTargets(makefile)].sort());
  assert.ok(workflow.includes('        run: make check-run GROUP=${{ matrix.group }}\n'), 'ci.yml runs make check-run for the group of its matrix');
  assert.deepEqual(ciCheckTargetErrors(workflow, makefile), []);
});

caseTest('a CI group set that omits, repeats or adds a target of CHECK_TARGETS fails', COMPUTE, () => {
  const grouped = (matrix = '[one, two]') => `jobs:\n  test:\n    strategy:\n      matrix:\n        group: ${matrix}\n    steps:\n      - name: make check\n        run: make check-run GROUP=\${{ matrix.group }}\n`;
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
  // group job도 CHECK_TARGETS의 target을 따로 실행하면 두 번 실행한다.
  assert.deepEqual(ciCheckTargetErrors(grouped().replace('GROUP=${{ matrix.group }}\n', 'GROUP=${{ matrix.group }}\n      - name: again\n        run: make b-check\n'), good), [
    'ci.yml step "again" runs b-check, which make check runs',
  ]);
});

// 보고서 path case(G5.128)는 CI job이 올리는 보고서 directory가 CI_GROUPS의 group마다 runner가 그 job의 ORM_CHECK_RUN_ID로 쓰는
// directory인지 본다. runner는 `-`를 `_`로 바꾸므로 `-`가 있는 group의 보고서는 올라가지 않았다.
caseTest('every CI group uploads the report directory that the runner writes', COMPUTE, () => {
  assert.deepEqual(ciReportPathErrors(workflow, text('Makefile')), []);
  const make = text('Makefile').replace(/^CI_GROUPS = (.*)$/m, 'CI_GROUPS = $1 stress-x').concat('\nCI_TARGETS_stress-x = feature-stress-mysql-check\n');
  assert.deepEqual(ciReportPathErrors(workflow, make), [
    'ci.yml job test group stress-x uploads .runtime/check/ci_1_1_stress-x/report/, but the runner writes the report of ORM_CHECK_RUN_ID 1-1-stress-x to .runtime/check/ci_1_1_stress_x/report/; name the group with lowercase letters, digits and _ only',
  ]);
});

// group setup case(G5.127)는 CI_GROUPS의 모든 group이 그 target의 need와, 그 need의 setup 단계가 필요로 하는 need의 setup step을
// 실행하는지 저장소의 Makefile과 contracts/check-inputs.json으로 본다. databases/create는 server를 server-programs의
// program으로 시작하므로 databases만 선언한 target의 group도 server-programs output이 필요하다. 그 output이 databases를
// 보지 않는 대조군에서는 stress-db가 server-programs setup step을 건너뛴다.
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

// CI group setup case(G5.111)는 group job의 setup step이 scripts/check/ci-setup.mts가 선언한 조건으로만 실행되는지, group-needs
// step이 make ci-group-needs의 output을 쓰는지, 그 뒤의 summary와 report가 group마다의 실행 id와 보고서를 쓰는지 본다.
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
  const check = `      - name: make check\n        if: \${{ !cancelled() }}\n        env:\n          ORM_CHECK_RUN_ID: \${{ github.run_id }}-\${{ github.run_attempt }}-\${{ matrix.group }}\n          ORM_CI_SETUP: \${{ toJSON(steps) }}\n        run: make check-run GROUP=\${{ matrix.group }}\n`;
  const after = AFTER_GROUP_CHECK.map(lines => lines.map((line, index) => `${index === 0 ? '      ' : '        '}${line.startsWith('ORM_') || line.startsWith('name: check') || line.startsWith('path:') || line.startsWith('if-no') ? '  ' : ''}${line}`).join('\n')).join('\n') + '\n';
  const job = (needs: string, composer: string) => `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v5\n        id: checkout\n      - name: setup of the CI group\n        id: group-needs\n        if: \${{ !cancelled() }}\n        run: ${needs}\n      - uses: actions/setup-go@v6\n        id: go\n        if: \${{ !cancelled() }}\n      - name: install PHP dependencies\n        id: composer\n        if: ${composer}\n        run: make install-php\n      - name: database servers\n        id: servers\n        if: ${stepCondition('servers')}\n        run: make test-servers\n${check}${after}`;
  const good = job(GROUP_NEEDS, stepCondition('composer'));
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good }, { setup, runner }), []);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': good }), []);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': job(GROUP_NEEDS, '${{ !cancelled() }}') }, { setup, runner }), [
    `ci.yml step "install PHP dependencies" of the CI group job runs under if: \${{ !cancelled() }} instead of if: ${stepCondition('composer')}, the condition that scripts/check/ci-setup.mts declares for the step composer`,
  ]);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': job('make ci-group-needs GROUP=static >> "$GITHUB_OUTPUT"', stepCondition('composer')) }, { setup, runner }), [
    `ci.yml step "setup of the CI group" runs make ci-group-needs GROUP=static >> "$GITHUB_OUTPUT" instead of ${GROUP_NEEDS}, which writes the setup of the CI group as step outputs`,
  ]);
  // group마다의 보고서가 아닌 report step과 group 없는 실행 id는 group의 보고서를 서로 덮는다.
  const shared = good.replace('name: check-${{ matrix.group }}-', 'name: check-');
  assert.match(ciAfterCheckErrors({ 'ci.yml': shared })[0] ?? '', /^ci\.yml step "report" after make check is not the declared report step: /);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': good.replace('${{ github.run_attempt }}-${{ matrix.group }}\n          ORM_CI_SETUP', '${{ github.run_attempt }}\n          ORM_CI_SETUP') }), [
    'ci.yml step "make check" gives make check no ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.group }}, which names the report of the run',
  ]);
});

// ci-passed case(G5.113-2)는 저장소의 ci.yml이 job ci-passed를 마지막에 두고 다른 모든 job을 needs로 받는지 보고, 최소
// workflow에서 빠진 job, 마지막이 아닌 job, always()가 아닌 조건, 다른 step을 거부한다.
caseTest('the job ci-passed runs last under always() and needs every other job', COMPUTE, () => {
  assert.deepEqual(ciPassedErrors(workflow), []);
  // A step is written as in ci.yml: its first line under the job's steps, its keys below it, and the entries of with: and env:
  // below those.
  const render = (lines: string[]) => lines.map((line: string, index) => `${' '.repeat(index === 0 ? 6 : /^(with|env):$/.test(lines[index - 1] ?? '') ? 10 : 8)}${line}\n`).join('');
  const step = `    steps:\n${CI_PASSED_STEPS.map(render).join('')}`;
  const job = (condition: string, needs: string) => `  ci-passed:\n    if: ${condition}\n    needs: [${needs}]\n    runs-on: ubuntu-26.04-arm\n${step}`;
  const others = '  test:\n    steps:\n      - run: make check\n  docs:\n    steps:\n      - run: make docs-ci\n';
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs')}`), []);
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}`), ['ci.yml has no job ci-passed, the check that the ruleset requires; add it as the last job with if: ${{ always() }} and needs: every other job']);
  assert.deepEqual(ciPassedErrors(`jobs:\n${job('${{ success() }}', 'test, pages')}${others}`), [
    'ci.yml job ci-passed is not the last job; move it after docs',
    'ci.yml job ci-passed does not run with if: ${{ always() }}, so a failed or cancelled job skips it instead of failing it',
    'ci.yml job ci-passed does not need the job docs; list every other job under needs',
    'ci.yml job ci-passed needs pages, which is no other job of ci.yml',
  ]);
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace('make ci-passed', 'true')}`)[0] ?? '', /^ci\.yml job ci-passed has the steps .* instead of - uses: actions\/checkout@v5/);
  // A job without the checkout runs make where the repository is not, and make finds no Makefile.
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace(`      ${CI_PASSED_STEPS[0]?.[0] ?? ''}\n`, '')}`)[0] ?? '', /^ci\.yml job ci-passed has the steps - uses: actions\/setup-node@v7/);
});

// 중복 실행 case는 저장소의 workflow, Makefile, feature contract와 최소 workflow를 검사한다.
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
  const twice = steps.replace('make repo-check', 'make check\n          make interface-check fuzz-check\n          node scripts/perf-test.mts\n          php packages/php/tests/CodecVectorsTest.php');
  assert.deepEqual(ciDuplicateCommandErrors(twice, make, commands), [
    'ci.yml step "checks" runs make interface-check, whose commands make check runs in feature-check',
    'ci.yml step "checks" runs node scripts/perf-test.mts, which make check runs in feature-check',
  ]);
  assert.deepEqual(ciDuplicateCommandErrors(steps.replace('make repo-check', 'make check\n          make fuzz-check'), make, commands), []);
});

// helper 실행 case(G5.120)는 make check가 helper check마다 한 번 실행하는지 본다: 저장소의 Makefile, feature contract와
// scripts/check/databases.mts, 그리고 helper를 두 번 실행하거나 한 번도 실행하지 않는 최소 Makefile이다.
caseTest('make check runs the check of every helper once', COMPUTE, () => {
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
  const twice = (id: string, places: string) => `make check runs the check of helper ${id} 2 times: ${places}; run it once, and add a helper whose check a target or setup step of make check runs to FEATURE_SUITE_HELPERS, which make feature-helper-check leaves out`;
  assert.deepEqual(helperRunErrors(manifest, make('suite', 'stress'), setup), [
    twice('nested', 'make helper-check; make nested-check, a target of make check'),
    twice('seed', 'make helper-check; the setup step databases/create of make check (scripts/check/databases.mts runs scripts/seed.sh)'),
    twice('seedts', 'make helper-check; the setup step databases/create of make check (scripts/check/databases.mts runs scripts/seedts.mts)'),
  ]);
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts plain', 'stress'), setup), [
    'make check runs no check of helper plain: no target of CHECK_TARGETS selects it and its command is no target or setup step of make check; leave it out of FEATURE_STRESS_HELPERS and FEATURE_SUITE_HELPERS so that make feature-helper-check runs it',
  ]);
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts', 'stress').replace('--helpers $(addprefix --without-helper ,$(STRESS) $(SUITE))', '--helpers $(addprefix --without-helper ,$(SUITE))'), setup), [
    twice('stress', 'make helper-check; make stress-check'),
  ]);
});

// helper 환경 case는 helper check의 make 명령이 읽는 shell 변수를 Makefile이 export하는지 본다: 저장소의 contracts/features.json과
// Makefile, 그리고 한 실행 경로만 설정하던 변수(ORM_OWNER_TEST_ENV)를 읽는 최소 manifest다.
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

// runner case는 저장소의 .github/runner와 workflow, 그리고 최소 workflow를 검사한다.
// A workflow among the copies of @polyspec/kit is kit's and make kit-check holds it byte for byte, so the workflow rules of this
// repository do not check it (T115). A runner other than that of kit's release.yml is a change of kit.
const vendoredFiles = copies;

caseTest('the workflow rules skip the workflows that @polyspec/kit copies', COMPUTE, () => {
  // kit copies one workflow, release.yml; its other copies (PRINCIPLES.md, the lint configurations, the bootstrap) are no workflows.
  assert.deepEqual(Object.keys(vendoredFiles).filter(file => file.startsWith('.github/workflows/')), ['.github/workflows/release.yml']);
  const all = { '.github/workflows/ci.yml': 'a', '.github/workflows/release.yml': 'b' };
  assert.deepEqual(ownWorkflows(all, vendoredFiles), { '.github/workflows/ci.yml': 'a' });
  assert.deepEqual(ownWorkflows({ 'ci.yml': 'a', 'release.yml': 'b' }, vendoredFiles), { 'ci.yml': 'a' });
  assert.throws(() => ownWorkflows(all, null), /no copies of @polyspec\/kit/);
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
  const job = 'jobs:\n  test:\n    runs-on: ubuntu-26.04-arm\n    steps:\n      - run: true\n';
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job }), []);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job.replace('ubuntu-26.04-arm', 'ubuntu-24.04') }), [
    'ci.yml runs on ubuntu-24.04; .github/runner declares ubuntu-26.04-arm',
  ]);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job.replace('    runs-on: ubuntu-26.04-arm\n', '') }), ['ci.yml declares no runs-on']);
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

// 공유 target case는 저장소의 Makefile과 최소 Makefile을 검사한다.
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

// 실행 file case는 저장소의 Makefile과 최소 Makefile을 검사한다.
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
});

// lease case는 Makefile 밖의 명령과 최소 단위를 검사한다.
caseTest('commands outside the Makefile build into the shared Rust target directory only under its lease', COMPUTE, () => {
  const { packageUnits } = runUnits();
  const files = new Set(trackedFiles('*'));
  const commands = [...makeRecipes(text('Makefile')), ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command })));
  const scripts = reachedScripts(commands, readScript, { throughLong: true });
  assert.deepEqual(unleasedCargoErrors([...featureUnits(), ...packageUnits, ...scripts]), []);
  const unit = (name: string, command: string) => ({ name, commands: [command] });
  const build = (segment: string) => `x builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`;
  assert.deepEqual(unleasedCargoErrors([
    unit('x', 'node tests/run-long.mts b -- cargo build --locked'),
    unit('x', '"$LEASE" run "$CARGO_LEASES" exclusive --wait -- cargo test --no-run --locked'),
    unit('x', 'node tests/cargo-test.mts a -- cargo test --locked --test a'),
    unit('x', '"${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a'),
  ]), [build('node tests/run-long.mts b -- cargo build --locked'),
    'x runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.mts): "${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a']);
});

// TypeScript 읽기 case는 저장소의 Makefile과 최소 Makefile, file을 검사한다.
caseTest('a target that runs code using the TypeScript build output holds it', COMPUTE, () => {
  const files = new Set(trackedFiles('*'));
  assert.deepEqual(typescriptReaderErrors(text('Makefile'), (path: string) => files.has(path) ? text(path) : undefined), []);
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

// 이름만 적는 case(G5.40)는 TypeScript test의 경로를 실행하지 않고 문자열로만 적는 test(가짜 node의 기대 출력, stub
// template, 정규식)를 읽는 것으로 세지 않고, 그 경로를 node로 실행하는 file(program과 인자 배열, exec나 spawn의 shell
// 문자열)은 여전히 읽는 것으로 세며, 여러 줄에 걸친 import도 읽는 것으로 세는지 확인한다.
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
    // 여러 줄의 import는 읽는 것이다. 함수 본문 뒤 주석에 적은 import 예시는 아니다.
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

// go run case는 최소 단위를 검사한다. 저장소 전체는 repository check가 본다.
caseTest('a go run, whose build has no step log, fails', COMPUTE, () => {
  assert.deepEqual(goRunErrors([
    { name: 'raw', commands: ['go run ./tests/interfaces/check --self-test'] },
    { name: 'env', commands: ['PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x'] },
    { name: 'wrapped', commands: ['node tests/go-run.mts interfaces-check ./tests/interfaces/check --self-test'] },
  ]), [
    'raw runs go run, whose build has no step log; run it through tests/go-run.mts: go run ./tests/interfaces/check --self-test',
    'env runs go run, whose build has no step log; run it through tests/go-run.mts: PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x',
  ]);
});

// 언어 case는 저장소의 tracked file과 최소 목록을 검사한다.
caseTest('every tool of the repository is written in Go, PHP, Rust or TypeScript', COMPUTE, () => {
  assert.deepEqual(toolingLanguageErrors(trackedFiles('*')), []);
  assert.deepEqual(toolingLanguageErrors(['scripts/stop-process.py', 'tests/stop-process/main.go', 'scripts/a.sh', 'tools/x.rb', 'packages/php/src/Db.php']), [
    'scripts/stop-process.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tools/x.rb is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
  // the Python exemption is exactly the five places of scripts/repo/scripts.mts; nothing else is exempt
  assert.deepEqual(toolingLanguageErrors(['packages/python/src/polyspec/orm/core.py', 'tests/interfaces/python.py', 'tests/interfaces/test_schema_utils.py',
    'tests/conformance/runner_python.py', 'tests/dbspec/compare/python.py']), []);
  assert.deepEqual(toolingLanguageErrors(['tests/interfaces/helper.py', 'tests/conformance/vectors.py', 'tests/dbspec/compare/other.py',
    'scripts/python_tool.py', 'packages/orm-python-old/x.py']), [
    'tests/interfaces/helper.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tests/conformance/vectors.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tests/dbspec/compare/other.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'scripts/python_tool.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'packages/orm-python-old/x.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
});

// startLogged case는 test-servers.mts의 startLogged로 가짜 서버를 시작한다. 서버 시작은 장기 작업이므로 기한이 없다. 준비
// 줄을 쓰고 계속 실행하면 startLogged는 서버가 끝나기 전에 돌아와야 하고, 준비 줄까지의 줄은 stderr에 보인다. 1.5초
// 뒤에야 준비 줄을 쓰는 느리지만 정상인 서버도 시작하고, 준비 줄 없이 끝나는 서버는 log와 함께 실패한다. 서버는 시작한
// process의 process group 밖, 자기 session에서 실행된다(G5.62). 출력은 다른 node process의 file로 받는다.
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
    // 느린 서버는 준비 줄 바로 앞에 marker file을 만든다. startLogged가 돌아왔을 때 그 file이 있으면 준비 줄을 기다린 것이다.
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

// timeout case는 저장소의 workflow와 최소 workflow의 step과 job에 timeout-minutes가 없는지 검사한다.
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
    '        run: make check',
    '',
  ].join('\n');
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain }), []);
  const step = (name: string) => `ci.yml step "${name}" has timeout-minutes; a long operation gets step logs and no deadline`;
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain
    .replace('      - uses: actions/checkout@v5', '      - uses: actions/checkout@v5\n        timeout-minutes: 10')
    .replace('        run: npm ci', '        timeout-minutes: 20\n        run: npm ci')
    .replace('        run: make check', '        timeout-minutes: 90\n        run: make check') }),
  [step('uses: actions/checkout@v5'), step('install'), step('checks')]);
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain.replace('    runs-on:', '    timeout-minutes: 360\n    runs-on:') }), [
    'ci.yml has timeout-minutes outside its steps, a deadline for a whole job; a long operation gets step logs and no deadline',
  ]);
});

// lease case는 저장소의 workflow가 lease 변수를 읽는 program을 make 밖에서 실행하지 않는지 보고, 최소 workflow의
// step이 그런 program(Go checker, Node script, shell script)을 직접 실행하면 거부하는지 확인한다. make target과
// lease를 읽지 않는 program은 허용한다.
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

// target case는 실행 명령이 packages/rust/target/를 직접 적으면 거부한다.
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

// manifest directory case는 Rust source가 package directory를 compile 시점의 env!로 읽으면 거부한다.
caseTest('Rust source reads the package directory when the program runs', COMPUTE, () => {
  assert.deepEqual(manifestDirErrors({
    'packages/rust/orm/tests/a.rs': 'let dir = polyspec_orm_testcase::manifest_dir();\n// env!("CARGO_MANIFEST_DIR") was the old form\n',
    'bench/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\ninclude!(concat!(env!("OUT_DIR"), "/m.rs"));\n',
  }), []);
  assert.deepEqual(manifestDirErrors({
    'packages/rust/orm/tests/a.rs': 'use std::path::PathBuf;\nlet root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");\n',
    'packages/rust/orm/src/codec.rs': '        let root = concat!(env!( "CARGO_MANIFEST_DIR" ), "/../../../tests/codec");\n',
  }), [
    'packages/rust/orm/tests/a.rs:2 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
    'packages/rust/orm/src/codec.rs:1 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
  ]);
});

// 연결 probe case는 client runtime이 연결할 때 server에 묻는 statement를 거부한다.
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

// program 경로 case는 Rust test가 package program의 경로를 compile 시점의 env!로 읽으면 거부한다.
caseTest('Rust tests read the paths of package programs when they run', COMPUTE, () => {
  assert.deepEqual(binExeErrors({
    'bench/rust/tests/a.rs': 'let program = &polyspec_orm_testcase::program("native");\n// env!("CARGO_BIN_EXE_native") was the old form\n',
  }), []);
  assert.deepEqual(binExeErrors({ 'bench/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\n' }), [
    'bench/rust/tests/b.rs:1 reads the program path at compile time with CARGO_BIN_EXE; read it when the test runs with polyspec_orm_testcase::program',
  ]);
});

// test 선언 case는 저장소의 JavaScript file과 최소 file을 검사한다.
const trackedFiles = (pattern: string) => execFileSync('git', ['ls-files', '-z', pattern], { cwd: repository }).toString().split('\0').filter(Boolean).filter(notVendored);

// scriptTexts는 scripts/의 script마다 그 명령 text다(scriptCommands): shell script의 줄과 TypeScript 명령 script의 COMMANDS.
// readScript는 reachedScripts가 따라가는 path를 그것으로 읽고, 명령 script가 아닌 TypeScript file은 읽지 않는다.
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

// 호출 환경 case(G5.119)는 JavaScript test가 하위 process에 자기를 실행한 쪽의 환경을 넘기지 않는지 본다. CI group의 job이
// 실행한 `make -n check`는 그 job의 GROUP을 받아 멈췄다.
caseTest('a JavaScript test gives its child processes only the variables of the case', COMPUTE, () => {
  assert.deepEqual(callerEnvironmentErrors(trackedTexts(trackedFiles('*.test.mjs'))), []);
  // 아래 fixture의 환경 이름은 이 file 자체가 그 규칙에 걸리지 않도록 조립한다.
  const caller = ['process', 'env'].join('.');
  const spawn = 'spawn' + 'Sync';
  const spread = (at: string) => `${at} gives a child process the environment of its caller; give it isolatedEnvironment of tests/environment.mts with the variables of the case`;
  const make = (at: string) => `${at} runs make with the environment of its caller, whose GROUP, GITHUB_ACTIONS and MAKEFLAGS reach the recipe; pass env: isolatedEnvironment(...) of tests/environment.mts with the variables of the case`;
  assert.deepEqual(callerEnvironmentErrors({
    'a.test.mjs': `${spawn}('make', ['-n', 'check'], { cwd: repo, encoding: 'utf8', env: { ...${caller}, GITHUB_ACTIONS: '' } });\n`,
    'b.test.mjs': `const dry = ${spawn}('make', ['-n', 'check'], { cwd: repo });\nrun('sh', [], { env: ${caller} });\n`,
    'c.test.mjs': `${spawn}('make', ['-n', 'check'], { env: isolatedEnvironment({ GROUP: 'static' }) });\nrun('sh', [], { env: isolatedEnvironment({ PATH: ${caller}.PATH }) });\n`,
    'd.mjs': `${spawn}('make', ['check'], { env: { ...${caller} } });\n`,
  }), [spread('a.test.mjs:1'), make('b.test.mjs:1'), spread('b.test.mjs:2')]);
});

caseTest('every Go and Rust test starts its case with the shared testcase package', COMPUTE, () => {
  assert.deepEqual(goTestCaseErrors(trackedTexts(trackedFiles('*_test.go'))), []);
  assert.deepEqual(rustTestCaseErrors(trackedTexts(trackedFiles('*.rs'))), []);
});

caseTest('a Go or Rust test without a case of its own fails', COMPUTE, () => {
  const go = [
    'package orm',
    'func TestStarted(t *testing.T) {',
    '\ttestcase.Start(t, testcase.Compute)',
    '}',
    'func TestBare(t *testing.T) {',
    '\tt.Log("no case")',
    '}',
    'func TestGenerated(t *testing.T) {',
    '\ttestcase.Start(t, testcase.Compute)',
    '\twrite(`package model',
    'func TestInside(t *testing.T) { _ = 1 }',
    '`)',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(goTestCaseErrors({ 'packages/go/orm/a_test.go': go, 'packages/go/testcase/testcase_test.go': 'func TestBare(t *testing.T) {\n}\n' }), [
    'packages/go/orm/a_test.go: TestBare does not start its case with packages/go/testcase, so it runs without a deadline or RUN line',
  ]);
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

// case 보고 case는 저장소가 실행하는 PHP와 TypeScript test와 최소 file을 검사한다.
caseTest('every PHP and TypeScript test that a check runs reports its cases', COMPUTE, () => {
  const commands = [
    ...text('Makefile').split('\n').filter(line => line.startsWith('\t')).map(line => ({ source: 'Makefile', command: line.slice(1) })),
    ...featureCommands(readFeatures(repository.pathname)).map(command => ({ source: 'contracts/features.json', command })),
    ...[...scriptTexts].flatMap(([path, lines]) => lines.split('\n').map(command => ({ source: path, command }))),
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

// 도구 case는 저장소의 검증 명령과 최소 명령을 검사한다.
const featureUnits = () => {
  const manifest = readFeatures(repository.pathname);
  return [...manifest.features.flatMap(feature => feature.verification
    .filter(check => (check.cwd ?? '.') === '.').map(check => ({ name: `contracts/features.json ${feature.id}/${check.id}`, commands: [check.command] }))),
  ...(manifest.helpers ?? []).map(helper => ({ name: `contracts/features.json helper ${helper.id}`, commands: [helper.command] }))];
};

caseTest('every build tool of a verification command runs under run-long without a deadline', COMPUTE, () => {
  assert.deepEqual(unwrappedToolErrors(featureUnits()), []);
});

caseTest('a build tool outside run-long or under a deadline fails', COMPUTE, () => {
  assert.deepEqual(segments(`a && node tests/run-long.mts x -- sh -c 'go generate ./ && git diff' || (cd b; c | d)`),
    ['a', `node tests/run-long.mts x -- sh -c 'go generate ./ && git diff'`, 'cd b', 'c', 'd']);
  const unit = (name: string, command: string) => ({ name, commands: [command] });
  const outside = (name: string, tool: string, segment: string) => `${name} runs ${tool} outside tests/run-long.mts, so it has no RUN line or step log: ${segment}`;
  const timed = (name: string, tool: string, form: string, segment: string) => `${name} runs ${tool} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unwrappedToolErrors([
    unit('tsc', 'node packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.json --noEmit'),
    unit('generate', 'go test ./packages/go/generator && cd packages/go/model && go generate ./'),
    unit('vet', 'go vet ./tests/conformance/runner_go'),
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
    outside('vet', 'go vet', 'go vet ./tests/conformance/runner_go'),
    outside('build', 'cargo build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration'),
    outside('npm', 'a TypeScript build', 'npm run typescript:build >/dev/null'),
    outside('later', 'go vet', 'go vet ./b'),
    timed('run-case', 'tsc', 'run-case.mjs', 'node tests/run-case.mjs typescript-types 5m -- node packages/ts/node_modules/typescript/bin/tsc --noEmit'),
    timed('make-case', 'cargo build', '$(RUN_CASE)', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd packages/rust -- cargo build --locked'),
    timed('timeout', 'go vet', 'timeout 300', 'node tests/run-long.mts vet -- timeout 300 go vet ./...'),
  ]);
});

// cargo test case는 저장소의 Makefile, 검증 명령, script와 최소 단위를 검사한다.
const runUnits = () => {
  const recipes = makeRecipes(text('Makefile'));
  const packageUnits = Object.entries(readPackage(join(repository.pathname, 'package.json')).scripts ?? {}).map(([name, command]) => ({ name: `package.json ${name}`, commands: [command] }));
  const files = new Set(trackedFiles('*'));
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command })));
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
    { name: 'bare', commands: ['$(WITH_TEST_ENV) cd packages/rust && cargo +$(T) test --locked --test a -- --nocapture'] },
    { name: 'built', commands: ['$(RUN_LONG) b --cwd packages/rust -- $(CARGO_LEASED) cargo +$(T) test --no-run --locked --test a', 'cd packages/rust && cargo +$(T) test --locked --test a'] },
    { name: 'copied', commands: ['cd packages/rust && $(CARGO_TEST) c -- cargo +$(T) test --locked --test a -- --nocapture', 'node tests/cargo-test.mts d -- cargo test --locked --lib'] },
    { name: 'timed', commands: ['node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a'] },
  ]), [message('bare', '--locked --test a'), message('built', '--locked --test a'),
    timed('timed', '--locked --test a', 'run-case.mjs', 'node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a')]);
});

caseTest('every build tool of the Makefile, package.json and the scripts runs under run-long', COMPUTE, () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/typescript/sqlite-test.mts'));
  assert.deepEqual(unwrappedToolErrors([...recipes, ...packageUnits.filter(unit => segments(unit.commands[0] ?? '').length > 1), ...scripts]), []);
});

// 재실행 case는 저장소의 workflow와 최소 workflow를 runner의 정체로 검사한다.
caseTest('the CI workflow runs no test runner outside make check', COMPUTE, () => {
  assert.deepEqual(ciRerunErrors(workflow, text('Makefile')), []);
});

caseTest('a workflow that runs a test runner after make check fails by identity', COMPUTE, () => {
  assert.equal(runnerIdentity('PATH="$HOME/.cargo/bin:$PATH" cargo +1.98.1 test --locked -p polyspec-orm codec'), 'cargo test');
  assert.equal(runnerIdentity("go test -v -timeout 0 ./packages/go/engine/ir -run '^$' -fuzz FuzzDecodeRequest -fuzztime=1s"), undefined);
  assert.equal(runnerIdentity('go run ./tests/interfaces/check --results tests/conformance/out'), undefined);
  assert.equal(runnerIdentity('node tests/go-test.mts -v -timeout 0 ./packages/go/engine -count=1'), 'go test');
  assert.equal(runnerIdentity('node tests/conformance/check/main.mts record --driver mysql out/go.json'), undefined);
  assert.equal(runnerIdentity('node --test tests/conformance/check/main.test.mts'), 'node test');
  assert.equal(runnerIdentity('php -d extension=x.so vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecTest.php'), 'phpunit vendor-php/bin/phpunit');
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
    'make check',
    '          make fuzz-check vet-again',
    '          go vet ./... && go test -v -timeout 0 ./...',
    '          (cd packages/rust && cargo test --locked -p polyspec-orm codec)',
    '          php packages/php/tests/CodecVectorsTest.php',
    '          node --test scripts/x.test.mjs',
    '          go run ./tests/interfaces/check --results tests/conformance/out',
  ].join('\n'));
  const message = (identity: string, via = '') => `ci.yml step "checks" runs ${identity}${via} outside make check; make check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`;
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

// 생성 case는 make check의 recipe와 검증 명령, 그리고 최소 단위를 검사한다.
caseTest('make check runs each go generate once', COMPUTE, () => {
  const targets = new Set(checkTargets(text('Makefile')));
  const { recipes } = runUnits();
  assert.deepEqual(repeatedGenerateErrors([...recipes.filter(unit => targets.has(unit.name.replace(/^Makefile /, ''))), ...featureUnits()]), []);
});

caseTest('a go generate that make check runs twice fails', COMPUTE, () => {
  assert.deepEqual(generateRuns(`$(RUN_LONG) go-model -- sh -c 'cd packages/go/model && go generate ./ && git diff --exit-code -- .'`), ['packages/go/model']);
  assert.deepEqual(generateRuns(`go test ./packages/go/generator && node tests/run-long.mts g --cwd packages/go/model -- sh -c 'go generate ./ && git diff'`), ['packages/go/model']);
  assert.deepEqual(generateRuns('cd packages/go/other && go generate ./'), ['packages/go/other']);
  assert.deepEqual(repeatedGenerateErrors([
    { name: 'Makefile go-model-check', commands: [`$(RUN_LONG) go-model -- sh -c 'cd packages/go/model && go generate ./ && git diff --exit-code -- .'`] },
    { name: 'contracts/features.json model_generation/generation-go', commands: [`node tests/run-long.mts g --cwd packages/go/model -- sh -c 'go generate ./ && git diff'`] },
    { name: 'other', commands: ['cd packages/go/other && go generate ./'] },
  ]), ['go generate of packages/go/model runs 2 times in make check: Makefile go-model-check, contracts/features.json model_generation/generation-go']);
});

// go test case는 저장소의 Makefile(변수를 푼), 검증 명령, script와 최소 단위를 검사한다.
caseTest('every go test runs through go-test.mts or run-long', COMPUTE, () => {
  const makefile = text('Makefile');
  const variables = makeVariables(makefile);
  const { recipes, scripts } = runUnits();
  const expanded = recipes.map(unit => ({ name: unit.name, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(rawGoTestErrors([...expanded, ...featureUnits(), ...scripts]), []);
});

caseTest('a go test without its build step, or under a deadline, fails', COMPUTE, () => {
  const message = (name: string, segment: string) => `${name} runs go test outside tests/go-test.mts, so its compile has no RUN line or step log: ${segment}`;
  const fuzz = "$(RUN_CASE) fuzz/ir 8m -- go test -v -timeout 0 ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s";
  assert.deepEqual(rawGoTestErrors([
    { name: 'raw', commands: ['go test -v -timeout 0 ./packages/go/orm -run X -count=1'] },
    { name: 'env', commands: ['ORM_RUN_PERF_GATE=1 go test -v ./packages/go/bench'] },
    { name: 'wrapped', commands: ['node tests/go-test.mts -v -timeout 0 ./packages/go/engine -count=1'] },
    { name: 'fuzz', commands: ["$(RUN_LONG) fuzz/ir -- go test -v -timeout 0 ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s"] },
    { name: 'build', commands: ['node tests/run-long.mts go-build -- go test -c -o x ./packages/go/engine/dbspec'] },
    { name: 'timed', commands: [fuzz] },
  ]), [message('raw', 'go test -v -timeout 0 ./packages/go/orm -run X -count=1'), message('env', 'ORM_RUN_PERF_GATE=1 go test -v ./packages/go/bench'),
    `timed runs go test under a deadline ($(RUN_CASE)); a long operation gets step logs and no deadline: ${fuzz}`]);
});

// 기한 case는 저장소의 Makefile(변수를 푼), 검증 명령, package.json script, run-long 아래의 것까지 모든
// script와 최소 단위를 검사한다.
caseTest('no check puts a deadline on a long operation', COMPUTE, () => {
  const makefile = text('Makefile');
  const variables = makeVariables(makefile);
  const { recipes, packageUnits } = runUnits();
  const files = new Set(trackedFiles('*'));
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command })));
  const scripts = reachedScripts(commands, readScript, { throughLong: true });
  assert.ok(scripts.some(unit => unit.name === 'scripts/package-check.mts'), 'the scripts under run-long are checked');
  const expanded = recipes.map(unit => ({ name: unit.name, commands: unit.commands.map(command => expand(command, variables)) }));
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
  assert.deepEqual(longDeadlineErrors(Object.entries(units).map(([name, command]) => ({ name, commands: [command] }))), [
    message('run-case', 'run-case.mjs', units['run-case']),
    message('make', '$(RUN_CASE)', units.make),
    message('variable', '$(BUILD_DEADLINE)', units.variable),
    message('timeout', 'timeout 600', units.timeout),
    message('go-default', 'go test without -timeout 0 (the default 10m)', units['go-default']),
    message('go-timeout', 'go test -timeout 10m', units['go-timeout']),
  ]);
});

// 전체 suite 규칙 case(G5.38-5)는 AGENTS.md와 AGENTS.ko.md가 전체 suite를 push 뒤 CI에서 실행한다는 규칙을 적고 이전의
// 로컬 규칙을 적지 않는지 확인한다.
caseTest('AGENTS states that the full suite runs on CI after a push', COMPUTE, () => {
  const read = (path: string) => readFileSync(new URL(path, repository), 'utf8');
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': read('AGENTS.md'), 'AGENTS.ko.md': read('AGENTS.ko.md') }), []);
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': 'The full suite (`make check`) runs exactly once, when every active checklist\n  item is complete.', 'AGENTS.ko.md': '' }).slice(0, 2), [
    'AGENTS.md does not state the full-suite rule: "runs on GitHub CI after a push"',
    'AGENTS.md does not state the full-suite rule: "collect enough information to fix every failure it found before the next CI run"',
  ]);
  assert.ok(fullSuiteRuleErrors({ 'AGENTS.md': 'runs exactly once, when every active checklist\n  item is complete', 'AGENTS.ko.md': '' })
    .includes('AGENTS.md still states the local full-suite rule: "runs exactly once, when every active checklist   item is complete"'));
});

// CI setup case(G5.52)는 workflow의 setup step이 실패해도 뒤의 step과 make check가 실행되고 그 실패를 runner에 넘기는지
// 본다. main의 workflow처럼 id 없는 install step, 조건 없는 step, continue-on-error, ORM_CI_SETUP 없는 make check는 오류다.
caseTest('a workflow runs every setup step and make check after a failed setup step and passes the results on', COMPUTE, () => {
  const setup = { go: 'go', rust: 'rust' };
  const runner = ['checkout'];
  const workflow = (steps: string, check: string) => `jobs:\n  test:\n    steps:\n${steps}${check}`;
  const good = workflow(`      - uses: actions/checkout@v5\n        id: checkout\n      - uses: actions/setup-go@v6\n        id: go\n        if: \${{ !cancelled() }}\n      - name: rust\n        id: rust\n        if: \${{ !cancelled() }}\n        run: rustup toolchain install\n`,
    `      - name: make check\n        if: \${{ !cancelled() }}\n        env:\n          ORM_CI_SETUP: \${{ toJSON(steps) }}\n        run: make check\n`);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good }, { setup, runner }), []);
  const bad = workflow(`      - uses: actions/checkout@v5\n        id: checkout\n      - uses: actions/setup-go@v6\n        with: { go-version: "1.27" }\n      - name: rust\n        id: rustup\n        continue-on-error: true\n        if: \${{ !cancelled() }}\n        run: rustup toolchain install\n`,
    `      - name: make check\n        run: make check\n`);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': bad }, { setup, runner }), [
    'ci.yml uses continue-on-error, which hides a failed step from the job; run later steps with if: ${{ !cancelled() }} instead',
    'ci.yml step "uses: actions/setup-go@v6" before make check has no id; give it the id of what it installs in scripts/check/ci-setup.mts',
    'ci.yml step "uses: actions/setup-go@v6" does not run after a failed earlier setup step; give it if: ${{ !cancelled() }}',
    'ci.yml step "rust" has the id rustup, which scripts/check/ci-setup.mts does not map to what it installs',
    'ci.yml has no setup step with the id go of scripts/check/ci-setup.mts',
    'ci.yml has no setup step with the id rust of scripts/check/ci-setup.mts',
    'ci.yml step "make check" does not run after a failed setup step; give it if: ${{ !cancelled() }}',
    'ci.yml step "make check" gives make check no ORM_CI_SETUP: ${{ toJSON(steps) }}, which tells the runner the failed setup steps',
  ]);
  // job마다 runner가 따로이므로 make check job 뒤의 docs job은 make check의 setup이나 그 뒤의 step이 아니다(G5.98).
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

// 독립 test case(G5.53)는 recipe 하나가 서로 다른 test나 lint 실행을 둘 이상 가지거나, 검증 명령이 `&&`로 test를 잇는
// 곳을 오류로 본다. 같은 test의 두 번째 실행, compile만 하는 줄, 입력을 만드는 줄, 의존성 도구의 build는 test가 아니다.
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
});


caseTest('a Go function does not call os.Exit after a defer', COMPUTE, () => {
  const leaking = `package main

func main() {
\tdirectory, _ := os.MkdirTemp("", "x-")
\tdefer os.RemoveAll(directory)
\t// os.Exit(3) in a comment is not a call
\tif failed() {
\t\tos.Exit(1)
\t}
}
`;
  const recovering = `package main

func main() {
\tdefer func() {
\t\tif recover() != nil {
\t\t\tos.Exit(1)
\t\t}
\t}()
}
`;
  const returning = `package main

func main() {
\tos.Exit(run())
}

func run() int {
\tdirectory, _ := os.MkdirTemp("", "x-")
\tdefer os.RemoveAll(directory)
\treturn 1
}

func usage() {
\tos.Exit(2)
}
`;
  const helper = `package main

func main() {
\tdb := open()
\tdefer db.Close()
\tcheck(db.Ping())
}

func check(err error) {
\tif err != nil {
\t\tfail(err)
\t}
}
`;
  const helperExit = `package main

func fail(err error) {
\tos.Exit(1)
}
`;
  assert.deepEqual(deferredExitErrors({ 'd/main.go': helper, 'd/fail.go': helperExit }), [
    'd/main.go:6: main calls check, which calls os.Exit, after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())',
  ]);
  assert.deepEqual(deferredExitErrors({ 'a/main.go': leaking, 'b/main.go': recovering, 'c/main.go': returning }), [
    'a/main.go:8: main calls os.Exit after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())',
    'b/main.go:6: main calls os.Exit after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())',
  ]);
  const tracked = execFileSync('git', ['ls-files', '*.go'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(deferredExitErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});

caseTest('Go code does not find its files through runtime.Caller', COMPUTE, () => {
  const caller = 'package p\n\nfunc root() string {\n\t_, file, _, _ := runtime.Caller(0)\n\treturn file\n}\n';
  const comment = 'package p\n\n// runtime.Caller(0) is not used here\nfunc root() string { return "." }\n';
  assert.deepEqual(callerPathErrors({ 'p/root_test.go': caller, 'p/doc.go': comment }), [
    'p/root_test.go:4: runtime.Caller gives the path the binary was compiled at, not the checkout that runs it; find files from the working directory (os.Getwd), which go test sets to the package directory',
  ]);
  const tracked = execFileSync('git', ['ls-files', '*.go'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(callerPathErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
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
  assert.deepEqual(ciMakeErrors({ '.github/workflows/ci.yml': workflow('node scripts/check/summary.mts', '      - name: deps\n        run: |\n          npm ci\n          make install-php\n') }), [
    '.github/workflows/ci.yml step "deps" runs npm ci; run it through a make target',
  ]);
  assert.deepEqual(ciMakeErrors({ '.github/workflows/docs-pages.yml': workflow('node scripts/check/summary.mts') }), [
    '.github/workflows/docs-pages.yml step "summary" runs node scripts/check/summary.mts; run it through a make target',
  ]);
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  assert.deepEqual(ciMakeErrors(Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [`.github/workflows/${name}`, readFileSync(join(directory, name), 'utf8')]))), []);
});

caseTest('a test does not fail on a measured time above a bound', COMPUTE, () => {
  assert.deepEqual(timeFailureErrors({
    'a_test.go': 'func TestA(t *testing.T) {\n\tif elapsed > parseBudget {\n\t\tt.Fatalf("slow")\n\t}\n}\n',
    'b.rs': '    assert!(cpu < Duration::from_secs(1), "cpu {cpu:?}");\n',
    'c.test.mjs': "    assert.ok(parseMs <= PARSE_BUDGET_MS, 'slow');\n",
    'd.php': "if ($cpuMs > 10000) {\n    throw new RuntimeException('slow');\n}\n",
  }).map(error => error.split(' fails ')[0]), ['a_test.go:2', 'b.rs:1', 'c.test.mjs:1', 'd.php:1']);
  // 경고, 하한, 두 측정의 비교, 0과의 비교는 실패가 아니거나 정확성 검사다.
  assert.deepEqual(timeFailureErrors({
    'e_test.go': 'func TestE(t *testing.T) {\n\tif elapsed > parseBudget {\n\t\ttestcase.Warn("slow")\n\t}\n}\n',
    'f.rs': '    assert!(waited >= Duration::from_millis(200), "too early");\n    assert!(cpu * 4 < wall, "clock");\n',
    'g.test.mjs': "    check(event.elapsed >= 0, 'negative');\n",
  }), []);
});

// trigger case(G5.98)는 ci.yml, push-gate.yml과 docs-pages.yml의 `on:` block이 선언과 같고, 다른 workflow가 push,
// pull_request, merge_group으로 실행하지 않는지 본다.
caseTest('every workflow runs on its declared events only', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  const actual = Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [`.github/workflows/${name}`, readFileSync(join(directory, name), 'utf8')]));
  assert.deepEqual(workflowTriggerErrors(actual), []);
  const text = (on: any[]) => `name: x\n${on.join('\n')}\n\njobs:\n  a:\n    runs-on: ubuntu\n`;
  const declared = Object.fromEntries(Object.entries(WORKFLOW_TRIGGERS).map(([path, on]) => [path, text(on)]));
  assert.deepEqual(workflowTriggerErrors(declared), []);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/ci.yml': text(['on:', '  pull_request:', '  push:', '    branches: [main]', '  workflow_dispatch:']) }), [
    '.github/workflows/ci.yml has the triggers on: pull_request: push: branches: [main] workflow_dispatch: instead of on: push: branches: [main] workflow_dispatch:',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/docs-pages.yml': text(['on:', '  push:', '    branches: [main]', '  pull_request:', '  workflow_dispatch:']) }), [
    '.github/workflows/docs-pages.yml has the triggers on: push: branches: [main] pull_request: workflow_dispatch: instead of on: push: branches: [main] workflow_dispatch:',
  ]);
  const { ['.github/workflows/push-gate.yml']: _, ...withoutGate } = declared;
  assert.deepEqual(workflowTriggerErrors({ ...withoutGate, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  pull_request:']) }), [
    ".github/workflows/push-gate.yml is missing; it runs on push: branches: ['**']",
    '.github/workflows/review.yml runs on pull_request; only ci.yml, push-gate.yml, docs-pages.yml and release.yml run on these events',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  workflow_dispatch:']) }), []);
  // release.yml은 version tag의 push에서만 실행한다(G5.113-3).
  assert.deepEqual(WORKFLOW_TRIGGERS['.github/workflows/release.yml'], ['on:', '  push:', "    tags: ['v*', '**/v*']"]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/release.yml': text(['on:', '  push:', '    branches: [main]']) }), [
    ".github/workflows/release.yml has the triggers on: push: branches: [main] instead of on: push: tags: ['v*', '**/v*']",
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
const goWorkflow = '    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make install-tools\n      - run: make check\n';
caseTest('every workflow runs the Go of mise.toml', COMPUTE, () => {
  assert.deepEqual(goVersionErrors({ 'ci.yml': goWorkflow }), []);
  assert.deepEqual(goVersionErrors({ 'ci.yml': goWorkflow.replace('      - run: make install-tools\n', '      - uses: actions/setup-go@v6\n        with: { go-version-file: go.mod }\n') }), [
    'ci.yml sets up Go with actions/setup-go; the Go of mise.toml is installed by make install-tools',
    'ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools',
  ]);
  assert.deepEqual(goVersionErrors({ 'ci.yml': '    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make check\n' }), [
    'ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools',
  ]);
});

// Go module path case(G5.113-5)는 저장소의 모든 go.mod가 자기 directory의 module path를 선언하는지 보고, 최소 file에서 다른
// path를 선언한 root와 하위 directory의 go.mod를 거부한다.
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

caseTest('every setup-php step installs the Composer of .composer-version', COMPUTE, () => {
  const php = '    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  assert.deepEqual(composerVersionErrors('2.10.3\n', { 'ci.yml': php }, '2.10.3'), []);
  assert.deepEqual(composerVersionErrors('2.10.3\n', { 'ci.yml': php.replace('          tools: composer:2.10.3\n', '') }, '2.11.0'), [
    'ci.yml sets up PHP without tools: composer:2.10.3; setup-php installs the newest Composer otherwise, so add tools: composer:2.10.3',
    'Composer 2.11.0 runs the checks; .composer-version declares 2.10.3, so its major and minor must be 2.10; install Composer 2.10.3 (composer self-update 2.10.3) or change .composer-version together with the CI evidence of the new release',
  ]);
});

// T70: 실행 중인 Composer는 선언한 release와 major.minor가 같으면 patch와 상관없이 받아들인다.
caseTest('a running Composer with the declared major and minor passes whatever its patch', COMPUTE, () => {
  const php = '    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  for (const running of ['2.10.3', '2.10.0', '2.10.9'])
    assert.deepEqual(composerVersionErrors('2.10.3\n', { 'ci.yml': php }, running), [], running);
  for (const running of ['2.9.9', '2.11.0'])
    assert.deepEqual(composerVersionErrors('2.10.3\n', { 'ci.yml': php }, running), [
      `Composer ${running} runs the checks; .composer-version declares 2.10.3, so its major and minor must be 2.10; install Composer 2.10.3 (composer self-update 2.10.3) or change .composer-version together with the CI evidence of the new release`,
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
    '\tnode packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.build.json',
    '\tnode packages/ts/node_modules/typescript/bin/tsc -p packages/ts/tsconfig.json --noEmit',
    '# go build -o $(LEASE) in a comment',
  ].join('\n');
  assert.deepEqual(unpublishedOutputErrors(makefile).map(error => error.split(', so ')[0]), [
    'Makefile:1 writes a Go build output in place',
    'Makefile:4 redirects a command into a file in place',
    'Makefile:7 runs tsc into dist in place',
  ]);
  assert.deepEqual(unpublishedOutputErrors(readFileSync(new URL('../../Makefile', import.meta.url), 'utf8')), []);
});

caseTest('a failure message for a missing condition names its fix', COMPUTE, () => {
  // fixture의 문구는 이어 붙여 만든다: 이 file도 검사 대상이다.
  const required = ['is', 'required'].join(' ');
  const files: Record<string, string> = {
    'tests/a.mjs': `if (!dsn) throw new Error('ORM_TEST_MYSQL_DSN ${required}; database tests never skip');\n// ORM_TEST_MYSQL_DSN ${required} in a comment\n`,
    'tests/b_test.go': `\tt.Fatal("ORM_TEST_MYSQL_DSN ${required}; run the test through its make target, which reads the environment of make test-servers")\n`,
    'scripts/c.sh': `: "\${BENCH_DSN:?BENCH_DSN ${required}}"\ncommand -v x >/dev/null || { echo "x ${['is', 'not', 'installed'].join(' ')}; run make install-server-programs" >&2; exit 1; }\n`,
  };
  assert.deepEqual(fixlessMessageErrors(files).map(error => error.split(': a failure')[0]), ['tests/a.mjs:1', 'scripts/c.sh:1']);
});

caseTest('no Makefile or script fixes a TCP port of the test servers', COMPUTE, () => {
  const makefile = ['TEST_MYSQL_PORT = 33171', '# TEST_POSTGRES_PORT = 55471', 'test-servers:', '\tnode scripts/test-servers.mts start $(TEST_MYSQL_PORT)', '\tnode scripts/test-servers.mts start'].join('\n');
  assert.deepEqual(fixedPortErrors({ Makefile: makefile, 'scripts/a.sh': 'export PGPORT=5432\nport=$(node scripts/free-ports.mts 1)\n' }).map(error => error.split(' fixes ')[0]), [
    'Makefile:1', 'Makefile:4', 'scripts/a.sh:1',
  ]);
  const tracked = execFileSync('git', ['ls-files', 'Makefile', '*.sh'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(fixedPortErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});
