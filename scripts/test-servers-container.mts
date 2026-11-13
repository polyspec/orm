// test-servers-container starts the test database servers of one kind, MySQL, PostgreSQL or MariaDB, as a Compose project
// that the program bay runs, on Apple container on macOS and on Docker on Linux, from the images that
// config/containers.json pins by their digests (CONTRIBUTING.md "Test database servers in containers", BAY1). It is the
// container form of the servers of scripts/test-servers.mts: a server takes the settings of the native primary (time
// zone, lower-case table names, binary log retention, InnoDB log space, and for PostgreSQL its WAL and its synchronous
// standby), and MySQL and PostgreSQL have a replica as a second service of the project.
//
//   node scripts/test-servers-container.mts start <mysql|postgres|mariadb>
//   node scripts/test-servers-container.mts run <mysql|postgres|mariadb> -- <command> [argument...]
//   node scripts/test-servers-container.mts stop
//   node scripts/test-servers-container.mts pull
//
// BAY_PROGRAM names bay; make passes it. Every step is a command of bay, and the script runs no container engine: plan
// --json gives the host name of each service and the authority of its certificate, images --json tells whether each
// image is on the machine, up -no-pull --json starts the servers and never pulls, exec runs a step in a started server,
// logs prints the last lines of a service, down removes the project, and pull, which only the command pull of this
// script runs, downloads the images.
//
// Each start has a project of its own: the directory .runtime/containers/<project> with compose.yaml and the files of
// its servers. <project> is orm-<checkout>-<run>, where <checkout> is the first 12 hexadecimal digits of the sha256 of
// the root of the checkout and <run> is 8 random hexadecimal digits; each command of bay takes it with -p, and the
// Compose file names no project (BAY2). So two checkouts and two runs of one checkout share nothing, and stop removes
// every project of its checkout, the project of a killed run included, and no project of another checkout (T444).
//
// A server is ready when bay up returns with 0: each service declares a healthcheck with the readiness program of its
// server over TCP on 127.0.0.1, and the standby of PostgreSQL depends on its healthy primary. This script waits for
// that process alone; it reads no log, starts no timer and repeats no request. The steps that prepare a started server
// then run in its container with bay exec, each to its end, in the order of the native servers (BAY9).
//
// The script holds no form and no suffix of a host name: it reads each host name from bay plan --json before bay up,
// for the standby of PostgreSQL, which names its primary in its command, and the host name and the IPv4 address of each
// service from the output of bay up --json (BAY4).
//
// start writes .runtime/containers/<kind>.env and refuses a kind that is started in the checkout; run gives the
// variables to its command, writes no shared file, and removes its project when the command ends or fails, or when the
// run gets SIGINT or SIGTERM, which it forwards to the command. The MySQL and PostgreSQL variables are those of the
// primary of TEST_ENV with the replica DSN, the MariaDB variables those of the primary of MARIADB_ENV. A server presents
// the certificate that bay issues for the host name of its service: the TLS DSN verifies it with the authority of bay,
// the DSN with the second CA, which this script issues and which signs nothing, fails the chain, and the mismatch DSN
// connects to the IPv4 address of the service, which the certificate does not name. No pooler is started, and bay
// publishes no Unix socket on the host; their variables are absent, and a check that reads one fails naming the
// variable (BAY8).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorCode } from '../tests/errors.mts';
import { holdExclusiveLease, issueTls, SERVER_TIME_ZONE, MYSQLD_BINLOG, MYSQLD_STORAGE, MYSQL_LOWER_CASE, ORM_ACCOUNTS_SQL, POSTGRES_WAL, REPLICA_PARTIAL_REVOKES_SQL, TestServerError } from './test-servers.mts';

const REPOSITORY = resolve(import.meta.dirname, '..');
// SCHEMA is the contract schema version of bay that this script is written for, which bay version --json reports.
const SCHEMA = 1;
// BAY_TLS is the folder where bay mounts the certificate of a container, its key and its authority, and INIT_MOUNT the
// folder whose files an image runs once when it initializes its data directory.
const BAY_TLS = '/etc/bay/tls';
const INIT_MOUNT = '/docker-entrypoint-initdb.d';
// POSTGRES_KEY is the copy of the key of the PostgreSQL server in the container, outside its data directory.
const POSTGRES_KEY = '/var/lib/postgresql/orm-tls-key.pem';

