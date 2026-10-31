// The recipe helper of TypeScript (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
// <recipe>-<database>.test.mjs, calls runRecipe with the recipe and the database, and each case of the recipe is one test
// whose steps call the public API of @polyspec/orm that each op names. It has no command line and no output of its own.
import { readFileSync } from 'node:fs';
import { Kind, Value as JsonValue, parse as parseJson } from '@polyspec/ordered-json';
import { StyledValue, blindIndex, decode, encode, hostDecode, hostEncode } from '../dist/index.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// NONE is the database part of a recipe without a database (FCV-3).
export const NONE = 'none';

// runRecipe registers every case of the recipe at path, relative to the repository root, on database.
export function runRecipe(path, database) {
  if (database !== NONE) throw new Error(`recipe ${path}: database ${database} has no case database in this helper`);
  const recipe = JSON.parse(readFileSync(path, 'utf8'));
  for (const recipeCase of recipe.cases) {
    caseTest(recipeCase.id, COMPUTE, () => {
      const bound = new Map();
      recipeCase.steps.forEach((step, index) => {
        try {
          run(step, bound, database);
        } catch (error) {
          throw new Error(`recipe ${path} case ${recipeCase.id} step ${index} (${step.op}) on ${database}: ${error.message}`, { cause: error });
        }
      });
    });
  }
}

// run maps the op of step to its call and checks the result against the expect of database.
function run(step, bound, database) {
  const result = { decoded: false };
  const attempt = call => {
    try {
      return call();
    } catch (error) {
      result.error = error;
      return undefined;
    }
  };
  switch (step.op) {
    case 'codec.decode':
      result.value = attempt(() => decode(step.styles, argument(step.raw, bound)));
      result.decoded = true;
      break;
    case 'codec.encode':
      result.value = attempt(() => encode(step.styles, styledArgument(step.value, step.styles, bound)));
      break;
    case 'codec.host_encode':
      result.value = attempt(() => hostEncode(argument(step.value, bound), step.styles, step.key ?? ''));
      break;
    case 'codec.host_decode':
      result.value = attempt(() => hostDecode(argument(step.raw, bound), step.styles, step.key ?? ''));
      break;
    case 'codec.blind_index':
      result.value = attempt(() => blindIndex(argument(step.value, bound), step.key ?? ''));
      break;
    default:
      throw new Error(`OP_UNKNOWN ${step.op}`);
  }
  if (step.as !== undefined) bound.set(step.as, result);
  const expect = step.expect?.[database];
  if (expect === undefined) {
    if (result.error !== undefined) throw new Error(`unexpected error ${result.error}`);
    return;
  }
  if (expect.error !== undefined) {
    const code = result.error?.code ?? '';
    if (code !== expect.error) throw new Error(`error ${code || 'none'} (${result.error ?? result.value}), want ${expect.error}`);
    return;
  }
  if (result.error !== undefined) throw new Error(`unexpected error ${result.error}`);
  if (!result.decoded) return compareCell(expect.value, result.value);
  if (result.value.kind === 'sql-null') {
    if (!('null' in expect.value)) throw new Error(`SQL NULL, want ${JSON.stringify(expect.value)}`);
    return;
  }
  const got = fromValue(result.value.payload());
  if (!equal(got, expect.value, step.styles.includes('ordered_json'))) {
    throw new Error(`decoded ${JSON.stringify(got)}, want ${JSON.stringify(expect.value)}`);
  }
}

// compareCell compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell by
// its UTF-8 bytes (FCV-4), and SQL NULL with null.
function compareCell(want, cell) {
  if (cell === null) {
    if (!('null' in want)) throw new Error(`no cell, want ${JSON.stringify(want)}`);
    return;
  }
  const got = Buffer.from(typeof cell === 'string' ? Buffer.from(cell, 'utf8') : cell);
  const expected = 'bytes_hex' in want ? Buffer.from(want.bytes_hex, 'hex') : 'text' in want ? Buffer.from(want.text, 'utf8') : null;
  if (expected === null) throw new Error(`a cell compares with bytes_hex or text, not ${JSON.stringify(want)}`);
  if (!got.equals(expected)) throw new Error(`cell ${got.toString('hex')}, want ${expected.toString('hex')}`);
}

// argument is the value of an argument: the result that a ref names, or the value of a wrapper.
function argument(raw, bound) {
  if ('ref' in raw) return reference(raw.ref, bound);
  return toValue(raw);
}

