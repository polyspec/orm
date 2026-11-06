/* A markdown connection as the PDO handle of a SQLite connection (docs/spec/dialects.md DIA-154, DIA-185): a flowmark
 * server runs the statements of SQL in SQLite's dialect on the corpus, so each statement that the handle prepares or runs
 * is one statement message of its session (docs/spec/protocol.md PRT-65 to PRT-71), and its answer is read as pdo_sqlite
 * reads a row. Every SQL surface of the connection reads and writes through it.
 *
 * The handle keeps the transaction state of its session from the statements it sends: BEGIN opens a transaction, and
 * COMMIT, END and a whole ROLLBACK end it, whether or not they succeed; a failed statement does not (a flowmark session
 * keeps its transaction open after a failed statement). After a failed COMMIT the state of the session is unknown, so the
 * session is closed, as is a session whose connection broke. Outside a transaction, a statement on a closed session runs on
 * a new session of the DSN, as a statement outside a transaction runs on any connection of a pool (PRT-72). */
#include "php.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_weakrefs.h"
#include "ext/pdo/php_pdo.h"
#include "ext/pdo/php_pdo_driver.h"
#include "ext/standard/base64.h"
#include "ext/standard/php_string.h"
#include "dbspec.h"
#include "markdown_native.h"
#include "context_closure.h"
#include <math.h>
#include <string.h>

static zend_class_entry *md_adapter_ce;
static zend_class_entry *md_statement_ce;

/* An untyped value, bound by execute(array): it keeps its PHP type on the wire. */
#define MD_UNTYPED ((zend_long) -1)

static zval *md_prop(zval *object, const char *name, zval *rv)
{
    return zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), true, rv);
}

static void md_set(zval *object, const char *name, zval *value)
{
    zend_update_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), value);
}

/* Sets the fetch mode of statement to mode and its arguments, as setFetchMode and query name them. */
static void md_set_fetch_mode(zval *statement, zend_long mode, zval *args, uint32_t argc)
{
    zval modes;
    array_init_size(&modes, argc + 1);
    add_next_index_long(&modes, mode);
    for (uint32_t i = 0; i < argc; i++) {
        Z_TRY_ADDREF(args[i]);
        add_next_index_zval(&modes, &args[i]);
    }
    md_set(statement, "fetchMode", &modes);
    zval_ptr_dtor(&modes);
}

void markdown_statement_message(zval *message, zend_string *sql, zval *params)
{
    array_init(message);
    add_assoc_string(message, "op", "statement");
    add_assoc_str(message, "sql", zend_string_copy(sql));
    Z_TRY_ADDREF_P(params);
    add_assoc_zval(message, "params", params);
}

static void md_set_bool(zval *object, const char *name, bool value)
{
    zval v;
    ZVAL_BOOL(&v, value);
    md_set(object, name, &v);
}

static void md_set_long(zval *object, const char *name, zend_long value)
{
    zval v;
    ZVAL_LONG(&v, value);
    md_set(object, name, &v);
}

static void md_set_null(zval *object, const char *name)
{
    zval v;
    ZVAL_NULL(&v);
    md_set(object, name, &v);
}

static void md_set_empty(zval *object, const char *name)
{
    zval v;
    array_init(&v);
    md_set(object, name, &v);
    zval_ptr_dtor(&v);
}

static void md_no_error(zval *object)
{
    zval info;
    array_init_size(&info, 3);
    add_next_index_string(&info, "00000");
    add_next_index_null(&info);
    add_next_index_null(&info);
    md_set(object, "errorInfoValue", &info);
    zval_ptr_dtor(&info);
}

static zval *md_find(zval *array, const char *key)
{
    return array != NULL && Z_TYPE_P(array) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key)) : NULL;
}

static bool md_session_open(zval *session)
{
    return !markdown_session_broken(session);
}

/* Turns the OrmException thrown now into the PDO driver error of a SQLite connection: a PDOException with the message of
 * the server, SQLSTATE HY000, the SQLite result code of the answer (or null) in its errorInfo and the OrmException as its
 * previous throwable, which OrmException::fromDriver reads (PRT-71). Any other exception stays as it is. The errorInfo is
 * also written to the errorInfoValue of each of owners (up to two, NULL when absent). */
static void md_driver_error(zend_long result_code, zval *owner, zval *other)
{
    if (EG(exception) == NULL) return;
    zend_class_entry *orm = zend_lookup_class_ex(zend_string_init_interned("Polyspec\\Orm\\OrmException",
        sizeof("Polyspec\\Orm\\OrmException") - 1, 0), NULL, ZEND_FETCH_CLASS_NO_AUTOLOAD);
    if (orm == NULL || !instanceof_function(EG(exception)->ce, orm)) return;
    zend_object *cause = EG(exception);
    GC_ADDREF(cause);
    zend_clear_exception();
    zval cause_value, message;
    ZVAL_OBJ(&cause_value, cause);
    zend_call_method_with_0_params(cause, cause->ce, NULL, "getmessage", &message);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&cause_value);
        return;
    }
    zend_string *full = zval_get_string(&message);
    zval_ptr_dtor(&message);
    /* The message of an OrmException is its code and the server's message; the PDO error carries the server's. */
    zval code_rv;
    zval *code = zend_read_property(orm, cause, "code_", sizeof("code_") - 1, true, &code_rv);
    zend_string *text = full;
    if (code != NULL && Z_TYPE_P(code) == IS_STRING && ZSTR_LEN(full) >= Z_STRLEN_P(code) + 2
        && memcmp(ZSTR_VAL(full), Z_STRVAL_P(code), Z_STRLEN_P(code)) == 0
        && memcmp(ZSTR_VAL(full) + Z_STRLEN_P(code), ": ", 2) == 0) {
        text = zend_string_init(ZSTR_VAL(full) + Z_STRLEN_P(code) + 2, ZSTR_LEN(full) - Z_STRLEN_P(code) - 2, 0);
        zend_string_release(full);
    }
    zval info;
    array_init_size(&info, 3);
    add_next_index_string(&info, "HY000");
    if (result_code >= 0) add_next_index_long(&info, result_code); else add_next_index_null(&info);
    add_next_index_str(&info, zend_string_copy(text));
    if (owner != NULL) md_set(owner, "errorInfoValue", &info);
    if (other != NULL) md_set(other, "errorInfoValue", &info);
    zend_class_entry *pdo_exception = php_pdo_get_exception();
    zend_object *error = zend_throw_exception(pdo_exception, ZSTR_VAL(text), 0);
    zend_string_release(text);
    zend_update_property_string(zend_ce_exception, error, "code", sizeof("code") - 1, "HY000");
    zend_update_property(pdo_exception, error, "errorInfo", sizeof("errorInfo") - 1, &info);
    zval_ptr_dtor(&info);
    zend_exception_set_previous(error, cause);
}

/* Whether sql begins a transaction (1), ends one (2: COMMIT, END or a ROLLBACK that is not ROLLBACK TO), or neither (0);
 * commit is set for COMMIT and END. */
