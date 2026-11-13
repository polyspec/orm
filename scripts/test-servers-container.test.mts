// The tests of scripts/test-servers-container.mts (BAY1, T444). They run the script against a stand-in bay and a stand-in
// container engine that each test writes into its own directory, so they need no container and no image. The stand-in
// bay keeps one file per project under its state directory: up reads the project name from compose.yaml of its working
// directory and records the project, down removes that file, and logs prints one line. brief --json prints the form of
// a service address with a suffix of the stand-in alone, and status --json prints each recorded project with the
// address of each service in that form, so a script that holds a suffix of its own fails. Each call of both stand-ins is a
// line of calls.log. Neither stand-in starts a process that stays, so nothing outlives a test (HR-87). Each test names
// two checkouts by two directories of its own. A test runs the stand-ins and openssl, which issues the keys of each start, as
// child processes, so each has the deadline of the class PROCESS.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { caseTest, PROCESS, withTemporaryDirectory } from '../tests/testcase.mts';
import { remove, run, start, type Context } from './test-servers-container.mts';
import { ORM_ACCOUNTS_SQL } from './test-servers.mts';

// ADDRESS is the IPv4 address that the stand-in bay reports for every service, and SUFFIX the suffix of its service
// addresses, which no bay has.
const ADDRESS = '192.168.64.9';
const SUFFIX = 'stand-in.test';

// StandIn has the paths of the stand-in programs of a test, the directory of the projects that the stand-in bay holds,
// and the files that change what the stand-ins do: while upFails exists, up records its project and exits with 1, and
// while absent exists, image inspect exits with 1 as the engine does for an image that is not on the machine, and while
// renamed exists, status reports each service at another address than brief states.
interface StandIn { bay: string; engine: string; state: string; calls: string; upFails: string; absent: string; renamed: string }

