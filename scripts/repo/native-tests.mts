// The rule of FCV-2 over the inventory of contracts/implementations.json (docs/spec/feature-coverage.md): a behaviour that more than
// one runtime has is the cases of a recipe, and a native test of it stays only where a line of FCV-2 names it with its reason.
import { rustCode } from '../features/rust-code.mts';

/** A feature of contracts/features.json as the rule reads it: its id and every test file it lists. */
export type ListedFeature = { id: string; files: string[] };

/** The inputs of the rule: the test files of each implementation, the features, the test files that run a recipe, FCV-2 and the files. */
export type NativeTestInputs = {
  // tests are the test files of the inventory by implementation: its globs less its support files and its internal tests.
  tests: Record<string, string[]>;
  features: ListedFeature[];
  // recipeTests are the test files that hand a recipe to the runner of their runtime (scripts/features/recipe-runners.mts).
  recipeTests: ReadonlySet<string>;
  spec: string;
  // files are the tracked files, among them the support files of PHP that declare the traits a test class uses.
  files: readonly string[];
  read: (file: string) => string;
};

// The text of FCV-2 in the spec: from its own line to the line of FCV-3.
const fcv2 = (spec: string): string => {
  const start = spec.indexOf('- **FCV-2**');
  const end = spec.indexOf('- **FCV-3**', start);
  return start === -1 || end === -1 ? '' : spec.slice(start, end);
};

