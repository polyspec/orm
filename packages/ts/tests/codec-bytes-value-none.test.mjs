// The recipe tests/codec/codec-bytes-value.json without a database: bytes are not a codec value (COD-63).
// Requirements: COD-63.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec-bytes-value.json', NONE);
