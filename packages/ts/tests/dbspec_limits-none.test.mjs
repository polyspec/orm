// The limit and stress recipe, tests/dbspec/limits.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-123, DBS-144, DBS-151, DBS-170.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/limits.json', NONE);
