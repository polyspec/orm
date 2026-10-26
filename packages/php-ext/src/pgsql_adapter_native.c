/* Native PDO-compatible PostgreSQL adapter backed by one public ext-pgsql connection. */
#include "php.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "ext/pdo/php_pdo.h"
#include "ext/pdo/php_pdo_driver.h"
#include "main/php_memory_streams.h"
#include "dbspec.h"
#include "object_method_lookup.h"
#include "pgsql_adapter_native.h"
#include "pgsql_lob_native.h"
#include "pgsql_statement_iterator_native.h"
#include <string.h>

static zend_class_entry *pgsql_adapter_ce;
static zend_class_entry *pgsql_statement_ce;

static bool pg_call_function(const char *name, zval *result, uint32_t count, zval *args)
{
    zval callable;
    ZVAL_STRING(&callable, name);
    ZVAL_UNDEF(result);
    zend_result status = call_user_function(EG(function_table), NULL, &callable, result, count, args);
    zval_ptr_dtor(&callable);
    return status == SUCCESS && EG(exception) == NULL;
}

static bool pg_call_method(zval *object, const char *name, zval *result, uint32_t count, zval *args)
{
    return object_callable_call(Z_OBJ_P(object), name, result, count, args);
}

static zval *pg_prop(zval *object, const char *name, zval *rv)
{
    return zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), true, rv);
}

static void pg_set(zval *object, const char *name, zval *value)
{
    zend_update_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), value);
}

static void pg_raise(const char *message)
{
    zend_string *name = zend_string_init("PDOException", sizeof("PDOException") - 1, 0);
    zend_class_entry *exception = zend_lookup_class(name);
    zend_string_release(name);
    if (exception == NULL) exception = zend_ce_exception;
    zend_throw_exception(exception, message, 0);
}

static bool pg_constant_long(const char *name, zend_long *out)
{
    const char *separator = strstr(name, "::");
    zval *value;
    if (separator != NULL) {
        zend_string *class_name = zend_string_init(name, separator - name, 0);
        zend_string *constant_name = zend_string_init(separator + 2, strlen(separator + 2), 0);
        value = zend_get_class_constant_ex(class_name, constant_name, NULL, ZEND_FETCH_CLASS_NO_AUTOLOAD);
        zend_string_release(class_name);
        zend_string_release(constant_name);
    } else {
        value = zend_get_constant_str(name, strlen(name));
    }
    if (value == NULL || Z_TYPE_P(value) != IS_LONG) return false;
    *out = Z_LVAL_P(value);
    return true;
}

static zend_string *pg_conninfo_quote(zend_string *value)
{
    smart_str out = {0};
    smart_str_appendc(&out, '\'');
    for (size_t i = 0; i < ZSTR_LEN(value); i++) {
        char c = ZSTR_VAL(value)[i];
        if (c == '\\' || c == '\'') smart_str_appendc(&out, '\\');
        smart_str_appendc(&out, c);
    }
    smart_str_appendc(&out, '\'');
    smart_str_0(&out);
    return out.s;
}

static bool pg_conninfo_append(smart_str *out, zend_string *key, zend_string *value)
{
    zend_string *quoted = pg_conninfo_quote(value);
    if (quoted == NULL) return false;
    if (out->s != NULL) smart_str_appendc(out, ' ');
    smart_str_append(out, key);
    smart_str_appendc(out, '=');
    smart_str_append(out, quoted);
    zend_string_release(quoted);
    return true;
}

static zend_string *pg_dsn_conninfo(zend_string *dsn, zval *username, zval *password, zval *options)
{
    const char *text = ZSTR_VAL(dsn);
    size_t length = ZSTR_LEN(dsn);
    size_t start = length >= 6 && memcmp(text, "pgsql:", 6) == 0 ? 6 : 0;
    zval fields;
    array_init(&fields);
    while (start < length) {
        size_t end = start;
        while (end < length && text[end] != ';') end++;
        size_t equal = start;
        while (equal < end && text[equal] != '=') equal++;
        if (equal > start && equal < end) {
            zend_string *key = zend_string_init(text + start, equal - start, 0);
            zend_string *value = zend_string_init(text + equal + 1, end - equal - 1, 0);
            if (ZSTR_LEN(value) >= 2 && ((ZSTR_VAL(value)[0] == '\'' && ZSTR_VAL(value)[ZSTR_LEN(value) - 1] == '\'')
                || (ZSTR_VAL(value)[0] == '"' && ZSTR_VAL(value)[ZSTR_LEN(value) - 1] == '"'))) {
                zend_string *trimmed = zend_string_init(ZSTR_VAL(value) + 1, ZSTR_LEN(value) - 2, 0);
                zend_string_release(value);
                value = trimmed;
            }
            zval field;
            ZVAL_STR(&field, value);
            zend_hash_update(Z_ARRVAL(fields), key, &field);
            zend_string_release(key);
        }
        start = end + 1;
    }
    if (username != NULL && Z_TYPE_P(username) != IS_NULL) {
        zval copy;
        ZVAL_STR(&copy, zval_get_string(username));
        zend_hash_str_update(Z_ARRVAL(fields), "user", sizeof("user") - 1, &copy);
    }
    if (password != NULL && Z_TYPE_P(password) != IS_NULL) {
        zval copy;
        ZVAL_STR(&copy, zval_get_string(password));
        zend_hash_str_update(Z_ARRVAL(fields), "password", sizeof("password") - 1, &copy);
    }
    if (options != NULL && Z_TYPE_P(options) == IS_ARRAY) {
        zend_string *key;
        zval *value;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(options), key, value) {
            if (key == NULL || Z_TYPE_P(value) == IS_NULL) continue;
            zval copy;
            ZVAL_STR(&copy, zval_get_string(value));
            zend_hash_update(Z_ARRVAL(fields), key, &copy);
        } ZEND_HASH_FOREACH_END();
    }
    smart_str out = {0};
    zend_string *key;
    zval *value;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(fields), key, value) {
        if (key == NULL || Z_TYPE_P(value) != IS_STRING || !pg_conninfo_append(&out, key, Z_STR_P(value))) {
            smart_str_free(&out);
            zval_ptr_dtor(&fields);
            return NULL;
        }
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&out);
    zval_ptr_dtor(&fields);
    return out.s == NULL ? ZSTR_EMPTY_ALLOC() : out.s;
}

static bool pg_get_connection(zval *object, zval *connection)
{
    zval rv;
    zval *value = pg_prop(object, "connection", &rv);
    if (value == NULL || Z_TYPE_P(value) != IS_OBJECT) {
        pg_raise("PostgreSQL connection is not open");
        return false;
    }
    ZVAL_COPY(connection, value);
    return true;
}

static void pg_set_error(zval *object, zend_string *state, zend_string *message)
{
    zval info;
    array_init_size(&info, 3);
    add_next_index_str(&info, zend_string_copy(state));
    add_next_index_null(&info);
    add_next_index_str(&info, zend_string_copy(message));
    pg_set(object, "errorInfoValue", &info);
    zval_ptr_dtor(&info);
    zval code;
    ZVAL_LONG(&code, 0);
    pg_set(object, "errorCodeValue", &code);
}

/*
 * Throws the PDOException of a failed statement: it carries the errorInfo that pg_set_error gives the connection, as a
 * PDO driver error does, so the error catalog reads the SQLSTATE from it (OrmException::fromDriver).
 */
static void pg_raise_statement(zval *object, zend_string *state, zend_string *message)
{
    pg_set_error(object, state, message);
    pg_raise(ZSTR_VAL(message));
    if (EG(exception) == NULL) return;
    zval info;
    array_init_size(&info, 3);
    add_next_index_str(&info, zend_string_copy(state));
    add_next_index_null(&info);
    add_next_index_str(&info, zend_string_copy(message));
    zend_update_property(EG(exception)->ce, EG(exception), "errorInfo", sizeof("errorInfo") - 1, &info);
    zval_ptr_dtor(&info);
}

static void pg_clear_error(zval *object)
{
    zval info, code;
    array_init_size(&info, 3);
    add_next_index_string(&info, "00000");
    add_next_index_null(&info);
    add_next_index_null(&info);
    ZVAL_LONG(&code, 0);
    pg_set(object, "errorInfoValue", &info);
    pg_set(object, "errorCodeValue", &code);
    zval_ptr_dtor(&info);
}

static zend_long pg_value_long(const char *name, zend_long fallback)
{
    zend_long value;
    return pg_constant_long(name, &value) ? value : fallback;
}

static bool pg_statement_key(zval *value, zval *key)
{
    if (Z_TYPE_P(value) == IS_LONG) { ZVAL_LONG(key, Z_LVAL_P(value) - 1); return true; }
    zend_string *name = zval_get_string(value);
    if (EG(exception) != NULL) { zend_string_release(name); return false; }
    const char *text = ZSTR_VAL(name);
    size_t length = ZSTR_LEN(name);
    if (length > 0 && text[0] == ':') { text++; length--; }
    ZVAL_STR(key, zend_string_init(text, length, 0));
    zend_string_release(name);
    return true;
}

static zval *pg_array_find_key(HashTable *array, zval *key)
{
    return Z_TYPE_P(key) == IS_LONG ? zend_hash_index_find(array, Z_LVAL_P(key))
        : Z_TYPE_P(key) == IS_STRING ? zend_hash_find(array, Z_STR_P(key)) : NULL;
}

static void pg_array_update_key(HashTable *array, zval *key, zval *value)
{
    if (Z_TYPE_P(key) == IS_LONG) zend_hash_index_update(array, Z_LVAL_P(key), value);
    else zend_hash_update(array, Z_STR_P(key), value);
}

