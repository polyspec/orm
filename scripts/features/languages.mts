import { resolve } from 'node:path';
import { readParityConfig, type ParityConfig } from '../json/formats.mts';
import { matchesAny } from '@polyspec/kit/glob';
import { CONVENTIONS, readDeclaration, testNamed, within } from '@polyspec/kit/parity-declaration';
import { checkedFiles } from '@polyspec/kit/tracked-files';

// The language set of the feature checks is the declared implementations of config/parity.json, the one source of it; a
// feature's languages are the implementations that its parity units bind.
const parity = readParityConfig(resolve(new URL('../..', import.meta.url).pathname, 'config/parity.json'));
const root = resolve(new URL('../..', import.meta.url).pathname);

/** The declared implementations, in the order config/parity.json declares them. */
export function implementationLanguages(): string[] {
  return parity.implementations.map(entry => entry.name);
}

/** Source roots whose test conventions are part of each implementation's declaration. */
export function implementationSourceRoots(config: ParityConfig = parity): Record<string, string[]> {
  return Object.fromEntries(config.implementations.map(implementation => [implementation.name, implementation.roots]));
}

/**
 * The files of the implementation source roots that the feature check classifies: kit's checked files of `base` (the files Git
 * tracks or would track, so a generated file that the repository ignores, such as the fixture models of make python-models, is
 * not a test file), which are the files the parity declaration check of kit classifies. A root is a folder or one file.
 */
export function implementationFiles(base: string = root, config: ParityConfig = parity): string[] {
  const roots = config.implementations.flatMap(implementation => implementation.roots);
  return checkedFiles(base).filter(file => roots.some(directory => file === directory || within(directory, file))).sort();
}

const units = new Map(parity.units.map(unit => [unit.id, unit]));

/** A parity-declared implementation-internal test path is not a shared feature case. */
export function implementationInternalTestPaths(config: ParityConfig = parity): Record<string, string[]> {
  return Object.fromEntries(config.implementations.map(implementation => [
    implementation.name,
    (implementation.internal ?? []).map(entry => entry.glob),
  ]));
}

/** Shared feature tests are the runner-convention inventory plus parity additions and exact unit bindings. */
export function implementationTestGlobs(config: ParityConfig = parity): Record<string, string[]> {
  return Object.fromEntries(config.implementations.map(implementation => [implementation.name, implementation.tests ?? []]));
}

/** Test-support modules are excluded from broad shared-test globs by their explicit parity declaration. */
export function implementationSupportGlobs(config: ParityConfig = parity): Record<string, string[]> {
  return Object.fromEntries(config.implementations.map(implementation => [implementation.name, implementation.support ?? []]));
}

/** The test files selected by the same Kit declaration inventory used by parity checks. */
export function implementationTestInventory(files: Iterable<string>, config: ParityConfig = parity): Record<string, string[]> {
  const allFiles = new Set(files);
  const declaration = readDeclaration(root, allFiles);
  return Object.fromEntries(config.implementations.map(implementation => {
    const bound = new Set(boundTestPaths(implementation.name, config));
    const conventionTests = declaration.model?.tests.get(implementation.name) ?? [];
    const named = [...allFiles].filter(file => implementation.roots.some(directory => within(directory, file)) && testNamed(file));
    const selected = new Set([
      ...conventionTests,
      ...named,
      ...allFilesOf(config, implementation.name, allFiles),
      ...bound,
    ]);
    const excluded = [...(implementation.support ?? []), ...(implementation.internal ?? []).map(item => item.glob)];
    return [implementation.name, [...selected].filter(file => !matchesAny(excluded, file)).sort()];
  }));
}

/** The test file globs that kit fixes for the runner `runner`; a runner kit does not know throws. */
function conventionsOf(runner: string): readonly string[] {
  const convention = Object.entries(CONVENTIONS).find(([name]) => name === runner);
  if (convention === undefined) throw new Error(`config/parity.json names the runner ${runner}, which has no test convention of kit`);
  return convention[1];
}

