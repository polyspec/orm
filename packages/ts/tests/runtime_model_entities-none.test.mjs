// The entities of the runtime model, tests/dbspec/runtime-model.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-65, DBS-85, DBS-111, DBS-112.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/runtime-model.json', NONE);
