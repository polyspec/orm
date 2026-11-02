// The canonical cases of the dbspec format recipe, tests/dbspec/canonical.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: ORES-19.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/canonical.json', NONE);
