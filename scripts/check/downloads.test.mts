// check가 읽는 download의 확인(scripts/check/downloads.mts)과 Makefile의 offline 규칙을 검사한다. 각 case는 임시
// directory의 lock file과 설치 기록, 가짜 cargo와 go로 실행하고 network는 쓰지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { composerMissing, missingDownloads, npmMissing, offlineMakeErrors } from './downloads.mts';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const write = (path: string, value: unknown) => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};

caseTest('the npm and Composer packages of a lock file must be installed at their locked versions', COMPUTE, () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-downloads-'));
  try {
    write(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0', optional: true }, 'node_modules/c': { version: '3.0.0' } } });
    assert.deepEqual(npmMissing(root, '.'), ['./node_modules is not installed']);
    write(join(root, 'node_modules/.package-lock.json'), { packages: { 'node_modules/a': { version: '0.9.0' }, 'node_modules/c': { version: '3.0.0' } } });
    assert.deepEqual(npmMissing(root, '.'), ['./node_modules/a 1.0.0 is installed as 0.9.0']);
    write(join(root, 'php/composer.lock'), { packages: [{ name: 'x/y', version: 'v1.0.0' }], 'packages-dev': [{ name: 'x/z', version: 'v2.0.0' }] });
    assert.deepEqual(composerMissing(root, 'php'), ['php/vendor is not installed']);
    write(join(root, 'php/vendor/composer/installed.json'), { packages: [{ name: 'x/y', version: 'v1.0.0' }] });
    assert.deepEqual(composerMissing(root, 'php'), ['php x/z v2.0.0 is not installed']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('a crate or Go module that is not downloaded names make install, never a retry online', PROCESS, () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-downloads-'));
  try {
    write(join(root, 'go.work'), 'go 1.27.2\n');
    // make cargo-downloads-check of @polyspec/kit answers as it does for a crate that is not in the registry, and go as an
    // offline go does for a module that is not downloaded.
    const calls: string[] = [];
    const run = (program: string, args: string[]) => {
      calls.push([program, ...args].join(' '));
      if (program === 'make') return { status: 2, stderr: '[cargo-downloads] the crates of 1 of 3 Cargo.lock files are not in the registry of CARGO_HOME:\npackages/rust/Cargo.lock: error: failed to download `serde v1.0.0`\nhelp: retry without the offline flag\n' };
      return { status: 1, stderr: 'go: example.com/m@v1.0.0: module lookup disabled by GOPROXY=off\n' };
    };
    const missing = missingDownloads(root, { run });
    assert.deepEqual(calls, ['make --no-print-directory cargo-downloads-check', 'go mod download']);
    assert.deepEqual(missing.map(entry => entry.need), ['rust', 'go']);
    const [rust, go] = missing;
    assert.ok(rust && go, 'both downloads are missing');
    assert.equal(rust.message, 'the crates of every Cargo.lock are not downloaded (packages/rust/Cargo.lock: error: failed to download `serde v1.0.0`); run make install, which downloads it');
    assert.equal(go.message, 'the Go modules of go.work are not downloaded (go: example.com/m@v1.0.0: module lookup disabled by GOPROXY=off); run make install, which downloads it');
    for (const { message } of missing) assert.doesNotMatch(message, /retry/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('the lowest Node is downloaded only by make install-node-min', PROCESS, () => {
  const cache = mkdtempSync(join(tmpdir(), 'orm-node-min-'));
  try {
    const result = spawnSync(process.execPath, [join(repo, 'scripts/typescript/node-min.mts')], { encoding: 'utf8', env: isolatedEnvironment({ ORM_NODE_CACHE: cache, ORM_NODE_MIN_INSTALL: '' }) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`^node-min: Node [0-9.]+ is not in ${cache.replace(/[.]/g, '\\.')}; run make install, which downloads it\n$`));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

caseTest('the Makefile runs every check offline and downloads only in the install targets', COMPUTE, () => {
  assert.deepEqual(offlineMakeErrors(readFileSync(join(repo, 'Makefile'), 'utf8')), []);
  const exports = 'export CARGO_NET_OFFLINE := true\nexport GOPROXY := off\nexport npm_config_offline := true\nexport COMPOSER_DISABLE_NETWORK := 1\nONLINE := env -u CARGO_NET_OFFLINE\n';
  assert.deepEqual(offlineMakeErrors(`${exports}install-x:\n\t$(ONLINE) npm ci\nrust-fetch: lease-tool\n\tcargo fetch --locked\nbuild:\n\t$(ONLINE) go build ./...\n`), [
    'Makefile rust-fetch downloads (cargo fetch --locked) outside an install target; make install downloads what the checks read',
    'Makefile build runs $(ONLINE) outside an install target: $(ONLINE) go build ./...',
  ]);
  // A rule of two targets is read as make reads it (makeTargets of scripts/repo/testcases.mts, T137-1-4-2-2).
  assert.deepEqual(offlineMakeErrors(`${exports}install-x:\n\tnpm ci\nfetch/a fetch/b:\n\tcurl -O x\n`), [
    'Makefile fetch/a downloads (curl -O x) outside an install target; make install downloads what the checks read',
    'Makefile fetch/b downloads (curl -O x) outside an install target; make install downloads what the checks read',
  ]);
  assert.deepEqual(offlineMakeErrors('check:\n\ttrue\n'), [
    'Makefile does not export CARGO_NET_OFFLINE := true', 'Makefile does not export GOPROXY := off',
    'Makefile does not export npm_config_offline := true', 'Makefile does not export COMPOSER_DISABLE_NETWORK := 1',
  ]);
});
