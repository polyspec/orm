#!/usr/bin/env node
// Makes the virtual environment of the checkout's Python without a symbolic link (`make python-venv DIR=<directory>`), and
// holds the rule that run-tests --venv checks (venvProblem). `python -m venv --copies` makes lib64 a relative link to lib on
// 64-bit posix systems other than macOS; the rule removes exactly that link, and refuses every other link, every other
// lib64 and every platlibdir other than lib, naming the path and changing nothing.
//
//   node scripts/kit/python-venv.mjs <directory>
//
// The run is idempotent: an existing directory that already is a venv of the checkout Python (run-tests' rule, the same Python
// version, platlibdir lib, no lib64 in sys.path) is accepted unchanged; any other existing directory is an error with its reason
// and is neither removed nor repaired. An absent directory is made with var/tools/bin/python3 (install-tools installs it), its link is
// removed, and the environment is checked: no sys.path entry names lib64, and venvProblem accepts it. A failure removes the
// directory that this run made, so no partial environment is left behind.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { isMain, ROOT } from './paths.mjs';
import { run, toolsPath } from './tool-wrappers.mjs';

const MAKE = (directory) => `make it with make python-venv DIR=${directory}, and install into it with --link-mode copy`;

/** The symbolic links below `directory`, as paths relative to it; a link is not followed. */
function symbolicLinks(directory, relative = '') {
  const found = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) found.push(rel);
    else if (entry.isDirectory()) found.push(...symbolicLinks(directory, rel));
  }
  return found;
}

/** Why the virtual environment `venv` may not run the python tests of `root`, or undefined when it may. */
export function venvProblem(venv, root = ROOT) {
  const config = path.join(venv, 'pyvenv.cfg');
  const relative = path.relative(root, venv);
  const make = MAKE(relative);
  if (!existsSync(config)) return `${relative} is not a virtual environment (no pyvenv.cfg); ${make}`;
  const home = /^home\s*=\s*(.+)$/m.exec(readFileSync(config, 'utf8'))?.[1].trim();
  const expected = toolsPath(root, 'python-build', 'python', 'bin');
  const resolved = target => (existsSync(target) ? realpathSync(target) : target);
  if (!home || resolved(home) !== resolved(expected)) {
    return `${relative} was made from ${home ?? 'no home'}, not from the Python of this checkout (${path.relative(root, expected)}); ${make}`;
  }
  const links = symbolicLinks(venv);
  if (links.length > 0) return `${relative} holds symbolic links (${links.slice(0, 3).join(', ')}${links.length > 3 ? ', …' : ''}); ${make}`;
  return undefined;
}

/**
 * Removes the lib64 link of the virtual environment `directory` after the checks, and changes nothing when one fails. The
 * platlibdir is the sys.platlibdir of the environment's interpreter, which must be lib. A link named lib64 must link to lib;
 * no other link may exist, and lib64 may be absent (macOS).
 */
export function finishVenv(directory, { platlibdir, root = ROOT }) {
  const relative = path.relative(root, directory);
  if (platlibdir !== 'lib') {
    throw new Error(`${relative} has sys.platlibdir ${platlibdir}, not lib; nothing is changed, and the environment is refused`);
  }
  for (const link of symbolicLinks(directory)) {
    if (link === 'lib64') continue;
    throw new Error(`${path.join(relative, link)} is a symbolic link to ${readlinkSync(path.join(directory, link))}; the venv holds no symbolic link other than lib64`);
  }
  const lib64 = path.join(directory, 'lib64');
  const stat = lstatSync(lib64, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (!stat.isSymbolicLink()) {
    throw new Error(`${path.join(relative, 'lib64')} is ${stat.isDirectory() ? 'a directory' : 'a file'}, not a symbolic link to lib; the venv holds no copy of lib`);
  }
  const target = readlinkSync(lib64);
  if (target !== 'lib') throw new Error(`${path.join(relative, 'lib64')} links to ${target}, not to lib; the venv holds no link to another directory`);
  unlinkSync(lib64);
}

/** The sys values of the interpreter `python`: its version, its platlibdir and its sys.path. */
function interpreterFacts(python, env = process.env) {
  const code = 'import json, platform, sys; print(json.dumps([platform.python_version(), sys.platlibdir, sys.path]))';
  const [version, platlibdir, paths] = JSON.parse(execFileSync(python, ['-c', code], { encoding: 'utf8', env }));
  return { version, platlibdir, paths };
}

/**
 * Why the existing virtual environment `directory` is not a venv of the checkout Python as this tool makes it, or undefined:
 * the rule of run-tests (pyvenv.cfg home, no symbolic link), the version of the checkout Python, platlibdir lib and no lib64 in
 * sys.path.
 */
export function existingVenvProblem(directory, root = ROOT, env = process.env) {
  const relative = path.relative(root, directory);
  const problem = venvProblem(directory, root);
  if (problem) return problem;
  const interpreter = path.join(directory, 'bin/python');
  if (!existsSync(interpreter)) return `${relative} has no bin/python`;
  const venv = interpreterFacts(interpreter, env);
  const checkout = interpreterFacts(toolsPath(root, 'bin', 'python3'), env);
  if (venv.version !== checkout.version) return `${relative} runs Python ${venv.version}, the checkout Python is ${checkout.version}`;
  if (venv.platlibdir !== 'lib') return `${relative} has the platlibdir ${venv.platlibdir}, not lib`;
  const named = venv.paths.filter(entry => entry.includes('lib64'));
  if (named.length > 0) return `${relative} has sys.path entries that name lib64 (${named.join(', ')})`;
  return undefined;
}

/**
 * Makes the virtual environment `directory` from the checkout Python, or accepts it unchanged when it already is one: the run
 * is idempotent. An existing directory that is not such a venv is an error with its reason; it is neither removed nor repaired.
 */
export function makeVenv({ root = ROOT, directory, env = process.env, print = () => {} }) {
  const relative = path.relative(root, directory);
  const python = toolsPath(root, 'bin', 'python3');
  if (!existsSync(python)) {
    throw new Error(`${path.relative(root, python)} is missing; declare pythonBuild in config/toolchain.json and run make install-tools TOOLS=python`);
  }
  if (lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
    const problem = existingVenvProblem(directory, root, env);
    if (problem) throw new Error(`${relative} exists and is not a venv of the checkout Python: ${problem}; it is neither removed nor repaired`);
    print(`${relative} unchanged: a venv of the checkout Python with no symbolic link`);
    return;
  }
  run(python, ['-m', 'venv', '--copies', '--without-pip', directory], { cwd: root, env }, print);
  try {
    const { platlibdir } = interpreterFacts(path.join(directory, 'bin/python'), env);
    finishVenv(directory, { platlibdir, root });
    const problem = existingVenvProblem(directory, root, env);
    if (problem) throw new Error(problem);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  print(`made ${relative} with no symbolic link`);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1) throw new Error('Usage: node scripts/kit/python-venv.mjs <directory>');
    makeVenv({ directory: path.resolve(ROOT, args[0]), print: text => process.stdout.write(`${text}\n`) });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
