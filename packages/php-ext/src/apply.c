/*
 * plan chain을 connection 하나에 step 하나씩 적용하고, 중단된 plan을 이어 가거나 되돌리고, 적용한 plan을 finalize한다
 * (PHP client PlanApply, docs/plans.md "Apply"). PDO와 그 statement는 객체의 메서드를 Zend API로 불러 쓰므로 하위 class가
 * 고친 메서드와 예외가 PHP client에서와 같다. 실패는 모두 PHP 예외이고, 함수는 예외가 남으면 false다.
 */
#include "dbspec.h"
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

/* PlanApply::EFFECT_QUERIES: dialect마다 효과 종류와 그 개수 query */
const dbs_effect_query dbs_effect_queries[] = {
    {"mysql", "table", "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?"},
    {"mysql", "column", "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?"},
    {"mysql", "index", "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?"},
    {"mysql", "constraint", "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?"},
    {"mysql", "trigger", "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?"},
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
    planv chain;
    zval *now, *events;
    smap history;   /* plan 이름 => hrow* */
    zend_long server_session;
} applier;

/* ------------------------------------------------------------ PHP calls */

/* obj->name(args...). obj가 객체가 아니면 PHP처럼 Error다. */
static bool call(zval *obj, const char *name, zval *ret, uint32_t argc, zval *a1, zval *a2)
{
    ZVAL_UNDEF(ret);
    if (Z_TYPE_P(obj) != IS_OBJECT) {
        zend_throw_error(NULL, "Call to a member function %s() on %s", name, zend_zval_value_name(obj));
        return false;
    }
    return pdo_call(obj, name, ret, argc, a1, a2);
}

/* 결과를 버리는 obj->name(text) */
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

/* new ce(args...)의 객체. 생성자의 예외가 남으면 false다. */
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

/* throw new ApplyError(code, plan, step, detail, previous). previous의 소유권을 가져간다. */
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

/* var_export($value, true) */
static str exported(zval *v)
{
    zval fn, args[2], ret;
    ZVAL_STRING(&fn, "var_export");
    ZVAL_COPY(&args[0], v);
    ZVAL_TRUE(&args[1]);
    ZVAL_UNDEF(&ret);
    str out = SL("");
    if (call_user_function(NULL, NULL, &fn, &ret, 2, args) == SUCCESS && Z_TYPE(ret) == IS_STRING) {
        out = str_z(Z_STR(ret));
    }
    zval_ptr_dtor(&ret);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&fn);
    return out;
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

/* 지금 던져진 예외를 errors에 옮긴다. ApplyCleanupError는 그 앞 error와 정리 error로 편다. */
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

/*
 * f를 실행한 뒤 ends를 앞의 실패와 상관없이 차례로 모두 실행한다. error가 하나면 그것을 그대로 던지고, 여럿이면 첫
 * error와 그 뒤의 정리 error를 함께 담은 ApplyCleanupError를 던진다.
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
    zval *args;      /* execute의 인자 배열 */
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

/* query가 돌려준 첫 row(row는 호출한 쪽이 해제한다). row가 없거나 result를 닫지 못하면 error다. */
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

/* row의 i번째 값의 사본, 없으면 null */
static void row_at(zval *row, zend_long i, zval *out)
{
    zval *v = Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), (zend_ulong)i) : NULL;
    if (v == NULL) {
        ZVAL_NULL(out);
        return;
    }
    ZVAL_COPY_DEREF(out, v);
}

/* query가 돌려준 첫 row의 첫 값 */
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

/* 효과가 지금 database에 있는지 알린다. */
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

/* 효과를 읽는다. 읽지 못하면 step의 failed error다. */
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

/* history를 읽어 기록된 plan 수를 돌려준다. 기록은 chain의 앞부분이어야 하고, 마지막 앞의 row는 applied나 done이어야 한다. */
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

