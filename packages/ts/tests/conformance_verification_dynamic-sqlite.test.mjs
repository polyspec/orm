// Requirements: PRT-67.
// The suite unit conformance_verification_dynamic-sqlite (docs/spec/feature-coverage.md FCV-3). Go and Rust type a bytes value at compile time.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/conformance_verification/conformance_verification_dynamic.json', 'sqlite');
