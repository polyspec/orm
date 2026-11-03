// The apply verification errors of tests/dbspec/apply-verification-errors.json on a memory connection (docs/spec/feature-coverage.md FCV-3).
// Requirements: PLN-92, PLN-93, PLN-96.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/apply-verification-errors.json', NONE);
