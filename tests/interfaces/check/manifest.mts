// Format of contracts/interfaces.json (the common interface manifest) and its own checks: manifest structure, component methods and
// the correspondence of rules, the prohibited symbol list, error labels, and the code list of docs/spec/errors.yaml.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkJson, readJsonFile } from '../../../scripts/json/schema.mts';
import { readLosslessJson } from './json.mts';

const schemas = resolve(import.meta.dirname, '../../../scripts/schema');

/** Symbol is one declaration's signature and whether it is public (export) in that language. */
export type Symbol = { signature: string; exported: boolean };
export type Symbols = Record<string, Symbol>;

/** mark is a symbol for comparison that does not consider public visibility (owner fields, records). */
export const mark = (signature: string, exported = true): Symbol => ({ signature, exported });
type Language = { roots?: string[]; symbols?: string };
export type Native = { symbol?: string; signature?: string };
export type Rule = {
  id?: string; for?: string; inputs?: string[]; output?: string; errors?: string[]; state?: string;
  native?: Record<string, Native>;
};
export type NativeSurface = { id?: string; owner?: string; semantic?: string; symbol?: string; signature?: string };
type AdapterCase = { test?: string; id?: string; phase?: string };
type BehaviorAdapter = {
  status?: string; primitive?: string; surface?: string; cases?: AdapterCase[]; item?: string; required_case?: string;
};
export type BehaviorContract = { id?: string; completion_item?: string; parity?: string; adapters?: Record<string, BehaviorAdapter> };
/**
 * Extension is what implements part of the contract outside the five client languages (extensions in contracts/interfaces.json, PHP extension
 * polyspec_orm). Its declarations are read from roots by a syntax language's extractor, only rules and owners are checked, and it holds its symbol snapshot and its hash
 * separately.
 */
export type Extension = {
  description?: string; syntax?: string; roots?: string[]; symbols?: string; symbol_hash?: string; rules?: string[]; owners?: string[];
};
export type Component = {
  id?: string; fields?: Record<string, string>; methods?: string[]; ownership?: string; ownership_ko?: string; internal?: string; internal_ko?: string;
};
type Edge = { from?: string; to?: string; kind?: string; role?: string; role_ko?: string };
/**
 * Sequence is one common state contract. statements lists in order the kinds of statement that sequence sends: model
 * statements (select, insert, update, delete), transaction control (begin, commit, rollback, savepoint, release, rollback_to), and
 * schema statements. Utility statements (named lock, transaction-local values, etc.) are not listed: their count and position
 * differ by dialect (MySQL's GET_LOCK and RELEASE_LOCK), and the exact list is set per dialect by the conformance vectors (tests/conformance/vectors*.json), which make conformance-check compares.
 * expected holds numbers as their original text (losslessJson).
 */
export type Sequence = { id?: string; expected?: unknown; statements?: string[] };
/**
 * Record fixes the whole value-less request/plan graph regardless of implementation. A native name is an adapter, and field and nested types are
 * common.
 */
export type ContractRecord = {
  id?: string; native?: Record<string, string>; fields?: Record<string, string>; optional?: string[]; extends?: string; union?: boolean;
};
/** Owner points to one symbol (`once`), and its field list is exactly as written in the contract. */
export type Owner = { id?: string; for?: string; native?: Record<string, { symbol?: string; fields?: string[] }> };
export type Manifest = {
  version?: number;
  schema?: string;
  languages?: Record<string, Language>;
  symbol_hashes?: Record<string, string>;
  extensions?: Record<string, Extension>;
  prohibited_symbols?: string[];
  rules?: Rule[];
  native_surfaces?: NativeSurface[];
  behavior_adapters?: BehaviorContract[];
  components?: Component[];
  edges?: Edge[];
  sequences?: Sequence[];
  records?: ContractRecord[];
  storage?: Rule[];
  owners?: Owner[];
};

/**
 * readManifest reads the manifest file with the schema. The expected values of the state contract are re-read so that numbers keep their original text:
 * because conformance results are compared as original text.
 */
export function readManifest(path: string): Manifest {
  const manifest = readJsonFile<Manifest>(path, join(schemas, 'interfaces-manifest.schema.json'));
  const lossless = checkJson<{ sequences?: { expected?: unknown }[] }>(readLosslessJson(path), join(schemas, 'interfaces-sequences.schema.json'), path);
  manifest.sequences?.forEach((sequence, index) => {
    const expected = lossless.sequences?.[index]?.expected;
    if (expected === undefined) delete sequence.expected;
    else sequence.expected = expected;
  });
  return manifest;
}

