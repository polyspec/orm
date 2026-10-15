// dbspec shared vectors (tests/dbspec/cases.json): document sets with external and parsing documents give the listed manifest, statements or errors.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-sets.mjs (after the build)
import { setCases } from './dbspec_case.mjs';

setCases();
