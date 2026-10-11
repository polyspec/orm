// Tests of scripts/kit/python-venv.mjs: the post-processing of a virtual environment made by `python -m venv --copies`
// (finishVenv). CPython makes lib64 a relative link to lib on 64-bit posix systems other than macOS; the post-processing
// removes that link when it is exactly that, and refuses every other symbolic link, every other lib64 and every platlibdir
// other than lib, naming the path and changing nothing. The trees are fixtures in a temporary directory; no Python runs.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { finishVenv, makeVenv } from '../../scripts/kit/python-venv.mjs';
import { tree } from './tree.mjs';

// A venv tree as `python -m venv --copies --without-pip` writes it: a library directory, an interpreter copy and the config.
function venvTree(t) {
  const root = tree(t);
  const venv = path.join(root, 'pkg/.venv');
  mkdirSync(path.join(venv, 'lib/python3.14/site-packages'), { recursive: true });
  mkdirSync(path.join(venv, 'bin'), { recursive: true });
  writeFileSync(path.join(venv, 'bin/python'), '#!/bin/sh\n');
  writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /x\nversion = 3.14.8\n');
  return { root, venv };
}

const links = (directory, relative = '') => readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
  const rel = path.join(relative, entry.name);
  if (entry.isSymbolicLink()) return [rel];
  return entry.isDirectory() ? links(directory, rel) : [];
});

test('a lib64 that links to lib is removed when sys.platlibdir is lib, and no link is left', (t) => {
  const { root, venv } = venvTree(t);
  symlinkSync('lib', path.join(venv, 'lib64'));
  finishVenv(venv, { platlibdir: 'lib', root });
  assert.equal(existsSync(path.join(venv, 'lib64')), false);
  assert.equal(lstatSync(path.join(venv, 'lib64'), { throwIfNoEntry: false }), undefined, 'the link is gone, not left dangling');
  assert.deepEqual(links(venv), []);
  assert.ok(lstatSync(path.join(venv, 'lib/python3.14/site-packages')).isDirectory(), 'lib is kept');
});

test('a venv with no lib64, as on macOS, passes unchanged', (t) => {
  const { root, venv } = venvTree(t);
  finishVenv(venv, { platlibdir: 'lib', root });
  assert.deepEqual(readdirSync(venv).sort(), ['bin', 'lib', 'pyvenv.cfg']);
});

test('a lib64 that links elsewhere is refused with its target, and nothing is removed', (t) => {
  const { root, venv } = venvTree(t);
  mkdirSync(path.join(root, 'pkg/elsewhere'));
  symlinkSync('../elsewhere', path.join(venv, 'lib64'));
  assert.throws(() => finishVenv(venv, { platlibdir: 'lib', root }), /pkg\/\.venv\/lib64 links to \.\.\/elsewhere, not to lib; the venv holds no link to another directory/);
  assert.equal(readlinkSync(path.join(venv, 'lib64')), '../elsewhere', 'the link is kept');
});

test('a lib64 that is a real directory is refused, and nothing is removed', (t) => {
  const { root, venv } = venvTree(t);
  mkdirSync(path.join(venv, 'lib64/python3.14'), { recursive: true });
  assert.throws(() => finishVenv(venv, { platlibdir: 'lib', root }), /pkg\/\.venv\/lib64 is a directory, not a symbolic link to lib; the venv holds no copy of lib/);
  assert.ok(lstatSync(path.join(venv, 'lib64')).isDirectory(), 'the directory is kept');
});

test('a platlibdir other than lib is refused, even with the lib64 link', (t) => {
  const { root, venv } = venvTree(t);
  symlinkSync('lib', path.join(venv, 'lib64'));
  assert.throws(() => finishVenv(venv, { platlibdir: 'lib64', root }), /pkg\/\.venv has sys\.platlibdir lib64, not lib; nothing is changed, and the environment is refused/);
  assert.equal(readlinkSync(path.join(venv, 'lib64')), 'lib', 'the link is kept');
});

test('another symbolic link, such as bin/python3 -> python, is refused and names it; lib64 is kept', (t) => {
  const { root, venv } = venvTree(t);
  symlinkSync('lib', path.join(venv, 'lib64'));
  symlinkSync('python', path.join(venv, 'bin/python3'));
  assert.throws(() => finishVenv(venv, { platlibdir: 'lib', root }), /pkg\/\.venv\/bin\/python3 is a symbolic link to python; the venv holds no symbolic link/);
  assert.equal(readlinkSync(path.join(venv, 'lib64')), 'lib', 'nothing is converted or removed');
});

// The run is idempotent (K44): an existing directory is accepted unchanged only when it is a venv of the checkout Python; any
// other existing directory is refused with its reason and is neither removed nor repaired.
test('makeVenv refuses an existing directory that is not a venv of the checkout Python, and changes nothing', (t) => {
  const { root, venv } = venvTree(t);
  mkdirSync(path.join(root, 'var/tools/bin'), { recursive: true });
  writeFileSync(path.join(root, 'var/tools/bin/python3'), '#!/bin/sh\n');
  assert.throws(() => makeVenv({ root, directory: venv }), /pkg\/\.venv exists and is not a venv of the checkout Python: pkg\/\.venv was made from \/x, not from the Python of this checkout .*; it is neither removed nor repaired/);
  assert.ok(existsSync(path.join(venv, 'pyvenv.cfg')));
  assert.ok(existsSync(path.join(venv, 'bin/python')));
});
