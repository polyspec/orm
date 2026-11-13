// Runs native conformance bodies of one language on one database and compares their output with the recipe
// conformance_verification and fixed_clock.json, so that a body and the recipe cannot disagree without a check failing.
//
//   node tests/conformance/check/recipe_vectors.mts generated --language L --database D
//     The bodies that call generated methods (T334-3-5-1), on a database that holds the fixture and the seed of the recipe
//     conformance_verification, against the expects of the recipe case of the same name.
//   node tests/conformance/check/recipe_vectors.mts fixed-clock --language L --database D
//     The fixed-clock bodies (T334-3-5-3), against tests/conformance/check/fixed_clock.json. FixClock
//     is a test entry point, so no recipe step can fix the clock (PRT-53).
//
// The Go runner comes from `go run`, the Rust runner from `cargo run` under the exclusive lease of the shared target
// directory (LEASE, CARGO_LEASES), the PHP extension from POLYSPEC_ORM_EXTENSION, and Python from ORM_PYTHON and
// ORM_PYTHON_MODELS. A body returns its output and this file asserts it, so one comparison serves all six runtimes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonValue, readJsonFile, type Json } from '../../../scripts/json/schema.mts';

const root = resolve(import.meta.dirname, '../../..');
const RECIPE = 'contracts/fixtures/conformance_verification/conformance_verification.json';
const RECIPE_SCHEMA = join(root, 'scripts/features/schema/recipe.schema.json');
const FIXED_CLOCK = 'tests/conformance/check/fixed_clock.json';

type Step = { op: string; expect?: Record<string, Json>; steps?: Step[]; only?: string[]; sql?: string };
type Case = { id: string; steps: Step[] };
type Recipe = { cases: Case[]; seed?: { after?: { sql?: string } } };
type Output = { result: Json; statements: Json[] };
export type Sequence = { id: string; expected?: Json; statements?: string[] };

const isObject = (value: Json | undefined): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A value that must be a list; a recipe or a body that holds something else is a failure of the check. */
export const list = (value: Json | undefined): Json[] => {
  if (!Array.isArray(value)) throw new Error(`expected a list, got ${JSON.stringify(value)}`);
  return value;
};

