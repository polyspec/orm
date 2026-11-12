// Requirements: CFG-15, INT-155, CFG-12, CFG-14, CFG-42.
// The suite unit transactions-markdown (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/transactions/transactions.json', 'markdown');
