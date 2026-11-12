// The declaration position cases of the dbspec parse recipe, tests/dbspec/positions.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: ORES-72.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/positions.json', NONE);
