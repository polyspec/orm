// The one recipe runner per runtime (FCV-15): a test file that runs a recipe (it names the recipe file, or a PHP extension test
// extends a PHP test that names it) hands the recipe to the runner of its runtime and implements no op; a runner dispatches an op by its full name and refuses an op it does not name; only the runner of a
// runtime refuses an op, so a runtime has no second runner; every op of the recipe schema is the op of a step of a recipe.
// `node scripts/features/recipe-runners.mts` prints each finding and exits 1 when there is one.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keysFile } from './recipe-keys.mts';
import { implementationFiles, implementationTestInventory } from './languages.mts';
import { jsonFiles } from './recipe-files.mts';
import { RUNNER_SOURCES } from '../../tests/conformance/check/recipe_vectors.mts';

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
  php: { call: /\bRecipeCases\b|\b(?:Database|Sqlite)RecipeTestCase\b|\bRecipe::|\bextends \w*Test\b/, files: /^packages\/php\/tests\/Recipe(Model)?\.php$/ },
  'php-extension': { call: /\bRecipeCases\b|\b(?:Database|Sqlite)RecipeTestCase\b|\bRecipe::|\bextends \w*Test\b/, files: /^packages\/php\/tests\/Recipe(Model)?\.php$/ },
  typescript: { call: /\brunRecipe\b/, files: /^packages\/ts\/tests\/recipe(_model)?\.mjs$/ },
  python: { call: /\brecipe_tests\b/, files: /^packages\/python\/tests\/recipe(_model)?\.py$/ },
  rust: {
    call: /\brecipe::\w*trials/,
    files: /^packages\/rust\/tests\/(src\/(recipe|recipe_apply|bench_set_dispatch)\.rs|tests\/all\/[^/]+\/dispatch\.rs)$/,
  },
};

/**
 * VECTOR_RUNNERS are the runner programs of the conformance bodies of each runtime (FCV-15): tests/conformance/check/recipe_vectors.mts
 * runs the generated-method and fixed-clock bodies of tests/conformance/vectors.json through them in every runtime, the PHP extension
 * through the PHP runner, so those bodies are cases that every runtime runs and not native tests.
 */
export const VECTOR_RUNNERS: Record<string, string[]> = RUNNER_SOURCES;

/** A test of one runtime that runs every case of a case file: its file, and the names of its tests that run the cases. */
export type CaseRunner = { file: string; tests: string[] };

/**
 * CASE_RUNNERS are the tests that run every case of a case file whose bodies each runtime writes, in every runtime (FCV-15): each
 * reads the ids and the expected results of the file, runs the body of each id and fails, before any case runs, when the file holds
 * an id that it has no body for or it has a body that the file does not name. So those bodies are cases that every runtime runs and
 * not native tests. `tests` are the names that the FCV-2 rule reads in the file and that run the cases; a TypeScript or Python test
 * named by the id of its case is no such name.
 */
export const CASE_RUNNERS: Record<string, Record<string, CaseRunner>> = {
  'tests/markdown/cases.json': {
    go: { file: 'packages/go/markdownmodel/conformance_test.go', tests: ['TestMarkdownConformance'] },
    php: { file: 'packages/php/tests/MarkdownConformanceTest.php', tests: ['testMarkdownConformance'] },
    'php-extension': { file: 'packages/php-ext/tests/MarkdownConformanceNativeTest.php', tests: ['testMarkdownConformance'] },
    typescript: { file: 'packages/ts/tests/markdown_conformance.mjs', tests: [] },
    python: { file: 'packages/python/tests/markdown_conformance.py', tests: [] },
    rust: { file: 'packages/rust/tests/tests/all/markdown_conformance.rs', tests: ['trials'] },
  },
};

/** The tests of CASE_RUNNERS, each as its file and its name joined by NUL, which the FCV-2 rule reads as no native test. */
export const caseRunnerTests = (): Set<string> =>
  new Set(Object.values(CASE_RUNNERS).flatMap(runners => Object.values(runners).flatMap(({ file, tests }) => tests.map(test => `${file}\0${test}`))));

/**
 * READERS are the test files that read the data of a recipe without running its steps, each with its reason; the other test files
 * whose code names a recipe run it, through the runner of their runtime. A reader that names no recipe is a finding.
 */
export const READERS: Record<string, string> = {
  'packages/ts/tests/recipe_keys.test.mjs': 'the unit test of the key check of the TypeScript runner; its recipes are inputs of that check',
  'packages/python/tests/test_recipe_keys.py': 'the unit test of the key check of the Python runner; its recipes are inputs of that check',
  'packages/rust/tests/tests/all/recipe_keys.rs': 'the unit test of the key check of the Rust runner; its recipes are inputs of that check',
  'packages/php/tests/RecipeKeysTest.php': 'the unit test of the key check of the PHP runner; its recipes are inputs of that check',
  'packages/ts/tests/dbspec-set-edges.mjs': 'reads the cases of tests/dbspec/set-files.json through parseSet, a call that only TypeScript has (DBS-176)',
  'packages/ts/tests/dbspec-begin-exclusive-lock.mjs': 'reads one plan of tests/dbspec/plan-cases.json to hold a lock that only the TypeScript apply test observes',
};

