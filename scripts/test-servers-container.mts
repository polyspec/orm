// test-servers-container starts one test database server, MySQL, PostgreSQL or MariaDB, in an Apple container from the
// image that config/containers.json pins by its digest, and writes the environment file of that one server. It is the
// container form of the servers of scripts/test-servers.mts: the server takes the settings of the native primary
// (time zone, lower-case table names, binary log retention, InnoDB log space, and for PostgreSQL its WAL and its
// synchronous standby), and its data lives on a tmpfs of the container, so removing the container removes the data and no
// volume is left. MySQL and PostgreSQL have a replica in a second container, polyspec-orm-test-<checkout>-<kind>-replica,
// as the native primaries have: the MySQL replica reads the binary log of the primary from its first file, which the
// primary resets after its image initialized it, and the PostgreSQL replica is a pg_basebackup of the primary that streams
// through the physical replication slot orm_replica. Both follow the primary before it creates the databases of the checks.
//
//   node scripts/test-servers-container.mts start <mysql|postgres|mariadb>
//   node scripts/test-servers-container.mts run <mysql|postgres|mariadb> -- <command> [argument...]
//   node scripts/test-servers-container.mts stop
//   node scripts/test-servers-container.mts pull
//
// CONTAINER_PROGRAM names the container program; make passes it. A container belongs to the checkout that started it:
// its name is polyspec-orm-test-<checkout>-<kind>, where <checkout> is the first 12 hexadecimal digits of the sha256 of
// the root of the checkout, so two checkouts run their servers at once, and stop removes only the containers of its own
// checkout; a container of another name is never stopped or removed (T444). Each kind runs at most once in a checkout,
// and kinds may run together: start refuses a kind whose container exists, and a start that fails removes the container
// of its kind. run starts the server of a kind, runs the command with the variables of the server, and removes that
// container when the command ends or fails, or when the run gets SIGINT or SIGTERM, which it forwards to the command.
//
// The environment file is .runtime/containers/<kind>.env; the MySQL and PostgreSQL files have the variables of the
// primary of TEST_ENV, the MariaDB file those of the primary of MARIADB_ENV. The DSNs name the address of the container
// on its network, which the container runtime assigns, and the port of the server in the container. The server has TLS
// with a certificate that issueTls of scripts/test-servers.mts issues for each start under .runtime/containers/tls-<kind>:
// it names the host name of the container, <name>.container.test, so the TLS DSN connects to that name, the DSN with the
// second CA fails the chain, and the mismatch DSN connects to the address, which the certificate does not name. The Unix
// socket of MySQL and MariaDB is published at .runtime/containers/<kind>.sock. The replica DSN names the address of the
// replica container. MariaDB has no replica, as the native MariaDB server has none, and no pooler is started, so their
// variables are absent and a check that reads them fails, naming the variable.
//
// Waiting for a server is a long operation without a time limit: start reads the output of the attached container on each
// change of its log file and resolves on the ready line that the server logs after its image finished its
// initialization, and fails when the container stops first.
// stop holds the exclusive lease of the servers of the checkout, then stops and removes each container of the checkout.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { holdExclusiveLease, issueTls, SERVER_TIME_ZONE, MYSQLD_BINLOG, MYSQLD_STORAGE, MYSQL_LOWER_CASE, POSTGRES_WAL, TestServerError } from './test-servers.mts';

const REPOSITORY = resolve(import.meta.dirname, '..');
const PREFIX = 'polyspec-orm-test-';
// TLS_MOUNT is the folder of the TLS files in the container.
const TLS_MOUNT = '/etc/orm-tls';
// POSTGRES_KEY is the copy of the key of the PostgreSQL server in the container, outside its data directory.
const POSTGRES_KEY = '/var/lib/postgresql/orm-tls-key.pem';

type Kind = 'mysql' | 'postgres' | 'mariadb';

// Context is the checkout whose servers a command starts or removes, and the container program that it runs.
export interface Context { root: string; program: string }

// Folders are the files of the servers of a checkout: .runtime/containers and its leases.
interface Folders { dir: string; leases: string }

