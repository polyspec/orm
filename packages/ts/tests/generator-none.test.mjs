// The generator recipe, contracts/fixtures/generator/generator.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-37, DSL-116, DSL-127, DSL-129, DSL-130, PLN-22.

import { NONE, runRecipe } from './recipe.mjs';

runRecipe('contracts/fixtures/generator/generator.json', NONE);
