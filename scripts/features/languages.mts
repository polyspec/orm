import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The language set of the feature checks is the client profile of config/parity.json, the one source of it.
const parity = JSON.parse(readFileSync(resolve(new URL('../..', import.meta.url).pathname, 'config/parity.json'), 'utf8')) as {
  profiles: { name: string; implementations: string[] }[];
};

/** The implementations of the client profile, in the order config/parity.json declares them. */
export function clientLanguages(): string[] {
  const profile = parity.profiles.find(entry => entry.name === 'client');
  if (!profile) throw new Error('config/parity.json has no client profile');
  return [...profile.implementations];
}
