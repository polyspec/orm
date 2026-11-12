// test-servers-mariadb starts and stops the MariaDB servers of the database checks, a primary, its replica, the privilege probe
// server and a ProxySQL in front of the primary, for
// `test-servers.mts mariadb-start` (make orm-test-mariadb) and the stop of test-servers.mts. MariaDB is a server of the mysql
// dialect (DIA-200): the clients reach it with mysql:// DSNs, and the recipes run their cases on it as the database mariadb
// (FCV-3). Its servers are their own set, apart from the MySQL and PostgreSQL servers of `start`, since the CI runner installs
// either the MySQL or the MariaDB packages, which conflict, and a CI group of MariaDB starts only these: they have their own
// data directories under .runtime/servers, their own four free ports, their own lease directory and the environment file
// .runtime/servers/mariadb.env, which WITH_MARIADB_ENV of the Makefile reads.
//
// The servers are a release of MARIADB_SERIES (scripts/mariadb-build.mts) and are started from the programs on PATH: the Makefile
// puts the bin folder of the local build first, and on the CI runner they are the programs of the Ubuntu packages. They take the
// settings of the MySQL servers wherever MariaDB has them: lower_case_table_names=1, the server zone Asia/Seoul, binary logging
// with trust-function-creators on, the time zone tables, the users orm and the TLS files, so a case meets the same server
// state on both; each setting MariaDB names otherwise is stated where it is set.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARIADB_SERIES, MARIADB_SERIES_LINE, MARIADB_VERSION } from './mariadb-build.mts';
import {
  checkedPort, holdExclusiveLease, issueTls, MYSQL_LOWER_CASE, proxysqlConfigOf, MYSQL_TLS_MISMATCH_HOST, MYSQL_TLS_SERVER_NAMES, mysqlEnvironment, ORM_ACCOUNTS_SQL,
  type Paths, pidRunning, run, shutdownError, socketDir, startLogged, stopServerProcess, TestServerError,
} from './test-servers.mts';

/** The ports of the MariaDB primary, its replica, the privilege probe server and the ProxySQL of the primary. */
export type MariadbPorts = { mariadb: number; mariadbReplica: number; mariadbPrivilege: number; proxysql: number };

// MARIADB_TOOLS are the programs that start and set up the servers, which stop by their process (stopServerProcess); a missing one
// fails the start by name.
const MARIADB_TOOLS = ['mariadbd', 'mariadb-install-db', 'mariadb', 'mariadb-tzinfo-to-sql', 'openssl', 'proxysql'];

// MARIADBD_BINLOG is the binary log of both servers, as MYSQLD_BINLOG states it for MySQL; MariaDB logs only with --log-bin.
export const MARIADBD_BINLOG = ['--log-bin=binlog', '--binlog-expire-logs-seconds=3600', '--max-binlog-size=16777216', '--log-bin-trust-function-creators=ON'];
// MARIADBD_PRIVILEGE_BINLOG is the binary log of the privilege probe server, with trust-function-creators off, as
// MYSQLD_PRIVILEGE_BINLOG states it for the MySQL privilege probe server: a writable server of its own, so the setting never
// changes the primary or the replica.
export const MARIADBD_PRIVILEGE_BINLOG = ['--log-bin=binlog', '--binlog-expire-logs-seconds=3600', '--max-binlog-size=16777216', '--log-bin-trust-function-creators=OFF'];

// MARIADBD_REPLICA is the replica of the primary: started without its replication, which the start sets up, read-only, and
// applying with the 4 parallel workers that MySQL 8.4 uses by default (replica_parallel_workers), where MariaDB applies serially
// (slave_parallel_threads=0), so the replica keeps up with the same primary load as the MySQL replica.
export const MARIADBD_REPLICA = ['--skip-slave-start', '--read-only=ON', '--slave-parallel-threads=4'];

/** The role of one mariadbd of the set. */
export type MariadbRole = 'primary' | 'replica' | 'privilege';

