// The tests of scripts/test-servers-container.mts (BAY1, T444). They run the script against a stand-in bay that each
// test writes into its own directory, so they need no container and no image. The stand-in takes the project name from
// the option -p and keeps one file per project under its state directory: up records the project and prints the host
// name and the address of each service as JSON, down removes that file, plan --json prints the host name of each service
// with a suffix of the stand-in alone and the path of its authority, so a script that holds a suffix of its own fails,
// images --json reports each image, exec and logs print one line, and version --json prints the schema version. Each
// call is a line of calls.log. The stand-in starts no process that stays, so nothing outlives a test (HR-87). Each test
// names two checkouts by two directories of its own. A test runs the stand-in and openssl, which issues the second CA
// of each start, as child processes, so each has the deadline of the class PROCESS.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { caseTest, PROCESS, withTemporaryDirectory } from '../tests/testcase.mts';
import { pull, remove, run, start, type Context } from './test-servers-container.mts';
import { ORM_ACCOUNTS_SQL, REPLICA_PARTIAL_REVOKES_SQL } from './test-servers.mts';

// ADDRESS is the IPv4 address that the stand-in bay reports for every service, SUFFIX the suffix of its host names, which
// no bay has, and AUTHORITY the path that it reports for the certificate of its authority.
const ADDRESS = '192.168.64.9';
const SUFFIX = 'stand-in.test';
const AUTHORITY = '/stand-in/authority.crt';

// StandIn has the path of the stand-in bay of a test, the directory of the projects that it holds, and the files that
// change what it does: while upFails exists, up records its project and exits with 1; while absent exists, images
// reports each image as missing and up -no-pull fails before it records anything; while execFails exists, exec exits
// with 7; while schema exists, version reports its text as the schema version.
interface StandIn { bay: string; state: string; calls: string; upFails: string; absent: string; execFails: string; schema: string }

