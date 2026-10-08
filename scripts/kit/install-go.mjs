// Installs the Go release that config/toolchain.json go declares into var/tools/go, with the wrappers go and gofmt in
// var/tools/bin. The release is downloaded by the Go of the machine as the module
// golang.org/toolchain@v0.0.1-go<version>.<os>-<arch> into a module cache of var/tools (GOTOOLCHAIN=local, so that the Go
// of the machine selects no other toolchain). An installed release is kept. The Go of the machine is never changed.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { installOnce } from './install-tool.mjs';
import { bootstrapEnvironment, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mjs';

const ARCHITECTURES = { x64: 'amd64', arm64: 'arm64' };
const SYSTEMS = new Set(['darwin', 'linux']);

/** The module of the Go toolchain `version` for a platform. */
export function goToolchainModule(version, platform = process.platform, arch = process.arch) {
  if (!ARCHITECTURES[arch]) throw new Error(`no Go toolchain module for the architecture ${arch}; the architectures are ${Object.keys(ARCHITECTURES).join(', ')}`);
  if (!SYSTEMS.has(platform)) throw new Error(`no Go toolchain module for the platform ${platform}; the platforms are ${[...SYSTEMS].join(', ')}`);
  return `golang.org/toolchain@v0.0.1-go${version}.${platform}-${ARCHITECTURES[arch]}`;
}

// The module zip of a Go toolchain keeps no file modes; like the toolchain switch of go, make the commands of bin and
// pkg/tool executable.
function makeExecutable(goroot) {
  const tool = path.join(goroot, 'pkg/tool');
  const directories = [path.join(goroot, 'bin'), ...(existsSync(tool) ? readdirSync(tool).map(name => path.join(tool, name)) : [])];
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      if (statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0o111) chmodSync(file, 0o755);
    }
  }
}

/** Installs the declared Go `{ version }` into var/tools/go of `root` and writes the wrappers; returns `{ installed, release }`. */
export function installGo({ root, declared, print = () => {} }) {
  const module = goToolchainModule(declared.version);
  const prefix = toolsPath(root, 'go');
  const result = installOnce({
    root, label: 'Go', prefix, recorded: declared.version, print,
    installedRelease: (directory) => {
      const file = path.join(directory, module, 'VERSION');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].replace(/^go/, '') : undefined;
    },
    install: (next) => {
      // The module cache of var/tools is writable (-modcacherw), so removing var/ needs no change of permissions.
      run('go', ['mod', 'download', '-x', module], {
        cwd: next, env: bootstrapEnvironment(root, { GOMODCACHE: next, GOFLAGS: '-modcacherw', GOTOOLCHAIN: 'local', GOWORK: 'off', GO111MODULE: 'on' }),
      }, print);
      // The downloaded zip is not needed once the toolchain is unpacked.
      rmSync(path.join(next, 'cache'), { recursive: true, force: true });
    },
  });
  const goroot = path.join(prefix, module);
  makeExecutable(goroot);
  for (const name of ['go', 'gofmt']) {
    writeWrapper(root, name, wrapperText(`${name} of Go ${declared.version} of this checkout`, `GOTOOLCHAIN=local exec ${quote(path.join(goroot, 'bin', name))} "$@"`), print);
  }
  return result;
}