// MARIADB_SERVERS are the name (of the data folder, the log and the pid file) and the server id of each role.
export const MARIADB_SERVERS: Record<MariadbRole, { name: string; id: number }> = {
  primary: { name: 'mariadb', id: 1 }, replica: { name: 'mariadb-replica', id: 2 }, privilege: { name: 'mariadb-privilege', id: 3 },
};
// MARIADBD_PERFORMANCE_SCHEMA is the Performance Schema of MySQL 8.4 by default, which MariaDB turns off: the schema on, the
// transaction instrument and the consumer of the current transaction events, and the instrument of the metadata locks, which
// the cases read on both servers (the threads of a session, its prepared statements, its transactions and the tables that its
// transaction holds).
export const MARIADBD_PERFORMANCE_SCHEMA = ['--performance-schema=ON', '--performance-schema-instrument=transaction=ON',
  '--performance-schema-consumer-events-transactions-current=ON', '--performance-schema-instrument=wait/lock/metadata/sql/mdl=ON'];
// MARIADBD_MYSQL_DEFAULTS are the defaults of MySQL 8.4 that MariaDB sets otherwise and that the cases meet: the 1 MiB thread
// stack, which a deeply nested statement needs (MariaDB's 292 KiB stack refuses it with 1436), and the event scheduler, on in
// MySQL and off in MariaDB, which runs the events a case creates.
export const MARIADBD_MYSQL_DEFAULTS = ['--thread-stack=1048576', '--event-scheduler=ON'];
// MARIADBD_STORAGE bounds the InnoDB redo log, which MariaDB sizes with innodb_log_file_size (MySQL: innodb_redo_log_capacity),
// and the undo tablespaces, as MYSQLD_STORAGE does.
export const MARIADBD_STORAGE = ['--innodb-log-file-size=16777216', '--innodb-max-undo-log-size=16777216'];

// mariadbdArguments are the arguments of the mariadbd of <role> (MARIADB_SERVERS). The server logs
// to its standard error, which startLogged keeps in <name>.log and reads for the ready line. secure_file_priv names a folder of its
// own that is never written, since MariaDB has no NULL of it (MySQL: --secure-file-priv=NULL). The TLS files are read at start,
// with the names of MYSQL_TLS_SERVER_NAMES. skip-name-resolve keeps a TCP client at 127.0.0.1 the user of host 127.0.0.1 that the DSNs
// name, as on MySQL; without it MariaDB resolves 127.0.0.1 to localhost and matches the user of host localhost. The privilege
// probe server has no TLS files, as the MySQL one has none.
export function mariadbdArguments(p: Paths, role: MariadbRole, port: number): string[] {
  const { name, id } = MARIADB_SERVERS[role];
  const tls = join(p.dir, 'mariadb-tls');
  return ['--no-defaults', `--datadir=${join(p.dir, name)}`, `--tmpdir=${mariadbTmpdir(p, role)}`, `--secure-file-priv=${join(p.dir, 'mariadb-files')}`,
    `--lower-case-table-names=${MYSQL_LOWER_CASE}`, '--bind-address=127.0.0.1', '--skip-name-resolve', `--port=${port}`,
    `--socket=${mariadbSocket(p, role)}`, `--pid-file=${join(p.dir, `${name}.server.pid`)}`,
    ...(role === 'privilege' ? MARIADBD_PRIVILEGE_BINLOG : MARIADBD_BINLOG), ...MARIADBD_STORAGE, ...MARIADBD_PERFORMANCE_SCHEMA, ...MARIADBD_MYSQL_DEFAULTS, `--server-id=${id}`,
    ...(role === 'privilege' ? [] : [`--ssl-ca=${tls}/ca.pem`, `--ssl-cert=${tls}/${name}-cert.pem`, `--ssl-key=${tls}/${name}-key.pem`]),
    ...(role === 'replica' ? MARIADBD_REPLICA : [])];
}

// mariadbTmpdir is the temporary folder of the mariadbd of <role>, its own: a starting mariadbd removes every #sql file of its
// tmpdir, so in the shared TMPDIR of the machine the start of any other server, or of mariadb-install-db, removed the Aria files of
// the internal temporary tables that a running server had open, and that server crashed (signal 11 in free_tmp_table).
export const mariadbTmpdir = (p: Paths, role: MariadbRole): string => join(p.dir, `${MARIADB_SERVERS[role].name}-tmp`);
const mariadbSocket = (p: Paths, role: MariadbRole): string =>
  ({ primary: p.sockets.mariadb, replica: p.sockets.mariadbReplica, privilege: p.sockets.mariadbPrivilege })[role];
const mariadbPid = (p: Paths, role: MariadbRole): string =>
  ({ primary: p.mariadbPid, replica: p.mariadbReplicaPid, privilege: p.mariadbPrivilegePid })[role];

