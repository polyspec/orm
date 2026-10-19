import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedEnvironment } from '../tests/environment.mts';
import { caseTest, COMPUTE, PROCESS } from '../tests/testcase.mts';
import { collisions, countDifferences } from './test-servers-mysql.mts';
import { paths } from './test-servers.mts';

caseTest('collisions names the schemas and tables that one lower case name would merge', COMPUTE, () => {
  assert.deepEqual(collisions(['Shop', 'shop', 'other'], [['other', 'Foo'], ['other', 'foo'], ['Other', 'bar'], ['shop', 'item']]), [
    'schemas Shop, shop',
    'tables of other: Foo, foo',
  ]);
  assert.deepEqual(collisions(['a', 'b'], [['a', 'x'], ['b', 'x']]), []);
});

caseTest('countDifferences compares counts by lower case name', COMPUTE, () => {
  assert.deepEqual(countDifferences({ 'Shop tables': 2, 'Shop.Item rows': 3 }, { 'shop tables': 2, 'shop.item rows': 3 }), []);
  assert.deepEqual(countDifferences({ 'Shop tables': 2, users: 1 }, { 'shop tables': 1, users: 1, 'x events': 1 }), [
    'shop tables: 2 before, 1 after',
    'x events: absent before, 1 after',
  ]);
});

// The real server case copies test-servers.mts of this checkout to a short temporary root (the script finds its servers from
// its own folder), initializes the MySQL primary and
// replica with the platform's default lower_case_table_names (2 on macOS, 0 on Linux), then migrates them to the declared
// 1. The root lives under /tmp so the socket paths fit the platform limit.
const repository = new URL('..', import.meta.url).pathname;
const platformDefault = process.platform === 'darwin' ? 2 : 0;

// earlier edits the copied script that starts the earlier servers; a case changes it to make the setup fail.
function fixture(mysqlPort: number, replicaPort: number, earlier = (declared: string, _root: string) => declared) {
  const root = mkdtempSync('/tmp/orm-mig-');
  const close = () => {
    spawnSync(process.execPath, [join(root, 'scripts/test-servers.mts'), 'mysql-stop'], { stdio: 'ignore' });
    // Only stop removes the socket directory that mysql-start made (the socket folder of test-servers.mts), so it is removed here.
    // The script names its servers by its real path (Node resolves the module path); /tmp is a link on macOS.
    rmSync(paths(realpathSync(root)).socketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  };
  // A failed setup leaves nothing behind: the servers it started and its folders go, and the error is rethrown.
  try {
    for (const file of ['scripts/test-servers.mts']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      copyFileSync(join(repository, file), join(root, file));
    }
    const declared = readFileSync(join(root, 'scripts/test-servers.mts'), 'utf8');
    assert.match(declared, /^export const MYSQL_LOWER_CASE = 1;$/m);
    writeFileSync(join(root, 'scripts/earlier-servers.mts'), earlier(declared.replace(/^export const MYSQL_LOWER_CASE = 1;$/m, `export const MYSQL_LOWER_CASE = ${platformDefault};`), root));
    mkdirSync(join(root, '.runtime/servers'), { recursive: true });
    execFileSync(process.execPath, [join(root, 'scripts/earlier-servers.mts'), 'mysql-start', String(mysqlPort), String(replicaPort)], { stdio: 'ignore' });
  } catch (error) {
    close();
    throw error;
  }
  const sql = (port: number, statements: string) => execFileSync('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', statements], { encoding: 'utf8' });
  return {
    root,
    sql,
    leases: join(root, '.runtime/servers.leases'),
    // The migration takes every path as an argument, so the script of the checkout runs, with the modules it imports.
    migrate: () => spawnSync('node', [join(repository, 'scripts/test-servers-mysql.mts'), join(root, 'scripts/test-servers.mts'), join(root, '.runtime/servers'), String(mysqlPort), String(replicaPort), '1'],
      { encoding: 'utf8', env: isolatedEnvironment({ LEASE: process.env.LEASE ?? '', LEASES: join(root, '.runtime/servers.leases') }) }),
    close,
  };
}

