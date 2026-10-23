/*
 * Polyspec\Orm\Db of the PHP library (packages/php/src/Db.php) in C: the connection (its PDO handle, driver, registered sets,
 * statement cache, statement event subscribers and request hook) and the statement path (select, scalarOf, paginate, writeOf,
 * the bind slots of args, exec, fetch, the relation steps of a read, the time values). The statements run through the PDO object
 * of the connection, called from C by its public methods. The library classes that Db.php calls (Engine, Registry, Assemble, Codec,
 * ParamCheck, Transform, Decimal, Collection, Markdown, OrmException, StatementEvent, DbState, Request) are called by their public
 * names, the same way.
 *
 * The transaction, savepoint, audit and execute methods are implemented here: the frames of the request, the begin and finish of a
 * transaction, its savepoints, the audit record of a write, and the execution of a statement without rows. utils() returns the
 * library's Utils over this connection, and stats() the library's Stats of this one connection, in use while a transaction frame
 * is active.
 */
#include "php.h"
#include "ext/pdo/php_pdo_driver.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_smart_str.h"
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdlib.h>
#include <unistd.h>

#define ORM_EXCEPTION "Polyspec\\Orm\\OrmException"
#define STATEMENT_EVENT "Polyspec\\Orm\\StatementEvent"
#define BYTES_CLASS "Polyspec\\Orm\\Bytes"
#define DB_STATE "Polyspec\\Orm\\DbState"
#define ROW_LOCK_TABLE "orm__row_lock"
#define REQUEST_CLASS "Polyspec\\Orm\\Request"
#define SECRET_MASK "$SECRET"
#define NOW_MASK "$NOW"

static void set_masked(zval *masks, zend_long idx, const char *s);
static zval *active_for(zval *db);
static bool audit_for(zval *self, zval *frame, bool guard, bool *settle);
static void settle_audit(zval *self, zval *frame, zend_long affected, zval *out);
static zend_long bind_limit(zval *driver);
static bool send_write(zval *self, zval *step, zval *args, zval *r, zval *id, zval *affected);

/* Values of PDO::FETCH_NUM and PDO::PARAM_* (the PHP runtime's constants). */
#define FETCH_NUM 3
#define PARAM_NULL 0
#define PARAM_INT 1
#define PARAM_LOB 3
#define PARAM_BOOL 5

/* ---- engine helpers ---- */

static zend_class_entry *cls(const char *name)
{
    zend_string *n = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(n);
    zend_string_release(n);
    return ce;
}

static bool is_instance(zval *v, const char *name)
{
    if (v == NULL || Z_TYPE_P(v) != IS_OBJECT) {
        return false;
    }
    zend_class_entry *ce = cls(name);
    return ce != NULL && instanceof_function(Z_OBJCE_P(v), ce);
}

/* The property of an object, read in the scope of its class (so the private members of Db are read). The result is a
 * pointer into the object, valid until the property is written. A missing or unset property is NULL. */
static zval *rd(zval *o, const char *name)
{
    zval *p = zend_read_property(Z_OBJCE_P(o), Z_OBJ_P(o), name, strlen(name), 1, &EG(uninitialized_zval));
    return p == NULL || Z_TYPE_P(p) == IS_UNDEF ? NULL : p;
}

static void wr(zval *o, const char *name, zval *v)
{
    zend_update_property(Z_OBJCE_P(o), Z_OBJ_P(o), name, strlen(name), v);
}

/* Calls a public method of an object. On success ret holds the result, which the caller releases. */
static bool mcall(zval *o, const char *m, zval *ret, uint32_t argc, zval *argv)
{
    zval fn;
    ZVAL_STRING(&fn, m);
    zend_result r = call_user_function(NULL, o, &fn, ret, argc, argv);
    zval_ptr_dtor(&fn);
    return r == SUCCESS && EG(exception) == NULL;
}

/* Calls a function by name, or a static method as "Polyspec\\Orm\\Codec::decodeRows". A call that is not callable, or that
 * throws, returns false with an exception set; the result must be checked by every caller (warn_unused_result). */
static bool scall(const char *f, zval *ret, uint32_t argc, zval *argv) __attribute__((warn_unused_result));
static bool scall(const char *f, zval *ret, uint32_t argc, zval *argv)
{
    zval fn;
    ZVAL_STRING(&fn, f);
    zend_result r = call_user_function(NULL, NULL, &fn, ret, argc, argv);
    zval_ptr_dtor(&fn);
    if (r != SUCCESS && EG(exception) == NULL) {
        zend_throw_error(NULL, "%s is not callable", f);
    }
    return r == SUCCESS && EG(exception) == NULL;
}

/* new $name(...argv) */
static bool newobj(const char *name, zval *ret, uint32_t argc, zval *argv)
{
    zend_class_entry *ce = cls(name);
    if (ce == NULL) {
        return false;
    }
    object_init_ex(ret, ce);
    if (ce->constructor == NULL) {
        return true;
    }
    zval ctor;
    if (!mcall(ret, "__construct", &ctor, argc, argv)) {
        zval_ptr_dtor(ret);
        ZVAL_UNDEF(ret);
        return false;
    }
    zval_ptr_dtor(&ctor);
    return true;
}

/* Throws the OrmException of code and the formatted message. */
static void throw_orm(const char *code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    zval args[2], ex;
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], msg);
    if (newobj(ORM_EXCEPTION, &ex, 2, args)) {
        zend_throw_exception_object(&ex);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
}

/* Takes the pending exception out of EG(exception); the caller owns the zval. */
static void take_exception(zval *out)
{
    ZVAL_OBJ(out, EG(exception));
    EG(exception) = NULL;
}

/* Sets an owned exception as the pending one. */
static void put_exception(zval *ex)
{
    zend_throw_exception_object(ex);
}

static bool pdo_exception_pending(void)
{
    static zend_class_entry *pdo_ce = NULL;
    if (EG(exception) == NULL) {
        return false;
    }
    if (pdo_ce == NULL) {
        pdo_ce = cls("PDOException");
    }
    return pdo_ce != NULL && instanceof_function(EG(exception)->ce, pdo_ce);
}

/* The integer value of the class constant Class::NAME, read from the class's constant table; 0 when there is none. */
static zend_long constant_long(const char *qualified)
{
    const char *sep = strstr(qualified, "::");
    if (sep == NULL) {
        return 0;
    }
    zend_string *class_name = zend_string_init(qualified, (size_t)(sep - qualified), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (ce == NULL) {
        return 0;
    }
    zend_class_constant *c = zend_hash_str_find_ptr(CE_CONSTANTS_TABLE(ce), sep + 2, strlen(sep + 2));
    if (c == NULL) {
        return 0;
    }
    zval *v = &c->value;
    return zval_get_long(v);
}

/* $a[$k] with ?? semantics: NULL when $a is not an array, the key is missing, or the value is null. */
static zval *aget(zval *a, const char *k)
{
    if (a == NULL || Z_TYPE_P(a) != IS_ARRAY) {
        return NULL;
    }
    zval *v = zend_symtable_str_find(Z_ARRVAL_P(a), k, strlen(k));
    if (v == NULL) {
        return NULL;
    }
    ZVAL_DEREF(v);
    return Z_TYPE_P(v) == IS_NULL ? NULL : v;
}

static zval *aidx(zval *a, zend_long i)
{
    if (a == NULL || Z_TYPE_P(a) != IS_ARRAY) {
        return NULL;
    }
    zval *v = zend_hash_index_find(Z_ARRVAL_P(a), (zend_ulong)i);
    if (v == NULL) {
        return NULL;
    }
    ZVAL_DEREF(v);
    return Z_TYPE_P(v) == IS_NULL ? NULL : v;
}

static zend_long acount(zval *a)
{
    return a == NULL || Z_TYPE_P(a) != IS_ARRAY ? 0 : (zend_long)zend_hash_num_elements(Z_ARRVAL_P(a));
}

static zend_long as_long(zval *v)
{
    return v == NULL ? 0 : zval_get_long(v);
}

static bool as_bool(zval *v)
{
    return v != NULL && zend_is_true(v);
}

static bool is_str(zval *v, const char *s)
{
    return v != NULL && Z_TYPE_P(v) == IS_STRING && strcmp(Z_STRVAL_P(v), s) == 0;
}

/* Appends a copy of v to the list a. */
static void push(zval *a, zval *v)
{
    zval c;
    ZVAL_COPY(&c, v);
    zend_hash_next_index_insert(Z_ARRVAL_P(a), &c);
}

/* a[k] = copy of v, where numeric string keys are integer keys (the PHP array rule). */
static void setk(zval *a, const char *k, zval *v)
{
    zval c;
    ZVAL_COPY(&c, v);
    zend_symtable_str_update(Z_ARRVAL_P(a), k, strlen(k), &c);
}

/* A property array that the caller may modify: it is made an empty array when it is not one. The pointer is into the object. */
static zval *array_prop(zval *o, const char *name)
{
    zval *p = rd(o, name);
    if (p == NULL || Z_TYPE_P(p) != IS_ARRAY) {
        zval empty;
        array_init(&empty);
        wr(o, name, &empty);
        zval_ptr_dtor(&empty);
        p = rd(o, name);
    }
    SEPARATE_ARRAY(p);
    return p;
}

/* A string of the form "a" of length n, as zval. */
static void str_zv(zval *v, const char *s)
{
    ZVAL_STRING(v, s);
}

/* ---- the connection ---- */

/* Db::handle(): the PDO handle of the connection. CONFIG when closed, CAPABILITY_UNSUPPORTED on a markdown connection. The
 * handle is returned as a copy the caller releases. */
static bool handle_pdo(zval *self, zval *out)
{
    zval *state = rd(self, "state");
    if (as_bool(rd(state, "closed"))) {
        throw_orm("CONFIG", "database is closed");
        return false;
    }
    zval *md = rd(self, "md");
    if (md != NULL && Z_TYPE_P(md) == IS_OBJECT) {
        zval arg, e;
        str_zv(&arg, "a SQL statement");
        bool ok = scall("Polyspec\\Orm\\Markdown::unsupported", &e, 1, &arg);
        zval_ptr_dtor(&arg);
        if (ok) {
            put_exception(&e);
        }
        return false;
    }
    zval *pdo = rd(state, "pdo");
    if (pdo == NULL || Z_TYPE_P(pdo) != IS_OBJECT) {
        throw_orm("CONFIG", "database is closed");
        return false;
    }
    ZVAL_COPY(out, pdo);
    return true;
}

/* Db::unsupportedOnMarkdown(surface): throws Markdown::unsupported(surface) on a markdown connection. */
static bool unsupported_on_markdown(zval *self, const char *surface)
{
    zval *md = rd(self, "md");
    if (md == NULL || Z_TYPE_P(md) != IS_OBJECT) {
        return true;
    }
    zval arg, e;
    str_zv(&arg, surface);
    bool ok = scall("Polyspec\\Orm\\Markdown::unsupported", &e, 1, &arg);
    zval_ptr_dtor(&arg);
    if (ok) {
        put_exception(&e);
    }
    return false;
}

static zend_long now_hr(void)
{
    zval t, r;
    ZVAL_TRUE(&t);
    if (!scall("hrtime", &r, 1, &t)) {
        return 0;
    }
    zend_long n = Z_LVAL(r);
    zval_ptr_dtor(&r);
    return n;
}

/* Db::failed: closes the cursor of a failed statement, ignoring its own error, and keeps the driver error pending. */
static void failed_cursor(zval *st)
{
    zval ex, r;
    take_exception(&ex);
    if (mcall(st, "closeCursor", &r, 0, NULL)) {
        zval_ptr_dtor(&r);
    } else if (EG(exception) != NULL) {
        zend_clear_exception();
    }
    put_exception(&ex);
}

/* ---- statement events ---- */

/* Db::publish: the subscribers receive a StatementEvent in registration order; a failure is SUBSCRIBER with the subscriber's
 * error as its previous. With no subscriber it does nothing. */
static bool publish(zval *self, zval *kind, zval *tables, zval *tx, zval *sql, zval *binds, zend_long start, zval *error)
{
    zval *state = rd(self, "state");
    zval *subs = rd(state, "subscribers");
    if (acount(subs) == 0) {
        return true;
    }
    double elapsed = (double)(now_hr() - start) / 1e9;
    zval list;
    array_init(&list);
    zval *bi;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(binds), bi)
    {
        ZVAL_DEREF(bi);
        if (is_instance(bi, BYTES_CLASS)) {
            push(&list, rd(bi, "bytes"));
        } else {
            push(&list, bi);
        }
    }
    ZEND_HASH_FOREACH_END();
    zval ev_args[7], event;
    ZVAL_COPY(&ev_args[0], sql);
    ZVAL_COPY(&ev_args[1], &list);
    ZVAL_COPY(&ev_args[2], kind);
    ZVAL_COPY(&ev_args[3], tables);
    ZVAL_DOUBLE(&ev_args[4], elapsed);
    ZVAL_COPY(&ev_args[5], tx);
    if (error == NULL) {
        ZVAL_NULL(&ev_args[6]);
    } else {
        ZVAL_COPY(&ev_args[6], error);
    }
    bool made = newobj(STATEMENT_EVENT, &event, 7, ev_args);
    for (int i = 0; i < 7; i++) {
        zval_ptr_dtor(&ev_args[i]);
    }
    zval_ptr_dtor(&list);
    if (!made) {
        return false;
    }
    /* Iterates over a copy of the list: an unsubscribe inside a subscriber does not change the order of this event. */
    HashTable *copy = zend_array_dup(Z_ARRVAL_P(subs));
    bool ok = true;
    zval *sub;
    ZEND_HASH_FOREACH_VAL(copy, sub)
    {
        zval ret;
        ZVAL_UNDEF(&ret);
        call_user_function(NULL, NULL, sub, &ret, 1, &event);
        zval_ptr_dtor(&ret);
        if (EG(exception) != NULL) {
            zval ex, msg;
            take_exception(&ex);
            ZVAL_UNDEF(&msg);
            mcall(&ex, "getMessage", &msg, 0, NULL);
            zend_string *m = zend_strpprintf(0, "statement event subscriber failed: %s",
                Z_TYPE(msg) == IS_STRING ? Z_STRVAL(msg) : "");
            zval a[3], sx;
            str_zv(&a[0], "SUBSCRIBER");
            ZVAL_STR(&a[1], m);
            ZVAL_COPY(&a[2], &ex);
            if (newobj(ORM_EXCEPTION, &sx, 3, a)) {
                put_exception(&sx);
            }
            zval_ptr_dtor(&a[0]);
            zval_ptr_dtor(&a[1]);
            zval_ptr_dtor(&a[2]);
            zval_ptr_dtor(&msg);
            zval_ptr_dtor(&ex);
            ok = false;
            break;
        }
    }
    ZEND_HASH_FOREACH_END();
    zend_array_destroy(copy);
    zval_ptr_dtor(&event);
    return ok;
}

/* ---- the send of one statement: the armed fault, the driver error, and the event ---- */

typedef bool (*op_fn)(zval *self, void *ctx, zval *ret);
typedef bool (*done_fn)(zval *self, void *ctx, zend_long start, zval *err);

/* Db::send. control statements are not blocked by an armed fault. ret is set when the operation returns true. */
static bool send_op(zval *self, bool control, op_fn op, void *ctx, done_fn done, void *dctx, zval *ret)
{
    ZVAL_UNDEF(ret);
    zend_long start = now_hr();
    if (!control) {
        zval *state = rd(self, "state");
        zval *fault = rd(state, "statementFault");
        if (fault != NULL && Z_TYPE_P(fault) == IS_OBJECT) {
            zval f, nul;
            ZVAL_COPY(&f, fault);
            ZVAL_NULL(&nul);
            wr(state, "statementFault", &nul);
            if (!done(self, dctx, start, &f)) {
                zval_ptr_dtor(&f);
                return false;
            }
            put_exception(&f);
            return false;
        }
    }
    if (!op(self, ctx, ret)) {
        if (!pdo_exception_pending()) {
            return false;
        }
        zval pe, pdo, args[3], err, made_ok, driver;
        take_exception(&pe);
        if (!handle_pdo(self, &pdo)) {
            zval_ptr_dtor(&pe);
            return false;
        }
        ZVAL_COPY(&driver, rd(self, "driver"));
        ZVAL_COPY(&args[0], &pe);
        ZVAL_COPY(&args[1], &driver);
        ZVAL_COPY(&args[2], &pdo);
        bool made = scall("Polyspec\\Orm\\OrmException::fromDriver", &err, 3, args);
        (void)made_ok;
        for (int i = 0; i < 3; i++) {
            zval_ptr_dtor(&args[i]);
        }
        zval_ptr_dtor(&driver);
        zval_ptr_dtor(&pdo);
        zval_ptr_dtor(&pe);
        if (!made) {
            return false;
        }
        if (!done(self, dctx, start, &err)) {
            zval_ptr_dtor(&err);
            return false;
        }
        put_exception(&err);
        return false;
    }
    if (!done(self, dctx, start, NULL)) {
        zval_ptr_dtor(ret);
        ZVAL_UNDEF(ret);
        return false;
    }
    return true;
}

/* A statement published as given (Db::observed and the statements that are not model statements). */
typedef struct pubctx {
    zval *kind, *tables, *tx, *sql, *binds;
} pubctx;

static bool done_publish(zval *self, void *ctx, zend_long start, zval *err)
{
    pubctx *c = ctx;
    return publish(self, c->kind, c->tables, c->tx, c->sql, c->binds, start, err);
}

/* The kind of a planned statement: the first word of its SQL. ALTER is the schema statement of the MySQL identity restart. */
static void statement_kind(zval *sql, zval *out)
{
    const char *s = Z_TYPE_P(sql) == IS_STRING ? Z_STRVAL_P(sql) : "";
    while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') {
        s++;
    }
    char word[16];
    size_t n = 0;
    while (s[n] != '\0' && s[n] != ' ' && n < sizeof(word) - 1) {
        word[n] = (char)((s[n] >= 'a' && s[n] <= 'z') ? s[n] - 32 : s[n]);
        n++;
    }
    word[n] = '\0';
    const char *kind = "select";
    if (strcmp(word, "ALTER") == 0) {
        kind = "schema";
    } else if (strcmp(word, "INSERT") == 0) {
        kind = "insert";
    } else if (strcmp(word, "UPDATE") == 0) {
        kind = "update";
    } else if (strcmp(word, "DELETE") == 0) {
        kind = "delete";
    }
    str_zv(out, kind);
}

/* A model statement (Db::modelDone): its kind is the first word of the plan step SQL, its tables are the step's, and its binds
 * are the arguments with the masks of the secret and the clock. The transaction is the connection's, which is never open here. */
typedef struct modelctx {
    zval *step, *sql, *args;
} modelctx;

static bool done_model(zval *self, void *ctx, zend_long start, zval *err)
{
    modelctx *c = ctx;
    zval args;
    ZVAL_COPY(&args, c->args);
    zval *masks = rd(self, "masks");
    if (masks != NULL && Z_TYPE_P(masks) == IS_ARRAY) {
        zend_ulong idx;
        zval *m;
        ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(masks), idx, m)
        {
            SEPARATE_ARRAY(&args);
            Z_TRY_ADDREF_P(m);
            zend_hash_index_update(Z_ARRVAL(args), idx, m);
        }
        ZEND_HASH_FOREACH_END();
    }
    zval kind, tables, tx;
    zval *t = aget(c->step, "tables");
    statement_kind(aget(c->step, "sql") ? aget(c->step, "sql") : c->sql, &kind);
    if (t != NULL) {
        ZVAL_COPY(&tables, t);
    } else {
        array_init(&tables);
    }
    zval *active = active_for(self);
    if (active != NULL) {
        ZVAL_COPY(&tx, rd(active, "number"));
    } else {
        ZVAL_NULL(&tx);
    }
    pubctx pc = {&kind, &tables, &tx, c->sql, &args};
    bool ok = done_publish(self, &pc, start, err);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&tables);
    zval_ptr_dtor(&tx);
    zval_ptr_dtor(&kind);
    return ok;
}

static bool is_empty_str(zval *v)
{
    return v == NULL || (Z_TYPE_P(v) == IS_STRING && Z_STRLEN_P(v) == 0);
}

static void set_long(zval *a, zend_long n)
{
    zval v;
    ZVAL_LONG(&v, n);
    zend_hash_next_index_insert(Z_ARRVAL_P(a), &v);
}

/* Db::$state->lastAffected: the affected count of the last successful write. */
static void set_last_affected(zval *self, zend_long n)
{
    zval v;
    ZVAL_LONG(&v, n);
    wr(rd(self, "state"), "lastAffected", &v);
}

/* ---- the statement cache and the statements ---- */

/* Db::stmt: the prepared statement of sql, from the cache of the connection (the oldest one is closed when the cache is full). */
static bool stmt_of(zval *self, zval *sql, zval *out)
{
    zval pdo;
    if (!handle_pdo(self, &pdo)) {
        return false;
    }
    zval *state = rd(self, "state");
    zval *stmts = array_prop(state, "stmts");
    zval *hit = zend_symtable_find(Z_ARRVAL_P(stmts), Z_STR_P(sql));
    if (hit != NULL) {
        ZVAL_COPY(out, hit);
        zval_ptr_dtor(&pdo);
        return true;
    }
    zval text;
    ZVAL_COPY(&text, sql);
    zval *drv = rd(self, "driver");
    if (is_str(drv, "postgres")) {
        /* pdo_pgsql numbers placeholders itself: the $n of the plan are replaced by ?. */
        const char *s = Z_STRVAL_P(sql);
        size_t len = Z_STRLEN_P(sql);
        smart_str b = {0};
        for (size_t i = 0; i < len; i++) {
            if (s[i] == '$' && i + 1 < len && s[i + 1] >= '0' && s[i + 1] <= '9') {
                size_t j = i + 1;
                while (j < len && s[j] >= '0' && s[j] <= '9') {
                    j++;
                }
                smart_str_appendc(&b, '?');
                i = j - 1;
                continue;
            }
            smart_str_appendc(&b, s[i]);
        }
        smart_str_0(&b);
        zval_ptr_dtor(&text);
        ZVAL_STR(&text, b.s ? b.s : ZSTR_EMPTY_ALLOC());
    }
    zval st;
    bool ok = mcall(&pdo, "prepare", &st, 1, &text);
    zval_ptr_dtor(&text);
    zval_ptr_dtor(&pdo);
    if (!ok) {
        return false;
    }
    zval stored;
    ZVAL_COPY(&stored, &st);
    zend_symtable_update(Z_ARRVAL_P(stmts), Z_STR_P(sql), &stored);
    zval *order = array_prop(state, "stmtOrder");
    push(order, sql);
    zend_long limit = as_long(rd(rd(self, "config"), "statementCacheSize"));
    while ((zend_long)zend_hash_num_elements(Z_ARRVAL_P(order)) > limit) {
        zval *first = zend_hash_index_find(Z_ARRVAL_P(order), 0);
        zval oldest;
        ZVAL_COPY(&oldest, first);
        zval *old = zend_symtable_find(Z_ARRVAL_P(stmts), Z_STR(oldest));
        if (old != NULL) {
            zval r;
            if (mcall(old, "closeCursor", &r, 0, NULL)) {
                zval_ptr_dtor(&r);
            }
        }
        zend_symtable_del(Z_ARRVAL_P(stmts), Z_STR(oldest));
        /* array_shift: the list is kept without its first value and renumbered. */
        zval rest;
        array_init(&rest);
        zval *v;
        bool first_seen = false;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(order), v)
        {
            if (!first_seen) {
                first_seen = true;
                continue;
            }
            push(&rest, v);
        }
        ZEND_HASH_FOREACH_END();
        wr(state, "stmtOrder", &rest);
        zval_ptr_dtor(&rest);
        zval_ptr_dtor(&oldest);
        order = array_prop(state, "stmtOrder");
    }
    ZVAL_COPY(out, &st);
    zval_ptr_dtor(&st);
    return true;
}

