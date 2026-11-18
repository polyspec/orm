// Requirements: DBS-108, SCH-7, FCV-22, FCV-4 (docs/spec/feature-coverage.md).
// The suite unit dbspec-set-decimal-postgres (docs/spec/feature-coverage.md FCV-22).
import { runRecipe } from './recipe.mjs';

await runRecipe('tests/dbspec/set-decimal.json', 'postgres');