/** A test file of an implementation that runs a recipe, with the recipes it names. */
export type Binding = { implementation: string; test: string; recipes: string[] };
export type Tree = {
  bindings: Binding[];
  // readers are the READERS that name a recipe; a reader that names none is stale.
  readers: string[];
  ops: string[];
  // sources are the texts of the files of the implementations, by path relative to the root.
  sources: Map<string, string>;
  // steps are the ops of the steps of the recipes.
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
  for (const reader of Object.keys(READERS)) if (!tree.readers.includes(reader)) out.push(`${reader}: a reader of READERS that names no recipe`);
  for (const binding of tree.bindings) {
    const runner = RUNNERS[binding.implementation];
    if (runner === undefined) {
      out.push(`${binding.implementation}: no runner is declared for this implementation`);
      continue;
    }
    const text = tree.sources.get(binding.test);
    if (text === undefined) {
      out.push(`${binding.implementation}: the recipe test ${binding.test} does not exist`);
      continue;
    }
    if (!runner.call.test(text)) out.push(`${binding.implementation}: ${binding.test} hands no recipe to the runner of its runtime`);
    for (const op of tree.ops) {
      if (text.includes(`"${op}"`) || text.includes(`'${op}'`)) out.push(`${binding.implementation}: ${binding.test} implements the op ${op}; the runner of its runtime holds it`);
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
  for (const [implementation, files] of Object.entries(VECTOR_RUNNERS)) {
    if (!(implementation in RUNNERS)) out.push(`${implementation}: a vector runner of no runtime`);
    for (const file of files) if (!tree.sources.has(file)) out.push(`${implementation}: the vector runner ${file} does not exist`);
  }
  for (const [cases, runners] of Object.entries(CASE_RUNNERS)) {
    for (const implementation of Object.keys(RUNNERS)) if (!(implementation in runners)) out.push(`${cases}: no case runner of ${implementation}`);
    for (const [implementation, { file }] of Object.entries(runners)) {
      if (!(implementation in RUNNERS)) out.push(`${cases}: a case runner of no runtime, ${implementation}`);
      const text = tree.sources.get(file);
      if (text === undefined) {
        out.push(`${implementation}: the case runner ${file} does not exist`);
        continue;
      }
      // The PHP extension runs the PHP runner, as a test class that extends the class of that runner.
      const phpClass = /([A-Za-z0-9_]+)\.php$/.exec(runners.php?.file ?? '')?.[1];
      const extendsPhp = implementation === 'php-extension' && phpClass !== undefined && new RegExp(`\\bextends \\S*\\b${phpClass}\\b`).test(text);
      if (!extendsPhp && !text.includes(cases.slice(cases.lastIndexOf('/') + 1))) out.push(`${implementation}: the case runner ${file} names no ${cases}`);
    }
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

// codeOf is the text of a source without its comment lines, so that a comment that cites a recipe does not make a recipe test.
const codeOf = (text: string): string => text.split('\n').filter(line => !/^\s*(?:\/\/|#|\*|\/\*)/.test(line)).join('\n');

/** namedRecipes is the recipes of `recipes` that the code of `file` names by their folder and file name (`bind/messages.json`). */
export function namedRecipes(file: string, recipes: readonly string[], sources: Map<string, string>): string[] {
  const code = codeOf(sources.get(file) ?? '');
  return recipes.filter(recipe => code.includes(recipe.split('/').slice(-2).join('/')));
}

/**
 * recipeBindings is the test files of `tests` (by implementation) that run one of `recipes`: a file whose code names a recipe by
 * its folder and file name (`bind/messages.json`), and a PHP extension test that extends a PHP test class whose file does.
 */
export function recipeBindings(tests: Record<string, string[]>, recipes: readonly string[], sources: Map<string, string>): Binding[] {
  const bindings: Binding[] = [];
  for (const [implementation, files] of Object.entries(tests)) {
    for (const test of files) {
      if (Object.hasOwn(READERS, test)) continue;
      const parent = implementation === 'php-extension' ? /\bextends\s+\\?(?:[\w\\]+\\)?(\w+Test)\b/.exec(sources.get(test) ?? '')?.[1] : undefined;
      const named = [...namedRecipes(test, recipes, sources), ...(parent === undefined ? [] : namedRecipes(`packages/php/tests/${parent}.php`, recipes, sources))];
      if (named.length > 0) bindings.push({ implementation, test, recipes: [...new Set(named)] });
    }
  }
  return bindings;
}

// opsOf narrows the key table of the recipe schema to the names of its step ops.
function opsOf(keys: unknown): string[] {
  if (keys === null || typeof keys !== 'object' || !('step' in keys) || keys.step === null || typeof keys.step !== 'object') throw new Error('recipe-keys.json holds no step table');
  return Object.keys(keys.step);
}

// readTree reads the tree of the checkout: the recipes are the JSON files of tests/ and contracts/ whose cases hold steps (another
// JSON file is a table that tests read), and the recipe tests are the test files of contracts/implementations.json that run one.
export function readTree(): Tree {
  const ops = opsOf(JSON.parse(readFileSync(keysFile, 'utf8')));
  const sources = new Map<string, string>();
  sourcesUnder(resolve(root, 'packages'), sources);
  const steps = new Set<string>();
  const recipes: string[] = [];
  for (const file of jsonFiles(root)) {
    const found = stepOps(JSON.parse(readFileSync(resolve(root, file), 'utf8')));
    if (found.size === 0) continue;
    recipes.push(file);
    for (const op of found) steps.add(op);
  }
  const { tests } = implementationTestInventory(implementationFiles(root));
  const readers = Object.keys(READERS).filter(reader => namedRecipes(reader, recipes, sources).length > 0);
  return { bindings: recipeBindings(tests, recipes, sources), readers, ops, sources, steps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findings(readTree());
  for (const finding of found) console.error(`recipe-runners: ${finding}`);
  if (found.length > 0) process.exit(1);
  console.log('ok - recipe-runners');
}
