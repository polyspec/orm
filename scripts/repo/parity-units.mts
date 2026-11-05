// The rule of FCV-2 over config/parity.json (docs/spec/feature-coverage.md): a behaviour that more than one runtime has is
// the cases of a recipe, and a native test stays only for what FCV-2 states with its reason.

/** The fields of a binding of config/parity.json that the rule reads: a feature unit names `id`, a suite unit `symbol`. */
type ParityBinding = { implementation: string; test?: string; id?: string; symbol?: string };
/** The fields of a unit of config/parity.json that the rule reads. */
type ParityUnit = { id: string; kind?: string; owner?: unknown; file?: string; cases?: string; bindings?: ParityBinding[] };

// The text of FCV-2 in the spec: from its own line to the line of FCV-3.
const fcv2 = (spec: string): string => {
  const start = spec.indexOf('- **FCV-2**');
  const end = spec.indexOf('- **FCV-3**', start);
  return start === -1 || end === -1 ? '' : spec.slice(start, end);
};

/** nativeExceptions reads the units that FCV-2 states to stay native, each with the reason it states after the colon. */
export const nativeExceptions = (spec: string): { id: string; reason: string }[] => {
  const statement = /((?:`[a-z0-9-]+`(?:, | and )?)+)(?: \([^)]*\))? stays? native\b[^:.]*: *([^\n.]+)/g;
  return [...fcv2(spec).matchAll(statement)].flatMap(([, names = '', reason = '']) =>
    [...names.matchAll(/`([a-z0-9-]+)`/g)].map(([, id = '']) => ({ id, reason: reason.trim() })));
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const field = (value: unknown, key: string): unknown => isRecord(value) ? value[key] : undefined;

// The case names of a suite file, by the `cases` expression of its unit (the forms of config/parity.json).
const caseNames = (content: unknown, expression: string | undefined): unknown[] => {
  if (expression === '$.cases[*].id') return list(field(content, 'cases')).map(item => field(item, 'id'));
  if (expression === '$.vectors[*].name') return list(field(content, 'vectors')).map(item => field(item, 'name'));
  if (expression === '$.cases[*]') return list(field(content, 'cases'));
  const database = /^\$\.cases_on\.(mysql|postgres|sqlite)\[\*\]$/.exec(expression ?? '')?.[1];
  if (database !== undefined) return list(field(field(content, 'cases_on'), database));
  const cases = field(content, 'cases');
  return expression === '$.cases.~' && isRecord(cases) ? Object.keys(cases) : [];
};

// The last part of a test name, with no namespace and no data set: what a suite symbol and a feature binding of PHP share.
const namedEntry = (name: string): string => (name.split('\\').at(-1) ?? name).replace(/ with data set .*$/, '');

// heldByRecipe returns the test of `binding` that runs the cases of a suite: the entry a suite unit binds, a case below that
// entry, or a case of the suite file when the suite binds the whole test file. A native test next to them in the file is not held.
const heldByRecipe = (binding: ParityBinding, suites: ParityUnit[], readSuite: (file: string) => unknown): boolean =>
  suites.some(suite => (suite.bindings ?? []).some(entry => {
    if (entry.implementation !== binding.implementation || entry.test !== binding.test || binding.id === undefined) return false;
    if (entry.symbol === undefined) return suite.file !== undefined && caseNames(readSuite(suite.file), suite.cases).includes(binding.id);
    const symbol = namedEntry(entry.symbol);
    const name = namedEntry(binding.id);
    return name === symbol || name.startsWith(`${symbol}/`) || name.startsWith(`${symbol}::`);
  }));

/**
 * nativeBoundUnitErrors names each feature unit of config/parity.json with no owner that binds a native test and that FCV-2
 * does not except, with the implementations of its native tests, and each exception of FCV-2 that names no unit. A feature
 * unit with no owner is a shared behaviour whatever the number of its bindings, so a binding removed from one runtime does not
 * leave the rule. A binding that runs a case of a suite is no native test; an owner unit is the behaviour of one runtime, and
 * an API unit binds symbols, not tests.
 */
export const nativeBoundUnitErrors = (units: ParityUnit[], spec: string, readSuite: (file: string) => unknown): string[] => {
  const exceptions = nativeExceptions(spec).map(({ id }) => id);
  const known = new Set(units.map(({ id }) => id));
  const suites = units.filter(unit => unit.kind === 'suite');
  const nativeBindings = (unit: ParityUnit) => (unit.bindings ?? []).filter(binding => !heldByRecipe(binding, suites, readSuite));
  return [
    ...units
      .filter(unit => unit.kind === 'feature' && unit.owner === undefined && !exceptions.includes(unit.id) && nativeBindings(unit).length > 0)
      .map(unit => `config/parity.json unit ${unit.id} is bound natively in ${[...new Set(nativeBindings(unit).map(({ implementation }) => implementation))].join(', ')}, and no recipe case holds it; make it the cases of a recipe (FCV-2 to FCV-4), or state why it stays native in FCV-2 of docs/spec/feature-coverage.md`),
    ...exceptions
      .filter(id => !known.has(id))
      .map(id => `docs/spec/feature-coverage.md FCV-2 states that ${id} stays native, and config/parity.json has no such unit; remove the line or name the unit`),
  ];
};

