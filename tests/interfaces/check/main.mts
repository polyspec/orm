// Interface check: compares each language's native declarations with the reviewed symbol manifest (contracts/interfaces.json and contracts/symbols/*.json),
// and enforces the common method contract regardless of generated source. It checks the five client languages and the extension (PHP extension) in turn,
// and when --results is given, it also compares the state trace of the conformance run against the common state contract.
//
// Usage: node tests/interfaces/check/main.mts [-root dir] [-record] [-self-test] [-generate] [-language name] [-results dir]...
//
// Options accept both single-dash (-record) and double-dash (--record), and values are given as `-language php` or `-language=php`. Bool options
// also accept `-record=false`.
//
// Expands rules per entity in the entity order of the dbspec document the contract points to. That order is read from the runtime model of the TypeScript client (make
// typescript-build's packages/ts/dist).
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readJsonFile } from '../../../scripts/json/schema.mts';
import { COMPUTE, PROCESS, runCase, runLong, type Step } from '../../testcase.mts';
import { checkOwners, checkOwnersAs, checkProhibitedSymbols, checkRecords, checkRules, differences } from './contract.mts';
import { diagram } from './diagram.mts';
import { buildGo, buildRust, checkCallsInRoots, extract, type Tools } from './extract.mts';
import { byteOrder, goJson } from './json.mts';
import { allRules, checkErrorLabels, readErrorCatalog, readManifest, validateManifest, type Extension, type Manifest, type Owner, type Rule, type Symbols } from './manifest.mts';
import { parserMutations } from './mutations.mts';
import { checkResults } from './sequences.mts';
import { apiProblems, readParity } from './api.mts';

const symbolsSchema = resolve(import.meta.dirname, '../../../scripts/schema/interface-symbols.schema.json');

// Case deadline of the interface check.
// MANIFEST: an in-memory computation that reads and compares the manifest, error catalog, component diagram, and dbspec documents.
const MANIFEST = COMPUTE;
// LANGUAGE: reads one language's native declarations with the extractor process, and with --self-test re-runs the extractor for each source mutation.
const LANGUAGE = PROCESS;
// RESULTS: reads the conformance output file and compares its state trace.
const RESULTS = COMPUTE;