type Kind = 'mysql' | 'postgres' | 'mariadb';

// Context is the checkout whose servers a command starts or removes, with the program bay.
export interface Context { root: string; bay: string }

// Folders are the files of the servers of a checkout: .runtime/containers and its leases.
interface Folders { dir: string; leases: string }

function folders(root: string): Folders {
  const dir = join(root, '.runtime/containers');
  return { dir, leases: join(dir, 'leases') };
}

// Yaml is a value of the Compose file: a string, a number, a list of strings, or a mapping of such values.
type Yaml = string | number | readonly string[] | { readonly [key: string]: Yaml };

// Service is a service of the project of a start. data is the data directory of the image, which a tmpfs replaces, so
// the data ends with the container; init is a file of the initialization directory of the image, for a setting that
// must hold before the server accepts its first connection; health is the readiness program of the server, which runs
// in the container; after is the service that must be healthy before this one starts.
interface Service {
  name: string;
  port: number;
  data: string;
  command: string[];
  environment: Record<string, string>;
  init?: { file: string; text: string };
  health: string[];
  after?: string;
}

// Step is a command that prepares a started server: it runs in the container of its service after bay up returned.
interface Step { service: string; command: string[] }

// Endpoint is where the checks reach the servers of a started project: the host name and the IPv4 address of each
// service by its name, the authority that signed the certificates of the servers, the second CA, which signed
// nothing, and the lease folder of the checkout.
interface Endpoint { host: (service: string) => string; ipv4: (service: string) => string; authority: string; other: string; leases: string }

interface Server {
  // services are the services of the kind, the primary first; host is the host name of a service of the project.
  services: (host: (service: string) => string) => Service[];
  // steps run after bay up, each to its end before the next.
  steps: (host: (service: string) => string) => Step[];
  variables: (server: Endpoint) => Record<string, string>;
}

const mysqlTls = (ca: string, host: string) => `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${ca}`;
const postgresTls = (ca: string, host: string) => `postgres://orm@${host}:5432/orm_test?sslmode=verify-full&sslrootcert=${ca}`;
// A MySQL or MariaDB server presents the certificate that bay mounts in its container.
const mysqlTlsOptions = [`--ssl-ca=${BAY_TLS}/ca.pem`, `--ssl-cert=${BAY_TLS}/cert.pem`, `--ssl-key=${BAY_TLS}/key.pem`];

// The MySQL and the MariaDB server take the options of the native primary (scripts/test-servers.mts).
const mysqlOptions = ['--secure-file-priv=NULL', `--lower-case-table-names=${MYSQL_LOWER_CASE}`, ...MYSQLD_BINLOG, ...MYSQLD_STORAGE];
const mysqlArguments = (serverId: number) => ['mysqld', '--mysqlx=OFF', ...mysqlOptions, `--server-id=${serverId}`, ...mysqlTlsOptions];

// The PostgreSQL servers take the settings of postgresArguments of scripts/test-servers.mts; the primary names the replica
// as its synchronous standby with synchronous_commit=local, so only a transaction that asks for remote_apply waits for it.
// PostgreSQL refuses a key that another user than its own can read, and bay mounts a key that every user of the
// container reads, so the key is copied for the user postgres first.
const postgresKey = `install -m 0600 -o postgres -g postgres ${BAY_TLS}/key.pem ${POSTGRES_KEY}`;
const postgresSettings = ['-c', `timezone=${SERVER_TIME_ZONE}`, '-c', 'ssl=on', '-c', `ssl_cert_file=${BAY_TLS}/cert.pem`, '-c', `ssl_key_file=${POSTGRES_KEY}`,
  ...POSTGRES_WAL.flatMap(setting => ['-c', setting])];

