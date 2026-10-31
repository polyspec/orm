// The suite unit catalog_connection-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/catalog_connection/catalog_connection.json', 'postgres');
