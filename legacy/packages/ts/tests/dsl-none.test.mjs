// The chain value recipe, contracts/fixtures/dsl/dsl.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DSL-49, DSL-50, PLN-4.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('contracts/fixtures/dsl/dsl.json', NONE);
