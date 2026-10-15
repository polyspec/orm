// Installs the mise release that config/toolchain.json mise declares into var/tools/mise-release, with the wrapper mise in
// var/tools/bin; the data, cache, state and config of mise, its installs and its shims, are var/tools/mise.
// mise installs every other tool of the checkout from mise.toml and mise.lock, so it is installed by the bootstrap, after the npm
// of packageManager and before any package. The archive is mise-v<version>-<os>-<arch>.tar.gz of the GitHub release of mise for
// this platform; the download is refused unless its sha256 is the digest that the declaration gives for the platform. The
// wrapper keeps every directory that mise reads or writes under var/tools, trusts the config of the checkout and installs only
// what mise.lock pins (MISE_LOCKED), so nothing of the machine changes and no config of the home is read.
import { rmSync } from 'node:fs';
import { writeAtomic } from './files.mts';
import path from 'node:path';
import { fileDigest } from './digest.mts';
import { installOnce } from './install-tool.mts';
import { bootstrapEnvironment, printedRelease, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mts';

// The asset of the mise archive of each platform key (process.platform-process.arch) that the declaration may name.
export const MISE_ASSETS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

/** The download URL of the mise archive of `version` for the asset `asset`. */
export const miseArchiveUrl = (version: string, asset: string): string => `https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-${asset}.tar.gz`;

/**
 * The environment in which the tools of mise run from its shims, var/tools/mise/shims, for the checkout `root`: the directories
 * of mise under var/tools/mise, mise.toml of the checkout as the global configuration, so a shim runs the tool of the
 * checkout from any directory instead of the next command of its name on PATH, the trusted config of the checkout, only what
 * mise.lock pins and no install on its own (a
 * missing tool is an error until make install-tools), and no uv that downloads a Python or reads a uv.toml of the home or the
 * system; uv keeps its cache in var/tools/mise. A tool that mise runs from uv gets the Python of mise from mise; the uv of a check gets it from UV_PYTHON
 * (toolsEnvironment of mise-tools.mts).
 */
export function miseEnvironment(root: string): Record<string, string> {
  return {
    MISE_DATA_DIR: toolsPath(root, 'mise'),
    MISE_CACHE_DIR: toolsPath(root, 'mise', 'cache'),
    MISE_STATE_DIR: toolsPath(root, 'mise', 'state'),
    MISE_CONFIG_DIR: toolsPath(root, 'mise', 'config'),
    MISE_GLOBAL_CONFIG_FILE: path.join(root, 'mise.toml'),
    MISE_TRUSTED_CONFIG_PATHS: root,
    MISE_LOCKED: '1',
    MISE_AUTO_INSTALL: '0',
    UV_PYTHON_DOWNLOADS: 'never',
    UV_NO_CONFIG: '1',
    UV_CACHE_DIR: toolsPath(root, 'mise', 'cache', 'uv'),
  };
}

/**
 * The environment of mise itself, which installs and locks the tools: miseEnvironment, and the module and build caches of the
 * Go that builds a tool under var/tools/mise, so nothing outside the checkout changes. Go checks every module that it
 * downloads against its checksum database (GOSUMDB, with no module exempt) and changes no go.mod (-mod=readonly); its module
 * cache stays writable (-modcacherw), so var/tools can be removed.
 */
export function miseInstallEnvironment(root: string): Record<string, string> {
  return {
    ...miseEnvironment(root),
    GOPATH: toolsPath(root, 'mise', 'go'),
    GOCACHE: toolsPath(root, 'mise', 'cache', 'go-build'),
    GOFLAGS: '-mod=readonly -modcacherw',
    GOSUMDB: 'sum.golang.org',
    GONOSUMDB: '',
    GOPRIVATE: '',
    GOINSECURE: '',
  };
}

// The text of the wrapper mise: the environment of mise for the checkout, then the binary. mise links each shim to the mise
// that PATH names, so the directory of the binary comes first on PATH: a shim that linked this wrapper would run mise itself,
// since the wrapper drops the name of the shim.
function miseWrapper(root: string, binary: string, version: string) {
  const variables = miseInstallEnvironment(root);
  const lines = [
    ...Object.entries(variables).map(([name, value]) => `${name}=${quote(value)}`),
    `PATH=${quote(path.dirname(binary))}:"$PATH"`,
    `export ${Object.keys(variables).join(' ')} PATH`,
    `exec ${quote(binary)} "$@"`,
  ];
  return wrapperText(`mise ${version} of this checkout`, lines.join('\n'));
}

/**
 * The go.mod of var/tools: mise installs Go there with the test sources of its distribution, and a repository whose root is a Go
 * module walks its whole tree with ./...; a go.mod makes var/tools a module of its own, which the pattern of an enclosing module
 * does not enter (K135). It names no package and requires nothing.
 */
export const TOOLS_GO_MOD = '// The tools of this checkout, a module of its own so that ./... of the repository does not walk them (kit K135).\nmodule var-tools\n';

/**
 * Installs the declared mise `{ version, sha256 }` (sha256 by platform key) into var/tools/mise-release of `root`, writes the
 * wrapper, and writes the go.mod of var/tools.
 */
/** The wrapper of var/tools/bin that runs the installed mise. */
export const MISE_WRAPPER = 'mise';

export function installMise({ root, declared, platform = `${process.platform}-${process.arch}`, print = () => {} }: { root: string; declared: { version: string; sha256: Readonly<Record<string, string>> }; platform?: string; print?: (text: string) => void }) {
  const asset = MISE_ASSETS[platform];
  if (!asset) throw new Error(`no mise archive is verified for ${platform}; the verified platforms are ${Object.keys(MISE_ASSETS).join(', ')}`);
  const sha256 = declared.sha256[platform];
  if (!sha256) throw new Error(`config/toolchain.json mise declares no sha256 for ${platform}; declare the digest of mise-v${declared.version}-${asset}.tar.gz`);
  const url = miseArchiveUrl(declared.version, asset);
  const prefix = toolsPath(root, 'mise-release');
  const binary = (directory: string) => path.join(directory, 'mise', 'bin', 'mise');
  const result = installOnce({
    root, label: 'mise', prefix, recorded: declared.version, installedRelease: (directory: string) => printedRelease(binary(directory), 'mise'), print,
    install: (next: string) => {
      const archive = path.join(next, `mise-${asset}.tar.gz`);
      const environment = bootstrapEnvironment(root);
      run('curl', ['--fail', '--silent', '--show-error', '--location', '--output', archive, url], { cwd: root, env: environment }, print);
      const actual = fileDigest(archive);
      if (actual !== sha256) {
        rmSync(archive, { force: true });
        throw new Error(`${url} has the sha256 ${actual}; config/toolchain.json mise declares ${sha256} for ${platform}`);
      }
      run('tar', ['-xzf', archive, '-C', next], { cwd: root, env: environment }, print);
      rmSync(archive, { force: true });
    },
  });
  writeWrapper(root, MISE_WRAPPER, miseWrapper(root, binary(prefix), declared.version), print);
  writeAtomic(toolsPath(root, 'go.mod'), TOOLS_GO_MOD);
  return result;
}
