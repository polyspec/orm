// Checks that every version declaration in orm matches the VERSION file. Each mismatched or missing declaration is reported one by one
// along with its file name.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { COMPUTE, sections } from '../../tests/testcase.mts';
import { parseFeatures } from '../features/manifest.mts';
import { parseComposer, parseNpmLock, parsePackage } from '../json/formats.mts';
import { errorMessage } from '../../tests/errors.mts';

// The Rust package orm produces. In Cargo.lock, only this package's version is the orm version.
const RUST_PACKAGES = ['polyspec-orm', 'polyspec-orm-schema', 'polyspec-orm-build', 'polyspec-orm-case-clock', 'polyspec-orm-case-database', 'polyspec-orm-testcase', 'polyspec-orm-tests', 'polyspec-orm-bench',
  'polyspec-orm-interface-symbols'];

// present keeps a version that a declaration holds.
const present = (value: string | undefined): value is string => value !== undefined && value !== '';
const first = (re: RegExp) => (text: string): string[] => [...text.matchAll(re)].slice(0, 1).map(m => m[1] ?? '');
const all = (re: RegExp) => (text: string): string[] => [...text.matchAll(re)].map(m => m[1] ?? '');
const cargoToml = (text: string) => [
  ...first(/^version = "([^"]+)"$/gm)(text),
  ...all(/^(?:polyspec-orm|polyspec-orm-schema) = \{ version = "=([^"]+)"/gm)(text),
];
const cargoLock = (text: string) => [...text.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)]
  .filter(m => RUST_PACKAGES.includes(m[1] ?? '')).map(m => m[2] ?? '');
// In the repository root's package-lock.json, the orm version is the entry of the workspace packages/ts (the root is a private
// workspace with no version).
const packageLock = (text: string) => [parseNpmLock(text, 'package-lock.json').packages['packages/ts']?.version].filter(present);

// For each declaration, its file and how the orm version is read from that file.
export const DECLARATIONS = [
  ...['packages/rust/orm', 'packages/rust/schema', 'packages/rust/build', 'packages/rust/case-clock', 'packages/rust/case-database',
    'packages/rust/testcase', 'packages/rust/tests', 'benchmarks/rust', 'packages/rust/testing/interfaces'].map(dir => ({ file: `${dir}/Cargo.toml`, read: cargoToml })),
  ...['packages/rust', 'benchmarks/rust', 'packages/rust/testing/interfaces'].map(dir => ({ file: `${dir}/Cargo.lock`, read: cargoLock })),
  { file: 'packages/php/composer.json', read: (text: string) => [parseComposer(text, 'packages/php/composer.json').version].filter(present) },
  { file: 'packages/php-ext/composer.json', read: (text: string) => [parseComposer(text, 'packages/php-ext/composer.json').version].filter(present) },
  { file: 'packages/ts/package.json', read: (text: string) => [parsePackage(text, 'packages/ts/package.json').version].filter(present) },
  { file: 'packages/python/pyproject.toml', read: (text: string) => [/^version = "([^"]+)"/m.exec(text)?.[1]].filter(present) },
  { file: 'package-lock.json', read: packageLock },
  { file: 'contracts/features.json', read: (text: string) => [parseFeatures(text, 'contracts/features.json').contract_version] },
  { file: 'packages/php/README.md', read: first(/Version (\d+\.\d+\.\d+)\./g) },
  { file: 'SECURITY.md', read: first(/development version is `([^`]+)`/g) },
  { file: 'SECURITY.ko.md', read: first(/개발 version은 `([^`]+)`/g) },
  { file: 'AGENTS.md', read: first(/Develop one `([^`]+)` version/g) },
  { file: 'AGENTS.ko.md', read: first(/하나의 `([^`]+)` 버전/g) },
  { file: 'docs/spec/plan.md', read: first(/product version is `([^`]+)`/g) },
  { file: 'docs/spec/plan.ko.md', read: first(/제품 버전은 `([^`]+)`이다/g) },
];

