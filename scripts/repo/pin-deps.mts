// pin-deps writes the release of polyspec binding and polyspec json that orm builds with: the git tag of every Cargo.toml
// that names their crates, and the release download of every package.json entry of their npm packages. legacy/ keeps the
// pins of the language implementations and is not read. The locks follow from `cargo update` and `npm install`, and
// the files of the binding packages that name the json release (packages/*/pyproject.toml, package.json, composer.json,
// go.mod, go.sum; CK-19) from `binding scaffold`, which reads the json crate of Cargo.lock; this script runs none of them.
//
// Each pin is rewritten to the given version whatever version it held, so a second run with the same versions writes
// nothing: the output is a fixed point.
//
// Usage: node scripts/repo/pin-deps.mts --binding 0.0.17 --json 0.0.34 [--check]
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

function main(args: string[]): number {
  const usage = 'usage: node scripts/repo/pin-deps.mts --binding <version> --json <version> [--check]';
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const binding = value('--binding');
  const json = value('--json');
  const check = args.includes('--check');
  const known = new Set(['--binding', '--json', '--check', binding, json]);
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
  if (check && changed.length > 0) {
    process.stderr.write(`pin-deps: these files pin another binding or json than ${binding} and ${json}:\n${changed.map(file => `  ${file}\n`).join('')}`);
    return 1;
  }
  process.stdout.write(check ? `pin-deps: binding ${binding} and json ${json} everywhere\n` : `pin-deps: ${changed.length} files written\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
