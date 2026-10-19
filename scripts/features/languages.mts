import { resolve } from 'node:path';
import { readParityConfig } from '../json/formats.mts';

// The language set of the feature checks is the client profile of config/parity.json, the one source of it; a feature's
// languages are the client implementations that its parity units bind.
const parity = readParityConfig(resolve(new URL('../..', import.meta.url).pathname, 'config/parity.json'));

/** The implementations of the client profile, in the order config/parity.json declares them. */
export function clientLanguages(): string[] {
  const profile = parity.profiles.find(entry => entry.name === 'client');
  if (!profile) throw new Error('config/parity.json has no client profile');
  return [...profile.implementations];
}

const units = new Map(parity.units.map(unit => [unit.id, unit]));

/** unknownParityUnits names the ids that config/parity.json does not declare. */
export function unknownParityUnits(ids: string[]): string[] {
  return ids.filter(id => !units.has(id));
}

/** featureLanguages is the client languages that the parity units bind, in the order of clientLanguages(). */
export function featureLanguages(ids: string[]): string[] {
  const bound = new Set(ids.flatMap(id => (units.get(id)?.bindings ?? []).map(binding => binding.implementation)));
  return clientLanguages().filter(language => bound.has(language));
}

/** unitTests is the test files that the parity unit of id binds for one implementation. */
export function unitTests(id: string, implementation: string): string[] {
  return (units.get(id)?.bindings ?? [])
    .filter(binding => binding.implementation === implementation)
    .map(binding => binding.test)
    .filter((test): test is string => test !== undefined);
}
