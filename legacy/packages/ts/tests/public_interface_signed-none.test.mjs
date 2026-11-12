// Requirements: INT-159.
// The suite unit public_interface_signed-none (docs/spec/feature-coverage.md FCV-3): the signed public interface recipe, contracts/fixtures/public_interface/public_interface_signed.json (the signed limit, which Rust refuses at compile time), on no database.
import { runRecipe, NONE } from './recipe.mjs';

runRecipe('contracts/fixtures/public_interface/public_interface_signed.json', NONE);
