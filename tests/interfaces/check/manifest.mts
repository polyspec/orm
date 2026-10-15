// contracts/interfaces.json(공통 interface manifest)의 형식과 그 자체의 검사다: manifest 구조, 구성요소 method와
// rule의 대응, 금지 symbol 목록, error label과 docs/errors.yaml의 code 목록.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkJson, readJsonFile } from '../../../scripts/json/schema.mts';
import { readLosslessJson } from './json.mts';

const schemas = resolve(import.meta.dirname, '../../../scripts/schema');

export type Symbols = Record<string, string>;
export type Language = { roots?: string[]; symbols?: string };
export type Native = { symbol?: string; signature?: string };
export type Rule = {
  id?: string; for?: string; inputs?: string[]; output?: string; errors?: string[]; state?: string;
  native?: Record<string, Native>;
};
/**
 * Extension은 다섯 client 언어 밖에서 contract의 일부를 구현하는 것이다(contracts/interfaces.json의 extensions, PHP 확장
 * orm_dbspec). 그 선언은 syntax 언어의 추출기로 roots에서 읽고, rules와 owners만 확인하며, symbol snapshot과 그 hash를
 * 따로 가진다.
 */
export type Extension = {
  description?: string; syntax?: string; roots?: string[]; symbols?: string; symbol_hash?: string; rules?: string[]; owners?: string[];
};
export type Component = {
  id?: string; fields?: Record<string, string>; methods?: string[]; ownership?: string; ownership_ko?: string; internal?: string; internal_ko?: string;
};
export type Edge = { from?: string; to?: string; kind?: string; role?: string; role_ko?: string };
/**
 * Sequence는 공통 state contract 하나다. statements는 그 sequence가 보내는 statement의 kind를 순서대로 적는다: model
 * statement(select, insert, update, delete), transaction 제어(begin, commit, rollback, savepoint, release, rollback_to)와
 * schema statement. utility statement(named lock, transaction-local 값 등)는 적지 않는다: 그 수와 위치는 dialect마다
 * 다르고(MySQL의 GET_LOCK과 RELEASE_LOCK), 정확한 목록은 conformance vector(tests/conformance/vectors*.json)가 dialect마다
 * 정해 make conformance-check가 비교한다. expected는 숫자를 원문으로 가진다(losslessJson).
 */
export type Sequence = { id?: string; expected?: unknown; statements?: string[] };
/**
 * Record는 값 없는 request/plan graph 전체를 구현과 무관하게 정한다. native 이름은 adapter이고 field와 중첩 type은
 * 공통이다.
 */
export type ContractRecord = {
  id?: string; native?: Record<string, string>; fields?: Record<string, string>; optional?: string[]; extends?: string; union?: boolean;
};
/** Owner는 한 symbol을 가리키며(`once`), 그 field 목록은 contract에 적힌 그대로다. */
export type Owner = { id?: string; for?: string; native?: Record<string, { symbol?: string; fields?: string[] }> };
export type Manifest = {
  version?: number;
  schema?: string;
  languages?: Record<string, Language>;
  symbol_hashes?: Record<string, string>;
  extensions?: Record<string, Extension>;
  prohibited_symbols?: string[];
  rules?: Rule[];
  components?: Component[];
  edges?: Edge[];
  sequences?: Sequence[];
  records?: ContractRecord[];
  storage?: Rule[];
  owners?: Owner[];
};

/**
 * readManifest는 manifest file을 schema로 읽는다. state contract의 expected 값은 숫자를 원문 그대로 가지도록 다시 읽는다:
 * conformance 결과와 원문으로 비교하기 때문이다.
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

/** allRules는 manifest의 rules와 storage rule이다. */
export function allRules(m: Manifest): Rule[] {
  return [...(m.rules ?? []), ...(m.storage ?? [])];
}

const size = (value: object | undefined): number => (value === undefined ? 0 : Object.keys(value).length);

/** validateManifest는 어느 언어나 file을 읽기 전에 manifest 자신의 구조를 검사한다. */
export function validateManifest(m: Manifest): void {
  if (m.version !== 1 || size(m.languages) !== 5 || size(m.symbol_hashes) !== 5 || (m.prohibited_symbols ?? []).length === 0
    || (m.components ?? []).length === 0 || (m.sequences ?? []).length === 0) {
    throw new Error('invalid interface manifest');
  }
  validateProhibitions(m.prohibited_symbols ?? []);
  checkComponentMethods(m);
}

/**
 * checkComponentMethods는 구성요소 도표(docs/interfaces-model.md)와 rule이 같은 method를 가지게 한다: 공개 구성요소의
 * method는 그 rule로만 공통 API이므로 rule이 없는 method는 어느 언어와도 비교되지 않고, 어느 공개 구성요소도 적지 않은
 * method의 rule은 도표가 빠뜨린 공통 API다. internal로 표시한 구성요소는 두 언어로 각 client가 그 method를 공통 signature
 * 없이 비공개로 구현하는 이유를 적으므로 그 method에는 rule이 없다.
 */
export function checkComponentMethods(m: Manifest): void {
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

/** validateProhibitions는 금지 symbol 목록이 비거나 중복된 이름이 없고 multi_statement를 금지하는지 검사한다. */
export function validateProhibitions(prohibited: string[]): void {
  const seen = new Set<string>();
  for (const name of prohibited) {
    if (name === '' || seen.has(name)) throw new Error(`duplicate or empty prohibited symbol ${JSON.stringify(name)}`);
    seen.add(name);
  }
  if (!seen.has('multi_statement')) throw new Error('interface manifest must prohibit multi_statement');
}

/** readErrorCatalog는 docs/errors.yaml의 code 목록이다. code는 대문자 이름이며 중복되지 않는다. */
export function readErrorCatalog(root: string): Set<string> {
  const document: unknown = parseYaml(readFileSync(join(root, 'docs/errors.yaml'), 'utf8'));
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
 * checkErrorLabels는 rule의 error label이 catalog의 code(또는 driver error 두 label)이고 rule 안에서 중복되지 않는지,
 * errors state sequence가 하나뿐이며 catalog code의 비지 않은 목록을 기대하는지 검사한다.
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
