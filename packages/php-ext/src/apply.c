/*
 * Applies the plan chain one step per connection, resumes or rolls back an interrupted plan, and finalizes an applied plan
 * (PHP client PlanApply, docs/spec/plans.md "Apply"). PDO and its statement call the object's methods through the Zend API, so subclasses
 * that override methods and exceptions behave as in the PHP client. All failures are PHP exceptions, and the function returns false if one is left.
 */
#include "dbspec.h"
#include "value_export.h"
#include "ext/pdo/php_pdo_driver.h"
#include "ext/spl/spl_exceptions.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_closures.h"

#define HISTORY "dbspec$plans"
#define MYSQL_LOCK "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))"
#define POSTGRES_LOCK "hashtext('dbspec$plans'), hashtext(current_schema())"
#define SESSION_REQUIREMENT "apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection"
#define LOCK_WAIT_SECONDS 5

static const char *const SESSION_QUERY_MYSQL = "SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK(" MYSQL_LOCK ") = CONNECTION_ID(), 0)";
static const char *const SESSION_QUERY_POSTGRES = "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2"
    " AND classid = (hashtext('dbspec$plans')::bigint & 4294967295)::oid AND objid = (hashtext(current_schema())::bigint & 4294967295)::oid)";

/* PlanApply::EFFECT_QUERIES: per dialect, the effect kinds and their count queries */
const dbs_effect_query dbs_effect_queries[] = {
    {"mysql", "table", "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?"},
    {"mysql", "column", "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?"},
    {"mysql", "index", "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?"},
    {"mysql", "constraint", "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?"},
    {"mysql", "trigger", "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?"},
    {"postgres", "table", "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') AND relname = ?"},
    {"postgres", "column", "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND a.attname = ? AND a.attnum > 0 AND NOT a.attisdropped"},
    {"postgres", "index", "SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND i.relname = ?"},
    {"postgres", "constraint", "SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND k.conname = ?"},
    {"postgres", "trigger", "SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND g.tgname = ? AND NOT g.tgisinternal"},
    {"postgres", "function", "SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname = ?"},
    {"sqlite", "table", "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?"},
    {"sqlite", "column", "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?"},
    {"sqlite", "index", "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?"},
    {"sqlite", "trigger", "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name = ?"},
    {"sqlite", "sequence", "SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?"},
    {NULL, NULL, NULL},
};

typedef struct {
    str from, to, state;
    zend_long step;
} hrow;

typedef struct applier {
    zval *c;
    renderer r;
    /* The server of the connection, which the caller read when it connected; verify introspects by it (DIA-203). */
    str server;
    planv chain;
    zval *now, *events;
    smap history;   /* plan name => hrow* */
    zend_long server_session;
} applier;

/* ------------------------------------------------------------ PHP calls */

/* obj->name(args...). If obj is not an object, it is an Error, as in PHP. */
static bool call(zval *obj, const char *name, zval *ret, uint32_t argc, zval *a1, zval *a2)
{
    ZVAL_UNDEF(ret);
    if (Z_TYPE_P(obj) != IS_OBJECT) {
        zend_throw_error(NULL, "Call to a member function %s() on %s", name, zend_zval_value_name(obj));
        return false;
    }
    return pdo_call(obj, name, ret, argc, a1, a2);
}

/* obj->name(text), discarding the result */
static bool call_text(zval *obj, const char *name, str text)
{
    zval arg, ret;
    ZVAL_STR(&arg, str_zend(text));
    bool ok = call(obj, name, &ret, 1, &arg, NULL);
    zval_ptr_dtor(&arg);
    zval_ptr_dtor(&ret);
    return ok;
}

static bool exec_sql(applier *a, str statement)
{
    return call_text(a->c, "exec", statement);
}

static bool pending(zend_class_entry *ce)
{
    return EG(exception) != NULL && instanceof_function(EG(exception)->ce, ce);
}

/* Object of new ce(args...). Returns false if the constructor leaves an exception. */
static bool construct(zend_class_entry *ce, zval *out, uint32_t argc, zval *args)
{
    object_init_ex(out, ce);
    zend_call_known_instance_method(ce->constructor, Z_OBJ_P(out), NULL, argc, args);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(out);
        ZVAL_UNDEF(out);
        return false;
    }
    return true;
}

/* throw new ApplyError(code, plan, step, detail, previous). Takes ownership of previous. */
static bool apply_error(const char *code, str plan_name, zend_long step, str detail, zend_object *previous)
{
    zval args[5], ex;
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], str_zend(plan_name));
    ZVAL_LONG(&args[2], step);
    ZVAL_STR(&args[3], str_zend(detail));
    uint32_t argc = 4;
    if (previous != NULL) {
        ZVAL_OBJ(&args[4], previous);
        argc = 5;
    }
    bool ok = construct(dbs_ce_ApplyError, &ex, argc, args);
    for (uint32_t i = 0; i < argc; i++) {
        zval_ptr_dtor(&args[i]);
    }
    if (ok) {
        zend_throw_exception_object(&ex);
    }
    return false;
}

static bool runtime_error(str message)
{
    return dbs_throw(spl_ce_RuntimeException, message);
}

/* ($this->events)(new ApplyEvent(...)) */
static bool emit(applier *a, const char *kind, str plan_name, zend_long step, zend_long steps, str statement)
{
    if (a->events == NULL) {
        return true;
    }
    zval args[5], ev, ret;
    ZVAL_STRING(&args[0], kind);
    ZVAL_STR(&args[1], str_zend(plan_name));
    ZVAL_LONG(&args[2], step);
    ZVAL_LONG(&args[3], steps);
    ZVAL_STR(&args[4], str_zend(statement));
    bool ok = construct(dbs_ce_ApplyEvent, &ev, 5, args);
    for (int i = 0; i < 5; i++) {
        zval_ptr_dtor(&args[i]);
    }
    if (!ok) {
        return false;
    }
    ZVAL_UNDEF(&ret);
    call_user_function(NULL, NULL, a->events, &ret, 1, &ev);
    zval_ptr_dtor(&ret);
    zval_ptr_dtor(&ev);
    return EG(exception) == NULL;
}

/* ------------------------------------------------------------- finish */

typedef bool (*part_fn)(applier *a, void *ctx);

typedef struct {
    part_fn fn;
    void *ctx;
} part;

typedef VEC(zend_object *) errorv;

/* Moves the exception thrown now into errors. ApplyCleanupError unfolds into the error before it and the cleanup error. */
static void collect(errorv *errors)
{
    zend_object *e = take_exception();
    if (!instanceof_function(e->ce, dbs_ce_ApplyCleanupError)) {
        PUSH(*errors, e);
        return;
    }
    zval rv;
    zval *previous = zend_read_property_ex(zend_ce_exception, e, ZSTR_KNOWN(ZEND_STR_PREVIOUS), true, &rv);
    if (Z_TYPE_P(previous) == IS_OBJECT) {
        GC_ADDREF(Z_OBJ_P(previous));
        PUSH(*errors, Z_OBJ_P(previous));
    }
    zval *cleanup = zend_read_property(dbs_ce_ApplyCleanupError, e, "cleanup", sizeof("cleanup") - 1, true, &rv);
    if (Z_TYPE_P(cleanup) == IS_ARRAY) {
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(cleanup), item) {
            ZVAL_DEREF(item);
            if (Z_TYPE_P(item) == IS_OBJECT) {
                GC_ADDREF(Z_OBJ_P(item));
                PUSH(*errors, Z_OBJ_P(item));
            }
        } ZEND_HASH_FOREACH_END();
    }
    OBJ_RELEASE(e);
}

static bool throw_errors(errorv *list);

/*
 * Runs f, then runs all of ends in order regardless of an earlier failure. If there is one error, it is thrown as is; if there are several, the first
 * error and the cleanup errors after it are thrown together in an ApplyCleanupError.
 */
static bool finish(applier *a, part f, const part *ends, size_t n)
{
    errorv errors = {0};
    if (!f.fn(a, f.ctx)) {
        collect(&errors);
    }
    for (size_t i = 0; i < n; i++) {
        if (!ends[i].fn(a, ends[i].ctx)) {
            collect(&errors);
        }
    }
    return throw_errors(&errors);
}

/* Throws the errors collected: none returns true; one is thrown as is; several are thrown as the first error and the cleanup
 * errors after it in an ApplyCleanupError. */