static bool pg_statement_sql(zend_string *source, zend_string **sql, zval *order)
{
    smart_str out = {0};
    array_init(order);
    const char *text = ZSTR_VAL(source);
    size_t length = ZSTR_LEN(source);
    enum { SQL_NORMAL, SQL_SINGLE, SQL_DOUBLE, SQL_LINE, SQL_BLOCK } state = SQL_NORMAL;
    for (size_t i = 0; i < length; i++) {
        char c = text[i], next = i + 1 < length ? text[i + 1] : '\0';
        if (state == SQL_SINGLE || state == SQL_DOUBLE) {
            smart_str_appendc(&out, c);
            char quote = state == SQL_SINGLE ? '\'' : '"';
            if (c == quote && next == quote) { smart_str_appendc(&out, next); i++; }
            else if (c == quote) state = SQL_NORMAL;
        } else if (state == SQL_LINE) {
            smart_str_appendc(&out, c);
            if (c == '\n') state = SQL_NORMAL;
        } else if (state == SQL_BLOCK) {
            smart_str_appendc(&out, c);
            if (c == '*' && next == '/') { smart_str_appendc(&out, '/'); i++; state = SQL_NORMAL; }
        } else if (c == '\'') { state = SQL_SINGLE; smart_str_appendc(&out, c); }
        else if (c == '"') { state = SQL_DOUBLE; smart_str_appendc(&out, c); }
        else if (c == '-' && next == '-') { state = SQL_LINE; smart_str_appends(&out, "--"); i++; }
        else if (c == '/' && next == '*') { state = SQL_BLOCK; smart_str_appends(&out, "/*"); i++; }
        else if (c == '?') {
            zval slot; ZVAL_LONG(&slot, zend_hash_num_elements(Z_ARRVAL_P(order))); add_next_index_zval(order, &slot);
            smart_str_appendc(&out, '$');
            smart_str_append_long(&out, zend_hash_num_elements(Z_ARRVAL_P(order)));
        } else if (c == ':' && next != ':' && (i == 0 || text[i - 1] != ':')
            && ((next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || next == '_')) {
            size_t start = i + 1, end = start + 1;
            while (end < length) {
                char n = text[end];
                if (!((n >= 'A' && n <= 'Z') || (n >= 'a' && n <= 'z') || (n >= '0' && n <= '9') || n == '_')) break;
                end++;
            }
            zval slot; ZVAL_STR(&slot, zend_string_init(text + start, end - start, 0)); add_next_index_zval(order, &slot);
            smart_str_appendc(&out, '$'); smart_str_append_long(&out, zend_hash_num_elements(Z_ARRVAL_P(order))); i = end - 1;
        } else smart_str_appendc(&out, c);
    }
    smart_str_0(&out);
    if (out.s == NULL) out.s = ZSTR_EMPTY_ALLOC();
    *sql = out.s;
    return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, __construct)
{
    zend_string *dsn;
    zval *username = NULL, *password = NULL, *options = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 4)
        Z_PARAM_STR(dsn)
        Z_PARAM_OPTIONAL
        Z_PARAM_ZVAL(username)
        Z_PARAM_ZVAL(password)
        Z_PARAM_ARRAY(options)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *conninfo = pg_dsn_conninfo(dsn, username, password, options);
    if (conninfo == NULL) RETURN_THROWS();
    zval args[2], connection;
    ZVAL_STR_COPY(&args[0], conninfo);
    zend_long force_new = 0;
    if (!pg_constant_long("PGSQL_CONNECT_FORCE_NEW", &force_new)) force_new = 2;
    ZVAL_LONG(&args[1], force_new);
    zend_string_release(conninfo);
    if (!pg_call_function("pg_connect", &connection, 2, args)) {
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&args[1]);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (Z_TYPE(connection) != IS_OBJECT) {
        zval_ptr_dtor(&connection);
        pg_raise("cannot connect to PostgreSQL");
        RETURN_THROWS();
    }
    pg_set(ZEND_THIS, "connection", &connection);
    zval_ptr_dtor(&connection);
    zval code, mode, stringify, transaction, affected, last_id, active, notice, info;
    ZVAL_LONG(&code, 0);
    ZVAL_LONG(&mode, 2);
    ZVAL_FALSE(&stringify);
    ZVAL_FALSE(&transaction);
    ZVAL_LONG(&affected, 0);
    ZVAL_FALSE(&last_id);
    ZVAL_NULL(&active);
    ZVAL_NULL(&notice);
    array_init_size(&info, 3);
    add_next_index_string(&info, "00000"); add_next_index_null(&info); add_next_index_null(&info);
    pg_set(ZEND_THIS, "errorCodeValue", &code);
    pg_set(ZEND_THIS, "errorInfoValue", &info);
    pg_set(ZEND_THIS, "errmode", &mode);
    pg_set(ZEND_THIS, "stringifyFetches", &stringify);
    pg_set(ZEND_THIS, "transaction", &transaction);
    pg_set(ZEND_THIS, "affectedRows", &affected);
    pg_set(ZEND_THIS, "lastInsertIdValue", &last_id);
    pg_set(ZEND_THIS, "activeStatement", &active);
    pg_set(ZEND_THIS, "noticeCallback", &notice);
    zval_ptr_dtor(&info);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, connect)
{
    zend_string *dsn;
    zval *username = NULL, *password = NULL, *options = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 4)
        Z_PARAM_STR(dsn)
        Z_PARAM_OPTIONAL
        Z_PARAM_ZVAL(username)
        Z_PARAM_ZVAL(password)
        Z_PARAM_ARRAY(options)
    ZEND_PARSE_PARAMETERS_END();
    object_init_ex(return_value, pgsql_adapter_ce);
    zval args[4], ignored;
    ZVAL_STR_COPY(&args[0], dsn);
    if (username == NULL) ZVAL_NULL(&args[1]); else ZVAL_COPY(&args[1], username);
    if (password == NULL) ZVAL_NULL(&args[2]); else ZVAL_COPY(&args[2], password);
    if (options == NULL) array_init(&args[3]); else ZVAL_COPY(&args[3], options);
    if (!pg_call_method(return_value, "__construct", &ignored, 4, args)) ZVAL_UNDEF(return_value);
    else zval_ptr_dtor(&ignored);
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, connectDsn)
{
    zend_string *dsn;
    zval *username, *password;
    zend_long timeout;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_STR(dsn)
        Z_PARAM_ZVAL(username)
        Z_PARAM_ZVAL(password)
        Z_PARAM_LONG(timeout)
    ZEND_PARSE_PARAMETERS_END();
    zval options, option;
    array_init(&options);
    smart_str value = {0};
    smart_str_appends(&value, "-c TimeZone=UTC");
    if (timeout > 0) { smart_str_appends(&value, " -c statement_timeout="); smart_str_append_long(&value, timeout); }
    smart_str_0(&value);
    ZVAL_STR(&option, value.s);
    zend_hash_str_update(Z_ARRVAL(options), "options", sizeof("options") - 1, &option);
    object_init_ex(return_value, pgsql_adapter_ce);
    zval args[4], ignored;
    ZVAL_STR_COPY(&args[0], dsn); ZVAL_COPY(&args[1], username); ZVAL_COPY(&args[2], password); ZVAL_COPY(&args[3], &options);
    if (!pg_call_method(return_value, "__construct", &ignored, 4, args)) ZVAL_UNDEF(return_value);
    else zval_ptr_dtor(&ignored);
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    zval_ptr_dtor(&options);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, cancelActive)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval connection, result;
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    if (!pg_call_function("pg_cancel_query", &result, 1, &connection)) { zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&connection);
    RETURN_ZVAL(&result, 1, 1);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, errorCode)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv;
    zval *info = pg_prop(ZEND_THIS, "errorInfoValue", &rv);
    zval *code = info != NULL && Z_TYPE_P(info) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(info), 0) : NULL;
    if (code == NULL) RETURN_NULL();
    RETURN_COPY(code);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, errorInfo)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv;
    zval *info = pg_prop(ZEND_THIS, "errorInfoValue", &rv);
    if (info == NULL) RETURN_EMPTY_ARRAY();
    RETURN_COPY(info);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, reportError)
{
    zval *error;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(error)
    ZEND_PARSE_PARAMETERS_END();
    zval mode_rv;
    zval *mode = pg_prop(ZEND_THIS, "errmode", &mode_rv);
    zend_long current = mode == NULL ? 0 : zval_get_long(mode);
    zend_long warning = pg_value_long("PDO::ERRMODE_WARNING", 1);
    zend_long exception = pg_value_long("PDO::ERRMODE_EXCEPTION", 2);
    if (current == warning) {
        zval message;
        if (!pg_call_method(error, "getMessage", &message, 0, NULL)) RETURN_THROWS();
        zend_string *text = zval_get_string(&message);
        zval_ptr_dtor(&message);
        php_error_docref(NULL, E_USER_WARNING, "%s", ZSTR_VAL(text));
        zend_string_release(text);
        if (EG(exception) != NULL) RETURN_THROWS();
    } else if (current == exception) {
        zval copy;
        ZVAL_COPY(&copy, error);
        zend_throw_exception_object(&copy);
        RETURN_THROWS();
    }
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, getPid)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval connection, result;
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    if (!pg_call_function("pg_get_pid", &result, 1, &connection)) { zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&connection);
    RETURN_ZVAL(&result, 1, 1);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, escapeIdentifier)
{
    zend_string *input;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(input) ZEND_PARSE_PARAMETERS_END();
    zval connection, args[2];
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    ZVAL_COPY(&args[0], &connection); ZVAL_STR_COPY(&args[1], input);
    zval_ptr_dtor(&connection);
    if (!pg_call_function("pg_escape_identifier", return_value, 2, args)) ZVAL_UNDEF(return_value);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, beginTransaction)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval sql, result, active;
    ZVAL_STRING(&sql, "BEGIN");
    if (!pg_call_method(ZEND_THIS, "exec", &result, 1, &sql)) { zval_ptr_dtor(&sql); RETURN_THROWS(); }
    zval_ptr_dtor(&sql); zval_ptr_dtor(&result);
    ZVAL_TRUE(&active); pg_set(ZEND_THIS, "transaction", &active);
    RETURN_TRUE;
}

/* Runs the statement that ends the transaction of the adapter self, COMMIT or ROLLBACK, and marks it ended. */
static bool pg_end_transaction(zval *self, const char *statement)
{
    zval sql, result, inactive;
    ZVAL_STRING(&sql, statement);
    bool ran = pg_call_method(self, "exec", &result, 1, &sql);
    zval_ptr_dtor(&sql);
    if (!ran) return false;
    zval_ptr_dtor(&result);
    ZVAL_FALSE(&inactive);
    pg_set(self, "transaction", &inactive);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, commit)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!pg_end_transaction(ZEND_THIS, "COMMIT")) RETURN_THROWS();
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, rollBack)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!pg_end_transaction(ZEND_THIS, "ROLLBACK")) RETURN_THROWS();
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, inTransaction)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *active = pg_prop(ZEND_THIS, "transaction", &rv);
    if (active != NULL && zend_is_true(active)) RETURN_TRUE;
    zval connection, result;
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    if (!pg_call_function("pg_transaction_status", &result, 1, &connection)) { zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&connection);
    zend_long idle = 0;
    pg_constant_long("PGSQL_TRANSACTION_IDLE", &idle);
    bool in_transaction = Z_TYPE(result) == IS_LONG && Z_LVAL(result) != idle;
    zval_ptr_dtor(&result);
    RETURN_BOOL(in_transaction);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, setAttribute)
{
    zend_long attribute;
    zval *value;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_LONG(attribute) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    zend_long attr = 0;
    if (pg_constant_long("PDO::ATTR_ERRMODE", &attr) && attribute == attr) { zval copy; ZVAL_COPY(&copy, value); pg_set(ZEND_THIS, "errmode", &copy); zval_ptr_dtor(&copy); RETURN_TRUE; }
    if (pg_constant_long("PDO::ATTR_STRINGIFY_FETCHES", &attr) && attribute == attr) { zval copy; ZVAL_BOOL(&copy, zend_is_true(value)); pg_set(ZEND_THIS, "stringifyFetches", &copy); RETURN_TRUE; }
    if (pg_constant_long("Pdo\\Pgsql::ATTR_DISABLE_PREPARES", &attr) && attribute == attr) RETURN_TRUE;
    if (pg_constant_long("PDO::ATTR_EMULATE_PREPARES", &attr) && attribute == attr) RETURN_BOOL(!zend_is_true(value));
    pg_raise("unsupported PDO attribute");
    RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, getAttribute)
{
    zend_long attribute, attr;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(attribute) ZEND_PARSE_PARAMETERS_END();
    if (pg_constant_long("PDO::ATTR_ERRMODE", &attr) && attribute == attr) {
        zval rv; RETURN_COPY(pg_prop(ZEND_THIS, "errmode", &rv));
    }
    if (pg_constant_long("PDO::ATTR_STRINGIFY_FETCHES", &attr) && attribute == attr) {
        zval rv; RETURN_COPY(pg_prop(ZEND_THIS, "stringifyFetches", &rv));
    }
    if (pg_constant_long("PDO::ATTR_EMULATE_PREPARES", &attr) && attribute == attr) RETURN_FALSE;
    if (pg_constant_long("PDO::ATTR_DRIVER_NAME", &attr) && attribute == attr) RETURN_STRING("pgsql");
    if (pg_constant_long("Pdo\\Pgsql::ATTR_DISABLE_PREPARES", &attr) && attribute == attr) RETURN_TRUE;
    if (pg_constant_long("PDO::ATTR_SERVER_VERSION", &attr) && attribute == attr) {
        zval connection, version;
        if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
        if (!pg_call_function("pg_version", &version, 1, &connection)) { zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&connection);
        zval *server = Z_TYPE(version) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(version), "server", sizeof("server") - 1) : NULL;
        if (server == NULL) { zval_ptr_dtor(&version); RETURN_EMPTY_STRING(); }
        RETVAL_STR(zval_get_string(server)); zval_ptr_dtor(&version); return;
    }
    if (pg_constant_long("PDO::ATTR_CONNECTION_STATUS", &attr) && attribute == attr) {
        zval connection, status;
        if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
        if (!pg_call_function("pg_connection_status", &status, 1, &connection)) { zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&connection);
        zend_long ok = 0; pg_constant_long("PGSQL_CONNECTION_OK", &ok);
        bool connected = Z_TYPE(status) == IS_LONG && Z_LVAL(status) == ok; zval_ptr_dtor(&status);
        RETURN_STRING(connected ? "PostgreSQL connection OK" : "PostgreSQL connection bad");
    }
    pg_raise("unsupported PDO attribute");
    RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, quote)
{
    zend_string *input; zend_long type = 2;
    ZEND_PARSE_PARAMETERS_START(1, 2) Z_PARAM_STR(input) Z_PARAM_OPTIONAL Z_PARAM_LONG(type) ZEND_PARSE_PARAMETERS_END();
    zend_long lob = 3;
    if (pg_constant_long("PDO::PARAM_LOB", &lob) && type == lob) {
        zend_string *hex = zend_string_alloc(ZSTR_LEN(input) * 2, 0);
        static const char digits[] = "0123456789abcdef";
        for (size_t i = 0; i < ZSTR_LEN(input); i++) {
            unsigned char c = (unsigned char)ZSTR_VAL(input)[i];
            ZSTR_VAL(hex)[2 * i] = digits[c >> 4]; ZSTR_VAL(hex)[2 * i + 1] = digits[c & 15];
        }
        ZSTR_VAL(hex)[ZSTR_LEN(hex)] = '\0';
        RETVAL_STR(strpprintf(0, "'\\\\x%s'", ZSTR_VAL(hex))); zend_string_release(hex); return;
    }
    zval connection, args[2];
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    ZVAL_COPY(&args[0], &connection); ZVAL_STR_COPY(&args[1], input); zval_ptr_dtor(&connection);
    if (!pg_call_function("pg_escape_literal", return_value, 2, args)) ZVAL_UNDEF(return_value);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
}

/* The first column of the one row that the statement query of the adapter self returns with the values executed;
 * return_value is undefined when a step fails. */
