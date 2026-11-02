// vectors.mts reads the shared dbspec vector files against their schemas (schema/): tests/dbspec/ddl.json, plan-cases.json,
// mermaid.json. A runner reads a file that a make target names; a file that cannot be read, is not
// JSON or that its schema refuses is written to stderr, "<path>: <reason>" per line, and the runner ends with 1.
// The validation sections of plan-cases.json are recipes beside it (plan-invalid, plan-chains, plan-parse and plan-comparisons .json);
// readVectors checks that each exists and parses, and readPlanRecipes reads them.
import { dirname, join } from 'node:path';
import { errorMessage } from '../errors.mts';
import { JsonError, parseJson, SchemaError, type SchemaIssue } from '../../scripts/json/schema.mts';
import { readInput } from './input.mts';

/** Lines of text, each without its line end. */
type Lines = string[];
/** A statement that runs or fails, or a query and the value it gives, optionally for some dialects only. */
type Behavior = ({ sql: string } | { query: string; want?: string }) & { fails?: true; dialects?: ('mysql' | 'postgres' | 'sqlite')[] };
/** tests/dbspec/ddl.json. */
type DdlVectors = {
  version: 1; note: string;
  cases: { id: string; documents: Record<string, Lines>; statements: Record<'mysql' | 'postgres' | 'sqlite', Lines>; behavior: Behavior[] }[];
};
/** A step of a recipe (scripts/features/schema/recipe.schema.json); a ref is {ref: name} and null is the empty schema. */
export type RecipeStep = {
  op: string; as?: string; lines?: Lines; source?: { ref: string } | null; target?: { ref: string } | null; plan?: { ref: string };
  plans?: { ref: string }[]; dialect?: 'mysql' | 'postgres' | 'sqlite';
  expect?: { none?: { text?: string; changes?: Lines[]; steps?: PlanStep[] } };
};
/** A recipe file. */
export type RecipeFile = { requirements: string[]; cases: { id: string; steps: RecipeStep[] }[] };
/** The validation sections of plan-cases.json, each a recipe beside it. */
export type PlanRecipes = { invalid: RecipeFile; chains: RecipeFile; parse: RecipeFile; comparisons: RecipeFile };
/** A step of a plan in one dialect. */
type PlanStep = {
  statement: string; effect: string; rollback?: string; irreversible?: string; finalize?: true; restore?: string; restore_if?: string;
  rollback_restore?: string; null_checks?: [string, string, string | null][];
};
/** tests/dbspec/plan-cases.json: its note and the requirement ids. Its cases are the recipe plan-cases.json (readPlanCases). */
type PlanVectors = { version: 1; note: string; requirements: string[] };
/** A case of plan-cases.json with its physical records from plans-physical.json, as the plan readers use it. */
export type PlanCase = {
  id: string; source: Lines | null; plan: Lines; changes: Lines[]; steps: Record<'mysql' | 'postgres' | 'sqlite', PlanStep[]>; before: Behavior[]; after: Behavior[];
};
/** tests/dbspec/plans-physical.json: the database data of each case, keyed by case id. */
type PlanPhysical = { version: 1; note: string; cases: Record<string, { before: Behavior[]; after: Behavior[] }> };
/** A step of tests/dbspec/mermaid.json (the recipe of the Mermaid ops, FCV-4): the fields its op reads. */
type MermaidStep = {
  op: string; text?: string[]; set?: Record<string, string[]>; document?: string; as?: string; mermaid?: string | { ref: string };
  name?: string; skeleton_of?: string; expect?: Record<string, { value: Record<string, unknown> }>;
};
/** A case of tests/dbspec/mermaid.json. */
export type MermaidCase = { id: string; requirements: string[]; steps: MermaidStep[] };
/** tests/dbspec/mermaid.json: the recipe of the Mermaid cases, checked against the recipe schema. */
type MermaidVectors = { requirements: string[]; cases: MermaidCase[] };
/** The vector files by the name of their schema. */
type Vectors = { ddl: DdlVectors; plans: PlanVectors; mermaid: MermaidVectors };

// The compare runners of every language report a refused vector file in one form, "<file>: <location> <problem>", where
// the location is the dotted path of the value (`canonical[0].documents.shop`) and the problem one of a fixed set
// (tests/dbspec/compare/runners.test.mts). vectorProblems writes the issues of a schema in that form.

// location is the dotted path of a JSON Pointer: object keys joined with ".", array indexes in brackets.
function location(pointer: string, property?: unknown): string {
  const segments = pointer.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (typeof property === 'string') segments.push(property);
  return segments.reduce((path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : path === '' ? segment : `${path}.${segment}`), '');
}

const ARTICLE: Record<string, string> = { integer: 'an integer', object: 'an object', array: 'an array', string: 'a string', boolean: 'a boolean', number: 'a number', null: 'null' };