// The lease case checks that, while another run holds the server's shared lease, the migration changes nothing and fails
// naming the holder. The holder is a shell stopped reading a FIFO, ended by a write to it after the check.
caseTest('the MySQL migration is refused while another run holds a lease of the servers', PROCESS, () => {
  const lease = process.env.LEASE;
  assert.ok(lease, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const servers = fixture(39305, 39306);
  const release = join(servers.root, 'release');
  const ready = join(servers.root, 'ready');
  let holder;
  try {
    execFileSync('mkfifo', [release, ready]);
    // The holder writes to ready after it takes the lease and waits reading release; the case reads ready to learn of the hold.
    holder = spawn('sh', ['-c', `${lease} hold ${servers.leases} shared --pid $$ && echo held > ${ready} && read line < ${release}`], { stdio: 'ignore' });
    assert.equal(execFileSync('sh', ['-c', `read state < ${ready}; echo $state`], { encoding: 'utf8' }), 'held\n');
    const refused = servers.migrate();
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /lease: refused the exclusive lease of .*servers\.leases; held by:\n  shared lease of pid [0-9]+ \(/);
    assert.match(refused.stderr, /the MySQL migration needs the exclusive lease of the servers; nothing changed/);
    assert.ok(!existsSync(join(servers.root, '.runtime/mysql-migration')), 'the refused migration started its work');
    assert.equal(readFileSync(join(servers.root, '.runtime/servers/mysql.settings'), 'utf8'), `lower_case_table_names=${platformDefault}\n`);
    assert.equal(servers.sql(39305, 'SELECT @@lower_case_table_names').trim(), String(platformDefault));
  } finally {
    if (holder?.exitCode === null) holder.kill();
    servers.close();
  }
});

caseTest('a MySQL setting other than the declared one migrates the data with equal counts, then nothing', PROCESS, () => {
  const servers = fixture(39301, 39302);
  try {
    servers.sql(39301, `
      CREATE DATABASE ShopDb; USE ShopDb;
      CREATE TABLE Item (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO Item VALUES (1, 'a'), (2, 'b'), (3, 'c');
      CREATE TABLE Note (id INT PRIMARY KEY); INSERT INTO Note VALUES (1);
      CREATE VIEW ItemView AS SELECT id FROM Item;
      CREATE PROCEDURE CountItems() SELECT COUNT(*) FROM Item;
      CREATE TRIGGER NoteAdded BEFORE INSERT ON Note FOR EACH ROW SET NEW.id = NEW.id;
      CREATE EVENT Tick ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1;
      CREATE USER 'migrated'@'127.0.0.1' IDENTIFIED BY 'secret'; GRANT SELECT ON ShopDb.* TO 'migrated'@'127.0.0.1';`);
    assert.equal(servers.sql(39301, 'SELECT @@lower_case_table_names').trim(), String(platformDefault));
    const first = servers.migrate();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    // Each migration step is a long task (runLong in tests/testcase.mts): it writes its TAP result line, in order, and no deadline ends it.
    const results = first.stdout.split('\n').filter(line => /^(not )?ok - /.test(line));
    assert.deepEqual(results, ['preflight', 'dump', 'stop', 'keep', 'start', 'restore', 'verify', 'record'].map(step => `ok - mysql-migration/${step}`));
    assert.doesNotMatch(first.stdout, /^# deadline \S+ exceeded$|^Bail out!/m);
    for (const port of [39301, 39302]) {
      assert.equal(servers.sql(port, 'SELECT @@lower_case_table_names').trim(), '1');
      assert.equal(servers.sql(port, 'SELECT COUNT(*) FROM shopdb.item').trim(), '3');
      assert.equal(servers.sql(port, "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'shopdb'").trim(), '1');
    }
    assert.equal(readFileSync(join(servers.root, '.runtime/servers/mysql.settings'), 'utf8'), 'lower_case_table_names=1\n');
    const kept = readdirSync(join(servers.root, '.runtime')).filter(name => name.startsWith('mysql-before-'));
    assert.equal(kept.length, 1);
    for (const name of ['mysql', 'mysql-replica', 'migration/dump.sql', 'migration/counts.json'])
      assert.ok(existsSync(join(servers.root, '.runtime', kept[0] ?? '', name)), `${name} is not kept`);
    const again = servers.migrate();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(again.stdout, 'test-servers: MySQL settings lower_case_table_names=1 unchanged\n');
  } finally {
    servers.close();
  }
});

caseTest('names that one lower case name would merge refuse the migration before any change', PROCESS, () => {
  const servers = fixture(39311, 39312);
  try {
    servers.sql(39311, 'CREATE DATABASE Pair; CREATE TABLE Pair.Foo (id INT)');
    const second = spawnSync('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', '39311', '-u', 'root', '-e', 'CREATE TABLE Pair.foo (id INT)'], { encoding: 'utf8' });
    if (platformDefault !== 0) {
      // A server on a case-insensitive file system makes no such pair of names (1050).
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /1050/);
      return;
    }
    assert.equal(second.status, 0, second.stderr);
    const refused = servers.migrate();
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /^not ok - mysql-migration\/preflight\n# names that lower_case_table_names=1 would merge, nothing changed: tables of pair: Foo, foo$/m);
    assert.equal(servers.sql(39311, 'SELECT @@lower_case_table_names').trim(), '0');
    assert.equal(readdirSync(join(servers.root, '.runtime')).filter(name => name.startsWith('mysql-before-')).length, 0);
  } finally {
    servers.close();
  }
});

// A failed setup leaves no temporary root: the fixture stops what it started, removes its folders and rethrows the error.
caseTest('the MySQL fixture removes its root when its setup fails', PROCESS, () => {
  let root = '';
  assert.throws(() => fixture(39315, 39316, (declared, at) => {
    root = at;
    return `process.exit(3);\n${declared}`;
  }), /earlier-servers\.mts mysql-start/);
  assert.ok(root);
  assert.equal(existsSync(root), false);
});