/* Db::exec: binds the arguments with their types where the driver needs them, and executes the statement. */
static bool exec_stmt(zval *self, zval *st, zval *args)
{
    zval r;
    if (!as_bool(rd(self, "typed"))) {
        if (!mcall(st, "execute", &r, 1, args)) {
            return false;
        }
        zval_ptr_dtor(&r);
        return true;
    }
    zval *drv = rd(self, "driver");
    if (is_str(drv, "mysql")) {
        zval bound;
        array_init(&bound);
        zend_ulong idx;
        zval *v;
        ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(args), idx, v)
        {
            ZVAL_DEREF(v);
            if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) {
                zval i;
                ZVAL_LONG(&i, Z_TYPE_P(v) == IS_TRUE);
                zend_hash_index_update(Z_ARRVAL(bound), idx, &i);
            } else if (is_instance(v, BYTES_CLASS)) {
                push(&bound, rd(v, "bytes"));
            } else {
                push(&bound, v);
            }
        }
        ZEND_HASH_FOREACH_END();
        bool ok = mcall(st, "execute", &r, 1, &bound);
        zval_ptr_dtor(&bound);
        if (ok) {
            zval_ptr_dtor(&r);
        }
        return ok;
    }
    bool pg = is_str(drv, "postgres");
    zend_ulong idx;
    zval *v;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(args), idx, v)
    {
        ZVAL_DEREF(v);
        zval argv[3];
        ZVAL_LONG(&argv[0], (zend_long)idx + 1);
        ZVAL_NULL(&argv[1]);
        ZVAL_NULL(&argv[2]);
        uint32_t argc = 2;
        if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) {
            if (pg) {
                ZVAL_BOOL(&argv[1], Z_TYPE_P(v) == IS_TRUE);
                ZVAL_LONG(&argv[2], PARAM_BOOL);
            } else {
                ZVAL_LONG(&argv[1], Z_TYPE_P(v) == IS_TRUE);
                ZVAL_LONG(&argv[2], PARAM_INT);
            }
            argc = 3;
        } else if (is_instance(v, BYTES_CLASS)) {
            ZVAL_COPY(&argv[1], rd(v, "bytes"));
            ZVAL_LONG(&argv[2], PARAM_LOB);
            argc = 3;
        } else if (Z_TYPE_P(v) == IS_NULL) {
            ZVAL_NULL(&argv[1]);
            ZVAL_LONG(&argv[2], PARAM_NULL);
            argc = 3;
        } else if (Z_TYPE_P(v) == IS_LONG && !pg) {
            ZVAL_COPY(&argv[1], v);
            ZVAL_LONG(&argv[2], PARAM_INT);
            argc = 3;
        } else {
            ZVAL_STR(&argv[1], zval_get_string(v));
        }
        bool ok = mcall(st, "bindValue", &r, argc, argv);
        for (uint32_t i = 1; i < 3; i++) {
            zval_ptr_dtor(&argv[i]);
        }
        if (!ok) {
            return false;
        }
        zval_ptr_dtor(&r);
    }
    ZEND_HASH_FOREACH_END();
    if (!mcall(st, "execute", &r, 0, NULL)) {
        return false;
    }
    zval_ptr_dtor(&r);
    return true;
}

/* ---- time values (Db::timeValue) ---- */

static bool is_digit_run(const char *s, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') {
            return false;
        }
    }
    return true;
}

static zend_long digits_value(const char *s, size_t n)
{
    zend_long v = 0;
    for (size_t i = 0; i < n; i++) {
        v = v * 10 + (s[i] - '0');
    }
    return v;
}

/* Matches "HH:MM:SS" at s (len bytes) and returns the number of bytes it takes, or 0. */
static size_t match_hms(const char *s, size_t len)
{
    if (len < 8 || !is_digit_run(s, 2) || s[2] != ':' || !is_digit_run(s + 3, 2) || s[5] != ':' || !is_digit_run(s + 6, 2)) {
        return 0;
    }
    return 8;
}

/* Matches "\.\d{1,6}" at s and returns its length, or 0 when absent. -1 when present but malformed. */
static int match_fraction(const char *s, size_t len, size_t *digits_out)
{
    if (len == 0 || s[0] != '.') {
        *digits_out = 0;
        return 0;
    }
    size_t n = 0;
    while (1 + n < len && s[1 + n] >= '0' && s[1 + n] <= '9') {
        n++;
    }
    if (n < 1 || n > 6) {
        return -1;
    }
    *digits_out = n;
    return (int)(1 + n);
}

/* $dt->format($fmt) as a zend_string the caller owns, or NULL on failure. */
static zend_string *format_of(zval *dt, const char *fmt)
{
    zval a, r;
    str_zv(&a, fmt);
    bool ok = mcall(dt, "format", &r, 1, &a);
    zval_ptr_dtor(&a);
    if (!ok) {
        return NULL;
    }
    zend_string *s = zval_get_string(&r);
    zval_ptr_dtor(&r);
    return s;
}

/* Db::timeText: 'Y-m-d H:i:s' with the fraction digits of precision. */
static zend_string *time_text(zval *dt, zend_long prec)
{
    zend_string *base = format_of(dt, "Y-m-d H:i:s");
    if (base == NULL) {
        return NULL;
    }
    if (prec <= 0) {
        return base;
    }
    zend_string *u = format_of(dt, "u");
    if (u == NULL) {
        zend_string_release(base);
        return NULL;
    }
    size_t take = (size_t)prec < ZSTR_LEN(u) ? (size_t)prec : ZSTR_LEN(u);
    zend_string *out = zend_strpprintf(0, "%s.%.*s", ZSTR_VAL(base), (int)take, ZSTR_VAL(u));
    zend_string_release(base);
    zend_string_release(u);
    return out;
}

/* Db::boundTimeText: a digit past precision must be zero, or the value has no column value (CODEC_ENCODE). */
static bool bound_time_text(zval *dt, zend_long prec, const char *col, zend_string **out)
{
    zend_string *u = format_of(dt, "u");
    if (u == NULL) {
        return false;
    }
    for (size_t i = (size_t)prec; i < ZSTR_LEN(u); i++) {
        if (ZSTR_VAL(u)[i] != '0') {
            zend_string *full = format_of(dt, "Y-m-d H:i:s.u");
            throw_orm("CODEC_ENCODE", "%s value %s has a non-zero digit past its %ld fraction digits", col,
                full != NULL ? ZSTR_VAL(full) : "", (long)prec);
            if (full != NULL) {
                zend_string_release(full);
            }
            zend_string_release(u);
            return false;
        }
    }
    zend_string_release(u);
    *out = time_text(dt, prec);
    return *out != NULL;
}

static void invalid_time_text(const char *v, size_t vlen, const char *col)
{
    const char *form = strcmp(col, "date") == 0 ? "YYYY-MM-DD" : "YYYY-MM-DD HH:MM:SS[.ffffff][Z|\xc2\xb1HH:MM]";
    throw_orm("CODEC_ENCODE", "%s value \"%.*s\" is not %s", col, (int)vlen, v, form);
}

/* Db::timeValue. Dates and times are text with no offset; a datetime is converted to the connection zone. out is the value. */
static bool time_value(zval *v, const char *col, zend_long prec, zval *zone, zval *out)
{
    zval cur;
    ZVAL_COPY(&cur, v);
    if (strcmp(col, "time") == 0 && is_instance(&cur, "DateTimeInterface")) {
        zval imm, tz;
        bool ok = scall("DateTimeImmutable::createFromInterface", &imm, 1, &cur)
            && mcall(&imm, "setTimezone", &tz, 1, zone);
        zval_ptr_dtor(&cur);
        if (!ok) {
            return false;
        }
        zval_ptr_dtor(&imm);
        zend_string *s = format_of(&tz, "H:i:s.u");
        zval_ptr_dtor(&tz);
        if (s == NULL) {
            return false;
        }
        ZVAL_STR(&cur, s);
    }
    if (strcmp(col, "time") == 0 && Z_TYPE(cur) == IS_STRING) {
        const char *s = Z_STRVAL(cur);
        size_t len = Z_STRLEN(cur);
        size_t n = match_hms(s, len);
        size_t fd = 0;
        int fl = n == 0 ? -1 : match_fraction(s + n, len - n, &fd);
        if (n == 0 || fl < 0 || n + (size_t)(fl == 0 ? 0 : fl) != len) {
            zval_ptr_dtor(&cur);
            throw_orm("CODEC_ENCODE", "time value \"%.*s\" is not HH:MM:SS[.ffffff]", (int)len, s);
            return false;
        }
        zend_long h = digits_value(s, 2), m = digits_value(s + 3, 2), sec = digits_value(s + 6, 2);
        if (h > 23 || m > 59 || sec > 59) {
            zval_ptr_dtor(&cur);
            throw_orm("CODEC_ENCODE", "time value \"%.*s\" is not HH:MM:SS[.ffffff]", (int)len, s);
            return false;
        }
        /* The fraction padded to six digits: the digits past the precision must be zero. */
        char frac[7] = "000000";
        if (fd > 0) {
            memcpy(frac, s + n + 1, fd);
        }
        for (size_t i = (size_t)prec; i < 6; i++) {
            if (frac[i] != '0') {
                zval_ptr_dtor(&cur);
                throw_orm("CODEC_ENCODE", "time value \"%.*s\" has a non-zero digit past its %ld fraction digits",
                    (int)len, s, (long)prec);
                return false;
            }
        }
        if (prec > 0) {
            ZVAL_STR(out, zend_strpprintf(0, "%.8s.%.*s", s, (int)prec, frac));
        } else {
            ZVAL_STR(out, zend_strpprintf(0, "%.8s", s));
        }
        zval_ptr_dtor(&cur);
        return true;
    }
    if (is_instance(&cur, "DateTimeInterface")) {
        if (strcmp(col, "date") == 0) {
            zend_string *d = format_of(&cur, "Y-m-d");
            zval_ptr_dtor(&cur);
            if (d == NULL) {
                return false;
            }
            ZVAL_STR(out, d);
            return true;
        }
        zval imm, tz;
        bool ok = scall("DateTimeImmutable::createFromInterface", &imm, 1, &cur)
            && mcall(&imm, "setTimezone", &tz, 1, zone);
        zval_ptr_dtor(&cur);
        if (!ok) {
            return false;
        }
        zval_ptr_dtor(&imm);
        zend_string *b = NULL;
        ok = bound_time_text(&tz, prec, col, &b);
        zval_ptr_dtor(&tz);
        if (!ok) {
            return false;
        }
        ZVAL_STR(out, b);
        return true;
    }
    if (Z_TYPE(cur) != IS_STRING) {
        ZVAL_COPY(out, &cur);
        zval_ptr_dtor(&cur);
        return true;
    }
    const char *s = Z_STRVAL(cur);
    size_t len = Z_STRLEN(cur);
    if (strcmp(col, "date") == 0) {
        bool shape = len == 10 && is_digit_run(s, 4) && s[4] == '-' && is_digit_run(s + 5, 2) && s[7] == '-' && is_digit_run(s + 8, 2);
        bool ok = false;
        if (shape) {
            zval args[3], d;
            str_zv(&args[0], "!Y-m-d");
            ZVAL_COPY(&args[1], &cur);
            ZVAL_COPY(&args[2], zone);
            bool made = scall("DateTimeImmutable::createFromFormat", &d, 3, args);
            zval_ptr_dtor(&args[0]);
            zval_ptr_dtor(&args[1]);
            zval_ptr_dtor(&args[2]);
            if (made && Z_TYPE(d) == IS_OBJECT) {
                zend_string *back = format_of(&d, "Y-m-d");
                ok = back != NULL && ZSTR_LEN(back) == len && memcmp(ZSTR_VAL(back), s, len) == 0;
                if (back != NULL) {
                    zend_string_release(back);
                }
            }
            zval_ptr_dtor(&d);
        }
        if (!ok) {
            invalid_time_text(s, len, col);
            zval_ptr_dtor(&cur);
            return false;
        }
        ZVAL_COPY(out, &cur);
        zval_ptr_dtor(&cur);
        return true;
    }
    /* A date, a space or T, the time, the fraction, and an optional offset: Z or +HH:MM or -HH:MM. */
    bool shape = len >= 19 && is_digit_run(s, 4) && s[4] == '-' && is_digit_run(s + 5, 2) && s[7] == '-' && is_digit_run(s + 8, 2)
        && (s[10] == ' ' || s[10] == 'T') && match_hms(s + 11, len - 11) == 8;
    size_t pos = 19;
    size_t fd = 0;
    if (shape && pos < len) {
        int fl = match_fraction(s + pos, len - pos, &fd);
        if (fl < 0) {
            shape = false;
        } else {
            pos += (size_t)fl;
        }
    }
    bool has_offset = false;
    char offset[7] = "";
    if (shape && pos < len) {
        if (s[pos] == 'Z' && pos + 1 == len) {
            has_offset = true;
            strcpy(offset, "Z");
            pos = len;
        } else if ((s[pos] == '+' || s[pos] == '-') && len - pos == 6 && is_digit_run(s + pos + 1, 2)
            && s[pos + 3] == ':' && is_digit_run(s + pos + 4, 2)) {
            has_offset = true;
            memcpy(offset, s + pos, 6);
            pos = len;
        } else {
            shape = false;
        }
    }
    if (!shape || pos != len) {
        invalid_time_text(s, len, col);
        zval_ptr_dtor(&cur);
        return false;
    }
    char frac[7] = "000000";
    if (fd > 0) {
        memcpy(frac, s + 20, fd);
    }
    /* The text of the value, as the library writes it: "Y-m-d H:i:s.u", with the fraction padded to six digits. */
    zend_string *text = zend_strpprintf(0, "%.10s %.8s.%s", s, s + 11, frac);
    zval args[2], t;
    bool made;
    if (!has_offset) {
        str_zv(&args[0], "!Y-m-d H:i:s.u");
        ZVAL_STR_COPY(&args[1], text);
        zval argv[3];
        ZVAL_COPY_VALUE(&argv[0], &args[0]);
        ZVAL_COPY_VALUE(&argv[1], &args[1]);
        ZVAL_COPY(&argv[2], zone);
        made = scall("DateTimeImmutable::createFromFormat", &t, 3, argv);
        zval_ptr_dtor(&argv[0]);
        zval_ptr_dtor(&argv[1]);
        zval_ptr_dtor(&argv[2]);
    } else {
        zend_string *withoff = zend_strpprintf(0, "%s%s", ZSTR_VAL(text), strcmp(offset, "Z") == 0 ? "+00:00" : offset);
        str_zv(&args[0], "!Y-m-d H:i:s.uP");
        ZVAL_STR(&args[1], withoff);
        made = scall("DateTimeImmutable::createFromFormat", &t, 2, args);
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&args[1]);
    }
    bool same = false;
    if (made && Z_TYPE(t) == IS_OBJECT) {
        zend_string *back = format_of(&t, "Y-m-d H:i:s.u");
        same = back != NULL && ZSTR_LEN(back) == ZSTR_LEN(text) && memcmp(ZSTR_VAL(back), ZSTR_VAL(text), ZSTR_LEN(text)) == 0;
        if (back != NULL) {
            zend_string_release(back);
        }
    }
    zend_string_release(text);
    if (!same) {
        invalid_time_text(s, len, col);
        zval_ptr_dtor(&t);
        zval_ptr_dtor(&cur);
        return false;
    }
    zval local = t;
    if (has_offset) {
        zval tz;
        bool ok = mcall(&t, "setTimezone", &tz, 1, zone);
        zval_ptr_dtor(&t);
        if (!ok) {
            zval_ptr_dtor(&cur);
            return false;
        }
        local = tz;
    }
    zend_string *b = NULL;
    bool bok = bound_time_text(&local, prec, col, &b);
    zval_ptr_dtor(&local);
    zval_ptr_dtor(&cur);
    if (!bok) {
        return false;
    }
    ZVAL_STR(out, b);
    return true;
}

/* Calls a library function whose first parameter is by reference (Assemble::index, Codec::decodeRows). target is passed as a
 * reference, and on success its final value replaces target. */
static bool scall_ref(const char *f, zval *target, uint32_t argc, zval *argv)
{
    zval tmp, ref, ret;
    ZVAL_COPY(&tmp, target);
    ZVAL_NEW_REF(&ref, &tmp);
    zval call[4];
    call[0] = ref;
    for (uint32_t i = 0; i < argc; i++) {
        call[i + 1] = argv[i];
    }
    bool ok = scall(f, &ret, argc + 1, call);
    zval_ptr_dtor(&ret);
    if (ok) {
        zval_ptr_dtor(target);
        ZVAL_COPY(target, Z_REFVAL(ref));
    }
    zval_ptr_dtor(&ref);
    return ok;
}

/* ---- keys and scalars (Db::scalarText, rowKey, rowSlot, sameScalar) ---- */

/* The text of a scalar in a key: null is one NUL byte, a bool is 1 or 0, a datetime is its microsecond text. */
static bool scalar_text(zval *v, zend_string **out)
{
    if (v == NULL || Z_TYPE_P(v) == IS_NULL) {
        *out = zend_string_init("\0", 1, 0);
        return true;
    }
    if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) {
        *out = zend_string_init(Z_TYPE_P(v) == IS_TRUE ? "1" : "0", 1, 0);
        return true;
    }
    if (is_instance(v, "DateTimeInterface")) {
        *out = format_of(v, "Y-m-d H:i:s.u");
        return *out != NULL;
    }
    *out = zval_get_string(v);
    return true;
}

static bool same_scalar(zval *a, zval *b)
{
    zend_string *x = NULL, *y = NULL;
    bool ok = scalar_text(a, &x) && scalar_text(b, &y);
    bool same = ok && ZSTR_LEN(x) == ZSTR_LEN(y) && memcmp(ZSTR_VAL(x), ZSTR_VAL(y), ZSTR_LEN(x)) == 0;
    if (x != NULL) {
        zend_string_release(x);
    }
    if (y != NULL) {
        zend_string_release(y);
    }
    return same;
}

/* The collection key of a row's key columns (Db::rowKey): out is NULL when a column is SQL NULL. */
static bool row_key(zval *row, zval *refs, zval *out)
{
    if (acount(refs) == 1) {
        zval *ref = aidx(refs, 0);
        zval *v = aidx(row, as_long(aget(ref, "index")));
        if (v == NULL) {
            ZVAL_NULL(out);
            return true;
        }
        return scall("Polyspec\\Orm\\Collection::keyOf", out, 1, v);
    }
    zend_string *acc = zend_string_init("", 0, 0);
    zval *ref;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(refs), ref)
    {
        zval *v = aidx(row, as_long(aget(ref, "index")));
        if (v == NULL) {
            zend_string_release(acc);
            ZVAL_NULL(out);
            return true;
        }
        zend_string *part = NULL;
        if (!scalar_text(v, &part)) {
            zend_string_release(acc);
            return false;
        }
        zend_string *piece = zend_strpprintf(0, "%s%zu:%.*s", ZSTR_VAL(acc), ZSTR_LEN(part), (int)ZSTR_LEN(part), ZSTR_VAL(part));
        zend_string_release(part);
        zend_string_release(acc);
        acc = piece;
    }
    ZEND_HASH_FOREACH_END();
    ZVAL_STR(out, acc);
    return true;
}

/* The identity of rowKey, the array key of a row grouping (Db::rowSlot): out is NULL for a NULL key. */
static bool row_slot(zval *row, zval *refs, zval *out)
{
    zval key;
    if (!row_key(row, refs, &key)) {
        return false;
    }
    if (Z_TYPE(key) == IS_NULL) {
        ZVAL_NULL(out);
        zval_ptr_dtor(&key);
        return true;
    }
    bool ok = scall("Polyspec\\Orm\\Collection::identityOf", out, 1, &key);
    zval_ptr_dtor(&key);
    return ok;
}

/* ---- the connection: registration, the request hook, the statement entry checks ---- */

/* Db::registeredModel: the manifest is registered on this connection, or SCHEMA_HASH_MISMATCH. */
static bool registered_model(zval *self, zval *hash, zval *out)
{
    zval *state = rd(self, "state");
    zval *sets = rd(state, "sets");
    if (sets == NULL || Z_TYPE_P(sets) != IS_ARRAY || zend_symtable_find(Z_ARRVAL_P(sets), Z_STR_P(hash)) == NULL) {
        throw_orm("SCHEMA_HASH_MISMATCH", "manifest %s is not registered on this connection: connect through its generated code or install it",
            Z_STRVAL_P(hash));
        return false;
    }
    return scall("Polyspec\\Orm\\Registry::model", out, 1, hash);
}

/* Db::hook: the request hook of this handle changes the request before the planner sees it. */
static bool apply_hook(zval *self, zval *r)
{
    zval *h = rd(self, "requestHook");
    if (h == NULL || Z_TYPE_P(h) != IS_OBJECT) {
        return true;
    }
    zval ret;
    ZVAL_UNDEF(&ret);
    bool ok = call_user_function(NULL, NULL, h, &ret, 1, r) == SUCCESS && EG(exception) == NULL;
    zval_ptr_dtor(&ret);
    return ok;
}

/* Db::enter: the connection is open, and a row lock is only inside a transaction: frame is the active transaction, or null. */
static bool enter(zval *self, zval *frame, zval *ir)
{
    if (as_bool(rd(rd(self, "state"), "closed"))) {
        throw_orm("CONFIG", "database is closed");
        return false;
    }
    if (frame != NULL && Z_TYPE_P(frame) == IS_OBJECT) {
        if (as_bool(rd(frame, "finished"))) {
            throw_orm("CONFIG", "transaction already finished");
            return false;
        }
    }
    zval *lock = aget(ir, "lock");
    bool in_transaction = frame != NULL && Z_TYPE_P(frame) == IS_OBJECT;
    if (lock != NULL && Z_TYPE_P(lock) == IS_STRING && Z_STRLEN_P(lock) > 0 && !in_transaction) {
        throw_orm("CONFIG", "row locks are allowed only inside a transaction");
        return false;
    }
    return true;
}

/* ---- the clock and the bind slots (Db::clock, args) ---- */

