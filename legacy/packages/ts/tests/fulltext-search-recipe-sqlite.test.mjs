// Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, PRT-75.
// The suite unit fulltext-search-recipe-sqlite (docs/spec/feature-coverage.md FCV-22).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/fulltext_search/fulltext_search.json', 'sqlite');
