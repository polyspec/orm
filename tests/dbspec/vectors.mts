// vectors.mts reads the shared dbspec vector files against their schemas (schema/): tests/dbspec/ddl.json, plans.json,
// mermaid.json and syntax.json. A runner reads a file that a make target names; a file that cannot be read, is not
// JSON or that its schema refuses is written to stderr, "<path>: <reason>" per line, and the runner ends with 1.
import { errorMessage } from '../errors.mts';
import { JsonError, parseJson, SchemaError, type SchemaIssue } from '../../scripts/json/schema.mts';
import { readInput } from './input.mts';

/** Lines of text, each without its line end. */
export type Lines = string[];
/** A statement that runs or fails, or a query and the value it gives, optionally for some dialects only. */
export type Behavior = ({ sql: string } | { query: string; want?: string }) & { fails?: true; dialects?: ('mysql' | 'postgres' | 'sqlite')[] };
/** tests/dbspec/ddl.json. */
export type DdlVectors = {
  version: 1; note: string;
  cases: { id: string; documents: Record<string, Lines>; statements: Record<'mysql' | 'postgres' | 'sqlite', Lines>; behavior: Behavior[] }[];
};
/** A step of a plan in one dialect. */
export type PlanStep = {
  statement: string; effect: string; rollback?: string; irreversible?: string; finalize?: true; restore?: string; restore_if?: string;
  rollback_restore?: string; null_checks?: [string, string, string | null][];
};
/** An error of a plan, a chain or a comparison: rule, line, column and message (null when the message is not compared). */
export type PlanError = [string, number, number, string | null];
/** tests/dbspec/plans.json. */
export type PlanVectors = {
  version: 1; note: string;
  cases: { id: string; source: Lines | null; plan: Lines; changes: Lines[]; steps: Record<'mysql' | 'postgres' | 'sqlite', PlanStep[]>; before: Behavior[]; after: Behavior[] }[];
  invalid: { id: string; source: Lines; plan: Lines; errors: Lines }[];
  chains: ({ id: string; plans: Lines[] } & ({ order: Lines } | { errors: Lines }))[];
  parse: { id: string; plan: Lines; errors: PlanError[] }[];
  comparisons: { id: string; source: Lines; target: Lines; differences: [string, string, string][]; errors: PlanError[] }[];
};
/** tests/dbspec/mermaid.json. */
export type MermaidVectors = {
  version: 1; note: string;
  export: { id: string; document: Lines; documents: Record<string, Lines>; mermaid: Lines; dropped: [string, string, string][] }[];
  import: { id: string; mermaid: Lines; document: Lines; dropped: [string, string, string][] }[];
  invalid: { id: string; mermaid: Lines; errors: [string, number, number][] }[];
  round_trip: { id: string; path: string; imported: [string, string, string][]; dropped: [string, string, string][] }[];
};
/** tests/dbspec/syntax.json. */
export type SyntaxVectors = { version: 1; note: string; cases: { id: string; tokens: [number, number, number, string][] }[] };

/** The vector files by the name of their schema. */
type Vectors = { ddl: DdlVectors; plans: PlanVectors; mermaid: MermaidVectors; syntax: SyntaxVectors };

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

/** readVectors reads the vector file at path against the schema `kind`; any failure is written to stderr and ends with 1. */
export function readVectors<K extends keyof Vectors>(path: string, kind: K): Vectors[K] {
  const text = readInput(path);
  try {
    return parseJson<Vectors[K]>(text, new URL(`./schema/${kind}.schema.json`, import.meta.url).pathname, path);
  } catch (error) {
    if (error instanceof SchemaError) for (const line of vectorProblems(path, error)) console.error(line);
    else if (error instanceof JsonError) console.error(error.message);
    else console.error(`${path}: ${errorMessage(error)}`);
    process.exit(1);
  }
}
