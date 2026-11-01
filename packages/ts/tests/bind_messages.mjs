// The markdown message and control recipe, tests/bind/messages.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4):
// each markdown.send step runs one typed public call on a listener that records the first message it receives.
// Requirements: PRT-67.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/bind/messages.json', NONE);
