// The tests of scripts/test-servers-container.mts (T444). They run the script against a stand-in container program that
// each test writes into its own directory: the program keeps one file per container under its state directory and
// prints the log lines of a ready MySQL server, so the tests need no container runtime and no image. Each test names
// two checkouts by two directories of its own.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { caseTest, COMPUTE, withTemporaryDirectory } from '../tests/testcase.mts';
import { containerName, remove, run, start, type Context } from './test-servers-container.mts';
import { ORM_ACCOUNTS_SQL, REPLICA_PARTIAL_REVOKES_SQL } from './test-servers.mts';

// standIn writes the stand-in container program into dir and returns its path and the directory of its containers. Its
// run is attached, as the script runs the container: it records the container with its process ID, prints the log lines
// of a ready MySQL server and runs until stop ends that process. Each exec appends its container and its command to the
// file exec.log of its directory.
//
// A run connects to the Unix socket lifeline and ends when that connection closes, so that no stand-in outlives the
// process that listens on lifeline, also when the runner ends that process at its deadline: the kernel closes each
// connection of a process that dies. removing listens on it for the test, unless hold is false and a process of the test
// listens. A run also connects to the Unix socket alive when a test listens on it, and writes its ready lines once the
// test answered, so the test knows each run and sees its end as the end of its connection. hold runs no server and only
// connects to lifeline, so the shell stand-in of a test stays until its lifeline closes.
interface StandIn { program: string; state: string; lifeline: string; alive: string; hold: boolean }

function standIn(dir: string, { hold = true }: { hold?: boolean } = {}): StandIn {
  const state = join(dir, 'containers');
  mkdirSync(state, { recursive: true });
  const [lifeline, alive] = [join(dir, 'lifeline'), join(dir, 'alive')];
  const program = join(dir, 'container.mjs');
  writeFileSync(program, `#!${process.execPath}
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
const state = ${JSON.stringify(state)};
const holdLifeline = () => connect(${JSON.stringify(lifeline)}).on('close', () => process.exit(0)).on('error', () => {});
const execs = ${JSON.stringify(join(dir, 'exec.log'))};
const [command, ...rest] = process.argv.slice(2);
const named = name => { if (!existsSync(join(state, name))) { console.error('container ' + name + ' does not exist'); process.exit(1); } };
if (command === 'list') console.log(JSON.stringify(readdirSync(state).map(id => ({ configuration: { id } }))));
else if (command === 'run') {
  const name = rest[rest.indexOf('--name') + 1];
  if (existsSync(join(state, name))) { console.error('container ' + name + ' exists'); process.exit(1); }
  writeFileSync(join(state, name), String(process.pid));
  process.on('SIGTERM', () => process.exit(0));
  holdLifeline();
  let said = false;
  const ready = () => {
    if (said) return;
    said = true;
    console.log('MySQL init process done. Ready for start up.');
    console.log('[Server] /usr/sbin/mysqld: ready for connections. Version: 8.4.11  socket: /var/run/mysqld/mysqld.sock  port: 3306');
  };
  connect(${JSON.stringify(alive)}).on('data', ready).on('error', ready);
  setInterval(() => {}, 2 ** 30);
} else if (command === 'hold') holdLifeline(); else if (command === 'exec') { named(rest[0]); appendFileSync(execs, JSON.stringify(rest) + '\\n'); }
else if (command === 'stop') {
  named(rest[0]);
  const pid = Number(readFileSync(join(state, rest[0]), 'utf8'));
  // A container that ended already is stopped, as container stop takes it.
  try { if (pid > 0) process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
else if (command === 'inspect') { named(rest[0]); console.log(JSON.stringify([{ status: { networks: [{ ipv4Address: '192.168.64.9/24' }] } }])); }
else if (command === 'delete') { named(rest[0]); rmSync(join(state, rest[0])); }
else { console.error('unknown command ' + command); process.exit(2); }
`);
  chmodSync(program, 0o755);
  return { program, state, lifeline, alive, hold };
}

