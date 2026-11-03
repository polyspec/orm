// Requirements: CFG-4, CFG-5, CFG-6, CFG-18, CFG-34.
// The recipe contracts/fixtures/dsn_reject/dsn_reject_checked.json on no database (docs/spec/feature-coverage.md FCV-3). Rust passes the TLS options to its driver and its fields are unsigned.
import { runRecipe, NONE } from './recipe.mjs';

runRecipe('contracts/fixtures/dsn_reject/dsn_reject_checked.json', NONE);
