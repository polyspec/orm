// The recipe helper of TypeScript (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
// <recipe>-<database>.test.mjs, calls runRecipe with the recipe and the database, and each case of the recipe is one test
// whose steps call the public API of @polyspec/orm that each op names. It has no command line and no output of its own.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { Kind, Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { AesKeyring, BindCell, CORE, Db, OrmError, StyledValue, blindIndex, chainPlans, compareSchemas, connect as connectModel, connectCatalog, dbspecManifest, decode, diffPlan, effectText, emitDbspec, emitPlan, encode, hostDecode, hostEncode, parseDbspec, parseDbspecSet, parsePlan, planSteps, readDbspecFile, readDbspecSet, registerModel, renderDbspec } from '../dist/index.js';
import { analyzeDbspec, formatDbspec, parseDbspecSet as parseDbspecSetBrowser, readDbspecBytes } from '../dist/dbspec/entry.js';
import { exportMermaid, importMermaid } from '../dist/dbspec/index.js';
import { connect } from '../dist/models/markdown_fixture/models.js';
import { Slots, connect as connectSlots } from '../dist/models/bind_fixture/models.js';
import { decodeRequest, validate } from '../dist/engine/validate.js';
import { Engine } from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { checkKeys } from './recipe_keys.mjs';
import { modelOps } from './recipe_model.mjs';
import { classesFromModel } from './registered_models.mjs';
import { nativeQuery, within } from './coverage_case.mjs';
import { conformanceCases, normalize } from './markdown_cases.mjs';
import { listenMarkdownTestServer } from './markdown_test_listener.mjs';
import { caseTest, COMPUTE, DATABASE } from '../../../tests/testcase.mts';

// NONE is the database part of a recipe without a database (FCV-3).
export const NONE = 'none';

// registerRecipeCase registers one case of a recipe with node:test.
function registerRecipeCase(recipeCase, deadline, body) {
  return caseTest(recipeCase.id, deadline, body);
}