// Listener is a Unix socket server of a test: it counts the connections it accepted, answers each when greet is set,
// and its idle resolves once no accepted connection is open.
interface Listener { accepted: () => number; idle: () => Promise<void>; close: () => Promise<void> }

async function listen(path: string, greet: boolean): Promise<Listener> {
  const open = new Set<Socket>();
  let accepted = 0;
  let waiting: (() => void)[] = [];
  const server = createServer(socket => {
    accepted += 1;
    open.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      open.delete(socket);
      if (open.size === 0) { for (const resolveIdle of waiting) resolveIdle(); waiting = []; }
    });
    if (greet) socket.write('ok');
  });
  await new Promise<void>((resolveListening, rejectListening) => server.once('error', rejectListening).listen(path, resolveListening));
  return {
    accepted: () => accepted,
    idle: () => open.size === 0 ? Promise.resolve() : new Promise(resolveIdle => { waiting.push(resolveIdle); }),
    close: () => {
      for (const socket of open) socket.destroy();
      return new Promise(resolveClosed => server.close(() => resolveClosed()));
    },
  };
}

// strings is the JSON list of strings of a line of exec.log.
function strings(line: string): string[] {
  const parsed: unknown = JSON.parse(line);
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) throw new Error(`exec.log holds no list of strings: ${line}`);
  return parsed;
}

// removing listens on the lifeline of the stand-in, runs the body of a test and then removes the containers of its
// checkouts and closes the lifeline, also when the body fails, so that no process of the stand-in outlives the test.
async function removing(stand: StandIn, contexts: Context[], body: () => Promise<void>): Promise<void> {
  const lifeline = stand.hold ? await listen(stand.lifeline, false) : undefined;
  try {
    await body();
  } finally {
    try {
      for (const context of contexts) remove(context);
    } finally {
      await lifeline?.close();
    }
  }
}

const checkouts = (dir: string, program: string): [Context, Context] => {
  const [first, second] = [join(dir, 'first'), join(dir, 'second')];
  for (const root of [first, second]) mkdirSync(root, { recursive: true });
  return [{ root: first, program }, { root: second, program }];
};

caseTest('two checkouts start a server of the same kind at once, each in a container of its own (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const { program, state } = stand;
    const [first, second] = checkouts(dir, program);
    await removing(stand, [first, second], async () => {
      // A container of another name, such as one that an earlier form of the script started, is never touched.
      writeFileSync(join(state, 'polyspec-orm-test-mysql'), '0');
      assert.notEqual(containerName(first.root, 'mysql'), containerName(second.root, 'mysql'));
      await Promise.all([start('mysql', first), start('mysql', second)]);
      const both = (root: string) => [containerName(root, 'mysql'), `${containerName(root, 'mysql')}-replica`];
      assert.deepEqual(readdirSync(state).sort(), [...both(first.root), ...both(second.root), 'polyspec-orm-test-mysql'].sort());
      for (const { root } of [first, second]) assert.ok(existsSync(join(root, '.runtime/containers/mysql.env')), `${root} has no environment file`);
      remove(first);
      assert.deepEqual(readdirSync(state).sort(), [...both(second.root), 'polyspec-orm-test-mysql'].sort());
      assert.ok(!existsSync(join(first.root, '.runtime/containers/mysql.env')), 'remove leaves the environment file of its checkout');
      assert.ok(existsSync(join(second.root, '.runtime/containers/mysql.env')), 'remove of one checkout removes the environment file of another');
      remove(second);
      assert.deepEqual(readdirSync(state), ['polyspec-orm-test-mysql']);
    });
  }));

