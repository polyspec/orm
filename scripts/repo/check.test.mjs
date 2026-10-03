import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { ciServerErrors, serverVariables } from './ci.mjs';
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

caseTest('a workflow that does not export the server environment fails', COMPUTE, () => {
  const unexported = steps.replace(`sed -e 's/^export //' .runtime/servers/env >> "$GITHUB_ENV"`, 'true');
  assert.deepEqual(ciServerErrors(unexported, script), [
    'ci.yml does not add .runtime/servers/env to $GITHUB_ENV in the step after make test-servers',
  ]);
});
