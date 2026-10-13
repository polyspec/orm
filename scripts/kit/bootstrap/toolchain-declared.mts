// The toolchain versions that a checkout declares, read from the files that declare them. Each entry names its version
// and the declaring file, so that an install and a check name the file in a message:
//   node         .node-version
//   npm          packageManager of package.json: npm@<version>, optionally +sha512.<digest of the registry tarball>
//   php          config/toolchain.json php (minor releases), else .php-version
//   python       config/toolchain.json python (minor release), else .python-version
//   pythonBuild  config/toolchain.json pythonBuild: the exact Python release of the python minor, which the declared uv installs
//   pythonBackend config/toolchain.json pythonBackend: the requirement name==version of the build backend of the Python wheels and its sha256
//   composer     config/toolchain.json composer
//   phpunit      config/toolchain.json phpunit: the exact release, installed from the composer.json and composer.lock of config/phpunit
//   uv           config/toolchain.json uv: the exact version and the sha256 of the release archive of each platform
//   alint        config/toolchain.json alint: the exact version and the sha256 of the release archive of each platform
//   cargoAudit   config/toolchain.json cargoAudit
//   govulncheck  config/toolchain.json govulncheck
//   symbolExtractors config/toolchain.json symbolExtractors: the symbol extractors of the parity check that install-tools builds
// Go and Rust are read by toolchain-files.mts with the tools of their ecosystems, and the lint tools (ruff, vulture,
// golangci-lint, deadcode, the PHP lint) by toolchain-lint.mts, after the bootstrap.
// A tool is declared when its file exists (node) or its config key is present; an undeclared tool is absent from the
// result. A malformed declaration throws an error with the file, the expected form and the actual value.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** A symbol extractor of the parity check that install-tools builds (install-symbols.mts). */
export type InstalledExtractor = 'go' | 'php';
const EXTRACTORS: readonly InstalledExtractor[] = ['go', 'php'];

const EXACT = /^\d+\.\d+\.\d+$/;
const MINOR = /^\d+\.\d+$/;
const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8');

/** A toolchain release and the file that declares it. */
export type Declared = { version: string; source: string };

/** A release with the sha256 of its file for each platform key. */
export type PlatformRelease = { version: string; sha256: Record<string, unknown>; source: string };

/** The declared toolchains of a checkout; an undeclared tool is absent. */
export type DeclaredToolchain = {
  node?: Declared;
  npm?: Declared & { sha512: string | undefined };
  php?: { minors: string[]; source: string };
  python?: { minor: string; source: string };
  uv?: PlatformRelease;
  alint?: PlatformRelease;
  pythonBuild?: Declared;
  pythonBackend?: { requirement: string; sha256: string; source: string };
  composer?: Declared & { sha256: unknown };
  phpunit?: Declared & { manifest: string };
  cargoAudit?: Declared;
  govulncheck?: Declared;
  symbolExtractors?: { extractors: InstalledExtractor[]; source: string };
};

/**
 * The key `key` of a JSON value as JavaScript reads it: undefined when the value lacks it, a TypeError for null. The
 * configuration is not checked against its schema here, so each value stays unknown until a check below reads it.
 */
// The cast only lets TypeScript read the key; the read itself is the same as before.
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key];

// Whether `value` is text that matches `pattern`; a JSON number or list is no text, whatever its text would be.
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);

function exact(file: string, what: string, value: unknown): string {
  if (!matches(EXACT, value)) throw new Error(`${file} must record ${what} as <major>.<minor>.<patch>; it records ${JSON.stringify(value)}`);
  return value;
}

function minor(file: string, what: string, value: unknown): string {
  if (!matches(MINOR, value)) throw new Error(`${file} must record ${what} as <major>.<minor>; it records ${JSON.stringify(value)}`);
  return value;
}

