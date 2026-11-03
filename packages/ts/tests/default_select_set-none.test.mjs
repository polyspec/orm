// The default select set, tests/planner/default-select-set.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: PRT-9, DBS-68.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/planner/default-select-set.json', NONE);