static void pg_single_value(zval *self, const char *query, zval *executed, zval *return_value)
{
    zval sql, statement, value;
    ZVAL_UNDEF(return_value);
    ZVAL_STRING(&sql, query);
    bool prepared = pg_call_method(self, "prepare", &statement, 1, &sql);
    zval_ptr_dtor(&sql);
    if (!prepared) return;
    if (pg_call_method(&statement, "execute", &value, 1, executed)) {
        zval_ptr_dtor(&value);
        if (pg_call_method(&statement, "fetchColumn", &value, 0, NULL)) ZVAL_COPY_VALUE(return_value, &value);
    }
    zval_ptr_dtor(&statement);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, lastInsertId)
{
    zend_string *name = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_STR_OR_NULL(name) ZEND_PARSE_PARAMETERS_END();
    zval executed;
    array_init(&executed);
    if (name != NULL) add_next_index_str(&executed, zend_string_copy(name));
    pg_single_value(ZEND_THIS, name == NULL ? "SELECT lastval()::text" : "SELECT currval(?)::text", &executed, return_value);
    zval_ptr_dtor(&executed);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, setNoticeCallback)
{
    zval *callback;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(callback) ZEND_PARSE_PARAMETERS_END();
    zval stored;
    if (Z_TYPE_P(callback) == IS_NULL) ZVAL_NULL(&stored); else ZVAL_COPY(&stored, callback);
    pg_set(ZEND_THIS, "noticeCallback", &stored); zval_ptr_dtor(&stored);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, markActive)
{
    zval *statement;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT_OF_CLASS(statement, pgsql_statement_ce) ZEND_PARSE_PARAMETERS_END();
    pg_set(ZEND_THIS, "activeStatement", statement);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, finish)
{
    zval *statement; ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT_OF_CLASS(statement, pgsql_statement_ce) ZEND_PARSE_PARAMETERS_END();
    zval rv; zval *active = pg_prop(ZEND_THIS, "activeStatement", &rv);
    if (active != NULL && Z_TYPE_P(active) == IS_OBJECT && Z_OBJ_P(active) == Z_OBJ_P(statement)) { zval null_value; ZVAL_NULL(&null_value); pg_set(ZEND_THIS, "activeStatement", &null_value); }
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, stringifyFetches)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval rv; zval *value = pg_prop(ZEND_THIS, "stringifyFetches", &rv); RETURN_BOOL(value != NULL && zend_is_true(value));
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, noticeCallback)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval rv; zval *value = pg_prop(ZEND_THIS, "noticeCallback", &rv); if (value == NULL) RETURN_NULL(); RETURN_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, getNotify)
{
    zend_long mode = 0, timeout = 0;
    ZEND_PARSE_PARAMETERS_START(0, 2) Z_PARAM_OPTIONAL Z_PARAM_LONG(mode) Z_PARAM_LONG(timeout) ZEND_PARSE_PARAMETERS_END();
    zend_long assoc = pg_value_long("PDO::FETCH_ASSOC", 2), num = pg_value_long("PDO::FETCH_NUM", 3), both = pg_value_long("PDO::FETCH_BOTH", 4), def = pg_value_long("PDO::FETCH_DEFAULT", 0);
    zend_long pg_mode;
    if (mode == def || mode == assoc) pg_mode = pg_value_long("PGSQL_ASSOC", 1);
    else if (mode == num) pg_mode = pg_value_long("PGSQL_NUM", 2);
    else if (mode == both) pg_mode = pg_value_long("PGSQL_BOTH", 3);
    else { pg_raise("unsupported notification fetch mode"); RETURN_THROWS(); }
    zval connection;
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    zval status_arg, status;
    ZVAL_COPY(&status_arg, &connection);
    if (!pg_call_function("pg_connection_status", &status, 1, &status_arg)) {
        zval_ptr_dtor(&status_arg); zval_ptr_dtor(&connection); RETURN_THROWS();
    }
    zval_ptr_dtor(&status_arg);
    zend_long connection_bad = 1;
    pg_constant_long("PGSQL_CONNECTION_BAD", &connection_bad);
    if (Z_TYPE(status) == IS_LONG && Z_LVAL(status) == connection_bad) {
        zval_ptr_dtor(&status); zval_ptr_dtor(&connection);
        pg_raise("PostgreSQL connection was lost");
        RETURN_THROWS();
    }
    zval_ptr_dtor(&status);
    zval args[2], notification; ZVAL_COPY(&args[0], &connection); ZVAL_LONG(&args[1], pg_mode);
    if (!pg_call_function("pg_get_notify", &notification, 2, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&args[0]);
    if ((Z_TYPE(notification) == IS_FALSE || Z_TYPE(notification) == IS_NULL) && timeout > 0) {
        zval socket_arg, socket; ZVAL_COPY(&socket_arg, &connection);
        if (!pg_call_function("pg_socket", &socket, 1, &socket_arg)) { zval_ptr_dtor(&socket_arg); zval_ptr_dtor(&notification); zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&socket_arg);
        if (Z_TYPE(socket) == IS_RESOURCE) {
            zval read, write, except, seconds, microseconds, selected;
            array_init(&read); zval socket_copy; ZVAL_COPY(&socket_copy, &socket); add_next_index_zval(&read, &socket_copy); ZVAL_MAKE_REF(&read);
            ZVAL_NULL(&write); ZVAL_MAKE_REF(&write); ZVAL_NULL(&except); ZVAL_MAKE_REF(&except);
            ZVAL_LONG(&seconds, timeout / 1000); ZVAL_LONG(&microseconds, (timeout % 1000) * 1000);
            zval select_args[5]; ZVAL_COPY_VALUE(&select_args[0], &read); ZVAL_COPY_VALUE(&select_args[1], &write); ZVAL_COPY_VALUE(&select_args[2], &except); ZVAL_COPY_VALUE(&select_args[3], &seconds); ZVAL_COPY_VALUE(&select_args[4], &microseconds);
            if (!pg_call_function("stream_select", &selected, 5, select_args)) { for (int i = 0; i < 5; i++) zval_ptr_dtor(&select_args[i]); zval_ptr_dtor(&socket); zval_ptr_dtor(&notification); zval_ptr_dtor(&connection); RETURN_THROWS(); }
            bool ready = zval_get_long(&selected) > 0; zval_ptr_dtor(&selected); for (int i = 0; i < 5; i++) zval_ptr_dtor(&select_args[i]);
            if (ready) {
                zval consume_arg, consumed; ZVAL_COPY(&consume_arg, &connection);
                if (!pg_call_function("pg_consume_input", &consumed, 1, &consume_arg)) { zval_ptr_dtor(&consume_arg); zval_ptr_dtor(&socket); zval_ptr_dtor(&notification); zval_ptr_dtor(&connection); RETURN_THROWS(); }
                zval_ptr_dtor(&consume_arg);
                if (!zend_is_true(&consumed)) {
                    zval_ptr_dtor(&consumed); zval_ptr_dtor(&socket); zval_ptr_dtor(&notification); zval_ptr_dtor(&connection);
                    pg_raise("PostgreSQL connection was lost");
                    RETURN_THROWS();
                }
                zval_ptr_dtor(&consumed);
                zval_ptr_dtor(&notification); ZVAL_COPY(&args[0], &connection); ZVAL_LONG(&args[1], pg_mode);
                if (!pg_call_function("pg_get_notify", &notification, 2, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS(); }
                zval_ptr_dtor(&args[0]);
            }
        }
        zval_ptr_dtor(&socket);
    }
    zval_ptr_dtor(&connection); RETURN_ZVAL(&notification, 1, 1);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, prepare)
{
    zend_string *sql; zval *options = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2) Z_PARAM_STR(sql) Z_PARAM_OPTIONAL Z_PARAM_ARRAY(options) ZEND_PARSE_PARAMETERS_END();
    object_init_ex(return_value, pgsql_statement_ce);
    zval args[2], ignored;
    ZVAL_COPY(&args[0], ZEND_THIS); ZVAL_STR_COPY(&args[1], sql);
    if (!pg_call_method(return_value, "__construct", &ignored, 2, args)) ZVAL_UNDEF(return_value);
    else zval_ptr_dtor(&ignored);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, query)
{
    zend_string *sql; zval *mode = NULL; zval *fetch_args = NULL; int fetch_count = 0;
    ZEND_PARSE_PARAMETERS_START(1, -1)
        Z_PARAM_STR(sql)
        Z_PARAM_OPTIONAL
        Z_PARAM_ZVAL(mode)
        Z_PARAM_VARIADIC('*', fetch_args, fetch_count)
    ZEND_PARSE_PARAMETERS_END();
    zval sql_arg, statement;
    ZVAL_STR_COPY(&sql_arg, sql);
    if (!pg_call_method(ZEND_THIS, "prepare", &statement, 1, &sql_arg)) { zval_ptr_dtor(&sql_arg); RETURN_THROWS(); }
    zval_ptr_dtor(&sql_arg);
    zval executed;
    if (!pg_call_method(&statement, "execute", &executed, 0, NULL)) { zval_ptr_dtor(&statement); RETURN_THROWS(); }
    zval_ptr_dtor(&executed);
    if (mode != NULL && Z_TYPE_P(mode) == IS_LONG) {
        zval args[8], result; uint32_t count = fetch_count + 1;
        if (count > 8) { zval_ptr_dtor(&statement); zend_throw_error(NULL, "too many PDO fetch mode arguments"); RETURN_THROWS(); }
        ZVAL_COPY(&args[0], mode);
        for (int i = 0; i < fetch_count; i++) ZVAL_COPY(&args[i + 1], &fetch_args[i]);
        if (!pg_call_method(&statement, "setFetchMode", &result, count, args)) {
            for (uint32_t i = 0; i < count; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&statement); RETURN_THROWS();
        }
        zval_ptr_dtor(&result); for (uint32_t i = 0; i < count; i++) zval_ptr_dtor(&args[i]);
    }
    RETURN_ZVAL(&statement, 1, 1);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, exec)
{
    zend_string *sql;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(sql) ZEND_PARSE_PARAMETERS_END();
    zval args[3], result, affected;
    ZVAL_STR_COPY(&args[0], sql); array_init(&args[1]); ZVAL_TRUE(&args[2]);
    if (!pg_call_method(ZEND_THIS, "executeSql", &result, 3, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); RETURN_THROWS(); }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    ZVAL_COPY(&args[0], &result);
    if (!pg_call_function("pg_affected_rows", &affected, 1, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&result); RETURN_THROWS(); }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&result); RETURN_ZVAL(&affected, 1, 1);
}