function folders(root: string): Folders {
  const dir = join(root, '.runtime/containers');
  return { dir, leases: join(dir, 'leases') };
}

// tlsDir is the folder of the TLS files of the server of kind on the host.
const tlsDir = (dir: string, kind: Kind) => join(dir, `tls-${kind}`);

// Marks are the log lines that start waits for: initialized is the log line of the image after its initialization, and
// ready is the first line after it that names a server that accepts connections on its port.
interface Marks {
  initialized: string;
  ready: (line: string) => boolean;
}

// Replica is the replica of a primary in a container of its own. prepare runs in the primary after it is ready and before
// the replica starts; arguments are the arguments of the replica container after its image, for the address of the
// primary; follow, when the replica needs it, runs in the replica after it is ready and before the primary creates the
// databases.
interface Replica extends Marks {
  prepare: string[];
  arguments: (primary: string) => string[];
  follow?: (primary: string) => string[];
}

interface Server extends Marks {
  // port is the port of the server in the container.
  port: number;
  // data is the data directory of the image, which a tmpfs replaces.
  data: string;
  environment: string[];
  arguments: string[];
  replica?: Replica;
  // databases runs in the container and creates the databases of the checks.
  databases: string[];
  // socket is the Unix socket of the server in the container, which start publishes on the host.
  socket?: string;
  variables: (server: Endpoint) => Record<string, string>;
}

// Endpoint is where the checks reach a started server: its address, its host name, which its certificate names, the
// host path of its published socket, the folders of its checkout, and the address of its replica, which a kind without a
// replica has not.
interface Endpoint { address: string; host: string; socket: string; folders: Folders; replica?: string }

// started is the address of the replica of kind, which start sets for each kind that has a replica.
function started(replica: string | undefined, kind: Kind): string {
  if (replica === undefined) throw new TestServerError(`test-servers-container: the replica of ${kind} has no address`);
  return replica;
}

const mysqlTls = (tls: string, host: string, ca: string) => `mysql://root@${host}:3306/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${tls}/${ca}.pem`;
const postgresTls = (tls: string, host: string, ca: string) => `postgres://orm@${host}:5432/orm_test?sslmode=verify-full&sslrootcert=${tls}/${ca}.pem`;
const mysqlTlsOptions = (kind: Kind) => [`--ssl-ca=${TLS_MOUNT}/ca.pem`, `--ssl-cert=${TLS_MOUNT}/${kind}-cert.pem`, `--ssl-key=${TLS_MOUNT}/${kind}-key.pem`];

// The MySQL and the MariaDB server take the options of the native primary (scripts/test-servers.mts). The temporary
// server of the image initialization listens on port 0, so the ready line of the server names port 3306.
const mysqlOptions = ['--secure-file-priv=NULL', `--lower-case-table-names=${MYSQL_LOWER_CASE}`, ...MYSQLD_BINLOG, ...MYSQLD_STORAGE];
const mysqlArguments = (serverId: number) => ['mysqld', '--mysqlx=OFF', ...mysqlOptions, `--server-id=${serverId}`, ...mysqlTlsOptions('mysql')];

// The PostgreSQL servers take the settings of postgresArguments of scripts/test-servers.mts; the primary names the replica
// as its synchronous standby with synchronous_commit=local, so only a transaction that asks for remote_apply waits for it.
// PostgreSQL refuses a key that another user than its own can read, so the key is copied for the user postgres first.
const postgresKey = `install -m 0600 -o postgres -g postgres ${TLS_MOUNT}/postgres-key.pem ${POSTGRES_KEY}`;
const postgresSettings = ['-c', `timezone=${SERVER_TIME_ZONE}`, '-c', 'ssl=on', '-c', `ssl_cert_file=${TLS_MOUNT}/postgres-cert.pem`, '-c', `ssl_key_file=${POSTGRES_KEY}`,
  ...POSTGRES_WAL.flatMap(setting => ['-c', setting])];
const mysqlReady = (line: string) => line.includes('ready for connections') && line.includes('port: 3306');