static bool throw_errors(errorv *list)
{
    errorv errors = *list;
    if (errors.n == 0) {
        return true;
    }
    if (errors.n == 1) {
        zval ex;
        ZVAL_OBJ(&ex, errors.v[0]);
        zend_throw_exception_object(&ex);
        return false;
    }
    zval args[2], ex;
    ZVAL_OBJ(&args[0], errors.v[0]);
    array_init_size(&args[1], (uint32_t)(errors.n - 1));
    for (size_t i = 1; i < errors.n; i++) {
        zval item;
        ZVAL_OBJ(&item, errors.v[i]);
        add_next_index_zval(&args[1], &item);
    }
    bool ok = construct(dbs_ce_ApplyCleanupError, &ex, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (ok) {
        zend_throw_exception_object(&ex);
    }
    return false;
}

/* ------------------------------------------------------------- queries */

typedef struct {
    str query;
    zval *args;      /* Argument array of execute */
    zval statement;
    zval row;
} rowq;

static bool row_run(applier *a, void *ctx)
{
    rowq *q = ctx;
    zval ret;
    if (!call(&q->statement, "execute", &ret, 1, q->args, NULL)) {
        return false;
    }
    zval_ptr_dtor(&ret);
    zval mode;
    ZVAL_LONG(&mode, 3 /* PDO::FETCH_NUM */);
    if (!call(&q->statement, "fetch", &q->row, 1, &mode, NULL)) {
        return false;
    }
    if (Z_TYPE(q->row) == IS_FALSE) {
        return runtime_error(fmt("%S returned no row", q->query));
    }
    return true;
}

static bool row_close(applier *a, void *ctx)
{
    rowq *q = ctx;
    zval ret;
    if (!call(&q->statement, "closeCursor", &ret, 0, NULL, NULL)) {
        return false;
    }
    bool closed = zend_is_true(&ret);
    zval_ptr_dtor(&ret);
    return closed || runtime_error(fmt("closing the result of %S failed", q->query));
}

/* First row returned by query (the caller frees the row). It is an error if there is no row or the result cannot be closed. */
static bool query_row(applier *a, str query, zval *args, zval *row)
{
    ZVAL_UNDEF(row);
    rowq q;
    memset(&q, 0, sizeof q);
    q.query = query;
    q.args = args;
    ZVAL_UNDEF(&q.row);
    zval empty;
    ZVAL_EMPTY_ARRAY(&empty);
    if (q.args == NULL) {
        q.args = &empty;
    }
    zval qz;
    ZVAL_STR(&qz, str_zend(query));
    bool ok = call(a->c, "prepare", &q.statement, 1, &qz, NULL);
    zval_ptr_dtor(&qz);
    if (!ok) {
        return false;
    }
    part ends[] = {{row_close, &q}};
    ok = finish(a, (part){row_run, &q}, ends, 1);
    zval_ptr_dtor(&q.statement);
    if (!ok) {
        zval_ptr_dtor(&q.row);
        return false;
    }
    ZVAL_COPY_VALUE(row, &q.row);
    return true;
}

/* Copy of the i-th value of row, or null if none */
static void row_at(zval *row, zend_long i, zval *out)
{
    zval *v = Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), (zend_ulong)i) : NULL;
    if (v == NULL) {
        ZVAL_NULL(out);
        return;
    }
    ZVAL_COPY_DEREF(out, v);
}

/* First value of the first row returned by query */
static bool query_value(applier *a, str query, zval *args, zval *value)
{
    zval row;
    if (!query_row(a, query, args, &row)) {
        ZVAL_UNDEF(value);
        return false;
    }
    row_at(&row, 0, value);
    zval_ptr_dtor(&row);
    return true;
}

/* CatalogRows::integer([$this->queryValue($query)], 0, $what) */
static bool query_integer(applier *a, str query, zval *args, str what, zend_long *out)
{
    zval v;
    if (!query_value(a, query, args, &v)) {
        return false;
    }
    bool ok = value_integer(&v, 0, what, out);
    zval_ptr_dtor(&v);
    return ok;
}

static void args_strs(zval *out, const str *values, size_t n)
{
    array_init_size(out, (uint32_t)n);
    for (size_t i = 0; i < n; i++) {
        add_next_index_str(out, str_zend(values[i]));
    }
}

/* -------------------------------------------------------------- effects */

const char *dbs_effect_query_for(dialect d, str kind)
{
    for (const dbs_effect_query *q = dbs_effect_queries; q->dialect != NULL; q++) {
        if (strcmp(q->dialect, dbs_dialect_names[d]) == 0 && str_eqc(kind, q->kind)) {
            return q->query;
        }
    }
    return NULL;
}

/* Reports whether the effect is now in the database. */
static bool effect_holds(applier *a, const effect *e, bool *out)
{
    str query;
    zval args;
    if (str_eqc(e->kind, "rows")) {
        query = fmt("SELECT COUNT(*) FROM (SELECT 1 FROM %S LIMIT 1) x", r_q(&a->r, e->table));
        ZVAL_EMPTY_ARRAY(&args);
    } else {
        const char *found = dbs_effect_query_for(a->r.d, e->kind);
        if (found == NULL) {
            return runtime_error(fmt("the effect %S has no query on %s", effect_text(e), dbs_dialect_names[a->r.d]));
        }
        query = str_c(found);
        if (str_eqc(e->kind, "table") || str_eqc(e->kind, "sequence")) {
            args_strs(&args, &e->table, 1);
        } else if (str_eqc(e->kind, "function")) {
            args_strs(&args, &e->name, 1);
        } else {
            str both[2] = {e->table, e->name};
            args_strs(&args, both, 2);
        }
    }
    zend_long n;
    bool ok = query_integer(a, query, &args, query, &n);
    zval_ptr_dtor(&args);
    if (ok) {
        *out = (n > 0) == e->present;
    }
    return ok;
}

/* Reads the effect. If it cannot be read, it is the step's failed error. */
static bool effect_at(applier *a, const plan *p, zend_long step, const effect *e, bool *out)
{
    if (e == NULL) {
        return dbs_throw(spl_ce_LogicException, fmt("step %d has no effect to read", step));
    }
    if (effect_holds(a, e, out)) {
        return true;
    }
    if (!pending(spl_ce_RuntimeException)) {
        return false;
    }
    return apply_error("failed", p->name, step, SL(""), take_exception());
}

/* ------------------------------------------------------------- history */

static str q(applier *a, const char *name)
{
    return r_q(&a->r, str_c(name));
}

static bool create_history(applier *a)
{
    const char *integer = "integer", *text = "varchar(71)", *tail = "";
    if (a->r.d == D_MYSQL) {
        integer = "INT";
        text = "varchar(71) CHARACTER SET ascii COLLATE ascii_bin";
        tail = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin";
    }
    return exec_sql(a, fmt("CREATE TABLE IF NOT EXISTS %S (%S %s NOT NULL, %S %s NOT NULL, %S %s NOT NULL, %S %s NOT NULL, %S %s NOT NULL, %S %s NOT NULL, %S %s NOT NULL, PRIMARY KEY (%S))%s",
        q(a, HISTORY), q(a, "name"), text, q(a, "from_hash"), text, q(a, "to_hash"), text, q(a, "state"), text, q(a, "step"), integer,
        q(a, "steps"), integer, q(a, "applied_at"), text, q(a, "name"), tail));
}

static bool read_history(applier *a)
{
    if (!create_history(a)) {
        return false;
    }
    str query = fmt("SELECT %S, %S, %S, %S, %S FROM %S", q(a, "name"), q(a, "from_hash"), q(a, "to_hash"), q(a, "state"), q(a, "step"), q(a, HISTORY));
    zval rows;
    a->history = (smap){0};
    if (!catalog_read(a->c, query, &rows)) {
        zval_ptr_dtor(&rows);
        return false;
    }
    bool ok = true;
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row) {
        str name;
        hrow *h = dbs_alloc(sizeof *h);
        if (!(row_text(row, 0, query, &name) && row_text(row, 1, query, &h->from) && row_text(row, 2, query, &h->to)
            && row_text(row, 3, query, &h->state) && row_integer(row, 4, query, &h->step))) {
            ok = false;
            break;
        }
        smap_set(&a->history, name, h);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&rows);
    return ok;
}

static size_t history_count(const applier *a)
{
    size_t n = 0;
    SMAP_EACH(&a->history, i) {
        n++;
    }
    return n;
}

static str plan_from(const plan *p)
{
    return p->has_from ? p->from : SL("empty");
}

static bool is_state(str s, const char *a, const char *b)
{
    return str_eqc(s, a) || (b != NULL && str_eqc(s, b));
}

/* Reads history and returns the number of recorded plans. The records must be a prefix of the chain, and the rows before the last must be applied or done. */
static bool position(applier *a, size_t *out)
{
    if (!read_history(a)) {
        return false;
    }
    size_t pos = 0;
    for (size_t i = 0; i < a->chain.n; i++) {
        plan *p = a->chain.v[i];
        hrow *row = smap_get(&a->history, p->name);
        if (row == NULL) {
            continue;
        }
        if (!str_eq(row->to, p->to) || !str_eq(row->from, plan_from(p))) {
            return apply_error("chain", p->name, 0, SL("the recorded plan has other hashes than the chain's plan"), NULL);
        }
        if (i != pos) {
            return apply_error("chain", p->name, 0, SL("a plan before it in the chain is not recorded"), NULL);
        }
        if (!is_state(row->state, "applying", "applied") && !is_state(row->state, "finalizing", "done") && !is_state(row->state, "rolling_back", NULL)) {
            return apply_error("chain", p->name, 0, fmt("the recorded state %S is not a history state", row->state), NULL);
        }
        pos = i + 1;
    }
    if (history_count(a) != pos) {
        return apply_error("chain", SL(""), 0, SL("the history records a plan that is not in the chain"), NULL);
    }
    for (size_t i = 0; i + 1 < pos; i++) {
        plan *p = a->chain.v[i];
        str state = ((hrow *)smap_get(&a->history, p->name))->state;
        if (!is_state(state, "applied", "done")) {
            return apply_error("chain", p->name, 0, fmt("a plan before the last is %S", state), NULL);
        }
    }
    *out = pos;
    return true;
}

