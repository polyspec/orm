// The suite unit immutable_write-mariadb (docs/spec/feature-coverage.md FCV-22).
// Requirements: DBS-84.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/immutable_write/immutable_write.json', 'mariadb');