// mariadbEnvironment is the environment file of the MariaDB servers on <ports>: the variables of the MySQL servers with MARIADB in
// place of MYSQL, which the recipe runners read for the database mariadb (FCV-3). ORM_TEST_MARIADB_PRIVILEGE_DSN is the
// ORM_TEST_MYSQL_PRIVILEGE_DSN of MariaDB, and ORM_TEST_MARIADB_PROXYSQL_DSN its ORM_TEST_PROXYSQL_DSN, the pooler of the user orm.
export function mariadbEnvironment(p: Paths, ports: MariadbPorts): Record<string, string> {
  const primary = `mysql://root@127.0.0.1:${ports.mariadb}`;
  const tls = (port: number, ca: string, host = 'localhost.') => `mysql://root@${host}:${port}/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=${p.dir}/mariadb-tls/${ca}.pem`;
  return {
    ORM_TEST_MARIADB_DSN: `${primary}/orm_test`,
    ORM_TEST_MARIADB_SERVER_DSN: `${primary}/orm_test`,
    ORM_TEST_MARIADB_REPLICA_DSN: `mysql://root@127.0.0.1:${ports.mariadbReplica}/orm_test`,
    ORM_TOOLS_MARIADB_DSN: `${primary}/orm_tools`,
    ORM_TEST_MARIADB_LEASES: p.mariadbLeases,
    ORM_TEST_MARIADB_TLS_DSN: tls(ports.mariadb, 'ca'),
    ORM_TEST_MARIADB_TLS_OTHER_CA_DSN: tls(ports.mariadb, 'other-ca'),
    ORM_TEST_MARIADB_TLS_MISMATCH_DSN: tls(ports.mariadbReplica, 'ca', MYSQL_TLS_MISMATCH_HOST),
    ORM_TEST_MARIADB_SOCKET: p.sockets.mariadb,
    ORM_TEST_MARIADB_PRIVILEGE_DSN: `mysql://root@127.0.0.1:${ports.mariadbPrivilege}/orm_test`,
    ORM_TEST_MARIADB_PROXYSQL_DSN: `mysql://orm:orm@127.0.0.1:${ports.proxysql}/orm_test`,
  };
}

/** MARIADB_VARIABLES are the names of the variables of the MariaDB environment file. */
export const MARIADB_VARIABLES = ['ORM_TEST_MARIADB_DSN', 'ORM_TEST_MARIADB_SERVER_DSN', 'ORM_TEST_MARIADB_REPLICA_DSN', 'ORM_TOOLS_MARIADB_DSN',
  'ORM_TEST_MARIADB_LEASES', 'ORM_TEST_MARIADB_TLS_DSN', 'ORM_TEST_MARIADB_TLS_OTHER_CA_DSN', 'ORM_TEST_MARIADB_TLS_MISMATCH_DSN', 'ORM_TEST_MARIADB_SOCKET',
  'ORM_TEST_MARIADB_PRIVILEGE_DSN', 'ORM_TEST_MARIADB_PROXYSQL_DSN'];

// mariadbEnvironmentPorts reads the ports of the running servers from their environment file.
export function mariadbEnvironmentPorts(text: string, file: string): MariadbPorts {
  const port = (name: string): number => {
    const match = new RegExp(`^export ${name}='[^@]*@127\\.0\\.0\\.1:(\\d+)/`, 'm').exec(text);
    if (!match) throw new TestServerError(`test-servers: ${file} records no port in ${name}; run make orm-test-servers-stop and make orm-test-mariadb, which rewrite it`);
    return checkedPort(match[1] ?? '');
  };
  return { mariadb: port('ORM_TEST_MARIADB_SERVER_DSN'), mariadbReplica: port('ORM_TEST_MARIADB_REPLICA_DSN'),
    mariadbPrivilege: port('ORM_TEST_MARIADB_PRIVILEGE_DSN'), proxysql: port('ORM_TEST_MARIADB_PROXYSQL_DSN') };
}

