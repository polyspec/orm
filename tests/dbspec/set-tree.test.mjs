import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../testcase.mts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSetTree } from './set-tree.mjs';

caseTest('writes text, bytes, hard links and symbolic links from one fixture tree', COMPUTE, () => {
  const root = buildSetTree({
    'source.txt': { file: 'fixture' },
    'bytes.bin': { hex: '66697874757265' },
    'hard.txt': { hardlink: 'source.txt' },
    'symbolic.txt': { symlink: 'source.txt' },
  }, 'orm-dbspec-set-tree-');
  try {
    for (const path of ['source.txt', 'bytes.bin', 'hard.txt', 'symbolic.txt']) {
      assert.equal(readFileSync(join(root, path), 'utf8'), 'fixture');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