function standIn(dir: string): StandIn {
  const stand: StandIn = {
    bay: join(dir, 'bay.mjs'), engine: join(dir, 'engine.mjs'), state: join(dir, 'projects'), calls: join(dir, 'calls.log'),
    upFails: join(dir, 'up-fails'), absent: join(dir, 'absent'), renamed: join(dir, 'renamed'),
  };
  mkdirSync(stand.state, { recursive: true });
  writeFileSync(stand.calls, '');
  const record = `appendFileSync(${JSON.stringify(stand.calls)}, JSON.stringify({ program, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');`;
  writeFileSync(stand.bay, `#!${process.execPath}
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const program = 'bay';
${record}
const [command, ...rest] = process.argv.slice(2);
const project = () => {
  const name = /^name: "([^"]+)"$/m.exec(readFileSync('compose.yaml', 'utf8'))?.[1];
  if (!name) { console.error('compose.yaml names no project'); process.exit(1); }
  return join(${JSON.stringify(stand.state)}, name);
};
if (command === 'up' && rest.length === 0) {
  if (existsSync(project())) { console.error('the project is up'); process.exit(1); }
  writeFileSync(project(), process.cwd());
  if (existsSync(${JSON.stringify(stand.upFails)})) { console.error('service mysql is unhealthy'); process.exit(1); }
  console.log('all services accept connections');
} else if (command === 'down' && rest.length === 0) rmSync(project(), { force: true });
else if (command === 'logs') console.log('the last lines of ' + rest.at(-1));
else if (command === 'brief' && rest.join(' ') === '--json') console.log(JSON.stringify({ schemaVersion: '1', serviceAddress: '<project>-<service>.${SUFFIX}:<port>' }));
else if (command === 'status' && rest.join(' ') === '--json') {
  const suffix = existsSync(${JSON.stringify(stand.renamed)}) ? 'renamed.test' : '${SUFFIX}';
  const groups = readdirSync(${JSON.stringify(stand.state)}).map(name => {
    const directory = readFileSync(join(${JSON.stringify(stand.state)}, name), 'utf8');
    if (directory === '') return { name, stackPath: '', services: null };
    const text = readFileSync(join(directory, 'compose.yaml'), 'utf8');
    const services = [...text.matchAll(/^ {2}([a-z-]+):\\n(?: {4}.*\\n)*? {4}expose: \\["(\\d+)"\\]$/gm)].map(([, service, port]) =>
      ({ name: service, container: name + '-' + service, state: 'running', ipv4: '${ADDRESS}', address: name + '-' + service + '.' + suffix + ':' + port, accepting: true }));
    return { name, stackPath: join(directory, 'compose.yaml'), services };
  });
  console.log(JSON.stringify({ machine: {}, groups }));
}
else { console.error('unknown command ' + command); process.exit(2); }
`);
  writeFileSync(stand.engine, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const program = 'engine';
${record}
const [noun, verb] = process.argv.slice(2);
if (noun === 'image' && verb === 'inspect') { if (existsSync(${JSON.stringify(stand.absent)})) { console.error('Error: image not found'); process.exit(1); } }
else if (noun === 'image' && verb === 'pull') {}
else { console.error('unknown command ' + noun + ' ' + verb); process.exit(2); }
`);
  for (const program of [stand.bay, stand.engine]) chmodSync(program, 0o755);
  return stand;
}

// Call is a line of calls.log: the stand-in that ran, its working directory and its arguments.
interface Call { program: string; cwd: string; args: string[] }

function calls(stand: StandIn): Call[] {
  return readFileSync(stand.calls, 'utf8').split('\n').filter(line => line !== '').map(line => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || !('program' in parsed) || !('cwd' in parsed) || !('args' in parsed)) throw new Error(`calls.log holds no call: ${line}`);
    const { program, cwd, args } = parsed;
    if (typeof program !== 'string' || typeof cwd !== 'string' || !Array.isArray(args) || !args.every((item): item is string => typeof item === 'string')) throw new Error(`calls.log holds no call: ${line}`);
    return { program, cwd, args };
  });
}

// commands are the calls of the stand-in bay as the first argument of each.
const commands = (stand: StandIn) => calls(stand).filter(call => call.program === 'bay').map(call => call.args[0]);

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
  const context = (root: string): Context => ({ root, bay: stand.bay, engine: stand.engine });
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

caseTest('two checkouts start a server of the same kind at once, each as a project of its own (BAY1, T444)', PROCESS, () =>
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

caseTest('the Compose file of MySQL has a service for each server, pinned images, a healthcheck over TCP and no published port (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const variables = await start('mysql', context);
      const project = only(context.root);
      const text = compose(context.root, project);
      assert.match(text, new RegExp(`^name: "${project}"$`, 'm'));
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mysql', 'mysql-replica'], 'the project has another service than one per server');
      assert.deepEqual([...text.matchAll(/^ {4}image: "(.*)"$/gm)].map(match => /^docker\.io\/library\/mysql@sha256:[0-9a-f]{64}$/.test(match[1] ?? '')), [true, true], 'an image is not pinned by its digest');
      assert.equal([...text.matchAll(/^ {4}expose: \["3306"\]$/gm)].length, 2);
      assert.ok(!/^\s*ports:/m.test(text), 'a service publishes a port');
      assert.equal([...text.matchAll(/^ {6}test: \["CMD", "mysqladmin", "ping", "--host=127\.0\.0\.1", "--protocol=TCP", "--silent"\]$/gm)].length, 2, 'a server has no healthcheck with mysqladmin ping over TCP');
      assert.match(text, /^ {4}depends_on:\n {6}mysql:\n {8}condition: "service_healthy"$/m, 'the replica does not wait for a healthy primary');
      assert.ok(!text.includes('--skip-replica-start'), 'the replica does not start its replication when its server starts');
      // The DSNs name each server by the address that bay reports for its service, and the mismatch DSN by its IPv4 address.
      const host = `${project}-mysql.${SUFFIX}`;
      assert.equal(variables['ORM_TEST_MYSQL_DSN'], `mysql://root@${host}:3306/orm_test`);
      assert.equal(variables['ORM_TEST_MYSQL_REPLICA_DSN'], `mysql://root@${project}-mysql-replica.${SUFFIX}:3306/orm_test`);
      const tls = join(containers(context.root), project, 'tls');
      assert.equal(variables['ORM_TEST_MYSQL_TLS_DSN'], `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${tls}/ca.pem`);
      assert.equal(variables['ORM_TEST_MYSQL_TLS_MISMATCH_DSN'], `mysql://root@${ADDRESS}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${tls}/ca.pem`);
      assert.ok(!('ORM_TEST_MYSQL_SOCKET' in variables), 'the environment names a Unix socket, which bay does not publish');
      assert.match(readFileSync(join(containers(context.root), 'mysql.env'), 'utf8'), new RegExp(`^export ORM_TEST_MYSQL_DSN='mysql://root@${host}:3306/orm_test'$`, 'm'));
      // The setup of each server is a file of the initialization directory of its image.
      const primary = readFileSync(join(containers(context.root), project, 'mysql-init/orm.sql'), 'utf8');
      const order = ['RESET BINARY LOGS AND GTIDS', 'CREATE DATABASE orm_test', 'CREATE DATABASE orm_tools', ORM_ACCOUNTS_SQL].map(statement => primary.indexOf(statement));
      assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? -1))), `the primary does not reset its binary log before the databases and the accounts: ${primary}`);
      const replica = readFileSync(join(containers(context.root), project, 'mysql-replica-init/orm.sql'), 'utf8');
      assert.ok(replica.includes(`CHANGE REPLICATION SOURCE TO SOURCE_HOST='${host}', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1;`), `the replica does not name the primary: ${replica}`);
      for (const setting of ['SET PERSIST partial_revokes = ON;', 'SET PERSIST super_read_only = ON;']) assert.ok(replica.includes(setting), `the replica misses ${setting}: ${replica}`);
      for (const service of ['mysql', 'mysql-replica']) assert.ok(text.includes(`"./${service}-init:/docker-entrypoint-initdb.d:ro"`), `${service} does not mount its initialization files`);
      // The script reads the form of a service address before it issues the certificate, asks the engine for the image
      // before bay up, and reads the addresses of its services after it.
      assert.deepEqual(calls(stand).map(call => `${call.program} ${call.args.slice(0, 2).join(' ')}`), ['bay brief --json', 'engine image inspect', 'bay up', 'bay status --json']);
      const certificate = new X509Certificate(readFileSync(join(tls, 'mysql-cert.pem')));
      assert.equal(certificate.subjectAltName, `DNS:${host}`, 'the certificate does not name the address that bay reports');
    });
  }));

