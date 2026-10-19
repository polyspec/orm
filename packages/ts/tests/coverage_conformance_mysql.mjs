// The conformance vectors of mysql (tests/conformance) as node:test tests, each named by its vector, run by the
// TypeScript conformance runner on a bench database of this run (conformance_case.mjs).
// Usage: node --test --conditions=orm-test packages/ts/tests/coverage_conformance_mysql.mjs (after npm run typescript:build,
// with the environment of make orm-test-servers)
import { conformanceSuite } from './conformance_case.mjs';

await conformanceSuite('mysql');