caseTest('a start of MySQL starts its replica, which follows the primary from the first binary log, before the databases (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const { program } = stand;
    const [context] = checkouts(dir, program);
    await removing(stand, [context], async () => {
      const primary = containerName(context.root, 'mysql');
      const replica = `${primary}-replica`;
      const variables = await start('mysql', context);
      assert.equal(variables['ORM_TEST_MYSQL_REPLICA_DSN'], 'mysql://root@192.168.64.9:3306/orm_test');
      assert.match(readFileSync(join(context.root, '.runtime/containers/mysql.env'), 'utf8'), /^export ORM_TEST_MYSQL_REPLICA_DSN='mysql:\/\/root@192\.168\.64\.9:3306\/orm_test'$/m);
      const execs = readFileSync(join(dir, 'exec.log'), 'utf8').trim().split('\n').map(strings);
      assert.deepEqual(execs.map(([name, , , , sql]) => [name, sql?.split(';')[0]]), [
        [primary, 'RESET BINARY LOGS AND GTIDS'],
        [replica, "CHANGE REPLICATION SOURCE TO SOURCE_HOST='192.168.64.9', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1"],
        [primary, 'CREATE DATABASE orm_test'],
      ], 'the replica does not follow the primary before the databases are created');
      // As the native servers have them: the replica refuses a catalog row change through partial_revokes (INT-119), and the
      // primary has the accounts of the user orm.
      const [, replicaSql, databasesSql] = execs.map(([, , , , sql]) => sql ?? '');
      assert.ok(replicaSql?.includes(REPLICA_PARTIAL_REVOKES_SQL), `the replica does not enable partial_revokes: ${replicaSql}`);
      assert.ok(databasesSql?.includes(ORM_ACCOUNTS_SQL), `the primary has no accounts of the user orm: ${databasesSql}`);
      remove(context);
    });
  }));

caseTest('a run removes its container when its command ends, fails or gets SIGINT or SIGTERM (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const { program, state } = stand;
    const [context] = checkouts(dir, program);
    await removing(stand, [context], async () => {
      const node = process.execPath;
      const ended = await run('mysql', [node, '-e', 'if (!process.env.ORM_TEST_MYSQL_DSN) process.exit(9)'], context);
      assert.deepEqual(ended, { code: 0, signal: null }, 'the command does not read the DSN of its server');
      assert.deepEqual(readdirSync(state), [], 'a run that ended leaves its container');
      const failed = await run('mysql', [node, '-e', 'process.exit(3)'], context);
      assert.deepEqual(failed, { code: 3, signal: null });
      assert.deepEqual(readdirSync(state), [], 'a run that failed leaves its container');
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const signals = new EventEmitter();
        // The run calls started once its command has spawned; the test sends the signal then, and the run forwards it.
        const waiting = run('mysql', [node, '-e', 'setInterval(() => {}, 2 ** 30)'], context, {
          signals, started: () => signals.emit(signal),
        });
        assert.deepEqual(await waiting, { code: null, signal }, `a run that got ${signal} does not end its command with it`);
        assert.deepEqual(readdirSync(state), [], `a run that got ${signal} leaves its container`);
        assert.ok(!existsSync(join(context.root, '.runtime/containers/mysql.env')), `a run that got ${signal} leaves its environment file`);
      }
    });
  }));

caseTest('a start that fails removes the container that it started (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const { program, state } = stand;
    const [context] = checkouts(dir, program);
    await removing(stand, [context], async () => {
      // This stand-in records the container, and its attached run ends without the line of a ready server, so the start fails.
      writeFileSync(join(dir, 'container.mjs'), `#!${process.execPath}
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = ${JSON.stringify(state)};
const [command, ...rest] = process.argv.slice(2);
if (command === 'list') console.log(JSON.stringify(readdirSync(state).map(id => ({ configuration: { id } }))));
else if (command === 'run') { writeFileSync(join(state, rest[rest.indexOf('--name') + 1]), '0'); console.log('the server stopped'); process.exit(1); }
else if (command === 'stop') {}
else if (command === 'delete') rmSync(join(state, rest[0]));
else process.exit(2);
`);
      await assert.rejects(start('mysql', context), /stopped with 1 before it was ready/);
      assert.deepEqual(readdirSync(state), [], 'a failed start leaves its container');
    });
  }));

