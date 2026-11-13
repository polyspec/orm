// The tests of scripts/test-servers-container.mts (T444). They run the script against a stand-in container program that
// each test writes into its own directory: the program keeps one file per container under its state directory and
// prints the log lines of a ready MySQL server, so the tests need no container runtime and no image. Each test names
// two checkouts by two directories of its own.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { caseTest, COMPUTE, withTemporaryDirectory } from '../tests/testcase.mts';
import { containerName, remove, run, start, type Context } from './test-servers-container.mts';

// standIn writes the stand-in container program into dir and returns its path and the directory of its containers. Its
// run is attached, as the script runs the container: it records the container with its process ID, prints the log lines
// of a ready MySQL server and runs until stop ends that process. Each exec appends its container and its command to the
// file exec.log of its directory.
function standIn(dir: string): { program: string; state: string } {
  const state = join(dir, 'containers');
  mkdirSync(state, { recursive: true });
  const program = join(dir, 'container.mjs');
  writeFileSync(program, `#!${process.execPath}
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = ${JSON.stringify(state)};
const execs = ${JSON.stringify(join(dir, 'exec.log'))};
const [command, ...rest] = process.argv.slice(2);
const named = name => { if (!existsSync(join(state, name))) { console.error('container ' + name + ' does not exist'); process.exit(1); } };
if (command === 'list') console.log(JSON.stringify(readdirSync(state).map(id => ({ configuration: { id } }))));
else if (command === 'run') {
  const name = rest[rest.indexOf('--name') + 1];
  if (existsSync(join(state, name))) { console.error('container ' + name + ' exists'); process.exit(1); }
  writeFileSync(join(state, name), String(process.pid));
  process.on('SIGTERM', () => process.exit(0));
  console.log('MySQL init process done. Ready for start up.');
  console.log('[Server] /usr/sbin/mysqld: ready for connections. Version: 8.4.11  socket: /var/run/mysqld/mysqld.sock  port: 3306');
  setInterval(() => {}, 2 ** 30);
} else if (command === 'exec') { named(rest[0]); appendFileSync(execs, JSON.stringify(rest) + '\\n'); }
else if (command === 'stop') { named(rest[0]); const pid = Number(readFileSync(join(state, rest[0]), 'utf8')); if (pid > 0) process.kill(pid, 'SIGTERM'); }
else if (command === 'inspect') { named(rest[0]); console.log(JSON.stringify([{ status: { networks: [{ ipv4Address: '192.168.64.9/24' }] } }])); }
else if (command === 'delete') { named(rest[0]); rmSync(join(state, rest[0])); }
else { console.error('unknown command ' + command); process.exit(2); }
`);
  chmodSync(program, 0o755);
  return { program, state };
}

const checkouts = (dir: string, program: string): [Context, Context] => {
  const [first, second] = [join(dir, 'first'), join(dir, 'second')];
  for (const root of [first, second]) mkdirSync(root, { recursive: true });
  return [{ root: first, program }, { root: second, program }];
};

caseTest('two checkouts start a server of the same kind at once, each in a container of its own (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const { program, state } = standIn(dir);
    const [first, second] = checkouts(dir, program);
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
  }));

caseTest('a start of MySQL starts its replica, which follows the primary from the first binary log, before the databases (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const { program } = standIn(dir);
    const [context] = checkouts(dir, program);
    const primary = containerName(context.root, 'mysql');
    const replica = `${primary}-replica`;
    const variables = await start('mysql', context);
    assert.equal(variables['ORM_TEST_MYSQL_REPLICA_DSN'], 'mysql://root@192.168.64.9:3306/orm_test');
    assert.match(readFileSync(join(context.root, '.runtime/containers/mysql.env'), 'utf8'), /^export ORM_TEST_MYSQL_REPLICA_DSN='mysql:\/\/root@192\.168\.64\.9:3306\/orm_test'$/m);
    const execs = readFileSync(join(dir, 'exec.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.deepEqual(execs.map(([name, , , , sql]) => [name, sql?.split(';')[0]]), [
      [primary, 'RESET BINARY LOGS AND GTIDS'],
      [replica, "CHANGE REPLICATION SOURCE TO SOURCE_HOST='192.168.64.9', SOURCE_PORT=3306, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1"],
      [primary, 'CREATE DATABASE orm_test'],
    ], 'the replica does not follow the primary before the databases are created');
    remove(context);
  }));

caseTest('a run removes its container when its command ends, fails or gets SIGINT or SIGTERM (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const { program, state } = standIn(dir);
    const [context] = checkouts(dir, program);
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
  }));

caseTest('a start that fails removes the container that it started (T444)', COMPUTE, () =>
  withTemporaryDirectory('orm-containers-', async dir => {
    const { program, state } = standIn(dir);
    const [context] = checkouts(dir, program);
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
  }));
