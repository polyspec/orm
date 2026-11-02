// The normalize cases of the dbspec format recipe, tests/dbspec/normalize.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: ORES-15, ORES-17, ORES-19.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/normalize.json', NONE);