static int md_control(zend_string *sql, bool *commit)
{
    const char *s = ZSTR_VAL(sql), *end = s + ZSTR_LEN(sql);
    *commit = false;
    while (s < end && (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r')) s++;
    size_t n = 0;
    while (s + n < end && ((s[n] >= 'A' && s[n] <= 'Z') || (s[n] >= 'a' && s[n] <= 'z'))) n++;
    if (s + n < end && (s[n] == '_' || (s[n] >= '0' && s[n] <= '9'))) return 0;
    if (n == 5 && strncasecmp(s, "BEGIN", 5) == 0) return 1;
    if ((n == 6 && strncasecmp(s, "COMMIT", 6) == 0) || (n == 3 && strncasecmp(s, "END", 3) == 0)) {
        *commit = true;
        return 2;
    }
    if (n == 8 && strncasecmp(s, "ROLLBACK", 8) == 0) {
        const char *t = s + n;
        for (int word = 0; word < 2; word++) {
            while (t < end && (*t == ' ' || *t == '\t' || *t == '\n' || *t == '\r')) t++;
            size_t m = 0;
            while (t + m < end && ((t[m] >= 'A' && t[m] <= 'Z') || (t[m] >= 'a' && t[m] <= 'z'))) m++;
            if (m == 2 && strncasecmp(t, "TO", 2) == 0) return 0;
            if (!(word == 0 && m == 11 && strncasecmp(t, "TRANSACTION", 11) == 0)) break;
            t += m;
        }
        return 2;
    }
    return 0;
}

/* Sends message on the session of the adapter self; a refusal is the PDO driver error of the statement. */
static bool md_send(zval *self, zval *message, zval *answer, zval *statement)
{
    zval rv, *session = md_prop(self, "session", &rv);
    zend_long result_code = -1;
    if (markdown_session_send(session, message, answer, &result_code)) {
        /* A statement or fetch answer is read into its form, as MarkdownSession::statement and fetch read it. */
        zval *op = zend_hash_str_find(Z_ARRVAL_P(message), ZEND_STRL("op"));
        const char *what = op != NULL && zend_string_equals_literal(Z_STR_P(op), "statement") ? "statement"
            : op != NULL && zend_string_equals_literal(Z_STR_P(op), "fetch") ? "fetch" : NULL;
        if (what == NULL || markdown_session_answer(what, answer)) return true;
        zval_ptr_dtor(answer);
        ZVAL_UNDEF(answer);
        md_driver_error(-1, self, statement);
        return false;
    }
    md_driver_error(result_code, self, statement);
    return false;
}

static bool md_simple(zval *self, const char *op, zval *answer, zval *statement)
{
    zval message;
    array_init(&message);
    add_assoc_string(&message, "op", op);
    bool ok = md_send(self, &message, answer, statement);
    zval_ptr_dtor(&message);
    return ok;
}

static bool md_statement_drain(zval *statement);

/* Opens a new session of the DSN dsn (address, corpus, token and the _pragma pairs) into out, and states its _pragma
 * statements on it, as on a SQLite DSN. */
static bool md_dial(zval *dsn, zval *out)
{
    zval *address = zend_hash_index_find(Z_ARRVAL_P(dsn), 0), *corpus = zend_hash_index_find(Z_ARRVAL_P(dsn), 1);
    zval *token = zend_hash_index_find(Z_ARRVAL_P(dsn), 2), *pragmas = zend_hash_index_find(Z_ARRVAL_P(dsn), 3);
    if (!markdown_session_dial(Z_STR_P(address), Z_STR_P(corpus), Z_STR_P(token), out)) return false;
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pragmas), pair) {
        zval *name = zend_hash_index_find(Z_ARRVAL_P(pair), 0), *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
        zval message, params, answer;
        array_init(&message);
        add_assoc_string(&message, "op", "statement");
        add_assoc_str(&message, "sql", zend_strpprintf(0, "PRAGMA %s = %s", Z_STRVAL_P(name), Z_STRVAL_P(value)));
        array_init(&params);
        add_assoc_zval(&message, "params", &params);
        bool ok = markdown_session_send(out, &message, &answer, NULL);
        zval_ptr_dtor(&message);
        if (!ok) {
            markdown_session_close(out);
            zval_ptr_dtor(out);
            ZVAL_UNDEF(out);
            return false;
        }
        zval_ptr_dtor(&answer);
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* The dial closure of an adapter: opens a session of the DSN that its context holds. */
static ZEND_NAMED_FUNCTION(md_dial_handler)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *dsn = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "dsn", sizeof("dsn") - 1, true, &rv);
    if (dsn == NULL || Z_TYPE_P(dsn) != IS_ARRAY) {
        zend_throw_error(NULL, "invalid markdown dial state");
        RETURN_THROWS();
    }
    if (!md_dial(dsn, return_value)) RETURN_THROWS();
}

static bool md_dial_closure(zval *dsn, zval *out)
{
    zval context;
    object_init(&context);
    zend_update_property(zend_standard_class_def, Z_OBJ(context), "dsn", sizeof("dsn") - 1, dsn);
    context_closure(out, "dial", sizeof("dial") - 1, md_dial_handler, &context);
    zval_ptr_dtor(&context);
    return Z_TYPE_P(out) == IS_OBJECT;
}

/* Opens a new session with the dial closure of the adapter self into out. */
static bool md_redial(zval *self, zval *out)
{
    zval rv, *dial = md_prop(self, "dial", &rv);
    ZVAL_UNDEF(out);
    if (call_user_function(NULL, NULL, dial, out, 0, NULL) != SUCCESS || EG(exception) != NULL) {
        if (!Z_ISUNDEF_P(out)) zval_ptr_dtor(out);
        ZVAL_UNDEF(out);
        return false;
    }
    zend_class_entry *session_ce = zend_lookup_class_ex(zend_string_init_interned("Polyspec\\Orm\\MarkdownSession",
        sizeof("Polyspec\\Orm\\MarkdownSession") - 1, 0), NULL, ZEND_FETCH_CLASS_NO_AUTOLOAD);
    if (Z_TYPE_P(out) != IS_OBJECT || session_ce == NULL || !instanceof_function(Z_OBJCE_P(out), session_ce)) {
        zval_ptr_dtor(out);
        ZVAL_UNDEF(out);
        db_throw_orm("INTERNAL", "the dial of a markdown connection returned no session");
        return false;
    }
    return true;
}

/* The statement adapter whose rows the session of self holds is kept by a WeakReference, so a statement that its caller
 * dropped is not kept alive by its connection: whether the session holds rows, and the statement into out when it is
 * still alive (a new reference), or UNDEF when it is gone. */
static bool md_active(zval *self, zval *out)
{
    ZVAL_UNDEF(out);
    zval rv, *ref = md_prop(self, "active", &rv);
    if (ref == NULL || Z_TYPE_P(ref) != IS_OBJECT) return false;
    zval referent;
    zend_call_method_with_0_params(Z_OBJ_P(ref), zend_ce_weakref, NULL, "get", &referent);
    if (Z_TYPE(referent) == IS_OBJECT) {
        ZVAL_COPY_VALUE(out, &referent);
    } else {
        zval_ptr_dtor(&referent);
    }
    return true;
}

static void md_set_active(zval *self, zval *statement)
{
    zval ref;
    zend_call_method_with_1_params(NULL, zend_ce_weakref, NULL, "create", &ref, statement);
    if (Z_TYPE(ref) == IS_OBJECT) md_set(self, "active", &ref);
    zval_ptr_dtor(&ref);
}

static void md_empty_answer(zval *answer)
{
    array_init(answer);
    zval empty;
    array_init(&empty);
    add_assoc_zval(answer, "columns", &empty);
    array_init(&empty);
    add_assoc_zval(answer, "rows", &empty);
    add_assoc_long(answer, "affected", 0);
    add_assoc_long(answer, "last_insert_id", 0);
    add_assoc_bool(answer, "more", 0);
}

/* Runs sql with params, a list in the wire form (PRT-67), on the session of the adapter self, for statement (an adapter
 * statement, or NULL for a statement whose rows are not read). The rows that another statement has not read yet are read
 * first, since a new statement on the session ends them (PRT-66). */