caseTest('the Compose files of PostgreSQL and MariaDB run the readiness program of their server and escape each dollar sign (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [postgres, mariadb] = checkouts(dir, stand);
    await removing([postgres, mariadb], async () => {
      const variables = await start('postgres', postgres);
      const project = only(postgres.root);
      const text = compose(postgres.root, project);
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['postgres', 'postgres-replica']);
      assert.equal([...text.matchAll(/^ {6}test: \["CMD", "pg_isready", "--host=127\.0\.0\.1", "--username=orm", "--dbname=postgres"\]$/gm)].length, 2);
      assert.match(text, /^ {4}depends_on:\n {6}postgres:\n {8}condition: "service_healthy"$/m);
      // Compose reads $NAME in a value as a variable of the environment of bay, so a dollar sign of a command is written twice.
      assert.ok(text.includes('exec docker-entrypoint.sh \\"$$@\\"'), 'the command of PostgreSQL keeps a single dollar sign');
      assert.ok(!/(^|[^$])\$([^$]|$)/m.test(text), 'the Compose file has a dollar sign that is not escaped');
      assert.ok(text.includes(`host=${project}-postgres.${SUFFIX} port=5432 user=orm application_name=orm_replica`), 'the standby does not copy the primary by its name');
      const init = readFileSync(join(containers(postgres.root), project, 'postgres-init/orm.sh'), 'utf8');
      assert.ok(init.indexOf("host replication orm all trust") >= 0 && init.includes('CREATE DATABASE orm_test') && init.includes('CREATE DATABASE orm_tools'), `the primary does not allow replication and create the databases: ${init}`);
      assert.equal(variables['ORM_TEST_POSTGRES_DSN'], `postgres://orm@${project}-postgres.${SUFFIX}:5432/orm_test`);
      assert.equal(variables['ORM_TEST_POSTGRES_REPLICA_DSN'], `postgres://orm@${project}-postgres-replica.${SUFFIX}:5432/orm_test`);

      const mariadbVariables = await start('mariadb', mariadb);
      const mariadbProject = only(mariadb.root);
      const mariadbText = compose(mariadb.root, mariadbProject);
      assert.deepEqual([...mariadbText.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mariadb']);
      assert.match(mariadbText, /^ {6}test: \["CMD", "healthcheck\.sh", "--connect", "--innodb_initialized"\]$/m);
      assert.ok(readFileSync(join(containers(mariadb.root), mariadbProject, 'mariadb-init/orm.sql'), 'utf8').includes(ORM_ACCOUNTS_SQL), 'the MariaDB primary has no accounts of the user orm');
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
      assert.deepEqual(commands(stand).filter(command => command === 'up' || command === 'down'), ['up', 'down', 'up', 'down', 'up', 'down', 'up', 'down'], 'a run does not remove its project with bay down');
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
      const ups = calls(stand).filter(call => call.program === 'bay' && call.args[0] === 'up').map(call => call.cwd);
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
      assert.deepEqual(calls(stand).filter(call => call.program === 'bay').map(call => call.args.join(' ')), ['brief --json', 'up', 'logs -n 50 mysql', 'logs -n 50 mysql-replica', 'down']);
      assert.deepEqual(readdirSync(stand.state), [], 'a failed start leaves its project');
      assert.deepEqual(projects(context.root), [], 'a failed start leaves the directory of its project');
      assert.ok(!existsSync(join(containers(context.root), 'mysql.env')), 'a failed start leaves an environment file');
    });
  }));

