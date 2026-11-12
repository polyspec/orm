// The suite unit composite_keys-mariadb (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-82, INT-87, PRT-12, PRT-40.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/composite_keys/composite_keys.json', 'mariadb');
