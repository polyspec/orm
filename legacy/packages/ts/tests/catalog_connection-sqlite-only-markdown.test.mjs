// Requirements: INT-103
// The suite unit catalog_connection-sqlite-only-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
// contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json on flowmark.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json', 'markdown');
