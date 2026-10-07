// version check가 VERSION과 다른 version 선언을 파일과 함께 거부하는지 확인한다.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changelogErrors, CHANGELOGS, versionErrors, DECLARATIONS } from './check.mjs';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';

const root = resolve(import.meta.dirname, '..', '..');
// 각 case는 version 선언 file을 읽고 임시 directory에 복사하는 계산이므로 COMPUTE 기한을 가진다.

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

caseTest('a declaration that disappears is reported', COMPUTE, async () => {
  const dir = await copyDeclarations();
  try {
    await writeFile(join(dir, 'contracts/features.json'), '{}\n');
    const errors = await versionErrors(dir);
    assert.ok(errors.some(e => e.includes('contracts/features.json') && e.includes('no version')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('the version of each Rust package in a lockfile and each version pin of a manifest are read', COMPUTE, async () => {
  const dir = await copyDeclarations();
  try {
    const lock = join(dir, 'clients/rust/Cargo.lock');
    const lockText = await readFile(lock, 'utf8');
    for (const name of ['polyspec-orm', 'polyspec-orm-testcase']) {
      assert.match(lockText, new RegExp(`^name = "${name}"\\nversion = "`, 'm'), `${name} is a package of clients/rust/Cargo.lock`);
    }
    await writeFile(lock, lockText.replace(/^(name = "polyspec-orm-testcase"\nversion = ")[^"]+"/m, '$19.9.9"'));
    const manifest = join(dir, 'clients/rust/orm/Cargo.toml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/^(polyspec-orm-schema = \{ version = "=)[^"]+"/m, '$19.9.8"'));
    const errors = await versionErrors(dir);
    assert.ok(errors.some(e => e.startsWith('clients/rust/Cargo.lock: version 9.9.9')), errors.join('\n'));
    assert.ok(errors.some(e => e.startsWith('clients/rust/orm/Cargo.toml: version 9.9.8')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 변경 이력 case(G5.113-1)는 저장소의 CHANGELOG.md와 CHANGELOG.ko.md가 `## Unreleased`로 시작하는지 보고, 최소 file에서 release
// PR의 결과를 받아들이며 빠지거나 둘인 `## Unreleased`, VERSION보다 큰 section, 순서가 틀린 section, 두 언어의 다른 section을
// 거부한다.
caseTest('the changelogs keep ## Unreleased at the top above the released versions', COMPUTE, async () => {
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const files = Object.fromEntries(await Promise.all(CHANGELOGS.map(async path => [path, await readFile(join(root, path), 'utf8')])));
  assert.deepEqual(changelogErrors(version, files), []);
  const pair = text => ({ 'CHANGELOG.md': `# Changelog\n\n${text}`, 'CHANGELOG.ko.md': `# 변경 이력\n\n${text}` });
  // release PR 0.0.2: VERSION은 0.0.2이고 `## Unreleased`는 `## 0.0.2`가 되며 그 위에 빈 `## Unreleased`가 온다.
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
