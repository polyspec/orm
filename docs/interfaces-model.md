<!-- doc-id: interfaces-model -->
# Common components

<!-- Generated from contracts/interfaces.json; DO NOT EDIT. -->

```mermaid
classDiagram
    class Model {
        Core core
        connect()
        and()
        or()
        relation()
        relations()
        limit()
        duplication()
        get()
        gets()
        getsCount()
        getCount()
        getSum()
        getAvg()
        getsPage()
        getQuery()
        create()
        creates()
        update()
        save()
        delete()
        restore()
        restoreOrCreate()
        expectRevision()
        toArray()
    }
    class Core {
        <<internal>>
        Columns columns
        Group conditions
        Optional_Db connection
        List_Model joins
        Optional_Limit limit
        Text lock
        List_Order order
        List_Model relations
        Optional_RowState row
        List_Assignment sets
        build()
    }
    class Request {
        <<internal>>
        RequestIR ir
        List_Value params
        shape()
    }
    class RequestIR {
        Text kind
        List_Assignment onDuplicate
        Optional_Optimistic optimistic
        Integer parameterCount
        QueryNode root
        List_List_Integer rows
        Text schemaHash
        List_Assignment set
        Integer version
    }
    class QueryNode {
        Columns columns
        Text entity
        List_Text groupBy
        List_Join joins
        Optional_Limit limit
        Text lock
        Group on
        RelationOptions options
        List_Order order
        List_Relation relations
        Group where
    }
    class Planner {
        <<internal>>
        Dialect dialect
        SchemaManifest manifest
        validate()
        plan()
    }
    class Plan {
        Text kind
        Text schemaHash
        List_Step steps
    }
    class Step {
        Optional_Assemble assemble
        List_BindSlot bindSlots
        Integer id
        Optional_ParentRef parent
        Text role
        Text sql
        List_Text tables
    }
    class Assemble {
        List_Child children
        List_OutputColumn columns
        Text entity
    }
    class Db {
        Config config
        Map_SchemaHash_Planner planners
        Cache_Shape_Plan plans
        ConnectionPool pool
        Cache_Sql_Statement statements
        List_StatementSubscriber subscribers
        connect()
        connectSchema()
        transaction()
        utils()
        close()
        stats()
        subscribe()
        execute()
        withRequestHook()
    }
    class TransactionFlow {
        <<internal>>
        List_TransactionFrame frames
        begin()
        savepoint()
        commit()
        rollback()
    }
    class Collection {
        Map_Key_Value fetched
        Map_Key_Model items
        List_Key keys
        get()
        first()
        keys()
        connect()
        delete()
        toArray()
    }
    class Page {
        Collection items
        Integer page
        Integer perPage
        Integer totalCount
        Integer totalPages
    }
    class Utils {
        Db db
        lock()
        setLocal()
        local()
        schema()
        privileges()
        aes()
        stats()
    }
    class SchemaUtils {
        Db db
        register()
        install()
        addTablesAndColumns()
        exists()
        installed()
        empty()
    }
    class AesUtils {
        Db db
        status()
        rotate()
    }
    class AESKeyring {
        Integer currentVersion
        Map_Integer_Secret versions
        versions()
    }
    class AESRotationStatus {
        Integer current
        Integer pending
        Integer total
        Map_Integer_Integer versions
    }
    class Generator {
        <<internal>>
        SchemaManifest manifest
        List_Path scan
        generate()
    }
    class Error {
        Optional_Error cause
        Text code
        Text message
    }
    class Dbspec {
        readFile()
        readBytes()
        readSet()
        parse()
        analyze()
        format()
        emit()
        manifest()
        render()
        introspect()
        externalDifferences()
        parsePlan()
        emitPlan()
        chain()
        diff()
        compareSchemas()
        installedDifferences()
        addTablesAndColumnsSteps()
        planSteps()
        apply()
        recover()
        rollback()
        finalize()
        exportMermaid()
        importMermaid()
    }
    class DbspecDocument {
    }
    Model *-- Core : stores chain state
    Core --> Db : uses connection
    Core --> TransactionFlow : uses flow transaction
    Core --> Request : builds
    Request *-- RequestIR : stores IR
    RequestIR *-- QueryNode : contains root
    QueryNode *-- QueryNode : contains child nodes
    Db *-- Planner : plans per schema
    Planner --> Plan : returns
    Plan *-- Step : contains ordered steps
    Step *-- Assemble : maps results
    Db --> TransactionFlow : opens
    Db --> Utils : returns
    Utils --> SchemaUtils : returns
    Utils --> AesUtils : returns
    SchemaUtils --> Planner : registers schema
    AesUtils --> AESKeyring : uses keys
    AesUtils --> AESRotationStatus : returns status
    Collection o-- Model : contains ordered models
    Page *-- Collection : contains items
    Model *-- Collection : contains relations
    Generator --> Model : emits
```

