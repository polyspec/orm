import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { ciServerErrors, serverVariables } from './ci.mjs';
import { nodeVersionErrors } from './node.mjs';
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
