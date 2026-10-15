// Starts and stops the servers of the database checks under .runtime/servers: a MySQL 8.4 primary and its replica, a
// PostgreSQL 17 primary and its replica, a ProxySQL pooler in front of the MySQL primary, and a PgBouncer pooler in
// transaction mode in front of the PostgreSQL primary. The servers listen on 127.0.0.1 over TCP; the other endpoints are
// Unix sockets in the socket folder (socketPaths), which stop and the ProxySQL admin interface use.
//
//   test-servers.mts start | tls | stop | mysql-stop | mysql-start <mysql port> <mysql replica port>
//
// start chooses six free ports on 127.0.0.1 (scripts/free-ports.mts) for the servers of this checkout, so two checkouts
// never contend for one fixed port; a server owns its port from the moment it listens. The environment file records
// them, and a later start or tls of running servers reads them from it.
//
// start initializes the primaries and replicas, creates the databases orm_test and orm_tools, starts the poolers, and
// writes the environment file .runtime/servers/env last. Each run creates its own bench and decimal databases
// (scripts/check/databases.mts). When that file exists, start rewrites it for the running servers and changes nothing
// else. A failed start stops the servers it started and keeps the logs in .runtime/servers. stop stops the servers that
// start started and removes .runtime/servers.
//
// Each replica applies every change of its primary. The PostgreSQL primary names the replica in
// synchronous_standby_names with synchronous_commit=local, so a transaction that sets synchronous_commit=remote_apply and
// writes WAL commits after the replica has applied it, and the other transactions do not wait. A transaction that writes
// no WAL besides its commit record does not wait either.
//
// LEASE and STOP_PROCESS are the Go programs that the Makefile builds (tests/lease, tests/stop-process): Node has no
// cross-process lease and no exit event of a process that is not its child.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');

/** TestServerError is a failure of the servers script; its message is the whole report, and main prints it. */
export class TestServerError extends Error {
  readonly status: number;
  constructor(message: string, status = 1) { super(message); this.status = status; }
}

/** The paths of the servers of a checkout. */
export type Paths = ReturnType<typeof paths>;

// paths are the files of the servers of the checkout <root>. The socket folder holds the Unix sockets. A socket path
// must fit sun_path, and a path under a deep checkout does not, so the sockets live in /tmp, the directory POSIX defines
// for temporary files, in a folder named by the first 16 hex digits of the SHA-256 of the checkout path: unique to the
// checkout and the same on every run. Its file "checkout" names the checkout that owns it; start refuses a folder another checkout owns, and stop
// removes it. leases is the lease directory of the servers (tests/lease): a run that uses the servers holds a shared
// lease there (WITH_TEST_ENV of the Makefile reads the path from the environment file); stopping the servers, a fresh
// start and the MySQL migration hold the exclusive lease, which is refused while any lease is held, naming the holders.
export function paths(root: string, socketDir = `/tmp/orm-servers-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`) {
  const dir = join(root, '.runtime/servers');
  return {
    root, dir, socketDir,
    env: join(dir, 'env'),
    leases: join(root, '.runtime/servers.leases'),
    mysqlPid: join(dir, 'mysql.pid'),
    mysqlReplicaPid: join(dir, 'mysql-replica.pid'),
    postgresData: join(dir, 'postgres'),
    postgresReplicaData: join(dir, 'postgres-replica'),
    proxysqlData: join(dir, 'proxysql'),
    proxysqlPid: join(dir, 'proxysql.pid'),
    pgbouncerPid: join(dir, 'pgbouncer.pid'),
    sockets: {
      mysql: join(socketDir, 'mysql.sock'),
      mysqlReplica: join(socketDir, 'mysql-replica.sock'),
      proxysqlAdmin: join(socketDir, 'proxysql-admin.sock'),
      proxysqlAdminPgsql: join(socketDir, 'proxysql-admin-pgsql.sock'),
      proxysqlPgsql: join(socketDir, 'proxysql-pgsql.sock'),
    },
  };
}

/** The ports of the six servers. */
export type Ports = { mysql: number; postgres: number; mysqlReplica: number; postgresReplica: number; proxysql: number; pgbouncer: number };

// SOCKET_LIMITS is the longest Unix socket path of each platform: sun_path of sockaddr_un holds the path and its NUL.
const SOCKET_LIMITS: Partial<Record<NodeJS.Platform, [string, number]>> = { linux: ['Linux', 107], darwin: ['macOS', 103] };

