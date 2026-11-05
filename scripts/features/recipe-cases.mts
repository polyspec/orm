// The key cases_on of a recipe with a case-level only (FCV-12). The parity tool of kit reads the cases of a suite unit by a path of keys, which holds
// no condition on only, while a runner registers a case only on the databases it names. So such a recipe holds the ids that each database runs, written
// by this script from its cases, and its units select their database's list; scripts/features/recipes.test.mts refuses a list that differs.
//
// Usage: node scripts/features/recipe-cases.mts
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecipeCases, type RecipeCases } from '../json/formats.mts';
import { parseJsonValue } from '../json/schema.mts';

type CasesOn = { mysql: string[]; postgres: string[]; sqlite: string[] };

const root = fileURLToPath(new URL('../..', import.meta.url));
const KEY = ',\n  "cases_on": ';

/** The case ids that each database runs, in the recipe's order. */
export function casesOn(cases: RecipeCases['cases']): CasesOn {
  const on = (database: string) => cases.filter(item => item.only === undefined || item.only.includes(database)).map(item => item.id);
  return { mysql: on('mysql'), postgres: on('postgres'), sqlite: on('sqlite') };
}

/** The text of a recipe with its key cases_on, which is the last key, as its cases state it. */
export function withCasesOn(text: string): string {
  const at = text.indexOf(KEY);
  const body = at === -1 ? text.slice(0, text.lastIndexOf('\n}')) : text.slice(0, at);
  const lists = JSON.stringify(casesOn(parseRecipeCases(`${body}\n}`, 'recipe').cases), null, 2).replaceAll('\n', '\n  ');
  return `${body}${KEY}${lists}\n}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of globSync('contracts/fixtures/*/*.json', { cwd: root })) {
    const text = readFileSync(resolve(root, file), 'utf8');
    const value = parseJsonValue(text, file);
    const items = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.cases : undefined;
    if (!Array.isArray(items) || !items.some(item => item !== null && typeof item === 'object' && 'only' in item)) continue;
    // A recipe of one database has one unit, on that database, whose cases all run there.
    if (Object.values(casesOn(parseRecipeCases(text, file).cases)).some(list => list.length === 0)) continue;
    writeFileSync(resolve(root, file), withCasesOn(text));
  }
}
