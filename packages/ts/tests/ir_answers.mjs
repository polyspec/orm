// The read answer recipe, tests/ir/answers.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4): each case
// runs the chain of tests/markdown/cases.json that its ir.answer step names on a listener that answers with the case's answer.
// Requirements: PRT-69, PRT-71, PRT-72.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/ir/answers.json', NONE);