// socketPathErrors checks each Unix socket path against the platform limit before a server starts. The sockets live in
// the socket folder, which does not depend on the depth of the checkout, so the check guards that declaration; a path
// over the limit fails with the path and the limit, never truncated.
export function socketPathErrors(sockets: Record<string, string>, platform: NodeJS.Platform = process.platform): string[] {
  const declared = SOCKET_LIMITS[platform];
  if (!declared) return [`test-servers: no Unix socket path limit is declared for ${platform}`];
  const [system, limit] = declared;
  return Object.values(sockets).flatMap(socket => {
    const bytes = Buffer.byteLength(socket);
    return bytes > limit ? [`test-servers: socket path ${socket} is ${bytes} bytes; ${system} allows at most ${limit}`] : [];
  }).slice(0, 1);
}

// MYSQLD_FILES is the secure_file_priv of every mysqld run. NULL turns file import and export off. Builds compile
// different defaults (NULL on Homebrew, /var/lib/mysql-files that the mysql-server package creates on Ubuntu), so it is
// stated to make the same server: mysqld does not start when that directory is missing.
const MYSQLD_FILES = '--secure-file-priv=NULL';
// MYSQL_LOWER_CASE is lower_case_table_names of the MySQL data directory. 1 is the one value both platforms accept (0
// needs a case-sensitive file system, 2 is not available on Linux). It is fixed when the data directory is initialized,
// so start moves the data when the directory holds another value (scripts/test-servers-mysql.mts).
export const MYSQL_LOWER_CASE = 1;
// MYSQLD_BINLOG is the binary log retention of both mysqld. The server removes expired logs only at start and when it
// rotates a log, so an expiry time (one hour) alone keeps a log that never reaches the default size (1 GB) to rotate.
// Rotating every 64 MiB makes the expiry take effect. The options apply when the next `make test-servers` starts the
// servers.
export const MYSQLD_BINLOG = ['--binlog-expire-logs-seconds=3600', '--max-binlog-size=67108864'];

// mysqldArguments are the arguments of the mysqld daemon of the primary (server id 1) or the replica (server id 2).
export function mysqldArguments(p: Paths, replica: boolean, port: number): string[] {
  const name = replica ? 'mysql-replica' : 'mysql';
  return ['--no-defaults', '--daemonize', MYSQLD_FILES, `--lower-case-table-names=${MYSQL_LOWER_CASE}`, `--datadir=${join(p.dir, name)}`,
    `--pid-file=${replica ? p.mysqlReplicaPid : p.mysqlPid}`, `--log-error=${join(p.dir, `${name}.log`)}`, '--bind-address=127.0.0.1',
    `--port=${port}`, `--socket=${replica ? p.sockets.mysqlReplica : p.sockets.mysql}`, '--mysqlx=OFF', ...MYSQLD_BINLOG,
    `--server-id=${replica ? 2 : 1}`, ...(replica ? ['--skip-replica-start'] : [])];
}

