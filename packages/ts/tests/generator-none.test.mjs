// The generator recipe, contracts/fixtures/generator/generator.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-175, DSL-37, DSL-38, DSL-116, DSL-127, DSL-129, DSL-130, DSL-154, DBS-103, DBS-104, DBS-110, DBS-173, INT-66, PLN-1, PLN-22.

import { NONE, runRecipe } from './recipe.mjs';

runRecipe('contracts/fixtures/generator/generator.json', NONE);
