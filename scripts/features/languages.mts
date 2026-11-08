import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchesAny } from '@polyspec/kit/glob';
import { checkedFiles } from '@polyspec/kit/tracked-files';
import { readImplementations, type Implementation } from '../json/formats.mts';
import { holdsRustTest } from './rust-code.mts';

// The language set of the feature checks is contracts/implementations.json, the one source of it; a feature's languages are
// the implementations whose roots hold one of its tests.
const root = resolve(new URL('../..', import.meta.url).pathname);
const implementations = readImplementations(resolve(root, 'contracts/implementations.json'));

/** The implementations of orm, in the order contracts/implementations.json declares them. */
export function implementationLanguages(): string[] {
  return implementations.map(entry => entry.name);
}

/** within holds when `file` is the root `directory` itself (a root of one file) or lies under it. */
function within(directory: string, file: string): boolean {
  return file === directory || file.startsWith(`${directory}/`);
}

/** The implementation whose roots hold `file`, or undefined for a file of no implementation. */
export function implementationOf(file: string, entries: readonly Implementation[] = implementations): string | undefined {
  return entries.find(entry => entry.roots.some(directory => within(directory, file)))?.name;
}

/** featureLanguages is the implementations whose roots hold one of `tests`, in the order of implementationLanguages(). */
export function featureLanguages(tests: readonly string[]): string[] {
  const found = new Set(tests.map(test => implementationOf(test)));
  return implementationLanguages().filter(language => found.has(language));
}

/**
 * The files of the implementation roots that the feature check classifies: kit's checked files of `base` (the files Git tracks or
 * would track, so a generated file that the repository ignores, such as the fixture models of make python-models, is not a test
 * file). A root is a folder or one file.
 */
export function implementationFiles(base: string = root, entries: readonly Implementation[] = implementations): string[] {
  return checkedFiles(base).filter(file => implementationOf(file, entries) !== undefined).sort();
}

// The names of test files in the conventions of every runner: *_test.*, test_*.*, *Test.*, *.test.* and *.spec.*.
const TEST_NAME = /(?:_test\.[^/]+|(?:^|\/)test_[^/]*\.[^/]+|Test\.[^/]+|\.test\.[^/]+|\.spec\.[^/]+)$/;

/**
 * The test files of each implementation among `files`: a file of its roots that one of its test globs selects (and, for Rust, a
 * .rs file whose code holds a test attribute, which cargo runs wherever it lies), less its support files and its internal tests. Each support or internal glob that selects no test file is reported in `stale`, so a declaration
 * that outlives its file does not stay.
 */
export function implementationTestInventory(files: Iterable<string>, entries: readonly Implementation[] = implementations,
  read: (file: string) => string = file => readFileSync(resolve(root, file), 'utf8')): { tests: Record<string, string[]>; stale: string[] } {
  const all = [...files];
  const stale: string[] = [];
  const tests = Object.fromEntries(entries.map(entry => {
    const selected = all.filter(file => entry.roots.some(directory => within(directory, file))
      && (matchesAny(entry.tests, file) || (entry.name === 'rust' && file.endsWith('.rs') && holdsRustTest(read(file)))));
    // A support file is a test file by its path or a file named like a test (test_support.rs) that holds no test.
    const named = all.filter(file => entry.roots.some(directory => within(directory, file)) && TEST_NAME.test(file));
    for (const glob of entry.support) {
      if (!selected.some(file => matchesAny([glob], file)) && !named.some(file => matchesAny([glob], file))) stale.push(`${entry.name}: ${glob} selects no test file of ${entry.roots.join(', ')}`);
    }
    for (const { glob } of entry.internal) {
      if (!selected.some(file => matchesAny([glob], file))) stale.push(`${entry.name}: ${glob} selects no test file of ${entry.roots.join(', ')}`);
    }
    const excluded = [...entry.support, ...entry.internal.map(item => item.glob)];
    return [entry.name, selected.filter(file => !matchesAny(excluded, file)).sort()];
  }));
  return { tests, stale };
}

/** Return the test files that no feature or helper declares. */
export function unlistedFeatureTestErrors(existing: Record<string, Iterable<string>>, listed: ReadonlySet<string>): string[] {
  return Object.entries(existing).flatMap(([language, files]) => [...files]
    .filter(file => !listed.has(file))
    .map(file => `${file}: ${language} test file belongs to no feature`));
}

/** A Korean twin is itself when already named .ko.md; otherwise derive the twin of the English page. */
export function koreanDocumentPath(document: string): string {
  return document.endsWith('.ko.md') ? document : document.replace(/\.md$/, '.ko.md');
}
