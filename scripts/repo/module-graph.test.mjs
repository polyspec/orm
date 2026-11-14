import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { caseTest, withTemporaryDirectory } from '../../tests/testcase.mts';
import { resolveImports, walkModules, walkScannedModules } from '../../tests/module-graph.mjs';

caseTest('collects resolved import targets and violations in source order', () => {
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

caseTest('visits reachable modules once in breadth-first order and keeps violations', () => {
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

caseTest('scans each reached module and resolves its imports with the module that holds them', () =>
  withTemporaryDirectory('orm-module-graph-', dir => {
    writeFileSync(join(dir, 'entry.js'), "import './left.js';\nimport 'node:fs';\n");
    writeFileSync(join(dir, 'left.js'), 'export const left = 1;\n');
    const asked = [];
    const result = walkScannedModules(join(dir, 'entry.js'), dir, (specifier, at, file) => {
      asked.push([specifier, file]);
      return specifier.startsWith('node:') ? { violation: `${at} imports "${specifier}"` } : { target: join(dirname(file), specifier) };
    });
    assert.deepEqual([...result.modules], [join(dir, 'entry.js'), join(dir, 'left.js')]);
    assert.deepEqual(asked, [['./left.js', join(dir, 'entry.js')], ['node:fs', join(dir, 'entry.js')]]);
    assert.deepEqual(result.violations, ['entry.js:2:1 imports "node:fs"']);
  }));
