// Requirements: INT-103
// The suite unit catalog_connection-sqlite-only (docs/spec/feature-coverage.md FCV-3): the recipe
// contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json on SQLite.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json', 'sqlite');
