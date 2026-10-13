#!/usr/bin/env node
// Makes a virtual environment of the checkout's Python with the uv of the checkout (`make python-venv DIR=<directory>`), and
// holds the rule that run-tests --venv checks (venvProblem): the environment comes from a Python that the uv of the checkout
// installed (var/tools/uv-python, install-python.mjs). The environment is left as uv makes it, its symbolic links included:
// they are uv's behavior.
//
//   node scripts/kit/python-venv.mjs <directory>
//
// The run is idempotent: an existing directory that already is a venv of the checkout Python (run-tests' rule and the same
// Python version) is accepted unchanged; any other existing directory is an error with its reason and is neither removed nor
// repaired. An absent directory is made with `var/tools/bin/uv venv --python var/tools/bin/python3`, and the environment is
// checked by venvProblem. A failure removes the directory that this run made, so no partial environment is left behind.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isMain, ROOT } from './paths.mjs';
import { run, toolsPath } from './tool-wrappers.mjs';

const MAKE = (directory) => `make it from the checkout Python, with make python-venv DIR=${directory} or var/tools/bin/uv venv --python var/tools/bin/python3 ${directory}`;

/** Whether `file` lies in `directory`, both read through their links. */
function inside(file, directory) {
  if (!existsSync(file) || !existsSync(directory)) return false;
  const relative = path.relative(realpathSync(directory), realpathSync(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Why the virtual environment `venv` may not run the python tests of `root`, or undefined when it may: its pyvenv.cfg names as
 * its home a directory of var/tools/uv-python, where the uv of the checkout installs the Python. Its symbolic links are not
 * checked: they are the behavior of the tool that made it.
 */
export function venvProblem(venv, root = ROOT) {
  const config = path.join(venv, 'pyvenv.cfg');
  const relative = path.relative(root, venv);
  const make = MAKE(relative);
  if (!existsSync(config)) return `${relative} is not a virtual environment (no pyvenv.cfg); ${make}`;
  const home = /^home\s*=\s*(.+)$/m.exec(readFileSync(config, 'utf8'))?.[1].trim();
  const installs = toolsPath(root, 'uv-python');
  if (!home || !inside(home, installs)) {
    return `${relative} was made from ${home ?? 'no home'}, not from a Python of this checkout (${path.relative(root, installs)}); ${make}`;
  }
  return undefined;
}

/** The Python version of the interpreter `python`. */
const pythonVersion = (python, env) => execFileSync(python, ['-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8', env }).trim();

/**
 * Why the existing virtual environment `directory` is not a venv of the checkout Python, or undefined: the rule of run-tests
 * (venvProblem), a bin/python, and the version of the checkout Python.
 */
export function existingVenvProblem(directory, root = ROOT, env = process.env) {
  const relative = path.relative(root, directory);
  const problem = venvProblem(directory, root);
  if (problem) return problem;
  const interpreter = path.join(directory, 'bin/python');
  if (!existsSync(interpreter)) return `${relative} has no bin/python`;
  const venv = pythonVersion(interpreter, env);
  const checkout = pythonVersion(toolsPath(root, 'bin', 'python3'), env);
  if (venv !== checkout) return `${relative} runs Python ${venv}, the checkout Python is ${checkout}`;
  return undefined;
}

/**
 * Makes the virtual environment `directory` from the checkout Python with the uv of the checkout, or accepts it unchanged when
 * it already is one: the run is idempotent. An existing directory that is not such a venv is an error with its reason; it is
 * neither removed nor repaired.
 */
export function makeVenv({ root = ROOT, directory, env = process.env, print = () => {} }) {
  const relative = path.relative(root, directory);
  const python = toolsPath(root, 'bin', 'python3');
  const uv = toolsPath(root, 'bin', 'uv');
  for (const [file, fix] of [[uv, 'declare uv in config/toolchain.json and run make install-tools TOOLS=uv'], [python, 'declare pythonBuild in config/toolchain.json and run make install-tools TOOLS=python']]) {
    if (!existsSync(file)) throw new Error(`${path.relative(root, file)} is missing; ${fix}`);
  }
  if (lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
    const problem = existingVenvProblem(directory, root, env);
    if (problem) throw new Error(`${relative} exists and is not a venv of the checkout Python: ${problem}; it is neither removed nor repaired`);
    print(`${relative} unchanged: a venv of the checkout Python`);
    return;
  }
  run(uv, ['venv', '--quiet', '--python', python, directory], { cwd: root, env }, print);
  try {
    const problem = existingVenvProblem(directory, root, env);
    if (problem) throw new Error(problem);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  print(`made ${relative}`);
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
