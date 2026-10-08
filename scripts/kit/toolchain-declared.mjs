// The toolchain versions that a checkout declares, read from the files that declare them. Each entry names its version
// and the declaring file, so that an install and a check name the file in a message:
//   node         .node-version
//   npm          packageManager of package.json: npm@<version>, optionally +sha512.<digest of the registry tarball>
//   go           config/toolchain.json go: the versionFile, else the toolchain line, else the go directive of the go.mod
//   rust         channel of rust-toolchain.toml
//   php          config/toolchain.json php (minor releases), else .php-version
//   python       config/toolchain.json python (minor release), else .python-version
//   composer     config/toolchain.json composer
//   ruff         the ruff==<version> pin of the pyproject.toml that config/toolchain.json ruff names
//   cargoAudit   config/toolchain.json cargoAudit
//   govulncheck  config/toolchain.json govulncheck
// A tool is declared when its file exists (node, rust) or its config key is present; an undeclared tool is absent from the
// result. A malformed declaration throws an error with the file, the expected form and the actual value.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const EXACT = /^\d+\.\d+\.\d+$/;
const MINOR = /^\d+\.\d+$/;
const read = (root, file) => readFileSync(path.join(root, file), 'utf8');

function exact(file, what, value) {
  if (!EXACT.test(value ?? '')) throw new Error(`${file} must record ${what} as <major>.<minor>.<patch>; it records ${JSON.stringify(value)}`);
  return value;
}

function minor(file, what, value) {
  if (!MINOR.test(value ?? '')) throw new Error(`${file} must record ${what} as <major>.<minor>; it records ${JSON.stringify(value)}`);
  return value;
}

/** The parsed config/toolchain.json of `root`, or an empty object when the repository has none. */
export function toolchainConfig(root) {
  return existsSync(path.join(root, 'config/toolchain.json')) ? JSON.parse(read(root, 'config/toolchain.json')) : {};
}

function goVersion(root, go) {
  const mod = read(root, go.mod);
  const directive = /^go (\d+\.\d+(?:\.\d+)?)$/m.exec(mod)?.[1];
  const toolchain = /^toolchain go(\d+\.\d+\.\d+)$/m.exec(mod)?.[1];
  if (go.versionFile) {
    const version = exact(go.versionFile, 'the Go release', read(root, go.versionFile).trim());
    // The go directive of the module is the minimum language version: it is the minor release or the release itself.
    if (directive && directive !== version && directive !== version.split('.').slice(0, 2).join('.')) {
      throw new Error(`${go.mod} declares go ${directive}, but ${go.versionFile} declares ${version}; write go ${version.split('.').slice(0, 2).join('.')} in ${go.mod}`);
    }
    return { version, source: go.versionFile };
  }
  if (toolchain) return { version: toolchain, source: `${go.mod} toolchain` };
  if (!directive || !EXACT.test(directive)) throw new Error(`${go.mod} has no toolchain line or go directive <major>.<minor>.<patch>; it has ${JSON.stringify(directive)}`);
  return { version: directive, source: `${go.mod} go directive` };
}

/** The exact release that config/toolchain.json of `root` records for `key`; an error names the expected form when it is missing or not exact. */
export const recordedRelease = (root, key) => exact('config/toolchain.json', key, toolchainConfig(root)[key]);

/** The declared toolchains of the checkout at `root`. */
export function declaredToolchain(root) {
  const config = toolchainConfig(root);
  const declared = {};
  if (existsSync(path.join(root, '.node-version'))) {
    declared.node = { version: exact('.node-version', 'the Node.js release', read(root, '.node-version').trim()), source: '.node-version' };
  }
  if (existsSync(path.join(root, 'package.json'))) {
    const manager = JSON.parse(read(root, 'package.json')).packageManager ?? '';
    const match = /^npm@(\d+\.\d+\.\d+)(?:\+sha512\.([0-9a-f]{128}))?$/.exec(manager);
    if (!match) throw new Error(`package.json packageManager is ${JSON.stringify(manager)}, expected npm@<major>.<minor>.<patch> or npm@<major>.<minor>.<patch>+sha512.<128 hexadecimal digits>`);
    declared.npm = { version: match[1], sha512: match[2], source: 'packageManager of package.json' };
  }
  if (config.go) declared.go = goVersion(root, config.go);
  if (existsSync(path.join(root, 'rust-toolchain.toml'))) {
    const channel = /^\s*channel\s*=\s*"([^"]*)"\s*$/m.exec(read(root, 'rust-toolchain.toml'))?.[1];
    declared.rust = { version: exact('rust-toolchain.toml', 'channel', channel), source: 'rust-toolchain.toml channel' };
  }
  const phpFile = existsSync(path.join(root, '.php-version')) ? minor('.php-version', 'the PHP minor release', read(root, '.php-version').trim()) : undefined;
  if (config.php) {
    for (const value of config.php) minor('config/toolchain.json', 'php as a list of minor releases', value);
    if (phpFile && !config.php.includes(phpFile)) throw new Error(`.php-version declares ${phpFile}, but config/toolchain.json php lists ${config.php.join(', ')}; list ${phpFile} or change .php-version`);
    declared.php = { minors: config.php, source: 'config/toolchain.json php' };
  } else if (phpFile) {
    declared.php = { minors: [phpFile], source: '.php-version' };
  }
  const pythonFile = existsSync(path.join(root, '.python-version')) ? minor('.python-version', 'the Python minor release', read(root, '.python-version').trim()) : undefined;
  if (config.python) {
    minor('config/toolchain.json', 'python', config.python);
    if (pythonFile && pythonFile !== config.python) throw new Error(`.python-version declares ${pythonFile}, but config/toolchain.json python declares ${config.python}; declare one minor release`);
    declared.python = { minor: config.python, source: 'config/toolchain.json python' };
  } else if (pythonFile) {
    declared.python = { minor: pythonFile, source: '.python-version' };
  }
  if (config.composer) {
    declared.composer = { version: exact('config/toolchain.json', 'composer', config.composer.version), sha256: config.composer.sha256, source: 'config/toolchain.json composer' };
  }
  if (config.ruff) {
    const pins = new Set([...read(root, config.ruff.pyproject).matchAll(/"ruff==(\d+\.\d+\.\d+)"/g)].map(match => match[1]));
    if (pins.size !== 1) throw new Error(`${config.ruff.pyproject} must pin one ruff==<major>.<minor>.<patch>; it pins ${pins.size === 0 ? 'none' : [...pins].join(', ')}`);
    declared.ruff = { version: [...pins][0], source: `${config.ruff.pyproject} ruff pin` };
  }
  for (const key of ['cargoAudit', 'govulncheck']) {
    if (config[key]) declared[key] = { version: recordedRelease(root, key), source: `config/toolchain.json ${key}` };
  }
  return declared;
}
