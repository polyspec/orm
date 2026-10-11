// python-venv-check와 install-python가 PATH의 python3이 아니라 config/toolchain.json의 pythonBuild(var/tools/bin/python3)로
// 만든 venv만 받는지 확인한다. venv의 interpreter는 stub으로 두며, install-python은 make -n으로 명령만 본다.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from '../../tests/environment.mjs';
import { caseTest, PROCESS } from '../../tests/testcase.mjs';

const root = resolve(import.meta.dirname, '..', '..');

// stub은 `python -c <code>`와 실행 인자를 무시하고 version 하나를 출력하는 interpreter다.
async function stubVenv(dir, version) {
  const venv = join(dir, '.venv');
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(venv, 'bin', 'python'), `#!/bin/sh\necho ${version}\n`);
  await chmod(join(venv, 'bin', 'python'), 0o755);
  return venv;
}

function make(args, { path = process.env.PATH } = {}) {
  return spawnSync('make', args, { cwd: root, encoding: 'utf8', env: isolatedEnvironment({ PATH: path }) });
}

caseTest('python-venv-check refuses a venv of another minor and names both versions and the fix', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-venv-'));
  try {
    const venv = await stubVenv(dir, '3.9.6');
    const result = make(['python-venv-check', `PYTHON_VENV=${venv}`]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const declared = (await readFile(join(root, '.python-version'), 'utf8')).trim();
    assert.ok((result.stdout + result.stderr).includes(`runs Python 3.9.6, but .python-version declares ${declared}`), result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /remove .+\.venv and run make install/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('python-venv-check accepts a venv of the minor that .python-version declares', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-venv-'));
  try {
    const venv = await stubVenv(dir, (JSON.parse(await readFile(join(root, 'config', 'toolchain.json'), 'utf8'))).pythonBuild.version);
    const result = make(['python-venv-check', `PYTHON_VENV=${venv}`]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('install-python builds its venv with the pinned interpreter, never the python3 of PATH', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-venv-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'python3'), '#!/bin/sh\necho 3.9.6\nexit 1\n');
    await chmod(join(bin, 'python3'), 0o755);
    const result = make(['-n', 'install-python', `PYTHON_VENV=${join(dir, '.venv')}`], { path: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /(^|[\s/])python3 -m venv/m);
    assert.match(result.stdout, /scripts\/kit\/install-tools\.mjs python/);
    assert.match(result.stdout, /python-venv DIR=/);
    assert.match(result.stdout, /var\/tools\/bin\/python3 -m pip --python /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
