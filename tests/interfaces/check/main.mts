// Interface check: 각 언어의 native 선언을 검토한 symbol manifest(contracts/interfaces.json과 contracts/symbols/*.json)에
// 비교하고, 생성된 source와 무관하게 공통 method contract를 강제한다. 다섯 client 언어와 extension(PHP 확장)을 차례로
// 확인하며, --results가 주어지면 conformance 실행의 state trace도 공통 state contract에 비교한다.
//
// Usage: node tests/interfaces/check/main.mts [-root dir] [-record] [-self-test] [-generate] [-language name] [-results dir]...
//
// 옵션은 한 줄표(-record)와 두 줄표(--record) 모두 받고, 값은 `-language php`나 `-language=php`로 준다. bool 옵션은
// `-record=false`도 받는다.
//
// entity 단위 rule은 contract가 가리키는 dbspec document의 entity 순서로 펼친다. 그 순서는 TypeScript client(make
// typescript-build가 만드는 packages/ts/dist)의 runtime model에서 읽는다.
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

const symbolsSchema = resolve(import.meta.dirname, '../../../scripts/schema/interface-symbols.schema.json');

// interface check의 case 기한이다.
// MANIFEST: manifest, error catalog, component diagram, dbspec 문서를 읽고 비교하는 memory 안의 계산이다.
const MANIFEST = COMPUTE;
// LANGUAGE: 한 언어의 native 선언을 추출기 process로 읽고, --self-test면 source mutation마다 추출기를 다시 실행한다.
const LANGUAGE = PROCESS;
// RESULTS: conformance output file을 읽어 state trace를 비교한다.
const RESULTS = COMPUTE;

const LANGUAGES = ['go', 'php', 'rust', 'typescript', 'python'];
const BOOLEANS = new Set(['record', 'self-test', 'generate']);
const VALUES = new Set(['root', 'language', 'results']);
const USAGE = `Usage of tests/interfaces/check/main.mts:
  -generate
    \tregenerate the component diagram from the manifest
  -language string
    \tcheck one language or extension; empty checks all five languages and every extension
  -record
    \twrite candidate native symbol inventories after common-contract checks
  -results value
    \talso check the state traces of a conformance output directory of this run, repeatable
  -root string
    \trepository root (default ".")
  -self-test
    \talso verify native parsers reject source mutations`;

/**
 * goFlags는 Go의 flag package가 받는 인자를 parseArgs의 형식으로 바꾼다: `-name`과 `--name`은 같고, bool 옵션의
 * `=true`와 `=false`를 받는다. 첫 위치 인자나 `--`에서 옵션이 끝난다.
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

/** loadOrder는 dbspec document의 entity 이름 순서다(TypeScript client의 runtime model). */
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

// writeSymbols는 symbol 기록을 Go의 json.MarshalIndent(두 칸 들여쓰기)와 줄 끝 하나로 쓴다.
function writeSymbols(path: string, symbols: Symbols): void {
  writeFileSync(path, `${goJson(symbols, '  ')}\n`, { mode: 0o644 });
}

type Options = { root: string; lang: string; tools: Tools; manifest: Manifest; order: string[] | undefined; record: boolean; selfTest: boolean };

/**
 * checkLanguage는 한 언어의 native 선언을 공통 contract, 기록된 symbol snapshot과 그 hash에 비교하고, selfTest면 추출기가
 * source mutation을 놓치지 않는지 확인한다.
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
  if (wantHash !== gotHash) problems.push(`${lang}: symbol snapshot hash differs from contracts/interfaces.json\n  want ${wantHash}\n  got  ${gotHash}`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  if (selfTest) {
    step('source mutations');
    await parserMutations(signal, root, lang, tools);
  }
  console.log(`${lang}: ${Object.keys(actual).length} native symbols inspected; shared signatures and records checked`);
}

/**
 * checkExtension은 extension 하나의 선언을 그 syntax의 추출기로 roots에서 읽어, extension이 구현하는 rule과 owner, 금지된
 * symbol, 기록된 symbol snapshot과 그 hash에 비교한다. extension이 적지 않은 rule이나 owner가 그 이름의 adapter를 가지면
 * 실패한다.
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
  if (wantHash !== gotHash) problems.push(`${name}: symbol snapshot hash differs from contracts/interfaces.json\n  want ${wantHash}\n  got  ${gotHash}`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  console.log(`${name}: ${Object.keys(actual).length} native symbols inspected; ${rules.length} rules and ${owners.length} owners checked`);
}

/** main은 이 실행의 종료 코드다. 임시 directory는 끝에 지운다. */
async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: goFlags(argv),
      options: {
        root: { type: 'string', default: '.' }, record: { type: 'boolean', default: false }, 'self-test': { type: 'boolean', default: false },
        generate: { type: 'boolean', default: false }, results: { type: 'string', multiple: true, default: [] }, language: { type: 'string', default: '' },
      },
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const record = values.record, selfTest = values['self-test'], generate = values.generate, results = values.results, language = values.language;
  let languages = [...LANGUAGES];
  // extensions가 undefined면 manifest의 모든 extension을 확인한다.
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
    const englishPath = join(root, 'docs/interfaces-model.md'), koreanPath = join(root, 'docs/interfaces-model.ko.md');
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
  const tools: Tools = {};
  // 추출기는 이 실행의 directory에 build하고, Rust 추출기는 lease 아래에서 그곳으로 복사한 것을 실행한다.
  const directory = languages.includes('go') || languages.includes('rust') ? mkdtempSync(join(tmpdir(), 'orm-interface-symbols-')) : undefined;
  try {
    if (directory !== undefined && languages.includes('go')) {
      if (!(await runLong('interfaces/go-build', async ({ step }) => { tools.go = await buildGo(step, root, directory); }))) return 1;
    }
    if (directory !== undefined && languages.includes('rust')) {
      if (!(await runLong('interfaces/rust-build', async ({ step }) => { tools.rust = await buildRust(step, root, directory); }))) return 1;
    }
    let failed = false;
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
    if (results.length > 0) {
      const passed = await runCase('interfaces/results', RESULTS, () => {
        const problems = results.flatMap(dir => checkResults(dir, languages, m.sequences ?? []));
        if (problems.length > 0) throw new Error(problems.join('\n'));
      });
      if (!passed) failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