/* json_encode($value) */
static str json(zval *value)
{
    zval fn, ret;
    ZVAL_STRING(&fn, "json_encode");
    ZVAL_UNDEF(&ret);
    str out = SL("");
    if (call_user_function(NULL, NULL, &fn, &ret, 1, value) == SUCCESS && Z_TYPE(ret) == IS_STRING) {
        out = str_z(Z_STR(ret));
    } else if (Z_TYPE(ret) == IS_FALSE) {
        out = SL("false");
    }
    zval_ptr_dtor(&ret);
    zval_ptr_dtor(&fn);
    return out;
}

typedef enum {
    VERIFY_OK,
    VERIFY_MISMATCH,
    VERIFY_ERROR,
} verify_result;

/* A successful catalog read can differ from the requested schema; database exceptions remain pending as VERIFY_ERROR. */
static verify_result verify(applier *a, str want, str *message)
{
    unsupportedv skipped = {0};
    document *d = dbs_introspect(a->c, a->r.d, a->server, SL("schema"), &skipped);
    if (d == NULL || dbs_failed()) {
        return VERIFY_ERROR;
    }
    if (skipped.n > 0) {
        const unsupported *u = &skipped.v[0];
        *message = fmt("the database has %u objects that dbspec cannot express, first %S %S %S: %S", skipped.n, u->kind, u->table, u->name, u->reason);
        return VERIFY_MISMATCH;
    }
    str got = SL("");
    if (d->tables.n > 0) {
        documentv set = {0};
        PUSH(set, d);
        manifest m;
        diags found = {0};
        if (!dbs_manifest(&set, &m, &found)) {
            if (dbs_failed()) {
                return VERIFY_ERROR;
            }
            zval list;
            array_init(&list);
            for (size_t i = 0; i < found.n; i++) {
                zval item;
                array_init(&item);
                add_next_index_str(&item, str_zend(found.v[i].rule));
                add_next_index_long(&item, found.v[i].line);
                add_next_index_long(&item, found.v[i].column);
                add_next_index_str(&item, str_zend(found.v[i].message));
                add_next_index_zval(&list, &item);
            }
            str text = json(&list);
            zval_ptr_dtor(&list);
            *message = fmt("the introspected schema is invalid: %S", text);
            return VERIFY_MISMATCH;
        }
        got = m.schema_hash;
    }
    if (!str_eq(got, want)) {
        *message = fmt("the database is at %S, not %S", got.n == 0 ? SL("empty") : got, want.n == 0 ? SL("empty") : want);
        return VERIFY_MISMATCH;
    }
    return VERIFY_OK;
}

/* ------------------------------------------------------------ conversion */

/* The savepoint of the SQLite rebuild of a table in the text storage of a uuid (PLN-110). */
#define CONVERT_SAVEPOINT "\"dbspec$convert\""
#define REBUILD_TABLE "dbspec$rebuild"

/* table name => strs* of its columns in text storage, and its keys in name order */
typedef struct {
    smap columns;
    strs tables;
} text_columns;

static bool text_column(const text_columns *text, str table, str column)
{
    const strs *names = smap_get(&text->columns, table);
    return names != NULL && strs_has(names, column);
}

static const table *document_table(const document *d, str name)
{
    for (size_t i = 0; d != NULL && i < d->tables.n; i++) {
        if (str_eq(d->tables.v[i]->name, name)) {
            return d->tables.v[i];
        }
    }
    return NULL;
}

static bool fkeys_named(const fkeyv *list, str name)
{
    for (size_t i = 0; list != NULL && i < list->n; i++) {
        if (str_eq(list->v[i]->name, name)) {
            return true;
        }
    }
    return false;
}

static int fkey_by_name(const void *x, const void *y, void *ctx)
{
    (void)ctx;
    return str_cmp((*(fkey *const *)x)->name, (*(fkey *const *)y)->name);
}

static int table_by_name(const void *x, const void *y, void *ctx)
{
    (void)ctx;
    return str_cmp((*(table *const *)x)->name, (*(table *const *)y)->name);
}

/* The foreign keys of list in name order. */
static fkeyv fkeys_sorted(const fkeyv *list)
{
    fkeyv out = {0};
    for (size_t i = 0; list != NULL && i < list->n; i++) {
        PUSH(out, list->v[i]);
    }
    dbs_sort(out.v, out.n, sizeof *out.v, fkey_by_name, NULL);
    return out;
}

/* The columns of table t among names, in the order of the state table. */
static strs state_column_order(const document *state, str t, const strs *names)
{
    strs out = {0};
    const table *st = document_table(state, t);
    for (size_t i = 0; st != NULL && i < st->columns.n; i++) {
        if (strs_has(names, st->columns.v[i]->name)) {
            PUSH(out, st->columns.v[i]->name);
        }
    }
    return out;
}

/* A failed catalog query of the conversion is ApplyError convert with the database error as its previous; another failure stays
 * pending. */
static bool convert_query_failed(void)
{
    if (!pending(spl_ce_RuntimeException)) {
        return false;
    }
    return apply_error("convert", SL(""), 0, SL(""), take_exception());
}

/* The statements of PLN-109 on MySQL and MariaDB, from the storage that the database has now: a command that stopped between two
 * statements writes the statements that remain. */