// A name in a code span; a list of them is joined by a comma or `and`.
const NAMES = /((?:`[^`\n]+`(?:,? and |, ))*`[^`\n]+`)/.source;
// `in <file>, <names>` names tests of one file: the form `In `file`, `a` and `b` stay as native tests: reason`, and the same words
// inside a longer line that states its reason.
const NAMED_TESTS = new RegExp(`\\b[Ii]n \`([^\`\\n]+)\`, ${NAMES}`, 'g');
// A path of a source file, which is no test name.
const FILE_NAME = /^[\w./-]+\.(?:go|php|[cm]?[jt]s|py|rs|json|md)$/;
// A line that states that something stays native or is a native test.
const STATES_NATIVE = /\bstays? native\b|\bstays? as (?:a )?native tests?\b|\bheld by a native test\b|\bnative tests? stays?\b/;

/** A line of FCV-2 that keeps native tests: the tests it names by file, and whether its reason follows a colon. */
export type NativeLine = { line: string; tests: { file: string; name: string }[]; reason: boolean };

/** nativeLines reads the items below the line of FCV-2 that state a native test, each with the tests it names in the form `in `file`, `test``. */
export const nativeLines = (spec: string): NativeLine[] =>
  fcv2(spec).split('\n').filter(line => /^\s+- /.test(line) && STATES_NATIVE.test(line)).map(line => ({
    line: line.trim(),
    tests: [...line.matchAll(NAMED_TESTS)].flatMap(([, file = '', names = '']) => {
      const named = [...names.matchAll(/`([^`\n]+)`/g)].map(([, name = '']) => name);
      // A list of paths, such as `in `a.go`, `b.php` and `c.mjs``, names files and no test.
      return named.some(name => FILE_NAME.test(name)) ? [] : named.map(name => ({ file, name }));
    }),
    reason: /:\s+\S/.test(line.replace(/`[^`\n]*`/g, '')),
  }));

// The tests that a test file declares, as each runner names them. A name that is not a literal, such as a node test named from a
// loop or a Rust trial named from a fixture, is not read, so the rule never finds a test that is not there.
const declared = (implementation: string, text: string): string[] => {
  const read = (pattern: RegExp, source: string = text) => [...source.matchAll(pattern)].map(match => (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1'));
  if (implementation === 'go') return read(/^func ((?:Test|Fuzz)\w*)\(/gm).filter(name => name !== 'TestMain');
  if (implementation === 'php' || implementation === 'php-extension') return read(/public (?:static )?function (test\w*)\(/g);
  if (implementation === 'python') return read(/^(?: {4})?(?:async )?def (test_\w+)\(/gm);
  if (implementation === 'typescript') return read(/(?<![.\w])(?:caseTest|test|it)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g);
  // Rust: a function under a test attribute, and the functions that `native_trials!("group": a, b)` makes trials of.
  const code = rustCode(text);
  const attributed = read(/#\[(?:tokio::)?test\b[^\]]*\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([^)]*\))? )?(?:async )?fn (\w+)/g, code);
  const trials = [...text.matchAll(/\bnative_trials!\(\s*"[^"]*"\s*:\s*([\w\s,]+?)\s*\)/g)]
    .flatMap(([, names = '']) => names.split(',').map(name => name.trim()).filter(Boolean));
  return [...attributed, ...trials];
};

// The tests of a file: a PHP class holds the tests of the traits it uses, which live in support files; a test that a class
// inherits is judged in the file of its parent.
const fileTests = (implementation: string, file: string, read: (path: string) => string, traits: Map<string, string>): string[] => {
  const text = read(file);
  const own = declared(implementation, text);
  if (implementation !== 'php' && implementation !== 'php-extension') return own;
  return [...own, ...[...text.matchAll(/^ {4}use ([\w\\, ]+);/gm)]
    .flatMap(([, names = '']) => names.split(','))
    .flatMap(name => {
      const trait = traits.get(name.trim().split('\\').at(-1) ?? '');
      return trait === undefined || trait === file ? [] : fileTests(implementation, trait, read, traits);
    })];
};

/** nativeTests is the native tests of each listed file, and the shared features that list each file of a shared behaviour. */
export const nativeTests = ({ tests, features, recipeTests, files: tracked, read }: Omit<NativeTestInputs, 'spec'>): { native: Map<string, Set<string>>; sharedBy: Map<string, string[]> } => {
  const implementationOf = new Map(Object.entries(tests).flatMap(([implementation, files]) => files.map((file): [string, string] => [file, implementation])));
  // The shared features that list each test file.
  const sharedBy = new Map<string, string[]>();
  for (const feature of features) {
    const files = [...new Set(feature.files)].filter(file => implementationOf.has(file));
    if (new Set(files.map(file => implementationOf.get(file))).size < 2) continue;
    for (const file of files) sharedBy.set(file, [...(sharedBy.get(file) ?? []), feature.id]);
  }
  const traits = new Map(tracked
    .filter(file => /^packages\/php(-ext)?\/tests\/.*\.php$/.test(file))
    .flatMap(file => [...read(file).matchAll(/^\s*trait (\w+)/gm)].map(([, name = '']): [string, string] => [name, file])));
  // The native tests: the tests of each listed file that runs no recipe, of a shared feature or of one runtime.
  const native = new Map<string, Set<string>>();
  for (const file of new Set(features.flatMap(feature => feature.files))) {
    const implementation = implementationOf.get(file);
    if (implementation === undefined || recipeTests.has(file)) continue;
    native.set(file, new Set(fileTests(implementation, file, read, traits)));
  }
  return { native, sharedBy };
};

/**
 * nativeTestErrors names each native test of a shared behaviour that no line of FCV-2 names, and each line of FCV-2 that names no
 * such test. A native test is a test of a file of the inventory that a feature lists and that hands no recipe to the runner of its
 * runtime; its behaviour is shared when the feature lists the test files of more than one implementation, and a feature that only
 * one implementation lists is the behaviour of that runtime. An internal test with its reason and a support file are not in the
 * inventory. A line of FCV-2 names a test by `in `file`, `test``, and states its reason after a colon.
 */
export const nativeTestErrors = (inputs: NativeTestInputs): string[] => {
  const { native, sharedBy } = nativeTests(inputs);
  const lines = nativeLines(inputs.spec);
  const stated = new Set(lines.flatMap(line => line.tests.map(({ file, name }) => `${file}\0${name}`)));
  const errors: string[] = [];
  for (const [file, names] of native) {
    if (!sharedBy.has(file)) continue;
    for (const name of names) {
      if (!stated.has(`${file}\0${name}`)) errors.push(`${file}: the native test ${name} of the shared feature ${(sharedBy.get(file) ?? []).join(', ')} runs no recipe, and no line of FCV-2 names it; make it the cases of a recipe (FCV-2 to FCV-4), or state why it stays native in FCV-2 of docs/spec/feature-coverage.md as in \`${file}\`, \`${name}\``);
    }
  }
  for (const { line, tests: named, reason } of lines) {
    const head = line.slice(0, 120);
    if (named.length === 0) errors.push(`docs/spec/feature-coverage.md FCV-2 line "${head}" names no native test; name each test it keeps as in \`file\`, \`test\`, or remove the line`);
    else if (!reason) errors.push(`docs/spec/feature-coverage.md FCV-2 line "${head}" states no reason after a colon; state why its tests stay native`);
    for (const { file, name } of named) {
      const names = native.get(file);
      if (names === undefined) errors.push(`docs/spec/feature-coverage.md FCV-2 keeps native tests of ${file}, which is no native test file (a recipe test, a support file, an internal test, a file that no feature lists or no test file); remove the name from the line`);
      else if (!names.has(name)) errors.push(`docs/spec/feature-coverage.md FCV-2 keeps the native test ${name} of ${file}, and that file holds no such test; remove the name from the line`);
    }
  }
  return errors;
};
