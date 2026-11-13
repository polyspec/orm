// test-servers-container writes the directory of a run of the test database servers of one kind, MySQL, PostgreSQL or
// MariaDB, and starts the file run.sh of that directory, which executes the run (CONTRIBUTING.md "Test database servers
// in containers", BAY1, BAY12). The servers are a Compose project that the program bay runs, on Apple container on macOS
// and on Docker on Linux, from the images that config/containers.json pins by their digests. It is the container form of
// the servers of scripts/test-servers.mts: a server takes the settings of the native primary (time zone, lower-case table
// names, binary log retention, InnoDB log space, and for PostgreSQL its WAL and its synchronous standby), and MySQL and
// PostgreSQL have a replica as a second service of the project.
//
//   node scripts/test-servers-container.mts start <mysql|postgres|mariadb>
//   node scripts/test-servers-container.mts run <mysql|postgres|mariadb> [--runner] [--keep] -- <command> [argument...]
//   node scripts/test-servers-container.mts remote <mysql|postgres|mariadb> <host> <directory> [--keep] [--pull] -- <command> [argument...]
//   node scripts/test-servers-container.mts stop
//   node scripts/test-servers-container.mts pull
//   node scripts/test-servers-container.mts install-bay
//
// The work is divided, so that a run executes on a machine whose host has only sh and bay. This script writes: the
// directory .runtime/containers/<project> with compose.yaml, run.sh, the second CA of the TLS cases and the
// initialization files, and for a run in the runner runner-setup.sh, check.sh and the bundle of the commit. run.sh
// executes: it is a POSIX sh file whose steps are commands of bay -p <project>, each decided by its exit status; it
// reads no JSON, starts no timer and repeats no request. <project> is orm-<checkout>-<run>, where <checkout> is the
// first 12 hexadecimal digits of the sha256 of the root of the checkout and <run> is 8 random hexadecimal digits, so two
// checkouts and two runs of one checkout share nothing, and stop removes every project of its checkout and no other.
//
// What a file of the directory names is read when the directory is written, from the bay of the machine that runs it:
// bay plan --json gives the host name of each service and the authority of its certificate, so this script holds no
// form and no suffix of a host name and run.sh needs no JSON. The IPv4 address of the mismatch DSN is known only after
// the start; run.sh reads it from the resolver of the container of the primary.
//
// A run has one of two forms, which the directory records and which does not change while it runs. In the form of the
// host the command of the run is a process of the host with the variables of the servers, for the results of the host
// system. In the form of the runner the project has the service runner, a Debian base image, in which runner-setup.sh
// installs the tools from a clone of the commit below the directory of the run, and the command runs with bay exec
// runner; nothing of that form is installed on the host. Both forms share the steps that prepare the servers.
//
// start writes .runtime/containers/<kind>.env and refuses a kind that is started in the checkout; run removes its
// project when its command ends or fails, or when the run gets SIGINT, SIGTERM or SIGHUP. No pooler is started, and bay
// publishes no Unix socket on the host; their variables are absent, and a check that reads one fails naming the
// variable (BAY8).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorCode } from '../tests/errors.mts';
import { holdExclusiveLease, issueTls, SERVER_TIME_ZONE, MYSQLD_BINLOG, MYSQLD_STORAGE, MYSQL_LOWER_CASE, ORM_ACCOUNTS_SQL, POSTGRES_WAL, REPLICA_PARTIAL_REVOKES_SQL, TestServerError } from './test-servers.mts';

const REPOSITORY = resolve(import.meta.dirname, '..');
// SCHEMA is the contract schema version of bay that this script and its run.sh are written for. A run takes the bay of
// its machine and compares no version: the contract of the output that it reads is what its result depends on.
const SCHEMA = 1;
// BAY_TLS is the folder where bay mounts the certificate of a container, its key and its authority, and INIT_MOUNT the
// folder whose files an image runs once when it initializes its data directory.
const BAY_TLS = '/etc/bay/tls';
const INIT_MOUNT = '/docker-entrypoint-initdb.d';
// POSTGRES_KEY is the copy of the key of the PostgreSQL server in the container, outside its data directory.
const POSTGRES_KEY = '/var/lib/postgresql/orm-tls-key.pem';
// RUN_MOUNT is the directory of the run in the runner.
const RUN_MOUNT = '/orm-run';

type Kind = 'mysql' | 'postgres' | 'mariadb';
// Form is where the command of a run runs: a process of the host, or bay exec in the service runner.
type Form = 'host' | 'runner';

// Context is the checkout whose servers a command starts or removes, with the command of bay: its program, or several
// words, as sudo -n bay on a machine where bay runs as root. ssh and tar are the programs of a run on another machine
// and curl that of the install target of bay; a test names stand-ins.
export interface Context { root: string; bay: string; ssh?: string; tar?: string; curl?: string }

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

// Endpoint is where the checks reach the servers of a project: the host name of each service by its name, the text
// that run.sh replaces with the IPv4 address of the primary, the authority that signed the certificates of the servers,
// the second CA, which signed nothing, and the lease folder.
interface Endpoint { host: (service: string) => string; ipv4: string; authority: string; other: string; leases: string }

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
        ORM_TEST_MYSQL_TLS_DSN: mysqlTls(authority, host('mysql')), ORM_TEST_MYSQL_TLS_OTHER_CA_DSN: mysqlTls(other, host('mysql')), ORM_TEST_MYSQL_TLS_MISMATCH_DSN: mysqlTls(authority, ipv4),
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
        ORM_TEST_POSTGRES_TLS_DSN: postgresTls(authority, host('postgres')), ORM_TEST_POSTGRES_TLS_OTHER_CA_DSN: postgresTls(other, host('postgres')), ORM_TEST_POSTGRES_TLS_MISMATCH_DSN: postgresTls(authority, ipv4),
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
        ORM_TEST_MARIADB_TLS_DSN: mysqlTls(authority, host('mariadb')), ORM_TEST_MARIADB_TLS_OTHER_CA_DSN: mysqlTls(other, host('mariadb')), ORM_TEST_MARIADB_TLS_MISMATCH_DSN: mysqlTls(authority, ipv4),
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

