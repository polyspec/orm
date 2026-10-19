// python-venv-check and orm-install-python accept only the venv of the Python release of mise.toml, never the python3 of PATH.
// The interpreter of the venv is a stub, and orm-install-python is read through make -n.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest, PROCESS } from '../../tests/testcase.mts';

const root = resolve(import.meta.dirname, '..', '..');

// The stub is an interpreter that ignores `python -c <code>` and its arguments and prints one version.
async function stubVenv(dir: string, version: string) {
  const venv = join(dir, '.venv');
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(venv, 'bin', 'python'), `#!/bin/sh\necho ${version}\n`);
  await chmod(join(venv, 'bin', 'python'), 0o755);
  return venv;
}

function make(args: string[], { path = process.env['PATH'] ?? '' }: { path?: string } = {}) {
  return spawnSync('make', args, { cwd: root, encoding: 'utf8', env: isolatedEnvironment({ PATH: path }) });
}

caseTest('python-venv-check refuses a venv of another release and names both releases and the fix', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-venv-'));
  try {
    const venv = await stubVenv(dir, '3.9.6');
    const result = make(['python-venv-check', `PYTHON_VENV=${venv}`]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /runs Python 3\.9\.6, but mise\.toml declares 3\.14\.8/);
    assert.match(result.stdout + result.stderr, /remove .+\.venv and run make install/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('python-venv-check accepts a venv of the release that mise.toml declares', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-venv-'));
  try {
    const venv = await stubVenv(dir, '3.14.8');
    const result = make(['python-venv-check', `PYTHON_VENV=${venv}`]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

caseTest('orm-install-python builds its venv with the pinned interpreter, never the python3 of PATH', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-venv-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'python3'), '#!/bin/sh\necho 3.9.6\nexit 1\n');
    await chmod(join(bin, 'python3'), 0o755);
    const result = make(['-n', 'orm-install-python', `PYTHON_VENV=${join(dir, '.venv')}`], { path: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /(^|[\s/])python3 -m venv/m);
    // install-tools installs every tool of mise.lock, the Python among them; it takes no tool names.
    assert.match(result.stdout, /install-tools\.mjs/);
    assert.doesNotMatch(result.stdout, /install-tools\.mjs \S/);
    assert.match(result.stdout, /python-venv DIR=/);
    // make puts the shims of mise before PATH, so python3 is the Python of mise.toml and the stub of PATH is never run.
    assert.match(result.stdout, /(^|\s)\S*\/var\/tools\/mise\/shims\/python3 -m pip --python /m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
