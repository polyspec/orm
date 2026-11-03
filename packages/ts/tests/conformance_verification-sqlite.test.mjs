// Requirements: DIA-18, DIA-56, DSL-137, PRT-77.
// The suite unit conformance_verification-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/conformance_verification/conformance_verification.json', 'sqlite');
