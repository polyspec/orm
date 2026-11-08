// The recipe tests/codec/codec-json-depth.json without a database: a value nested deeper than 256 levels is refused (COD-70).
// Requirements: COD-70.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec-json-depth.json', NONE);