export async function versionErrors(root: string): Promise<string[]> {
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const errors: string[] = [];
  for (const { file, read } of DECLARATIONS) {
    let found: string[];
    try { found = read(await readFile(join(root, file), 'utf8')); }
    catch (error) { errors.push(`${file}: ${errorMessage(error)}`); continue; }
    if (found.length === 0) errors.push(`${file}: no version declaration found (VERSION is ${version})`);
    for (const value of found) if (value !== version) errors.push(`${file}: version ${value} differs from VERSION ${version}`);
  }
  return errors;
}

// CHANGELOGS are the change history files. Each file has `## Unreleased` at the top (changes not yet tagged), and the sections below it are
// released versions `## X.Y.Z`, with the newest version on top. A release PR changes VERSION and every package file to X.Y.Z,
// and turns `## Unreleased` into `## X.Y.Z` and then puts an empty `## Unreleased` above it (AGENTS.md), so that no section is larger
// than VERSION. The files in both languages have the same sections.
export const CHANGELOGS = ['CHANGELOG.md', 'CHANGELOG.ko.md'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
// compare orders two released versions X.Y.Z with semver.
const compare = (a: string, b: string): number => semver.compare(a, b);

// changelogErrors returns one error for each place where a version's change history file ({path: text}) violates these rules.
export function changelogErrors(version: string, files: Record<string, string>): string[] {
  const errors: string[] = [];
  const sections: Record<string, string[]> = {};
  for (const [path, text] of Object.entries(files)) {
    const headings = [...text.matchAll(/^## (.*)$/gm)].map(match => (match[1] ?? '').trim());
    sections[path] = headings;
    if (headings[0] !== 'Unreleased') errors.push(`${path}: the first section is ${headings[0] === undefined ? 'missing' : `## ${headings[0]}`}; write the entries of the changes that no tag released under ## Unreleased at the top`);
    if (headings.filter(heading => heading === 'Unreleased').length > 1) errors.push(`${path}: ## Unreleased appears ${headings.filter(heading => heading === 'Unreleased').length} times; keep one at the top`);
    const versions = headings.filter(heading => heading !== 'Unreleased');
    for (const heading of versions) {
      if (!SEMVER.test(heading)) errors.push(`${path}: the section ## ${heading} is neither ## Unreleased nor a released version X.Y.Z`);
      else if (compare(heading, version) > 0) errors.push(`${path}: the section ## ${heading} is above VERSION ${version}; the release PR sets VERSION to the version it releases`);
    }
    const released = versions.filter(heading => SEMVER.test(heading));
    for (const [index, heading] of released.slice(1).entries())
      if (compare(released[index] ?? '', heading) <= 0) errors.push(`${path}: the section ## ${heading} follows ## ${released[index]}; a newer version comes first and appears once`);
  }
  const [first = '', ...others] = Object.keys(sections);
  const listed = (path: string) => sections[path] ?? [];
  for (const path of others)
    if (listed(path).join('\n') !== listed(first).join('\n')) errors.push(`${path}: the sections ${listed(path).map(heading => `## ${heading}`).join(', ')} differ from the sections ${listed(first).map(heading => `## ${heading}`).join(', ')} of ${first}`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The version check is one case that reads the declaration file and compares it.
  const log = sections();
  log.begin('version', COMPUTE);
  const root = resolve(import.meta.dirname, '..', '..');
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const errors = [...await versionErrors(root),
    ...changelogErrors(version, Object.fromEntries(await Promise.all(CHANGELOGS.map(async (path): Promise<[string, string]> => [path, await readFile(join(root, path), 'utf8')]))))];
  for (const error of errors) console.error(`version: ${error}`);
  if (errors.length === 0) console.log(`version: ${DECLARATIONS.length} declarations agree on ${version}; ${CHANGELOGS.join(' and ')} start with ## Unreleased`);
  log.end(errors.length ? `${errors.length} declaration(s) differ; each is listed above` : undefined);
  if (errors.length > 0) process.exitCode = 1;
}
