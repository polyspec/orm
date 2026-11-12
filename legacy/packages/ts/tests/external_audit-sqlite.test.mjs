// The suite unit external_audit-sqlite (docs/spec/feature-coverage.md FCV-3).
// Requirements: SCH-14, DBS-110.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/external_audit/external_audit.json', 'sqlite');
