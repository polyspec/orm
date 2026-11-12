// The suite unit constraints_and_relations-markdown (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-33, INT-87, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/constraints_and_relations/constraints_and_relations.json', 'markdown');
