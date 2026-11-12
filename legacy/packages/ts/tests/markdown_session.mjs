// The session recipe, tests/markdown/session.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4): each
// markdown.session step runs reads of the bind fixture model on a listener that answers from its replies.
// Requirements: PRT-66.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/markdown/session.json', NONE);
