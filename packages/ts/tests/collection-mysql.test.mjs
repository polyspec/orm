// The suite unit collection-mysql (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('tests/collection/collection.json', 'mysql');
