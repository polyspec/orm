// isMain (scripts/kit/paths.mjs) tells whether a tool is the command that Node.js started. The command may name the tool
// through a symbolic link of its directory (macOS temporary directories are such links), and then it is the same file.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMain, ROOT } from '../../scripts/kit/paths.mjs';

test('isMain is true when the command names the tool through a link of its directory', (t) => {
  const link = mkdtempSync(path.join(tmpdir(), 'paths-link-'));
  t.after(() => rmSync(link, { recursive: true, force: true }));
  const alias = path.join(link, 'checkout');
  symlinkSync(ROOT, alias);
  const module = new URL('../../scripts/kit/paths.mjs', import.meta.url).href;
  const argv = process.argv[1];
  try {
    process.argv[1] = path.join(alias, 'scripts/kit/paths.mjs');
    assert.equal(isMain(module), true, 'the same file, named through a link, is the command');
    process.argv[1] = path.join(ROOT, 'scripts/kit/kit-check.mjs');
    assert.equal(isMain(module), false, 'another file is not the command');
  } finally {
    process.argv[1] = argv;
  }
  assert.equal(fileURLToPath(module), path.join(ROOT, 'scripts/kit/paths.mjs'));
});
