// The JSON boundary of the infrastructure: a JSON file is read, parsed and validated against its JSON Schema (draft
// 2020-12) by ajv in strict mode with every error, and the value is typed by the type guard of the compiled schema, never by
// a type assertion. A schema that strict mode refuses throws, so a schema never passes unchecked. The shape and the names
// follow the JSON helper of polyspec/kit (K158); this module takes the schemas of orm, which kit's helper does not read.
import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

/** A file that is not JSON. */
export class JsonError extends Error {}

/** One refusal of a schema: the JSON Pointer of the value, the keyword that refused it and the params of that keyword. */
export type SchemaIssue = { pointer: string; keyword: string; params: Record<string, unknown> };

/** A JSON value that its schema refuses: one line per error prefixed with the source, and the same errors as issues. */
export class SchemaError extends Error {
  readonly lines: string[];
  readonly issues: SchemaIssue[];
  constructor(lines: string[], issues: SchemaIssue[] = []) {
    super(lines.join('\n'));
    this.lines = lines;
    this.issues = issues;
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: true, verbose: true });

// errorLine is one ajv error: the JSON Pointer of the value (`/` for the whole document), the message and its params, and
// the value when it is not an object or array.
function errorLine(source: string, error: ErrorObject): string {
  const value = error.data === null || typeof error.data !== 'object' ? `, value ${JSON.stringify(error.data)}` : '';
  return `${source}: ${error.instancePath || '/'} ${error.message ?? 'is invalid'} ${JSON.stringify(error.params)}${value}`;
}

// parse reads JSON text; invalid JSON throws a JsonError that names the source.
function parse(text: string, source: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new JsonError(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// validator compiles the schema file; a schema holds no $id, so compiling it again adds nothing to ajv.
function validator<T>(schema: string): ValidateFunction<T> {
  const rules = parse(readFileSync(schema, 'utf8'), schema);
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) throw new JsonError(`${schema}: a JSON Schema is an object`);
  return ajv.compile<T>(rules);
}

/** checkJson is a parsed JSON value against the schema file, typed; it throws a SchemaError naming source. */
export function checkJson<T>(value: unknown, schema: string, source: string): T {
  const check = validator<T>(schema);
  if (check(value)) return value;
  const errors = check.errors ?? [];
  throw new SchemaError(errors.map(error => errorLine(source, error)), errors.map(issue));
}

// issue is an ajv error as a SchemaIssue; its params are the keyword's own values (a property name, an allowed value).
function issue(error: ErrorObject): SchemaIssue {
  const params: Record<string, unknown> = { ...error.params };
  return { pointer: error.instancePath, keyword: error.keyword, params };
}

/** parseJson is the value of the JSON text against the schema file; it throws a JsonError or a SchemaError naming source. */
export function parseJson<T>(text: string, schema: string, source: string): T {
  return checkJson<T>(parse(text, source), schema, source);
}

/** readJsonFile is the value of the JSON file against the schema file. */
export function readJsonFile<T>(file: string, schema: string): T {
  return parseJson<T>(readFileSync(file, 'utf8'), schema, file);
}

/** refusedPaths is the instance paths of the errors that a parse reports, or [] when the parse accepts the document. */
export function refusedPaths(parse: () => unknown): string[] {
  try {
    parse();
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return [...new Set(error.lines.map(line => line.split(' ')[1] ?? ''))];
  }
  return [];
}
