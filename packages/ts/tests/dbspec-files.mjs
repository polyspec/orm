// dbspec shared vectors (tests/dbspec/cases.json): files read by path and by bytes give the listed text or diagnostics.
// Each case is a top-level test named by its id (dbspec_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-files.mjs (after the build)
import { fileCases } from './dbspec_case.mjs';

fileCases();