/* The normal query path is asynchronous so pg_cancel_query can cancel this exact backend while it waits. */
ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, executeSql)
{
    zend_string *sql; HashTable *params; bool simple_query = false; zval *param_types = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 4)
        Z_PARAM_STR(sql) Z_PARAM_ARRAY_HT(params) Z_PARAM_OPTIONAL Z_PARAM_BOOL(simple_query) Z_PARAM_ARRAY(param_types)
    ZEND_PARSE_PARAMETERS_END();
    zval active_rv; zval *active = pg_prop(ZEND_THIS, "activeStatement", &active_rv);
    if (active != NULL && Z_TYPE_P(active) == IS_OBJECT) {
        zval closed;
        if (pg_call_method(active, "closeCursor", &closed, 0, NULL)) zval_ptr_dtor(&closed);
        if (EG(exception) != NULL) RETURN_THROWS();
    }
    pg_clear_error(ZEND_THIS);
    zval connection, values, send_args[3], sent;
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    array_init_size(&values, zend_hash_num_elements(params));
    zval *param; zend_ulong param_index;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(params, param_index, param) {
        zval *type_value = param_types != NULL ? zend_hash_index_find(Z_ARRVAL_P(param_types), param_index) : NULL;
        zend_long type = type_value != NULL && Z_TYPE_P(type_value) == IS_LONG ? Z_LVAL_P(type_value) : -1;
        zend_long null_type = pg_value_long("PDO::PARAM_NULL", 0), bool_type = pg_value_long("PDO::PARAM_BOOL", 5), lob_type = pg_value_long("PDO::PARAM_LOB", 3);
        if (Z_TYPE_P(param) == IS_NULL || type == null_type) add_next_index_null(&values);
        else if (type == lob_type) {
            zval contents;
            if (Z_TYPE_P(param) == IS_RESOURCE) {
                zval arg; ZVAL_COPY(&arg, param);
                if (!pg_call_function("stream_get_contents", &contents, 1, &arg)) { zval_ptr_dtor(&arg); zval_ptr_dtor(&values); zval_ptr_dtor(&connection); RETURN_THROWS(); }
                zval_ptr_dtor(&arg);
            } else ZVAL_COPY(&contents, param);
            if (Z_TYPE(contents) != IS_STRING) { zval_ptr_dtor(&contents); zval_ptr_dtor(&values); zval_ptr_dtor(&connection); pg_raise("PostgreSQL LOB parameter must be a string or stream"); RETURN_THROWS(); }
            zend_string *hex = zend_string_alloc(Z_STRLEN(contents) * 2 + 2, 0); ZSTR_VAL(hex)[0] = '\\'; ZSTR_VAL(hex)[1] = 'x';
            static const char digits[] = "0123456789abcdef";
            for (size_t i = 0; i < Z_STRLEN(contents); i++) { unsigned char c = (unsigned char) Z_STRVAL(contents)[i]; ZSTR_VAL(hex)[2 + i * 2] = digits[c >> 4]; ZSTR_VAL(hex)[3 + i * 2] = digits[c & 15]; }
            ZSTR_VAL(hex)[ZSTR_LEN(hex)] = '\0'; add_next_index_str(&values, hex); zval_ptr_dtor(&contents);
        }
        else if (Z_TYPE_P(param) == IS_TRUE || type == bool_type) add_next_index_string(&values, zend_is_true(param) ? "true" : "false");
        else if (Z_TYPE_P(param) == IS_FALSE) add_next_index_string(&values, "false");
        else if (Z_TYPE_P(param) == IS_STRING || Z_TYPE_P(param) == IS_LONG || Z_TYPE_P(param) == IS_DOUBLE || Z_TYPE_P(param) == IS_OBJECT) {
            zend_string *text = zval_get_string(param);
            if (EG(exception) != NULL) { zend_string_release(text); zval_ptr_dtor(&values); zval_ptr_dtor(&connection); RETURN_THROWS(); }
            add_next_index_str(&values, text);
        } else {
            zval_ptr_dtor(&values); zval_ptr_dtor(&connection); pg_raise("PostgreSQL parameter cannot be represented as text"); RETURN_THROWS();
        }
    } ZEND_HASH_FOREACH_END();
    ZVAL_COPY(&send_args[0], &connection); ZVAL_STR_COPY(&send_args[1], sql);
    if (simple_query) {
        if (!pg_call_function("pg_send_query", &sent, 2, send_args)) {
            zval_ptr_dtor(&send_args[0]); zval_ptr_dtor(&send_args[1]); zval_ptr_dtor(&values); zval_ptr_dtor(&connection); RETURN_THROWS();
        }
        zval_ptr_dtor(&send_args[0]); zval_ptr_dtor(&send_args[1]);
    } else {
        ZVAL_COPY(&send_args[2], &values);
        if (!pg_call_function("pg_send_query_params", &sent, 3, send_args)) {
            for (int i = 0; i < 3; i++) zval_ptr_dtor(&send_args[i]); zval_ptr_dtor(&values); zval_ptr_dtor(&connection); RETURN_THROWS();
        }
        for (int i = 0; i < 3; i++) zval_ptr_dtor(&send_args[i]);
    }
    zval_ptr_dtor(&sent); zval_ptr_dtor(&values);
    zval socket_arg, socket;
    ZVAL_COPY(&socket_arg, &connection);
    if (!pg_call_function("pg_socket", &socket, 1, &socket_arg)) { zval_ptr_dtor(&socket_arg); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&socket_arg);
    if (Z_TYPE(socket) != IS_RESOURCE) { zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); pg_raise("PostgreSQL connection has no socket"); RETURN_THROWS(); }
    while (1) {
        zval busy_arg, busy;
        ZVAL_COPY(&busy_arg, &connection);
        if (!pg_call_function("pg_connection_busy", &busy, 1, &busy_arg)) { zval_ptr_dtor(&busy_arg); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&busy_arg);
        bool is_busy = zend_is_true(&busy); zval_ptr_dtor(&busy);
        if (!is_busy) break;
        zval read, write, except, seconds, microseconds, selected;
        array_init(&read); zval socket_copy; ZVAL_COPY(&socket_copy, &socket); add_next_index_zval(&read, &socket_copy);
        ZVAL_MAKE_REF(&read);
        ZVAL_NULL(&write); ZVAL_MAKE_REF(&write); ZVAL_NULL(&except); ZVAL_MAKE_REF(&except);
        ZVAL_NULL(&seconds); ZVAL_NULL(&microseconds);
        zval select_args[5]; ZVAL_COPY_VALUE(&select_args[0], &read); ZVAL_COPY_VALUE(&select_args[1], &write);
        ZVAL_COPY_VALUE(&select_args[2], &except); ZVAL_COPY_VALUE(&select_args[3], &seconds); ZVAL_COPY_VALUE(&select_args[4], &microseconds);
        if (!pg_call_function("stream_select", &selected, 5, select_args)) {
            for (int i = 0; i < 5; i++) zval_ptr_dtor(&select_args[i]); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS();
        }
        bool ready = zval_get_long(&selected) > 0; zval_ptr_dtor(&selected);
        for (int i = 0; i < 5; i++) zval_ptr_dtor(&select_args[i]);
        if (!ready) continue;
        zval consume_arg, consumed;
        ZVAL_COPY(&consume_arg, &connection);
        if (!pg_call_function("pg_consume_input", &consumed, 1, &consume_arg)) { zval_ptr_dtor(&consume_arg); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&consume_arg);
        bool ok = zend_is_true(&consumed); zval_ptr_dtor(&consumed);
        if (!ok) { zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); pg_raise("PostgreSQL connection was lost while waiting for a query"); RETURN_THROWS(); }
        zval parsed_busy_arg, parsed_busy;
        ZVAL_COPY(&parsed_busy_arg, &connection);
        if (!pg_call_function("pg_connection_busy", &parsed_busy, 1, &parsed_busy_arg)) { zval_ptr_dtor(&parsed_busy_arg); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&parsed_busy_arg); zval_ptr_dtor(&parsed_busy);
        zval callback_rv; zval *callback = pg_prop(ZEND_THIS, "noticeCallback", &callback_rv);
        if (callback != NULL && Z_TYPE_P(callback) == IS_OBJECT) {
            zend_long all = pg_value_long("PGSQL_NOTICE_ALL", 1), clear = pg_value_long("PGSQL_NOTICE_CLEAR", 2);
            zval notice_args[2], notices;
            ZVAL_COPY(&notice_args[0], &connection); ZVAL_LONG(&notice_args[1], all);
            if (!pg_call_function("pg_last_notice", &notices, 2, notice_args)) { zval_ptr_dtor(&notice_args[0]); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS(); }
            zval_ptr_dtor(&notice_args[0]);
            ZVAL_COPY(&notice_args[0], &connection); ZVAL_LONG(&notice_args[1], clear);
            zval discarded;
            if (pg_call_function("pg_last_notice", &discarded, 2, notice_args)) zval_ptr_dtor(&discarded);
            zval_ptr_dtor(&notice_args[0]);
            if (Z_TYPE(notices) == IS_ARRAY) {
                zval *notice;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL(notices), notice) {
                    zend_string *text = zval_get_string(notice);
                    if (EG(exception) != NULL) { zend_string_release(text); zval_ptr_dtor(&notices); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS(); }
                    zval arg, ignored; ZVAL_STR(&arg, text);
                    if (call_user_function(NULL, NULL, callback, &ignored, 1, &arg) != SUCCESS || EG(exception) != NULL) {
                        zval_ptr_dtor(&arg); zval_ptr_dtor(&notices); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS();
                    }
                    zval_ptr_dtor(&arg); zval_ptr_dtor(&ignored);
                } ZEND_HASH_FOREACH_END();
            }
            zval_ptr_dtor(&notices);
        }
        zval function, exists;
        ZVAL_STRING(&function, "pcntl_signal_dispatch");
        if (pg_call_function("function_exists", &exists, 1, &function)) {
            if (zend_is_true(&exists)) {
                zval dispatched;
                if (!pg_call_function("pcntl_signal_dispatch", &dispatched, 0, NULL)) {
                    zval_ptr_dtor(&exists); zval_ptr_dtor(&function); zval_ptr_dtor(&socket); zval_ptr_dtor(&connection); RETURN_THROWS();
                }
                zval_ptr_dtor(&dispatched);
            }
            zval_ptr_dtor(&exists);
        }
        zval_ptr_dtor(&function);
    }
    zval_ptr_dtor(&socket);
    zval get_arg, result;
    ZVAL_COPY(&get_arg, &connection);
    if (!pg_call_function("pg_get_result", &result, 1, &get_arg)) { zval_ptr_dtor(&get_arg); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&get_arg); zval_ptr_dtor(&connection);
    zval last_result, query_state, query_message;
    ZVAL_UNDEF(&last_result); ZVAL_NULL(&query_state); ZVAL_NULL(&query_message);
    while (Z_TYPE(result) == IS_OBJECT) {
        zval status_arg, status; ZVAL_COPY(&status_arg, &result);
        if (!pg_call_function("pg_result_status", &status, 1, &status_arg)) { zval_ptr_dtor(&status_arg); zval_ptr_dtor(&result); if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result); zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message); RETURN_THROWS(); }
        zval_ptr_dtor(&status_arg);
        zend_long tuple_status = 2, command_status = 1;
        pg_constant_long("PGSQL_TUPLES_OK", &tuple_status); pg_constant_long("PGSQL_COMMAND_OK", &command_status);
        bool succeeded = Z_TYPE(status) == IS_LONG && (Z_LVAL(status) == tuple_status || Z_LVAL(status) == command_status);
        zval_ptr_dtor(&status);
        if (!succeeded) {
            if (Z_TYPE(query_message) == IS_NULL) {
                zval error_args[2], state, message; ZVAL_COPY(&error_args[0], &result);
                zend_long field = 0; pg_constant_long("PGSQL_DIAG_SQLSTATE", &field); ZVAL_LONG(&error_args[1], field);
                if (!pg_call_function("pg_result_error_field", &state, 2, error_args)) { zval_ptr_dtor(&error_args[0]); zval_ptr_dtor(&error_args[1]); zval_ptr_dtor(&result); if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result); zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message); RETURN_THROWS(); }
                zval_ptr_dtor(&error_args[0]); zval_ptr_dtor(&error_args[1]);
                zval message_arg; ZVAL_COPY(&message_arg, &result);
                if (!pg_call_function("pg_result_error", &message, 1, &message_arg)) { zval_ptr_dtor(&message_arg); zval_ptr_dtor(&state); zval_ptr_dtor(&result); if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result); zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message); RETURN_THROWS(); }
                zval_ptr_dtor(&message_arg);
                ZVAL_COPY_VALUE(&query_state, &state); ZVAL_COPY_VALUE(&query_message, &message);
            }
            zval free_arg, freed; ZVAL_COPY(&free_arg, &result); if (pg_call_function("pg_free_result", &freed, 1, &free_arg)) zval_ptr_dtor(&freed); zval_ptr_dtor(&free_arg);
        } else {
            if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result);
            ZVAL_COPY_VALUE(&last_result, &result);
        }
        ZVAL_UNDEF(&result);
        zval next_arg; ZVAL_UNDEF(&next_arg); zval next_connection;
        if (!pg_get_connection(ZEND_THIS, &next_connection)) { if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result); zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message); RETURN_THROWS(); }
        ZVAL_COPY(&next_arg, &next_connection); zval_ptr_dtor(&next_connection);
        if (!pg_call_function("pg_get_result", &result, 1, &next_arg)) { zval_ptr_dtor(&next_arg); if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result); zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message); RETURN_THROWS(); }
        zval_ptr_dtor(&next_arg);
        if (Z_TYPE(result) == IS_FALSE || Z_TYPE(result) == IS_NULL) { zval_ptr_dtor(&result); ZVAL_UNDEF(&result); break; }
    }
    if (Z_TYPE(query_message) != IS_NULL) {
        zend_string *state_text = Z_TYPE(query_state) == IS_STRING ? Z_STR(query_state) : zend_string_init("HY000", sizeof("HY000") - 1, 0);
        zend_string *message_text = zval_get_string(&query_message);
        pg_raise_statement(ZEND_THIS, state_text, message_text);
        if (Z_TYPE(query_state) != IS_STRING) zend_string_release(state_text);
        zend_string_release(message_text); zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message);
        if (!Z_ISUNDEF(last_result)) zval_ptr_dtor(&last_result);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&query_state); zval_ptr_dtor(&query_message);
    if (Z_ISUNDEF(last_result)) { if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result); pg_raise("PostgreSQL connection was lost before receiving a result"); RETURN_THROWS(); }
    ZVAL_COPY_VALUE(&result, &last_result);
    zval affected_arg, affected;
    ZVAL_COPY(&affected_arg, &result);
    if (pg_call_function("pg_affected_rows", &affected, 1, &affected_arg)) { pg_set(ZEND_THIS, "affectedRows", &affected); zval_ptr_dtor(&affected); }
    zval_ptr_dtor(&affected_arg);
    zval last_id; ZVAL_FALSE(&last_id); pg_set(ZEND_THIS, "lastInsertIdValue", &last_id);
    pg_clear_error(ZEND_THIS);
    RETURN_ZVAL(&result, 1, 1);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, __construct)
{
    zval *pdo; zend_string *source_sql;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_OBJECT_OF_CLASS(pdo, pgsql_adapter_ce) Z_PARAM_STR(source_sql) ZEND_PARSE_PARAMETERS_END();
    zval empty, null_value, row, affected;
    array_init(&empty); pg_set(ZEND_THIS, "bindings", &empty); zval_ptr_dtor(&empty);
    array_init(&empty); pg_set(ZEND_THIS, "bindingTypes", &empty); zval_ptr_dtor(&empty);
    array_init(&empty); pg_set(ZEND_THIS, "boundRefs", &empty); zval_ptr_dtor(&empty);
    array_init(&empty); pg_set(ZEND_THIS, "boundRefTypes", &empty); zval_ptr_dtor(&empty);
    array_init(&empty); pg_set(ZEND_THIS, "boundColumns", &empty); zval_ptr_dtor(&empty);
    array_init(&empty); add_next_index_long(&empty, pg_value_long("PDO::FETCH_BOTH", 4)); pg_set(ZEND_THIS, "fetchMode", &empty); zval_ptr_dtor(&empty);
    ZVAL_NULL(&null_value); pg_set(ZEND_THIS, "result", &null_value);
    ZVAL_LONG(&row, 0); pg_set(ZEND_THIS, "row", &row);
    ZVAL_LONG(&affected, 0); pg_set(ZEND_THIS, "affected", &affected);
    array_init(&empty); pg_set(ZEND_THIS, "columns", &empty); zval_ptr_dtor(&empty);
    pg_set(ZEND_THIS, "pdo", pdo);
    zval sql; ZVAL_STR_COPY(&sql, source_sql); pg_set(ZEND_THIS, "sourceSql", &sql); zval_ptr_dtor(&sql);
}

/* Stores value and its PDO type under the statement key key in the arrays values and types of the statement
 * adapter self; false with an exception for an invalid key. */
static bool pg_store_binding(zval *self, zval *key, zval *value, zend_long type, const char *values, const char *types)
{
    zval slot;
    if (!pg_statement_key(key, &slot)) return false;
    zval rv, *stored = pg_prop(self, values, &rv);
    zval copy;
    ZVAL_COPY(&copy, value);
    pg_array_update_key(Z_ARRVAL_P(stored), &slot, &copy);
    zval type_rv, *stored_types = pg_prop(self, types, &type_rv);
    zval type_value;
    ZVAL_LONG(&type_value, type);
    pg_array_update_key(Z_ARRVAL_P(stored_types), &slot, &type_value);
    zval_ptr_dtor(&slot);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, bindValue)
{
    zval *key, *value; zend_long type = 2;
    ZEND_PARSE_PARAMETERS_START(2, 3) Z_PARAM_ZVAL(key) Z_PARAM_ZVAL(value) Z_PARAM_OPTIONAL Z_PARAM_LONG(type) ZEND_PARSE_PARAMETERS_END();
    if (!pg_store_binding(ZEND_THIS, key, value, type, "bindings", "bindingTypes")) RETURN_THROWS();
    RETURN_TRUE;
}

/* The arguments key, value and type of bindParam and bindColumn, whose maximum length and driver options the adapter
 * reads and ignores as PDO does; false with the argument error thrown. */
static bool pg_bind_args(zend_execute_data *execute_data, zval **key, zval **value, zend_long *type)
{
    zend_long max_length = 0;
    zval *driver_options = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 5)
        Z_PARAM_ZVAL(*key) Z_PARAM_ZVAL(*value) Z_PARAM_OPTIONAL Z_PARAM_LONG(*type) Z_PARAM_LONG(max_length)
        Z_PARAM_ZVAL(driver_options)
    ZEND_PARSE_PARAMETERS_END_EX(return false);
    (void) max_length;
    (void) driver_options;
    return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, bindParam)
{
    zval *key, *value; zend_long type = 2;
    if (!pg_bind_args(execute_data, &key, &value, &type)) RETURN_THROWS();
    if (!pg_store_binding(ZEND_THIS, key, value, type, "boundRefs", "boundRefTypes")) RETURN_THROWS();
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, bindColumn)
{
    zval *key, *value; zend_long type = 2;
    if (!pg_bind_args(execute_data, &key, &value, &type)) RETURN_THROWS();
    (void) type;
    zval rv, *columns = pg_prop(ZEND_THIS, "boundColumns", &rv), copy, slot; ZVAL_COPY(&copy, value);
    if (!pg_statement_key(key, &slot)) { zval_ptr_dtor(&copy); RETURN_THROWS(); }
    pg_array_update_key(Z_ARRVAL_P(columns), &slot, &copy); zval_ptr_dtor(&slot);
    RETURN_TRUE;
}

