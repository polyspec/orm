// The SQLite unsupported column reason of tests/dbspec/introspect-messages.json on a memory connection (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DIA-191.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/introspect-messages.json', NONE);
