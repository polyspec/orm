// Installs the Python release that config/toolchain.json pythonBuild declares with the uv of the checkout
// (var/tools/bin/uv, install-uv.mjs), and writes the wrapper python3 in var/tools/bin. `uv python install` downloads the
// python-build-standalone build that the pinned uv release names for the version, checks its sha256 and installs it into
// var/tools/uv-python (UV_PYTHON_INSTALL_DIR of the wrapper) as uv lays it out, its links included; --no-bin writes no
// command outside that directory. `uv python find` names the installed interpreter, which the wrapper runs by its absolute
// path. uv keeps an installed release, and the Python of the machine is never used or changed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { printedRelease, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mjs';

/** The interpreter of the uv-managed Python `version` of the checkout, or undefined when uv has not installed it. */
function managedPython(uv, version, root) {
  try {
    const found = execFileSync(uv, ['python', 'find', '--managed-python', '--no-project', version], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

/** Installs the declared Python `{ version }` with the uv of var/tools and writes the wrapper var/tools/bin/python3. */
export function installPython({ root, declared, print = () => {} }) {
  const uv = toolsPath(root, 'bin', 'uv');
  if (!existsSync(uv)) throw new Error(`Python needs ${path.relative(root, uv)}, which installs it; declare uv in config/toolchain.json and run make install-tools TOOLS=uv`);
  const where = path.relative(root, toolsPath(root, 'uv-python'));
  const before = managedPython(uv, declared.version, root);
  if (before) print(`Python: ${declared.version} is installed in ${where}`);
  else {
    print(`Python: none is installed in ${where}; installing ${declared.version}`);
    run(uv, ['python', 'install', '--no-bin', declared.version], { cwd: root }, print);
  }
  const python = managedPython(uv, declared.version, root);
  const release = python && printedRelease(python, 'python');
  if (release !== declared.version) throw new Error(`the installation of Python ${declared.version} by ${path.relative(root, uv)} prints ${release}; expected ${declared.version}`);
  if (!before) print(`Python: installed ${declared.version} in ${where}`);
  writeWrapper(root, 'python3', wrapperText(`Python ${declared.version} of this checkout`, `exec ${quote(python)} "$@"`), print);
  return { installed: !before, release };
}