// The temporary server that an image starts to initialize a data directory listens only on its socket, so each readiness
// program connects over TCP on 127.0.0.1 and succeeds only for the server that the checks reach.
const mysqlHealth = ['mysqladmin', 'ping', '--host=127.0.0.1', '--protocol=TCP', '--silent'];
const postgresHealth = ['pg_isready', '--host=127.0.0.1', '--username=orm', '--dbname=postgres'];
const DATABASES_SQL = `CREATE DATABASE orm_test; CREATE DATABASE orm_tools; ${ORM_ACCOUNTS_SQL}`;
const postgresEnvironment = { POSTGRES_USER: 'orm', POSTGRES_HOST_AUTH_METHOD: 'trust', POSTGRES_INITDB_ARGS: '--encoding=UTF8 --locale=C' };

const SERVERS: Record<Kind, Server> = {
  mysql: {
    services: () => [
      { name: 'mysql', port: 3306, data: '/var/lib/mysql', command: mysqlArguments(1), environment: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' }, health: mysqlHealth },
      { name: 'mysql-replica', port: 3306, data: '/var/lib/mysql', command: [...mysqlArguments(2), '--skip-replica-start'], environment: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' }, health: mysqlHealth },
    ],
    // The order of the native servers: the primary resets its binary log, which holds the initialization of its image,
    // that the image of the replica ran as well; the replica then follows the primary from the first file of that log, is
    // read-only and enables partial_revokes, so it refuses a catalog row change (INT-119); and the primary creates the
    // databases and the accounts of the user orm, which the replica applies. Each step needs a server that accepts
    // connections and changes what a running server does, so none is a file of the initialization of the image.
    steps: host => [
      { service: 'mysql', command: ['mysql', '-uroot', '-e', 'RESET BINARY LOGS AND GTIDS'] },
      { service: 'mysql-replica', command: ['mysql', '-uroot', '-e',
        `CHANGE REPLICATION SOURCE TO SOURCE_HOST='${host('mysql')}', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1; START REPLICA; SET GLOBAL super_read_only = ON; ${REPLICA_PARTIAL_REVOKES_SQL}`] },
      { service: 'mysql', command: ['mysql', '-uroot', '-e', DATABASES_SQL] },
    ],
    variables: ({ host, ipv4, authority, other, leases }) => {
      const mysql = `mysql://root@${host('mysql')}:3306`;
      return {
        ORM_TEST_MYSQL_DSN: `${mysql}/orm_test`, ORM_TEST_MYSQL_SERVER_DSN: `${mysql}/orm_test`, ORM_TOOLS_MYSQL_DSN: `${mysql}/orm_tools`,
        ORM_RUN_MYSQL_DSN: `${mysql}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: leases,
        ORM_TEST_MYSQL_TLS_DSN: mysqlTls(authority, host('mysql')), ORM_TEST_MYSQL_TLS_OTHER_CA_DSN: mysqlTls(other, host('mysql')), ORM_TEST_MYSQL_TLS_MISMATCH_DSN: mysqlTls(authority, ipv4('mysql')),
        ORM_TEST_MYSQL_REPLICA_DSN: `mysql://root@${host('mysql-replica')}:3306/orm_test`,
      };
    },
  },
  postgres: {
    services: host => [
      // The rules of the image let every host connect to every database, which does not cover replication. The rule that
      // lets the role orm replicate is a file of the initialization of the image, because bay up starts the standby as
      // soon as the primary is healthy, before a step of this script can run.
      { name: 'postgres', port: 5432, data: '/var/lib/postgresql/data', environment: postgresEnvironment, health: postgresHealth,
        command: ['sh', '-c', `${postgresKey} && exec docker-entrypoint.sh "$@"`, 'sh',
          'postgres', ...postgresSettings, '-c', 'synchronous_standby_names=orm_replica', '-c', 'synchronous_commit=local'],
        init: { file: 'orm.sh', text: `echo 'host replication orm all trust' >> "$PGDATA/pg_hba.conf"\n` } },
      // The standby is a pg_basebackup of the healthy primary into the empty data directory, and the image skips its
      // initialization for that directory; -R writes the standby configuration with the application_name that
      // synchronous_standby_names lists, and -C -S creates the slot orm_replica, as postgresBaseBackupArguments does.
      { name: 'postgres-replica', port: 5432, data: '/var/lib/postgresql/data', environment: postgresEnvironment, health: postgresHealth, after: 'postgres',
        command: ['sh', '-c', `${postgresKey} && chown postgres:postgres "$PGDATA" && chmod 0700 "$PGDATA" && gosu postgres pg_basebackup -D "$PGDATA" -R -C -S orm_replica -X stream -d 'host=${host('postgres')} port=5432 user=orm application_name=orm_replica' && exec docker-entrypoint.sh "$@"`, 'sh',
          'postgres', ...postgresSettings] },
    ],
    // The primary creates the databases after the standby follows it, as the native primary does.
    steps: () => [{ service: 'postgres', command: ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'orm', '-d', 'postgres', '-c', 'CREATE DATABASE orm_test', '-c', 'CREATE DATABASE orm_tools'] }],
    variables: ({ host, ipv4, authority, other, leases }) => {
      const postgres = `postgres://orm@${host('postgres')}:5432`;
      return {
        ORM_TEST_POSTGRES_DSN: `${postgres}/orm_test`, ORM_TEST_POSTGRES_SERVER_DSN: `${postgres}/orm_test`, ORM_TOOLS_POSTGRES_DSN: `${postgres}/orm_tools`,
        ORM_RUN_POSTGRES_DSN: `${postgres}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: leases,
        ORM_TEST_POSTGRES_TLS_DSN: postgresTls(authority, host('postgres')), ORM_TEST_POSTGRES_TLS_OTHER_CA_DSN: postgresTls(other, host('postgres')), ORM_TEST_POSTGRES_TLS_MISMATCH_DSN: postgresTls(authority, ipv4('postgres')),
        ORM_TEST_POSTGRES_REPLICA_DSN: `postgres://orm@${host('postgres-replica')}:5432/orm_test`,
      };
    },
  },
  mariadb: {
    // healthcheck.sh is the readiness program of the image; --connect requires a connection over TCP.
    services: () => [
      { name: 'mariadb', port: 3306, data: '/var/lib/mysql', command: ['mariadbd', ...mysqlOptions, '--server-id=1', ...mysqlTlsOptions], environment: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: '1' },
        health: ['healthcheck.sh', '--connect', '--innodb_initialized'] },
    ],
    steps: () => [{ service: 'mariadb', command: ['mariadb', '-uroot', '-e', DATABASES_SQL] }],
    variables: ({ host, ipv4, authority, other, leases }) => {
      const mariadb = `mysql://root@${host('mariadb')}:3306`;
      return {
        ORM_TEST_MARIADB_DSN: `${mariadb}/orm_test`, ORM_TEST_MARIADB_SERVER_DSN: `${mariadb}/orm_test`, ORM_TOOLS_MARIADB_DSN: `${mariadb}/orm_tools`, ORM_TEST_MARIADB_LEASES: leases,
        ORM_TEST_MARIADB_TLS_DSN: mysqlTls(authority, host('mariadb')), ORM_TEST_MARIADB_TLS_OTHER_CA_DSN: mysqlTls(other, host('mariadb')), ORM_TEST_MARIADB_TLS_MISMATCH_DSN: mysqlTls(authority, ipv4('mariadb')),
      };
    },
  },
};

