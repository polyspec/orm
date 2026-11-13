// The database branches of the recipes (FCV-16): a case that runs a step on some databases only (`only`), or that states a
// different statement or outcome per database (a map by database whose entries differ), is a branch, and every runtime
// would otherwise run one test on every database. A branch stays only where the server lacks the feature or gives its own
// answer; the case then states why in `databases_differ`, which names the spec item, most often a DIA item, that states it. A branch where the
// orm answers differently, or a statement that one form valid on every server can replace, is not stated: it is fixed.
// A step that names a case of a vector file (`vectors` and `case`) takes the branches of that case too: a vector case for
// one dialect (`dialect`), an entry for some dialects only (`dialects`), and for `dbspec.plan_physical` the entries of the
// case in plans-physical.json beside the vector file; the `dialect` of a step inside a vector is the dialect argument of a
// call that runs on no database, and is not a branch.
// `node scripts/features/recipe-branches.mts` lists every branch of the database recipes with its file and line, its case,
// what it splits and its reason; `--check` exits 1 when a branch states no reason or a reason names no branch.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { jsonFiles } from './recipe-files.mts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: Json };

const DATABASE_NAMES = new Set(['mysql', 'mariadb', 'postgres', 'sqlite', 'markdown']);
const DIALECT_NAMES = new Set(['mysql', 'postgres', 'sqlite']);
const REASON_ID = /\b[A-Z]{2,5}-\d+[a-z]?\b/g;

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Calls visit on each object inside value with its path; visit returns the keys whose members it took, which the walk does not enter. */
function walkObjects(value: Json, path: string, visit: (node: Node, path: string) => Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObjects(item, `${path}/${index}`, visit));
    return;
  }
  if (!isNode(value)) return;
  const taken = visit(value, path);
  for (const [key, member] of Object.entries(value)) if (!taken.has(key)) walkObjects(member, `${path}/${key}`, visit);
}

/** One branch of a case: where it is, inside the case, and the databases it names. */
export type Branch = { path: string; kind: 'only' | 'map' | 'vector'; databases: string[] };

/** The branches of one case: each `only` of the case and its steps, and each map by database whose entries differ. */
export function caseBranches(kase: Node): Branch[] {
  const branches: Branch[] = [];
  const visit = (node: Node, path: string): Set<string> => {
    const taken = new Set(['only']);
    const only = node.only;
    if (Array.isArray(only) && only.length > 0) branches.push({ path: `${path}/only`, kind: 'only', databases: only.map(String) });
    for (const [key, member] of Object.entries(node)) {
      if (key === 'only' || !isNode(member)) continue;
      const names = Object.keys(member);
      if (names.length > 1 && names.every(name => DATABASE_NAMES.has(name)) && new Set(Object.values(member).map(entry => JSON.stringify(entry))).size > 1) {
        branches.push({ path: `${path}/${key}`, kind: 'map', databases: names });
        taken.add(key);
      }
    }
    return taken;
  };
  for (const [key, member] of Object.entries(kase)) {
    if (key === 'databases_differ' || key === 'id' || key === 'requirements') continue;
    if (key === 'only') {
      if (Array.isArray(member) && member.length > 0) branches.push({ path: '/only', kind: 'only', databases: member.map(String) });
      continue;
    }
    walkObjects(member, `/${key}`, visit);
  }
  return branches;
}

/** The vector case that a step names: a member of the array `cases` with that id, or the member of the object `cases` by that key. */
function vectorCase(document: unknown, id: string, where: string): Node {
  const cases = isNode(document) ? document.cases : undefined;
  const found = Array.isArray(cases) ? cases.find(entry => isNode(entry) && entry.id === id) : isNode(cases) ? cases[id] : undefined;
  if (!isNode(found)) throw new Error(`${where} names the vector case ${id}, which its file does not hold`);
  return found;
}

/** The dialect branches of a vector case: its own `dialect`, and each `dialects` inside it. */
function dialectBranches(vector: Node, base: string): Branch[] {
  const branches: Branch[] = [];
  if (typeof vector.dialect === 'string') {
    if (!DIALECT_NAMES.has(vector.dialect)) throw new Error(`${base} names the dialect ${vector.dialect}`);
    branches.push({ path: `${base}/dialect`, kind: 'vector', databases: [vector.dialect] });
  }
  const visit = (node: Node, path: string): Set<string> => {
    if (!Array.isArray(node.dialects)) return new Set();
    branches.push({ path: `${path}/dialects`, kind: 'vector', databases: node.dialects.map(String) });
    return new Set(['dialects']);
  };
  for (const [key, member] of Object.entries(vector)) if (key !== 'dialect') walkObjects(member, `${base}/${key}`, visit);
  return branches;
}

