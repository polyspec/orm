// The recipe helper of TypeScript (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
// <recipe>-<database>.test.mjs, calls runRecipe with the recipe and the database, and each case of the recipe is one test
// whose steps call the public API of @polyspec/orm that each op names. It has no command line and no output of its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { Kind, Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { CORE, Db, OrmError, StyledValue, blindIndex, chainPlans, compareSchemas, connectCatalog, dbspecManifest, decode, diffPlan, effectText, emitPlan, encode, hostDecode, hostEncode, parseDbspec, parseDbspecSet, parsePlan, planSteps, readDbspecSet, registerModel } from '../dist/index.js';
import { connect } from '../dist/models/markdown_fixture/models.js';
import { connect as connectBind, Slots as BindSlots } from '../dist/models/bind_fixture/models.js';
import { decodeRequest, validate } from '../dist/engine/validate.js';
import { Engine } from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { modelOps } from './recipe_model.mjs';
import { classesFromModel } from './registered_models.mjs';
import { nativeQuery } from './coverage_case.mjs';
import { conformanceCases, normalize } from './markdown_cases.mjs';
import { listenMarkdownTestServer } from './markdown_test_listener.mjs';
import { caseTest, COMPUTE, DATABASE } from '../../../tests/testcase.mts';

// NONE is the database part of a recipe without a database (FCV-3).
export const NONE = 'none';

// runRecipe registers every case of the recipe at path, relative to the repository root, on database. A database other than
// none runs each case on a case database of its own (databaseRecipe), and the entry awaits the registration.
export function runRecipe(path, database) {
  if (database !== NONE) return databaseRecipe(path, database);
  const text = readFileSync(path, 'utf8');
  const recipe = JSON.parse(text);
  const literal = parseJson(text);
  // An ir.validate step checks its request against the schema of the recipe, which the recipe names relative to its own file.
  const schema = recipe.schema === undefined ? undefined : validationModel(resolve(root, dirname(path), recipe.schema));
  for (const [caseIndex, recipeCase] of recipe.cases.entries()) {
    caseTest(recipeCase.id, COMPUTE, async () => {
      const bound = new Map();
      for (const [index, step] of recipeCase.steps.entries()) {
        try {
          if (step.op === 'ir.validate') checkValidate(step, requestText(literal, caseIndex, index), schema, database);
          else if (step.op === 'planner.compile') checkPlanner(step, dirname(path), database);
          else if (dbspecOps.includes(step.op)) checkDbspec(step, bound, database);
          else if (step.op === 'ir.answer') await checkAnswer(step, database);
          else if (step.op === 'dsn.connect') await checkDsnConnect(step, database);
          else run(step, bound, database);
        } catch (error) {
          throw new Error(`recipe ${path} case ${recipeCase.id} step ${index} (${step.op}) on ${database}: ${error.message}`, { cause: error });
        }
      }
    });
  }
}

// connectDriver opens a DSN with Db.connect, closes it and returns its driver: the one implementation of dsn.connect (FCV-4).
async function connectDriver(dsn) {
  const db = await Db.connect(dsn);
  try {
    return db.driver;
  } finally {
    await db.close();
  }
}