const KINDS: readonly Kind[] = ['mysql', 'postgres', 'mariadb'];

function isKind(text: string | undefined): text is Kind {
  return text === 'mysql' || text === 'postgres' || text === 'mariadb';
}

// field is the value of a property of a parsed JSON value, or undefined when the value is no object or has no such property.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function image(kind: Kind): string {
  const file = join(REPOSITORY, 'config/containers.json');
  const reference = field(field(field(JSON.parse(readFileSync(file, 'utf8')), 'images'), kind), 'reference');
  if (typeof reference !== 'string' || !/@sha256:[0-9a-f]{64}$/.test(reference)) throw new TestServerError(`test-servers-container: ${file} pins no image of ${kind} by its digest`);
  return reference;
}

// checkout is the identifier of a checkout in the names of its projects: the first 12 hexadecimal digits of the sha256
// of its root.
function checkout(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

// Ran is the end of a command of bay that this script ran to its end.
interface Ran { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

// At is the project of a command of bay: its name, which bay takes with -p, and its directory, where bay reads compose.yaml.
interface At { name: string; dir: string }

// bay runs a command of bay to its end with its output captured, for a project when at is given, and fails naming the
// path, what bay does for this script and what provides it when the program is missing.
function bay(context: Context, args: string[], at?: At): Ran {
  const ran = spawnSync(context.bay, at ? ['-p', at.name, ...args] : args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(at ? { cwd: at.dir } : {}) });
  if (ran.error) {
    if (errorCode(ran.error) === 'ENOENT' && !existsSync(context.bay))
      throw new TestServerError(`test-servers-container: ${context.bay} is missing: it is the program bay, which runs the Compose project of the servers; install bay at that path and run bay check -scope run, which names the machine setup that bay install applies (no target of this repository installs bay, BAY5)`);
    throw new TestServerError(`test-servers-container: ${context.bay}: ${ran.error.message}`);
  }
  return { status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr };
}

// read runs a command of bay that must succeed and returns the JSON value that it prints.
function read(context: Context, args: string[], at?: At): unknown {
  const ran = bay(context, args, at);
  if (ran.status !== 0) throw new TestServerError(`test-servers-container: bay ${args.join(' ')}${at ? ` of ${at.name}` : ''} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
  return JSON.parse(ran.stdout);
}

// contract fails unless the bay of context has the contract that this script is written for.
function contract(context: Context): void {
  const schema = field(read(context, ['version', '--json']), 'schemaVersion');
  if (schema !== SCHEMA)
    throw new TestServerError(`test-servers-container: bay version --json reports the contract schema version ${JSON.stringify(schema)}, and this script is written for ${SCHEMA}; install a bay of that contract at ${context.bay}`);
}

// text is a property of a value that bay printed, which must be a string; what names the value in the failure.
function text(value: unknown, name: string, what: string): string {
  const found = field(value, name);
  if (typeof found !== 'string' || found === '') throw new TestServerError(`test-servers-container: ${what} has no ${name}: ${JSON.stringify(value)}`);
  return found;
}

// reported are the services that a command of bay printed under services, by their names.
function reported(printed: unknown, what: string): Map<string, unknown> {
  const services = field(printed, 'services');
  if (!Array.isArray(services)) throw new TestServerError(`test-servers-container: ${what} prints no services: ${JSON.stringify(printed)}`);
  return new Map(services.map(service => [text(service, 'name', `a service of ${what}`), service] as const));
}

// yaml writes a mapping of the Compose file in block style with each string as a JSON string, which YAML reads as a
// double-quoted scalar. Compose reads $NAME in a value as a variable of the environment of bay, so each dollar sign of a
// string is written twice, which Compose reads as one.
function yaml(mapping: { readonly [key: string]: Yaml }, indent = ''): string {
  const scalar = (value: string | number) => typeof value === 'number' ? String(value) : JSON.stringify(value.replaceAll('$', '$$$$'));
  return Object.entries(mapping).map(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number') return `${indent}${key}: ${scalar(value)}\n`;
    if (isList(value)) return `${indent}${key}: [${value.map(scalar).join(', ')}]\n`;
    return `${indent}${key}:\n${yaml(value, `${indent}  `)}`;
  }).join('');
}

function isList(value: Yaml): value is readonly string[] {
  return Array.isArray(value);
}

// composeFile is the Compose file of a project: one service per server, with the pinned image, the port of the server in
// expose and no key ports, so no port of the host is published, and the data directory of the image on a tmpfs. A
// healthcheck is the bound of bay for a start, in the file on purpose. start_period declares the time in which the image
// initializes its data directory, minutes on a loaded machine, during which a failed probe is not counted; after it,
// retries probes a second apart fail the start, and a container that stops fails it at once.
function composeFile(kind: Kind, services: readonly Service[]): string {
  return yaml({
    services: Object.fromEntries(services.map(service => [service.name, {
      image: image(kind),
      command: service.command,
      expose: [String(service.port)],
      environment: { TZ: SERVER_TIME_ZONE, ...service.environment },
      tmpfs: [service.data],
      ...(service.init ? { volumes: [`./${service.name}-init:${INIT_MOUNT}:ro`] } : {}),
      cpus: '4',
      mem_limit: '4g',
      ...(service.after === undefined ? {} : { depends_on: { [service.after]: { condition: 'service_healthy' } } }),
      healthcheck: { test: ['CMD', ...service.health], interval: '1s', timeout: '5s', retries: 10, start_period: '600s' },
    }])),
  });
}

// Project is a started project: its name, its directory, and the variables of its servers.
interface Project extends At { variables: Record<string, string> }

// upProcess runs bay up -no-pull --json for a project and resolves with its exit status and its standard output when it
// ends; its progress goes to the standard error of this script. The end of that process is the only event that a start
// waits for. -no-pull makes bay fail before it creates anything when an image is not on the machine.
function upProcess(context: Context, at: At): Promise<{ ended: number | NodeJS.Signals | null; printed: string }> {
  return new Promise((resolveUp, rejectUp) => {
    const child = spawn(context.bay, ['-p', at.name, 'up', '-no-pull', '--json'], { cwd: at.dir, stdio: ['ignore', 'pipe', 2] });
    let printed = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { printed += chunk; });
    child.on('error', error => rejectUp(new TestServerError(`test-servers-container: ${context.bay}: ${error.message}`)));
    child.on('close', (code, signal) => resolveUp({ ended: code ?? signal, printed }));
  });
}

// up starts the servers of a kind as a project of its own and returns it. A start that fails after it created the
// directory of the project removes the project.
async function up(kind: Kind, context: Context): Promise<Project> {
  contract(context);
  const dirs = folders(context.root);
  mkdirSync(dirs.leases, { recursive: true });
  const name = `orm-${checkout(context.root)}-${randomBytes(4).toString('hex')}`;
  const at: At = { name, dir: join(dirs.dir, name) };
  mkdirSync(at.dir);
  let started = false;
  try {
    // bay plans a project from its Compose file, and the standby of PostgreSQL names its primary in its command, so the
    // file is written for the plan with no host name and then with the host names of the plan.
    const file = join(at.dir, 'compose.yaml');
    writeFileSync(file, composeFile(kind, SERVERS[kind].services(() => 'unplanned.invalid')));
    const planned = reported(read(context, ['plan', '--json'], at), 'bay plan --json');
    const plannedHost = (service: string) => text(planned.get(service), 'host', `the service ${service} of bay plan --json`);
    const services = SERVERS[kind].services(plannedHost);
    const authority = text(field(planned.get(kind), 'certificate'), 'ca', `the certificate of the service ${kind} of bay plan --json`);
    for (const service of services) {
      if (!service.init) continue;
      const init = join(at.dir, `${service.name}-init`);
      mkdirSync(init);
      chmodSync(init, 0o755);
      writeFileSync(join(init, service.init.file), service.init.text);
      chmodSync(join(init, service.init.file), 0o644);
    }
    writeFileSync(file, composeFile(kind, services));
    // No start pulls an image: bay tells which images are on the machine, and exits with 1 when one is not.
    const images = bay(context, ['images', '--json'], at);
    const listed: unknown = JSON.parse(images.stdout);
    for (const each of Array.isArray(listed) ? listed : []) {
      if (field(each, 'present') !== true)
        throw new TestServerError(`test-servers-container: the image ${String(field(each, 'image'))} of the service ${String(field(each, 'service'))} is not on this machine; run make orm-install-container-images, which pulls the images of config/containers.json`);
    }
    if (images.status !== 0) throw new TestServerError(`test-servers-container: bay images --json of ${name} exited with ${images.status ?? images.signal}:\n${images.stderr}${images.stdout}`);
    // The second CA signs nothing: the DSN that names it fails the chain of the certificate of the server.
    const tls = join(at.dir, 'tls');
    issueTls(tls, []);
    started = true;
    const { ended, printed } = await upProcess(context, at);
    if (ended !== 0) {
      for (const service of services) {
        console.error(`test-servers-container: the last lines of the service ${service.name} of ${name}:`);
        const logs = bay(context, ['logs', '-n', '50', service.name], at);
        process.stderr.write(`${logs.stdout}${logs.stderr}`);
      }
      throw new TestServerError(`test-servers-container: bay up of ${name} exited with ${ended}; the output of bay and the last lines of each service are above`);
    }
    const now = reported(JSON.parse(printed), 'bay up --json');
    const host = (service: string) => text(now.get(service), 'host', `the service ${service} of bay up --json`);
    const ipv4 = (service: string) => {
      const address = text(now.get(service), 'address', `the service ${service} of bay up --json`);
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new TestServerError(`test-servers-container: bay up --json reports no IPv4 address of the service ${service} of ${name}: ${address}`);
      return address;
    };
    for (const service of services) {
      if (host(service.name) !== plannedHost(service.name))
        throw new TestServerError(`test-servers-container: bay up reports the service ${service.name} of ${name} at ${host(service.name)}, and bay plan stated ${plannedHost(service.name)}`);
      ipv4(service.name);
    }
    for (const step of SERVERS[kind].steps(host)) {
      const ran = bay(context, ['exec', step.service, ...step.command], at);
      if (ran.status !== 0) throw new TestServerError(`test-servers-container: bay exec ${step.service} ${step.command.join(' ')} of ${name} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
    }
    return { ...at, variables: SERVERS[kind].variables({ host, ipv4, authority, other: join(tls, 'other-ca.pem'), leases: dirs.leases }) };
  } catch (error) {
    console.error(`test-servers-container: the start of ${kind} failed; removing ${name}`);
    down(context, at, started);
    throw error;
  }
}