// environment is the environment file of the servers on <ports>. It is the one definition of every variable the checks
// read, including the server DSNs ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN, which name the servers
// without a pooler even where a check points ORM_TEST_*_DSN at one. The TLS DSNs name the host localhost., the fully
// qualified form of localhost, which resolves to 127.0.0.1 over TCP, because ssl-mode=VERIFY_IDENTITY checks a host
// name and the PHP driver connects to localhost through the Unix socket. ORM_RUN_* are the DSNs whose database
// scripts/check/databases.mts replaces with the databases of one run.
export function environment(p: Paths, ports: Ports): Record<string, string> {
  const mysql = `mysql://root@127.0.0.1:${ports.mysql}`;
  const postgres = `postgres://orm@127.0.0.1:${ports.postgres}`;
  const tls = (port: number, ca: string) => `mysql://root@localhost.:${port}/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${p.dir}/tls/${ca}.pem`;
  return {
    ORM_TEST_MYSQL_DSN: `${mysql}/orm_test`,
    ORM_TEST_POSTGRES_DSN: `${postgres}/orm_test?sslmode=disable`,
    ORM_TEST_MYSQL_SERVER_DSN: `${mysql}/orm_test`,
    ORM_TEST_POSTGRES_SERVER_DSN: `${postgres}/orm_test?sslmode=disable`,
    ORM_TEST_MYSQL_REPLICA_DSN: `mysql://root@127.0.0.1:${ports.mysqlReplica}/orm_test`,
    ORM_TEST_POSTGRES_REPLICA_DSN: `postgres://orm@127.0.0.1:${ports.postgresReplica}/orm_test?sslmode=disable`,
    ORM_TEST_PROXYSQL_DSN: `mysql://orm:orm@127.0.0.1:${ports.proxysql}/orm_test`,
    ORM_TEST_PGBOUNCER_DSN: `postgres://orm@127.0.0.1:${ports.pgbouncer}/orm_test?sslmode=disable`,
    ORM_TEST_PGBOUNCER_SINGLE_DSN: `postgres://orm@127.0.0.1:${ports.pgbouncer}/orm_test_single?sslmode=disable`,
    ORM_TOOLS_MYSQL_DSN: `${mysql}/orm_tools`,
    ORM_TOOLS_POSTGRES_DSN: `${postgres}/orm_tools?sslmode=disable`,
    ORM_RUN_MYSQL_DSN: `${mysql}/orm_run?timezone=%2B00:00`,
    ORM_RUN_POSTGRES_DSN: `${postgres}/orm_run?sslmode=disable&timezone=%2B00:00`,
    ORM_RUN_SQLITE_QUERY: '_pragma=busy_timeout(5000)&timezone=%2B00:00',
    ORM_TEST_SERVERS_LEASES: p.leases,
    ORM_TEST_MYSQL_TLS_DSN: tls(ports.mysql, 'ca'),
    ORM_TEST_MYSQL_TLS_OTHER_CA_DSN: tls(ports.mysql, 'other-ca'),
    ORM_TEST_MYSQL_TLS_MISMATCH_DSN: tls(ports.mysqlReplica, 'ca'),
  };
}

/** SERVER_VARIABLES are the names of the variables of the environment file, for the CI checks (scripts/repo/ci.mts). */
export const SERVER_VARIABLES = Object.keys(environment(paths('/'), { mysql: 1, postgres: 1, mysqlReplica: 1, postgresReplica: 1, proxysql: 1, pgbouncer: 1 }));