// checkDsnConnect runs the dsn.connect op (FCV-4) on the DSN text of the step, and checks the refusal code or the driver of its expect.
async function checkDsnConnect(step, database) {
  const expect = step.expect?.[database];
  let driver;
  let code = '';
  try {
    driver = await connectDriver(step.dsn);
  } catch (error) {
    code = error?.code ?? '';
  }
  if (expect === undefined) {
    if (code !== '') throw new Error(`unexpected error ${code}`);
    return;
  }
  if (expect.error !== undefined) {
    if (code !== expect.error) throw new Error(`error ${code || 'none'}, want ${expect.error}`);
    return;
  }
  if (code !== '') throw new Error(`unexpected error ${code}`);
  if (!isDeepStrictEqual(expect.value, { text: driver })) throw new Error(`driver ${driver}, want ${JSON.stringify(expect.value)}`);
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

// holdsBytes is whether the recipe value is bytes or a list or a map that holds bytes at any depth.
const holdsBytes = raw => 'bytes_hex' in raw || (raw.array ?? []).some(holdsBytes) || (raw.object ?? []).some(([, item]) => holdsBytes(item));

// styledArgument is the styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage,
// so that its member order and number text are those of the recipe, and the common value model otherwise.
function styledArgument(raw, styles, bound) {
  if ('ref' in raw) {
    const value = reference(raw.ref, bound);
    return value instanceof StyledValue ? value : StyledValue.value(value);
  }
  if ('null' in raw) return StyledValue.sqlNull();
  // An ordered_json wrapper is the ordered-json value of its value, whatever the stages (FCV-4).
  if ('ordered_json' in raw) return StyledValue.value(parseJson(jsonText(raw.ordered_json)));
  // Bytes have no JSON text, so a value that holds bytes reaches an ordered_json stage as the value it is (COD-63).
  if (styles.includes('ordered_json') && !holdsBytes(raw)) return StyledValue.value(parseJson(jsonText(raw)));
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
  if ('int' in w) return BigInt(w.int);
  if ('float' in w) return Number(w.float);
  // Number reads NaN, Infinity and -Infinity, the three non-finite values of the f64 wrapper.
  if ('f64' in w) return Number(w.f64);
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
  if (typeof value === 'number') return { float: Object.is(value, -0) ? '-0.0' : String(value) };
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
// every other value by number value, an integer as a bigint and a float as a number, and with its object as a set of pairs
// (FCV-4).
function equal(got, want, ordered) {
  const kind = Object.keys(got)[0];
  if (kind !== Object.keys(want)[0]) return false;
  if (kind === 'int') return ordered ? got.int === want.int : BigInt(got.int) === BigInt(want.int);
  if (kind === 'float') return ordered ? got.float === want.float : Object.is(Number(got.float), Number(want.float));
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
  // A fixture of none runs every case on an empty case database; the helper never infers it (FCV-3).
  const { schema, installFirst } = recipe.fixture === NONE_FIXTURE
    ? { schema: undefined, installFirst: [] }
    : await fixtureSchema(resolve(root, recipe.fixture));
  for (const recipeCase of recipe.cases) {
    caseTest(recipeCase.id, DATABASE, ({ step }) =>
      withCaseDatabase(database, step, caseDatabase => runCase({ name, recipe, recipeCase, database, schema, installFirst, caseDatabase, step })));
  }
}

/**
 * The Schema of a dbspec-set.json through the public dbspec API (docs/spec/dbspec.md "External documents"): the owned
 * documents parsed with the external ones of the set, and the manifest of the owned documents with the external text.
 * Each external document is also a schema of its own, which a case installs first, as the bench set does.
 */
async function fixtureSchema(setPath) {
  const set = readDbspecSet(setPath);
  if (set.documents === null) throw new Error(`${setPath}: ${JSON.stringify(set.errors)}`);
  const text = file => new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  const owned = set.documents.map(text);
  const external = set.external.map(text);
  const manifestOf = (owners, externals) => {
    const documents = parseDbspecSet(owners, externals).map(parsed => {
      if (parsed.document === null || parsed.diagnostics.length > 0) throw new Error(`${setPath}: ${parsed.name}: ${JSON.stringify(parsed.diagnostics)}`);
      return parsed.document;
    });
    const { manifest, diagnostics } = dbspecManifest(documents);
    if (manifest === null) throw new Error(`${setPath}: ${JSON.stringify(diagnostics)}`);
    return manifest;
  };
  const manifest = manifestOf(owned, external);
  const installFirst = external.map(each => {
    const shared = manifestOf([each], []);
    return { manifestText: shared.manifestText, manifestHash: shared.manifestHash };
  });
  return { schema: { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash, externalText: manifest.externalText }, installFirst };
}

const NONE_FIXTURE = 'none';

async function runCase({ name, recipe, recipeCase, database, schema, installFirst, caseDatabase, step }) {
  const db = await Db.connect(caseDatabase.dsn);
  try {
    // A case with install: false gets no fixture here; its steps install it (FCV-4, schema.install).
    if (schema !== undefined && recipeCase.install !== false) {
      for (const shared of [...installFirst, schema]) await db.utils().schema().install(shared);
      step('schema installed');
    }
    await runCaseOn({ name, recipe, recipeCase, database, schema, caseDatabase, step, db });
  } finally {
    await db.close();
  }
}

async function runCaseOn({ name, recipe, recipeCase, database, schema, caseDatabase, step, db }) {
  const closers = [];
  const catalog = await connectCatalog(caseDatabase.dsn);
  try {
    const namespace = await catalog.currentNamespace();
    const bound = new Map([['database', { text: caseDatabase.name }]]);
    const classes = schema === undefined ? {} : classesFromModel(registerModel(schema.manifestText, schema.manifestHash, schema.externalText));
    const context = { catalog, namespace, database, dsn: caseDatabase.dsn, bound, rowPaths: new Map(), db, schema, classes, dir: dirname(resolve(root, name)), closers };
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
    for (const close of closers) await close();
    await catalog.close();
  }
}

// Each op maps to one call of the public API and returns the fields that its expect compares.
const MODEL_OPS = modelOps({ native, databaseValue, stepArgument });

/** The error that a failing transaction callback throws (FCV-4: expect CALLBACK). */
const callbackError = new Error('the transaction callback failed');

/** The model of table, connected to db, of the classes that the registered fixture declares. */
function modelOf(table, db, { classes }) {
  if (classes[table] === undefined) throw new Error(`the fixture declares no table ${table}`);
  return new classes[table]().connect(db);
}

/** Records one statement event as a recipe object (FCV-4): transactions are numbered from 1 in order of appearance. */
function recordEvent(subscription, event) {
  if (!(typeof event.elapsed === 'number' && event.elapsed >= 0)) subscription.negative = true;
  let transaction = null;
  if (event.transaction !== null) {
    if (!subscription.numbers.has(event.transaction)) subscription.numbers.set(event.transaction, subscription.numbers.size + 1);
    transaction = subscription.numbers.get(event.transaction);
  }
  subscription.records.push({
    sql: event.sql, binds: event.binds, kind: event.kind, tables: [...event.tables], transaction,
    error: event.error === null ? null : event.error.code,
  });
}

/** The recipe object of a recorded event, with the six fields of FCV-4 in order; the elapsed time is not compared. */
function eventObject(record) {
  return { object: [
    ['sql', { text: record.sql }],
    ['binds', { array: record.binds.map(bindWrapper) }],
    ['kind', { text: record.kind }],
    ['tables', { array: record.tables.map(name => ({ text: name })) }],
    ['transaction', record.transaction === null ? { null: true } : { int: String(record.transaction) }],
    ['error', record.error === null ? { null: true } : { text: record.error }],
  ] };
}

/** The recipe wrapper of a bind value (the values of the statement_events fixture: text, int and null). */
function bindWrapper(value) {
  if (value === null) return { null: true };
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) return { int: String(value) };
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'boolean') return { bool: value };
  throw new Error(`no recipe wrapper for the bind ${JSON.stringify(value)}`);
}

