import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import { AFTER_GROUP_CHECK, CI_PASSED_STEP, ciPassedErrors, ciGroups, GROUP_NEEDS, chainedCommandErrors, concurrencyErrors, workflowTriggerErrors, WORKFLOW_TRIGGERS, ciMakeErrors, checkTargets, ciAfterCheckErrors, ciSetupErrors, independentTestErrors, fullSuiteRuleErrors, ciCheckTargetErrors, ciDuplicateCommandErrors, ciLeaseErrors, ciRerunErrors, ciServerErrors, expand, featureCommands, makeVariables, runnerErrors, runnerIdentity, serverVariables, stepTimeoutErrors } from './ci.mjs';
import { nodeVersionErrors } from './node.mjs';
import { fixlessMessageErrors } from './messages.mjs';
import { binExeErrors, manifestDirErrors, runFile, targetPathErrors } from './target.mjs';
import { connectProbeErrors } from './probes.mjs';
import { composerVersionErrors, goVersionErrors, phpVersionErrors, rustToolchainErrors } from './toolchains.mjs';
import { execFileSync } from 'node:child_process';
import { CI_SETUP, groupOutputs, RUNNER_STEPS, stepCondition } from '../check/ci-setup.mjs';
import { scriptPathErrors, toolingLanguageErrors } from './scripts.mjs';
import { callerPathErrors, deferredExitErrors, detachedGroupErrors, timeFailureErrors } from './gosource.mjs';
import { generateRuns, goRunErrors, goTestCaseErrors, longDeadlineErrors, makeRecipes, fixedPortErrors, runtimePathErrors, sharedTargetErrors, unpublishedOutputErrors, typescriptHolderErrors, typescriptReaderErrors, unleasedCargoErrors, nodeTestErrors, rawGoTestErrors, reachedScripts, repeatedGenerateErrors, reportingScriptErrors, rustTestCaseErrors, segments, testEntries, unbuiltCargoTestErrors, unwrappedToolErrors } from './testcases.mjs';

const tracked = ['scripts/docs/rules.mjs', 'clients/typescript/package.json', 'scripts/typescript/sqlite-test.sh'];

caseTest('a script path must be a tracked file or directory', COMPUTE, () => {
  assert.deepEqual(scriptPathErrors({ 'schema:check': 'node scripts/schema/check.mjs' }, tracked), [
    'package.json script schema:check names scripts/schema/check.mjs, which is not a tracked file or directory',
  ]);
  assert.deepEqual(
    scriptPathErrors(
      {
        'docs:rules-check': 'node scripts/docs/rules.mjs',
        'typescript:build': 'npm --prefix clients/typescript run build',
        'typescript:test': 'npm run typescript:build && ./scripts/typescript/sqlite-test.sh',
        'docs:dev': 'vitepress dev docs',
      },
      tracked,
    ),
    [],
  );
});

const servers = readFileSync(new URL('../test-servers.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

caseTest('the CI workflow provides every variable of make test-servers', COMPUTE, () => {
  const variables = serverVariables(servers);
  for (const variable of ['ORM_TEST_MYSQL_REPLICA_DSN', 'ORM_TEST_POSTGRES_REPLICA_DSN', 'ORM_TEST_PROXYSQL_DSN',
    'ORM_TEST_PGBOUNCER_DSN', 'ORM_TEST_PGBOUNCER_SINGLE_DSN', 'ORM_TEST_MYSQL_TLS_DSN', 'ORM_RUN_MYSQL_DSN', 'ORM_RUN_POSTGRES_DSN',
    'ORM_RUN_SQLITE_QUERY', 'ORM_TEST_SERVERS_LEASES'])
    assert.ok(variables.includes(variable), `${variable} is not read from scripts/test-servers.sh`);
  assert.deepEqual(ciServerErrors(workflow, servers), []);
});

// steps와 script는 workflow와 test-servers.sh의 최소 형태다. 각 case는 그 하나를 바꾼다.
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
const script = [
  `cat > "$ENV_FILE.tmp" <<END`,
  `export ORM_TEST_MYSQL_DSN='$mysql/orm_test'`,
  `export ORM_TEST_PGBOUNCER_DSN='postgres://orm@127.0.0.1:$PGBOUNCER_PORT/orm_test'`,
  'END',
  '',
].join('\n');

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
  const summary = ['      - name: summary', '        if: ${{ !cancelled() }}', '        env:', '          ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}', '        run: node scripts/check/summary.mjs'];
  const report = ['      - name: report', '        if: ${{ !cancelled() }}', '        uses: actions/upload-artifact@v4', '        with:', '          name: check-${{ github.run_id }}-${{ github.run_attempt }}',
    '          path: .runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}/report/', '          if-no-files-found: error'];
  const workflow = (...steps) => ['jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v5', '      - name: install', '        run: npm ci', ...steps.flat(), ''].join('\n');
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
  assert.match(ciAfterCheckErrors({ 'ci.yml': workflow(check, summary, report, other) })[0], /^ci\.yml step "uses: actions\/cache@v4" runs - uses: actions\/cache@v4 after make check/);
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
const minimum = JSON.parse(readFileSync(new URL('package.json', repository), 'utf8')).engines.node;
const workflows = Object.fromEntries(readdirSync(new URL('.github/workflows/', repository)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(new URL(`.github/workflows/${name}`, repository), 'utf8')]));

caseTest('the checks and every workflow run the Node of .node-version', COMPUTE, () => {
  assert.deepEqual(Object.keys(workflows), ['.github/workflows/ci.yml', '.github/workflows/docs-pages.yml', '.github/workflows/push-gate.yml']);
  assert.deepEqual(nodeVersionErrors(declared, minimum, workflows, process.versions.node), []);
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
const text = path => readFileSync(new URL(path, repository), 'utf8');
const runningPhp = execFileSync('php', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']).toString();
const runningRustc = /^rustc (\S+)/.exec(execFileSync('rustc', ['--version'], { cwd: repository }).toString())[1];

caseTest('the checks and every workflow run the PHP of .php-version and the Rust of rust-toolchain.toml', COMPUTE, () => {
  const composer = JSON.parse(text('clients/php/composer.json'));
  assert.deepEqual(phpVersionErrors(text('.php-version'), composer.require.php, workflows, runningPhp), []);
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
  '      - run: composer install --working-dir=clients/php',
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
  assert.deepEqual(phpVersionErrors('8.3\n', '>=8.4', {}, '8.3'), ['.php-version 8.3 is below clients/php/composer.json require.php >=8.4']);
  assert.deepEqual(phpVersionErrors('8.5.10\n', '>=8.4', {}, '8.5'), ['.php-version must hold one release x.y and a newline, found "8.5.10\\n"']);
  assert.deepEqual(phpVersionErrors('8.5\n', '^8.4', {}, '8.5'), ['clients/php/composer.json require.php must be ">=x.y", found "^8.4"']);
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
  '      - run: (cd clients/rust && cargo test --locked)',
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
  for (const target of ['ts-min-check', 'php-min-check', 'feature-check', 'go-test-check'])
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
  assert.ok(workflow.includes('        run: make check GROUP=${{ matrix.group }}\n'), 'ci.yml runs make check for the group of its matrix');
  assert.deepEqual(ciCheckTargetErrors(workflow, makefile), []);
});

caseTest('a CI group set that omits, repeats or adds a target of CHECK_TARGETS fails', COMPUTE, () => {
  const grouped = (matrix = '[one, two]') => `jobs:\n  test:\n    strategy:\n      matrix:\n        group: ${matrix}\n    steps:\n      - name: make check\n        run: make check GROUP=\${{ matrix.group }}\n`;
  const make = groups => ['CHECK_TARGETS = a-check b-check c-check', ...groups, ''].join('\n');
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
  assert.deepEqual(ciCheckTargetErrors(grouped(), make([])), ['ci.yml runs make check GROUP=${{ matrix.group }}, but the Makefile declares no CI_GROUPS']);
  assert.deepEqual(ciCheckTargetErrors(grouped().replace('    strategy:\n      matrix:\n        group: [one, two]\n', ''), good), [
    'ci.yml job test runs make check GROUP=${{ matrix.group }} without a matrix group: [...] of CI_GROUPS',
  ]);
  // group job도 CHECK_TARGETS의 target을 따로 실행하면 두 번 실행한다.
  assert.deepEqual(ciCheckTargetErrors(grouped().replace('GROUP=${{ matrix.group }}\n', 'GROUP=${{ matrix.group }}\n      - name: again\n        run: make b-check\n'), good), [
    'ci.yml step "again" runs b-check, which make check runs',
  ]);
});

// CI group setup case(G5.111)는 group job의 setup step이 scripts/check/ci-setup.mjs가 선언한 조건으로만 실행되는지, group-needs
// step이 make ci-group-needs의 output을 쓰는지, 그 뒤의 summary와 report가 group마다의 실행 id와 보고서를 쓰는지 본다.
caseTest('a CI group job runs each setup step under its declared condition and reports per group', COMPUTE, () => {
  assert.equal(stepCondition('go'), '${{ !cancelled() }}');
  assert.equal(stepCondition('composer'), "${{ !cancelled() && steps.group-needs.outputs.php == 'true' }}");
  assert.equal(stepCondition('servers'), "${{ !cancelled() && steps.group-needs.outputs.databases == 'true' }}");
  assert.deepEqual(groupOutputs(['a', 'b'], { a: ['go', 'composer'], b: ['databases'] }),
    { 'node-modules': false, rust: false, php: true, 'php-extension-tools': false, 'server-programs': true, databases: true });
  assert.throws(() => groupOutputs(['x'], {}), /target x declares no needs in contracts\/check-inputs\.json; declare its scope and needs there/);
  const setup = { 'group-needs': null, go: 'go', composer: 'composer', servers: 'databases' };
  const runner = ['checkout'];
  const check = `      - name: make check\n        if: \${{ !cancelled() }}\n        env:\n          ORM_CHECK_RUN_ID: \${{ github.run_id }}-\${{ github.run_attempt }}-\${{ matrix.group }}\n          ORM_CI_SETUP: \${{ toJSON(steps) }}\n          ORM_GIT_RANGE: \${{ github.event_name == 'pull_request' && format('{0}..{1}', github.event.pull_request.base.sha, github.event.pull_request.head.sha) || github.event_name == 'merge_group' && format('{0}..{1}', github.event.merge_group.base_sha, github.event.merge_group.head_sha) || '' }}\n        run: make check GROUP=\${{ matrix.group }}\n`;
  const after = AFTER_GROUP_CHECK.map(lines => lines.map((line, index) => `${index === 0 ? '      ' : '        '}${line.startsWith('ORM_') || line.startsWith('name: check') || line.startsWith('path:') || line.startsWith('if-no') ? '  ' : ''}${line}`).join('\n')).join('\n') + '\n';
  const job = (needs, composer) => `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v5\n        id: checkout\n      - name: setup of the CI group\n        id: group-needs\n        if: \${{ !cancelled() }}\n        run: ${needs}\n      - uses: actions/setup-go@v6\n        id: go\n        if: \${{ !cancelled() }}\n      - name: install PHP dependencies\n        id: composer\n        if: ${composer}\n        run: make install-php\n      - name: database servers\n        id: servers\n        if: ${stepCondition('servers')}\n        run: make test-servers\n${check}${after}`;
  const good = job(GROUP_NEEDS, stepCondition('composer'));
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good }, { setup, runner }), []);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': good }), []);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': job(GROUP_NEEDS, '${{ !cancelled() }}') }, { setup, runner }), [
    `ci.yml step "install PHP dependencies" of the CI group job runs under if: \${{ !cancelled() }} instead of if: ${stepCondition('composer')}, the condition that scripts/check/ci-setup.mjs declares for the step composer`,
  ]);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': job('make ci-group-needs GROUP=static >> "$GITHUB_OUTPUT"', stepCondition('composer')) }, { setup, runner }), [
    `ci.yml step "setup of the CI group" runs make ci-group-needs GROUP=static >> "$GITHUB_OUTPUT" instead of ${GROUP_NEEDS}, which writes the setup of the CI group as step outputs`,
  ]);
  // group마다의 보고서가 아닌 report step과 group 없는 실행 id는 group의 보고서를 서로 덮는다.
  const shared = good.replace('name: check-${{ matrix.group }}-', 'name: check-');
  assert.match(ciAfterCheckErrors({ 'ci.yml': shared })[0], /^ci\.yml step "report" after make check is not the declared report step: /);
  assert.deepEqual(ciAfterCheckErrors({ 'ci.yml': good.replace('${{ github.run_attempt }}-${{ matrix.group }}\n          ORM_CI_SETUP', '${{ github.run_attempt }}\n          ORM_CI_SETUP') }), [
    'ci.yml step "make check" gives make check no ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.group }}, which names the report of the run',
  ]);
});

