// The tests of scripts/test-servers-container.mts (BAY1, BAY12, T444). They run the script, and the run.sh that it
// writes, against a stand-in bay that each test writes into its own directory, so they need no container and no image.
// The stand-in takes the project name from the option -p and keeps one file per project under its state directory: up
// records the project, down removes that file, plan --json prints the host name of each service with a suffix of the
// stand-in alone and the path of its authority, so a script that holds a suffix of its own fails, images reports each
// image, exec getent prints an address, another exec and logs print one line, and version prints the schema version.
// Each call is a line of calls.log. The stand-in starts no process that stays, so nothing outlives a test (HR-87). Each
// test names two checkouts by two directories of its own. A test runs sh, the stand-in and openssl, which issues the
// second CA of each start, as child processes, and ends when they end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { caseTest, withTemporaryDirectory } from '../tests/testcase.mts';
import { installBay, kinds, pull, remote, remove, run, start, type Context } from './test-servers-container.mts';
import { ORM_ACCOUNTS_SQL } from './test-servers.mts';

// ADDRESS is the IPv4 address that the stand-in bay resolves every host name to, SUFFIX the suffix of its host names,
// which no bay has, and AUTHORITY the path that it reports for the certificate of its authority.
const ADDRESS = '192.168.64.9';
const SUFFIX = 'stand-in.test';
const AUTHORITY = '/stand-in/authority.crt';
// VERSION is the version that the stand-in bay reports: that of a build of a machine, which no release has.
const VERSION = 'v0.0.0-stand-in+dirty';

// StandIn has the path of the stand-in bay of a test, which is named bay in a directory of its own, so that a stand-in
// ssh finds it on PATH; the directory of the projects that it holds; and the files that change what it does: while
// upFails exists, an up records its project and exits with 1, and the job check fails as its servers would; while absent
// exists, images reports each image as missing and up -no-pull and job add fail before they record anything; while
// execFails exists, a step of a server exits with 7; while schema exists, version reports its text as the schema
// version, and while release exists, its text as the version of bay; while checkFails exists, the command of the job
// check exits with 5, and while buildFails exists, the build command of the job build exits with 6. A job runs when it
// is added, and a job added again with its key is returned and does not run; while unended exists, a job added is
// queued and does not end, and its wait exits with 1 as a wait that ends before its job does. ups.log has the services of each up and
// each job.
interface StandIn { bay: string; state: string; calls: string; upFails: string; absent: string; execFails: string; schema: string; release: string; checkFails: string; buildFails: string; unended: string; ups: string }