function image(kind: Kind | 'runner'): string {
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

// Ran is the end of a program that this script ran to its end.
interface Ran { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

// At is a project: its name, which bay takes with -p, and its directory, where bay reads compose.yaml.
interface At { name: string; dir: string }

// bay runs a command of bay to its end with its output captured, for a project when at is given, and fails naming the
// path, what bay does for this script and what provides it when the program is missing.
function bay(context: Context, args: string[], at?: At): Ran {
  const [program = '', ...first] = context.bay.split(' ').filter(word => word !== '');
  const ran = spawnSync(program, [...first, ...(at ? ['-p', at.name] : []), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(at ? { cwd: at.dir } : {}) });
  if (ran.error) {
    if (errorCode(ran.error) === 'ENOENT')
      throw new TestServerError(`test-servers-container: ${program} is missing: it is the program bay, which runs the Compose project of the servers; install bay on this machine, or name the command of bay in BAY_COMMAND`);
    throw new TestServerError(`test-servers-container: ${context.bay}: ${ran.error.message}`);
  }
  return { status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr };
}

// succeeded is the standard output of a program that must have exited with 0; what names it in the failure.
function succeeded(ran: Ran, what: string): string {
  if (ran.status !== 0) throw new TestServerError(`test-servers-container: ${what} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
  return ran.stdout;
}

// BayPin is the release of bay that CI installs, which config/containers.json pins: its version, the address of its
// files, and the sha256 of its archive for each platform, named <system>_<processor> as the archives name it. Only the
// install target reads it: a run takes the bay of its machine, as it takes make, and checks its contract alone.
export interface BayPin { version: string; release: string; sha256: Record<string, string> }

function bayPin(): BayPin {
  const file = join(REPOSITORY, 'config/containers.json');
  const declared = field(JSON.parse(readFileSync(file, 'utf8')), 'bay');
  const [version, release, sha256] = [field(declared, 'version'), field(declared, 'release'), field(declared, 'sha256')];
  if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(version) || typeof release !== 'string' || !release.startsWith('https://') || !isRecord(sha256) || !Object.values(sha256).every(each => typeof each === 'string' && /^[0-9a-f]{64}$/.test(each)))
    throw new TestServerError(`test-servers-container: ${file} pins no release of bay with its version, its address and the sha256 of each archive`);
  return { version, release, sha256: Object.fromEntries(Object.entries(sha256).map(([platform, each]) => [platform, String(each)])) };
}

// contracted fails unless what bay version --json printed has the contract that this script is written for; where
// names the machine of that bay in the failure. What changes the result of a run is the contract of the output that
// the script and run.sh read, and not the number of a release, so no version is compared.
function contracted(printed: string, where: string): void {
  const schema = field(JSON.parse(printed), 'schemaVersion');
  if (schema !== SCHEMA)
    throw new TestServerError(`test-servers-container: bay version --json reports the contract schema version ${JSON.stringify(schema)}${where}, and this script is written for ${SCHEMA}; install a bay of that contract`);
}

// contract fails unless the bay of context has that contract.
function contract(context: Context): void {
  contracted(succeeded(bay(context, ['version', '--json']), 'bay version --json'), '');
}

// text is a property of a value that bay printed, which must be a string; what names the value in the failure.
function text(value: unknown, name: string, what: string): string {
  const found = field(value, name);
  if (typeof found !== 'string' || found === '') throw new TestServerError(`test-servers-container: ${what} has no ${name}: ${JSON.stringify(value)}`);
  return found;
}

// Planned is what bay plan --json of the machine of a run states for the project: the host name of each service, and
// the authority that signs the certificates of the services by its path on that machine and by the path where bay
// mounts it in each container.
interface Planned { host: (service: string) => string; authority: string; mounted: string }

// planned reads the plan that bay printed for the services of a kind.
function planned(printed: string, kind: Kind): Planned {
  const services = field(JSON.parse(printed), 'services');
  if (!Array.isArray(services)) throw new TestServerError(`test-servers-container: bay plan --json prints no services: ${printed}`);
  const byName = new Map(services.map(service => [text(service, 'name', 'a service of bay plan --json'), service] as const));
  return {
    host: service => text(byName.get(service), 'host', `the service ${service} of bay plan --json`),
    authority: text(field(byName.get(kind), 'certificate'), 'ca', `the certificate of the service ${kind} of bay plan --json`),
    mounted: text(field(byName.get(kind), 'certificate'), 'containerCa', `the certificate of the service ${kind} of bay plan --json`),
  };
}

// yaml writes a mapping of the Compose file in block style with each string as a JSON string, which YAML reads as a
// double-quoted scalar. Compose reads $NAME in a value as a variable of the environment of bay, so each dollar sign of a
// string is written twice, which Compose reads as one.
function yaml(mapping: { readonly [key: string]: Yaml }, indent = ''): string {
  const scalar = (value: string | number) => typeof value === 'string' ? JSON.stringify(value.replaceAll('$', '$$$$')) : String(value);
  return Object.entries(mapping).map(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number') return `${indent}${key}: ${scalar(value)}\n`;
    if (isList(value)) return `${indent}${key}: [${value.map(scalar).join(', ')}]\n`;
    return `${indent}${key}:\n${yaml(value, `${indent}  `)}`;
  }).join('');
}

function isList(value: Yaml): value is readonly string[] {
  return Array.isArray(value);
}

// Runner is what config/containers.json declares for the service runner besides its image: the packages of Debian that
// runner-setup.sh installs, and the releases of the node of the machine and of rustup with the sha256 of the file of
// each processor.
interface Runner { packages: string[]; node: Record<string, string>; rustup: { version: string; sha256: Record<string, string> } }

function runner(): Runner {
  const file = join(REPOSITORY, 'config/containers.json');
  const declared = field(JSON.parse(readFileSync(file, 'utf8')), 'runner');
  const strings = (value: unknown, what: string): Record<string, string> => {
    if (!isRecord(value) || !Object.values(value).every(each => typeof each === 'string' && /^[0-9a-f]{64}$/.test(each))) throw new TestServerError(`test-servers-container: ${file} declares no sha256 of ${what} for each processor`);
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, String(each)]));
  };
  const packages = field(declared, 'packages');
  const version = field(field(declared, 'rustup'), 'version');
  if (!Array.isArray(packages) || !packages.every((each): each is string => typeof each === 'string' && /^[a-z0-9][a-z0-9.+-]*$/.test(each)) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new TestServerError(`test-servers-container: ${file} declares no packages and no release of rustup for the runner`);
  return { packages, node: strings(field(declared, 'node'), 'the node of the machine'), rustup: { version, sha256: strings(field(field(declared, 'rustup'), 'sha256'), 'rustup') } };
}

// nodeVersion is the release of node that mise.toml pins, which the runner takes as the node of its machine.
function nodeVersion(): string {
  const file = join(REPOSITORY, 'mise.toml');
  const version = /^node = "(\d+\.\d+\.\d+)"$/m.exec(readFileSync(file, 'utf8'))?.[1];
  if (version === undefined) throw new TestServerError(`test-servers-container: ${file} pins no release of node`);
  return version;
}

// composeFile is the Compose file of a project: one service per server, with the pinned image, the port of the server in
// expose and no key ports, so no port of the host is published, and the data directory of the image on a tmpfs. A
// healthcheck is the bound of bay for a start, in the file on purpose. start_period declares the time in which the image
// initializes its data directory, minutes on a loaded machine, during which a failed probe is not counted; after it,
// retries probes a second apart fail the start, and a container that stops fails it at once.
//
// A run in the runner adds the service runner: the Debian base image with a command that does not end and the
// directory of the run at RUN_MOUNT. It has no port, and restart "no" states that it is not started again. It keeps the
// trust and the certificate of bay, as each service does, so its TLS DSNs name the authority that bay mounts in it. The
// tools of the runner keep their files below the directory of the run (CARGO_HOME, RUSTUP_HOME), so removing the
// directory removes them. A build of the Rust tests needs more memory than a server: 8g is the limit of the runner.
function composeFile(kind: Kind, services: readonly Service[], form: Form): string {
  return yaml({
    services: {
      ...Object.fromEntries(services.map(service => [service.name, {
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
      ...(form === 'host' ? {} : { runner: {
        image: image('runner'),
        command: ['sleep', 'infinity'],
        environment: { CARGO_HOME: `${RUN_MOUNT}/cargo`, RUSTUP_HOME: `${RUN_MOUNT}/rustup` },
        restart: 'no',
        volumes: [`.:${RUN_MOUNT}`],
        cpus: '4',
        mem_limit: '8g',
      } }),
    },
  });
}

// quote writes a word of sh that holds text as it is.
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const words = (command: readonly string[]) => command.map(quote).join(' ');

// runFile is run.sh of a project. Each step is one command of bay, and its exit status decides the run. The parts: up
// checks bay and the images, starts the servers, runs the steps that prepare them and writes servers.env; down removes
// the project and writes the file removed; pull downloads the images; and no part is the whole run, which also runs
// the command of the run and removes the project at its end, at a failed step and on SIGINT, SIGTERM and SIGHUP, so a
// run whose ssh connection ends removes its servers.
//
// A command that sh starts in the background ignores SIGINT, so the command of the run gets SIGTERM for each signal.
// The address of the mismatch DSN is the first word that getent ahostsv4, which prints IPv4 addresses alone, prints for
// the host name of the primary in the container of the primary.
function runFile(at: At, kind: Kind, form: Form, services: readonly Service[], steps: readonly Step[], primary: string, variables: Record<string, string>, command: readonly string[] | undefined): string {
  const environment = Object.entries(variables).map(([name, value]) => {
    if (/['\n\r\\`]/.test(value) || /\$(?!\{(?:address|dir)\})/.test(value)) throw new TestServerError(`test-servers-container: ${name} holds a character that run.sh does not write: ${value}`);
    return `export ${name}='${value}'`;
  });
  const check = command === undefined ? ['say "this directory was written without a command; write a run with make orm-test-container-run"', 'exit 2']
    : form === 'host' ? [`( . "$dir/servers.env" && exec ${words(command)} ) &`]
      : [`b exec runner sh ${RUN_MOUNT}/runner-setup.sh >&2 || failed "$?" "bay exec runner sh ${RUN_MOUNT}/runner-setup.sh"`, `b exec runner sh ${RUN_MOUNT}/check.sh &`];
  return `#!/bin/sh
# run.sh of the project ${at.name}: the ${kind} servers of a run in the form of the ${form}, written by
# scripts/test-servers-container.mts. It needs sh and bay alone. BAY_COMMAND is the command of bay, of one or more words,
# as sudo -n bay where bay runs as root; without it, bay of PATH.
#   sh run.sh         the whole run: the servers, the command of the run, and the removal of the project
#   sh run.sh up      start the servers and write servers.env
#   sh run.sh down    remove the project
#   sh run.sh pull    download the images of the project
set -u
dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$dir" || exit 1
bay=\${BAY_COMMAND:-bay}
project=${quote(at.name)}
child=

say() { printf 'run.sh: %s\\n' "$*" >&2; }
b() { $bay -p "$project" "$@"; }

down() {
  b down >&2 || { say "bay down of $project exited with $?; the project is not removed"; return 1; }
  : > "$dir/removed"
}

# failed <status> <what>: a step that failed removes the project and ends the run with its status.
failed() {
  say "$2 of $project exited with $1"
  down
  exit "$1"
}

contract() {
  set -- $bay
  command -v "$1" >/dev/null 2>&1 || { say "$1 is missing: it is the program bay, which runs the Compose project of the servers; install bay on this machine, or name the command of bay in BAY_COMMAND"; exit 1; }
  stated=$($bay version) || { say "$bay version exited with $?"; exit 1; }
  say "$stated"
  mkdir -p "$dir/report" && printf '%s\\n' "$stated" > "$dir/report/bay-version"
  case "$stated" in
    *' schema ${SCHEMA}') ;;
    *) say "bay version reports another contract schema version than ${SCHEMA}, for which this file is written: $stated; install a bay of that contract"; exit 1 ;;
  esac
}

up() {
  contract
  b images >&2 || { say "an image of $project is not on this machine; run make orm-install-container-images, which pulls the images of config/containers.json, or sh $dir/run.sh pull"; exit 1; }
  rm -f "$dir/removed"
  : > "$dir/started"
  b up -no-pull >&2 || {
    status=$?
${services.map(service => `    say "the last lines of the service ${service.name}:"; b logs -n 50 ${quote(service.name)} >&2`).join('\n')}
    failed "$status" "bay up"
  }
${steps.map(step => `  b exec ${quote(step.service)} ${words(step.command)} >&2 || failed "$?" ${quote(`bay exec ${step.service} ${step.command.join(' ')}`)}`).join('\n')}
  resolved=$(b exec ${quote(kind)} getent ahostsv4 ${quote(primary)}) || failed "$?" ${quote(`bay exec ${kind} getent ahostsv4 ${primary}`)}
  address=\${resolved%%[!0-9.]*}
  case "$address" in
    *.*.*.*) ;;
    *) say "the host name ${primary} of the plan has no IPv4 address in the container of ${kind}: $resolved"; failed 1 "the address of the primary" ;;
  esac
  cat > "$dir/servers.env.tmp" <<ENVIRONMENT
${environment.join('\n')}
ENVIRONMENT
  mv "$dir/servers.env.tmp" "$dir/servers.env"
}

interrupted() {
  trap '' INT TERM HUP
  if [ -n "$child" ]; then kill -s TERM "$child" 2>/dev/null; wait "$child"; fi
  down
  exit "$1"
}

case "\${1:-}" in
  up) up ;;
  down) down ;;
  pull) contract; b pull >&2 || { status=$?; say "bay pull of $project exited with $status"; exit "$status"; } ;;
  '')
    trap 'interrupted 130' INT
    trap 'interrupted 143' TERM
    trap 'interrupted 129' HUP
    up
    ${check.join('\n    ')}
    child=$!
    wait "$child"
    status=$?
    child=
    down || exit 1
    exit "$status"
    ;;
  *) say "usage: sh run.sh [up|down|pull]"; exit 2 ;;
esac
`;
}

