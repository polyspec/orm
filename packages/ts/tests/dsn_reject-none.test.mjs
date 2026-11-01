// Requirements: CFG-2, CFG-17, CFG-19, CFG-26.
// The suite unit dsn_reject-none (docs/spec/feature-coverage.md FCV-3): the refused DSN recipe on no database.
import { runRecipe, NONE } from './recipe.mjs';

runRecipe('contracts/fixtures/dsn_reject/dsn_reject.json', NONE);