| Component | Behavior and state |
|---|---|
| Model | Generated per entity. Holds the column values of a new or loaded row and the chain state in its Core. |
| Core | Stores the chain state and builds a value-free request with a separate parameter list. Internal: Each client builds the request inside its own model runtime; the request IR it builds is the common shape, not the build call (docs/interfaces.md §2). |
| Request | The request shape is the plan cache key; values stay in the parameter list. Internal: The shape is the plan cache key that each client computes inside its connection; the request IR and its parameter list are common, not the shape call (docs/interfaces.md §7). |
| RequestIR | The common request shape of every client. |
| QueryNode | The root, a join child, a relation child, or a subquery. |
| Planner | Runs in the client process. Validates a request against the manifest and renders the dialect SQL. Internal: Each client validates and plans the request inside its connection, in the calling process; the plan and its SQL are common, checked by the conformance vectors, not the planner calls (docs/interfaces.md §7). |
| Plan | Immutable statements and assembly metadata cached per request shape. |
| Step | One SQL statement of a plan. |
| Assemble | Maps result columns by position to models, joins, and relations. |
| Db | Owns the pool, the planners of the schema sets registered on it, the plan and statement caches, and the statement event subscribers. |
| TransactionFlow | Private. The transaction of the current execution flow; models without a connection use it. Internal: Begin, savepoint, commit and rollback are private; Db.transaction is their public entry (docs/interfaces.md §6). |
| Collection | Ordered models keyed by primary key, keyName, or fetchKey. |
| Page | The rows and counts of getsPage. |
| Utils | Connection utilities; lock and local values need an active transaction. |
| SchemaUtils | Registers the set of a generated schema on the connection without reading the database; installs the set with the client DDL renderer, verifies the database and registers the set; upgrades an installed set by the tables and the null or defaulted columns that the database lacks, without registering it. |
| AesUtils | Reports and rotates AES key versions of a model table. |
| AESKeyring | Keys by version; the current version encrypts new values. |
| AESRotationStatus | Row counts per key version. |
| Generator | One per language. Reads the dbspec document set and emits models; Go and Rust emit only the chain methods the sources call. Internal: Each language generates its models with its own build tool and command; the generated models are common, not the generate call (docs/interfaces.md §11, docs/usage.md §3). |
| Error | A stable code from docs/errors.yaml. |
| Dbspec | Reads a dbspec document file, or checks the bytes of one that the caller read, after checking its signature and encoding, reads a set file into the files of its document set, parses a dbspec document against its declared document set and gives the positions of its declarations, analyzes a text into that parse result and the tokens of its syntax, formats a text in canonical form or refuses a text that has a diagnostic, emits a parsed document in canonical form, gives the manifest text, schema text and hashes of a document set, renders a document set as dialect statements, introspects a database into a document, compares databases with external documents and with a set, reads, emits, chains, diffs and writes the steps of plans, compares schema texts, applies, recovers, rolls back and finalizes plans on a connection, and exports and imports Mermaid erDiagrams (docs/dbspec.md, docs/dialects.md, docs/plans.md, docs/mermaid.md). |
| DbspecDocument | One parsed and validated dbspec document. It is immutable; emitting it gives its canonical text. |

A component marked `<<internal>>` states its grounding in the manifest field `internal` (`internal_ko`): each client implements its methods privately with no common signature, so they have no interface rule. Every method of the other components has a rule, and every rule names a method of a public component; `make interface-check` checks both directions.