function standIn(dir: string): StandIn {
  const stand: StandIn = {
    bay: join(dir, 'bin/bay'), state: join(dir, 'projects'), calls: join(dir, 'calls.log'),
    upFails: join(dir, 'up-fails'), absent: join(dir, 'absent'), execFails: join(dir, 'exec-fails'), schema: join(dir, 'schema'), release: join(dir, 'release-version'), checkFails: join(dir, 'check-fails'), buildFails: join(dir, 'build-fails'), unended: join(dir, 'unended'), ups: join(dir, 'ups.log'),
  };
  mkdirSync(stand.state, { recursive: true });
  mkdirSync(dirname(stand.bay), { recursive: true });
  writeFileSync(stand.calls, '');
  writeFileSync(stand.bay, `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
appendFileSync(${JSON.stringify(stand.calls)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const fail = (text, status = 1) => { console.error('bay: ' + text); process.exit(status); };
let [option, name, command, ...rest] = process.argv.slice(2);
// -f names the Compose file; without it, compose.yaml of the working directory.
let composeFile = 'compose.yaml';
if (command === '-f') { composeFile = rest[0]; [command, ...rest] = rest.slice(1); }
const jobs = ${JSON.stringify(join(dir, 'jobs'))};
const jobOf = id => JSON.parse(readFileSync(join(jobs, id + '.json'), 'utf8'));
// bay job wait, show, logs and cancel name a job by its ID, with or without the project.
if (option === 'job' || (option === '-p' && command === 'job' && rest[0] !== 'add')) {
  if (option === '-p') name = rest[0];
  const id = process.argv.at(-1);
  if (!existsSync(join(jobs, id + '.json'))) fail('no job ' + id);
  const job = jobOf(id);
  if (name === 'wait') process.exit(job.exitCode === 0 ? 0 : 1);
  if (name === 'show') { console.log(JSON.stringify(job, null, 2)); process.exit(0); }
  if (name === 'logs') { console.log('the output of the job ' + id); process.exit(0); }
  if (name === 'cancel') process.exit(0);
  fail('unknown job command ' + name, 2);
}
const is = (...words) => command === words[0] && rest.join(' ') === words.slice(1).join(' ');
if (option === 'version') {
  const schema = existsSync(${JSON.stringify(stand.schema)}) ? Number(readFileSync(${JSON.stringify(stand.schema)}, 'utf8')) : 1;
  const version = existsSync(${JSON.stringify(stand.release)}) ? readFileSync(${JSON.stringify(stand.release)}, 'utf8') : ${JSON.stringify(VERSION)};
  console.log(name === '--json' ? JSON.stringify({ version, schemaVersion: schema }) : 'bay ' + version + ' (0000) go0 test/test schema ' + schema);
  process.exit(0);
}
if (option !== '-p' || !name) fail('the stand-in takes the project name from -p', 2);
const project = join(${JSON.stringify(stand.state)}, name);
const services = () => {
  const text = readFileSync(composeFile, 'utf8');
  if (/^name:/m.test(text)) fail('compose.yaml names a project');
  return [...text.matchAll(/^ {2}([a-z-]+):\\n(?: {4,}.*\\n)*? {4}image: "(.*)"$/gm)].map(([, service, image]) => {
    const port = Number(new RegExp('^ {2}' + service + ':\\\\n(?: {4,}.*\\\\n)*? {4}expose: \\\\["(\\\\d+)"\\\\]$', 'm').exec(text)?.[1] ?? 0);
    return { name: service, host: name + '-' + service + '.${SUFFIX}', port, image, certificate: { ca: ${JSON.stringify(AUTHORITY)}, containerCa: '/stand-in/mounted-authority.pem' } };
  });
};
const absent = existsSync(${JSON.stringify(stand.absent)});
if (is('plan', '--json')) console.log(JSON.stringify({ schemaVersion: 1, project: name, services: services() }));
else if (is('images')) {
  for (const service of services()) console.log(service.name + ' ' + service.image + ' ' + (absent ? 'missing' : 'present'));
  if (absent) fail('an image is not in the local store');
} else if (is('up', '-no-pull')) {
  if (absent) fail('an image is not in the local store');
  // A second up of a project adds the services that its Compose file now declares and keeps the others.
  appendFileSync(${JSON.stringify(stand.ups)}, JSON.stringify(services().map(service => service.name)) + '\\n');
  writeFileSync(project, process.cwd());
  if (existsSync(${JSON.stringify(stand.upFails)})) fail('service mysql stopped during healthcheck');
  console.log('all services accept connections');
} else if (command === 'job' && rest[0] === 'add') {
  // A job runs at once: the stand-in records the services that it brings up, writes what the command of the job
  // writes, and keeps the job by its key, so a second add of the key returns it and runs nothing.
  const key = rest[rest.indexOf('-key') + 1];
  const service = rest.at(-1);
  mkdirSync(jobs, { recursive: true });
  const keyed = join(jobs, 'key-' + key);
  if (existsSync(keyed)) { console.log(JSON.stringify(jobOf(readFileSync(keyed, 'utf8')), null, 2)); process.exit(0); }
  if (absent) fail('an image is not in the local store');
  const id = 'job-' + (readdirSync(jobs).filter(each => each.startsWith('key-')).length + 1);
  if (existsSync(${JSON.stringify(stand.unended)})) {
    writeFileSync(join(jobs, id + '.json'), JSON.stringify({ id, project: name, service, key, state: 'queued', queued: '2026-11-14T00:00:00Z' }));
    writeFileSync(keyed, id);
    console.log(JSON.stringify(jobOf(id), null, 2));
    process.exit(0);
  }
  appendFileSync(${JSON.stringify(stand.ups)}, JSON.stringify(services().map(each => each.name)) + '\\n');
  mkdirSync('report', { recursive: true });
  let exitCode = 0;
  if (service === 'build') {
    exitCode = existsSync(${JSON.stringify(stand.buildFails)}) ? 6 : 0;
    writeFileSync('report/build-status', exitCode + '\\n');
  } else if (service === 'check') {
    if (existsSync(${JSON.stringify(stand.upFails)})) exitCode = 1;
    else {
      // Each service setup-<kind> writes the address of the primary of its kind.
      for (const each of services()) if (each.name.startsWith('setup-')) writeFileSync('address-' + each.name.slice('setup-'.length), ${JSON.stringify(ADDRESS)} + '\\n');
      exitCode = existsSync(${JSON.stringify(stand.checkFails)}) ? 5 : 0;
      writeFileSync('report/status', exitCode + '\\n');
      writeFileSync('report/check.log', 'the output of the command\\n');
    }
  } else fail('the stand-in runs the jobs build and check, not ' + service);
  writeFileSync(join(jobs, id + '.json'), JSON.stringify({ id, project: name, service, key, state: exitCode === 0 ? 'succeeded' : 'failed', ended: '2026-11-14T00:00:01Z', exitCode }));
  writeFileSync(keyed, id);
  console.log(JSON.stringify(jobOf(id), null, 2));
} else if (is('down')) rmSync(project, { force: true });
else if (is('pull')) { if (services().length === 0) fail('compose.yaml has no service'); }
else if (command === 'logs') console.log('the last lines of ' + rest.at(-1));
else if (command === 'exec') {
  if (!existsSync(project)) fail('the project is not up');
  // getent ahostsv4 prints IPv4 addresses alone; getent hosts prints the IPv6 address of a service first.
  if (rest[1] === 'getent') console.log(rest[2] === 'ahostsv4' ? ${JSON.stringify(ADDRESS)} + '  STREAM ' + rest.at(-1) + '\\n' + ${JSON.stringify(ADDRESS)} + '  DGRAM' : 'fd36:4b09::62d7 ' + rest.at(-1));
  else if (existsSync(${JSON.stringify(stand.execFails)})) { console.error('ERROR 1045: the statement failed'); process.exit(7); }
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

// commands are the calls of the stand-in bay for a project, each as its arguments after -p <project> and -f <file>.
const commands = (stand: StandIn) => calls(stand).filter(call => call.args[0] === '-p').map(call => call.args.slice(call.args[2] === '-f' ? 4 : 2).join(' '));
// verbs are the first argument of each of those calls.
const verbs = (stand: StandIn) => commands(stand).map(command => command.split(' ')[0]);
// steps are the commands that prepared a started server: each exec but the one that reads the address of the primary
// and those of the runner.
const steps = (stand: StandIn, project?: string) => calls(stand).filter(call => call.args[2] === 'exec' && call.args[4] !== 'getent' && call.args[3] !== 'runner' && (project === undefined || call.args[1] === project)).map(call => call.args.slice(3));

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

// committed makes the checkout of a context a Git repository with one commit, which a run in the runner bundles.
function committed(context: Context): void {
  const git = (...args: string[]) => {
    const ran = spawnSync('git', ['-C', context.root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(ran.status, 0, `git ${args.join(' ')}: ${ran.stderr}`);
  };
  writeFileSync(join(context.root, '.gitignore'), '.runtime/\n');
  writeFileSync(join(context.root, 'tracked.txt'), 'the commit of the run\n');
  git('init', '-q');
  git('add', '.gitignore', 'tracked.txt');
  git('commit', '-q', '-m', 'the commit of the run');
}

// appeared resolves when the file exists: it watches the directory of the file and looks once after the watch started.
function appeared(path: string): Promise<void> {
  return new Promise<void>(resolveAppeared => {
    const watcher = watch(dirname(path), () => { if (existsSync(path)) { watcher.close(); resolveAppeared(); } });
    if (existsSync(path)) { watcher.close(); resolveAppeared(); }
  });
}

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

const file = (root: string, project: string, name: string) => readFileSync(join(containers(root), project, name), 'utf8');
const compose = (root: string, project: string) => file(root, project, 'compose.yaml');

caseTest('two checkouts start a server of the same kind at once, each as a project of its own (BAY1, BAY2, T444)', () =>
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

caseTest('a start of MySQL has a service for each server on a tmpfs, the certificate of bay and no published port, and its run.sh prepares the servers with bay exec in the order of the native servers (BAY1, BAY4, BAY9, BAY11, BAY12.1)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const variables = await start('mysql', context);
      const project = only(context.root);
      const text = compose(context.root, project);
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mysql', 'mysql-replica'], 'the project of a start on the host has another service than one per server');
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
      // The DSNs name each server by the host name of the plan of bay, and the mismatch DSN by the address that the
      // container of the primary resolves that name to.
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
      // The script reads the plan; run.sh then asks for the images, starts without a pull, runs each step in its
      // started server, and reads the address of the primary.
      const ran = commands(stand);
      assert.deepEqual(ran.slice(0, 3), ['plan --json', 'images', 'up -no-pull']);
      assert.deepEqual(steps(stand).map(step => [step[0], step.at(-1)?.split(';')[0]]), [
        ['mysql', 'RESET BINARY LOGS AND GTIDS'],
        ['mysql-replica', `CHANGE REPLICATION SOURCE TO SOURCE_HOST='${host}', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1`],
        ['mysql', 'CREATE DATABASE orm_test'],
      ], 'the replica does not follow the primary from its reset binary log before the databases are created');
      const [, follow, databases] = steps(stand).map(step => step.at(-1) ?? '');
      for (const statement of ['START REPLICA', 'SET GLOBAL super_read_only = ON']) assert.ok(follow?.includes(statement), `the replica misses ${statement}: ${follow}`);
      // The replica sets nothing that the native replica does not set (a catalog row change no longer reads partial_revokes, T426-2).
      assert.ok(follow?.endsWith('SET GLOBAL super_read_only = ON'), `the replica sets more than the native replica does: ${follow}`);
      assert.ok(databases?.includes('CREATE DATABASE orm_tools') && databases.includes(ORM_ACCOUNTS_SQL), `the primary has no databases and accounts of the user orm: ${databases}`);
      assert.equal(ran.at(-1), `exec mysql getent ahostsv4 ${host}`);
      assert.equal(ran.length, 7, `the start ran another command of bay: ${ran.join(' | ')}`);
      // run.sh is a file of sh that names no other program of the host than bay, no timer and no JSON.
      const script = file(context.root, project, 'run.sh');
      assert.ok(script.startsWith('#!/bin/sh\n') && !/\bnode\b|\bjq\b|\bsleep\b|--json/.test(script), 'run.sh needs another program than sh and bay, waits by a timer, or reads JSON');
    });
  }));

caseTest('the starts of PostgreSQL and MariaDB run the readiness program of their server and escape each dollar sign (BAY1)', () =>
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
      assert.ok(file(postgres.root, project, 'postgres-init/orm.sh').includes('host replication orm all trust'), 'the primary does not let the role orm replicate');
      assert.deepEqual(steps(stand), [['postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'orm', '-d', 'postgres', '-c', 'CREATE DATABASE orm_test', '-c', 'CREATE DATABASE orm_tools']]);
      assert.equal(variables['ORM_TEST_POSTGRES_DSN'], `postgres://orm@${project}-postgres.${SUFFIX}:5432/orm_test`);
      assert.equal(variables['ORM_TEST_POSTGRES_REPLICA_DSN'], `postgres://orm@${project}-postgres-replica.${SUFFIX}:5432/orm_test`);
      assert.equal(variables['ORM_TEST_POSTGRES_TLS_DSN'], `postgres://orm@${project}-postgres.${SUFFIX}:5432/orm_test?sslmode=verify-full&sslrootcert=${AUTHORITY}`);

      const mariadbVariables = await start('mariadb', mariadb);
      const mariadbProject = only(mariadb.root);
      const mariadbText = compose(mariadb.root, mariadbProject);
      assert.deepEqual([...mariadbText.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mariadb']);
      assert.match(mariadbText, /^ {6}test: \["CMD", "healthcheck\.sh", "--connect", "--innodb_initialized"\]$/m);
      const mariadbSteps = steps(stand, mariadbProject);
      assert.deepEqual(mariadbSteps.map(step => step.slice(0, 2)), [['mariadb', 'mariadb']]);
      assert.ok(mariadbSteps[0]?.at(-1)?.includes(ORM_ACCOUNTS_SQL), 'the MariaDB primary has no accounts of the user orm');
      assert.equal(mariadbVariables['ORM_TEST_MARIADB_DSN'], `mysql://root@${mariadbProject}-mariadb.${SUFFIX}:3306/orm_test`);
      assert.ok(!('ORM_TEST_MARIADB_SOCKET' in mariadbVariables));
    });
  }));