/* Db::clock: the time fixed by the test entry point, or the wall clock of the connection's zone. */
static bool clock_of(zval *self, zval *out)
{
    zval *fixed = rd(rd(self, "state"), "fixedClock");
    zval *zone = rd(self, "zone");
    if (fixed != NULL && Z_TYPE_P(fixed) == IS_OBJECT) {
        return mcall(fixed, "setTimezone", out, 1, zone);
    }
    zval args[2];
    str_zv(&args[0], "now");
    ZVAL_COPY(&args[1], zone);
    bool ok = newobj("DateTimeImmutable", out, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    return ok;
}

static bool list_has(zval *list, const char *s)
{
    zval *v;
    if (list == NULL || Z_TYPE_P(list) != IS_ARRAY) {
        return false;
    }
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(list), v)
    {
        ZVAL_DEREF(v);
        if (Z_TYPE_P(v) == IS_STRING && strcmp(Z_STRVAL_P(v), s) == 0) {
            return true;
        }
    }
    ZEND_HASH_FOREACH_END();
    return false;
}

/* Db::args: the bind values of a plan step, resolved from the parent values, the request parameters, the connection's
 * configuration, its clock and the audit of the frame. */
static bool args_of(zval *self, zval *step, zval *params, zval *parents, zval *frame, zval *out)
{
    array_init(out);
    zval masks;
    array_init(&masks);
    zval *driver = rd(self, "driver");
    zval *zone = rd(self, "zone");
    zval *cfg = rd(self, "config");
    bool typed = is_str(driver, "sqlite");
    bool have_clock = false;
    zval clock;
    zval *bs = aget(step, "bind_slots");
    zval *b;
    if (bs != NULL && Z_TYPE_P(bs) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(bs), b)
        {
            ZVAL_DEREF(b);
            zval *from = aget(b, "from");
            if (is_str(from, "parent")) {
                if (parents != NULL && Z_TYPE_P(parents) == IS_ARRAY) {
                    zval *pv;
                    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(parents), pv)
                    {
                        push(out, pv);
                    }
                    ZEND_HASH_FOREACH_END();
                }
            } else if (is_str(from, "param")) {
                zend_long pi = as_long(aget(b, "param"));
                zval nullv;
                ZVAL_NULL(&nullv);
                zval *pv = aidx(params, pi);
                zval v;
                ZVAL_COPY(&v, pv != NULL ? pv : &nullv);
                zval slot, dummy;
                zval argv[3];
                if (!scall("Polyspec\\Orm\\ParamCheck::bindSlotType", &slot, 1, b)) {
                    zval_ptr_dtor(&v);
                    goto fail;
                }
                ZVAL_LONG(&argv[0], pi);
                ZVAL_COPY(&argv[1], &v);
                ZVAL_COPY(&argv[2], &slot);
                bool ok = scall("Polyspec\\Orm\\ParamCheck::checkAssign", &dummy, 3, argv);
                zval_ptr_dtor(&dummy);
                for (int i = 0; i < 3; i++) {
                    zval_ptr_dtor(&argv[i]);
                }
                if (!ok) {
                    zval_ptr_dtor(&slot);
                    zval_ptr_dtor(&v);
                    goto fail;
                }
                zval *transform = aget(b, "transform");
                zval *styles = aget(b, "host_styles");
                if (is_empty_str(transform) && acount(styles) == 0) {
                    zval chk[4];
                    ZVAL_LONG(&chk[0], pi);
                    ZVAL_COPY(&chk[1], &v);
                    ZVAL_COPY(&chk[2], &slot);
                    ZVAL_COPY(&chk[3], zone);
                    bool cok = scall("Polyspec\\Orm\\ParamCheck::check", &dummy, 4, chk);
                    zval_ptr_dtor(&dummy);
                    for (int i = 0; i < 4; i++) {
                        zval_ptr_dtor(&chk[i]);
                    }
                    if (!cok) {
                        zval_ptr_dtor(&slot);
                        zval_ptr_dtor(&v);
                        goto fail;
                    }
                }
                zval_ptr_dtor(&slot);
                zval *colz = aget(b, "col_type");
                const char *col = colz != NULL && Z_TYPE_P(colz) == IS_STRING ? Z_STRVAL_P(colz) : "";
                if ((strcmp(col, "datetime") == 0 || strcmp(col, "date") == 0 || strcmp(col, "time") == 0) && Z_TYPE(v) != IS_NULL) {
                    zval tv;
                    if (!time_value(&v, col, as_long(aget(b, "precision")), zone, &tv)) {
                        zval_ptr_dtor(&v);
                        goto fail;
                    }
                    zval_ptr_dtor(&v);
                    ZVAL_COPY_VALUE(&v, &tv);
                }
                if (strcmp(col, "decimal") == 0 && Z_TYPE(v) != IS_NULL) {
                    if (Z_TYPE(v) != IS_STRING) {
                        zval_ptr_dtor(&v);
                        throw_orm("CODEC_ENCODE", "decimal bind requires exact text");
                        goto fail;
                    }
                    zval dargs[3], dres;
                    ZVAL_COPY(&dargs[0], &v);
                    ZVAL_COPY(&dargs[1], aget(b, "precision") ? aget(b, "precision") : &nullv);
                    ZVAL_COPY(&dargs[2], aget(b, "scale") ? aget(b, "scale") : &nullv);
                    bool dok = scall(is_str(driver, "sqlite") ? "Polyspec\\Orm\\Decimal::scaled" : "Polyspec\\Orm\\Decimal::normalize",
                        &dres, 3, dargs);
                    for (int i = 0; i < 3; i++) {
                        zval_ptr_dtor(&dargs[i]);
                    }
                    zval_ptr_dtor(&v);
                    if (!dok) {
                        goto fail;
                    }
                    ZVAL_COPY_VALUE(&v, &dres);
                }
                if (is_instance(&v, "DateTimeInterface")) {
                    zval imm, tz;
                    bool dok = scall("DateTimeImmutable::createFromInterface", &imm, 1, &v)
                        && mcall(&imm, "setTimezone", &tz, 1, zone);
                    zval_ptr_dtor(&v);
                    zval_ptr_dtor(&imm);
                    if (!dok) {
                        goto fail;
                    }
                    zend_string *s = format_of(&tz, "Y-m-d H:i:s.u");
                    zval_ptr_dtor(&tz);
                    if (s == NULL) {
                        goto fail;
                    }
                    ZVAL_STR(&v, s);
                }
                zval *tr = aget(b, "transform");
                zval *hs = aget(b, "host_styles");
                if (!is_empty_str(tr)) {
                    zval targs[2], tres;
                    ZVAL_COPY(&targs[0], tr);
                    ZVAL_COPY(&targs[1], &v);
                    bool tok = scall("Polyspec\\Orm\\Transform::param", &tres, 2, targs);
                    zval_ptr_dtor(&targs[0]);
                    zval_ptr_dtor(&targs[1]);
                    zval_ptr_dtor(&v);
                    if (!tok) {
                        goto fail;
                    }
                    ZVAL_COPY_VALUE(&v, &tres);
                } else if (list_has(hs, "blind_index")) {
                    zval bargs[2], bres;
                    ZVAL_COPY(&bargs[0], &v);
                    ZVAL_COPY(&bargs[1], rd(cfg, "blindIndexKey"));
                    bool bok = scall("Polyspec\\Orm\\Codec::blindIndex", &bres, 2, bargs);
                    zval_ptr_dtor(&bargs[0]);
                    zval_ptr_dtor(&bargs[1]);
                    zval_ptr_dtor(&v);
                    if (!bok) {
                        goto fail;
                    }
                    ZVAL_COPY_VALUE(&v, &bres);
                } else if (acount(hs) > 0) {
                    zval eargs[3], eres;
                    ZVAL_COPY(&eargs[0], &v);
                    ZVAL_COPY(&eargs[1], hs);
                    ZVAL_COPY(&eargs[2], rd(cfg, "aesKey"));
                    bool eok = scall("Polyspec\\Orm\\Codec::hostEncode", &eres, 3, eargs);
                    for (int i = 0; i < 3; i++) {
                        zval_ptr_dtor(&eargs[i]);
                    }
                    zval_ptr_dtor(&v);
                    if (!eok) {
                        goto fail;
                    }
                    ZVAL_COPY_VALUE(&v, &eres);
                    typed = typed || is_instance(&v, BYTES_CLASS);
                } else if (Z_TYPE(v) == IS_TRUE || Z_TYPE(v) == IS_FALSE || is_instance(&v, BYTES_CLASS)) {
                    typed = true;
                }
                push(out, &v);
                zval_ptr_dtor(&v);
                (void)hs;
            } else if (is_str(from, "secret")) {
                zval *name = aget(b, "name");
                if (!is_str(name, "aes") || is_empty_str(rd(cfg, "aesKey"))) {
                    throw_orm("CONFIG", "secret %s is not configured", name != NULL && Z_TYPE_P(name) == IS_STRING ? Z_STRVAL_P(name) : "");
                    goto fail;
                }
                set_masked(&masks, acount(out), SECRET_MASK);
                push(out, rd(cfg, "aesKey"));
            } else if (is_str(from, "config")) {
                zval *name = aget(b, "name");
                if (!is_str(name, "aes_version")) {
                    throw_orm("CONFIG", "config value %s is not configured", name != NULL && Z_TYPE_P(name) == IS_STRING ? Z_STRVAL_P(name) : "");
                    goto fail;
                }
                push(out, rd(cfg, "aesVersion"));
            } else if (is_str(from, "now")) {
                set_masked(&masks, acount(out), NOW_MASK);
                if (!have_clock) {
                    if (!clock_of(self, &clock)) {
                        goto fail;
                    }
                    have_clock = true;
                }
                zend_string *t = time_text(&clock, as_long(aget(b, "precision")));
                if (t == NULL) {
                    goto fail;
                }
                zval tz;
                ZVAL_STR(&tz, t);
                push(out, &tz);
                zval_ptr_dtor(&tz);
            } else if (is_str(from, "audit")) {
                zval *audit = frame != NULL && Z_TYPE_P(frame) == IS_OBJECT ? rd(frame, "audit") : NULL;
                if (audit == NULL) {
                    throw_orm("CONFIG", "a write of an audited table needs an audit: run it in a transaction with audit values");
                    goto fail;
                }
                zval *aname = aget(audit, "table");
                zval *bname = aget(b, "name");
                if (!(aname != NULL && bname != NULL && zend_string_equals(Z_STR_P(bname), Z_STR_P(aname)))) {
                    throw_orm("CONFIG", "the audited table records its audits in %s, but the audit of the transaction is a row of %s",
                        bname != NULL && Z_TYPE_P(bname) == IS_STRING ? Z_STRVAL_P(bname) : "",
                        aname != NULL && Z_TYPE_P(aname) == IS_STRING ? Z_STRVAL_P(aname) : "");
                    goto fail;
                }
                push(out, aget(audit, "key"));
            } else {
                throw_orm("INTERNAL", "bind from %s", from != NULL && Z_TYPE_P(from) == IS_STRING ? Z_STRVAL_P(from) : "");
                goto fail;
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    if (have_clock) {
        zval_ptr_dtor(&clock);
    }
    wr(self, "masks", &masks);
    zval tv;
    ZVAL_BOOL(&tv, typed);
    wr(self, "typed", &tv);
    zval_ptr_dtor(&masks);
    return true;
fail:
    if (have_clock) {
        zval_ptr_dtor(&clock);
    }
    zval_ptr_dtor(&masks);
    zval_ptr_dtor(out);
    ZVAL_UNDEF(out);
    return false;
}

/* ---- the statements of the statement path (Db::query, scalar, relations, rootInParts) ---- */

static void set_masked(zval *masks, zend_long idx, const char *s)
{
    zval v;
    ZVAL_STRING(&v, s);
    zend_hash_index_update(Z_ARRVAL_P(masks), (zend_ulong)idx, &v);
}

/* The send bodies of the statements. Each returns false with the PDO exception pending or another exception; a pending PDO
 * exception has closed its cursor first (Db::failed). */
typedef struct qctx {
    zval *sql;
    zval *args;
} qctx;

static bool op_query(zval *self, void *ctx, zval *ret)
{
    qctx *c = ctx;
    zval st, mode, rows, r;
    if (!stmt_of(self, c->sql, &st)) {
        return false;
    }
    if (!exec_stmt(self, &st, c->args)) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    ZVAL_LONG(&mode, FETCH_NUM);
    if (!mcall(&st, "fetchAll", &rows, 1, &mode)) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    bool ok = mcall(&st, "closeCursor", &r, 0, NULL);
    zval_ptr_dtor(&st);
    if (!ok) {
        zval_ptr_dtor(&rows);
        return false;
    }
    zval_ptr_dtor(&r);
    ZVAL_COPY_VALUE(ret, &rows);
    return true;
}

static bool op_scalar(zval *self, void *ctx, zval *ret)
{
    qctx *c = ctx;
    zval st, v, r;
    if (!stmt_of(self, c->sql, &st)) {
        return false;
    }
    if (!exec_stmt(self, &st, c->args)) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    if (!mcall(&st, "fetchColumn", &v, 0, NULL)) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    bool ok = mcall(&st, "closeCursor", &r, 0, NULL);
    zval_ptr_dtor(&st);
    if (!ok) {
        zval_ptr_dtor(&v);
        return false;
    }
    zval_ptr_dtor(&r);
    ZVAL_COPY_VALUE(ret, &v);
    return true;
}

/* Db::query and Db::scalar: the statement of the step with its args, published as a model statement. */
static bool query_rows(zval *self, zval *step, zval *params, zval *sql_in, zval *parents, zval *out)
{
    zval sql;
    if (sql_in != NULL) {
        ZVAL_COPY(&sql, sql_in);
    } else {
        ZVAL_COPY(&sql, aget(step, "sql"));
    }
    zval args;
    zval empty_parents;
    array_init(&empty_parents);
    bool ok = args_of(self, step, params, parents != NULL ? parents : &empty_parents, NULL, &args);
    zval_ptr_dtor(&empty_parents);
    if (!ok) {
        zval_ptr_dtor(&sql);
        return false;
    }
    qctx qc = {&sql, &args};
    modelctx mc = {step, &sql, &args};
    zval rows;
    ok = send_op(self, false, op_query, &qc, done_model, &mc, &rows);
    zval_ptr_dtor(&sql);
    if (ok) {
        zval *dec = aget(step, "decode");
        if (dec != NULL && acount(dec) > 0) {
            zval cargs[2];
            ZVAL_COPY(&cargs[0], dec);
            ZVAL_COPY(&cargs[1], rd(self, "config"));
            ok = scall_ref("Polyspec\\Orm\\Codec::decodeRows", &rows, 2, cargs);
            zval_ptr_dtor(&cargs[0]);
            zval_ptr_dtor(&cargs[1]);
            if (!ok) {
                zval_ptr_dtor(&rows);
            }
        }
    } else {
        zval_ptr_dtor(&rows);
    }
    zval_ptr_dtor(&args);
    if (ok) {
        ZVAL_COPY_VALUE(out, &rows);
    }
    return ok;
}

static bool scalar_of_step(zval *self, zval *step, zval *params, zval *out)
{
    zval args;
    if (!args_of(self, step, params, NULL, NULL, &args)) {
        return false;
    }
    zval sql;
    ZVAL_COPY(&sql, aget(step, "sql"));
    qctx qc = {&sql, &args};
    modelctx mc = {step, &sql, &args};
    zval v;
    bool ok = send_op(self, false, op_scalar, &qc, done_model, &mc, &v);
    zval_ptr_dtor(&sql);
    zval_ptr_dtor(&args);
    if (!ok) {
        return false;
    }
    if (Z_TYPE(v) == IS_FALSE) {
        ZVAL_NULL(out);
        zval_ptr_dtor(&v);
    } else {
        ZVAL_COPY_VALUE(out, &v);
    }
    return true;
}

/* Pushes the value of row[index] (or null) on the list out. */
static void push_at(zval *out, zval *row, zval *idx_src)
{
    zval *v = aidx(row, as_long(aget(idx_src, "index")));
    if (v == NULL) {
        zval n;
        ZVAL_NULL(&n);
        zend_hash_next_index_insert(Z_ARRVAL_P(out), &n);
        return;
    }
    push(out, v);
}

/* Db::parentValues: the distinct parent keys of the rows, with the keys' values in order. */
static bool parent_values(zval *pr, zval *parents, zval *params, zval *out)
{
    array_init(out);
    zval seen;
    array_init(&seen);
    zval *ifp = aget(pr, "if_parent");
    zval *keys = aget(pr, "keys");
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(parents), row)
    {
        ZVAL_DEREF(row);
        if (ifp != NULL) {
            zval *pv = aidx(params, as_long(aget(ifp, "param")));
            zval nullv;
            ZVAL_NULL(&nullv);
            zval *rv = aidx(row, as_long(aget(ifp, "index")));
            zval *left = rv != NULL ? rv : &nullv;
            if (!same_scalar(left, pv != NULL ? pv : &nullv)) {
                continue;
            }
        }
        zval key;
        if (!row_slot(row, keys, &key)) {
            zval_ptr_dtor(&seen);
            zval_ptr_dtor(out);
            return false;
        }
        if (Z_TYPE(key) == IS_NULL || zend_symtable_find(Z_ARRVAL(seen), Z_STR(key)) != NULL) {
            zval_ptr_dtor(&key);
            continue;
        }
        zval t;
        ZVAL_TRUE(&t);
        zend_symtable_update(Z_ARRVAL(seen), Z_STR(key), &t);
        zval_ptr_dtor(&key);
        zval *ref;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), ref)
        {
            push_at(out, row, ref);
        }
        ZEND_HASH_FOREACH_END();
    }
    ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&seen);
    return true;
}

/* Db::expandIn: rewrites the parent placeholder of a relation step into a list padded to a power of two. The values are padded
 * the same way; on PostgreSQL every later placeholder number shifts. */
static bool expand_in(zval *step, zval *vals, zval *sql_out, zval *vals_out)
{
    zval *pk = aget(aget(step, "parent"), "keys");
    zend_long width = acount(pk);
    zend_long tuples = width == 0 ? 0 : acount(vals) / width;
    zend_long n = 1;
    while (n < tuples) {
        n <<= 1;
    }
    array_init(vals_out);
    zval *v;
    zend_long i = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(vals), v)
    {
        (void)i;
        push(vals_out, v);
        i++;
    }
    ZEND_HASH_FOREACH_END();
    /* The last tuple repeats: array_slice(vals, (tuples - 1) * width, width). */
    zend_long last_from = (tuples - 1) * width;
    while (acount(vals_out) < n * width) {
        for (zend_long p = 0; p < width; p++) {
            zval *lv = aidx(vals, last_from + p);
            zval nullv;
            ZVAL_NULL(&nullv);
            push(vals_out, lv != NULL ? lv : &nullv);
        }
    }
    const char *src = Z_STRVAL_P(aget(step, "sql"));
    size_t len = strlen(src);
    smart_str b = {0};
    zval *bs = aget(step, "bind_slots");
    const char *sep = width == 1 ? ", " : "), (";
    if (strstr(src, "$1") != NULL) {
        zend_long parent = -1;
        zval *bsv;
        zend_ulong bi = 0;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(bs), bsv)
        {
            (void)bi;
            zval *from = aget(bsv, "from");
            if (is_str(from, "parent")) {
                parent = (zend_long)bi + 1;
            }
            bi++;
        }
        ZEND_HASH_FOREACH_END();
        for (size_t p = 0; p < len; p++) {
            if (src[p] != '$' || p + 1 >= len || src[p + 1] < '0' || src[p + 1] > '9') {
                smart_str_appendc(&b, src[p]);
                continue;
            }
            size_t q = p + 1;
            zend_long k = 0;
            while (q < len && src[q] >= '0' && src[q] <= '9') {
                k = k * 10 + (src[q] - '0');
                q++;
            }
            if (k == parent) {
                for (zend_long t = 0; t < n; t++) {
                    if (t > 0) {
                        smart_str_appends(&b, sep);
                    }
                    for (zend_long pp = 0; pp < width; pp++) {
                        if (pp > 0) {
                            smart_str_appends(&b, ", ");
                        }
                        smart_str_appendc(&b, '$');
                        smart_str_append_long(&b, k + t * width + pp);
                    }
                }
            } else if (k > parent) {
                smart_str_appendc(&b, '$');
                smart_str_append_long(&b, k + n * width - 1);
            } else {
                smart_str_appendl(&b, src + p, q - p);
            }
            p = q - 1;
        }
    } else {
        zend_long slot = 0;
        for (size_t p = 0; p < len; p++) {
            if (src[p] != '?') {
                smart_str_appendc(&b, src[p]);
                continue;
            }
            zval *from = aidx(bs, slot);
            zval *fv = from != NULL ? aget(from, "from") : NULL;
            if (is_str(fv, "parent")) {
                for (zend_long t = 0; t < n; t++) {
                    if (t > 0) {
                        smart_str_appends(&b, sep);
                    }
                    for (zend_long pp = 0; pp < width; pp++) {
                        if (pp > 0) {
                            smart_str_appends(&b, ", ");
                        }
                        smart_str_appendc(&b, '?');
                    }
                }
            } else {
                smart_str_appendc(&b, '?');
            }
            slot++;
        }
    }
    smart_str_0(&b);
    ZVAL_STR(sql_out, b.s ? b.s : ZSTR_EMPTY_ALLOC());
    return true;
}

/* Db::relationChunks: the parent values in chunks of a power of two of tuples that the driver's bind limit allows. */
static bool relation_chunks(zval *step, zval *vals, zval *driver, zval *out)
{
    zend_long width = acount(aget(aget(step, "parent"), "keys"));
    zval *bs = aget(step, "bind_slots");
    zend_long non_parent = 0;
    zval *b;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(bs), b)
    {
        if (!is_str(aget(b, "from"), "parent")) {
            non_parent++;
        }
    }
    ZEND_HASH_FOREACH_END();
    zend_long max_tuples = width == 0 ? 0 : (bind_limit(driver) - non_parent) / width;
    if (max_tuples < 1) {
        throw_orm("IR_INVALID", "relation %ld needs more bind parameters than %s permits", (long)as_long(aget(step, "id")),
            Z_STRVAL_P(driver));
        return false;
    }
    zend_long chunk = 1;
    while (chunk * 2 <= max_tuples) {
        chunk *= 2;
    }
    array_init(out);
    zend_long size = chunk * width;
    zval cur;
    array_init(&cur);
    zend_long count = 0;
    zval *v;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(vals), v)
    {
        push(&cur, v);
        count++;
        if (count == size) {
            zend_hash_next_index_insert(Z_ARRVAL_P(out), &cur);
            array_init(&cur);
            count = 0;
        }
    }
    ZEND_HASH_FOREACH_END();
    if (count > 0) {
        zend_hash_next_index_insert(Z_ARRVAL_P(out), &cur);
    } else {
        zval_ptr_dtor(&cur);
    }
    return true;
}

