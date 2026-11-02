// The key table of the recipe format (FCV-2 to FCV-4): one table generated from scripts/features/schema/recipe.schema.json,
// read by every loader of the six runners, which refuses a file, case or step key that the table does not hold, by name.
// `node scripts/features/recipe-keys.mts` writes the table; `--check` exits 1 when the tracked table is not the one the schema makes.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
export const schemaFile = resolve(root, 'scripts/features/schema/recipe.schema.json');
export const keysFile = resolve(root, 'scripts/features/schema/recipe-keys.json');

type Node = { [key: string]: unknown };

export type KeyTable = {
  schema: 1;
  file: string[];
  case: string[];
  step: { [op: string]: string[] };
};

// node narrows a value of the schema to an object, or names where the schema holds something else.
function node(value: unknown, where: string): Node {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`recipe schema: ${where} is not an object`);
  return Object.fromEntries(Object.entries(value));
}

// strings narrows a value of the schema to a list of texts.
function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error(`recipe schema: ${where} is not a list of texts`);
  return value.filter(item => typeof item === 'string');
}

// pointer resolves a local JSON pointer (#/a/b) of the schema.
function pointer(schema: Node, ref: string): Node {
  if (!ref.startsWith('#/')) throw new Error(`recipe schema: ${ref} is not a local reference`);
  let current: Node = schema;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!(key in current)) throw new Error(`recipe schema: ${ref} does not resolve`);
    current = node(current[key], ref);
  }
  return current;
}

// keysOf collects the property names of a schema node, through its references and its oneOf, anyOf and allOf members.
function keysOf(schema: Node, at: Node, names: Set<string>): Set<string> {
  if (typeof at.$ref === 'string') return keysOf(schema, pointer(schema, at.$ref), names);
  if (at.properties !== undefined) for (const name of Object.keys(node(at.properties, 'properties'))) names.add(name);
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const members = at[combinator];
    if (Array.isArray(members)) for (const member of members) keysOf(schema, node(member, combinator), names);
  }
  return names;
}

// keyTable derives the table from the schema: the file keys, the case keys, and per op the keys of its variants and its op.
export function keyTable(schema: Node): KeyTable {
  const defs = node(schema.$defs, '$defs');
  const ops = node(defs.ops, '$defs.ops');
  if (defs.step === undefined || defs.case === undefined) throw new Error('recipe schema: $defs holds no step or case');
  const stepDef = node(defs.step, '$defs.step');
  const caseDef = node(defs.case, '$defs.case');
  const stepOps = strings(node(node(stepDef.properties, '$defs.step.properties').op, '$defs.step.properties.op').enum, 'the op enum of step');
  const step: { [op: string]: string[] } = {};
  for (const op of stepOps) {
    if (!(op in ops)) throw new Error(`recipe schema: op ${op} has no $defs.ops entry`);
    step[op] = [...keysOf(schema, node(ops[op], `$defs.ops.${op}`), new Set(['op']))].sort();
  }
  const members: unknown = stepDef.oneOf;
  if (!Array.isArray(members)) throw new Error('recipe schema: $defs.step holds no oneOf list');
  for (const member of members) {
    const ref = node(member, 'a oneOf member of step').$ref;
    if (typeof ref !== 'string') throw new Error('recipe schema: a oneOf member of step has no $ref');
    const op = String(ref.split('/').pop());
    if (!stepOps.includes(op)) throw new Error(`recipe schema: the oneOf of step names ${op}, which its op enum lacks`);
  }
  for (const op of Object.keys(ops)) {
    if (!stepOps.includes(op)) throw new Error(`recipe schema: $defs.ops ${op} is not in the op enum of step`);
  }
  return {
    schema: 1,
    file: Object.keys(node(schema.properties, 'properties')).sort(),
    case: Object.keys(node(caseDef.properties, '$defs.case.properties')).sort(),
    step,
  };
}

// readSchema reads the recipe schema as an object.
export function readSchema(): Node {
  return node(JSON.parse(readFileSync(schemaFile, 'utf8')), schemaFile);
}

// render is the tracked text of a table.
export function render(table: KeyTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = render(keyTable(readSchema()));
  if (process.argv.includes('--check')) {
    const tracked = readFileSync(keysFile, 'utf8');
    if (tracked !== text) {
      process.stderr.write(`${keysFile} is not the key table of ${schemaFile}; run node scripts/features/recipe-keys.mts\n`);
      process.exit(1);
    }
  } else {
    writeFileSync(keysFile, text);
  }
}
