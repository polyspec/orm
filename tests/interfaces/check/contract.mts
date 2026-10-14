// 한 언어(또는 extension)의 native 선언을 공통 contract에 비교하는 검사다: rule의 signature, 금지 symbol, owner의 field
// 목록, record의 wire 형식. 각 검사는 차이마다 한 줄을 돌려준다.
import { sortBytes } from './json.mts';
import type { ContractRecord, Owner, Rule, Symbols } from './manifest.mts';

/** differences는 기대한 symbol과 실제 symbol의 차이(missing, changed, unexpected)를 byte 순서로 돌려준다. */
export function differences(want: Symbols, got: Symbols): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(want)) {
    if (!Object.hasOwn(got, key)) out.push(`missing ${key}`);
    else if (value !== got[key]) out.push(`changed ${key}\n  want ${value}\n  got  ${got[key] ?? ''}`);
  }
  for (const key of Object.keys(got)) {
    if (!Object.hasOwn(want, key)) out.push(`unexpected ${key}`);
  }
  return sortBytes(out);
}

// SPACE는 Go의 unicode.IsSpace가 공백으로 보는 문자다.
const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

/** compact는 공백을 지운 signature다. rustfmt가 parameter 목록에 허용하는 끝 쉼표는 문법일 뿐 공통 signature를 바꾸지 않는다. */
export function compact(value: string): string {
  return value.replace(SPACE, '').replaceAll(',)', ')');
}

/** pascal은 snake_case 이름의 PascalCase다. */
export function pascal(value: string): string {
  return value.split('_').filter(part => part !== '').map(part => part.slice(0, 1).toUpperCase() + part.slice(1)).join('');
}

/**
 * checkRules는 rule마다 언어의 native symbol과 signature를 실제 선언에 비교한다. entity 단위 rule은 order(contract가
 * 가리키는 dbspec document의 entity 순서)로 펼친다.
 */
export function checkRules(lang: string, actual: Symbols, rules: Rule[], order: string[] | undefined): string[] {
  const errors: string[] = [];
  for (const rule of rules) {
    const id = rule.id ?? '';
    const native = rule.native?.[lang];
    if (native === undefined) {
      errors.push(`${id}: missing ${lang} mapping`);
      continue;
    }
    const maps: Record<string, string>[] = [];
    if (rule.for === 'once') maps.push({});
    else if (rule.for === 'entity') {
      for (const name of order ?? []) maps.push({ entity: name, Entity: pascal(name) });
    } else errors.push(`${id}: unknown expansion ${rule.for ?? ''}`);
    for (const vars of maps) {
      const fill = (value: string): string => Object.entries(vars).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, replacement), value);
      const key = fill(native.symbol ?? ''), want = fill(native.signature ?? '');
      const got = actual[key] ?? '';
      if (!Object.hasOwn(actual, key) || compact(got) !== compact(want)) errors.push(`${lang}/${id}: ${key}\n  want ${want}\n  got  ${got}`);
    }
  }
  return errors;
}

// normalizeName은 글자와 숫자만 소문자로 남긴 이름이다. 언어마다 다른 이름 형식(MultiStatement, multi_statement,
// multiStatement)이 같은 이름이 된다.
function normalizeName(value: string): string {
  return [...value].filter(char => /^[\p{L}\p{Nd}]$/u.test(char)).map(char => char.toLowerCase()).join('');
}

/** checkProhibitedSymbols는 금지 symbol이 이름 형식과 무관하게 선언이나 signature에 나오는 곳마다 한 줄을 돌려준다. */
export function checkProhibitedSymbols(lang: string, actual: Symbols, prohibited: string[]): string[] {
  const errors: string[] = [];
  for (const [symbol, signature] of Object.entries(actual)) {
    const value = normalizeName(`${symbol} ${signature}`);
    for (const name of prohibited) {
      if (value.includes(normalizeName(name))) errors.push(`${lang}: prohibited symbol ${name} matches ${symbol}`);
    }
  }
  return sortBytes(errors);
}

/**
 * checkOwners는 owner의 field 목록을 실제 선언에 비교한다. source inventory는 다시 기록할 수 있지만, 공통 owner의 배치는
 * contract를 고치지 않고는 비공개 controller, cache, connection field를 얻을 수 없다.
 */
export function checkOwners(lang: string, symbols: Symbols, owners: Owner[]): string[] {
  return checkOwnersAs(lang, lang, symbols, owners);
}