static bool find_child(zval *a, zend_long id, zval *out)
{
    zval *children = aget(a, "children");
    zval *ch;
    if (children == NULL || Z_TYPE_P(children) != IS_ARRAY) {
        return false;
    }
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(children), ch)
    {
        ZVAL_DEREF(ch);
        zval *kind = aget(ch, "kind");
        if (!is_str(kind, "join") && aget(ch, "step") != NULL && as_long(aget(ch, "step")) == id) {
            zval *keys = aget(ch, "child_keys");
            if (keys != NULL) {
                ZVAL_COPY(out, keys);
            } else {
                ZVAL_NULL(out);
            }
            return true;
        }
        if (is_str(kind, "join") && find_child(aget(ch, "assemble"), id, out)) {
            return true;
        }
    }
    ZEND_HASH_FOREACH_END();
    return false;
}

/* Db::childKeys: the key columns of the child of the relation step id. */
static bool child_keys_of(zval *plan, zend_long id, zval *out)
{
    zval *steps = aget(plan, "steps");
    zval *st;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(steps), st)
    {
        ZVAL_DEREF(st);
        zval *as = aget(st, "assemble");
        if (as != NULL && find_child(as, id, out)) {
            return true;
        }
    }
    ZEND_HASH_FOREACH_END();
    throw_orm("INTERNAL", "relation step %ld without a child", (long)id);
    return false;
}

/* Db::relations: the rows of the relation steps of the plan, grouped by the parent keys. */
static bool relations_of(zval *self, zval *plan, zval *params, zval *main, zval *out)
{
    zval steps_out;
    array_init(&steps_out);
    zval *steps = aget(plan, "steps");
    zval *st;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(steps), st)
    {
        ZVAL_DEREF(st);
        if (!is_str(aget(st, "role"), "relation")) {
            continue;
        }
        zval *pr = aget(st, "parent");
        zend_long pstep = as_long(aget(pr, "step"));
        zval *parents;
        if (pstep == 0) {
            parents = main;
        } else {
            zval *prev = zend_hash_index_find(Z_ARRVAL(steps_out), (zend_ulong)pstep);
            parents = aget(prev, "data");
            if (parents == NULL) {
                zval e;
                array_init(&e);
                parents = &e;
            }
        }
        zval vals;
        if (!parent_values(pr, parents, params, &vals)) {
            zval_ptr_dtor(&steps_out);
            return false;
        }
        zval sr;
        array_init(&sr);
        setk(&sr, "step", st);
        zval data;
        array_init(&data);
        zval byKey;
        array_init(&byKey);
        if (acount(&vals) > 0) {
            zval chunks;
            if (!relation_chunks(st, &vals, rd(self, "driver"), &chunks)) {
                zval_ptr_dtor(&vals);
                zval_ptr_dtor(&data);
                zval_ptr_dtor(&byKey);
                zval_ptr_dtor(&sr);
                zval_ptr_dtor(&steps_out);
                return false;
            }
            zval *chunk;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL(chunks), chunk)
            {
                zval sql, cvals;
                expand_in(st, chunk, &sql, &cvals);
                zval rows;
                if (!query_rows(self, st, params, &sql, &cvals, &rows)) {
                    zval_ptr_dtor(&sql);
                    zval_ptr_dtor(&cvals);
                    zval_ptr_dtor(&chunks);
                    zval_ptr_dtor(&vals);
                    zval_ptr_dtor(&data);
                    zval_ptr_dtor(&byKey);
                    zval_ptr_dtor(&sr);
                    zval_ptr_dtor(&steps_out);
                    return false;
                }
                zval *row;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row)
                {
                    push(&data, row);
                }
                ZEND_HASH_FOREACH_END();
                zval_ptr_dtor(&rows);
                zval_ptr_dtor(&sql);
                zval_ptr_dtor(&cvals);
            }
            ZEND_HASH_FOREACH_END();
            zval_ptr_dtor(&chunks);
        }
        zval keys;
        if (!child_keys_of(plan, as_long(aget(st, "id")), &keys)) {
            zval_ptr_dtor(&vals);
            zval_ptr_dtor(&data);
            zval_ptr_dtor(&byKey);
            zval_ptr_dtor(&sr);
            zval_ptr_dtor(&steps_out);
            return false;
        }
        zend_ulong j;
        zval *row;
        ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL(data), j, row)
        {
            zval key;
            if (!row_slot(row, &keys, &key)) {
                return false;
            }
            if (Z_TYPE(key) != IS_NULL) {
                zval *bucket = zend_symtable_find(Z_ARRVAL(byKey), Z_STR(key));
                if (bucket == NULL) {
                    zval nb;
                    array_init(&nb);
                    bucket = zend_symtable_update(Z_ARRVAL(byKey), Z_STR(key), &nb);
                }
                zval jv;
                ZVAL_LONG(&jv, (zend_long)j);
                zend_hash_next_index_insert(Z_ARRVAL_P(bucket), &jv);
            }
            zval_ptr_dtor(&key);
        }
        ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&keys);
        zval_ptr_dtor(&vals);
        setk(&sr, "data", &data);
        zval_ptr_dtor(&data);
        setk(&sr, "byKey", &byKey);
        zval_ptr_dtor(&byKey);
        zend_hash_index_update(Z_ARRVAL(steps_out), (zend_ulong)as_long(aget(st, "id")), &sr);
    }
    ZEND_HASH_FOREACH_END();
    array_init(out);
    setk(out, "main", main);
    zval steps_copy;
    ZVAL_COPY(&steps_copy, &steps_out);
    setk(out, "steps", &steps_copy);
    zval_ptr_dtor(&steps_copy);
    setk(out, "params", params);
    zval_ptr_dtor(&steps_out);
    return true;
}

static zend_long bind_limit(zval *driver)
{
    return is_str(driver, "sqlite") ? 999 : 65535;
}

/* The request with the IN list of its target predicate replaced by ps: a copy of ir with where.items[target].pred.ps set. */
static void with_ps(zval *ir, zend_long target, zval *ps, zval *out)
{
    ZVAL_ARR(out, zend_array_dup(Z_ARRVAL_P(ir)));
    zval where_c;
    ZVAL_ARR(&where_c, zend_array_dup(Z_ARRVAL_P(aget(out, "where"))));
    zval items_c;
    ZVAL_ARR(&items_c, zend_array_dup(Z_ARRVAL_P(aget(&where_c, "items"))));
    zval item_c;
    ZVAL_ARR(&item_c, zend_array_dup(Z_ARRVAL_P(aidx(&items_c, target))));
    zval pred_c;
    ZVAL_ARR(&pred_c, zend_array_dup(Z_ARRVAL_P(aget(&item_c, "pred"))));
    setk(&pred_c, "ps", ps);
    setk(&item_c, "pred", &pred_c);
    zval_ptr_dtor(&pred_c);
    zend_hash_index_update(Z_ARRVAL(items_c), (zend_ulong)target, &item_c);
    setk(&where_c, "items", &items_c);
    zval_ptr_dtor(&items_c);
    setk(out, "where", &where_c);
    zval_ptr_dtor(&where_c);
}

/* Db::rootInParts: a root IN list over the bind limit is split into requests whose results together equal the original result.
 * out is the list of the requests; it is empty when the statement fits. */
/* Adds one part of a split IN list to out: the request r with its IN list padded to the group, which is emptied for the next part. */
static bool emit_part(zval *out, zval *r, zval *ir, zend_long target, zval *group, zval *unique)
{
    zval padded, ir_new, part;
    if (!scall("Polyspec\\Orm\\Request::padIn", &padded, 1, group)) {
        zval_ptr_dtor(group);
        zval_ptr_dtor(unique);
        zval_ptr_dtor(out);
        return false;
    }
    with_ps(ir, target, &padded, &ir_new);
    zval_ptr_dtor(&padded);
    zend_object *clone = zend_objects_clone_obj(Z_OBJ_P(r));
    ZVAL_OBJ(&part, clone);
    wr(&part, "ir", &ir_new);
    zval_ptr_dtor(&ir_new);
    zend_hash_next_index_insert(Z_ARRVAL_P(out), &part);
    return true;
}

static bool root_parts(zval *self, zval *r, zval *step, zval *out)
{
    array_init(out);
    zend_long limit = bind_limit(rd(self, "driver"));
    zend_long nbind = acount(aget(step, "bind_slots"));
    if (nbind <= limit) {
        return true;
    }
    zval *ir = rd(r, "ir");
    zval *where = aget(ir, "where");
    zval *items = aget(where, "items");
    if (aget(ir, "limit") != NULL || aget(ir, "order") != NULL || aget(ir, "group_by") != NULL || acount(items) == 0) {
        goto too_large;
    }
    zend_long target = -1;
    zend_ulong i;
    zval *item;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(items), i, item)
    {
        zval *pred = aget(item, "pred");
        if (pred == NULL) {
            continue;
        }
        zval *next = aidx(items, (zend_long)i + 1);
        const char *next_conn = "";
        if (next != NULL) {
            zval *first = NULL;
            zval *fv;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(next), fv)
            {
                first = fv;
                break;
            }
            ZEND_HASH_FOREACH_END();
            zval *nc = first != NULL ? aget(first, "conn") : NULL;
            if (nc != NULL && Z_TYPE_P(nc) == IS_STRING) {
                next_conn = Z_STRVAL_P(nc);
            }
        }
        zval *pc = aget(pred, "conn");
        if (is_str(pc, "or") || strcmp(next_conn, "or") == 0) {
            goto too_large;
        }
        zval *op = aget(pred, "op");
        if (is_str(op, "in") && aget(pred, "sub") == NULL) {
            zval *tpred = target < 0 ? NULL : aget(aidx(items, target), "pred");
            if (target < 0 || acount(aget(pred, "ps")) > acount(aget(tpred, "ps"))) {
                target = (zend_long)i;
            }
        }
    }
    ZEND_HASH_FOREACH_END();
    if (target < 0) {
        goto too_large;
    }
    zval *ps = aget(aget(aidx(items, target), "pred"), "ps");
    zend_long available = limit - (nbind - acount(ps));
    if (available < 1) {
        goto too_large;
    }
    zend_long chunk = 1;
    while (chunk * 2 <= available) {
        chunk *= 2;
    }
    zval seen, unique;
    array_init(&seen);
    array_init(&unique);
    zval *p;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ps), p)
    {
        zval *pv = aidx(rd(r, "params"), as_long(p));
        zval nullv;
        ZVAL_NULL(&nullv);
        zend_string *k = NULL;
        if (!scalar_text(pv != NULL ? pv : &nullv, &k)) {
            zval_ptr_dtor(&seen);
            zval_ptr_dtor(&unique);
            zval_ptr_dtor(out);
            return false;
        }
        if (zend_symtable_find(Z_ARRVAL(seen), k) == NULL) {
            zval t;
            ZVAL_TRUE(&t);
            zend_symtable_update(Z_ARRVAL(seen), k, &t);
            push(&unique, p);
        }
        zend_string_release(k);
    }
    ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&seen);
    zend_long count = 0;
    zval group;
    array_init(&group);
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(unique), p)
    {
        push(&group, p);
        count++;
        if (count == chunk) {
            if (!emit_part(out, r, ir, target, &group, &unique)) {
                return false;
            }
            array_init(&group);
            count = 0;
        }
    }
    ZEND_HASH_FOREACH_END();
    if (count > 0) {
        if (!emit_part(out, r, ir, target, &group, &unique)) {
            return false;
        }
    } else {
        zval_ptr_dtor(&group);
    }
    zval_ptr_dtor(&unique);
    return true;
too_large:
    throw_orm("IR_INVALID", "the statement needs %ld bind parameters but %s permits %ld", (long)nbind,
        Z_STRVAL_P(rd(self, "driver")), (long)limit);
    zval_ptr_dtor(out);
    ZVAL_UNDEF(out);
    return false;
}

/* Db::plan: the plan of a request on this connection, which plans only the sets registered to it. */
static bool plan_of(zval *self, zval *r, zval *out)
{
    zval *hash = aget(rd(r, "ir"), "manifest_hash");
    zval model;
    if (hash == NULL || !registered_model(self, hash, &model)) {
        return false;
    }
    zval_ptr_dtor(&model);
    zval eargs[3], engine, rr, shape;
    ZVAL_COPY(&eargs[0], hash);
    ZVAL_COPY(&eargs[1], rd(self, "driver"));
    ZVAL_LONG(&eargs[2], as_long(rd(rd(self, "config"), "planCacheSize")));
    bool ok = scall("Polyspec\\Orm\\Engine::for", &engine, 3, eargs);
    for (int i = 0; i < 3; i++) {
        zval_ptr_dtor(&eargs[i]);
    }
    if (!ok) {
        return false;
    }
    if (!mcall(r, "canonicalize", &rr, 0, NULL)) {
        zval_ptr_dtor(&engine);
        return false;
    }
    zval_ptr_dtor(&rr);
    if (!mcall(r, "shape", &shape, 0, NULL)) {
        zval_ptr_dtor(&engine);
        return false;
    }
    if (acount(rd(r, "params")) <= bind_limit(rd(self, "driver"))) {
        ok = mcall(&engine, "plan", out, 1, &shape);
    } else {
        /* More values than the bind limit: the plan of the split requests is not kept in the plan cache. */
        zval plan, mdl;
        ok = mcall(&engine, "compile", &plan, 1, &shape);
        if (ok) {
            ZVAL_COPY(&mdl, rd(&engine, "model"));
            ok = scall_ref("Polyspec\\Orm\\Assemble::index", &plan, 1, &mdl);
            zval_ptr_dtor(&mdl);
            if (ok) {
                ZVAL_COPY_VALUE(out, &plan);
            } else {
                zval_ptr_dtor(&plan);
            }
        }
    }
    zval_ptr_dtor(&shape);
    zval_ptr_dtor(&engine);
    return ok;
}

/* ---- the statement events and the statements that are not model statements (Db::observed, run, fetch) ---- */

static bool op_exec_sql(zval *self, void *ctx, zval *ret)
{
    zval *sql = ctx;
    zval pdo;
    if (!handle_pdo(self, &pdo)) {
        return false;
    }
    bool ok = mcall(&pdo, "exec", ret, 1, sql);
    zval_ptr_dtor(&pdo);
    if (ok) {
        zval_ptr_dtor(ret);
        ZVAL_NULL(ret);
    }
    return ok;
}

typedef struct fetchctx {
    zval *sql;
    zval *args;
} fetchctx;

/* Db::fetch's send: on PostgreSQL the $n of the text are replaced by ? and each value is bound again for each ?. */
static bool op_fetch_rows(zval *self, void *ctx, zval *ret)
{
    fetchctx *c = ctx;
    zval text, bound;
    array_init(&bound);
    if (is_str(rd(self, "driver"), "postgres")) {
        const char *s = Z_STRVAL_P(c->sql);
        size_t len = Z_STRLEN_P(c->sql);
        smart_str b = {0};
        for (size_t p = 0; p < len; p++) {
            if (s[p] == '$' && p + 1 < len && s[p + 1] >= '0' && s[p + 1] <= '9') {
                size_t q = p + 1;
                zend_long k = 0;
                while (q < len && s[q] >= '0' && s[q] <= '9') {
                    k = k * 10 + (s[q] - '0');
                    q++;
                }
                zval *v = aidx(c->args, k - 1);
                zval nullv;
                ZVAL_NULL(&nullv);
                push(&bound, v != NULL ? v : &nullv);
                smart_str_appendc(&b, '?');
                p = q - 1;
                continue;
            }
            smart_str_appendc(&b, s[p]);
        }
        smart_str_0(&b);
        ZVAL_STR(&text, b.s ? b.s : ZSTR_EMPTY_ALLOC());
    } else {
        ZVAL_COPY(&text, c->sql);
        zval_ptr_dtor(&bound);
        ZVAL_COPY(&bound, c->args);
    }
    zval pdo;
    if (!handle_pdo(self, &pdo)) {
        zval_ptr_dtor(&text);
        zval_ptr_dtor(&bound);
        return false;
    }
    zval st, r, rows;
    bool ok = mcall(&pdo, "prepare", &st, 1, &text);
    zval_ptr_dtor(&text);
    zval_ptr_dtor(&pdo);
    if (!ok) {
        zval_ptr_dtor(&bound);
        return false;
    }
    ok = mcall(&st, "execute", &r, 1, &bound);
    zval_ptr_dtor(&bound);
    if (!ok) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    zval_ptr_dtor(&r);
    zval cols;
    if (!mcall(&st, "columnCount", &cols, 0, NULL)) {
        zval_ptr_dtor(&st);
        return false;
    }
    bool has_cols = zval_get_long(&cols) > 0;
    zval_ptr_dtor(&cols);
    if (has_cols) {
        zval mode;
        ZVAL_LONG(&mode, FETCH_NUM);
        ok = mcall(&st, "fetchAll", &rows, 1, &mode);
    } else {
        array_init(&rows);
        ok = true;
    }
    if (!ok) {
        zval_ptr_dtor(&st);
        return false;
    }
    bool closed = mcall(&st, "closeCursor", &r, 0, NULL);
    zval_ptr_dtor(&st);
    if (!closed) {
        zval_ptr_dtor(&rows);
        return false;
    }
    zval_ptr_dtor(&r);
    ZVAL_COPY_VALUE(ret, &rows);
    return true;
}

static bool op_observed_closure(zval *self, void *ctx, zval *ret)
{
    (void)self;
    zval *closure = ctx;
    return call_user_function(NULL, NULL, closure, ret, 0, NULL) == SUCCESS && EG(exception) == NULL;
}

/* Db::observedAs: the connection is open, then the statement is sent and published. */
static bool observed_as(zval *self, bool control, zval *kind, zval *tables, zval *tx, zval *sql, zval *binds,
    op_fn op, void *opctx, zval *out)
{
    zval pdo;
    if (!handle_pdo(self, &pdo)) {
        return false;
    }
    zval_ptr_dtor(&pdo);
    pubctx pc = {kind, tables, tx, sql, binds};
    return send_op(self, control, op, opctx, done_publish, &pc, out);
}

/* Db::run: a statement with no binds and no rows. */
static bool run_stmt(zval *self, const char *kind, zval *tables, zval *tx, const char *sql, bool control)
{
    zval k, t, s, b, r;
    str_zv(&k, kind);
    ZVAL_COPY(&t, tables);
    ZVAL_COPY(&s, tx);
    str_zv(&b, sql);
    array_init(&r);
    zval binds;
    array_init(&binds);
    zval sqlz;
    ZVAL_STRING(&sqlz, sql);
    bool ok = observed_as(self, control, &k, &t, &s, &sqlz, &binds, op_exec_sql, &sqlz, &r);
    zval_ptr_dtor(&k);
    zval_ptr_dtor(&t);
    zval_ptr_dtor(&s);
    zval_ptr_dtor(&b);
    zval_ptr_dtor(&r);
    zval_ptr_dtor(&binds);
    zval_ptr_dtor(&sqlz);
    return ok;
}

/* Db::acquireSQLiteRowLock: on SQLite, a row lock is the write of the lock table; the NOWAIT modes turn the busy timeout off
 * for that statement. */
static bool ensure_row_lock_table(zval *self)
{
    zval *state = rd(self, "state");
    if (as_bool(rd(state, "rowLockReady"))) {
        return true;
    }
    zval nul, tables;
    ZVAL_NULL(&nul);
    array_init(&tables);
    zval name;
    str_zv(&name, ROW_LOCK_TABLE);
    zend_hash_next_index_insert(Z_ARRVAL(tables), &name);
    bool ok = run_stmt(self, "utility", &tables, &nul, "CREATE TABLE IF NOT EXISTS \"orm__row_lock\" (\"id\" INTEGER PRIMARY KEY CHECK (\"id\" = 1))", true);
    zval_ptr_dtor(&tables);
    if (ok) {
        zval t;
        ZVAL_TRUE(&t);
        wr(state, "rowLockReady", &t);
    }
    return ok;
}

static bool acquire_row_lock(zval *self, zval *mode)
{
    if (Z_TYPE_P(mode) != IS_STRING || Z_STRLEN_P(mode) == 0 || !is_str(rd(self, "driver"), "sqlite")) {
        return true;
    }
    zval tx, no_tables;
    ZVAL_NULL(&tx);
    array_init(&no_tables);
    size_t n = Z_STRLEN_P(mode);
    bool nowait = n >= 7 && strcmp(Z_STRVAL_P(mode) + n - 7, "_nowait") == 0;
    zend_long previous = 0;
    if (nowait) {
        zval kind, tables, sql, args;
        str_zv(&kind, "utility");
        array_init(&tables);
        str_zv(&sql, "PRAGMA busy_timeout");
        array_init(&args);
        fetchctx fc = {&sql, &args};
        zval rows;
        bool ok = observed_as(self, true, &kind, &tables, &tx, &sql, &args, op_fetch_rows, &fc, &rows);
        zval_ptr_dtor(&kind);
        zval_ptr_dtor(&tables);
        zval_ptr_dtor(&sql);
        zval_ptr_dtor(&args);
        if (!ok) {
            return false;
        }
        zval *first = aidx(aidx(&rows, 0), 0);
        previous = as_long(first);
        zval_ptr_dtor(&rows);
        if (!run_stmt(self, "utility", &no_tables, &tx, "PRAGMA busy_timeout=0", true)) {
            return false;
        }
    }
    zval pending;
    bool has_pending = false;
    bool ok = ensure_row_lock_table(self);
    if (ok) {
        zval tables;
        array_init(&tables);
        zval name;
        str_zv(&name, ROW_LOCK_TABLE);
        zend_hash_next_index_insert(Z_ARRVAL(tables), &name);
        ok = run_stmt(self, "utility", &tables, &tx,
            "INSERT INTO \"orm__row_lock\" (\"id\") VALUES (1) ON CONFLICT (\"id\") DO UPDATE SET \"id\"=excluded.\"id\"", true);
        zval_ptr_dtor(&tables);
    }
    if (!ok) {
        if (EG(exception) != NULL) {
            take_exception(&pending);
            has_pending = true;
            if (nowait && is_instance(&pending, ORM_EXCEPTION)) {
                zval prev;
                ZVAL_UNDEF(&prev);
                mcall(&pending, "getPrevious", &prev, 0, NULL);
                if (Z_TYPE(prev) == IS_OBJECT && is_instance(&prev, "PDOException")) {
                    zval *ei = rd(&prev, "errorInfo");
                    zval *code = aidx(ei, 1);
                    if (((as_long(code)) & 0xff) == 5) {
                        zval msg, args[3], ex;
                        ZVAL_UNDEF(&msg);
                        mcall(&prev, "getMessage", &msg, 0, NULL);
                        str_zv(&args[0], "LOCK_NOT_AVAILABLE");
                        ZVAL_COPY(&args[1], &msg);
                        ZVAL_COPY(&args[2], &prev);
                        if (newobj(ORM_EXCEPTION, &ex, 3, args)) {
                            zval_ptr_dtor(&pending);
                            ZVAL_COPY_VALUE(&pending, &ex);
                        }
                        zval_ptr_dtor(&args[0]);
                        zval_ptr_dtor(&args[1]);
                        zval_ptr_dtor(&args[2]);
                        zval_ptr_dtor(&msg);
                    }
                }
                zval_ptr_dtor(&prev);
            }
        }
    }
    if (nowait) {
        char buf[32];
        snprintf(buf, sizeof(buf), "PRAGMA busy_timeout=%ld", (long)previous);
        if (!run_stmt(self, "utility", &no_tables, &tx, buf, true)) {
            if (has_pending) {
                zval_ptr_dtor(&pending);
            }
            return false;
        }
    }
    if (has_pending) {
        put_exception(&pending);
    }
    return ok;
}