static bool md_run(zval *self, zend_string *sql, zval *params, zval *statement, zval *answer)
{
    zval held;
    if (md_active(self, &held)) {
        if (Z_TYPE(held) == IS_UNDEF) {
            /* No one can read the rows of a statement that is gone, so the session ends them (PRT-66). */
            md_set_null(self, "active");
            zval session_rv, *current = md_prop(self, "session", &session_rv);
            if (md_session_open(current)) {
                zval ignored;
                if (!md_simple(self, "close", &ignored, NULL)) return false;
                zval_ptr_dtor(&ignored);
            }
        } else if (statement == NULL || Z_OBJ(held) != Z_OBJ_P(statement)) {
            bool drained = md_statement_drain(&held);
            zval_ptr_dtor(&held);
            if (!drained) return false;
        } else {
            zval_ptr_dtor(&held);
        }
    }
    md_set_null(self, "active");
    md_no_error(self);
    bool commit;
    int control = md_control(sql, &commit);
    zval rv, *transaction = md_prop(self, "transaction", &rv);
    bool in_transaction = transaction != NULL && Z_TYPE_P(transaction) == IS_TRUE;
    zval session_rv, *session = md_prop(self, "session", &session_rv);
    if (!md_session_open(session) && !in_transaction) {
        if (control == 2 && !commit) {
            /* The server rolled back the transaction of the session it lost; there is nothing to roll back. */
            md_empty_answer(answer);
            return true;
        }
        if (control != 2) {
            zval fresh;
            if (!md_redial(self, &fresh)) {
                md_driver_error(-1, self, statement);
                return false;
            }
            md_set(self, "session", &fresh);
            zval_ptr_dtor(&fresh);
        }
    }
    zval message;
    markdown_statement_message(&message, sql, params);
    bool ok = md_send(self, &message, answer, statement);
    zval_ptr_dtor(&message);
    if (control == 2) md_set_bool(self, "transaction", false);
    if (!ok) {
        if (commit) {
            /* After a failed COMMIT the state of the session is unknown. */
            zval closed_rv, *current = md_prop(self, "session", &closed_rv);
            markdown_session_close(current);
        }
        return false;
    }
    if (control == 1) md_set_bool(self, "transaction", true);
    zval *last = md_find(answer, "last_insert_id");
    md_set_long(self, "lastInsertIdValue", last == NULL ? 0 : zval_get_long(last));
    zval *more = md_find(answer, "more");
    if (more != NULL && Z_TYPE_P(more) == IS_TRUE) {
        if (statement != NULL) {
            md_set_active(self, statement);
        } else {
            zval ignored;
            if (!md_simple(self, "close", &ignored, NULL)) {
                zval_ptr_dtor(answer);
                ZVAL_UNDEF(answer);
                return false;
            }
            zval_ptr_dtor(&ignored);
        }
    }
    return true;
}

static bool md_holds(zval *self, zval *statement)
{
    zval held;
    if (!md_active(self, &held) || Z_TYPE(held) == IS_UNDEF) return false;
    bool same = Z_OBJ(held) == Z_OBJ_P(statement);
    zval_ptr_dtor(&held);
    return same;
}

/* The next batch of the rows of statement, which the session of self holds. */
static bool md_fetch_rows(zval *self, zval *statement, zval *answer)
{
    if (!md_holds(self, statement)) {
        db_throw_orm("INTERNAL", "the rows of the statement are no longer held by the session");
        return false;
    }
    if (!md_simple(self, "fetch", answer, statement)) {
        md_set_null(self, "active");
        return false;
    }
    zval *more = md_find(answer, "more");
    if (more == NULL || Z_TYPE_P(more) != IS_TRUE) md_set_null(self, "active");
    return true;
}

/* Ends the rows of statement that the session of self still holds. */
static bool md_close_rows(zval *self, zval *statement)
{
    if (!md_holds(self, statement)) return true;
    md_set_null(self, "active");
    zval ignored;
    if (!md_simple(self, "close", &ignored, statement)) return false;
    zval_ptr_dtor(&ignored);
    return true;
}

static void md_adapter_init(zval *self, zval *session, zval *dial)
{
    init_prop(self, "session", session);
    init_prop(self, "dial", dial);
    md_set_bool(self, "transaction", false);
    md_set_long(self, "lastInsertIdValue", 0);
    md_no_error(self);
    md_set_null(self, "active");
}

bool markdown_pdo_connect(zend_string *address, zend_string *corpus, zend_string *token, zval *pragmas, zval *out)
{
    zval dsn, session;
    array_init_size(&dsn, 4);
    add_next_index_str(&dsn, zend_string_copy(address));
    add_next_index_str(&dsn, zend_string_copy(corpus));
    add_next_index_str(&dsn, zend_string_copy(token));
    Z_TRY_ADDREF_P(pragmas);
    add_next_index_zval(&dsn, pragmas);
    if (!md_dial(&dsn, &session)) {
        zval_ptr_dtor(&dsn);
        return false;
    }
    zval dial;
    bool made = md_dial_closure(&dsn, &dial);
    zval_ptr_dtor(&dsn);
    if (!made) {
        markdown_session_close(&session);
        zval_ptr_dtor(&session);
        return false;
    }
    object_init_ex(out, md_adapter_ce);
    md_adapter_init(out, &session, &dial);
    zval_ptr_dtor(&session);
    zval_ptr_dtor(&dial);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(out);
        ZVAL_UNDEF(out);
        return false;
    }
    return true;
}

void markdown_pdo_session(zval *pdo, zval *out)
{
    zval rv, *session = md_prop(pdo, "session", &rv);
    ZVAL_COPY(out, session);
}

void markdown_pdo_register(zend_class_entry *adapter_ce, zend_class_entry *statement_ce)
{
    md_adapter_ce = adapter_ce;
    md_statement_ce = statement_ce;
}

bool markdown_pdo_is_adapter(zval *value)
{
    return value != NULL && Z_TYPE_P(value) == IS_OBJECT && md_adapter_ce != NULL
        && instanceof_function(Z_OBJCE_P(value), md_adapter_ce);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, __construct)
{
    zval *session, *dial;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(session)
        Z_PARAM_OBJECT_OF_CLASS(dial, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    md_adapter_init(ZEND_THIS, session, dial);
}


static void md_run_control(zval *self, const char *sql, zval *return_value)
{
    zend_string *text = zend_string_init(sql, strlen(sql), 0);
    zval params, answer;
    array_init(&params);
    bool ok = md_run(self, text, &params, NULL, &answer);
    zend_string_release(text);
    zval_ptr_dtor(&params);
    if (!ok) RETURN_THROWS();
    zval_ptr_dtor(&answer);
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, beginTransaction)
{
    ZEND_PARSE_PARAMETERS_NONE();
    md_run_control(ZEND_THIS, "BEGIN", return_value);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, commit)
{
    ZEND_PARSE_PARAMETERS_NONE();
    md_run_control(ZEND_THIS, "COMMIT", return_value);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, rollBack)
{
    ZEND_PARSE_PARAMETERS_NONE();
    md_run_control(ZEND_THIS, "ROLLBACK", return_value);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, inTransaction)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *transaction = md_prop(ZEND_THIS, "transaction", &rv);
    RETURN_BOOL(transaction != NULL && Z_TYPE_P(transaction) == IS_TRUE);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, exec)
{
    zend_string *sql;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(sql) ZEND_PARSE_PARAMETERS_END();
    zval params, answer;
    array_init(&params);
    bool ok = md_run(ZEND_THIS, sql, &params, NULL, &answer);
    zval_ptr_dtor(&params);
    if (!ok) RETURN_THROWS();
    zval *affected = md_find(&answer, "affected");
    RETVAL_LONG(affected == NULL ? 0 : zval_get_long(affected));
    zval_ptr_dtor(&answer);
}