/** A value that must be an object. */
export const record = (value: Json | undefined): { [key: string]: Json } => {
  if (!isObject(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  return value;
};

const text = (value: Json | undefined): string => {
  if (typeof value !== 'string') throw new Error(`expected a text, got ${JSON.stringify(value)}`);
  return value;
};

const output = (value: Json | undefined): Output => {
  const held = record(value);
  return { result: held.result ?? null, statements: list(held.statements) };
};

/** A recipe value as plain JSON: the wrappers of FCV-4 and the `json` form of an expect. */
export function plain(value: Json): Json {
  if (!isObject(value)) return value;
  const [key, inner = null] = Object.entries(value)[0] ?? [];
  if (Object.keys(value).length === 1) {
    if (key === 'int' || key === 'decimal') return Number(inner);
    if (key === 'text' || key === 'bool' || key === 'float') return inner;
    if (key === 'null' || key === 'json') return key === 'null' ? null : inner;
    if (key === 'array') return list(inner).map(plain);
    if (key === 'object') return Object.fromEntries(list(inner).map(member => {
      const [name, item = null] = list(member);
      return [text(name), plain(item)];
    }));
  }
  return value;
}

/** The result of the step, as what its expect holds: an error code, or its plain value. */
function stepValue(step: Step, database: string): Json {
  const expect = step.expect?.[database];
  if (!isObject(expect)) throw new Error(`a step ${step.op} has no expect for ${database}`);
  return 'error' in expect ? expect.error ?? null : plain(expect);
}

const size = (value: Json | undefined): number => list(value).length;

/** The value of a step that a shape reads and its case does not hold. */
const noStep = (): Json => {
  throw new Error('a recipe case holds fewer steps than the shape of its body reads');
};

const terminalReuse = ([first = noStep(), rows, last = noStep()]: Json[]): Json => [first, size(rows), last];

/** The output of the body of each vector, built from the steps of its recipe case in order. */
const shapes: Record<string, (steps: Json[]) => Json> = {
  terminal_by: ([one = noStep(), missing = noStep(), rows = noStep(), count = noStep()]) => ({ one, missing, rows, count }),
  terminal_reuse: terminalReuse,
  relation_empty: ([rows]) => size(rows),
  aes_values: ([row = noStep(), found = noStep()]) => ({ row, found }),
  hex_malformed: ([odd_length = noStep(), white_space = noStep()]) => ({ odd_length, white_space }),
  empty_reads: ([get = noStep(), get_by = noStep(), gets, gets_count = noStep(), page, count = noStep(), sum = noStep(), avg = noStep(), null_rows = noStep(), null_sum = noStep(), null_avg = noStep()]) => {
    const held = record(page);
    return {
      avg, count, get, get_by, gets: size(gets), gets_count, null_avg, null_rows, null_sum,
      page: { items: size(held.keys), page: held.page ?? null, per_page: held.per_page ?? null, total_count: held.total ?? null, total_pages: held.pages ?? null },
      sum,
    };
  },
  // The recipe counts the row that holds both facts: a body answers each of them, and the count is one only when both hold.
  now_defaults: ([found]) => {
    const held = plain(list(list(record(found).rows)[0])[0] ?? null) === 1;
    return { created_equals_updated: held, created_near_clock: held };
  },
  delete_recursive: ([loaded, members_left = noStep(), service_left = noStep()]) => ({
    members: size(record(loaded).service_member_models), members_left, service_left,
  }),
  // The steps db.last_affected read the count of each write, in the order of the body.
  affected_counts: ([upsert_inserted = noStep(), upsert_updated = noStep(), update_unchanged = noStep(), update_changed = noStep()]) => Object.fromEntries(
    Object.entries({ update_changed, update_unchanged, upsert_inserted, upsert_updated }).map(([name, held]) => [name, plain(record(held).value ?? null)]),
  ),
};

/** The steps of a case with those of its transactions, in the order they run. */
const inOrder = (steps: Step[]): Step[] => steps.flatMap(step => [step, ...inOrder(step.steps ?? [])]);

/** The result and the statements that the recipe case states for a body. */
function expectedOfCase(recipeCase: Case, database: string): Output {
  const shape = shapes[recipeCase.id];
  if (shape === undefined) throw new Error(`recipe case ${recipeCase.id} has no body shape`);
  const held = inOrder(recipeCase.steps).filter(step => step.expect !== undefined && step.op !== 'events.captured');
  const captured = recipeCase.steps.find(step => step.op === 'events.captured');
  if (captured === undefined) throw new Error(`recipe case ${recipeCase.id} captures no statement`);
  const statements = stepValue(captured, database);
  const events = isObject(statements) ? statements.value ?? statements : statements;
  return { result: shape(held.map(step => stepValue(step, database))), statements: list(plain(events)) };
}

/** A body masks the sequence value it created as `$SEQ`; the recipe states it, and only an integer takes that mask. */
function unmasked(got: Json | undefined, want: Json | undefined): Json | undefined {
  if (!Array.isArray(got) || !Array.isArray(want)) return got;
  return got.map((bind, index) => {
    const stated = want[index];
    return bind === '$SEQ' && typeof stated === 'number' ? stated : bind;
  });
}

/** The vectors that no recipe case holds, each with where its expectation lives. */
export const NO_RECIPE_CASE: Record<string, string> = {
  clock_truncate_write: 'fixed_clock.json: FixClock is a test entry point, so no recipe step can fix the clock (PRT-53)',
  clock_compare_six_digits: 'fixed_clock.json: FixClock is a test entry point, so no recipe step can fix the clock (PRT-53)',
};

/**
 * The result of a state contract built from the steps of its case: a body folds a step into a boolean, a size or a null
 * for no error, and the recipe holds what the runtime returns. Each value then compares with the contract.
 */
const RESULT_SHAPES: Record<string, (steps: Json[]) => Json> = {
  ...shapes,
  // The last expect of the case is the count that shows the connection still works after the refusals.
  errors: steps => steps.filter(step => typeof step === 'string'),
  transactions: ([first, second, count = noStep(), rows, local = noStep(), left = noStep()]) => [first === 'CALLBACK', count, size(rows), local, second === 'CALLBACK', left],
};

/** The case whose counts come from the seed of the recipe: its result compares in shape, and a number need only be a number. */
const SEED_SHAPES: Record<string, (steps: Json[]) => Json> = {
  terminal_reuse: terminalReuse,
};

const isNumber = (value: Json): boolean => typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));