const mariadbAt = (port: number, sql: string, database: string[] = []): void =>
  run('mariadb', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', ...database, '-e', sql]);

// mariadbReplicaStopped reads the SQL thread of the replica on port: undefined while it runs, else why it stopped.
function mariadbReplicaStopped(port: number): string | undefined {
  const status = spawnSync('mariadb', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-e', 'SHOW REPLICA STATUS\\G'], { encoding: 'utf8' });
  if (status.status !== 0) return `replica status unavailable (mariadb exited with ${status.status ?? status.signal})`;
  const field = (name: string): string => status.stdout.split('\n')
    .find(line => line.trim().startsWith(`${name}:`))?.split(':').slice(1).join(':').trim() ?? 'absent';
  const running = field('Slave_SQL_Running');
  return running === 'Yes' ? undefined : `Slave_SQL_Running: ${running}; Last_SQL_Error: ${field('Last_SQL_Error') || 'none'}`;
}

// PRIVILEGE_STATE is what the privilege probe server answers to PRIVILEGE_STATE_SQL: binary logging on, trust-function-creators
// off and a writable server, the state that mysqlPrivilegeReady requires of the MySQL one.
const PRIVILEGE_STATE_SQL = 'SELECT @@log_bin, @@log_bin_trust_function_creators, @@read_only';
const PRIVILEGE_STATE = '1\t0\t0';

function mariadbPrivilegeState(port: number): string {
  const checked = spawnSync('mariadb', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', 'orm_test',
    '-e', PRIVILEGE_STATE_SQL], { encoding: 'utf8' });
  return checked.status === 0 ? checked.stdout.trim() : checked.stderr.trim() || `exit ${checked.status ?? checked.signal}`;
}

// mariadbRunning judges the running servers by their processes, the SQL thread of the replica and the state of the privilege probe server.
function mariadbRunning(p: Paths): MariadbPorts | undefined {
  const pids = [p.mariadbPid, p.mariadbReplicaPid, p.mariadbPrivilegePid, p.mariadbProxysqlPid];
  if (!existsSync(p.mariadbEnv) || !pids.every(pidRunning)) return;
  const ports = mariadbEnvironmentPorts(readFileSync(p.mariadbEnv, 'utf8'), p.mariadbEnv);
  const stopped = mariadbReplicaStopped(ports.mariadbReplica);
  const privilege = mariadbPrivilegeState(ports.mariadbPrivilege);
  if (stopped === undefined && privilege === PRIVILEGE_STATE) return ports;
  console.error(`test-servers: ${stopped === undefined ? `the MariaDB privilege probe server reports ${privilege}` : `the MariaDB replica is stopped, ${stopped}`}; the MariaDB servers are started again`);
}

// mariadbTls issues the TLS files of the MariaDB servers under <dir>/mariadb-tls, as tls of test-servers.mts does for MySQL: a
// test CA, a primary certificate that names localhost, a replica certificate that names orm-mismatch.invalid, and a second CA.
function mariadbTls(p: Paths): void {
  const dir = join(p.dir, 'mariadb-tls');
  if (existsSync(join(dir, 'other-ca.pem'))) return;
  issueTls(dir, [['mariadb', MYSQL_TLS_SERVER_NAMES.mysql], ['mariadb-replica', MYSQL_TLS_SERVER_NAMES.mysqlReplica]]);
}

// mariadbVersion requires the mariadbd on PATH to be a release of MARIADB_SERIES: the local build of MARIADB_VERSION or the
// newest package of the series on the CI runner.
function mariadbVersion(): void {
  const line = spawnSync('mariadbd', ['--version'], { encoding: 'utf8' }).stdout ?? '';
  if (!MARIADB_SERIES_LINE.test(line))
    throw new TestServerError(`test-servers: mariadbd on PATH prints ${JSON.stringify(line.trim())}, not MariaDB ${MARIADB_SERIES}; run make orm-install-mariadb`);
}

// ROOT_TCP_SQL gives root the host 127.0.0.1, by which every DSN of the environment reaches it over TCP: mariadb-install-db creates
// root only for localhost, the Unix socket. Each server makes that user for itself and logs it to no binary log, so the replica does not
// apply the grant of the primary over the privileges it takes from root.
const ROOT_TCP_SQL = "SET SESSION sql_log_bin = 0; CREATE USER IF NOT EXISTS 'root'@'127.0.0.1'; GRANT ALL ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;";

async function startServers(p: Paths, ports: MariadbPorts): Promise<void> {
  const env = mysqlEnvironment();
  mkdirSync(join(p.dir, 'mariadb-files'), { recursive: true });
  mariadbTls(p);
  for (const [role, port] of [['primary', ports.mariadb], ['replica', ports.mariadbReplica], ['privilege', ports.mariadbPrivilege]] as const) {
    const { name } = MARIADB_SERVERS[role];
    mkdirSync(mariadbTmpdir(p, role), { recursive: true });
    // mariadb-install-db makes the data folder as mysqld --initialize-insecure does for MySQL. --auth-root-authentication-method=normal
    // gives root the password-less native login of an insecure MySQL root, where MariaDB would let root in only by the unix_socket
    // plugin as the operating-system user root; --skip-test-db leaves out the database test and the grants of the anonymous user on
    // test and test_%, which MySQL does not make.
    run('mariadb-install-db', ['--no-defaults', `--datadir=${join(p.dir, name)}`, `--tmpdir=${mariadbTmpdir(p, role)}`, '--auth-root-authentication-method=normal', '--skip-test-db',
      `--lower-case-table-names=${MYSQL_LOWER_CASE}`], { stdio: ['ignore', openSync(join(p.dir, `${name}-init.log`), 'w'), 'inherit'], env });
    await startLogged(p.dir, name, 'ready for connections', 'mariadbd', mariadbdArguments(p, role, port), env);
    run('mariadb', ['--no-defaults', `--socket=${mariadbSocket(p, role)}`, '-u', 'root', '-e', ROOT_TCP_SQL]);
    console.log(`test-servers: MariaDB ${role} on 127.0.0.1:${port}`);
  }
  mariadbAt(ports.mariadbPrivilege, 'CREATE DATABASE orm_test');
  const privilege = mariadbPrivilegeState(ports.mariadbPrivilege);
  if (privilege !== PRIVILEGE_STATE)
    throw new TestServerError(`test-servers: the MariaDB privilege probe server reports ${privilege}; want binary logging on, log_bin_trust_function_creators=0 and a writable server`);
  // The replica reads the binary log of the primary from its first file, before the primary holds data, so it applies every later
  // change. read_only=ON refuses the writes of every user without the privilege READ ONLY ADMIN, and the replica takes that privilege
  // from root at 127.0.0.1, the user of ORM_TEST_MARIADB_REPLICA_DSN, so the replica refuses the writes of root as super_read_only
  // does on MySQL; the replication thread writes whatever read_only says.
  mariadbAt(ports.mariadbReplica, `CHANGE MASTER TO MASTER_HOST='127.0.0.1', MASTER_PORT=${ports.mariadb}, MASTER_USER='root', MASTER_USE_GTID=no;
    START REPLICA; REVOKE READ ONLY ADMIN ON *.* FROM 'root'@'127.0.0.1'; SET GLOBAL read_only = ON;`);
  const tables = spawnSync('mariadb-tzinfo-to-sql', ['/usr/share/zoneinfo'], { stdio: ['ignore', 'pipe', openSync(join(p.dir, 'mariadb-tzinfo.log'), 'w')], maxBuffer: 1 << 30 });
  if (tables.status !== 0) throw new TestServerError(`test-servers: mariadb-tzinfo-to-sql exited with ${tables.status ?? tables.signal}; see ${join(p.dir, 'mariadb-tzinfo.log')}`);
  run('mariadb', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(ports.mariadb), '-u', 'root', 'mysql'], { stdio: ['pipe', 'inherit', 'inherit'], input: tables.stdout });
  mariadbAt(ports.mariadb, `CREATE DATABASE orm_test; CREATE DATABASE orm_tools; ${ORM_ACCOUNTS_SQL}`);
  // The ProxySQL of the primary pools the connections of the user orm over at most PROXYSQL_BACKEND_CONNECTIONS server
  // connections, as the ProxySQL of the MySQL primary does, and reports the version of the MariaDB it fronts.
  const data = join(p.dir, 'mariadb-proxysql');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(p.dir, 'mariadb-proxysql.cnf'), proxysqlConfigOf({ data, admin: p.sockets.mariadbProxysqlAdmin, adminPgsql: p.sockets.mariadbProxysqlAdminPgsql,
    pgsql: p.sockets.mariadbProxysqlPgsql, port: ports.proxysql, backend: ports.mariadb, serverVersion: `${MARIADB_VERSION}-MariaDB` }));
  // ProxySQL logs the consulting notice after its listeners are bound.
  await startLogged(p.dir, 'mariadb-proxysql', 'For consultancy visit', 'proxysql', ['--foreground', '--initial', '--no-version-check', '-c', join(p.dir, 'mariadb-proxysql.cnf'), '-D', data]);
  console.log(`test-servers: the ProxySQL of MariaDB on 127.0.0.1:${ports.proxysql}`);
}

