// Requirements: CFG-4, CFG-5, CFG-5a, PRT-77.
// The suite unit connection_pool-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/connection_pool/connection_pool.json', 'postgres');