// setupFile is runner-setup.sh, which runs in the runner as root and installs what a check of this repository needs,
// in the order of the first installation of CONTRIBUTING.md. It downloads, so it is an installation step, and each file
// that it downloads is checked against the sha256 that config/containers.json pins. It skips what a kept directory has.
//
// lld is the linker of the Rust builds of the runner: with the default linker a build of the tests on a machine with
// 3.7 GiB of memory took 30 minutes and 3.0 GiB of swap, and with lld 16 minutes and 0.86 GiB. The setting is the
// config.toml of the CARGO_HOME of the runner, so no run of the host reads it.
function setupFile(): string {
  const { packages, node, rustup } = runner();
  const version = nodeVersion();
  // PLATFORMS are the names of nodejs.org for the processors that uname -m names.
  const PLATFORMS: Record<string, string> = { aarch64: 'linux-arm64', x86_64: 'linux-x64' };
  const processors = Object.keys(node).map(processor => {
    const [platform, rustupSum] = [PLATFORMS[processor], rustup.sha256[processor]];
    if (platform === undefined || rustupSum === undefined) throw new TestServerError(`test-servers-container: config/containers.json pins the node of the processor ${processor}, for which it pins no rustup or this script knows no platform of nodejs.org`);
    return `  ${processor}) platform=${platform} node_sum=${node[processor]} rustup_sum=${rustupSum} ;;`;
  });
  return `#!/bin/sh
# runner-setup.sh: the installation of the service runner, written by scripts/test-servers-container.mts.
set -eu
run=${RUN_MOUNT}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ${packages.join(' ')}

processor=$(uname -m)
case "$processor" in
${processors.join('\n')}
  *) echo "runner-setup.sh: config/containers.json pins no file for the processor $processor" >&2; exit 1 ;;
esac
# fetch <url> <sha256> <file>: a downloaded file is used only when it has the pinned sha256.
fetch() {
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >&2
}

if [ ! -x "$run/node/bin/node" ]; then
  fetch "https://nodejs.org/dist/v${version}/node-v${version}-$platform.tar.xz" "$node_sum" "$run/node.tar.xz"
  mkdir -p "$run/node"
  tar -xJf "$run/node.tar.xz" --strip-components=1 -C "$run/node"
  rm "$run/node.tar.xz"
fi
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  fetch "https://static.rust-lang.org/rustup/archive/${rustup.version}/$processor-unknown-linux-gnu/rustup-init" "$rustup_sum" "$run/rustup-init"
  chmod +x "$run/rustup-init"
  "$run/rustup-init" -y --no-modify-path --default-toolchain none
  rm "$run/rustup-init"
fi
mkdir -p "$CARGO_HOME"
cat > "$CARGO_HOME/config.toml" <<'CARGO'
[target.aarch64-unknown-linux-gnu]
rustflags = ["-C", "link-arg=-fuse-ld=lld"]
[target.x86_64-unknown-linux-gnu]
rustflags = ["-C", "link-arg=-fuse-ld=lld"]
CARGO
cat > "$run/runner.env" <<TOOLS
export PATH='$run/node/bin:$CARGO_HOME/bin:$PATH'
TOOLS
. "$run/runner.env"

# The clone of the commit of the run: the tools, the packages and the build outputs of the runner are below it.
git config --global --add safe.directory "$run/repo"
if [ ! -d "$run/repo/.git" ]; then
  git init -q "$run/repo"
  git -C "$run/repo" fetch -q "$run/repo.bundle" HEAD
  git -C "$run/repo" checkout -q --detach FETCH_HEAD
fi
cd "$run/repo"
if [ ! -d node_modules ]; then
  npm_version=$(node -p 'require("./package.json").devEngines.packageManager.version')
  (cd /tmp && npm exec --yes --package="npm@$npm_version" -- sh -c "cd '$run/repo' && npm ci --ignore-scripts --allow-remote=root")
fi
make install-tools TOOLS=npm
make install-packages
make install-tools
rustup toolchain install
mkdir -p "$run/report" "$run/leases"
`;
}

