// The rule diagnostics and canonical forms of tests/dbspec/rules.json, tests/dbspec/rules.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-2, DBS-3, DBS-34, DBS-35, DBS-36, DBS-39, DBS-40, DBS-47, DBS-57, DBS-58, DBS-61, DBS-63, DBS-64, DBS-91, DBS-122, DBS-125, DBS-126, DBS-127, DBS-128, DBS-129, DBS-131, DBS-132, DBS-134, DBS-135, DBS-141, DBS-144, DBS-145, DBS-146, DBS-147, DBS-148, DBS-149, DBS-153, DBS-154, DBS-156, DBS-157, DBS-158, DBS-159, DBS-161, DBS-162, DBS-163, DBS-164, DBS-165, DBS-166, DBS-167, DBS-168, DBS-169, DBS-171, DBS-181.
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/rules.json', NONE);
