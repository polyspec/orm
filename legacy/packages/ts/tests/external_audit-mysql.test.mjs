// The suite unit external_audit-mysql (docs/spec/feature-coverage.md FCV-22).
// Requirements: SCH-14, DBS-110.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/external_audit/external_audit.json', 'mysql');