// Each op maps to one call of the public API and returns the fields that its expect compares.
const TABLE_MODELS = { EventProbe: 'event_probe' };

/** The bound value that a field names: a plain name, or the {"ref": name} of an argument (FCV-4). */
const refOf = (field, { bound: values }) => {
  const name = typeof field === 'string' ? field : field.ref;
  if (!values.has(name)) throw new Error(`no bound value ${name}`);
  return values.get(name);
};
/** The connection that an op names, or the case connection when the op has none. */
const connectionOf = (s, context) => (s.connection === undefined ? context.db : refOf(s.connection, context));
/**
 * The path of a model step, "table" or "generated" (coordinator ruling on row routing). A step with `row` names no model and
 * no connection: it is routed by the bound row, which records the path that made it; a row that no bound row holds fails by
 * name. Any other step is routed by its model.
 */
const routeOf = (s, context) => {
  if (s.row === undefined) return TABLE_MODELS[s.model] === undefined ? 'generated' : 'table';
  const name = typeof s.row === 'string' ? s.row : s.row.ref;
  if (!context.rowPaths.has(name)) throw new Error(`${s.op} names row ${name}, which no bound row holds`);
  return context.rowPaths.get(name);
};

const OPS = {
  // dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step.
  async 'dsn.connect'(s, context) {
    return { value: { text: await connectDriver(s.dsn === 'case' ? context.dsn : s.dsn) } };
  },
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
  const op = OPS[s.op] ?? MODEL_OPS[s.op];
  if (op === undefined) throw new Error(`OP_UNKNOWN ${s.op}`);
  const expected = s.expect === undefined ? undefined : resolveRefs(s.expect[context.database], context);
  let actual;
  try {
    actual = await op(s, context);
  } catch (error) {
    const code = error === callbackError ? 'CALLBACK' : error?.code;
    if (expected?.error === undefined || typeof code !== 'string') throw error;
    assert.equal(code, expected.error, `the error code (${error.message})`);
    return;
  }
  if (s.as !== undefined) {
    context.bound.set(s.as, actual.bind ?? actual.value);
    // A model op that binds a row records the path that made it, so that a later {row} step routes to it.
    if (actual.bind !== undefined && s.op.startsWith('model.')) context.rowPaths.set(s.as, routeOf(s, context));
  }
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

// validationModel registers the schema manifest that the ir.validate steps check their requests against.
function validationModel(schemaPath) {
  const validated = dbspecManifest([parseDbspec(readFileSync(schemaPath, 'utf8'), {}).document]).manifest;
  return { model: registerModel(validated.manifestText, validated.manifestHash), hash: validated.manifestHash };
}

// requestText is the request of the step as its ordered-json text, so a number keeps its literal (0.0 is not 0).
function requestText(literal, caseIndex, stepIndex) {
  return stringifyJson(literal.get('cases').items[caseIndex].get('steps').items[stepIndex].get('request'));
}

// checkValidate gives the request of an ir.validate step to the validator, with the manifest_hash of its schema added, and checks
// the outcome of the expect of database: {value: {bool: true}} for an accepted request, {error: CODE} for a request that fails with CODE.
function checkValidate(step, text, schema, database) {
  if (schema === undefined) throw new Error('ir.validate needs the schema key of the recipe');
  let got = null;
  try {
    const request = decodeRequest(text);
    if ('manifest_hash' in request) throw new Error('request already holds manifest_hash');
    validate(schema.model, { ...request, manifest_hash: schema.hash });
  } catch (error) {
    got = error.code ?? String(error);
  }
  const outcome = step.expect[database];
  if (outcome === undefined) throw new Error(`ir.validate has no expect for ${database}`);
  if (outcome.error !== undefined) {
    if (got !== outcome.error) throw new Error(`got ${got ?? 'valid'}, want ${outcome.error}`);
    return;
  }
  if (JSON.stringify(outcome.value) !== '{"bool":true}') throw new Error(`ir.validate expects {bool true} or an error, got ${JSON.stringify(outcome.value)}`);
  if (got !== null) throw new Error(`got ${got}, want valid`);
}

// plannerDialects are the dialects that a planner.compile step compiles its request for, in the order of the planner fixture.
const plannerDialects = ['mysql', 'postgres', 'sqlite'];

// plannerSlot is the source and type of one bind slot in the form of the planner fixture: the request value number of a param
// slot, the key types of a parent slot, and the fraction digits, varchar length and not-null flag where the fixture writes them.
function plannerSlot(slot) {
  if (slot.from === 'parent') return { from: slot.from, key_types: slot.key_types };
  const out = slot.from === 'param' ? { from: slot.from, param: slot.param, type: slot.col_type } : { from: slot.from, type: slot.col_type };
  if (slot.col_type === 'datetime' || slot.col_type === 'time') out.precision = slot.precision ?? 0;
  if (slot.from === 'param' && slot.col_type === 'varchar') out.length = slot.length ?? 0;
  if (slot.not_null === true) out.not_null = true;
  return out;
}

// checkPlanner compiles the request of a planner.compile step with the client engine of each dialect, against the manifest of
// the schema that the step names relative to the recipe file, and checks the plans with the expect of database: {value: {mysql,
// postgres, sqlite}} with the statements of each dialect, or {error: CODE}, which every dialect must reject with.
function checkPlanner(step, recipeDir, database) {
  if (database !== NONE) throw new Error('planner.compile runs without a database');
  if (typeof step.schema !== 'string') throw new Error('planner.compile needs a schema');
  const { model, hash } = validationModel(resolve(root, recipeDir, step.schema));
  const request = { ...structuredClone(step.input), manifest_hash: hash };
  const outcome = step.expect[database];
  if (outcome === undefined) throw new Error(`planner.compile has no expect for ${database}`);
  if (outcome.error !== undefined) {
    for (const dialect of plannerDialects) {
      let code = null;
      try { new Engine(model, dialect).compile(request); } catch (error) { code = error.code ?? String(error); }
      if (code !== outcome.error) throw new Error(`${dialect}: got ${code ?? 'a plan'}, want ${outcome.error}`);
    }
    return;
  }
  const got = {};
  for (const dialect of plannerDialects) {
    const plan = new Engine(model, dialect).compile(request);
    got[dialect] = plan.steps.map(planStep => ({ role: planStep.role, sql: planStep.sql, slots: planStep.bind_slots.map(plannerSlot), tables: planStep.tables }));
  }
  const actual = JSON.parse(JSON.stringify(got));
  if (!isDeepStrictEqual(actual, outcome.value)) throw new Error(`planner.compile: got ${JSON.stringify(actual)}, want ${JSON.stringify(outcome.value)}`);
}

// dbspecOps are the ops of the schema and plan calls (FCV-4), which checkDbspec runs without a database.
const dbspecOps = ['dbspec.parse', 'dbspec.parse_plan', 'dbspec.emit_plan', 'dbspec.diff', 'dbspec.plan_steps', 'dbspec.chain', 'dbspec.compare'];

// checkDbspec runs one dbspec op through the public call that FCV-4 names, binds the result of its as for a later ref, and checks
// what the call returned, as JSON, with the expect of database. A null source is the empty schema of diffPlan.
function checkDbspec(step, bound, database) {
  if (database !== NONE) throw new Error(`${step.op} runs without a database`);
  const want = step.expect?.[database];
  if (want === undefined) throw new Error(`${step.op} has no expect for ${database}`);
  let got;
  switch (step.op) {
    case 'dbspec.parse':
    case 'dbspec.parse_plan':
      got = dbspecParse(step, bound);
      break;
    case 'dbspec.emit_plan':
      got = { text: emitPlan(dbspecPlan(step.plan, bound)) };
      break;
    case 'dbspec.diff':
      got = dbspecDiff(step, bound);
      break;
    case 'dbspec.plan_steps':
      got = dbspecPlanSteps(step, bound);
      break;
    case 'dbspec.chain':
      got = dbspecChain(step, bound);
      break;
    case 'dbspec.compare':
      got = dbspecCompare(step, bound);
      break;
  }
  const actual = JSON.parse(JSON.stringify(got));
  if (!isDeepStrictEqual(actual, want)) throw new Error(`${step.op}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
}

// dbspecParse runs parseDbspec (dbspec.parse) or parsePlan (dbspec.parse_plan) on the lines of step, and returns {diagnostics}.
function dbspecParse(step, bound) {
  const text = step.lines.join('\n') + '\n';
  const result = step.op === 'dbspec.parse' ? parseDbspec(text, {}) : parsePlan(text);
  const value = step.op === 'dbspec.parse' ? result.document : result.plan;
  if (step.as !== undefined) bound.set(step.as, { dbspec: value });
  return { diagnostics: parseRows(result.diagnostics, false) };
}

// dbspecPlanSteps runs planSteps for one dialect and returns {steps}, the plans.json objects of its steps, or fails on diagnostics.
function dbspecPlanSteps(step, bound) {
  const result = planSteps(dbspecDocument(step.source, bound), dbspecPlan(step.plan, bound), step.dialect);
  if (result.diagnostics.length > 0) throw new Error(`plan steps: ${result.diagnostics.map(d => d.message).join('; ')}`);
  return { steps: result.steps.map(stepFields) };
}

// stepFields is the object of one step as docs/spec/plans.md "Steps" writes it.
function stepFields(s) {
  const out = { statement: s.statement, effect: effectText(s.effect) };
  if (s.rollback !== '') out.rollback = s.rollback;
  else if (s.irreversible !== '') out.irreversible = s.irreversible;
  if (s.restore !== '') out.restore = s.restore;
  if (s.rollbackRestore !== '') out.rollback_restore = s.rollbackRestore;
  if (s.restore !== '' || s.rollbackRestore !== '') out.restore_if = effectText(s.restoreIf);
  if (s.nullChecks.length > 0) out.null_checks = s.nullChecks.map(c => [c.table, c.column, c.default]);
  if (s.finalize) out.finalize = true;
  return out;
}

// dbspecDiff runs diffPlan and returns {changes} or, with diagnostics, {messages} of rule plan.
function dbspecDiff(step, bound) {
  const result = diffPlan(dbspecDocument(step.source, bound), dbspecPlan(step.plan, bound));
  if (result.diagnostics.length > 0) return { messages: messagesOf(result.diagnostics, 'plan') };
  return { changes: (result.changes ?? []).map(c => [c.kind, c.table, c.name]) };
}

// dbspecChain runs chainPlans and returns {order} with the plan names or, with diagnostics, {messages} of rule chain.
function dbspecChain(step, bound) {
  const result = chainPlans(step.plans.map(raw => dbspecPlan(raw, bound)));
  if (result.diagnostics.length > 0) return { messages: messagesOf(result.diagnostics, 'chain') };
  return { order: (result.plans ?? []).map(p => p.name) };
}

// dbspecCompare runs compareSchemas and returns {differences, diagnostics}, whose diagnostics carry their message for every rule.
function dbspecCompare(step, bound) {
  const result = compareSchemas(dbspecDocument(step.source, bound), dbspecDocument(step.target, bound));
  return { differences: (result.differences ?? []).map(d => [d.kind, d.table, d.name]), diagnostics: parseRows(result.diagnostics, true) };
}

// parseRows are the diagnostics as [rule, line, column, message]: the message is that of rule plan only, unless all is set.
function parseRows(diagnostics, all) {
  return diagnostics.map(d => [d.rule, d.line, d.column, all || d.rule === 'plan' ? d.message : null]);
}

// messagesOf returns the messages of the diagnostics, and fails on a diagnostic of another rule than rule.
function messagesOf(diagnostics, rule) {
  for (const d of diagnostics) if (d.rule !== rule) throw new Error(`diagnostic of rule ${d.rule}, want ${rule}: ${d.message}`);
  return diagnostics.map(d => d.message);
}

// dbspecValue is the result that the ref of raw binds by an earlier dbspec step, and fails when raw is no ref or names none.
function dbspecValue(raw, bound) {
  if (raw === undefined || raw === null || typeof raw.ref !== 'string') throw new Error(`${JSON.stringify(raw)} is not a ref`);
  const result = bound.get(raw.ref);
  if (result === undefined || !('dbspec' in result)) throw new Error(`ref ${raw.ref} names no bound result`);
  return result.dbspec;
}

// dbspecDocument is the document that source or target names, or null for the empty schema when the field is null.
function dbspecDocument(raw, bound) {
  if (raw === null) return null;
  const value = dbspecValue(raw, bound);
  if (value === null) throw new Error(`${raw.ref} binds no document`);
  return value;
}

// dbspecPlan is the plan that the ref of raw names.
function dbspecPlan(raw, bound) {
  const value = dbspecValue(raw, bound);
  if (value === null) throw new Error(`${raw.ref} binds no plan`);
  return value;
}

// startMarkdownTestServerWithKeyedAnswers is a listener that answers connect with {"ok":true} and every later message with the answer of answers keyed
// by the op of a control message or the kind of a request; a message without an answer is IR_INVALID.
async function startMarkdownTestServerWithKeyedAnswers(answers) {
  const server = createServer(socket => {
    let first = true;
    createInterface({ input: socket }).on('line', line => {
      if (first) {
        first = false;
        socket.write('{"ok":true}\n');
        return;
      }
      let key = 'unreadable';
      try {
        const message = JSON.parse(line);
        key = message.op ?? message.request?.kind ?? key;
      } catch (error) {
        // An unreadable line keeps the key 'unreadable'; any other error is a defect and is thrown.
        if (!(error instanceof SyntaxError)) throw error;
      }
      const answer = Object.hasOwn(answers, key) ? answers[key] : { error: { code: 'IR_INVALID', message: `the case has no answer for ${key}` } };
      socket.write(`${JSON.stringify(answer)}\n`);
    });
    socket.on('error', () => {});
  });
  return listenMarkdownTestServer(server);
}

// startMarkdownTestServerWithAnswer is a listener that answers connect with {"ok":true} and the one later request with answer.
// The request line is added to sent (PRT-66), so that a params expect reads the request the chain sends.
async function startMarkdownTestServerWithAnswer(answer, sent) {
  const server = createServer(socket => {
    const replies = ['{"ok":true}', answer];
    createInterface({ input: socket }).on('line', line => {
      if (replies.length === 1) sent.push(line);
      if (replies.length > 0) socket.write(`${replies.shift()}\n`);
    });
    socket.on('error', () => {});
  });
  return listenMarkdownTestServer(server);
}

// requestParams returns the params of the request message that a listener received, in the JSON form of PRT-67 (PRT-66).
function requestParams(sent) {
  for (const line of sent) {
    const message = JSON.parse(line);
    if (message.request !== undefined) return message.params ?? [];
  }
  throw new Error('the listener received no request message');
}

// bindSlotChain is the chain of a bind step (T334-3-15-3c, PRT-67): it writes the bind value into the slot column of the bind_fixture
// model through its setter and sends the insert, so the request carries the wire value of the slot.
function bindSlotChain(bind) {
  const prefix = bind.column.slice(0, bind.column.indexOf('_'));
  const setter = `set${prefix[0].toUpperCase()}${prefix.slice(1)}Value`;
  return async ({ db }) => {
    const row = new BindSlots().connect(db);
    row[setter](bind.value);
    await row.create();
    return null;
  };
}

// checkAnswer runs the chain of an ir.answer step on a connection to a listener that answers with the answer or answers of the step,
// normalizes its result, and compares it with the value of the expect of database. An OrmError from the chain is {error: CODE}.
// An expect of {params} compares the params of the request that the listener received instead (PRT-66).
async function checkAnswer(step, database) {
  const expect = step.expect?.[database];
  if (expect === undefined) throw new Error(`ir.answer has no expect for ${database}`);
  if (expect.value === undefined && expect.params === undefined) throw new Error(`ir.answer expect for ${database} has neither value nor params`);
  if (step.bind !== undefined && step.chain !== 'slot') throw new Error(`a bind step names the chain slot, not ${step.chain}`);
  const chain = step.bind !== undefined ? bindSlotChain(step.bind) : conformanceCases[step.chain];
  if (chain === undefined) throw new Error(`chain ${step.chain} is no markdown conformance case`);
  if (expect.params !== undefined && step.answers !== undefined) throw new Error('a params expect needs one answer, not answers');
  const sent = [];
  const server = step.answers !== undefined ? await startMarkdownTestServerWithKeyedAnswers(step.answers) : await startMarkdownTestServerWithAnswer(JSON.stringify(step.answer), sent);
  const db = await (step.bind !== undefined ? connectBind : connect)(server.dsn);
  let got;
  let failed = false;
  try {
    got = normalize(await chain({ db }));
  } catch (error) {
    if (!(error instanceof OrmError)) throw new Error(`${step.chain} failed without an orm code: ${error?.stack ?? error}`, { cause: error });
    got = { error: error.code };
    failed = true;
  } finally {
    await db.close();
    await server.close();
  }
  if (expect.params !== undefined && !failed) got = requestParams(sent);
  const want = expect.params ?? expect.value;
  if (!isDeepStrictEqual(got, want)) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// Schema installation (FCV-4). A schema argument is the document set of its files, read from the recipe's directory, parsed
// with its external documents through the public dbspec API and built into a manifest; manifest_replace changes the manifest
// text after building and keeps its hash, so that the text no longer hashes to it.
async function schemaArgument(arg, context) {
  const read = names => Promise.all(names.map(name => readFile(resolve(context.dir, name), 'utf8')));
  const set = parseDbspecSet(await read(arg.documents), await read(arg.external ?? []));
  const diagnostics = set.flatMap(entry => entry.diagnostics);
  if (diagnostics.length > 0) throw new Error(`schema: ${JSON.stringify(diagnostics)}`);
  const built = dbspecManifest(set.map(entry => entry.document));
  if (built.manifest === null) throw new Error(`schema: ${JSON.stringify(built.diagnostics)}`);
  let manifestText = built.manifest.manifestText;
  if (arg.manifest_replace !== undefined) manifestText = manifestText.replaceAll(arg.manifest_replace.from, arg.manifest_replace.to);
  return { manifestText, manifestHash: built.manifest.manifestHash, externalText: built.manifest.externalText };
}

// okValue is the value of an op that returns without error (FCV-4).
const okValue = { value: { bool: true } };

// runNested runs the nested steps of statements.count or transaction, each with its own expect, through the same runStep (FCV-4).
async function runNested(steps, context) {
  for (const nested of steps) await runStep(nested, context);
}

Object.assign(OPS, {
  async 'schema.install'(s, context) {
    if (s.connection !== undefined) {
      await connectionOf(s, context).utils().schema().install(context.schema);
      return okValue;
    }
    await context.db.utils().schema().install(await schemaArgument(s.schema, context));
    return okValue;
  },
  async 'schema.register'(s, context) {
    context.db.utils().schema().register(await schemaArgument(s.schema, context));
    return okValue;
  },
  async 'schema.connect'(s, context) {
    const connected = await Db.connectSchema(context.dsn, await schemaArgument(s.schema, context));
    await connected.close();
    return okValue;
  },
  async 'schema.add_tables_and_columns'(s, context) {
    const added = await context.db.utils().schema().addTablesAndColumns(await schemaArgument(s.schema, context));
    return { value: { array: added.map(text => ({ text })) } };
  },
  async 'statements.count'(s, context) {
    let count = 0;
    const unsubscribe = context.db.subscribe(() => { count += 1; });
    try {
      await runNested(s.steps, context);
    } finally {
      unsubscribe();
    }
    return { count };
  },
  async transaction(s, context) {
    await connectionOf(s, context).transaction(async () => {
      await runNested(s.steps, context);
      if (s.fail) throw callbackError;
    }, { retry: 0 });
    return okValue;
  },
});

/** The table-model ops of the statement-event fixture (FCV-4 model ops on a table model, with no generated model). */
const TABLE_OPS = {
  async 'model.create'(s, context) {
    const m = modelOf(TABLE_MODELS[s.model], connectionOf(s, context), context);
    for (const a of assignments(s.values, context)) m[CORE].setValue(a.name, a.value);
    await m.create();
    return { bind: m };
  },
  async 'model.get_by'(s, context) {
    if (s.key !== undefined) throw new Error('model.get_by with key has no table-model path');
    const m = modelOf(TABLE_MODELS[s.model], connectionOf(s, context), context);
    whereAll(m, assignments(s.where, context));
    return { bind: await m.get() };
  },
  async 'model.update'(s, context) {
    const row = refOf(s.row, context);
    for (const a of assignments(s.set, context)) row[CORE].setValue(a.name, a.value);
    await row.update();
    return {};
  },
  async 'model.delete'(s, context) {
    await refOf(s.row, context).delete();
    return {};
  },
  async 'model.count'(s, context) {
    const m = modelOf(TABLE_MODELS[s.model], connectionOf(s, context), context);
    if (s.where !== undefined) whereAll(m, assignments(s.where, context));
    return { value: { int: String(await m.getCount()) } };
  },
};

/** Narrows a table-model chain by the equalities of where, joined by and in column order. */
function whereAll(m, where) {
  if (where.length === 0) return;
  m[CORE].whereChain('', where.map((a, i) => ({ conn: i === 0 ? '' : 'and', op: '', column: a.name, columns: [], compare: '' })), where.map(a => a.value));
}

// The shared model op names dispatch on the model: a table model takes TABLE_OPS, every other model MODEL_OPS (FCV-4).
for (const op of Object.keys(TABLE_OPS)) {
  OPS[op] = async (s, context) => {
    const path = routeOf(s, context);
    if (path === 'table') return TABLE_OPS[op](s, context);
    if (s.row !== undefined) throw new Error(`${op} with row: row ${s.row.ref ?? s.row} was bound by the generated path, which has no row form`);
    return MODEL_OPS[op](s, context);
  };
}

Object.assign(OPS, {
  async 'events.subscribe'(s, context) {
    const subscription = { records: [], numbers: new Map(), negative: false, stop: undefined };
    subscription.stop = connectionOf(s, context).subscribe(event => recordEvent(subscription, event));
    return { bind: subscription };
  },
  async 'events.fail_subscriber'(s, context) {
    const stop = connectionOf(s, context).subscribe(event => {
      if (event.kind === s.kind) throw new Error('subscriber refused the event');
    });
    return { bind: { stop } };
  },
  async 'events.stop_failing'(s, context) {
    refOf(s.ref, context).stop();
    return {};
  },
  async 'events.unsubscribe'(s, context) {
    refOf(s.ref, context).stop();
    return {};
  },
  async 'events.captured'(s, context) {
    const subscription = refOf(s.ref, context);
    if (subscription.negative) throw new Error('an event has a negative elapsed time');
    const records = s.compare === 'tables' ? subscription.records.filter(r => r.tables.length > 0) : subscription.records;
    return { value: { array: records.map(eventObject) } };
  },
});
