// The one recipe runner per runtime (FCV-15): the binding of a recipe suite unit hands its file to the runner of its runtime
// and implements no op; a runner dispatches an op by its full name and refuses an op it does not name; only the runner of a
// runtime refuses an op, so a runtime has no second runner; every op of the recipe schema is the op of a step of a recipe.
// `node scripts/features/recipe-runners.mts` prints each finding and exits 1 when there is one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keysFile } from './recipe-keys.mts';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

type Runner = {
  // call is what a binding file holds when it hands a recipe to this runner.
  call: RegExp;
  // files are the sources of the runner. A Rust trial binary includes the generated models of its fixture, which the runner
  // cannot name, so the dispatcher of those models is part of the runner.
  files: RegExp;
};

export const RUNNERS: { [implementation: string]: Runner } = {
  go: { call: /\brecipe\.Run/, files: /^packages\/go\/internal\/recipe\/[^/]+\.go$/ },
  php: { call: /\bRecipeCases\b|\bDatabaseRecipeTestCase\b|\bRecipe::|\bextends \w*Test\b/, files: /^packages\/php\/tests\/Recipe(Model)?\.php$/ },
  'php-extension': { call: /\bRecipeCases\b|\bDatabaseRecipeTestCase\b|\bRecipe::|\bextends \w*Test\b/, files: /^packages\/php\/tests\/Recipe(Model)?\.php$/ },
  typescript: { call: /\brunRecipe\b/, files: /^packages\/ts\/tests\/recipe(_model)?\.mjs$/ },
  python: { call: /\brecipe_tests\b/, files: /^packages\/python\/tests\/recipe(_model)?\.py$/ },
  rust: {
    call: /\brecipe::\w*trials/,
    files: /^packages\/rust\/tests\/(src\/(recipe|recipe_apply|bench_set_dispatch)\.rs|tests\/all\/[^/]+\/dispatch\.rs)$/,
  },
};

export type Unit = { id: string; kind: string; file?: string; recipe?: boolean; bindings?: { implementation: string; test: string }[] };
export type Tree = {
  units: Unit[];
  ops: string[];
  // sources are the texts of the files of the implementations, by path relative to the root.
  sources: Map<string, string>;
  // steps are the ops of the steps of the recipes of the suite units.
  steps: Set<string>;
};

// stepOps collects the op of each step, nested steps of a transaction among them.
export function stepOps(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) stepOps(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value) as [string, unknown][]) {
      if (key === 'steps' && Array.isArray(item)) {
        for (const step of item as unknown[]) {
          const op = step !== null && typeof step === 'object' && 'op' in step ? step.op : undefined;
          if (typeof op === 'string') found.add(op);
        }
      }
      stepOps(item, found);
    }
  }
  return found;
}

// findings is what the tree breaks of FCV-15, one text per defect.
export function findings(tree: Tree): string[] {
  const out: string[] = [];
  for (const unit of tree.units) {
    if (unit.kind !== 'suite' || unit.recipe !== true) continue;
    for (const binding of unit.bindings ?? []) {
      const runner = RUNNERS[binding.implementation];
      if (runner === undefined) {
        out.push(`${unit.id} ${binding.implementation}: no runner is declared for this implementation`);
        continue;
      }
      const text = tree.sources.get(binding.test);
      if (text === undefined) {
        out.push(`${unit.id} ${binding.implementation}: the binding file ${binding.test} does not exist`);
        continue;
      }
      if (!runner.call.test(text)) out.push(`${unit.id} ${binding.implementation}: ${binding.test} hands no recipe to the runner of its runtime`);
      for (const op of tree.ops) {
        if (text.includes(`"${op}"`) || text.includes(`'${op}'`)) out.push(`${unit.id} ${binding.implementation}: ${binding.test} implements the op ${op}; the runner of its runtime holds it`);
      }
    }
  }
  for (const [implementation, runner] of Object.entries(RUNNERS)) {
    const own = [...tree.sources].filter(([path]) => runner.files.test(path));
    if (own.length === 0) out.push(`${implementation}: the runner has no source file`);
    else if (!own.some(([, text]) => text.includes('OP_UNKNOWN'))) out.push(`${implementation}: the runner refuses no op it does not name (OP_UNKNOWN)`);
    for (const [path, text] of own) {
      if (/(HasPrefix|startsWith|str_starts_with|startswith|starts_with)\([^)\n]*\b[oO]p\b[^)\n]*\)|\b[oO]p\b[^\n]{0,20}\.(startsWith|startswith|starts_with)\(/.test(text)) {
        out.push(`${implementation}: ${path} dispatches an op by a prefix of its name`);
      }
    }
  }
  for (const [path, text] of tree.sources) {
    const owned = Object.values(RUNNERS).some(runner => runner.files.test(path));
    if (!owned && text.includes('OP_UNKNOWN') && !/(_test\.go|[./]test\.m?[jt]s|Test\.php|tests?\.rs)$/.test(path)) out.push(`${path}: refuses an op outside the runner of its runtime`);
  }
  for (const op of tree.ops) {
    if (!tree.steps.has(op)) out.push(`the schema op ${op} is the op of no step of a recipe`);
  }
  return out;
}

// sourcesUnder reads the sources of the implementations, without build output.
function sourcesUnder(directory: string, sources: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['target', 'node_modules', 'vendor', '.venv', 'dist', '__pycache__'].includes(entry.name)) sourcesUnder(path, sources);
    } else if (/\.(go|mjs|mts|py|php|rs)$/.test(entry.name)) {
      sources.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  }
}

// isUnit tells a unit of the parity declarations from another value.
function isUnit(value: unknown): value is Unit {
  return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && 'kind' in value && typeof value.kind === 'string';
}

// unitsOf narrows the parity declarations to their units.
function unitsOf(parity: unknown): Unit[] {
  if (parity === null || typeof parity !== 'object' || !('units' in parity) || !Array.isArray(parity.units)) throw new Error('config/parity.json holds no list of units');
  return parity.units.filter(isUnit);
}

// opsOf narrows the key table of the recipe schema to the names of its step ops.
function opsOf(keys: unknown): string[] {
  if (keys === null || typeof keys !== 'object' || !('step' in keys) || keys.step === null || typeof keys.step !== 'object') throw new Error('recipe-keys.json holds no step table');
  return Object.keys(keys.step);
}

// readTree reads the tree of the checkout.
export function readTree(): Tree {
  const units = unitsOf(JSON.parse(readFileSync(resolve(root, 'config/parity.json'), 'utf8')));
  const ops = opsOf(JSON.parse(readFileSync(keysFile, 'utf8')));
  const sources = new Map<string, string>();
  sourcesUnder(resolve(root, 'packages'), sources);
  const steps = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== 'suite' || !unit.file?.endsWith('.json') || !existsSync(resolve(root, unit.file))) continue;
    const recipe: unknown = JSON.parse(readFileSync(resolve(root, unit.file), 'utf8'));
    // A recipe is a file of the recipe schema or a file whose cases hold steps; another JSON file of a suite is a table its tests read.
    unit.recipe = stepOps(recipe).size > 0;
    stepOps(recipe, steps);
  }
  return { units, ops, sources, steps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findings(readTree());
  for (const finding of found) console.error(`recipe-runners: ${finding}`);
  if (found.length > 0) process.exit(1);
  console.log('ok - recipe-runners');
}
