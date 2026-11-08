// Interface check: compares each language's native declarations with the reviewed manifest (contracts/interfaces.json),
// and enforces the common method contract regardless of generated source. It checks the five client languages and the extension (PHP extension) in turn,
//
// Usage: node tests/interfaces/check/main.mts [-root dir] [-self-test] [-generate] [-language name]
//
// Options accept both single-dash (-self-test) and double-dash (--self-test), and values are given as `-language php` or `-language=php`. Bool options
// also accept `-self-test=false`.
//
// Expands rules per entity in the entity order of the dbspec document the contract points to. That order is read from the runtime model of the TypeScript client (make
// typescript-build's packages/ts/dist).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { COMPUTE, PROCESS, runCase, runLong, type Step } from '../../testcase.mts';
import { checkNativeSurfaces, checkOwners, checkOwnersAs, checkProhibitedSymbols, checkRecords, checkRules } from './contract.mts';
import { diagram } from './diagram.mts';
import { buildGo, buildRust, checkCallsInRoots, extract, type Tools } from './extract.mts';
import { byteOrder } from './json.mts';
import { allRules, checkErrorLabels, readErrorCatalog, readManifest, validateManifest, type Extension, type Manifest, type Owner, type Rule } from './manifest.mts';
import { parserMutations } from './mutations.mts';
import { apiProblems, readImplementationNames } from './api.mts';

// Case deadline of the interface check.
// MANIFEST: an in-memory computation that reads and compares the manifest, error catalog, component diagram, and dbspec documents.
const MANIFEST = COMPUTE;
// LANGUAGE: reads one language's native declarations with the extractor process, and with --self-test re-runs the extractor for each source mutation.
const LANGUAGE = PROCESS;

const LANGUAGES = ['go', 'php', 'rust', 'typescript', 'python'];
const BOOLEANS = new Set(['self-test', 'generate']);
const VALUES = new Set(['root', 'language']);
const USAGE = `Usage of tests/interfaces/check/main.mts:
  -generate
    \tregenerate the component diagram from the manifest
  -language string
    \tcheck one language or extension; empty checks all five languages and every extension
  -root string
    \trepository root (default ".")
  -self-test
    \talso verify native parsers reject source mutations`;

/**
 * goFlags converts arguments accepted by Go's flag package into parseArgs form: `-name` and `--name` are the same, and bool options
 * accept `=true` and `=false`. Options end at the first positional argument or `--`.
 */
export function goFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (arg === '--' || !arg.startsWith('-') || arg === '-') break;
    const body = arg.replace(/^--?/, '');
    const [name = '', value] = body.split(/=(.*)/s, 2);
    if (BOOLEANS.has(name)) {
      if (value === undefined || value === 'true' || value === '1') out.push(`--${name}`);
      else if (value !== 'false' && value !== '0') throw new Error(`invalid boolean value ${JSON.stringify(value)} for -${name}: parse error`);
    } else if (VALUES.has(name)) {
      if (value !== undefined) out.push(`--${name}=${value}`);
      else {
        const next = argv[index + 1];
        if (next === undefined) throw new Error(`flag needs an argument: -${name}`);
        out.push(`--${name}=${next}`);
        index++;
      }
    } else throw new Error(`flag provided but not defined: -${name}`);
  }
  return out;
}

/** loadOrder is the entity name order of the dbspec document (the TypeScript client's runtime model). */
async function loadOrder(root: string, path: string): Promise<string[]> {
  const dist = join(root, 'packages/ts/dist');
  if (!existsSync(join(dist, 'engine/model.js'))) throw new Error(`${dist} has no build of the TypeScript client; run make typescript-build`);
  const file: unknown = await import(join(dist, 'dbspec/file.js'));
  const model: unknown = await import(join(dist, 'engine/model.js'));
  if (!hasFunction(file, 'readDbspecFile') || !hasFunction(model, 'parseDocumentSet') || !hasFunction(model, 'modelOfDocuments')) {
    throw new Error(`${dist} does not export readDbspecFile, parseDocumentSet and modelOfDocuments`);
  }
  const read: unknown = file.readDbspecFile(path);
  if (read === null || typeof read !== 'object' || !('text' in read) || typeof read.text !== 'string') {
    const diagnostics = read !== null && typeof read === 'object' && 'diagnostics' in read && Array.isArray(read.diagnostics) ? read.diagnostics : [];
    throw new Error(`SCHEMA_INVALID: ${path}: ${diagnostics.map((d: unknown) => JSON.stringify(d)).join('; ')}`);
  }
  const loaded: unknown = model.modelOfDocuments(model.parseDocumentSet([read.text]));
  if (loaded === null || typeof loaded !== 'object' || !('entities' in loaded) || !(loaded.entities instanceof Map)) throw new Error('the runtime model has no entities');
  return [...loaded.entities.keys()].map(String);
}

