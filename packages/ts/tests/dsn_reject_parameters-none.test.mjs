// Requirements: CFG-19, CFG-20, CFG-37.
// The recipe contracts/fixtures/dsn_reject/dsn_reject_parameters.json on no database (docs/spec/feature-coverage.md FCV-3). Go and Rust pass another parameter to their drivers.
import { runRecipe, NONE } from './recipe.mjs';

runRecipe('contracts/fixtures/dsn_reject/dsn_reject_parameters.json', NONE);
