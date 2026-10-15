// dbspec invalid plans (tests/dbspec/plans.json invalid): each reports exactly its plan diagnostics.
// Each case is a top-level test named by its id (plan_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-plan-invalid.mjs (after the build)
import { invalidPlanCases } from './plan_case.mjs';

invalidPlanCases();