/** The member of an object, or the item of a list whose counterpart is an object; null when it holds none. */
const member = (value: Json[] | { [key: string]: Json }, name: string): Json => (Array.isArray(value) ? value[Number(name)] : value[name]) ?? null;

/** The paths where a stated value and a built value differ; with loose, two numbers of the seed are the same. */
function resultDifferences(stated: Json, built: Json, loose: boolean, path = '$'): string[] {
  if (stated === '$SEQ' || stated === '$TS') return [];
  if (loose && isNumber(stated) && isNumber(built)) return [];
  if (Array.isArray(stated) && Array.isArray(built)) {
    if (!loose && stated.length !== built.length) return [`${path}: ${stated.length} items in the contract, ${built.length} in the case`];
    if (stated.length !== built.length && typeof stated[0] !== 'object') return [`${path}: ${stated.length} items in the contract, ${built.length} in the case`];
    return stated.flatMap((item, index) => (index < built.length ? resultDifferences(item, built[index] ?? null, loose, `${path}[${index}]`) : []));
  }
  if (stated !== null && built !== null && typeof stated === 'object' && typeof built === 'object') {
    const names = new Set([...Object.keys(stated), ...Object.keys(built)]);
    return [...names].flatMap(name => resultDifferences(member(stated, name), member(built, name), loose, `${path}.${name}`));
  }
  return JSON.stringify(stated) === JSON.stringify(built) ? [] : [`${path}: ${JSON.stringify(stated)} in the contract, ${JSON.stringify(built)} in the case`];
}

function unwrapped(value: Json): Json {
  const held = plain(value);
  if (Array.isArray(held)) return held.map(unwrapped);
  if (held !== null && typeof held === 'object') return Object.fromEntries(Object.entries(held).map(([name, item]) => [name, unwrapped(item)]));
  return held;
}

const leaves = (value: Json): string[] => {
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leaves);
  return [JSON.stringify(value)];
};

const MASKED = new Set(['$SEQ', '$TS', '$AES', '$NOW'].map(text => JSON.stringify(text)));

/** What a stated result holds and the expects of its recipe case do not, on one database. */
function resultValueDifferences(name: string, result: Json, recipeCase: Case, database: string): string[] {
  const out: string[] = [];
  const expects = inOrder(recipeCase.steps).flatMap(step => {
    const expect = step.expect?.[database];
    return step.op !== 'events.captured' && expect !== undefined ? [expect] : [];
  });
  const values = expects.map(expect => {
    const held = unwrapped(expect);
    return isObject(held) && 'error' in held ? held.error ?? null : held;
  });
  const seed = SEED_SHAPES[name];
  const shape = seed ?? RESULT_SHAPES[name];
  if (shape !== undefined) return [...out, ...resultDifferences(result, shape(values.map(value => (
    isObject(value) && 'value' in value && name !== 'affected_counts' ? value.value ?? null : value
  ))), seed !== undefined)];
  const have = new Map<string, number>();
  for (const leaf of expects.flatMap(expect => leaves(unwrapped(expect)))) have.set(leaf, (have.get(leaf) ?? 0) + 1);
  const suffixes = expects.flatMap(expect => {
    const suffix = isObject(expect) ? expect.message_suffix : undefined;
    return typeof suffix === 'string' ? [suffix] : [];
  });
  for (const leaf of leaves(result).filter(item => !MASKED.has(item))) {
    const message = /^"([A-Z][A-Z0-9_]*): (.*)"$/.exec(leaf);
    if (message !== null) {
      if (!have.has(JSON.stringify(message[1]))) out.push(`the code of the message ${leaf} of the contract is in no expect of the case`);
      const body = message[2] ?? '';
      if (!suffixes.some(suffix => body.endsWith(suffix))) out.push(`the message ${leaf} of the contract has no message_suffix in the case`);
      continue;
    }
    const count = have.get(leaf) ?? 0;
    if (count === 0) out.push(`the result value ${leaf} of the contract is in no expect of the case`);
    else have.set(leaf, count - 1);
  }
  return out;
}

