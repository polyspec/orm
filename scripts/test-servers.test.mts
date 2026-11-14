// The stop tests of scripts/test-servers.mts. make orm-test-servers-check builds tests/stop-process and tests/lease and passes
// their paths as STOP_PROCESS and LEASE.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { isolatedEnvironment } from '../tests/environment.mts';
import { caseTest } from '../tests/testcase.mts';
import { buildOptionsText, CMAKE_OPTIONS } from './mariadb-build.mts';
import { mariadbdArguments, mariadbEnvironment, mariadbEnvironmentPorts, MARIADB_VARIABLES } from './test-servers-mariadb.mts';
import { environment, issueTls, MYSQLD_BINLOG, MYSQLD_PRIVILEGE_BINLOG, MYSQL_TLS_MISMATCH_HOST, MYSQL_TLS_SERVER_NAMES, mysqlEnvironment, mysqlPrivilegeArguments, mysqldArguments, paths, POSTGRES_HBA, POSTGRES_LOCALE, postgresBaseBackupArguments, proxysqlConfig, postgresEnvironment, SERVER_TIME_ZONE, startLogged, stopEarlierStart, stopPid, TestServerError, TLS_SERVERS, type Paths } from './test-servers.mts';
import { withPidFixture } from './test-servers-fixture.mts';
import * as servers from './test-servers.mts';

// The storage settings of the servers (KSTD-5-88-5), read from the module so that a missing one fails its assertion.
const { MYSQLD_STORAGE, POSTGRES_WAL, postgresArguments } = servers;

// processState is the state that ps reports for a process, empty when it is gone. exited is whether it has ended: an ended
// process is gone, or a zombie (state Z) until the process that adopted it reaps it, and kill(pid, 0) still succeeds on a
// zombie, so the state is read.
const processState = (pid: number): string => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
const exited = (pid: number): boolean => { const state = processState(pid); return state === '' || state.startsWith('Z'); };