// checkFile is check.sh, which runs the command of a run in the runner, in the clone, with the tools of the runner and
// the variables of the servers. Its output is also report/check.log and its exit status report/status, which a run on
// another machine brings back.
function checkFile(command: readonly string[]): string {
  return `#!/bin/sh
# check.sh: the command of the run in the service runner, written by scripts/test-servers-container.mts.
run=${RUN_MOUNT}
. "$run/runner.env"
. "$run/servers.env"
export ORM_RUN_REPORT="$run/report"
cd "$run/repo" || exit 1
{ ( ${words(command)} ); echo "$?" > "$run/report/status"; } 2>&1 | tee "$run/report/check.log"
exit "$(cat "$run/report/status")"
`;
}

// Written is what the directory of a run was written with.
interface Written extends At { kind: Kind; form: Form }

// Plan reads the output of bay plan --json for the project of a directory whose compose.yaml is written.
type Plan = (at: At) => string;

// write writes the directory of a run and returns its project. The plan is that of the machine that runs the directory,
// so the Compose file is written once for the plan, with no host name, and once with the host names of the plan, which
// the standby of PostgreSQL names in its command. A write that fails removes the directory.
function write(kind: Kind, context: Context, form: Form, command: readonly string[] | undefined, plan: Plan, place: { leases: string; other: string; authority: (planned: Planned) => string }): Written {
  const dirs = folders(context.root);
  mkdirSync(dirs.leases, { recursive: true });
  const name = `orm-${checkout(context.root)}-${randomBytes(4).toString('hex')}`;
  const at: Written = { name, dir: join(dirs.dir, name), kind, form };
  mkdirSync(at.dir);
  try {
    const file = join(at.dir, 'compose.yaml');
    writeFileSync(file, composeFile(kind, SERVERS[kind].services(() => 'unplanned.invalid'), form));
    const stated = planned(plan(at), kind);
    const { host } = stated;
    const services = SERVERS[kind].services(host);
    for (const service of services) {
      if (!service.init) continue;
      const init = join(at.dir, `${service.name}-init`);
      mkdirSync(init);
      chmodSync(init, 0o755);
      writeFileSync(join(init, service.init.file), service.init.text);
      chmodSync(join(init, service.init.file), 0o644);
    }
    writeFileSync(file, composeFile(kind, services, form));
    // The second CA signs nothing: the DSN that names it fails the chain of the certificate of the server.
    issueTls(join(at.dir, 'tls'), []);
    const variables = SERVERS[kind].variables({ host, ipv4: '${address}', authority: place.authority(stated), other: place.other, leases: place.leases });
    writeFileSync(join(at.dir, 'run.sh'), runFile(at, kind, form, services, SERVERS[kind].steps(host), host(kind), variables, command));
    if (form === 'runner') {
      if (command === undefined) throw new TestServerError('test-servers-container: a run in the runner needs a command');
      writeFileSync(join(at.dir, 'runner-setup.sh'), setupFile());
      writeFileSync(join(at.dir, 'check.sh'), checkFile(command));
      bundle(context.root, join(at.dir, 'repo.bundle'));
    }
    return at;
  } catch (error) {
    rmSync(at.dir, { recursive: true, force: true });
    throw error;
  }
}