/**
 * What a state contract of contracts/interfaces.json states and its recipe case does not, on one database: the statement
 * kinds in order, utility statements left out, and the result.
 */
export function sequenceDifferences(sequence: Sequence, recipeCase: Case, database: string): string[] {
  const captured = inOrder(recipeCase.steps).find(step => step.op === 'events.captured');
  const events = captured?.expect?.[database];
  const kinds = (events === undefined ? [] : list(unwrapped(isObject(events) ? events.value ?? null : null))).map(event => record(event).kind ?? null).filter(kind => kind !== 'utility');
  const out = JSON.stringify(kinds) === JSON.stringify(sequence.statements ?? []) ? [] : [`statements ${JSON.stringify(sequence.statements ?? [])} in the contract, ${JSON.stringify(kinds)} in the case`];
  return [...out, ...resultValueDifferences(sequence.id, sequence.expected ?? null, recipeCase, database)];
}

/** Each statement of a body against the fields that the statement of the expect states. */
export function compareOutput(name: string, got: Output, want: Output): void {
  assert.deepEqual(got.result, want.result, `${name}: the result differs from its expect`);
  assert.equal(got.statements.length, want.statements.length, `${name}: the number of statements differs from its expect`);
  for (const [index, statement] of want.statements.entries()) {
    const fields = record(statement);
    const actual = record(got.statements[index]);
    for (const key of Object.keys(fields)) {
      assert.deepEqual(key === 'binds' ? unmasked(actual[key], fields[key]) : actual[key], fields[key], `${name}: statement ${index} ${key}`);
    }
  }
}

/** The program and arguments of the runner of a language (PAR-1). */
export function runnerCommand(language: string, dsn: string, names: string[], env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const flags = ['--dsn', dsn, ...names.flatMap(name => ['--vector', name])];
  const commands: Record<string, () => [string, string[]]> = {
    go: () => ['go', ['run', '-tags', 'ormtest', './legacy/packages/go/internal/conformance', '-dsn', dsn, ...names.flatMap(name => ['-vector', name])]],
    php: () => ['php', ['legacy/packages/php/testing/conformance/runner.php', ...flags]],
    'php-extension': () => ['php', ['-d', `extension=${env.POLYSPEC_ORM_EXTENSION ?? ''}`, 'legacy/packages/php/testing/conformance/runner.php', ...flags]],
    typescript: () => ['node', ['legacy/packages/ts/testing/conformance/runner_typescript.mts', ...flags]],
    python: () => [env.ORM_PYTHON ?? '', ['legacy/packages/python/testing/conformance/runner_python.py', '--models', env.ORM_PYTHON_MODELS ?? '', ...flags]],
    rust: () => [env.LEASE ?? '', ['run', env.CARGO_LEASES ?? '', 'exclusive', '--wait', '--', 'cargo', 'run', '--locked', '--manifest-path', 'packages/rust/Cargo.toml', '-p', 'polyspec-orm-tests', '--bin', 'conformance', '--', ...flags]],
  };
  const command = commands[language];
  if (command === undefined) throw new Error(`unsupported language ${JSON.stringify(language)}`);
  return command();
}

/** The sources of the runner of each language; php-extension runs the PHP runner. */
export const RUNNER_SOURCES: Record<string, string[]> = {
  go: ['legacy/packages/go/internal/conformance/main.go', 'legacy/packages/go/internal/conformance/affected_ormtest.go', 'legacy/packages/go/internal/conformance/clock_ormtest.go'],
  php: ['legacy/packages/php/testing/conformance/runner.php'],
  typescript: ['legacy/packages/ts/testing/conformance/runner_typescript.mts'],
  python: ['legacy/packages/python/testing/conformance/runner_python.py'],
  rust: ['packages/rust/programs/src/conformance.rs'],
};