function killAndWait(pid: number): void {
  const stop = process.env.STOP_PROCESS;
  assert.ok(stop, 'STOP_PROCESS is unset; run make orm-test-servers-check, which builds it');
  const result = spawnSync(stop, ['KILL', String(pid)], { encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
}

function cleanupStartedChild(dir: string, name: string): void {
  try {
    const file = join(dir, `${name}.pid`);
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'));
      if (!exited(pid)) killAndWait(pid);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The PostgreSQL locale cases. A PostgreSQL server with no locale in its environment fails at start with postmaster became
// multithreaded during startup, so the tool sets LC_ALL for initdb and the server it starts, whatever the caller set.
caseTest('the database server environments use Asia/Seoul independently of the host', () => {
  assert.equal(POSTGRES_LOCALE, 'en_US.UTF-8');
  assert.equal(SERVER_TIME_ZONE, 'Asia/Seoul');
  assert.equal(mysqlEnvironment({ PATH: '/bin', TZ: 'UTC' }).TZ, SERVER_TIME_ZONE);
  assert.equal(postgresEnvironment({ PATH: '/bin', TZ: 'UTC' }).TZ, SERVER_TIME_ZONE);
  assert.equal(postgresEnvironment({ PATH: '/bin' }).LC_ALL, POSTGRES_LOCALE);
  assert.equal(postgresEnvironment({ PATH: '/bin', LC_ALL: 'C' }).LC_ALL, POSTGRES_LOCALE);
  assert.equal(postgresEnvironment({ PATH: '/bin' }).PATH, '/bin');
});

// The start case runs initdb and the PostgreSQL server with the environment postgresEnvironment builds from a caller that
// sets no locale, then reads the environment that the server started with from its own process and stops it. A
// server that fails at start never logs its ready line, so the start is the observed ready event (startLogged).
caseTest('the PostgreSQL server starts with no locale set by the caller, and reads the locale it sets', async ({ step }) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orm-pglocale-')));
  const data = join(dir, 'data');
  const caller = { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir };
  assert.ok(!('LC_ALL' in caller), 'the caller sets no locale');
  try {
    const init = spawnSync('initdb', ['-D', data, '-U', 'orm', '--auth=trust', '--encoding=UTF8', '--locale=C'], { env: postgresEnvironment(caller), encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    step('initdb: done');
    const port = await freePort();
    await startLogged(dir, 'postgres', 'database system is ready to accept connections', 'postgres', ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='], postgresEnvironment(caller));
    step(`postgres: ready on ${port}`);
    // A server process reads the locale from its environment: its own postmaster line names the locale it runs with.
    const pid = Number(readFileSync(join(dir, 'postgres.pid'), 'utf8').trim());
    const environ = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    assert.match(environ, new RegExp(`LC_ALL=${POSTGRES_LOCALE.replace(/[.]/g, '[.]')}(\\s|$)`), `the server runs without LC_ALL=${POSTGRES_LOCALE}: ${environ}`);
  } finally {
    spawnSync('pg_ctl', ['-D', data, 'stop', '-m', 'fast', '-w'], { env: postgresEnvironment(caller), stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stopPid case stops a fake server. Stopping a server is a long task, so it has no deadline, and its end is learned
// from the operating system's exit event (STOP_PROCESS), not by polling. A slow but sound server that ends 1.5 seconds
// after TERM is reported stopped after that, when its process is already gone.
// freePort is a TCP port of the loopback address that no server listens on when the promise resolves.
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { reject(new Error(`the server listens on ${String(address)}, not a port`)); return; }
      server.close(() => resolve(address.port));
    });
  });
}

caseTest('stopPid waits for the exit event of the server, with no polling', () => {
  assert.ok(process.env.STOP_PROCESS, 'STOP_PROCESS is unset; run make orm-test-servers-check, which builds it');
  const dir = mkdtempSync(join(tmpdir(), 'orm-stop-'));
  try {
    for (const [name, delay] of [['quick', 0], ['slow', 1.5]] as const) {
      // The server sets its TERM trap, then writes ready to the FIFO; the outer shell reads that write to learn the start.
      const pidFile = join(dir, `${name}.pid`), ready = join(dir, `${name}.ready`);
      const server = spawnSync('sh', ['-c', `mkfifo ${ready}
sh -c 'trap "sleep ${delay}; kill \\$child; exit 0" TERM; sleep 30 & child=$!; echo ready > ${ready}; wait' >/dev/null 2>&1 &
echo $! > ${pidFile}
read state < ${ready}`], { env: isolatedEnvironment() });
      assert.equal(server.status, 0, String(server.stderr));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      const started = Date.now();
      stopPid(pidFile);
      const elapsed = Date.now() - started;
      assert.ok(exited(pid), `${name} server still runs after stopPid (state ${processState(pid)})`);
      assert.ok(elapsed >= delay * 1000, `${name} server reported stopped after ${elapsed} ms, before its ${delay} s shutdown`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The earlier-start case leaves a fake server running on the datadir of an earlier start, known by its pid file under
// .runtime/servers, and checks that stopEarlierStart, which start runs before it starts servers, stops it on its exit
// event and removes the directory. No database starts.
caseTest('a start first stops the server an earlier start left on its datadir, by its pid file', () => {
  const { LEASE: lease, STOP_PROCESS: stopProcess } = process.env;
  assert.ok(lease && stopProcess, 'LEASE or STOP_PROCESS is unset; run make orm-test-servers-check, which builds them');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-earlier-')));
  const p = paths(root, join(root, 'sockets'));
  try {
    mkdirSync(p.dir, { recursive: true });
    const ready = join(root, 'ready');
    const server = spawnSync('sh', ['-c', `mkfifo ${ready}
sh -c 'trap "kill \\$child; exit 0" TERM; sleep 30 & child=$!; echo ready > ${ready}; wait' >/dev/null 2>&1 &
echo $! > ${p.proxysqlPid}
read state < ${ready}`], { env: isolatedEnvironment() });
    assert.equal(server.status, 0, String(server.stderr));
    const pid = Number(readFileSync(p.proxysqlPid, 'utf8').trim());
    stopEarlierStart(p);
    assert.ok(exited(pid), `the server of the earlier start still runs (state ${processState(pid)})`);
    assert.ok(!existsSync(p.dir), `${p.dir} is kept`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The stop cases of the database servers (MySQL and MariaDB, each with its replica and privilege probe server) run
// `test-servers.mts stop` on a temporary root whose pid files name fake servers, shells that end on TERM. The rule is
// the same for the six: a server whose pid file names a process that has exited is reported not running and the stop
// succeeds; a running one is stopped by its process, whatever client the PATH holds; any other failure shows its
// output and fails the stop. No database starts.
const DATABASE_SERVERS = (p: Paths): [string, string][] => [[p.mysqlPid, 'MySQL'], [p.mysqlReplicaPid, 'the MySQL replica'],
  [p.mysqlPrivilegePid, 'the MySQL privilege probe server'], [p.mariadbPid, 'MariaDB'], [p.mariadbReplicaPid, 'the MariaDB replica'],
  [p.mariadbPrivilegePid, 'the MariaDB privilege probe server']];

// fakeServer starts a shell that ends on TERM and writes its pid into <pidFile>; it returns after the shell set its trap.
function fakeServer(pidFile: string): number {
  const ready = `${pidFile}.ready`;
  const server = spawnSync('sh', ['-c', `mkfifo ${ready}
sh -c 'trap "kill \\$child; exit 0" TERM; sleep 30 & child=$!; echo ready > ${ready}; wait' >/dev/null 2>&1 &
echo $! > ${pidFile}
read state < ${ready}`], { env: isolatedEnvironment() });
  assert.equal(server.status, 0, String(server.stderr));
  return Number(readFileSync(pidFile, 'utf8').trim());
}

// stopFixture runs main(['stop']) on a fresh root with <PATH> and <STOP_PROCESS> in the environment and returns what it
// printed and the error it threw; the fake servers that still run afterwards are stopped by the real STOP_PROCESS.
async function stopFixture(prepare: (p: Paths, bin: string) => void, env: { stopProcess?: (bin: string) => string } = {}): Promise<{ lines: string[]; error: unknown; pids: number[] }> {
  const { LEASE: lease, STOP_PROCESS: stopProcess, PATH: path } = process.env;
  assert.ok(lease && stopProcess, 'LEASE or STOP_PROCESS is unset; run make orm-test-servers-check, which builds them');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-stop-db-')));
  const p = paths(root, join(root, 'sockets'));
  const bin = join(root, 'bin');
  const lines: string[] = [];
  const log = console.log;
  let error: unknown;
  const pids: number[] = [];
  try {
    mkdirSync(p.dir, { recursive: true });
    mkdirSync(p.socketDir, { recursive: true });
    mkdirSync(bin);
    // The clients that the MariaDB bin folder puts first on the PATH of make orm-test-servers-stop: its mysqladmin is
    // mariadb-admin, whose COM_SHUTDOWN MySQL 8.4 answers with Unknown command.
    for (const client of ['mysqladmin', 'mariadb-admin']) {
      writeFileSync(join(bin, client), `#!/bin/sh\necho "${client}: shutdown failed; error: 'Unknown command'" >&2\nexit 1\n`);
      chmodSync(join(bin, client), 0o755);
    }
    prepare(p, bin);
    for (const [file] of DATABASE_SERVERS(p)) if (existsSync(file)) pids.push(Number(readFileSync(file, 'utf8').trim()));
    process.env.PATH = `${bin}:${path ?? ''}`;
    if (env.stopProcess) process.env.STOP_PROCESS = env.stopProcess(bin);
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try { await servers.main(['stop'], p); } catch (thrown) { error = thrown; }
  } finally {
    console.log = log;
    process.env.PATH = path;
    process.env.STOP_PROCESS = stopProcess;
    for (const pid of pids) if (!exited(pid)) spawnSync(stopProcess, ['TERM', String(pid)], { env: isolatedEnvironment() });
    rmSync(root, { recursive: true, force: true });
  }
  return { lines, error, pids };
}

caseTest('stop stops each running database server by its process, whatever mysqladmin the PATH holds', async () => {
  let names: [string, string][] = [];
  const { lines, error, pids } = await stopFixture(p => { names = DATABASE_SERVERS(p); for (const [file] of names) fakeServer(file); });
  assert.equal(error, undefined, `stop failed: ${errorText(error)}`);
  for (const pid of pids) assert.ok(exited(pid), `the fake server ${pid} still runs after stop (state ${processState(pid)})`);
  for (const [, name] of names) assert.ok(lines.includes(`test-servers: stopped ${name}`), `stop did not report stopping ${name}: ${lines.join(' | ')}`);
});

caseTest('stop reports a database server whose pid file names an exited process and succeeds', async () => {
  // A process that has exited and been reaped: spawnSync returns after the wait.
  const dead = spawnSync('true').pid;
  assert.ok(dead !== undefined && exited(dead), 'the dead process fixture still runs');
  let names: [string, string][] = [];
  const { lines, error } = await stopFixture(p => { names = DATABASE_SERVERS(p); for (const [file] of names) writeFileSync(file, `${dead}\n`); });
  assert.equal(error, undefined, `stop failed: ${errorText(error)}`);
  for (const [file, name] of names)
    assert.ok(lines.includes(`test-servers: ${name} is not running: process ${dead} of ${file} has exited`), `stop did not report ${name} as not running: ${lines.join(' | ')}`);
});

caseTest('stop fails with the output of a failed stop of a running database server', async () => {
  const { error } = await stopFixture(p => { fakeServer(p.mysqlPid); fakeServer(p.mariadbPid); }, {
    stopProcess: bin => {
      const refusing = join(bin, 'stop-process');
      writeFileSync(refusing, '#!/bin/sh\necho "stop-process: refused $2" >&2\nexit 7\n');
      chmodSync(refusing, 0o755);
      return refusing;
    },
  });
  assert.ok(error instanceof TestServerError, `stop did not fail: ${errorText(error)}`);
  assert.match(error.message, /MySQL shutdown failed: test-servers: .*stop-process TERM exited with 7/);
  assert.match(error.message, /MariaDB shutdown failed: test-servers: .*stop-process TERM exited with 7/);
});

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

caseTest('only ESRCH means a server is gone and other kill errors keep its data directory', () => {
  for (const code of ['EPERM', 'EINVAL']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-kill-error-')));
    const p = paths(root, join(root, 'sockets'));
    const failures = [Object.assign(new Error(`kill ${code}`), { code }), Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })];
    const calls: number[] = [];
    const originalKill = process.kill.bind(process);
    try {
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.pgbouncerPid, '51001\n');
      writeFileSync(p.proxysqlPid, '51002\n');
      process.kill = (pid: number) => {
        calls.push(pid);
        throw pid === 51001 ? failures[0] : failures[1];
      };
      assert.throws(() => stopEarlierStart(p), error => {
        assert.ok(error instanceof TestServerError);
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, failures);
        return true;
      });
      assert.deepEqual(calls, [51001, 51002]);
      assert.ok(existsSync(p.dir), 'data directory was removed after a denied kill');
    } finally {
      process.kill = originalKill;
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-kill-gone-')));
  const p = paths(root, join(root, 'sockets'));
  const gone = Object.assign(new Error('already gone'), { code: 'ESRCH' });
  const originalKill = process.kill.bind(process);
  try {
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.pgbouncerPid, '51003\n');
    process.kill = () => { throw gone; };
    stopEarlierStart(p);
    assert.ok(!existsSync(p.dir), 'data directory remains for an absent process');
  } finally {
    process.kill = originalKill;
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('a PID-file read failure is preserved before any kill check', () => {
  let called = false;
  withPidFixture(({ paths: p }) => {
    mkdirSync(p.dir, { recursive: true });
    mkdirSync(p.pgbouncerPid);
    process.kill = () => { called = true; return true; };
    assert.throws(() => stopEarlierStart(p), (error: TestServerError) => {
      assert.ok(error.cause instanceof Error);
      return (error.cause as NodeJS.ErrnoException).code === 'EISDIR';
    });
    assert.equal(called, false, 'kill ran after the PID-file read failed');
    assert.ok(existsSync(p.dir), 'data directory was removed after a PID-file read failure');
  });
});

caseTest('invalid PID-file values never signal unrelated processes or remove server data', () => {
  for (const value of ['0', '-1', 'NaN', '9007199254740992']) {
    let called = false;
    withPidFixture(({ paths: p }) => {
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.pgbouncerPid, `${value}\n`);
      process.kill = () => { called = true; throw Object.assign(new Error('invalid PID probe'), { code: 'EPERM' }); };
      assert.throws(() => stopEarlierStart(p), (error: TestServerError) => {
        assert.match(error.message, /invalid PID file/);
        assert.match(error.message, /run make orm-test-servers-check/);
        assert.ok(error.cause instanceof Error);
        return true;
      });
      assert.equal(called, false, `kill ran for invalid PID '${value}'`);
      assert.ok(existsSync(p.dir), `data directory was removed for invalid PID '${value}'`);
    });
  }
});

// The lease case copies the scripts of this checkout to a temporary root and checks that, while another run holds the
// server's shared lease, `test-servers.mts stop` refuses naming that holder and keeps the server directory, and that the
// stop proceeds once the hold ends. The holder is a shell that waits reading a FIFO; ready and end go through FIFOs.
caseTest('stopping the test servers is refused while another run holds a lease, naming the holder', () => {
  const { LEASE: lease, STOP_PROCESS: stopProcess } = process.env;
  assert.ok(lease && stopProcess, 'LEASE or STOP_PROCESS is unset; run make orm-test-servers-check, which builds them');
  // The script names its servers by its real path (Node resolves the module path), so the root is a real path too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-lease-')));
  const release = join(root, 'release');
  const ready = join(root, 'ready');
  const leases = join(root, '.runtime/servers.leases');
  let holder;
  const stop = () => spawnSync(process.execPath, [join(root, 'scripts/test-servers.mts'), 'stop'], { encoding: 'utf8', env: isolatedEnvironment({ LEASE: lease, STOP_PROCESS: stopProcess }) });
  try {
    // The script runs from the temporary root with the modules it imports (../tests/errors.mts, 0dfe45bc6, and the MariaDB servers).
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tests'));
    for (const file of ['test-servers.mts', 'test-servers-mariadb.mts', 'mariadb-build.mts'])
      copyFileSync(new URL(`./${file}`, import.meta.url), join(root, 'scripts', file));
    copyFileSync(new URL('../tests/errors.mts', import.meta.url), join(root, 'tests/errors.mts'));
    mkdirSync(join(root, '.runtime/servers'), { recursive: true });
    execFileSync('mkfifo', [release, ready]);
    holder = spawn('sh', ['-c', `${lease} hold ${leases} shared --pid $$ && echo held > ${ready} && read line < ${release}`], { stdio: 'ignore' });
    assert.equal(execFileSync('sh', ['-c', `read state < ${ready}; echo $state`], { encoding: 'utf8' }), 'held\n');
    const refused = stop();
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.match(refused.stderr, new RegExp(`^lease: refused the exclusive lease of ${leases.replace(/[.]/g, '\\.')}; held by:\n  shared lease of pid ${holder.pid} \\(running\\) from \\S+ since \\S+: sh -c `));
    assert.ok(existsSync(join(root, '.runtime/servers')), 'the refused stop removed the servers directory');
    execFileSync('sh', ['-c', `echo done > ${release}`]);
    // When the holder shell ends, the releaser removes its lease. The stop after it does not wait for a change event of the
    // lease directory but tries at once, so it waits with `lease run --wait` until the lease is removed, then stops.
    execFileSync(lease, ['run', leases, 'exclusive', '--wait', '--', 'true']);
    const stopped = stop();
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.match(stopped.stdout, /test-servers: removed .*\.runtime\/servers\n$/);
    assert.ok(!existsSync(join(root, '.runtime/servers')), 'the stop left the servers directory');
  } finally {
    // End a holder that a failed case left behind; when it ends, the releaser removes its lease.
    if (holder?.exitCode === null) holder.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// The nested lease case checks that child processes running together under a process that holds exclusive (as the
// feature steps of make feature-check do) do not share that hold but divide it again among themselves. While the outer
// shell holds exclusive and child shell A holds exclusive waiting on a FIFO, the exclusive and shared requests of another
// child refuse naming A. When A ends, a child with --wait takes it, and the same process taking it again reuses its
// hold. Then two child shells under the outer shell hold shared together. The releaser removes a child's hold after its
// process ends, so the first hold after an earlier one waits for that release with --wait.
caseTest('children of an exclusive holder share its lease one exclusive holder at a time', () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-nested-'));
  const leases = join(root, 'leases');
  try {
    const script = `set -u
L=${lease}; D=${leases}; R=${root}
mkfifo "$R/held" "$R/release"
"$L" hold "$D" exclusive --pid $$ || exit 9
sh -c '"$1" hold "$2" exclusive --pid $$ && echo held > "$3/held" && read line < "$3/release"' a "$L" "$D" "$R" &
read state < "$R/held"
sh -c '"$1" hold "$2" exclusive --pid $$' b "$L" "$D" 2> "$R/exclusive.err"; echo "exclusive=$?"
sh -c '"$1" hold "$2" shared --pid $$' c "$L" "$D" 2> "$R/shared.err"; echo "shared=$?"
echo done > "$R/release"; wait
sh -c '"$1" hold "$2" exclusive --wait --pid $$ && "$1" hold "$2" exclusive --pid $$' d "$L" "$D"; echo "after=$?"
sh -c '"$1" hold "$2" shared --wait --pid $$ && echo held > "$3/held" && read line < "$3/release"' e "$L" "$D" "$R" &
read state < "$R/held"
sh -c '"$1" hold "$2" shared --pid $$' f "$L" "$D"; echo "readers=$?"
echo done > "$R/release"; wait
`;
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout, 'exclusive=3\nshared=3\nafter=0\nreaders=0\n', run.stderr);
    for (const kind of ['exclusive', 'shared']) {
      assert.match(readFileSync(join(root, `${kind}.err`), 'utf8'),
        new RegExp(`^lease: refused the ${kind} lease of ${leases.replace(/[.]/g, '\\.')}; held by:\n  exclusive lease of pid \\d+ \\(running\\) from \\S+ since \\S+: sh -c `));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The dead hold case (G5.56) places hold files directly and sees how lease treats them. Each holder pid is of a process
// that has ended. A hold whose releaser is alive is being released, so --wait waits; when the releaser ends without
// removing it, it is taken. A shared hold with neither holder nor releaser is taken by anyone, an exclusive one only by an exclusive request.
function deadPid() {
  return spawnSync('true').pid;
}
function writeHolder(dir: string, name: string, fields: { kind: string; pid: number; releaser?: number|undefined; }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ checkout: '/x', started: '2026-10-06T00:00:00Z', command: 'make x', ...fields }));
}

// A refused attempt writes nothing in the lease directory: every waiter watches that directory, so a write of one waiter's attempt
// wakes the others, whose attempts wake it again, and they spin for as long as the holder runs. The directory's time shows a write
// that was removed again.
caseTest('a refused attempt leaves the lease directory untouched, so waiters do not wake each other', () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-quiet-'));
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    for (const [held, file, request] of [['exclusive', 'exclusive.json', 'exclusive'], ['exclusive', 'exclusive.json', 'shared'], ['shared', 'shared-1-a.json', 'exclusive']] as const) {
      const leases = join(root, `${held}-${request}`);
      assert.ok(holder.pid !== undefined, 'the holder process started');
      writeHolder(leases, file, { kind: held, pid: holder.pid });
      const before = statSync(leases, { bigint: true }).mtimeNs;
      const refused: SpawnSyncReturns<string> = spawnSync(lease, ['run', leases, request, '--', 'true'], { encoding: 'utf8' });
      assert.equal(refused.status, 3, refused.stderr);
      assert.equal(statSync(leases, { bigint: true }).mtimeNs, before, `a refused ${request} request wrote in the directory of a held ${held} lease`);
    }
  } finally {
    holder.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('an ended holder whose releaser still runs is waited for, and taken over when the releaser ends without removing it', async () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-dead-'));
  const releaser = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const leases = join(root, 'leases');
    writeHolder(leases, 'shared-1-a.json', { kind: 'shared', pid: deadPid(), releaser: releaser.pid });
    const waiter = spawn(lease, ['run', leases, 'exclusive', '--wait', '--', 'echo', 'got'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    waiter.stdout.on('data', chunk => { out += chunk; });
    waiter.stderr.on('data', chunk => { err += chunk; });
    const ended = new Promise(resolve => waiter.on('close', code => resolve(code)));
    const early = await Promise.race([ended, new Promise(resolve => setTimeout(() => resolve('waiting'), 500))]);
    assert.equal(early, 'waiting', `the waiter ended while the releaser ran: ${err}`);
    assert.match(err, /waiting for the exclusive lease .*ended, releaser \d+ running/s);
    releaser.kill('SIGKILL');
    assert.equal(await ended, 0, err);
    assert.equal(out, 'got\n');
    assert.match(err, /lease: took over the dead shared lease of pid \d+ \(dead\)/);
  } finally {
    releaser.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('a dead shared lease is taken over by any request, a dead exclusive one only by an exclusive request', () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-dead-'));
  try {
    const shared = join(root, 'shared');
    writeHolder(shared, 'shared-1-a.json', { kind: 'shared', pid: deadPid() });
    const exclusiveRun = spawnSync(lease, ['run', shared, 'exclusive', '--', 'echo', 'got'], { encoding: 'utf8' });
    assert.equal(exclusiveRun.status, 0, exclusiveRun.stderr);
    assert.equal(exclusiveRun.stdout, 'got\n');
    assert.match(exclusiveRun.stderr, /^lease: took over the dead shared lease of pid \d+ \(dead\)/);

    const exclusive = join(root, 'exclusive');
    writeHolder(exclusive, 'exclusive.json', { kind: 'exclusive', pid: deadPid() });
    const sharedRun = spawnSync(lease, ['run', exclusive, 'shared', '--wait', '--', 'echo', 'got'], { encoding: 'utf8' });
    assert.equal(sharedRun.status, 3, sharedRun.stdout + sharedRun.stderr);
    assert.match(sharedRun.stderr, /exclusive lease of pid \d+ \(dead\).*\nthe dead exclusive holder may have left the resource half made; the next exclusive holder takes its lease over and makes the resource again\n$/s);
    const takeover = spawnSync(lease, ['run', exclusive, 'exclusive', '--', 'echo', 'got'], { encoding: 'utf8' });
    assert.equal(takeover.status, 0, takeover.stderr);
    assert.match(takeover.stderr, /^lease: took over the dead exclusive lease of pid \d+ \(dead\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('hold records its releaser in the lease file before it returns', async () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-dead-'));
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const leases = join(root, 'leases');
    const held = spawnSync(lease, ['hold', leases, 'shared', '--pid', String(holder.pid)], { encoding: 'utf8' });
    assert.equal(held.status, 0, held.stderr);
    const files = readdirSync(leases).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1, files.join(' '));
    const record: unknown = JSON.parse(readFileSync(join(leases, files[0] ?? ''), 'utf8'));
    assert.ok(typeof record === 'object' && record !== null && 'pid' in record && 'releaser' in record && typeof record.releaser === 'number', JSON.stringify(record));
    assert.equal(record.pid, holder.pid);
    assert.ok(record.releaser > 0 && record.releaser !== holder.pid, JSON.stringify(record));
    process.kill(record.releaser, 0);
    holder.kill('SIGKILL');
    const after = spawnSync(lease, ['run', leases, 'exclusive', '--wait', '--', 'true'], { encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
    assert.doesNotMatch(after.stderr, /took over/, 'the releaser removed the lease itself');
  } finally {
    holder.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

// The shared database case checks that the server environment file names no bench database and creates no decimal
// database that the Makefile shares; scripts/check/databases.mts creates that database for each run.
caseTest('the server environment names no bench or decimal database that runs share', () => {
  const variables = environment(paths('/checkout'), { mysql: 1, postgres: 2, mysqlReplica: 3, postgresReplica: 4, proxysql: 5, pgbouncer: 6 });
  assert.deepEqual(Object.keys(variables).filter(name => /^(?:ORM_)?(?:BENCH|DECIMAL)_/.test(name)), [], 'the server environment names a shared bench or decimal database');
  assert.equal(variables['ORM_RUN_MYSQL_DSN'], 'mysql://root@127.0.0.1:1/orm_run?timezone=%2B00:00');
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');
  assert.match(makefile, /^DECIMAL_ENV =$/m, 'the Makefile names a shared decimal environment');
  assert.doesNotMatch(makefile, /^decimal-db-setup:/m, 'the Makefile sets up a shared decimal database');
});

// SQLite is a local file selected by its absolute-path DSN; the test-server provisioning has replicas only for
// MySQL and PostgreSQL and exposes no SQLite replica endpoint.
// Requirements: CFG-26.
caseTest('the test-server environment has no SQLite replica endpoint', () => {
  const variables = environment(paths('/checkout'), { mysql: 1, postgres: 2, mysqlReplica: 3, postgresReplica: 4, proxysql: 5, pgbouncer: 6 });
  assert.equal(variables['ORM_TEST_MYSQL_REPLICA_DSN'], 'mysql://root@127.0.0.1:3/orm_test');
  assert.equal(variables['ORM_TEST_POSTGRES_REPLICA_DSN'], 'postgres://orm@127.0.0.1:4/orm_test');
  assert.deepEqual(Object.keys(variables).filter(name => /SQLITE.*REPLICA|REPLICA.*SQLITE/.test(name)), []);
});

caseTest('PostgreSQL trusts only the orm login and requires SCRAM for other loopback roles', () => {
  assert.deepEqual(POSTGRES_HBA, [
    'host replication orm 127.0.0.1/32 trust',
    'host all orm 127.0.0.1/32 trust',
    'host all all 127.0.0.1/32 scram-sha-256',
  ]);
  assert.ok(POSTGRES_HBA.indexOf('host all orm 127.0.0.1/32 trust') < POSTGRES_HBA.indexOf('host all all 127.0.0.1/32 scram-sha-256'));
  assert.ok(POSTGRES_HBA.every(rule => !/^host all all .* trust$/.test(rule)));
});

caseTest('the MySQL primary has a positive localhost TLS DSN and the replica has a TCP hostname-mismatch DSN', () => {
  const variables = environment(paths('/checkout'), { mysql: 1, postgres: 2, mysqlReplica: 3, postgresReplica: 4, proxysql: 5, pgbouncer: 6 });
  const positiveTls = variables['ORM_TEST_MYSQL_TLS_DSN'];
  const mismatchTls = variables['ORM_TEST_MYSQL_TLS_MISMATCH_DSN'];
  assert.equal(MYSQL_TLS_SERVER_NAMES.mysql, 'DNS:localhost');
  assert.equal(MYSQL_TLS_SERVER_NAMES.mysqlReplica, 'DNS:orm-mismatch.invalid');
  assert.equal(MYSQL_TLS_MISMATCH_HOST, 'localhost.');
  assert.ok(positiveTls, 'the environment writes the positive MySQL TLS DSN');
  assert.ok(mismatchTls, 'the environment writes the intentional TLS mismatch DSN');
  assert.equal(new URL(positiveTls).hostname, 'localhost.');
  assert.equal(new URL(mismatchTls).hostname, MYSQL_TLS_MISMATCH_HOST);
  assert.equal(new URL(positiveTls).port, '1');
  assert.equal(new URL(mismatchTls).port, '3');
  assert.match(positiveTls, /ssl-mode=VERIFY_IDENTITY/);
  assert.match(mismatchTls, /ssl-mode=VERIFY_IDENTITY/);
});

caseTest('the PostgreSQL primary has a verified localhost TLS DSN and the replica has a hostname-mismatch DSN', () => {
  const p = paths('/checkout');
  const variables = environment(p, { mysql: 1, postgres: 2, mysqlReplica: 3, postgresReplica: 4, proxysql: 5, pgbouncer: 6 });
  const dsn = (name: string) => { const value = variables[name]; assert.ok(value, `the environment writes ${name}`); return new URL(value); };
  const [positive, otherCa, mismatch] = [dsn('ORM_TEST_POSTGRES_TLS_DSN'), dsn('ORM_TEST_POSTGRES_TLS_OTHER_CA_DSN'), dsn('ORM_TEST_POSTGRES_TLS_MISMATCH_DSN')];
  for (const url of [positive, otherCa, mismatch]) {
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  }
  assert.deepEqual([positive.port, otherCa.port, mismatch.port], ['2', '2', '4']);
  assert.deepEqual([positive, otherCa, mismatch].map(url => url.searchParams.get('sslrootcert')), [`${p.dir}/tls/ca.pem`, `${p.dir}/tls/other-ca.pem`, `${p.dir}/tls/ca.pem`]);
  assert.deepEqual(TLS_SERVERS.filter(([name]) => name.startsWith('postgres')), [['postgres', 'DNS:localhost,IP:127.0.0.1'], ['postgres-replica', 'DNS:orm-mismatch.invalid']]);
});

// The binary log retention case gives the retention options of MYSQLD_BINLOG that test-servers.mts passes to mysqld, with
// small values, to a fixture server on a temporary data directory and a free port, leaving the shared servers alone. The
// server removes expired binary logs only at start and when it rotates a log, so retention needs both an expiry and a
// rotation size. After one batch of writes and a wait longer than the expiry, another write must make the server remove
// the first file; if it stays, the case fails naming the file and why it stayed.
// The storage case (KSTD-5-88-5) checks the settings that bound what the servers keep: the redo log, undo and binary log
// of both mysqld, and the WAL of both PostgreSQL servers. A server that keeps the defaults takes 100 MiB of redo log per
// mysqld from its start and up to 1 GB of WAL per PostgreSQL server, in every checkout.
caseTest('the test servers keep small redo logs, binary logs and WAL', () => {
  for (const replica of [false, true]) {
    const args = mysqldArguments(paths('/checkout'), replica, 1);
    for (const flag of ['--innodb-redo-log-capacity=16777216', '--innodb-max-undo-log-size=16777216', '--max-binlog-size=16777216', '--binlog-expire-logs-seconds=3600', '--log-bin-trust-function-creators=ON'])
      assert.ok(args.includes(flag), `the mysqld ${replica ? 'replica' : 'primary'} does not take ${flag}: ${args.join(' ')}`);
  }
  assert.deepEqual(MYSQLD_STORAGE, ['--innodb-redo-log-capacity=16777216', '--innodb-max-undo-log-size=16777216']);
  assert.equal(typeof postgresArguments, 'function', 'scripts/test-servers.mts states no arguments of the PostgreSQL servers');
  assert.deepEqual(POSTGRES_WAL, ['min_wal_size=32MB', 'max_wal_size=64MB', 'wal_keep_size=0']);
  assert.deepEqual(postgresArguments('/data', 5432, true, '/tls'), ['-D', '/data', '-p', '5432', '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=',
    '-c', 'timezone=Asia/Seoul', '-c', 'ssl=on', '-c', 'ssl_cert_file=/tls/postgres-cert.pem', '-c', 'ssl_key_file=/tls/postgres-key.pem', '-c', 'synchronous_standby_names=orm_replica', '-c', 'synchronous_commit=local', '-c', 'min_wal_size=32MB', '-c', 'max_wal_size=64MB', '-c', 'wal_keep_size=0']);
  assert.deepEqual(postgresArguments('/replica', 5433, false, '/tls'), ['-D', '/replica', '-p', '5433', '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=',
    '-c', 'timezone=Asia/Seoul', '-c', 'ssl=on', '-c', 'ssl_cert_file=/tls/postgres-replica-cert.pem', '-c', 'ssl_key_file=/tls/postgres-replica-key.pem', '-c', 'min_wal_size=32MB', '-c', 'max_wal_size=64MB', '-c', 'wal_keep_size=0']);
});

caseTest('the MySQL privilege probe has a separate writable binlog server with trust creators off', () => {
  const p = paths('/checkout');
  const args = mysqlPrivilegeArguments(p, 3310);
  assert.ok(args.includes(`--datadir=${p.mysqlPrivilegeData}`));
  assert.ok(args.includes(`--pid-file=${p.mysqlPrivilegePid}`));
  assert.ok(args.includes(`--socket=${p.sockets.mysqlPrivilege}`));
  assert.ok(args.includes('--log-bin=binlog'));
  assert.ok(args.includes('--log-bin-trust-function-creators=OFF'));
  assert.ok(!args.includes('--log-bin-trust-function-creators=ON'));
  assert.ok(!args.includes('--read-only') && !args.includes('--super-read-only'));
  assert.deepEqual(MYSQLD_PRIVILEGE_BINLOG, ['--log-bin=binlog', '--binlog-expire-logs-seconds=3600', '--max-binlog-size=16777216', '--log-bin-trust-function-creators=OFF']);
});

caseTest('the test MySQL server removes an expired binary log by itself', async () => {
  const flags = MYSQLD_BINLOG;
  const expireFlag = flags.find(f => f.startsWith('--binlog-expire-logs-seconds='));
  const sizeFlag = flags.find(f => f.startsWith('--max-binlog-size='));
  // Fixture values: an expiry of 2 seconds and the smallest size mysqld accepts, 4096 bytes; no option outside the declaration.
  const EXPIRE_SECONDS = 2;
  const fixtureFlags = [`--binlog-expire-logs-seconds=${EXPIRE_SECONDS}`, ...(sizeFlag ? ['--max-binlog-size=4096'] : [])];
  const root = mkdtempSync(join(tmpdir(), 'orm-binlog-'));
  // A Unix socket path cannot exceed 104 bytes, so the socket goes in a short directory.
  const socketDir = mkdtempSync('/tmp/orm-binlog-');
  const port = await freePort();
  const mysql = (sql: string) => execFileSync('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', sql], { encoding: 'utf8' });
  const data = join(root, 'data');
  try {
    execFileSync('mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--log-error=${join(root, 'init.log')}`]);
    // --daemonize returns after the server accepts connections or fails.
    execFileSync('mysqld', ['--no-defaults', '--daemonize', `--datadir=${data}`, `--pid-file=${join(root, 'mysqld.pid')}`, `--log-error=${join(root, 'mysqld.log')}`,
      '--bind-address=127.0.0.1', `--port=${port}`, `--socket=${join(socketDir, 's')}`, '--mysqlx=OFF', '--server-id=1', ...MYSQLD_STORAGE, ...fixtureFlags]);
    mysql('CREATE DATABASE b; CREATE TABLE b.t (v VARCHAR(1024))');
    const burst = () => { for (let i = 0; i < 10; i++) mysql("INSERT INTO b.t VALUES (REPEAT('x', 1000))"); };
    burst();
    const first = (mysql('SHOW BINARY LOGS').trim().split('\n')[0] ?? '').split('\t');
    // The expiry counts from the file's last write; wait one second longer than it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (EXPIRE_SECONDS + 1) * 1000);
    burst();
    const logs = mysql('SHOW BINARY LOGS').trim().split('\n').map(l => l.split('\t')[0]);
    const size = mysql('SELECT @@max_binlog_size').trim();
    assert.ok(!logs.includes(first[0]),
      `${first[0]} (${first[1]} bytes, last written more than ${EXPIRE_SECONDS + 1} s ago) is kept past binlog_expire_logs_seconds=${EXPIRE_SECONDS}: ` +
      `the server removes expired logs only when it rotates the log, and max_binlog_size=${size} was never reached` +
      (expireFlag ? '' : '; scripts/test-servers.mts sets no --binlog-expire-logs-seconds') + (sizeFlag ? '' : '; scripts/test-servers.mts sets no --max-binlog-size'));
    // Both mysqld of the shared servers receive the same retention options.
    for (const replica of [false, true])
      assert.ok(MYSQLD_BINLOG.every(flag => mysqldArguments(paths('/checkout'), replica, 1).includes(flag)), `the mysqld ${replica ? 'replica' : 'primary'} does not take MYSQLD_BINLOG`);
  } finally {
    // mysqladmin shutdown over TCP returns before the server exits, and a server whose data directory is removed
    // while it shuts down never exits: InnoDB retries its redo log file in the missing directory and writes an
    // error for every try into its log, which fills the file system of the log. So the case stops the server
    // through STOP_PROCESS, which returns on the exit event of the process, and removes the directories only
    // after that; a server that does not stop fails the case and keeps its directories.
    const pidFile = join(root, 'mysqld.pid');
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim();
      const stopped = spawnSync(process.env.STOP_PROCESS ?? '', ['TERM', pid], { encoding: 'utf8' });
      assert.equal(stopped.status, 0, `the fixture mysqld ${pid} did not stop (STOP_PROCESS ${process.env.STOP_PROCESS ?? 'unset'}): ${stopped.error?.message ?? stopped.stderr}; ${root} is kept`);
      assert.ok(exited(Number(pid)), `mysqld ${pid} (state ${processState(Number(pid))}) still runs after STOP_PROCESS returned; ${root} is kept`);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});

// The replica WAL case (T218) makes a fixture PostgreSQL primary and replica on a temporary directory and free ports with
// the pg_basebackup arguments of test-servers.mts, leaving the shared servers alone. While the replica is stopped, the
// primary writes and switches WAL segments and checks points, so a primary that keeps no WAL for the replica removes the
// segments the replica still needs. The replica started again must stream, and a commit that waits for it must return.
caseTest('the test PostgreSQL replica streams again after the primary wrote WAL while it was stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-pgwal-'));
  const [primaryPort, replicaPort] = [await freePort(), await freePort()];
  const primary = join(root, 'primary');
  const replica = join(root, 'replica');
  const psql = (port: number, sql: string, timeout?: number) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'orm', '-d', 'postgres', '-c', sql],
    { encoding: 'utf8', timeout }).trim();
  // The PostgreSQL programs run with the environment of the server tool (postgresEnvironment), which sets the locale.
  const env = postgresEnvironment();
  // The servers take the TLS files of TLS_SERVERS, as the test servers do.
  const tlsDir = join(root, 'tls');
  issueTls(tlsDir, TLS_SERVERS);
  for (const [name] of TLS_SERVERS) chmodSync(join(tlsDir, `${name}-key.pem`), 0o600);
  // Both servers start with the arguments of test-servers.mts (postgresArguments), its WAL settings included.
  const start = (data: string, port: number, primary: boolean) => execFileSync('pg_ctl', ['-D', data, '-l', `${data}.log`, '-w', '-t', '60', '-o',
    postgresArguments(data, port, primary, tlsDir).slice(2).join(' '), 'start'], { stdio: 'ignore', env });
  const stop = (data: string) => { if (existsSync(join(data, 'postmaster.pid'))) execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore', env }); };
  try {
    execFileSync('initdb', ['-D', primary, '-U', 'orm', '--auth=trust', '--encoding=UTF8', '--locale=C'], { stdio: 'ignore', env });
    start(primary, primaryPort, true);
    execFileSync('pg_basebackup', postgresBaseBackupArguments(replica, primaryPort), { stdio: 'ignore', env });
    start(replica, replicaPort, false);
    psql(primaryPort, 'CREATE TABLE t (v text)');
    stop(replica);
    for (let i = 0; i < 8; i++) psql(primaryPort, "INSERT INTO t SELECT repeat('x', 1000) FROM generate_series(1, 2000); SELECT pg_switch_wal(); CHECKPOINT");
    start(replica, replicaPort, false);
    const state = psql(primaryPort, "SELECT coalesce((SELECT state FROM pg_stat_replication WHERE application_name = 'orm_replica'), 'absent')");
    let commit = 'returned';
    try { psql(primaryPort, "SET synchronous_commit = remote_apply; INSERT INTO t VALUES ('y')", 20_000); } catch (error) { commit = `did not return within 20 s (${(error instanceof Error ? error.message : String(error)).split('\n')[0]})`; }
    const log = readFileSync(`${replica}.log`, 'utf8').split('\n').filter(line => line.includes('has already been removed')).slice(0, 1).join('');
    assert.ok(commit === 'returned', `a synchronous commit ${commit}; the replica is ${state} in pg_stat_replication${log === '' ? '' : `, and logs: ${log}`}`);
    assert.equal(psql(primaryPort, "SELECT state FROM pg_stat_replication WHERE application_name = 'orm_replica'"), 'streaming');
  } finally {
    stop(replica);
    stop(primary);
    rmSync(root, { recursive: true, force: true });
  }
});

// The socket path case (T135) takes the paths of the servers of a long checkout. A Unix socket path must fit the sun_path
// limit (103 bytes on macOS, 107 on Linux, NUL excluded) and must not depend on the depth of the checkout.
caseTest('test server sockets stay within the Unix socket path limit for a long checkout', () => {
  const root = `/Users/someone/Projects/polyspec/${'a-very-long-worktree-name-'.repeat(4)}T135`;
  const sockets = Object.values(paths(root).sockets);
  // The MySQL primary, replica and privilege probe server, the three of the ProxySQL of MySQL, and the same six of MariaDB.
  assert.equal(sockets.length, 12);
  for (const socket of sockets) assert.ok(Buffer.byteLength(socket) <= 103, `socket path ${socket} is ${Buffer.byteLength(socket)} bytes; macOS allows at most 103`);
  // The same checkout gets the same directory, and another checkout another directory.
  assert.equal(paths(root).sockets.mysql, sockets[0]);
  assert.notEqual(paths(`${root}x`).sockets.mysql, sockets[0]);
});

// startLogged waits for its ready line by the events of its log and of its server, with no deadline (T390, FCV-18): a line
// that is already written when the server starts is seen, and a cancellation asks the server to end and waits for its exit.
const QUIET_SERVER = (marker: string): string => `const { writeFileSync } = require('node:fs'); const server = require('node:net').createServer().listen();
  process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'cleaned'); server.close(); }); console.log('started');`;

/** Runs body while the lines that startLogged forwards to the standard error are given to `line`. */
async function withForwarded(line: (text: string) => void, body: () => Promise<void>): Promise<void> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => { line(String(chunk)); return true; };
  try { await body(); } finally { process.stderr.write = originalWrite; }
}

caseTest('startLogged names what it waits for, and a cancellation asks its server to end and waits for its exit', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orm-startlogged-')));
  const log = join(dir, 'silent.log');
  const marker = join(dir, 'cleaned');
  const controller = new AbortController();
  const forwarded: string[] = [];
  try {
    await withForwarded(text => {
      forwarded.push(text);
      // The server has set its handler when its first line is forwarded: the case cancels the start then.
      if (text.includes('silent: started')) controller.abort(new Error('the case cancels the start'));
    }, async () => {
      await assert.rejects(
        startLogged(dir, 'silent', 'line-never-printed', process.execPath, ['-e', QUIET_SERVER(marker)], isolatedEnvironment(), controller.signal),
        (error: Error) => {
          assert.ok(error instanceof TestServerError);
          assert.match(error.message, /the start of silent was cancelled before it logged 'line-never-printed': the case cancels the start/);
          assert.ok(error.message.includes(log), error.message);
          return true;
        },
      );
    });
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned', 'the server ran its cleanup before the start was reported');
    assert.ok(forwarded.some(text => text.includes(`silent: waits for the line 'line-never-printed' with no time limit; its log is ${log}`)), forwarded.join(''));
    assert.ok(forwarded.some(text => /silent: sent SIGTERM to process group \d+ and waits for its exit with no time limit/.test(text)), forwarded.join(''));
  } finally {
    cleanupStartedChild(dir, 'silent');
  }
});

caseTest('startLogged keeps the cancellation and the failure of its request, and forwards no line after it settled', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orm-startlogged-cleanup-')));
  const originalKill = process.kill.bind(process);
  const denied = Object.assign(new Error('process group is not signalable'), { code: 'EPERM' });
  const controller = new AbortController();
  const forwarded: string[] = [];
  const sent: (NodeJS.Signals | number | undefined)[] = [];
  let closeLateWatcher: (() => void) | undefined;
  try {
    process.kill = (target: number, signal?: NodeJS.Signals | number) => {
      if (target < 0) { sent.push(signal); throw denied; }
      return originalKill(target, signal);
    };
    await withForwarded(text => {
      forwarded.push(text);
      if (text.includes('blocked: heartbeat')) controller.abort(new Error('the case cancels the start'));
    }, async () => {
      await assert.rejects(startLogged(dir, 'blocked', 'never-ready', process.execPath, ['-e', 'setInterval(() => console.log("heartbeat"), 25)'], isolatedEnvironment(), controller.signal), error => {
        assert.ok(error instanceof TestServerError);
        assert.match(error.message, /was cancelled before it logged 'never-ready'/);
        assert.match(error.message, /SIGTERM could not be sent to process group/);
        const cause = error.cause;
        assert.ok(cause instanceof AggregateError);
        assert.ok(cause.errors[0] instanceof Error);
        assert.match(cause.errors[0].message, /was cancelled before it logged 'never-ready'/);
        assert.strictEqual(cause.errors[1], denied);
        return true;
      });
      assert.deepEqual(sent, ['SIGTERM'], 'one request, and no SIGKILL after it');
      const countAtSettle = forwarded.length;
      const offset = statSync(join(dir, 'blocked.log')).size;
      await new Promise<void>(resolveLate => {
        const late = watch(join(dir, 'blocked.log'), () => {
          if (statSync(join(dir, 'blocked.log')).size > offset) { late.close(); closeLateWatcher = undefined; resolveLate(); }
        });
        closeLateWatcher = () => late.close();
        if (statSync(join(dir, 'blocked.log')).size > offset) { late.close(); closeLateWatcher = undefined; resolveLate(); }
      });
      assert.equal(forwarded.length, countAtSettle, 'the log watcher forwarded output after the start settled');
    });
  } finally {
    closeLateWatcher?.();
    process.kill = originalKill;
    cleanupStartedChild(dir, 'blocked');
  }
});

caseTest('startLogged resolves when the ready line is written at once, before its watcher is attached', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orm-startlogged-')));
  try {
    await startLogged(dir, 'early', 'ready-at-once', process.execPath, ['-e', "console.log('ready-at-once'); setInterval(() => {}, 1000)"], isolatedEnvironment());
  } finally {
    cleanupStartedChild(dir, 'early');
  }
});

// The replica SQL thread check of the start (G5.55-2). A fake mysql on PATH answers SHOW REPLICA STATUS: a running thread is
// not reported, and a stopped one is named with its state and its last error. No server is started.
const replicaStatus = (status: string): string => `#!/bin/sh
case "$*" in
  *"SHOW REPLICA STATUS"*) printf '${status}\\n' ;;
esac
exit 0
`;

caseTest('the start reports a stopped MySQL replica SQL thread with its last error, and accepts a running one', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'replica-sql-')));
  const savedPath = process.env.PATH;
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'mysql'), replicaStatus('Replica_IO_Running: Yes\\nReplica_SQL_Running: No\\nLast_SQL_Error: Error 1114 The table is full'));
    chmodSync(join(bin, 'mysql'), 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const stopped = servers.replicaSqlStopped(3306);
    assert.match(stopped ?? '', /Replica_SQL_Running: No/);
    assert.match(stopped ?? '', /Error 1114 The table is full/);
    writeFileSync(join(bin, 'mysql'), replicaStatus('Replica_IO_Running: Yes\\nReplica_SQL_Running: Yes\\nLast_SQL_Error: '));
    assert.equal(servers.replicaSqlStopped(3306), undefined);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Unix socket authenticates a client as 'orm'@'localhost', and the backends of ProxySQL as 'orm'@'127.0.0.1'; a running server takes the same statements (T343-7).
caseTest('the MySQL accounts of the user orm name both hosts and are idempotent', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    assert.ok(servers.ORM_ACCOUNTS_SQL.includes(`CREATE USER IF NOT EXISTS 'orm'@'${host}' IDENTIFIED BY 'orm';`), `no account for ${host}`);
    assert.ok(servers.ORM_ACCOUNTS_SQL.includes(`GRANT ALL ON *.* TO 'orm'@'${host}';`), `no grant for ${host}`);
  }
});

// A client that stops reading must not take the pooler down, and a client that disconnects must not leave its statement running (CFG-34, CFG-35, T343-13).
caseTest('the ProxySQL of the test servers declares the settings that CFG-34 and CFG-35 state', () => {
  const config = proxysqlConfig(paths('/checkout'), { mysql: 1, postgres: 2, mysqlReplica: 3, postgresReplica: 4, proxysql: 5, pgbouncer: 6 });
  const variables = config.slice(config.indexOf('mysql_variables='), config.indexOf('pgsql_variables='));
  assert.match(variables, /^ {2}threshold_resultset_size=65536$/m, 'mysql-threshold_resultset_size is not 64 KiB');
  assert.match(variables, /^ {2}kill_backend_connection_when_disconnect=true$/m, 'mysql-kill_backend_connection_when_disconnect is not declared');
});

// The case-socket DSN of the MySQL recipe cases (FCV-4, CFG-10) reads the primary's Unix socket from the environment file.
caseTest('the test-server environment writes the MySQL socket of the primary as ORM_TEST_MYSQL_SOCKET', () => {
  const p = paths('/checkout');
  const variables = environment(p, { mysql: 1, postgres: 2, mysqlReplica: 3, postgresReplica: 4, proxysql: 5, pgbouncer: 6 });
  assert.equal(variables.ORM_TEST_MYSQL_SOCKET, p.sockets.mysql, 'the environment does not write the primary socket');
});

// The MariaDB servers (scripts/test-servers-mariadb.mts) write every variable of MARIADB_VARIABLES and read their ports back; the
// replica refuses writes, the privilege probe server logs binary changes with trust-function-creators off and has no TLS files, and
// every server keeps a TCP client at 127.0.0.1 the user of that host.
caseTest('the MariaDB build leaves out the DTrace probes and records its options, so a build of other options is built again', () => {
  assert.ok(CMAKE_OPTIONS.includes('-DENABLE_DTRACE=OFF'), CMAKE_OPTIONS.join(' '));
  assert.equal(buildOptionsText(['-DA=1', '-DB=2']), '-DA=1\n-DB=2\n');
  assert.notEqual(buildOptionsText(CMAKE_OPTIONS), buildOptionsText(CMAKE_OPTIONS.filter(option => option !== '-DENABLE_DTRACE=OFF')));
});

caseTest('the MariaDB servers write their environment and give each role its settings', () => {
  const p = paths('/checkout');
  const ports = { mariadb: 1, mariadbReplica: 2, mariadbPrivilege: 3, proxysql: 4 };
  const variables = mariadbEnvironment(p, ports);
  assert.deepEqual(Object.keys(variables), MARIADB_VARIABLES);
  assert.equal(variables.ORM_TEST_MARIADB_SOCKET, p.sockets.mariadb);
  const text = Object.entries(variables).map(([name, value]) => `export ${name}='${value}'\n`).join('');
  assert.deepEqual(mariadbEnvironmentPorts(text, 'mariadb.env'), ports);
  assert.throws(() => mariadbEnvironmentPorts('', 'mariadb.env'), /records no port in ORM_TEST_MARIADB_SERVER_DSN/);
  const primary = mariadbdArguments(p, 'primary', 1);
  const replica = mariadbdArguments(p, 'replica', 2);
  const privilege = mariadbdArguments(p, 'privilege', 3);
  for (const args of [primary, replica, privilege]) assert.ok(args.includes('--skip-name-resolve'), args.join(' '));
  for (const args of [primary, replica, privilege]) assert.ok(args.includes('--thread-stack=1048576') && args.includes('--event-scheduler=ON'), args.join(' '));
  assert.ok(replica.includes('--slave-parallel-threads=4') && !primary.includes('--slave-parallel-threads=4'), replica.join(' '));
  assert.deepEqual([primary, replica, privilege].map(args => args.find(arg => arg.startsWith('--tmpdir='))), ['mariadb', 'mariadb-replica', 'mariadb-privilege'].map(name => `--tmpdir=${p.dir}/${name}-tmp`));
  for (const args of [primary, replica, privilege]) assert.ok(args.includes('--performance-schema=ON') && args.includes('--performance-schema-instrument=transaction=ON') && args.includes('--performance-schema-instrument=wait/lock/metadata/sql/mdl=ON'), args.join(' '));
  assert.ok(replica.includes('--read-only=ON') && !primary.includes('--read-only=ON') && !privilege.includes('--read-only=ON'));
  assert.ok(privilege.includes('--log-bin-trust-function-creators=OFF') && primary.includes('--log-bin-trust-function-creators=ON'));
  assert.ok(!privilege.some(arg => arg.startsWith('--ssl-')) && primary.some(arg => arg.startsWith('--ssl-ca=')));
  assert.deepEqual([primary, replica, privilege].map(args => args.find(arg => arg.startsWith('--server-id='))), ['--server-id=1', '--server-id=2', '--server-id=3']);
});