function writeMariadbEnvironment(p: Paths, ports: MariadbPorts): void {
  const lines = Object.entries(mariadbEnvironment(p, ports)).map(([name, value]) => {
    if (/['\n\r]/.test(value)) throw new TestServerError(`test-servers: ${name} holds a quote or a newline: ${value}`);
    return `export ${name}='${value}'\n`;
  });
  writeFileSync(`${p.mariadbEnv}.tmp`, lines.join(''));
  renameSync(`${p.mariadbEnv}.tmp`, p.mariadbEnv);
}

// stopMariadbProcesses stops the ProxySQL, then the privilege probe server, the replica and the primary that their pid files
// name, by the rule of the MySQL servers (stopServerProcess): TERM and the exit event for a running one, a report for one whose
// process has exited.
function stopMariadbProcesses(p: Paths): void {
  const errors: unknown[] = [];
  try { stopServerProcess(p.mariadbProxysqlPid, 'the ProxySQL of MariaDB'); } catch (error) { errors.push(error); }
  for (const [role, name] of [['privilege', 'the MariaDB privilege probe server'], ['replica', 'the MariaDB replica'], ['primary', 'MariaDB']] as const) {
    try { stopServerProcess(mariadbPid(p, role), name); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw shutdownError('test-servers: MariaDB shutdown failed', errors);
}

/** stopMariadb stops the MariaDB servers under the exclusive lease of their lease directory. */
export function stopMariadb(p: Paths): void {
  if (![p.mariadbPid, p.mariadbReplicaPid, p.mariadbPrivilegePid, p.mariadbProxysqlPid].some(file => existsSync(file))) return;
  holdExclusiveLease(p.mariadbLeases);
  stopMariadbProcesses(p);
}

/** startMariadb starts the MariaDB servers, or keeps the running ones and rewrites their environment file. */
export async function startMariadb(p: Paths): Promise<void> {
  const running = mariadbRunning(p);
  if (running) {
    writeMariadbEnvironment(p, running);
    console.log(`test-servers: MariaDB running; environment ${p.mariadbEnv}`);
    return;
  }
  const missing = MARIADB_TOOLS.filter(tool => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', tool], { stdio: 'ignore' }).status !== 0);
  if (missing.length) throw new TestServerError(`test-servers: ${missing.join(', ')} not on PATH; run make orm-install-mariadb, or make orm-install-server-programs on the CI runner`);
  mariadbVersion();
  const chosen = spawnSync(process.execPath, [join(import.meta.dirname, 'free-ports.mts'), '4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const free = chosen.status === 0 ? chosen.stdout.trim().split(/\s+/).filter(Boolean).map(checkedPort) : [];
  const [mariadb, mariadbReplica, mariadbPrivilege, proxysql] = free;
  if (free.length !== 4 || mariadb === undefined || mariadbReplica === undefined || mariadbPrivilege === undefined || proxysql === undefined)
    throw new TestServerError(`test-servers: scripts/free-ports.mts chose ${free.length} ports, not 4; run node scripts/free-ports.mts 4 to see why`);
  const ports = { mariadb, mariadbReplica, mariadbPrivilege, proxysql };
  holdExclusiveLease(p.mariadbLeases);
  mkdirSync(p.dir, { recursive: true });
  socketDir(p);
  stopMariadbProcesses(p);
  for (const name of [...Object.values(MARIADB_SERVERS).flatMap(server => [server.name, `${server.name}-tmp`]), 'mariadb-proxysql']) rmSync(join(p.dir, name), { recursive: true, force: true });
  rmSync(p.mariadbEnv, { force: true });
  try {
    await startServers(p, ports);
    writeMariadbEnvironment(p, ports);
  } catch (error) {
    console.error(`test-servers: MariaDB start failed; logs are in ${p.dir}`);
    try { stopMariadbProcesses(p); }
    catch (cleanup) { throw shutdownError(`test-servers: MariaDB start failed: ${error instanceof Error ? error.message : String(error)}`, [cleanup]); }
    throw error;
  }
  console.log(`test-servers: MariaDB started; environment ${p.mariadbEnv}`);
}
