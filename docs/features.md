# Feature contracts

The executable source is [contracts/features.json](../contracts/features.json). Each entry defines inputs, outputs, state transitions, errors, client support, fixtures, tests, and paired documentation.

| ID | Feature | Status | Client support |
|---|---|---|---|
| schema_migrations | Schema migration | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| composite_keys | Composite keys | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| authenticated_encryption | Versioned authenticated encryption | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| parameter_chunking | IN and relation parameter limits | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| batch_writes | Typed batch writes | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| keyset_pagination | Typed keyset pagination | planned | go: planned<br>php: planned<br>rust: planned<br>typescript: planned |
| transactions | Transaction options | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| precompiled_plans | Precompiled plan bundles | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| constraints_and_relations | Constraints and relation predicates | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| conformance_verification | Cross-client conformance verification | partial | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

Run make feature-check to validate paths and execute every verification command declared for non-planned features. An implemented feature requires tests and paired documentation; partial and planned are incomplete.