const LANGUAGES = ['go', 'php', 'rust', 'typescript', 'python'];
const BOOLEANS = new Set(['record', 'self-test', 'generate']);
const VALUES = new Set(['root', 'language', 'results', 'vector']);
const USAGE = `Usage of tests/interfaces/check/main.mts:
  -generate
    \tregenerate the component diagram from the manifest
  -language string
    \tcheck one language or extension; empty checks all five languages and every extension
  -record
    \twrite candidate native symbol inventories after common-contract checks
  -results value
    \talso check the state traces of a conformance output directory of this run, repeatable
  -vector value
    \twith -results, check the state contracts of the named vectors only, repeatable
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

function fileSHA256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

// writeSymbols writes the symbol record the way Go's json.MarshalIndent does (two-space indentation) with one trailing newline.
function writeSymbols(path: string, symbols: Symbols): void {
  writeFileSync(path, `${goJson(symbols, '  ')}\n`, { mode: 0o644 });
}

// The symbol hashes that a record run computed, by manifest path (symbol_hashes.<language> or extensions.<name>). The
// record run writes them into contracts/interfaces.json, so the manifest follows the snapshots it records.
const recordedHashes = new Map<string, string>();

type Options = { root: string; lang: string; tools: Tools; manifest: Manifest; order: string[] | undefined; record: boolean; selfTest: boolean };

/**
 * checkLanguage compares one language's native declarations with the common contract, the recorded symbol snapshot, and its hash, and with selfTest checks
 * that the extractor does not miss source mutations.
 */
async function checkLanguage({ root, lang, tools, manifest: m, order, record, selfTest }: Options, signal: AbortSignal, step: Step): Promise<void> {
  const config = m.languages?.[lang] ?? {};
  const roots = config.roots ?? [];
  const callFailures = checkCallsInRoots(root, lang, roots);
  step('extracting native declarations');
  const actual = await extract(signal, root, lang, roots, tools, root);
  const problems = [
    ...checkRules(lang, actual, m.rules ?? [], order),
    ...checkRules(lang, actual, m.storage ?? [], order),
    ...checkRecords(lang, actual, m.records ?? []),
    ...checkOwners(lang, actual, m.owners ?? []),
    ...checkProhibitedSymbols(lang, actual, m.prohibited_symbols ?? []),
    ...callFailures,
  ];
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const path = join(root, config.symbols ?? '');
  if (record) writeSymbols(path, actual);
  else for (const d of differences(readJsonFile<Symbols>(path, symbolsSchema), actual)) problems.push(`${lang}: ${d}`);
  const gotHash = fileSHA256(path), wantHash = m.symbol_hashes?.[lang] ?? '';
  if (record) recordedHashes.set(`symbol_hashes.${lang}`, gotHash);
  else if (wantHash !== gotHash) problems.push(`${lang}: symbol snapshot hash differs from contracts/interfaces.json\n  want ${wantHash}\n  got  ${gotHash}`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  if (selfTest) {
    step('source mutations');
    await parserMutations(signal, root, lang, tools);
  }
  console.log(`${lang}: ${Object.keys(actual).length} native symbols inspected; shared signatures and records checked`);
}

/**
 * checkExtension reads one extension's declarations from roots with the extractor of its syntax, and compares the rules and owners it implements, the prohibited
 * symbols, and the recorded symbol snapshot and its hash. If a rule or owner the extension does not declare has an adapter of that name, it
 * fails.
 */
export async function checkExtension(root: string, name: string, e: Extension, m: Manifest, order: string[] | undefined, record: boolean,
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
  const actual = await extract(signal, root, syntax, roots, {}, root);
  problems.push(...checkRules(name, actual, rules, order), ...checkOwnersAs(name, syntax, actual, owners),
    ...checkProhibitedSymbols(name, actual, m.prohibited_symbols ?? []), ...callFailures);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const path = join(root, e.symbols ?? '');
  if (record) writeSymbols(path, actual);
  else for (const d of differences(readJsonFile<Symbols>(path, symbolsSchema), actual)) problems.push(`${name}: ${d}`);
  const gotHash = fileSHA256(path), wantHash = e.symbol_hash ?? '';
  if (record) recordedHashes.set(`extensions.${name}`, gotHash);
  else if (wantHash !== gotHash) problems.push(`${name}: symbol snapshot hash differs from contracts/interfaces.json\n  want ${wantHash}\n  got  ${gotHash}`);
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
        root: { type: 'string', default: '.' }, record: { type: 'boolean', default: false }, 'self-test': { type: 'boolean', default: false },
        generate: { type: 'boolean', default: false }, results: { type: 'string', multiple: true, default: [] }, vector: { type: 'string', multiple: true, default: [] }, language: { type: 'string', default: '' },
      },
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const record = values.record, selfTest = values['self-test'], generate = values.generate, results = values.results, vectors = values.vector, language = values.language;
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
  // The API units of config/parity.json are read here, so that the check of each client runs against the same units.
  const apiPassed = await runCase('interfaces/api-units', MANIFEST, () => {
    const problems = apiProblems(root, readParity(root), readErrorCatalog(root));
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
      const options: Options = { root, lang, tools, manifest: m, order, record, selfTest };
      if (!(await runCase(`interfaces/${lang}`, LANGUAGE, ({ signal, step }) => checkLanguage(options, signal, step)))) failed = true;
    }
    for (const name of extensions ?? Object.keys(m.extensions ?? {}).sort(byteOrder)) {
      const e = m.extensions?.[name];
      if (e === undefined) {
        console.error(`contracts/interfaces.json declares no extension ${name}`);
        failed = true;
        continue;
      }
      if (!(await runCase(`interfaces/${name}`, LANGUAGE, ({ signal, step }) => checkExtension(root, name, e, m, order, record, signal, step)))) failed = true;
    }
    if (record && recordedHashes.size > 0) writeManifestHashes(join(root, 'contracts/interfaces.json'), recordedHashes);
    if (results.length > 0) {
      const passed = await runCase('interfaces/results', RESULTS, () => {
        const problems = results.flatMap(dir => checkResults(dir, languages, m.sequences ?? [], vectors));
        if (problems.length > 0) throw new Error(problems.join('\n'));
      });
      if (!passed) failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * writeManifestHashes sets the recorded symbol hashes in the manifest text, changing only the hash value of each entry: the
 * symbol_hashes of a language and the symbol_hash of an extension. An entry that the text lacks is an error, not a new key.
 */
function writeManifestHashes(path: string, hashes: Map<string, string>): void {
  let text = readFileSync(path, 'utf8');
  for (const [key, hash] of hashes) {
    const [section, name] = key.split('.');
    const field = section === 'symbol_hashes' ? 'symbol_hashes' : 'extensions';
    const at = text.indexOf(`"${field}": {`);
    if (at < 0) throw new Error(`${path} has no ${field} object for ${key}`);
    const body = text.slice(at);
    const pattern = section === 'symbol_hashes'
      ? new RegExp(`("${name}": ")sha256:[0-9a-f]+(")`)
      : new RegExp(`("${name}": \\{[\\s\\S]*?"symbol_hash": ")sha256:[0-9a-f]+(")`);
    if (!pattern.test(body)) throw new Error(`${path} has no hash for ${key}`);
    text = text.slice(0, at) + body.replace(pattern, `$1${hash}$2`);
  }
  writeFileSync(path, text, { mode: 0o644 });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
