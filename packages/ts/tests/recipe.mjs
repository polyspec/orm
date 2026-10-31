// The recipe helper of TypeScript (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
// <recipe>-<database>.test.mjs, calls runRecipe with the recipe and the database, and each case of the recipe is one test
// whose steps call the public API of @polyspec/orm that each op names. It has no command line and no output of its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kind, Value as JsonValue, parse as parseJson } from '@polyspec/ordered-json';
import { Db, StyledValue, blindIndex, connectCatalog, dbspecManifest, decode, encode, hostDecode, hostEncode, parseDbspec, readDbspecFile } from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { nativeQuery } from './coverage_case.mjs';
import { caseTest, COMPUTE, DATABASE } from '../../../tests/testcase.mts';

// NONE is the database part of a recipe without a database (FCV-3).
export const NONE = 'none';

// runRecipe registers every case of the recipe at path, relative to the repository root, on database. A database other than
// none runs each case on a case database of its own (databaseRecipe), and the entry awaits the registration.
export function runRecipe(path, database) {
  if (database !== NONE) return databaseRecipe(path, database);
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

// The database path (FCV-3 and FCV-4): each case runs on a case database of its own through the public catalog API.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DATABASES = new Set(['mysql', 'postgres', 'sqlite']);

// databaseRecipe registers one test per case of the recipe at path on the database (FCV-3).
async function databaseRecipe(path, database) {
  if (!DATABASES.has(database)) throw new Error(`recipe ${path}: unknown database ${database}`);
  const recipe = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const name = path;
  if (recipe.fixture === undefined) throw new Error(`recipe ${name}: no fixture, so it has no database`);
  const schema = await fixtureSchema(resolve(root, recipe.fixture));
  for (const recipeCase of recipe.cases) {
    caseTest(`${name}/${recipeCase.id}/${database}`, DATABASE, ({ step }) =>
      withCaseDatabase(database, step, caseDatabase => runCase({ name, recipe, recipeCase, database, schema, caseDatabase, step })));
  }
}

/** The Schema of a dbspec-set.json: the parse and the manifest of its documents through the public dbspec API. */
async function fixtureSchema(setPath) {
  const set = JSON.parse(await readFile(setPath, 'utf8'));
  const documents = [];
  for (const document of set.documents) {
    const path = resolve(dirname(setPath), document);
    const read = await readDbspecFile(path);
    if (read.text === null) throw new Error(`${path}: ${JSON.stringify(read.diagnostics)}`);
    const parsed = parseDbspec(read.text, {});
    if (parsed.document === null) throw new Error(`${path}: ${JSON.stringify(parsed.diagnostics)}`);
    documents.push(parsed.document);
  }
  const { manifest, diagnostics } = dbspecManifest(documents);
  if (manifest === null) throw new Error(`${setPath}: ${JSON.stringify(diagnostics)}`);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

async function runCase({ name, recipe, recipeCase, database, schema, caseDatabase, step }) {
  const db = await Db.connect(caseDatabase.dsn);
  try { await db.utils().schema().install(schema); } finally { await db.close(); }
  step('schema installed');
  const catalog = await connectCatalog(caseDatabase.dsn);
  try {
    const namespace = await catalog.currentNamespace();
    const bound = new Map([['database', { text: caseDatabase.name }]]);
    const context = { catalog, namespace, database, dsn: caseDatabase.dsn, bound };
    for (const rows of [recipe.seed?.rows, recipeCase.seed?.rows]) {
      for (const [table, values] of Object.entries(rows ?? {})) {
        const metadata = await catalog.describeTable({ namespace, name: table });
        for (const row of values) await catalog.insertRow(metadata, assignments(row, context));
      }
    }
    step('seed rows inserted');
    for (const [index, current] of recipeCase.steps.entries()) {
      const where = `recipe ${name}, case ${recipeCase.id}, step ${index} (${current.op}), database ${database}`;
      try {
        await runStep(current, context);
      } catch (error) {
        throw new Error(`${where}: ${error.message}`, { cause: error });
      }
      step(`step ${index} ${current.op}`);
    }
  } finally {
    await catalog.close();
  }
}

// Each op maps to one call of the public API and returns the fields that its expect compares.
const OPS = {
  async 'catalog.current_namespace'(_, { catalog }) {
    return { value: { text: await catalog.currentNamespace() } };
  },
  async 'catalog.describe_table'(s, { catalog, namespace }) {
    const metadata = await catalog.describeTable({ namespace, name: s.table });
    return { bind: metadata, columns: metadata.columns.map(c => c.name), primary_key: metadata.primaryKey, reliable_row_identity: metadata.reliableRowIdentity };
  },
  async 'catalog.table_page'(s, { catalog, namespace }) {
    const page = await catalog.tablePage({ namespace, name: s.table }, s.limit, s.offset);
    const indexes = s.columns.map(column => {
      const at = page.columnIndex(column);
      if (at < 0) throw new Error(`the page has no column ${column}`);
      return at;
    });
    const types = page.result.columns.map(c => c.nativeType);
    return { bind: page, columns: page.result.columns.map(c => c.name), order_by: page.orderBy, has_more: page.hasMore, rows: page.result.rows.map(row => indexes.map(at => plain(row[at], types[at]))) };
  },
  async 'catalog.read_only_query'(s, context) {
    const result = await context.catalog.readOnlyQuery(sql(s.sql, context), [], limits(s));
    return { rows: result.rows.map(row => row.map(cell => plain(cell, null))) };
  },
  async 'catalog.read_only_grid_query'(s, context) {
    const result = await context.catalog.readOnlyGridQuery(sql(s.sql, context), [], limits(s));
    return { columns: result.columns.map(c => c.name), rows: result.rows.map(row => row.map(grid)) };
  },
  async 'catalog.row_snapshot'(s, context) {
    return { bind: context.catalog.rowSnapshotFromPage(stepArgument(s.page, context), s.index) };
  },
  async 'catalog.insert_row'(s, context) {
    const metadata = stepArgument(s.metadata, context);
    return mutation(metadata, await context.catalog.insertRow(metadata, assignments(s.values, context)));
  },
  async 'catalog.update_row'(s, context) {
    const snapshot = stepArgument(s.snapshot, context);
    return mutation(snapshot.metadata, await context.catalog.updateRow(snapshot, assignments(s.set, context)));
  },
  async 'catalog.delete_row'(s, context) {
    return { value: { int: String(await context.catalog.deleteRow(stepArgument(s.snapshot, context))) } };
  },
  async 'sql.exec'(s, context) {
    await nativeQuery(context.database, context.dsn, [sql(s.sql, context)]);
    return {};
  },
};

async function runStep(s, context) {
  const op = OPS[s.op];
  if (op === undefined) throw new Error(`OP_UNKNOWN ${s.op}`);
  const expected = s.expect === undefined ? undefined : resolveRefs(s.expect[context.database], context);
  let actual;
  try {
    actual = await op(s, context);
  } catch (error) {
    if (expected?.error === undefined || typeof error?.code !== 'string') throw error;
    assert.equal(error.code, expected.error, `the error code (${error.message})`);
    return;
  }
  if (s.as !== undefined) context.bound.set(s.as, actual.bind ?? actual.value);
  if (expected === undefined) return;
  if (expected.error !== undefined) throw new Error(`expected ${expected.error}, and the op succeeded`);
  const compared = Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]]));
  assert.deepEqual(normalized(compared), normalized(expected));
}