caseTest('a start pulls no image: an absent image fails naming the install target, before bay runs (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.absent, '');
      await assert.rejects(start('mysql', context), /the image docker\.io\/library\/mysql@sha256:[0-9a-f]{64} of mysql is not on this machine; run make orm-install-container-images, which pulls the images of config\/containers\.json/);
      assert.ok(!commands(stand).includes('up'), 'bay up ran for an image that is not on the machine');
      assert.deepEqual(projects(context.root), [], 'a start with an absent image leaves a directory');
    });
  }));

caseTest('a start with a missing program fails naming the program and what provides it, and creates nothing (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const missing = join(dir, 'missing');
      await assert.rejects(start('mysql', { ...context, bay: missing }), new RegExp(`${missing} is missing: it is the program bay, which runs the Compose project of the servers; install bay at that path`));
      await assert.rejects(start('mysql', { ...context, engine: missing }), new RegExp(`${missing} is missing: it is the container engine, which holds the images of the servers; install`));
      assert.deepEqual(projects(context.root), [], 'a start with a missing program leaves a directory');
      assert.ok(!commands(stand).includes('up'), 'a start with a missing program ran bay up');
    });
  }));

caseTest('a start reads each address from bay: a service that bay reports at another address fails the start and removes its project (BAY1)', PROCESS, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.renamed, '');
      await assert.rejects(start('mysql', context), /bay status reports the service mysql of orm-[0-9a-f]{12}-[0-9a-f]{8} at orm-[0-9a-f-]+-mysql\.renamed\.test:3306, and bay brief states orm-[0-9a-f-]+-mysql\.stand-in\.test:3306/);
      assert.deepEqual(readdirSync(stand.state), [], 'a start with another address leaves its project');
      assert.deepEqual(projects(context.root), []);
    });
  }));