caseTest('a run on the host removes its project when its command ends, fails or gets SIGINT or SIGTERM (BAY1, BAY12.1, T444)', () =>
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
        const marker = join(dir, `running-${signal}`);
        // The command writes a file once it runs; the test sends the signal when the directory shows the file, an
        // event of the file system, and the run sends it on to run.sh, which ends the command and removes the project.
        const waiting = run('mysql', [node, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); setInterval(() => {}, 2 ** 30)`], context, { signals });
        await appeared(marker);
        signals.emit(signal);
        assert.deepEqual(await waiting, { code: null, signal }, `a run that got ${signal} does not end with it`);
        left(`got ${signal}`);
      }
      assert.deepEqual(verbs(stand).filter(verb => verb === 'up' || verb === 'down'), ['up', 'down', 'up', 'down', 'up', 'down', 'up', 'down'], 'a run does not remove its project with bay down');
    });
  }));

caseTest('two runs of one kind in one checkout have a project each, and a second start of a kind is refused (BAY1)', () =>
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

caseTest('a start whose bay up fails prints the last lines of each service and removes its project (BAY1, T444)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.upFails, '');
      await assert.rejects(start('mysql', context), /bay up of orm-[0-9a-f]{12}-[0-9a-f]{8} exited with 1/);
      assert.deepEqual(commands(stand), ['plan --json', 'images', 'up -no-pull', 'logs -n 50 mysql', 'logs -n 50 mysql-replica', 'down']);
      assert.deepEqual(readdirSync(stand.state), [], 'a failed start leaves its project');
      assert.deepEqual(projects(context.root), [], 'a failed start leaves the directory of its project');
      assert.ok(!existsSync(join(containers(context.root), 'mysql.env')), 'a failed start leaves an environment file');
      // A kept run keeps the output of bay up, which names the service and the cause, the last lines of each service
      // and the failed step in report/ (BAY12.7).
      assert.deepEqual(await run('mysql', ['true'], context, { keep: true }), { code: 1, signal: null });
      const project = only(context.root);
      const output = file(context.root, project, 'report/bay-up-servers.log');
      for (const part of ['bay: service mysql stopped during healthcheck', 'the last lines of mysql\n', 'the last lines of mysql-replica\n']) assert.ok(output.includes(part), `report/bay-up-servers.log misses ${part}: ${output}`);
      assert.equal(file(context.root, project, 'report/bay-up-servers.status'), '1\n');
      assert.match(file(context.root, project, 'report/steps.log'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ bay up of orm-[0-9a-f]{12}-[0-9a-f]{8} exited with 1$/m);
    });
  }));

caseTest('a start whose step fails in a started server names the step and its status and removes its project (BAY9)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.execFails, '');
      await assert.rejects(start('mysql', context), /ERROR 1045: the statement failed\n[^]*bay exec mysql mysql -uroot -e RESET BINARY LOGS AND GTIDS of orm-[0-9a-f]{12}-[0-9a-f]{8} exited with 7/);
      assert.equal(verbs(stand).filter(verb => verb === 'exec').length, 1, 'a start runs a step after a failed one');
      assert.equal(verbs(stand).at(-1), 'down');
      assert.deepEqual(readdirSync(stand.state), [], 'a start with a failed step leaves its project');
      assert.deepEqual(projects(context.root), []);
    });
  }));

caseTest('a start pulls no image: an absent image fails naming the install target before bay up, which runs with -no-pull, and the install target pulls with bay (BAY3)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      writeFileSync(stand.absent, '');
      await assert.rejects(start('mysql', context), /an image of orm-[0-9a-f]{12}-[0-9a-f]{8} is not on this machine; run make orm-install-container-images, which pulls the images of config\/containers\.json/);
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

caseTest('a start with a missing bay, or a bay of another contract, fails naming it and what provides it, and creates nothing (BAY1, BAY5)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      const missing = join(dir, 'missing');
      await assert.rejects(start('mysql', { ...context, bay: missing }), new RegExp(`${missing} is missing: it is the program bay, which runs the Compose project of the servers; install bay on this machine`));
      writeFileSync(stand.schema, '2');
      await assert.rejects(start('mysql', context), /bay version --json reports the contract schema version 2, and this script is written for 1; install a bay of that contract/);
      assert.deepEqual(projects(context.root), [], 'a start with a missing program leaves a directory');
      assert.deepEqual(commands(stand), [], 'a start with a bay of another contract ran a command of a project');
    });
  }));

caseTest('a run in the runner is the job build, which installs the runner from a bundle of the commit, and the job check, which runs its command after setup prepared the servers (BAY12.2, BAY12.3, BAY12.5, BAY13)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context, plain] = checkouts(dir, stand);
    await removing([context, plain], async () => {
      // A run in the runner runs a commit: a checkout that is no repository, or whose tracked files differ, is refused.
      await assert.rejects(run('mysql', ['make', 'test-rust'], plain, { runner: true }), /git status .* exited with/);
      assert.deepEqual(projects(plain.root), [], 'a refused run in the runner leaves a directory');
      committed(context);
      writeFileSync(join(context.root, 'tracked.txt'), 'a change that is not committed\n');
      await assert.rejects(run('mysql', ['make', 'test-rust'], context, { runner: true }), /the tracked files of .* differ from its commit, and a run in the runner runs the commit; commit the changes first/);
      writeFileSync(join(context.root, 'tracked.txt'), 'the commit of the run\n');
      writeFileSync(stand.calls, '');

      const ended = await run('mysql', ['make', "CASES=a 'quoted' case", 'test-rust'], context, { runner: true, keep: true });
      assert.deepEqual(ended, { code: 0, signal: null });
      const project = only(context.root);
      // The part check has the servers, the one-shot service setup after each server is healthy, and the job check
      // after setup; the part build has the job build alone, so no server holds memory during the build.
      const text = file(context.root, project, 'compose.run.yaml');
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mysql', 'mysql-replica', 'setup-mysql', 'check']);
      assert.deepEqual([...file(context.root, project, 'compose.build.yaml').matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['build']);
      const setupService = text.slice(text.indexOf('  setup-mysql:\n'), text.indexOf('  check:\n'));
      assert.match(setupService, /^ {4}command: \["sh", "\/orm-run\/setup-mysql\.sh"\]$/m);
      assert.match(setupService, /^ {4}depends_on:\n {6}mysql:\n {8}condition: "service_healthy"\n {6}mysql-replica:\n {8}condition: "service_healthy"$/m);
      const check = text.slice(text.indexOf('  check:\n'));
      assert.match(check, /^ {4}image: "docker\.io\/library\/debian@sha256:[0-9a-f]{64}"$/m, 'the runner is not a pinned Debian image');
      assert.match(check, /^ {4}command: \["sh", "\/orm-run\/job-check\.sh"\]$/m);
      assert.match(check, /^ {4}depends_on:\n {6}setup-mysql:\n {8}condition: "service_completed_successfully"$/m);
      assert.match(check, /^ {4}x-bay:\n {6}job: true\n {6}timeout: "12h"$/m, 'the check is no job of bay with the timeout of config/containers.json');
      assert.match(file(context.root, project, 'compose.build.yaml'), /^ {4}command: \["sh", "\/orm-run\/job-build\.sh"\]$/m);
      // A job mounts the directory of the run and nothing of the checkout of the host.
      assert.match(check, /^ {4}volumes: \[".:\/orm-run"\]$/m);
      assert.ok(!text.includes(context.root), 'a service mounts the checkout of the host');
      assert.match(check, /^ {6}HOME: "\/orm-run\/home"\n {6}CARGO_HOME: "\/orm-run\/cargo"\n {6}RUSTUP_HOME: "\/orm-run\/rustup"$/m, 'the home and the tools of the runner are not below the directory of the run');
      // setup prepares the servers with the client of the image over TCP, in the order of the native servers, and
      // writes the address of the primary.
      const setup = file(context.root, project, 'setup-mysql.sh');
      const host = (service: string) => `${project}-${service}.${SUFFIX}`;
      const order = [`'mysql' '-h' '${host('mysql')}' '-uroot' '-e' 'RESET BINARY LOGS AND GTIDS'`, `'mysql' '-h' '${host('mysql-replica')}' '-uroot' '-e' 'CHANGE REPLICATION SOURCE TO`, `'mysql' '-h' '${host('mysql')}' '-uroot' '-e' 'CREATE DATABASE orm_test;`, `getent ahostsv4 '${host('mysql')}'`];
      const at = order.map(part => setup.indexOf(part));
      assert.ok(at.every(index => index >= 0) && at.every((index, position) => position === 0 || index > (at[position - 1] ?? 0)), `setup.sh does not prepare the servers in the order of the native servers: ${setup}`);
      assert.ok(setup.includes('> "$run/address-mysql.tmp"') && setup.includes('mv "$run/address-mysql.tmp" "$run/address-mysql"'), 'setup-mysql.sh writes no address of the primary');
      // The installation pins its packages and files, links with lld through the cargo configuration of the runner
      // alone, clones the bundle and follows the first installation of the repository.
      const installation = file(context.root, project, 'runner-setup.sh');
      for (const part of ['apt-get install -y --no-install-recommends git make gcc g++ curl ca-certificates', ' lld ', 'sha256sum -c', 'https://nodejs.org/dist/v', 'https://static.rust-lang.org/rustup/archive/',
        'rustflags = ["-C", "link-arg=-fuse-ld=lld"]', 'cat > "$CARGO_HOME/config.toml"', 'git -C "$run/repo" fetch -q "$run/repo.bundle" HEAD', 'make install\nmkdir -p'])
        assert.ok(installation.includes(part), `runner-setup.sh misses ${part}`);
      assert.match(installation, /^ {2}aarch64\) platform=linux-arm64 node_sum=[0-9a-f]{64} rustup_sum=[0-9a-f]{64} ;;$/m, 'runner-setup.sh pins no file of a processor');
      // sh reads each written file: a file with a syntax error fails here and not in a container.
      for (const name of ['run.sh', 'runner-setup.sh', 'setup-mysql.sh', 'job-build.sh', 'job-check.sh', 'check.sh']) {
        const read = spawnSync('/bin/sh', ['-n', join(containers(context.root), project, name)], { encoding: 'utf8' });
        assert.equal(read.status, 0, `sh does not read ${name}: ${read.stderr}`);
      }
      // runner-setup.sh runs in a copy of the directory of the run, as a job runs it in a directory that has no home
      // yet, with a stand-in apt-get, uname and make, the tools of a kept directory, and the git of this machine, so its
      // writes below HOME are those of a job. Each job names the same HOME below the mounted directory of the run, so
      // what the job build writes there is what the job check reads.
      assert.match(file(context.root, project, 'compose.build.yaml'), /^ {6}HOME: "\/orm-run\/home"$/m, 'the job build has another home');
      const copy = join(dir, 'runner');
      cpSync(join(containers(context.root), project), copy, { recursive: true });
      assert.ok(!existsSync(join(copy, 'home')), 'the directory of the run holds a home before a job runs');
      writeFileSync(join(copy, 'runner-setup.sh'), installation.replace(/^run=\/orm-run$/m, `run='${copy}'`));
      const tools = join(dir, 'runner-tools');
      mkdirSync(tools);
      for (const [name, body] of [['apt-get', ':'], ['uname', 'echo aarch64'], ['make', 'echo "$*" > "$HOME/made"']] as const) writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      for (const tool of ['node/bin/node', 'cargo/bin/rustup']) {
        mkdirSync(dirname(join(copy, tool)), { recursive: true });
        writeFileSync(join(copy, tool), '#!/bin/sh\n', { mode: 0o755 });
      }
      mkdirSync(join(copy, 'repo/.git'), { recursive: true });
      mkdirSync(join(copy, 'repo/node_modules'));
      const installed = spawnSync('/bin/sh', [join(copy, 'runner-setup.sh')], { encoding: 'utf8', env: { PATH: `${tools}:/usr/bin:/bin`, HOME: join(copy, 'home'), CARGO_HOME: join(copy, 'cargo'), RUSTUP_HOME: join(copy, 'rustup'), GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(installed.status, 0, `runner-setup.sh fails in a directory without a home: ${installed.stderr}`);
      assert.match(readFileSync(join(copy, 'home/.gitconfig'), 'utf8'), /directory = .*\/repo$/m, 'the configuration of git is not in the home below the directory of the run');
      assert.equal(readFileSync(join(copy, 'home/made'), 'utf8'), 'install\n', 'make install did not write into the home below the directory of the run');
      const bundled = spawnSync('git', ['bundle', 'verify', join(containers(context.root), project, 'repo.bundle')], { cwd: context.root, encoding: 'utf8' });
      assert.equal(bundled.status, 0, `repo.bundle is no bundle of the commit: ${bundled.stderr}`);
      assert.ok(file(context.root, project, 'check.sh').includes(`( 'make' 'CASES=a '\\''quoted'\\'' case' 'test-rust' )`), 'check.sh does not run the command of the run as it was given');
      // job-check.sh writes the variables, which name the directory of the run by its mount, the authority by the path
      // where bay mounts it and the mismatch DSN by the address that setup.sh wrote.
      const jobCheck = file(context.root, project, 'job-check.sh');
      assert.ok(jobCheck.includes(`export ORM_TEST_MYSQL_TLS_DSN='mysql://root@${host('mysql')}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=/stand-in/mounted-authority.pem'`), jobCheck);
      assert.ok(jobCheck.includes('ssl-ca=/orm-run/tls/other-ca.pem') && jobCheck.includes(`export ORM_TEST_SERVERS_LEASES='/orm-run/leases'`) && jobCheck.includes('@${address_mysql}:3306/'), jobCheck);
      // run.sh queues build and then check, each by its key, follows each, and records what bay records of it.
      const followed = (id: string) => [`job logs -f -timeout 24h ${id}`, `job wait -timeout 24h ${id}`, `job logs ${id}`, `job show -json ${id}`];
      assert.deepEqual(commands(stand).filter(command => !command.startsWith('plan')), ['images', `job add -json -key ${project}-build build`, ...followed('job-1'), 'images', `job add -json -key ${project}-check check`, ...followed('job-2')]);
      assert.deepEqual(readFileSync(stand.ups, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['build'], ['mysql', 'mysql-replica', 'setup-mysql', 'check']]);
      assert.equal(JSON.parse(file(context.root, project, 'report/job-check.json')).service, 'check');
      const stepsLog = file(context.root, project, 'report/steps.log');
      for (const step of ['the job build (job-1)', 'the job check (job-2)']) assert.ok(stepsLog.includes(` ${step}`), `steps.log has no time of ${step}: ${stepsLog}`);
      assert.deepEqual(readdirSync(stand.state), [], 'a run in the runner leaves its project');
      assert.ok(!check.includes('mem_limit'), 'the runner has a memory limit that nobody gave');
      assert.ok(!installation.includes('jobs ='), 'the cargo of the runner has a count of jobs that nobody gave');

      // The kept directory runs again with sh and the stand-in bay alone: its jobs have their keys already, so run.sh
      // returns them and runs nothing again, and the status is that of the job.
      writeFileSync(stand.calls, '');
      writeFileSync(stand.ups, '');
      const again = spawnSync('/bin/sh', [join(containers(context.root), project, 'run.sh')], { env: { PATH: '/usr/bin:/bin', BAY_COMMAND: stand.bay }, encoding: 'utf8' });
      assert.equal(again.status, 0, `run.sh does not end with the status of the job: ${again.stderr}`);
      assert.equal(readFileSync(stand.ups, 'utf8'), '', 'a job queued again with its key ran again');
      // A part queued alone prints the ID of its job.
      const added = spawnSync('/bin/sh', [join(containers(context.root), project, 'run.sh'), 'add', 'check'], { env: { PATH: '/usr/bin:/bin', BAY_COMMAND: stand.bay }, encoding: 'utf8' });
      assert.equal(added.status, 0, added.stderr);
      assert.equal(added.stdout, 'job-2\n');
      const wrong = spawnSync('/bin/sh', [join(containers(context.root), project, 'run.sh'), 'add', 'another'], { env: { PATH: '/usr/bin:/bin', BAY_COMMAND: stand.bay }, encoding: 'utf8' });
      assert.equal(wrong.status, 2, 'a part that is neither build nor check is queued');
    });
  }));

caseTest('a run of several kinds is one project with the servers, the steps and the variables of each kind, and sqlite names no server (T477)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      // KIND is a comma list; sqlite names no server, a list needs a kind with a server and names each kind once.
      assert.deepEqual(kinds('mysql,postgres,sqlite'), ['mysql', 'postgres']);
      assert.deepEqual(kinds('mariadb'), ['mariadb']);
      for (const refused of ['sqlite', 'mysql,mysql', 'mysql,oracle', '', 'mysql,'])
        assert.throws(() => kinds(refused), /is mysql, postgres, mariadb or sqlite|a kind with a server|more than once/, refused);

      // In the form of the host one run starts the servers of each kind, runs the steps of each kind in the container of
      // its server, and gives its command the variables of each kind, with the address of the primary of each kind.
      const has = ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_MYSQL_REPLICA_DSN', 'ORM_TEST_POSTGRES_DSN', 'ORM_TEST_POSTGRES_REPLICA_DSN'].map(name => `process.env.${name}`).join(' && ');
      const mismatch = `process.env.ORM_TEST_MYSQL_TLS_MISMATCH_DSN.includes('@${ADDRESS}:3306/') && process.env.ORM_TEST_POSTGRES_TLS_MISMATCH_DSN.includes('@${ADDRESS}:5432/')`;
      const ended = await run(['mysql', 'postgres'], [process.execPath, '-e', `process.exit(${has} && ${mismatch} ? 0 : 9)`], context, { keep: true });
      assert.deepEqual(ended, { code: 0, signal: null }, 'the command of a run of two kinds lacks the variables of a kind');
      const host = only(context.root);
      assert.deepEqual([...compose(context.root, host).matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mysql', 'mysql-replica', 'postgres', 'postgres-replica']);
      assert.deepEqual(steps(stand, host).map(step => step[0]), ['mysql', 'mysql-replica', 'mysql', 'postgres'], 'the steps of each kind did not run in the containers of its servers');
      assert.ok(commands(stand).includes(`exec mysql getent ahostsv4 ${host}-mysql.${SUFFIX}`) && commands(stand).includes(`exec postgres getent ahostsv4 ${host}-postgres.${SUFFIX}`), 'the address of the primary of a kind was not read');
      // The servers of a container take the smaller caches that the documentation states.
      const services = compose(context.root, host);
      assert.equal([...services.matchAll(/"--innodb-buffer-pool-size=64M"/g)].length, 2, 'a MySQL server takes another buffer pool');
      assert.equal([...services.matchAll(/"shared_buffers=32MB"/g)].length, 2, 'a PostgreSQL server takes other shared buffers');
      remove(context);

      // In the form of the runner each kind has its service setup-<kind> of the image of that kind, the job check waits
      // for each, and job-check.sh writes the variables of each kind with the address that each setup wrote.
      committed(context);
      writeFileSync(stand.ups, '');
      assert.deepEqual(await run(['mysql', 'postgres'], ['make', 'client-db-check'], context, { runner: true, keep: true }), { code: 0, signal: null });
      const project = only(context.root);
      const text = file(context.root, project, 'compose.run.yaml');
      assert.deepEqual([...text.matchAll(/^ {2}([a-z-]+):$/gm)].map(match => match[1]), ['mysql', 'mysql-replica', 'postgres', 'postgres-replica', 'setup-mysql', 'setup-postgres', 'check']);
      const setupOf = (kind: string, next: string) => text.slice(text.indexOf(`  setup-${kind}:\n`), text.indexOf(`  ${next}:\n`));
      const images = JSON.parse(readFileSync(join(import.meta.dirname, '../config/containers.json'), 'utf8')).images;
      assert.ok(setupOf('mysql', 'setup-postgres').includes(`image: "${images.mysql.reference}"`) && setupOf('postgres', 'check').includes(`image: "${images.postgres.reference}"`), 'a setup does not run the client of the image of its kind');
      assert.match(setupOf('postgres', 'check'), /^ {4}depends_on:\n {6}postgres:\n {8}condition: "service_healthy"\n {6}postgres-replica:\n {8}condition: "service_healthy"$/m);
      assert.match(text.slice(text.indexOf('  check:\n')), /^ {4}depends_on:\n {6}setup-mysql:\n {8}condition: "service_completed_successfully"\n {6}setup-postgres:\n {8}condition: "service_completed_successfully"$/m);
      const jobCheck = file(context.root, project, 'job-check.sh');
      for (const part of ['read -r address_mysql < "$run/address-mysql"', 'read -r address_postgres < "$run/address-postgres"', '@${address_mysql}:3306/', '@${address_postgres}:5432/', "export ORM_TEST_MYSQL_DSN=", "export ORM_TEST_POSTGRES_DSN="])
        assert.ok(jobCheck.includes(part), `job-check.sh misses ${part}: ${jobCheck}`);
      // A target that reads the environment file of the servers reads servers.env.
      const checkSh = file(context.root, project, 'check.sh');
      assert.ok(checkSh.includes(`export TEST_ENV="$run/servers.env" MARIADB_ENV="$run/servers.env"`), checkSh);
      for (const name of ['run.sh', 'setup-mysql.sh', 'setup-postgres.sh', 'job-check.sh', 'check.sh']) {
        const read = spawnSync('/bin/sh', ['-n', join(containers(context.root), project, name)], { encoding: 'utf8' });
        assert.equal(read.status, 0, `sh does not read ${name}: ${read.stderr}`);
      }
      assert.deepEqual(readFileSync(stand.ups, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['build'], ['mysql', 'mysql-replica', 'postgres', 'postgres-replica', 'setup-mysql', 'setup-postgres', 'check']]);
      assert.equal(file(context.root, project, 'report/status'), '0\n');
    });
  }));

caseTest('a run in the runner whose job check fails ends with the result of the job and names it in the report (BAY12.7, BAY13)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      committed(context);
      writeFileSync(stand.checkFails, '');
      assert.deepEqual(await run('mysql', ['make', 'test-rust'], context, { runner: true, keep: true }), { code: 1, signal: null });
      const project = only(context.root);
      assert.equal(file(context.root, project, 'report/status'), '5\n');
      assert.equal(JSON.parse(file(context.root, project, 'report/job-check.json')).exitCode, 5);
      assert.match(file(context.root, project, 'report/steps.log'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ the job check of orm-[0-9a-f]{12}-[0-9a-f]{8} did not succeed: bay job wait exited with 1$/m);
      assert.deepEqual(readdirSync(stand.state), []);
      // An image that is absent fails the run before a job is queued, naming the install target, and leaves nothing.
      remove(context);
      writeFileSync(stand.absent, '');
      writeFileSync(stand.ups, '');
      assert.deepEqual(await run('mysql', ['make', 'test-rust'], context, { runner: true }), { code: 1, signal: null });
      assert.equal(readFileSync(stand.ups, 'utf8'), '', 'a job ran without its image');
      assert.deepEqual(projects(context.root), [], 'a run without its image leaves its directory');
    });
  }));

caseTest('run.sh refuses a bay of another contract and a missing bay before it starts anything, compares no version, and records the version of its bay (BAY12.1, BAY5)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      await start('mysql', context);
      const script = join(containers(context.root), only(context.root), 'run.sh');
      writeFileSync(stand.calls, '');
      writeFileSync(stand.schema, '2');
      const other = spawnSync('/bin/sh', [script, 'up'], { env: { PATH: '/usr/bin:/bin', BAY_COMMAND: stand.bay }, encoding: 'utf8' });
      assert.equal(other.status, 1);
      assert.match(other.stderr, /bay version reports another contract schema version than 1, for which this file is written: .* schema 2; install a bay of that contract/);
      const missing = spawnSync('/bin/sh', [script, 'up'], { env: { PATH: '/usr/bin:/bin', BAY_COMMAND: join(dir, 'missing') }, encoding: 'utf8' });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /missing is missing: it is the program bay, which runs the Compose project of the servers; install bay on this machine, or name the command of bay in BAY_COMMAND/);
      writeFileSync(stand.schema, '1');
      assert.deepEqual(commands(stand), [], 'run.sh ran a command of its project for a bay that it refuses');
      // The bay of a machine is a tool of the machine, as make is: a run takes any version that has the contract,
      // the build of a developer included, and leaves the line of bay version in its output and in report/.
      writeFileSync(stand.release, 'v7.8.9-another+dirty');
      remove(context);
      await start('postgres', context);
      const project = only(context.root);
      assert.equal(file(context.root, project, 'report/bay-version'), 'bay v7.8.9-another+dirty (0000) go0 test/test schema 1\n');
      assert.ok(!file(context.root, project, 'run.sh').includes(JSON.parse(readFileSync(join(import.meta.dirname, '../config/containers.json'), 'utf8')).bay.version), 'run.sh reads the release that CI installs');
      const script2 = join(containers(context.root), project, 'run.sh');
      // The command of bay may have several words, as sudo -n bay has on a CI runner: each word reaches bay.
      writeFileSync(stand.calls, '');
      const words = spawnSync('/bin/sh', [script2, 'down'], { env: { PATH: '/usr/bin:/bin', BAY_COMMAND: `/usr/bin/env ORM_STAND_IN=1 ${stand.bay}` }, encoding: 'utf8' });
      assert.equal(words.status, 0, words.stderr);
      assert.deepEqual(commands(stand), ['down']);
      const several = await run('mysql', [process.execPath, '-e', ''], { ...context, bay: `/usr/bin/env ORM_STAND_IN=1 ${stand.bay}` });
      assert.deepEqual(several, { code: 0, signal: null }, 'the script does not run a command of bay with several words');
    });
  }));

caseTest('a run on another machine sends its directory once, queues and waits for each job there through ssh, brings the report back and leaves nothing there (BAY12.4, BAY12.6, BAY13, BAY13.1)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      committed(context);
      // The stand-in ssh runs the command of its second argument on this machine with the stand-in bay as the bay of
      // PATH, and records the host; while drop exists, it ends a command that waits for a job with 255, as ssh ends when
      // the connection drops. The directory of the other machine is a directory of the test.
      const ssh = join(dir, 'ssh');
      const drop = join(dir, 'drop');
      writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(join(dir, 'hosts.log'))}\ncase "$2" in *' wait '*) [ -e ${JSON.stringify(drop)} ] && exit 255 ;; esac\nPATH=${JSON.stringify(dirname(stand.bay))}:$PATH\nexport PATH\nexec /bin/sh -c "$2"\n`);
      chmodSync(ssh, 0o755);
      const there = join(dir, 'other machine');
      writeFileSync(stand.checkFails, '');
      const where = { host: 'runs@other.invalid', directory: there, pull: true, keep: true };
      const status = remote('postgres', ['make', 'test-rust'], { ...context, ssh }, where);
      assert.equal(status, 1, 'the run does not end with the result of its job check on the other machine');
      assert.deepEqual([...new Set(readFileSync(join(dir, 'hosts.log'), 'utf8').trim().split('\n'))], ['runs@other.invalid']);
      const ran = calls(stand).filter(call => call.args[0] === '-p');
      assert.ok(ran.length > 0 && ran.every(call => call.cwd.startsWith(realpathSync(there))), 'a command of bay of a project ran in a directory of this machine');
      // Each job is queued and waited for on the machine that runs it, which knows a job as soon as it is queued.
      const job = ['job', 'job', 'job', 'job', 'job'];
      assert.deepEqual(ran.map(call => call.args[call.args[2] === '-f' ? 4 : 2]), ['plan', 'pull', 'pull', 'images', ...job, 'images', ...job]);
      assert.deepEqual(ran.filter(call => call.args[2] === 'job').map(call => call.args[3]), ['logs', 'wait', 'logs', 'show', 'logs', 'wait', 'logs', 'show']);
      assert.ok(calls(stand).every(call => !call.args.includes('-peer')), 'a job was read through a peer');
      const [report] = readdirSync(join(containers(context.root), 'reports'));
      assert.ok(report, 'the report did not come back');
      const reported = (name: string) => readFileSync(join(containers(context.root), 'reports', report, name), 'utf8');
      assert.equal(reported('status'), '5\n');
      assert.equal(reported('check.log'), 'the output of the command\n');
      assert.equal(JSON.parse(reported('job-check.json')).exitCode, 5);
      assert.deepEqual(readdirSync(there), [report], 'the kept directory is not the one directory there');

      // The same run started again, as after a lost connection, sends nothing and queues no job a second time.
      writeFileSync(stand.ups, '');
      writeFileSync(join(dir, 'hosts.log'), '');
      assert.equal(remote('postgres', ['make', 'test-rust'], { ...context, ssh }, { ...where, pull: false, keep: false }), 1);
      assert.equal(readFileSync(stand.ups, 'utf8'), '', 'a job of the run ran a second time');
      assert.deepEqual(readdirSync(there), [], 'the run leaves its directory on the other machine');
      assert.deepEqual(projects(context.root), [], 'the run leaves its directory on this machine');

      // A job that has not ended is no failed job: the run queues no job check, keeps the directory there, whose files
      // the queued job reads, and ends with 3; the same command, once the job ended, waits for it and goes on.
      rmSync(stand.checkFails);
      writeFileSync(stand.unended, '');
      const command = ['make', 'test-rust', 'unended'];
      assert.equal(remote('mysql', command, { ...context, ssh }, { ...where, keep: false }), 3, 'a run whose job has not ended does not end with 3');
      assert.equal(readFileSync(stand.ups, 'utf8'), '', 'a job that has not ended ran');
      const [kept] = readdirSync(there);
      assert.ok(kept && existsSync(join(there, kept, 'compose.build.yaml')), 'the run removed the directory that its queued job reads');
      assert.equal(JSON.parse(readFileSync(join(containers(context.root), 'reports', kept, 'job-build.json'), 'utf8')).state, 'queued');
      assert.ok(!existsSync(join(there, kept, 'job-check')), 'the job check was queued after a job build that has not ended');
      rmSync(stand.unended);
      const queued = join(dir, 'jobs', `${readFileSync(join(there, kept, 'job-build'), 'utf8').trim()}.json`);
      writeFileSync(queued, JSON.stringify({ ...JSON.parse(readFileSync(queued, 'utf8')), state: 'succeeded', ended: '2026-11-14T00:00:02Z', exitCode: 0 }));
      // A wait that ends with the connection is no end of the job either.
      writeFileSync(drop, '');
      assert.equal(remote('mysql', command, { ...context, ssh }, { ...where, keep: false }), 3, 'a run whose connection dropped does not end with 3');
      assert.deepEqual(readdirSync(there), [kept], 'the run removed its directory after a dropped connection');
      rmSync(drop);
      assert.equal(remote('mysql', command, { ...context, ssh }, { ...where, keep: false }), 0);
      const checked = readFileSync(stand.ups, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      assert.ok(checked.length === 1 && checked[0]?.includes('check'), `the job check did not run once: ${JSON.stringify(checked)}`);
      assert.deepEqual(readdirSync(there), [], 'the run leaves its directory on the other machine');

      // A run with a failed build queues no job check.
      writeFileSync(stand.ups, '');
      writeFileSync(stand.buildFails, '');
      assert.equal(remote('mysql', ['make', 'test-rust'], { ...context, ssh }, { ...where, keep: false, build: ['make', 'build'] }), 1);
      assert.deepEqual(readFileSync(stand.ups, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['build']], 'the job check ran after a failed build');
    });
  }));

