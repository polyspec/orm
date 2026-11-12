// The recipe tests/codec/codec-non-finite-value.json without a database: a float that is not finite is refused (COD-70).
// Requirements: COD-70.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec-non-finite-value.json', NONE);