// runRecipe registers every case of the recipe at path, relative to the repository root, on database. A database other than
// none runs each case on a case database of its own (databaseRecipe), and the entry awaits the registration.
export function runRecipe(path, database) {
  if (database !== NONE) return databaseRecipe(path, database);
  const text = readFileSync(path, 'utf8');
  checkKeys(path, text);
  const recipe = JSON.parse(text);
  const literal = parseJson(text);
  // The recipe as wrappers, so that an expect's integers are compared by their digits (not by a JavaScript number).
  const wrapped = fromJson(literal);
  // An ir.validate step checks its request against the schema of the recipe, which the recipe names relative to its own file.
  const schema = recipe.schema === undefined ? undefined : validationModel(resolve(root, dirname(path), recipe.schema));
  const dir = resolve(root, dirname(path));
  for (const [caseIndex, recipeCase] of recipe.cases.entries()) {
    registerRecipeCase(recipeCase, COMPUTE, async () => {
      const bound = new Map();
      for (const [index, step] of recipeCase.steps.entries()) {
        try {
          if (step.op === 'ir.validate') checkValidate(step, requestText(literal, caseIndex, index), schema, database);
          else if (step.op === 'planner.compile') checkPlanner(step, dirname(path), database);
          else if (dbspecOps.includes(step.op)) checkDbspec(step, bound, database);
          else if (step.op === 'ir.answer') await checkAnswer(step, database);
          else if (step.op === 'dsn.connect') await checkDsnConnect(step, database);
          else if (dbspecFileOps.includes(step.op)) await checkDbspecFiles(step, dir, database);
          else if (mermaidOps.includes(step.op)) checkMermaid(step, mermaidStep(step, bound, dir), database);
          else if (step.op === 'markdown.send') await withProcessZone(step.process_zone, () => checkSend(step, member(member(member(wrapped, 'cases').array[caseIndex], 'steps').array[index], 'expect')));
          else if (step.op === 'model.assign') await checkAssign(step, member(member(member(wrapped, 'cases').array[caseIndex], 'steps').array[index], 'expect'));
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

// The Mermaid ops (FCV-4), on the public Mermaid calls of the dbspec entry (DBS-169).
const mermaidOps = ['dbspec.export_mermaid', 'dbspec.import_mermaid'];

// mermaidStep runs the dbspec.export_mermaid or dbspec.import_mermaid op of step (FCV-4) on the public Mermaid calls (DBS-169)
// and returns its plain JSON result, as the Go helper does (packages/go/internal/recipe/mermaid.go). dir is the directory of the
// recipe, which the document and skeleton_of fields are relative to. A step with as binds the result, so a ref reads its fields.
function mermaidStep(step, bound, dir) {
  const got = step.op === 'dbspec.export_mermaid' ? exportStep(step, dir) : importStep(step, bound, dir);
  if (step.as !== undefined) bound.set(step.as, { decoded: false, value: got });
  return got;
}

// exportStep exports the inline text with the other documents of its set, or the .dbs file document (FCV-4).
function exportStep(step, dir) {
  let { text: source, set } = step.text === undefined ? { text: '', set: {} } : inlineDocument(step);
  if (step.document !== undefined) {
    const read = readDbspecFile(resolve(dir, step.document));
    if (read.diagnostics.length > 0) throw new Error(`read ${step.document}: ${JSON.stringify(read.diagnostics)}`);
    [source, set] = [read.text, {}];
  }
  const parsed = parseDbspec(source, set);
  if (parsed.diagnostics.length > 0) throw new Error(`parse: ${JSON.stringify(parsed.diagnostics)}`);
  const { mermaid, dropped } = exportMermaid(parsed.document);
  return { mermaid, dropped: dropsOf(dropped) };
}

function importStep(step, bound, dir) {
  const text = typeof step.mermaid === 'string' ? step.mermaid : mermaidReference(step.mermaid, bound);
  const imported = importMermaid(text, step.name);
  if (imported.diagnostics.length > 0) {
    return { errors: imported.diagnostics.map(d => [d.rule, d.line, d.column]) };
  }
  if (step.skeleton_of === undefined) {
    return { document: emitDbspec(imported.document), dropped: dropsOf(imported.dropped) };
  }
  const read = readDbspecFile(resolve(dir, step.skeleton_of));
  if (read.diagnostics.length > 0) throw new Error(`read ${step.skeleton_of}: ${JSON.stringify(read.diagnostics)}`);
  const original = parseDbspec(read.text, {});
  if (original.diagnostics.length > 0) throw new Error(`parse ${step.skeleton_of}: ${JSON.stringify(original.diagnostics)}`);
  const same = isDeepStrictEqual(mermaidSkeleton(original.document), mermaidSkeleton(imported.document));
  return { dropped: dropsOf(imported.dropped), same_skeleton: same };
}

// mermaidReference reads the text of a ref, {ref: "<name>.<field>"}, of a bound plain result.
function mermaidReference(raw, bound) {
  const [name, field] = String(raw.ref ?? '').split('.');
  if (!bound.has(name)) throw new Error(`ref ${raw.ref} names no bound result`);
  const value = bound.get(name).value?.[field];
  if (typeof value !== 'string') throw new Error(`ref ${raw.ref} is not a text`);
  return value;
}

function dropsOf(dropped) {
  return dropped.map(u => [u.kind, u.table, u.name]);
}

// mermaidSkeleton writes the tables, columns, primary keys and foreign keys that Mermaid carries, in table-name order; foreign
// key actions are left out, since Mermaid does not carry them.
function mermaidSkeleton(document) {
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const out = [];
  for (const t of [...document.tables].sort(byName)) {
    out.push(`table ${t.name}`);
    for (const c of t.columns) {
      const dflt = c.default === null ? '-' : c.default.kind === 'now' ? 'now' : c.default.text;
      out.push(`column ${c.name} ${JSON.stringify(c.type)} null=${c.nullable} identity=${c.identity} default=${dflt}`);
    }
    out.push(`primary key ${t.primaryKey.columns.join(', ')}`);
    for (const f of [...t.foreignKeys].sort(byName)) {
      out.push(`foreign key ${f.name} (${f.columns.join(', ')}) references ${f.table} (${f.references.join(', ')})`);
    }
  }
  return out;
}

// checkMermaid compares the keys of the expect of database that step names with the plain result, as JSON values.
function checkMermaid(step, got, database) {
  const expect = step.expect?.[database];
  if (expect === undefined) throw new Error(`${step.op} has no expect for ${database}`);
  const actual = JSON.parse(JSON.stringify(got));
  for (const [key, want] of Object.entries(expect.value)) {
    if (!(key in actual)) throw new Error(`the result has no ${key}: ${JSON.stringify(actual)}`);
    if (!isDeepStrictEqual(actual[key], want)) throw new Error(`${key}: got ${JSON.stringify(actual[key])}, want ${JSON.stringify(want)}`);
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
  const text = await readFile(resolve(root, path), 'utf8');
  checkKeys(path, text);
  const recipe = JSON.parse(text);
  const name = path;
  if (recipe.fixture === undefined) throw new Error(`recipe ${name}: no fixture, so it has no database`);
  // A fixture of none runs every case on an empty case database; the helper never infers it (FCV-3).
  const { schema, installFirst } = recipe.fixture === NONE_FIXTURE
    ? { schema: undefined, installFirst: [] }
    : await fixtureSchema(resolve(root, recipe.fixture));
  for (const recipeCase of recipe.cases) {
    if (recipeCase.only !== undefined && !recipeCase.only.includes(database)) continue;
    registerRecipeCase(recipeCase, DATABASE, ({ step }) =>
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
  let context;
  try {
    const namespace = await catalog.currentNamespace();
    const bound = new Map([['database', { text: caseDatabase.name }]]);
    const classes = schema === undefined ? {} : classesFromModel(registerModel(schema.manifestText, schema.manifestHash, schema.externalText));
    context = { catalog, namespace, database, dsn: caseDatabase.dsn, bound, rowPaths: new Map(), db, schema, classes, dir: dirname(resolve(root, name)), closers, closed: false, records: [], hookBases: new Map(), fields: new Map() };
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
    if (context === undefined) await catalog.close();
    else if (!context.closed) await context.catalog.close();
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
const TABLE_MODELS = {
  EventProbe: 'event_probe', HookItem: 'hook_item', HookEntry: 'hook_entry', HookUpsert: 'hook_upsert', RotRow: 'rot_row',
  ChunkAuthor: 'chunk_author',
};

/** The table of a table model, or a failure that names the model. */
function tableOf(model) {
  if (TABLE_MODELS[model] === undefined) throw new Error(`model ${model} has no table entry`);
  return TABLE_MODELS[model];
}

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
  async 'catalog.connect'(s) {
    if (s.dsn.url !== undefined) {
      const connection = await connectCatalog(s.dsn.url).then(catalog => ({ catalog }), error => ({ error }));
      if (connection.catalog !== undefined) await connection.catalog.close();
      return { error: connection.error?.code };
    }
    // A DSN of a SQLite file that the case does not create: the connection fails, and the file must not exist afterwards.
    const directory = mkdtempSync(join(tmpdir(), 'orm-recipe-absent-'));
    const path = join(directory, 'absent.sqlite');
    try {
      const connection = await connectCatalog(`sqlite://${path}`).then(
        catalog => ({ catalog }),
        error => ({ error }),
      );
      if (connection.catalog !== undefined) await connection.catalog.close();
      return { error: connection.error?.code, file_created: existsSync(path) };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  async 'catalog.close'(_, context) {
    context.closed = true;
    await context.catalog.close();
    return {};
  },
  async 'catalog.reconnect'(_, context) {
    context.catalog = await connectCatalog(context.dsn);
    context.closed = false;
    context.namespace = await context.catalog.currentNamespace();
    return {};
  },
  async 'catalog.revision'(s, context) {
    const snapshot = stepArgument(s.snapshot, context);
    return { value: { text: snapshot.revision } };
  },
  async 'catalog.current_namespace'(_, { catalog }) {
    return { value: { text: await catalog.currentNamespace() } };
  },
  async 'catalog.describe_table'(s, { catalog, namespace }) {
    const metadata = await catalog.describeTable({ namespace: s.namespace ?? namespace, name: s.table });
    return {
      bind: metadata,
      kind: metadata.kind,
      columns_present: metadata.columns.length > 0,
      namespace: { text: metadata.table.namespace },
      columns: metadata.columns.map(c => c.name),
      primary_key: metadata.primaryKey,
      reliable_row_identity: metadata.reliableRowIdentity,
      native_types: metadata.columns.map(c => c.nativeType),
      nullable: metadata.columns.map(c => c.nullable),
      generated: metadata.columns.map(c => c.generated),
      automatic_keys: metadata.columns.map(c => c.automaticKey),
      defaults: metadata.columns.map(c => c.defaultExpression !== null),
    };
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
    const result = await context.catalog.readOnlyQuery(sql(s.sql, context), (s.binds ?? []).map(bind => native(databaseValue(bind, context))), limits(s));
    return { columns: result.columns, row_count: result.rows.length, rows: result.rows.map(row => row.map(cell => plain(cell, null))) };
  },
  async 'catalog.read_only_grid_query'(s, context) {
    const result = await context.catalog.readOnlyGridQuery(sql(s.sql, context), [], limits(s));
    return { columns: result.columns.map(c => c.name), rows: result.rows.map(row => row.map(grid)) };
  },
  async 'catalog.row_snapshot'(s, context) {
    const page = s.page_with === undefined ? stepArgument(s.page, context) : { ...bound(s.page_with.page.ref, context), orderBy: s.page_with.order_by };
    const snapshot = context.catalog.rowSnapshotFromPage(page, s.index);
    return { bind: snapshot, keys: snapshot.keys().map(key => plain(key, null)), key_indexes: snapshot.keyIndexList() };
  },
  // The generated model reads the bind_cell row by its key; the body is the model's value, SQL NULL or text.
  async 'model.read_bind_cell'(s, context) {
    const db = await connectModel(context.dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      const body = (await new BindCell().connect(db).seq(s.seq).get()).getBody();
      return { value: body === null ? { null: 'text' } : { text: body } };
    } finally {
      await db.close();
    }
  },
  async 'catalog.row_cells'(s, context) {
    const snapshot = stepArgument(s.snapshot, context);
    const types = snapshot.metadata.columns.map(c => c.nativeType);
    return { cells: snapshot.originalCells().map((cell, at) => plain(cell, types[at])) };
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
    // An object form runs only on the databases whose key it holds (FCV-4): an absent key runs nothing.
    const statement = typeof s.sql === 'string' ? s.sql : s.sql[context.database];
    if (statement !== undefined) await nativeQuery(context.database, context.dsn, [statement]);
    return {};
  },
  // The request hook and AES ops of FCV-4 (T334-3-4): each calls the public API of the same name on a bound connection.
  async 'utils.aes_status'(s, context) {
    const status = await connectionOf(s, context).utils().aes().status(modelOf(tableOf(s.model), connectionOf(s, context), context), aesKeyring(s.keyring));
    const versions = [...status.versions.keys()].sort((a, b) => a - b).map(version => [String(version), { int: String(status.versions.get(version)) }]);
    return { value: { object: [
      ['current', { int: String(status.current) }],
      ['total', { int: String(status.total) }],
      ['pending', { int: String(status.pending) }],
      ['versions', { object: versions }],
    ] } };
  },
  async 'utils.aes_rotate'(s, context) {
    const rotated = await connectionOf(s, context).utils().aes().rotate(modelOf(tableOf(s.model), connectionOf(s, context), context), aesKeyring(s.keyring));
    return { value: { int: String(rotated) } };
  },
  'hook.install'(s, context) {
    installHook(s, context);
    return {};
  },
  'hook.records'(_, context) {
    const counts = {};
    for (const record of context.records) counts[record.entity] = (counts[record.entity] ?? 0) + 1;
    const list = context.records.map(record => ({ object: [['kind', { text: record.kind }], ['entity', { text: record.entity }]] }));
    return { value: { array: list }, counts };
  },
};

// OP_DEADLINE_MS bounds one op: a read that did not stop at its budget (the cross join of the user table) fails instead of running on.
const OP_DEADLINE_MS = 20000;

async function runStep(s, context) {
  const op = OPS[s.op] ?? MODEL_OPS[s.op];
  if (op === undefined) throw new Error(`OP_UNKNOWN ${s.op}`);
  // A step with only runs on the databases it names, and its expect names exactly those; a step without only names every database.
  if (s.only !== undefined && !s.only.includes(context.database)) return;
  if (s.expect !== undefined) {
    const named = Object.keys(s.expect).sort().join(',');
    const want = (s.only ?? ['mysql', 'postgres', 'sqlite']).slice().sort().join(',');
    if (named !== want) throw new Error(`the expect of ${s.op} names ${named}, want ${want}`);
  }
  const expected = s.expect === undefined ? undefined : resolveRefs(s.expect[context.database], context);
  let actual;
  try {
    actual = await within(Promise.resolve().then(() => op(s, context)), OP_DEADLINE_MS, `${s.op} on ${context.database}`);
  } catch (error) {
    const code = error === callbackError ? 'CALLBACK' : error?.code;
    if (expected?.error === undefined || typeof code !== 'string') throw error;
    assert.equal(code, expected.error, `the error code (${error.message})`);
    if (expected.message_suffix !== undefined) assert.ok(error.message.endsWith(expected.message_suffix), `the error message ${JSON.stringify(error.message)} ends with ${JSON.stringify(expected.message_suffix)}`);
    return;
  }
  if (s.as !== undefined) {
    context.bound.set(s.as, actual.bind ?? actual.value);
    // A dotted ref reads the fields of the result, as the Go helper does (FCV-4).
    context.fields.set(s.as, actual);
    // A model op that binds a row records the path that made it, so that a later {row} step routes to it.
    if (actual.bind !== undefined && Object.hasOwn(MODEL_OPS, s.op)) context.rowPaths.set(s.as, routeOf(s, context));
  }
  if (expected === undefined) return;
  if (expected.error !== undefined && actual.error === undefined) throw new Error(`expected ${expected.error}, and the op succeeded`);
  const compared = Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]]));
  assert.deepEqual(normalized(compared), normalized(expected));
}

/** A field that holds SQL or a database-decided value: the string itself, or the entry of the database. */
function sql(field, { database }) {
  return typeof field === 'string' ? field : field[database];
}

/** The keyring of a recipe (FCV-4 aesKeyring), by the public constructor. */
function aesKeyring(raw) {
  return new AesKeyring(aesKeys(raw), raw.current);
}

function aesKeys(raw) {
  return new Map(Object.entries(raw.versions).map(([version, key]) => [Number(version), key]));
}

function limits(s) {
  return { ...(s.max_rows === undefined ? {} : { maxRows: s.max_rows }), ...(s.max_bytes === undefined ? {} : { maxBytes: s.max_bytes }) };
}

/** A bound value of {"ref": "<name>"}, the value the step binds, or of {"ref": "<name>.<path>"}, the field at path of its result (FCV-4). */
function bound(ref, context) {
  const [head, ...path] = ref.split('.');
  if (!context.bound.has(head)) throw new Error(`no bound value ${head}`);
  if (path.length === 0) return context.bound.get(head);
  return path.reduce((value, key) => {
    if (value === null || typeof value !== 'object' || !(key in value)) throw new Error(`bound value ${head} has no ${path.join('.')}`);
    return value[key];
  }, context.fields.get(head));
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

/**
 * The assignments of a step: a list of [name, value] pairs, so that a name may repeat or name no column, or the members of a seed
 * row, an object of column names. Each value is a recipe wrapper or a per-database object.
 */
function assignments(values, context) {
  const pairs = Array.isArray(values) ? values : Object.entries(values);
  return pairs.map(([name, value]) => ({ name, value: native(databaseValue(stepArgument(value, context), context)) }));
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
    case 'null': case 'nil': return null;
    // An array is a list of values (an IN list of where); a sequence item adds its integers in place (FCV-4).
    case 'array': return value.flatMap(item => ('sequence' in item ? sequenceValues(item.sequence) : [native(item)]));
    case 'sequence': return sequenceValues(value);
    default: throw new Error(`unknown recipe wrapper ${kind}`);
  }
}

/** The integer values from, from + 1, ... of a {"sequence": {"from", "count"}} wrapper (FCV-4). */
function sequenceValues({ from, count }) {
  return Array.from({ length: count }, (_, index) => native({ int: String(from + index) }));
}

/** The recipe wrapper of a plain value; a string takes the wrapper of the native type of its column when one is known. */
function plain(value, nativeType) {
  if (value === null) return { null: true };
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) return { int: String(value) };
  if (typeof value === 'boolean') return { bool: value };
  if (value instanceof Uint8Array) return { bytes_hex: Buffer.from(value).toString('hex') };
  if (typeof value === 'string') return { [temporalKind(nativeType) ?? 'text']: value };
  if (typeof value === 'number') return { float: String(value) };
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
    case 'integer': return { int: String(cell.value) };
    case 'unsigned': return { uint: String(cell.value) };
    case 'float32': return { f32_bits: cell.bits };
    case 'float64': return { f64_bits: String(cell.bits) };
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

// dbspecPlanSteps runs planSteps for one dialect and returns {steps}, the plan-cases.json objects of its steps, or fails on diagnostics.
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

// checkAnswer runs the chain of an ir.answer step on a connection to a listener that answers with the answer or answers of the step,
// normalizes its result, and compares it with the value of the expect of database. An OrmError from the chain is {error: CODE}.
// An expect of {params} compares the params of the request that the listener received instead (PRT-66).
async function checkAnswer(step, database) {
  const expect = step.expect?.[database];
  if (expect === undefined) throw new Error(`ir.answer has no expect for ${database}`);
  if (expect.value === undefined && expect.params === undefined) throw new Error(`ir.answer expect for ${database} has neither value nor params`);
  const chain = conformanceCases[step.chain];
  if (chain === undefined) throw new Error(`chain ${step.chain} is no markdown conformance case`);
  if (expect.params !== undefined && step.answers !== undefined) throw new Error('a params expect needs one answer, not answers');
  const sent = [];
  const server = step.answers !== undefined ? await startMarkdownTestServerWithKeyedAnswers(step.answers) : await startMarkdownTestServerWithAnswer(JSON.stringify(step.answer), sent);
  const db = await connect(server.dsn);
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
    // The options of the transaction (INT-46): a nested transaction that names one is refused with CONFIG.
    const options = { retry: 0 };
    if (s.isolation !== undefined) options.isolation = s.isolation;
    if (s.read_only === true) options.readOnly = true;
    await connectionOf(s, context).transaction(async () => {
      await runNested(s.steps, context);
      if (s.fail) throw callbackError;
    }, options);
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
    if (s.row !== undefined) {
      await refOf(s.row, context).delete();
      return {};
    }
    const m = modelOf(tableOf(s.model), connectionOf(s, context), context);
    whereAll(m, assignments(s.where, context));
    for (const row of (await m.gets()).values()) await row.delete();
    return {};
  },
  async 'model.creates'(s, context) {
    const db = connectionOf(s, context);
    const rows = s.rows.map(values => filled(modelOf(tableOf(s.model), db, context), values, context));
    return { value: { int: String(await modelOf(tableOf(s.model), db, context).creates(rows, s.batch)) } };
  },
  async 'model.duplicate_create'(s, context) {
    const db = connectionOf(s, context);
    const row = filled(modelOf(tableOf(s.model), db, context), s.values, context);
    row.duplication(filled(modelOf(tableOf(s.model), db, context), s.duplication, context));
    await row.create();
    return {};
  },
  async 'model.restore'(s, context) {
    await filled(modelOf(tableOf(s.model), connectionOf(s, context), context), s.values, context).restore();
    return {};
  },
  async 'model.query'(s, context) {
    const db = connectionOf(s, context);
    const parent = modelOf(tableOf(s.model), db, context);
    whereAll(parent, assignments(s.where, context));
    for (const column of s.order ?? []) parent[CORE].orderBy(column, false, []);
    const rel = s.relation;
    if (rel !== undefined) {
      const child = modelOf(tableOf(rel.model), db, context);
      for (const [left, right] of rel.match) child[`match${pascal(left)}With${pascal(right)}`]();
      if (rel.many) parent.relations(child);
      else parent.relation(child);
    }
    const offset = s.offset ?? 0;
    const paged = s.page === true;
    let parents;
    let total;
    if (paged) {
      if (!(s.limit > 0)) throw new Error('a paged model.query needs a limit above 0');
      const page = await parent.getsPage(Math.floor(offset / s.limit) + 1, s.limit);
      parents = page.items.values();
      total = page.totalCount;
    } else {
      // limit is the public limit of the statement (FCV-4), so a limit on a split IN list fails with IR_INVALID.
      if (s.limit > 0) parent[CORE].setLimit(offset, s.limit);
      parents = (await parent.gets()).values();
    }
    const rows = [];
    for (const row of parents) {
      const own = tableCells(row, s.columns);
      if (rel === undefined) {
        rows.push(own);
        continue;
      }
      for (const child of relatedTableRows(row, tableOf(rel.model), rel.many)) rows.push([...own, ...tableCells(child, rel.columns)]);
    }
    return paged ? { rows, total } : { rows };
  },
  async 'model.count'(s, context) {
    const m = modelOf(TABLE_MODELS[s.model], connectionOf(s, context), context);
    if (s.where !== undefined) whereAll(m, assignments(s.where, context));
    return { value: { int: String(await m.getCount()) } };
  },
};

/** The table model m with the column values of an object of recipe wrappers set. */
function filled(m, values, context) {
  for (const a of assignments(values, context)) m[CORE].setValue(a.name, a.value);
  return m;
}

/** The cells of the columns of a read table row: text and integer values have a recipe wrapper (FCV-4). */
function tableCells(model, columns) {
  const values = model.toArray();
  return columns.map(column => {
    if (!(column in values)) throw new Error(`the row has no column ${column}`);
    return cell(values[column]);
  });
}

/** The rows that a relation read attached to a parent: each row of a collection, or the one row of a single relation. */
function relatedTableRows(parent, table, many) {
  const related = parent[`get${pascal(table)}${many ? 'Models' : 'Model'}`]();
  if (many) return related.values();
  return related === null || related === undefined ? [] : [related];
}

/** The name of a table or column in the chain grammar: hook_item is HookItem. */
function pascal(name) {
  return name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

/** Narrows a table-model chain by the equalities of where, joined by and in column order. */
function whereAll(m, where) {
  if (where.length === 0) return;
  m[CORE].whereChain('', where.map((a, i) => ({ conn: i === 0 ? '' : 'and', op: '', column: a.name, columns: [], compare: '' })), where.map(a => a.value));
}

function cell(value) {
  if (value === null) return { null: true };
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'bigint') return { int: value.toString() };
  if (typeof value === 'number' && Number.isInteger(value)) return { int: String(value) };
  throw new Error(`a read value ${String(value)} of type ${typeof value} has no recipe wrapper in a request op`);
}

/** Binds the connection of s to the connection that model.connect opened with the actions of s as its request hook, in order;
 * a later hook.install on the same connection replaces the hook (FCV-4). */
function installHook(s, context) {
  const base = context.hookBases.get(s.connection) ?? refOf(s.connection, context);
  const hooks = s.hooks;
  const actions = hooks.map(a => ({
    action: a.action,
    kinds: a.kinds,
    column: a.column,
    value: a.value === undefined ? undefined : native(databaseValue(stepArgument(a.value, context), context)),
    nested: a.nested === true,
    code: a.error,
  }));
  context.records = [];
  const hooked = base.withRequestHook((query, addParam) => {
    for (const a of actions) {
      if (!kindMatches(a.kinds, query.kind)) continue;
      switch (a.action) {
        case 'scope':
          if (a.nested) scopeTree(query, a.column, a.value, addParam);
          else andWhere(query, equalPred(addParam, a.column, a.value));
          break;
        case 'assign': {
          const p = addParam(a.value);
          (query.set ??= []).push({ column: a.column, p });
          for (const row of query.rows ?? []) row.push(addParam(a.value));
          break;
        }
        case 'record':
          context.records.push({ kind: query.kind, entity: query.entity });
          break;
        case 'fail':
          throw new OrmError(a.code, `request hook refused ${query.kind}`);
        default:
          throw new Error(`hook action ${a.action} is unknown`);
      }
    }
    return query;
  });
  context.hookBases.set(s.connection, base);
  context.bound.set(s.connection, hooked);
}

const READS = new Set(['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate']);

/** Whether a kind list (or one of the names reads, reads+restore, every) holds kind. */
function kindMatches(kinds, kind) {
  if (typeof kinds === 'string') {
    if (kinds === 'every') return true;
    if (kinds === 'reads') return READS.has(kind);
    if (kinds === 'reads+restore') return READS.has(kind) || kind === 'restore';
    return false;
  }
  return Array.isArray(kinds) && kinds.includes(kind);
}

function equalPred(addParam, column, value) {
  return { column, op: 'eq', p: addParam(value) };
}

/** Adds pred to the where of query with and; an existing where is wrapped in one group item. */
export function andWhere(query, pred) {
  if (query.where === undefined || query.where.items.length === 0) {
    query.where = { items: [{ pred }] };
    return;
  }
  query.where = { items: [{ group: query.where }, { pred: { ...pred, conn: 'and' } }] };
}

/** Adds column = value to the where of query and of each of its relation queries, nested ones included. */
function scopeTree(query, column, value, addParam) {
  andWhere(query, equalPred(addParam, column, value));
  for (const relation of query.relations ?? []) scopeTree(relation.query, column, value, addParam);
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

// readDocuments reads the .dbs files that paths name relative to dir, and parses each with the set of the headers of the files
// (FCV-4). It returns the text of each file and its parsed document, in the order of paths.
async function readDocuments(dir, paths) {
  const texts = [];
  const set = {};
  for (const path of paths) {
    const text = await readFile(resolve(dir, path), 'utf8');
    const fields = text.split('\n', 1)[0].trim().split(/\s+/);
    if (fields.length !== 3 || fields[0] !== 'dbspec') throw new Error(`${path} has no dbspec header`);
    set[fields[2]] = text;
    texts.push(text);
  }
  const documents = texts.map((text, i) => {
    const parsed = parseDbspec(text, set);
    if (parsed.diagnostics.length > 0) throw new Error(`${paths[i]}: ${JSON.stringify(parsed.diagnostics)}`);
    return parsed.document;
  });
  return { texts, documents };
}

// joinText joins lines with LF, or with CRLF when crlf is set, with a final line ending. A mixed document starts with CRLF,
// alternates CRLF and LF from its second line, and has no final line ending.
function joinText(lines, crlf, mixed) {
  if (mixed) return lines.map((line, i) => (i === 0 ? '' : i % 2 === 1 ? '\r\n' : '\n') + line).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

// inlineDocument returns the text of a step and the set of its other documents, joined with the step's line endings.
function inlineDocument(step) {
  const crlf = step.crlf === true;
  const mixed = step.mixed === true;
  const set = {};
  for (const [name, lines] of Object.entries(step.set ?? {})) set[name] = joinText(lines, crlf, mixed);
  return { text: joinText(step.text, crlf, mixed), set };
}

// emitStable parses text with the set, emits it, and checks that the emission parses and emits to itself.
function emitStable(text, set) {
  const parsed = parseDbspec(text, set);
  assert.deepEqual(parsed.diagnostics, [], 'the text parses');
  const first = emitDbspec(parsed.document);
  const again = parseDbspec(first, set);
  assert.deepEqual(again.diagnostics, [], 'the emission parses');
  assert.equal(emitDbspec(again.document), first, 'the emission is idempotent');
  return first;
}

// checkRefusal checks that parse refuses text with exactly the diagnostics of want, and that format returns no text
// and the same diagnostics.
function checkRefusal(text, set, want) {
  const parsed = parseDbspec(text, set);
  assert.ok(!parsed.document, 'Parse returned a document for an invalid source');
  const formatted = formatDbspec(text, set);
  assert.equal(formatted.text, null, 'a document with a diagnostic is not rewritten');
  for (const got of [parsed.diagnostics, formatted.diagnostics]) {
    assert.deepEqual(got.map(d => ({ rule: d.rule, line: d.line, column: d.column })), want, 'diagnostics');
    for (const d of got) assert.ok(d.message, `diagnostic ${d.rule} has no message`);
  }
}

// FILE_MESSAGES is the suffix of the message of each file rule, after the name of the file.
const FILE_MESSAGES = { signature: ' is not a dbspec document', encoding: ' is not valid UTF-8' };

// headerName is the name of a document, the third word of its header line.
function headerName(text) {
  return text.split('\n', 1)[0].trim().split(/\s+/)[2] ?? '';
}

// createdTables is the table names that the CREATE TABLE statements create, in statement order.
function createdTables(statements) {
  return statements
    .filter(s => s.startsWith('CREATE TABLE '))
    .map(s => s.slice('CREATE TABLE '.length).split(' ')[0].replace(/^[`"]|[`"]$/g, ''));
}

// sameDiagnostics checks that got has the rule, line and column of each expected diagnostic, in order, and a message.
function sameDiagnostics(want, got) {
  assert.deepEqual(got.map(d => ({ rule: d.rule, line: d.line, column: d.column })), want, 'diagnostics');
  for (const d of got) assert.ok(d.message, `diagnostic ${d.rule} has no message`);
}

// checkSet runs dbspec.set (the port of checkSet of packages/go/internal/recipe/dbspec.go). The owned texts, then the external
// texts, are parsed each against the other texts and the parsing texts, and dbspecManifest builds the set's manifest. A refused
// set (expect.diagnostics not empty) expects those diagnostics from dbspecManifest and from each dialect of renderDbspec, and no manifest
// and no statements. A built set expects its texts and hashes when expect.manifest is given, parses its manifest and external
// texts back as a set without diagnostics, gives the same hashes in the reversed order, and renders statements in each dialect
// that create the tables of expect.created.
function checkSet(step, expect) {
  const owned = step.owned;
  const all = [...owned, ...(step.external ?? [])];
  const documents = all.map((text, i) => {
    const set = { ...step.parsing };
    all.forEach((other, j) => {
      if (j !== i) set[headerName(other)] = other;
    });
    const parsed = parseDbspec(text, set);
    assert.deepEqual(parsed.diagnostics, [], `document ${i + 1} parses`);
    return i >= owned.length ? Object.freeze({ ...parsed.document, external: true }) : parsed.document;
  });
  const refused = (expect.diagnostics ?? []).length > 0;
  const built = dbspecManifest(documents);
  sameDiagnostics(expect.diagnostics ?? [], built.diagnostics);
  assert.equal(built.manifest === null, refused, 'the manifest is absent exactly when the set is refused');
  for (const dialect of ['mysql', 'postgres', 'sqlite']) {
    const rendered = renderDbspec(documents, dialect);
    if (refused) {
      sameDiagnostics(expect.diagnostics, rendered.diagnostics);
      assert.equal(rendered.statements, null, `${dialect} renders no statements for a refused set`);
      continue;
    }
    assert.deepEqual(rendered.diagnostics, [], `${dialect} renders`);
    assert.ok(rendered.statements.length > 0, `${dialect} renders statements`);
    if (expect.created !== undefined) assert.deepEqual(createdTables(rendered.statements), expect.created, `tables that ${dialect} creates`);
  }
  if (refused) return;
  const manifest = built.manifest;
  if (expect.manifest !== undefined) {
    const want = expect.manifest;
    assert.equal(manifest.manifestText, want.manifest_text, 'manifest_text');
    assert.equal(manifest.schemaText, want.schema_text, 'schema_text');
    assert.equal(manifest.manifestHash, want.manifest_hash, 'manifest_hash');
    assert.equal(manifest.schemaHash, want.schema_hash, 'schema_hash');
    if (want.external_text !== undefined) assert.equal(manifest.externalText, want.external_text, 'external_text');
  }
  // The manifest and external text parse back as a set without diagnostics (docs/spec/dbspec.md "Manifest and hashes").
  const split = text => (text === '' ? [] : text.split(/(?<=\n)(?=dbspec )/));
  for (const r of parseDbspecSet(split(manifest.manifestText), split(manifest.externalText))) {
    assert.deepEqual(r.diagnostics, [], `manifest and external text of ${r.name}`);
  }
  const reversed = dbspecManifest([...documents].reverse());
  assert.ok(reversed.manifest !== null, 'the reversed set has a manifest');
  assert.equal(reversed.manifest.manifestHash, manifest.manifestHash, 'the reversed set has the manifest hash');
  assert.equal(reversed.manifest.schemaHash, manifest.schemaHash, 'the reversed set has the schema hash');
}

// dbspecFileOps are the dbspec ops whose documents are files relative to the recipe, which checkDbspecFiles runs.
const dbspecFileOps = ['dbspec.parse_emit', 'dbspec.manifest', 'dbspec.render', 'dbspec.analyze', 'dbspec.parse_positions', 'dbspec.format', 'dbspec.parse_set', 'dbspec.set', 'dbspec.read_file', 'dbspec.read_bytes'];

// checkDbspecFiles runs one dbspec op of a step through the public dbspec API and checks the result against the expect of database.
// dir is the directory of the recipe: the paths of a step are relative to it (FCV-4).
async function checkDbspecFiles(step, dir, database) {
  const expect = step.expect?.[database];
  if (expect === undefined) throw new Error(`${step.op} has no expect for ${database}`);
  switch (step.op) {
    case 'dbspec.parse_emit': {
      const { texts, documents } = await readDocuments(dir, step.documents);
      const identical = documents.every((document, i) => emitDbspec(document) === texts[i]);
      assert.equal(identical, expect.identical, 'emit identical');
      break;
    }
    case 'dbspec.manifest': {
      const { documents } = await readDocuments(dir, step.documents);
      const { manifest, diagnostics } = dbspecManifest(documents);
      assert.deepEqual(diagnostics, [], 'the document set has a manifest');
      assert.ok(expect.manifest_hash, 'the expect names a manifest hash');
      assert.equal(manifest.manifestHash, expect.manifest_hash, 'manifest hash');
      break;
    }
    case 'dbspec.render': {
      const { documents } = await readDocuments(dir, step.documents);
      for (const dialect of ['mysql', 'postgres', 'sqlite']) {
        const rendered = renderDbspec(documents, dialect);
        assert.deepEqual(rendered.diagnostics, [], `${dialect} renders`);
        assert.ok(expect[dialect]?.length > 0, `${dialect} expects statements`);
        assert.deepEqual(rendered.statements, expect[dialect], `${dialect} statements`);
      }
      break;
    }
    case 'dbspec.analyze': {
      if (step.document === undefined) {
        const { text, set } = inlineDocument(step);
        const analysis = analyzeDbspec(text, set);
        assert.deepEqual(analysis.tokens.map(t => [t.line, t.start, t.end, t.class]), expect.tokens ?? [], 'tokens');
        break;
      }
      const text = await readFile(resolve(dir, step.document), 'utf8');
      const analysis = analyzeDbspec(text, {});
      const parsed = parseDbspec(text, {});
      assert.deepEqual(analysis.diagnostics, [], 'the analysis has no diagnostic');
      assert.equal(emitDbspec(analysis.document), emitDbspec(parsed.document), 'the analysis holds the parsed document');
      assert.deepEqual(analysis.positions, parsed.positions, 'the analysis holds the positions of the parse');
      assert.ok(expect.tokens?.length > 0, 'the expect names tokens');
      assert.deepEqual(analysis.tokens.map(t => [t.line, t.start, t.end, t.class]), expect.tokens, 'tokens');
      break;
    }
    case 'dbspec.parse_positions': {
      const { text, set } = step.document === undefined ? inlineDocument(step) : { text: await readFile(resolve(dir, step.document), 'utf8'), set: {} };
      const parsed = parseDbspec(text, set);
      assert.deepEqual(parsed.diagnostics, [], 'the document parses');
      assert.ok(expect.positions?.length > 0, 'the expect names positions');
      assert.deepEqual(parsed.positions.map(p => ({ kind: p.kind, path: [...p.path], line: p.line, column: p.column })), expect.positions, 'positions');
      break;
    }
    case 'dbspec.format': {
      assert.ok(step.text?.length > 0, 'dbspec.format has no text');
      const { text, set } = inlineDocument(step);
      if (expect.diagnostics !== undefined) {
        assert.ok(expect.diagnostics.length > 0, 'the expect names diagnostics');
        checkRefusal(text, set, expect.diagnostics);
        break;
      }
      const expected = `${expect.text.join('\n')}\n`;
      assert.equal(emitStable(text, set), expected, 'emission');
      const formatted = formatDbspec(text, set);
      assert.deepEqual(formatted.diagnostics, [], 'the text formats');
      assert.equal(formatted.text, expected, 'formatted text');
      assert.equal(formatDbspec(formatted.text, set).text, formatted.text, 'a formatted text is its own format');
      break;
    }
    case 'dbspec.parse_set': {
      // The Node entry and the browser-safe entry both parse the set, and each must give the expected documents.
      for (const [entry, parse] of [['node', parseDbspecSet], ['browser', parseDbspecSetBrowser]]) {
        const got = parse(step.owned, step.external ?? []);
        assert.equal(got.length, expect.documents.length, `${entry}: one result per text`);
        got.forEach((d, i) => {
          const want = expect.documents[i];
          assert.equal(d.name ?? '', want.name, `${entry}: documents[${i}].name`);
          assert.equal(d.external, want.external, `${entry}: documents[${i}].external`);
          assert.equal(d.document !== null, want.parsed, `${entry}: documents[${i}] parsed`);
          assert.equal(d.diagnostics.length, want.diagnostics.length, `${entry}: documents[${i}] diagnostic count`);
          want.diagnostics.forEach((w, k) => {
            const x = d.diagnostics[k];
            assert.deepEqual([x.rule, x.line, x.column], [w.rule, w.line, w.column], `${entry}: documents[${i}] diagnostic ${k}`);
            if (w.message !== undefined) assert.equal(x.message, w.message, `${entry}: documents[${i}] diagnostic ${k} message`);
          });
        });
      }
      break;
    }
    case 'dbspec.read_file':
    case 'dbspec.read_bytes': {
      const want = expect.errors ?? [];
      const path = resolve(dir, step.path);
      let name = path;
      let read;
      if (step.op === 'dbspec.read_file') read = readDbspecFile(path);
      else {
        name = step.path;
        read = readDbspecBytes(name, readFileSync(path));
      }
      const { text, diagnostics } = read;
      if (want.length > 0) {
        assert.equal(text, null, 'the reader returned text with diagnostics');
        assert.equal(diagnostics.length, want.length, 'diagnostic count');
        diagnostics.forEach((d, i) => {
          assert.equal(d.message, name + FILE_MESSAGES[d.rule], `message ${i}`);
          assert.deepEqual([d.rule, d.line, d.column], [want[i].rule, want[i].line, want[i].column], `diagnostic ${i}`);
        });
        break;
      }
      assert.deepEqual(diagnostics, [], 'no diagnostic');
      assert.equal(text, readFileSync(path, 'utf8'), 'the reader text differs from the file bytes');
      assert.equal(emitStable(text, {}), text, 'emission');
      break;
    }
    case 'dbspec.set':
      checkSet(step, expect);
      break;
    default:
      throw new Error(`OP_UNKNOWN ${step.op}`);
  }
}

// withProcessZone runs work with the process default zone set to zone when the step names one (process_zone, an IANA zone). Node reads
// process.env.TZ for every Date and Intl use from the assignment on, and the previous value is restored in finally: a missing value is
// deleted, so no zone outlives the step.
async function withProcessZone(zone, work) {
  if (zone === undefined) return work();
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

// checkSend runs a markdown.send step: a transaction begin, or the typed filter of a slot column with the value of its wrapper, on a
// listener that records the first message it receives. The expect is not per database: {message: json} is compared with the message
// (messageValue) and {error: code} with the OrmError code of a call that sent no message (FCV-4).
async function checkSend(step, wrappedExpect) {
  await checkFirst(async db => {
    if (step.begin !== undefined) await db.transaction(() => {}, { readOnly: step.begin.read_only === true });
    else await queryColumn(step, db);
  }, step, wrappedExpect);
}

// checkFirst runs call on a connection to the markdown.send listener and compares the first message it records, or the OrmError code of a
// call that sent none, with the expect of step.
async function checkFirst(call, step, wrappedExpect) {
  const received = [];
  const server = await startMarkdownSendListener(received);
  let db;
  let callError;
  try {
    db = await connectSlots(server.dsn);
    await call(db);
  } catch (error) {
    callError = error;
  } finally {
    if (db !== undefined) await db.close();
    await server.close();
  }
  let got;
  if (received.length > 0) got = { message: messageValue(received[0]) };
  else if (callError instanceof OrmError) got = { code: callError.code };
  else throw new Error(`the call returned ${callError ?? 'no error'} and sent no message`, { cause: callError });
  if (step.expect.error !== undefined) {
    const code = got.code ?? '';
    if (code !== step.expect.error) throw new Error(`the call returned error ${code || 'none'}, want ${step.expect.error}`);
    return;
  }
  if (step.expect.message === undefined) throw new Error('markdown.send expects a message or an error');
  if (got.code !== undefined) throw new Error(`the call returned error ${got.code} before a message`);
  const want = member(wrappedExpect, 'message');
  if (!equal(got.message, want, false)) throw new Error(`message ${JSON.stringify(got.message)}, want ${JSON.stringify(want)}`);
}

// checkAssign runs a model.assign step: the public setter of the column of a new row of the generated model, then its insert, which the
// listener of checkFirst records (FCV-4). The setter takes the host value of the wrapper, so a null wrapper reaches the setter's
// typed check only if the setter accepts null; the nil case is excluded for TypeScript (DSL-29).
async function checkAssign(step, wrappedExpect) {
  if (step.model !== 'slots' || step.column !== 'varchar_value') throw new Error(`model.assign of ${step.model}.${step.column} has no typed setter in the TypeScript cases`);
  await checkFirst(db => new Slots().connect(db).setVarcharValue(hostValue(step.value)).create(), step, wrappedExpect);
}

// member is the value of the member name of an object wrapper (fromJson), or undefined when there is none.
function member(wrapper, name) {
  return wrapper?.object?.find(([key]) => key === name)?.[1];
}

// messageValue is the message that an expect compares, as a wrapper: the whole message of a begin, or the one parameter of a statement.
// The message is read with its number text, so an integer is compared by its digits.
function messageValue(text) {
  const message = fromJson(parseJson(text));
  if (member(message, 'op')?.text === 'begin') return message;
  const params = member(message, 'params');
  // A statement with no parameter (a nil compared with eq is IS NULL, DSL-48) has the empty list as its message.
  if (params?.array?.length === 0) return params;
  if (params?.array?.length !== 1) throw new Error(`the statement message ${text} holds no single parameter`);
  return params.array[0];
}

// queryColumn runs the generated typed filter of the slot column of step with the value of its wrapper. The time, datetime and date
// filters take the text form of the value (DBS-121); the integer filters take the host value, which TypeScript does not type, so a
// wrapper of another kind reaches the public path and is refused there (CODEC_ENCODE). A column or operator without a typed filter
// here is a defect of the recipe.
async function queryColumn(step, db) {
  const slots = new Slots().connect(db);
  if (step.operator === 'like_contains') {
    if (step.column !== 'slots.text_value') throw new Error(`the column ${step.column} has no contains filter in the TypeScript cases`);
    return slots.lkTextValue(hostValue(step.params[0])).gets();
  }
  if (step.operator !== 'eq') throw new Error(`operator ${step.operator} has no typed filter in the TypeScript cases`);
  switch (step.column) {
    case 'slots.i16_value': return slots.getsByI16Value(hostValue(step.params[0]));
    case 'slots.i32_value': return slots.getsByI32Value(hostValue(step.params[0]));
    case 'slots.i64_value': return slots.getsByI64Value(hostValue(step.params[0]));
    case 'slots.f64_value': return slots.f64Value(hostValue(step.params[0])).gets();
    case 'slots.bool_value': return slots.boolValue(hostValue(step.params[0])).gets();
    case 'slots.decimal_value': return slots.decimalValue(hostValue(step.params[0])).gets();
    case 'slots.varchar_value': return slots.varcharValue(hostValue(step.params[0])).gets();
    case 'slots.varchar_null_value': return slots.varcharNullValue(hostValue(step.params[0])).gets();
    case 'slots.varchar_long_value': return slots.varcharLongValue(hostValue(step.params[0])).gets();
    case 'slots.text_value': return slots.textValue(hostValue(step.params[0])).gets();
    case 'slots.uuid_value': return slots.uuidValue(hostValue(step.params[0])).gets();
    case 'slots.bytes_value': return slots.bytesValue(hostValue(step.params[0])).gets();
  }
  const value = temporalValue(step.params[0]);
  switch (step.column) {
    case 'slots.time1_value': return slots.time1Value(value).gets();
    case 'slots.time2_value': return slots.time2Value(value).gets();
    case 'slots.datetime1_value': return slots.datetime1Value(value).gets();
    case 'slots.datetime2_value': return slots.datetime2Value(value).gets();
    case 'slots.time0_value': return slots.getsByTime0Value(value);
    case 'slots.time3_value': return slots.getsByTime3Value(value);
    case 'slots.time6_value': return slots.getsByTime6Value(value);
    case 'slots.datetime0_value': return slots.getsByDatetime0Value(value);
    case 'slots.datetime3_value': return slots.getsByDatetime3Value(value);
    case 'slots.datetime6_value': return slots.getsByDatetime6Value(value);
    case 'slots.date_value': return slots.getsByDateValue(value);
  }
  throw new Error(`the column ${step.column} has no typed filter in the TypeScript cases`);
}

// hostValue is the value that the TypeScript API takes for a wrapper of a numeric or bool column: an int by native (a number, or a bigint
// beyond the safe range), a float or an f64 as its number (NaN, Infinity and -Infinity included), and text or bool as they are, so
// that the public path refuses the wrong kind.
function hostValue(wrapper) {
  const keys = Object.keys(wrapper);
  if (keys.length === 1 && (keys[0] === 'float' || keys[0] === 'f64')) return Number(wrapper[keys[0]]);
  return native(wrapper);
}

// temporalValue is the text of a temporal wrapper of one string key; any other wrapper is its host value, which the public path
// refuses with its code (CODEC_ENCODE, PRT-67), so a bool wrapper of a datetime column reaches it.
function temporalValue(wrapper) {
  const keys = Object.keys(wrapper);
  if (keys.length === 1 && typeof wrapper[keys[0]] === 'string') return wrapper[keys[0]];
  return hostValue(wrapper);
}

// startMarkdownSendListener answers connect with {"ok":true}, records the first message after it in received, and answers that message
// and every later one with an error so the call ends.
async function startMarkdownSendListener(received) {
  const server = createServer(socket => {
    let lines = 0;
    createInterface({ input: socket }).on('line', line => {
      lines += 1;
      if (lines === 1) {
        socket.write('{"ok":true}\n');
        return;
      }
      if (lines === 2) received.push(line);
      socket.write('{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}\n');
    });
    socket.on('error', () => {});
  });
  return listenMarkdownTestServer(server);
}
