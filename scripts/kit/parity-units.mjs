// The rules of the language-parity check that compare the units with the tree, without running anything: R1 (an API unit
// without the exported symbol of an implementation), R2 (a suite without a binding of an implementation), R4 (a suite file
// that no unit declares), R5 (a test file that no binding runs), R6 (a binding test outside its implementation), R8 (an
// exclusion) and R11 (an exported symbol that no unit declares).
import { matchesAny } from './glob.mjs';
import { finding, within } from './parity-declaration.mjs';

/** The pairs of each unit of `kind` with each implementation of its profile that no exclusion removes, in declaration order. */
export function pairs(model, kind) {
  return model.config.units.filter(unit => unit.kind === kind)
    .flatMap(unit => model.members(unit).filter(name => !model.exclusion(unit, name)).map(name => ({ unit, implementation: model.implementations.get(name) })));
}

/** R1: each API unit has an exported symbol in each implementation of its profile. */
export function missingImplementations(model) {
  return pairs(model, 'api').flatMap(({ unit, implementation }) => {
    const where = { unit: unit.id, implementation: implementation.name, place: implementation.symbols };
    const declared = unit.symbols.find(entry => entry.implementation === implementation.name);
    if (!declared) return [finding('R1', `the API unit ${unit.id} declares no symbol of ${implementation.name}`, where)];
    const exported = model.snapshots.get(implementation.name)?.get(declared.symbol);
    if (exported === undefined) return [finding('R1', `${declared.symbol} is not in ${implementation.symbols}`, where)];
    return exported ? [] : [finding('R1', `${declared.symbol} is not exported`, where)];
  });
}

/** R2: each suite unit has a binding of each implementation of its profile. */
export function missingBindings(model) {
  return pairs(model, 'suite')
    .filter(({ unit, implementation }) => !unit.bindings.some(entry => entry.implementation === implementation.name))
    .map(({ unit, implementation }) => finding('R2', `${unit.file} has no binding of ${implementation.name}`, { unit: unit.id, implementation: implementation.name, place: unit.file }));
}

/** R4: each file of the suite globs is the file of a suite unit. */
export function undeclaredSuites(model, files) {
  const declared = new Set(model.config.units.map(unit => unit.file));
  return [...files].filter(file => matchesAny(model.config.suites ?? [], file) && !declared.has(file))
    .map(file => finding('R4', 'the vector file is the file of no suite unit; declare a unit for it', { place: file }));
}

/** Whether `file` is a support file of an implementation of `runner`: it holds no test of that runner. */
const supportFile = (model, runner, file) => model.config.implementations.some(implementation => implementation.runner === runner && matchesAny(implementation.support ?? [], file));

/** R5: each test file of an implementation, except its support files, is the test of a binding of that implementation. */
export function undeclaredTests(model, files) {
  return model.config.implementations.flatMap((implementation) => {
    const bound = new Set(model.config.units.flatMap(unit => unit.bindings ?? []).filter(entry => entry.implementation === implementation.name).map(entry => entry.test));
    return [...files].filter(file => matchesAny(implementation.tests, file) && !bound.has(file) && !matchesAny(implementation.support ?? [], file))
      .map(file => finding('R5', `the test file of ${implementation.name} is the test of no binding, so no check runs it`, { implementation: implementation.name, place: file }));
  });
}

// The vendored tools and tests of kit, which test kit and belong to no implementation.
const KIT_DIRECTORIES = ['scripts/kit', 'tests/kit'];

/**
 * R6: the test of each binding lies in a root of its implementation or in a comparator root, and every other file of the test
 * patterns of a runner, except a support file of an implementation of that runner, lies in a root of an implementation of that
 * runner or in a comparator root.
 */
export function misplacedTests(model, files) {
  const comparators = model.config.comparators ?? [];
  const inComparator = file => comparators.some(root => within(root, file));
  const bound = model.config.units.flatMap(unit => (unit.bindings ?? []).map(entry => ({ unit, entry })));
  const bindings = bound.flatMap(({ unit, entry }) => {
    const roots = model.implementations.get(entry.implementation).roots;
    return roots.some(root => within(root, entry.test)) || inComparator(entry.test) ? [] : [finding('R6', `the test lies outside ${roots.join(', ')}, the roots of ${entry.implementation}`, { unit: unit.id, implementation: entry.implementation, place: entry.test })];
  });
  const tests = new Set(bound.map(({ entry }) => entry.test));
  const patterns = [...files].filter(file => !tests.has(file) && !inComparator(file) && !KIT_DIRECTORIES.some(root => within(root, file))).flatMap((file) => {
    const runners = model.config.testPatterns.filter(pattern => matchesAny(pattern.globs, file)).map(pattern => pattern.runner);
    return [...new Set(runners)].filter(runner => !supportFile(model, runner, file)).flatMap((runner) => {
      const roots = model.config.implementations.filter(entry => entry.runner === runner).flatMap(entry => entry.roots);
      if (roots.some(root => within(root, file))) return [];
      return [finding('R6', `a ${runner} test outside ${roots.join(', ') || 'nothing'}, the roots of the ${runner} implementations, and outside ${comparators.join(', ') || 'nothing'}, the comparator roots; move it into the package of its implementation`, { place: file })];
    });
  });
  return [...bindings, ...patterns];
}

/** R8: each exclusion, which never counts as holding the unit. */
export function exclusions(model) {
  return (model.config.exclusions ?? []).map(entry => finding('R8', `excluded: ${entry.reason} (${entry.item})`, { unit: entry.unit, implementation: entry.implementation }));
}

/** R11: each exported symbol of a snapshot is the symbol of an API unit or a native-only entry of its implementation. */
export function undeclaredPublic(model) {
  return model.config.implementations.flatMap((implementation) => {
    const declared = new Set([
      ...model.config.units.flatMap(unit => unit.symbols ?? []).filter(entry => entry.implementation === implementation.name).map(entry => entry.symbol),
      ...(model.config.nativeOnly ?? []).filter(entry => entry.implementation === implementation.name).map(entry => entry.symbol),
    ]);
    return [...(model.snapshots.get(implementation.name) ?? [])].filter(([id, exported]) => exported && !declared.has(id))
      .map(([id]) => finding('R11', `${id} is exported, and no API unit and no nativeOnly entry declares it`, { implementation: implementation.name, place: implementation.symbols }));
  });
}