// hostPlace and RUNNER_PLACE are where the variables of each form name the files of a run: the host names the directory
// by the variable dir of run.sh and the authority by its path on the machine, the runner names the directory by its
// mount and the authority by the path where bay mounts it in a container.
const hostPlace = (leases: string) => ({ leases, other: '${dir}/tls/other-ca.pem', authority: (stated: Planned) => stated.authority });
const RUNNER_PLACE = { leases: `${RUN_MOUNT}/leases`, other: `${RUN_MOUNT}/tls/other-ca.pem`, authority: (stated: Planned) => stated.mounted };

// bundle writes the commit of the checkout as a Git bundle, which the runner clones; the host of the run needs no git.
// A run in the runner is a run of that commit, so a checkout whose tracked files differ from it is refused.
function bundle(root: string, file: string): void {
  const git = (args: string[]) => {
    const ran = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (ran.error) throw new TestServerError(`test-servers-container: git: ${ran.error.message}`);
    return succeeded({ status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr }, `git ${args.join(' ')} in ${root}`);
  };
  const changed = git(['status', '--porcelain', '--untracked-files=no']);
  if (changed !== '') throw new TestServerError(`test-servers-container: the tracked files of ${root} differ from its commit, and a run in the runner runs the commit; commit the changes first:\n${changed}`);
  git(['bundle', 'create', file, 'HEAD']);
}

