import assert from 'node:assert/strict';
import test from 'node:test';
import { walkModules } from './module-graph.mjs';

test('visits reachable modules once in breadth-first order and keeps violations', () => {
  const edges = new Map([
    ['entry', { targets: ['left', 'right'], violations: ['entry violation'] }],
    ['left', { targets: ['shared'], violations: [] }],
    ['right', { targets: ['shared', 'entry'], violations: ['right violation'] }],
    ['shared', { targets: ['left'], violations: [] }],
  ]);
  const visits = [];
  const result = walkModules('entry', file => {
    visits.push(file);
    return edges.get(file);
  });

  assert.deepEqual(visits, ['entry', 'left', 'right', 'shared']);
  assert.deepEqual([...result.modules], visits);
  assert.deepEqual(result.violations, ['entry violation', 'right violation']);
});