function reference(name, bound) {
  const result = bound.get(name);
  if (result === undefined) throw new Error(`ref ${name} names no bound result`);
  if (result.error !== undefined) throw new Error(`ref ${name} names a failed step: ${result.error}`);
  return result.value;
}

// styledArgument is the styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage,
// so that its member order and number text are those of the recipe, and the common value model otherwise.
function styledArgument(raw, styles, bound) {
  if ('ref' in raw) {
    const value = reference(raw.ref, bound);
    return value instanceof StyledValue ? value : StyledValue.value(value);
  }
  if ('null' in raw) return StyledValue.sqlNull();
  if (styles.includes('ordered_json')) return StyledValue.value(parseJson(jsonText(raw)));
  return StyledValue.value(toValue(raw));
}

// jsonText writes a wrapper as JSON text with its members in order and its numbers as their recipe text.
function jsonText(w) {
  if ('nil' in w) return 'null';
  if ('bool' in w) return String(w.bool);
  if ('int' in w) return w.int;
  if ('float' in w) return w.float;
  if ('text' in w) return JSON.stringify(w.text);
  if ('array' in w) return `[${w.array.map(jsonText).join(',')}]`;
  if ('object' in w) return `{${w.object.map(([key, value]) => `${JSON.stringify(key)}:${jsonText(value)}`).join(',')}}`;
  throw new Error(`a ${Object.keys(w)[0]} wrapper is not a codec value`);
}

// toValue is the JavaScript value of a wrapper in the common value model of COD-16.
function toValue(w) {
  if ('nil' in w || 'null' in w) return null;
  if ('bool' in w) return w.bool;
  if ('int' in w) return Number(w.int);
  if ('float' in w) return Number(w.float);
  if ('text' in w) return w.text;
  if ('bytes_hex' in w) return Buffer.from(w.bytes_hex, 'hex');
  if ('array' in w) return w.array.map(toValue);
  if ('object' in w) return Object.fromEntries(w.object.map(([key, value]) => [key, toValue(value)]));
  throw new Error(`a ${Object.keys(w)[0]} wrapper is not a codec value`);
}

// fromValue is the wrapper of a decoded value; an ordered-json value keeps its member order and number text.
function fromValue(value) {
  if (value instanceof JsonValue) return fromJson(value);
  if (value === null) return { nil: true };
  if (typeof value === 'boolean') return { bool: value };
  if (typeof value === 'number') return { number: value };
  if (typeof value === 'bigint') return { int: String(value) };
  if (typeof value === 'string') return { text: value };
  if (value instanceof Uint8Array) return { bytes_hex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return { array: value.map(fromValue) };
  return { object: Object.entries(value).map(([key, item]) => [key, fromValue(item)]) };
}

function fromJson(value) {
  switch (value.kind) {
    case Kind.Null: return { nil: true };
    case Kind.Boolean: return { bool: value.booleanValue() };
    case Kind.String: return { text: value.stringValue() };
    case Kind.Number: {
      const text = value.numberLiteral();
      return /[.eE]/.test(text) ? { float: text } : { int: text };
    }
    case Kind.Array: return { array: value.items.map(fromJson) };
    default: return { object: value.keys.map(key => [key.stringValue(), fromJson(value.get(key.stringValue()))]) };
  }
}

// equal compares a decoded wrapper with an expected one: an ordered-json value by its number text and member order (COD-16),
// every other value by number value and with its object as a set of pairs (FCV-4). A JavaScript number does not tell an
// integer from an integral float (COD-3), so it equals an int or a float wrapper of the same value.
function equal(got, want, ordered) {
  if ('number' in got) {
    const expected = 'int' in want ? Number(want.int) : 'float' in want ? Number(want.float) : undefined;
    return expected !== undefined && Object.is(got.number, expected);
  }
  const kind = Object.keys(got)[0];
  if (kind !== Object.keys(want)[0]) return false;
  if (kind === 'int' || kind === 'float') return ordered ? got[kind] === want[kind] : Number(got[kind]) === Number(want[kind]);
  if (kind === 'array') return got.array.length === want.array.length && got.array.every((item, index) => equal(item, want.array[index], ordered));
  if (kind === 'object') {
    if (got.object.length !== want.object.length) return false;
    if (ordered) return got.object.every(([key, item], index) => key === want.object[index][0] && equal(item, want.object[index][1], ordered));
    return want.object.every(([key, item]) => got.object.some(([gotKey, gotItem]) => gotKey === key && equal(gotItem, item, ordered)));
  }
  return got[kind] === want[kind];
}