/* Copies each value of the statement bindings into params under its key, with its PDO type of types or null into
 * binding_types; deref reads a bound reference's current value. Bindings that are no array add nothing. */
static void pg_collect_bindings(zval *bindings, zval *types, bool deref, zval *params, zval *binding_types)
{
    if (bindings == NULL || Z_TYPE_P(bindings) != IS_ARRAY) return;
    zval *value; zend_ulong index; zend_string *name;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(bindings), index, name, value) {
        zval slot, copy;
        if (name == NULL) ZVAL_LONG(&slot, index); else ZVAL_STR_COPY(&slot, name);
        if (deref) ZVAL_COPY_DEREF(&copy, value); else ZVAL_COPY(&copy, value);
        pg_array_update_key(Z_ARRVAL_P(params), &slot, &copy);
        zval *type = types != NULL && Z_TYPE_P(types) == IS_ARRAY ? pg_array_find_key(Z_ARRVAL_P(types), &slot) : NULL;
        zval type_copy;
        if (type == NULL) ZVAL_NULL(&type_copy); else ZVAL_COPY(&type_copy, type);
        pg_array_update_key(Z_ARRVAL_P(binding_types), &slot, &type_copy);
        zval_ptr_dtor(&slot);
    } ZEND_HASH_FOREACH_END();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, execute)
{
    zval *provided = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_ARRAY(provided) ZEND_PARSE_PARAMETERS_END();
    if (provided != NULL) {
        zval new_bindings, new_types;
        array_init_size(&new_bindings, zend_hash_num_elements(Z_ARRVAL_P(provided)));
        array_init(&new_types);
        zval *value; zend_ulong index; zend_string *name;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(provided), index, name, value) {
            zval slot, copy;
            if (name == NULL) ZVAL_LONG(&slot, index);
            else {
                const char *text = ZSTR_VAL(name); size_t length = ZSTR_LEN(name);
                if (length > 0 && text[0] == ':') { text++; length--; }
                ZVAL_STR(&slot, zend_string_init(text, length, 0));
            }
            ZVAL_COPY(&copy, value);
            pg_array_update_key(Z_ARRVAL(new_bindings), &slot, &copy);
            zval_ptr_dtor(&slot);
        } ZEND_HASH_FOREACH_END();
        pg_set(ZEND_THIS, "bindings", &new_bindings);
        pg_set(ZEND_THIS, "bindingTypes", &new_types);
        zval_ptr_dtor(&new_bindings);
        zval_ptr_dtor(&new_types);
    }
    zval rv, *pdo = pg_prop(ZEND_THIS, "pdo", &rv);
    zval sqlrv; zval *source_value = pg_prop(ZEND_THIS, "sourceSql", &sqlrv);
    if (pdo == NULL || Z_TYPE_P(pdo) != IS_OBJECT || source_value == NULL || Z_TYPE_P(source_value) != IS_STRING) {
        zend_throw_error(NULL, "invalid PostgreSQL statement state"); RETURN_THROWS();
    }
    zval params; array_init(&params);
    zval binding_types; array_init(&binding_types);
    zval bindings_rv, refs_rv, types_rv, ref_types_rv;
    zval *bindings = pg_prop(ZEND_THIS, "bindings", &bindings_rv), *refs = pg_prop(ZEND_THIS, "boundRefs", &refs_rv);
    zval *types = pg_prop(ZEND_THIS, "bindingTypes", &types_rv), *ref_types = pg_prop(ZEND_THIS, "boundRefTypes", &ref_types_rv);
    pg_collect_bindings(bindings, types, false, &params, &binding_types);
    pg_collect_bindings(refs, ref_types, true, &params, &binding_types);
    zend_string *numbered = NULL; zval order;
    pg_statement_sql(Z_STR_P(source_value), &numbered, &order);
    zval ordered, ordered_types; array_init_size(&ordered, zend_hash_num_elements(Z_ARRVAL(order))); array_init_size(&ordered_types, zend_hash_num_elements(Z_ARRVAL(order)));
    zval *slot; ZEND_HASH_FOREACH_VAL(Z_ARRVAL(order), slot) {
        zval *value = pg_array_find_key(Z_ARRVAL(params), slot);
        if (value == NULL) {
            zend_string_release(numbered); zval_ptr_dtor(&order); zval_ptr_dtor(&params); zval_ptr_dtor(&binding_types); zval_ptr_dtor(&ordered); zval_ptr_dtor(&ordered_types);
            if (Z_TYPE_P(slot) == IS_STRING) zend_throw_exception_ex(zend_ce_exception, 0, "parameter %s was not bound", Z_STRVAL_P(slot));
            else zend_throw_exception_ex(zend_ce_exception, 0, "parameter %" ZEND_LONG_FMT_SPEC " was not bound", zval_get_long(slot) + 1);
            RETURN_THROWS();
        }
        zval copy; ZVAL_COPY_DEREF(&copy, value); add_next_index_zval(&ordered, &copy);
        zval *type = pg_array_find_key(Z_ARRVAL(binding_types), slot);
        if (type == NULL) add_next_index_null(&ordered_types); else { zval type_copy; ZVAL_COPY(&type_copy, type); add_next_index_zval(&ordered_types, &type_copy); }
    } ZEND_HASH_FOREACH_END();
    zval args[4], result;
    ZVAL_STR(&args[0], numbered); ZVAL_COPY_VALUE(&args[1], &ordered); ZVAL_FALSE(&args[2]); ZVAL_COPY_VALUE(&args[3], &ordered_types);
    if (!pg_call_method(pdo, "executeSql", &result, 4, args)) {
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&args[3]); zval_ptr_dtor(&params); zval_ptr_dtor(&binding_types); zval_ptr_dtor(&order); RETURN_THROWS();
    }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&args[3]); zval_ptr_dtor(&params); zval_ptr_dtor(&binding_types); zval_ptr_dtor(&order);
    pg_set(ZEND_THIS, "result", &result); zval_ptr_dtor(&result);
    zval row; ZVAL_LONG(&row, 0); pg_set(ZEND_THIS, "row", &row);
    zval affected_arg, affected; zval result_rv; zval *stored_result = pg_prop(ZEND_THIS, "result", &result_rv);
    ZVAL_COPY(&affected_arg, stored_result);
    if (!pg_call_function("pg_affected_rows", &affected, 1, &affected_arg)) { zval_ptr_dtor(&affected_arg); RETURN_THROWS(); }
    zval_ptr_dtor(&affected_arg); pg_set(ZEND_THIS, "affected", &affected); zval_ptr_dtor(&affected);
    zval columns; array_init(&columns);
    zend_long count = 0; zval count_arg, count_value; ZVAL_COPY(&count_arg, stored_result);
    if (!pg_call_function("pg_num_fields", &count_value, 1, &count_arg)) { zval_ptr_dtor(&count_arg); zval_ptr_dtor(&columns); RETURN_THROWS(); }
    zval_ptr_dtor(&count_arg); count = zval_get_long(&count_value); zval_ptr_dtor(&count_value);
    for (zend_long i = 0; i < count; i++) {
        zval meta; array_init(&meta);
        /* The name of the table is read only when getColumnMeta asks for it: pg_field_table looks it up with a query
         * of its own, a server transaction that the statement did not ask for. */
        zval no_table; ZVAL_NULL(&no_table); zend_hash_str_update(Z_ARRVAL(meta), "table", sizeof("table") - 1, &no_table);
        const char *functions[] = {"pg_field_name", "pg_field_type", "pg_field_type_oid", "pg_field_size"};
        const char *keys[] = {"name", "type", "oid", "size"};
        for (int j = 0; j < 4; j++) {
            zval call_args[2], value; ZVAL_COPY(&call_args[0], stored_result); ZVAL_LONG(&call_args[1], i);
            if (!pg_call_function(functions[j], &value, 2, call_args)) { zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&call_args[1]); zval_ptr_dtor(&meta); zval_ptr_dtor(&columns); RETURN_THROWS(); }
            zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&call_args[1]); zend_hash_str_update(Z_ARRVAL(meta), keys[j], strlen(keys[j]), &value);
        }
        add_next_index_zval(&columns, &meta);
    }
    pg_set(ZEND_THIS, "columns", &columns); zval_ptr_dtor(&columns);
    zval pdo_arg; ZVAL_COPY(&pdo_arg, ZEND_THIS); zval mark_args[1], ignored; ZVAL_COPY(&mark_args[0], &pdo_arg); zval_ptr_dtor(&pdo_arg);
    if (!pg_call_method(pdo, "markActive", &ignored, 1, mark_args)) { zval_ptr_dtor(&mark_args[0]); RETURN_THROWS(); }
    zval_ptr_dtor(&mark_args[0]); zval_ptr_dtor(&ignored);
    RETURN_TRUE;
}