caseTest('the install target of bay takes the archive of the release that CI installs for the platform, uses it only with its sha256, and leaves bay and bayd in the tools of the checkout (BAY5)', () =>
  withTemporaryDirectory('orm-containers-', dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    // The archive of a release holds the directory bay_<version>_<system>_<processor> with bay and bayd. The stand-in
    // curl writes the archive of the test to the file of -o and records its arguments.
    const platform = `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`;
    const name = `bay_v9.9.9_${platform}`;
    mkdirSync(join(dir, 'release', name), { recursive: true });
    for (const program of ['bay', 'bayd']) writeFileSync(join(dir, 'release', name, program), `#!/bin/sh\necho ${program}\n`, { mode: 0o755 });
    const archive = join(dir, `${name}.tar.gz`);
    assert.equal(spawnSync('tar', ['-C', join(dir, 'release'), '-czf', archive, name]).status, 0);
    const curl = join(dir, 'curl');
    writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'curl.log'))}\nwhile [ "$1" != -o ]; do shift; done\ncp ${JSON.stringify(archive)} "$2"\n`, { mode: 0o755 });
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const pin = (sums: Record<string, string>) => ({ version: 'v9.9.9', release: 'https://releases.invalid/bay/v9.9.9', sha256: sums });
    const tools = join(context.root, 'var/tools/bay');
    assert.throws(() => installBay({ ...context, curl }, pin({ [platform]: '0'.repeat(64) })), /\.tar\.gz has the sha256 [0-9a-f]{64}, and config\/containers\.json pins 0{64}/);
    assert.ok(!existsSync(join(tools, 'bay')), 'an archive with another sha256 was installed');
    installBay({ ...context, curl }, pin({ [platform]: sha256 }));
    assert.ok(readFileSync(join(dir, 'curl.log'), 'utf8').includes(`https://releases.invalid/bay/v9.9.9/${name}.tar.gz`), 'the archive is not that of the pinned release and platform');
    for (const program of ['bay', 'bayd']) assert.equal(spawnSync(join(tools, program), { encoding: 'utf8' }).stdout, `${program}\n`);
    assert.deepEqual(readdirSync(tools).sort(), ['bay', 'bayd'], 'the install target leaves another file than the two programs');
    assert.throws(() => installBay({ ...context, curl }, pin({})), /config\/containers\.json pins no archive of bay for/);
  }));

