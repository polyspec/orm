// dbspec Mermaid export (tests/dbspec/mermaid.json export): each case writes exactly its Mermaid lines and dropped objects.
// Each case is a top-level test named by its id (mermaid_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-mermaid-export.mjs (after the build)
import { exportCases } from './mermaid_case.mjs';

exportCases();
