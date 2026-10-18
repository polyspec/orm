// Checks that the version check rejects, along with the file, any version declaration that differs from VERSION.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changelogErrors, CHANGELOGS, versionErrors, DECLARATIONS } from './check.mts';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';

const root = resolve(import.meta.dirname, '..', '..');
// Each case reads a version declaration file and copies it to a temporary directory, so it has a COMPUTE deadline.

async function copyDeclarations() {
  const dir = await mkdtemp(join(tmpdir(), 'orm-version-'));
  await cp(join(root, 'VERSION'), join(dir, 'VERSION'));
  for (const { file } of DECLARATIONS) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(join(root, file), join(dir, file));
  }
  return dir;
}

caseTest('the repository declares one version', COMPUTE, async () => {
  assert.deepEqual(await versionErrors(root), []);
});

caseTest('a declaration that differs from VERSION is reported with its file', COMPUTE, async () => {
  const dir = await copyDeclarations();
  try {
    const file = join(dir, 'packages/ts/package.json');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    const errors = await versionErrors(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /packages\/ts\/package\.json/);
    assert.match(errors[0] ?? '', /9\.9\.9/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('a declaration that disappears is reported', COMPUTE, async () => {
  const dir = await copyDeclarations();
  try {
    await writeFile(join(dir, 'contracts/features.json'), '{}\n');
    const errors = await versionErrors(dir);
    // contracts/features.json is read as a schema, so if its declaration is missing, the schema reports that contract_version is missing.
    assert.ok(errors.some(e => e.includes('contracts/features.json') && e.includes('contract_version')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('the version of each Rust package in a lockfile and each version pin of a manifest are read', COMPUTE, async () => {
  const dir = await copyDeclarations();
  try {
    const lock = join(dir, 'packages/rust/Cargo.lock');
    const lockText = await readFile(lock, 'utf8');
    for (const name of ['polyspec-orm', 'polyspec-orm-testcase']) {
      assert.match(lockText, new RegExp(`^name = "${name}"\\nversion = "`, 'm'), `${name} is a package of packages/rust/Cargo.lock`);
    }
    await writeFile(lock, lockText.replace(/^(name = "polyspec-orm-testcase"\nversion = ")[^"]+"/m, '$19.9.9"'));
    const manifest = join(dir, 'packages/rust/orm/Cargo.toml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/^(polyspec-orm-schema = \{ version = "=)[^"]+"/m, '$19.9.8"'));
    const errors = await versionErrors(dir);
    assert.ok(errors.some(e => e.startsWith('packages/rust/Cargo.lock: version 9.9.9')), errors.join('\n'));
    assert.ok(errors.some(e => e.startsWith('packages/rust/orm/Cargo.toml: version 9.9.8')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The change history case (G5.113-1) checks whether the repository's CHANGELOG.md and CHANGELOG.ko.md start with `## Unreleased`, and accepts the result of a minimal-file release
// PR, and rejects a missing or duplicated `## Unreleased`, a section greater than VERSION, sections out of order, and
// sections that differ between the two languages.
caseTest('the changelogs keep ## Unreleased at the top above the released versions', COMPUTE, async () => {
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const files = Object.fromEntries(await Promise.all(CHANGELOGS.map(async (path): Promise<[string, string]> => [path, await readFile(join(root, path), 'utf8')])));
  assert.deepEqual(changelogErrors(version, files), []);
  const pair = (text: string) => ({ 'CHANGELOG.md': `# Changelog\n\n${text}`, 'CHANGELOG.ko.md': `# 변경 이력\n\n${text}` });
  // release PR 0.0.2: VERSION becomes 0.0.2, `## Unreleased` becomes `## 0.0.2`, and an empty `## Unreleased` is placed above it.
  assert.deepEqual(changelogErrors('0.0.2', pair('## Unreleased\n\n## 0.0.2\n\n- G1: a.\n\n## 0.0.1\n\n- G0: b.\n')), []);
  assert.deepEqual(changelogErrors('0.0.2', pair('## 0.0.2\n\n- G1: a.\n')), [
    'CHANGELOG.md: the first section is ## 0.0.2; write the entries of the changes that no tag released under ## Unreleased at the top',
    'CHANGELOG.ko.md: the first section is ## 0.0.2; write the entries of the changes that no tag released under ## Unreleased at the top',
  ]);
  assert.deepEqual(changelogErrors('0.0.2', pair('## Unreleased\n\n## 0.1.0\n\n## Unreleased\n')).slice(0, 2), [
    'CHANGELOG.md: ## Unreleased appears 2 times; keep one at the top',
    'CHANGELOG.md: the section ## 0.1.0 is above VERSION 0.0.2; the release PR sets VERSION to the version it releases',
  ]);
  assert.deepEqual(changelogErrors('0.0.3', { 'CHANGELOG.md': '## Unreleased\n\n## 0.0.1\n\n## 0.0.2\n', 'CHANGELOG.ko.md': '## Unreleased\n\n## 0.0.2\n\n## next\n' }), [
    'CHANGELOG.md: the section ## 0.0.2 follows ## 0.0.1; a newer version comes first and appears once',
    'CHANGELOG.ko.md: the section ## next is neither ## Unreleased nor a released version X.Y.Z',
    'CHANGELOG.ko.md: the sections ## Unreleased, ## 0.0.2, ## next differ from the sections ## Unreleased, ## 0.0.1, ## 0.0.2 of CHANGELOG.md',
  ]);
});