// writeEnvironment writes the environment file through a temporary file and a rename, so a reader never sees half of it.
function writeEnvironment(p: Paths, ports: Ports): void {
  const lines = Object.entries(environment(p, ports)).map(([name, value]) => {
    if (/['\n\r]/.test(value)) throw new TestServerError(`test-servers: ${name} holds a quote or a newline: ${value}`);
    return `export ${name}='${value}'\n`;
  });
  writeFileSync(`${p.env}.tmp`, lines.join(''));
  renameSync(`${p.env}.tmp`, p.env);
}

// environmentPorts reads the ports of the running servers from their environment file: start chose them when it
// started the servers, and writeEnvironment recorded them.
export function environmentPorts(text: string, file: string): Ports {
  const port = (name: string): number => {
    const match = new RegExp(`^export ${name}='[^@]*@127\\.0\\.0\\.1:(\\d+)/`, 'm').exec(text);
    if (!match) throw new TestServerError(`test-servers: ${file} records no port in ${name}; run make test-servers-stop and make test-servers, which rewrite it`);
    return checkedPort(match[1] ?? '');
  };
  return { mysql: port('ORM_TEST_MYSQL_SERVER_DSN'), postgres: port('ORM_TEST_POSTGRES_SERVER_DSN'), mysqlReplica: port('ORM_TEST_MYSQL_REPLICA_DSN'),
    postgresReplica: port('ORM_TEST_POSTGRES_REPLICA_DSN'), proxysql: port('ORM_TEST_PROXYSQL_DSN'), pgbouncer: port('ORM_TEST_PGBOUNCER_DSN') };
}

function checkedPort(text: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new TestServerError(`test-servers: invalid port '${text}'`, 2);
  return port;
}

// run runs a command, passing its output on, and fails naming it when it fails. input feeds its standard input.
function run(program: string, args: string[], options: SpawnSyncOptions = {}): void {
  const ran = spawnSync(program, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (ran.error) throw new TestServerError(`test-servers: ${program}: ${ran.error.message}`);
  if (ran.status !== 0) throw new TestServerError(`test-servers: ${program} ${args[0] ?? ''} exited with ${ran.status ?? ran.signal}`);
}

// program is the path of a program that the Makefile builds and passes in the environment.
function program(name: 'LEASE' | 'STOP_PROCESS'): string {
  const path = process.env[name];
  if (!path) throw new TestServerError(`test-servers: ${name} is unset; run this through make, which builds it`);
  return path;
}

// holdExclusive holds the exclusive lease of the servers until this process exits, or fails naming the holders of the
// leases that block it (the lease program prints them and exits with 3).
function holdExclusive(p: Paths): void {
  const held = spawnSync(program('LEASE'), ['hold', p.leases, 'exclusive', '--pid', String(process.pid)], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (held.status !== 0) throw new TestServerError('', held.status ?? 1);
}

const pidRunning = (file: string): boolean => {
  if (!existsSync(file)) return false;
  try { process.kill(Number(readFileSync(file, 'utf8').split('\n')[0]), 0); return true; } catch { return false; }
};
const postgresRunning = (data: string): boolean =>
  existsSync(join(data, 'postmaster.pid')) && spawnSync('pg_ctl', ['-D', data, 'status'], { stdio: 'ignore' }).status === 0;

// stopPid sends TERM, or <signal>, to the process whose id is the first line of the pid file and returns when the
// operating system reports that the process has exited, through STOP_PROCESS (kqueue NOTE_EXIT on macOS, a pidfd on
// Linux). Stopping is a long operation with no deadline, and the wait is that event, not polling.
export function stopPid(file: string, signal = 'TERM'): void {
  run(program('STOP_PROCESS'), [signal, readFileSync(file, 'utf8').split('\n')[0] ?? '']);
}

function stopMysql(p: Paths): void {
  // Through the server socket, shutdown returns after the server removes its pid file; through TCP it returns at once.
  for (const [pid, socket, name] of [[p.mysqlReplicaPid, p.sockets.mysqlReplica, 'the MySQL replica'], [p.mysqlPid, p.sockets.mysql, 'MySQL']] as const) {
    if (!pidRunning(pid)) continue;
    run('mysqladmin', ['--no-defaults', `--socket=${socket}`, '-u', 'root', 'shutdown']);
    console.log(`test-servers: stopped ${name}`);
  }
}

function stopServers(p: Paths): void {
  for (const [pid, name] of [[p.pgbouncerPid, 'PgBouncer'], [p.proxysqlPid, 'ProxySQL']] as const) {
    if (!pidRunning(pid)) continue;
    stopPid(pid);
    console.log(`test-servers: stopped ${name}`);
  }
  stopMysql(p);
  // INT is the fast shutdown of PostgreSQL. `pg_ctl stop -w` would wait at most 60 s (PGCTLTIMEOUT) and has no setting
  // without a limit.
  for (const [data, name] of [[p.postgresReplicaData, 'the PostgreSQL replica'], [p.postgresData, 'PostgreSQL']] as const) {
    if (!postgresRunning(data)) continue;
    stopPid(join(data, 'postmaster.pid'), 'INT');
    console.log(`test-servers: stopped ${name}`);
  }
}

const allRunning = (p: Paths): boolean => pidRunning(p.mysqlPid) && pidRunning(p.mysqlReplicaPid) && postgresRunning(p.postgresData) &&
  postgresRunning(p.postgresReplicaData) && pidRunning(p.proxysqlPid) && pidRunning(p.pgbouncerPid);

// socketDir makes the socket folder, owned by this user and naming this checkout. A folder left by this checkout is
// reused; one another checkout or user owns is refused.
function socketDir(p: Paths): void {
  if (existsSync(p.socketDir)) {
    const owner = existsSync(join(p.socketDir, 'checkout')) ? readFileSync(join(p.socketDir, 'checkout'), 'utf8').trim() : '';
    if (statSync(p.socketDir).uid !== userInfo().uid || owner !== p.root)
      throw new TestServerError(`test-servers: socket directory ${p.socketDir} belongs to ${owner || 'another user or checkout'}, not ${p.root}; remove it if no servers use it`);
    return;
  }
  mkdirSync(p.socketDir, { mode: 0o700 });
  writeFileSync(join(p.socketDir, 'checkout'), `${p.root}\n`);
}

function startMysql(p: Paths, ports: Pick<Ports, 'mysql' | 'mysqlReplica'>): void {
  const initialize = (name: string) => run('mysqld', ['--no-defaults', '--initialize-insecure', MYSQLD_FILES, `--lower-case-table-names=${MYSQL_LOWER_CASE}`,
    `--datadir=${join(p.dir, name)}`, `--log-error=${join(p.dir, `${name}-init.log`)}`]);
  initialize('mysql');
  // --daemonize returns after the server accepts connections or fails.
  run('mysqld', mysqldArguments(p, false, ports.mysql));
  console.log(`test-servers: MySQL on 127.0.0.1:${ports.mysql}`);
  // The replica starts before the primary holds data and reads the binary log of the primary from its first file, so
  // it applies every later change.
  initialize('mysql-replica');
  run('mysqld', mysqldArguments(p, true, ports.mysqlReplica));
  mysqlAt(ports.mysqlReplica, `CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1', SOURCE_PORT=${ports.mysql}, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1;
    START REPLICA; SET GLOBAL super_read_only = ON;`);
  console.log(`test-servers: MySQL replica on 127.0.0.1:${ports.mysqlReplica}`);
  writeFileSync(join(p.dir, 'mysql.settings'), `lower_case_table_names=${MYSQL_LOWER_CASE}\n`);
}

const mysqlAt = (port: number, sql: string, database: string[] = []): void =>
  run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', ...database, '-e', sql]);

// mysqlTimezones loads the time zone tables of the primary, which the replica applies from its binary log.
function mysqlTimezones(p: Paths, port: number): void {
  const tables = spawnSync('mysql_tzinfo_to_sql', ['/usr/share/zoneinfo'], { stdio: ['ignore', 'pipe', openSync(join(p.dir, 'mysql-tzinfo.log'), 'w')], maxBuffer: 1 << 30 });
  if (tables.status !== 0) throw new TestServerError(`test-servers: mysql_tzinfo_to_sql exited with ${tables.status ?? tables.signal}; see ${join(p.dir, 'mysql-tzinfo.log')}`);
  run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', 'mysql'], { stdio: ['pipe', 'inherit', 'inherit'], input: tables.stdout });
}

// startLogged runs a server in a new session (spawn's detached, setsid on POSIX: the server outlives the command that
// started it and several runs share it, so ending the process group of the starting command does not reach it), with
// its output appended to <dir>/<name>.log and its process id in <dir>/<name>.pid. Starting a server is a long operation:
// it has no deadline, and its result is an observed event. The log is read on each change event of the file; each line
// before the ready line is shown on stderr as "test-servers: <name>: <line>". It resolves when the server logs a line
// that contains <line>, and fails when the server exits first, naming the server and the last lines of its log.
export function startLogged(dir: string, name: string, line: string, command: string, args: string[]): Promise<void> {
  const log = join(dir, `${name}.log`);
  const fd = openSync(log, 'a');
  // The server's lines start at the size of the log before the server starts: read after the spawn, the size could
  // already hold its first lines, and a ready line written before it would never be read.
  let offset = statSync(log).size, pending = '', done = false;
  const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return new Promise((resolveStart, rejectStart) => {
    const reader = openSync(log, 'r');
    const finish = (error?: TestServerError) => {
      if (done) return;
      done = true;
      watcher.close();
      closeSync(reader);
      child.unref();
      if (error) rejectStart(error); else resolveStart();
    };
    const read = () => {
      if (done) return;
      const chunk = Buffer.alloc(65536);
      for (let n; (n = readSync(reader, chunk, 0, chunk.length, offset)) > 0; offset += n) pending += chunk.subarray(0, n).toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const text of lines) {
        if (done) return;
        process.stderr.write(`test-servers: ${name}: ${text}\n`);
        if (text.includes(line)) finish();
      }
    };
    const watcher = watch(log, read);
    child.on('error', error => finish(new TestServerError(`test-servers: ${name}: ${error.message}`)));
    child.on('spawn', () => { writeFileSync(join(dir, `${name}.pid`), `${child.pid}\n`); read(); });
    child.on('exit', () => {
      if (done) return;
      read();
      if (pending !== '') { const last = pending; pending = ''; process.stderr.write(`test-servers: ${name}: ${last}\n`); if (last.includes(line)) finish(); }
      const tail = readFileSync(log, 'utf8').split('\n').filter((text, index, all) => index < all.length - 1 || text !== '').slice(-20).join('\n');
      finish(new TestServerError(`test-servers: ${name} exited before it logged '${line}'; last lines of ${log}:\n${tail}`));
    });
  });
}

async function startPostgres(p: Paths, ports: Ports): Promise<void> {
  run('initdb', ['-D', p.postgresData, '-U', 'orm', '--auth=trust', '--encoding=UTF8', '--locale=C'], { stdio: ['ignore', openSync(join(p.dir, 'postgres-init.log'), 'w'), 'inherit'] });
  // `pg_ctl start -w` would wait at most 60 s; startLogged waits for the ready line.
  await startLogged(p.dir, 'postgres', 'database system is ready to accept connections', 'postgres', ['-D', p.postgresData, '-p', String(ports.postgres),
    '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'synchronous_standby_names=orm_replica', '-c', 'synchronous_commit=local']);
  console.log(`test-servers: PostgreSQL on 127.0.0.1:${ports.postgres}`);
  // -R writes the standby configuration with the application_name that synchronous_standby_names of the primary lists.
  run('pg_basebackup', ['-D', p.postgresReplicaData, '-R', '-X', 'stream', '-d', `host=127.0.0.1 port=${ports.postgres} user=orm application_name=orm_replica`]);
  // A standby logs that it accepts read-only connections.
  await startLogged(p.dir, 'postgres-replica', 'database system is ready to accept read-only connections', 'postgres', ['-D', p.postgresReplicaData,
    '-p', String(ports.postgresReplica), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=']);
  console.log(`test-servers: PostgreSQL replica on 127.0.0.1:${ports.postgresReplica}`);
}

// tls issues the TLS files of the MySQL servers once under <dir>/tls and loads them into both servers with ALTER
// INSTANCE RELOAD TLS, which keeps the running sessions: a test CA, a certificate of the primary that names localhost, a
// certificate of the replica, signed by the same CA, that names only orm-mismatch.invalid, so that a client that checks
// the host name refuses it, and a second CA that signed neither. The MySQL TLS cases of the clients connect with
// ssl-mode=VERIFY_IDENTITY (docs/config.md); their DSNs are in the environment file.
function tls(p: Paths, ports: Pick<Ports, 'mysql' | 'mysqlReplica'>): void {
  const dir = join(p.dir, 'tls');
  if (!existsSync(join(dir, 'other-ca.pem'))) {
    const tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const log = openSync(join(tmp, 'openssl.log'), 'a');
    const openssl = (args: string[]) => run('openssl', args, { stdio: ['ignore', 'inherit', log] });
    for (const ca of ['ca', 'other-ca'])
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', `/CN=orm test ${ca}`, '-keyout', join(tmp, `${ca}-key.pem`), '-out', join(tmp, `${ca}.pem`)]);
    for (const [name, san] of [['mysql', 'DNS:localhost'], ['mysql-replica', 'DNS:orm-mismatch.invalid']] as const) {
      openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=orm test ${name}`, '-keyout', join(tmp, `${name}-key.pem`), '-out', join(tmp, `${name}.csr`)]);
      writeFileSync(join(tmp, `${name}.ext`), `subjectAltName=${san}\n`);
      openssl(['x509', '-req', '-in', join(tmp, `${name}.csr`), '-CA', join(tmp, 'ca.pem'), '-CAkey', join(tmp, 'ca-key.pem'), '-CAcreateserial', '-days', '3650',
        '-extfile', join(tmp, `${name}.ext`), '-out', join(tmp, `${name}-cert.pem`)]);
    }
    closeSync(log);
    renameSync(tmp, dir);
  }
  for (const [name, port] of [['mysql', ports.mysql], ['mysql-replica', ports.mysqlReplica]] as const)
    mysqlAt(port, `SET GLOBAL ssl_ca = '${dir}/ca.pem'; SET GLOBAL ssl_cert = '${dir}/${name}-cert.pem'; SET GLOBAL ssl_key = '${dir}/${name}-key.pem'; ALTER INSTANCE RELOAD TLS;`);
  console.log(`test-servers: MySQL TLS from ${dir}`);
}

// startProxysql pools the connections of the user orm to the MySQL primary and multiplexes them over at most four server
// connections. The admin and PostgreSQL interfaces listen on Unix sockets only.
async function startProxysql(p: Paths, ports: Ports): Promise<void> {
  mysqlAt(ports.mysql, "CREATE USER 'orm'@'127.0.0.1' IDENTIFIED BY 'orm'; GRANT ALL ON *.* TO 'orm'@'127.0.0.1'");
  mkdirSync(p.proxysqlData, { recursive: true });
  writeFileSync(join(p.dir, 'proxysql.cnf'), `datadir="${p.proxysqlData}"
admin_variables=
{
  admin_credentials="admin:admin"
  mysql_ifaces="${p.sockets.proxysqlAdmin}"
  pgsql_ifaces="${p.sockets.proxysqlAdminPgsql}"
  restapi_enabled=false
  web_enabled=false
}
mysql_variables=
{
  interfaces="127.0.0.1:${ports.proxysql}"
  threads=2
  monitor_enabled=false
  server_version="8.4.0"
}
pgsql_variables=
{
  interfaces="${p.sockets.proxysqlPgsql}"
  monitor_enabled=false
}
mysql_servers=
(
  { address="127.0.0.1", port=${ports.mysql}, hostgroup=0, max_connections=4 }
)
mysql_users=
(
  { username="orm", password="orm", default_hostgroup=0 }
)
`);
  // ProxySQL logs the consulting notice after its listeners are bound.
  await startLogged(p.dir, 'proxysql', 'For consultancy visit', 'proxysql', ['--foreground', '--initial', '--no-version-check', '-c', join(p.dir, 'proxysql.cnf'), '-D', p.proxysqlData]);
  console.log(`test-servers: ProxySQL on 127.0.0.1:${ports.proxysql}`);
}

// startPgbouncer pools the connections to the PostgreSQL primary in transaction mode over at most four server
// connections per database. The database orm_test_single reaches orm_test through one server connection, so every client
// of it shares the same server session. PgBouncer keeps the protocol-level prepared statements of each client and sets
// the tracked parameters of the client, including statement_timeout sent as a startup parameter, on every server
// connection it assigns to the client.
async function startPgbouncer(p: Paths, ports: Ports): Promise<void> {
  writeFileSync(join(p.dir, 'pgbouncer-users.txt'), '"orm" ""\n');
  writeFileSync(join(p.dir, 'pgbouncer.ini'), `[databases]
orm_test_single = host=127.0.0.1 port=${ports.postgres} dbname=orm_test pool_size=1
* = host=127.0.0.1 port=${ports.postgres}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${ports.pgbouncer}
unix_socket_dir =
auth_type = trust
auth_file = ${p.dir}/pgbouncer-users.txt
pool_mode = transaction
default_pool_size = 4
max_client_conn = 500
max_prepared_statements = 200
track_extra_parameters = statement_timeout
`);
  // PgBouncer logs "process up" after it listens on its sockets.
  await startLogged(p.dir, 'pgbouncer', 'process up', 'pgbouncer', [join(p.dir, 'pgbouncer.ini')]);
  console.log(`test-servers: PgBouncer on 127.0.0.1:${ports.pgbouncer}`);
}

const TOOLS = ['mysqld', 'initdb', 'postgres', 'pg_ctl', 'pg_basebackup', 'proxysql', 'pgbouncer'];
const onPath = (tool: string): boolean => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', tool], { stdio: 'ignore' }).status === 0;

async function start(p: Paths): Promise<void> {
  if (existsSync(p.env)) {
    const ports = environmentPorts(readFileSync(p.env, 'utf8'), p.env);
    if (!allRunning(p)) throw new TestServerError(`test-servers: ${p.env} exists but a server is not running; run make test-servers-stop`);
    // The running servers keep their data; a MySQL setting that differs from the declared one moves the data into newly
    // initialized directories.
    run(process.execPath, [join(ROOT, 'scripts/test-servers-mysql.mts'), join(ROOT, 'scripts/test-servers.mts'), p.dir, String(ports.mysql), String(ports.mysqlReplica), String(MYSQL_LOWER_CASE)],
      { env: { ...process.env, LEASES: p.leases } });
    writeEnvironment(p, ports);
    console.log(`test-servers: running; environment ${p.env}`);
    process.stdout.write(readFileSync(p.env, 'utf8'));
    return;
  }
  if (existsSync(p.dir)) throw new TestServerError(`test-servers: ${p.dir} holds an incomplete start; run make test-servers-stop`);
  const [socketError] = socketPathErrors(p.sockets);
  if (socketError) throw new TestServerError(socketError);
  for (const tool of TOOLS)
    if (!onPath(tool)) throw new TestServerError(`test-servers: ${tool} is not installed; run make install-server-programs, or install it with the package manager of the machine`);
  if (!onPath('openssl')) throw new TestServerError('test-servers: openssl is not installed; run make install-server-programs, or install it with the package manager of the machine');
  const chosen = spawnSync(process.execPath, [join(ROOT, 'scripts/free-ports.mts'), '6'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const free = chosen.status === 0 ? chosen.stdout.trim().split(/\s+/).filter(Boolean) : [];
  if (free.length !== 6) throw new TestServerError(`test-servers: scripts/free-ports.mts chose ${free.length} ports, not 6; run node scripts/free-ports.mts 6 to see why`);
  const [mysql, postgres, mysqlReplica, postgresReplica, proxysql, pgbouncer] = free.map(checkedPort);
  if (mysql === undefined || postgres === undefined || mysqlReplica === undefined || postgresReplica === undefined || proxysql === undefined || pgbouncer === undefined) throw new TestServerError('test-servers: scripts/free-ports.mts chose fewer than 6 ports');
  const ports: Ports = { mysql, postgres, mysqlReplica, postgresReplica, proxysql, pgbouncer };
  holdExclusive(p);
  mkdirSync(p.dir, { recursive: true });
  socketDir(p);
  try {
    startMysql(p, ports);
    tls(p, ports);
    await startPostgres(p, ports);
    mysqlTimezones(p, ports.mysql);
    mysqlAt(ports.mysql, 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools');
    run('psql', ['-X', '-q', '-o', '/dev/null', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(ports.postgres), '-U', 'orm', 'postgres',
      '-c', 'CREATE DATABASE orm_test', '-c', 'CREATE DATABASE orm_tools'], { env: { ...process.env, PGTZ: 'UTC', PGOPTIONS: '-c client_min_messages=warning' } });
    await startProxysql(p, ports);
    await startPgbouncer(p, ports);
    writeEnvironment(p, ports);
  } catch (error) {
    console.error(`test-servers: start failed; logs are in ${p.dir}`);
    stopServers(p);
    throw error;
  }
  console.log(`test-servers: started; environment ${p.env}`);
}

const USAGE = 'usage: test-servers.mts start | tls | stop; run it through make test-servers, make test-servers-tls or make test-servers-stop';

export async function main(args: string[], p: Paths = paths(ROOT)): Promise<void> {
  const [action, ...rest] = args;
  const arity = (count: number) => { if (rest.length !== count) throw new TestServerError(USAGE, 2); };
  switch (action) {
    case 'start':
      arity(0);
      return start(p);
    case 'tls': {
      // tls loads the TLS files into the running servers, on the ports of their environment file.
      arity(0);
      if (!existsSync(p.env)) throw new TestServerError(`test-servers: ${p.env} is missing; run make test-servers, which starts the servers`);
      const ports = environmentPorts(readFileSync(p.env, 'utf8'), p.env);
      tls(p, ports);
      return writeEnvironment(p, ports);
    }
    case 'mysql-stop':
      // mysql-stop and mysql-start <mysql port> <mysql replica port> are the steps of the MySQL migration
      // (scripts/test-servers-mysql.mts): they stop the MySQL servers, and initialize and start them with the declared
      // settings.
      arity(0);
      return stopMysql(p);
    case 'mysql-start': {
      arity(2);
      const ports = { mysql: checkedPort(rest[0] ?? ''), mysqlReplica: checkedPort(rest[1] ?? '') };
      socketDir(p);
      startMysql(p, ports);
      tls(p, ports);
      return mysqlTimezones(p, ports.mysql);
    }
    case 'stop':
      arity(0);
      if (!existsSync(p.dir)) { console.log(`test-servers: no servers under ${p.dir}`); return; }
      holdExclusive(p);
      stopServers(p);
      rmSync(p.socketDir, { recursive: true, force: true });
      console.log(`test-servers: removed ${p.socketDir}`);
      rmSync(p.dir, { recursive: true, force: true });
      console.log(`test-servers: removed ${p.dir}`);
      return;
    default:
      throw new TestServerError(USAGE, 2);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof TestServerError)) throw error;
    if (error.message) console.error(error.message);
    process.exitCode = error.status;
  }
}
