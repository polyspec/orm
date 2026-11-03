// The load of a document set, tests/dbspec/load-set.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: SCH-12, DBS-156.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/load-set.json', NONE);
