// dbspec plan chains (tests/dbspec/plans.json chains): each orders its plans or reports exactly its chain diagnostics.
// Each case is a top-level test named by its id (plan_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-plan-chains.mjs (after the build)
import { chainCases } from './plan_case.mjs';

chainCases();
