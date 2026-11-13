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
// BAY_PROGRAM names bay and CONTAINER_PROGRAM the container engine of the platform; make passes both. The servers start
// and stop only through bay up and bay down. The engine is run only for the images: bay has no command that pulls an
// image and no setting that refuses a pull, so a start asks the engine whether each image is on the machine and fails
// for an absent one, and pull, the only command that downloads, pulls with the engine (BAY3).
//
// Each start has a project of its own: the directory .runtime/containers/<project> with compose.yaml, the TLS files and
// the initialization files of its servers. <project> is orm-<checkout>-<run>, where <checkout> is the first 12
// hexadecimal digits of the sha256 of the root of the checkout and <run> is 8 random hexadecimal digits, and the Compose
// file names it in its key name, the only place where bay reads a project name (BAY2). So two checkouts and two runs
// of one checkout share nothing, and stop removes every project of its checkout, the project of a killed run included,
// and no project of another checkout (T444).
//
// bay runs no command in a started container, so the setup of a server is a file of /docker-entrypoint-initdb.d of its
// service, which the image runs once before the server accepts connections over TCP. A server is ready when bay up
// returns with 0: each service declares a healthcheck with the readiness program of its server over TCP on 127.0.0.1,
// and a replica depends on its healthy primary. This script waits for that process alone; it reads no log, starts no
// timer and repeats no request.
//
// The script holds no form and no suffix of a service address. It reads the form from serviceAddress of bay brief
// --json before it issues the certificate of a server and writes the files of the project, reads the address and the
// IPv4 address of each service from bay status --json after bay up, and fails a start whose two readings differ (BAY4).
//
// start writes .runtime/containers/<kind>.env and refuses a kind that is started in the checkout; run gives the
// variables to its command, writes no shared file, and removes its project when the command ends or fails, or when the
// run gets SIGINT or SIGTERM, which it forwards to the command. The MySQL and PostgreSQL variables are those of the
// primary of TEST_ENV with the replica DSN, the MariaDB variables those of the primary of MARIADB_ENV. The certificate
// of a server names the host name of its address: the TLS DSN connects to that name, the DSN with the second CA fails
// the chain, and the mismatch DSN connects to the IPv4 address of the service, which the certificate does not name. No
// pooler is started and no Unix socket of a server is on the host, because bay publishes none (BAY8); their variables
// are absent, and a check that reads one fails naming the variable.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorCode } from '../tests/errors.mts';
import { holdExclusiveLease, issueTls, SERVER_TIME_ZONE, MYSQLD_BINLOG, MYSQLD_STORAGE, MYSQL_LOWER_CASE, ORM_ACCOUNTS_SQL, POSTGRES_WAL, TestServerError } from './test-servers.mts';

const REPOSITORY = resolve(import.meta.dirname, '..');
// TLS_MOUNT is the folder of the TLS files in the container, and INIT_MOUNT the folder whose files an image runs once
// when it initializes its data directory.
const TLS_MOUNT = '/etc/orm-tls';
const INIT_MOUNT = '/docker-entrypoint-initdb.d';
// POSTGRES_KEY is the copy of the key of the PostgreSQL server in the container, outside its data directory.
const POSTGRES_KEY = '/var/lib/postgresql/orm-tls-key.pem';

type Kind = 'mysql' | 'postgres' | 'mariadb';

// Context is the checkout whose servers a command starts or removes, with the program bay and the container engine.
export interface Context { root: string; bay: string; engine: string }

// Folders are the files of the servers of a checkout: .runtime/containers and its leases.
interface Folders { dir: string; leases: string }

function folders(root: string): Folders {
  const dir = join(root, '.runtime/containers');
  return { dir, leases: join(dir, 'leases') };
}

// Yaml is a value of the Compose file: a string, a number, a list of strings, or a mapping of such values.
type Yaml = string | number | readonly string[] | { readonly [key: string]: Yaml };