function allFilesOf(config: ParityConfig, language: string, files: Set<string>): string[] {
  const implementation = config.implementations.find(entry => entry.name === language);
  if (!implementation) return [];
  const patterns = [
    ...conventionsOf(implementation.runner),
    ...(config.testPatterns ?? []).filter(pattern => pattern.runner === implementation.runner).flatMap(pattern => pattern.globs),
    ...(implementation.tests ?? []),
  ];
  return [...files].filter(file => implementation.roots.some(directory => within(directory, file)) && matchesAny(patterns, file));
}

/** Compatibility query over the complete convention-aware inventory. */
export function isDeclaredSharedTest(language: string, file: string, globs = implementationTestGlobs()): boolean {
  return matchesAny(globs[language] ?? [], file);
}

/** A support/internal declaration excludes a file; otherwise the Kit convention, explicit additions, or a binding selects it. */
export function isFeatureTestPath(language: string, file: string, globs = implementationTestGlobs(), bound = boundTestPaths(language), internal = implementationInternalTestPaths(), support = implementationSupportGlobs(), config: ParityConfig = parity): boolean {
  const implementation = config.implementations.find(entry => entry.name === language);
  if (!implementation || !implementation.roots.some(directory => within(directory, file))) return false;
  if (isImplementationInternalTest(language, file, internal) || matchesAny(support[language] ?? [], file)) return false;
  const patterns = [
    ...conventionsOf(implementation.runner),
    ...(config.testPatterns ?? []).filter(pattern => pattern.runner === implementation.runner).flatMap(pattern => pattern.globs),
    ...(globs[language] ?? []),
  ];
  return matchesAny(patterns, file) || testNamed(file) || bound.includes(file);
}

/** The feature checker excludes only exact test paths declared internal by config/parity.json. */
export function isImplementationInternalTest(language: string, file: string, internal = implementationInternalTestPaths()): boolean {
  return matchesAny(internal[language] ?? [], file);
}

/** A Korean twin is itself when already named .ko.md; otherwise derive the twin of the English page. */
export function koreanDocumentPath(document: string): string {
  return document.endsWith('.ko.md') ? document : document.replace(/\.md$/, '.ko.md');
}

/** The exact test paths named by parity units for one implementation. */
export function boundTestPaths(language: string, config: ParityConfig = parity): string[] {
  return [...new Set(config.units.flatMap(unit => (unit.bindings ?? [])
    .flatMap(binding => binding.implementation === language && binding.test !== undefined ? [binding.test] : [])))];
}

/** unknownParityUnits names the ids that config/parity.json does not declare. */
export function unknownParityUnits(ids: string[]): string[] {
  return ids.filter(id => !units.has(id));
}

/** Return the convention-selected tests that no feature or helper declares. */
export function unlistedFeatureTestErrors(existing: Record<string, Iterable<string>>, listed: ReadonlySet<string>): string[] {
  return Object.entries(existing).flatMap(([language, files]) => [...files]
    .filter(file => !listed.has(file))
    .map(file => `${file}: ${language} test file belongs to no feature`));
}

/** featureLanguages is the implementations that the parity units bind, in the order of implementationLanguages(). */
export function featureLanguages(ids: string[], config: ParityConfig = parity): string[] {
  const configuredUnits = new Map(config.units.map(unit => [unit.id, unit]));
  const bound = new Set(ids.flatMap(id => (configuredUnits.get(id)?.bindings ?? []).map(binding => binding.implementation)));
  return config.implementations.map(entry => entry.name).filter(language => bound.has(language));
}

/** unitTests is the test files that the parity unit of id binds for one implementation. */
export function unitTests(id: string, implementation: string): string[] {
  return (units.get(id)?.bindings ?? [])
    .filter(binding => binding.implementation === implementation)
    .map(binding => binding.test)
    .filter((test): test is string => test !== undefined);
}