| From | To | Relation |
|---|---|---|
| Model | Core | stores chain state |
| Core | Db | uses connection |
| Core | TransactionFlow | uses flow transaction |
| Core | Request | builds |
| Request | RequestIR | stores IR |
| RequestIR | QueryNode | contains root |
| QueryNode | QueryNode | contains child nodes |
| Db | Planner | plans per schema |
| Planner | Plan | returns |
| Plan | Step | contains ordered steps |
| Step | Assemble | maps results |
| Db | TransactionFlow | opens |
| Db | Utils | returns |
| Utils | SchemaUtils | returns |
| Utils | AesUtils | returns |
| SchemaUtils | Planner | registers schema |
| AesUtils | AESKeyring | uses keys |
| AesUtils | AESRotationStatus | returns status |
| Collection | Model | contains ordered models |
| Page | Collection | contains items |
| Model | Collection | contains relations |
| Generator | Model | emits |

An underscore in a diagram type name separates nested types. The table defines the exact types.

| Field | Common type |
|---|---|
| Model.core | `Core` |
| Core.columns | `Columns` |
| Core.conditions | `Group` |
| Core.connection | `Optional<Db>` |
| Core.joins | `List<Model>` |
| Core.limit | `Optional<Limit>` |
| Core.lock | `Text` |
| Core.order | `List<Order>` |
| Core.relations | `List<Model>` |
| Core.row | `Optional<RowState>` |
| Core.sets | `List<Assignment>` |
| Request.ir | `RequestIR` |
| Request.params | `List<Value>` |
| RequestIR.kind | `Text` |
| RequestIR.onDuplicate | `List<Assignment>` |
| RequestIR.optimistic | `Optional<Optimistic>` |
| RequestIR.parameterCount | `Integer` |
| RequestIR.root | `QueryNode` |
| RequestIR.rows | `List<List<Integer>>` |
| RequestIR.schemaHash | `Text` |
| RequestIR.set | `List<Assignment>` |
| RequestIR.version | `Integer` |
| QueryNode.columns | `Columns` |
| QueryNode.entity | `Text` |
| QueryNode.groupBy | `List<Text>` |
| QueryNode.joins | `List<Join>` |
| QueryNode.limit | `Optional<Limit>` |
| QueryNode.lock | `Text` |
| QueryNode.on | `Group` |
| QueryNode.options | `RelationOptions` |
| QueryNode.order | `List<Order>` |
| QueryNode.relations | `List<Relation>` |
| QueryNode.where | `Group` |
| Planner.dialect | `Dialect` |
| Planner.manifest | `SchemaManifest` |
| Plan.kind | `Text` |
| Plan.schemaHash | `Text` |
| Plan.steps | `List<Step>` |
| Step.assemble | `Optional<Assemble>` |
| Step.bindSlots | `List<BindSlot>` |
| Step.id | `Integer` |
| Step.parent | `Optional<ParentRef>` |
| Step.role | `Text` |
| Step.sql | `Text` |
| Step.tables | `List<Text>` |
| Assemble.children | `List<Child>` |
| Assemble.columns | `List<OutputColumn>` |
| Assemble.entity | `Text` |
| Db.config | `Config` |
| Db.planners | `Map<SchemaHash,Planner>` |
| Db.plans | `Cache<Shape,Plan>` |
| Db.pool | `ConnectionPool` |
| Db.statements | `Cache<Sql,Statement>` |
| Db.subscribers | `List<StatementSubscriber>` |
| TransactionFlow.frames | `List<TransactionFrame>` |
| Collection.fetched | `Map<Key,Value>` |
| Collection.items | `Map<Key,Model>` |
| Collection.keys | `List<Key>` |
| Page.items | `Collection` |
| Page.page | `Integer` |
| Page.perPage | `Integer` |
| Page.totalCount | `Integer` |
| Page.totalPages | `Integer` |
| Utils.db | `Db` |
| SchemaUtils.db | `Db` |
| AesUtils.db | `Db` |
| AESKeyring.currentVersion | `Integer` |
| AESKeyring.versions | `Map<Integer,Secret>` |
| AESRotationStatus.current | `Integer` |
| AESRotationStatus.pending | `Integer` |
| AESRotationStatus.total | `Integer` |
| AESRotationStatus.versions | `Map<Integer,Integer>` |
| Generator.manifest | `SchemaManifest` |
| Generator.scan | `List<Path>` |
| Error.cause | `Optional<Error>` |
| Error.code | `Text` |
| Error.message | `Text` |
