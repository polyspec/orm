// Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, DIA-187, PRT-75.
// The suite unit fulltext-search-recipe-markdown (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/fulltext_search/fulltext_search.json', 'markdown');
