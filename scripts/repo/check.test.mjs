import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import { checkTargets, ciCheckTargetErrors, ciDuplicateCommandErrors, ciServerErrors, featureCommands, runnerErrors, serverVariables, stepTimeoutErrors } from './ci.mjs';
import { nodeVersionErrors } from './node.mjs';
import { runFile, targetPathErrors } from './target.mjs';
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
    '        run: echo "version=$(./scripts/php/php-min.sh --version)" >> "$GITHUB_OUTPUT"',
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
  const base = mkdtempSync(join(tmpdir(), 'orm-sock-'));
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
      const result = spawnSync('sh', [join(root, 'scripts/test-servers.sh'), 'start', '39171', '39471', '39181', '39481', '39182', '39482'], { encoding: 'utf8' });
      const socket = join(root, '.runtime/servers', name);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, `test-servers: socket path ${socket} is ${Buffer.byteLength(socket)} bytes; ${system} allows at most ${limit}\n`);
      assert.equal(existsSync(join(root, '.runtime/servers')), false, 'the servers directory was created');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// start_logged case는 test-servers.sh의 start_logged를 그대로 꺼내 가짜 서버로 실행한다. 서버가 준비
// 줄을 쓰고 계속 실행하면 start_logged는 서버가 끝나기 전에 돌아와야 한다(Ubuntu의 mawk처럼 pipe를
// block 단위로 읽는 reader는 서버가 끝날 때까지 줄을 넘기지 않는다). 준비 줄 없이 끝나면 실패한다.
caseTest('start_logged reports a ready line, an exit or its deadline', COMPUTE, () => {
  const script = readFileSync(new URL('../test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('start_logged() {');
  const body = script.slice(start, script.indexOf('\n}\n', start) + 3);
  assert.ok(start >= 0 && body.endsWith('}\n'), 'start_logged is absent from scripts/test-servers.sh');
  const dir = mkdtempSync(join(tmpdir(), 'orm-logged-'));
  try {
    // 출력은 file로 받는다: 계속 실행하는 가짜 서버와 reader는 pipe를 열어 두므로, pipe로 받으면
    // spawnSync가 shell이 끝난 뒤에도 서버가 끝날 때까지 기다린다.
    const run = server => {
      const out = join(dir, 'stdout'), err = join(dir, 'stderr');
      const status = spawnSync('sh', ['-c', `set -eu\nDIR=${dir}\n${body}\nstart_logged fake 2 'accepting connections' sh -c '${server}'\necho returned`],
        { stdio: ['ignore', openSync(out, 'w'), openSync(err, 'w')], timeout: 20_000 }).status;
      return { status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
    };
    const started = Date.now();
    const ready = run('echo starting; echo now accepting connections; exec sleep 30');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout, 'returned\n');
    assert.ok(Date.now() - started < 10_000, `start_logged returned after ${Date.now() - started} ms`);
    assert.match(readFileSync(join(dir, 'fake.log'), 'utf8'), /^starting\nnow accepting connections\n/);
    spawnSync('sh', ['-c', `kill $(cat ${dir}/fake.pid)`]);
    rmSync(join(dir, 'fake.log'));
    const exited = run('echo starting; exit 3');
    assert.equal(exited.status, 1);
    assert.equal(exited.stderr, `test-servers: fake exited before it logged 'accepting connections'; last lines of ${dir}/fake.log:\nstarting\n`);
    rmSync(join(dir, 'fake.log'));
    // 준비 줄 없이 계속 실행하는 서버는 선언한 기한(2초)이 지나면 실패한다.
    const waiting = Date.now();
    const silent = run('echo starting; echo still starting; exec sleep 30');
    assert.equal(silent.status, 1);
    assert.equal(silent.stderr, `test-servers: fake logged no line with 'accepting connections' within its deadline of 2 s; last lines of ${dir}/fake.log:\nstarting\nstill starting\n`);
    assert.ok(Date.now() - waiting < 10_000, `start_logged failed after ${Date.now() - waiting} ms`);
    spawnSync('sh', ['-c', `kill $(cat ${dir}/fake.pid)`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// timeout case는 저장소의 workflow와 최소 workflow의 step마다 timeout-minutes를 검사한다.
caseTest('every workflow step declares its own timeout-minutes', COMPUTE, () => {
  assert.deepEqual(stepTimeoutErrors(workflows), []);
  const timed = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '        timeout-minutes: 5',
    '      - name: checks',
    '        timeout-minutes: 30',
    '        run: make check',
    '',
  ].join('\n');
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': timed }), []);
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': timed.replace('        timeout-minutes: 30\n', '') }), [
    'ci.yml step "checks" has no timeout-minutes of its own',
  ]);
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': timed.replace('timeout-minutes: 5', 'timeout-minutes: 0') }), [
    'ci.yml step "uses: actions/checkout@v5" has no timeout-minutes of its own',
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
