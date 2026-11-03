// The keys of the recipe format that a helper does not read (FCV-2): a key that the schema accepts and a helper ignores
// passes on every value, so a case that holds it asserts nothing there. This reads the sources of the five helpers by the
// name of the key, so a key that a helper reads for one op and ignores on another op is not found here.
import { globSync, readFileSync } from 'node:fs';

type Node = { [key: string]: unknown };

const DATABASES = new Set(['mysql', 'postgres', 'sqlite', 'none']);

// A key that the format holds for the reader of the recipe, and that no runtime has a call to make with.
export const ANNOTATIONS: { [key: string]: string } = {
  reason: 'sql.exec states why the fixture cannot declare the DDL (FCV-4); it is read by the reader of the recipe',
};

// HELPERS holds the sources of each helper and the form in which its language reads a key.
export const HELPERS: { [helper: string]: { sources: string[]; reads: (key: string) => RegExp } } = {
  typescript: {
    sources: ['packages/ts/tests/recipe*.mjs'],
    reads: key => new RegExp(`\\.${key}\\b|['"\`]${key}['"\`]|[{,]\\s*${key}\\s*[,}:=]`),
  },
  python: {
    sources: ['packages/python/tests/recipe*.py', 'packages/python/tests/chain_answer.py'],
    reads: key => new RegExp(`['"]${key}['"]`),
  },
  php: { sources: ['packages/php/tests/Recipe*.php'], reads: key => new RegExp(`['"]${key}['"]`) },
  go: { sources: ['packages/go/internal/recipe/*.go'], reads: key => new RegExp(`"${key}[",]`) },
  rust: { sources: ['packages/rust/tests/**/*.rs'], reads: key => new RegExp(`"${key}"`) },
};

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);

// schemaKeys is every step key and every key of an outcome under expect that the schema accepts.
export function schemaKeys(schema: Node): Set<string> {
  const names = new Set<string>();
  const resolved = (at: unknown): unknown => {
    let current = at;
    while (isNode(current) && typeof current.$ref === 'string') {
      current = current.$ref.slice(2).split('/').reduce<unknown>((node, key) => (isNode(node) ? node[key] : undefined), schema);
    }
    return current;
  };
  const walk = (at: unknown, seen: Set<unknown>): void => {
    const here = resolved(at);
    if (!isNode(here) || seen.has(here)) return;
    seen.add(here);
    if (isNode(here.properties)) {
      for (const [name, value] of Object.entries(here.properties)) {
        if (name === 'expect' || name === 'expect_unnamed' || DATABASES.has(name)) walk(value, seen);
        else names.add(name);
      }
    }
    if (isNode(here.additionalProperties)) walk(here.additionalProperties, seen);
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      const members = here[combinator];
      if (Array.isArray(members)) for (const member of members) walk(member, seen);
    }
  };
  const defs = schema.$defs;
  if (!isNode(defs) || !isNode(defs.ops)) throw new Error('recipe schema: $defs holds no ops');
  for (const op of Object.values(defs.ops)) walk(op, new Set());
  return names;
}

// sourceOf is the sources of a helper without their comment lines, where the name of a key reads nothing.
function sourceOf(root: string, globs: string[]): string {
  return globs
    .flatMap(glob => globSync(glob, { cwd: root }))
    .filter(file => !/_test\.go$|keys/i.test(file))
    .map(file => readFileSync(`${root}/${file}`, 'utf8').split('\n').filter(line => !/^\s*(\/\/|#|\*|\/\*)/.test(line)).join('\n'))
    .join('\n');
}

// unreadKeys is one line for each helper and each key of the schema that it does not read.
export function unreadKeys(root: string, schema: Node): string[] {
  const unread: string[] = [];
  const keys = [...schemaKeys(schema)].filter(key => !(key in ANNOTATIONS)).sort();
  for (const [helper, { sources, reads }] of Object.entries(HELPERS)) {
    const source = sourceOf(root, sources);
    for (const key of keys) if (!reads(key).test(source)) unread.push(`${helper} does not read ${key}`);
  }
  return unread;
}
