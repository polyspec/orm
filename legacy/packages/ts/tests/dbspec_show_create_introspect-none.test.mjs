// The MySQL introspection of the checks of SHOW CREATE TABLE on the canned catalog of tests/dbspec/show-create.json, the recipe tests/dbspec/show-create-introspect.json (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DIA-84.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/show-create-introspect.json', NONE);