// Service is a service of the project of a start. command and environment are those of the server; init is the file of
// the initialization directory of the image, by its name; health is the readiness program of the server, which runs in
// the container; after is the service that must be healthy before this one starts.
interface Service {
  name: string;
  port: number;
  command: string[];
  environment: Record<string, string>;
  init?: { file: string; text: string };
  health: string[];
  after?: string;
}

// Endpoint is where the checks reach the servers of a started project: the host name and the IPv4 address of each
// service by its name, the folder of the TLS files on the host, and the lease folder of the checkout.
interface Endpoint { host: (service: string) => string; ipv4: (service: string) => string; tls: string; leases: string }

interface Server {
  // services are the services of the kind, the primary first; host is the host name of a service of the project.
  services: (host: (service: string) => string) => Service[];
  variables: (server: Endpoint) => Record<string, string>;
}

const mysqlTls = (tls: string, host: string, ca: string) => `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${tls}/${ca}.pem`;
const postgresTls = (tls: string, host: string, ca: string) => `postgres://orm@${host}:5432/orm_test?sslmode=verify-full&sslrootcert=${tls}/${ca}.pem`;
const mysqlTlsOptions = (kind: Kind) => [`--ssl-ca=${TLS_MOUNT}/ca.pem`, `--ssl-cert=${TLS_MOUNT}/${kind}-cert.pem`, `--ssl-key=${TLS_MOUNT}/${kind}-key.pem`];

// The MySQL and the MariaDB server take the options of the native primary (scripts/test-servers.mts).
const mysqlOptions = ['--secure-file-priv=NULL', `--lower-case-table-names=${MYSQL_LOWER_CASE}`, ...MYSQLD_BINLOG, ...MYSQLD_STORAGE];
const mysqlArguments = (serverId: number) => ['mysqld', '--mysqlx=OFF', ...mysqlOptions, `--server-id=${serverId}`, ...mysqlTlsOptions('mysql')];

// The PostgreSQL servers take the settings of postgresArguments of scripts/test-servers.mts; the primary names the replica
// as its synchronous standby with synchronous_commit=local, so only a transaction that asks for remote_apply waits for it.
// PostgreSQL refuses a key that another user than its own can read, so the key is copied for the user postgres first.
const postgresKey = `install -m 0600 -o postgres -g postgres ${TLS_MOUNT}/postgres-key.pem ${POSTGRES_KEY}`;
const postgresSettings = ['-c', `timezone=${SERVER_TIME_ZONE}`, '-c', 'ssl=on', '-c', `ssl_cert_file=${TLS_MOUNT}/postgres-cert.pem`, '-c', `ssl_key_file=${POSTGRES_KEY}`,
  ...POSTGRES_WAL.flatMap(setting => ['-c', setting])];

// The temporary server that an image starts to initialize a data directory listens only on its socket, so each readiness
// program connects over TCP on 127.0.0.1 and succeeds only for the server that the checks reach.
const mysqlHealth = ['mysqladmin', 'ping', '--host=127.0.0.1', '--protocol=TCP', '--silent'];
const postgresHealth = ['pg_isready', '--host=127.0.0.1', '--username=orm', '--dbname=postgres'];
const DATABASES_SQL = `CREATE DATABASE orm_test; CREATE DATABASE orm_tools; ${ORM_ACCOUNTS_SQL}`;
const postgresEnvironment = { POSTGRES_USER: 'orm', POSTGRES_HOST_AUTH_METHOD: 'trust', POSTGRES_INITDB_ARGS: '--encoding=UTF8 --locale=C' };