static void md_statement_init(zval *statement, zval *pdo, zend_string *sql)
{
    init_prop(statement, "pdo", pdo);
    zval text;
    ZVAL_STR_COPY(&text, sql);
    init_prop(statement, "sourceSql", &text);
    zval_ptr_dtor(&text);
    md_set_empty(statement, "bindings");
    md_set_empty(statement, "columns");
    md_set_empty(statement, "rows");
    md_set_long(statement, "next", 0);
    md_set_bool(statement, "more", false);
    md_set_long(statement, "affected", 0);
    md_set_null(statement, "current");
    md_set_empty(statement, "fetchMode");
    md_no_error(statement);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, prepare)
{
    zend_string *sql;
    zval *options = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2) Z_PARAM_STR(sql) Z_PARAM_OPTIONAL Z_PARAM_ARRAY(options) ZEND_PARSE_PARAMETERS_END();
    (void) options;
    object_init_ex(return_value, md_statement_ce);
    md_statement_init(return_value, ZEND_THIS, sql);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, query)
{
    zend_string *sql;
    zend_long mode = 0;
    bool mode_null = true;
    zval *args = NULL;
    uint32_t argc = 0;
    ZEND_PARSE_PARAMETERS_START(1, -1)
        Z_PARAM_STR(sql) Z_PARAM_OPTIONAL Z_PARAM_LONG_OR_NULL(mode, mode_null) Z_PARAM_VARIADIC('*', args, argc)
    ZEND_PARSE_PARAMETERS_END();
    object_init_ex(return_value, md_statement_ce);
    md_statement_init(return_value, ZEND_THIS, sql);
    if (EG(exception) != NULL) RETURN_THROWS();
    zval ignored;
    ZVAL_UNDEF(&ignored);
    zend_call_method_with_0_params(Z_OBJ_P(return_value), md_statement_ce, NULL, "execute", &ignored);
    zval_ptr_dtor(&ignored);
    if (EG(exception) != NULL) RETURN_THROWS();
    if (!mode_null) md_set_fetch_mode(return_value, mode, args, argc);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, quote)
{
    zend_string *text;
    zend_long type = PDO_PARAM_STR;
    ZEND_PARSE_PARAMETERS_START(1, 2) Z_PARAM_STR(text) Z_PARAM_OPTIONAL Z_PARAM_LONG(type) ZEND_PARSE_PARAMETERS_END();
    (void) type;
    smart_str out = {0};
    smart_str_appendc(&out, '\'');
    for (size_t i = 0; i < ZSTR_LEN(text); i++) {
        if (ZSTR_VAL(text)[i] == '\'') smart_str_appendc(&out, '\'');
        smart_str_appendc(&out, ZSTR_VAL(text)[i]);
    }
    smart_str_appendc(&out, '\'');
    RETURN_STR(smart_str_extract(&out));
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, lastInsertId)
{
    zend_string *name = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_STR_OR_NULL(name) ZEND_PARSE_PARAMETERS_END();
    (void) name;
    zval rv, *last = md_prop(ZEND_THIS, "lastInsertIdValue", &rv);
    RETURN_STR(zend_long_to_str(last == NULL ? 0 : zval_get_long(last)));
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, getAttribute)
{
    zend_long attribute;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(attribute) ZEND_PARSE_PARAMETERS_END();
    switch (attribute) {
        case PDO_ATTR_ERRMODE: RETURN_LONG(PDO_ERRMODE_EXCEPTION);
        case PDO_ATTR_STRINGIFY_FETCHES: RETURN_FALSE;
        case PDO_ATTR_EMULATE_PREPARES: RETURN_FALSE;
        case PDO_ATTR_CASE: RETURN_LONG(PDO_CASE_NATURAL);
        case PDO_ATTR_ORACLE_NULLS: RETURN_LONG(PDO_NULL_NATURAL);
        case PDO_ATTR_DEFAULT_FETCH_MODE: RETURN_LONG(PDO_FETCH_BOTH);
        case PDO_ATTR_DRIVER_NAME: RETURN_STRING("sqlite");
        case PDO_ATTR_SERVER_VERSION: {
            zend_string *sql = zend_string_init("SELECT sqlite_version()", sizeof("SELECT sqlite_version()") - 1, 0);
            zval params, answer;
            array_init(&params);
            bool ok = md_run(ZEND_THIS, sql, &params, NULL, &answer);
            zend_string_release(sql);
            zval_ptr_dtor(&params);
            if (!ok) RETURN_THROWS();
            zval *rows = md_find(&answer, "rows");
            zval *row = rows != NULL && Z_TYPE_P(rows) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(rows), 0) : NULL;
            zval *cell = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 0) : NULL;
            RETVAL_STR(cell == NULL ? ZSTR_EMPTY_ALLOC() : zval_get_string(cell));
            zval_ptr_dtor(&answer);
            return;
        }
        default: RETURN_FALSE;
    }
}

