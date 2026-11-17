// The owner of the test servers (T612, HR-87): a start names the process that owns the servers it started or reused, and the
// servers stop when that owner has ended and no run holds a lease of them. These cases check the decision with fake steps,
// so they start no server.
import assert from 'node:assert/strict';
import { caseTest } from '../tests/testcase.mts';
import { own, ownerPid, type OwnerSteps } from './test-servers-owner.mts';

function steps(generation: string | undefined, fail: Partial<Record<'holdOwner' | 'holdExclusive', Error>> = {}): { calls: string[]; steps: OwnerSteps } {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      holdOwner: () => { calls.push('holdOwner'); if (fail.holdOwner) throw fail.holdOwner; },
      holdExclusive: () => { calls.push('holdExclusive'); if (fail.holdExclusive) throw fail.holdExclusive; },
      generation: () => { calls.push('generation'); return generation; },
      stop: () => { calls.push('stop'); },
      log: text => { calls.push(`log: ${text}`); },
    },
  };
}

caseTest('the owner stops the servers it watched after its owner ended and every lease was released', () => {
  const run = steps('g1');
  assert.equal(own('g1', run.steps), 'stopped');
  assert.deepEqual(run.calls, ['holdOwner', 'holdExclusive', 'generation', 'stop']);
});

caseTest('the owner leaves servers of another start alone', () => {
  for (const found of ['g2', undefined]) {
    const run = steps(found);
    assert.equal(own('g1', run.steps), 'replaced');
    assert.deepEqual(run.calls, ['holdOwner', 'holdExclusive', 'generation']);
  }
});

caseTest('an owner lease that cannot be held still ends in the stop of the servers', () => {
  const run = steps('g1', { holdOwner: new Error('the owner 7 had ended') });
  assert.equal(own('g1', run.steps), 'stopped');
  assert.deepEqual(run.calls, ['holdOwner', 'log: the lease of the owner was not held: the owner 7 had ended; the servers stop when no other lease is held', 'holdExclusive', 'generation', 'stop']);
});

caseTest('the owner stops nothing without the exclusive lease', () => {
  const refused = new Error('lease refused');
  const run = steps('g1', { holdExclusive: refused });
  assert.throws(() => own('g1', run.steps), error => error === refused);
  assert.deepEqual(run.calls, ['holdOwner', 'holdExclusive']);
});

caseTest('a start names its owner by ORM_SERVERS_OWNER', () => {
  assert.equal(ownerPid({ ORM_SERVERS_OWNER: '4242' }), 4242);
  for (const value of [undefined, '', '0', '-1', '12x', '1.5'])
    assert.throws(() => ownerPid(value === undefined ? {} : { ORM_SERVERS_OWNER: value }), /ORM_SERVERS_OWNER/);
});
