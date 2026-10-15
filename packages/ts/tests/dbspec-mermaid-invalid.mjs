// dbspec Mermaid invalid diagrams (tests/dbspec/mermaid.json invalid): each case reports exactly its diagnostics.
// Each case is a top-level test named by its id (mermaid_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-mermaid-invalid.mjs (after the build)
import { invalidCases } from './mermaid_case.mjs';

invalidCases();
