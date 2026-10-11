// Installs the ruff release that config/toolchain.json ruff declares into the virtual environment var/tools/python, with the
// wrapper ruff in var/tools/bin. The wheel of this platform is downloaded by installBackend with the sha256 of each declared
// wheel, so pip refuses a wheel that is not declared; the environment is made with var/tools/bin/python3, the Python that
// install-python.mjs installs, and holds copies of the interpreter, not links. An installed release is kept. The Python of the
// machine is never used.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { installOnce } from './install-tool.mjs';
import { installBackend } from './release-backend.mjs';
import { bootstrapEnvironment, printedRelease, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mjs';

/** Installs the declared ruff `{ version, sha256, source }` into var/tools/python of `root` and writes the wrapper. */
export function installRuff({ root, declared, print = () => {} }) {
  const python = toolsPath(root, 'bin', 'python3');
  if (!existsSync(python)) throw new Error(`ruff needs ${path.relative(root, python)}, the Python that config/toolchain.json pythonBuild declares; declare pythonBuild and run make install-tools TOOLS=python`);
  const prefix = toolsPath(root, 'python');
  const result = installOnce({
    root, label: 'ruff', prefix, recorded: declared.version, installedRelease: prefix => printedRelease(path.join(prefix, 'bin/ruff'), 'ruff'), print,
    install: (next) => {
      const environment = bootstrapEnvironment(root);
      const { file } = installBackend({ root, env: environment, requirement: `ruff==${declared.version}`, digests: Object.values(declared.sha256), source: declared.source, print });
      run(python, ['-m', 'venv', '--copies', next], { cwd: root, env: environment }, print);
      run(path.join(next, 'bin/python'), ['-m', 'pip', 'install', '--quiet', '--no-index', '--no-deps', file], { cwd: root, env: environment }, print);
    },
  });
  writeWrapper(root, 'ruff', wrapperText(`ruff ${declared.version} of this checkout`, `exec ${quote(path.join(prefix, 'bin/ruff'))} "$@"`), print);
  return result;
}