/** allRules is the manifest's rules and storage rules. */
export function allRules(m: Manifest): Rule[] {
  return [...(m.rules ?? []), ...(m.storage ?? [])];
}

const size = (value: object | undefined): number => (value === undefined ? 0 : Object.keys(value).length);

/** validateManifest checks the manifest's own structure before any language or file is read. */
export function validateManifest(m: Manifest): void {
  if (m.version !== 1 || size(m.languages) !== 5 || size(m.symbol_hashes) !== 5 || (m.prohibited_symbols ?? []).length === 0
    || (m.components ?? []).length === 0 || (m.sequences ?? []).length === 0) {
    throw new Error('invalid interface manifest');
  }
  validateProhibitions(m.prohibited_symbols ?? []);
  checkComponentMethods(m);
  validateNativeSurfaces(m.native_surfaces ?? []);
  validateBehaviorAdapters(m.behavior_adapters ?? [], m.native_surfaces ?? []);
}

/** validateNativeSurfaces accepts only typed, language-owned host APIs tied to a shared semantic requirement. */
function validateNativeSurfaces(surfaces: NativeSurface[]): void {
  const seen = new Set<string>();
  for (const surface of surfaces) {
    const id = surface.id ?? '', owner = surface.owner ?? '';
    if (id === '' || seen.has(id) || !['go', 'php', 'rust', 'typescript', 'python'].includes(owner)
      || (surface.semantic ?? '') === '' || (surface.symbol ?? '') === '' || (surface.signature ?? '') === '') {
      throw new Error(`invalid or duplicate native surface ${id}`);
    }
    seen.add(id);
  }
}

/** validateBehaviorAdapters keeps a truthful six-runtime adapter ledger without treating unresolved work as completed behavior. */
export function validateBehaviorAdapters(contracts: BehaviorContract[], surfaces: NativeSurface[]): void {
  const runtimes = ['go', 'php', 'php-extension', 'python', 'rust', 'typescript'];
  const ids = new Set<string>();
  const surfaceIds = new Set(surfaces.map(surface => surface.id ?? ''));
  for (const contract of contracts) {
    const id = contract.id ?? '', adapters = contract.adapters ?? {};
    if (id === '' || ids.has(id) || (contract.completion_item ?? '') === '' || (contract.parity ?? '') === '' || runtimes.some(runtime => !Object.hasOwn(adapters, runtime))
      || Object.keys(adapters).some(runtime => !runtimes.includes(runtime))) {
      throw new Error(`invalid or duplicate behavior adapter contract ${id}`);
    }
    ids.add(id);
    for (const runtime of runtimes) {
      const adapter = adapters[runtime] ?? {};
      if (adapter.status === 'implemented') {
        const requiresSurface = runtime === 'go' || runtime === 'typescript' || runtime === 'python';
        if ((adapter.primitive ?? '') === '' || (adapter.cases ?? []).length === 0 || adapter.item !== undefined
          || adapter.required_case !== undefined || (requiresSurface && adapter.surface === undefined)
          || (adapter.surface !== undefined && !surfaceIds.has(adapter.surface))) {
          throw new Error(`${id}/${runtime}: implemented adapter requires a primitive and exact cases`);
        }
        if (adapter.surface !== undefined) {
          const surface = surfaces.find(candidate => candidate.id === adapter.surface);
          if (surface?.owner !== runtime || surface.semantic !== id) throw new Error(`${id}/${runtime}: host surface owner or semantic does not match`);
        }
        for (const c of adapter.cases ?? []) {
          if ((c.test ?? '') === '' || (c.id ?? '') === '' || (c.phase !== undefined && c.phase !== 'before-start' && c.phase !== 'in-flight')) {
            throw new Error(`${id}/${runtime}: adapter case requires test and id and has an invalid phase`);
          }
        }
      } else if (adapter.status === 'unresolved') {
        if ((adapter.item ?? '') === '' || (adapter.required_case ?? '') === '' || adapter.primitive !== undefined
          || (adapter.cases ?? []).length > 0 || adapter.surface !== undefined) {
          throw new Error(`${id}/${runtime}: unresolved adapter requires an item and required case, and cannot claim implementation`);
        }
      } else throw new Error(`${id}/${runtime}: status must be implemented or unresolved`);
    }
  }
  if (!ids.has('CFG-9')) throw new Error('missing behavior adapter contract CFG-9');
}

