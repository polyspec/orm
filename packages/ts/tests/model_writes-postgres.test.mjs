// Requirements: FCV-8, FCV-9, FCV-10, FCV-13, FCV-14.
// The suite unit model_writes-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/model_writes/model_writes.json', 'postgres');
