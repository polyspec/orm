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

// pointer resolves a local JSON pointer (#/a/b) of the schema.
function pointer(schema: Node, ref: string): Node {
  if (!ref.startsWith('#/')) throw new Error(`recipe schema: ${ref} is not a local reference`);
  let node: unknown = schema;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (node === null || typeof node !== 'object' || !(key in node)) throw new Error(`recipe schema: ${ref} does not resolve`);
    node = (node as Node)[key];
  }
  return node as Node;
}

// keysOf collects the property names of a schema node, through its references and its oneOf, anyOf and allOf members.
function keysOf(schema: Node, node: Node, names: Set<string>): Set<string> {
  if (typeof node.$ref === 'string') return keysOf(schema, pointer(schema, node.$ref), names);
  const properties = node.properties;
  if (properties !== null && typeof properties === 'object') for (const name of Object.keys(properties)) names.add(name);
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const members = node[combinator];
    if (Array.isArray(members)) for (const member of members) keysOf(schema, member as Node, names);
  }
  return names;
}

// keyTable derives the table from the schema: the file keys, the case keys, and per op the keys of its variants and its op.
export function keyTable(schema: Node): KeyTable {
  const defs = schema.$defs as { [name: string]: Node };
  const ops = defs.ops as { [op: string]: Node };
  const stepDef = defs.step;
  const caseDef = defs.case;
  if (stepDef === undefined || caseDef === undefined) throw new Error('recipe schema: $defs holds no step or case');
  const stepOps = ((stepDef.properties as Node).op as { enum: string[] }).enum;
  const step: { [op: string]: string[] } = {};
  for (const op of stepOps) {
    if (!(op in ops)) throw new Error(`recipe schema: op ${op} has no $defs.ops entry`);
    const variant = ops[op];
    if (variant === undefined) throw new Error(`recipe schema: op ${op} has no $defs.ops entry`);
    step[op] = [...keysOf(schema, variant, new Set(['op']))].sort();
  }
  for (const member of (stepDef.oneOf as Node[])) {
    const op = String((member.$ref as string).split('/').pop());
    if (!stepOps.includes(op)) throw new Error(`recipe schema: the oneOf of step names ${op}, which its op enum lacks`);
  }
  for (const op of Object.keys(ops)) {
    if (!stepOps.includes(op)) throw new Error(`recipe schema: $defs.ops ${op} is not in the op enum of step`);
  }
  return {
    schema: 1,
    file: Object.keys(schema.properties as Node).sort(),
    case: Object.keys((caseDef.properties as Node)).sort(),
    step,
  };
}

// render is the tracked text of a table.
export function render(table: KeyTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8')) as Node;
  const text = render(keyTable(schema));
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
