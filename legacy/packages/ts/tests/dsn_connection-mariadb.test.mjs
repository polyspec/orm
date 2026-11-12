// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-16, CFG-2, DIA-57, DSL-141, DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.
// The suite unit dsn_connection-mariadb (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/dsn_connection/dsn_connection.json', 'mariadb');
