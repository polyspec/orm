// The owner of the test servers (T612, HR-87): a start names the process that owns the servers it started or reused, and the
// servers stop once every owner has ended and no run holds a lease of them. These cases check the decision with fake steps,
// so they start no server.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest } from '../tests/testcase.mts';
import { own, ownerPid, type OwnerSteps } from './test-servers-owner.mts';
import { main, paths } from './test-servers.mts';

function steps(generation: string | undefined, fail: Partial<Record<'waitOwners' | 'holdExclusive', Error>> = {}): { calls: string[]; steps: OwnerSteps } {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      waitOwners: () => { calls.push('waitOwners'); if (fail.waitOwners) throw fail.waitOwners; },
      holdExclusive: () => { calls.push('holdExclusive'); if (fail.holdExclusive) throw fail.holdExclusive; },
      generation: () => { calls.push('generation'); return generation; },
      stop: () => { calls.push('stop'); },
    },
  };
}

caseTest('the owner stops the servers it watched after every owner ended and every lease was released', () => {
  const run = steps('g1');
  assert.equal(own('g1', run.steps), 'stopped');
  assert.deepEqual(run.calls, ['waitOwners', 'holdExclusive', 'generation', 'stop']);
});

caseTest('the owner leaves servers of another start alone', () => {
  for (const found of ['g2', undefined]) {
    const run = steps(found);
    assert.equal(own('g1', run.steps), 'replaced');
    assert.deepEqual(run.calls, ['waitOwners', 'holdExclusive', 'generation']);
  }
});

caseTest('the owner stops nothing without the exclusive lease of the owners', () => {
  const refused = new Error('lease refused');
  const run = steps('g1', { waitOwners: refused });
  assert.throws(() => own('g1', run.steps), error => error === refused);
  assert.deepEqual(run.calls, ['waitOwners']);
});

caseTest('the owner stops nothing without the exclusive lease of the servers', () => {
  const refused = new Error('lease refused');
  const run = steps('g1', { holdExclusive: refused });
  assert.throws(() => own('g1', run.steps), error => error === refused);
  assert.deepEqual(run.calls, ['waitOwners', 'holdExclusive']);
});

caseTest('a start names its owner by ORM_SERVERS_OWNER', () => {
  assert.equal(ownerPid({ ORM_SERVERS_OWNER: '4242' }), 4242);
  for (const value of [undefined, '', '0', '-1', '12x', '1.5'])
    assert.throws(() => ownerPid(value === undefined ? {} : { ORM_SERVERS_OWNER: value }), /ORM_SERVERS_OWNER/);
});

// make orm-test-mariadb-stop (test-servers.mts mariadb-stop) stops the MariaDB servers by their pid files under the exclusive
// lease of their lease directory and removes their files, and leaves the other servers of the checkout alone. The fixture has
// the files of MariaDB servers that have ended, so no server runs; LEASE is the lease program that make builds.
caseTest('mariadb-stop removes the MariaDB servers and keeps the other servers', async () => {
  assert.ok(process.env.LEASE, 'LEASE is unset; run make orm-test-servers-check, which builds it');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-mariadb-stop-')));
  try {
    const p = paths(root, join(root, 'sockets'));
    mkdirSync(p.socketDir, { recursive: true });
    const mariadb = [...['mariadb', 'mariadb-replica', 'mariadb-privilege', 'mariadb-proxysql'].map(name => join(p.dir, name)), ...['mariadb', 'mariadb-replica', 'mariadb-privilege'].map(name => join(p.dir, `${name}-tmp`))];
    for (const dir of [...mariadb, join(p.dir, 'mysql'), join(p.dir, 'postgres')]) mkdirSync(dir, { recursive: true });
    for (const file of [p.mariadbEnv, p.env]) writeFileSync(file, '');
    await main(['mariadb-stop'], p);
    assert.deepEqual([...mariadb, p.mariadbEnv].filter(existsSync), [], 'mariadb-stop leaves MariaDB files');
    assert.deepEqual([join(p.dir, 'mysql'), join(p.dir, 'postgres'), p.env, p.socketDir].filter(path => !existsSync(path)), [], 'mariadb-stop removed files of the other servers');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
