# Common interface implementation matrix

Reference: [Common interface v1](interfaces.md), [machine specification](../contracts/interfaces.json), and [generated model](interfaces-model.md). Reproduction commands and check coverage are in the [verification guide](../tests/interfaces/README.md).

Local verification: **26 conformance vectors × Go, PHP, Rust, and TypeScript × MySQL, PostgreSQL, and SQLite produce the same statements, binds, and results**. The generated interface, native symbol, and record checks run from `make interface-check`.

### Rust ORM mapping

The generated models use the following public Rust API directly; there is no
intermediate query or model layer.

| Specification call | Rust API and behavior |
|---|---|
| Engine selection and connection | `Db::connect(dsn, pool_size, Config)` selects MySQL, PostgreSQL, or SQLite from the DSN and creates the bounded pool without any registered set; `Db::connect_schema(dsn, &SCHEMA, pool_size, Config)`, which the generated `model::connect` calls, also registers the set of the generated models. |
| Schema hash check | A generated `Schema::new(manifest_text, manifest_hash)` validates the embedded manifest text; the engine rejects a request whose hash differs with `SCHEMA_HASH_MISMATCH`. |
| Schema installation and inspection | `db.utils().schema().install(&model::SCHEMA)` installs the set, verifies the database and registers the set on the connection; `db.utils().schema().register(&model::SCHEMA)` registers the set without reading the database; `exists`, `installed`, and `empty` inspect the selected database. Audit directives in the manifest are installed with the audit tables and triggers. |
| Transaction isolation, read-only, timeout, retry, and audit | `db.transaction(callback).isolation(Isolation::...).read_only().timeout_ms(ms).retry(count)` applies the declared options; `retry(0)` runs the callback once. `Db::transaction_once(callback)` preserves the callback error and does not retry. `audit(values)` on each of the three transaction builders inserts the audit record of the unit of work from the values of `Config::audit_source`. |
| Cancellation | Dropping a statement or transaction future closes its checked-out connection so the server operation is canceled or rolled back before that slot is reused; driver cancellation maps to `CANCELED`. |
| Encrypted columns | `Config::aes_version`, `Config::aes_keys`, `Config::blind_index_key`, and `db.utils().aes()` provide key validation, encrypted writes, blind indexes, status, and rotation for generated encrypted columns. |

PostgreSQL, MySQL, and SQLite cases exercise these calls, and the pooler
case uses the same generated models through a one-slot PgBouncer connection.

| Interface | Implementation and verification |
|---|---|
| IF-01, IF-18, IF-32 | Each client plans requests in its own process with a port of the same planner and checks the schema hash of its models. The conformance vectors compare the planned SQL and binds of the four clients. `tests/interfaces/check` compares the 20 request records of Go, PHP, Rust, and TypeScript field by field |
| IF-02 | Column values keep their logical type. `TestConnectionsUseUTC` and the equivalent PHP, TypeScript and Rust cases check that date and time values are written and read in UTC on SQLite and on MySQL and PostgreSQL servers whose zone is KST, including SQLite string datetime comparisons in the stored six-digit form. Rust generated models use typed `NaiveDateTime` values and cover the same database time behavior in integration cases |
| IF-03 ~ IF-08 | Generated models store the chain state in one core object. The `conditions_connectors`, `conditions_group`, `expression_forms`, `conditions_values`, `joins`, and `errors` vectors check connectors, groups, negated groups, value shapes, join placement, and invalid chains |
| IF-09 ~ IF-12 | 23 model methods are fixed per language: the generated Go models, the PHP and TypeScript base classes, and the Rust `orm-build` template. `terminal_by` and `terminal_reuse` check terminals and the reuse of one model |
| IF-13 ~ IF-17 | `Db.connect`, `Db.transaction`, `Db.utils`, `Utils.lock`, `SchemaUtils.install`, and the AES utilities are fixed per language. The `transactions` vector and the client transaction tests check savepoints, row locks, named locks, and local values |
| IF-19, IF-20 | The `relations`, `relation_empty`, and `subqueries` vectors check relation statements and assembly. `TestBindLimitSplitting` checks the Go split of large IN lists on three databases; PHP, Rust, and TypeScript retain the common planner specification and their client suites check the resulting relation and subquery paths |
| IF-21 ~ IF-24 | The `write_cycle`, `now_defaults`, `creates_and_save`, `delete_recursive`, and `restore` vectors check dirty writes, clock defaults, upserts, optimistic updates, recursive deletes, and the restore of a soft-deleted row |
| IF-25 ~ IF-27 | The owner rules fix the five `Page` fields and the four `AESRotationStatus` fields in every language. The client model tests check keyed collections and pages |
| IF-28 ~ IF-31 | 80 codec vectors, the AES vectors, and the `aes_values`, `aes_status`, `get_query`, and `errors` vectors check codecs, key versions, masked binds, and error codes |
| IF-33 | The manifest generates the component diagram. `make interface-check` checks the diagram, the symbol snapshots, and the source mutations |
| IF-34 | PHP and TypeScript resolve only names that follow the chain rules; the Go and Rust generators reject other names before the build |

Structure checks compare the common methods and stored fields first, then report missing, added, and changed native declarations. A SHA-256 value of each symbol list is fixed in `contracts/interfaces.json`; changing declarations without updating the specification fails. `owners` restricts the fields of `Page` and `AESRotationStatus`, so updating only the symbol list cannot add a state field to them. Language-version syntax such as PHP's default readonly setter form is normalized; explicit access changes remain visible. Seven source-change counterexamples per language are checked.

### Planner ownership

| Client | Planner and generated model owner | Executable owner tests | Dependent-part and shared checks |
|---|---|---|---|
| Go | `engine/*` is called directly by `clients/go/orm`; generated models are under `clients/go/model` | `clients/go/orm/*_test.go`, `clients/go/model/*_test.go` | `tests/conformance/runner.go`, `tests/interfaces/check` |
| PHP | `clients/php/src` plans and executes through PDO; generated models are under `clients/php/gen` | `clients/php/tests/*.php` | `tests/conformance/runner.php`, `tests/interfaces/php.php` |
| Rust | `clients/rust/orm` plans and executes through sqlx; `orm-build` generates models | `clients/rust/tests/src`, `clients/rust/orm/src/*_test.rs` | `tests/conformance/runner_rust.rs`, `tests/interfaces/rust` |
| TypeScript | `clients/typescript/src` plans and executes through native drivers; generated models are under `clients/typescript/src/models` | `clients/typescript/tests` | `tests/conformance/runner_typescript.mjs`, `tests/interfaces/typescript.mjs` |

Each owner test is kept in its client directory. Conformance compares the four outputs and does not replace owner tests; `tests/interfaces/check` verifies the shared declarations and generated artifacts.

These results verify the listed interfaces and scenarios. They do not prove equivalence of every function body or every possible input. Overall progress is tracked in the [checklist](checklist.md).
