// Requirements: DBS-115, DIA-11, DIA-14, DIA-24, DIA-37, DSL-137, DSL-139, DSL-144, INT-39, PRT-77.
// The suite unit conformance_verification-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/conformance_verification/conformance_verification.json', 'sqlite');
