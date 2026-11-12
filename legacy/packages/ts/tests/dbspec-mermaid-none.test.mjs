// The Mermaid recipe, tests/dbspec/mermaid.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: MER-1 to MER-13.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/mermaid.json', NONE);