function standIn(dir: string): StandIn {
  const stand: StandIn = {
    bay: join(dir, 'bay.mjs'), state: join(dir, 'projects'), calls: join(dir, 'calls.log'),
    upFails: join(dir, 'up-fails'), absent: join(dir, 'absent'), execFails: join(dir, 'exec-fails'), schema: join(dir, 'schema'),
  };
  mkdirSync(stand.state, { recursive: true });
  writeFileSync(stand.calls, '');
  writeFileSync(stand.bay, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(${JSON.stringify(stand.calls)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const fail = (text, status = 1) => { console.error('bay: ' + text); process.exit(status); };
const [option, name, command, ...rest] = process.argv.slice(2);
const is = (...words) => command === words[0] && rest.join(' ') === words.slice(1).join(' ');
if (option === 'version' && name === '--json') {
  console.log(JSON.stringify({ version: 'stand-in', schemaVersion: existsSync(${JSON.stringify(stand.schema)}) ? Number(readFileSync(${JSON.stringify(stand.schema)}, 'utf8')) : 1 }));
  process.exit(0);
}
if (option !== '-p' || !name) fail('the stand-in takes the project name from -p', 2);
const project = join(${JSON.stringify(stand.state)}, name);
const services = () => {
  const text = readFileSync('compose.yaml', 'utf8');
  if (/^name:/m.test(text)) fail('compose.yaml names a project');
  return [...text.matchAll(/^ {2}([a-z-]+):\\n(?: {4,}.*\\n)*? {4}image: "(.*)"$/gm)].map(([, service, image]) => {
    const port = Number(new RegExp('^ {2}' + service + ':\\\\n(?: {4,}.*\\\\n)*? {4}expose: \\\\["(\\\\d+)"\\\\]$', 'm').exec(text)?.[1] ?? 0);
    return { name: service, host: name + '-' + service + '.${SUFFIX}', port, image, certificate: { ca: ${JSON.stringify(AUTHORITY)}, containerCert: '/etc/bay/tls/cert.pem', containerKey: '/etc/bay/tls/key.pem', containerCa: '/etc/bay/tls/ca.pem' } };
  });
};
const absent = existsSync(${JSON.stringify(stand.absent)});
if (is('plan', '--json')) console.log(JSON.stringify({ schemaVersion: 1, project: name, services: services() }));
else if (is('images', '--json')) {
  console.log(JSON.stringify(services().map(service => ({ service: service.name, image: service.image, present: !absent }))));
  if (absent) fail('an image is not in the local store');
} else if (is('up', '-no-pull', '--json')) {
  if (absent) fail('an image is not in the local store');
  if (existsSync(project)) fail('the project is up');
  writeFileSync(project, process.cwd());
  if (existsSync(${JSON.stringify(stand.upFails)})) fail('service mysql is unhealthy');
  console.error('all services accept connections');
  console.log(JSON.stringify({ schemaVersion: 1, project: name, services: services().map(service => ({ ...service, address: ${JSON.stringify(ADDRESS)} })) }));
} else if (is('down')) rmSync(project, { force: true });
else if (is('pull')) { if (services().length === 0) fail('compose.yaml has no service'); }
else if (command === 'logs') console.log('the last lines of ' + rest.at(-1));
else if (command === 'exec') {
  if (!existsSync(project)) fail('the project is not up');
  if (existsSync(${JSON.stringify(stand.execFails)})) { console.error('ERROR 1045: the statement failed'); process.exit(7); }
} else fail('unknown command ' + command, 2);
`);
  chmodSync(stand.bay, 0o755);
  return stand;
}

// Call is a line of calls.log: the working directory of the stand-in and its arguments.
interface Call { cwd: string; args: string[] }

function calls(stand: StandIn): Call[] {
  return readFileSync(stand.calls, 'utf8').split('\n').filter(line => line !== '').map(line => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || !('cwd' in parsed) || !('args' in parsed)) throw new Error(`calls.log holds no call: ${line}`);
    const { cwd, args } = parsed;
    if (typeof cwd !== 'string' || !Array.isArray(args) || !args.every((item): item is string => typeof item === 'string')) throw new Error(`calls.log holds no call: ${line}`);
    return { cwd, args };
  });
}

// commands are the calls of the stand-in bay for a project, each as its arguments after -p <project>.
const commands = (stand: StandIn) => calls(stand).filter(call => call.args[0] === '-p').map(call => call.args.slice(2).join(' '));
// verbs are the first argument of each of those calls.
const verbs = (stand: StandIn) => commands(stand).map(command => command.split(' ')[0]);

// removing runs the body of a test and then removes the projects of its checkouts, also when the body fails.
async function removing(contexts: Context[], body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } finally {
    for (const context of contexts) remove(context);
  }
}

const checkouts = (dir: string, stand: StandIn): [Context, Context] => {
  const [first, second] = [join(dir, 'first'), join(dir, 'second')];
  for (const root of [first, second]) mkdirSync(root, { recursive: true });
  const context = (root: string): Context => ({ root, bay: stand.bay });
  return [context(first), context(second)];
};

const containers = (root: string) => join(root, '.runtime/containers');

// projects are the names of the project directories of a checkout: orm-<checkout>-<run>.
function projects(root: string): string[] {
  if (!existsSync(containers(root))) return [];
  return readdirSync(containers(root)).filter(name => /^orm-[0-9a-f]{12}-[0-9a-f]{8}$/.test(name)).sort();
}

// only is the one project of a checkout.
function only(root: string): string {
  const [project, ...others] = projects(root);
  if (project === undefined || others.length > 0) throw new Error(`${root} has not one project: ${projects(root).join(' ')}`);
  return project;
}

const compose = (root: string, project: string) => readFileSync(join(containers(root), project, 'compose.yaml'), 'utf8');

caseTest('two checkouts start a server of the same kind at once, each as a project of its own (BAY1, BAY2, T444)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [first, second] = checkouts(dir, stand);
    await removing([first, second], async () => {
      // A project of another name, such as one of another tool, is never removed.
      writeFileSync(join(stand.state, 'another-project'), '');
      await Promise.all([start('mysql', first), start('mysql', second)]);
      const [one, two] = [only(first.root), only(second.root)];
      assert.notEqual(one.slice(0, 16), two.slice(0, 16), 'two checkouts have the same identifier in their project names');
      assert.deepEqual(readdirSync(stand.state).sort(), ['another-project', one, two].sort());
      assert.equal(readFileSync(join(stand.state, one), 'utf8'), realpathSync(join(containers(first.root), one)), 'bay up did not run in the directory of the project');
      // The project name reaches bay on its command line, and the Compose file names none.
      assert.ok(calls(stand).every(call => call.args[0] === 'version' || (call.args[0] === '-p' && [one, two].includes(call.args[1] ?? ''))), 'a call of bay does not name its project with -p');
      assert.ok(!/^name:/m.test(compose(first.root, one)), 'the Compose file names its project');
      for (const { root } of [first, second]) assert.ok(existsSync(join(containers(root), 'mysql.env')), `${root} has no environment file`);
      remove(first);
      assert.deepEqual(readdirSync(stand.state).sort(), ['another-project', two].sort());
      assert.deepEqual(projects(first.root), [], 'remove leaves the directory of its project');
      assert.ok(!existsSync(join(containers(first.root), 'mysql.env')), 'remove leaves the environment file of its checkout');
      assert.ok(existsSync(join(containers(second.root), 'mysql.env')), 'remove of one checkout removes the environment file of another');
      remove(second);
      assert.deepEqual(readdirSync(stand.state), ['another-project']);
    });
  }));

caseTest('a start of MySQL has a service for each server on a tmpfs, the certificate of bay and no published port, and prepares the servers with bay exec in the order of the native servers (BAY1, BAY4, BAY9, BAY11)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const variables = await start('mysql', context);
      const project = only(context.root);
      const text = compose(context.root, project);
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mysql', 'mysql-replica'], 'the project has another service than one per server');
      assert.deepEqual([...text.matchAll(/^ {4}image: "(.*)"$/gm)].map(match => /^docker\.io\/library\/mysql@sha256:[0-9a-f]{64}$/.test(match[1] ?? '')), [true, true], 'an image is not pinned by its digest');
      assert.equal([...text.matchAll(/^ {4}expose: \["3306"\]$/gm)].length, 2);
      assert.ok(!/^\s*ports:/m.test(text), 'a service publishes a port');
      assert.equal([...text.matchAll(/^ {4}tmpfs: \["\/var\/lib\/mysql"\]$/gm)].length, 2, 'the data of a server is not on a tmpfs');
      assert.ok(!/^\s*volumes:/m.test(text), 'a MySQL service mounts a file of the host');
      // The healthcheck runs the readiness program of the server over TCP; start_period declares the initialization
      // of the image, and the count of probes after it is within what bay accepts (1 to 100).
      assert.equal([...text.matchAll(/^ {6}test: \["CMD", "mysqladmin", "ping", "--host=127\.0\.0\.1", "--protocol=TCP", "--silent"\]\n {6}interval: "1s"\n {6}timeout: "5s"\n {6}retries: 10\n {6}start_period: "600s"$/gm)].length, 2, 'a server has no healthcheck with mysqladmin ping over TCP and a start period');
      // Each server presents the certificate that bay gives its container.
      for (const option of ['--ssl-ca=/etc/bay/tls/ca.pem', '--ssl-cert=/etc/bay/tls/cert.pem', '--ssl-key=/etc/bay/tls/key.pem']) assert.equal(text.split(`"${option}"`).length, 3, `a server does not take ${option}`);
      assert.ok(text.includes('"--skip-replica-start"'), 'the replica starts its replication before the primary reset its binary log');
      // The DSNs name each server by the host name that bay reports, and the mismatch DSN by its IPv4 address.
      const host = `${project}-mysql.${SUFFIX}`;
      assert.equal(variables['ORM_TEST_MYSQL_DSN'], `mysql://root@${host}:3306/orm_test`);
      assert.equal(variables['ORM_TEST_MYSQL_REPLICA_DSN'], `mysql://root@${project}-mysql-replica.${SUFFIX}:3306/orm_test`);
      assert.equal(variables['ORM_TEST_MYSQL_TLS_DSN'], `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${AUTHORITY}`);
      assert.equal(variables['ORM_TEST_MYSQL_TLS_MISMATCH_DSN'], `mysql://root@${ADDRESS}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${AUTHORITY}`);
      const other = join(containers(context.root), project, 'tls/other-ca.pem');
      assert.equal(variables['ORM_TEST_MYSQL_TLS_OTHER_CA_DSN'], `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${other}`);
      assert.ok(existsSync(other), 'the second CA of the TLS cases is not issued');
      assert.ok(!('ORM_TEST_MYSQL_SOCKET' in variables), 'the environment names a Unix socket, which bay does not publish');
      assert.match(readFileSync(join(containers(context.root), 'mysql.env'), 'utf8'), new RegExp(`^export ORM_TEST_MYSQL_DSN='mysql://root@${host}:3306/orm_test'$`, 'm'));
      // bay plans the project, reports its images and starts it without a pull; then each step runs in its started server.
      const ran = commands(stand);
      assert.deepEqual(ran.slice(0, 3), ['plan --json', 'images --json', 'up -no-pull --json']);
      const steps = calls(stand).filter(call => call.args[2] === 'exec').map(call => [call.args[3], call.args.at(-1)?.split(';')[0]]);
      assert.deepEqual(steps, [
        ['mysql', 'RESET BINARY LOGS AND GTIDS'],
        ['mysql-replica', `CHANGE REPLICATION SOURCE TO SOURCE_HOST='${host}', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1`],
        ['mysql', 'CREATE DATABASE orm_test'],
      ], 'the replica does not follow the primary from its reset binary log before the databases are created');
      const [, follow, databases] = calls(stand).filter(call => call.args[2] === 'exec').map(call => call.args.at(-1) ?? '');
      for (const statement of ['START REPLICA', 'SET GLOBAL super_read_only = ON', REPLICA_PARTIAL_REVOKES_SQL]) assert.ok(follow?.includes(statement), `the replica misses ${statement}: ${follow}`);
      assert.ok(databases?.includes('CREATE DATABASE orm_tools') && databases.includes(ORM_ACCOUNTS_SQL), `the primary has no databases and accounts of the user orm: ${databases}`);
      assert.equal(ran.length, 6, `the start ran another command of bay: ${ran.join(' | ')}`);
    });
  }));

