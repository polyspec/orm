import { resolve } from 'node:path';
import { readParityConfig } from '../json/formats.mts';

// The language set of the feature checks is the declared implementations of config/parity.json, the one source of it; a
// feature's languages are the implementations that its parity units bind.
const parity = readParityConfig(resolve(new URL('../..', import.meta.url).pathname, 'config/parity.json'));

/** The declared implementations, in the order config/parity.json declares them. */
export function implementationLanguages(): string[] {
  return parity.implementations.map(entry => entry.name);
}

const units = new Map(parity.units.map(unit => [unit.id, unit]));

/** unknownParityUnits names the ids that config/parity.json does not declare. */
export function unknownParityUnits(ids: string[]): string[] {
  return ids.filter(id => !units.has(id));
}

/** featureLanguages is the implementations that the parity units bind, in the order of implementationLanguages(). */
export function featureLanguages(ids: string[]): string[] {
  const bound = new Set(ids.flatMap(id => (units.get(id)?.bindings ?? []).map(binding => binding.implementation)));
  return implementationLanguages().filter(language => bound.has(language));
}

/** unitTests is the test files that the parity unit of id binds for one implementation. */
export function unitTests(id: string, implementation: string): string[] {
  return (units.get(id)?.bindings ?? [])
    .filter(binding => binding.implementation === implementation)
    .map(binding => binding.test)
    .filter((test): test is string => test !== undefined);
}