/* database의 introspection이 want schemaHash(''이면 빈 database)이고 미지원 객체가 없는지 확인한다. 아니면 RuntimeException이다. */
static bool verify(applier *a, str want)
{
    unsupportedv skipped = {0};
    document *d = dbs_introspect(a->c, a->r.d, SL("schema"), &skipped);
    if (d == NULL || dbs_failed()) {
        return false;
    }
    if (skipped.n > 0) {
        const unsupported *u = &skipped.v[0];
        return runtime_error(fmt("the database has %u objects that dbspec cannot express, first %S %S %S: %S", skipped.n, u->kind, u->table, u->name, u->reason));
    }
    str got = SL("");
    if (d->tables.n > 0) {
        documentv set = {0};
        PUSH(set, d);
        manifest m;
        diags found = {0};
        if (!dbs_manifest(&set, &m, &found)) {
            if (dbs_failed()) {
                return false;
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
            return runtime_error(fmt("the introspected schema is invalid: %S", text));
        }
        got = m.schema_hash;
    }
    if (!str_eq(got, want)) {
        return runtime_error(fmt("the database is at %S, not %S", got.n == 0 ? SL("empty") : got, want.n == 0 ? SL("empty") : want));
    }
    return true;
}

/* 중단된 plan이 없고 catalog가 기록한 schema와 같을 때 기록된 plan 수를 돌려준다. */
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
    if (!verify(a, want)) {
        if (!pending(spl_ce_RuntimeException)) {
            return false;
        }
        zend_object *e = take_exception();
        str message = exception_message(e);
        OBJ_RELEASE(e);
        return apply_error("drift", SL(""), 0, message, NULL);
    }
    *out = pos;
    return true;
}

/* chain에서 plan의 앞 plan target을 source로 쓴 step */
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

/* 중단된 row의 step을 catalog의 효과로 정한다. forward이면 앞으로, 아니면 뒤로 이어 갈 위치다. */
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
    /* 앞으로 갈 때 repeat step은 다시 실행하고, 뒤로 갈 때는 그 rollback을 다시 실행한다. */
    bool took = held || (!forward && str_eqc(e->kind, "repeat"));
    if (rolling) {
        *out = took ? k : k - 1;
    } else {
        *out = took ? k + 1 : k;
    }
    return true;
}

/* applied_at: tool clock의 UTC 시각을 소수 여섯 자리로 버림한 text */
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

/* plan의 row를 state와 step으로 쓴다. row가 없으면 만든다. */
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

/* step i의 statement 하나를 event와 함께 실행한다. statement 앞에서 server session을 확인한다. */
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

/* SQLite에서 foreign key를 어기는 row가 없는지 확인한다. */
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

/* 적용한 plan의 rollback이 non-null로 되돌릴 column의 NULL row를 default로 채우거나, default가 없으면 nulls error다. */
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

/* verify의 RuntimeException을 code의 ApplyError로 바꾼다: verify는 이전 예외로, drift는 message로 담는다. */
static bool verify_as(applier *a, const plan *p, str want, const char *code)
{
    if (verify(a, want)) {
        return true;
    }
    if (!pending(spl_ce_RuntimeException)) {
        return false;
    }
    zend_object *e = take_exception();
    if (strcmp(code, "verify") == 0) {
        return apply_error("verify", p->name, 0, SL(""), e);
    }
    str message = exception_message(e);
    OBJ_RELEASE(e);
    return apply_error(code, p->name, 0, message, NULL);
}

/* step start부터 finalize step 앞까지 실행하고 검증한 뒤 row를 applied로 바꾼다. */
static bool forward(applier *a, const plan *p, const planstepv *steps, zend_long start)
{
    zend_long end = finalize_start(steps), n = (zend_long)steps->n;
    for (zend_long i = start; i < end; i++) {
        const planstep *s = &steps->v[i];
        str statement = s->statement;
        if (s->restore.n > 0) {
            bool held;
            if (!effect_at(a, p, i, s->has_restore_if ? &s->restore_if : NULL, &held)) {
                return false;
            }
            if (held) {
                statement = s->restore;
            }
        }
        if (!run(a, p, steps, i, statement) || !set_step(a, p, i + 1)) {
            return false;
        }
    }
    return foreign_key_check(a, p) && verify_as(a, p, p->to, "verify") && emit(a, "verified", p->name, 0, n, SL(""))
        && record(a, p, "applied", end) && emit(a, "done", p->name, 0, n, SL(""));
}

