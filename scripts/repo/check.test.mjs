import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { checkTargets, ciCheckTargetErrors, ciDuplicateCommandErrors, ciServerErrors, featureCommands, serverVariables } from './ci.mjs';
import { nodeVersionErrors } from './node.mjs';
import { phpVersionErrors, rustToolchainErrors } from './toolchains.mjs';
import { execFileSync } from 'node:child_process';
import { scriptPathErrors } from './scripts.mjs';

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
    'ORM_TEST_PGBOUNCER_DSN', 'ORM_TEST_PGBOUNCER_SINGLE_DSN', 'ORM_TEST_MYSQL_TLS_DSN', 'BENCH_SQLITE_DSN'])
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
  '      - name: server environment',
  `        run: sed -e 's/^export //' .runtime/servers/env >> "$GITHUB_ENV"`,
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
});

caseTest('a workflow that creates a symbolic link fails', COMPUTE, () => {
  for (const command of ['ln -s a b', 'sudo ln -sf /usr/lib/a.so.1t64 /usr/lib/a.so.1', 'ln --symbolic a b', `node -e "fs.symlinkSync('a', 'b')"`]) {
    const linked = steps.replace('      - name: database servers', `      - name: link\n        run: ${command}\n      - name: database servers`);
    assert.deepEqual(ciServerErrors(linked, script), ['ci.yml step "link" creates a symbolic link'], command);
  }
});

caseTest('a workflow that does not export the server environment fails', COMPUTE, () => {
  const unexported = steps.replace(`sed -e 's/^export //' .runtime/servers/env >> "$GITHUB_ENV"`, 'true');
  assert.deepEqual(ciServerErrors(unexported, script), [
    'ci.yml does not add .runtime/servers/env to $GITHUB_ENV in the step after make test-servers',
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
  assert.deepEqual(Object.keys(workflows), ['.github/workflows/ci.yml', '.github/workflows/docs-pages.yml']);
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
  '      - run: composer install --working-dir=clients/php',
  '',
].join('\n');

caseTest('a workflow that declares php-version itself fails', COMPUTE, () => {
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php }, '8.5'), []);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('php-version-file: .php-version', 'php-version: "8.4"') }, '8.5'), [
    'ci.yml declares php-version itself; .php-version declares it',
    'ci.yml does not read php-version-file .php-version in shivammathur/setup-php',
  ]);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('shivammathur/setup-php@v2', 'actions/checkout@v5') }, '8.5'), [
    'ci.yml runs PHP without shivammathur/setup-php',
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

// 중복 실행 case는 저장소의 workflow, Makefile, feature contract와 최소 workflow를 검사한다.
caseTest('the CI workflow does not run a verification command of feature-check again', COMPUTE, () => {
  const commands = featureCommands(JSON.parse(text('contracts/features.json')));
  for (const command of ['./scripts/perf-test.sh', 'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test'])
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
