// dbspec schema comparisons (tests/dbspec/plans.json comparisons): each lists exactly its differences or compare diagnostics.
// Each case is a top-level test named by its id (plan_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-plan-comparisons.mjs (after the build)
import { comparisonCases } from './plan_case.mjs';

comparisonCases();
