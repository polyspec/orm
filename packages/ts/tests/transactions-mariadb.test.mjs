// Requirements: CFG-15, INT-155.
// The suite unit transactions-mariadb (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/transactions/transactions.json', 'mariadb');