// localPlan reads the plan from the bay of this machine.
const localPlan = (context: Context): Plan => at => succeeded(bay(context, ['plan', '--json'], at), `bay plan --json of ${at.name}`);

// Executed is how run.sh ended, with the last part of what it wrote to its standard error.
interface Executed { code: number | null; signal: NodeJS.Signals | null; said: string }

// execute runs a part of run.sh of a project with sh and resolves when it ends; the end of that process is the only
// event that this script waits for. Its output is that of this script, and the last part of its standard error is kept
// for the failure. kill, when it is given, receives the call that sends a signal to sh.
function execute(context: Context, at: At, part: 'up' | 'down' | 'pull' | undefined, kill?: (send: (signal: NodeJS.Signals) => void) => void, started?: () => void): Promise<Executed> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('sh', [join(at.dir, 'run.sh'), ...(part === undefined ? [] : [part])], { env: { ...process.env, BAY_COMMAND: context.bay }, stdio: ['ignore', 'inherit', 'pipe'] });
    let said = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { process.stderr.write(chunk); said = `${said}${chunk}`.slice(-8192); });
    kill?.(signal => child.kill(signal));
    child.on('spawn', () => started?.());
    child.on('error', error => rejectRun(new TestServerError(`test-servers-container: sh: ${error.message}`)));
    child.on('close', (code, signal) => resolveRun({ code, signal, said }));
  });
}

// down removes a project with the part down of its run.sh, and then its directory. A project whose bay down fails
// keeps its directory, so that stop finds it again; a directory without run.sh was never started.
function down(context: Context, at: At): void {
  if (existsSync(join(at.dir, 'run.sh'))) {
    const ran = spawnSync('sh', [join(at.dir, 'run.sh'), 'down'], { env: { ...process.env, BAY_COMMAND: context.bay }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (ran.error) throw new TestServerError(`test-servers-container: sh: ${ran.error.message}`);
    succeeded({ status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr }, `sh ${join(at.dir, 'run.sh')} down`);
  }
  rmSync(at.dir, { recursive: true, force: true });
  console.error(`test-servers-container: removed ${at.name}`);
}

// environment reads the variables of servers.env of a started project.
function environment(file: string): Record<string, string> {
  return Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/^export ([A-Z_]+)='(.*)'$/gm)].map(([, name, value]) => [name ?? '', value ?? '']));
}

// claim is the file that names the project of the kind that start started in a checkout.
const claim = (dir: string, kind: Kind) => join(dir, `${kind}.project`);