/* The attributes that a SQLite connection sets: exceptions as the error mode, and natural fetches. Any other value of
 * them is refused. */
ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, setAttribute)
{
    zend_long attribute;
    zval *value;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_LONG(attribute) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    switch (attribute) {
        case PDO_ATTR_ERRMODE: RETURN_BOOL(Z_TYPE_P(value) == IS_LONG && Z_LVAL_P(value) == PDO_ERRMODE_EXCEPTION);
        case PDO_ATTR_STRINGIFY_FETCHES:
        case PDO_ATTR_EMULATE_PREPARES: RETURN_BOOL(Z_TYPE_P(value) == IS_FALSE);
        default: RETURN_FALSE;
    }
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, errorCode)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *info = md_prop(ZEND_THIS, "errorInfoValue", &rv);
    zval *state = info != NULL && Z_TYPE_P(info) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(info), 0) : NULL;
    if (state == NULL) RETURN_NULL();
    RETURN_COPY(state);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, errorInfo)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *info = md_prop(ZEND_THIS, "errorInfoValue", &rv);
    RETURN_COPY(info);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, close)
{
    ZEND_PARSE_PARAMETERS_NONE();
    md_set_null(ZEND_THIS, "active");
    zval rv, *session = md_prop(ZEND_THIS, "session", &rv);
    markdown_session_close(session);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, shutdown)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *session = md_prop(ZEND_THIS, "session", &rv);
    markdown_session_shutdown(session);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, abandon)
{
    ZEND_PARSE_PARAMETERS_NONE();
    md_set_null(ZEND_THIS, "active");
    zval rv, *session = md_prop(ZEND_THIS, "session", &rv);
    markdown_session_close(session);
    md_set_bool(ZEND_THIS, "transaction", false);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, run)
{
    zend_string *sql;
    zval *params, *statement = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(sql) Z_PARAM_ARRAY(params)
        Z_PARAM_OPTIONAL Z_PARAM_OBJECT_OF_CLASS_OR_NULL(statement, md_statement_ce)
    ZEND_PARSE_PARAMETERS_END();
    if (!md_run(ZEND_THIS, sql, params, statement, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, fetchRows)
{
    zval *statement;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT_OF_CLASS(statement, md_statement_ce) ZEND_PARSE_PARAMETERS_END();
    if (!md_fetch_rows(ZEND_THIS, statement, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownPdoAdapter, closeRows)
{
    zval *statement;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT_OF_CLASS(statement, md_statement_ce) ZEND_PARSE_PARAMETERS_END();
    if (!md_close_rows(ZEND_THIS, statement)) RETURN_THROWS();
}

/* --- MarkdownStatementAdapter --- */

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, __construct)
{
    zval *pdo;
    zend_string *sql;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_OBJECT_OF_CLASS(pdo, md_adapter_ce) Z_PARAM_STR(sql) ZEND_PARSE_PARAMETERS_END();
    md_statement_init(ZEND_THIS, pdo, sql);
}

/* The slot of a bound parameter: a position from 0, or a name without its colon. */
static void md_slot(zval *param, bool from_one, zval *out)
{
    if (Z_TYPE_P(param) == IS_LONG) {
        ZVAL_LONG(out, from_one ? Z_LVAL_P(param) - 1 : Z_LVAL_P(param));
        return;
    }
    zend_string *name = zval_get_string(param);
    size_t skip = ZSTR_LEN(name) > 0 && ZSTR_VAL(name)[0] == ':' ? 1 : 0;
    ZVAL_STRINGL(out, ZSTR_VAL(name) + skip, ZSTR_LEN(name) - skip);
    zend_string_release(name);
}

static void md_bind(zval *self, zval *slot, zval *value, zend_long type)
{
    zval rv, *bindings = md_prop(self, "bindings", &rv), copy, pair;
    ZVAL_ARR(&copy, zend_array_dup(Z_ARRVAL_P(bindings)));
    array_init_size(&pair, 2);
    Z_TRY_ADDREF_P(value);
    add_next_index_zval(&pair, value);
    add_next_index_long(&pair, type);
    if (Z_TYPE_P(slot) == IS_LONG) zend_hash_index_update(Z_ARRVAL(copy), Z_LVAL_P(slot), &pair);
    else zend_symtable_update(Z_ARRVAL(copy), Z_STR_P(slot), &pair);
    md_set(self, "bindings", &copy);
    zval_ptr_dtor(&copy);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, bindValue)
{
    zval *param, *value;
    zend_long type = PDO_PARAM_STR;
    ZEND_PARSE_PARAMETERS_START(2, 3) Z_PARAM_ZVAL(param) Z_PARAM_ZVAL(value) Z_PARAM_OPTIONAL Z_PARAM_LONG(type) ZEND_PARSE_PARAMETERS_END();
    zval slot;
    md_slot(param, true, &slot);
    md_bind(ZEND_THIS, &slot, value, type);
    zval_ptr_dtor(&slot);
    RETURN_TRUE;
}

/* The statement text with its named placeholders written as `?`, and the slot of each placeholder in order: null for a
 * `?`, whose slot is its position, or the name of a `:name`. */
static zend_string *md_positional(zend_string *source, zval *order)
{
    const char *sql = ZSTR_VAL(source);
    size_t length = ZSTR_LEN(source);
    smart_str out = {0};
    array_init(order);
    for (size_t i = 0; i < length; i++) {
        char c = sql[i];
        if (c == '\'' || c == '"' || c == '`') {
            size_t end = i + 1;
            while (end < length && (sql[end] != c || (end + 1 < length && sql[end + 1] == c))) end += sql[end] == c ? 2 : 1;
            size_t stop = end < length ? end + 1 : length;
            smart_str_appendl(&out, sql + i, stop - i);
            i = stop - 1;
            continue;
        }
        if (c == '-' && i + 1 < length && sql[i + 1] == '-') {
            const char *nl = memchr(sql + i, '\n', length - i);
            size_t end = nl == NULL ? length : (size_t) (nl - sql);
            smart_str_appendl(&out, sql + i, end - i);
            i = end - 1;
            continue;
        }
        if (c == '/' && i + 1 < length && sql[i + 1] == '*') {
            const char *close = php_memnstr(sql + i + 2, "*/", 2, sql + length);
            size_t end = close == NULL ? length : (size_t) (close - sql) + 2;
            smart_str_appendl(&out, sql + i, end - i);
            i = end - 1;
            continue;
        }
        if (c == '?') {
            add_next_index_null(order);
            smart_str_appendc(&out, '?');
            continue;
        }
        if (c == ':' && i + 1 < length && (i == 0 || sql[i - 1] != ':')
            && ((sql[i + 1] >= 'A' && sql[i + 1] <= 'Z') || (sql[i + 1] >= 'a' && sql[i + 1] <= 'z') || sql[i + 1] == '_')) {
            size_t end = i + 1;
            while (end < length && ((sql[end] >= 'A' && sql[end] <= 'Z') || (sql[end] >= 'a' && sql[end] <= 'z')
                || (sql[end] >= '0' && sql[end] <= '9') || sql[end] == '_')) end++;
            add_next_index_stringl(order, sql + i + 1, end - i - 1);
            smart_str_appendc(&out, '?');
            i = end - 1;
            continue;
        }
        smart_str_appendc(&out, c);
    }
    if (out.s == NULL) return ZSTR_EMPTY_ALLOC();
    return smart_str_extract(&out);
}

static void md_tagged(zval *out, const char *tag, const char *bytes, size_t length)
{
    array_init_size(out, 1);
    add_assoc_str(out, tag, php_base64_encode((const unsigned char *) bytes, length));
}

/* A text in the wire form: itself when it is UTF-8, otherwise {"text": base64}. */
static void md_text(zval *out, zend_string *text)
{
    str s = {ZSTR_VAL(text), ZSTR_LEN(text)};
    if (utf8_valid_prefix(s) == ZSTR_LEN(text)) ZVAL_STR_COPY(out, text);
    else md_tagged(out, "text", ZSTR_VAL(text), ZSTR_LEN(text));
}

static bool md_stream_bytes(zval *value, zend_string **out)
{
    php_stream *stream;
    php_stream_from_zval_no_verify(stream, value);
    if (stream == NULL) {
        db_throw_orm("CONFIG", "a blob parameter must be a string or a stream");
        return false;
    }
    *out = php_stream_copy_to_mem(stream, PHP_STREAM_COPY_ALL, 0);
    if (*out == NULL) *out = ZSTR_EMPTY_ALLOC();
    return true;
}

/* The value of a parameter in the form of a statement message (PRT-67). An untyped value keeps its type: null, a boolean
 * as the integer 1 or 0, an integer, a finite float, a text, and {"float": "+Inf"} or {"float": "-Inf"} for an infinity; Bytes and a stream
 * are {"bytes": base64}. A typed value is bound as pdo_sqlite binds it: PARAM_NULL as NULL, PARAM_INT as an integer,
 * PARAM_BOOL as the integer 1 or 0, PARAM_LOB as a blob and PARAM_STR as its text, except that a float keeps its number
 * unless it is bound as PARAM_INT or PARAM_LOB, as an untyped float does. */
static bool md_param(zval *value, zend_long type, zval *out)
{
    ZVAL_DEREF(value);
    if (Z_TYPE_P(value) == IS_NULL || type == PDO_PARAM_NULL) {
        ZVAL_NULL(out);
        return true;
    }
    if (type == PDO_PARAM_LOB || Z_TYPE_P(value) == IS_RESOURCE) {
        zend_string *bytes;
        if (Z_TYPE_P(value) == IS_RESOURCE) {
            if (!md_stream_bytes(value, &bytes)) return false;
        } else if (Z_TYPE_P(value) == IS_STRING) {
            bytes = zend_string_copy(Z_STR_P(value));
        } else {
            db_throw_orm("CONFIG", "a blob parameter must be a string or a stream");
            return false;
        }
        md_tagged(out, "bytes", ZSTR_VAL(bytes), ZSTR_LEN(bytes));
        zend_string_release(bytes);
        return true;
    }
    if (Z_TYPE_P(value) == IS_OBJECT) {
        zend_class_entry *bytes_ce = zend_lookup_class_ex(zend_string_init_interned("Polyspec\\Orm\\Bytes",
            sizeof("Polyspec\\Orm\\Bytes") - 1, 0), NULL, ZEND_FETCH_CLASS_NO_AUTOLOAD);
        if (bytes_ce != NULL && instanceof_function(Z_OBJCE_P(value), bytes_ce)) {
            zval rv, *bytes = zend_read_property(bytes_ce, Z_OBJ_P(value), "bytes", sizeof("bytes") - 1, true, &rv);
            md_tagged(out, "bytes", Z_STRVAL_P(bytes), Z_STRLEN_P(bytes));
            return true;
        }
        if (!Z_OBJCE_P(value)->__tostring) {
            db_throw_orm("CONFIG", "a parameter of type %s has no text", ZSTR_VAL(Z_OBJCE_P(value)->name));
            return false;
        }
        zend_string *text = zval_try_get_string(value);
        if (text == NULL) return false;
        md_text(out, text);
        zend_string_release(text);
        return true;
    }
    if (Z_TYPE_P(value) == IS_ARRAY) {
        db_throw_orm("CONFIG", "a parameter of type array has no text");
        return false;
    }
    if (type == PDO_PARAM_INT) {
        ZVAL_LONG(out, zval_get_long(value));
        return true;
    }
    /* A float that is not bound as an integer or a blob keeps its number (PRT-67). */
    if (Z_TYPE_P(value) == IS_DOUBLE && type != PDO_PARAM_INT && type != PDO_PARAM_LOB) {
        double d = Z_DVAL_P(value);
        if (zend_isnan(d)) {
            db_throw_orm("CONFIG", "a statement parameter of NaN has no JSON form");
            return false;
        }
        if (zend_isinf(d)) {
            array_init_size(out, 1);
            add_assoc_string(out, "float", d > 0 ? "+Inf" : "-Inf");
        } else {
            ZVAL_DOUBLE(out, d);
        }
        return true;
    }
    /* A boolean binds as the integer 1 or 0, as SQLite binds it (PRT-67). */
    if (type == PDO_PARAM_BOOL || Z_TYPE_P(value) == IS_TRUE || Z_TYPE_P(value) == IS_FALSE) {
        ZVAL_LONG(out, zend_is_true(value) ? 1 : 0);
        return true;
    }
    if (type != MD_UNTYPED || Z_TYPE_P(value) == IS_STRING) {
        zend_string *text = zval_get_string(value);
        md_text(out, text);
        zend_string_release(text);
        return true;
    }
    ZVAL_COPY(out, value);
    return true;
}

static void md_statement_reset(zval *self)
{
    md_set_empty(self, "columns");
    md_set_empty(self, "rows");
    md_set_long(self, "next", 0);
    md_set_bool(self, "more", false);
    md_set_long(self, "affected", 0);
    md_set_null(self, "current");
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, execute)
{
    zval *params = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_ARRAY_OR_NULL(params) ZEND_PARSE_PARAMETERS_END();
    if (params != NULL) {
        md_set_empty(ZEND_THIS, "bindings");
        zend_ulong index;
        zend_string *key;
        zval *value;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(params), index, key, value) {
            zval param, slot;
            if (key == NULL) ZVAL_LONG(&param, (zend_long) index); else ZVAL_STR_COPY(&param, key);
            md_slot(&param, false, &slot);
            md_bind(ZEND_THIS, &slot, value, MD_UNTYPED);
            zval_ptr_dtor(&param);
            zval_ptr_dtor(&slot);
        } ZEND_HASH_FOREACH_END();
    }
    zval pdo_rv, *pdo = md_prop(ZEND_THIS, "pdo", &pdo_rv);
    zval source_rv, *source = md_prop(ZEND_THIS, "sourceSql", &source_rv);
    zval order;
    zend_string *sql = md_positional(Z_STR_P(source), &order);
    zval bindings_rv, *bindings = md_prop(ZEND_THIS, "bindings", &bindings_rv);
    zval wire;
    array_init_size(&wire, zend_hash_num_elements(Z_ARRVAL(order)));
    zend_ulong position;
    zval *slot;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL(order), position, slot) {
        zval *bound = Z_TYPE_P(slot) == IS_NULL ? zend_hash_index_find(Z_ARRVAL_P(bindings), position)
            : zend_symtable_find(Z_ARRVAL_P(bindings), Z_STR_P(slot));
        if (bound == NULL) {
            if (Z_TYPE_P(slot) == IS_NULL) db_throw_orm("CONFIG", "parameter %lu of the statement was not bound", (unsigned long) position);
            else db_throw_orm("CONFIG", "parameter %s of the statement was not bound", Z_STRVAL_P(slot));
            break;
        }
        zval param;
        if (!md_param(zend_hash_index_find(Z_ARRVAL_P(bound), 0), zval_get_long(zend_hash_index_find(Z_ARRVAL_P(bound), 1)), &param)) break;
        add_next_index_zval(&wire, &param);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&order);
    if (EG(exception) != NULL) {
        zend_string_release(sql);
        zval_ptr_dtor(&wire);
        RETURN_THROWS();
    }
    md_statement_reset(ZEND_THIS);
    zval answer;
    bool ok = md_run(pdo, sql, &wire, ZEND_THIS, &answer);
    zend_string_release(sql);
    zval_ptr_dtor(&wire);
    if (!ok) RETURN_THROWS();
    md_no_error(ZEND_THIS);
    zval *columns = md_find(&answer, "columns"), *rows = md_find(&answer, "rows");
    zval *more = md_find(&answer, "more"), *affected = md_find(&answer, "affected");
    if (columns != NULL && Z_TYPE_P(columns) == IS_ARRAY) md_set(ZEND_THIS, "columns", columns);
    if (rows != NULL && Z_TYPE_P(rows) == IS_ARRAY) {
        md_set(ZEND_THIS, "rows", rows);
        zval *first = zend_hash_index_find(Z_ARRVAL_P(rows), 0);
        if (first != NULL && Z_TYPE_P(first) == IS_ARRAY) md_set(ZEND_THIS, "current", first);
    }
    md_set_bool(ZEND_THIS, "more", more != NULL && Z_TYPE_P(more) == IS_TRUE);
    md_set_long(ZEND_THIS, "affected", affected == NULL ? 0 : zval_get_long(affected));
    zval_ptr_dtor(&answer);
    RETURN_TRUE;
}

/* Reads every batch of rows that the session still holds, so a new statement on the session can run. */
static bool md_statement_drain(zval *statement)
{
    zval pdo_rv, *pdo = md_prop(statement, "pdo", &pdo_rv);
    while (1) {
        zval more_rv, *more = md_prop(statement, "more", &more_rv);
        if (more == NULL || Z_TYPE_P(more) != IS_TRUE) return true;
        zval answer;
        if (!md_fetch_rows(pdo, statement, &answer)) {
            md_set_bool(statement, "more", false);
            return false;
        }
        zval rows_rv, *rows = md_prop(statement, "rows", &rows_rv), all, *row;
        ZVAL_ARR(&all, zend_array_dup(Z_ARRVAL_P(rows)));
        zval *batch = md_find(&answer, "rows");
        if (batch != NULL && Z_TYPE_P(batch) == IS_ARRAY) {
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(batch), row) {
                Z_TRY_ADDREF_P(row);
                add_next_index_zval(&all, row);
            } ZEND_HASH_FOREACH_END();
        }
        md_set(statement, "rows", &all);
        zval_ptr_dtor(&all);
        zval *next = md_find(&answer, "more");
        md_set_bool(statement, "more", next != NULL && Z_TYPE_P(next) == IS_TRUE);
        zval_ptr_dtor(&answer);
    }
}

