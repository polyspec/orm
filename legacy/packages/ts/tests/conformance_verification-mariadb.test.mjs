// Requirements: DIA-18, DIA-24, DIA-56, DSL-137, INT-39.
// The suite unit conformance_verification-mariadb (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/conformance_verification/conformance_verification.json', 'mariadb');
