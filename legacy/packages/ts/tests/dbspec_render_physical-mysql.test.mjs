// Requirements: DIA-113, FCV-22, FCV-4 (docs/spec/feature-coverage.md).
// The suite unit dbspec-render-physical-mysql (docs/spec/feature-coverage.md FCV-22).
import { runRecipe } from './recipe.mjs';

await runRecipe('tests/dbspec/render-physical.json', 'mysql');
