// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134.
// The suite unit utils-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/utils/utils.json', 'sqlite');
