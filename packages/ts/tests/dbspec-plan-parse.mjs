// dbspec plan parse errors (tests/dbspec/plans.json parse): each reports exactly its diagnostics.
// Each case is a top-level test named by its id (plan_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-plan-parse.mjs (after the build)
import { parseCases } from './plan_case.mjs';

parseCases();
