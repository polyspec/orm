import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isBuiltinModule, scanModule } from './module-scan.mjs';

test('recognizes Node builtin roots with and without the node prefix', () => {
  assert.equal(isBuiltinModule('fs/promises'), true);
  assert.equal(isBuiltinModule('node:fs/promises'), true);
  assert.equal(isBuiltinModule('@polyspec/orm/dbspec'), false);
});

test('finds literal imports and Node globals without flagging property names', () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-module-scan-'));
  const file = join(root, 'scan.mjs');
  try {
    writeFileSync(file, [
      "import { value } from 'pkg';",
      "export * from 'other';",
      'const object = { process: 1 };',
      'object.process;',
      'const cwd = process.cwd();',
      "await import('./chunk.js');",
      "await import(`./${'chunk'}.js`);",
    ].join('\n'));

    const result = scanModule(file, root);
    assert.deepEqual(result.imports.map(entry => entry.specifier), ['pkg', 'other', './chunk.js']);
    assert.deepEqual(result.violations, [
      'scan.mjs:5:13 uses the Node global process',
      'scan.mjs:7:7 dynamic import with no literal specifier cannot be followed',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
