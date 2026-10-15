// dbspec shared vectors (tests/dbspec/cases.json): valid documents give the listed positions.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-positions.mjs (after the build)
import { positionCases } from './dbspec_case.mjs';

positionCases();