static bool pg_statement_row(zval *self, zend_long mode, zval *row_value)
{
    zval rv, *result = pg_prop(self, "result", &rv);
    if (result == NULL || Z_TYPE_P(result) != IS_OBJECT) { ZVAL_FALSE(row_value); return true; }
    zval num_args[1], num_rows; ZVAL_COPY(&num_args[0], result);
    if (!pg_call_function("pg_num_rows", &num_rows, 1, num_args)) { zval_ptr_dtor(&num_args[0]); return false; }
    zval_ptr_dtor(&num_args[0]);
    zval row_rv; zval *row_prop = pg_prop(self, "row", &row_rv);
    zend_long row = row_prop == NULL ? 0 : zval_get_long(row_prop);
    if (row >= zval_get_long(&num_rows)) { zval_ptr_dtor(&num_rows); ZVAL_FALSE(row_value); return true; }
    zval_ptr_dtor(&num_rows);
    zval args[2], values; ZVAL_COPY(&args[0], result); ZVAL_LONG(&args[1], row);
    if (!pg_call_function("pg_fetch_row", &values, 2, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); return false; }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (Z_TYPE(values) != IS_ARRAY) { zval_ptr_dtor(&values); ZVAL_FALSE(row_value); return true; }
    zval next; ZVAL_LONG(&next, row + 1); pg_set(self, "row", &next);
    zval columns_rv; zval *columns = pg_prop(self, "columns", &columns_rv);
    zval pdo_rv; zval *pdo = pg_prop(self, "pdo", &pdo_rv); zval stringify = {0};
    if (pdo != NULL) pg_call_method(pdo, "stringifyFetches", &stringify, 0, NULL);
    bool stringify_values = zend_is_true(&stringify); if (!Z_ISUNDEF(stringify)) zval_ptr_dtor(&stringify);
    zend_long fetch_num = pg_value_long("PDO::FETCH_NUM", 3), fetch_both = pg_value_long("PDO::FETCH_BOTH", 4), fetch_obj = pg_value_long("PDO::FETCH_OBJ", 5), fetch_col = pg_value_long("PDO::FETCH_COLUMN", 7);
    zval converted; array_init(&converted);
    zval *raw; zend_ulong index;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL(values), index, raw) {
        zval value; ZVAL_COPY(&value, raw);
        if (Z_TYPE(value) == IS_STRING && columns != NULL && Z_TYPE_P(columns) == IS_ARRAY) {
            zval *meta = zend_hash_index_find(Z_ARRVAL_P(columns), index);
            zval *type = meta != NULL ? zend_hash_str_find(Z_ARRVAL_P(meta), "type", sizeof("type") - 1) : NULL;
            if (type != NULL && Z_TYPE_P(type) == IS_STRING) {
                if (zend_string_equals_literal(Z_STR_P(type), "bytea")) {
                    zval binary, argument;
                    ZVAL_COPY(&argument, &value);
                    if (!pg_call_function("pg_unescape_bytea", &binary, 1, &argument)) {
                        zval_ptr_dtor(&argument);
                        zval_ptr_dtor(&value);
                        zval_ptr_dtor(&values);
                        zval_ptr_dtor(&converted);
                        return false;
                    }
                    zval_ptr_dtor(&argument);
                    if (Z_TYPE(binary) != IS_STRING) {
                        zval_ptr_dtor(&binary);
                        zval_ptr_dtor(&value);
                        zval_ptr_dtor(&values);
                        zval_ptr_dtor(&converted);
                        zend_throw_exception(zend_ce_exception, "PostgreSQL bytea decoding did not return a string", 0);
                        return false;
                    }
                    if (stringify_values) {
                        zval_ptr_dtor(&value);
                        ZVAL_COPY_VALUE(&value, &binary);
                        zend_hash_index_update(Z_ARRVAL(converted), index, &value);
                        continue;
                    }
                    php_stream *stream = php_stream_temp_new();
                    if (stream == NULL) {
                        zval_ptr_dtor(&binary);
                        zval_ptr_dtor(&value);
                        zval_ptr_dtor(&values);
                        zval_ptr_dtor(&converted);
                        zend_throw_exception(zend_ce_exception, "cannot allocate PostgreSQL bytea stream", 0);
                        return false;
                    }
                    size_t binary_length = Z_STRLEN(binary);
                    ssize_t written = php_stream_write(stream, Z_STRVAL(binary), binary_length);
                    zval_ptr_dtor(&binary);
                    if (written < 0 || (size_t) written != binary_length || php_stream_rewind(stream) != 0) {
                        php_stream_close(stream);
                        zval_ptr_dtor(&value);
                        zval_ptr_dtor(&values);
                        zval_ptr_dtor(&converted);
                        zend_throw_exception(zend_ce_exception, "cannot initialize PostgreSQL bytea stream", 0);
                        return false;
                    }
                    zval_ptr_dtor(&value);
                    php_stream_to_zval(stream, &value);
                } else if (zend_string_equals_literal(Z_STR_P(type), "bool")) {
                    bool truth = zend_string_equals_literal(Z_STR(value), "t");
                    zval_ptr_dtor(&value);
                    if (stringify_values) ZVAL_STRING(&value, truth ? "1" : "0");
                    else ZVAL_BOOL(&value, truth);
                }
                else if (!stringify_values && (zend_string_equals_literal(Z_STR_P(type), "int2") || zend_string_equals_literal(Z_STR_P(type), "int4"))) { zend_long n = zval_get_long(&value); zval_ptr_dtor(&value); ZVAL_LONG(&value, n); }
                else if (!stringify_values && zend_string_equals_literal(Z_STR_P(type), "int8")) { zend_long n; if (is_numeric_string(Z_STRVAL(value), Z_STRLEN(value), &n, NULL, 0) == IS_LONG) { zval_ptr_dtor(&value); ZVAL_LONG(&value, n); } }
                else if (!stringify_values && (zend_string_equals_literal(Z_STR_P(type), "float4") || zend_string_equals_literal(Z_STR_P(type), "float8"))) { double n = zval_get_double(&value); zval_ptr_dtor(&value); ZVAL_DOUBLE(&value, n); }
            }
        }
        zend_hash_index_update(Z_ARRVAL(converted), index, &value);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&values);
    zval bound_rv; zval *bound_columns = pg_prop(self, "boundColumns", &bound_rv);
    if (bound_columns != NULL && Z_TYPE_P(bound_columns) == IS_ARRAY) {
        zval *bound; zend_ulong numeric_key; zend_string *string_key;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(bound_columns), numeric_key, string_key, bound) {
            zval *value = NULL;
            if (string_key == NULL) value = zend_hash_index_find(Z_ARRVAL(converted), numeric_key);
            else if (columns != NULL && Z_TYPE_P(columns) == IS_ARRAY) {
                zval *meta; zend_ulong column_index;
                ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(columns), column_index, meta) {
                    zval *name = zend_hash_str_find(Z_ARRVAL_P(meta), "name", sizeof("name") - 1);
                    if (name != NULL && Z_TYPE_P(name) == IS_STRING && zend_string_equals(Z_STR_P(name), string_key)) { value = zend_hash_index_find(Z_ARRVAL(converted), column_index); break; }
                } ZEND_HASH_FOREACH_END();
            }
            if (value != NULL) {
                zval *target = Z_TYPE_P(bound) == IS_REFERENCE ? Z_REFVAL_P(bound) : bound;
                zval copy; ZVAL_COPY(&copy, value); zval_ptr_dtor(target); ZVAL_COPY_VALUE(target, &copy);
            }
        } ZEND_HASH_FOREACH_END();
    }
    if (mode == fetch_num || mode == fetch_col) {
        if (mode == fetch_col) {
            zval *value = zend_hash_index_find(Z_ARRVAL(converted), 0);
            if (value == NULL) ZVAL_FALSE(row_value); else ZVAL_COPY(row_value, value);
            zval_ptr_dtor(&converted); return true;
        }
        ZVAL_COPY_VALUE(row_value, &converted); return true;
    }
    zval associative; array_init(&associative);
    if (columns != NULL && Z_TYPE_P(columns) == IS_ARRAY) {
        zval *meta; zend_ulong i; ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(columns), i, meta) {
            zval *name = zend_hash_str_find(Z_ARRVAL_P(meta), "name", sizeof("name") - 1), *value = zend_hash_index_find(Z_ARRVAL(converted), i);
            if (name != NULL && Z_TYPE_P(name) == IS_STRING && value != NULL) { zval copy; ZVAL_COPY(&copy, value); zend_hash_update(Z_ARRVAL(associative), Z_STR_P(name), &copy); }
        } ZEND_HASH_FOREACH_END();
    }
    if (mode == pg_value_long("PDO::FETCH_BOUND", 6)) { zval_ptr_dtor(&associative); zval_ptr_dtor(&converted); ZVAL_TRUE(row_value); return true; }
    if (mode == fetch_obj) {
        object_init(row_value); zend_string *key; zval *value;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(associative), key, value) { if (key != NULL) zend_update_property(Z_OBJCE_P(row_value), Z_OBJ_P(row_value), ZSTR_VAL(key), ZSTR_LEN(key), value); } ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&associative); return true;
    }
    if (mode == fetch_both) {
        if (columns != NULL && Z_TYPE_P(columns) == IS_ARRAY) {
            zval *meta; zend_ulong i; ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(columns), i, meta) {
                (void) meta;
                zval *value = zend_hash_index_find(Z_ARRVAL(converted), i); if (value != NULL) { zval copy; ZVAL_COPY(&copy, value); add_index_zval(&associative, i, &copy); }
            } ZEND_HASH_FOREACH_END();
        }
    }
    zval_ptr_dtor(&converted);
    ZVAL_COPY_VALUE(row_value, &associative); return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, fetch)
{
    zend_long mode = 0, orientation = 0, offset = 0;
    ZEND_PARSE_PARAMETERS_START(0, 3) Z_PARAM_OPTIONAL Z_PARAM_LONG(mode) Z_PARAM_LONG(orientation) Z_PARAM_LONG(offset) ZEND_PARSE_PARAMETERS_END();
    (void) orientation; (void) offset;
    if (mode == pg_value_long("PDO::FETCH_DEFAULT", 0)) { zval rv; zval *modes = pg_prop(ZEND_THIS, "fetchMode", &rv); zval *stored = modes != NULL && Z_TYPE_P(modes) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(modes), 0) : NULL; mode = stored == NULL ? pg_value_long("PDO::FETCH_BOTH", 4) : zval_get_long(stored); }
    if (!pg_statement_row(ZEND_THIS, mode, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, fetchAll)
{
    zend_long mode = 0; zval *args = NULL; int argc = 0;
    ZEND_PARSE_PARAMETERS_START(0, -1) Z_PARAM_OPTIONAL Z_PARAM_LONG(mode) Z_PARAM_VARIADIC('*', args, argc) ZEND_PARSE_PARAMETERS_END();
    (void) args; (void) argc;
    if (mode == pg_value_long("PDO::FETCH_DEFAULT", 0)) {
        zval rv; zval *modes = pg_prop(ZEND_THIS, "fetchMode", &rv);
        zval *stored = modes != NULL && Z_TYPE_P(modes) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(modes), 0) : NULL;
        mode = stored == NULL ? pg_value_long("PDO::FETCH_BOTH", 4) : zval_get_long(stored);
    }
    array_init(return_value);
    while (1) { zval row; if (!pg_statement_row(ZEND_THIS, mode, &row)) { zval_ptr_dtor(return_value); RETURN_THROWS(); } if (Z_TYPE(row) == IS_FALSE) { zval_ptr_dtor(&row); break; } add_next_index_zval(return_value, &row); }
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, fetchColumn)
{
    zend_long column = 0; ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_LONG(column) ZEND_PARSE_PARAMETERS_END();
    zval row; if (!pg_statement_row(ZEND_THIS, pg_value_long("PDO::FETCH_NUM", 3), &row)) RETURN_THROWS();
    if (Z_TYPE(row) != IS_ARRAY) { ZVAL_FALSE(return_value); return; }
    zval *value = zend_hash_index_find(Z_ARRVAL(row), column); if (value == NULL) ZVAL_FALSE(return_value); else ZVAL_COPY(return_value, value); zval_ptr_dtor(&row);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, fetchObject)
{
    zend_string *class_name = NULL; zval *ctor_args = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 2) Z_PARAM_OPTIONAL Z_PARAM_STR_OR_NULL(class_name) Z_PARAM_ARRAY(ctor_args) ZEND_PARSE_PARAMETERS_END();
    zval row; if (!pg_statement_row(ZEND_THIS, pg_value_long("PDO::FETCH_ASSOC", 2), &row)) RETURN_THROWS();
    if (Z_TYPE(row) != IS_ARRAY) { ZVAL_FALSE(return_value); return; }
    zend_class_entry *ce = class_name == NULL ? zend_standard_class_def : zend_lookup_class(class_name);
    if (ce == NULL) { zval_ptr_dtor(&row); RETURN_THROWS(); }
    object_init_ex(return_value, ce);
    if (ctor_args != NULL && zend_hash_num_elements(Z_ARRVAL_P(ctor_args)) > 0) {
        zval ctor, ignored; ZVAL_STRING(&ctor, "__construct");
        if (zend_hash_str_exists(&ce->function_table, "__construct", sizeof("__construct") - 1)) {
            zval callable; array_init(&callable); zval object; ZVAL_COPY(&object, return_value); add_next_index_zval(&callable, &object); add_next_index_zval(&callable, &ctor);
            zend_fcall_info fci; zend_fcall_info_cache fcc;
            uint32_t argc = zend_hash_num_elements(Z_ARRVAL_P(ctor_args));
            zval *packed = argc == 0 ? NULL : safe_emalloc(argc, sizeof(zval), 0);
            uint32_t i = 0; zval *arg; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ctor_args), arg) { ZVAL_COPY(&packed[i++], arg); } ZEND_HASH_FOREACH_END();
            if (zend_fcall_info_init(&callable, 0, &fci, &fcc, NULL, NULL) == SUCCESS) { ZVAL_UNDEF(&ignored); fci.retval = &ignored; fci.params = packed; fci.param_count = argc; zend_call_function(&fci, &fcc); if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored); }
            for (uint32_t j = 0; j < argc; j++) zval_ptr_dtor(&packed[j]); if (packed != NULL) efree(packed);
            zval_ptr_dtor(&callable);
        }
        zval_ptr_dtor(&ctor);
    }
    zend_string *key; zval *value; ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(row), key, value) { if (key != NULL) zend_update_property(ce, Z_OBJ_P(return_value), ZSTR_VAL(key), ZSTR_LEN(key), value); } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&row);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, closeCursor)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *result = pg_prop(ZEND_THIS, "result", &rv);
    if (result != NULL && Z_TYPE_P(result) == IS_OBJECT) { zval arg, ignored; ZVAL_COPY(&arg, result); if (pg_call_function("pg_free_result", &ignored, 1, &arg)) zval_ptr_dtor(&ignored); zval_ptr_dtor(&arg); }
    zval null_value; ZVAL_NULL(&null_value); pg_set(ZEND_THIS, "result", &null_value);
    zval pdo_rv; zval *pdo = pg_prop(ZEND_THIS, "pdo", &pdo_rv);
    if (pdo != NULL && Z_TYPE_P(pdo) == IS_OBJECT) { zval args[1], ignored; ZVAL_COPY(&args[0], ZEND_THIS); if (pg_call_method(pdo, "finish", &ignored, 1, args)) zval_ptr_dtor(&ignored); zval_ptr_dtor(&args[0]); if (EG(exception) != NULL) RETURN_THROWS(); }
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, columnCount)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval rv, *result = pg_prop(ZEND_THIS, "result", &rv); if (result == NULL || Z_TYPE_P(result) != IS_OBJECT) RETURN_LONG(0);
    zval arg, count; ZVAL_COPY(&arg, result); if (!pg_call_function("pg_num_fields", &count, 1, &arg)) { zval_ptr_dtor(&arg); RETURN_THROWS(); } zval_ptr_dtor(&arg); RETURN_ZVAL(&count, 1, 1);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, rowCount)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval rv; zval *count = pg_prop(ZEND_THIS, "affected", &rv); if (count == NULL) RETURN_LONG(0); RETURN_COPY(count);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, getColumnMeta)
{
    zend_long column; ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(column) ZEND_PARSE_PARAMETERS_END();
    zval rv; zval *columns = pg_prop(ZEND_THIS, "columns", &rv), *meta = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY && column >= 0 ? zend_hash_index_find(Z_ARRVAL_P(columns), column) : NULL;
    if (meta == NULL) RETURN_FALSE;
    zval *table = zend_hash_str_find(Z_ARRVAL_P(meta), "table", sizeof("table") - 1);
    zval result_rv, *result = pg_prop(ZEND_THIS, "result", &result_rv);
    if (table != NULL && Z_TYPE_P(table) == IS_NULL && result != NULL && Z_TYPE_P(result) == IS_OBJECT) {
        zval call_args[2], name; ZVAL_COPY(&call_args[0], result); ZVAL_LONG(&call_args[1], column);
        bool called = pg_call_function("pg_field_table", &name, 2, call_args);
        zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&call_args[1]);
        if (!called) RETURN_THROWS();
        zval updated, *updated_meta; ZVAL_ARR(&updated, zend_array_dup(Z_ARRVAL_P(columns)));
        updated_meta = zend_hash_index_find(Z_ARRVAL(updated), column);
        ZVAL_DEREF(updated_meta); SEPARATE_ARRAY(updated_meta);
        zend_hash_str_update(Z_ARRVAL_P(updated_meta), "table", sizeof("table") - 1, &name);
        pg_set(ZEND_THIS, "columns", &updated); zval_ptr_dtor(&updated);
        columns = pg_prop(ZEND_THIS, "columns", &rv);
        meta = zend_hash_index_find(Z_ARRVAL_P(columns), column);
    }
    array_init(return_value);
    const char *keys[] = {"name", "size", "type", "oid", "table"}; const char *out[] = {"name", "len", "native_type", "pgsql:oid", "table"};
    for (int i = 0; i < 5; i++) { zval *value = zend_hash_str_find(Z_ARRVAL_P(meta), keys[i], strlen(keys[i])); if (value != NULL) { zval copy; ZVAL_COPY(&copy, value); zend_hash_str_update(Z_ARRVAL_P(return_value), out[i], strlen(out[i]), &copy); } }
    zval type; ZVAL_LONG(&type, pg_value_long("PDO::PARAM_STR", 2)); zend_hash_str_update(Z_ARRVAL_P(return_value), "pdo_type", sizeof("pdo_type") - 1, &type);
    zval null_value; ZVAL_NULL(&null_value); zend_hash_str_update(Z_ARRVAL_P(return_value), "precision", sizeof("precision") - 1, &null_value);
    zval flags; array_init(&flags); zend_hash_str_update(Z_ARRVAL_P(return_value), "flags", sizeof("flags") - 1, &flags);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, setFetchMode)
{
    zend_long mode; zval *args = NULL; int argc = 0;
    ZEND_PARSE_PARAMETERS_START(1, -1) Z_PARAM_LONG(mode) Z_PARAM_VARIADIC('*', args, argc) ZEND_PARSE_PARAMETERS_END();
    zval modes; array_init_size(&modes, argc + 1); add_next_index_long(&modes, mode); for (int i = 0; i < argc; i++) { zval copy; ZVAL_COPY(&copy, &args[i]); add_next_index_zval(&modes, &copy); } pg_set(ZEND_THIS, "fetchMode", &modes); zval_ptr_dtor(&modes); RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, errorCode)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval rv, *pdo = pg_prop(ZEND_THIS, "pdo", &rv); if (pdo == NULL) RETURN_NULL();
    if (!pg_call_method(pdo, "errorCode", return_value, 0, NULL)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, errorInfo)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval rv, *pdo = pg_prop(ZEND_THIS, "pdo", &rv); if (pdo == NULL) RETURN_EMPTY_ARRAY();
    if (!pg_call_method(pdo, "errorInfo", return_value, 0, NULL)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, getAttribute)
{
    zend_long name; ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(name) ZEND_PARSE_PARAMETERS_END();
    zval rv, *pdo = pg_prop(ZEND_THIS, "pdo", &rv), arg; if (pdo == NULL) RETURN_THROWS(); ZVAL_LONG(&arg, name);
    if (!pg_call_method(pdo, "getAttribute", return_value, 1, &arg)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, setAttribute)
{
    zend_long attribute; zval *value; ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_LONG(attribute) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    zval rv, *pdo = pg_prop(ZEND_THIS, "pdo", &rv), args[2]; if (pdo == NULL) RETURN_THROWS(); ZVAL_LONG(&args[0], attribute); ZVAL_COPY(&args[1], value);
    if (!pg_call_method(pdo, "setAttribute", return_value, 2, args)) { zval_ptr_dtor(&args[1]); RETURN_THROWS(); } zval_ptr_dtor(&args[1]);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, nextRowset)
{
    ZEND_PARSE_PARAMETERS_NONE(); RETURN_FALSE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, getIterator)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (orm_pgsql_statement_iterator(ZEND_THIS, return_value) != SUCCESS) {
        if (EG(exception) == NULL) pg_raise("cannot create PostgreSQL statement iterator");
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlStatementAdapter, debugDumpParams)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval bindings_rv, types_rv, refs_rv, ref_types_rv, sql_rv;
    zval *bindings = pg_prop(ZEND_THIS, "bindings", &bindings_rv);
    zval *types = pg_prop(ZEND_THIS, "bindingTypes", &types_rv);
    zval *refs = pg_prop(ZEND_THIS, "boundRefs", &refs_rv);
    zval *ref_types = pg_prop(ZEND_THIS, "boundRefTypes", &ref_types_rv);
    zval *sql = pg_prop(ZEND_THIS, "sourceSql", &sql_rv);
    zval parameters;
    array_init(&parameters);
    if (bindings != NULL && Z_TYPE_P(bindings) == IS_ARRAY) {
        zend_string *key; zend_ulong index; zval *value;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(bindings), index, key, value) {
            zval copy; ZVAL_COPY(&copy, value);
            if (key == NULL) zend_hash_index_update(Z_ARRVAL(parameters), index, &copy);
            else zend_hash_update(Z_ARRVAL(parameters), key, &copy);
        } ZEND_HASH_FOREACH_END();
    }
    if (refs != NULL && Z_TYPE_P(refs) == IS_ARRAY) {
        zend_string *key; zend_ulong index; zval *value;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(refs), index, key, value) {
            zval copy; ZVAL_COPY_DEREF(&copy, value);
            if (key == NULL) zend_hash_index_update(Z_ARRVAL(parameters), index, &copy);
            else zend_hash_update(Z_ARRVAL(parameters), key, &copy);
        } ZEND_HASH_FOREACH_END();
    }
    ZVAL_MAKE_REF(&parameters);
    zval sorted;
    if (!pg_call_function("ksort", &sorted, 1, &parameters)) {
        zval_ptr_dtor(&parameters);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&sorted);
    zval *parameter_array = Z_REFVAL(parameters);
    smart_str output = {0};
    smart_str_appends(&output, "SQL: [");
    size_t sql_length = sql != NULL && Z_TYPE_P(sql) == IS_STRING ? Z_STRLEN_P(sql) : 0;
    smart_str_append_long(&output, sql_length);
    smart_str_appends(&output, "] ");
    if (sql != NULL && Z_TYPE_P(sql) == IS_STRING) smart_str_append(&output, Z_STR_P(sql));
    smart_str_appends(&output, "\nParams:  ");
    smart_str_append_long(&output, zend_hash_num_elements(Z_ARRVAL_P(parameter_array)));
    smart_str_appendc(&output, '\n');
    zend_string *key; zend_ulong index; zval *value;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(parameter_array), index, key, value) {
        (void) value;
        zval *type = NULL;
        if (key == NULL) {
            if (types != NULL && Z_TYPE_P(types) == IS_ARRAY) type = zend_hash_index_find(Z_ARRVAL_P(types), index);
            if (type == NULL && ref_types != NULL && Z_TYPE_P(ref_types) == IS_ARRAY) type = zend_hash_index_find(Z_ARRVAL_P(ref_types), index);
            smart_str_appends(&output, "Key: Position #");
            smart_str_append_long(&output, index);
            smart_str_appends(&output, ":\nparamno=");
            smart_str_append_long(&output, index);
            smart_str_appends(&output, "\nname=[0] \"\"\n");
        } else {
            if (types != NULL && Z_TYPE_P(types) == IS_ARRAY) type = zend_hash_find(Z_ARRVAL_P(types), key);
            if (type == NULL && ref_types != NULL && Z_TYPE_P(ref_types) == IS_ARRAY) type = zend_hash_find(Z_ARRVAL_P(ref_types), key);
            zend_string *name = strpprintf(0, ":%s", ZSTR_VAL(key));
            smart_str_appends(&output, "Key: Name: [");
            smart_str_append_long(&output, ZSTR_LEN(name));
            smart_str_appends(&output, "] ");
            smart_str_append(&output, name);
            smart_str_appends(&output, "\nparamno=");
            smart_str_append(&output, key);
            smart_str_appends(&output, "\nname=[");
            smart_str_append_long(&output, ZSTR_LEN(name));
            smart_str_appends(&output, "] \"");
            smart_str_append(&output, name);
            smart_str_appends(&output, "\"\n");
            zend_string_release(name);
        }
        smart_str_appends(&output, "is_param=1\nparam_type=");
        smart_str_append_long(&output, type == NULL ? pg_value_long("PDO::PARAM_STR", 2) : zval_get_long(type));
        smart_str_appendc(&output, '\n');
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&output);
    if (output.s != NULL) PHPWRITE(ZSTR_VAL(output.s), ZSTR_LEN(output.s));
    smart_str_free(&output);
    zval_ptr_dtor(&parameters);
    RETURN_NULL();
}