/**
 * The parsed config/toolchain.json of `root`, or an empty object when the repository has none. It is not checked against
 * its schema here, so each value stays unknown until a check reads it; a JSON value that is not an object reads as one
 * without the key, and null fails at the first read with a TypeError, as JavaScript reads them.
 */
export function toolchainConfig(root: string): Record<string, unknown> {
  return existsSync(path.join(root, 'config/toolchain.json')) ? JSON.parse(read(root, 'config/toolchain.json')) : {};
}

/** The exact release that config/toolchain.json of `root` records for `key`; an error names the expected form when it is missing or not exact. */
export const recordedRelease = (root: string, key: string): string => exact('config/toolchain.json', key, toolchainConfig(root)[key]);

// The exact Python release of pythonBuild, which must be a release of the declared python minor: { version }. uv installs it,
// so pythonBuild needs the declaration uv.
function pythonBuild(value: unknown, minor: string | undefined, uv: PlatformRelease | undefined): Declared {
  const file = 'config/toolchain.json pythonBuild';
  if (!minor) throw new Error(`${file} needs python, the minor release of the checks; declare python in config/toolchain.json or write .python-version`);
  const version = exact(file, 'the Python release', field(value, 'version'));
  if (version.split('.').slice(0, 2).join('.') !== minor) throw new Error(`${file} declares ${version}, but python declares ${minor}; declare a release of ${minor}`);
  if (!uv) throw new Error(`${file} needs uv, which installs the Python; declare uv in config/toolchain.json`);
  return { version, source: file };
}

/**
 * The release of a tool of config/toolchain.json `key` that is installed from a file of each platform, its archive or its
 * wheel (`kind`): its exact version and the sha256 of the file of each platform key, each read as 64 hexadecimal digits.
 */
export function platformRelease(key: string, kind: 'archive' | 'wheel', value: unknown): PlatformRelease {
  const file = `config/toolchain.json ${key}`;
  const version = field(value, 'version');
  if (!matches(EXACT, version)) throw new Error(`${file} must record version as <major>.<minor>.<patch>; it records ${JSON.stringify(version)}`);
  // Object.keys and Object.entries read any value: a text fails the digest check on its characters and a number has no keys.
  const digests = (field(value, 'sha256') ?? {}) as Record<string, unknown>;
  if (Object.keys(digests).length === 0) throw new Error(`${file} must record the sha256 of the ${key} ${kind} of each platform, for example linux-x64; it records none`);
  for (const [platform, digest] of Object.entries(digests)) {
    if (!matches(/^[0-9a-f]{64}$/, digest)) throw new Error(`${file} must record the sha256 of ${platform} as 64 lowercase hexadecimal digits; it records ${JSON.stringify(digest)}`);
  }
  return { version, sha256: digests, source: file };
}

// The PHPUnit release of the PHP tests of kit: its exact version; the Composer project that installs it is config/phpunit.
function phpunit(value: unknown): Declared & { manifest: string } {
  const file = 'config/toolchain.json phpunit';
  return { version: exact(file, 'the PHPUnit release', field(value, 'version')), manifest: 'config/phpunit/composer.json', source: file };
}

// The build backend of the Python wheels: its exact requirement name==version and the sha256 of its wheel.
function pythonBackend(value: unknown): { requirement: string; sha256: string; source: string } {
  const file = 'config/toolchain.json pythonBackend';
  const requirement = field(value, 'requirement');
  const sha256 = field(value, 'sha256');
  if (!matches(/^[A-Za-z0-9._-]+==\d+(\.\d+)*$/, requirement)) throw new Error(`${file} must record requirement as name==version; it records ${JSON.stringify(requirement)}`);
  if (!matches(/^[0-9a-f]{64}$/, sha256)) throw new Error(`${file} must record sha256 as 64 lowercase hexadecimal digits; it records ${JSON.stringify(sha256)}`);
  return { requirement, sha256, source: file };
}

