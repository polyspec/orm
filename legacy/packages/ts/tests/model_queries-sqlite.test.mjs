// The suite unit model_queries-sqlite (docs/spec/feature-coverage.md FCV-3).
// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/model_queries/model_queries.json', 'sqlite');
