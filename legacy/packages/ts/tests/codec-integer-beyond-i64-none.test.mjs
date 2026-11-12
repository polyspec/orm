// The recipe tests/codec/codec-integer-beyond-i64.json without a database: an integer beyond i64 is refused (COD-62).
// Requirements: COD-62.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec-integer-beyond-i64.json', NONE);
