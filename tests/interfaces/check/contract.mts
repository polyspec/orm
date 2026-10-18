// A check that compares a language's (or extension's) native declarations with the common contract: the signature of rules, prohibited symbols, the field
// lists of owners, and the wire format of records. Each check returns one line per difference.
import { sortBytes } from './json.mts';
import { mark, type ContractRecord, type Owner, type Rule, type Symbol, type Symbols } from './manifest.mts';

/** differences returns the differences between expected and actual symbols (missing, changed, unexpected) in byte order. */
// show writes one symbol with whether it is public and its signature.
const show = (entry: Symbol): string => `${entry.exported ? 'exported' : 'private'} ${entry.signature}`;

export function differences(want: Symbols, got: Symbols): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(want)) {
    if (!Object.hasOwn(got, key)) out.push(`missing ${key}`);
    else if (value.signature !== got[key]?.signature || value.exported !== got[key]?.exported) {
      out.push(`changed ${key}\n  want ${show(value)}\n  got  ${show(got[key] ?? { signature: '', exported: false })}`);
    }
  }
  for (const key of Object.keys(got)) {
    if (!Object.hasOwn(want, key)) out.push(`unexpected ${key}`);
  }
  return sortBytes(out);
}

// SPACE is a character that Go's unicode.IsSpace treats as whitespace.
const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

/** compact is the signature with whitespace removed. A trailing comma that rustfmt allows in a parameter list is syntax only and does not change the common signature. */
function compact(value: string): string {
  return value.replace(SPACE, '').replaceAll(',)', ')');
}

/** pascal is the PascalCase of a snake_case name. */
function pascal(value: string): string {
  return value.split('_').filter(part => part !== '').map(part => part.slice(0, 1).toUpperCase() + part.slice(1)).join('');
}

/**
 * checkRules compares each rule's native symbol and signature with the actual declarations. An entity-level rule expands by order (the entity order
 * of the dbspec document that the contract points to).
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
      const got = actual[key]?.signature ?? '';
      if (!Object.hasOwn(actual, key) || compact(got) !== compact(want)) errors.push(`${lang}/${id}: ${key}\n  want ${want}\n  got  ${got}`);
    }
  }
  return errors;
}

// normalizeName is the name that keeps only letters and digits, in lowercase. Name forms that differ by language (MultiStatement, multi_statement,
// multiStatement) become the same name.
function normalizeName(value: string): string {
  return value.replaceAll(/[^\p{L}\p{Nd}]/gu, '').toLowerCase();
}

/** checkProhibitedSymbols returns one line for each place a prohibited symbol appears in a declaration or signature, regardless of name form. */
export function checkProhibitedSymbols(lang: string, actual: Symbols, prohibited: string[]): string[] {
  const errors: string[] = [];
  for (const [symbol, entry] of Object.entries(actual)) {
    const value = normalizeName(`${symbol} ${entry.signature}`);
    for (const name of prohibited) {
      if (value.includes(normalizeName(name))) errors.push(`${lang}: prohibited symbol ${name} matches ${symbol}`);
    }
  }
  return sortBytes(errors);
}

/**
 * checkOwners compares each owner's field list with the actual declarations. The source inventory may be re-recorded, but the common owner's placement
 * cannot get private controller, cache, or connection fields without changing the contract.
 */
export function checkOwners(lang: string, symbols: Symbols, owners: Owner[]): string[] {
  return checkOwnersAs(lang, lang, symbols, owners);
}

/** checkOwnersAs applies checkOwners in the field notation of a syntax language. An extension (the PHP extension) finds its mapping by its own name and reads fields in PHP syntax. */
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
    for (const field of native.fields ?? []) expected[field] = mark('field');
    for (const key of Object.keys(symbols)) {
      if (key.startsWith(prefix)) actual[key.slice(prefix.length)] = mark('field');
    }
    for (const d of differences(expected, actual)) failures.push(`${lang}/${id}: ${d}`);
  }
  return failures;
}

// wireFields is the value of the `#wire` symbol: a JSON object from field name to wire type.
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

// asSymbols gives a map of record fields the exported status of a public declaration, for the comparison of differences.
const asSymbols = (fields: Record<string, string>): Symbols => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, mark(value)]));

const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && b[key] === value);

/**
 * checkRecords compares a language's record declarations (`#wire` symbols) with the common record: the fields with extends and flatten expanded, and their nested
 * types. In PHP all records are in one validator, and that validator must have no records outside the contract.
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
    const raw = symbols[`${key}#wire`]?.signature;
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
      expected[key] = mark('record');
    }
    for (const key of Object.keys(symbols)) {
      if (key.startsWith(prefix) && key.endsWith('#wire')) actual[key] = mark('record');
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
      for (const d of differences(asSymbols(expected), asSymbols(actual))) failures.push(`${lang}/${r.id ?? ''}: ${d}`);
    }
  }
  return failures;
}

