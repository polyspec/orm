// dbspec shared vectors (tests/dbspec/cases.json): normalize documents emit their canonical lines.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-normalize.mjs (after the build)
import { normalizeCases } from './dbspec_case.mjs';

normalizeCases();
