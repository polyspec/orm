// dbspec Mermaid round trips (tests/dbspec/mermaid.json round_trip): each case exports its document and imports the export back to its tables, columns, primary keys and foreign keys.
// Each case is a top-level test named by its id (mermaid_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-mermaid-round-trip.mjs (after the build)
import { roundTripCases } from './mermaid_case.mjs';

roundTripCases();
