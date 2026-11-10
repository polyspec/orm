// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134, CFG-30, INT-50, INT-72.
// The suite unit utils-mariadb (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/utils/utils.json', 'mariadb');