/** The declared toolchains of the checkout at `root`. */
export function declaredToolchain(root: string): DeclaredToolchain {
  const config = toolchainConfig(root);
  const declared: DeclaredToolchain = {};
  if (existsSync(path.join(root, '.node-version'))) {
    declared.node = { version: exact('.node-version', 'the Node.js release', read(root, '.node-version').trim()), source: '.node-version' };
  }
  if (existsSync(path.join(root, 'package.json'))) {
    const manager = field(JSON.parse(read(root, 'package.json')), 'packageManager') ?? '';
    // A packageManager that is not text is no npm declaration, whatever its text would be.
    const match = typeof manager === 'string' ? /^npm@(\d+\.\d+\.\d+)(?:\+sha512\.([0-9a-f]{128}))?$/.exec(manager) : null;
    if (!match) throw new Error(`package.json packageManager is ${JSON.stringify(manager)}, expected npm@<major>.<minor>.<patch> or npm@<major>.<minor>.<patch>+sha512.<128 hexadecimal digits>`);
    // The first group always takes part in a match.
    declared.npm = { version: match[1]!, sha512: match[2], source: 'packageManager of package.json' };
  }
  const phpFile = existsSync(path.join(root, '.php-version')) ? minor('.php-version', 'the PHP minor release', read(root, '.php-version').trim()) : undefined;
  if (config.php) {
    // The loop fails for a value that is not a list: with a TypeError when it is not iterable, with the minor check on the
    // first character of a text. Each item that passes is a minor release as text.
    const php = config.php as string[];
    for (const value of php) minor('config/toolchain.json', 'php as a list of minor releases', value);
    if (phpFile && !php.includes(phpFile)) throw new Error(`.php-version declares ${phpFile}, but config/toolchain.json php lists ${php.join(', ')}; list ${phpFile} or change .php-version`);
    declared.php = { minors: php, source: 'config/toolchain.json php' };
  } else if (phpFile) {
    declared.php = { minors: [phpFile], source: '.php-version' };
  }
  const pythonFile = existsSync(path.join(root, '.python-version')) ? minor('.python-version', 'the Python minor release', read(root, '.python-version').trim()) : undefined;
  if (config.python) {
    const python = minor('config/toolchain.json', 'python', config.python);
    if (pythonFile && pythonFile !== config.python) throw new Error(`.python-version declares ${pythonFile}, but config/toolchain.json python declares ${config.python}; declare one minor release`);
    declared.python = { minor: python, source: 'config/toolchain.json python' };
  } else if (pythonFile) {
    declared.python = { minor: pythonFile, source: '.python-version' };
  }
  if (config.uv) declared.uv = platformRelease('uv', 'archive', config.uv);
  if (config.alint) declared.alint = platformRelease('alint', 'archive', config.alint);
  if (config.pythonBuild) {
    declared.pythonBuild = pythonBuild(config.pythonBuild, declared.python?.minor, declared.uv);
  }
  if (config.pythonBackend) {
    declared.pythonBackend = pythonBackend(config.pythonBackend);
  }
  if (config.composer) {
    declared.composer = { version: exact('config/toolchain.json', 'composer', field(config.composer, 'version')), sha256: field(config.composer, 'sha256'), source: 'config/toolchain.json composer' };
  }
  if (config.phpunit) declared.phpunit = phpunit(config.phpunit);
  for (const key of ['cargoAudit', 'govulncheck'] as const) {
    if (config[key]) declared[key] = { version: recordedRelease(root, key), source: `config/toolchain.json ${key}` };
  }
  if (config.symbolExtractors !== undefined) {
    const extractors: unknown = config.symbolExtractors;
    if (!Array.isArray(extractors) || !extractors.length || extractors.some(name => !EXTRACTORS.includes(name))) throw new Error(`config/toolchain.json symbolExtractors is ${JSON.stringify(extractors)}; expected a list of ${EXTRACTORS.join(', ')}`);
    declared.symbolExtractors = { extractors, source: 'config/toolchain.json symbolExtractors' };
  }
  return declared;
}