/** The branches of the vector cases that the steps of a case of the recipe file name. */
export function vectorBranches(root: string, file: string, kase: Node, read: (path: string) => unknown): Branch[] {
  const steps = kase.steps;
  if (!Array.isArray(steps)) return [];
  const branches: Branch[] = [];
  steps.forEach((step, index) => {
    if (!isNode(step) || typeof step.vectors !== 'string' || typeof step.case !== 'string') return;
    const where = `${file} case ${typeof kase.id === 'string' ? kase.id : '(no id)'} step ${index}`;
    const path = resolve(root, dirname(file), step.vectors);
    branches.push(...dialectBranches(vectorCase(read(path), step.case, where), `${relative(root, path)}#${step.case}`));
    if (step.op === 'dbspec.plan_physical') {
      const physical = resolve(dirname(path), 'plans-physical.json');
      branches.push(...dialectBranches(vectorCase(read(physical), step.case, where), `${relative(root, physical)}#${step.case}`));
    }
  });
  return branches;
}

/** The ids of the items that the English documents of docs/spec define, each as `**<ID>**`. */
export function specItems(root: string): Set<string> {
  const ids = new Set<string>();
  const directory = resolve(root, 'docs/spec');
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.md') || file.endsWith('.ko.md')) continue;
    for (const match of readFileSync(resolve(directory, file), 'utf8').matchAll(/\*\*([A-Z]{2,5}-\d+[a-z]?)\*\*/g)) ids.add(match[1] ?? '');
  }
  return ids;
}

/** A case of a database recipe with its branches, its reason and the line of its id. */
export type BranchedCase = { file: string; line: number; id: string; branches: Branch[]; reason: string | undefined };

/** The cases of the database recipes (a recipe that names a fixture) that hold a branch or state a reason. */
export function branchedCases(root: string): BranchedCase[] {
  const found: BranchedCase[] = [];
  const documents = new Map<string, unknown>();
  const read = (path: string): unknown => {
    if (!documents.has(path)) documents.set(path, JSON.parse(readFileSync(path, 'utf8')));
    return documents.get(path);
  };
  for (const file of jsonFiles(root)) {
    const text = readFileSync(resolve(root, file), 'utf8');
    const recipe: unknown = JSON.parse(text);
    if (!isNode(recipe) || typeof recipe.$schema !== 'string' || !recipe.$schema.endsWith('/recipe.schema.json') || !('fixture' in recipe)) continue;
    // The recipe schema holds what follows; a file that breaks it is refused here too, so that no case is skipped unseen.
    const cases = recipe.cases;
    if (!Array.isArray(cases)) throw new Error(`${file}: a recipe with a fixture holds no array of cases`);
    const lines = text.split('\n');
    for (const kase of cases) {
      if (!isNode(kase) || typeof kase.id !== 'string') throw new Error(`${file}: a case is not an object with a text id`);
      const id = kase.id;
      const branches = [...caseBranches(kase), ...vectorBranches(root, file, kase, read)];
      const reason = typeof kase.databases_differ === 'string' ? kase.databases_differ : undefined;
      if (branches.length === 0 && reason === undefined) continue;
      const line = lines.findIndex(row => row.includes(`"id": ${JSON.stringify(id)}`)) + 1;
      found.push({ file: relative(root, resolve(root, file)), line, id, branches, reason });
    }
  }
  return found;
}

/** The faults of the branches: a branch without a reason, a reason without a branch, a reason that names no spec item. */
export function branchFaults(cases: BranchedCase[], items: Set<string>): string[] {
  const faults: string[] = [];
  for (const kase of cases) {
    const where = `${kase.file}:${kase.line} case ${kase.id}`;
    if (kase.reason === undefined) {
      faults.push(`${where}: branches on a database (${kase.branches.map(branch => `${branch.path} ${branch.databases.join(',')}`).join('; ')}) and states no databases_differ`);
      continue;
    }
    if (kase.branches.length === 0) faults.push(`${where}: states databases_differ and holds no branch on a database`);
    // A token of the form of an id names an item when its prefix is one that docs/spec uses, so that a name such as UTF-8 is text.
    const prefixes = new Set([...items].map(id => id.slice(0, id.indexOf('-'))));
    const named = [...kase.reason.matchAll(REASON_ID)].map(match => match[0]).filter(id => prefixes.has(id.slice(0, id.indexOf('-'))));
    if (named.length === 0) faults.push(`${where}: databases_differ names no item of docs/spec`);
    for (const id of named) if (!items.has(id)) faults.push(`${where}: databases_differ names ${id}, which docs/spec does not define`);
  }
  return faults;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../..', import.meta.url).pathname;
  const cases = branchedCases(root);
  if (process.argv.includes('--check')) {
    const faults = branchFaults(cases, specItems(root));
    for (const fault of faults) console.error(`recipe-branches: ${fault}`);
    // exitCode, not exit: exit would end the process before a piped stderr takes every fault.
    if (faults.length > 0) process.exitCode = 1;
    else console.log(`recipe-branches: ${cases.length} cases branch on a database, each with its reason`);
  } else {
    for (const kase of cases) {
      console.log(`${kase.file}:${kase.line}\t${kase.id}\t${kase.branches.map(branch => `${branch.path} ${branch.databases.join(',')}`).join('; ')}\t${kase.reason ?? '(no reason)'}`);
    }
  }
}
