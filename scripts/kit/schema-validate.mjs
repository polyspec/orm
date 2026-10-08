// A validator for the JSON Schema keywords that the schemas of scripts/kit/schema use: type, required, properties,
// additionalProperties (false), items, enum, const, pattern, minItems and minimum. Other keywords fail the schema
// itself, so a schema never passes unchecked. `kit-check` validates config/<name>.json against
// scripts/kit/schema/<name>.schema.json.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './files.mjs';

/** The directory of the schemas of kit. */
export const SCHEMAS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema');

const KEYWORDS = new Set(['$schema', 'title', 'description', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minItems', 'minimum']);

const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

/** The errors of `value` against `schema` at `where`, each a sentence naming the location, the rule and the values. */
export function validate(value, schema, where = '$') {
  const errors = [];
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`schema keyword ${key} at ${where} is not supported by kit`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(types.includes('number') && actual === 'integer')) errors.push(`${where} is ${actual}, the schema requires ${types.join(' or ')}`);
    if (errors.length) return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${where} is ${JSON.stringify(value)}, the schema requires ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} is ${JSON.stringify(value)}, the schema allows ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${where} is ${JSON.stringify(value)}, the schema requires a match of ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errors.push(`${where} is ${value}, the schema requires at least ${schema.minimum}`);
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${where} lacks ${key}, the schema requires it`);
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (key in properties) errors.push(...validate(value[key], properties[key], `${where}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${where}.${key} is not in the schema`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where} has ${value.length} items, the schema requires at least ${schema.minItems}`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items, `${where}[${index}]`)));
  }
  return errors;
}

/** The JSON value of the file `file` of `root` and its errors, each prefixed with `file`, against the schema `schema` (a file name in SCHEMAS). */
export function readConfig(root, file, schema) {
  const value = readJson(root, file);
  return { value, errors: validate(value, readJson(SCHEMAS, schema)).map(error => `${file}: ${error}`) };
}
