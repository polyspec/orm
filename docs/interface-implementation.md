# Common interface implementation matrix

Reference: [Common interface v1](interfaces.md), [machine specification](../contracts/interfaces.json), and [generated model](interfaces-model.md). Reproduction commands and check coverage are in the [verification guide](../tests/interfaces/README.md).

Local and [GitHub CI](https://github.com/polyspec/orm/actions/runs/34649545210) verification on 2026-09-12: **58 scenarios × Go, PHP, and Rust × MySQL, PostgreSQL, and SQLite match**. Common input and output, stored fields, 25 wire records, native declarations, and source-change counterexamples are checked separately. TypeScript is not implemented.

| Interface | Implementation and verification |
|---|---|
| IF-01, IF-10, IF-18, IF-32 | Common schema and compiler with 25 Request/Plan records. Go/Rust declaration comparison, recursive PHP compile checks, and rejection of unknown IR fields |
| IF-03, IF-09 | Go `gen.Battle() -> *BattleQuery`, PHP `Battle::query()`, Rust `battle::query()`. Query and Row types are separate; generated interface compilation is checked |
| IF-05 | Rust terminals borrow the query and copy params into execution results. `interface_query_reuse`: count → gets → count |
| IF-06, IF-07 | Copies of child trees and ON, WHERE, HAVING, nested, and ifParent indexes. All Go fields and `interface_attach` are checked |
| IF-08 | First error is retained and child errors are propagated. `interface_error`: the same invalid request fails repeatedly |
| IF-11, IF-12 | Value terminals and root finders. `bound_count_finder`, `root_finder_join_relation`, generated signatures, and token comparison |
| IF-13 ~ IF-17 | Root binding, row/join/relation inheritance, and rejection after transaction completion. `unbound_terminal`, `finished_transaction`, `bound_transaction_rollback`, Go cancellation/rebinding, and Rust cancellation cleanup checks |
| IF-19, IF-20, IF-24 | Relation stages, pagination, flatten, hidden, and projection vectors. Assembly does not share mutable state |
| IF-21, IF-22 | Current values remain available, first column order is retained, and only dirty fields are cleared after success. `interface_row_state`, `interface_dirty_retry` |
| IF-23, IF-29 | Unloaded rows are CONFIG, the loaded source version is retained separately, and an unloaded version is CONFIG. `interface_original_version`. `interface_identity` checks update/delete using the lookup-time primary key after the current value changes |
| IF-02, IF-24 | `has`/`relLoaded` and conversion of unloaded columns assigned through setters. `selectNone()` retains PK and FK |
| IF-25, IF-26 | Typed keys, duplicate positions, and entries. `interface_typed_keys`. Map/array conversion in every language returns IR_INVALID on key collisions. `interface_nested_keys` checks propagation from nested relation collisions to parent conversion |
| IF-27 | Declaration comparison for five Page fields, `interface_invalid_page`, and existing pagination vectors |
| IF-28, IF-30, IF-31 | Configuration, 96 codec cases, AES, hook masking, and statement order |
| IF-33 | Manifest-based interface and diagram generation, generation drift, structure, and execution checks connected to `make interface-check`, `make check`, and CI |
| IF-34 | PHP value argument guards and the dynamic compatibility layer. PHP integration and compatibility checks |

Structure checks compare common methods and stored fields first, then check missing, added, and changed native declarations. A SHA-256 symbol list is fixed in `contracts/interfaces.json`; changing declarations without updating the specification fails. `owners` restricts all fields by role, so updating only the symbol list cannot add arbitrary state fields. Language-version syntax such as PHP's default readonly setter form is normalized; explicit access changes remain visible. Seven source-change counterexamples per language and 165 PHP wire-field/shape counterexamples are checked.

These results verify the listed interfaces and scenarios. They do not prove equivalence of every function body or every possible input. The 150-table Rust build check is not complete. Overall progress is tracked in the [checklist](checklist.md).