// down removes a project with bay down, when bay up ran for it, and then removes its directory. A project whose bay
// down fails keeps its directory, so that stop finds it again.
function down(context: Context, at: At, started = existsSync(join(at.dir, 'compose.yaml'))): void {
  if (started) {
    const ran = bay(context, ['down'], at);
    if (ran.status !== 0) throw new TestServerError(`test-servers-container: bay down of ${at.name} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
  }
  rmSync(at.dir, { recursive: true, force: true });
  console.error(`test-servers-container: removed ${at.name}`);
}

// claim is the file that names the project of the kind that start started in a checkout.
const claim = (dir: string, kind: Kind) => join(dir, `${kind}.project`);

// start starts the servers of a kind for the checkout of context, writes the environment file of the kind, and returns
// its variables. It refuses a kind that is started in the checkout, because the environment file names one project.
export async function start(kind: Kind, context: Context): Promise<Record<string, string>> {
  const { dir } = folders(context.root);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(claim(dir, kind), '', { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new TestServerError(`test-servers-container: ${kind} is started in this checkout; run make orm-test-container-stop, which removes it`);
  }
  try {
    const project = await up(kind, context);
    writeFileSync(claim(dir, kind), `${project.name}\n`);
    writeEnvironment(join(dir, `${kind}.env`), project.variables);
    console.error(`test-servers-container: ${kind} is the project ${project.name}`);
    return project.variables;
  } catch (error) {
    rmSync(claim(dir, kind), { force: true });
    throw error;
  }
}

// remove removes every project of the checkout of context, the project of a killed run included, and the files of its
// starts. A project of another checkout is never removed: its directory is below its own checkout.
export function remove(context: Context): void {
  const { dir } = folders(context.root);
  if (!existsSync(dir)) return;
  const prefix = `orm-${checkout(context.root)}-`;
  for (const name of readdirSync(dir).filter(each => each.startsWith(prefix))) down(context, { name, dir: join(dir, name) });
  for (const kind of KINDS) for (const file of [`${kind}.env`, `${kind}.project`]) rmSync(join(dir, file), { force: true });
}

function writeEnvironment(file: string, variables: Record<string, string>): void {
  const lines = Object.entries(variables).map(([name, value]) => {
    if (/['\n\r]/.test(value)) throw new TestServerError(`test-servers-container: ${name} holds a quote or a newline: ${value}`);
    return `export ${name}='${value}'\n`;
  });
  writeFileSync(`${file}.tmp`, lines.join(''));
  renameSync(`${file}.tmp`, file);
}

// Signals is where a run receives SIGINT and SIGTERM: the process, or the emitter of a test.
interface Signals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

// RunOptions has the source of the signals of a run and a call for the moment its command has started.
export interface RunOptions { signals?: Signals; started?: () => void }

// Ended is how the command of a run ended: its exit code, or the signal that ended it.
export interface Ended { code: number | null; signal: NodeJS.Signals | null }

// run starts the servers of a kind as a project of its own, runs the command with the variables of the servers, and
// removes that project when the command ends or fails, or when the run gets SIGINT or SIGTERM, which it forwards to the
// command. A signal that comes while the servers start ends the run once the start ends, without the command.
export async function run(kind: Kind, command: readonly string[], context: Context, options: RunOptions = {}): Promise<Ended> {
  const [file, ...args] = command;
  if (file === undefined) throw new TestServerError('test-servers-container: run needs a command after --', 2);
  const signals = options.signals ?? process;
  let received: NodeJS.Signals | undefined;
  let child: ChildProcess | undefined;
  const interrupt = () => { received = 'SIGINT'; child?.kill('SIGINT'); };
  const terminate = () => { received = 'SIGTERM'; child?.kill('SIGTERM'); };
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  let project: Project | undefined;
  try {
    project = await up(kind, context);
    if (received !== undefined) return { code: null, signal: received };
    const { variables } = project;
    return await new Promise<Ended>((resolveRun, rejectRun) => {
      const spawned = spawn(file, args, { env: { ...process.env, ...variables }, stdio: 'inherit' });
      child = spawned;
      spawned.on('spawn', () => {
        if (received !== undefined) spawned.kill(received);
        options.started?.();
      });
      spawned.on('error', error => rejectRun(new TestServerError(`test-servers-container: ${file}: ${error.message}`)));
      spawned.on('exit', (code, signal) => resolveRun({ code, signal }));
    });
  } finally {
    signals.off('SIGINT', interrupt);
    signals.off('SIGTERM', terminate);
    if (project) down(context, project);
  }
}

// pull downloads each pinned image with bay pull; it is the only command that downloads. bay pulls the images of a
// Compose file, so pull writes one with a service for each kind into a directory of its own, which it removes; bay
// pull creates and starts no container.
export function pull(context: Context): void {
  contract(context);
  const { dir } = folders(context.root);
  mkdirSync(dir, { recursive: true });
  const name = `orm-${checkout(context.root)}-pull-${randomBytes(4).toString('hex')}`;
  const at: At = { name, dir: join(dir, name) };
  mkdirSync(at.dir);
  try {
    writeFileSync(join(at.dir, 'compose.yaml'), yaml({ services: Object.fromEntries(KINDS.map(kind => [kind, { image: image(kind) }])) }));
    const pulled = spawnSync(context.bay, ['-p', at.name, 'pull'], { cwd: at.dir, stdio: ['ignore', 2, 2] });
    if (pulled.error) throw new TestServerError(`test-servers-container: ${context.bay}: ${pulled.error.message}`);
    if (pulled.status !== 0) throw new TestServerError(`test-servers-container: bay pull of the images of config/containers.json exited with ${pulled.status ?? pulled.signal}`);
  } finally {
    rmSync(at.dir, { recursive: true, force: true });
  }
}

// exitCode is the exit code of a run whose command ended: its code, or 128 and the number of the signal that ended it.
function exitCode({ code, signal }: Ended): number {
  if (code !== null) return code;
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

if (import.meta.main) {
  const [command, kind, separator, ...rest] = process.argv.slice(2);
  try {
    const program = process.env['BAY_PROGRAM'];
    if (!program) throw new TestServerError('test-servers-container: BAY_PROGRAM is unset; run this through make, which names the program bay');
    const context: Context = { root: REPOSITORY, bay: program };
    const { dir, leases } = folders(REPOSITORY);
    if (command === 'start' && isKind(kind) && separator === undefined) {
      await start(kind, context);
      console.log(`test-servers-container: ${kind} is started; its environment file is ${join(dir, `${kind}.env`)}`);
    } else if (command === 'run' && isKind(kind) && separator === '--' && rest.length > 0) process.exitCode = exitCode(await run(kind, rest, context));
    else if (command === 'stop' && kind === undefined) {
      mkdirSync(leases, { recursive: true });
      holdExclusiveLease(leases);
      remove(context);
    } else if (command === 'pull' && kind === undefined) pull(context);
    else throw new TestServerError('usage: test-servers-container.mts start <mysql|postgres|mariadb> | run <mysql|postgres|mariadb> -- <command> [argument...] | stop | pull', 2);
  } catch (error) {
    if (!(error instanceof TestServerError)) throw error;
    if (error.message) console.error(error.message);
    process.exitCode = error.status;
  }
}
