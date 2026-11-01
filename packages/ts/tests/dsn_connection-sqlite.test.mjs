// Requirements: CFG-1, INT-15, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
// The suite unit dsn_connection-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/dsn_connection/dsn_connection.json', 'sqlite');
