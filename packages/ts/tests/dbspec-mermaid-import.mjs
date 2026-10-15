// dbspec Mermaid import (tests/dbspec/mermaid.json import): each case reads its Mermaid lines into exactly its document and dropped objects.
// Each case is a top-level test named by its id (mermaid_case.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-mermaid-import.mjs (after the build)
import { importCases } from './mermaid_case.mjs';

importCases();