/** behaviorCompletionErrors reports unresolved runtime adapters so an item cannot claim six-client completion early. */
export function behaviorCompletionErrors(contract: BehaviorContract): string[] {
  return Object.entries(contract.adapters ?? {}).filter(([, adapter]) => adapter.status !== 'implemented')
    .map(([runtime]) => `${contract.id ?? ''}/${runtime}: unresolved native behavior adapter`);
}

/**
 * checkComponentMethods makes the component diagram (docs/spec/interfaces-model.md) and the rules have the same methods: the public component's
 * method is common API only through its rule, so a method with no rule is compared with no language, and no public component may leave out
 * a method. A method's rule is common API the diagram omitted. A component marked internal states why each client implements that method privately, without a common signature, in both languages,
 * so that method has no rule.
 */
function checkComponentMethods(m: Manifest): void {
  const rules = allRules(m);
  const declared = new Set(rules.map(r => r.id ?? ''));
  const listed = new Set<string>();
  const missing: string[] = [];
  for (const c of m.components ?? []) {
    const internal = c.internal ?? '', internalKo = c.internal_ko ?? '';
    if ((internal === '') !== (internalKo === '')) {
      throw new Error(`component ${c.id ?? ''} is internal without its grounding in both internal and internal_ko`);
    }
    if (internal !== '') continue;
    for (const method of c.methods ?? []) {
      const id = `${c.id ?? ''}.${method}`;
      listed.add(id);
      if (!declared.has(id)) missing.push(id);
    }
  }
  const unlisted = rules.map(r => r.id ?? '').filter(id => !listed.has(id));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`component methods without an interface rule in contracts/interfaces.json: ${missing.join(', ')}`);
  if (unlisted.length > 0) problems.push(`interface rules whose method no public component lists in contracts/interfaces.json: ${unlisted.join(', ')}`);
  if (problems.length > 0) throw new Error(problems.join('; '));
}

/** validateProhibitions checks that the prohibited symbol list is not empty, has no duplicate names, and prohibits multi_statement. */
export function validateProhibitions(prohibited: string[]): void {
  const seen = new Set<string>();
  for (const name of prohibited) {
    if (name === '' || seen.has(name)) throw new Error(`duplicate or empty prohibited symbol ${JSON.stringify(name)}`);
    seen.add(name);
  }
  if (!seen.has('multi_statement')) throw new Error('interface manifest must prohibit multi_statement');
}

/** readErrorCatalog is the code list of docs/spec/errors.yaml. A code is an uppercase name and is not duplicated. */
export function readErrorCatalog(root: string): Set<string> {
  const document: unknown = parseYaml(readFileSync(join(root, 'docs/spec/errors.yaml'), 'utf8'));
  const entries: unknown[] = document !== null && typeof document === 'object' && 'codes' in document && Array.isArray(document.codes) ? document.codes : [];
  if (entries.length === 0) throw new Error('error catalog has no codes');
  const codes = new Set<string>();
  for (const entry of entries) {
    const value: unknown = entry !== null && typeof entry === 'object' && 'code' in entry ? entry.code : '';
    const code = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    if (!/^[A-Z][A-Z0-9_]*$/.test(code) || codes.has(code)) throw new Error(`invalid or duplicate error code ${JSON.stringify(code)}`);
    codes.add(code);
  }
  return codes;
}

/**
 * checkErrorLabels checks that each rule's error label is a code in the catalog (or one of the two driver error labels) and is not duplicated within the rule,
 * and that the errors state sequence is the only one and expects a non-empty list of catalog codes.
 */
export function checkErrorLabels(codes: Set<string>, rules: Rule[], sequences: Sequence[]): string[] {
  const failures: string[] = [];
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const label of rule.errors ?? []) {
      if (seen.has(label)) failures.push(`${rule.id ?? ''}: duplicate error ${label}`);
      seen.add(label);
      if (!codes.has(label) && label !== 'driver error' && label !== 'driver or codec error') failures.push(`${rule.id ?? ''}: unknown error ${label}`);
    }
  }
  let found = false;
  for (const sequence of sequences) {
    if (sequence.id !== 'errors') continue;
    if (found) failures.push('duplicate errors state sequence');
    found = true;
    const values = sequence.expected;
    if (!Array.isArray(values) || values.length === 0) {
      failures.push('errors state sequence requires a nonempty code list');
      continue;
    }
    values.forEach((value: unknown, index: number) => {
      if (typeof value !== 'string' || !codes.has(value)) failures.push(`errors state sequence item ${index} is not a declared code`);
    });
  }
  if (!found) failures.push('missing errors state sequence');
  return failures;
}
