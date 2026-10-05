import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../tests/testcase.mjs';
import { collisions, countDifferences } from './test-servers-mysql.mjs';

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

// 실제 서버 case는 이 checkout의 script를 짧은 임시 root로 복사하고, 그 platform의 기본
// lower_case_table_names(macOS 2, Linux 0)로 MySQL primary와 replica를 초기화한 뒤 선언한 1로
// migration한다. socket 경로가 platform 한도 안에 들도록 root는 /tmp 아래에 둔다.
const repository = new URL('..', import.meta.url).pathname;
const platformDefault = process.platform === 'darwin' ? 2 : 0;

function fixture(mysqlPort, replicaPort) {
  const root = mkdtempSync('/tmp/orm-mig-');
  for (const file of ['scripts/test-servers.sh', 'scripts/test-servers-mysql.mjs', 'tests/testcase.mjs']) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    copyFileSync(join(repository, file), join(root, file));
  }
  const declared = readFileSync(join(root, 'scripts/test-servers.sh'), 'utf8');
  assert.match(declared, /^MYSQL_LOWER_CASE=1$/m);
  writeFileSync(join(root, 'scripts/earlier-servers.sh'), declared.replace(/^MYSQL_LOWER_CASE=1$/m, `MYSQL_LOWER_CASE=${platformDefault}`));
  mkdirSync(join(root, '.runtime/servers'), { recursive: true });
  execFileSync('sh', [join(root, 'scripts/earlier-servers.sh'), 'mysql-start', String(mysqlPort), String(replicaPort)], { stdio: 'ignore' });
  const sql = (port, statements) => execFileSync('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', statements], { encoding: 'utf8' });
  return {
    root,
    sql,
    leases: join(root, '.runtime/servers.leases'),
    migrate: () => spawnSync('node', [join(root, 'scripts/test-servers-mysql.mjs'), join(root, 'scripts/test-servers.sh'), join(root, '.runtime/servers'), String(mysqlPort), String(replicaPort), '1'],
      { encoding: 'utf8', env: { ...process.env, LEASES: join(root, '.runtime/servers.leases') } }),
    close: () => {
      spawnSync('sh', [join(root, 'scripts/test-servers.sh'), 'mysql-stop'], { stdio: 'ignore' });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// lease case는 다른 실행이 서버의 shared lease를 가진 동안 migration이 아무것도 바꾸지 않고 그 보유자를
// 적으며 실패하는지 확인한다. 보유자는 FIFO를 읽으며 멈춰 있는 shell이고, 확인 뒤 FIFO에 써서 끝낸다.
caseTest('the MySQL migration is refused while another run holds a lease of the servers', PROCESS, () => {
  const lease = process.env.LEASE;
  assert.ok(lease, 'LEASE is unset; run make test-servers-check, which builds it');
  const servers = fixture(39305, 39306);
  const release = join(servers.root, 'release');
  const ready = join(servers.root, 'ready');
  let holder;
  try {
    execFileSync('mkfifo', [release, ready]);
    // 보유자는 lease를 얻은 뒤 ready에 쓰고 release를 읽으며 기다린다. 이 case는 ready를 읽어 보유를 안다.
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
    for (const step of ['preflight', 'dump', 'stop', 'keep', 'start', 'restore', 'verify', 'record'])
      assert.match(first.stdout, new RegExp(`^PASS mysql-migration/${step} elapsed=`, 'm'));
    for (const port of [39301, 39302]) {
      assert.equal(servers.sql(port, 'SELECT @@lower_case_table_names').trim(), '1');
      assert.equal(servers.sql(port, 'SELECT COUNT(*) FROM shopdb.item').trim(), '3');
      assert.equal(servers.sql(port, "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'shopdb'").trim(), '1');
    }
    assert.equal(readFileSync(join(servers.root, '.runtime/servers/mysql.settings'), 'utf8'), 'lower_case_table_names=1\n');
    const kept = readdirSync(join(servers.root, '.runtime')).filter(name => name.startsWith('mysql-before-'));
    assert.equal(kept.length, 1);
    for (const name of ['mysql', 'mysql-replica', 'migration/dump.sql', 'migration/counts.json'])
      assert.ok(existsSync(join(servers.root, '.runtime', kept[0], name)), `${name} is not kept`);
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
      // 대소문자를 구분하지 않는 파일 시스템의 서버는 그런 이름 쌍을 만들지 않는다(1050).
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /1050/);
      return;
    }
    assert.equal(second.status, 0, second.stderr);
    const refused = servers.migrate();
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /^FAIL mysql-migration\/preflight elapsed=[^:]+: names that lower_case_table_names=1 would merge, nothing changed: tables of pair: Foo, foo$/m);
    assert.equal(servers.sql(39311, 'SELECT @@lower_case_table_names').trim(), '0');
    assert.equal(readdirSync(join(servers.root, '.runtime')).filter(name => name.startsWith('mysql-before-')).length, 0);
  } finally {
    servers.close();
  }
});