/* Whether a column of the declared type has REAL affinity (SQLite's rules of column affinity). */
static bool md_real_affinity(zval *column)
{
    zval *type = md_find(column, "type");
    if (type == NULL || Z_TYPE_P(type) != IS_STRING) return false;
    zend_string *upper = zend_string_toupper(Z_STR_P(type));
    const char *t = ZSTR_VAL(upper);
    bool real = strstr(t, "INT") == NULL && strstr(t, "CHAR") == NULL && strstr(t, "CLOB") == NULL
        && strstr(t, "TEXT") == NULL && strstr(t, "BLOB") == NULL
        && (strstr(t, "REAL") != NULL || strstr(t, "FLOA") != NULL || strstr(t, "DOUB") != NULL);
    zend_string_release(upper);
    return real;
}

static bool md_base64(zval *text, zval *out)
{
    zend_string *bytes = Z_TYPE_P(text) == IS_STRING
        ? php_base64_decode_ex((const unsigned char *) Z_STRVAL_P(text), Z_STRLEN_P(text), true) : NULL;
    if (bytes == NULL) {
        db_throw_orm("INTERNAL", "the cell %s holds no base64 text", Z_TYPE_P(text) == IS_STRING ? Z_STRVAL_P(text) : "");
        return false;
    }
    ZVAL_STR(out, bytes);
    return true;
}

