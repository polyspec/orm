// Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64, INT-74, INT-88, INT-89, INT-130.
// The suite unit public_interface-none (docs/spec/feature-coverage.md FCV-3): the public interface recipe, contracts/fixtures/public_interface/public_interface.json, on no database.
import { runRecipe, NONE } from './recipe.mjs';

runRecipe('contracts/fixtures/public_interface/public_interface.json', NONE);