/* ---- the entry points of the statement path (Db::select, scalarOf, paginate, writeOf, statement) ---- */

/* Calls the Markdown object's method m with self and r when self holds one: 1 or 0 for its result, or -1 when self holds
no Markdown object, so the caller runs the statement itself. */
static int md_call(zval *self, zval *r, const char *m, zval *out)
{
    zval *md = rd(self, "md");
    if (md == NULL || Z_TYPE_P(md) != IS_OBJECT) {
        return -1;
    }
    zval args[2];
    ZVAL_COPY(&args[0], self);
    ZVAL_COPY(&args[1], r);
    char name[64];
    snprintf(name, sizeof name, "Polyspec\\Orm\\Markdown::%s", m);
    bool ok = scall(name, out, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    return ok ? 1 : 0;
}

static bool select_impl(zval *self, zval *frame, zval *r, zval *out)
{
    if (!apply_hook(self, r)) {
        return false;
    }
    zval *ir = rd(r, "ir");
    if (!enter(self, frame, ir)) {
        return false;
    }
    int handled = md_call(self, r, "read", out);
    if (handled >= 0) {
        return handled == 1;
    }
    zval plan;
    if (!plan_of(self, r, &plan)) {
        return false;
    }
    zval *step0 = aidx(aget(&plan, "steps"), 0);
    zval lock;
    zval *lk = aget(ir, "lock");
    if (lk != NULL) {
        ZVAL_COPY(&lock, lk);
    } else {
        ZVAL_EMPTY_STRING(&lock);
    }
    bool ok = acquire_row_lock(self, &lock);
    zval_ptr_dtor(&lock);
    zval parts, main;
    /* query_rows leaves its out unset on failure, so main is NULL until a rows array replaces it. */
    ZVAL_NULL(&main);
    if (!ok || !root_parts(self, r, step0, &parts)) {
        zval_ptr_dtor(&plan);
        return false;
    }
    if (acount(&parts) > 0) {
        array_init(&main);
        zval seen;
        array_init(&seen);
        zval *part;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(parts), part)
        {
            zval pplan, rows;
            if (!plan_of(self, part, &pplan)) {
                ok = false;
                break;
            }
            zval *pstep0 = aidx(aget(&pplan, "steps"), 0);
            if (!query_rows(self, pstep0, rd(part, "params"), NULL, NULL, &rows)) {
                zval_ptr_dtor(&pplan);
                ok = false;
                break;
            }
            zval *row;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row)
            {
                zval key;
                if (!row_slot(row, aget(pstep0, "assemble") ? aget(aget(pstep0, "assemble"), "key") : NULL, &key)) {
                    ok = false;
                    break;
                }
                zend_string *ks = Z_TYPE(key) == IS_NULL ? ZSTR_EMPTY_ALLOC() : zval_get_string(&key);
                if (zend_symtable_find(Z_ARRVAL(seen), ks) == NULL) {
                    zval t;
                    ZVAL_TRUE(&t);
                    zend_symtable_update(Z_ARRVAL(seen), ks, &t);
                    push(&main, row);
                }
                if (Z_TYPE(key) != IS_NULL) {
                    zend_string_release(ks);
                }
                zval_ptr_dtor(&key);
            }
            ZEND_HASH_FOREACH_END();
            zval_ptr_dtor(&rows);
            zval_ptr_dtor(&pplan);
            if (!ok) {
                break;
            }
        }
        ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&seen);
    } else {
        ok = query_rows(self, step0, rd(r, "params"), NULL, NULL, &main);
    }
    zval_ptr_dtor(&parts);
    if (ok) {
        zval res;
        ok = relations_of(self, &plan, rd(r, "params"), &main, &res);
        if (ok) {
            array_init(out);
            push(out, &plan);
            push(out, &res);
            zval_ptr_dtor(&res);
        }
    }
    zval_ptr_dtor(&main);
    zval_ptr_dtor(&plan);
    return ok;
}

static bool scalar_of_impl(zval *self, zval *frame, zval *r, zval *out)
{
    if (!apply_hook(self, r)) {
        return false;
    }
    if (!enter(self, frame, rd(r, "ir"))) {
        return false;
    }
    int handled = md_call(self, r, "scalar", out);
    if (handled >= 0) {
        return handled == 1;
    }
    zval plan;
    if (!plan_of(self, r, &plan)) {
        return false;
    }
    zval *step0 = aidx(aget(&plan, "steps"), 0);
    zval parts;
    if (!root_parts(self, r, step0, &parts)) {
        zval_ptr_dtor(&plan);
        return false;
    }
    bool ok = true;
    if (acount(&parts) > 0) {
        zval *ir = rd(r, "ir");
        if (!is_str(aget(ir, "kind"), "count")) {
            throw_orm("IR_INVALID", "a split IN list can be merged only for a count");
            ok = false;
        } else {
            zend_long total = 0;
            zval *part;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL(parts), part)
            {
                zval pplan, v;
                if (!plan_of(self, part, &pplan) || !scalar_of_step(self, aidx(aget(&pplan, "steps"), 0), rd(part, "params"), &v)) {
                    ok = false;
                    zval_ptr_dtor(&pplan);
                    break;
                }
                total += zval_get_long(&v);
                zval_ptr_dtor(&v);
                zval_ptr_dtor(&pplan);
            }
            ZEND_HASH_FOREACH_END();
            if (ok) {
                ZVAL_LONG(out, total);
            }
        }
    } else {
        ok = scalar_of_step(self, step0, rd(r, "params"), out);
    }
    zval_ptr_dtor(&parts);
    zval_ptr_dtor(&plan);
    return ok;
}

static bool paginate_impl(zval *self, zval *frame, zval *r, zval *out)
{
    if (!apply_hook(self, r)) {
        return false;
    }
    if (!enter(self, frame, rd(r, "ir"))) {
        return false;
    }
    int handled = md_call(self, r, "read", out);
    if (handled >= 0) {
        return handled == 1;
    }
    zval plan;
    if (!plan_of(self, r, &plan)) {
        return false;
    }
    zval main, res;
    bool ok = query_rows(self, aidx(aget(&plan, "steps"), 0), rd(r, "params"), NULL, NULL, &main);
    if (ok) {
        ok = relations_of(self, &plan, rd(r, "params"), &main, &res);
    }
    zval_ptr_dtor(&main);
    if (!ok) {
        zval_ptr_dtor(&plan);
        return false;
    }
    zval *steps = aget(&plan, "steps");
    zval *st;
    bool found = false;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(steps), st)
    {
        ZVAL_DEREF(st);
        if (is_str(aget(st, "role"), "count")) {
            zval count;
            ok = scalar_of_step(self, st, rd(r, "params"), &count);
            if (ok) {
                array_init(out);
                push(out, &plan);
                push(out, &res);
                zval n;
                ZVAL_LONG(&n, zval_get_long(&count));
                zend_hash_next_index_insert(Z_ARRVAL_P(out), &n);
                zval_ptr_dtor(&count);
            }
            found = true;
            break;
        }
    }
    ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&res);
    zval_ptr_dtor(&plan);
    if (!found) {
        throw_orm("INTERNAL", "paginate plan has no count step");
        return false;
    }
    return ok;
}

static bool binds_audit(zval *step)
{
    zval *bs = aget(step, "bind_slots");
    zval *b;
    if (bs == NULL || Z_TYPE_P(bs) != IS_ARRAY) {
        return false;
    }
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(bs), b)
    {
        if (is_str(aget(b, "from"), "audit")) {
            return true;
        }
    }
    ZEND_HASH_FOREACH_END();
    return false;
}

/* The settle of a failed guarded write: the pending error is kept while the savepoint is undone. */
static void settle_discard(zval *self, zval *frame)
{
    zval pending, s;
    bool had = EG(exception) != NULL;
    if (had) {
        take_exception(&pending);
    }
    settle_audit(self, frame, 0, &s);
    zval_ptr_dtor(&s);
    if (had) {
        put_exception(&pending);
    }
}

/* The write set of the transaction (INT-52): TxFrame::recordInserted of the PHP library records the generated key. frame is
 * NULL or the transaction's frame. */
static bool record_inserted(zval *frame, zval *r, zval *id)
{
    if (frame == NULL || Z_TYPE_P(frame) != IS_OBJECT) {
        return true;
    }
    zval args[3], res;
    ZVAL_COPY(&args[0], frame);
    ZVAL_COPY(&args[1], r);
    ZVAL_COPY(&args[2], id);
    bool ok = scall("Polyspec\\Orm\\TxFrame::recordInserted", &res, 3, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
    if (ok) {
        zval_ptr_dtor(&res);
    }
    return ok;
}

static bool write_of_impl(zval *self, zval *frame, zval *r, zval *after, zval *out)
{
    if (!apply_hook(self, r)) {
        return false;
    }
    if (after != NULL && Z_TYPE_P(after) == IS_OBJECT) {
        zval ret, arg;
        ZVAL_UNDEF(&ret);
        ZVAL_COPY(&arg, r);
        bool ok = call_user_function(NULL, NULL, after, &ret, 1, &arg) == SUCCESS && EG(exception) == NULL;
        zval_ptr_dtor(&ret);
        zval_ptr_dtor(&arg);
        if (!ok) {
            return false;
        }
    }
    zval *ir = rd(r, "ir");
    if (!enter(self, frame, ir)) {
        return false;
    }
    zval *md = rd(self, "md");
    if (md != NULL && Z_TYPE_P(md) == IS_OBJECT) {
        zval args[2], res;
        ZVAL_COPY(&args[0], self);
        ZVAL_COPY(&args[1], r);
        bool ok = scall("Polyspec\\Orm\\Markdown::write", &res, 2, args);
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&args[1]);
        if (!ok) {
            return false;
        }
        zval *keys = aidx(&res, 0);
        zval *affected = aidx(&res, 1);
        zend_long n = as_long(affected);
        zval first;
        if (keys != NULL) {
            ZVAL_COPY(&first, keys);
        } else {
            ZVAL_NULL(&first);
        }
        zval_ptr_dtor(&res);
        if (aget(ir, "optimistic") != NULL && n == 0) {
            zval_ptr_dtor(&first);
            throw_orm("OPTIMISTIC_LOCK", "the row changed after it was read");
            return false;
        }
        if (!record_inserted(frame, r, &first)) {
            zval_ptr_dtor(&first);
            return false;
        }
        set_last_affected(self, n);
        array_init(out);
        zend_hash_next_index_insert(Z_ARRVAL_P(out), &first);
        set_long(out, n);
        return true;
    }
    zval plan;
    if (!plan_of(self, r, &plan)) {
        return false;
    }
    zval step;
    ZVAL_COPY(&step, aidx(aget(&plan, "steps"), 0));
    bool has_frame = frame != NULL && Z_TYPE_P(frame) == IS_OBJECT;
    bool settle_needed = false;
    if (has_frame && binds_audit(&step)) {
        bool guard = !is_str(aget(ir, "kind"), "insert");
        if (!audit_for(self, frame, guard, &settle_needed)) {
            zval_ptr_dtor(&step);
            zval_ptr_dtor(&plan);
            return false;
        }
    }
    zval args;
    if (!args_of(self, &step, rd(r, "params"), NULL, frame, &args)) {
        if (settle_needed) {
            settle_discard(self, frame);
        }
        zval_ptr_dtor(&step);
        zval_ptr_dtor(&plan);
        return false;
    }
    zval id, affected_zv;
    bool ok = send_write(self, &step, &args, r, &id, &affected_zv);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&step);
    zval_ptr_dtor(&plan);
    if (!ok) {
        if (settle_needed) {
            settle_discard(self, frame);
        }
        return false;
    }
    zend_long n = zval_get_long(&affected_zv);
    if (settle_needed) {
        zval settled;
        settle_audit(self, frame, n, &settled);
        if (Z_TYPE(settled) != IS_NULL) {
            zval_ptr_dtor(&id);
            put_exception(&settled);
            return false;
        }
        zval_ptr_dtor(&settled);
    }
    if (aget(ir, "optimistic") != NULL && n == 0) {
        zval_ptr_dtor(&id);
        throw_orm("OPTIMISTIC_LOCK", "the row changed after it was read");
        return false;
    }
    if (!record_inserted(frame, r, &id)) {
        zval_ptr_dtor(&id);
        return false;
    }
    set_last_affected(self, n);
    array_init(out);
    zend_hash_next_index_insert(Z_ARRVAL_P(out), &id);
    set_long(out, n);
    return true;
}

/* Db::sendWrite: the write's statement, its generated identity or RETURNING key, and its affected count. The results go to id
 * and affected. */
typedef struct wctx {
    zval *step;
    zval *args;
    zval *r;
} wctx;

static bool op_write(zval *self, void *ctx, zval *ret)
{
    wctx *c = ctx;
    zval *sql = aget(c->step, "sql");
    zval st;
    if (!stmt_of(self, sql, &st)) {
        return false;
    }
    zval *ir = rd(c->r, "ir");
    bool insert = is_str(aget(ir, "kind"), "insert");
    if (!exec_stmt(self, &st, c->args)) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    if (insert && strstr(Z_STRVAL_P(sql), " RETURNING ") != NULL) {
        zval id, r;
        bool ok = mcall(&st, "fetchColumn", &id, 0, NULL);
        if (ok) {
            ok = mcall(&st, "closeCursor", &r, 0, NULL);
            zval_ptr_dtor(&r);
        }
        zval_ptr_dtor(&st);
        if (!ok) {
            zval_ptr_dtor(&id);
            return false;
        }
        array_init(ret);
        zend_hash_next_index_insert(Z_ARRVAL_P(ret), &id);
        set_long(ret, 1);
        return true;
    }
    /* Registry::model(hash)->entity(entity)['identity']: a model without an identity column has no generated key. */
    zval model, ent;
    if (!scall("Polyspec\\Orm\\Registry::model", &model, 1, aget(ir, "manifest_hash"))
        || !mcall(&model, "entity", &ent, 1, aget(ir, "entity"))) {
        zval_ptr_dtor(&st);
        return false;
    }
    zval_ptr_dtor(&model);
    zval *identity = aget(&ent, "identity");
    bool identity_set = identity != NULL && !(Z_TYPE_P(identity) == IS_STRING && Z_STRLEN_P(identity) == 0);
    zval_ptr_dtor(&ent);
    bool upsert = insert && acount(aget(ir, "on_duplicate")) > 0;
    zval id, affected;
    ZVAL_NULL(&id);
    if (insert && aget(ir, "rows") == NULL && identity_set) {
        zval pdo, r;
        if (!handle_pdo(self, &pdo) || !mcall(&pdo, "lastInsertId", &r, 0, NULL)) {
            zval_ptr_dtor(&st);
            return false;
        }
        zval_ptr_dtor(&pdo);
        zval_ptr_dtor(&id);
        ZVAL_COPY_VALUE(&id, &r);
    }
    if (upsert) {
        ZVAL_LONG(&affected, 1);
    } else {
        zval rc;
        if (!mcall(&st, "rowCount", &rc, 0, NULL)) {
            zval_ptr_dtor(&id);
            zval_ptr_dtor(&st);
            return false;
        }
        ZVAL_COPY_VALUE(&affected, &rc);
    }
    zval_ptr_dtor(&st);
    array_init(ret);
    zend_hash_next_index_insert(Z_ARRVAL_P(ret), &id);
    zend_hash_next_index_insert(Z_ARRVAL_P(ret), &affected);
    return true;
}

static bool send_write(zval *self, zval *step, zval *args, zval *r, zval *id, zval *affected)
{
    wctx wc = {step, args, r};
    zval sql;
    ZVAL_COPY(&sql, aget(step, "sql"));
    modelctx mc = {step, &sql, args};
    zval res;
    bool ok = send_op(self, false, op_write, &wc, done_model, &mc, &res);
    zval_ptr_dtor(&sql);
    if (!ok) {
        return false;
    }
    zval *first = zend_hash_index_find(Z_ARRVAL(res), 0);
    zval *second = zend_hash_index_find(Z_ARRVAL(res), 1);
    ZVAL_COPY(id, first);
    ZVAL_COPY(affected, second);
    zval_ptr_dtor(&res);
    return true;
}

/* Db::statement: the SQL and the binds of a request, with the masks of the secret and the clock, for getQuery. */
static bool statement_impl(zval *self, zval *r, zval *out)
{
    if (!unsupported_on_markdown(self, "getQuery")) {
        return false;
    }
    if (!apply_hook(self, r)) {
        return false;
    }
    zval plan;
    if (!plan_of(self, r, &plan)) {
        return false;
    }
    zval step;
    ZVAL_COPY(&step, aidx(aget(&plan, "steps"), 0));
    zval args;
    bool ok = args_of(self, &step, rd(r, "params"), NULL, NULL, &args);
    if (ok) {
        zval *masks = rd(self, "masks");
        if (masks != NULL && Z_TYPE_P(masks) == IS_ARRAY) {
            zend_ulong idx;
            zval *m;
            ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(masks), idx, m)
            {
                zend_hash_index_update(Z_ARRVAL(args), idx, m);
                Z_TRY_ADDREF_P(m);
            }
            ZEND_HASH_FOREACH_END();
        }
        zval binds;
        array_init(&binds);
        zval *v;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(args), v)
        {
            ZVAL_DEREF(v);
            if (is_instance(v, BYTES_CLASS)) {
                push(&binds, rd(v, "bytes"));
            } else {
                push(&binds, v);
            }
        }
        ZEND_HASH_FOREACH_END();
        array_init(out);
        setk(out, "sql", aget(&step, "sql"));
        zend_hash_str_update(Z_ARRVAL_P(out), "binds", strlen("binds"), &binds);
        zval_ptr_dtor(&args);
    }
    zval_ptr_dtor(&step);
    zval_ptr_dtor(&plan);
    return ok;
}

/* Db::subscribe: the subscriber joins the connection's subscribers under the next number. The returned closure removes that
 * subscriber. The closure's function is an internal function whose reserved slot holds the number; zend_create_fake_closure
 * copies the function, so each closure keeps its own number. */
ZEND_NAMED_FUNCTION(db_unsubscribe)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_long id = (zend_long)(uintptr_t)EX(func)->internal_function.reserved[0];
    zval *self = &EX(This);
    zval *subs = array_prop(rd(self, "state"), "subscribers");
    zend_hash_index_del(Z_ARRVAL_P(subs), (zend_ulong)id);
}

static bool subscribe_impl(zval *self, zval *subscriber, zval *out)
{
    if (!unsupported_on_markdown(self, "statement events")) {
        return false;
    }
    zval *state = rd(self, "state");
    zend_long id = as_long(rd(state, "subscriberSeq"));
    zval next;
    ZVAL_LONG(&next, id + 1);
    wr(state, "subscriberSeq", &next);
    zval *subs = array_prop(state, "subscribers");
    zval sub;
    ZVAL_COPY(&sub, subscriber);
    zend_hash_index_update(Z_ARRVAL_P(subs), (zend_ulong)id, &sub);
    zend_internal_function *unsub = pemalloc(sizeof(zend_internal_function), 1);
    memset(unsub, 0, sizeof(zend_internal_function));
    unsub->type = ZEND_INTERNAL_FUNCTION;
    unsub->fn_flags = ZEND_ACC_PUBLIC;
    unsub->scope = Z_OBJCE_P(self);
    unsub->function_name = zend_string_init_interned("unsubscribe", sizeof("unsubscribe") - 1, 1);
    unsub->handler = db_unsubscribe;
    unsub->reserved[0] = (void *)(uintptr_t)id;
    zend_create_fake_closure(out, (zend_function *)unsub, Z_OBJCE_P(self), Z_OBJCE_P(self), self);
    /* zend_create_fake_closure copies the function into the closure, which frees its copy with the closure; the
     * template is not used again, so it is freed here rather than leaked per subscribe. */
    pefree(unsub, 1);
    return true;
}

static zend_long insert_parts_batch(zend_long rows, zend_long batch, zval *out)
{
    array_init(out);
    while (rows > 0) {
        zend_long part = rows < batch ? rows : batch;
        set_long(out, part);
        rows -= part;
    }
    return 0;
}

/* ---- the connection state set up by the constructor ---- */

ZEND_METHOD(Polyspec_Orm_Db, __construct)
{
    zval *pdo, *config, *zone, *md = NULL;
    zend_string *driver;
    ZEND_PARSE_PARAMETERS_START(4, 5)
        Z_PARAM_OBJECT_OR_NULL(pdo)
        Z_PARAM_STR(driver)
        Z_PARAM_OBJECT_OF_CLASS(config, cls("Polyspec\\Orm\\Config"))
        Z_PARAM_OBJECT_OF_CLASS(zone, cls("DateTimeZone"))
        Z_PARAM_OPTIONAL
        Z_PARAM_OBJECT_OR_NULL(md)
    ZEND_PARSE_PARAMETERS_END();
    zval *self = ZEND_THIS;
    zval drv, nul, state, empty, fl;
    ZVAL_STR_COPY(&drv, driver);
    wr(self, "driver", &drv);
    zval_ptr_dtor(&drv);
    wr(self, "config", config);
    wr(self, "zone", zone);
    if (md != NULL) {
        wr(self, "md", md);
    } else {
        ZVAL_NULL(&nul);
        wr(self, "md", &nul);
    }
    if (!newobj(DB_STATE, &state, 0, NULL)) {
        return;
    }
    wr(self, "state", &state);
    array_init(&empty);
    wr(self, "masks", &empty);
    zval_ptr_dtor(&empty);
    ZVAL_FALSE(&fl);
    wr(self, "typed", &fl);
    ZVAL_NULL(&nul);
    wr(self, "requestHook", &nul);
    zval_ptr_dtor(&state);
    if (pdo == NULL || Z_TYPE_P(pdo) == IS_NULL) {
        return;
    }
    zval args[2], r;
    ZVAL_LONG(&args[0], constant_long("PDO::ATTR_ERRMODE"));
    ZVAL_LONG(&args[1], constant_long("PDO::ERRMODE_EXCEPTION"));
    mcall(pdo, "setAttribute", &r, 2, args);
    zval_ptr_dtor(&r);
    ZVAL_LONG(&args[0], constant_long("PDO::ATTR_EMULATE_PREPARES"));
    ZVAL_BOOL(&args[1], is_str(&drv, "mysql"));
    mcall(pdo, "setAttribute", &r, 2, args);
    zval_ptr_dtor(&r);
    if (strcmp(ZSTR_VAL(driver), "postgres") == 0) {
        ZVAL_LONG(&args[0], constant_long("Pdo\\Pgsql::ATTR_DISABLE_PREPARES"));
        ZVAL_TRUE(&args[1]);
        mcall(pdo, "setAttribute", &r, 2, args);
        zval_ptr_dtor(&r);
    }
    ZVAL_LONG(&args[0], constant_long("PDO::ATTR_STRINGIFY_FETCHES"));
    ZVAL_FALSE(&args[1]);
    mcall(pdo, "setAttribute", &r, 2, args);
    zval_ptr_dtor(&r);
    wr(rd(self, "state"), "pdo", pdo);
}