static bool mysql_conversion(applier *a, const document *state, const text_columns *text, const smap *missing, strs *out)
{
    renderer *r = &a->r;
    /* The column types of the columns in text storage: char(36), or varbinary(36) of a conversion that stopped. */
    smap types = {0}; /* table NUL column => str* */
    for (size_t i = 0; i < text->tables.n; i++) {
        str t = text->tables.v[i];
        const strs *names = smap_get(&text->columns, t);
        for (size_t k = 0; k < names->n; k++) {
            str values[2] = {t, names->v[k]};
            zval args, value;
            args_strs(&args, values, 2);
            bool ok = query_value(a, SL("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?"),
                &args, &value);
            zval_ptr_dtor(&args);
            if (!ok) {
                return convert_query_failed();
            }
            str *type = dbs_alloc(sizeof *type);
            *type = Z_TYPE(value) == IS_STRING ? str_z(Z_STR(value)) : SL("");
            zval_ptr_dtor(&value);
            smap_set(&types, fmt("%S.%S", t, names->v[k]), type);
        }
    }
    /* 1. The foreign keys of the state that the database has and whose columns or referenced columns are in text storage. */
    smap dropped = {0}; /* table => fkeyv* */
    tablev state_tables = {0};
    for (size_t i = 0; i < state->tables.n; i++) {
        PUSH(state_tables, state->tables.v[i]);
    }
    dbs_sort(state_tables.v, state_tables.n, sizeof *state_tables.v, table_by_name, NULL);
    for (size_t i = 0; i < state_tables.n; i++) {
        const table *st = state_tables.v[i];
        fkeyv fs = fkeys_sorted(&st->fks);
        for (size_t k = 0; k < fs.n; k++) {
            fkey *f = fs.v[k];
            if (fkeys_named(smap_get(missing, st->name), f->name)) {
                continue;
            }
            bool uses = false;
            for (size_t c = 0; c < f->columns.n && !uses; c++) {
                uses = text_column(text, st->name, f->columns.v[c]);
            }
            for (size_t c = 0; c < f->refs.n && !uses; c++) {
                uses = text_column(text, f->table, f->refs.v[c]);
            }
            if (uses) {
                PUSH(*out, fmt("ALTER TABLE %S DROP FOREIGN KEY %S", r_q(r, st->name), r_q(r, f->name)));
                fkeyv *list = smap_get(&dropped, st->name);
                if (list == NULL) {
                    list = dbs_alloc(sizeof *list);
                    *list = (fkeyv){0};
                    smap_set(&dropped, st->name, list);
                }
                PUSH(*list, f);
            }
        }
    }
    SMAP_EACH(missing, i) {
        const fkeyv *fs = missing->e[i].val;
        fkeyv *list = smap_get(&dropped, missing->e[i].key);
        if (list == NULL) {
            list = dbs_alloc(sizeof *list);
            *list = (fkeyv){0};
            smap_set(&dropped, missing->e[i].key, list);
        }
        for (size_t k = 0; k < fs->n; k++) {
            PUSH(*list, fs->v[k]);
        }
    }
    /* 2. Each char(36) column becomes varbinary(36), which holds both forms. */
    for (size_t i = 0; i < text->tables.n; i++) {
        str t = text->tables.v[i];
        strs order = state_column_order(state, t, smap_get(&text->columns, t));
        for (size_t k = 0; k < order.n; k++) {
            str *type = smap_get(&types, fmt("%S.%S", t, order.v[k]));
            if (type == NULL || !str_eqc(*type, "char(36)")) {
                continue;
            }
            const column *c = table_column(document_table(state, t), order.v[k]);
            str check = r_q(r, dbs_renderer_name(t, c->name));
            str definition = fmt("%S VARBINARY(36)%s", r_q(r, c->name), c->nullable ? " NULL" : " NOT NULL");
            if (c->has_default) {
                definition = fmt("%S DEFAULT %S", definition, c->def);
            }
            PUSH(*out, fmt("ALTER TABLE %S DROP CONSTRAINT %S, MODIFY COLUMN %S, ADD CONSTRAINT %S CHECK (length(%S) IN (16, 36))", r_q(r, t), check,
                definition, check, r_q(r, c->name)));
        }
    }
    /* 3. The texts become their 16 bytes. */
    for (size_t i = 0; i < text->tables.n; i++) {
        str t = text->tables.v[i];
        strs order = state_column_order(state, t, smap_get(&text->columns, t));
        for (size_t k = 0; k < order.n; k++) {
            str qc = r_q(r, order.v[k]);
            str query = fmt("SELECT COUNT(*) FROM (SELECT 1 FROM %S WHERE length(%S) = 36 LIMIT 1) x", r_q(r, t), qc);
            zend_long n;
            if (!query_integer(a, query, NULL, query, &n)) {
                return convert_query_failed();
            }
            if (n > 0) {
                PUSH(*out, fmt("UPDATE %S SET %S = UNHEX(REPLACE(%S, '-', '')) WHERE length(%S) = 36", r_q(r, t), qc, qc, qc));
            }
        }
    }
    /* 4. Each table gets its rendered form, a referenced table before the tables that reference it, with its dropped foreign keys
     * whose referenced table has its rendered form. */
    smap pending_tables = {0};
    for (size_t i = 0; i < text->tables.n; i++) {
        smap_set(&pending_tables, text->tables.v[i], TRUEP);
    }
    smap added = {0};
    for (size_t left = text->tables.n; left > 0; left--) {
        str next = SNULL;
        bool found = false;
        for (size_t i = 0; i < text->tables.n && !found; i++) {
            str t = text->tables.v[i];
            if (!smap_has(&pending_tables, t)) {
                continue;
            }
            const table *st = document_table(state, t);
            bool ready = true;
            for (size_t k = 0; k < st->fks.n && ready; k++) {
                ready = str_eq(st->fks.v[k]->table, t) || !smap_has(&pending_tables, st->fks.v[k]->table);
            }
            if (ready) {
                next = t;
                found = true;
            } else if (next.s == NULL) {
                /* A cycle of such tables takes the first of them by name; its foreign keys to a pending table are added last. */
                next = t;
            }
        }
        smap_del(&pending_tables, next);
        strs parts = {0};
        strs order = state_column_order(state, next, smap_get(&text->columns, next));
        for (size_t k = 0; k < order.n; k++) {
            const column *c = table_column(document_table(state, next), order.v[k]);
            str check = r_q(r, dbs_renderer_name(next, c->name));
            PUSH(parts, fmt("DROP CONSTRAINT %S", check));
            PUSH(parts, fmt("MODIFY COLUMN %S", r_column(r, c)));
            PUSH(parts, fmt("ADD CONSTRAINT %S CHECK (%S)", check, r_type_check(r, c)));
        }
        fkeyv fs = fkeys_sorted(smap_get(&dropped, next));
        for (size_t k = 0; k < fs.n; k++) {
            if (!smap_has(&pending_tables, fs.v[k]->table)) {
                PUSH(parts, fmt("ADD %S", r_foreign_key(r, fs.v[k])));
                smap_set(&added, fmt("%S.%S", next, fs.v[k]->name), TRUEP);
            }
        }
        PUSH(*out, fmt("ALTER TABLE %S %S", r_q(r, next), strs_join(&parts, ", ")));
    }
    /* 5. A foreign key of a cycle, and one of a table without text storage, is added last. */
    strs owners = {0};
    smap_keys_sorted(&dropped, &owners);
    for (size_t i = 0; i < owners.n; i++) {
        fkeyv fs = fkeys_sorted(smap_get(&dropped, owners.v[i]));
        for (size_t k = 0; k < fs.n; k++) {
            if (!smap_has(&added, fmt("%S.%S", owners.v[i], fs.v[k]->name))) {
                PUSH(*out, fmt("ALTER TABLE %S ADD %S", r_q(r, owners.v[i]), r_foreign_key(r, fs.v[k])));
            }
        }
    }
    return !dbs_failed();
}

/* The statements of PLN-110: each table that holds a column in text storage, in name order, is rebuilt in its rendered form inside
 * one savepoint. */
static bool sqlite_conversion(applier *a, const document *state, const text_columns *text, strs *out)
{
    renderer *r = &a->r;
    for (size_t i = 0; i < text->tables.n; i++) {
        str name = text->tables.v[i];
        const table *t = document_table(state, name);
        const strs *names = smap_get(&text->columns, name);
        PUSH(*out, SL("SAVEPOINT " CONVERT_SAVEPOINT));
        PUSH(*out, r_create_table(r, t, SL(REBUILD_TABLE), r_table_check_name, (void *)t, NULL));
        bool identity = false;
        for (size_t k = 0; k < t->columns.n; k++) {
            identity = identity || t->columns.v[k]->identity;
        }
        if (identity) {
            PUSH(*out, fmt("INSERT INTO sqlite_sequence (name, seq) SELECT '" REBUILD_TABLE "', seq FROM sqlite_sequence WHERE name = '%S'", name));
        }
        strs into = {0}, from = {0};
        for (size_t k = 0; k < t->columns.n; k++) {
            str qc = r_q(r, t->columns.v[k]->name);
            PUSH(into, qc);
            PUSH(from, strs_has(names, t->columns.v[k]->name) ? fmt("unhex(replace(%S, '-', ''))", qc) : qc);
        }
        PUSH(*out, fmt("INSERT INTO %S (%S) SELECT %S FROM %S", r_q(r, SL(REBUILD_TABLE)), strs_join(&into, ", "), strs_join(&from, ", "), r_q(r, name)));
        PUSH(*out, fmt("DROP TABLE %S", r_q(r, name)));
        PUSH(*out, fmt("ALTER TABLE %S RENAME TO %S", r_q(r, SL(REBUILD_TABLE)), r_q(r, name)));
        strs rendered = r_table(r, t);
        for (size_t k = 1; k < rendered.n; k++) {
            PUSH(*out, rendered.v[k]);
        }
        strs triggers = r_triggers(r, t);
        for (size_t k = 0; k < triggers.n; k++) {
            PUSH(*out, triggers.v[k]);
        }
        PUSH(*out, SL("RELEASE " CONVERT_SAVEPOINT));
    }
    return !dbs_failed();
}

/* Returns false after a stop or a failure of the conversion, whose exception is pending; inside the SQLite rebuild of a table it
 * rolls the table back first, so that the table is kept as it was (PLN-110). */
static bool end_conversion(applier *a, bool open)
{
    if (!open) {
        return false;
    }
    errorv errors = {0};
    PUSH(errors, take_exception());
    if (!exec_sql(a, SL("ROLLBACK TO " CONVERT_SAVEPOINT))) {
        collect(&errors);
    }
    if (!exec_sql(a, SL("RELEASE " CONVERT_SAVEPOINT))) {
        collect(&errors);
    }
    throw_errors(&errors);
    return false;
}

/* Converts the uuid columns in the text storage of a release up to 0.0.28 to 16 bytes, before the drift check and before any plan
 * (PLN-108). It converts nothing on PostgreSQL, on a database with no recorded plan, and when an unsupported object other than
 * such a column exists or the schema with such columns read as uuid is not the state; the drift check then reports the database. */
