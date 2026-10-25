import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from './testcase.mts';
import { resolveImports, walkModules } from './module-graph.mjs';

caseTest('collects resolved import targets and violations in source order', COMPUTE, () => {
  const result = resolveImports(
    [
      { specifier: './local.js', at: 'entry:1' },
      { specifier: 'node:fs', at: 'entry:2' },
    ],
    (specifier, at) => specifier.startsWith('.')
      ? { target: 'local.js' }
      : { violation: `${at} imports "${specifier}"` },
  );
  assert.deepEqual(result, {
    targets: ['local.js'],
    violations: ['entry:2 imports "node:fs"'],
  });
});

caseTest('visits reachable modules once in breadth-first order and keeps violations', COMPUTE, () => {
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