static bool pg_copy_append_quoted_identifier(smart_str *out, zval *connection, const char *text, size_t length)
{
    zval args[2], quoted; ZVAL_COPY(&args[0], connection); ZVAL_STRINGL(&args[1], text, length);
    if (!pg_call_function("pg_escape_identifier", &quoted, 2, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); return false; }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (Z_TYPE(quoted) != IS_STRING) { zval_ptr_dtor(&quoted); return false; }
    smart_str_append(out, Z_STR(quoted)); zval_ptr_dtor(&quoted); return true;
}

static zend_string *pg_copy_quote_table(zval *connection, zend_string *table)
{
    smart_str out = {0}; size_t start = 0;
    for (size_t i = 0; i <= ZSTR_LEN(table); i++) {
        if (i != ZSTR_LEN(table) && ZSTR_VAL(table)[i] != '.') continue;
        if (i == start || !pg_copy_append_quoted_identifier(&out, connection, ZSTR_VAL(table) + start, i - start)) { smart_str_free(&out); return NULL; }
        if (i != ZSTR_LEN(table)) smart_str_appends(&out, ".");
        start = i + 1;
    }
    smart_str_0(&out); return out.s;
}

static bool pg_copy_append_fields(smart_str *out, zval *connection, zend_string *fields)
{
    size_t start = 0; bool first = true;
    for (size_t i = 0; i <= ZSTR_LEN(fields); i++) {
        if (i != ZSTR_LEN(fields) && ZSTR_VAL(fields)[i] != ',') continue;
        size_t left = start, right = i;
        while (left < right && (ZSTR_VAL(fields)[left] == ' ' || ZSTR_VAL(fields)[left] == '\t')) left++;
        while (right > left && (ZSTR_VAL(fields)[right - 1] == ' ' || ZSTR_VAL(fields)[right - 1] == '\t')) right--;
        if (left == right) return false;
        if (!first) smart_str_appends(out, ", ");
        if (!pg_copy_append_quoted_identifier(out, connection, ZSTR_VAL(fields) + left, right - left)) return false;
        first = false; start = i + 1;
    }
    return !first;
}

static bool pg_copy_query(zval *connection, zend_string *query, zval *result)
{
    zval args[2]; ZVAL_COPY(&args[0], connection); ZVAL_STR_COPY(&args[1], query);
    if (!pg_call_function("pg_query", result, 2, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); return false; }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, copyFromArray)
{
    zend_string *table, *separator = NULL, *null_as = NULL, *fields = NULL; zval *rows;
    ZEND_PARSE_PARAMETERS_START(2, 5)
        Z_PARAM_STR(table) Z_PARAM_ARRAY(rows)
        Z_PARAM_OPTIONAL Z_PARAM_STR(separator) Z_PARAM_STR(null_as) Z_PARAM_STR_OR_NULL(fields)
    ZEND_PARSE_PARAMETERS_END();
    if (separator == NULL) separator = zend_string_init("\t", 1, 0); else zend_string_addref(separator);
    if (null_as == NULL) null_as = zend_string_init("\\N", 2, 0); else zend_string_addref(null_as);
    zval connection; if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    if (fields == NULL) {
        zval args[5], result; ZVAL_COPY(&args[0], &connection); ZVAL_STR_COPY(&args[1], table); ZVAL_COPY(&args[2], rows); ZVAL_STR_COPY(&args[3], separator); ZVAL_STR_COPY(&args[4], null_as);
        if (!pg_call_function("pg_copy_from", &result, 5, args)) { for (int i = 0; i < 5; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); RETURN_THROWS(); }
        for (int i = 0; i < 5; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); RETURN_ZVAL(&result, 1, 1);
    }
    if (ZSTR_LEN(separator) != 1) { zval_ptr_dtor(&connection); zend_value_error("PostgreSQL COPY delimiter must be one byte"); RETURN_THROWS(); }
    smart_str query = {0}; smart_str_appends(&query, "COPY ");
    zend_string *quoted_table = pg_copy_quote_table(&connection, table);
    if (quoted_table == NULL) { zval_ptr_dtor(&connection); pg_raise("invalid PostgreSQL COPY table name"); RETURN_THROWS(); }
    smart_str_append(&query, quoted_table); zend_string_release(quoted_table); smart_str_appends(&query, " (");
    if (!pg_copy_append_fields(&query, &connection, fields)) { smart_str_free(&query); zval_ptr_dtor(&connection); pg_raise("invalid PostgreSQL COPY field list"); RETURN_THROWS(); }
    smart_str_appends(&query, ") FROM STDIN WITH (FORMAT text, DELIMITER ");
    zval escape_args[2], delimiter_lit, null_lit; ZVAL_COPY(&escape_args[0], &connection); ZVAL_STR_COPY(&escape_args[1], separator);
    if (!pg_call_function("pg_escape_literal", &delimiter_lit, 2, escape_args)) { zval_ptr_dtor(&escape_args[0]); zval_ptr_dtor(&escape_args[1]); smart_str_free(&query); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&escape_args[1]); ZVAL_STR_COPY(&escape_args[1], null_as);
    if (!pg_call_function("pg_escape_literal", &null_lit, 2, escape_args)) { zval_ptr_dtor(&escape_args[0]); zval_ptr_dtor(&escape_args[1]); zval_ptr_dtor(&delimiter_lit); smart_str_free(&query); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&escape_args[0]); zval_ptr_dtor(&escape_args[1]); smart_str_append(&query, Z_STR(delimiter_lit)); smart_str_appends(&query, ", NULL "); smart_str_append(&query, Z_STR(null_lit)); smart_str_appendc(&query, ')'); smart_str_0(&query); zval_ptr_dtor(&delimiter_lit); zval_ptr_dtor(&null_lit);
    zval started; if (!pg_copy_query(&connection, query.s, &started)) { smart_str_free(&query); zval_ptr_dtor(&connection); RETURN_THROWS(); } smart_str_free(&query);
    zend_long copy_in = pg_value_long("PGSQL_COPY_IN", 4); zval status_arg, status; ZVAL_COPY(&status_arg, &started);
    if (!pg_call_function("pg_result_status", &status, 1, &status_arg)) { zval_ptr_dtor(&status_arg); zval_ptr_dtor(&started); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&status_arg); bool copying = Z_TYPE(status) == IS_LONG && Z_LVAL(status) == copy_in; zval_ptr_dtor(&status); zval free_arg, freed; ZVAL_COPY(&free_arg, &started); if (pg_call_function("pg_free_result", &freed, 1, &free_arg)) zval_ptr_dtor(&freed); zval_ptr_dtor(&free_arg); zval_ptr_dtor(&started);
    if (!copying) { zval_ptr_dtor(&connection); pg_raise("PostgreSQL COPY FROM did not start"); RETURN_THROWS(); }
    zval *row; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        zend_string *line = zval_get_string(row);
        if (EG(exception) != NULL) { zval_ptr_dtor(&connection); zend_string_release(line); RETURN_THROWS(); }
        zend_string *with_newline = strpprintf(0, "%s\n", ZSTR_VAL(line)); zend_string_release(line);
        zval args[2], result; ZVAL_COPY(&args[0], &connection); ZVAL_STR(&args[1], with_newline);
        if (!pg_call_function("pg_put_line", &result, 2, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&connection); RETURN_THROWS(); }
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); bool ok = zend_is_true(&result); zval_ptr_dtor(&result);
        if (!ok) { zval_ptr_dtor(&connection); pg_raise("PostgreSQL COPY FROM failed"); RETURN_THROWS(); }
    } ZEND_HASH_FOREACH_END();
    zval end_arg, ended; ZVAL_COPY(&end_arg, &connection);
    if (!pg_call_function("pg_end_copy", &ended, 1, &end_arg)) { zval_ptr_dtor(&end_arg); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&end_arg); zval_ptr_dtor(&connection); RETURN_ZVAL(&ended, 1, 1);
}

