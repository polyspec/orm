// dbspec shared vectors (tests/dbspec/cases.json): document sets give the listed manifest and hashes in any order.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-hashes.mjs (after the build)
import { hashCases } from './dbspec_case.mjs';

hashCases();
