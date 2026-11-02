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
import { Db, OrmError, StyledValue, blindIndex, connectCatalog, dbspecManifest, decode, emitDbspec, encode, hostDecode, hostEncode, parseDbspec, parseDbspecSet as parseDbspecSetNode, readDbspecFile, registerModel, renderDbspec } from '../dist/index.js';
import { analyzeDbspec, formatDbspec, parseDbspecSet, readDbspecBytes } from '../dist/dbspec/entry.js';
import { connect } from '../dist/models/markdown_fixture/models.js';
import { decodeRequest, validate } from '../dist/engine/validate.js';
import { withCaseDatabase } from './case-database.mjs';
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
  const dir = resolve(root, dirname(path));
  for (const [caseIndex, recipeCase] of recipe.cases.entries()) {
    caseTest(recipeCase.id, COMPUTE, async () => {
      const bound = new Map();
      for (const [index, step] of recipeCase.steps.entries()) {
        try {
          if (step.op === 'ir.validate') checkValidate(step, requestText(literal, caseIndex, index), schema, database);
          else if (step.op === 'ir.answer') await checkAnswer(step, database);
          else if (step.op.startsWith('dbspec.')) await checkDbspec(step, dir, database);
          else run(step, bound, database);
        } catch (error) {
          throw new Error(`recipe ${path} case ${recipeCase.id} step ${index} (${step.op}) on ${database}: ${error.message}`, { cause: error });
        }
      }
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
  const schema = await fixtureSchema(resolve(root, recipe.fixture));
  for (const recipeCase of recipe.cases) {
    caseTest(recipeCase.id, DATABASE, ({ step }) =>
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
async function startMarkdownTestServerWithAnswer(answer) {
  const server = createServer(socket => {
    const replies = ['{"ok":true}', answer];
    createInterface({ input: socket }).on('line', () => {
      if (replies.length > 0) socket.write(`${replies.shift()}\n`);
    });
    socket.on('error', () => {});
  });
  return listenMarkdownTestServer(server);
}

// checkAnswer runs the chain of an ir.answer step on a connection to a listener that answers with the answer or answers of the step,
// normalizes its result, and compares it with the value of the expect of database. An OrmError from the chain is {error: CODE}.
async function checkAnswer(step, database) {
  const expect = step.expect?.[database];
  if (expect === undefined) throw new Error(`ir.answer has no expect for ${database}`);
  const chain = conformanceCases[step.chain];
  if (chain === undefined) throw new Error(`chain ${step.chain} is no markdown conformance case`);
  const server = step.answers !== undefined ? await startMarkdownTestServerWithKeyedAnswers(step.answers) : await startMarkdownTestServerWithAnswer(JSON.stringify(step.answer));
  const db = await connect(server.dsn);
  let got;
  try {
    got = normalize(await chain({ db }));
  } catch (error) {
    if (!(error instanceof OrmError)) throw new Error(`${step.chain} failed without an orm code: ${error?.stack ?? error}`, { cause: error });
    got = { error: error.code };
  } finally {
    await db.close();
    await server.close();
  }
  if (!isDeepStrictEqual(got, expect.value)) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(expect.value)}`);
}

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
    const set = { ...(step.parsing ?? {}) };
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

// checkDbspec runs one dbspec op of a step through the public dbspec API and checks the result against the expect of database.
// dir is the directory of the recipe: the paths of a step are relative to it (FCV-4).
async function checkDbspec(step, dir, database) {
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
      for (const [entry, parse] of [['node', parseDbspecSetNode], ['browser', parseDbspecSet]]) {
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