static bool convert(applier *a, size_t position)
{
    if (a->r.d == D_POSTGRES || position == 0) {
        return true;
    }
    const plan *state = a->chain.v[position - 1];
    unsupportedv skipped = {0};
    document *live = dbs_introspect(a->c, a->r.d, a->server, SL("schema"), &skipped);
    if (live == NULL || dbs_failed()) {
        if (!pending(spl_ce_RuntimeException)) {
            return false;
        }
        return apply_error("verify", SL(""), 0, SL(""), take_exception());
    }
    text_columns text = {0};
    for (size_t i = 0; i < skipped.n; i++) {
        const unsupported *u = &skipped.v[i];
        if (!str_eqc(u->kind, "column") || !str_eqc(u->reason, DBS_TEXT_STORAGE_REASON)) {
            return true;
        }
        strs *names = smap_get(&text.columns, u->table);
        if (names == NULL) {
            names = dbs_alloc(sizeof *names);
            *names = (strs){0};
            smap_set(&text.columns, u->table, names);
        }
        PUSH(*names, u->name);
    }
    if (text.columns.live == 0) {
        return true;
    }
    smap_keys_sorted(&text.columns, &text.tables);
    /* A dropped foreign key is missing only while its table holds a column in text storage (PLN-109). */
    smap missing = {0}; /* table => fkeyv* */
    for (size_t i = 0; i < live->tables.n; i++) {
        table *t = live->tables.v[i];
        const table *want = document_table(state->schema, t->name);
        if (!smap_has(&text.columns, t->name) || want == NULL) {
            continue;
        }
        for (size_t k = 0; k < want->fks.n; k++) {
            fkey *f = want->fks.v[k];
            if (!fkeys_named(&t->fks, f->name)) {
                PUSH(t->fks, f);
                fkeyv *list = smap_get(&missing, t->name);
                if (list == NULL) {
                    list = dbs_alloc(sizeof *list);
                    *list = (fkeyv){0};
                    smap_set(&missing, t->name, list);
                }
                PUSH(*list, f);
            }
        }
    }
    documentv set = {0};
    PUSH(set, live);
    manifest m;
    diags found = {0};
    if (!dbs_manifest(&set, &m, &found)) {
        return !dbs_failed();
    }
    if (!str_eq(m.schema_hash, state->to)) {
        return true;
    }
    strs statements = {0};
    bool built = a->r.d == D_MYSQL ? mysql_conversion(a, state->schema, &text, &missing, &statements)
                                   : sqlite_conversion(a, state->schema, &text, &statements);
    if (!built) {
        return false;
    }
    bool open = false;
    for (size_t i = 0; i < statements.n; i++) {
        str statement = statements.v[i];
        if (!emit(a, "convert", SL(""), (zend_long)i, 0, statement)) {
            return end_conversion(a, open);
        }
        if (!exec_sql(a, statement)) {
            if (pending(php_pdo_get_exception())) {
                apply_error("convert", SL(""), (zend_long)i, statement, take_exception());
            }
            return end_conversion(a, open);
        }
        if (str_starts(statement, "SAVEPOINT ")) {
            open = true;
        } else if (str_starts(statement, "RELEASE ")) {
            open = false;
        }
    }
    return true;
}

/* When there is no interrupted plan and the catalog's recorded schema matches, returns the number of recorded plans. */
static bool settled(applier *a, size_t *out)
{
    size_t pos;
    if (!position(a, &pos)) {
        return false;
    }
    str want = SL("");
    if (pos > 0) {
        plan *p = a->chain.v[pos - 1];
        hrow *row = smap_get(&a->history, p->name);
        if (!is_state(row->state, "applied", "done")) {
            return apply_error("interrupted", p->name, row->step, fmt("the plan is %S; run recover or rollback", row->state), NULL);
        }
        want = p->to;
    }
    if (!convert(a, pos)) {
        return false;
    }
    str detail = SL("");
    verify_result result = verify(a, want, &detail);
    if (result == VERIFY_ERROR) {
        if (!pending(spl_ce_RuntimeException)) {
            return false;
        }
        zend_object *e = take_exception();
        return apply_error("verify", SL(""), 0, SL(""), e);
    }
    if (result == VERIFY_MISMATCH) {
        return apply_error("drift", SL(""), 0, detail, NULL);
    }
    *out = pos;
    return true;
}

/* Step that uses the target of the plan before this one in the chain as its source */
static bool steps_of(applier *a, const plan *p, planstepv *out)
{
    const document *source = NULL;
    for (size_t i = 0; i < a->chain.n; i++) {
        if (a->chain.v[i] == p && i > 0) {
            source = a->chain.v[i - 1]->schema;
        }
    }
    diags d = {0};
    if (plan_steps(source, p, a->r.d, out, &d)) {
        return true;
    }
    if (dbs_failed()) {
        return false;
    }
    return apply_error("chain", p->name, 0, d.v[0].message, NULL);
}

/* Sets the step of the interrupted row from the catalog's effect. It is the position to continue from: forward if forward, otherwise backward. */
static bool resolve(applier *a, const plan *p, const hrow *row, const planstepv *steps, bool forward, zend_long *out)
{
    zend_long k = row->step, n = (zend_long)steps->n;
    if (k < 0 || k > n) {
        return apply_error("chain", p->name, 0, fmt("the recorded step %d is outside the plan's %d steps", k, n), NULL);
    }
    bool rolling = str_eqc(row->state, "rolling_back");
    zend_long uncertain = rolling ? k - 1 : k;
    if (uncertain < 0 || uncertain >= n) {
        *out = k;
        return true;
    }
    const effect *e = &steps->v[uncertain].effect;
    bool held = false;
    if (!str_eqc(e->kind, "repeat") && !effect_at(a, p, uncertain, e, &held)) {
        return false;
    }
    /* When going forward, a repeat step is run again; when going backward, its rollback is run again. */
    bool took = held || (!forward && str_eqc(e->kind, "repeat"));
    if (rolling) {
        *out = took ? k : k - 1;
    } else {
        *out = took ? k + 1 : k;
    }
    return true;
}

/* applied_at: text of the tool clock's UTC time truncated to six fractional digits */
static bool applied_at(applier *a, str *out)
{
    zval now, fn, at, utc, zone_fn, zone_name, moved, format, text;
    ZVAL_UNDEF(&now);
    call_user_function(NULL, NULL, a->now, &now, 0, NULL);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&now);
        return false;
    }
    ZVAL_STRING(&fn, "DateTimeImmutable::createFromInterface");
    ZVAL_UNDEF(&at);
    call_user_function(NULL, NULL, &fn, &at, 1, &now);
    zval_ptr_dtor(&fn);
    zval_ptr_dtor(&now);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&at);
        return false;
    }
    ZVAL_STRING(&zone_fn, "timezone_open");
    ZVAL_STRING(&zone_name, "UTC");
    ZVAL_UNDEF(&utc);
    call_user_function(NULL, NULL, &zone_fn, &utc, 1, &zone_name);
    zval_ptr_dtor(&zone_fn);
    zval_ptr_dtor(&zone_name);
    bool ok = EG(exception) == NULL && call(&at, "setTimezone", &moved, 1, &utc, NULL);
    zval_ptr_dtor(&utc);
    zval_ptr_dtor(&at);
    if (!ok) {
        return false;
    }
    ZVAL_STRING(&format, "Y-m-d\\TH:i:s.u\\Z");
    ok = call(&moved, "format", &text, 1, &format, NULL);
    zval_ptr_dtor(&format);
    zval_ptr_dtor(&moved);
    if (!ok) {
        return false;
    }
    zend_string *s = zval_get_string(&text);
    *out = str_z(s);
    zend_string_release(s);
    zval_ptr_dtor(&text);
    return true;
}

/* prepare(sql)->execute(args) */
static bool prepared(applier *a, str sql, zval *args)
{
    zval qz, statement, ret;
    ZVAL_STR(&qz, str_zend(sql));
    bool ok = call(a->c, "prepare", &statement, 1, &qz, NULL);
    zval_ptr_dtor(&qz);
    if (ok) {
        ok = call(&statement, "execute", &ret, 1, args, NULL);
        zval_ptr_dtor(&ret);
    }
    zval_ptr_dtor(&statement);
    zval_ptr_dtor(args);
    return ok;
}

/* Writes the plan's row with its state and step. Creates the row if it does not exist. */
static bool record(applier *a, const plan *p, const char *state, zend_long step)
{
    if (smap_get(&a->history, p->name) == NULL) {
        planstepv steps;
        str at;
        if (!steps_of(a, p, &steps) || !applied_at(a, &at)) {
            return false;
        }
        zval args;
        array_init(&args);
        add_next_index_str(&args, str_zend(p->name));
        add_next_index_str(&args, str_zend(plan_from(p)));
        add_next_index_str(&args, str_zend(p->to));
        add_next_index_string(&args, state);
        add_next_index_long(&args, step);
        add_next_index_long(&args, (zend_long)steps.n);
        add_next_index_str(&args, str_zend(at));
        if (!prepared(a, fmt("INSERT INTO %S (%S, %S, %S, %S, %S, %S, %S) VALUES (?, ?, ?, ?, ?, ?, ?)", q(a, HISTORY), q(a, "name"), q(a, "from_hash"),
            q(a, "to_hash"), q(a, "state"), q(a, "step"), q(a, "steps"), q(a, "applied_at")), &args)) {
            return false;
        }
        hrow *h = dbs_alloc(sizeof *h);
        *h = (hrow){plan_from(p), p->to, str_c(state), step};
        smap_set(&a->history, p->name, h);
        return true;
    }
    zval args;
    array_init(&args);
    add_next_index_string(&args, state);
    add_next_index_long(&args, step);
    add_next_index_str(&args, str_zend(p->name));
    return prepared(a, fmt("UPDATE %S SET %S = ?, %S = ? WHERE %S = ?", q(a, HISTORY), q(a, "state"), q(a, "step"), q(a, "name")), &args);
}

