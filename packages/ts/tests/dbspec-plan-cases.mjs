// dbspec plan cases (tests/dbspec/plan-cases.json) without a database (docs/spec/feature-coverage.md FCV-3): each plan parses, emits back unchanged, diffs against its source and writes exactly the listed steps in every dialect.
// Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57, PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71, PLN-72, PLN-73, PLN-74, PLN-75, PLN-76, PLN-77, PLN-78, PLN-79, PLN-80, PLN-81, PLN-82, PLN-83, PLN-84, PLN-85, PLN-86, PLN-87, PLN-88.
// Usage: node --test packages/ts/tests/dbspec-plan-cases.mjs (after the build)
import { NONE, runRecipe } from './recipe.mjs';

runRecipe('tests/dbspec/plan-cases.json', NONE);