const SERVERS: Record<Kind, Server> = {
  mysql: {
    port: 3306, data: '/var/lib/mysql', environment: ['MYSQL_ALLOW_EMPTY_PASSWORD=yes'],
    arguments: mysqlArguments(1),
    initialized: 'MySQL init process done', ready: mysqlReady,
    // The replica reads the binary log of the primary from its first file, which the reset leaves empty, so it applies
    // every change after the initialization of the image and none of the image, which initialized the replica as well.
    replica: {
      initialized: 'MySQL init process done', ready: mysqlReady,
      prepare: ['mysql', '-uroot', '-e', 'RESET BINARY LOGS AND GTIDS'],
      arguments: () => [...mysqlArguments(2), '--skip-replica-start'],
      follow: primary => ['mysql', '-uroot', '-e',
        `CHANGE REPLICATION SOURCE TO SOURCE_HOST='${primary}', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1; START REPLICA; SET GLOBAL super_read_only = ON`],
    },
    databases: ['mysql', '-uroot', '-e', 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools'],
    socket: '/var/run/mysqld/mysqld.sock',
    variables: ({ address, host, socket, folders: { dir, leases }, replica }) => {
      const mysql = `mysql://root@${address}:3306`;
      const tls = tlsDir(dir, 'mysql');
      return {
        ORM_TEST_MYSQL_DSN: `${mysql}/orm_test`, ORM_TEST_MYSQL_SERVER_DSN: `${mysql}/orm_test`, ORM_TOOLS_MYSQL_DSN: `${mysql}/orm_tools`,
        ORM_RUN_MYSQL_DSN: `${mysql}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: leases,
        ORM_TEST_MYSQL_TLS_DSN: mysqlTls(tls, host, 'ca'), ORM_TEST_MYSQL_TLS_OTHER_CA_DSN: mysqlTls(tls, host, 'other-ca'), ORM_TEST_MYSQL_TLS_MISMATCH_DSN: mysqlTls(tls, address, 'ca'),
        ORM_TEST_MYSQL_SOCKET: socket, ORM_TEST_MYSQL_REPLICA_DSN: `mysql://root@${started(replica, 'mysql')}:3306/orm_test`,
      };
    },
  },
  postgres: {
    port: 5432, data: '/var/lib/postgresql/data',
    environment: ['POSTGRES_USER=orm', 'POSTGRES_HOST_AUTH_METHOD=trust', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C'],
    arguments: ['sh', '-c', `${postgresKey} && exec docker-entrypoint.sh "$@"`, 'sh',
      'postgres', ...postgresSettings, '-c', 'synchronous_standby_names=orm_replica', '-c', 'synchronous_commit=local'],
    initialized: 'PostgreSQL init process complete', ready: line => line.includes('database system is ready to accept connections'),
    // The rules of the image let every host connect to every database, which does not cover replication, so prepare lets
    // the role orm replicate. The replica is a pg_basebackup of the primary into the empty data directory, and the image
    // skips its initialization for that directory; -R writes the standby configuration with the application_name that
    // synchronous_standby_names lists, and -C -S creates the slot orm_replica, as postgresBaseBackupArguments does.
    replica: {
      initialized: 'Skipping initialization', ready: line => line.includes('database system is ready to accept read-only connections'),
      prepare: ['sh', '-c', `echo 'host replication orm all trust' >> "$PGDATA/pg_hba.conf" && psql -X -q -t -U orm -d postgres -c 'SELECT pg_reload_conf()'`],
      arguments: primary => ['sh', '-c', `${postgresKey} && chown postgres:postgres "$PGDATA" && chmod 0700 "$PGDATA" && gosu postgres pg_basebackup -D "$PGDATA" -R -C -S orm_replica -X stream -d 'host=${primary} port=5432 user=orm application_name=orm_replica' && exec docker-entrypoint.sh "$@"`, 'sh',
        'postgres', ...postgresSettings],
    },
    databases: ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'orm', '-d', 'postgres', '-c', 'CREATE DATABASE orm_test', '-c', 'CREATE DATABASE orm_tools'],
    variables: ({ address, host, folders: { dir, leases }, replica }) => {
      const postgres = `postgres://orm@${address}:5432`;
      const tls = tlsDir(dir, 'postgres');
      return {
        ORM_TEST_POSTGRES_DSN: `${postgres}/orm_test`, ORM_TEST_POSTGRES_SERVER_DSN: `${postgres}/orm_test`, ORM_TOOLS_POSTGRES_DSN: `${postgres}/orm_tools`,
        ORM_RUN_POSTGRES_DSN: `${postgres}/orm_run?timezone=%2B00:00`, ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00', ORM_TEST_SERVERS_LEASES: leases,
        ORM_TEST_POSTGRES_TLS_DSN: postgresTls(tls, host, 'ca'), ORM_TEST_POSTGRES_TLS_OTHER_CA_DSN: postgresTls(tls, host, 'other-ca'), ORM_TEST_POSTGRES_TLS_MISMATCH_DSN: postgresTls(tls, address, 'ca'),
        ORM_TEST_POSTGRES_REPLICA_DSN: `postgres://orm@${started(replica, 'postgres')}:5432/orm_test`,
      };
    },
  },
  mariadb: {
    port: 3306, data: '/var/lib/mysql', environment: ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1'],
    arguments: ['mariadbd', ...mysqlOptions, '--server-id=1', ...mysqlTlsOptions('mariadb')],
    initialized: 'MariaDB init process done', ready: mysqlReady,
    databases: ['mariadb', '-uroot', '-e', 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools'],
    socket: '/run/mysqld/mysqld.sock',
    variables: ({ address, host, socket, folders: { dir, leases } }) => {
      const mariadb = `mysql://root@${address}:3306`;
      const tls = tlsDir(dir, 'mariadb');
      return {
        ORM_TEST_MARIADB_DSN: `${mariadb}/orm_test`, ORM_TEST_MARIADB_SERVER_DSN: `${mariadb}/orm_test`, ORM_TOOLS_MARIADB_DSN: `${mariadb}/orm_tools`, ORM_TEST_MARIADB_LEASES: leases,
        ORM_TEST_MARIADB_TLS_DSN: mysqlTls(tls, host, 'ca'), ORM_TEST_MARIADB_TLS_OTHER_CA_DSN: mysqlTls(tls, host, 'other-ca'), ORM_TEST_MARIADB_TLS_MISMATCH_DSN: mysqlTls(tls, address, 'ca'),
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
  const file = join(REPOSITORY, 'config/containers.json');
  const reference = field(field(field(JSON.parse(readFileSync(file, 'utf8')), 'images'), kind), 'reference');
  if (typeof reference !== 'string' || !/@sha256:[0-9a-f]{64}$/.test(reference)) throw new TestServerError(`test-servers-container: ${file} pins no image of ${kind} by its digest`);
  return reference;
}

// checkout is the identifier of a checkout in the names of its containers: the first 12 hexadecimal digits of the sha256
// of its root.
function checkout(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

// containerName is the name of the container of a kind that the checkout at root starts; its replica is that name with
// the suffix -replica.
export function containerName(root: string, kind: Kind): string {
  return `${PREFIX}${checkout(root)}-${kind}`;
}

const replicaName = (root: string, kind: Kind) => `${containerName(root, kind)}-replica`;

// container runs the container program and returns its standard output, or fails naming the command and its output.
function container(program: string, args: string[]): string {
  const ran = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (ran.error) throw new TestServerError(`test-servers-container: ${program}: ${ran.error.message}`);
  if (ran.status !== 0) throw new TestServerError(`test-servers-container: container ${args.join(' ')} exited with ${ran.status ?? ran.signal}:\n${ran.stderr}${ran.stdout}`);
  return ran.stdout;
}

// ours are the names of the containers of the checkout; a container of another name is never stopped or removed.
function ours({ root, program }: Context): string[] {
  const listed: unknown = JSON.parse(container(program, ['list', '--all', '--format', 'json']));
  if (!Array.isArray(listed)) throw new TestServerError('test-servers-container: container list printed no list');
  const prefix = `${PREFIX}${checkout(root)}-`;
  return listed.map(entry => field(field(entry, 'configuration'), 'id')).filter((id): id is string => typeof id === 'string' && id.startsWith(prefix));
}

// address is the IPv4 address of the container on its network, without its prefix length.
function address(program: string, name: string): string {
  const inspected: unknown = JSON.parse(container(program, ['inspect', name]));
  const networks = Array.isArray(inspected) ? field(field(inspected[0], 'status'), 'networks') : undefined;
  const ipv4 = Array.isArray(networks) ? field(networks[0], 'ipv4Address') : undefined;
  const text = (typeof ipv4 === 'string' ? ipv4 : '').split('/')[0] ?? '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(text)) throw new TestServerError(`test-servers-container: container inspect ${name} names no IPv4 address`);
  return text;
}

// launch starts the container attached, in a new session, with its output appended to .runtime/containers/<label>.log: the
// container program outlives this command, and its exit is the event that the container stopped, which a log follower of
// the container program does not report. The log is read on each change event of the file; each line is shown on stderr as
// "test-servers-container: <label>: <line>". It resolves on the ready line after the line of the initialization, and fails
// when the container stops first, naming the log.
function launch(context: Context, label: string, server: Marks, args: string[]): Promise<void> {
  const log = join(folders(context.root).dir, `${label}.log`);
  writeFileSync(log, '');
  const fd = openSync(log, 'a');
  const child = spawn(context.program, args, { detached: true, stdio: ['ignore', fd, fd] });
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
        process.stderr.write(`test-servers-container: ${label}: ${line}\n`);
        if (line.includes(server.initialized)) initialized = true;
        else if (initialized && server.ready(line)) finish();
      }
    };
    // libuv watches the file through kqueue in one-shot mode: it submits the watch in the poll phase of the loop and submits
    // it again after each event callback, and kqueue reports only the writes that follow a submission. A write before the
    // first submission or during a callback sends no event, so every read runs from setImmediate, in the check phase after
    // the submission, and reads those writes; every later write sends an event.
    const watcher = watch(log, () => setImmediate(read));
    setImmediate(read);
    child.on('error', error => finish(new TestServerError(`test-servers-container: ${context.program}: ${error.message}`)));
    child.on('exit', (code, signal) => {
      read();
      finish(new TestServerError(`test-servers-container: the container of ${label} stopped with ${code ?? signal} before it was ready; its log is ${log}`));
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

// start starts the server of a kind for the checkout of context, writes its environment file, and returns its variables.
// A start that fails after the container was started removes the container of its kind.
export async function start(kind: Kind, context: Context): Promise<Record<string, string>> {
  const server = SERVERS[kind];
  const name = containerName(context.root, kind);
  for (const each of [name, replicaName(context.root, kind)])
    if (ours(context).includes(each)) throw new TestServerError(`test-servers-container: ${each} exists; run make orm-test-container-stop first`);
  const dirs = folders(context.root);
  mkdirSync(dirs.leases, { recursive: true });
  const env = join(dirs.dir, `${kind}.env`);
  const socket = join(dirs.dir, `${kind}.sock`);
  rmSync(env, { force: true });
  rmSync(socket, { force: true });
  const host = `${name}.container.test`;
  // The servers of the images read the key as another user than the one that writes it here; these keys sign test data only.
  const tls = tlsDir(dirs.dir, kind);
  rmSync(tls, { recursive: true, force: true });
  issueTls(tls, [[kind, `DNS:${host}`]]);
  for (const file of [`${kind}-key.pem`, `${kind}-cert.pem`, 'ca.pem']) chmodSync(join(tls, file), 0o644);
  const options = (container: string) => ['run', '--name', container, '--cpus', '4', '--memory', '4G', '--tmpfs', server.data, '--volume', `${tls}:${TLS_MOUNT}`,
    '--env', `TZ=${SERVER_TIME_ZONE}`, ...server.environment.flatMap(setting => ['--env', setting])];
  const started = launch(context, kind, server, [...options(name), ...(server.socket ? ['--publish-socket', `${socket}:${server.socket}`] : []), image(kind), ...server.arguments]);
  try {
    await started;
    const primary = address(context.program, name);
    let replica: string | undefined;
    if (server.replica) {
      const replicaContainer = replicaName(context.root, kind);
      container(context.program, ['exec', name, ...server.replica.prepare]);
      await launch(context, `${kind}-replica`, server.replica, [...options(replicaContainer), image(kind), ...server.replica.arguments(primary)]);
      replica = address(context.program, replicaContainer);
      if (server.replica.follow) container(context.program, ['exec', replicaContainer, ...server.replica.follow(primary)]);
    }
    container(context.program, ['exec', name, ...server.databases]);
    const variables = server.variables({ address: primary, host, socket, folders: dirs, ...(replica === undefined ? {} : { replica }) });
    writeEnvironment(env, variables);
    return variables;
  } catch (error) {
    console.error(`test-servers-container: start of ${kind} failed; removing ${name}`);
    remove(context, kind);
    throw error;
  }
}

// remove stops and removes the containers of the checkout of context, or the container of kind alone, and the files of
// their servers.
export function remove(context: Context, kind?: Kind): void {
  const { dir } = folders(context.root);
  const kinds = kind === undefined ? KINDS : [kind];
  const names = new Set(kinds.flatMap(each => [replicaName(context.root, each), containerName(context.root, each)]));
  for (const name of ours(context).filter(each => names.has(each))) {
    container(context.program, ['stop', name]);
    container(context.program, ['delete', name]);
    console.error(`test-servers-container: removed ${name}`);
  }
  for (const each of kinds) for (const file of [`${each}.env`, `${each}.sock`, `${each}.log`, `${each}-replica.log`, `tls-${each}`]) rmSync(join(dir, file), { recursive: true, force: true });
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

// run starts the server of a kind, runs the command with the variables of the server, and removes that container when
// the command ends or fails, or when the run gets SIGINT or SIGTERM, which it forwards to the command. A signal that
// comes while the server starts ends the run once the start ends, without the command.
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
  try {
    const variables = await start(kind, context);
    if (received !== undefined) return { code: null, signal: received };
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
    remove(context, kind);
  }
}

// pull pulls each pinned image; it is the only command that downloads.
function pull(program: string): void {
  for (const kind of KINDS) {
    const ran = spawnSync(program, ['image', 'pull', image(kind)], { stdio: 'inherit' });
    if (ran.status !== 0) throw new TestServerError(`test-servers-container: container image pull ${image(kind)} exited with ${ran.status ?? ran.signal}`);
  }
}

// containerProgram is the container program that make names in CONTAINER_PROGRAM.
function containerProgram(): string {
  const program = process.env['CONTAINER_PROGRAM'];
  if (!program) throw new TestServerError('test-servers-container: CONTAINER_PROGRAM is unset; run this through make, which names the container program');
  return program;
}

// exitCode is the exit code of a run whose command ended: its code, or 128 and the number of the signal that ended it.
function exitCode({ code, signal }: Ended): number {
  if (code !== null) return code;
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

if (import.meta.main) {
  const [command, kind, separator, ...rest] = process.argv.slice(2);
  try {
    const context: Context = { root: REPOSITORY, program: containerProgram() };
    const { dir, leases } = folders(REPOSITORY);
    if (command === 'start' && isKind(kind) && separator === undefined) {
      await start(kind, context);
      console.log(`test-servers-container: ${kind} in ${containerName(REPOSITORY, kind)}; its environment file is ${join(dir, `${kind}.env`)}`);
    } else if (command === 'run' && isKind(kind) && separator === '--' && rest.length > 0) process.exitCode = exitCode(await run(kind, rest, context));
    else if (command === 'stop' && kind === undefined) {
      mkdirSync(leases, { recursive: true });
      holdExclusiveLease(leases);
      remove(context);
    } else if (command === 'pull' && kind === undefined) pull(context.program);
    else throw new TestServerError('usage: test-servers-container.mts start <mysql|postgres|mariadb> | run <mysql|postgres|mariadb> -- <command> [argument...] | stop | pull', 2);
  } catch (error) {
    if (!(error instanceof TestServerError)) throw error;
    if (error.message) console.error(error.message);
    process.exitCode = error.status;
  }
}