const SERVERS: Record<Kind, Server> = {
  mysql: {
    services: host => [
      // The primary resets its binary log as the last step of the initialization of its image and then creates the
      // databases and the accounts of the user orm, as the native servers have them, so its binary log holds these
      // statements and none of the image, which initializes the replica as well.
      { name: 'mysql', port: 3306, command: mysqlArguments(1), environment: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' }, health: mysqlHealth,
        init: { file: 'orm.sql', text: `RESET BINARY LOGS AND GTIDS; ${DATABASES_SQL}\n` } },
      // The replica names the primary as its source in the temporary server of its image and starts its replication when
      // its server starts: it reads the binary log of the primary from its first file and applies the databases and the
      // accounts. The two settings are persisted, because the temporary server stops after this file: super_read_only,
      // and partial_revokes as REPLICA_PARTIAL_REVOKES_SQL sets it on the native replica, so the replica refuses a
      // catalog row change (INT-119).
      { name: 'mysql-replica', port: 3306, command: mysqlArguments(2), environment: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' }, health: mysqlHealth, after: 'mysql',
        init: { file: 'orm.sql', text: `CHANGE REPLICATION SOURCE TO SOURCE_HOST='${host('mysql')}', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1; SET PERSIST partial_revokes = ON; SET PERSIST super_read_only = ON;\n` } },
    ],
    variables: ({ host, ipv4, tls, leases }) => {
      const mysql = `mysql://root@${host('mysql')}:3306`;
      return {
        ORM_TEST_MYSQL_DSN: `${mysql}/orm_test`, ORM_TEST_MYSQL_SERVER_DSN: `${mysql}/orm_test`, ORM_TOOLS_MYSQL_DSN: `${mysql}/orm_tools`,
        ORM_RUN_MYSQL_DSN: `${mysql}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: leases,
        ORM_TEST_MYSQL_TLS_DSN: mysqlTls(tls, host('mysql'), 'ca'), ORM_TEST_MYSQL_TLS_OTHER_CA_DSN: mysqlTls(tls, host('mysql'), 'other-ca'), ORM_TEST_MYSQL_TLS_MISMATCH_DSN: mysqlTls(tls, ipv4('mysql'), 'ca'),
        ORM_TEST_MYSQL_REPLICA_DSN: `mysql://root@${host('mysql-replica')}:3306/orm_test`,
      };
    },
  },
  postgres: {
    services: host => [
      // The rules of the image let every host connect to every database, which does not cover replication, so the
      // initialization lets the role orm replicate, and creates the databases.
      { name: 'postgres', port: 5432, environment: postgresEnvironment, health: postgresHealth,
        command: ['sh', '-c', `${postgresKey} && exec docker-entrypoint.sh "$@"`, 'sh',
          'postgres', ...postgresSettings, '-c', 'synchronous_standby_names=orm_replica', '-c', 'synchronous_commit=local'],
        init: { file: 'orm.sh', text: `echo 'host replication orm all trust' >> "$PGDATA/pg_hba.conf"\npsql -X -q -v ON_ERROR_STOP=1 -U orm -d postgres -c 'CREATE DATABASE orm_test' -c 'CREATE DATABASE orm_tools'\n` } },
      // The standby is a pg_basebackup of the healthy primary into the empty data directory, and the image skips its
      // initialization for that directory; -R writes the standby configuration with the application_name that
      // synchronous_standby_names lists, and -C -S creates the slot orm_replica, as postgresBaseBackupArguments does.
      { name: 'postgres-replica', port: 5432, environment: postgresEnvironment, health: postgresHealth, after: 'postgres',
        command: ['sh', '-c', `${postgresKey} && chown postgres:postgres "$PGDATA" && chmod 0700 "$PGDATA" && gosu postgres pg_basebackup -D "$PGDATA" -R -C -S orm_replica -X stream -d 'host=${host('postgres')} port=5432 user=orm application_name=orm_replica' && exec docker-entrypoint.sh "$@"`, 'sh',
          'postgres', ...postgresSettings] },
    ],
    variables: ({ host, ipv4, tls, leases }) => {
      const postgres = `postgres://orm@${host('postgres')}:5432`;
      return {
        ORM_TEST_POSTGRES_DSN: `${postgres}/orm_test`, ORM_TEST_POSTGRES_SERVER_DSN: `${postgres}/orm_test`, ORM_TOOLS_POSTGRES_DSN: `${postgres}/orm_tools`,
        ORM_RUN_POSTGRES_DSN: `${postgres}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: leases,
        ORM_TEST_POSTGRES_TLS_DSN: postgresTls(tls, host('postgres'), 'ca'), ORM_TEST_POSTGRES_TLS_OTHER_CA_DSN: postgresTls(tls, host('postgres'), 'other-ca'), ORM_TEST_POSTGRES_TLS_MISMATCH_DSN: postgresTls(tls, ipv4('postgres'), 'ca'),
        ORM_TEST_POSTGRES_REPLICA_DSN: `postgres://orm@${host('postgres-replica')}:5432/orm_test`,
      };
    },
  },
  mariadb: {
    // healthcheck.sh is the readiness program of the image; --connect requires a connection over TCP.
    services: () => [
      { name: 'mariadb', port: 3306, command: ['mariadbd', ...mysqlOptions, '--server-id=1', ...mysqlTlsOptions('mariadb')], environment: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: '1' },
        health: ['healthcheck.sh', '--connect', '--innodb_initialized'], init: { file: 'orm.sql', text: `${DATABASES_SQL}\n` } },
    ],
    variables: ({ host, ipv4, tls, leases }) => {
      const mariadb = `mysql://root@${host('mariadb')}:3306`;
      return {
        ORM_TEST_MARIADB_DSN: `${mariadb}/orm_test`, ORM_TEST_MARIADB_SERVER_DSN: `${mariadb}/orm_test`, ORM_TOOLS_MARIADB_DSN: `${mariadb}/orm_tools`, ORM_TEST_MARIADB_LEASES: leases,
        ORM_TEST_MARIADB_TLS_DSN: mysqlTls(tls, host('mariadb'), 'ca'), ORM_TEST_MARIADB_TLS_OTHER_CA_DSN: mysqlTls(tls, host('mariadb'), 'other-ca'), ORM_TEST_MARIADB_TLS_MISMATCH_DSN: mysqlTls(tls, ipv4('mariadb'), 'ca'),
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

// ran is the end of a program that this script ran to its end.
interface Ran { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

// PROVIDED states, for each program, what it does for this script and what provides it; a missing program fails with it.
const PROVIDED = {
  bay: 'it is the program bay, which runs the Compose project of the servers; install bay at that path and run bay check, which names the machine setup that bay install applies (no target of this repository installs bay, BAY5)',
  engine: 'it is the container engine, which holds the images of the servers; install Apple container on macOS or Docker on Linux at that path, or name the engine of this machine in CONTAINER_PROGRAM',
};

// program runs bay or the engine to its end with its output captured, in cwd when it is given, and fails naming the
// path when the program is missing.
function program(context: Context, which: 'bay' | 'engine', args: string[], cwd?: string): Ran {
  const path = context[which];
  const ran = spawnSync(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }) });
  if (ran.error) {
    if (errorCode(ran.error) === 'ENOENT' && !existsSync(path)) throw new TestServerError(`test-servers-container: ${path} is missing: ${PROVIDED[which]}`);
    throw new TestServerError(`test-servers-container: ${path}: ${ran.error.message}`);
  }
  return { status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr };
}

// bay runs a command of bay that must succeed and returns its standard output.
function bay(context: Context, args: string[], cwd?: string): string {
  const ran = program(context, 'bay', args, cwd);
  if (ran.status !== 0) throw new TestServerError(`test-servers-container: bay ${args.join(' ')}${cwd === undefined ? '' : ` in ${cwd}`} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
  return ran.stdout;
}

// addressForm reads the form of a service address from bay brief --json and returns the address of a service of a
// project on a port in that form. The form names the project, the service and, last, the port.
function addressForm(context: Context): (project: string, service: string, port: number) => string {
  const form = field(JSON.parse(bay(context, ['brief', '--json'])), 'serviceAddress');
  if (typeof form !== 'string' || !form.endsWith(':<port>') || form.split('<project>').length !== 2 || form.split('<service>').length !== 2)
    throw new TestServerError(`test-servers-container: bay brief --json states the service address ${JSON.stringify(form)}, which does not name <project> and <service> once and end with :<port>`);
  return (project, service, port) => form.replace('<project>', project).replace('<service>', service).replace('<port>', String(port));
}

// reported are the address and the IPv4 address that bay status --json reports for each service of a started project,
// by the name of the service.
function reported(context: Context, project: string): Map<string, { address: unknown; ipv4: unknown }> {
  const groups = field(JSON.parse(bay(context, ['status', '--json'])), 'groups');
  const group = Array.isArray(groups) ? groups.find(each => field(each, 'name') === project) : undefined;
  const services = field(group, 'services');
  if (!Array.isArray(services)) throw new TestServerError(`test-servers-container: bay status --json reports no services of the project ${project}`);
  return new Map(services.flatMap(service => {
    const name = field(service, 'name');
    return typeof name === 'string' ? [[name, { address: field(service, 'address'), ipv4: field(service, 'ipv4') }] as const] : [];
  }));
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
// expose and no key ports, so no port of the host is published. The interval, the time limit of one probe and the count
// of probes are settings of the probe of bay, which requires a count: 600 probes a second apart are far above the time
// a start takes on a loaded machine.
function composeFile(project: string, kind: Kind, services: readonly Service[]): string {
  return yaml({
    name: project,
    services: Object.fromEntries(services.map(service => [service.name, {
      image: image(kind),
      command: service.command,
      expose: [String(service.port)],
      environment: { TZ: SERVER_TIME_ZONE, ...service.environment },
      volumes: [`./tls:${TLS_MOUNT}:ro`, ...(service.init ? [`./${service.name}-init:${INIT_MOUNT}:ro`] : [])],
      cpus: '4',
      mem_limit: '4g',
      ...(service.after === undefined ? {} : { depends_on: { [service.after]: { condition: 'service_healthy' } } }),
      healthcheck: { test: ['CMD', ...service.health], interval: '1s', timeout: '5s', retries: 600 },
    }])),
  });
}

// Project is a started project: its name, its directory, and the variables of its servers.
interface Project { name: string; dir: string; variables: Record<string, string> }

// upProcess runs bay up in the directory of a project and resolves with its exit status when it ends; its output goes
// to the standard error of this script. The end of that process is the only event that a start waits for.
function upProcess(context: Context, dir: string): Promise<number | NodeJS.Signals | null> {
  return new Promise((resolveUp, rejectUp) => {
    const child = spawn(context.bay, ['up'], { cwd: dir, stdio: ['ignore', 2, 2] });
    child.on('error', error => rejectUp(new TestServerError(`test-servers-container: ${context.bay}: ${error.message}`)));
    child.on('exit', (code, signal) => resolveUp(code ?? signal));
  });
}

// up starts the servers of a kind as a project of its own and returns it. It creates nothing when a program or an image
// is missing, and a start that fails after it created the directory of the project removes the project.
async function up(kind: Kind, context: Context): Promise<Project> {
  const form = addressForm(context);
  const reference = image(kind);
  const inspected = program(context, 'engine', ['image', 'inspect', reference]);
  if (inspected.status !== 0)
    throw new TestServerError(`test-servers-container: the image ${reference} of ${kind} is not on this machine; run make orm-install-container-images, which pulls the images of config/containers.json:\n${inspected.stderr}`);
  const dirs = folders(context.root);
  mkdirSync(dirs.leases, { recursive: true });
  const name = `orm-${checkout(context.root)}-${randomBytes(4).toString('hex')}`;
  const dir = join(dirs.dir, name);
  mkdirSync(dir);
  let started = false;
  try {
    const ports = new Map(SERVERS[kind].services(() => '').map(service => [service.name, service.port] as const));
    const address = (service: string) => {
      const port = ports.get(service);
      if (port === undefined) throw new TestServerError(`test-servers-container: ${kind} has no service ${service}`);
      return form(name, service, port);
    };
    const host = (service: string) => address(service).slice(0, address(service).lastIndexOf(':'));
    const services = SERVERS[kind].services(host);
    // The servers of the images read the key as another user than the one that writes it here; these keys sign test data
    // only. The certificate names the host name that the form of bay gives the primary.
    const tls = join(dir, 'tls');
    issueTls(tls, [[kind, `DNS:${host(kind)}`]]);
    for (const file of [`${kind}-key.pem`, `${kind}-cert.pem`, 'ca.pem']) chmodSync(join(tls, file), 0o644);
    for (const service of services) {
      if (!service.init) continue;
      const init = join(dir, `${service.name}-init`);
      mkdirSync(init);
      chmodSync(init, 0o755);
      writeFileSync(join(init, service.init.file), service.init.text);
      chmodSync(join(init, service.init.file), 0o644);
    }
    writeFileSync(join(dir, 'compose.yaml'), composeFile(name, kind, services));
    started = true;
    const ended = await upProcess(context, dir);
    if (ended !== 0) {
      for (const service of services) {
        console.error(`test-servers-container: the last lines of the service ${service.name} of ${name}:`);
        const logs = program(context, 'bay', ['logs', '-n', '50', service.name], dir);
        process.stderr.write(`${logs.stdout}${logs.stderr}`);
      }
      throw new TestServerError(`test-servers-container: bay up of ${name} exited with ${ended}; the output of bay and the last lines of each service are above`);
    }
    const now = reported(context, name);
    const ipv4 = (service: string) => {
      const text = now.get(service)?.ipv4;
      if (typeof text !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(text)) throw new TestServerError(`test-servers-container: bay status reports no IPv4 address of the service ${service} of ${name}: ${JSON.stringify(text)}`);
      return text;
    };
    for (const service of services) {
      const at = now.get(service.name)?.address;
      if (at !== address(service.name))
        throw new TestServerError(`test-servers-container: bay status reports the service ${service.name} of ${name} at ${typeof at === 'string' ? at : JSON.stringify(at)}, and bay brief states ${address(service.name)}; the certificate and the replica of the project name the address of bay brief`);
      ipv4(service.name);
    }
    return { name, dir, variables: SERVERS[kind].variables({ host, ipv4, tls, leases: dirs.leases }) };
  } catch (error) {
    console.error(`test-servers-container: the start of ${kind} failed; removing ${name}`);
    down(context, dir, started);
    throw error;
  }
}

// down removes a project with bay down, when bay up ran for it, and then removes its directory. A project whose bay
// down fails keeps its directory, so that stop finds it again.
function down(context: Context, dir: string, started = existsSync(join(dir, 'compose.yaml'))): void {
  if (started) bay(context, ['down'], dir);
  rmSync(dir, { recursive: true, force: true });
  console.error(`test-servers-container: removed ${dir}`);
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
  for (const name of readdirSync(dir).filter(each => each.startsWith(prefix))) down(context, join(dir, name));
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
    if (project) down(context, project.dir);
  }
}

// pull pulls each pinned image with the container engine; it is the only command that downloads (BAY3).
function pull(context: Context): void {
  for (const kind of KINDS) {
    const pulled = program(context, 'engine', ['image', 'pull', image(kind)]);
    process.stderr.write(`${pulled.stdout}${pulled.stderr}`);
    if (pulled.status !== 0) throw new TestServerError(`test-servers-container: ${context.engine} image pull ${image(kind)} exited with ${pulled.status ?? pulled.signal}`);
  }
}

// named is the program that make names in the variable of its name.
function named(variable: 'BAY_PROGRAM' | 'CONTAINER_PROGRAM'): string {
  const path = process.env[variable];
  if (!path) throw new TestServerError(`test-servers-container: ${variable} is unset; run this through make, which names the program`);
  return path;
}

// exitCode is the exit code of a run whose command ended: its code, or 128 and the number of the signal that ended it.
function exitCode({ code, signal }: Ended): number {
  if (code !== null) return code;
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

if (import.meta.main) {
  const [command, kind, separator, ...rest] = process.argv.slice(2);
  try {
    const context: Context = { root: REPOSITORY, bay: named('BAY_PROGRAM'), engine: named('CONTAINER_PROGRAM') };
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