static void md_cell_error(zval *raw)
{
    zval encoded, arg;
    ZVAL_UNDEF(&encoded);
    ZVAL_COPY(&arg, raw);
    bool encoded_ok = scall("json_encode", &encoded, 1, &arg) && Z_TYPE(encoded) == IS_STRING;
    zval_ptr_dtor(&arg);
    if (encoded_ok) db_throw_orm("INTERNAL", "the cell %s is no value", Z_STRVAL(encoded));
    else if (EG(exception) == NULL) db_throw_orm("INTERNAL", "a cell of the answer is no value");
    zval_ptr_dtor(&encoded);
}

/* One value of a row as pdo_sqlite reads it (PRT-69): an integer, a float, a string, a blob as a string, or null. A column
 * of REAL affinity holds a real, which an answer writes as an integer when it has no fraction. */
static bool md_cell(zval *raw, zval *column, zval *out)
{
    switch (Z_TYPE_P(raw)) {
        case IS_NULL: ZVAL_NULL(out); return true;
        case IS_LONG:
            if (md_real_affinity(column)) ZVAL_DOUBLE(out, (double) Z_LVAL_P(raw));
            else ZVAL_LONG(out, Z_LVAL_P(raw));
            return true;
        case IS_DOUBLE:
        case IS_STRING: ZVAL_COPY(out, raw); return true;
        case IS_ARRAY: {
            zval *bytes = md_find(raw, "bytes"), *text = md_find(raw, "text"), *number = md_find(raw, "float");
            if (bytes != NULL) return md_base64(bytes, out);
            if (text != NULL) return md_base64(text, out);
            if (number != NULL && Z_TYPE_P(number) == IS_STRING) {
                if (zend_string_equals_literal(Z_STR_P(number), "+Inf")) { ZVAL_DOUBLE(out, ZEND_INFINITY); return true; }
                if (zend_string_equals_literal(Z_STR_P(number), "-Inf")) { ZVAL_DOUBLE(out, -ZEND_INFINITY); return true; }
            }
            break;
        }
        default: break;
    }
    ZVAL_UNDEF(out);
    md_cell_error(raw);
    return false;
}

/* The next row of self as a list of its values, or false after the last; false on failure with an exception. */
static bool md_next_row(zval *self, zval *values)
{
    ZVAL_FALSE(values);
    while (1) {
        zval rows_rv, *rows = md_prop(self, "rows", &rows_rv);
        zval next_rv, *next = md_prop(self, "next", &next_rv);
        zend_long at = zval_get_long(next);
        if (at < (zend_long) zend_hash_num_elements(Z_ARRVAL_P(rows))) break;
        zval more_rv, *more = md_prop(self, "more", &more_rv);
        if (more == NULL || Z_TYPE_P(more) != IS_TRUE) return true;
        zval pdo_rv, *pdo = md_prop(self, "pdo", &pdo_rv), answer;
        if (!md_fetch_rows(pdo, self, &answer)) {
            md_set_bool(self, "more", false);
            return false;
        }
        zval *batch = md_find(&answer, "rows"), *again = md_find(&answer, "more");
        if (batch != NULL && Z_TYPE_P(batch) == IS_ARRAY) md_set(self, "rows", batch); else md_set_empty(self, "rows");
        md_set_bool(self, "more", again != NULL && Z_TYPE_P(again) == IS_TRUE);
        md_set_long(self, "next", 0);
        zval_ptr_dtor(&answer);
    }
    zval rows_rv, *rows = md_prop(self, "rows", &rows_rv);
    zval next_rv, *next = md_prop(self, "next", &next_rv);
    zend_long at = zval_get_long(next);
    zval *raw = zend_hash_index_find(Z_ARRVAL_P(rows), at);
    md_set_long(self, "next", at + 1);
    if (raw == NULL || Z_TYPE_P(raw) != IS_ARRAY) {
        db_throw_orm("INTERNAL", "a row of the answer is no list");
        return false;
    }
    zval row;
    ZVAL_COPY(&row, raw);
    md_set(self, "current", &row);
    zval columns_rv, *columns = md_prop(self, "columns", &columns_rv);
    array_init_size(values, zend_hash_num_elements(Z_ARRVAL(row)));
    zend_ulong i;
    zval *cell;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL(row), i, cell) {
        zval value;
        if (!md_cell(cell, zend_hash_index_find(Z_ARRVAL_P(columns), i), &value)) {
            zval_ptr_dtor(&row);
            zval_ptr_dtor(values);
            ZVAL_FALSE(values);
            return false;
        }
        add_next_index_zval(values, &value);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&row);
    return true;
}

static zend_long md_mode(zval *self, zend_long mode, zend_long *column)
{
    zval rv, *modes = md_prop(self, "fetchMode", &rv);
    zval *stored = zend_hash_index_find(Z_ARRVAL_P(modes), 0);
    zval *argument = zend_hash_index_find(Z_ARRVAL_P(modes), 1);
    if (mode == PDO_FETCH_USE_DEFAULT) mode = stored == NULL ? PDO_FETCH_BOTH : zval_get_long(stored);
    if (column != NULL && stored != NULL && zval_get_long(stored) == mode && argument != NULL) *column = zval_get_long(argument);
    return mode;
}