// problem is the shared form of one issue: its location and what is wrong there.
function problem(issue: SchemaIssue): string {
  const { pointer, keyword, params } = issue;
  switch (keyword) {
    case 'required': return `${location(pointer, params['missingProperty'])} is missing`;
    case 'additionalProperties': return `${location(pointer, params['additionalProperty'])} is not a known field`;
    case 'unevaluatedProperties': return `${location(pointer, params['unevaluatedProperty'])} is not a known field`;
    case 'type': return `${location(pointer)} is not ${[params['type']].flat().map(type => ARTICLE[String(type)] ?? String(type)).join(' or ')}`;
    case 'minItems': return `${location(pointer)} is empty`;
    case 'const': return `${location(pointer)} is not ${JSON.stringify(params['allowedValue'])}`;
    default: return `${location(pointer)} fails the ${keyword} rule of its schema ${JSON.stringify(params)}`;
  }
}

/** vectorProblems writes the issues of a refused vector file as "<file>: <location> <problem>" lines. */
export function vectorProblems(path: string, error: SchemaError): string[] {
  return error.issues.map(issue => `${path}: ${problem(issue)}`);
}

/** refuse writes why the file at path cannot be read as a vector file or a recipe, and ends with 1. */
function refuse(path: string, error: unknown): never {
  if (error instanceof SchemaError) for (const line of vectorProblems(path, error)) console.error(line);
  else if (error instanceof JsonError) console.error(error.message);
  else console.error(`${path}: ${errorMessage(error)}`);
  process.exit(1);
}

/** readRecipe reads the recipe at path against the recipe schema; any failure is written to stderr and ends with 1. */
function readRecipe(path: string): RecipeFile {
  const text = readInput(path);
  try {
    return parseJson<RecipeFile>(text, new URL('../../scripts/features/schema/recipe.schema.json', import.meta.url).pathname, path);
  } catch (error) {
    refuse(path, error);
  }
}

/** readPlanRecipes reads the four recipes of the validation sections of the plan-cases.json at plansPath; a failure ends with 1. */
export function readPlanRecipes(plansPath: string): PlanRecipes {
  const beside = (section: string) => join(dirname(plansPath), `plan-${section}.json`);
  return {
    invalid: readRecipe(beside('invalid')),
    chains: readRecipe(beside('chains')),
    parse: readRecipe(beside('parse')),
    comparisons: readRecipe(beside('comparisons')),
  };
}

/** readPlanPhysical reads plans-physical.json of plansPath against its schema; a failure ends with 1. */
function readPlanPhysical(plansPath: string): PlanPhysical {
  const path = join(dirname(plansPath), 'plans-physical.json');
  const text = readInput(path);
  try {
    return parseJson<PlanPhysical>(text, new URL('./schema/plans-physical.schema.json', import.meta.url).pathname, path);
  } catch (error) {
    refuse(path, error);
  }
}

/** readPlanCases reads the cases of plan-cases.json of plansPath, each with its physical records; a failure ends with 1. */
export function readPlanCases(casesPath: string): PlanCase[] {
  const recipePath = casesPath;
  const recipe = readRecipe(recipePath);
  const physicalPath = join(dirname(casesPath), 'plans-physical.json');
  const physical = readPlanPhysical(casesPath).cases;
  return recipe.cases.map(c => {
    let source: Lines | null = null;
    let plan: Lines = [];
    let changes: Lines[] | undefined;
    const steps: Partial<Record<'mysql' | 'postgres' | 'sqlite', PlanStep[]>> = {};
    for (const s of c.steps) {
      if (s.op === 'dbspec.parse' && s.as === 'source') source = s.lines ?? null;
      else if (s.op === 'dbspec.parse_plan') plan = s.lines ?? [];
      else if (s.op === 'dbspec.diff') changes = s.expect?.none?.changes;
      else if (s.op === 'dbspec.plan_steps' && s.dialect !== undefined) {
        const dialectSteps = s.expect?.none?.steps;
        if (dialectSteps !== undefined) steps[s.dialect] = dialectSteps;
      }
    }
    const record = physical[c.id];
    if (changes === undefined) refuse(recipePath, new Error(`case ${c.id} has no dbspec.diff changes`));
    const { mysql, postgres, sqlite } = steps;
    if (mysql === undefined || postgres === undefined || sqlite === undefined) refuse(recipePath, new Error(`case ${c.id} has no plan steps of every dialect`));
    if (record === undefined) refuse(physicalPath, new Error(`case ${c.id} has no physical record`));
    return { id: c.id, source, plan, changes, steps: { mysql, postgres, sqlite }, before: record.before, after: record.after };
  });
}

/** readVectors reads the vector file at path against the schema `kind`; any failure is written to stderr and ends with 1. */
export function readVectors<K extends keyof Vectors>(path: string, kind: K): Vectors[K] {
  const text = readInput(path);
  let vectors: Vectors[K];
  try {
    // The Mermaid vectors are a recipe, so they are checked against the recipe schema of the features (FCV-2).
    const schema = kind === 'mermaid' ? new URL('../../scripts/features/schema/recipe.schema.json', import.meta.url) : new URL(`./schema/${kind}.schema.json`, import.meta.url);
    vectors = parseJson<Vectors[K]>(text, schema.pathname, path);
  } catch (error) {
    refuse(path, error);
  }
  if (kind === 'plans') readPlanRecipes(path);
  return vectors;
}