static bool set_step(applier *a, const plan *p, zend_long step)
{
    zval args;
    array_init(&args);
    add_next_index_long(&args, step);
    add_next_index_str(&args, str_zend(p->name));
    return prepared(a, fmt("UPDATE %S SET %S = ? WHERE %S = ?", q(a, HISTORY), q(a, "step"), q(a, "name")), &args);
}

/* ------------------------------------------------------------- session */

static bool same_session(applier *a, const plan *p, zend_long i, zval *current)
{
    zend_long id;
    if (!value_integer(current, 0, SL("server session id"), &id)) {
        return false;
    }
    if (id == a->server_session) {
        return true;
    }
    return apply_error("session", p != NULL ? p->name : SL(""), p == NULL ? 0 : i,
        fmt("the connection moved from server session %d to %d; " SESSION_REQUIREMENT, a->server_session, id), NULL);
}

static bool open_session(applier *a, const char *query)
{
    zval row;
    str qs = str_c(query);
    if (!query_row(a, qs, NULL, &row)) {
        return false;
    }
    bool ok = row_integer(&row, 0, qs, &a->server_session);
    if (ok) {
        zval held;
        row_at(&row, 1, &held);
        bool shared = Z_TYPE(held) == IS_TRUE || (Z_TYPE(held) == IS_LONG && Z_LVAL(held) == 1)
            || (Z_TYPE(held) == IS_STRING && zend_string_equals_literal(Z_STR(held), "1"));
        zval_ptr_dtor(&held);
        if (shared) {
            ok = apply_error("session", SL(""), 0, SL("this server session already holds the " HISTORY " lock, so another client shares it; " SESSION_REQUIREMENT), NULL);
        }
    }
    zval_ptr_dtor(&row);
    return ok;
}

/* Runs one statement of step i together with its event. Checks the server session before the statement. */
static bool run(applier *a, const plan *p, const planstepv *steps, zend_long i, str statement)
{
    if (!emit(a, "statement", p->name, i, (zend_long)steps->n, statement)) {
        return false;
    }
    if (a->r.d != D_SQLITE) {
        str query = a->r.d == D_MYSQL ? SL("SELECT CONNECTION_ID()") : SL("SELECT pg_backend_pid()");
        zval current;
        if (!query_value(a, query, NULL, &current)) {
            if (!pending(php_pdo_get_exception())) {
                return false;
            }
            return apply_error("failed", p->name, i, query, take_exception());
        }
        bool ok = same_session(a, p, i, &current);
        zval_ptr_dtor(&current);
        if (!ok) {
            return false;
        }
    }
    if (!exec_sql(a, statement)) {
        if (!pending(php_pdo_get_exception())) {
            return false;
        }
        return apply_error("failed", p->name, i, statement, take_exception());
    }
    return emit(a, "applied", p->name, i, (zend_long)steps->n, statement);
}

/* Checks in SQLite that no row violates a foreign key. */
static bool foreign_key_check(applier *a, const plan *p)
{
    if (a->r.d != D_SQLITE) {
        return true;
    }
    str query = SL("SELECT COUNT(*) FROM pragma_foreign_key_check");
    zend_long broken;
    if (!query_integer(a, query, NULL, query, &broken)) {
        return false;
    }
    if (broken > 0) {
        return apply_error("verify", p->name, 0, fmt("%d rows break a foreign key", broken), NULL);
    }
    return true;
}

/* Fills the NULL rows of a column that the applied plan's rollback would restore as non-null with its default; if there is no default, it is a nulls error. */
static bool null_checks(applier *a, const plan *p, const planstepv *steps, zend_long upto)
{
    for (zend_long i = 0; i < upto; i++) {
        const planstep *s = &steps->v[i];
        for (size_t k = 0; k < s->null_checks.n; k++) {
            const nullcheck *c = &s->null_checks.v[k];
            str query = fmt("SELECT COUNT(*) FROM %S WHERE %S IS NULL", r_q(&a->r, c->table), r_q(&a->r, c->column));
            zend_long n;
            if (!query_integer(a, query, NULL, query, &n)) {
                return false;
            }
            if (n == 0) {
                continue;
            }
            if (!c->has_default) {
                return apply_error("nulls", p->name, i, fmt("column %S.%S has %d NULL rows and no default to restore NOT NULL", c->table, c->column, n), NULL);
            }
            if (!exec_sql(a, fmt("UPDATE %S SET %S = %S WHERE %S IS NULL", r_q(&a->r, c->table), r_q(&a->r, c->column), c->def, r_q(&a->r, c->column)))) {
                return false;
            }
        }
    }
    return true;
}

static zend_long finalize_start(const planstepv *steps)
{
    for (size_t i = 0; i < steps->n; i++) {
        if (steps->v[i].finalize) {
            return (zend_long)i;
        }
    }
    return (zend_long)steps->n;
}

static bool irreversible(const plan *p, const planstepv *steps, zend_long i)
{
    return apply_error("irreversible", p->name, i, steps->v[i].finalize ? SL("a finalize step has no rollback") : steps->v[i].irreversible, NULL);
}

/* Converts verify's RuntimeException into an ApplyError with code: verify is kept as the previous exception, and drift is kept as the message. */
static bool verify_as(applier *a, const plan *p, str want, const char *code)
{
    str detail = SL("");
    verify_result result = verify(a, want, &detail);
    if (result == VERIFY_OK) {
        return true;
    }
    if (result == VERIFY_ERROR && !pending(spl_ce_RuntimeException)) {
        return false;
    }
    if (result == VERIFY_MISMATCH) {
        return apply_error(code, p->name, 0, detail, NULL);
    }
    zend_object *e = take_exception();
    return apply_error("verify", p->name, 0, SL(""), e);
}

/* Selects a step's direction-specific restore SQL after checking the same schema effect. */
static bool step_statement(applier *a, const plan *p, const planstepv *steps, zend_long i, bool rollback, str *out)
{
    const planstep *s = &steps->v[i];
    str restore = rollback ? s->rollback_restore : s->restore;
    *out = rollback ? s->rollback : s->statement;
    if (restore.n == 0) {
        return true;
    }
    bool held;
    if (!effect_at(a, p, i, s->has_restore_if ? &s->restore_if : NULL, &held)) {
        return false;
    }
    if (held) {
        *out = restore;
    }
    return true;
}

/* Runs from step start up to the finalize step, verifies, then sets the row to applied. */
static bool forward(applier *a, const plan *p, const planstepv *steps, zend_long start)
{
    zend_long end = finalize_start(steps), n = (zend_long)steps->n;
    for (zend_long i = start; i < end; i++) {
        str statement;
        if (!step_statement(a, p, steps, i, false, &statement) || !run(a, p, steps, i, statement)
            || !set_step(a, p, i + 1)) {
            return false;
        }
    }
    return foreign_key_check(a, p) && verify_as(a, p, p->to, "verify") && emit(a, "verified", p->name, 0, n, SL(""))
        && record(a, p, "applied", end) && emit(a, "done", p->name, 0, n, SL(""));
}

/* Runs the finalize step from start and sets the row to done. */
static bool finalize_from(applier *a, const plan *p, const planstepv *steps, zend_long start)
{
    zend_long n = (zend_long)steps->n;
    for (zend_long i = start; i < n; i++) {
        if (!run(a, p, steps, i, steps->v[i].statement) || !set_step(a, p, i + 1)) {
            return false;
        }
    }
    return record(a, p, "done", n) && emit(a, "done", p->name, 0, n, SL(""));
}

/* Applies one plan up to the finalize step and verifies it. */
static bool apply_plan(applier *a, const plan *p)
{
    planstepv steps;
    if (!steps_of(a, p, &steps) || !emit(a, "plan", p->name, 0, (zend_long)steps.n, SL(""))) {
        return false;
    }
    zend_long end = finalize_start(&steps);
    for (zend_long i = 0; i < end; i++) {
        if (steps.v[i].rollback.n == 0 && !emit(a, "irreversible", p->name, i, (zend_long)steps.n, steps.v[i].statement)) {
            return false;
        }
    }
    return record(a, p, "applying", 0) && forward(a, p, &steps, 0);
}

/* --------------------------------------------------------- operations */

typedef enum { OP_APPLY, OP_RECOVER, OP_ROLLBACK, OP_FINALIZE } operation;

static bool op_apply(applier *a)
{
    size_t pos;
    if (!settled(a, &pos)) {
        return false;
    }
    for (size_t i = pos; i < a->chain.n; i++) {
        if (!apply_plan(a, a->chain.v[i])) {
            return false;
        }
    }
    return true;
}

/* Selects the last plan known to the chain operations, or reports an empty chain. */
static bool current_plan(applier *a, plan **out_plan, hrow **out_row)
{
    size_t pos;
    if (!position(a, &pos)) {
        return false;
    }
    if (pos == 0) {
        *out_plan = NULL;
        *out_row = NULL;
        return true;
    }
    *out_plan = a->chain.v[pos - 1];
    *out_row = smap_get(&a->history, (*out_plan)->name);
    return true;
}