// start starts the servers of a kind for the checkout of context, writes the environment file of the kind, and returns
// its variables. It refuses a kind that is started in the checkout, because the environment file names one project.
export async function start(kind: Kind, context: Context): Promise<Record<string, string>> {
  const { dir, leases } = folders(context.root);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(claim(dir, kind), '', { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new TestServerError(`test-servers-container: ${kind} is started in this checkout; run make orm-test-container-stop, which removes it`);
  }
  try {
    contract(context);
    const at = write(kind, context, 'host', undefined, localPlan(context), hostPlace(leases));
    const ended = await execute(context, at, 'up');
    if (ended.code !== 0) {
      // run.sh removed the project when a step failed after bay up; a part that failed before it started nothing.
      finish(at, false);
      throw new TestServerError(`test-servers-container: sh run.sh up of ${at.name} exited with ${ended.code ?? ended.signal}:\n${ended.said}`);
    }
    writeFileSync(claim(dir, kind), `${at.name}\n`);
    copyFileSync(join(at.dir, 'servers.env'), `${join(dir, `${kind}.env`)}.tmp`);
    renameSync(`${join(dir, `${kind}.env`)}.tmp`, join(dir, `${kind}.env`));
    console.error(`test-servers-container: ${kind} is the project ${at.name}`);
    return environment(join(at.dir, 'servers.env'));
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

// Signals is where a run receives SIGINT and SIGTERM: the process, or the emitter of a test.
interface Signals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

// RunOptions has the source of the signals of a run and a call for the moment its command has started.
export interface RunOptions { signals?: Signals; started?: () => void }

// Ended is how the command of a run ended: its exit code, or the signal that ended it.
export interface Ended { code: number | null; signal: NodeJS.Signals | null }

// RunForm is how a run runs its command: in the runner instead of on the host, and with its directory kept at its end,
// so that a later sh run.sh of that directory finds the installed tools and the build of the commit.
export interface RunForm { runner?: boolean; keep?: boolean }

// run writes the directory of a run of a kind and runs its run.sh, which starts the servers, runs the command with
// their variables, and removes the project when the command ends or fails, or when the run gets SIGINT or SIGTERM,
// which this script sends on to sh. It then removes the directory, unless the run keeps it; a directory whose project
// run.sh did not remove stays, so that stop finds it.
export async function run(kind: Kind, command: readonly string[], context: Context, options: RunOptions & RunForm = {}): Promise<Ended> {
  if (command.length === 0) throw new TestServerError('test-servers-container: run needs a command after --', 2);
  const signals = options.signals ?? process;
  let received: NodeJS.Signals | undefined;
  let send: ((signal: NodeJS.Signals) => void) | undefined;
  const interrupt = () => { received = 'SIGINT'; send?.('SIGINT'); };
  const terminate = () => { received = 'SIGTERM'; send?.('SIGTERM'); };
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  try {
    contract(context);
    const { leases } = folders(context.root);
    const at = write(kind, context, options.runner ? 'runner' : 'host', command, localPlan(context), options.runner ? RUNNER_PLACE : hostPlace(leases));
    const ended = await execute(context, at, undefined, kill => { send = kill; if (received !== undefined) kill(received); }, options.started);
    finish(at, options.keep === true);
    return received !== undefined ? { code: null, signal: received } : { code: ended.code, signal: ended.signal };
  } finally {
    signals.off('SIGINT', interrupt);
    signals.off('SIGTERM', terminate);
  }
}

// finish removes the directory of a run that ended, unless the run keeps it. run.sh writes the file started before bay
// up and the file removed after bay down; a directory with started and without removed has a project that is not
// removed, and stays.
function finish(at: At, keep: boolean): void {
  const left = existsSync(join(at.dir, 'started')) && !existsSync(join(at.dir, 'removed'));
  if (left) throw new TestServerError(`test-servers-container: run.sh did not remove the project ${at.name}; run make orm-test-container-stop, which removes it`);
  if (keep) console.error(`test-servers-container: kept ${at.dir}; sh ${join(at.dir, 'run.sh')} runs it again`);
  else rmSync(at.dir, { recursive: true, force: true });
}

// Remote is a run on another machine: the host that ssh names, the directory there that receives the directory of the
// run, the command of bay there (bay of PATH without it), and whether the run pulls the images first.
export interface Remote { host: string; directory: string; bay?: string; keep?: boolean; pull?: boolean }

// remote runs a kind in the runner on another machine, whose host needs sh and bay alone. It writes the directory with
// the plan of the bay of that machine, sends it as a tar archive through ssh, runs ssh <host> sh <directory>/run.sh,
// brings report/ back into the directory of the run, and removes the directory of that machine, unless the run keeps
// it. run.sh knows no machine: only this command names the host and the directory.
export function remote(kind: Kind, command: readonly string[], context: Context, where: Remote): number {
  if (command.length === 0) throw new TestServerError('test-servers-container: remote needs a command after --', 2);
  const [ssh, tar] = [context.ssh ?? 'ssh', context.tar ?? 'tar'];
  const program = (file: string, args: string[], stdio: [number | 'ignore', number | 'pipe', 2]) => {
    const ran = spawnSync(file, args, { encoding: 'utf8', stdio, maxBuffer: 2 ** 30 });
    if (ran.error) throw new TestServerError(`test-servers-container: ${file}: ${ran.error.message}`);
    return ran;
  };
  // send packs a directory and unpacks it in a directory of the machine; the archive is a file, so that the exit status
  // of each program is read.
  const send = (from: string, to: string) => {
    const archive = `${from}.tar`;
    try {
      if (program(tar, ['-C', from, '-cf', archive, '.'], ['ignore', 2, 2]).status !== 0) throw new TestServerError(`test-servers-container: ${tar} of ${from} failed`);
      const input = openSync(archive, 'r');
      try {
        if (program(ssh, [where.host, `mkdir -p ${quote(to)} && tar -C ${quote(to)} -xf -`], [input, 2, 2]).status !== 0) throw new TestServerError(`test-servers-container: sending ${from} to ${where.host}:${to} failed`);
      } finally {
        closeSync(input);
      }
    } finally {
      rmSync(archive, { force: true });
    }
  };
  // The bay of that machine has the contract of this script: it is read before anything is written or sent.
  const theirs = where.bay ?? 'bay';
  if (/['\n]/.test(theirs)) throw new TestServerError(`test-servers-container: the command of bay of ${where.host} holds a quote: ${theirs}`);
  const stated = program(ssh, [where.host, `${theirs} version --json`], ['ignore', 'pipe', 2]);
  if (stated.status !== 0) throw new TestServerError(`test-servers-container: ${theirs} version --json on ${where.host} exited with ${stated.status ?? stated.signal}; install bay there, or name its command in REMOTE_BAY_COMMAND`);
  contracted(stated.stdout, ` on ${where.host}`);
  let there: string | undefined;
  const at = write(kind, context, 'runner', command, planning => {
    there = `${where.directory}/${planning.name}`;
    send(planning.dir, there);
    const printed = program(ssh, [where.host, `cd ${quote(there)} && ${theirs} -p ${quote(planning.name)} plan --json`], ['ignore', 'pipe', 2]);
    if (printed.status !== 0) throw new TestServerError(`test-servers-container: bay plan --json of ${planning.name} on ${where.host} exited with ${printed.status ?? printed.signal}`);
    return printed.stdout;
  }, RUNNER_PLACE);
  const target = `${where.directory}/${at.name}`;
  try {
    send(at.dir, target);
    if (where.pull && program(ssh, [where.host, `BAY_COMMAND=${quote(theirs)} sh ${quote(`${target}/run.sh`)} pull`], ['ignore', 2, 2]).status !== 0) throw new TestServerError(`test-servers-container: sh run.sh pull of ${at.name} on ${where.host} failed`);
    const ended = program(ssh, [where.host, `BAY_COMMAND=${quote(theirs)} sh ${quote(`${target}/run.sh`)}`], ['ignore', 2, 2]);
    const report = `${join(at.dir, 'report')}.tar`;
    const output = openSync(report, 'w');
    try {
      const fetched = program(ssh, [where.host, `mkdir -p ${quote(`${target}/report`)} && tar -C ${quote(`${target}/report`)} -cf - .`], ['ignore', output, 2]);
      mkdirSync(join(at.dir, 'report'), { recursive: true });
      if (fetched.status !== 0 || program(tar, ['-C', join(at.dir, 'report'), '-xf', report], ['ignore', 2, 2]).status !== 0) throw new TestServerError(`test-servers-container: bringing the report of ${at.name} back from ${where.host} failed`);
    } finally {
      closeSync(output);
      rmSync(report, { force: true });
    }
    const kept = join(folders(context.root).dir, 'reports', at.name);
    mkdirSync(join(folders(context.root).dir, 'reports'), { recursive: true });
    renameSync(join(at.dir, 'report'), kept);
    console.error(`test-servers-container: the report of ${at.name} is ${kept}`);
    return ended.status ?? 1;
  } finally {
    if (!where.keep) program(ssh, [where.host, `rm -rf ${quote(target)}`], ['ignore', 2, 2]);
    rmSync(at.dir, { recursive: true, force: true });
  }
}

// pull downloads each pinned image with bay pull; it is the only command of this script that downloads on this
// machine. bay pulls the images of a Compose file, so pull writes one with a service for each image into a directory
// of its own, which it removes; bay pull creates and starts no container.
export function pull(context: Context): void {
  contract(context);
  const { dir } = folders(context.root);
  mkdirSync(dir, { recursive: true });
  const name = `orm-${checkout(context.root)}-pull-${randomBytes(4).toString('hex')}`;
  const at: At = { name, dir: join(dir, name) };
  mkdirSync(at.dir);
  try {
    writeFileSync(join(at.dir, 'compose.yaml'), yaml({ services: Object.fromEntries([...KINDS, 'runner' as const].map(each => [each, { image: image(each) }])) }));
    const pulled = bay(context, ['pull'], at);
    process.stderr.write(`${pulled.stdout}${pulled.stderr}`);
    if (pulled.status !== 0) throw new TestServerError(`test-servers-container: bay pull of the images of config/containers.json exited with ${pulled.status ?? pulled.signal}`);
  } finally {
    rmSync(at.dir, { recursive: true, force: true });
  }
}

// installBay installs the release of bay that CI installs into var/tools/bay of the checkout: it downloads the archive
// of the platform, uses it only with the sha256 that config/containers.json pins, and publishes bay and bayd, which bay finds
// beside itself. It changes nothing of the machine: the machine setup is bay install, which the target
// orm-install-bay-machine runs.
export function installBay(context: Context, pin: BayPin = bayPin()): void {
  const platform = `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const sum = pin.sha256[platform];
  if (sum === undefined) throw new TestServerError(`test-servers-container: config/containers.json pins no archive of bay for ${platform}; add its sha256 from SHA256SUMS of ${pin.release}`);
  const name = `bay_${pin.version}_${platform}`;
  const tools = join(context.root, 'var/tools');
  const staging = join(tools, `bay.${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { recursive: true });
  try {
    const archive = join(staging, `${name}.tar.gz`);
    const ran = (file: string, args: string[]) => {
      const ended = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 2, 2] });
      if (ended.error) throw new TestServerError(`test-servers-container: ${file}: ${ended.error.message}`);
      if (ended.status !== 0) throw new TestServerError(`test-servers-container: ${file} ${args.join(' ')} exited with ${ended.status ?? ended.signal}`);
    };
    ran(context.curl ?? 'curl', ['-fsSL', `${pin.release}/${name}.tar.gz`, '-o', archive]);
    const found = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (found !== sum) throw new TestServerError(`test-servers-container: ${name}.tar.gz has the sha256 ${found}, and config/containers.json pins ${sum}; the archive is not used`);
    ran(context.tar ?? 'tar', ['-C', staging, '-xzf', archive]);
    const target = join(tools, 'bay');
    mkdirSync(target, { recursive: true });
    for (const program of ['bay', 'bayd']) {
      chmodSync(join(staging, name, program), 0o755);
      renameSync(join(staging, name, program), join(target, program));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// exitCode is the exit code of a run whose command ended: its code, or 128 and the number of the signal that ended it.
function exitCode({ code, signal }: Ended): number {
  if (code !== null) return code;
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

if (import.meta.main) {
  const [command, kind, ...rest] = process.argv.slice(2);
  try {
    const program = process.env['BAY_COMMAND'];
    if (!program) throw new TestServerError('test-servers-container: BAY_COMMAND is unset; run this through make, which names the command of bay');
    const context: Context = { root: REPOSITORY, bay: program };
    const { dir, leases } = folders(REPOSITORY);
    const usage = new TestServerError('usage: test-servers-container.mts start <kind> | run <kind> [--runner] [--keep] -- <command> [argument...] | remote <kind> <host> <directory> [--keep] [--pull] -- <command> [argument...] | stop | pull | install-bay, where <kind> is mysql, postgres or mariadb', 2);
    const separator = rest.indexOf('--');
    const [options, words] = separator < 0 ? [rest, []] : [rest.slice(0, separator), rest.slice(separator + 1)];
    const flags = options.filter(option => option.startsWith('--'));
    const names = options.filter(option => !option.startsWith('--'));
    const allowed = (...known: string[]) => flags.every(flag => known.includes(flag));
    if (command === 'start' && isKind(kind) && rest.length === 0) {
      await start(kind, context);
      console.log(`test-servers-container: ${kind} is started; its environment file is ${join(dir, `${kind}.env`)}`);
    } else if (command === 'run' && isKind(kind) && words.length > 0 && names.length === 0 && allowed('--runner', '--keep'))
      process.exitCode = exitCode(await run(kind, words, context, { runner: flags.includes('--runner'), keep: flags.includes('--keep') }));
    else if (command === 'remote' && isKind(kind) && words.length > 0 && names.length === 2 && allowed('--keep', '--pull'))
      process.exitCode = remote(kind, words, context, { host: names[0] ?? '', directory: names[1] ?? '', keep: flags.includes('--keep'), pull: flags.includes('--pull'), ...(process.env['REMOTE_BAY_COMMAND'] ? { bay: process.env['REMOTE_BAY_COMMAND'] } : {}) });
    else if (command === 'stop' && kind === undefined) {
      mkdirSync(leases, { recursive: true });
      holdExclusiveLease(leases);
      remove(context);
    } else if (command === 'pull' && kind === undefined) pull(context);
    else if (command === 'install-bay' && kind === undefined) installBay(context);
    else throw usage;
  } catch (error) {
    if (!(error instanceof TestServerError)) throw error;
    if (error.message) console.error(error.message);
    process.exitCode = error.status;
  }
}
