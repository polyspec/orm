// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// The suite unit statement_events-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/statement_events/statement_events.json', 'sqlite');
