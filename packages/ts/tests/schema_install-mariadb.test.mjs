// Requirements: SCH-13
// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11, INT-56, INT-57, INT-58, SCH-8, SCH-9
// The suite unit schema_install-mariadb (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/schema_install/schema_install.json', 'mariadb');