ZEND_METHOD(Polyspec_Orm_Db, registerSet)
{
    zval *schema;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(schema, cls("Polyspec\\Orm\\Schema"))
    ZEND_PARSE_PARAMETERS_END();
    zval r;
    if (!mcall(schema, "verify", &r, 0, NULL)) {
        RETURN_THROWS();
    }
    zval_ptr_dtor(&r);
    zval hash;
    if (!scall("Polyspec\\Orm\\Registry::schema", &r, 1, schema)) {
        RETURN_THROWS();
    }
    zval_ptr_dtor(&r);
    zval *sets = array_prop(rd(ZEND_THIS, "state"), "sets");
    zval *mh = rd(schema, "manifestHash");
    ZVAL_TRUE(&hash);
    zend_symtable_update(Z_ARRVAL_P(sets), Z_STR_P(mh), &hash);
}

ZEND_METHOD(Polyspec_Orm_Db, driver)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_COPY(rd(ZEND_THIS, "driver"));
}

ZEND_METHOD(Polyspec_Orm_Db, markdownSession)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *state = rd(ZEND_THIS, "state");
    zval *md = rd(ZEND_THIS, "md");
    if (as_bool(rd(state, "closed")) || md == NULL) {
        throw_orm("CONFIG", "database is closed");
        RETURN_THROWS();
    }
    RETURN_COPY(md);
}

ZEND_METHOD(Polyspec_Orm_Db, unsupportedOnMarkdown)
{
    zend_string *surface;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(surface)
    ZEND_PARSE_PARAMETERS_END();
    if (!unsupported_on_markdown(ZEND_THIS, ZSTR_VAL(surface))) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, registeredModel)
{
    zend_string *hash;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(hash)
    ZEND_PARSE_PARAMETERS_END();
    zval h;
    ZVAL_STR_COPY(&h, hash);
    zval m;
    bool ok = registered_model(ZEND_THIS, &h, &m);
    zval_ptr_dtor(&h);
    if (!ok) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&m);
}

ZEND_METHOD(Polyspec_Orm_Db, zone)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_COPY(rd(ZEND_THIS, "zone"));
}

ZEND_METHOD(Polyspec_Orm_Db, config)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_COPY(rd(ZEND_THIS, "config"));
}

ZEND_METHOD(Polyspec_Orm_Db, pdo)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval p;
    if (!handle_pdo(ZEND_THIS, &p)) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&p);
}

ZEND_METHOD(Polyspec_Orm_Db, driverError)
{
    zval *e;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(e)
    ZEND_PARSE_PARAMETERS_END();
    zval pdo, args[3], err;
    if (!handle_pdo(ZEND_THIS, &pdo)) {
        RETURN_THROWS();
    }
    ZVAL_COPY(&args[0], e);
    ZVAL_COPY(&args[1], rd(ZEND_THIS, "driver"));
    ZVAL_COPY_VALUE(&args[2], &pdo);
    bool ok = scall("Polyspec\\Orm\\OrmException::fromDriver", &err, 3, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
    if (!ok) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&err);
}



ZEND_METHOD(Polyspec_Orm_Db, close)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *self = ZEND_THIS;
    zval *state = rd(self, "state");
    if (as_bool(rd(state, "closed"))) {
        return;
    }
    zval *md = rd(self, "md");
    if (md != NULL && Z_TYPE_P(md) == IS_OBJECT) {
        zval t, r;
        ZVAL_TRUE(&t);
        wr(state, "closed", &t);
        if (mcall(md, "close", &r, 0, NULL)) {
            zval_ptr_dtor(&r);
        }
        return;
    }
    zval *stmts = rd(state, "stmts");
    zval *st;
    zval err;
    ZVAL_UNDEF(&err);
    if (stmts != NULL && Z_TYPE_P(stmts) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(stmts), st)
        {
            zval r;
            if (!mcall(st, "closeCursor", &r, 0, NULL)) {
                if (pdo_exception_pending()) {
                    zval pe;
                    take_exception(&pe);
                    zval dargs[3], derr, pdo;
                    if (handle_pdo(self, &pdo)) {
                        ZVAL_COPY(&dargs[0], &pe);
                        ZVAL_COPY(&dargs[1], rd(self, "driver"));
                        ZVAL_COPY(&dargs[2], &pdo);
                        if (scall("Polyspec\\Orm\\OrmException::fromDriver", &derr, 3, dargs)) {
                            ZVAL_COPY_VALUE(&err, &derr);
                        }
                        zval_ptr_dtor(&dargs[0]);
                        zval_ptr_dtor(&dargs[1]);
                        zval_ptr_dtor(&dargs[2]);
                        zval_ptr_dtor(&pdo);
                    }
                    zval_ptr_dtor(&pe);
                }
                break;
            }
            zval_ptr_dtor(&r);
        }
        ZEND_HASH_FOREACH_END();
    }
    zval t, empty, nul;
    ZVAL_TRUE(&t);
    wr(state, "closed", &t);
    array_init(&empty);
    wr(state, "stmts", &empty);
    wr(state, "stmtOrder", &empty);
    zval_ptr_dtor(&empty);
    ZVAL_NULL(&nul);
    wr(state, "pdo", &nul);
    if (Z_TYPE(err) != IS_UNDEF) {
        put_exception(&err);
    }
}

ZEND_METHOD(Polyspec_Orm_Db, withRequestHook)
{
    zval *hook;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(hook, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zend_object *clone = zend_objects_clone_obj(Z_OBJ_P(ZEND_THIS));
    zval c;
    ZVAL_OBJ(&c, clone);
    wr(&c, "requestHook", hook);
    RETURN_COPY_VALUE(&c);
}

ZEND_METHOD(Polyspec_Orm_Db, subscribe)
{
    zval *subscriber;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(subscriber, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zval out;
    if (!subscribe_impl(ZEND_THIS, subscriber, &out)) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&out);
}



/* Db::setListener(open) and Db::listener(): the opener of the LISTEN connections, which DbState keeps (docs/spec/dialects.md DIA-194). */
ZEND_METHOD(Polyspec_Orm_Db, setListener)
{
    zval *opener;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(opener, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    wr(rd(ZEND_THIS, "state"), "listener", opener);
}

ZEND_METHOD(Polyspec_Orm_Db, listener)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *opener = rd(rd(ZEND_THIS, "state"), "listener");
    if (opener == NULL) {
        RETURN_NULL();
    }
    RETURN_COPY(opener);
}

/* Db::notify(channel, payload) and Db::listen(channel) call Polyspec\Orm\Listen, which holds the rules and the statements of
 * the PHP client and is the one implementation of both clients (docs/spec/dialects.md DIA-192 to DIA-196). */
ZEND_METHOD(Polyspec_Orm_Db, notify)
{
    zend_string *channel, *payload;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(channel)
        Z_PARAM_STR(payload)
    ZEND_PARSE_PARAMETERS_END();
    zval args[3], ret;
    ZVAL_COPY(&args[0], ZEND_THIS);
    ZVAL_STR_COPY(&args[1], channel);
    ZVAL_STR_COPY(&args[2], payload);
    bool ok = scall("Polyspec\\Orm\\Listen::notify", &ret, 3, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
    if (!ok) {
        RETURN_THROWS();
    }
    zval_ptr_dtor(&ret);
}

ZEND_METHOD(Polyspec_Orm_Db, listen)
{
    zend_string *channel;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(channel)
    ZEND_PARSE_PARAMETERS_END();
    zval args[2], ret;
    ZVAL_COPY(&args[0], ZEND_THIS);
    ZVAL_STR_COPY(&args[1], channel);
    bool ok = scall("Polyspec\\Orm\\Listen::listen", &ret, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (!ok) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&ret);
}

ZEND_METHOD(Polyspec_Orm_Db, publish)
{
    zval *tables, *binds, *error = NULL;
    zend_string *kind, *sql;
    zval *tx;
    zend_long start;
    ZEND_PARSE_PARAMETERS_START(7, 7)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_ZVAL(tx)
        Z_PARAM_STR(sql)
        Z_PARAM_ARRAY(binds)
        Z_PARAM_LONG(start)
        Z_PARAM_OBJECT_OR_NULL(error)
    ZEND_PARSE_PARAMETERS_END();
    zval k;
    ZVAL_STR_COPY(&k, kind);
    zval s;
    ZVAL_STR_COPY(&s, sql);
    if (!publish(ZEND_THIS, &k, tables, tx, &s, binds, start, error)) {
        zval_ptr_dtor(&k);
        zval_ptr_dtor(&s);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&k);
    zval_ptr_dtor(&s);
}

ZEND_METHOD(Polyspec_Orm_Db, observed)
{
    zend_string *kind, *sql;
    zval *tables, *tx, *binds, *send;
    ZEND_PARSE_PARAMETERS_START(6, 6)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_ZVAL(tx)
        Z_PARAM_STR(sql)
        Z_PARAM_ARRAY(binds)
        Z_PARAM_OBJECT_OF_CLASS(send, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zval k, s;
    ZVAL_STR_COPY(&k, kind);
    ZVAL_STR_COPY(&s, sql);
    bool ok = observed_as(ZEND_THIS, false, &k, tables, tx, &s, binds, op_observed_closure, send, return_value);
    zval_ptr_dtor(&k);
    zval_ptr_dtor(&s);
    if (!ok) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, run)
{
    zend_string *kind, *sql;
    zval *tables, *tx;
    bool control = false;
    ZEND_PARSE_PARAMETERS_START(4, 5)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_ZVAL(tx)
        Z_PARAM_STR(sql)
        Z_PARAM_OPTIONAL
        Z_PARAM_BOOL(control)
    ZEND_PARSE_PARAMETERS_END();
    zval k, s, sqlz, binds, out;
    ZVAL_STR_COPY(&k, kind);
    ZVAL_STR_COPY(&sqlz, sql);
    ZVAL_COPY(&s, tx);
    array_init(&binds);
    bool ok = observed_as(ZEND_THIS, control, &k, tables, &s, &sqlz, &binds, op_exec_sql, &sqlz, &out);
    zval_ptr_dtor(&k);
    zval_ptr_dtor(&s);
    zval_ptr_dtor(&sqlz);
    zval_ptr_dtor(&binds);
    if (!ok) {
        RETURN_THROWS();
    }
    zval_ptr_dtor(&out);
}

ZEND_METHOD(Polyspec_Orm_Db, fetch)
{
    zend_string *kind, *sql;
    zval *tables, *tx, *args = NULL;
    bool control = false;
    ZEND_PARSE_PARAMETERS_START(4, 6)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_ZVAL(tx)
        Z_PARAM_STR(sql)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(args)
        Z_PARAM_BOOL(control)
    ZEND_PARSE_PARAMETERS_END();
    zval k, s, sqlz, argz, out, binds;
    ZVAL_STR_COPY(&k, kind);
    ZVAL_STR_COPY(&sqlz, sql);
    ZVAL_COPY(&s, tx);
    if (args != NULL) {
        ZVAL_COPY(&argz, args);
    } else {
        array_init(&argz);
    }
    ZVAL_COPY(&binds, &argz);
    fetchctx fc = {&sqlz, &argz};
    bool ok = observed_as(ZEND_THIS, control, &k, tables, &s, &sqlz, &binds, op_fetch_rows, &fc, &out);
    zval_ptr_dtor(&k);
    zval_ptr_dtor(&s);
    zval_ptr_dtor(&sqlz);
    zval_ptr_dtor(&argz);
    zval_ptr_dtor(&binds);
    if (!ok) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&out);
}




static bool op_execute(zval *self, void *ctx, zval *ret)
{
    wctx *c = ctx;
    zval st;
    if (!stmt_of(self, aget(c->step, "sql"), &st)) {
        return false;
    }
    if (!exec_stmt(self, &st, c->args)) {
        if (pdo_exception_pending()) {
            failed_cursor(&st);
        }
        zval_ptr_dtor(&st);
        return false;
    }
    zval r;
    bool ok = mcall(&st, "closeCursor", &r, 0, NULL);
    zval_ptr_dtor(&st);
    if (ok) {
        zval_ptr_dtor(&r);
        ZVAL_NULL(ret);
    }
    return ok;
}

/* Db::execute: a compiled statement without rows, run on the connection (outside a transaction it has no audit). */
static bool execute_impl(zval *self, zval *step, zval *params)
{
    zval frame;
    zval *active = active_for(self);
    if (active != NULL) {
        ZVAL_COPY(&frame, active);
    } else {
        ZVAL_NULL(&frame);
    }
    zval empty_ir;
    array_init(&empty_ir);
    bool ok = enter(self, &frame, &empty_ir);
    zval_ptr_dtor(&empty_ir);
    if (!ok) {
        zval_ptr_dtor(&frame);
        return false;
    }
    if (aget(step, "assemble") != NULL) {
        zval_ptr_dtor(&frame);
        throw_orm("IR_INVALID", "execute runs a statement without rows; the statement is a read");
        return false;
    }
    zval plist;
    array_init(&plist);
    zval *pv;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(params), pv)
    {
        push(&plist, pv);
    }
    ZEND_HASH_FOREACH_END();
    zend_long nparams = acount(&plist);
    zval *bs = aget(step, "bind_slots");
    zval *b;
    zend_long i = 0;
    if (bs != NULL && Z_TYPE_P(bs) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(bs), b)
        {
            zval *from = aget(b, "from");
            zend_long pi = as_long(aget(b, "param"));
            if (is_str(from, "param") && (pi < 0 || pi >= nparams)) {
                zval_ptr_dtor(&plist);
                zval_ptr_dtor(&frame);
                throw_orm("IR_INVALID", "bind slot %ld reads parameter %ld, but execute has %ld parameters", (long)i, (long)pi,
                    (long)nparams);
                return false;
            }
            i++;
        }
        ZEND_HASH_FOREACH_END();
    }
    bool has_frame = Z_TYPE(frame) == IS_OBJECT;
    if (has_frame && binds_audit(step)) {
        bool settle;
        if (!audit_for(self, &frame, false, &settle)) {
            zval_ptr_dtor(&plist);
            zval_ptr_dtor(&frame);
            return false;
        }
    }
    zval args;
    ok = args_of(self, step, &plist, NULL, &frame, &args);
    zval_ptr_dtor(&plist);
    zval_ptr_dtor(&frame);
    if (!ok) {
        return false;
    }
    wctx wc = {step, &args, NULL};
    zval sql;
    ZVAL_COPY(&sql, aget(step, "sql"));
    modelctx mc = {step, &sql, &args};
    zval res;
    ok = send_op(self, false, op_execute, &wc, done_model, &mc, &res);
    zval_ptr_dtor(&sql);
    zval_ptr_dtor(&args);
    if (ok) {
        zval_ptr_dtor(&res);
    }
    return ok;
}

