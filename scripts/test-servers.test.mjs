// The stop tests of scripts/test-servers.sh. make test-servers-check builds tests/stop-process and tests/lease and passes
// their paths as STOP_PROCESS and LEASE.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { isolatedEnvironment } from '../tests/environment.mjs';
import { caseTest, COMPUTE, DATABASE } from '../tests/testcase.mjs';

// The stop_pid case takes stop_pid of test-servers.sh as it is and stops a fake server. Stopping a server is a long task,
// so it has no deadline, and its end is learned from the operating system's exit event, not by polling. A slow but sound
// server that ends 1.5 seconds after TERM is reported stopped after that, when its process is already gone.
caseTest('stop_pid waits for the exit event of the server, with no polling', COMPUTE, () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('stop_pid() {');
  const body = script.slice(start, script.indexOf('\n}\n', start) + 3);
  assert.ok(start >= 0 && body.endsWith('}\n'), 'stop_pid is absent from scripts/test-servers.sh');
  assert.doesNotMatch(body, /\bsleep\b|\bwhile\b|\buntil\b|kill -0/, 'stop_pid polls for the exit');
  assert.match(body, /"\$\{STOP_PROCESS:\?/, 'stop_pid does not run the Go program STOP_PROCESS of tests/stop-process');
  const stopProcess = process.env.STOP_PROCESS;
  assert.ok(stopProcess, 'STOP_PROCESS is unset; run make test-servers-check, which builds it');
  const dir = mkdtempSync(join(tmpdir(), 'orm-stop-'));
  try {
    for (const [name, delay] of [['quick', 0], ['slow', 1.5]]) {
      // The server sets its TERM trap, then writes ready to the FIFO; the outer shell reads that write to learn the start.
      const pidFile = join(dir, `${name}.pid`), ready = join(dir, `${name}.ready`);
      const server = spawnSync('sh', ['-c', `mkfifo ${ready}
sh -c 'trap "sleep ${delay}; kill \\$child; exit 0" TERM; sleep 30 & child=$!; echo ready > ${ready}; wait' >/dev/null 2>&1 &
echo $! > ${pidFile}
read state < ${ready}`], { timeout: 10_000 });
      assert.equal(server.status, 0, String(server.stderr));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      const started = Date.now();
      const stopped = spawnSync('sh', ['-c', `set -eu\nSTOP_PROCESS=${stopProcess}\n${body}\nstop_pid ${pidFile}\necho stopped`], { encoding: 'utf8', timeout: 20_000 });
      const elapsed = Date.now() - started;
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(stopped.stdout, 'stopped\n');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${name} server still runs after stop_pid`);
      assert.ok(elapsed >= delay * 1000, `${name} server reported stopped after ${elapsed} ms, before its ${delay} s shutdown`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The lease case copies the scripts of this checkout to a temporary root and checks that, while another run holds the
// server's shared lease, `test-servers.sh stop` refuses naming that holder and keeps the server directory, and that the
// stop proceeds once the hold ends. The holder is a shell that waits reading a FIFO; ready and end go through FIFOs.
caseTest('stopping the test servers is refused while another run holds a lease, naming the holder', COMPUTE, () => {
  const { LEASE: lease, STOP_PROCESS: stopProcess } = process.env;
  assert.ok(lease && stopProcess, 'LEASE or STOP_PROCESS is unset; run make test-servers-check, which builds them');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-'));
  const release = join(root, 'release');
  const ready = join(root, 'ready');
  const leases = join(root, '.runtime/servers.leases');
  let holder;
  const stop = () => spawnSync('sh', [join(root, 'scripts/test-servers.sh'), 'stop'], { encoding: 'utf8', env: isolatedEnvironment({ LEASE: lease, STOP_PROCESS: stopProcess }) });
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('./test-servers.sh', import.meta.url), join(root, 'scripts/test-servers.sh'));
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
caseTest('children of an exclusive holder share its lease one exclusive holder at a time', COMPUTE, () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make test-servers-check, which builds it');
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
function writeHolder(dir, name, fields) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ checkout: '/x', started: '2026-10-06T00:00:00Z', command: 'make x', ...fields }));
}

caseTest('an ended holder whose releaser still runs is waited for, and taken over when the releaser ends without removing it', COMPUTE, async () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make test-servers-check, which builds it');
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

caseTest('a dead shared lease is taken over by any request, a dead exclusive one only by an exclusive request', COMPUTE, () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make test-servers-check, which builds it');
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

caseTest('hold records its releaser in the lease file before it returns', COMPUTE, async () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-dead-'));
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const leases = join(root, 'leases');
    const held = spawnSync(lease, ['hold', leases, 'shared', '--pid', String(holder.pid)], { encoding: 'utf8' });
    assert.equal(held.status, 0, held.stderr);
    const files = readdirSync(leases).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1, files.join(' '));
    const record = JSON.parse(readFileSync(join(leases, files[0]), 'utf8'));
    assert.equal(record.pid, holder.pid);
    assert.ok(record.releaser > 0 && record.releaser !== holder.pid, JSON.stringify(record));
    process.kill(record.releaser, 0);
    holder.kill('SIGKILL');
    const after = spawnSync(lease, ['run', leases, 'exclusive', '--wait', '--', 'true'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(after.status, 0, after.stderr);
    assert.doesNotMatch(after.stderr, /took over/, 'the releaser removed the lease itself');
  } finally {
    holder.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

// The shared database case checks that the server environment file names no bench database and creates no decimal
// database that the Makefile shares; scripts/check/databases.sh creates that database for each run.
caseTest('the server environment names no bench or decimal database that runs share', COMPUTE, () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('write_env() {');
  const writeEnv = script.slice(start, script.indexOf('\n}\n', start));
  assert.ok(start >= 0, 'write_env is absent from scripts/test-servers.sh');
  assert.doesNotMatch(writeEnv, /export (?:ORM_)?BENCH_[A-Z_]*=/, 'the server environment names a shared bench database');
  assert.match(writeEnv, /export ORM_RUN_MYSQL_DSN='\$mysql\/orm_run\?timezone=%2B00:00'/);
  assert.doesNotMatch(script, /bench-db\.sh/, 'make test-servers seeds a shared bench database');
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');
  assert.match(makefile, /^DECIMAL_ENV =$/m, 'the Makefile names a shared decimal environment');
  assert.doesNotMatch(makefile, /^decimal-db-setup:/m, 'the Makefile sets up a shared decimal database');
});

// The binary log retention case gives the retention options of MYSQLD_BINLOG that test-servers.sh passes to mysqld, with
// small values, to a fixture server on a temporary data directory and a free port, leaving the shared servers alone. The
// server removes expired binary logs only at start and when it rotates a log, so retention needs both an expiry and a
// rotation size. After one batch of writes and a wait longer than the expiry, another write must make the server remove
// the first file; if it stays, the case fails naming the file and why it stayed.
caseTest('the test MySQL server removes an expired binary log by itself', DATABASE, async () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const declared = /^MYSQLD_BINLOG="([^"]*)"$/m.exec(script)?.[1] ?? '';
  const flags = declared.split(/\s+/).filter(Boolean);
  const expireFlag = flags.find(f => f.startsWith('--binlog-expire-logs-seconds='));
  const sizeFlag = flags.find(f => f.startsWith('--max-binlog-size='));
  // Fixture values: an expiry of 2 seconds and the smallest size mysqld accepts, 4096 bytes; no option outside the declaration.
  const EXPIRE_SECONDS = 2;
  const fixtureFlags = [`--binlog-expire-logs-seconds=${EXPIRE_SECONDS}`, ...(sizeFlag ? ['--max-binlog-size=4096'] : [])];
  const root = mkdtempSync(join(tmpdir(), 'orm-binlog-'));
  // A Unix socket path cannot exceed 104 bytes, so the socket goes in a short directory.
  const socketDir = mkdtempSync('/tmp/orm-binlog-');
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port: p } = server.address(); server.close(() => resolve(p)); });
  });
  const mysql = sql => execFileSync('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', sql], { encoding: 'utf8' });
  const data = join(root, 'data');
  try {
    execFileSync('mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--log-error=${join(root, 'init.log')}`]);
    // --daemonize returns after the server accepts connections or fails.
    execFileSync('mysqld', ['--no-defaults', '--daemonize', `--datadir=${data}`, `--pid-file=${join(root, 'mysqld.pid')}`, `--log-error=${join(root, 'mysqld.log')}`,
      '--bind-address=127.0.0.1', `--port=${port}`, `--socket=${join(socketDir, 's')}`, '--mysqlx=OFF', '--server-id=1', ...fixtureFlags]);
    mysql('CREATE DATABASE b; CREATE TABLE b.t (v VARCHAR(1024))');
    const burst = () => { for (let i = 0; i < 10; i++) mysql("INSERT INTO b.t VALUES (REPEAT('x', 1000))"); };
    burst();
    const first = mysql('SHOW BINARY LOGS').trim().split('\n')[0].split('\t');
    // The expiry counts from the file's last write; wait one second longer than it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (EXPIRE_SECONDS + 1) * 1000);
    burst();
    const logs = mysql('SHOW BINARY LOGS').trim().split('\n').map(l => l.split('\t')[0]);
    const size = mysql('SELECT @@max_binlog_size').trim();
    assert.ok(!logs.includes(first[0]),
      `${first[0]} (${first[1]} bytes, last written more than ${EXPIRE_SECONDS + 1} s ago) is kept past binlog_expire_logs_seconds=${EXPIRE_SECONDS}: ` +
      `the server removes expired logs only when it rotates the log, and max_binlog_size=${size} was never reached` +
      (expireFlag ? '' : '; scripts/test-servers.sh sets no --binlog-expire-logs-seconds') + (sizeFlag ? '' : '; scripts/test-servers.sh sets no --max-binlog-size'));
    // Both mysqld of the shared servers receive the same retention options.
    for (const command of ['--server-id=1', '--server-id=2']) {
      const line = script.split('\n').findIndex(l => l.includes(command));
      assert.ok(line >= 0 && /\$MYSQLD_BINLOG\b/.test(script.split('\n').slice(line - 2, line + 1).join('\n')), `the mysqld with ${command} in scripts/test-servers.sh does not take $MYSQLD_BINLOG`);
    }
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
      assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' }, `mysqld ${pid} still runs after STOP_PROCESS returned; ${root} is kept`);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});

// The socket path case (T135) evaluates the path declarations of test-servers.sh with a long checkout path. A Unix socket
// path must fit the sun_path limit (103 bytes on macOS, 107 on Linux, NUL excluded) and must not depend on the depth of the checkout.
caseTest('test server sockets stay within the Unix socket path limit for a long checkout', COMPUTE, () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('\nDIR=');
  const declarations = script.slice(start, script.indexOf('\nusage() {', start));
  const root = `/Users/someone/Projects/polyspec/${'a-very-long-worktree-name-'.repeat(4)}T135`;
  const run = spawnSync('sh', ['-c', `set -eu\nROOT='${root}'\n${declarations}\nfor s in "$MYSQL_SOCKET" "$MYSQL_REPLICA_SOCKET" "$PROXYSQL_ADMIN_SOCKET" "$PROXYSQL_ADMIN_PGSQL_SOCKET" "$PROXYSQL_PGSQL_SOCKET"; do echo "$s"; done`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const sockets = run.stdout.trim().split('\n');
  assert.equal(sockets.length, 5);
  for (const socket of sockets) assert.ok(Buffer.byteLength(socket) <= 103, `socket path ${socket} is ${Buffer.byteLength(socket)} bytes; macOS allows at most 103`);
  // The same checkout gets the same directory, and another checkout another directory.
  const again = spawnSync('sh', ['-c', `set -eu\nROOT='${root}'\n${declarations}\necho "$MYSQL_SOCKET"`], { encoding: 'utf8' });
  assert.equal(again.stdout.trim(), sockets[0]);
  const other = spawnSync('sh', ['-c', `set -eu\nROOT='${root}x'\n${declarations}\necho "$MYSQL_SOCKET"`], { encoding: 'utf8' });
  assert.notEqual(other.stdout.trim(), sockets[0]);
});