function hasFunction<K extends string>(value: unknown, name: K): value is Record<K, (...args: unknown[]) => unknown> {
  return value !== null && typeof value === 'object' && name in value && typeof Reflect.get(value, name) === 'function';
}

type Options = { root: string; lang: string; tools: Tools; manifest: Manifest; order: string[] | undefined; selfTest: boolean };

/**
 * checkLanguage compares one language's native declarations with the common contract, and with selfTest checks
 * that the extractor does not miss source mutations.
 */
async function checkLanguage({ root, lang, tools, manifest: m, order, selfTest }: Options, signal: AbortSignal, step: Step): Promise<void> {
  const config = m.languages?.[lang] ?? {};
  const roots = config.roots ?? [];
  const callFailures = checkCallsInRoots(root, lang, roots);
  step('extracting native declarations');
  const actual = await extract(signal, root, lang, roots, tools, root);
  const problems = [
    ...checkRules(lang, actual, m.rules ?? [], order),
    ...checkRules(lang, actual, m.storage ?? [], order),
    ...checkNativeSurfaces(lang, actual, m.native_surfaces ?? []),
    ...checkRecords(lang, actual, m.records ?? []),
    ...checkOwners(lang, actual, m.owners ?? []),
    ...checkProhibitedSymbols(lang, actual, m.prohibited_symbols ?? []),
    ...callFailures,
  ];
  if (problems.length > 0) throw new Error(problems.join('\n'));
  if (selfTest) {
    step('source mutations');
    await parserMutations(signal, root, lang, tools);
  }
  console.log(`${lang}: ${Object.keys(actual).length} native symbols inspected; shared signatures and records checked`);
}

/**
 * checkExtension reads one extension's declarations from roots with the extractor of its syntax, and compares the rules and owners it implements, the prohibited
 * symbols. If a rule or owner the extension does not declare has an adapter of that name, it fails.
 */
export async function checkExtension(root: string, name: string, e: Extension, m: Manifest, order: string[] | undefined,
  signal: AbortSignal | undefined, step: Step): Promise<void> {
  const problems: string[] = [];
  const listedRules = e.rules ?? [], listedOwners = e.owners ?? [];
  const rules: Rule[] = [];
  for (const r of allRules(m)) {
    if (listedRules.includes(r.id ?? '')) rules.push(r);
    else if (r.native !== undefined && Object.hasOwn(r.native, name)) problems.push(`${name}: ${r.id ?? ''} has a ${name} adapter that the extension does not list`);
  }
  if (rules.length !== listedRules.length) problems.push(`${name} lists ${listedRules.length} rules, ${rules.length} of them in the manifest`);
  const owners: Owner[] = [];
  for (const o of m.owners ?? []) {
    if (listedOwners.includes(o.id ?? '')) owners.push(o);
    else if (o.native !== undefined && Object.hasOwn(o.native, name)) problems.push(`${name}: owner ${o.id ?? ''} has a ${name} mapping that the extension does not list`);
  }
  if (owners.length !== listedOwners.length) problems.push(`${name} lists ${listedOwners.length} owners, ${owners.length} of them in the manifest`);
  const syntax = e.syntax ?? '', roots = e.roots ?? [];
  const callFailures = checkCallsInRoots(root, syntax, roots);
  step(`extracting ${name} declarations with the ${syntax} parser`);
  const actual = await extract(signal, root, syntax, roots, {}, root, { loadPhpAutoloader: false });
  problems.push(...checkRules(name, actual, rules, order), ...checkOwnersAs(name, syntax, actual, owners),
    ...checkProhibitedSymbols(name, actual, m.prohibited_symbols ?? []), ...callFailures);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  console.log(`${name}: ${Object.keys(actual).length} native symbols inspected; ${rules.length} rules and ${owners.length} owners checked`);
}

