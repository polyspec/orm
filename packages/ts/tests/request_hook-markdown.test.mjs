// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-78, PRT-65.
// The suite unit request_hook-markdown (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/request_hook/request_hook.json', 'markdown');
