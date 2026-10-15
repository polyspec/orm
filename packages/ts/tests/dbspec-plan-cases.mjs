// dbspec plan cases (tests/dbspec/plans.json cases): each plan parses, emits back unchanged, diffs against its source and writes exactly the listed steps in every dialect.
// Each case is a top-level test named by its id (plan_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-plan-cases.mjs (after the build)
import { planCases } from './plan_case.mjs';

planCases();