caseTest('the starts of PostgreSQL and MariaDB run the readiness program of their server and escape each dollar sign (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [postgres, mariadb] = checkouts(dir, stand);
    await removing([postgres, mariadb], async () => {
      const variables = await start('postgres', postgres);
      const project = only(postgres.root);
      const text = compose(postgres.root, project);
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['postgres', 'postgres-replica']);
      assert.equal([...text.matchAll(/^ {6}test: \["CMD", "pg_isready", "--host=127\.0\.0\.1", "--username=orm", "--dbname=postgres"\]$/gm)].length, 2);
      assert.match(text, /^ {4}depends_on:\n {6}postgres:\n {8}condition: "service_healthy"$/m, 'the standby does not wait for a healthy primary');
      assert.equal([...text.matchAll(/^ {4}tmpfs: \["\/var\/lib\/postgresql\/data"\]$/gm)].length, 2);
      // Compose reads $NAME in a value as a variable of the environment of bay, so a dollar sign of a command is written twice.
      assert.ok(text.includes('exec docker-entrypoint.sh \\"$$@\\"'), 'the command of PostgreSQL keeps a single dollar sign');
      assert.ok(!/(^|[^$])\$([^$]|$)/m.test(text), 'the Compose file has a dollar sign that is not escaped');
      assert.ok(text.includes('/etc/bay/tls/key.pem') && text.includes('ssl_cert_file=/etc/bay/tls/cert.pem'), 'PostgreSQL does not present the certificate of bay');
      // The standby copies the primary by the host name that bay plans for it.
      assert.ok(text.includes(`host=${project}-postgres.${SUFFIX} port=5432 user=orm application_name=orm_replica`), 'the standby does not copy the primary by its planned name');
      // The rule that lets the standby connect is in place before the primary accepts connections, since bay up starts the standby.
      assert.ok(text.includes(`"./postgres-init:/docker-entrypoint-initdb.d:ro"`), 'the primary does not mount its initialization file');
      assert.ok(readFileSync(join(containers(postgres.root), project, 'postgres-init/orm.sh'), 'utf8').includes('host replication orm all trust'), 'the primary does not let the role orm replicate');
      const steps = calls(stand).filter(call => call.args[2] === 'exec').map(call => call.args.slice(3));
      assert.deepEqual(steps, [['postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'orm', '-d', 'postgres', '-c', 'CREATE DATABASE orm_test', '-c', 'CREATE DATABASE orm_tools']]);
      assert.equal(variables['ORM_TEST_POSTGRES_DSN'], `postgres://orm@${project}-postgres.${SUFFIX}:5432/orm_test`);
      assert.equal(variables['ORM_TEST_POSTGRES_REPLICA_DSN'], `postgres://orm@${project}-postgres-replica.${SUFFIX}:5432/orm_test`);
      assert.equal(variables['ORM_TEST_POSTGRES_TLS_DSN'], `postgres://orm@${project}-postgres.${SUFFIX}:5432/orm_test?sslmode=verify-full&sslrootcert=${AUTHORITY}`);

      const mariadbVariables = await start('mariadb', mariadb);
      const mariadbProject = only(mariadb.root);
      const mariadbText = compose(mariadb.root, mariadbProject);
      assert.deepEqual([...mariadbText.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mariadb']);
      assert.match(mariadbText, /^ {6}test: \["CMD", "healthcheck\.sh", "--connect", "--innodb_initialized"\]$/m);
      const mariadbSteps = calls(stand).filter(call => call.args[1] === mariadbProject && call.args[2] === 'exec').map(call => call.args.slice(3));
      assert.deepEqual(mariadbSteps.map(step => step.slice(0, 2)), [['mariadb', 'mariadb']]);
      assert.ok(mariadbSteps[0]?.at(-1)?.includes(ORM_ACCOUNTS_SQL), 'the MariaDB primary has no accounts of the user orm');
      assert.equal(mariadbVariables['ORM_TEST_MARIADB_DSN'], `mysql://root@${mariadbProject}-mariadb.${SUFFIX}:3306/orm_test`);
      assert.ok(!('ORM_TEST_MARIADB_SOCKET' in mariadbVariables));
    });
  }));

caseTest('a run removes its project when its command ends, fails or gets SIGINT or SIGTERM (BAY1, T444)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const node = process.execPath;
      const left = (when: string) => {
        assert.deepEqual(readdirSync(stand.state), [], `a run that ${when} leaves its project`);
        assert.deepEqual(projects(context.root), [], `a run that ${when} leaves the directory of its project`);
        assert.ok(!existsSync(join(containers(context.root), 'mysql.env')), `a run that ${when} writes an environment file`);
      };
      const ended = await run('mysql', [node, '-e', 'if (!/^mysql:\\/\\/root@orm-[0-9a-f]{12}-[0-9a-f]{8}-mysql\\.stand-in\\.test:3306\\/orm_test$/.test(process.env.ORM_TEST_MYSQL_DSN)) process.exit(9)'], context);
      assert.deepEqual(ended, { code: 0, signal: null }, 'the command does not read the DSN of its server');
      left('ended');
      const failed = await run('mysql', [node, '-e', 'process.exit(3)'], context);
      assert.deepEqual(failed, { code: 3, signal: null });
      left('failed');
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const signals = new EventEmitter();
        // The run calls started once its command has spawned; the test sends the signal then, and the run forwards it.
        const waiting = run('mysql', [node, '-e', 'setInterval(() => {}, 2 ** 30)'], context, { signals, started: () => signals.emit(signal) });
        assert.deepEqual(await waiting, { code: null, signal }, `a run that got ${signal} does not end its command with it`);
        left(`got ${signal}`);
      }
      assert.deepEqual(verbs(stand).filter(verb => verb === 'up' || verb === 'down'), ['up', 'down', 'up', 'down', 'up', 'down', 'up', 'down'], 'a run does not remove its project with bay down');
    });
  }));