caseTest('a start reads the lines that the container writes before the watch of its log takes effect (T445)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir);
    const { state } = stand;
    const [context] = checkouts(dir, join(dir, 'container.sh'));
    await removing(stand, [context], async () => {
      const written = join(dir, 'written');
      execFileSync('mkfifo', [written]);
      // The run of this stand-in writes both lines, tells the test through the FIFO written, and then stays quiet, as a
      // server does after its ready line, by holding the lifeline of the stand-in in the same process, until stop ends its
      // process or the test closes the lifeline. Only the primary tells the test, which reads written once; the
      // replica writes its lines when the test no longer waits.
      writeFileSync(join(dir, 'container.sh'), `#!/bin/sh
state=${JSON.stringify(state)}
command=$1; shift
case $command in
  run)
    name=; previous=
    for argument in "$@"; do [ "$previous" = --name ] && name=$argument; previous=$argument; done
    printf '%s' $$ > "$state/$name"
    printf 'MySQL init process done. Ready for start up.\\n[Server] /usr/sbin/mysqld: ready for connections. Version: 8.4.11  port: 3306\\n'
    case $name in *-replica) ;; *) printf 'written' > ${JSON.stringify(written)} ;; esac
    exec ${JSON.stringify(join(dir, 'container.mjs'))} hold ;;
  *) exec ${JSON.stringify(join(dir, 'container.mjs'))} "$command" "$@" ;;
esac
`);
      chmodSync(join(dir, 'container.sh'), 0o755);
      const started = start('mysql', context);
      // The spawn of the container queued its spawn event before this tick, so the start has read the empty log when this
      // tick runs, and the poll phase that registers the watch of the log comes after it: the tick holds the loop until the
      // stand-in has written its lines, so they come before the watch takes effect.
      process.nextTick(() => readFileSync(written, 'utf8'));
      await started;
      assert.deepEqual(readdirSync(state).sort(), [containerName(context.root, 'mysql'), `${containerName(context.root, 'mysql')}-replica`].sort());
      remove(context);
      assert.deepEqual(readdirSync(state), []);
    });
  }));

caseTest('the stand-in containers end when the process that started them dies without removing them (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const stand = standIn(dir, { hold: false });
    const [context] = checkouts(dir, stand.program);
    await removing(stand, [context], async () => {
      // The test listens on alive, so it knows each run; the driver listens on the lifeline, starts MySQL, says so, and
      // waits. SIGKILL ends it as the runner ends a test process at its deadline, so no finally of its own removes the
      // containers.
      const alive = await listen(stand.alive, true);
      try {
        const driver = spawn(process.execPath, ['--input-type=module', '-e', `
import { createServer } from 'node:net';
import { start } from ${JSON.stringify(join(import.meta.dirname, 'test-servers-container.mts'))};
await new Promise(resolve => createServer().listen(${JSON.stringify(stand.lifeline)}, resolve));
await start('mysql', ${JSON.stringify(context)});
process.stdout.write('started\\n');
setInterval(() => {}, 2 ** 30);
`], { stdio: ['ignore', 'pipe', 'inherit'] });
        const exited = once(driver, 'exit');
        let output = '';
        driver.stdout.setEncoding('utf8');
        await new Promise<void>((resolveStarted, rejectStarted) => {
          driver.stdout.on('data', (chunk: string) => { output += chunk; if (output.includes('started\n')) resolveStarted(); });
          void exited.then(([code, signal]) => rejectStarted(new Error(`the driver ended with ${String(code ?? signal)} before it started MySQL: ${output}`)));
        });
        // Each run writes its ready lines after the test answered its connection, so the start has its runs counted.
        assert.equal(alive.accepted(), readdirSync(stand.state).length, 'a run of the stand-in did not connect to alive');
        driver.kill('SIGKILL');
        await exited;
        await alive.idle();
      } finally {
        await alive.close();
      }
      const running = readdirSync(stand.state).filter(name => {
        try {
          process.kill(Number(readFileSync(join(stand.state, name), 'utf8')), 0);
          return true;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
          throw error;
        }
      });
      assert.deepEqual(running, [], 'a stand-in container outlived the process that started it');
    });
  }));
