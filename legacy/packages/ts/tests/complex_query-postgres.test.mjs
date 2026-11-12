// The suite unit complex_query-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/complex_query/complex_query.json', 'postgres');
