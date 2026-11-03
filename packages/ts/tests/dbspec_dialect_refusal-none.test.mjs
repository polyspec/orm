// The refusal of an unknown dialect, tests/dbspec/dialect-refusal.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-174.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/dialect-refusal.json', NONE);
