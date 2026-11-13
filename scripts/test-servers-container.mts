// test-servers-container starts one test database server, MySQL, PostgreSQL or MariaDB, in an Apple container from the
// image that config/containers.json pins by its digest, and writes the environment file of that one server. It is the
// container form of the primaries of scripts/test-servers.mts: the server takes the settings of the native primary
// (time zone, lower-case table names, binary log retention, InnoDB log space), and its data lives on a tmpfs of the
// container, so removing the container removes the data and no volume is left.
//
//   node scripts/test-servers-container.mts start <mysql|postgres|mariadb>
//   node scripts/test-servers-container.mts stop
//   node scripts/test-servers-container.mts pull
//
// Each kind runs at most once, and kinds may run together: start refuses a kind whose container exists. The environment file is
// .runtime/containers/<kind>.env; the MySQL and PostgreSQL files have the variables of the primary of TEST_ENV, the
// MariaDB file those of the primary of MARIADB_ENV. The DSNs name the address of the container on its network, which
// the container runtime assigns, and the port of the server in the container. The server has TLS with a certificate
// that issueTls of scripts/test-servers.mts issues for each start under .runtime/containers/tls-<kind>: it names the host name of
// the container, <name>.container.test, so the TLS DSN connects to that name, the DSN with the second CA fails the chain,
// and the mismatch DSN connects to the address, which the certificate does not name. The Unix socket of MySQL and
// MariaDB is published at .runtime/containers/<kind>.sock. A replica and a pooler are not started, so their variables are
// absent and a check that reads them fails, naming the variable.
//
// Waiting for a server is a long operation without a time limit: start reads the output of the attached container on each
// change of its log file and resolves on the ready line that the server logs after its image finished its
// initialization, and fails when the container stops first.
// stop holds the exclusive lease of the servers, then stops and removes each container of this script.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { holdExclusiveLease, issueTls, SERVER_TIME_ZONE, MYSQLD_BINLOG, MYSQLD_STORAGE, MYSQL_LOWER_CASE, TestServerError } from './test-servers.mts';

const ROOT = resolve(import.meta.dirname, '..');
const CONTAINER = '/opt/homebrew/bin/container';
const PREFIX = 'polyspec-orm-test-';
const DIR = join(ROOT, '.runtime/containers');
const LEASES = join(DIR, 'leases');
// TLS_MOUNT is the folder of the TLS files in the container.
const TLS_MOUNT = '/etc/orm-tls';
// POSTGRES_KEY is the copy of the key of the PostgreSQL server in the container, outside its data directory.
const POSTGRES_KEY = '/var/lib/postgresql/orm-tls-key.pem';

type Kind = 'mysql' | 'postgres' | 'mariadb';

interface Server {
  // port is the port of the server in the container.
  port: number;
  // data is the data directory of the image, which a tmpfs replaces.
  data: string;
  environment: string[];
  arguments: string[];
  // initialized is the log line of the image after its initialization; ready is the first line after it that names a
  // server that accepts connections on its port.
  initialized: string;
  ready: (line: string) => boolean;
  // databases runs in the container and creates the databases of the checks.
  databases: string[];
  // socket is the Unix socket of the server in the container, which start publishes on the host.
  socket?: string;
  variables: (server: Endpoint) => Record<string, string>;
}

// Endpoint is where the checks reach a started server: its address, its host name, which its certificate names, and the
// host path of its published socket.
interface Endpoint { address: string; host: string; socket: string }

// tlsDir is the folder of the TLS files of the server of kind on the host.
const tlsDir = (kind: Kind) => join(DIR, `tls-${kind}`);
const mysqlTls = (kind: Kind, host: string, ca: string) => `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${tlsDir(kind)}/${ca}.pem`;
const postgresTls = (host: string, ca: string) => `postgres://orm@${host}:5432/orm_test?sslmode=verify-full&sslrootcert=${tlsDir('postgres')}/${ca}.pem`;
const mysqlTlsOptions = (kind: Kind) => [`--ssl-ca=${TLS_MOUNT}/ca.pem`, `--ssl-cert=${TLS_MOUNT}/${kind}-cert.pem`, `--ssl-key=${TLS_MOUNT}/${kind}-key.pem`];

