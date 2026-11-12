// The document set parse cases recipe, tests/dbspec/set-parse.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-2, DBS-28, DBS-29, DBS-30, DBS-31, DBS-156, DBS-168, DBS-171.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/set-parse.json', NONE);
