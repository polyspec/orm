// The suite unit audit_triggers-markdown (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/audit_triggers/audit_triggers.json', 'markdown');
