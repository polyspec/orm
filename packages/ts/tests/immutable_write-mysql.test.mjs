// The suite unit immutable_write-mysql (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-84.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/immutable_write/immutable_write.json', 'mysql');