/** The names of the bodies that a runner source declares, in each language the call that takes the name first. */
export function declaredBodies(source: string): string[] {
  return [...source.matchAll(/\b(?:run!?|vector)\(\s*["']([a-z0-9_]+)["']/g)].flatMap(match => match[1] ?? []);
}

function runner(language: string, dsn: string, names: string[]): { [key: string]: Json } {
  const [name, args] = runnerCommand(language, dsn, names);
  if (name === '') throw new Error(`the runner of ${language} is not named in the environment`);
  const run = spawnSync(name, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`the ${language} runner exited ${String(run.status)}: ${(run.stderr + run.stdout).replaceAll(dsn, '[dsn]')}`);
  return record(parseJsonValue(run.stdout, `the ${language} runner`));
}

/** The recipe conformance_verification, read against the recipe schema. */
export const readRecipe = (): Recipe => readJsonFile<Recipe>(join(root, RECIPE), RECIPE_SCHEMA);

export function expectations(mode: string, database: string): Map<string, Output> {
  const out = new Map<string, Output>();
  if (mode === 'generated') {
    const recipe = readRecipe();
    for (const id of Object.keys(shapes)) {
      const recipeCase = recipe.cases.find(item => item.id === id);
      if (recipeCase === undefined) throw new Error(`${RECIPE} has no case ${id}`);
      out.set(id, expectedOfCase(recipeCase, database));
    }
  } else if (mode === 'fixed-clock') {
    const file = record(parseJsonValue(readFileSync(join(root, FIXED_CLOCK), 'utf8'), FIXED_CLOCK));
    for (const item of list(file.cases)) {
      const { id, expect } = record(item);
      const held = record(expect)[database];
      if (held === undefined) throw new Error(`${FIXED_CLOCK} case ${text(id)} has no expect for ${database}`);
      out.set(text(id), output(held));
    }
  } else throw new Error(`unknown mode ${JSON.stringify(mode)}`);
  return out;
}

/** The statement of the recipe that moves the PostgreSQL identity sequences past its seed, for a body that creates rows on that seed. */
export function sequenceStatement(): string {
  const statement = readRecipe().seed?.after?.sql;
  if (statement === undefined) throw new Error(`${RECIPE} has no sequence statement in its seed`);
  return statement;
}

const isFunction = <F,>(value: unknown): value is F => typeof value === 'function';

/** The function that a module of the JavaScript tests exports, by the signature this file calls it with. */
function exported<F>(module: unknown, name: string): F {
  const value: unknown = module !== null && typeof module === 'object' ? Reflect.get(module, name) : undefined;
  if (!isFunction<F>(value)) throw new Error(`the module exports no function ${name}`);
  return value;
}

async function main(args: string[]): Promise<void> {
  const [mode, ...rest] = args;
  const flag = (name: string): string => {
    const index = rest.indexOf(name);
    const value = index < 0 ? undefined : rest[index + 1];
    if (value === undefined) throw new Error(`${name} is required; run make conformance-generated-methods-check or make conformance-fixed-clock-check, which pass it`);
    return value;
  };
  const language = flag('--language');
  const database = flag('--database');
  const want = expectations(mode ?? '', database);
  const tests = pathToFileURL(join(root, 'legacy/packages/ts/tests')).href;
  const caseDatabase: unknown = await import(`${tests}/case-database.mjs`);
  const recipeRunner: unknown = await import(`${tests}/recipe.mjs`);
  const postgresClient = exported<(dsn: string) => { connect: () => Promise<void>; query: (sql: string) => Promise<unknown>; end: () => Promise<void> }>(caseDatabase, 'postgresClient');
  const withCaseDatabase = exported<(d: string, s: (m: string) => void, b: (c: { dsn: string }) => Promise<void>) => Promise<void>>(caseDatabase, 'withCaseDatabase');
  const prepareRecipeDatabase = exported<(p: string, d: string, dsn: string) => Promise<void>>(recipeRunner, 'prepareRecipeDatabase');
  await withCaseDatabase(database, () => undefined, async ({ dsn }) => {
    await prepareRecipeDatabase(RECIPE, database, dsn);
    if (database === 'postgres') {
      const client = postgresClient(dsn);
      await client.connect();
      try { await client.query(sequenceStatement()); } finally { await client.end(); }
    }
    const outputs = runner(language, dsn, [...want.keys()]);
    for (const [name, expected] of want) {
      const got = outputs[name];
      if (got === undefined) throw new Error(`the ${language} runner gave no output for ${name}`);
      compareOutput(`${language}/${database}/${name}`, output(got), expected);
    }
  });
  console.log(`ok - ${mode ?? ''} ${language} ${database}: ${[...want.keys()].join(', ')}`);
}

if (import.meta.main) await main(process.argv.slice(2));
