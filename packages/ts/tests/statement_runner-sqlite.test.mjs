// Requirements: INT-150, INT-77, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// The suite unit statement_runner-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/statement_runner/statement_runner.json', 'sqlite');