caseTest('two runs of one kind in one checkout have a project each, and a second start of a kind is refused (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const node = process.execPath;
      const both = await Promise.all([run('mysql', [node, '-e', ''], context), run('mysql', [node, '-e', ''], context)]);
      assert.deepEqual(both, [{ code: 0, signal: null }, { code: 0, signal: null }]);
      const ups = calls(stand).filter(call => call.args[2] === 'up').map(call => call.args[1]);
      assert.equal(new Set(ups).size, 2, 'two runs share a project');
      assert.deepEqual(readdirSync(stand.state), []);
      await start('mysql', context);
      await assert.rejects(start('mysql', context), /mysql is started in this checkout; run make orm-test-container-stop, which removes it/);
      assert.equal(projects(context.root).length, 1, 'a refused start leaves a project');
      await start('postgres', context);
      assert.equal(projects(context.root).length, 2, 'two kinds do not run together');
    });
  }));

caseTest('a start whose bay up fails prints the last lines of each service and removes its project (BAY1, T444)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.upFails, '');
      await assert.rejects(start('mysql', context), /bay up of orm-[0-9a-f]{12}-[0-9a-f]{8} exited with 1/);
      assert.deepEqual(commands(stand), ['plan --json', 'images --json', 'up -no-pull --json', 'logs -n 50 mysql', 'logs -n 50 mysql-replica', 'down']);
      assert.deepEqual(readdirSync(stand.state), [], 'a failed start leaves its project');
      assert.deepEqual(projects(context.root), [], 'a failed start leaves the directory of its project');
      assert.ok(!existsSync(join(containers(context.root), 'mysql.env')), 'a failed start leaves an environment file');
    });
  }));

