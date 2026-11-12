// The generator scan recipe, contracts/fixtures/generator_scan/generator_scan.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-44, DSL-151, DSL-152.

import { NONE, runRecipe } from './recipe.mjs';

runRecipe('contracts/fixtures/generator_scan/generator_scan.json', NONE);
