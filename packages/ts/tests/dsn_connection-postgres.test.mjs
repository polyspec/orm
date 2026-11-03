// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-19, CFG-27, CFG-28, CFG-29, CFG-6, CFG-21, CFG-22, CFG-23, CFG-25, CFG-24, PLN-32.
// The suite unit dsn_connection-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/dsn_connection/dsn_connection.json', 'postgres');
