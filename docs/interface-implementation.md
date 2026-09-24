# Common interface implementation matrix

Reference: [Common interface v1](interfaces.md), [machine specification](../contracts/interfaces.json), and [generated model](interfaces-model.md). Reproduction commands and check coverage are in the [verification guide](../tests/interfaces/README.md).

Local verification: **25 conformance vectors × Go, PHP, Rust, and TypeScript × MySQL, PostgreSQL, and SQLite produce the same statements, binds, and results**. The final CI run is required before completion.

| Interface | Implementation and verification |
|---|---|
| IF-01, IF-18, IF-32 | Each client plans requests in its own process with a port of the same planner and checks the schema hash of its models. The conformance vectors compare the planned SQL and binds of the four clients. `tests/interfaces/check` compares the 20 request records of Go, Rust, and TypeScript field by field |
| IF-02 | Column values keep their logical type. `TestConnectionTimeZone` and the equal tests of PHP, TypeScript, and Rust check date and time values in four time zones on three databases |
| IF-03 ~ IF-08 | Generated models store the chain state in one core object. The `conditions_connectors`, `conditions_group`, `conditions_values`, `joins`, and `errors` vectors check connectors, groups, value shapes, join placement, and invalid chains |
| IF-09 ~ IF-12 | 22 model methods are fixed per language: the generated Go models, the PHP and TypeScript base classes, and the Rust `orm-build` template. `terminal_by` and `terminal_reuse` check terminals and the reuse of one model |
| IF-13 ~ IF-17 | `Db.connect`, `Db.transaction`, `Db.utils`, `Utils.lock`, `SchemaUtils.install`, and the AES utilities are fixed per language. The `transactions` vector and the client transaction tests check savepoints, row locks, named locks, and local values |
| IF-19, IF-20 | The `relations`, `relation_empty`, and `subqueries` vectors check relation statements and assembly. `TestBindLimitSplitting` checks the Go split of large IN lists on three databases; PHP, Rust, and TypeScript have no split test |
| IF-21 ~ IF-24 | The `write_cycle`, `now_defaults`, `creates_and_save`, and `delete_recursive` vectors check dirty writes, clock defaults, upserts, optimistic updates, and recursive deletes |
| IF-25 ~ IF-27 | The owner rules fix the five `Page` fields and the four `AESRotationStatus` fields in every language. The client model tests check keyed collections and pages |
| IF-28 ~ IF-31 | 80 codec vectors, the AES vectors, and the `aes_values`, `aes_status`, `get_query`, and `errors` vectors check codecs, key versions, masked binds, and error codes |
| IF-33 | The manifest generates the component diagram. `make interface-check` checks the diagram, the symbol snapshots, and the source mutations |
| IF-34 | PHP and TypeScript resolve only names that follow the chain rules; the Go and Rust generators reject other names before the build |

Structure checks compare the common methods and stored fields first, then report missing, added, and changed native declarations. A SHA-256 value of each symbol list is fixed in `contracts/interfaces.json`; changing declarations without updating the specification fails. `owners` restricts the fields of `Page` and `AESRotationStatus`, so updating only the symbol list cannot add a state field to them. Language-version syntax such as PHP's default readonly setter form is normalized; explicit access changes remain visible. Seven source-change counterexamples per language are checked.

These results verify the listed interfaces and scenarios. They do not prove equivalence of every function body or every possible input. Overall progress is tracked in the [checklist](checklist.md).
