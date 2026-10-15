// dbspec shared vectors (tests/dbspec/cases.json): invalid documents report exactly the listed diagnostics in source order.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-invalid.mjs (after the build)
import { invalidCases } from './dbspec_case.mjs';

invalidCases();
