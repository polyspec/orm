// Runs native conformance bodies of one language on one database and compares their output with data outside
// tests/conformance/vectors*.json, so that a body and the recipe cannot disagree without a check failing.
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

const root = resolve(import.meta.dirname, '../../..');
const RECIPE = 'contracts/fixtures/conformance_verification/conformance_verification.json';
const FIXED_CLOCK = 'tests/conformance/check/fixed_clock.json';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Step = { op: string; expect?: Record<string, Json>; steps?: Step[]; only?: string[]; sql?: string };
type Case = { id: string; steps: Step[] };
type Output = { result: Json; statements: Json[] };

/** A recipe value as plain JSON: the wrappers of FCV-4 and the `json` form of an expect. */
export function plain(value: Json): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const [key, inner] = Object.entries(value)[0] ?? [];
  if (Object.keys(value).length === 1) {
    if (key === 'int' || key === 'decimal') return Number(inner);
    if (key === 'text' || key === 'bool' || key === 'float') return inner as Json;
    if (key === 'null' || key === 'json') return key === 'null' ? null : inner as Json;
    if (key === 'array') return (inner as Json[]).map(plain);
    if (key === 'object') return Object.fromEntries((inner as [string, Json][]).map(([name, item]) => [name, plain(item)]));
  }
  return value;
}

/** The result of the step, as what its expect holds: an error code, or its plain value. */
function stepValue(step: Step, database: string): Json {
  const expect = step.expect?.[database];
  if (expect === undefined || expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
    throw new Error(`a step ${step.op} has no expect for ${database}`);
  }
  return 'error' in expect ? expect.error as Json : plain(expect);
}

const size = (value: Json): number => {
  if (!Array.isArray(value)) throw new Error(`expected a list, got ${JSON.stringify(value)}`);
  return value.length;
};

/** The output of the body of each vector, built from the steps of its recipe case in order. */
const shapes: Record<string, (steps: Json[]) => Json> = {
  terminal_by: ([one, missing, rows, count]) => ({ one, missing, rows, count }) as Json,
  terminal_reuse: ([first, rows, last]) => [first, size(rows), last] as Json,
  relation_empty: ([rows]) => size(rows),
  aes_values: ([row, found]) => ({ row, found }) as Json,
  hex_malformed: ([odd_length, white_space]) => ({ odd_length, white_space }) as Json,
  empty_reads: ([get, get_by, gets, gets_count, page, count, sum, avg, null_rows, null_sum, null_avg]) => {
    const held = page as { keys: Json[]; page: Json; per_page: Json; total: Json; pages: Json };
    return {
      avg, count, get, get_by, gets: size(gets), gets_count, null_avg, null_rows, null_sum,
      page: { items: size(held.keys), page: held.page, per_page: held.per_page, total_count: held.total, total_pages: held.pages },
      sum,
    } as Json;
  },
  // The recipe counts the row that holds both facts: a body answers each of them, and the count is one only when both hold.
  now_defaults: ([found]) => {
    const held = plain(((found as { rows: Json[][] }).rows[0] as Json[])[0] as Json) === 1;
    return { created_equals_updated: held, created_near_clock: held };
  },
  delete_recursive: ([loaded, members_left, service_left]) => ({
    members: size((loaded as { service_member_models: Json }).service_member_models), members_left, service_left,
  }) as Json,
  // The steps db.last_affected read the count of each write, in the order of the body.
  affected_counts: ([upsert_inserted, upsert_updated, update_unchanged, update_changed]) => Object.fromEntries(
    Object.entries({ update_changed, update_unchanged, upsert_inserted, upsert_updated }).map(([name, held]) => [name, plain((held as { value: Json }).value)]),
  ) as Json,
};

/** The steps of a case with those of its transactions, in the order they run. */
const inOrder = (steps: Step[]): Step[] => steps.flatMap(step => [step, ...inOrder(step.steps ?? [])]);