/** A field that holds SQL or a database-decided value: the string itself, or the entry of the database. */
function sql(field, { database }) {
  return typeof field === 'string' ? field : field[database];
}

function limits(s) {
  return { ...(s.max_rows === undefined ? {} : { maxRows: s.max_rows }), ...(s.max_bytes === undefined ? {} : { maxBytes: s.max_bytes }) };
}

/** A bound value of {"ref": "<name>"} or {"ref": "<name>.<path>"}. */
function bound(ref, { bound: values }) {
  const [head, ...path] = ref.split('.');
  if (!values.has(head)) throw new Error(`no bound value ${head}`);
  return path.reduce((value, key) => {
    if (value === null || typeof value !== 'object' || !(key in value)) throw new Error(`bound value ${head} has no ${path.join('.')}`);
    return value[key];
  }, values.get(head));
}

function stepArgument(field, context) {
  if (field !== null && typeof field === 'object' && 'ref' in field) return bound(field.ref, context);
  return field;
}

function resolveRefs(value, context) {
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, context));
  if (value === null || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && 'ref' in value) return bound(value.ref, context);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRefs(item, context)]));
}

/** The assignments of an object of column names whose values are recipe wrappers or per-database objects. */
function assignments(values, context) {
  return Object.entries(values).map(([name, value]) => ({ name, value: native(databaseValue(stepArgument(value, context), context)) }));
}

function databaseValue(value, { database }) {
  if (value !== null && typeof value === 'object' && 'mysql' in value && 'postgres' in value && 'sqlite' in value) return value[database];
  return value;
}

/** The value of the TypeScript API for a recipe wrapper. */
function native(wrapper) {
  const [[kind, value]] = Object.entries(wrapper);
  switch (kind) {
    case 'int': {
      const n = BigInt(value);
      return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    case 'text': case 'date': case 'time': case 'datetime': case 'decimal': return value;
    case 'bytes_hex': return Uint8Array.from(Buffer.from(value, 'hex'));
    case 'bool': return value;
    case 'null': return null;
    default: throw new Error(`unknown recipe wrapper ${kind}`);
  }
}

/** The recipe wrapper of a plain value; a string takes the wrapper of the native type of its column when one is known. */
function plain(value, nativeType) {
  if (value === null) return { null: true };
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) return { int: String(value) };
  if (typeof value === 'boolean') return { bool: value };
  if (value instanceof Uint8Array) return { bytes_hex: Buffer.from(value).toString('hex') };
  if (typeof value === 'string') return { [temporalKind(nativeType) ?? 'text']: value };
  throw new Error(`no recipe wrapper for the plain value ${String(value)}`);
}

function temporalKind(nativeType) {
  const type = (nativeType ?? '').toLowerCase();
  if (/^(datetime|timestamp)/.test(type)) return 'datetime';
  if (type.startsWith('time')) return 'time';
  if (type.startsWith('date')) return 'date';
  if (/^(decimal|numeric)/.test(type)) return 'decimal';
  return null;
}

/** The recipe wrapper of a grid cell. */
function grid(cell) {
  switch (cell.kind) {
    case 'null': return { null: true };
    case 'integer': case 'unsigned': return { int: String(cell.value) };
    case 'decimal': case 'text': case 'date': case 'time': case 'datetime': return { [cell.kind]: cell.value };
    case 'boolean': return { bool: cell.value };
    case 'binary': return { bytes_hex: Buffer.from(cell.value).toString('hex') };
    default: throw new Error(`no recipe wrapper for the grid cell ${cell.kind}`);
  }
}

/** The fields of a mutation result: its rows, each cell wrapped by the native type of its column in the metadata. */
function mutation(metadata, result) {
  const types = result.columns.map(column => metadata.columns.find(c => c.name === column)?.nativeType ?? null);
  return { rows: result.rows.map(row => row.map((cell, at) => plain(cell, types[at]))) };
}

/** NULL compares by its nullness: an expect names the parameter type of NULL, and a result has none. */
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value === null || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && 'null' in value) return { null: true };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
}