// ci-passed case(G5.113-2)는 저장소의 ci.yml이 job ci-passed를 마지막에 두고 다른 모든 job을 needs로 받는지 보고, 최소
// workflow에서 빠진 job, 마지막이 아닌 job, always()가 아닌 조건, 다른 step을 거부한다.
caseTest('the job ci-passed runs last under always() and needs every other job', COMPUTE, () => {
  assert.deepEqual(ciPassedErrors(workflow), []);
  const step = `    steps:\n      ${CI_PASSED_STEP[0]}\n        ${CI_PASSED_STEP[1]}\n          ${CI_PASSED_STEP[2]}\n        ${CI_PASSED_STEP[3]}\n`;
  const job = (condition, needs) => `  ci-passed:\n    if: ${condition}\n    needs: [${needs}]\n    runs-on: ubuntu-26.04-arm\n${step}`;
  const others = '  test:\n    steps:\n      - run: make check\n  docs:\n    steps:\n      - run: make docs-ci\n';
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs')}`), []);
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}`), ['ci.yml has no job ci-passed, the check that the ruleset requires; add it as the last job with if: ${{ always() }} and needs: every other job']);
  assert.deepEqual(ciPassedErrors(`jobs:\n${job('${{ success() }}', 'test, pages')}${others}`), [
    'ci.yml job ci-passed is not the last job; move it after docs',
    'ci.yml job ci-passed does not run with if: ${{ always() }}, so a failed or cancelled job skips it instead of failing it',
    'ci.yml job ci-passed does not need the job docs; list every other job under needs',
    'ci.yml job ci-passed needs pages, which is no other job of ci.yml',
  ]);
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace('make ci-passed', 'true')}`)[0], /^ci\.yml job ci-passed has the steps .* instead of - name: every job passed/);
});

// 중복 실행 case는 저장소의 workflow, Makefile, feature contract와 최소 workflow를 검사한다.
caseTest('the CI workflow does not run a verification command of feature-check again', COMPUTE, () => {
  const commands = featureCommands(JSON.parse(text('contracts/features.json')));
  for (const command of ['./scripts/perf-test.sh', 'PATH="$HOME/.cargo/bin:$PATH" node tests/go-run.mjs interfaces-check ./tests/interfaces/check --self-test'])
    assert.ok(commands.includes(command), `${command} is not a verification command of contracts/features.json`);
  assert.deepEqual(ciDuplicateCommandErrors(workflow, text('Makefile'), commands), []);
});

caseTest('a workflow that runs a verification command of feature-check again fails', COMPUTE, () => {
  const make = [
    'CHECK_TARGETS = feature-check',
    'interface-check:',
    '\tPATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test',
    'perf-check:',
    '\t$(WITH_TEST_ENV) ./scripts/perf-test.sh',
    'fuzz-check:',
    "\tgo test ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest",
    '',
  ].join('\n');
  const commands = featureCommands({ features: [{ verification: [
    { id: 'interfaces', command: 'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test' },
    { id: 'perf', command: './scripts/perf-test.sh' },
    { id: 'elsewhere', command: 'php tests/codec/check.php', cwd: 'clients/php' },
  ] }] });
  assert.deepEqual(commands, ['PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test', './scripts/perf-test.sh']);
  const twice = steps.replace('make repo-check', 'make check\n          make interface-check fuzz-check\n          ./scripts/perf-test.sh\n          php tests/codec/check.php');
  assert.deepEqual(ciDuplicateCommandErrors(twice, make, commands), [
    'ci.yml step "checks" runs make interface-check, whose commands make check runs in feature-check',
    'ci.yml step "checks" runs ./scripts/perf-test.sh, which make check runs in feature-check',
  ]);
  assert.deepEqual(ciDuplicateCommandErrors(steps.replace('make repo-check', 'make check\n          make fuzz-check'), make, commands), []);
});

// runner case는 저장소의 .github/runner와 workflow, 그리고 최소 workflow를 검사한다.
caseTest('every workflow job runs on the runner of .github/runner', COMPUTE, () => {
  assert.equal(text('.github/runner'), 'ubuntu-26.04-arm\n');
  assert.deepEqual(runnerErrors(text('.github/runner'), workflows), []);
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
    '      - run: composer install --working-dir=clients/php',
    '',
  ].join('\n');
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum }, '8.5'), []);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum.replace('        id: php-min\n', '') }, '8.5'), [
    'ci.yml reads steps.php-min.outputs.version without the step that writes it from ./scripts/php/php-min.sh',
  ]);
  const reversed = minimum.replace('          php-version: ${{ steps.php-min.outputs.version }}', '          php-version-file: .php-version#')
    .replace('          php-version-file: .php-version\n          coverage: none\n      - run', '          php-version: ${{ steps.php-min.outputs.version }}\n          coverage: none\n      - run').replace('.php-version#', '.php-version');
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': reversed }, '8.5'), [
    'ci.yml must set up the PHP of .php-version last, so that it is php on PATH',
  ]);
});

