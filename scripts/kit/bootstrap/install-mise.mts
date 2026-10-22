// Installs the mise release that config/toolchain.json mise declares into var/tools/mise-release, with the wrapper mise in
// var/tools/bin; the data, cache, state and config of mise, its installs and its shims, are var/tools/mise.
// mise installs every other tool of the checkout from mise.toml and mise.lock, so it is installed first by the bootstrap, which
// then installs the node of mise.toml with it (installNode), before npm and before any package (K171). The archive is mise-v<version>-<os>-<arch>.tar.gz of the GitHub release of mise for
// this platform; the download is refused unless its sha256 is the digest that the declaration gives for the platform. The
// wrapper keeps every directory that mise reads or writes under var/tools, records the trust of the config of the checkout (trustConfig) and installs only
// what mise.lock pins (MISE_LOCKED), so nothing of the machine changes and no config of the home is read.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
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

/**
 * Records the trust of the mise.toml of the checkout `root` with `mise trust` in the state dir of the checkout (MISE_STATE_DIR),
 * run by the mise `binary` with the environment of mise of the checkout. Each shim of the checkout reads that config only once it
 * is trusted there, so a new worktree is trusted by its own install of mise and no environment variable trusts a path (K208).
 * The trust of the checkout is then the only entry of its trusted-configs: the other entries, of the home directory, of other
 * checkouts and of removed worktrees, are removed.
 */
export function trustConfig({ root, binary, print = () => {} }: { root: string; binary: string; print?: (text: string) => void }): void {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...miseEnvironment(root) };
  // With MISE_GLOBAL_CONFIG_FILE set, `mise trust` trusts the global configuration instead of the file it names, so it is unset here (K208).
  delete environment.MISE_GLOBAL_CONFIG_FILE;
  run(binary, ['trust', path.join(root, 'mise.toml')], { cwd: root, env: environment }, print);
  removeForeignTrusts(root);
}

/** Removes the entries of trusted-configs of the checkout `root` that trust something other than its own mise.toml. */
export function removeForeignTrusts(root: string): void {
  const directory = toolsPath(root, 'mise', 'state', 'trusted-configs');
  for (const { name } of foreignTrusts(root)) rmSync(path.join(directory, name), { recursive: true, force: true });
}

/**
 * The entries of trusted-configs of the checkout `root` that trust something other than the mise.toml of the checkout, each with
 * the path it trusts (K397). mise records a trust as a link to the folder of the file, so a link to the home directory trusts every
 * mise.toml under it, and a link to the folder of a removed worktree trusts a folder that no longer holds a config.
 */
export function foreignTrusts(root: string): { name: string; target: string }[] {
  const directory = toolsPath(root, 'mise', 'state', 'trusted-configs');
  if (!existsSync(directory)) return [];
  const own = new Set([path.resolve(root), realpathSync(root)]);
  const found: { name: string; target: string }[] = [];
  for (const name of readdirSync(directory)) {
    const entry = path.join(directory, name);
    const target = lstatSync(entry).isSymbolicLink() ? path.resolve(directory, readlinkSync(entry)) : entry;
    if (!own.has(target)) found.push({ name, target });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** The download URL of the mise archive of `version` for the asset `asset`. */
export const miseArchiveUrl = (version: string, asset: string): string => `https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-${asset}.tar.gz`;

/**
 * The environment in which the tools of mise run from its shims, var/tools/mise/shims, for the checkout `root`: the directories
 * of mise under var/tools/mise, mise.toml of the checkout as the global configuration, so a shim runs the tool of the
 * checkout from any directory instead of the next command of its name on PATH, the trusted config of the checkout, only what
 * mise.lock pins and no install on its own (a
 * missing tool is an error until make install-tools), and no uv that downloads a Python or reads a uv.toml of the home or the
 * system; uv keeps its cache in var/tools/mise. A tool that mise runs from uv gets the Python of mise from mise; the uv of a check gets it from UV_PYTHON
 * (toolsEnvironment of mise-tools.mts). var/tools is that of the main checkout (toolsPath, K519): a linked worktree runs the data,
 * the installs and the shims that the main checkout installed and keeps only its own mise.toml as the global configuration, which
 * mise reads without a trust, so a uv tool such as vulture, whose install mise keys by its data dir, is the one of the main checkout.
 */
export function miseEnvironment(root: string): Record<string, string> {
  return {
    MISE_DATA_DIR: toolsPath(root, 'mise'),
    MISE_CACHE_DIR: toolsPath(root, 'mise', 'cache'),
    MISE_STATE_DIR: toolsPath(root, 'mise', 'state'),
    MISE_CONFIG_DIR: toolsPath(root, 'mise', 'config'),
    MISE_GLOBAL_CONFIG_FILE: path.join(root, 'mise.toml'),
    // mise install records the trust of the root of the global config, the home directory unless this names the checkout (K397-1).
    MISE_GLOBAL_CONFIG_ROOT: root,
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
  trustConfig({ root, binary: binary(prefix), print });
  writeWrapper(root, MISE_WRAPPER, miseWrapper(root, binary(prefix), declared.version), print);
  writeAtomic(toolsPath(root, 'go.mod'), TOOLS_GO_MOD);
  return result;
}

/**
 * The directory of the install of the tool `key` of mise.toml of the checkout `root`, which `mise where` prints when the mise of
 * the checkout runs in `root`: mise reads the mise.toml of the checkout, whichever mise.toml governs the directory where the tool
 * later runs, so a tool started by a path under it runs outside the shims (K199).
 */
export function miseWhere(root: string, key: string): string {
  return execFileSync(toolsPath(root, 'bin', MISE_WRAPPER), ['where', key], { cwd: root, env: bootstrapEnvironment(root), encoding: 'utf8' }).trim();
}

/** The wrapper of var/tools/bin that runs the Node.js of mise.toml, which mise installs into var/tools/mise. */
export const NODE_WRAPPER = 'node';

/**
 * Installs the Node.js of mise.toml at the digest of mise.lock with the mise of the checkout (`mise install --locked node`)
 * and writes the wrapper node of var/tools/bin, which starts that node by the absolute path that `mise where node` prints.
 * The wrapper runs node itself, not the shim of mise: a shim puts the bin directory of the install, with the npm that Node.js
 * bundles, first on the PATH of node, so a command npm of a tool would not run the npm of packageManager. A mise.toml that
 * declares no node, or a mise.lock that does not pin it, fails the install of mise. Returns the path of the wrapper.
 */
export function installNode({ root, print = () => {} }: { root: string; print?: (text: string) => void }): string {
  const mise = toolsPath(root, 'bin', MISE_WRAPPER);
  try {
    run(mise, ['install', '--locked', 'node'], { cwd: root, env: bootstrapEnvironment(root) }, print);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(`${error.message}; mise.toml must declare node, the Node.js release of the checkout, and mise.lock must pin it (make toolchain-lock)`, { cause: error });
  }
  const directory = miseWhere(root, 'node');
  writeWrapper(root, NODE_WRAPPER, wrapperText('the Node.js of mise.toml of this checkout', `exec ${quote(path.join(directory, 'bin', 'node'))} "$@"`), print);
  return toolsPath(root, 'bin', NODE_WRAPPER);
}