// The MySQL and the MariaDB server take the options of the native primary (scripts/test-servers.mts). The temporary
// server of the image initialization listens on port 0, so the ready line of the server names port 3306.
const mysqlOptions = ['--secure-file-priv=NULL', `--lower-case-table-names=${MYSQL_LOWER_CASE}`, ...MYSQLD_BINLOG, ...MYSQLD_STORAGE, '--server-id=1'];
const mysqlReady = (line: string) => line.includes('ready for connections') && line.includes('port: 3306');

const SERVERS: Record<Kind, Server> = {
  mysql: {
    port: 3306, data: '/var/lib/mysql', environment: ['MYSQL_ALLOW_EMPTY_PASSWORD=yes'],
    arguments: ['mysqld', '--mysqlx=OFF', ...mysqlOptions, ...mysqlTlsOptions('mysql')],
    initialized: 'MySQL init process done', ready: mysqlReady,
    databases: ['mysql', '-uroot', '-e', 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools'],
    socket: '/var/run/mysqld/mysqld.sock',
    variables: ({ address, host, socket }) => {
      const mysql = `mysql://root@${address}:3306`;
      return {
        ORM_TEST_MYSQL_DSN: `${mysql}/orm_test`, ORM_TEST_MYSQL_SERVER_DSN: `${mysql}/orm_test`, ORM_TOOLS_MYSQL_DSN: `${mysql}/orm_tools`,
        ORM_RUN_MYSQL_DSN: `${mysql}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: LEASES,
        ORM_TEST_MYSQL_TLS_DSN: mysqlTls('mysql', host, 'ca'), ORM_TEST_MYSQL_TLS_OTHER_CA_DSN: mysqlTls('mysql', host, 'other-ca'), ORM_TEST_MYSQL_TLS_MISMATCH_DSN: mysqlTls('mysql', address, 'ca'),
        ORM_TEST_MYSQL_SOCKET: socket,
      };
    },
  },
  postgres: {
    port: 5432, data: '/var/lib/postgresql/data',
    environment: ['POSTGRES_USER=orm', 'POSTGRES_HOST_AUTH_METHOD=trust', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C'],
    // PostgreSQL refuses a key that another user than its own can read, so the key is copied for the user postgres first.
    arguments: ['sh', '-c', `install -m 0600 -o postgres -g postgres ${TLS_MOUNT}/postgres-key.pem ${POSTGRES_KEY} && exec docker-entrypoint.sh "$@"`, 'sh',
      'postgres', '-c', `timezone=${SERVER_TIME_ZONE}`, '-c', 'min_wal_size=32MB', '-c', 'max_wal_size=64MB',
      '-c', 'ssl=on', '-c', `ssl_cert_file=${TLS_MOUNT}/postgres-cert.pem`, '-c', `ssl_key_file=${POSTGRES_KEY}`],
    initialized: 'PostgreSQL init process complete', ready: line => line.includes('database system is ready to accept connections'),
    databases: ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'orm', '-d', 'postgres', '-c', 'CREATE DATABASE orm_test', '-c', 'CREATE DATABASE orm_tools'],
    variables: ({ address, host }) => {
      const postgres = `postgres://orm@${address}:5432`;
      return {
        ORM_TEST_POSTGRES_DSN: `${postgres}/orm_test`, ORM_TEST_POSTGRES_SERVER_DSN: `${postgres}/orm_test`, ORM_TOOLS_POSTGRES_DSN: `${postgres}/orm_tools`,
        ORM_RUN_POSTGRES_DSN: `${postgres}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: LEASES,
        ORM_TEST_POSTGRES_TLS_DSN: postgresTls(host, 'ca'), ORM_TEST_POSTGRES_TLS_OTHER_CA_DSN: postgresTls(host, 'other-ca'), ORM_TEST_POSTGRES_TLS_MISMATCH_DSN: postgresTls(address, 'ca'),
      };
    },
  },
  mariadb: {
    port: 3306, data: '/var/lib/mysql', environment: ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1'],
    arguments: ['mariadbd', ...mysqlOptions, ...mysqlTlsOptions('mariadb')],
    initialized: 'MariaDB init process done', ready: mysqlReady,
    databases: ['mariadb', '-uroot', '-e', 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools'],
    socket: '/run/mysqld/mysqld.sock',
    variables: ({ address, host, socket }) => {
      const mariadb = `mysql://root@${address}:3306`;
      return {
        ORM_TEST_MARIADB_DSN: `${mariadb}/orm_test`, ORM_TEST_MARIADB_SERVER_DSN: `${mariadb}/orm_test`, ORM_TOOLS_MARIADB_DSN: `${mariadb}/orm_tools`, ORM_TEST_MARIADB_LEASES: LEASES,
        ORM_TEST_MARIADB_TLS_DSN: mysqlTls('mariadb', host, 'ca'), ORM_TEST_MARIADB_TLS_OTHER_CA_DSN: mysqlTls('mariadb', host, 'other-ca'), ORM_TEST_MARIADB_TLS_MISMATCH_DSN: mysqlTls('mariadb', address, 'ca'),
        ORM_TEST_MARIADB_SOCKET: socket,
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
  const file = join(ROOT, 'config/containers.json');
  const reference = field(field(field(JSON.parse(readFileSync(file, 'utf8')), 'images'), kind), 'reference');
  if (typeof reference !== 'string' || !/@sha256:[0-9a-f]{64}$/.test(reference)) throw new TestServerError(`test-servers-container: ${file} pins no image of ${kind} by its digest`);
  return reference;
}

// container runs the container program and returns its standard output, or fails naming the command and its output.
function container(args: string[]): string {
  const ran = spawnSync(CONTAINER, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (ran.error) throw new TestServerError(`test-servers-container: ${CONTAINER}: ${ran.error.message}`);
  if (ran.status !== 0) throw new TestServerError(`test-servers-container: container ${args.join(' ')} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
  return ran.stdout;
}

// ours are the names of the containers of this script; a container of another name is never stopped or removed.
function ours(): string[] {
  const listed: unknown = JSON.parse(container(['list', '--all', '--format', 'json']));
  if (!Array.isArray(listed)) throw new TestServerError('test-servers-container: container list printed no list');
  return listed.map(entry => field(field(entry, 'configuration'), 'id')).filter((id): id is string => typeof id === 'string' && id.startsWith(PREFIX));
}

// address is the IPv4 address of the container on its network, without its prefix length.
function address(name: string): string {
  const inspected: unknown = JSON.parse(container(['inspect', name]));
  const networks = Array.isArray(inspected) ? field(field(inspected[0], 'status'), 'networks') : undefined;
  const ipv4 = Array.isArray(networks) ? field(networks[0], 'ipv4Address') : undefined;
  const text = (typeof ipv4 === 'string' ? ipv4 : '').split('/')[0] ?? '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(text)) throw new TestServerError(`test-servers-container: container inspect ${name} names no IPv4 address`);
  return text;
}

// run starts the container attached, in a new session, with its output appended to .runtime/containers/<kind>.log: the
// container program outlives this command, and its exit is the event that the container stopped, which a log follower of
// the container program does not report. The log is read on each change event of the file; each line is shown on stderr as
// "test-servers-container: <kind>: <line>". It resolves on the ready line after the line of the initialization, and fails
// when the container stops first, naming the log.
function run(kind: Kind, server: Server, args: string[]): Promise<void> {
  const log = join(DIR, `${kind}.log`);
  writeFileSync(log, '');
  const fd = openSync(log, 'a');
  const child = spawn(CONTAINER, args, { detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const reader = openSync(log, 'r');
  let offset = 0, pending = '', initialized = false, done = false;
  return new Promise((resolveReady, rejectReady) => {
    const finish = (error?: TestServerError) => {
      if (done) return;
      done = true;
      watcher.close();
      closeSync(reader);
      child.unref();
      if (error) rejectReady(error); else resolveReady();
    };
    const read = () => {
      if (done) return;
      const chunk = Buffer.alloc(65536);
      for (let n; (n = readSync(reader, chunk, 0, chunk.length, offset)) > 0; offset += n) pending += chunk.subarray(0, n).toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (done) return;
        process.stderr.write(`test-servers-container: ${kind}: ${line}\n`);
        if (line.includes(server.initialized)) initialized = true;
        else if (initialized && server.ready(line)) finish();
      }
    };
    const watcher = watch(log, read);
    child.on('error', error => finish(new TestServerError(`test-servers-container: ${CONTAINER}: ${error.message}`)));
    child.on('spawn', read);
    child.on('exit', (code, signal) => {
      read();
      finish(new TestServerError(`test-servers-container: the container of ${kind} stopped with ${code ?? signal} before it was ready; its log is ${log}`));
    });
  });
}

function writeEnvironment(file: string, variables: Record<string, string>): void {
  const lines = Object.entries(variables).map(([name, value]) => {
    if (/['\n\r]/.test(value)) throw new TestServerError(`test-servers-container: ${name} holds a quote or a newline: ${value}`);
    return `export ${name}='${value}'\n`;
  });
  writeFileSync(`${file}.tmp`, lines.join(''));
  renameSync(`${file}.tmp`, file);
}

async function start(kind: Kind): Promise<void> {
  const server = SERVERS[kind];
  const name = `${PREFIX}${kind}`;
  if (ours().includes(name)) throw new TestServerError(`test-servers-container: ${name} exists; run make orm-test-container-stop first`);
  mkdirSync(LEASES, { recursive: true });
  const env = join(DIR, `${kind}.env`);
  const socket = join(DIR, `${kind}.sock`);
  rmSync(env, { force: true });
  rmSync(socket, { force: true });
  const host = `${name}.container.test`;
  // The servers of the images read the key as another user than the one that writes it here; these keys sign test data only.
  const tls = tlsDir(kind);
  rmSync(tls, { recursive: true, force: true });
  issueTls(tls, [[kind, `DNS:${host}`]]);
  for (const file of [`${kind}-key.pem`, `${kind}-cert.pem`, 'ca.pem']) chmodSync(join(tls, file), 0o644);
  const started = run(kind, server, ['run', '--name', name, '--cpus', '4', '--memory', '4G', '--tmpfs', server.data, '--volume', `${tls}:${TLS_MOUNT}`,
    ...(server.socket ? ['--publish-socket', `${socket}:${server.socket}`] : []), '--env', `TZ=${SERVER_TIME_ZONE}`,
    ...server.environment.flatMap(setting => ['--env', setting]), image(kind), ...server.arguments]);
  try {
    await started;
    container(['exec', name, ...server.databases]);
    writeEnvironment(env, server.variables({ address: address(name), host, socket }));
  } catch (error) {
    console.error(`test-servers-container: start of ${kind} failed; run make orm-test-container-stop to remove ${name}`);
    throw error;
  }
  console.log(`test-servers-container: ${kind} in ${name}; its environment file is ${env}`);
}

function stop(): void {
  mkdirSync(LEASES, { recursive: true });
  holdExclusiveLease(LEASES);
  for (const name of ours()) {
    container(['stop', name]);
    container(['delete', name]);
    console.log(`test-servers-container: removed ${name}`);
  }
  for (const kind of KINDS) for (const file of [`${kind}.env`, `${kind}.sock`, `${kind}.log`, `tls-${kind}`]) rmSync(join(DIR, file), { recursive: true, force: true });
}

// pull pulls each pinned image; it is the only command that downloads.
function pull(): void {
  for (const kind of KINDS) {
    const ran = spawnSync(CONTAINER, ['image', 'pull', image(kind)], { stdio: 'inherit' });
    if (ran.status !== 0) throw new TestServerError(`test-servers-container: container image pull ${image(kind)} exited with ${ran.status ?? ran.signal}`);
  }
}

const [command, kind] = process.argv.slice(2);
try {
  if (command === 'start' && isKind(kind)) await start(kind);
  else if (command === 'stop' && kind === undefined) stop();
  else if (command === 'pull' && kind === undefined) pull();
  else throw new TestServerError('usage: test-servers-container.mts start <mysql|postgres|mariadb> | stop | pull', 2);
} catch (error) {
  if (!(error instanceof TestServerError)) throw error;
  if (error.message) console.error(error.message);
  process.exitCode = error.status;
}
