// dbspec shared vectors (tests/dbspec/cases.json): canonical documents emit unchanged.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-canonical.mjs (after the build)
// Requirements: ORES-19.
import { canonicalCases } from './dbspec_case.mjs';

canonicalCases();
