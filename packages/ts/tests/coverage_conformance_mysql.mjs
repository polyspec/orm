// The conformance vectors of mysql (tests/conformance) as node:test tests, each named by its vector, run by the
// TypeScript conformance runner on a bench database of this run (conformance_case.mjs).
// Usage: node --test --conditions=orm-test packages/ts/tests/coverage_conformance_mysql.mjs (after npm run typescript:build,
// with the environment of make orm-test-servers)
// Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39, DIA-24.
// Temporal cases: datetime_p0_roundtrip, time_p3_roundtrip, datetime_precision_rejected.
import { conformanceSuite } from './conformance_case.mjs';

await conformanceSuite('mysql');
