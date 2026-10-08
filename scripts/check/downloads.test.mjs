// check가 읽는 download의 확인(scripts/check/downloads.mjs)과 Makefile의 offline 규칙을 검사한다. 각 case는 임시
// directory의 lock file과 설치 기록, 가짜 cargo와 go로 실행하고 network는 쓰지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import { isolatedEnvironment } from '../../tests/environment.mjs';
import { composerMissing, missingDownloads, npmMissing, offlineMakeErrors } from './downloads.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const write = (path, value) => {
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
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    write(join(root, 'packages/orm-rust/Cargo.toml'), '');
    write(join(root, 'packages/orm-rust/Cargo.lock'), '');
    write(join(root, 'go.mod'), 'module x\n');
    // A cargo that answers as an offline cargo does for a crate that is not in the registry.
    write(join(root, 'bin/cargo'), "#!/bin/sh\necho 'error: failed to download `serde v1.0.0`' >&2\necho 'help: retry without the offline flag' >&2\nexit 101\n");
    chmodSync(join(root, 'bin/cargo'), 0o755);
    const run = () => ({ status: 1, stderr: 'go: example.com/m@v1.0.0: module lookup disabled by GOPROXY=off\n' });
    const missing = missingDownloads(root, { run, cargo: join(root, 'bin/cargo') });
    assert.deepEqual(missing.map(entry => entry.need), ['rust', 'go']);
    assert.equal(missing[0].message, 'the crates are not downloaded (packages/orm-rust/Cargo.lock: error: failed to download `serde v1.0.0`); run make install, which downloads it');
    assert.equal(missing[1].message, 'the Go modules of go.mod are not downloaded (go: example.com/m@v1.0.0: module lookup disabled by GOPROXY=off); run make install, which downloads it');
    for (const { message } of missing) assert.doesNotMatch(message, /retry/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('the lowest Node is downloaded only by make install-node-min', PROCESS, () => {
  const cache = mkdtempSync(join(tmpdir(), 'orm-node-min-'));
  try {
    const result = spawnSync('sh', [join(repo, 'scripts/typescript/node-min.sh')], { encoding: 'utf8', env: isolatedEnvironment({ ORM_NODE_CACHE: cache, ORM_NODE_MIN_INSTALL: '' }) });
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
  assert.deepEqual(offlineMakeErrors('check:\n\ttrue\n'), [
    'Makefile does not export CARGO_NET_OFFLINE := true', 'Makefile does not export GOPROXY := off',
    'Makefile does not export npm_config_offline := true', 'Makefile does not export COMPOSER_DISABLE_NETWORK := 1',
  ]);
});
