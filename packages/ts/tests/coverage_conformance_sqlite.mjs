// The conformance vectors of sqlite (tests/conformance) as node:test tests, each named by its vector, run by the
// TypeScript conformance runner on a bench database of this run (conformance_case.mjs).
// Usage: node --test --conditions=orm-test packages/ts/tests/coverage_conformance_sqlite.mjs (after npm run typescript:build,
// with the environment of make test-servers)
import { conformanceSuite } from './conformance_case.mjs';

await conformanceSuite('sqlite');
