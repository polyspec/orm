// The plans of the runtime model, tests/planner/runtime-model.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-112, PRT-32, PRT-81, PRT-82, DIA-24, PRT-33.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/planner/runtime-model.json', NONE);