/** main is this run's exit code. The temporary directory is deleted at the end. */
async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: goFlags(argv),
      options: {
        root: { type: 'string', default: '.' }, 'self-test': { type: 'boolean', default: false },
        generate: { type: 'boolean', default: false }, language: { type: 'string', default: '' },
      },
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const selfTest = values['self-test'], generate = values.generate, language = values.language;
  let languages = [...LANGUAGES];
  // If extensions is undefined, checks all extensions in the manifest.
  let extensions: string[] | undefined;
  if (language !== '') {
    if (LANGUAGES.includes(language)) {
      languages = [language];
      extensions = [];
    } else if (language === 'php-extension') {
      languages = [];
      extensions = [language];
    } else {
      console.error(`unsupported language ${language}`);
      return 1;
    }
    console.log(`diagnostic scope: ${language} only; the full interface check requires all five languages and every extension`);
  }
  const root = resolve(values.root);
  let m: Manifest = {};
  let order: string[] | undefined;
  const manifestPassed = await runCase('interfaces/manifest', MANIFEST, async () => {
    m = readManifest(join(root, 'contracts/interfaces.json'));
    validateManifest(m);
    const codes = readErrorCatalog(root);
    const failures = checkErrorLabels(codes, allRules(m), m.sequences ?? []);
    if (failures.length !== 0) throw new Error(failures.join('\n'));
    const english = diagram(m, false), korean = diagram(m, true);
    const englishPath = join(root, 'docs/spec/interfaces-model.md'), koreanPath = join(root, 'docs/spec/interfaces-model.ko.md');
    if (generate) {
      writeFileSync(englishPath, english, { mode: 0o644 });
      writeFileSync(koreanPath, korean, { mode: 0o644 });
    } else {
      if (!readFileSync(englishPath).equals(Buffer.from(english, 'utf8'))) throw new Error('component diagram differs from the manifest; run with --generate');
      if (!readFileSync(koreanPath).equals(Buffer.from(korean, 'utf8'))) throw new Error('Korean component diagram differs from the manifest; run with --generate');
    }
    order = await loadOrder(root, join(root, m.schema ?? ''));
  });
  if (!manifestPassed) return 1;
  // The error catalog of every implementation is read here, before the check of each client.
  const apiPassed = await runCase('interfaces/error-catalogs', MANIFEST, () => {
    const problems = apiProblems(root, readImplementationNames(root), readErrorCatalog(root));
    if (problems.length > 0) throw new Error(problems.join('\n'));
  });
  const tools: Tools = {};
  // The extractor is built into this run's directory, and the Rust extractor runs what is copied there under the lease.
  const directory = languages.includes('go') || languages.includes('rust') ? mkdtempSync(join(tmpdir(), 'orm-interface-symbols-')) : undefined;
  try {
    if (directory !== undefined && languages.includes('go')) {
      if (!(await runLong('interfaces/go-build', async ({ step }) => { tools.go = await buildGo(step, root, directory); }))) return 1;
    }
    if (directory !== undefined && languages.includes('rust')) {
      if (!(await runLong('interfaces/rust-build', async ({ step }) => { tools.rust = await buildRust(step, root, directory); }))) return 1;
    }
    let failed = !apiPassed;
    for (const lang of languages) {
      const options: Options = { root, lang, tools, manifest: m, order, selfTest };
      if (!(await runCase(`interfaces/${lang}`, LANGUAGE, ({ signal, step }) => checkLanguage(options, signal, step)))) failed = true;
    }
    for (const name of extensions ?? Object.keys(m.extensions ?? {}).sort(byteOrder)) {
      const e = m.extensions?.[name];
      if (e === undefined) {
        console.error(`contracts/interfaces.json declares no extension ${name}`);
        failed = true;
        continue;
      }
      if (!(await runCase(`interfaces/${name}`, LANGUAGE, ({ signal, step }) => checkExtension(root, name, e, m, order, signal, step)))) failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