/* The row values in the fetch mode mode; column is the column of PDO::FETCH_COLUMN. */
static bool md_shape(zval *self, zval *values, zend_long mode, zend_long column, zval *out)
{
    zval rv, *columns = md_prop(self, "columns", &rv);
    zend_ulong i;
    zval *value;
    switch (mode) {
        case PDO_FETCH_NUM:
            ZVAL_COPY(out, values);
            return true;
        case PDO_FETCH_COLUMN: {
            zval *picked = zend_hash_index_find(Z_ARRVAL_P(values), column);
            if (picked == NULL) ZVAL_FALSE(out); else ZVAL_COPY(out, picked);
            return true;
        }
        case PDO_FETCH_ASSOC:
        case PDO_FETCH_BOTH:
        case PDO_FETCH_OBJ:
            array_init(out);
            ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(values), i, value) {
                zval *name = md_find(zend_hash_index_find(Z_ARRVAL_P(columns), i), "name");
                zend_string *key = name == NULL ? zend_long_to_str((zend_long) i) : zval_get_string(name);
                Z_TRY_ADDREF_P(value);
                zend_symtable_update(Z_ARRVAL_P(out), key, value);
                zend_string_release(key);
                if (mode == PDO_FETCH_BOTH) {
                    Z_TRY_ADDREF_P(value);
                    zend_hash_index_update(Z_ARRVAL_P(out), i, value);
                }
            } ZEND_HASH_FOREACH_END();
            if (mode == PDO_FETCH_OBJ) {
                zval props = *out;
                object_and_properties_init(out, zend_standard_class_def, Z_ARRVAL(props));
            }
            return true;
        default:
            db_throw_orm("INTERNAL", "fetch mode " ZEND_LONG_FMT " is not supported", mode);
            return false;
    }
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, fetch)
{
    zend_long mode = PDO_FETCH_USE_DEFAULT, orientation = 0, offset = 0;
    ZEND_PARSE_PARAMETERS_START(0, 3) Z_PARAM_OPTIONAL Z_PARAM_LONG(mode) Z_PARAM_LONG(orientation) Z_PARAM_LONG(offset) ZEND_PARSE_PARAMETERS_END();
    (void) orientation; (void) offset;
    zend_long column = 0;
    mode = md_mode(ZEND_THIS, mode, &column);
    zval values;
    if (!md_next_row(ZEND_THIS, &values)) RETURN_THROWS();
    if (Z_TYPE(values) == IS_FALSE) RETURN_FALSE;
    bool ok = md_shape(ZEND_THIS, &values, mode, column, return_value);
    zval_ptr_dtor(&values);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, fetchAll)
{
    zend_long mode = PDO_FETCH_USE_DEFAULT;
    zval *args = NULL;
    uint32_t argc = 0;
    ZEND_PARSE_PARAMETERS_START(0, -1) Z_PARAM_OPTIONAL Z_PARAM_LONG(mode) Z_PARAM_VARIADIC('*', args, argc) ZEND_PARSE_PARAMETERS_END();
    zend_long column = 0;
    mode = md_mode(ZEND_THIS, mode, &column);
    if (argc > 0) column = zval_get_long(&args[0]);
    array_init(return_value);
    while (1) {
        zval values;
        if (!md_next_row(ZEND_THIS, &values)) { zval_ptr_dtor(return_value); RETURN_THROWS(); }
        if (Z_TYPE(values) == IS_FALSE) return;
        if (mode == PDO_FETCH_KEY_PAIR) {
            zval *key = zend_hash_index_find(Z_ARRVAL(values), 0), *value = zend_hash_index_find(Z_ARRVAL(values), 1);
            if (key == NULL || value == NULL) {
                zval_ptr_dtor(&values);
                zval_ptr_dtor(return_value);
                db_throw_orm("INTERNAL", "PDO::FETCH_KEY_PAIR reads a result of two columns");
                RETURN_THROWS();
            }
            Z_TRY_ADDREF_P(value);
            array_set_zval_key(Z_ARRVAL_P(return_value), key, value);
            zval_ptr_dtor(value);
            zval_ptr_dtor(&values);
            continue;
        }
        zval row;
        bool ok = md_shape(ZEND_THIS, &values, mode, column, &row);
        zval_ptr_dtor(&values);
        if (!ok) { zval_ptr_dtor(return_value); RETURN_THROWS(); }
        add_next_index_zval(return_value, &row);
    }
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, fetchColumn)
{
    zend_long column = 0;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_LONG(column) ZEND_PARSE_PARAMETERS_END();
    zval values;
    if (!md_next_row(ZEND_THIS, &values)) RETURN_THROWS();
    if (Z_TYPE(values) == IS_FALSE) RETURN_FALSE;
    zval *value = zend_hash_index_find(Z_ARRVAL(values), column);
    if (value == NULL) RETVAL_FALSE; else RETVAL_COPY(value);
    zval_ptr_dtor(&values);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, closeCursor)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *more = md_prop(ZEND_THIS, "more", &rv);
    if (more != NULL && Z_TYPE_P(more) == IS_TRUE) {
        md_set_bool(ZEND_THIS, "more", false);
        zval pdo_rv, *pdo = md_prop(ZEND_THIS, "pdo", &pdo_rv);
        if (!md_close_rows(pdo, ZEND_THIS)) RETURN_THROWS();
    }
    md_set_empty(ZEND_THIS, "rows");
    md_set_long(ZEND_THIS, "next", 0);
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, columnCount)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *columns = md_prop(ZEND_THIS, "columns", &rv);
    RETURN_LONG(zend_hash_num_elements(Z_ARRVAL_P(columns)));
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, rowCount)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *affected = md_prop(ZEND_THIS, "affected", &rv);
    RETURN_LONG(zval_get_long(affected));
}

/* The metadata of a column as pdo_sqlite gives it: the storage class of its value in the current row, whether that value
 * is a blob, and the declared type of the column. */
ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, getColumnMeta)
{
    zend_long index;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(index) ZEND_PARSE_PARAMETERS_END();
    zval rv, *columns = md_prop(ZEND_THIS, "columns", &rv);
    zval *column = index < 0 ? NULL : zend_hash_index_find(Z_ARRVAL_P(columns), index);
    if (column == NULL) RETURN_FALSE;
    zval current_rv, *current = md_prop(ZEND_THIS, "current", &current_rv);
    zval *cell = current != NULL && Z_TYPE_P(current) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(current), index) : NULL;
    const char *kind = "null";
    if (cell == NULL || Z_TYPE_P(cell) == IS_NULL) kind = "null";
    else if (Z_TYPE_P(cell) == IS_ARRAY && md_find(cell, "bytes") != NULL) kind = "blob";
    else if (Z_TYPE_P(cell) == IS_DOUBLE || (Z_TYPE_P(cell) == IS_ARRAY && md_find(cell, "float") != NULL)) kind = "double";
    else if (Z_TYPE_P(cell) == IS_LONG) kind = md_real_affinity(column) ? "double" : "integer";
    else kind = "string";
    array_init(return_value);
    add_assoc_string(return_value, "native_type", strcmp(kind, "blob") == 0 ? "string" : kind);
    add_assoc_long(return_value, "pdo_type", strcmp(kind, "null") == 0 ? PDO_PARAM_NULL
        : strcmp(kind, "integer") == 0 ? PDO_PARAM_INT : PDO_PARAM_STR);
    zval flags;
    array_init(&flags);
    if (strcmp(kind, "blob") == 0) add_next_index_string(&flags, "blob");
    add_assoc_zval(return_value, "flags", &flags);
    zval *name = md_find(column, "name");
    add_assoc_str(return_value, "name", name == NULL ? ZSTR_EMPTY_ALLOC() : zval_get_string(name));
    add_assoc_long(return_value, "len", -1);
    add_assoc_long(return_value, "precision", 0);
    zval *type = md_find(column, "type");
    if (type != NULL && Z_TYPE_P(type) == IS_STRING && Z_STRLEN_P(type) > 0) {
        add_assoc_str(return_value, "sqlite:decl_type", zend_string_copy(Z_STR_P(type)));
    }
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, setFetchMode)
{
    zend_long mode;
    zval *args = NULL;
    uint32_t argc = 0;
    ZEND_PARSE_PARAMETERS_START(1, -1) Z_PARAM_LONG(mode) Z_PARAM_VARIADIC('*', args, argc) ZEND_PARSE_PARAMETERS_END();
    md_set_fetch_mode(ZEND_THIS, mode, args, argc);
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, errorCode)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *info = md_prop(ZEND_THIS, "errorInfoValue", &rv);
    zval *state = zend_hash_index_find(Z_ARRVAL_P(info), 0);
    if (state == NULL) RETURN_NULL();
    RETURN_COPY(state);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, errorInfo)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *info = md_prop(ZEND_THIS, "errorInfoValue", &rv);
    RETURN_COPY(info);
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, drain)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!md_statement_drain(ZEND_THIS)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_MarkdownStatementAdapter, nextRowset)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_FALSE;
}
