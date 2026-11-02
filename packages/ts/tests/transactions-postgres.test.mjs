// The suite unit transactions-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/transactions/transactions.json', 'postgres');
