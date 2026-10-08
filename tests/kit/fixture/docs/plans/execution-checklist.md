<!-- doc-id: execution-checklist -->
# Execution checklist

| ID | Task | Verification | State |
|---|---|---|---|
| T1 | Write the parser | `make test` | [o] |
| T1-1 | Print `a \| b` for a union | `make test` | [ ] |
| T2 | Remove the old runner | `make test` | [!] cause: blocked; retry: T1 done |
