// dbspec add tables steps (tests/dbspec/add-tables-steps.json) without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-56, SCH-8.
// Usage: node --test packages/ts/tests/dbspec-add-tables-steps.mjs (after the build)
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/add-tables-steps.json', NONE);