/** The result and the statements that the recipe case states for a body. */
export function expectedOfCase(recipeCase: Case, database: string): Output {
  const shape = shapes[recipeCase.id];
  if (shape === undefined) throw new Error(`recipe case ${recipeCase.id} has no body shape`);
  const held = inOrder(recipeCase.steps).filter(step => step.expect !== undefined && step.op !== 'events.captured');
  const captured = recipeCase.steps.find(step => step.op === 'events.captured');
  if (captured === undefined) throw new Error(`recipe case ${recipeCase.id} captures no statement`);
  const statements = stepValue(captured, database);
  const events = (statements as { value?: Json }).value ?? statements;
  const stated = plain(events) as Json[];
  return { result: shape(held.map(step => stepValue(step, database))), statements: stated };
}

/** A body masks the sequence value it created as `$SEQ`; the recipe states it, and only an integer takes that mask. */
function unmasked(got: Json | undefined, want: Json | undefined): Json | undefined {
  if (!Array.isArray(got) || !Array.isArray(want)) return got;
  return got.map((bind, index) => bind === '$SEQ' && typeof want[index] === 'number' ? want[index] as Json : bind);
}

type Vector = { name: string; expect: { result?: Json; statements?: { [key: string]: Json }[] } };

/** The vector file of a database (DIA-37). */
export const vectorFile = (database: string): string =>
  join(root, 'tests/conformance', database === 'mysql' ? 'vectors.json' : `vectors.${database}.json`);

/** The vectors that no recipe case holds, each with where its expectation lives. */
export const NO_RECIPE_CASE: Record<string, string> = {
  errors: 'the refusal tests of each runtime (T334-3-5-2) read its chains',
  clock_truncate_write: 'fixed_clock.json: FixClock is a test entry point, so no recipe step can fix the clock (PRT-53)',
  clock_compare_six_digits: 'fixed_clock.json: FixClock is a test entry point, so no recipe step can fix the clock (PRT-53)',
};

/** Why the values of a vector result cannot equal its recipe case, which derives them from the seed of the recipe (T334-3-5). */
const SEED_RESULTS = new Set([
  'conditions_values', 'terminal_by', 'terminal_reuse', 'expression_forms', 'joins', 'subqueries', 'aggregates', 'empty_reads',
  'functions', 'column_pairs', 'aes_status',
]);

/**
 * The result of a vector as its recipe case states it. A body folds a step into a boolean, a size or a null for no error,
 * and the recipe holds what the runtime returns: the error code of the step, its rows, its count.
 */
const RESULT_FORMS: Record<string, (result: Json) => Json> = {
  relation_empty: () => [],
  contains_null: result => ({ count: (result as { count: Json }).count }),
  audit_lazy: result => {
    const { rolled_back: _, ...rest } = result as Record<string, Json>;
    return { ...rest, rolled_back: 'CALLBACK' };
  },
  transactions: result => (result as Json[]).filter((_, index) => index !== 2).map(item => (item === true ? 'CALLBACK' : item)),
  empty_reads: result => {
    const { gets: _, page, ...rest } = result as Record<string, Json>;
    const { items: _items, ...held } = page as Record<string, Json>;
    return { ...rest, page: held };
  },
  now_defaults: () => [1],
  expect_revision: result => {
    const { delete_match: _, ...rest } = result as Record<string, Json>;
    return rest;
  },
  delete_lock: () => ['FOREIGN_KEY'],
};

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

const stepsOf = (steps: Step[]): Step[] =>
  steps.flatMap(step => [step, ...stepsOf((step as { steps?: Step[] }).steps ?? [])]);

const MASKED = new Set(['$SEQ', '$TS', '$AES', '$NOW'].map(text => JSON.stringify(text)));

/**
 * What a vector states and its recipe case does not, on one database. Statements compare field by field, `$SEQ` being any
 * integer. A result value is held when an expect of the case holds it; an error message is held by its code and suffix.
 */
