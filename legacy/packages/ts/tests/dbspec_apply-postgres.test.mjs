// Requirements: PLN-89, PLN-90, PLN-91, PLN-92, PLN-93, PLN-94, PLN-95, PLN-96, PLN-104, PLN-105.
// The suite unit dbspec_apply-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/dbspec_apply/dbspec_apply.json', 'postgres');
