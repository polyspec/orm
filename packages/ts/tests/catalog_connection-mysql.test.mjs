// The suite unit catalog_connection-mysql (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/catalog_connection/catalog_connection.json', 'mysql');
