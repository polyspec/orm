// The make target release-tools-path of scripts/kit/kit.mk, which the vendored release workflow runs right after
// release-tools: it appends var/tools/bin of the checkout to GITHUB_PATH, the file the runner reads between steps, so the
// following steps run on the installed tools. The order of the workflow itself is a case of tests/source, because kit does
// not vendor workflows/. No test uses the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('make release-tools-path appends var/tools/bin of the checkout to GITHUB_PATH', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github_path');
  writeFileSync(file, '');
  const run = spawnSync('make', ['--no-print-directory', '-f', 'scripts/kit/kit.mk', 'release-tools-path'], { cwd: ROOT, env: { ...process.env, GITHUB_PATH: file }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(file, 'utf8'), `${ROOT}/var/tools/bin\n`);
});

test('make release-tools-path refuses without GITHUB_PATH and names where it runs', () => {
  const env = { ...process.env };
  delete env.GITHUB_PATH;
  const run = spawnSync('make', ['--no-print-directory', '-f', 'scripts/kit/kit.mk', 'release-tools-path'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /release-tools-path: GITHUB_PATH is not set; run it in the release workflow between steps/);
});