caseTest('a start whose step fails in a started server names the step and its status and removes its project (BAY9)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.execFails, '');
      await assert.rejects(start('mysql', context), /bay exec mysql mysql -uroot -e RESET BINARY LOGS AND GTIDS of orm-[0-9a-f]{12}-[0-9a-f]{8} exited with 7:\nERROR 1045: the statement failed/);
      assert.equal(verbs(stand).filter(verb => verb === 'exec').length, 1, 'a start runs a step after a failed one');
      assert.equal(verbs(stand).at(-1), 'down');
      assert.deepEqual(readdirSync(stand.state), [], 'a start with a failed step leaves its project');
      assert.deepEqual(projects(context.root), []);
    });
  }));

caseTest('a start pulls no image: an absent image fails naming the install target before bay up, which runs with -no-pull, and the install target pulls with bay (BAY3)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.absent, '');
      await assert.rejects(start('mysql', context), /the image docker\.io\/library\/mysql@sha256:[0-9a-f]{64} of the service mysql is not on this machine; run make orm-install-container-images, which pulls the images of config\/containers\.json/);
      assert.ok(!verbs(stand).includes('up'), 'bay up ran for an image that is not on the machine');
      assert.deepEqual(projects(context.root), [], 'a start with an absent image leaves a directory');
      writeFileSync(stand.calls, '');
      pull(context);
      assert.deepEqual(commands(stand), ['pull'], 'the install target does not pull with bay pull alone');
      const pulled = calls(stand).find(call => call.args[2] === 'pull');
      assert.ok(pulled && !existsSync(pulled.cwd), 'the install target leaves the directory of its Compose file');
      assert.deepEqual(readdirSync(stand.state), [], 'the install target started a project');
    });
  }));

caseTest('a start with a missing bay, or a bay of another contract, fails naming it and what provides it, and creates nothing (BAY1, BAY5)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const missing = join(dir, 'missing');
      await assert.rejects(start('mysql', { ...context, bay: missing }), new RegExp(`${missing} is missing: it is the program bay, which runs the Compose project of the servers; install bay at that path`));
      writeFileSync(stand.schema, '2');
      await assert.rejects(start('mysql', context), /bay version --json reports the contract schema version 2, and this script is written for 1; install a bay of that contract/);
      assert.deepEqual(projects(context.root), [], 'a start with a missing program leaves a directory');
      assert.deepEqual(commands(stand), [], 'a start with a bay of another contract ran a command of a project');
    });
  }));
