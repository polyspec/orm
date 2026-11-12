// The recipe tests/codec/codec-lone-surrogate.json without a database: a text with a lone surrogate is refused (COD-64, COD-70).
// Requirements: COD-64, COD-70.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec-lone-surrogate.json', NONE);