static bool op_recover(applier *a)
{
    plan *p;
    hrow *row;
    if (!current_plan(a, &p, &row)) {
        return false;
    }
    if (p == NULL) {
        return true;
    }
    if (is_state(row->state, "applied", "done")) {
        return true;
    }
    planstepv steps;
    zend_long k;
    if (!steps_of(a, p, &steps) || !resolve(a, p, row, &steps, true, &k)) {
        return false;
    }
    zend_long n = (zend_long)steps.n;
    if (str_eqc(row->state, "finalizing")) {
        return emit(a, "finalize", p->name, 0, n, SL("")) && finalize_from(a, p, &steps, k);
    }
    return emit(a, "plan", p->name, 0, n, SL("")) && record(a, p, "applying", k) && forward(a, p, &steps, k);
}

static bool op_rollback(applier *a)
{
    plan *p;
    hrow *row;
    if (!current_plan(a, &p, &row)) {
        return false;
    }
    if (p == NULL) {
        return true;
    }
    planstepv steps;
    if (!steps_of(a, p, &steps)) {
        return false;
    }
    zend_long n = (zend_long)steps.n;
    zend_long k = row->step;
    bool applied = is_state(row->state, "applied", "done");
    if (applied) {
        if (k < 0 || k > n) {
            return apply_error("chain", p->name, 0, fmt("the recorded step %d is outside the plan's %d steps", k, n), NULL);
        }
        size_t at = 0;
        while (at < a->chain.n && a->chain.v[at] != p) {
            at++;
        }
        if (!convert(a, at < a->chain.n ? at + 1 : 0)) {
            return false;
        }
        if (!verify_as(a, p, p->to, "drift")) {
            return false;
        }
    } else if (!resolve(a, p, row, &steps, false, &k)) {
        return false;
    }
    if (k > 0 && steps.v[k - 1].rollback.n == 0) {
        return irreversible(p, &steps, k - 1);
    }
    if (applied && !null_checks(a, p, &steps, k)) {
        return false;
    }
    if (!emit(a, "rollback", p->name, 0, n, SL("")) || !record(a, p, "rolling_back", k)) {
        return false;
    }
    for (zend_long i = k - 1; i >= 0; i--) {
        const planstep *s = &steps.v[i];
        if (s->rollback.n == 0) {
            return irreversible(p, &steps, i);
        }
        str statement;
        if (!step_statement(a, p, &steps, i, true, &statement) || !run(a, p, &steps, i, statement)
            || !set_step(a, p, i)) {
            return false;
        }
    }
    if (!foreign_key_check(a, p) || !verify_as(a, p, p->has_from ? p->from : SL(""), "verify") || !emit(a, "verified", p->name, 0, n, SL(""))) {
        return false;
    }
    zval args;
    array_init(&args);
    add_next_index_str(&args, str_zend(p->name));
    return prepared(a, fmt("DELETE FROM %S WHERE %S = ?", q(a, HISTORY), q(a, "name")), &args) && emit(a, "done", p->name, 0, n, SL(""));
}

static bool op_finalize(applier *a)
{
    size_t pos;
    if (!settled(a, &pos)) {
        return false;
    }
    for (size_t i = 0; i < pos; i++) {
        plan *p = a->chain.v[i];
        if (!str_eqc(((hrow *)smap_get(&a->history, p->name))->state, "applied")) {
            continue;
        }
        planstepv steps;
        if (!steps_of(a, p, &steps) || !emit(a, "finalize", p->name, 0, (zend_long)steps.n, SL(""))) {
            return false;
        }
        zend_long start = finalize_start(&steps);
        if (!record(a, p, "finalizing", start) || !finalize_from(a, p, &steps, start)) {
            return false;
        }
    }
    return true;
}

typedef struct {
    operation op;
    zend_long previous[2];
    bool has_previous;
    str previous_text;
    zval current;
} session_state;

static bool operate(applier *a, operation op)
{
    switch (op) {
        case OP_APPLY: return op_apply(a);
        case OP_RECOVER: return op_recover(a);
        case OP_ROLLBACK: return op_rollback(a);
        default: return op_finalize(a);
    }
}

static bool mysql_body(applier *a, void *ctx)
{
    session_state *s = ctx;
    if (!same_session(a, NULL, 0, &s->current)) {
        return false;
    }
    str query = SL("SELECT @@SESSION.lock_wait_timeout, @@SESSION.innodb_lock_wait_timeout");
    zval row;
    if (!query_row(a, query, NULL, &row)) {
        return false;
    }
    zend_long values[2];
    bool ok = row_integer(&row, 0, query, &values[0]) && row_integer(&row, 1, query, &values[1]);
    zval_ptr_dtor(&row);
    if (!ok || !exec_sql(a, fmt("SET SESSION lock_wait_timeout = %d, innodb_lock_wait_timeout = %d", (zend_long)LOCK_WAIT_SECONDS, (zend_long)LOCK_WAIT_SECONDS))) {
        return false;
    }
    s->previous[0] = values[0];
    s->previous[1] = values[1];
    s->has_previous = true;
    return operate(a, s->op);
}

static bool mysql_restore(applier *a, void *ctx)
{
    session_state *s = ctx;
    return !s->has_previous || exec_sql(a, fmt("SET SESSION lock_wait_timeout = %d, innodb_lock_wait_timeout = %d", s->previous[0], s->previous[1]));
}

static bool mysql_release(applier *a, void *ctx)
{
    return exec_sql(a, SL("DO RELEASE_LOCK(" MYSQL_LOCK ")"));
}

static bool postgres_body(applier *a, void *ctx)
{
    session_state *s = ctx;
    if (!same_session(a, NULL, 0, &s->current)) {
        return false;
    }
    zval value, ignored;
    if (!query_value(a, SL("SELECT current_setting('lock_timeout')"), NULL, &value)) {
        return false;
    }
    if (!query_value(a, fmt("SELECT set_config('lock_timeout', '%ds', false)", (zend_long)LOCK_WAIT_SECONDS), NULL, &ignored)) {
        zval_ptr_dtor(&value);
        return false;
    }
    zval_ptr_dtor(&ignored);
    zend_string *text = zval_get_string(&value);
    zval_ptr_dtor(&value);
    s->previous_text = str_z(text);
    zend_string_release(text);
    s->has_previous = true;
    return operate(a, s->op);
}

static bool postgres_restore(applier *a, void *ctx)
{
    session_state *s = ctx;
    if (!s->has_previous) {
        return true;
    }
    zval args, ignored;
    args_strs(&args, &s->previous_text, 1);
    bool ok = query_value(a, SL("SELECT set_config('lock_timeout', ?, false)"), &args, &ignored);
    zval_ptr_dtor(&args);
    if (ok) {
        zval_ptr_dtor(&ignored);
    }
    return ok;
}

static bool postgres_release(applier *a, void *ctx)
{
    zval released;
    if (!query_value(a, SL("SELECT pg_advisory_unlock(" POSTGRES_LOCK ")"), NULL, &released)) {
        return false;
    }
    bool ok = true;
    if (Z_TYPE(released) == IS_FALSE) {
        ok = runtime_error(SL("the advisory lock of " HISTORY " was not held at unlock"));
    } else if (Z_TYPE(released) != IS_TRUE) {
        ok = runtime_error(fmt("pg_advisory_unlock returned %S; want true or false", dbs_export_value(&released)));
    }
    zval_ptr_dtor(&released);
    return ok;
}

typedef struct {
    operation op;
    zend_long foreign_keys, legacy, busy;
    str mode;
    /* Another connection holds the database, so this connection took no lock for the release read to release. */
    bool locked;
} sqlite_state;

static bool sqlite_lock_result(zend_object *exception)
{
    if (exception == NULL) {
        return false;
    }
    zval rv;
    ZVAL_UNDEF(&rv);
    zval *info = zend_read_property(exception->ce, exception, ZEND_STRL("errorInfo"), 1, &rv);
    if (Z_TYPE_P(info) != IS_ARRAY) {
        if (!Z_ISUNDEF(rv)) zval_ptr_dtor(&rv);
        return false;
    }
    zval *code = zend_hash_index_find(Z_ARRVAL_P(info), 1);
    bool locked = false;
    if (code != NULL && Z_TYPE_P(code) == IS_LONG) {
        zend_long primary = Z_LVAL_P(code) & 0xff;
        locked = primary == 5 || primary == 6;
    }
    if (!Z_ISUNDEF(rv)) zval_ptr_dtor(&rv);
    return locked;
}