// socket case는 test-servers.sh를 깊은 checkout 경로의 scripts/ 아래에 복사해 실행한다. script는
// 자기 위치에서 .runtime/servers를 정하므로, 그 경로의 socket이 platform 한도(Linux 107, macOS 103
// byte)를 넘으면 서버를 시작하기 전에 그 path와 한도를 말하고 실패해야 한다.
caseTest('test-servers.sh refuses a socket path longer than the platform limit', PROCESS, () => {
  const limit = { linux: 107, darwin: 103 }[process.platform];
  assert.ok(limit, `no socket path limit for ${process.platform}`);
  // base는 /tmp 아래에 둔다: case에는 가장 짧은 mysql.sock은 한도 안에 드는 root가 필요하지만, 단계의 임시
  // directory(TMPDIR, macOS에서는 /var/folders/... 아래의 orm-step-*)는 그 자체로 한도에 가깝다.
  const base = mkdtempSync('/tmp/orm-sock-');
  assert.ok(Buffer.byteLength(join(base, '.runtime/servers/mysql.sock')) <= limit, `${base} leaves no room under the socket path limit`);
  try {
    // 첫 경로는 가장 짧은 mysql.sock도 한도를 넘고, 둘째 경로는 가장 긴
    // proxysql-admin-pgsql.sock만 넘는다. 실패는 넘은 첫 socket을 말한다.
    const fits = name => root => Buffer.byteLength(join(root, '.runtime/servers', name)) <= limit;
    const deep = (name, keep) => {
      let root = base;
      while (fits(name)(root)) {
        const next = join(root, 'd');
        if (keep && !keep(next)) root = `${root}x`; else root = next;
      }
      return root;
    };
    const system = process.platform === 'linux' ? 'Linux' : 'macOS';
    for (const [root, name] of [[deep('mysql.sock'), 'mysql.sock'], [deep('proxysql-admin-pgsql.sock', fits('mysql.sock')), 'proxysql-admin-pgsql.sock']]) {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(new URL('../test-servers.sh', import.meta.url), join(root, 'scripts/test-servers.sh'));
      const result = spawnSync('sh', [join(root, 'scripts/test-servers.sh'), 'start'], { encoding: 'utf8' });
      const socket = join(root, '.runtime/servers', name);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, `test-servers: socket path ${socket} is ${Buffer.byteLength(socket)} bytes; ${system} allows at most ${limit}\n`);
      assert.equal(existsSync(join(root, '.runtime/servers')), false, 'the servers directory was created');
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
    '\t$(RUN_LONG) rust-build/x --cwd clients/rust -- cargo build --locked --example x',
    '\tX=$(CARGO_TARGET_DIR)/debug/examples/x go test ./a',
    'copied:',
    '\t$(RUN_LONG) rust-build/y --cwd clients/rust -- $(CARGO_COPY) debug/y -- cargo build --locked --bin y',
    '\t$(RUN_LONG) rust-build/z -- $(CARGO_LEASED) cargo test --no-run --locked',
    '\t# $(CARGO_TARGET_DIR)/debug/y in a comment',
    '',
  ].join('\n');
  assert.deepEqual(sharedTargetErrors(makefile), [
    'Makefile:1 uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): DOCUMENT = $(CARGO_TARGET_DIR)/dbspec/stress.dbs',
    'Makefile:4 uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): X=$(CARGO_TARGET_DIR)/debug/examples/x go test ./a',
    'Makefile run builds into the shared Rust target directory without its lease; run the build under $(CARGO_LEASED) or $(CARGO_COPY): $(RUN_LONG) rust-build/x --cwd clients/rust -- cargo build --locked --example x',
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
  const scripts = reachedScripts(commands, path => files.has(path) ? text(path) : undefined, { throughLong: true });
  assert.deepEqual(unleasedCargoErrors([...featureUnits(), ...packageUnits, ...scripts]), []);
  const unit = (name, command) => ({ name, commands: [command] });
  const build = segment => `x builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`;
  assert.deepEqual(unleasedCargoErrors([
    unit('x', 'node tests/run-long.mjs b -- cargo build --locked'),
    unit('x', '"$LEASE" run "$CARGO_LEASES" exclusive --wait -- cargo test --no-run --locked'),
    unit('x', 'node tests/cargo-test.mjs a -- cargo test --locked --test a'),
    unit('x', '"${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a'),
  ]), [build('node tests/run-long.mjs b -- cargo build --locked'),
    'x runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.sh): "${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a']);
});

// TypeScript 읽기 case는 저장소의 Makefile과 최소 Makefile, file을 검사한다.
caseTest('a target that runs code using the TypeScript build output holds it', COMPUTE, () => {
  const files = new Set(trackedFiles('*'));
  assert.deepEqual(typescriptReaderErrors(text('Makefile'), path => files.has(path) ? text(path) : undefined), []);
  const sources = {
    'scripts/reads.mjs': "const run = ['node', ['clients/typescript/tests/db.mjs']];\n",
    'clients/typescript/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n",
    'scripts/quoted.mjs': "const fixture = \"import { Db } from '../dist/index.js';\";\n",
  };
  const makefile = 'reader:\n\tnode scripts/reads.mjs\nheld:\n\t$(READ_TYPESCRIPT)\n\tnode scripts/reads.mjs\nquoted:\n\tnode --test scripts/quoted.mjs\n';
  assert.deepEqual(typescriptReaderErrors(makefile, path => sources[path]), [
    'Makefile reader runs scripts/reads.mjs, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)',
  ]);
});

// 이름만 적는 case(G5.40)는 TypeScript test의 경로를 실행하지 않고 문자열로만 적는 test(가짜 node의 기대 출력, stub
// template, 정규식)를 읽는 것으로 세지 않고, 그 경로를 node로 실행하는 file(program과 인자 배열, exec나 spawn의 shell
// 문자열)은 여전히 읽는 것으로 세며, 여러 줄에 걸친 import도 읽는 것으로 세는지 확인한다.
caseTest('a test that only names a TypeScript test path does not read the build output', COMPUTE, () => {
  const sources = {
    'clients/typescript/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n",
    'scripts/names.test.mjs': [
      "assert.deepEqual(ran, ['node clients/typescript/tests/db.mjs']);",
      "assert.match(stderr, /node clients\\/typescript\\/tests\\/db\\.mjs \\(exit 3\\)/);",
      "const stub = `#!/bin/sh\\necho \"node $*\" >> log # node clients/typescript/tests/db.mjs`;",
      '',
    ].join('\n'),
    'scripts/array.mjs': "const run = ['node', ['clients/typescript/tests/db.mjs']];\n",
    'scripts/exec-path.mjs': "spawnSync(process.execPath, ['clients/typescript/tests/db.mjs', '--x']);\n",
    'scripts/shell.mjs': "execSync('node --conditions=orm-test clients/typescript/tests/db.mjs');\n",
    // 여러 줄의 import는 읽는 것이다. 함수 본문 뒤 주석에 적은 import 예시는 아니다.
    'clients/typescript/tests/multi.mjs': "import {\n  Db,\n  OrmError as Failure,\n} from '../dist/index.js';\n",
    'scripts/multi.mjs': "const run = ['node', ['clients/typescript/tests/multi.mjs']];\n",
    'scripts/comment.mjs': "export function f(a) {\n  // an import may span lines: `import {\\n  a,\\n} from '../dist/index.js'`\n}\n",
  };
  const makefile = 'names:\n\tnode --test scripts/names.test.mjs\narray:\n\tnode scripts/array.mjs\nexec-path:\n\tnode scripts/exec-path.mjs\nshell:\n\tnode scripts/shell.mjs\nmulti:\n\tnode scripts/multi.mjs\ncomment:\n\tnode scripts/comment.mjs\n';
  const reader = (target, file) => `Makefile ${target} runs ${file}, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)`;
  assert.deepEqual(typescriptReaderErrors(makefile, path => sources[path]), [
    reader('array', 'scripts/array.mjs'), reader('exec-path', 'scripts/exec-path.mjs'), reader('shell', 'scripts/shell.mjs'), reader('multi', 'scripts/multi.mjs'),
  ]);
});

// go run case는 최소 단위를 검사한다. 저장소 전체는 repository check가 본다.
caseTest('a go run, whose build has no step log, fails', COMPUTE, () => {
  assert.deepEqual(goRunErrors([
    { name: 'raw', commands: ['go run ./tests/interfaces/check --self-test'] },
    { name: 'env', commands: ['PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x'] },
    { name: 'wrapped', commands: ['node tests/go-run.mjs interfaces-check ./tests/interfaces/check --self-test'] },
  ]), [
    'raw runs go run, whose build has no step log; run it through tests/go-run.mjs: go run ./tests/interfaces/check --self-test',
    'env runs go run, whose build has no step log; run it through tests/go-run.mjs: PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x',
  ]);
});

// 언어 case는 저장소의 tracked file과 최소 목록을 검사한다.
caseTest('every tool of the repository is written in Go, PHP, Rust or TypeScript', COMPUTE, () => {
  assert.deepEqual(toolingLanguageErrors(trackedFiles('*')), []);
  assert.deepEqual(toolingLanguageErrors(['scripts/stop-process.py', 'tests/stop-process/main.go', 'scripts/a.sh', 'tools/x.rb', 'clients/php/src/Db.php']), [
    'scripts/stop-process.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tools/x.rb is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
});

// start_logged case는 test-servers.sh의 start_logged를 그대로 꺼내 가짜 서버로 실행한다. 서버 시작은 장기
// 작업이므로 기한이 없다. 준비 줄을 쓰고 계속 실행하면 start_logged는 서버가 끝나기 전에 돌아와야 하고
// (Ubuntu의 mawk처럼 pipe를 block 단위로 읽는 reader는 서버가 끝날 때까지 줄을 넘기지 않는다), 준비 줄
// 앞의 줄은 stderr에 보인다. 1.5초 뒤에야 준비 줄을 쓰는 느리지만 정상인 서버도 시작하고, 준비 줄 없이
// 끝나는 서버는 log와 함께 실패한다.
caseTest('start_logged waits for a ready line or an exit, with no deadline', COMPUTE, () => {
  const script = readFileSync(new URL('../test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('start_logged() {');
  const body = script.slice(start, script.indexOf('\n}\n', start) + 3);
  assert.ok(start >= 0 && body.endsWith('}\n'), 'start_logged is absent from scripts/test-servers.sh');
  assert.doesNotMatch(body, /\bsleep\b|\btimeout\b|deadline=/, 'start_logged has a timer');
  assert.ok(!script.split('\n').some(text => !/^\s*#/.test(text) && /\bpg_ctl\b.*\s-w\b/.test(text)), 'pg_ctl -w waits at most 60 s');
  const dir = mkdtempSync(join(tmpdir(), 'orm-logged-'));
  try {
    // 출력은 file로 받는다: 계속 실행하는 가짜 서버와 reader는 pipe를 열어 두므로, pipe로 받으면
    // spawnSync가 shell이 끝난 뒤에도 서버가 끝날 때까지 기다린다.
    const newSession = process.env.NEW_SESSION;
    assert.ok(newSession, 'NEW_SESSION is unset; run make repo-check, which builds it');
    const run = server => {
      const out = join(dir, 'stdout'), err = join(dir, 'stderr');
      const status = spawnSync('sh', ['-c', `set -eu\nDIR=${dir}\nNEW_SESSION=${newSession}\n${body}\nstart_logged fake 'accepting connections' sh -c '${server}'\necho returned`],
        { stdio: ['ignore', openSync(out, 'w'), openSync(err, 'w')], timeout: 20_000 }).status;
      return { status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
    };
    const alive = () => spawnSync('sh', ['-c', `kill -0 $(cat ${dir}/fake.pid)`]).status === 0;
    const ready = run('echo starting; echo now accepting connections; echo serving; exec sleep 30');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout, 'returned\n');
    assert.equal(ready.stderr, 'test-servers: fake: starting\ntest-servers: fake: now accepting connections\n');
    // start_logged는 서버가 끝나기 전에 돌아왔다: 돌아온 뒤에도 서버가 실행 중이다.
    assert.ok(alive(), 'start_logged returned only after the server ended');
    // 서버는 시작한 명령의 process group 밖, 자기 session에서 실행된다(G5.62).
    const groupOf = pid => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    const server = readFileSync(join(dir, 'fake.pid'), 'utf8').trim();
    assert.notEqual(groupOf(server), groupOf(process.pid), 'the server runs in the process group of the command that started it');
    assert.match(readFileSync(join(dir, 'fake.log'), 'utf8'), /^starting\nnow accepting connections\n/);
    spawnSync('sh', ['-c', `kill $(cat ${dir}/fake.pid)`]);
    rmSync(join(dir, 'fake.log'));
    // 느린 서버는 준비 줄 바로 앞에 marker file을 만든다. start_logged가 돌아왔을 때 그 file이 있으면 준비 줄을
    // 기다린 것이다. 앞의 줄에 돌아왔다면 file은 아직 없다.
    const slow = run(`echo starting; sleep 1.5; echo still starting; sleep 1; touch ${dir}/ready-marker; echo now accepting connections; exec sleep 30`);
    assert.equal(slow.status, 0, slow.stderr);
    assert.equal(slow.stdout, 'returned\n');
    assert.equal(slow.stderr, 'test-servers: fake: starting\ntest-servers: fake: still starting\ntest-servers: fake: now accepting connections\n');
    assert.ok(existsSync(join(dir, 'ready-marker')), 'start_logged returned before the slow server logged its ready line');
    assert.ok(alive(), 'start_logged returned only after the slow server ended');
    spawnSync('sh', ['-c', `kill $(cat ${dir}/fake.pid)`]);
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
  const step = name => `ci.yml step "${name}" has timeout-minutes; a long operation gets step logs and no deadline`;
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
  const all = execFileSync('git', ['ls-files', '-z'], { cwd: repository }).toString().split('\0').filter(Boolean);
  const read = path => all.includes(path) ? text(path) : undefined;
  assert.deepEqual(ciLeaseErrors(workflows, all, read), []);
  const files = {
    'tests/leased/main.go': 'package main\nfunc main() { _ = os.Getenv("LEASE") }\n',
    'tests/leased/main_test.go': 'package main\n',
    'tests/plain/main.go': 'package main\nfunc main() {}\n',
    'scripts/leased.mjs': "const { LEASE: lease, CARGO_LEASES: leases } = process.env;\n",
    'scripts/leased.sh': '"${LEASE:?}" run "$CARGO_LEASES" exclusive -- true\n',
    'scripts/plain.mjs': 'console.log(1);\n',
  };
  const workflow = run => ['jobs:', '  test:', '    steps:', '      - name: contracts', '        run: |', ...run.map(line => `          ${line}`), ''].join('\n');
  const errors = ciLeaseErrors({ 'ci.yml': workflow([
    'node tests/go-run.mjs leased ./tests/leased --results out',
    'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/leased',
    'node scripts/leased.mjs && sh scripts/leased.sh',
    'node tests/go-run.mjs plain ./tests/plain',
    'node scripts/plain.mjs',
    'make conformance-check',
  ]) }, Object.keys(files), path => files[path]);
  const error = (program, file) => `ci.yml step "contracts" runs ${program} outside make; ${file} reads LEASE, which make exports, so the step runs it through a make target`;
  assert.deepEqual(errors, [
    error('./tests/leased', 'tests/leased/main.go'),
    error('./tests/leased', 'tests/leased/main.go'),
    error('scripts/leased.mjs', 'scripts/leased.mjs'),
    error('scripts/leased.sh', 'scripts/leased.sh'),
  ]);
});

// target case는 실행 명령이 clients/rust/target/를 직접 적으면 거부한다.
caseTest('a run command names the Rust target directory through CARGO_TARGET_DIR', COMPUTE, () => {
  assert.deepEqual(targetPathErrors({
    Makefile: '# measured clients/rust/target 10 GiB\nexport CARGO_TARGET_DIR := $(abspath clients/rust/target)\nx:\n\t$(CARGO_TARGET_DIR)/debug/integration\n',
    'scripts/a.sh': '"${CARGO_TARGET_DIR:?}/debug/integration"\n',
  }), []);
  assert.deepEqual(targetPathErrors({
    Makefile: 'x:\n\tclients/rust/target/debug/integration\n',
    'scripts/a.mjs': "resolve(root, 'clients/rust/target/debug/integration')\n",
    'tests/b/main.go': '\t\ttarget = filepath.Join(root, "clients", "rust", "target")\n',
  }), [
    'Makefile:2 names clients/rust/target instead of CARGO_TARGET_DIR',
    'scripts/a.mjs:1 names clients/rust/target instead of CARGO_TARGET_DIR',
    'tests/b/main.go:1 names clients/rust/target instead of CARGO_TARGET_DIR',
  ]);
  assert.deepEqual(targetPathErrors({ 'tests/x/main.go': '\t// cargo builds into clients/rust/target by default\n' }), []);
  assert.ok(runFile('contracts/features.json') && runFile('tests/dbspec/compare/runners.mjs'));
  assert.ok(!runFile('examples/complex/rust/main.rs') && !runFile('clients/rust/README.md') && !runFile('scripts/repo/target.mjs'));
});

// manifest directory case는 Rust source가 package directory를 compile 시점의 env!로 읽으면 거부한다.
caseTest('Rust source reads the package directory when the program runs', COMPUTE, () => {
  assert.deepEqual(manifestDirErrors({
    'clients/rust/orm/tests/a.rs': 'let dir = polyspec_orm_testcase::manifest_dir();\n// env!("CARGO_MANIFEST_DIR") was the old form\n',
    'bench/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\ninclude!(concat!(env!("OUT_DIR"), "/m.rs"));\n',
  }), []);
  assert.deepEqual(manifestDirErrors({
    'clients/rust/orm/tests/a.rs': 'use std::path::PathBuf;\nlet root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");\n',
    'clients/rust/orm/src/codec.rs': '        let root = concat!(env!( "CARGO_MANIFEST_DIR" ), "/../../../tests/codec");\n',
  }), [
    'clients/rust/orm/tests/a.rs:2 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
    'clients/rust/orm/src/codec.rs:1 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
  ]);
});

// 연결 probe case는 client runtime이 연결할 때 server에 묻는 statement를 거부한다.
caseTest('a client connects without a probe statement', COMPUTE, () => {
  assert.deepEqual(connectProbeErrors({
    'clients/go/orm/db.go': '\tversion := sqliteVersion\n',
    'clients/typescript/src/database.ts': "    try { (await pool.reserve()).release(false); } catch (error) { throw error; }\n",
    'clients/go/orm/cancel_test.go': '\tc.Raw("", "SELECT sqlite_version()", nil)\n',
    'clients/php/src/Dbspec/SqliteCatalog.php': "SELECT sqlite_version()\n",
  }), []);
  assert.deepEqual(connectProbeErrors({
    'clients/go/orm/db.go': '\tif err := s.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version); err != nil {\n',
    'clients/php/src/Orm.php': "                    $version = (string) $pdo->query('SELECT sqlite_version()')->fetchColumn();\n",
    'clients/typescript/src/database.ts': "    try { await pool.execute('SELECT 1', [], undefined, unobserved); } catch (error) { throw error; }\n",
    'clients/rust/orm/src/db.rs': '                let version: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await?;\n',
  }), [
    'clients/go/orm/db.go:1 asks the server for the SQLite version; read the library version from the driver',
    'clients/php/src/Orm.php:1 asks the server for the SQLite version; read the library version from the driver',
    'clients/typescript/src/database.ts:1 sends SELECT 1 to check the connection; open a connection without a statement',
    'clients/rust/orm/src/db.rs:1 asks the server for the SQLite version; read the library version from the driver',
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
const trackedFiles = pattern => execFileSync('git', ['ls-files', '-z', pattern], { cwd: repository }).toString().split('\0').filter(Boolean);
const trackedTexts = paths => Object.fromEntries(paths.map(path => [path, text(path)]));

caseTest('every JavaScript test declares its cases with caseTest', COMPUTE, () => {
  assert.deepEqual(nodeTestErrors(trackedTexts(trackedFiles('*.mjs').filter(path => !path.startsWith('docs/')))), []);
});

caseTest('a JavaScript test that declares tests with node:test directly fails', COMPUTE, () => {
  const message = path => `${path} declares tests with node:test directly; use caseTest of tests/testcase.mjs, which gives each case its deadline and RUN, PASS or FAIL line`;
  assert.deepEqual(nodeTestErrors({
    'a.test.mjs': "import { test } from 'node:test';\n",
    'b.test.mjs': "import test from 'node:test';\n",
    'c.test.mjs': "import { after, it as check } from 'node:test';\n",
    'd.test.mjs': "import { after } from 'node:test';\nimport { caseTest } from '../testcase.mjs';\n",
    'tests/testcase.mjs': "import test from 'node:test';\n",
  }), [message('a.test.mjs'), message('b.test.mjs'), message('c.test.mjs')]);
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
  assert.deepEqual(goTestCaseErrors({ 'clients/go/orm/a_test.go': go, 'internal/testcase/testcase_test.go': 'func TestBare(t *testing.T) {\n}\n' }), [
    'clients/go/orm/a_test.go: TestBare does not start its case with internal/testcase, so it runs without a deadline or RUN line',
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
  assert.deepEqual(rustTestCaseErrors({ 'clients/rust/orm/tests/a.rs': rust }), [
    'clients/rust/orm/tests/a.rs: bare does not start its case with polyspec_orm_testcase, so it runs without a deadline or RUN line',
  ]);
});

// case 보고 case는 저장소가 실행하는 PHP와 TypeScript test와 최소 file을 검사한다.
caseTest('every PHP and TypeScript test that a check runs reports its cases', COMPUTE, () => {
  const commands = [
    ...text('Makefile').split('\n').filter(line => line.startsWith('\t')).map(line => ({ source: 'Makefile', command: line.slice(1) })),
    ...featureCommands(JSON.parse(text('contracts/features.json'))).map(command => ({ source: 'contracts/features.json', command })),
    ...trackedFiles('scripts/*.sh').flatMap(path => text(path).split('\n').map(command => ({ source: path, command }))),
    ...Object.values(JSON.parse(text('package.json')).scripts).map(command => ({ source: 'package.json', command })),
  ];
  const files = new Set(trackedFiles('*'));
  assert.ok(commands.some(({ command }) => testEntries(command).includes('clients/php/tests/decimal_model_db.php')));
  assert.deepEqual(reportingScriptErrors(commands, path => files.has(path) ? text(path) : undefined), []);
});

caseTest('a PHP or TypeScript test without the shared case report fails', COMPUTE, () => {
  const files = {
    'clients/php/tests/bare.php': "<?php\nrequire __DIR__ . '/autoload.php';\necho 'PASS';\n",
    'clients/php/tests/autoload.php': '<?php\n',
    'clients/php/tests/helped.php': "<?php\nrequire_once __DIR__ . '/case_helper.php';\n",
    'clients/php/tests/case_helper.php': "<?php\nrequire_once dirname(__DIR__, 3) . '/tests/testcase.php';\n",
    'clients/typescript/tests/bare.mjs': "import { Db } from '../dist/index.js';\n",
    'clients/typescript/tests/cased.mjs': "import { cases } from '../../../tests/testcase.mjs';\n",
    'tests/testcase.php': '<?php\n',
    'tests/testcase.mjs': '',
  };
  const read = path => files[path];
  assert.deepEqual(testEntries('. "$DECIMAL_ENV" && node --conditions=orm-test clients/typescript/tests/bare.mjs --dialect mysql'), ['clients/typescript/tests/bare.mjs']);
  assert.deepEqual(reportingScriptErrors([
    { source: 'Makefile', command: 'php clients/php/tests/bare.php && php clients/php/tests/helped.php' },
    { source: 'contracts/features.json', command: 'node --test clients/typescript/tests/bare.mjs clients/typescript/tests/cased.mjs' },
    { source: 'scripts/x.sh', command: 'php clients/php/tests/missing.php' },
    { source: 'scripts/y.sh', command: 'php scripts/setup.php' },
  ], read), [
    'Makefile runs clients/php/tests/bare.php, which reports no case through tests/testcase.php or tests/testcase.mjs, so it runs without a deadline or RUN line',
    'contracts/features.json runs clients/typescript/tests/bare.mjs, which reports no case through tests/testcase.php or tests/testcase.mjs, so it runs without a deadline or RUN line',
    'scripts/x.sh runs clients/php/tests/missing.php, which is not a tracked file',
  ]);
});

// 도구 case는 저장소의 검증 명령과 최소 명령을 검사한다.
const featureUnits = () => {
  const manifest = JSON.parse(text('contracts/features.json'));
  return [...manifest.features.flatMap(feature => feature.verification
    .filter(check => (check.cwd ?? '.') === '.').map(check => ({ name: `contracts/features.json ${feature.id}/${check.id}`, commands: [check.command] }))),
  ...(manifest.helpers ?? []).map(helper => ({ name: `contracts/features.json helper ${helper.id}`, commands: [helper.command] }))];
};

caseTest('every build tool of a verification command runs under run-long without a deadline', COMPUTE, () => {
  assert.deepEqual(unwrappedToolErrors(featureUnits()), []);
});

caseTest('a build tool outside run-long or under a deadline fails', COMPUTE, () => {
  assert.deepEqual(segments(`a && node tests/run-long.mjs x -- sh -c 'go generate ./ && git diff' || (cd b; c | d)`),
    ['a', `node tests/run-long.mjs x -- sh -c 'go generate ./ && git diff'`, 'cd b', 'c', 'd']);
  const unit = (name, command) => ({ name, commands: [command] });
  const outside = (name, tool, segment) => `${name} runs ${tool} outside tests/run-long.mjs, so it has no RUN line or step log: ${segment}`;
  const timed = (name, tool, form, segment) => `${name} runs ${tool} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unwrappedToolErrors([
    unit('tsc', 'node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.json --noEmit'),
    unit('generate', 'go test ./generator && cd clients/go/model && go generate ./'),
    unit('vet', 'go vet ./tests/conformance/check'),
    unit('build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration && ./integration'),
    unit('npm', 'npm run typescript:build >/dev/null'),
    unit('later', 'node tests/run-long.mjs a -- go vet ./a && go vet ./b'),
    unit('wrapped', 'node tests/run-long.mjs go-generate --cwd clients/go/model -- sh -c \'go generate ./ && git diff --exit-code -- .\''),
    unit('make', '$(RUN_LONG) rust-build/x --cwd clients/rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked'),
    unit('tsc-build', '$(TSC_BUILD)'),
    unit('run-case', 'node tests/run-case.mjs typescript-types 5m -- node clients/typescript/node_modules/typescript/bin/tsc --noEmit'),
    unit('make-case', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd clients/rust -- cargo build --locked'),
    unit('timeout', 'node tests/run-long.mjs vet -- timeout 300 go vet ./...'),
  ]), [
    outside('tsc', 'tsc', 'node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.json --noEmit'),
    outside('generate', 'go generate', 'go generate ./'),
    outside('vet', 'go vet', 'go vet ./tests/conformance/check'),
    outside('build', 'cargo build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration'),
    outside('npm', 'a TypeScript build', 'npm run typescript:build >/dev/null'),
    outside('later', 'go vet', 'go vet ./b'),
    timed('run-case', 'tsc', 'run-case.mjs', 'node tests/run-case.mjs typescript-types 5m -- node clients/typescript/node_modules/typescript/bin/tsc --noEmit'),
    timed('make-case', 'cargo build', '$(RUN_CASE)', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd clients/rust -- cargo build --locked'),
    timed('timeout', 'go vet', 'timeout 300', 'node tests/run-long.mjs vet -- timeout 300 go vet ./...'),
  ]);
});

// cargo test case는 저장소의 Makefile, 검증 명령, script와 최소 단위를 검사한다.
const runUnits = () => {
  const recipes = makeRecipes(text('Makefile'));
  const packageUnits = Object.entries(JSON.parse(text('package.json')).scripts).map(([name, command]) => ({ name: `package.json ${name}`, commands: [command] }));
  const files = new Set(trackedFiles('*'));
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command })));
  return { recipes, packageUnits, scripts: reachedScripts(commands, path => files.has(path) ? text(path) : undefined) };
};

caseTest('every cargo test run goes through cargo-test.mjs', COMPUTE, () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/client-db-test.sh'));
  assert.ok(!scripts.some(unit => unit.name === 'scripts/package-check.sh'), 'package-check.sh runs under run-long');
  assert.deepEqual(unbuiltCargoTestErrors([...recipes, ...featureUnits(), ...packageUnits, ...scripts]), []);
});

caseTest('a cargo test run outside cargo-test.mjs, or a build under a deadline, fails', COMPUTE, () => {
  assert.deepEqual(makeRecipes('A = 1\nx: y\n\tcd a && cargo test\n\n# c\nz:\n\techo\n').map(unit => unit.name), ['Makefile x', 'Makefile z']);
  const message = (name, args) => `${name} runs cargo test ${args} outside tests/cargo-test.mjs, so it runs the test binaries of the shared Rust target directory`;
  const timed = (name, args, form, segment) => `${name} runs the build cargo test --no-run ${args} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unbuiltCargoTestErrors([
    { name: 'bare', commands: ['$(WITH_TEST_ENV) cd clients/rust && cargo +$(T) test --locked --test a -- --nocapture'] },
    { name: 'built', commands: ['$(RUN_LONG) b --cwd clients/rust -- $(CARGO_LEASED) cargo +$(T) test --no-run --locked --test a', 'cd clients/rust && cargo +$(T) test --locked --test a'] },
    { name: 'copied', commands: ['cd clients/rust && $(CARGO_TEST) c -- cargo +$(T) test --locked --test a -- --nocapture', 'node tests/cargo-test.mjs d -- cargo test --locked --lib'] },
    { name: 'timed', commands: ['node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a'] },
  ]), [message('bare', '--locked --test a'), message('built', '--locked --test a'),
    timed('timed', '--locked --test a', 'run-case.mjs', 'node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a')]);
});

caseTest('every build tool of the Makefile, package.json and the scripts runs under run-long', COMPUTE, () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/typescript/sqlite-test.sh'));
  assert.deepEqual(unwrappedToolErrors([...recipes, ...packageUnits.filter(unit => segments(unit.commands[0]).length > 1), ...scripts]), []);
});

// 재실행 case는 저장소의 workflow와 최소 workflow를 runner의 정체로 검사한다.
caseTest('the CI workflow runs no test runner outside make check', COMPUTE, () => {
  assert.deepEqual(ciRerunErrors(workflow, text('Makefile')), []);
});

caseTest('a workflow that runs a test runner after make check fails by identity', COMPUTE, () => {
  assert.equal(runnerIdentity('PATH="$HOME/.cargo/bin:$PATH" cargo +1.98.1 test --locked -p polyspec-orm codec'), 'cargo test');
  assert.equal(runnerIdentity("go test -v -timeout 0 ./engine/ir -run '^$' -fuzz FuzzDecodeRequest -fuzztime=1s"), undefined);
  assert.equal(runnerIdentity('go run ./tests/interfaces/check --results tests/conformance/out'), undefined);
  assert.equal(runnerIdentity('node tests/go-test.mjs -v -timeout 0 ./engine -count=1'), 'go test');
  assert.equal(runnerIdentity("node tests/run-long.mjs fuzz/ir -- go test -v ./engine/ir -run '^$' -fuzz FuzzDecodeRequest"), undefined);
  assert.equal(runnerIdentity('node tests/run-long.mjs rust-build/x -- cargo test --no-run --locked'), 'cargo test');
  const make = [
    'CHECK_TARGETS = repo-check',
    'GO_TEST = go test -v -timeout 0',
    'fuzz-check:',
    "\t$(GO_TEST) ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s",
    'vet-again:',
    '\t$(GO_TEST) ./clients/go/orm -run TestCodec',
    '',
  ].join('\n');
  const again = steps.replace('make repo-check', [
    'make check',
    '          make fuzz-check vet-again',
    '          go vet ./... && go test -v -timeout 0 ./...',
    '          (cd clients/rust && cargo test --locked -p polyspec-orm codec)',
    '          php tests/codec/check.php',
    '          node --test scripts/x.test.mjs',
    '          go run ./tests/interfaces/check --results tests/conformance/out',
  ].join('\n'));
  const message = (identity, via = '') => `ci.yml step "checks" runs ${identity}${via} outside make check; make check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`;
  assert.deepEqual(ciRerunErrors(again, make), [
    message('go test', ' through make vet-again'),
    message('go vet'),
    message('go test'),
    message('cargo test'),
    message('php tests/codec/check.php'),
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
  assert.deepEqual(generateRuns(`$(RUN_LONG) go-model -- sh -c 'cd clients/go/model && go generate ./ && git diff --exit-code -- .'`), ['clients/go/model']);
  assert.deepEqual(generateRuns(`go test ./generator && node tests/run-long.mjs g --cwd clients/go/model -- sh -c 'go generate ./ && git diff'`), ['clients/go/model']);
  assert.deepEqual(generateRuns('cd clients/go/other && go generate ./'), ['clients/go/other']);
  assert.deepEqual(repeatedGenerateErrors([
    { name: 'Makefile go-model-check', commands: [`$(RUN_LONG) go-model -- sh -c 'cd clients/go/model && go generate ./ && git diff --exit-code -- .'`] },
    { name: 'contracts/features.json model_generation/generation-go', commands: [`node tests/run-long.mjs g --cwd clients/go/model -- sh -c 'go generate ./ && git diff'`] },
    { name: 'other', commands: ['cd clients/go/other && go generate ./'] },
  ]), ['go generate of clients/go/model runs 2 times in make check: Makefile go-model-check, contracts/features.json model_generation/generation-go']);
});

// go test case는 저장소의 Makefile(변수를 푼), 검증 명령, script와 최소 단위를 검사한다.
caseTest('every go test runs through go-test.mjs or run-long', COMPUTE, () => {
  const makefile = text('Makefile');
  const variables = makeVariables(makefile);
  const { recipes, scripts } = runUnits();
  const expanded = recipes.map(unit => ({ name: unit.name, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(rawGoTestErrors([...expanded, ...featureUnits(), ...scripts]), []);
});

caseTest('a go test without its build step, or under a deadline, fails', COMPUTE, () => {
  const message = (name, segment) => `${name} runs go test outside tests/go-test.mjs, so its compile has no RUN line or step log: ${segment}`;
  const fuzz = "$(RUN_CASE) fuzz/ir 8m -- go test -v -timeout 0 ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s";
  assert.deepEqual(rawGoTestErrors([
    { name: 'raw', commands: ['go test -v -timeout 0 ./clients/go/orm -run X -count=1'] },
    { name: 'env', commands: ['ORM_RUN_PERF_GATE=1 go test -v ./clients/go/bench'] },
    { name: 'wrapped', commands: ['node tests/go-test.mjs -v -timeout 0 ./engine -count=1'] },
    { name: 'fuzz', commands: ["$(RUN_LONG) fuzz/ir -- go test -v -timeout 0 ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s"] },
    { name: 'build', commands: ['node tests/run-long.mjs go-build -- go test -c -o x ./engine/dbspec'] },
    { name: 'timed', commands: [fuzz] },
  ]), [message('raw', 'go test -v -timeout 0 ./clients/go/orm -run X -count=1'), message('env', 'ORM_RUN_PERF_GATE=1 go test -v ./clients/go/bench'),
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
  const scripts = reachedScripts(commands, path => files.has(path) ? text(path) : undefined, { throughLong: true });
  assert.ok(scripts.some(unit => unit.name === 'scripts/package-check.sh'), 'the scripts under run-long are checked');
  const expanded = recipes.map(unit => ({ name: unit.name, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(longDeadlineErrors([...expanded, ...featureUnits(), ...packageUnits, ...scripts]), []);
});

caseTest('a deadline on a long operation fails', COMPUTE, () => {
  const message = (name, form, segment) => `${name} puts a deadline (${form}) on a long operation; it gets step logs and no deadline, and only a test case has its own: ${segment}`;
  const units = {
    'run-case': 'node tests/run-case.mjs package 8m -- ./scripts/package-check.sh',
    make: '$(RUN_CASE) go-fmt $(TOOL_DEADLINE) -- gofmt -l .',
    variable: 'node tests/run-long.mjs x -- sh -c "sleep $(BUILD_DEADLINE)"',
    timeout: 'timeout 600 cargo build --locked',
    'go-default': 'go test ./...',
    'go-timeout': 'node tests/go-test.mjs -v -timeout 10m ./engine',
    'go-none': 'go test -timeout 0 ./...',
    'go-build': 'go test -c -o x ./engine/dbspec',
    'go-runner': 'node tests/go-test.mjs -v -timeout 0 ./engine -count=1',
    long: 'node tests/run-long.mjs rust-build/x -- cargo test --no-run --locked',
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
  const read = path => readFileSync(new URL(path, repository), 'utf8');
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': read('AGENTS.md'), 'AGENTS.ko.md': read('AGENTS.ko.md') }), []);
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': 'The full suite (`make check`) runs exactly once, when every active checklist\n  item is complete.', 'AGENTS.ko.md': '' }).slice(0, 2), [
    'AGENTS.md does not state the full-suite rule: "runs on GitHub CI after a push"',
    'AGENTS.md does not state the full-suite rule: "collect enough information to fix every failure it found before the next CI run"',
  ]);
  assert.ok(fullSuiteRuleErrors({ 'AGENTS.md': 'runs exactly once, when every active checklist\n  item is complete', 'AGENTS.ko.md': '' })
    .includes('AGENTS.md still states the local full-suite rule: "runs exactly once, when every active checklist   item is complete"'));
});

// CI setup case(G5.52)는 workflow의 setup step이 실패해도 뒤의 step과 make check가 실행되고 그 실패를 runner에 넘기는지
// 본다. main의 workflow처럼 id 없는 install step, 조건 없는 step, continue-on-error, ORM_CI_SETUP이나 ORM_GIT_RANGE 없는 make check는 오류다.
caseTest('a workflow runs every setup step and make check after a failed setup step and passes the results on', COMPUTE, () => {
  const setup = { go: 'go', rust: 'rust' };
  const runner = ['checkout'];
  const workflow = (steps, check) => `jobs:\n  test:\n    steps:\n${steps}${check}`;
  const good = workflow(`      - uses: actions/checkout@v5\n        id: checkout\n      - uses: actions/setup-go@v6\n        id: go\n        if: \${{ !cancelled() }}\n      - name: rust\n        id: rust\n        if: \${{ !cancelled() }}\n        run: rustup toolchain install\n`,
    `      - name: make check\n        if: \${{ !cancelled() }}\n        env:\n          ORM_CI_SETUP: \${{ toJSON(steps) }}\n          ORM_GIT_RANGE: \${{ github.event_name == 'pull_request' && format('{0}..{1}', github.event.pull_request.base.sha, github.event.pull_request.head.sha) || github.event_name == 'merge_group' && format('{0}..{1}', github.event.merge_group.base_sha, github.event.merge_group.head_sha) || '' }}\n        run: make check\n`);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': good }, { setup, runner }), []);
  const bad = workflow(`      - uses: actions/checkout@v5\n        id: checkout\n      - uses: actions/setup-go@v6\n        with: { go-version: "1.27" }\n      - name: rust\n        id: rustup\n        continue-on-error: true\n        if: \${{ !cancelled() }}\n        run: rustup toolchain install\n`,
    `      - name: make check\n        run: make check\n`);
  assert.deepEqual(ciSetupErrors({ 'ci.yml': bad }, { setup, runner }), [
    'ci.yml uses continue-on-error, which hides a failed step from the job; run later steps with if: ${{ !cancelled() }} instead',
    'ci.yml step "uses: actions/setup-go@v6" before make check has no id; give it the id of what it installs in scripts/check/ci-setup.mjs',
    'ci.yml step "uses: actions/setup-go@v6" does not run after a failed earlier setup step; give it if: ${{ !cancelled() }}',
    'ci.yml step "rust" has the id rustup, which scripts/check/ci-setup.mjs does not map to what it installs',
    'ci.yml has no setup step with the id go of scripts/check/ci-setup.mjs',
    'ci.yml has no setup step with the id rust of scripts/check/ci-setup.mjs',
    'ci.yml step "make check" does not run after a failed setup step; give it if: ${{ !cancelled() }}',
    'ci.yml step "make check" gives make check no ORM_CI_SETUP: ${{ toJSON(steps) }}, which tells the runner the failed setup steps',
    'ci.yml step "make check" gives make check no ORM_GIT_RANGE of the pull request and the merge group, the commits whose subjects git-check reads',
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
    'GO_TEST = node tests/go-test.mjs -v -timeout 0',
    'two:', "\t$(GO_TEST) ./a -count=1", '\tphp clients/php/tests/b_test.php',
    'again:', '\tphp clients/php/tests/b_test.php', '\tphp clients/php/tests/b_test.php',
    'built:', '\tnode tests/dbspec/stress.mjs > out.dbs', '\tgo test -c -o x ./engine', '\tnode clients/typescript/node_modules/typescript/bin/tsc -p x', '\tnode --test tests/x.test.mjs',
    'linted:', '\tcargo +$(shell sed -n \'s/x/\\1/p\' f) clippy -p polyspec-orm -- -D warnings', '\tnode $(abspath tests/cargo-test.mjs) y -- cargo test -p polyspec-orm',
    'parts: parts/a parts/b', 'parts/a:', "\t$(GO_TEST) ./a -count=1", 'parts/b:', '\tphp clients/php/tests/b_test.php',
  ].join('\n');
  assert.deepEqual(independentTestErrors(makefile).map(error => error.split(' runs ')[0]), ['Makefile two', 'Makefile linted']);
  assert.deepEqual(chainedCommandErrors({ features: [{ id: 'f', verification: [{ id: 'chained', command: 'node clients/typescript/tests/a.mjs && node clients/typescript/tests/b.mjs' }, { id: 'built', command: 'npm run typescript:build && node clients/typescript/tests/a.mjs' }] }], helpers: [] }).map(error => error.split(' chains ')[0]),
    ['contracts/features.json f/chained']);
  const root = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(independentTestErrors(readFileSync(join(root, 'Makefile'), 'utf8')), []);
  assert.deepEqual(chainedCommandErrors(JSON.parse(readFileSync(join(root, 'contracts/features.json'), 'utf8'))), []);
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
  const tracked = execFileSync('git', ['ls-files', '*.go'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean);
  assert.deepEqual(deferredExitErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});

caseTest('Go code does not find its files through runtime.Caller', COMPUTE, () => {
  const caller = 'package p\n\nfunc root() string {\n\t_, file, _, _ := runtime.Caller(0)\n\treturn file\n}\n';
  const comment = 'package p\n\n// runtime.Caller(0) is not used here\nfunc root() string { return "." }\n';
  assert.deepEqual(callerPathErrors({ 'p/root_test.go': caller, 'p/doc.go': comment }), [
    'p/root_test.go:4: runtime.Caller gives the path the binary was compiled at, not the checkout that runs it; find files from the working directory (os.Getwd), which go test sets to the package directory',
  ]);
  const tracked = execFileSync('git', ['ls-files', '*.go'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean);
  assert.deepEqual(callerPathErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});

caseTest('a script that starts a process group of its own checks that group after it ends', COMPUTE, () => {
  assert.deepEqual(detachedGroupErrors({
    'a.mjs': "const child = spawn('go', ['test'], { detached: true });",
    'b.mjs': "const child = spawn('go', ['test'], { detached: true });\nchild.on('exit', () => endGroup(child.pid));",
    'c.mjs': "const child = spawn('go', ['test']);",
  }), ['a.mjs starts a process in a group of its own (detached: true) and never checks that group after it ends; check it with endGroup of scripts/check/step.mjs and fail on what it left']);
  const root = new URL('../..', import.meta.url).pathname;
  const tracked = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: root }).toString().split('\n').filter(Boolean);
  assert.deepEqual(detachedGroupErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(join(root, path), 'utf8')]))), []);
});

caseTest('every CI step runs a make target', COMPUTE, () => {
  const workflow = (summary, extra = '') => `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v5\n      - name: install\n        run: make install-node\n${extra}      - name: summary\n        run: ${summary}\n`;
  assert.deepEqual(ciMakeErrors({ '.github/workflows/ci.yml': workflow('node scripts/check/summary.mjs') }), []);
  assert.deepEqual(ciMakeErrors({ '.github/workflows/ci.yml': workflow('node scripts/check/summary.mjs', '      - name: deps\n        run: |\n          npm ci\n          make install-php\n') }), [
    '.github/workflows/ci.yml step "deps" runs npm ci; run it through a make target',
  ]);
  assert.deepEqual(ciMakeErrors({ '.github/workflows/docs-pages.yml': workflow('node scripts/check/summary.mjs') }), [
    '.github/workflows/docs-pages.yml step "summary" runs node scripts/check/summary.mjs; run it through a make target',
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
  const text = on => `name: x\n${on.join('\n')}\n\njobs:\n  a:\n    runs-on: ubuntu\n`;
  const declared = Object.fromEntries(Object.entries(WORKFLOW_TRIGGERS).map(([path, on]) => [path, text(on)]));
  assert.deepEqual(workflowTriggerErrors(declared), []);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/ci.yml': text(['on:', '  push:', '  pull_request:', '  merge_group:', '  workflow_dispatch:']) }), [
    '.github/workflows/ci.yml has the triggers on: push: pull_request: merge_group: workflow_dispatch: instead of on: pull_request: merge_group: workflow_dispatch:',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/docs-pages.yml': text(['on:', '  push:', '    branches: [main]', '  pull_request:', '  workflow_dispatch:']) }), [
    '.github/workflows/docs-pages.yml has the triggers on: push: branches: [main] pull_request: workflow_dispatch: instead of on: push: branches: [main] workflow_dispatch:',
  ]);
  const { ['.github/workflows/push-gate.yml']: _, ...withoutGate } = declared;
  assert.deepEqual(workflowTriggerErrors({ ...withoutGate, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  pull_request:']) }), [
    ".github/workflows/push-gate.yml is missing; it runs on push: branches-ignore: ['gh-readonly-queue/**'] pull_request: merge_group:",
    '.github/workflows/review.yml runs on pull_request; only ci.yml, push-gate.yml and docs-pages.yml run on these events',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  workflow_dispatch:']) }), []);
});

caseTest('every workflow that runs on push cancels the run of the push before it', COMPUTE, () => {
  const concurrency = 'concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n';
  const workflow = (on, extra = '') => `name: x\non:\n${on}\n${extra}jobs:\n  a:\n    runs-on: ubuntu\n`;
  assert.deepEqual(concurrencyErrors({ 'a.yml': workflow('  push:\n    branches: [main]', concurrency) }), []);
  assert.deepEqual(concurrencyErrors({ 'b.yml': workflow('  workflow_dispatch:') }), []);
  assert.deepEqual(concurrencyErrors({ 'c.yml': workflow('  push:', 'concurrency:\n  group: c-${{ github.ref }}\n  cancel-in-progress: false\n') }).map(error => error.split(' ')[0]), ['c.yml']);
  assert.deepEqual(concurrencyErrors({ 'd.yml': workflow('  push:') }).map(error => error.split(' ')[0]), ['d.yml']);
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  assert.deepEqual(concurrencyErrors(Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [name, readFileSync(join(directory, name), 'utf8')]))), []);
});

const goWorkflow = '    steps:\n      - uses: actions/setup-go@v6\n        with: { go-version-file: .go-version }\n      - run: make check\n';
caseTest('the checks and every workflow run the Go of .go-version', COMPUTE, () => {
  assert.deepEqual(goVersionErrors('1.27.0\n', 'module m\n\ngo 1.27\n', { 'ci.yml': goWorkflow }, '1.27.0'), []);
  assert.deepEqual(goVersionErrors('1.27\n', 'module m\n\ngo 1.27\n', { 'ci.yml': goWorkflow.replace('go-version-file: .go-version', 'go-version: "1.27"') }, '1.27.1'), [
    '.go-version must hold one exact Go release x.y.z and a newline, found "1.27\\n"; write the release that CI and the local checks run',
    'ci.yml declares go-version itself; read go-version-file: .go-version in actions/setup-go',
    'ci.yml does not read go-version-file .go-version in actions/setup-go; add go-version-file: .go-version',
  ]);
  assert.deepEqual(goVersionErrors('1.27.0\n', 'module m\n\ngo 1.26\n', { 'ci.yml': '    steps:\n      - run: make check\n' }, '1.27.1'), [
    'go.mod declares go 1.26, but .go-version declares 1.27.0; write go 1.27 in go.mod',
    'ci.yml runs Go without actions/setup-go; add a setup-go step with go-version-file: .go-version',
    'Go 1.27.1 runs the checks; .go-version declares 1.27.0; install Go 1.27.0 or change .go-version together with the CI evidence of the new release',
  ]);
});

caseTest('every setup-php step installs the Composer of .composer-version', COMPUTE, () => {
  const php = '    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  assert.deepEqual(composerVersionErrors('2.10.3\n', { 'ci.yml': php }, '2.10.3'), []);
  assert.deepEqual(composerVersionErrors('2.10.3\n', { 'ci.yml': php.replace('          tools: composer:2.10.3\n', '') }, '2.10.4'), [
    'ci.yml sets up PHP without tools: composer:2.10.3; setup-php installs the newest Composer otherwise, so add tools: composer:2.10.3',
    'Composer 2.10.4 runs the checks; .composer-version declares 2.10.3; install Composer 2.10.3 (composer self-update 2.10.3) or change .composer-version together with the CI evidence of the new release',
  ]);
});

caseTest('a Makefile build output is published through a temporary file', COMPUTE, () => {
  const makefile = [
    'LEASE_BUILD = go build -o $(LEASE) ./tests/lease',
    'PUBLISHED = $(PUBLISH) $(LEASE) go build -o @OUT@ ./tests/lease',
    'doc:',
    '\tnode tests/dbspec/stress.mjs > $(DOC)',
    '\t$(PUBLISH) $(DOC) node tests/dbspec/stress.mjs',
    '\ttest -f x || { echo "x is missing" >&2; exit 1; }',
    '\tnode clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json',
    '\tnode clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.json --noEmit',
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
  const files = {
    'tests/a.mjs': `if (!dsn) throw new Error('ORM_TEST_MYSQL_DSN ${required}; database tests never skip');\n// ORM_TEST_MYSQL_DSN ${required} in a comment\n`,
    'tests/b_test.go': `\tt.Fatal("ORM_TEST_MYSQL_DSN ${required}; run the test through its make target, which reads the environment of make test-servers")\n`,
    'scripts/c.sh': `: "\${BENCH_DSN:?BENCH_DSN ${required}}"\ncommand -v x >/dev/null || { echo "x ${['is', 'not', 'installed'].join(' ')}; run make install-server-programs" >&2; exit 1; }\n`,
  };
  assert.deepEqual(fixlessMessageErrors(files).map(error => error.split(': a failure')[0]), ['tests/a.mjs:1', 'scripts/c.sh:1']);
});

caseTest('no Makefile or script fixes a TCP port of the test servers', COMPUTE, () => {
  const makefile = ['TEST_MYSQL_PORT = 33171', '# TEST_POSTGRES_PORT = 55471', 'test-servers:', '\t./scripts/test-servers.sh start $(TEST_MYSQL_PORT)', '\t./scripts/test-servers.sh start'].join('\n');
  assert.deepEqual(fixedPortErrors({ Makefile: makefile, 'scripts/a.sh': 'export PGPORT=5432\nport=$(node scripts/free-ports.mjs 1)\n' }).map(error => error.split(' fixes ')[0]), [
    'Makefile:1', 'Makefile:4', 'scripts/a.sh:1',
  ]);
  const tracked = execFileSync('git', ['ls-files', 'Makefile', '*.sh'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean);
  assert.deepEqual(fixedPortErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});