/* The arguments table, filename, separator, null_as and fields of copyFromFile and copyToFile; false with the
 * argument error thrown. */
static bool pg_copy_file_args(zend_execute_data *execute_data, zend_string **table, zend_string **filename,
    zend_string **separator, zend_string **null_as, zend_string **fields)
{
    ZEND_PARSE_PARAMETERS_START(2, 5)
        Z_PARAM_STR(*table) Z_PARAM_STR(*filename) Z_PARAM_OPTIONAL Z_PARAM_STR(*separator) Z_PARAM_STR(*null_as)
        Z_PARAM_STR_OR_NULL(*fields)
    ZEND_PARSE_PARAMETERS_END_EX(return false);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, copyFromFile)
{
    zend_string *table, *filename, *separator = NULL, *null_as = NULL, *fields = NULL;
    if (!pg_copy_file_args(execute_data, &table, &filename, &separator, &null_as, &fields)) RETURN_THROWS();
    zval args[1], contents; ZVAL_STR_COPY(&args[0], filename);
    if (!pg_call_function("file_get_contents", &contents, 1, args)) { zval_ptr_dtor(&args[0]); RETURN_THROWS(); }
    zval_ptr_dtor(&args[0]);
    if (Z_TYPE(contents) != IS_STRING) { zval_ptr_dtor(&contents); zend_throw_exception_ex(zend_ce_exception, 0, "cannot read PostgreSQL COPY file %s", ZSTR_VAL(filename)); RETURN_THROWS(); }
    zval rows; array_init(&rows); const char *data = Z_STRVAL(contents); size_t length = Z_STRLEN(contents), start = 0;
    for (size_t i = 0; i <= length; i++) {
        if (i != length && data[i] != '\n' && data[i] != '\r') continue;
        if (i == length || i > start) add_next_index_stringl(&rows, data + start, i - start);
        if (i < length && data[i] == '\r' && i + 1 < length && data[i + 1] == '\n') i++;
        start = i + 1;
    }
    if (length > 0 && (data[length - 1] == '\n' || data[length - 1] == '\r') && zend_hash_num_elements(Z_ARRVAL(rows)) > 0) zend_hash_index_del(Z_ARRVAL(rows), zend_hash_num_elements(Z_ARRVAL(rows)) - 1);
    zval_ptr_dtor(&contents);
    if (separator == NULL) separator = zend_string_init("\t", 1, 0); else zend_string_addref(separator);
    if (null_as == NULL) null_as = zend_string_init("\\N", 2, 0); else zend_string_addref(null_as);
    zval call_args[5]; ZVAL_STR_COPY(&call_args[0], table); ZVAL_COPY_VALUE(&call_args[1], &rows); ZVAL_STR(&call_args[2], separator); ZVAL_STR(&call_args[3], null_as); if (fields == NULL) ZVAL_NULL(&call_args[4]); else ZVAL_STR_COPY(&call_args[4], fields);
    if (!pg_call_method(ZEND_THIS, "copyFromArray", return_value, 5, call_args)) { for (int i = 0; i < 5; i++) zval_ptr_dtor(&call_args[i]); RETURN_THROWS(); }
    for (int i = 0; i < 5; i++) zval_ptr_dtor(&call_args[i]);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, copyToArray)
{
    zend_string *table, *separator = NULL, *null_as = NULL, *fields = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 4)
        Z_PARAM_STR(table) Z_PARAM_OPTIONAL Z_PARAM_STR(separator) Z_PARAM_STR(null_as) Z_PARAM_STR_OR_NULL(fields)
    ZEND_PARSE_PARAMETERS_END();
    if (separator == NULL) separator = zend_string_init("\t", 1, 0); else zend_string_addref(separator);
    if (null_as == NULL) null_as = zend_string_init("\\N", 2, 0); else zend_string_addref(null_as);
    zval connection; if (!pg_get_connection(ZEND_THIS, &connection)) { zend_string_release(separator); zend_string_release(null_as); RETURN_THROWS(); }
    if (fields == NULL) {
        zval args[4], result; ZVAL_COPY(&args[0], &connection); ZVAL_STR_COPY(&args[1], table); ZVAL_STR_COPY(&args[2], separator); ZVAL_STR_COPY(&args[3], null_as);
        if (!pg_call_function("pg_copy_to", &result, 4, args)) { for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); RETURN_THROWS(); }
        for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); RETURN_ZVAL(&result, 1, 1);
    }
    if (ZSTR_LEN(separator) != 1) { zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); zend_value_error("PostgreSQL COPY delimiter must be one byte"); RETURN_THROWS(); }
    smart_str query = {0}; smart_str_appends(&query, "SELECT ");
    if (!pg_copy_append_fields(&query, &connection, fields)) { smart_str_free(&query); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); pg_raise("invalid PostgreSQL COPY field list"); RETURN_THROWS(); }
    smart_str_appends(&query, " FROM "); zend_string *quoted_table = pg_copy_quote_table(&connection, table);
    if (quoted_table == NULL) { smart_str_free(&query); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); pg_raise("invalid PostgreSQL COPY table name"); RETURN_THROWS(); }
    smart_str_append(&query, quoted_table); zend_string_release(quoted_table); smart_str_0(&query);
    zval args[3], result, params; ZVAL_STR(&args[0], query.s); array_init(&params); ZVAL_COPY_VALUE(&args[1], &params); ZVAL_TRUE(&args[2]);
    if (!pg_call_method(ZEND_THIS, "executeSql", &result, 3, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); RETURN_THROWS(); }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    zval num_arg, num_rows; ZVAL_COPY(&num_arg, &result);
    if (!pg_call_function("pg_num_rows", &num_rows, 1, &num_arg)) { zval_ptr_dtor(&num_arg); zval_ptr_dtor(&result); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); RETURN_THROWS(); }
    zval_ptr_dtor(&num_arg); array_init_size(return_value, zval_get_long(&num_rows)); zval_ptr_dtor(&num_rows);
    zval narg, nfields; ZVAL_COPY(&narg, &result);
    if (!pg_call_function("pg_num_fields", &nfields, 1, &narg)) { zval_ptr_dtor(&narg); zval_ptr_dtor(&result); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); zval_ptr_dtor(return_value); RETURN_THROWS(); }
    zval_ptr_dtor(&narg); zend_long count = zval_get_long(&nfields); zval_ptr_dtor(&nfields);
    while (1) {
        zval fetch_arg, row; ZVAL_COPY(&fetch_arg, &result);
        if (!pg_call_function("pg_fetch_row", &row, 1, &fetch_arg)) { zval_ptr_dtor(&fetch_arg); zval_ptr_dtor(&result); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); zval_ptr_dtor(return_value); RETURN_THROWS(); }
        zval_ptr_dtor(&fetch_arg);
        if (Z_TYPE(row) != IS_ARRAY) { zval_ptr_dtor(&row); break; }
        smart_str line = {0};
        for (zend_long i = 0; i < count; i++) {
            if (i > 0) smart_str_append(&line, separator);
            zval *value = zend_hash_index_find(Z_ARRVAL(row), i);
            if (value == NULL || Z_TYPE_P(value) == IS_NULL) smart_str_append(&line, null_as);
            else {
                zend_string *text = zval_get_string(value);
                if (EG(exception) != NULL) { zend_string_release(text); zval_ptr_dtor(&row); smart_str_free(&line); zval_ptr_dtor(&result); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as); zval_ptr_dtor(return_value); RETURN_THROWS(); }
                if (zend_string_equals(text, null_as)) smart_str_appendc(&line, '\\');
                for (size_t j = 0; j < ZSTR_LEN(text); j++) {
                    char c = ZSTR_VAL(text)[j];
                    if (c == '\\') smart_str_appends(&line, "\\\\");
                    else if (c == '\n') smart_str_appends(&line, "\\n");
                    else if (c == '\r') smart_str_appends(&line, "\\r");
                    else if (c == ZSTR_VAL(separator)[0]) { smart_str_appendc(&line, '\\'); smart_str_appendc(&line, c); }
                    else smart_str_appendc(&line, c);
                }
                zend_string_release(text);
            }
        }
        smart_str_0(&line); if (line.s == NULL) line.s = ZSTR_EMPTY_ALLOC(); add_next_index_str(return_value, line.s); zval_ptr_dtor(&row);
    }
    zval_ptr_dtor(&result); zval_ptr_dtor(&connection); zend_string_release(separator); zend_string_release(null_as);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, copyToFile)
{
    zend_string *table, *filename, *separator = NULL, *null_as = NULL, *fields = NULL;
    if (!pg_copy_file_args(execute_data, &table, &filename, &separator, &null_as, &fields)) RETURN_THROWS();
    if (separator == NULL) separator = zend_string_init("\t", 1, 0); else zend_string_addref(separator);
    if (null_as == NULL) null_as = zend_string_init("\\N", 2, 0); else zend_string_addref(null_as);
    zval args[4], rows; ZVAL_STR_COPY(&args[0], table); ZVAL_STR(&args[1], separator); ZVAL_STR(&args[2], null_as); if (fields == NULL) ZVAL_NULL(&args[3]); else ZVAL_STR_COPY(&args[3], fields);
    if (!pg_call_method(ZEND_THIS, "copyToArray", &rows, 4, args)) { for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]); RETURN_THROWS(); }
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    if (Z_TYPE(rows) != IS_ARRAY) { zval_ptr_dtor(&rows); RETURN_FALSE; }
    smart_str contents = {0}; zval *row; ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row) { zend_string *text = zval_get_string(row); if (EG(exception) != NULL) { zend_string_release(text); smart_str_free(&contents); zval_ptr_dtor(&rows); RETURN_THROWS(); } smart_str_append(&contents, text); smart_str_appendc(&contents, '\n'); zend_string_release(text); } ZEND_HASH_FOREACH_END();
    smart_str_0(&contents); if (contents.s == NULL) contents.s = ZSTR_EMPTY_ALLOC(); zval write_args[2], written; ZVAL_STR_COPY(&write_args[0], filename); ZVAL_STR(&write_args[1], contents.s);
    if (!pg_call_function("file_put_contents", &written, 2, write_args)) { zval_ptr_dtor(&write_args[0]); zval_ptr_dtor(&write_args[1]); zval_ptr_dtor(&rows); RETURN_THROWS(); }
    zval_ptr_dtor(&write_args[0]); zval_ptr_dtor(&write_args[1]); zval_ptr_dtor(&rows);
    if (Z_TYPE(written) == IS_FALSE) { zval_ptr_dtor(&written); zend_throw_exception_ex(zend_ce_exception, 0, "cannot write PostgreSQL COPY file %s", ZSTR_VAL(filename)); RETURN_THROWS(); }
    zval_ptr_dtor(&written); RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, lobCreate)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval connection, result; if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS();
    if (!pg_call_function("pg_lo_create", &result, 1, &connection)) { zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zval_ptr_dtor(&connection); if (Z_TYPE(result) == IS_FALSE) RETURN_ZVAL(&result, 1, 1);
    zend_string *text = zval_get_string(&result); zval_ptr_dtor(&result); RETVAL_STR(text);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, lobOpen)
{
    zend_string *oid, *mode; ZEND_PARSE_PARAMETERS_START(1, 2) Z_PARAM_STR(oid) Z_PARAM_OPTIONAL Z_PARAM_STR(mode) ZEND_PARSE_PARAMETERS_END();
    if (mode == NULL) mode = zend_string_init("rb", 2, 0); else zend_string_addref(mode);
    zval connection, args[3], lob; if (!pg_get_connection(ZEND_THIS, &connection)) { zend_string_release(mode); RETURN_THROWS(); }
    ZVAL_COPY(&args[0], &connection); ZVAL_STR_COPY(&args[1], oid); ZVAL_STR(&args[2], mode);
    if (!pg_call_function("pg_lo_open", &lob, 3, args)) { for (int i = 0; i < 3; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    for (int i = 0; i < 3; i++) zval_ptr_dtor(&args[i]);
    if (Z_TYPE(lob) == IS_FALSE) { zval_ptr_dtor(&connection); RETURN_ZVAL(&lob, 1, 1); }
    if (orm_pgsql_lob_stream(&lob, return_value) != SUCCESS) {
        zval close_arg, close_result; ZVAL_COPY(&close_arg, &lob);
        if (pg_call_function("pg_lo_close", &close_result, 1, &close_arg)) zval_ptr_dtor(&close_result);
        zval_ptr_dtor(&close_arg); zval_ptr_dtor(&lob); zval_ptr_dtor(&connection); zend_string_release(mode);
        pg_raise("cannot create PostgreSQL large-object stream"); RETURN_THROWS();
    }
    zval_ptr_dtor(&connection); zval_ptr_dtor(&lob); zend_string_release(mode);
}

ZEND_METHOD(Polyspec_Orm_Internal_PgsqlPdoAdapter, lobUnlink)
{
    zend_string *oid; ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(oid) ZEND_PARSE_PARAMETERS_END(); zval connection, args[2];
    if (!pg_get_connection(ZEND_THIS, &connection)) RETURN_THROWS(); ZVAL_COPY(&args[0], &connection); ZVAL_STR_COPY(&args[1], oid); zval_ptr_dtor(&connection);
    if (!pg_call_function("pg_lo_unlink", return_value, 2, args)) ZVAL_UNDEF(return_value); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
}

void pgsql_adapter_native_register(zend_class_entry *adapter_ce, zend_class_entry *statement_ce)
{
    pgsql_adapter_ce = adapter_ce;
    pgsql_statement_ce = statement_ce;
}

bool pgsql_adapter_native_is_adapter(zval *value)
{
    return value != NULL && Z_TYPE_P(value) == IS_OBJECT && pgsql_adapter_ce != NULL && instanceof_function(Z_OBJCE_P(value), pgsql_adapter_ce);
}