export function vectorDifferences(vector: Vector, recipeCase: Case, database: string): string[] {
  const out: string[] = [];
  const steps = stepsOf(recipeCase.steps);
  const captured = steps.find(step => step.op === 'events.captured');
  const events = captured?.expect?.[database] as { value?: Json } | undefined;
  const got = (events === undefined ? [] : unwrapped(events.value ?? null)) as { [key: string]: Json }[];
  const want = vector.expect.statements ?? [];
  if (got.length !== want.length) out.push(`${want.length} statements in the vector, ${got.length} in the case`);
  else {
    for (const [index, statement] of want.entries()) {
      for (const [field, value] of Object.entries(statement)) {
        if (field === 'binds') continue;
        if (JSON.stringify(got[index]?.[field]) !== JSON.stringify(value)) out.push(`statement ${index} ${field}: ${JSON.stringify(value)} in the vector, ${JSON.stringify(got[index]?.[field])} in the case`);
      }
      const binds = statement.binds as Json[];
      const held = got[index]?.binds as Json[];
      if (binds.length !== held.length) out.push(`statement ${index} has ${binds.length} binds in the vector, ${held.length} in the case`);
      for (const [position, bind] of binds.entries()) {
        const same = bind === '$SEQ' ? Number.isInteger(held[position]) : JSON.stringify(bind) === JSON.stringify(held[position]);
        if (!same) out.push(`statement ${index} bind ${position}: ${JSON.stringify(bind)} in the vector, ${JSON.stringify(held[position])} in the case`);
      }
    }
  }
  const expects = steps.filter(step => step.op !== 'events.captured' && step.expect?.[database] !== undefined).map(step => step.expect?.[database] as Json);
  const have = new Map<string, number>();
  for (const leaf of expects.flatMap(expect => leaves(unwrapped(expect)))) have.set(leaf, (have.get(leaf) ?? 0) + 1);
  const suffixes = expects.flatMap(expect => {
    const suffix = (expect as { message_suffix?: Json }).message_suffix;
    return typeof suffix === 'string' ? [suffix] : [];
  });
  const result = vector.expect.result ?? null;
  const stated = leaves(RESULT_FORMS[vector.name]?.(result) ?? result).filter(leaf => !MASKED.has(leaf));
  const total = [...have.values()].reduce((sum, count) => sum + count, 0);
  if (SEED_RESULTS.has(vector.name)) {
    if (total < stated.length) out.push(`${stated.length} result values in the vector, ${total} in the expects of the case`);
    return out;
  }
  for (const leaf of stated) {
    const message = /^"([A-Z][A-Z0-9_]*): (.*)"$/.exec(leaf);
    if (message !== null) {
      if (!have.has(JSON.stringify(message[1]))) out.push(`the code of the message ${leaf} of the vector is in no expect of the case`);
      if (!suffixes.some(suffix => (message[2] as string).endsWith(suffix))) out.push(`the message ${leaf} of the vector has no message_suffix in the case`);
      continue;
    }
    const count = have.get(leaf) ?? 0;
    if (count === 0) out.push(`the result value ${leaf} of the vector is in no expect of the case`);
    else have.set(leaf, count - 1);
  }
  return out;
}

/** Each statement of a body against the fields that the statement of the expect states. */
export function compareOutput(name: string, got: Output, want: Output): void {
  assert.deepEqual(got.result, want.result, `${name}: the result differs from its expect`);
  assert.equal(got.statements.length, want.statements.length, `${name}: the number of statements differs from its expect`);
  for (const [index, statement] of want.statements.entries()) {
    const fields = statement as Record<string, Json>;
    const actual = got.statements[index] as Record<string, Json>;
    for (const key of Object.keys(fields)) {
      assert.deepEqual(key === 'binds' ? unmasked(actual[key], fields[key]) : actual[key], fields[key], `${name}: statement ${index} ${key}`);
    }
  }
}

