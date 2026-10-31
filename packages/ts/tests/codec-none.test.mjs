// The codec recipe, tests/codec/codec.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: COD-3, COD-4, COD-5, COD-8, COD-9, COD-10, COD-11, COD-12, COD-13, COD-14, COD-16, COD-20, COD-28,
// COD-29, COD-30, COD-31, COD-33, COD-34, COD-35, COD-36, COD-37, COD-38, COD-39, COD-40, PLN-15.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec.json', NONE);
