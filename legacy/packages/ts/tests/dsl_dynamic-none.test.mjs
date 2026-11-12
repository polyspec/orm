// The chain values that Go and Rust refuse at compile time, contracts/fixtures/dsl/dsl-dynamic.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DSL-49, DSL-50, DSL-160, PLN-4.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('contracts/fixtures/dsl/dsl-dynamic.json', NONE);