caseTest('a run in the runner with a build command builds in the job build, before the servers start, with the jobs and the memory limits that it is given (BAY12.8, BAY13)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const [context] = checkouts(dir, stand);
    await removing([context], async () => {
      committed(context);
      const options = { runner: true, keep: true, build: ['make', 'test-rust-build'], jobs: 2, runnerMemory: '2600m', serverMemory: '700m' };
      assert.deepEqual(await run('mysql', ['make', 'test-rust'], context, options), { code: 0, signal: null });
      const project = only(context.root);
      assert.ok(file(context.root, project, 'build.sh').includes(`( 'make' 'test-rust-build' )`), 'build.sh does not run the build command as it was given');
      assert.ok(!file(context.root, project, 'build.sh').includes('servers.env'), 'the build reads the variables of servers that are not up');
      const jobBuild = file(context.root, project, 'job-build.sh');
      assert.ok(jobBuild.indexOf('sh "$run/runner-setup.sh"') < jobBuild.indexOf('sh "$run/build.sh"') && jobBuild.includes('at "the build command"'), jobBuild);
      // The jobs are a setting of the cargo of the runner, and each limit is the mem_limit of its services.
      assert.match(file(context.root, project, 'runner-setup.sh'), /^\[build\]\njobs = 2$/m);
      const text = file(context.root, project, 'compose.run.yaml');
      assert.deepEqual([...text.matchAll(/^ {4}mem_limit: "(.*)"$/gm)].map(match => match[1]), ['700m', '700m', '2600m']);
      assert.match(file(context.root, project, 'compose.build.yaml'), /^services:\n {2}build:\n(?: {4}.*\n)* {4}mem_limit: "2600m"\n/);
      for (const name of ['run.sh', 'build.sh', 'job-build.sh']) assert.equal(spawnSync('/bin/sh', ['-n', join(containers(context.root), project, name)]).status, 0, `sh does not read ${name}`);

      // A build that fails ends the run with the result of its job, and the job check is not queued.
      remove(context);
      writeFileSync(stand.buildFails, '');
      writeFileSync(stand.ups, '');
      assert.deepEqual(await run('mysql', ['make', 'test-rust'], context, { runner: true, build: ['make', 'test-rust-build'] }), { code: 1, signal: null });
      assert.deepEqual(readFileSync(stand.ups, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['build']], 'the servers started after a failed build');
      assert.deepEqual(readdirSync(stand.state), [], 'a run with a failed build leaves its project');
      assert.deepEqual(projects(context.root), []);
      // A value that is no count or no size is refused before anything is written.
      await assert.rejects(run('mysql', ['true'], context, { runner: true, jobs: 0 }), /the count of cargo jobs 0 is no whole number above 0/);
      await assert.rejects(run('mysql', ['true'], context, { runner: true, runnerMemory: 'much' }), /the memory limit much of the runner is no size such as 2600m or 3g/);
      await assert.rejects(run('mysql', ['true'], context, { build: ['true'] }), /a build command runs in the runner; run with FORM=runner/);
    });
  }));

caseTest('a run that is given a check through a Unix socket is refused, since the jobs of the runner run no command in the container of a server (BAY8)', () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const script = join(import.meta.dirname, 'test-servers-container.mts');
    const refused = spawnSync(process.execPath, [script, 'run', 'mysql', '--runner', '--', 'true'], { cwd: dir, env: { ...process.env, BAY_COMMAND: stand.bay, ORM_CONTAINER_SOCKET_BUILD: 'make socket-build' }, encoding: 'utf8' });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /a check through a Unix socket runs in the container of its server, and the jobs of bay of the runner run no command there; no run takes SOCKET_BUILD or SOCKET_RUN \(BAY8\)/);
    assert.deepEqual(calls(stand), [], 'a refused run ran bay');
  }));