function runner(language: string, dsn: string, names: string[]): Output & Record<string, unknown> {
  const flags = ['--dsn', dsn, ...names.flatMap(name => ['--vector', name])];
  const env = process.env;
  const commands: Record<string, () => [string, string[]]> = {
    go: () => ['go', ['run', '-tags', 'ormtest', './packages/go/internal/conformance', '-dsn', dsn, ...names.flatMap(name => ['-vector', name])]],
    php: () => ['php', ['packages/php/testing/conformance/runner.php', ...flags]],
    'php-extension': () => ['php', ['-d', `extension=${env.POLYSPEC_ORM_EXTENSION ?? ''}`, 'packages/php/testing/conformance/runner.php', ...flags]],
    typescript: () => ['node', ['packages/ts/testing/conformance/runner_typescript.mts', ...flags]],
    python: () => [env.ORM_PYTHON ?? '', ['packages/python/testing/conformance/runner_python.py', '--models', env.ORM_PYTHON_MODELS ?? '', ...flags]],
    rust: () => [env.LEASE ?? '', ['run', env.CARGO_LEASES ?? '', 'exclusive', '--wait', '--', 'cargo', 'run', '--locked', '--manifest-path', 'packages/rust/Cargo.toml', '-p', 'polyspec-orm-tests', '--bin', 'conformance', '--', ...flags]],
  };
  const command = commands[language];
  if (command === undefined) throw new Error(`unsupported language ${JSON.stringify(language)}`);
  const [name, args] = command();
  if (name === '') throw new Error(`the runner of ${language} is not named in the environment`);
  const run = spawnSync(name, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`the ${language} runner exited ${String(run.status)}: ${(run.stderr + run.stdout).replaceAll(dsn, '[dsn]')}`);
  return JSON.parse(run.stdout) as Output & Record<string, unknown>;
}

export function expectations(mode: string, database: string): Map<string, Output> {
  const out = new Map<string, Output>();
  if (mode === 'generated') {
    const recipe = JSON.parse(readFileSync(join(root, RECIPE), 'utf8')) as { cases: Case[] };
    for (const id of Object.keys(shapes)) {
      const recipeCase = recipe.cases.find(item => item.id === id);
      if (recipeCase === undefined) throw new Error(`${RECIPE} has no case ${id}`);
      out.set(id, expectedOfCase(recipeCase, database));
    }
  } else if (mode === 'fixed-clock') {
    const file = JSON.parse(readFileSync(join(root, FIXED_CLOCK), 'utf8')) as { cases: { id: string; expect: Record<string, Output> }[] };
    for (const item of file.cases) {
      const expect = item.expect[database];
      if (expect === undefined) throw new Error(`${FIXED_CLOCK} case ${item.id} has no expect for ${database}`);
      out.set(item.id, expect);
    }
  } else throw new Error(`unknown mode ${JSON.stringify(mode)}`);
  return out;
}

/** The statement of the recipe that moves the PostgreSQL identity sequences past its seed, for a body that creates rows on that seed. */
export function sequenceStatement(): string {
  const recipe = JSON.parse(readFileSync(join(root, RECIPE), 'utf8')) as { seed?: { after?: { sql?: string } } };
  const statement = recipe.seed?.after?.sql;
  if (statement === undefined) throw new Error(`${RECIPE} has no sequence statement in its seed`);
  return statement;
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
  const tests = pathToFileURL(join(root, 'packages/ts/tests')).href;
  const { postgresClient, withCaseDatabase } = await import(`${tests}/case-database.mjs`) as {
    postgresClient: (dsn: string) => { connect: () => Promise<void>; query: (sql: string) => Promise<unknown>; end: () => Promise<void> };
    withCaseDatabase: (d: string, s: (m: string) => void, b: (c: { dsn: string }) => Promise<void>) => Promise<void>;
  };
  const { prepareRecipeDatabase } = await import(`${tests}/recipe.mjs`) as { prepareRecipeDatabase: (p: string, d: string, dsn: string) => Promise<void> };
  await withCaseDatabase(database, () => undefined, async ({ dsn }) => {
    await prepareRecipeDatabase(RECIPE, database, dsn);
    if (database === 'postgres') {
      const client = postgresClient(dsn);
      await client.connect();
      try { await client.query(sequenceStatement()); } finally { await client.end(); }
    }
    const output = runner(language, dsn, [...want.keys()]);
    for (const [name, expected] of want) {
      const got = output[name];
      if (got === undefined) throw new Error(`the ${language} runner gave no output for ${name}`);
      compareOutput(`${language}/${database}/${name}`, got as Output, expected);
    }
  });
  console.log(`ok - ${mode ?? ''} ${language} ${database}: ${[...want.keys()].join(', ')}`);
}

if (import.meta.main) await main(process.argv.slice(2));
