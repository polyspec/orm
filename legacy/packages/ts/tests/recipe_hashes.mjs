// The manifest hash cases of the dbspec manifest recipe, tests/dbspec/hashes.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-65, ORES-16, DBS-86, DBS-94, DBS-99, DBS-100, DBS-102, DBS-103, DIA-97.
// Requirements: ORES-13.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/hashes.json', NONE);
