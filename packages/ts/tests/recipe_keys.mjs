// The key check of the recipe format (FCV-2 to FCV-4, T334-3-5-6): the TypeScript loader refuses a file, case or step key that
// the key table beside the recipe's schema does not hold, and each op that the table does not hold, by name, before any case
// runs. It imports nothing from the built client, so its unit test runs without a build.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// keyTable reads the key table beside the schema that the $schema of the recipe at path names, relative to the recipe's directory.
export function keyTable(path, schema) {
  return JSON.parse(readFileSync(resolve(root, dirname(path), dirname(schema), 'recipe-keys.json'), 'utf8'));
}

// unknownKey returns the first key of object, in sorted order, that keys does not hold.
const unknownKey = (object, keys) => Object.keys(object).sort().find(key => !keys.includes(key));

// checkKeys refuses the recipe text at path (relative to the repository root) on its first key or op that its table does not hold.
export function checkKeys(path, text) {
  const recipe = JSON.parse(text);
  if (typeof recipe.$schema !== 'string' || recipe.$schema === '') throw new Error(`recipe ${path}: no $schema names the recipe key table`);
  const table = keyTable(path, recipe.$schema);
  const file = unknownKey(recipe, table.file);
  if (file !== undefined) throw new Error(`recipe ${path}: unknown key ${file}`);
  if (!Array.isArray(recipe.cases)) throw new Error(`recipe ${path}: cases is not a list`);
  for (const recipeCase of recipe.cases) {
    const id = recipeCase.id;
    const key = unknownKey(recipeCase, table.case);
    if (key !== undefined) throw new Error(`recipe ${path} case ${id}: unknown key ${key}`);
    if (!Array.isArray(recipeCase.steps)) throw new Error(`recipe ${path} case ${id}: steps is not a list`);
    recipeCase.steps.forEach((step, index) => {
      if (!Object.hasOwn(table.step, step.op)) throw new Error(`recipe ${path} case ${id} step ${index}: unknown op ${step.op}`);
      const stepKey = unknownKey(step, table.step[step.op]);
      if (stepKey !== undefined) throw new Error(`recipe ${path} case ${id} step ${index} (${step.op}): unknown key ${stepKey}`);
    });
  }
}