// The tests that a test file declares, as each runner names them. A name that is not a literal, such as a node test named from a loop, is
// not read, so the rule never finds a test that is not there; the suite of such a file is judged by the parity tool.
const declared = (implementation: string, text: string): string[] => {
  const read = (pattern: RegExp) => [...text.matchAll(pattern)].map(match => (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1'));
  if (implementation === 'go') return read(/^func ((?:Test|Fuzz)\w*)\(/gm).filter(name => name !== 'TestMain');
  if (implementation === 'php' || implementation === 'php-extension') return read(/public (?:static )?function (test\w*)\(/g);
  if (implementation === 'python') return read(/^(?: {4})?(?:async )?def (test_\w+)\(/gm);
  if (implementation === 'typescript') return read(/(?<![.\w])(?:caseTest|test|it)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g);
  return read(/#\[(?:tokio::)?test[^\]]*\](?:\s*#\[[^\n]*\])*\s*(?:pub )?(?:async )?fn (\w+)\(/g);
};

// The name of a test in a binding, whatever the form of the runner: PHP `Namespace\Class::testA with data set "x"`, Go `TestA/case`, Rust `a::b::name`.
const bindingLeaf = (id: string): string => {
  const entry = namedEntry(id).split('::').at(-1) ?? id;
  return /^Test\w*\//.test(entry) ? entry.split('/')[0] ?? entry : entry;
};

// A PHP class holds the tests of the traits it uses, which live in support files; a test that a class inherits is judged in the file of its parent.
const fileTests = (implementation: string, file: string, read: (path: string) => string, traits: Map<string, string>): string[] => {
  const text = read(file);
  const own = declared(implementation, text);
  if (implementation !== 'php' && implementation !== 'php-extension') return own;
  return [...own, ...[...text.matchAll(/^ {4}use ([\w\\, ]+);/gm)]
    .flatMap(([, names = '']) => names.split(','))
    .flatMap(name => {
      const trait = traits.get(name.trim().split('\\').at(-1) ?? '');
      return trait === undefined ? [] : fileTests(implementation, trait, read, traits);
    })];
};

/** nativeTestLines reads the lines of FCV-2 that keep native tests of one file by name, each with the reason after its colon. */
export const nativeTestLines = (spec: string): { file: string; names: string[]; reason: string }[] =>
  [...fcv2(spec).matchAll(/^\s*- In `([^`]+)`, ((?:`[^`]+`(?:, | and )?)+) stays? as (?:a )?native tests?: *(\S[^\n]*)$/gm)].map(([, file = '', names = '', reason = '']) => ({
    file,
    names: [...names.matchAll(/`([^`]+)`/g)].map(([, name = '']) => name),
    reason,
  }));

/**
 * unboundNativeTestErrors names each test of a file that a binding of config/parity.json names, when no binding names that test and no line of
 * FCV-2 keeps it, and each name of such a line that the file does not hold. The parity tool checks a file as a whole, so a test can lose its binding
 * there or never have had one and still run. A suite bound with no symbol is a whole file whose cases the parity tool compares with its recipe.
 */
export const unboundNativeTestErrors = (units: ParityUnit[], spec: string, files: string[], read: (path: string) => string): string[] => {
  const traits = new Map(files.filter(file => /^packages\/php(-ext)?\/tests\/.*\.php$/.test(file)).flatMap(file =>
    [...read(file).matchAll(/^\s*trait (\w+)/gm)].map(([, name = '']): [string, string] => [name, file])));
  const bound = new Map<string, { implementation: string; names: Set<string>; whole: boolean }>();
  for (const unit of units) {
    for (const binding of unit.bindings ?? []) {
      if (binding.test === undefined) continue;
      const entry = bound.get(binding.test) ?? { implementation: binding.implementation, names: new Set<string>(), whole: false };
      const name = binding.id ?? binding.symbol;
      if (name === undefined) entry.whole = true;
      else entry.names.add(bindingLeaf(name));
      bound.set(binding.test, entry);
    }
  }
  const lines = nativeTestLines(spec);
  const errors: string[] = [];
  for (const [file, { implementation, names, whole }] of bound) {
    if (whole) continue;
    const kept = new Set(lines.filter(line => line.file === file).flatMap(line => line.names));
    const tests = new Set(fileTests(implementation, file, read, traits));
    for (const test of tests) {
      if (!names.has(test) && !kept.has(test)) errors.push(`${file}: the native test ${test} has no binding in config/parity.json and no line of FCV-2; make it the cases of a recipe (FCV-2 to FCV-4), bind it to the unit that states it, or state why it stays native in FCV-2 of docs/spec/feature-coverage.md`);
    }
    for (const test of kept) {
      if (!tests.has(test)) errors.push(`docs/spec/feature-coverage.md FCV-2 keeps the native test ${test} of ${file}, and that file holds no such test; remove the name from the line`);
    }
  }
  for (const { file } of lines) {
    if (!bound.has(file)) errors.push(`docs/spec/feature-coverage.md FCV-2 keeps native tests of ${file}, and no binding of config/parity.json names that file; remove the line or bind the file`);
  }
  return errors;
};
