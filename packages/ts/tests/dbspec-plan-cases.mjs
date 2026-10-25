// dbspec plan cases (tests/dbspec/plans.json cases): each plan parses, emits back unchanged, diffs against its source and writes exactly the listed steps in every dialect.
// Requirements: PLN-73, PLN-74, PLN-75, PLN-76, PLN-77, PLN-78, PLN-79, PLN-80, PLN-81, PLN-82, PLN-83.
// Each case is a top-level test named by its id (plan_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-plan-cases.mjs (after the build)
import { planCases } from './plan_case.mjs';

planCases();
