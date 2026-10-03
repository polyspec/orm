// version check가 VERSION과 다른 version 선언을 파일과 함께 거부하는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { versionErrors, DECLARATIONS } from './check.mjs';

const root = resolve(import.meta.dirname, '..', '..');

async function copyDeclarations() {
  const dir = await mkdtemp(join(tmpdir(), 'orm-version-'));
  await cp(join(root, 'VERSION'), join(dir, 'VERSION'));
  for (const { file } of DECLARATIONS) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(join(root, file), join(dir, file));
  }
  return dir;
}

test('the repository declares one version', async () => {
  assert.deepEqual(await versionErrors(root), []);
});

test('a declaration that differs from VERSION is reported with its file', async () => {
  const dir = await copyDeclarations();
  try {
    const file = join(dir, 'clients/typescript/package.json');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    const errors = await versionErrors(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /clients\/typescript\/package\.json/);
    assert.match(errors[0], /9\.9\.9/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a declaration that disappears is reported', async () => {
  const dir = await copyDeclarations();
  try {
    await writeFile(join(dir, 'contracts/features.json'), '{}\n');
    const errors = await versionErrors(dir);
    assert.ok(errors.some(e => e.includes('contracts/features.json') && e.includes('no version')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
