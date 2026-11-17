// pin-deps writes the release of polyspec binding and polyspec json that orm builds with: the git tag of every Cargo.toml
// that names their crates, and the release download of every package.json entry of their npm packages. legacy/ keeps the
// pins of the language implementations and is not read. The locks follow from `cargo update` and `npm install`, and
// the files of the binding packages that name the json release (packages/*/pyproject.toml, package.json, composer.json,
// go.mod, go.sum; CK-19) from `binding scaffold`, which reads the json crate of Cargo.lock; this script runs none of them.
//
// Each pin is rewritten to the given version whatever version it held, so a second run with the same versions writes
// nothing: the output is a fixed point.
//
// config/binding-python-siblings.txt names the wheel of polyspec json of each platform by the URL of its release asset and
// the sha256 of that asset. A sha256 does not follow from a version, so a line whose release changes takes the sha256
// that --wheel-sha256 gives for its new asset, and the script names each asset it was given none for and writes nothing.
//
// Usage: node scripts/repo/pin-deps.mts --binding 0.0.21 --json 0.0.37 [--wheel-sha256 <asset>=<hex>]... [--check]
//   --check writes nothing and fails when a file pins another version.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function trackedFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '*Cargo.toml', '*package.json', ':!legacy/**'], { cwd: ROOT, encoding: 'utf8' });
  return listed.split('\0').filter(Boolean);
}

export function pin(text: string, versions: { binding: string; json: string }): string {
  let out = text;
  for (const [repo, version] of Object.entries(versions)) {
    // Cargo: { git = "https://github.com/polyspec/<repo>.git", tag = "v<version>" }
    out = out.replace(new RegExp(`(github\\.com/polyspec/${repo}\\.git", tag = "v)[0-9]+\\.[0-9]+\\.[0-9]+(")`, 'g'), `$1${version}$2`);
    // npm: https://github.com/polyspec/<repo>/releases/download/v<version>/polyspec-<repo>[-<target>]-<version>.tgz
    out = out.replace(
      new RegExp(`(github\\.com/polyspec/${repo}/releases/download/v)[0-9]+\\.[0-9]+\\.[0-9]+(/polyspec-${repo}(?:-[a-z0-9-]+?)?-)[0-9]+\\.[0-9]+\\.[0-9]+(\\.tgz)`, 'g'),
      `$1${version}$2${version}$3`,
    );
  }
  return out;
}

const WHEELS = 'config/binding-python-siblings.txt';
// A wheel line: the URL of the release asset, then the rest of the line up to its sha256.
const WHEEL_LINE = /^(polyspec-json @ https:\/\/github\.com\/polyspec\/json\/releases\/download\/v)([0-9]+\.[0-9]+\.[0-9]+)(\/)(polyspec_json-)([0-9]+\.[0-9]+\.[0-9]+)(-[^ ]+\.whl)( .*--hash=sha256:)([0-9a-f]+)$/;

/**
 * The text of the wheel pins with each line at the json release `json`, and the assets whose sha256 `hashes` does not
 * give. A line that names the release already is kept with its sha256; when an asset is missing the text is unchanged.
 */
export function pinWheels(text: string, json: string, hashes: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const lines = text.split('\n').map(line => {
    const at = WHEEL_LINE.exec(line);
    if (at === null) return line;
    const [, url, release, slash, name, version, rest, tail] = at;
    if (release === json && version === json) return line;
    const asset = `${name ?? ''}${json}${rest ?? ''}`;
    const hash = hashes[asset];
    if (hash === undefined) {
      missing.push(asset);
      return line;
    }
    return `${url ?? ''}${json}${slash ?? ''}${asset}${tail ?? ''}${hash}`;
  });
  return missing.length > 0 ? { text, missing } : { text: lines.join('\n'), missing };
}

function main(args: string[]): number {
  const usage = 'usage: node scripts/repo/pin-deps.mts --binding <version> --json <version> [--wheel-sha256 <asset>=<hex>]... [--check]';
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const binding = value('--binding');
  const json = value('--json');
  const check = args.includes('--check');
  const hashes: Record<string, string> = {};
  const given = args.flatMap((arg, at) => (arg === '--wheel-sha256' ? [args[at + 1] ?? ''] : []));
  for (const pair of given) {
    const [asset, hash] = pair.split('=');
    if (asset === undefined || hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) {
      process.stderr.write(`pin-deps: ${usage}\n`);
      return 2;
    }
    hashes[asset] = hash;
  }
  const known = new Set(['--binding', '--json', '--check', '--wheel-sha256', binding, json, ...given]);
  const unknown = args.filter(arg => !known.has(arg));
  if (binding === undefined || json === undefined || !VERSION.test(binding) || !VERSION.test(json) || unknown.length > 0) {
    process.stderr.write(`pin-deps: ${usage}\n`);
    return 2;
  }
  const changed: string[] = [];
  for (const file of trackedFiles()) {
    const path = join(ROOT, file);
    const text = readFileSync(path, 'utf8');
    const pinned = pin(text, { binding, json });
    if (pinned === text) continue;
    changed.push(file);
    if (!check) writeFileSync(path, pinned);
  }
  const wheelsPath = join(ROOT, WHEELS);
  const wheelsText = readFileSync(wheelsPath, 'utf8');
  const wheels = pinWheels(wheelsText, json, hashes);
  if (wheels.missing.length > 0) {
    if (check) changed.push(WHEELS);
    else {
      process.stderr.write(`pin-deps: ${WHEELS} needs the sha256 of each wheel of json ${json}; give --wheel-sha256 <asset>=<hex> for:\n${wheels.missing.map(asset => `  ${asset}\n`).join('')}`);
      return 1;
    }
  } else if (wheels.text !== wheelsText) {
    changed.push(WHEELS);
    if (!check) writeFileSync(wheelsPath, wheels.text);
  }
  if (check && changed.length > 0) {
    process.stderr.write(`pin-deps: these files pin another binding or json than ${binding} and ${json}:\n${changed.map(file => `  ${file}\n`).join('')}`);
    return 1;
  }
  process.stdout.write(check ? `pin-deps: binding ${binding} and json ${json} everywhere\n` : `pin-deps: ${changed.length} files written\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
