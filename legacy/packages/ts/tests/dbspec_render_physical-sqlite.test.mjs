// Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
// The suite unit dbspec-render-physical-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('tests/dbspec/render-physical.json', 'sqlite');