/** checkOwnersAs는 checkOwners를 syntax 언어의 field 표기로 한다. extension(PHP 확장)은 자기 이름으로 mapping을 찾고 PHP 문법으로 field를 읽는다. */
export function checkOwnersAs(lang: string, syntax: string, symbols: Symbols, owners: Owner[]): string[] {
  const failures: string[] = [];
  for (const owner of owners) {
    const id = owner.id ?? '';
    if (owner.for !== 'once') {
      failures.push(`${id}: unknown owner expansion ${owner.for ?? ''}`);
      continue;
    }
    const native = owner.native?.[lang];
    if (native === undefined) {
      failures.push(`${id}: missing owner mapping ${lang}`);
      continue;
    }
    const symbol = native.symbol ?? '';
    if (!Object.hasOwn(symbols, symbol)) {
      failures.push(`${lang}/${id}: missing owner ${symbol}`);
      continue;
    }
    const prefix = syntax === 'php' ? `${symbol}::$` : `${symbol}#field.`;
    const expected: Symbols = {}, actual: Symbols = {};
    for (const field of native.fields ?? []) expected[field] = 'field';
    for (const key of Object.keys(symbols)) {
      if (key.startsWith(prefix)) actual[key.slice(prefix.length)] = 'field';
    }
    for (const d of differences(expected, actual)) failures.push(`${lang}/${id}: ${d}`);
  }
  return failures;
}

// wireFields는 `#wire` symbol의 값, field 이름에서 wire type으로 가는 JSON object다.
function wireFields(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`json: cannot unmarshal ${raw} into a record wire`);
  const out: Record<string, string> = {};
  for (const [key, type] of Object.entries(value)) {
    if (typeof type !== 'string') throw new Error(`json: cannot unmarshal the wire type of ${key} into a string`);
    out[key] = type;
  }
  return out;
}

const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && b[key] === value);

/**
 * checkRecords는 언어의 record 선언(`#wire` symbol)을 공통 record에 비교한다: extends와 flatten을 펼친 field와 그 중첩
 * type. PHP는 record가 모두 한 validator 안에 있고, 그 validator에 contract 밖의 record가 없어야 한다.
 */
export function checkRecords(lang: string, symbols: Symbols, records: ContractRecord[]): string[] {
  const byId = new Map<string, ContractRecord>(), byNative = new Map<string, ContractRecord>();
  for (const r of records) {
    byId.set(r.id ?? '', r);
    byNative.set(r.native?.[lang] ?? '', r);
  }
  const flattenExpected = (r: ContractRecord): Record<string, string> => {
    const out: Record<string, string> = {};
    if ((r.extends ?? '') !== '') Object.assign(out, flattenExpected(byId.get(r.extends ?? '') ?? {}));
    Object.assign(out, r.fields ?? {});
    return out;
  };
  const normalize = (prefix: string, type: string): string => {
    for (const kind of ['list', 'map']) {
      if (type.startsWith(`${kind}<`) && type.endsWith('>')) return `${kind}<${normalize(prefix, type.slice(kind.length + 1, -1))}>`;
    }
    const record = byNative.get(prefix + type);
    return record === undefined ? type : record.id ?? '';
  };
  const readNative = (r: ContractRecord): Record<string, string> => {
    const key = r.native?.[lang] ?? '';
    const prefix = key.slice(0, key.lastIndexOf('::') + 2);
    const raw = symbols[`${key}#wire`];
    if (raw === undefined || !Object.hasOwn(symbols, `${key}#wire`)) throw new Error(`${lang}: missing record ${key}`);
    const out: Record<string, string> = {};
    for (const [field, type] of Object.entries(wireFields(raw))) {
      if (field === '@flatten') {
        const parent = byNative.get(prefix + type);
        if (parent === undefined) throw new Error(`unknown flattened record ${type}`);
        Object.assign(out, readNative(parent));
      } else out[field] = normalize(prefix, type);
    }
    return out;
  };
  const failures: string[] = [];
  for (const r of records) {
    if ((r.native?.[lang] ?? '') === '') failures.push(`${lang}/${r.id ?? ''}: missing record mapping`);
  }
  if (failures.length !== 0) return failures;
  const first = records[0];
  if (lang === 'php' && first !== undefined) {
    let prefix = first.native?.[lang] ?? '';
    if (prefix.lastIndexOf('::') < 0) return ['php records: missing validator mapping'];
    prefix = prefix.slice(0, prefix.lastIndexOf('::') + 2);
    const expected: Symbols = {}, actual: Symbols = {};
    for (const r of records) {
      const key = `${r.native?.[lang] ?? ''}#wire`;
      if (!key.startsWith(prefix)) failures.push(`php/${r.id ?? ''}: record is outside the validator`);
      expected[key] = 'record';
    }
    for (const key of Object.keys(symbols)) {
      if (key.startsWith(prefix) && key.endsWith('#wire')) actual[key] = 'record';
    }
    for (const mismatch of differences(expected, actual)) failures.push(`php records: ${mismatch}`);
  }
  for (const r of records) {
    let actual: Record<string, string>;
    try {
      actual = readNative(r);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const expected = flattenExpected(r);
    if (!sameMap(actual, expected)) {
      for (const d of differences(expected, actual)) failures.push(`${lang}/${r.id ?? ''}: ${d}`);
    }
  }
  return failures;
}