/* finalize step을 start부터 실행하고 row를 done으로 바꾼다. */
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

/* plan 하나를 finalize step 앞까지 적용하고 검증한다. */
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

static bool op_recover(applier *a)
{
    size_t pos;
    if (!position(a, &pos)) {
        return false;
    }
    if (pos == 0) {
        return true;
    }
    plan *p = a->chain.v[pos - 1];
    hrow *row = smap_get(&a->history, p->name);
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
    size_t pos;
    if (!position(a, &pos)) {
        return false;
    }
    if (pos == 0) {
        return true;
    }
    plan *p = a->chain.v[pos - 1];
    hrow *row = smap_get(&a->history, p->name);
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
        str statement = s->rollback;
        if (s->rollback_restore.n > 0) {
            bool held;
            if (!effect_at(a, p, i, s->has_restore_if ? &s->restore_if : NULL, &held)) {
                return false;
            }
            if (held) {
                statement = s->rollback_restore;
            }
        }
        if (!run(a, p, &steps, i, statement) || !set_step(a, p, i)) {
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
        ok = runtime_error(fmt("pg_advisory_unlock returned %S; want true or false", exported(&released)));
    }
    zval_ptr_dtor(&released);
    return ok;
}

typedef struct {
    operation op;
    zend_long foreign_keys, legacy, busy;
    str mode;
} sqlite_state;

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
        return apply_error("locked", SL(""), 0, SL("another connection holds the SQLite database"), take_exception());
    }
    return exec_sql(a, SL("COMMIT")) && exec_sql(a, SL("PRAGMA foreign_keys = OFF")) && exec_sql(a, SL("PRAGMA legacy_alter_table = OFF")) && operate(a, s->op);
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

/* locking mode를 되돌린 뒤 한 번 읽어야 exclusive lock이 풀린다. */
static bool sqlite_read_once(applier *a, void *ctx)
{
    zval v;
    if (!query_value(a, SL("SELECT COUNT(*) FROM sqlite_master"), NULL, &v)) {
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
    part ends[] = {{sqlite_foreign_keys, &s}, {sqlite_legacy, &s}, {sqlite_mode, &s}, {sqlite_read_once, &s}, {sqlite_busy, &s}};
    return finish(a, (part){sqlite_body, &s}, ends, 5);
}

/* dialect의 lock을 잡고 session 설정을 바꾼 뒤 op를 실행하고, 끝에 설정을 되돌리고 lock을 놓는다. */
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
            ok = runtime_error(fmt("GET_LOCK returned %S; want 1 or 0", exported(&got)));
        }
    } else if (Z_TYPE(got) == IS_FALSE) {
        ok = apply_error("locked", SL(""), 0, SL("another session holds the " HISTORY " advisory lock of this schema"), NULL);
    } else if (Z_TYPE(got) != IS_TRUE) {
        ok = runtime_error(fmt("pg_try_advisory_lock returned %S; want true or false", exported(&got)));
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

/* PlanApply의 생성자: dialect, error mode, chain 순서로 확인한다. */
static bool applier_init(applier *a, zval *c, str dialect_name, zval *plans, zval *now, zval *events)
{
    *a = (applier){0};
    a->c = c;
    a->now = now;
    a->events = events;
    if (!dbs_dialect(dialect_name, &a->r.d)) {
        return false;
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

bool dbs_apply(const char *op, zval *c, str dialect_name, zval *plans, zval *now, zval *events)
{
    applier a;
    if (!applier_init(&a, c, dialect_name, plans, now, events)) {
        return false;
    }
    operation o = strcmp(op, "apply") == 0 ? OP_APPLY : strcmp(op, "recover") == 0 ? OP_RECOVER : strcmp(op, "rollback") == 0 ? OP_ROLLBACK : OP_FINALIZE;
    return session(&a, o);
}

bool dbs_effect_on(zval *c, str dialect_name, const effect *e, bool *out)
{
    applier a;
    zval now;
    ZVAL_NULL(&now);
    if (!applier_init(&a, c, dialect_name, NULL, &now, NULL)) {
        return false;
    }
    return effect_holds(&a, e, out);
}
