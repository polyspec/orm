// The recipe tests/codec/codec-undefined-member.json without a database: a member that is undefined is refused (COD-70).
// Requirements: COD-70.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/codec/codec-undefined-member.json', NONE);