ZEND_METHOD(Polyspec_Orm_Db, execute)
{
    zval *step, *params;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(step)
        Z_PARAM_ARRAY(params)
    ZEND_PARSE_PARAMETERS_END();
    if (!execute_impl(ZEND_THIS, step, params)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, select)
{
    zval *frame, *r;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(frame)
        Z_PARAM_OBJECT_OF_CLASS(r, cls("Polyspec\\Orm\\Request"))
    ZEND_PARSE_PARAMETERS_END();
    if (!select_impl(ZEND_THIS, frame, r, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, scalarOf)
{
    zval *frame, *r;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(frame)
        Z_PARAM_OBJECT_OF_CLASS(r, cls("Polyspec\\Orm\\Request"))
    ZEND_PARSE_PARAMETERS_END();
    if (!scalar_of_impl(ZEND_THIS, frame, r, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, paginate)
{
    zval *frame, *r;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(frame)
        Z_PARAM_OBJECT_OF_CLASS(r, cls("Polyspec\\Orm\\Request"))
    ZEND_PARSE_PARAMETERS_END();
    if (!paginate_impl(ZEND_THIS, frame, r, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, writeOf)
{
    zval *frame, *r, *after = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_ZVAL(frame)
        Z_PARAM_OBJECT_OF_CLASS(r, cls("Polyspec\\Orm\\Request"))
        Z_PARAM_OPTIONAL
        Z_PARAM_ZVAL(after)
    ZEND_PARSE_PARAMETERS_END();
    if (after != NULL && Z_TYPE_P(after) == IS_NULL) {
        after = NULL;
    }
    if (!write_of_impl(ZEND_THIS, frame, r, after, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, statement)
{
    zval *r;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(r, cls("Polyspec\\Orm\\Request"))
    ZEND_PARSE_PARAMETERS_END();
    if (!statement_impl(ZEND_THIS, r, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, clock)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!clock_of(ZEND_THIS, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, timeValue)
{
    zval *v, *zone;
    zend_string *col;
    zend_long precision;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_ZVAL(v)
        Z_PARAM_STR(col)
        Z_PARAM_LONG(precision)
        Z_PARAM_OBJECT_OF_CLASS(zone, cls("DateTimeZone"))
    ZEND_PARSE_PARAMETERS_END();
    if (!time_value(v, ZSTR_VAL(col), precision, zone, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, acquireSQLiteRowLock)
{
    zend_string *mode;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(mode)
    ZEND_PARSE_PARAMETERS_END();
    zval m;
    ZVAL_STR_COPY(&m, mode);
    bool ok = acquire_row_lock(ZEND_THIS, &m);
    zval_ptr_dtor(&m);
    if (!ok) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, rowKey)
{
    zval *row, *refs;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(row)
        Z_PARAM_ARRAY(refs)
    ZEND_PARSE_PARAMETERS_END();
    if (!row_key(row, refs, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, rowSlot)
{
    zval *row, *refs;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(row)
        Z_PARAM_ARRAY(refs)
    ZEND_PARSE_PARAMETERS_END();
    if (!row_slot(row, refs, return_value)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Db, sameScalar)
{
    zval *a, *b;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(a)
        Z_PARAM_ZVAL(b)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(same_scalar(a, b));
}

ZEND_METHOD(Polyspec_Orm_Db, scalarText)
{
    zval *v;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ZVAL(v)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *s = NULL;
    if (!scalar_text(v, &s)) {
        RETURN_THROWS();
    }
    RETURN_STR(s);
}

ZEND_METHOD(Polyspec_Orm_Db, bindLimit)
{
    zval *driver;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ZVAL(driver)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_LONG(bind_limit(driver));
}

ZEND_METHOD(Polyspec_Orm_Db, insertParts)
{
    zend_long rows, batch;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_LONG(rows)
        Z_PARAM_LONG(batch)
    ZEND_PARSE_PARAMETERS_END();
    insert_parts_batch(rows, batch, return_value);
}


/* ---- transactions (T182-5-2): the frames, begin, finish, savepoints, the audit record, the transaction callback ---- */

/* Db::$frames: the active transactions of the request, innermost last, across the connections. */
static zval *g_frames;
static size_t g_nframes;
static size_t g_capframes;

static void frames_push(zval *frame)
{
    if (g_nframes == g_capframes) {
        g_capframes = g_capframes == 0 ? 8 : g_capframes * 2;
        g_frames = erealloc(g_frames, g_capframes * sizeof(zval));
    }
    ZVAL_COPY(&g_frames[g_nframes++], frame);
}

static void frames_pop(void)
{
    if (g_nframes > 0) {
        zval_ptr_dtor(&g_frames[--g_nframes]);
    }
}

/* Db::activeFor: the innermost active transaction of the connection's state, or NULL. The pointer is into the frame stack. */
static zval *active_for(zval *db)
{
    zval *state = rd(db, "state");
    for (size_t i = g_nframes; i > 0; i--) {
        zval *fdb = rd(&g_frames[i - 1], "db");
        zval *fstate = rd(fdb, "state");
        if (Z_OBJ_P(fstate) == Z_OBJ_P(state)) {
            return &g_frames[i - 1];
        }
    }
    return NULL;
}

/* Makes the rollback error: OrmException::rollback(cause, rollback). Throws it. */
static void throw_rollback(zval *cause, zval *rollback)
{
    zval args[2], ex;
    ZVAL_COPY(&args[0], cause);
    ZVAL_COPY(&args[1], rollback);
    if (scall("Polyspec\\Orm\\OrmException::rollback", &ex, 2, args)) {
        put_exception(&ex);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
}

/* Db::joined: the one error, or a CONFIG carrying the messages of several. Returns an owned exception or NULL in out. */
static void joined(zval *errors, zval *out)
{
    zend_long n = acount(errors);
    ZVAL_NULL(out);
    if (n == 0) {
        return;
    }
    if (n == 1) {
        zval *first = aidx(errors, 0);
        if (first != NULL) {
            ZVAL_COPY(out, first);
        }
        return;
    }
    smart_str msg = {0};
    zval *e;
    zend_long i = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(errors), e)
    {
        zval m;
        ZVAL_UNDEF(&m);
        mcall(e, "getMessage", &m, 0, NULL);
        if (i > 0) {
            smart_str_appends(&msg, "; ");
        }
        smart_str_append(&msg, zval_get_string(&m));
        zval_ptr_dtor(&m);
        i++;
    }
    ZEND_HASH_FOREACH_END();
    smart_str_0(&msg);
    zval args[3], ex;
    ZVAL_STR(&args[0], zend_string_init("CONFIG", 6, 0));
    ZVAL_STR(&args[1], msg.s ? msg.s : ZSTR_EMPTY_ALLOC());
    zval *first = aidx(errors, 0);
    ZVAL_COPY(&args[2], first);
    if (newobj(ORM_EXCEPTION, &ex, 3, args)) {
        ZVAL_COPY_VALUE(out, &ex);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
}

/* A statement of the connection that is not a model statement, in the transaction (Db::control): it cannot be blocked by a fault. */
static bool control_stmt(zval *self, const char *kind, zval *tx, const char *sql)
{
    zval k, tables, s, binds, out;
    str_zv(&k, kind);
    array_init(&tables);
    ZVAL_COPY(&s, tx);
    zval sqlz;
    str_zv(&sqlz, sql);
    array_init(&binds);
    bool ok = observed_as(self, true, &k, &tables, &s, &sqlz, &binds, op_exec_sql, &sqlz, &out);
    zval_ptr_dtor(&k);
    zval_ptr_dtor(&tables);
    zval_ptr_dtor(&s);
    zval_ptr_dtor(&sqlz);
    zval_ptr_dtor(&binds);
    if (ok) {
        zval_ptr_dtor(&out);
    }
    return ok;
}

/* The transaction number of a frame, as a zval. */
static void frame_number(zval *frame, zval *out)
{
    ZVAL_COPY(out, rd(frame, "number"));
}

/* Db::endSavepoint: the statement of the savepoint name; its error, or NULL in out. Takes the pending exception. */
static void savepoint_control(zval *self, zval *frame, const char *kind, const char *name, bool *ok);

static void end_savepoint(zval *self, zval *frame, const char *kind, const char *name, zval *out)
{
    bool ok;
    savepoint_control(self, frame, kind, name, &ok);
    if (ok) {
        ZVAL_NULL(out);
        return;
    }
    zval ex;
    take_exception(&ex);
    ZVAL_COPY_VALUE(out, &ex);
}

static void savepoint_control(zval *self, zval *frame, const char *kind, const char *name, bool *ok)
{
    const char *op = "savepoint";
    char statement[128];
    if (strcmp(kind, "savepoint") == 0) {
        snprintf(statement, sizeof(statement), "SAVEPOINT %s", name);
    } else if (strcmp(kind, "release") == 0) {
        op = "release";
        snprintf(statement, sizeof(statement), "RELEASE SAVEPOINT %s", name);
    } else {
        op = "rollback_to";
        snprintf(statement, sizeof(statement), "ROLLBACK TO SAVEPOINT %s", name);
    }
    zval *md = rd(self, "md");
    if (md != NULL && Z_TYPE_P(md) == IS_OBJECT) {
        zval msg, r;
        array_init(&msg);
        zval v;
        str_zv(&v, op);
        setk(&msg, "op", &v);
        zval_ptr_dtor(&v);
        str_zv(&v, name);
        setk(&msg, "name", &v);
        zval_ptr_dtor(&v);
        *ok = mcall(md, "call", &r, 1, &msg);
        zval_ptr_dtor(&msg);
        zval_ptr_dtor(&r);
        return;
    }
    zval fnum;
    frame_number(frame, &fnum);
    *ok = control_stmt(self, kind, &fnum, statement);
    zval_ptr_dtor(&fnum);
}

/* The sort order of the mysql local keys: bytewise, as SORT_STRING. */
static int frame_key_compare(Bucket *a, Bucket *b)
{
    return zend_binary_strcmp(Z_STRVAL(a->val), Z_STRLEN(a->val), Z_STRVAL(b->val), Z_STRLEN(b->val));
}

/* Db::cleanup: releases the locks of the frame and clears its local values; every step is tried and the failures are returned. */
static void frame_cleanup(zval *self, zval *frame, zval *errors)
{
    array_init(errors);
    zval *fnum_zv = rd(frame, "number");
    zval fnum;
    ZVAL_COPY(&fnum, fnum_zv);
    zval *locks = rd(frame, "locks");
    if (locks != NULL && Z_TYPE_P(locks) == IS_ARRAY) {
        zval *key;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(locks), key)
        {
            zval tables, sql, args, rows, s;
            array_init(&tables);
            str_zv(&sql, "SELECT RELEASE_LOCK(?)");
            array_init(&args);
            push(&args, key);
            zval binds;
            ZVAL_COPY(&binds, &args);
            ZVAL_COPY(&s, &fnum);
            zval k;
            str_zv(&k, "utility");
            fetchctx fc = {&sql, &args};
            bool ok = observed_as(self, true, &k, &tables, &s, &sql, &binds, op_fetch_rows, &fc, &rows);
            zval_ptr_dtor(&k);
            zval_ptr_dtor(&s);
            zval_ptr_dtor(&tables);
            zval_ptr_dtor(&sql);
            zval_ptr_dtor(&args);
            zval_ptr_dtor(&binds);
            if (ok) {
                zval *first = aidx(aidx(&rows, 0), 0);
                bool held = false;
                if (first != NULL) {
                    zend_string *fs = zval_get_string(first);
                    held = ZSTR_LEN(fs) == 1 && ZSTR_VAL(fs)[0] == '1';
                    zend_string_release(fs);
                }
                zval_ptr_dtor(&rows);
                if (!held) {
                    throw_orm("CONFIG", "lock %s was not held at transaction end", Z_STRVAL_P(key));
                    ok = false;
                }
            }
            if (!ok) {
                zval ex;
                take_exception(&ex);
                push(errors, &ex);
                zval_ptr_dtor(&ex);
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    zval empty;
    array_init(&empty);
    wr(frame, "locks", &empty);
    zval_ptr_dtor(&empty);
    if (is_str(rd(self, "driver"), "mysql")) {
        zval *locals = rd(frame, "locals");
        if (locals != NULL && Z_TYPE_P(locals) == IS_ARRAY) {
            /* The keys are sorted as strings and cleared in that order. */
            zval keys;
            array_init(&keys);
            zend_string *ks;
            ZEND_HASH_FOREACH_STR_KEY(Z_ARRVAL_P(locals), ks)
            {
                if (ks != NULL) {
                    zval kz;
                    ZVAL_STR_COPY(&kz, ks);
                    push(&keys, &kz);
                    zval_ptr_dtor(&kz);
                }
            }
            ZEND_HASH_FOREACH_END();
            zend_hash_sort(Z_ARRVAL(keys), frame_key_compare, 0);
            zval *k;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL(keys), k)
            {
                smart_str sql = {0};
                smart_str_appends(&sql, "SET @`orm.");
                smart_str_append(&sql, zval_get_string(k));
                smart_str_appends(&sql, "` = NULL");
                smart_str_0(&sql);
                bool ok = control_stmt(self, "utility", &fnum, ZSTR_VAL(sql.s));
                if (!ok) {
                    zval ex;
                    take_exception(&ex);
                    push(errors, &ex);
                    zval_ptr_dtor(&ex);
                }
                smart_str_free(&sql);
            }
            ZEND_HASH_FOREACH_END();
            zval_ptr_dtor(&keys);
        }
    }
    if (is_str(rd(self, "driver"), "sqlite")) {
        if (as_bool(rd(frame, "readOnly"))) {
            if (!control_stmt(self, "utility", &fnum, "PRAGMA query_only = 0")) {
                zval ex;
                take_exception(&ex);
                push(errors, &ex);
                zval_ptr_dtor(&ex);
            }
        }
        if (is_str(rd(frame, "isolation"), "read_uncommitted")) {
            if (!control_stmt(self, "utility", &fnum, "PRAGMA read_uncommitted = 0")) {
                zval ex;
                take_exception(&ex);
                push(errors, &ex);
                zval_ptr_dtor(&ex);
            }
        }
    }
    zval_ptr_dtor(&fnum);
}

/* Db::finish: ends the transaction. Returns false with the error pending when the end failed. */
static bool finish_tx(zval *self, zval *frame, bool commit)
{
    zval t;
    ZVAL_TRUE(&t);
    wr(frame, "finished", &t);
    zval *md = rd(self, "md");
    if (md != NULL && Z_TYPE_P(md) == IS_OBJECT) {
        zval msg, r;
        array_init(&msg);
        zval op;
        str_zv(&op, commit ? "commit" : "rollback");
        setk(&msg, "op", &op);
        zval_ptr_dtor(&op);
        bool ok = mcall(md, "call", &r, 1, &msg);
        zval_ptr_dtor(&msg);
        zval_ptr_dtor(&r);
        return ok;
    }
    zval fnum;
    frame_number(frame, &fnum);
    zval errors, failure_z;
    frame_cleanup(self, frame, &errors);
    joined(&errors, &failure_z);
    zval_ptr_dtor(&errors);
    if (commit && Z_TYPE(failure_z) == IS_NULL) {
        if (control_stmt(self, "commit", &fnum, "COMMIT")) {
            zval_ptr_dtor(&failure_z);
            zval_ptr_dtor(&fnum);
            return true;
        }
        zval ex;
        take_exception(&ex);
        zval_ptr_dtor(&failure_z);
        ZVAL_COPY_VALUE(&failure_z, &ex);
    }
    zval rollback;
    ZVAL_NULL(&rollback);
    /* A failed COMMIT may have ended the transaction on the server, so only the remaining transaction is rolled back. */
    bool attempted = false;
    bool rolled = true;
    zval pdo;
    if (!commit) {
        attempted = true;
    } else if (handle_pdo(self, &pdo)) {
        zval r;
        bool ok = mcall(&pdo, "inTransaction", &r, 0, NULL);
        attempted = ok && zend_is_true(&r);
        zval_ptr_dtor(&r);
        zval_ptr_dtor(&pdo);
        if (!ok) {
            zval ex;
            take_exception(&ex);
            ZVAL_COPY_VALUE(&rollback, &ex);
            rolled = false;
        }
    } else {
        zval ex;
        take_exception(&ex);
        ZVAL_COPY_VALUE(&rollback, &ex);
        rolled = false;
    }
    if (rolled && attempted) {
        if (!control_stmt(self, "rollback", &fnum, "ROLLBACK")) {
            zval ex;
            take_exception(&ex);
            ZVAL_COPY_VALUE(&rollback, &ex);
        }
    }
    zval_ptr_dtor(&fnum);
    if (commit) {
        if (Z_TYPE(rollback) == IS_NULL) {
            put_exception(&failure_z);
        } else {
            throw_rollback(&failure_z, &rollback);
            zval_ptr_dtor(&failure_z);
            zval_ptr_dtor(&rollback);
        }
        return false;
    }
    zval list, final_err;
    array_init(&list);
    if (Z_TYPE(failure_z) != IS_NULL) {
        push(&list, &failure_z);
    }
    if (Z_TYPE(rollback) != IS_NULL) {
        push(&list, &rollback);
    }
    zval_ptr_dtor(&failure_z);
    zval_ptr_dtor(&rollback);
    joined(&list, &final_err);
    zval_ptr_dtor(&list);
    if (Z_TYPE(final_err) != IS_NULL) {
        put_exception(&final_err);
        return false;
    }
    zval_ptr_dtor(&final_err);
    return true;
}

static void driver_error(zval *self, zval *ex, zval *out)
{
    zval arg;
    ZVAL_COPY(&arg, ex);
    if (!mcall(self, "driverError", out, 1, &arg)) {
        ZVAL_NULL(out);
    }
    zval_ptr_dtor(&arg);
}

/* Db::begin: opens the transaction on the connection. out is the frame; false with the error pending when it failed. */
static bool begin_tx(zval *self, const char *isolation, bool read_only, zend_long timeout, zval *out);

/* Db::savepoint: a nested transaction of the same connection is a savepoint of the outer frame. out is the callback's result. */
static bool savepoint_tx(zval *self, zval *frame, zval *fn, zval *out)
{
    zend_long sp = as_long(rd(frame, "savepoints")) + 1;
    zval spz;
    ZVAL_LONG(&spz, sp);
    wr(frame, "savepoints", &spz);
    char name[64];
    snprintf(name, sizeof(name), "orm_sp_%ld", (long)sp);
    zval audit_before;
    ZVAL_COPY(&audit_before, rd(frame, "audit"));
    zval inserted_before;
    ZVAL_COPY(&inserted_before, rd(frame, "inserted"));
    bool kept = false;
    bool has_pending = false;
    zval pending;
    bool ok_sp;
    savepoint_control(self, frame, "savepoint", name, &ok_sp);
    if (!ok_sp) {
        take_exception(&pending);
        has_pending = true;
    } else {
        frames_push(frame);
        zval ret;
        ZVAL_UNDEF(&ret);
        bool ok = call_user_function(NULL, NULL, fn, &ret, 0, NULL) == SUCCESS && EG(exception) == NULL;
        if (!ok) {
            zval ex, failure, e1, e2, list, ended;
            take_exception(&ex);
            frames_pop();
            if (is_instance(&ex, "PDOException")) {
                driver_error(self, &ex, &failure);
            } else {
                ZVAL_COPY(&failure, &ex);
            }
            zval_ptr_dtor(&ex);
            end_savepoint(self, frame, "rollback_to", name, &e1);
            end_savepoint(self, frame, "release", name, &e2);
            array_init(&list);
            if (Z_TYPE(e1) != IS_NULL) {
                push(&list, &e1);
            }
            if (Z_TYPE(e2) != IS_NULL) {
                push(&list, &e2);
            }
            zval_ptr_dtor(&e1);
            zval_ptr_dtor(&e2);
            joined(&list, &ended);
            zval_ptr_dtor(&list);
            if (Z_TYPE(ended) == IS_NULL) {
                ZVAL_COPY_VALUE(&pending, &failure);
            } else {
                throw_rollback(&failure, &ended);
                take_exception(&pending);
                zval_ptr_dtor(&failure);
                zval_ptr_dtor(&ended);
            }
            has_pending = true;
        } else {
            frames_pop();
            zval rel;
            end_savepoint(self, frame, "release", name, &rel);
            if (Z_TYPE(rel) != IS_NULL) {
                ZVAL_COPY_VALUE(&pending, &rel);
                has_pending = true;
            } else {
                kept = true;
                ZVAL_COPY_VALUE(out, &ret);
            }
        }
    }
    if (!kept) {
        wr(frame, "audit", &audit_before);
        wr(frame, "inserted", &inserted_before);
    }
    zval_ptr_dtor(&audit_before);
    zval_ptr_dtor(&inserted_before);
    zend_long left = as_long(rd(frame, "savepoints")) - 1;
    zval leftz;
    ZVAL_LONG(&leftz, left);
    wr(frame, "savepoints", &leftz);
    if (has_pending) {
        put_exception(&pending);
    }
    return kept;
}

/* Makes the frame of a transaction that opens with the next transaction count of state, into out; false when the frame is not made. */
static bool make_tx_frame(zval *self, zval *state, zval *out, bool read_only, const char *isolation)
{
    zval n;
    zval *st = rd(state, "transactions");
    ZVAL_LONG(&n, as_long(st) + 1);
    wr(state, "transactions", &n);
    zval ctor[4];
    ZVAL_COPY(&ctor[0], self);
    ZVAL_BOOL(&ctor[1], read_only);
    str_zv(&ctor[2], isolation);
    ZVAL_COPY(&ctor[3], &n);
    bool made = newobj("Polyspec\\Orm\\TxFrame", out, 4, ctor);
    for (int i = 0; i < 4; i++) {
        zval_ptr_dtor(&ctor[i]);
    }
    return made;
}

/* Db::begin: the statements that open the transaction, by driver, and the frame that holds them. */
static bool begin_tx(zval *self, const char *isolation, bool read_only, zend_long timeout, zval *out)
{
    zval *state = rd(self, "state");
    if (as_bool(rd(state, "closed"))) {
        throw_orm("CONFIG", "database is closed");
        return false;
    }
    if (timeout > 0 && !is_str(rd(self, "driver"), "postgres")) {
        throw_orm("CAPABILITY_UNSUPPORTED", "transaction timeoutMs is supported only by postgres");
        return false;
    }
    zval *md = rd(self, "md");
    if (md != NULL && Z_TYPE_P(md) == IS_OBJECT) {
        if (isolation[0] != '\0') {
            zval arg, e;
            str_zv(&arg, "the transaction isolation option");
            if (scall("Polyspec\\Orm\\Markdown::unsupported", &e, 1, &arg)) {
                put_exception(&e);
            }
            zval_ptr_dtor(&arg);
            return false;
        }
        if (!make_tx_frame(self, state, out, read_only, isolation)) {
            return false;
        }
        zval ro, bm, r;
        ZVAL_BOOL(&ro, read_only);
        bool sent = scall("Polyspec\\Orm\\Markdown::beginMessage", &bm, 1, &ro)
            && mcall(md, "call", &r, 1, &bm);
        zval_ptr_dtor(&bm);
        zval_ptr_dtor(&r);
        return sent;
    }
    /* The upper-case level of the isolation: underscores become spaces. */
    char level[32] = "";
    for (size_t i = 0; isolation[i] != '\0' && i < sizeof(level) - 1; i++) {
        char c = isolation[i] == '_' ? ' ' : isolation[i];
        level[i] = (char)((c >= 'a' && c <= 'z') ? c - 32 : c);
        level[i + 1] = '\0';
    }
    if (is_str(rd(self, "driver"), "sqlite") && !ensure_row_lock_table(self)) {
        return false;
    }
    if (!make_tx_frame(self, state, out, read_only, isolation)) {
        return false;
    }
    /* The statements that open the transaction. Each is [kind, sql] and is a control statement. */
    const char *kinds[4];
    char sqls[4][256];
    int nsteps = 0;
    const char *driver = Z_STRVAL_P(rd(self, "driver"));
    if (strcmp(driver, "mysql") == 0) {
        if (level[0] != '\0') {
            kinds[nsteps] = "utility";
            snprintf(sqls[nsteps++], 256, "SET TRANSACTION ISOLATION LEVEL %s", level);
        }
        kinds[nsteps] = "begin";
        snprintf(sqls[nsteps++], 256, "%s", read_only ? "START TRANSACTION READ ONLY" : "START TRANSACTION");
    } else if (strcmp(driver, "postgres") == 0) {
        kinds[nsteps] = "begin";
        snprintf(sqls[nsteps++], 256, "BEGIN%s%s%s", level[0] != '\0' ? " ISOLATION LEVEL " : "", level,
            read_only ? " READ ONLY" : "");
        if (timeout > 0) {
            kinds[nsteps] = "utility";
            snprintf(sqls[nsteps++], 256, "SET LOCAL statement_timeout = %ld", (long)timeout);
        }
    } else {
        kinds[nsteps] = "begin";
        snprintf(sqls[nsteps++], 256, "%s", read_only ? "BEGIN" : "BEGIN IMMEDIATE");
        if (strcmp(isolation, "read_uncommitted") == 0) {
            kinds[nsteps] = "utility";
            snprintf(sqls[nsteps++], 256, "PRAGMA read_uncommitted = 1");
        }
        if (read_only) {
            kinds[nsteps] = "utility";
            snprintf(sqls[nsteps++], 256, "PRAGMA query_only = 1");
        }
    }
    zval number_z;
    frame_number(out, &number_z);
    for (int i = 0; i < nsteps; i++) {
        zval tables;
        array_init(&tables);
        zval tx;
        ZVAL_COPY(&tx, &number_z);
        bool ok = run_stmt(self, kinds[i], &tables, &tx, sqls[i], true);
        zval_ptr_dtor(&tables);
        zval_ptr_dtor(&tx);
        if (ok) {
            continue;
        }
        zval failure;
        take_exception(&failure);
        zval dummy;
        bool in_tx = false;
        zval pdo;
        if (handle_pdo(self, &pdo)) {
            zval r;
            if (mcall(&pdo, "inTransaction", &r, 0, NULL)) {
                in_tx = zend_is_true(&r);
                zval_ptr_dtor(&r);
            }
            zval_ptr_dtor(&pdo);
        } else {
            zval_ptr_dtor(&failure);
            take_exception(&dummy);
            put_exception(&dummy);
            zval_ptr_dtor(&number_z);
            zval_ptr_dtor(out);
            return false;
        }
        if (!in_tx) {
            put_exception(&failure);
            zval_ptr_dtor(&number_z);
            zval_ptr_dtor(out);
            return false;
        }
        if (!finish_tx(self, out, false)) {
            zval cleanup;
            take_exception(&cleanup);
            throw_rollback(&failure, &cleanup);
            zval_ptr_dtor(&failure);
            zval_ptr_dtor(&cleanup);
            zval_ptr_dtor(&number_z);
            zval_ptr_dtor(out);
            return false;
        }
        put_exception(&failure);
        zval_ptr_dtor(&number_z);
        zval_ptr_dtor(out);
        return false;
    }
    zval_ptr_dtor(&number_z);
    return true;
}

/* Sorts the strings of a list bytewise (SORT_STRING). */
static int zstr_compare(const void *a, const void *b)
{
    zend_string *x = *(zend_string *const *)a;
    zend_string *y = *(zend_string *const *)b;
    return zend_binary_strcmp(ZSTR_VAL(x), ZSTR_LEN(x), ZSTR_VAL(y), ZSTR_LEN(y));
}

/* The keys of an array, sorted bytewise: the order of ksort(..., SORT_STRING). Keys that are integers are converted to strings. */
static void sorted_keys(zval *arr, zend_string ***keys_out, size_t *n_out)
{
    size_t n = zend_hash_num_elements(Z_ARRVAL_P(arr));
    zend_string **keys = emalloc(sizeof(zend_string *) * (n ? n : 1));
    size_t i = 0;
    zend_string *k;
    zend_ulong h;
    ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(arr), h, k)
    {
        keys[i++] = k != NULL ? zend_string_copy(k) : zend_long_to_str((zend_long)h);
    }
    ZEND_HASH_FOREACH_END();
    qsort(keys, n, sizeof(zend_string *), zstr_compare);
    *keys_out = keys;
    *n_out = n;
}

static void free_keys(zend_string **keys, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        zend_string_release(keys[i]);
    }
    efree(keys);
}

/* The audit source of the configuration, called once: its value (an array), or false with its exception pending. */
static bool scall_source(zval *source, zval *out)
{
    return call_user_function(NULL, NULL, source, out, 0, NULL) == SUCCESS && EG(exception) == NULL
        && Z_TYPE_P(out) == IS_ARRAY;
}

/* a[k] = copy of v with a string key that is a symbol-table key (numeric strings become integer keys). */
static void setkz(zval *a, zend_string *k, zval *v)
{
    zval c;
    ZVAL_COPY(&c, v);
    zend_symtable_update(Z_ARRVAL_P(a), k, &c);
}

/* Db::auditRecord: the audit record of the transaction's values: the audit source's value plus the transaction's value, in the
 * record table the connection's set names. out is the record array, or the CONFIG error is pending (false). */
static bool audit_record(zval *self, zval *values, zval *out)
{
    zval *source = rd(rd(self, "config"), "auditSource");
    if (source == NULL || Z_TYPE_P(source) != IS_OBJECT) {
        throw_orm("CONFIG", "the transaction has audit values but the connection has no audit source: set Config auditSource");
        return false;
    }
    zval *state = rd(self, "state");
    zval *sets = rd(state, "sets");
    /* The models of the sets: [hash, model] pairs in registration order. */
    zval models;
    array_init(&models);
    zend_string *hk;
    zend_ulong hi;
    ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(sets), hi, hk)
    {
        zval hash, model;
        if (hk != NULL) {
            ZVAL_STR_COPY(&hash, hk);
        } else {
            ZVAL_LONG(&hash, (zend_long)hi);
        }
        if (!scall("Polyspec\\Orm\\Registry::model", &model, 1, &hash)) {
            zval_ptr_dtor(&hash);
            zval_ptr_dtor(&models);
            return false;
        }
        zval pair;
        array_init(&pair);
        zend_hash_next_index_insert(Z_ARRVAL(pair), &hash);
        zend_hash_next_index_insert(Z_ARRVAL(pair), &model);
        zend_hash_next_index_insert(Z_ARRVAL(models), &pair);
    }
    ZEND_HASH_FOREACH_END();
    /* The audit record tables of the entities, sorted and unique. */
    zval tables;
    array_init(&tables);
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(models), pair)
    {
        zval *model = aidx(pair, 1);
        zval *ents = rd(model, "entities");
        zval *entity;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ents), entity)
        {
            zval *rec = aget(entity, "audit_record");
            if (rec == NULL || Z_TYPE_P(rec) != IS_STRING || Z_STRLEN_P(rec) == 0) {
                continue;
            }
            bool present = false;
            zval *t;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL(tables), t)
            {
                if (zend_string_equals(Z_STR_P(t), Z_STR_P(rec))) {
                    present = true;
                }
            }
            ZEND_HASH_FOREACH_END();
            if (!present) {
                push(&tables, rec);
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    ZEND_HASH_FOREACH_END();
    size_t nt = acount(&tables);
    if (nt == 0) {
        zval_ptr_dtor(&models);
        zval_ptr_dtor(&tables);
        throw_orm("CONFIG", "the transaction has audit values but no set of the connection has an audited table");
        return false;
    }
    /* Sorts the tables bytewise: the first one is the record table. */
    zend_string **tk = emalloc(sizeof(zend_string *) * nt);
    size_t ti = 0;
    zval *t;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(tables), t)
    {
        tk[ti++] = zend_string_copy(Z_STR_P(t));
    }
    ZEND_HASH_FOREACH_END();
    qsort(tk, nt, sizeof(zend_string *), zstr_compare);
    if (nt > 1) {
        smart_str list = {0};
        for (size_t i = 0; i < nt; i++) {
            if (i > 0) {
                smart_str_appends(&list, ", ");
            }
            smart_str_append(&list, tk[i]);
        }
        smart_str_0(&list);
        throw_orm("CONFIG", "the audited tables of the connection record their audits in %s; one audit record table is required",
            ZSTR_VAL(list.s));
        smart_str_free(&list);
        free_keys(tk, nt);
        zval_ptr_dtor(&models);
        zval_ptr_dtor(&tables);
        return false;
    }
    zend_string *record_table = tk[0];
    /* The target: the last entity of the sets whose table is the record table and that is not external. */
    zval target;
    ZVAL_NULL(&target);
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(models), pair)
    {
        zval *hash = aidx(pair, 0);
        zval *model = aidx(pair, 1);
        zval *ents = rd(model, "entities");
        zval *entity;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ents), entity)
        {
            zval *tbl = aget(entity, "table");
            if (tbl != NULL && Z_TYPE_P(tbl) == IS_STRING && zend_string_equals(Z_STR_P(tbl), record_table)
                && !as_bool(aget(entity, "external"))) {
                zval_ptr_dtor(&target);
                array_init(&target);
                setk(&target, "hash", hash);
                setk(&target, "entity", entity);
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    ZEND_HASH_FOREACH_END();
    if (Z_TYPE(target) == IS_NULL) {
        throw_orm("CONFIG", "the audit record table %s is not a table of a set registered on the connection", ZSTR_VAL(record_table));
        free_keys(tk, nt);
        zval_ptr_dtor(&models);
        zval_ptr_dtor(&tables);
        return false;
    }
    zval *entity = aget(&target, "entity");
    if (acount(aget(entity, "pk")) != 1) {
        throw_orm("CONFIG", "the audit record table %s needs a primary key of one column", ZSTR_VAL(record_table));
        zval_ptr_dtor(&target);
        free_keys(tk, nt);
        zval_ptr_dtor(&models);
        zval_ptr_dtor(&tables);
        return false;
    }
    /* The merged values: the source's, then the transaction's, each in key order. */
    zval merged, src;
    array_init(&merged);
    bool ok = scall_source(source, &src);
    if (ok) {
        zval *cols = aget(entity, "columns");
        for (int which = 0; which < 2 && ok; which++) {
            zval *set = which == 0 ? &src : values;
            zend_string **sk;
            size_t sn;
            sorted_keys(set, &sk, &sn);
            for (size_t i = 0; i < sn && ok; i++) {
                zval *v = zend_symtable_find(Z_ARRVAL_P(set), sk[i]);
                ZVAL_DEREF(v);
                if (zend_symtable_find(Z_ARRVAL_P(cols), sk[i]) == NULL || Z_TYPE_P(zend_symtable_find(Z_ARRVAL_P(cols), sk[i])) == IS_NULL) {
                    throw_orm("CONFIG", "audit value %s is not a column of %s", ZSTR_VAL(sk[i]), ZSTR_VAL(record_table));
                    ok = false;
                    break;
                }
                setkz(&merged, sk[i], v);
            }
            free_keys(sk, sn);
        }
    }
    zval_ptr_dtor(&src);
    if (ok && acount(&merged) == 0) {
        throw_orm("CONFIG", "the audit record of %s has no value: the audit source and the transaction give none", ZSTR_VAL(record_table));
        ok = false;
    }
    free_keys(tk, nt);
    zval_ptr_dtor(&models);
    zval_ptr_dtor(&tables);
    if (!ok) {
        zval_ptr_dtor(&merged);
        zval_ptr_dtor(&target);
        return false;
    }
    setk(&target, "values", &merged);
    zval_ptr_dtor(&merged);
    ZVAL_COPY_VALUE(out, &target);
    return true;
}

/* Db::insertAudit: inserts the audit record of the transaction and returns its table and key. */
static bool insert_audit(zval *self, zval *frame, zval *record, zval *out)
{
    zval *entity = aget(record, "entity");
    zval *hash = aget(record, "hash");
    zval ctor[2];
    str_zv(&ctor[0], "insert");
    ZVAL_COPY(&ctor[1], hash);
    zval r;
    bool made = newobj(REQUEST_CLASS, &r, 2, ctor);
    zval_ptr_dtor(&ctor[0]);
    zval_ptr_dtor(&ctor[1]);
    if (!made) {
        return false;
    }
    zval ir;
    ZVAL_COPY(&ir, rd(&r, "ir"));
    setk(&ir, "entity", aget(entity, "entity"));
    zval set;
    array_init(&set);
    zval *values = aget(record, "values");
    zend_string **vk;
    size_t vn;
    sorted_keys(values, &vk, &vn);
    bool ok = true;
    for (size_t i = 0; i < vn && ok; i++) {
        zval *value = zend_symtable_find(Z_ARRVAL_P(values), vk[i]);
        ZVAL_DEREF(value);
        zval entry;
        array_init(&entry);
        zval colz;
        ZVAL_STR_COPY(&colz, vk[i]);
        zend_hash_str_update(Z_ARRVAL(entry), "column", 6, &colz);
        if (Z_TYPE_P(value) == IS_NULL) {
            zval t;
            ZVAL_TRUE(&t);
            zend_hash_str_update(Z_ARRVAL(entry), "null", 4, &t);
        } else {
            zval *cols = aget(entity, "columns");
            zval *cdef = zend_symtable_find(Z_ARRVAL_P(cols), vk[i]);
            zval enc_args[2];
            ZVAL_COPY(&enc_args[0], cdef);
            ZVAL_COPY(&enc_args[1], value);
            zval enc;
            ok = scall("Polyspec\\Orm\\Model::encodeValue", &enc, 2, enc_args);
            zval_ptr_dtor(&enc_args[0]);
            zval_ptr_dtor(&enc_args[1]);
            if (ok) {
                if (Z_TYPE(enc) == IS_NULL) {
                    zval t;
                    ZVAL_TRUE(&t);
                    zend_hash_str_update(Z_ARRVAL(entry), "null", 4, &t);
                } else {
                    zval pv;
                    ok = mcall(&r, "param", &pv, 1, &enc);
                    if (ok) {
                        zend_hash_str_update(Z_ARRVAL(entry), "p", 1, &pv);
                    }
                }
            }
            zval_ptr_dtor(&enc);
        }
        if (ok) {
            zend_hash_next_index_insert(Z_ARRVAL(set), &entry);
        } else {
            zval_ptr_dtor(&entry);
        }
    }
    free_keys(vk, vn);
    if (ok) {
        setk(&ir, "set", &set);
        wr(&r, "ir", &ir);
    }
    zval_ptr_dtor(&set);
    zval_ptr_dtor(&ir);
    if (!ok) {
        zval_ptr_dtor(&r);
        return false;
    }
    zval id_pair;
    bool wok = write_of_impl(self, frame, &r, NULL, &id_pair);
    zval_ptr_dtor(&r);
    if (!wok) {
        return false;
    }
    zval *id = aidx(&id_pair, 0);
    zval key;
    ZVAL_NULL(&key);
    zval *pk = aidx(aget(entity, "pk"), 0);
    zval *identity = aget(entity, "identity");
    if (identity != NULL && pk != NULL && zend_string_equals(Z_STR_P(identity), Z_STR_P(pk))) {
        if (id != NULL) {
            ZVAL_LONG(&key, zval_get_long(id));
        }
    } else if (pk != NULL) {
        zval *pv = zend_symtable_find(Z_ARRVAL_P(values), Z_STR_P(pk));
        if (pv != NULL) {
            ZVAL_COPY(&key, pv);
        }
    }
    zval_ptr_dtor(&id_pair);
    if (Z_TYPE(key) == IS_NULL) {
        throw_orm("CONFIG", "the audit record %s has no %s after its insert", Z_STRVAL_P(aget(entity, "table")),
            Z_STRVAL_P(pk));
        return false;
    }
    array_init(out);
    setk(out, "table", aget(entity, "table"));
    setk(out, "key", &key);
    zval_ptr_dtor(&key);
    return true;
}

/* Db::auditFor: makes sure the audit record precedes a write of an audited table. A guard (an update, delete or restore that can
 * match no row) inserts the record inside the savepoint orm_audit; then *settle is set, and settle_audit ends that savepoint. */
static bool audit_for(zval *self, zval *frame, bool guard, bool *settle)
{
    *settle = false;
    zval *audit = rd(frame, "audit");
    zval *pending = rd(frame, "pendingAudit");
    /* The frame's audit is null until its audit record is written: a null value is no record (Db::auditFor checks !== null). */
    if ((audit != NULL && Z_TYPE_P(audit) != IS_NULL) || pending == NULL) {
        return true;
    }
    zval pend;
    ZVAL_COPY(&pend, pending);
    zval rec;
    if (!guard) {
        bool ok = insert_audit(self, frame, &pend, &rec);
        zval_ptr_dtor(&pend);
        if (ok) {
            wr(frame, "audit", &rec);
            zval_ptr_dtor(&rec);
        }
        return ok;
    }
    bool ok_sp;
    savepoint_control(self, frame, "savepoint", "orm_audit", &ok_sp);
    if (!ok_sp) {
        zval_ptr_dtor(&pend);
        return false;
    }
    if (!insert_audit(self, frame, &pend, &rec)) {
        zval e, ended, ended1, ended2, list;
        take_exception(&e);
        end_savepoint(self, frame, "rollback_to", "orm_audit", &ended1);
        end_savepoint(self, frame, "release", "orm_audit", &ended2);
        array_init(&list);
        if (Z_TYPE(ended1) != IS_NULL) {
            push(&list, &ended1);
        }
        if (Z_TYPE(ended2) != IS_NULL) {
            push(&list, &ended2);
        }
        zval_ptr_dtor(&ended1);
        zval_ptr_dtor(&ended2);
        joined(&list, &ended);
        zval_ptr_dtor(&list);
        zval_ptr_dtor(&pend);
        if (Z_TYPE(ended) == IS_NULL) {
            put_exception(&e);
        } else {
            throw_rollback(&e, &ended);
            zval_ptr_dtor(&e);
            zval_ptr_dtor(&ended);
        }
        return false;
    }
    zval_ptr_dtor(&pend);
    wr(frame, "audit", &rec);
    zval_ptr_dtor(&rec);
    *settle = true;
    return true;
}

/* The settle of a guarded audit: releases the savepoint when the write changed a row, and otherwise undoes the record. Returns the
 * error to throw, or NULL in out. */
static void settle_audit(zval *self, zval *frame, zend_long affected, zval *out)
{
    if (affected > 0) {
        end_savepoint(self, frame, "release", "orm_audit", out);
        return;
    }
    zval nul;
    ZVAL_NULL(&nul);
    wr(frame, "audit", &nul);
    zval e1, e2, list;
    end_savepoint(self, frame, "rollback_to", "orm_audit", &e1);
    end_savepoint(self, frame, "release", "orm_audit", &e2);
    array_init(&list);
    if (Z_TYPE(e1) != IS_NULL) {
        push(&list, &e1);
    }
    if (Z_TYPE(e2) != IS_NULL) {
        push(&list, &e2);
    }
    zval_ptr_dtor(&e1);
    zval_ptr_dtor(&e2);
    joined(&list, out);
    zval_ptr_dtor(&list);
}

/* Db::runTransaction: the callback runs in the frame; an error rolls the frame back, and its own failure is reported with the
 * rollback's when the rollback fails too. A rollback fault of the test entry point is reported as failed. */
static bool run_transaction(zval *self, zval *fn, const char *isolation, bool read_only, zend_long timeout, zval *pending, zval *out)
{
    zval frame;
    if (!begin_tx(self, isolation, read_only, timeout, &frame)) {
        return false;
    }
    if (pending != NULL) {
        wr(&frame, "pendingAudit", pending);
    }
    frames_push(&frame);
    zval v;
    ZVAL_UNDEF(&v);
    bool ok = call_user_function(NULL, NULL, fn, &v, 0, NULL) == SUCCESS && EG(exception) == NULL;
    if (!ok) {
        zval ex, failure, cleanup;
        take_exception(&ex);
        frames_pop();
        if (is_instance(&ex, "PDOException")) {
            driver_error(self, &ex, &failure);
        } else {
            ZVAL_COPY(&failure, &ex);
        }
        zval_ptr_dtor(&ex);
        if (!finish_tx(self, &frame, false)) {
            take_exception(&cleanup);
            throw_rollback(&failure, &cleanup);
            zval_ptr_dtor(&cleanup);
            zval_ptr_dtor(&failure);
            zval_ptr_dtor(&frame);
            return false;
        }
        zval_ptr_dtor(&frame);
        zval *rf = rd(rd(self, "state"), "rollbackFault");
        if (as_bool(rf)) {
            zval f;
            ZVAL_FALSE(&f);
            wr(rd(self, "state"), "rollbackFault", &f);
            zval inner;
            throw_orm("FAULT", "test fault: the rollback of the transaction ran and is reported as failed");
            take_exception(&inner);
            throw_rollback(&failure, &inner);
            zval_ptr_dtor(&inner);
            zval_ptr_dtor(&failure);
            return false;
        }
        put_exception(&failure);
        return false;
    }
    frames_pop();
    if (!finish_tx(self, &frame, true)) {
        zval_ptr_dtor(&frame);
        zval_ptr_dtor(&v);
        return false;
    }
    zval_ptr_dtor(&frame);
    ZVAL_COPY_VALUE(out, &v);
    return true;
}

/* Db::transaction: the callback runs in a transaction of the connection; a transaction of the same connection inside an active one
 * is a savepoint and accepts only the retry option. A DEADLOCK is retried up to retry times, with a growing back-off. */
static bool transaction_impl(zval *self, zval *fn, const char *isolation, bool read_only, zend_long timeout, zend_long retry,
    zval *audit, zval *out)
{
    if (retry < 0) {
        throw_orm("CONFIG", "transaction retry must not be negative");
        return false;
    }
    if (timeout < 0) {
        throw_orm("CONFIG", "transaction timeoutMs must not be negative");
        return false;
    }
    static const char *const levels[] = {"", "read_uncommitted", "read_committed", "repeatable_read", "serializable"};
    bool known = false;
    for (size_t i = 0; i < sizeof(levels) / sizeof(levels[0]); i++) {
        if (strcmp(isolation, levels[i]) == 0) {
            known = true;
        }
    }
    if (!known) {
        throw_orm("CONFIG", "unsupported transaction isolation %s", isolation);
        return false;
    }
    if (audit != NULL && Z_TYPE_P(audit) != IS_NULL) {
        if (!unsupported_on_markdown(self, "a transaction with audit values")) {
            return false;
        }
    }
    zval *outer = active_for(self);
    bool has_outer = outer != NULL;
    zval outer_copy;
    if (has_outer) {
        ZVAL_COPY(&outer_copy, outer);
    }
    zval record;
    bool has_record = false;
    if (audit != NULL && Z_TYPE_P(audit) == IS_ARRAY && !has_outer) {
        if (!audit_record(self, audit, &record)) {
            if (has_outer) {
                zval_ptr_dtor(&outer_copy);
            }
            return false;
        }
        has_record = true;
    }
    if (has_outer) {
        bool has_audit = audit != NULL && Z_TYPE_P(audit) != IS_NULL;
        if (strlen(isolation) != 0 || read_only || timeout != 0 || has_audit) {
            zval_ptr_dtor(&outer_copy);
            throw_orm("CONFIG", "a nested transaction of the same connection accepts only the retry option");
            return false;
        }
        bool kept = savepoint_tx(self, &outer_copy, fn, out);
        zval_ptr_dtor(&outer_copy);
        return kept;
    }
    for (zend_long attempt = 0;; attempt++) {
        if (run_transaction(self, fn, isolation, read_only, timeout, has_record ? &record : NULL, out)) {
            if (has_record) {
                zval_ptr_dtor(&record);
            }
            return true;
        }
        zval ex;
        take_exception(&ex);
        zval *code = rd(&ex, "code_");
        bool deadlock = code != NULL && is_str(code, "DEADLOCK");
        if (!deadlock || attempt >= retry) {
            if (has_record) {
                zval_ptr_dtor(&record);
            }
            put_exception(&ex);
            return false;
        }
        zval_ptr_dtor(&ex);
        zval r;
        zval lo, hi;
        ZVAL_LONG(&lo, 0);
        ZVAL_LONG(&hi, 20000);
        zval jitter_args[2];
        ZVAL_COPY(&jitter_args[0], &lo);
        ZVAL_COPY(&jitter_args[1], &hi);
        zend_long jitter = 0;
        if (scall("random_int", &r, 2, jitter_args) && Z_TYPE(r) == IS_LONG) {
            jitter = Z_LVAL(r);
        }
        zval_ptr_dtor(&r);
        zval_ptr_dtor(&jitter_args[0]);
        zval_ptr_dtor(&jitter_args[1]);
        zend_long micros = (50000L << attempt) + jitter;
        usleep((useconds_t)micros);
    }
}

ZEND_METHOD(Polyspec_Orm_Db, transaction)
{
    zval *fn;
    zend_string *iso = NULL;
    bool read_only = false;
    zend_long timeout = 0, retry = 3;
    zval *audit = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 6)
        Z_PARAM_OBJECT_OF_CLASS(fn, zend_ce_closure)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(iso)
        Z_PARAM_BOOL(read_only)
        Z_PARAM_LONG(timeout)
        Z_PARAM_LONG(retry)
        Z_PARAM_ARRAY_OR_NULL(audit)
    ZEND_PARSE_PARAMETERS_END();
    const char *isolation = iso != NULL ? ZSTR_VAL(iso) : "";
    zval out;
    ZVAL_UNDEF(&out);
    if (!transaction_impl(ZEND_THIS, fn, isolation, read_only, timeout, retry, audit, &out)) {
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&out);
}

ZEND_METHOD(Polyspec_Orm_Db, nextTransaction)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *state = rd(ZEND_THIS, "state");
    zend_long n = as_long(rd(state, "transactions")) + 1;
    zval nz;
    ZVAL_LONG(&nz, n);
    wr(state, "transactions", &nz);
    RETURN_LONG(n);
}

ZEND_METHOD(Polyspec_Orm_Db, transactionNumber)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *frame = active_for(ZEND_THIS);
    if (frame == NULL) {
        RETURN_NULL();
    }
    RETURN_COPY(rd(frame, "number"));
}

ZEND_METHOD(Polyspec_Orm_Db, activeFor)
{
    zval *db;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(db, cls("Polyspec\\Orm\\Db"))
    ZEND_PARSE_PARAMETERS_END();
    zval *frame = active_for(db);
    if (frame == NULL) {
        RETURN_NULL();
    }
    RETURN_COPY(frame);
}

ZEND_METHOD(Polyspec_Orm_Db, resolve)
{
    zval *conn;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OR_NULL(conn)
    ZEND_PARSE_PARAMETERS_END();
    zval pair;
    array_init(&pair);
    if (conn != NULL) {
        if (as_bool(rd(rd(conn, "state"), "closed"))) {
            zval_ptr_dtor(&pair);
            throw_orm("CONFIG", "database is closed");
            RETURN_THROWS();
        }
        zval c;
        ZVAL_COPY(&c, conn);
        zend_hash_next_index_insert(Z_ARRVAL(pair), &c);
        zval *frame = active_for(conn);
        zval f;
        if (frame != NULL) {
            ZVAL_COPY(&f, frame);
        } else {
            ZVAL_NULL(&f);
        }
        zend_hash_next_index_insert(Z_ARRVAL(pair), &f);
    } else {
        if (g_nframes == 0) {
            zval_ptr_dtor(&pair);
            throw_orm("CONFIG", "the model has no connection; use connect or run it inside a transaction");
            RETURN_THROWS();
        }
        zval *frame = &g_frames[g_nframes - 1];
        zval db;
        ZVAL_COPY(&db, rd(frame, "db"));
        zend_hash_next_index_insert(Z_ARRVAL(pair), &db);
        zval f;
        ZVAL_COPY(&f, frame);
        zend_hash_next_index_insert(Z_ARRVAL(pair), &f);
    }
    RETURN_COPY_VALUE(&pair);
}

ZEND_METHOD(Polyspec_Orm_Db, inTransaction)
{
    zval *conn, *fn;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OR_NULL(conn)
        Z_PARAM_OBJECT(fn)
    ZEND_PARSE_PARAMETERS_END();
    if (conn == NULL) {
        if (g_nframes == 0) {
            throw_orm("CONFIG", "the model has no connection; use connect or run it inside a transaction");
            RETURN_THROWS();
        }
        zval ret;
        ZVAL_UNDEF(&ret);
        if (call_user_function(NULL, NULL, fn, &ret, 0, NULL) != SUCCESS || EG(exception) != NULL) {
            zval_ptr_dtor(&ret);
            RETURN_THROWS();
        }
        zval_ptr_dtor(&ret);
        return;
    }
    zval out;
    ZVAL_UNDEF(&out);
    if (!transaction_impl(conn, fn, "", false, 0, 0, NULL, &out)) {
        RETURN_THROWS();
    }
    zval_ptr_dtor(&out);
}

ZEND_METHOD(Polyspec_Orm_Db, utils)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval self;
    ZVAL_OBJ_COPY(&self, Z_OBJ_P(ZEND_THIS));
    if (!newobj("Polyspec\\Orm\\Utils", return_value, 1, &self)) {
        zval_ptr_dtor(&self);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&self);
}

ZEND_METHOD(Polyspec_Orm_Db, stats)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_long busy = active_for(ZEND_THIS) != NULL ? 1 : 0;
    zval args[4];
    ZVAL_LONG(&args[0], 1);
    ZVAL_LONG(&args[1], 1);
    ZVAL_LONG(&args[2], busy);
    ZVAL_LONG(&args[3], 1 - busy);
    if (!newobj("Polyspec\\Orm\\Stats", return_value, 4, args)) {
        RETURN_THROWS();
    }
}
