// The suite unit performance_gate-mysql (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/performance_gate/performance_gate.json', 'mysql');
