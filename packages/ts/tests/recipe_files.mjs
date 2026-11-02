// The document file cases of the dbspec reader recipe, tests/dbspec/files.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-4, DBS-155, DBS-171.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/files.json', NONE);
