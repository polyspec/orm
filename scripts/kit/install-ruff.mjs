// Installs the ruff release that the pyproject.toml of config/toolchain.json ruff pins into the virtual environment
// var/tools/python, with the wrapper ruff in var/tools/bin. The environment is made with the interpreter
// python<minor> of the machine, where the minor release is the declared Python, and holds copies of the interpreter, not
// links. An installed release is kept. The Python of the machine is never changed.
import path from 'node:path';
import { installOnce } from './install-tool.mjs';
import { bootstrapEnvironment, printedRelease, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mjs';

/** Installs the declared ruff `{ version }` with the Python `python` `{ minor }` into var/tools/python of `root` and writes the wrapper. */
export function installRuff({ root, declared, python, print = () => {} }) {
  if (!python) throw new Error('ruff needs the Python minor release of its virtual environment; declare python in config/toolchain.json or write .python-version');
  const prefix = toolsPath(root, 'python');
  const result = installOnce({
    root, label: 'ruff', prefix, recorded: declared.version, installedRelease: prefix => printedRelease(path.join(prefix, 'bin/ruff'), 'ruff'), print,
    install: (next) => {
      const environment = bootstrapEnvironment(root);
      run(`python${python.minor}`, ['-m', 'venv', '--copies', next], { cwd: root, env: environment }, print);
      run(path.join(next, 'bin/python'), ['-m', 'pip', 'install', '--quiet', `ruff==${declared.version}`], { cwd: root, env: environment }, print);
    },
  });
  writeWrapper(root, 'ruff', wrapperText(`ruff ${declared.version} of this checkout`, `exec ${quote(path.join(prefix, 'bin/ruff'))} "$@"`), print);
  return result;
}