static bool sqlite_body(applier *a, void *ctx)
{
    sqlite_state *s = ctx;
    if (!exec_sql(a, SL("PRAGMA locking_mode = EXCLUSIVE"))) {
        return false;
    }
    if (!exec_sql(a, SL("BEGIN EXCLUSIVE"))) {
        if (!pending(php_pdo_get_exception())) {
            return false;
        }
        if (!sqlite_lock_result(EG(exception))) {
            return false;
        }
        s->locked = true;
        return apply_error("locked", SL(""), 0, SL("another connection holds the SQLite database"), take_exception());
    }
    return exec_sql(a, SL("COMMIT")) && exec_sql(a, SL("PRAGMA foreign_keys = OFF")) && exec_sql(a, SL("PRAGMA legacy_alter_table = OFF")) && operate(a, s->op);
}

/* The release read must not wait a second time for the lock that another connection holds. */
static bool sqlite_no_wait(applier *a, void *ctx)
{
    return !((sqlite_state *)ctx)->locked || exec_sql(a, SL("PRAGMA busy_timeout = 0"));
}

static bool sqlite_foreign_keys(applier *a, void *ctx)
{
    return exec_sql(a, fmt("PRAGMA foreign_keys = %d", ((sqlite_state *)ctx)->foreign_keys));
}

static bool sqlite_legacy(applier *a, void *ctx)
{
    return exec_sql(a, fmt("PRAGMA legacy_alter_table = %d", ((sqlite_state *)ctx)->legacy));
}

static bool sqlite_mode(applier *a, void *ctx)
{
    return exec_sql(a, fmt("PRAGMA locking_mode = %S", ((sqlite_state *)ctx)->mode));
}

/*
 * The exclusive lock is released only after the locking mode is reverted and then read once. When another connection
 * holds the database, a lock result of the read means there is no lock to release.
 */
static bool sqlite_read_once(applier *a, void *ctx)
{
    zval v;
    if (!query_value(a, SL("SELECT COUNT(*) FROM sqlite_master"), NULL, &v)) {
        if (((sqlite_state *)ctx)->locked && pending(php_pdo_get_exception()) && sqlite_lock_result(EG(exception))) {
            zend_clear_exception();
            return true;
        }
        return false;
    }
    zval_ptr_dtor(&v);
    return true;
}

static bool sqlite_busy(applier *a, void *ctx)
{
    return exec_sql(a, fmt("PRAGMA busy_timeout = %d", ((sqlite_state *)ctx)->busy));
}

static bool pragma_value(applier *a, const char *pragma, zval *out)
{
    return query_value(a, str_c(pragma), NULL, out);
}

static bool pragma_integer(applier *a, const char *pragma, zend_long *out)
{
    zval v;
    if (!pragma_value(a, pragma, &v)) {
        return false;
    }
    bool ok = value_integer(&v, 0, str_c(pragma), out);
    zval_ptr_dtor(&v);
    return ok;
}

static bool sqlite_session(applier *a, operation op)
{
    sqlite_state s;
    memset(&s, 0, sizeof s);
    s.op = op;
    zval mode;
    if (!pragma_integer(a, "PRAGMA foreign_keys", &s.foreign_keys) || !pragma_integer(a, "PRAGMA legacy_alter_table", &s.legacy)
        || !pragma_integer(a, "PRAGMA busy_timeout", &s.busy) || !pragma_value(a, "PRAGMA locking_mode", &mode)) {
        return false;
    }
    zval row;
    array_init(&row);
    add_next_index_zval(&row, &mode);
    bool ok = row_text(&row, 0, SL("PRAGMA locking_mode"), &s.mode);
    zval_ptr_dtor(&row);
    if (!ok || !exec_sql(a, fmt("PRAGMA busy_timeout = %d", (zend_long)(LOCK_WAIT_SECONDS * 1000)))) {
        return false;
    }
    part ends[] = {{sqlite_no_wait, &s}, {sqlite_foreign_keys, &s}, {sqlite_legacy, &s}, {sqlite_mode, &s}, {sqlite_read_once, &s}, {sqlite_busy, &s}};
    return finish(a, (part){sqlite_body, &s}, ends, 6);
}

/* Takes the dialect's lock, changes the session settings, runs op, then restores the settings and releases the lock at the end. */
static bool session(applier *a, operation op)
{
    if (a->r.d == D_SQLITE) {
        return sqlite_session(a, op);
    }
    session_state s;
    memset(&s, 0, sizeof s);
    s.op = op;
    zval row, got;
    bool mysql = a->r.d == D_MYSQL;
    if (!open_session(a, mysql ? SESSION_QUERY_MYSQL : SESSION_QUERY_POSTGRES)) {
        return false;
    }
    str query = mysql ? SL("SELECT GET_LOCK(" MYSQL_LOCK ", 0), CONNECTION_ID()") : SL("SELECT pg_try_advisory_lock(" POSTGRES_LOCK "), pg_backend_pid()");
    if (!query_row(a, query, NULL, &row)) {
        return false;
    }
    row_at(&row, 0, &got);
    row_at(&row, 1, &s.current);
    zval_ptr_dtor(&row);
    bool ok = true;
    if (mysql) {
        if ((Z_TYPE(got) == IS_LONG && Z_LVAL(got) == 0) || (Z_TYPE(got) == IS_STRING && zend_string_equals_literal(Z_STR(got), "0"))) {
            ok = apply_error("locked", SL(""), 0, SL("another session holds the " HISTORY " lock of this database"), NULL);
        } else if (!((Z_TYPE(got) == IS_LONG && Z_LVAL(got) == 1) || (Z_TYPE(got) == IS_STRING && zend_string_equals_literal(Z_STR(got), "1")))) {
            ok = runtime_error(fmt("GET_LOCK returned %S; want 1 or 0", dbs_export_value(&got)));
        }
    } else if (Z_TYPE(got) == IS_FALSE) {
        ok = apply_error("locked", SL(""), 0, SL("another session holds the " HISTORY " advisory lock of this schema"), NULL);
    } else if (Z_TYPE(got) != IS_TRUE) {
            ok = runtime_error(fmt("pg_try_advisory_lock returned %S; want true or false", dbs_export_value(&got)));
    }
    zval_ptr_dtor(&got);
    if (ok) {
        part ends[2] = {{mysql ? mysql_restore : postgres_restore, &s}, {mysql ? mysql_release : postgres_release, &s}};
        ok = finish(a, (part){mysql ? mysql_body : postgres_body, &s}, ends, 2);
    }
    zval_ptr_dtor(&s.current);
    return ok;
}

/* ------------------------------------------------------------------ API */

/* PlanApply's constructor: checks the dialect, the server when one is given (an effect read introspects nothing), the error mode,
 * and the chain order. */
static bool applier_init(applier *a, zval *c, str dialect_name, const str *server, zval *plans, zval *now, zval *events)
{
    *a = (applier){0};
    a->c = c;
    a->now = now;
    a->events = events;
    if (!dbs_dialect(dialect_name, &a->r.d)) {
        return false;
    }
    if (server != NULL) {
        bool mariadb;
        if (!dbs_server(a->r.d, *server, &mariadb)) {
            return false;
        }
        a->server = *server;
    }
    zval mode, ret;
    ZVAL_LONG(&mode, 3 /* PDO::ATTR_ERRMODE */);
    if (!call(c, "getAttribute", &ret, 1, &mode, NULL)) {
        return false;
    }
    bool exception_mode = Z_TYPE(ret) == IS_LONG && Z_LVAL(ret) == 2 /* PDO::ERRMODE_EXCEPTION */;
    zval_ptr_dtor(&ret);
    if (!exception_mode) {
        return dbs_throw(spl_ce_InvalidArgumentException, SL("apply needs a connection whose error mode is PDO::ERRMODE_EXCEPTION"));
    }
    planv in = {0};
    if (plans != NULL && !in_plans(plans, &in, "the plans")) {
        return false;
    }
    diags d = {0};
    if (!plan_chain(&in, &a->chain, &d)) {
        if (dbs_failed()) {
            return false;
        }
        return apply_error("chain", SL(""), 0, d.v[0].message, NULL);
    }
    return true;
}

bool dbs_apply(const char *op, zval *c, str dialect_name, str server, zval *plans, zval *now, zval *events)
{
    operation o;
    if (strcmp(op, "apply") == 0) {
        o = OP_APPLY;
    } else if (strcmp(op, "recover") == 0) {
        o = OP_RECOVER;
    } else if (strcmp(op, "rollback") == 0) {
        o = OP_ROLLBACK;
    } else if (strcmp(op, "finalize") == 0) {
        o = OP_FINALIZE;
    } else {
        zend_value_error("%s is not a plan operation; apply, recover, rollback and finalize are", op);
        return false;
    }
    applier a;
    if (!applier_init(&a, c, dialect_name, &server, plans, now, events)) {
        return false;
    }
    return session(&a, o);
}

bool dbs_effect_on(zval *c, str dialect_name, const effect *e, bool *out)
{
    applier a;
    zval now;
    ZVAL_NULL(&now);
    if (!applier_init(&a, c, dialect_name, NULL, NULL, &now, NULL)) {
        return false;
    }
    return effect_holds(&a, e, out);
}
