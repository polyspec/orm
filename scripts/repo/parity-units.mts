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
