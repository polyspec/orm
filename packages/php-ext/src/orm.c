/* The native connection factory and the value-function constructors of Polyspec\\Orm\\Orm. */
#include "dbspec.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_closures.h"
#include "main/php_streams.h"

static bool orm_connect_markdown(zend_string *dsn, zval *config, zval *out);
static bool markdown_session_dial(zend_string *address, zend_string *corpus, zend_string *token, zval *out);
static bool markdown_session_call(zval *self, zval *message, zval *out);
static void markdown_session_close(zval *self);
static bool orm_connect_sql(zend_string *dsn, zval *config, zval *out, bool listener);
static bool orm_decoded(zval *input, bool raw, zval *out);
static bool orm_query_decode(const char *value, size_t length, zval *out);

ZEND_NAMED_FUNCTION(orm_listener_open)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv_dsn, rv_config;
    zval *dsn = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "dsn", sizeof("dsn") - 1, true, &rv_dsn);
    zval *config = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "config", sizeof("config") - 1, true, &rv_config);
    if (dsn == NULL || Z_TYPE_P(dsn) != IS_STRING || config == NULL || Z_TYPE_P(config) != IS_OBJECT) {
        zend_throw_error(NULL, "invalid native listener connection state");
        RETURN_THROWS();
    }
    zval db;
    if (!orm_connect_sql(Z_STR_P(dsn), config, &db, true)) RETURN_THROWS();
    zval pdo;
    if (!pdo_call(&db, "pdo", &pdo, 0, NULL, NULL)) {
        zval_ptr_dtor(&db);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&db);
    ZVAL_COPY_VALUE(return_value, &pdo);
}

static void orm_func(zval *out, const char *name, uint32_t argc, zval *args, bool column)
{
    zval ctor[3];
    ZVAL_STRING(&ctor[0], name);
    array_init(&ctor[1]);
    for (uint32_t i = 0; i < argc; i++) {
        zval v;
        ZVAL_COPY(&v, &args[i]);
        add_next_index_zval(&ctor[1], &v);
    }
    ZVAL_BOOL(&ctor[2], column);
    if (!newobj("Polyspec\\Orm\\Func", out, 3, ctor)) {
        ZVAL_UNDEF(out);
    }
    zval_ptr_dtor(&ctor[0]);
    zval_ptr_dtor(&ctor[1]);
}

#define ORM_FUNC0(method, value) \
    ZEND_METHOD(Polyspec_Orm_Orm, method) { \
        ZEND_PARSE_PARAMETERS_NONE(); \
        orm_func(return_value, value, 0, NULL, false); \
    }
#define ORM_FUNC1(method, value) \
    ZEND_METHOD(Polyspec_Orm_Orm, method) { \
        zend_long n; \
        ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(n) ZEND_PARSE_PARAMETERS_END(); \
        zval arg; ZVAL_LONG(&arg, n); \
        orm_func(return_value, value, 1, &arg, false); \
    }
#define ORM_COLUMN_FUNC0(method, value) \
    ZEND_METHOD(Polyspec_Orm_Orm, method) { \
        ZEND_PARSE_PARAMETERS_NONE(); \
        orm_func(return_value, value, 0, NULL, true); \
    }

ORM_FUNC0(now, "now")
ORM_FUNC0(today, "today")
ORM_FUNC1(secondsAgo, "seconds_ago")
ORM_FUNC1(minutesAgo, "minutes_ago")
ORM_FUNC1(hoursAgo, "hours_ago")
ORM_FUNC1(daysAgo, "days_ago")
ORM_FUNC1(monthsAgo, "months_ago")
ORM_FUNC1(secondsLater, "seconds_later")
ORM_FUNC1(minutesLater, "minutes_later")
ORM_FUNC1(hoursLater, "hours_later")
ORM_FUNC1(daysLater, "days_later")
ORM_FUNC1(monthsLater, "months_later")
ORM_COLUMN_FUNC0(dayOfWeek, "day_of_week")
ORM_COLUMN_FUNC0(year, "year")
ORM_COLUMN_FUNC0(month, "month")
ORM_COLUMN_FUNC0(date, "date")

ZEND_METHOD(Polyspec_Orm_Orm, transactionConflict)
{
    zend_string *message;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(message)
    ZEND_PARSE_PARAMETERS_END();
    zval args[2];
    ZVAL_STRING(&args[0], "DEADLOCK");
    ZVAL_STR_COPY(&args[1], message);
    if (!newobj("Polyspec\\Orm\\OrmException", return_value, 2, args)) {
        ZVAL_UNDEF(return_value);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
}

static bool orm_parse_url(zend_string *dsn, zval *parts)
{
    zval arg;
    const char *separator = strstr(ZSTR_VAL(dsn), ":///");
    if (separator != NULL) {
        size_t scheme_len = (size_t)(separator - ZSTR_VAL(dsn));
        smart_str normalized = {0};
        smart_str_appendl(&normalized, ZSTR_VAL(dsn), scheme_len);
        smart_str_appends(&normalized, "://localhost/");
        smart_str_appendl(&normalized, separator + 4, ZSTR_LEN(dsn) - scheme_len - 4);
        smart_str_0(&normalized);
        ZVAL_STR(&arg, normalized.s);
    } else {
        ZVAL_STR_COPY(&arg, dsn);
    }
    bool ok = scall("parse_url", parts, 1, &arg);
    zval_ptr_dtor(&arg);
    if (!ok || Z_TYPE_P(parts) != IS_ARRAY) {
        if (EG(exception) != NULL) zend_clear_exception();
        db_throw_orm("CONFIG", "invalid DSN URI");
        return false;
    }
    return true;
}

static zval *orm_part(zval *parts, const char *name)
{
    zval *v = zend_hash_str_find(Z_ARRVAL_P(parts), name, strlen(name));
    return v != NULL && Z_TYPE_P(v) != IS_NULL ? v : NULL;
}

static bool orm_scheme(zend_string *dsn, zend_string **scheme)
{
    const char *p = ZSTR_VAL(dsn);
    size_t n = ZSTR_LEN(dsn), end = 0;
    while (end < n && p[end] != ':' && ((p[end] >= 'A' && p[end] <= 'Z') || (p[end] >= 'a' && p[end] <= 'z')
           || (end > 0 && ((p[end] >= '0' && p[end] <= '9') || p[end] == '+' || p[end] == '.' || p[end] == '-')))) end++;
    if (end == 0 || end + 2 >= n || p[end] != ':' || p[end + 1] != '/' || p[end + 2] != '/') {
        db_throw_orm("CONFIG", "dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://");
        return false;
    }
    *scheme = zend_string_init(p, end, 0);
    zend_str_tolower(ZSTR_VAL(*scheme), ZSTR_LEN(*scheme));
    return true;
}

static bool orm_query(zval *parts, zval *query)
{
    zval *raw = orm_part(parts, "query");
    if (raw == NULL || Z_TYPE_P(raw) != IS_STRING) {
        array_init(query);
        return true;
    }
    zval args[2], result;
    ZVAL_COPY(&args[0], raw);
    array_init(&args[1]);
    ZVAL_MAKE_REF(&args[1]);
    bool ok = scall("parse_str", &result, 2, args);
    zval_ptr_dtor(&args[0]);
    if (ok) zval_ptr_dtor(&result);
    ZVAL_UNREF(&args[1]);
    ZVAL_COPY_VALUE(query, &args[1]);
    return ok && Z_TYPE_P(query) == IS_ARRAY;
}

static zval *orm_query_value(zval *query, const char *key)
{
    zval *v = zend_hash_str_find(Z_ARRVAL_P(query), key, strlen(key));
    return v != NULL && Z_TYPE_P(v) != IS_NULL ? v : NULL;
}

typedef struct {
    const char *key;
    size_t key_length;
    const char *value;
    size_t value_length;
} orm_query_parameter;

static bool orm_query_next(const char *query, size_t length, size_t *position, orm_query_parameter *parameter)
{
    while (*position < length) {
        size_t start = *position, end = start;
        while (end < length && query[end] != '&') end++;
        *position = end < length ? end + 1 : length;
        if (end == start) continue;
        const char *equals = memchr(query + start, '=', end - start);
        parameter->key = query + start;
        parameter->key_length = equals == NULL ? end - start : (size_t)(equals - parameter->key);
        parameter->value = equals == NULL ? query + end : equals + 1;
        parameter->value_length = equals == NULL ? 0 : (size_t)(query + end - parameter->value);
        return true;
    }
    return false;
}

typedef bool (*orm_query_visitor)(const orm_query_parameter *parameter, void *context);

static bool orm_query_visit(zval *parts, orm_query_visitor visit, void *context)
{
    zval *raw = orm_part(parts, "query");
    if (raw == NULL || Z_TYPE_P(raw) != IS_STRING) return true;
    const char *p = Z_STRVAL_P(raw);
    size_t position = 0;
    orm_query_parameter parameter;
    while (orm_query_next(p, Z_STRLEN_P(raw), &position, &parameter)) {
        if (!visit(&parameter, context)) return false;
    }
    return true;
}

static bool orm_decoded(zval *input, bool raw, zval *out)
{
    zval arg;
    ZVAL_COPY(&arg, input);
    bool ok = scall(raw ? "rawurldecode" : "urldecode", out, 1, &arg);
    zval_ptr_dtor(&arg);
    return ok && Z_TYPE_P(out) == IS_STRING;
}

static bool orm_query_decode(const char *value, size_t length, zval *out)
{
    zval encoded;
    ZVAL_STRINGL(&encoded, value, length);
    bool ok = orm_decoded(&encoded, false, out);
    zval_ptr_dtor(&encoded);
    return ok;
}

typedef struct {
    const char *driver;
    const char *const *allowed;
    size_t count;
} orm_query_allowed_context;

static bool orm_query_allow(const orm_query_parameter *parameter, void *context)
{
    orm_query_allowed_context *allowed = context;
    zval decoded;
    if (!orm_query_decode(parameter->key, parameter->key_length, &decoded)) return false;
    bool found = false;
    for (size_t k = 0; k < allowed->count; k++) {
        if (Z_STRLEN(decoded) == strlen(allowed->allowed[k])
            && memcmp(Z_STRVAL(decoded), allowed->allowed[k], Z_STRLEN(decoded)) == 0) found = true;
    }
    if (!found) {
        smart_str accepted = {0};
        for (size_t k = 0; k < allowed->count; k++) {
            if (k != 0) smart_str_appends(&accepted, ", ");
            smart_str_appends(&accepted, allowed->allowed[k]);
        }
        smart_str_0(&accepted);
        db_throw_orm("CONFIG", "%s DSN has the unknown parameter %s; it accepts %s",
            allowed->driver, Z_STRVAL(decoded), ZSTR_VAL(accepted.s));
        smart_str_free(&accepted);
        zval_ptr_dtor(&decoded);
        return false;
    }
    zval_ptr_dtor(&decoded);
    return true;
}

static bool orm_query_allowed(zval *parts, const char *driver, const char *const *keys, size_t count)
{
    orm_query_allowed_context context = {driver, keys, count};
    return orm_query_visit(parts, orm_query_allow, &context);
}

static bool orm_sqlite_pragma(const orm_query_parameter *parameter, void *context)
{
    zval *out = context;
    zval key;
    if (!orm_query_decode(parameter->key, parameter->key_length, &key)) return false;
    if (zend_string_equals_literal(Z_STR(key), "_pragma")) {
        zval value;
        if (!orm_query_decode(parameter->value, parameter->value_length, &value)) { zval_ptr_dtor(&key); return false; }
        const char *text = Z_STRVAL(value);
        size_t len = Z_STRLEN(value), open = 0;
        while (open < len && ((text[open] >= 'a' && text[open] <= 'z') || text[open] == '_')) open++;
        bool valid = open > 0 && open + 2 < len && text[open] == '(' && text[len - 1] == ')';
        for (size_t j = open + 1; valid && j + 1 < len; j++) {
            if (!((text[j] >= 'A' && text[j] <= 'Z') || (text[j] >= 'a' && text[j] <= 'z')
                  || (text[j] >= '0' && text[j] <= '9') || text[j] == '_')) valid = false;
        }
        if (!valid) {
            zend_string *bad = zend_string_copy(Z_STR(value));
            zval_ptr_dtor(&value); zval_ptr_dtor(&key);
            db_throw_orm("CONFIG", "sqlite DSN _pragma %s is invalid", ZSTR_VAL(bad));
            zend_string_release(bad);
            return false;
        }
        zval pair;
        array_init(&pair);
        add_next_index_stringl(&pair, text, open);
        add_next_index_stringl(&pair, text + open + 1, len - open - 2);
        add_next_index_zval(out, &pair);
        zval_ptr_dtor(&value);
    }
    zval_ptr_dtor(&key);
    return true;
}

static bool orm_sqlite_pragmas(zval *parts, zval *out)
{
    return orm_query_visit(parts, orm_sqlite_pragma, out);
}

static bool orm_parse_dsn(zend_string *dsn, zval *out)
{
    zend_string *scheme = NULL;
    if (!orm_scheme(dsn, &scheme)) return false;
    if (zend_string_equals_literal(scheme, "markdown")) {
        db_throw_orm("CONFIG", "a markdown DSN selects the markdown IR executor and has no PDO DSN; read it with parseMarkdownDsn");
        zend_string_release(scheme);
        return false;
    }
    const char *driver = ZSTR_VAL(scheme);
    if (!zend_string_equals_literal(scheme, "mysql") && !zend_string_equals_literal(scheme, "postgres")
        && !zend_string_equals_literal(scheme, "sqlite")) {
        db_throw_orm("CONFIG", "unsupported DSN scheme %s; want mysql, postgres, sqlite, or markdown", driver);
        zend_string_release(scheme);
        return false;
    }
    zval parts, query;
    ZVAL_UNDEF(&parts);
    ZVAL_UNDEF(&query);
    if (!orm_parse_url(dsn, &parts) || !orm_query(&parts, &query)) goto fail;
    static const char *const mysql_keys[] = {"timezone", "socket", "ssl-mode", "ssl-ca"};
    static const char *const pg_keys[] = {"timezone", "host", "sslmode"};
    static const char *const sqlite_keys[] = {"timezone", "_pragma", "_txlock"};
    if (zend_string_equals_literal(scheme, "mysql")) {
        if (!orm_query_allowed(&parts, driver, mysql_keys, sizeof(mysql_keys) / sizeof(mysql_keys[0]))) goto fail;
    } else if (zend_string_equals_literal(scheme, "postgres")) {
        if (!orm_query_allowed(&parts, driver, pg_keys, sizeof(pg_keys) / sizeof(pg_keys[0]))) goto fail;
    } else if (!orm_query_allowed(&parts, driver, sqlite_keys, sizeof(sqlite_keys) / sizeof(sqlite_keys[0]))) goto fail;
    zval *timezone = orm_query_value(&query, "timezone");
    if (timezone != NULL && (Z_TYPE_P(timezone) != IS_STRING
        || (strcmp(Z_STRVAL_P(timezone), "+00:00") != 0 && strcmp(Z_STRVAL_P(timezone), "UTC") != 0))) {
        db_throw_orm("CONFIG", "dsn timezone %s: every connection reads and writes datetime values in UTC",
            Z_TYPE_P(timezone) == IS_STRING ? Z_STRVAL_P(timezone) : "");
        goto fail;
    }
    zval *path = orm_part(&parts, "path"), *host = orm_part(&parts, "host"), *port = orm_part(&parts, "port");
    const char *path_s = path != NULL && Z_TYPE_P(path) == IS_STRING ? Z_STRVAL_P(path) : "";
    size_t path_n = path != NULL && Z_TYPE_P(path) == IS_STRING ? Z_STRLEN_P(path) : 0;
    zval *user = orm_part(&parts, "user"), *pass = orm_part(&parts, "pass");
    zval user_dec, pass_dec;
    if (user != NULL && Z_TYPE_P(user) == IS_STRING) {
        if (!orm_decoded(user, true, &user_dec)) goto fail;
    } else ZVAL_NULL(&user_dec);
    if (pass != NULL && Z_TYPE_P(pass) == IS_STRING) {
        if (!orm_decoded(pass, true, &pass_dec)) { zval_ptr_dtor(&user_dec); goto fail; }
    } else ZVAL_NULL(&pass_dec);
    smart_str pdo = {0};
    zval pragmas;
    array_init(&pragmas);
    zval ssl_ca;
    ZVAL_NULL(&ssl_ca);
    if (zend_string_equals_literal(scheme, "mysql")) {
        while (path_n != 0 && *path_s == '/') { path_s++; path_n--; }
        zval *socket = orm_query_value(&query, "socket");
        if (path_n == 0 || (socket == NULL && (host == NULL || Z_TYPE_P(host) != IS_STRING || Z_STRLEN_P(host) == 0))) {
            db_throw_orm("CONFIG", "mysql DSN must include host and database");
            goto fail_values;
        }
        if (socket != NULL && Z_TYPE_P(socket) == IS_STRING) {
            smart_str_appends(&pdo, "mysql:unix_socket=");
            smart_str_append(&pdo, Z_STR_P(socket));
        } else {
            smart_str_appends(&pdo, "mysql:host=");
            smart_str_append(&pdo, Z_STR_P(host));
            if (port != NULL && Z_TYPE_P(port) == IS_LONG) {
                smart_str_appends(&pdo, ";port=");
                smart_str_append_long(&pdo, Z_LVAL_P(port));
            }
        }
        smart_str_appends(&pdo, ";dbname=");
        smart_str_appendl(&pdo, path_s, path_n);
        smart_str_appends(&pdo, ";charset=utf8mb4");
        zval *ca = orm_query_value(&query, "ssl-ca");
        zval *mode = orm_query_value(&query, "ssl-mode");
        if ((ca != NULL || mode != NULL)) {
            if (mode == NULL || Z_TYPE_P(mode) != IS_STRING || strcmp(Z_STRVAL_P(mode), "VERIFY_IDENTITY") != 0) {
                zval mode_arg, mode_json;
                if (mode == NULL) ZVAL_NULL(&mode_arg); else ZVAL_COPY(&mode_arg, mode);
                bool encoded = scall("json_encode", &mode_json, 1, &mode_arg);
                zval_ptr_dtor(&mode_arg);
                if (!encoded || Z_TYPE(mode_json) != IS_STRING) {
                    if (encoded) zval_ptr_dtor(&mode_json);
                    goto fail_values;
                }
                db_throw_orm("CONFIG", "mysql DSN ssl-mode %s is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca",
                    Z_STRVAL(mode_json));
                zval_ptr_dtor(&mode_json);
                goto fail_values;
            }
            if (ca == NULL || Z_TYPE_P(ca) != IS_STRING || Z_STRLEN_P(ca) == 0) {
                db_throw_orm("CONFIG", "mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file");
                goto fail_values;
            }
            if (Z_STRVAL_P(ca)[0] != '/') {
                db_throw_orm("CONFIG", "mysql DSN ssl-ca %s is not an absolute path", Z_STRVAL_P(ca));
                goto fail_values;
            }
            if (socket != NULL) {
                db_throw_orm("CONFIG", "mysql DSN ssl-mode connects over TCP and does not accept socket");
                goto fail_values;
            }
            zval ip_arg, ip_filter, ip_result, ip_args[2];
            const char *host_start = Z_STRVAL_P(host);
            size_t host_len = Z_STRLEN_P(host);
            if (host_len >= 2 && host_start[0] == '[' && host_start[host_len - 1] == ']') {
                host_start++;
                host_len -= 2;
            }
            ZVAL_STRINGL(&ip_arg, host_start, host_len);
            ZVAL_LONG(&ip_filter, 275);
            ZVAL_COPY_VALUE(&ip_args[0], &ip_arg);
            ZVAL_COPY_VALUE(&ip_args[1], &ip_filter);
            bool is_ip = scall("filter_var", &ip_result, 2, ip_args) && Z_TYPE(ip_result) != IS_FALSE;
            if (Z_TYPE(ip_result) != IS_UNDEF) zval_ptr_dtor(&ip_result);
            zval_ptr_dtor(&ip_arg);
            if (is_ip) {
                db_throw_orm("CONFIG", "mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address %s", Z_STRVAL_P(host));
                goto fail_values;
            }
            ZVAL_COPY(&ssl_ca, ca);
        }
    } else if (zend_string_equals_literal(scheme, "postgres")) {
        while (path_n != 0 && *path_s == '/') { path_s++; path_n--; }
        zval *dbhost = orm_query_value(&query, "host");
        if (path_n == 0) {
            db_throw_orm("CONFIG", "postgres DSN must include host and database");
            goto fail_values;
        }
        if (dbhost == NULL) dbhost = host;
        if (dbhost == NULL || Z_TYPE_P(dbhost) != IS_STRING || Z_STRLEN_P(dbhost) == 0) {
            db_throw_orm("CONFIG", "postgres DSN must include host and database");
            goto fail_values;
        }
        smart_str_appends(&pdo, "pgsql:host=");
        smart_str_append(&pdo, Z_STR_P(dbhost));
        smart_str_appends(&pdo, ";port=");
        if (port != NULL && Z_TYPE_P(port) == IS_LONG) smart_str_append_long(&pdo, Z_LVAL_P(port));
        else smart_str_appends(&pdo, "5432");
        smart_str_appends(&pdo, ";dbname=");
        smart_str_appendl(&pdo, path_s, path_n);
        zval *sslmode = orm_query_value(&query, "sslmode");
        if (sslmode != NULL && Z_TYPE_P(sslmode) == IS_STRING) {
            smart_str_appends(&pdo, ";sslmode=");
            smart_str_append(&pdo, Z_STR_P(sslmode));
        }
    } else {
        if (strncmp(ZSTR_VAL(dsn), "sqlite:///", 10) != 0 || path_n == 0) {
            db_throw_orm("CONFIG", "sqlite DSN must include an absolute database path");
            goto fail_values;
        }
        zval *txlock = orm_query_value(&query, "_txlock");
        if (txlock != NULL) {
            db_throw_orm("CONFIG", "sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE");
            goto fail_values;
        }
        if (!orm_sqlite_pragmas(&parts, &pragmas)) goto fail_values;
        zval path_value, decoded_path;
        ZVAL_STRINGL(&path_value, path_s, path_n);
        zval preg_args[2], preg_result;
        ZVAL_STRING(&preg_args[0], "/%(?![0-9A-Fa-f]{2})/");
        ZVAL_COPY(&preg_args[1], &path_value);
        if (scall("preg_match", &preg_result, 2, preg_args) && Z_TYPE(preg_result) == IS_LONG && Z_LVAL(preg_result) == 1) {
            zval_ptr_dtor(&preg_result); zval_ptr_dtor(&preg_args[0]); zval_ptr_dtor(&preg_args[1]); zval_ptr_dtor(&path_value);
            db_throw_orm("CONFIG", "sqlite DSN path has a % without two hexadecimal digits");
            goto fail_values;
        }
        if (Z_TYPE(preg_result) != IS_UNDEF) zval_ptr_dtor(&preg_result);
        zval_ptr_dtor(&preg_args[0]); zval_ptr_dtor(&preg_args[1]);
        if (!orm_decoded(&path_value, true, &decoded_path)) { zval_ptr_dtor(&path_value); goto fail_values; }
        zval_ptr_dtor(&path_value);
        if (memchr(Z_STRVAL(decoded_path), 0, Z_STRLEN(decoded_path)) != NULL) {
            zval_ptr_dtor(&decoded_path); db_throw_orm("CONFIG", "sqlite DSN path must not contain a NUL byte"); goto fail_values;
        }
        str decoded_text = {Z_STRVAL(decoded_path), Z_STRLEN(decoded_path)};
        if (utf8_valid_prefix(decoded_text) != decoded_text.n) {
            zval_ptr_dtor(&decoded_path); db_throw_orm("CONFIG", "sqlite DSN path must be UTF-8 after percent-decoding"); goto fail_values;
        }
        smart_str_appends(&pdo, "sqlite:");
        smart_str_append(&pdo, Z_STR(decoded_path));
        zval_ptr_dtor(&decoded_path);
    }
    if (zend_string_equals_literal(scheme, "mysql")) {
        if (Z_TYPE(user_dec) == IS_NULL) ZVAL_EMPTY_STRING(&user_dec);
        if (Z_TYPE(pass_dec) == IS_NULL) ZVAL_EMPTY_STRING(&pass_dec);
    }
    smart_str_0(&pdo);
    array_init(out);
    add_next_index_str(out, zend_string_copy(scheme));
    add_next_index_str(out, pdo.s);
    add_next_index_zval(out, &user_dec);
    add_next_index_zval(out, &pass_dec);
    add_next_index_zval(out, &pragmas);
    add_next_index_zval(out, &ssl_ca);
    zend_string_release(scheme);
    zval_ptr_dtor(&query);
    zval_ptr_dtor(&parts);
    return true;
fail_values:
    smart_str_free(&pdo);
    zval_ptr_dtor(&pragmas);
    zval_ptr_dtor(&ssl_ca);
    zval_ptr_dtor(&user_dec);
    zval_ptr_dtor(&pass_dec);
fail:
    if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query);
    if (Z_TYPE(parts) != IS_UNDEF) zval_ptr_dtor(&parts);
    zend_string_release(scheme);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Orm, parseDsn)
{
    zend_string *dsn;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(dsn)
    ZEND_PARSE_PARAMETERS_END();
    if (!orm_parse_dsn(dsn, return_value)) ZVAL_UNDEF(return_value);
}

typedef struct {
    zend_string **token;
    size_t *found;
} orm_markdown_query_context;

static bool orm_markdown_query_parameter(const orm_query_parameter *parameter, void *context)
{
    orm_markdown_query_context *markdown = context;
    zval key;
    if (!orm_query_decode(parameter->key, parameter->key_length, &key)) return false;
    if (!zend_string_equals_literal(Z_STR(key), "token")) {
        zend_string *key_copy = zend_string_copy(Z_STR(key));
        zval_ptr_dtor(&key);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; it does not accept %s", ZSTR_VAL(key_copy));
        zend_string_release(key_copy);
        return false;
    }
    zval_ptr_dtor(&key);
    zval value;
    if (!orm_query_decode(parameter->value, parameter->value_length, &value)) return false;
    (*markdown->found)++;
    if (*markdown->token != NULL) zend_string_release(*markdown->token);
    *markdown->token = zend_string_copy(Z_STR(value));
    zval_ptr_dtor(&value);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Orm, parseMarkdownDsn)
{
    zend_string *dsn;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(dsn)
    ZEND_PARSE_PARAMETERS_END();
    zval parts;
    ZVAL_UNDEF(&parts);
    if (!orm_parse_url(dsn, &parts)) RETURN_THROWS();
    zval *scheme = orm_part(&parts, "scheme"), *host = orm_part(&parts, "host"), *port = orm_part(&parts, "port");
    zval *path = orm_part(&parts, "path"), *user = orm_part(&parts, "user"), *pass = orm_part(&parts, "pass");
    if (scheme == NULL || Z_TYPE_P(scheme) != IS_STRING || strcasecmp(Z_STRVAL_P(scheme), "markdown") != 0) {
        zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; give the port that flowmark serve printed and the corpus name");
        RETURN_THROWS();
    }
    if (user != NULL || pass != NULL) {
        zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; it takes no user");
        RETURN_THROWS();
    }
    if (host == NULL || Z_TYPE_P(host) != IS_STRING || strcmp(Z_STRVAL_P(host), "127.0.0.1") != 0) {
        zend_string *h = host != NULL && Z_TYPE_P(host) == IS_STRING ? zend_string_copy(Z_STR_P(host)) : ZSTR_EMPTY_ALLOC();
        zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; host \"%s\": a flowmark server listens on 127.0.0.1 only", ZSTR_VAL(h));
        zend_string_release(h);
        RETURN_THROWS();
    }
    if (port == NULL || Z_TYPE_P(port) != IS_LONG || Z_LVAL_P(port) < 1 || Z_LVAL_P(port) > 65535) {
        zend_string *p = port == NULL ? zend_string_init("0", 1, 0) : zval_get_string(port);
        zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; port \"%s\" is not 1 to 65535: give the port that flowmark serve printed", ZSTR_VAL(p));
        zend_string_release(p);
        RETURN_THROWS();
    }
    if (path == NULL || Z_TYPE_P(path) != IS_STRING || Z_STRLEN_P(path) < 2 || Z_STRVAL_P(path)[0] != '/') {
        zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; the path is not one corpus name: give the corpus root's directory name");
        RETURN_THROWS();
    }
    zval raw_corpus, corpus;
    ZVAL_STRINGL(&raw_corpus, Z_STRVAL_P(path) + 1, Z_STRLEN_P(path) - 1);
    if (!orm_decoded(&raw_corpus, true, &corpus)) { zval_ptr_dtor(&raw_corpus); zval_ptr_dtor(&parts); RETURN_THROWS(); }
    zval_ptr_dtor(&raw_corpus);
    if (Z_STRLEN(corpus) == 0 || memchr(Z_STRVAL(corpus), '/', Z_STRLEN(corpus)) != NULL) {
        zval_ptr_dtor(&corpus); zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; the path is not one corpus name: give the corpus root's directory name");
        RETURN_THROWS();
    }
    zend_string *token = NULL;
    size_t found = 0;
    orm_markdown_query_context query_context = {&token, &found};
    if (!orm_query_visit(&parts, orm_markdown_query_parameter, &query_context)) {
        if (token != NULL) zend_string_release(token);
        zval_ptr_dtor(&corpus); zval_ptr_dtor(&parts); RETURN_THROWS();
    }
    if (found != 1 || token == NULL || ZSTR_LEN(token) == 0) {
        if (token != NULL) zend_string_release(token);
        zval_ptr_dtor(&corpus); zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; give one token, the token of .flowmark/server.json of the corpus");
        RETURN_THROWS();
    }
    smart_str address = {0};
    smart_str_appends(&address, "127.0.0.1:");
    smart_str_append_long(&address, Z_LVAL_P(port));
    smart_str_0(&address);
    array_init(return_value);
    add_next_index_str(return_value, address.s);
    add_next_index_str(return_value, Z_STR(corpus));
    add_next_index_str(return_value, token);
    zval_ptr_dtor(&parts);
}

ZEND_METHOD(Polyspec_Orm_Orm, mysqlTlsOptions)
{
    zend_string *ssl_ca = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR_OR_NULL(ssl_ca)
    ZEND_PARSE_PARAMETERS_END();
    array_init(return_value);
    if (ssl_ca == NULL) return;
    zval arg, is_file, readable;
    ZVAL_UNDEF(&is_file);
    ZVAL_UNDEF(&readable);
    ZVAL_STR_COPY(&arg, ssl_ca);
    bool ok_file = scall("is_file", &is_file, 1, &arg);
    bool is_regular = ok_file && zend_is_true(&is_file);
    if (Z_TYPE(is_file) != IS_UNDEF) zval_ptr_dtor(&is_file);
    bool ok_read = scall("is_readable", &readable, 1, &arg);
    bool can_read = ok_read && zend_is_true(&readable);
    if (Z_TYPE(readable) != IS_UNDEF) zval_ptr_dtor(&readable);
    zval_ptr_dtor(&arg);
    if (!is_regular || !can_read) {
        zval_ptr_dtor(return_value);
        db_throw_orm("CONFIG", "mysql DSN ssl-ca %s is not a readable file", ZSTR_VAL(ssl_ca));
        ZVAL_UNDEF(return_value);
        return;
    }
    zval ca_name, verify_name, ca, verify;
    ZVAL_STRING(&ca_name, "Pdo\\Mysql::ATTR_SSL_CA");
    ZVAL_STRING(&verify_name, "Pdo\\Mysql::ATTR_SSL_VERIFY_SERVER_CERT");
    if (!scall("constant", &ca, 1, &ca_name) || !scall("constant", &verify, 1, &verify_name)) {
        zval_ptr_dtor(&ca_name); zval_ptr_dtor(&verify_name); zval_ptr_dtor(return_value);
        ZVAL_UNDEF(return_value); return;
    }
    add_index_str(return_value, Z_LVAL(ca), zend_string_copy(ssl_ca));
    add_index_bool(return_value, Z_LVAL(verify), true);
    zval_ptr_dtor(&ca_name); zval_ptr_dtor(&verify_name); zval_ptr_dtor(&ca); zval_ptr_dtor(&verify);
}

static void orm_connect_failure(zend_object *cause)
{
    zend_string *name = zend_string_init("PDOException", sizeof("PDOException") - 1, 0);
    zend_class_entry *pdo_exception = zend_lookup_class(name);
    zend_string_release(name);
    if (cause != NULL && (pdo_exception == NULL || !instanceof_function(cause->ce, pdo_exception))) {
        EG(exception) = cause;
        return;
    }
    zend_string *detail;
    if (cause == NULL) {
        detail = zend_string_init("PDO connection failed", sizeof("PDO connection failed") - 1, 0);
    } else {
        zval rv;
        zval *property = zend_read_property_ex(instanceof_function(cause->ce, zend_ce_error) ? zend_ce_error : zend_ce_exception,
            cause, ZSTR_KNOWN(ZEND_STR_MESSAGE), true, &rv);
        detail = zval_get_string(property);
    }
    zend_string *message = strpprintf(0, "cannot connect: %s", ZSTR_VAL(detail));
    zend_string_release(detail);
    zval args[3], exception;
    ZVAL_STRING(&args[0], "CONFIG");
    ZVAL_STR(&args[1], message);
    if (cause == NULL) ZVAL_NULL(&args[2]); else ZVAL_OBJ(&args[2], cause);
    if (!newobj("Polyspec\\Orm\\OrmException", &exception, 3, args)) {
        for (int i = 0; i < 3; i++) zval_ptr_dtor(&args[i]);
        return;
    }
    for (int i = 0; i < 3; i++) zval_ptr_dtor(&args[i]);
    zend_throw_exception_object(&exception);
}

static zval *orm_config_value(zval *config, const char *name)
{
    return zend_read_property(Z_OBJCE_P(config), Z_OBJ_P(config), name, strlen(name), true, &EG(uninitialized_zval));
}

static bool orm_config_check(zval *config)
{
    zval *pool = orm_config_value(config, "poolSize");
    zval *idle = orm_config_value(config, "poolIdleSize");
    zval *life = orm_config_value(config, "poolLifetimeMs");
    zval *timeout = orm_config_value(config, "statementTimeoutMs");
    if (zval_get_long(pool) != 0 || zval_get_long(idle) != 0 || zval_get_long(life) != 0) {
        db_throw_orm("CONFIG", "poolSize, poolIdleSize and poolLifetimeMs configure a connection pool, and the PHP client opens one connection per Db and keeps no pool; pool PHP connections with PgBouncer or ProxySQL (docs/spec/config.md \"Connection poolers\")");
        return false;
    }
    if (zval_get_long(timeout) < 0) {
        db_throw_orm("CONFIG", "statement timeout must not be negative");
        return false;
    }
    return true;
}

static bool orm_constant(const char *name, zval *out)
{
    zval arg;
    ZVAL_STRING(&arg, name);
    bool ok = scall("constant", out, 1, &arg);
    zval_ptr_dtor(&arg);
    return ok;
}

static bool orm_set_attribute(zval *pdo, const char *attr, const char *value)
{
    zval args[2], result;
    if (!orm_constant(attr, &args[0])) return false;
    if (!orm_constant(value, &args[1])) { zval_ptr_dtor(&args[0]); return false; }
    bool ok = pdo_call(pdo, "setAttribute", &result, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (ok) zval_ptr_dtor(&result);
    return ok;
}

static bool orm_exec(zval *pdo, const char *sql)
{
    zval arg, result;
    ZVAL_STRING(&arg, sql);
    bool ok = pdo_call(pdo, "exec", &result, 1, &arg, NULL);
    zval_ptr_dtor(&arg);
    if (ok) zval_ptr_dtor(&result);
    return ok;
}

static bool orm_connection_id(zval *pdo, zend_string *driver, zend_long *id)
{
    const char *sql = zend_string_equals_literal(driver, "mysql") ? "SELECT CONNECTION_ID()" : "SELECT pg_backend_pid()";
    zval query, statement, value, closed;
    ZVAL_STRING(&query, sql);
    bool ok = pdo_call(pdo, "query", &statement, 1, &query, NULL);
    zval_ptr_dtor(&query);
    if (!ok) return false;
    ok = pdo_call(&statement, "fetchColumn", &value, 0, NULL, NULL);
    if (ok) {
        *id = zval_get_long(&value);
        zval_ptr_dtor(&value);
        if (*id <= 0) {
            db_throw_orm("CONNECTION_LOST", "database returned an invalid cancellation connection id");
            ok = false;
        }
    }
    if (pdo_call(&statement, "closeCursor", &closed, 0, NULL, NULL)) zval_ptr_dtor(&closed);
    zval_ptr_dtor(&statement);
    return ok;
}

static bool orm_fake_closure(zval *out, zif_handler handler, const char *name, zval *context)
{
    zend_internal_function *fn = pemalloc(sizeof(*fn), 1);
    memset(fn, 0, sizeof(*fn));
    fn->type = ZEND_INTERNAL_FUNCTION;
    fn->fn_flags = ZEND_ACC_PUBLIC;
    fn->scope = zend_standard_class_def;
    fn->function_name = zend_string_init_interned(name, strlen(name), 1);
    fn->handler = handler;
    fn->num_args = 0;
    fn->required_num_args = 0;
    zend_create_fake_closure(out, (zend_function *)fn, zend_standard_class_def, zend_standard_class_def, context);
    pefree(fn, 1);
    return Z_TYPE_P(out) == IS_OBJECT;
}

static zval *orm_connection_state(zval *db, zval *rv)
{
    return zend_read_property(Z_OBJCE_P(db), Z_OBJ_P(db), "state", sizeof("state") - 1, true, rv);
}

ZEND_NAMED_FUNCTION(orm_cancel_backend)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv_dsn, rv_config, rv_driver, rv_id;
    zval *dsn = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "dsn", sizeof("dsn") - 1, true, &rv_dsn);
    zval *config = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "config", sizeof("config") - 1, true, &rv_config);
    zval *driver = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "driver", sizeof("driver") - 1, true, &rv_driver);
    zval *id = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "connectionId", sizeof("connectionId") - 1, true, &rv_id);
    if (dsn == NULL || Z_TYPE_P(dsn) != IS_STRING || config == NULL || Z_TYPE_P(config) != IS_OBJECT
        || driver == NULL || Z_TYPE_P(driver) != IS_STRING || id == NULL || Z_TYPE_P(id) != IS_LONG) {
        zend_throw_error(NULL, "invalid native cancellation operation state");
        RETURN_THROWS();
    }
    zval control, pdo;
    if (!orm_connect_sql(Z_STR_P(dsn), config, &control, true)) RETURN_THROWS();
    if (!pdo_call(&control, "pdo", &pdo, 0, NULL, NULL)) {
        zval_ptr_dtor(&control);
        RETURN_THROWS();
    }
    bool ok;
    if (zend_string_equals_literal(Z_STR_P(driver), "mysql")) {
        smart_str sql = {0};
        smart_str_appends(&sql, "KILL CONNECTION ");
        smart_str_append_long(&sql, Z_LVAL_P(id));
        smart_str_0(&sql);
        ok = orm_exec(&pdo, ZSTR_VAL(sql.s));
        smart_str_free(&sql);
    } else {
        zval sql, statement, arguments, executed, result, closed;
        ZVAL_STRING(&sql, "SELECT pg_terminate_backend(?)");
        ok = pdo_call(&pdo, "prepare", &statement, 1, &sql, NULL);
        zval_ptr_dtor(&sql);
        if (ok) {
            array_init(&arguments);
            add_next_index_long(&arguments, Z_LVAL_P(id));
            ok = pdo_call(&statement, "execute", &executed, 1, &arguments, NULL);
            zval_ptr_dtor(&arguments);
            if (ok) {
                zval_ptr_dtor(&executed);
                ok = pdo_call(&statement, "fetchColumn", &result, 0, NULL, NULL);
                if (ok) {
                    bool terminated = zend_is_true(&result);
                    zval_ptr_dtor(&result);
                    if (!terminated) {
                        db_throw_orm("CONNECTION_LOST", "PostgreSQL did not terminate the cancelled connection");
                        ok = false;
                    }
                }
            }
            if (pdo_call(&statement, "closeCursor", &closed, 0, NULL, NULL)) zval_ptr_dtor(&closed);
            zval_ptr_dtor(&statement);
        }
    }
    zval_ptr_dtor(&pdo);
    zval closed;
    if (pdo_call(&control, "close", &closed, 0, NULL, NULL)) zval_ptr_dtor(&closed);
    zval_ptr_dtor(&control);
    if (!ok) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_NAMED_FUNCTION(orm_reopen_backend)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv_dsn, rv_config;
    zval *dsn = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "dsn", sizeof("dsn") - 1, true, &rv_dsn);
    zval *config = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "config", sizeof("config") - 1, true, &rv_config);
    if (dsn == NULL || Z_TYPE_P(dsn) != IS_STRING || config == NULL || Z_TYPE_P(config) != IS_OBJECT) {
        zend_throw_error(NULL, "invalid native cancellation reopen state");
        RETURN_THROWS();
    }
    zval reopened;
    if (!orm_connect_sql(Z_STR_P(dsn), config, &reopened, false)) RETURN_THROWS();
    zval state_rv;
    zval *state = orm_connection_state(&reopened, &state_rv);
    zval *pdo = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "pdo", sizeof("pdo") - 1, true, &state_rv);
    zval *cancel = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelConnection", sizeof("cancelConnection") - 1, true, &state_rv);
    zval *reconnect = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "reconnect", sizeof("reconnect") - 1, true, &state_rv);
    if (pdo == NULL || Z_TYPE_P(pdo) != IS_OBJECT || cancel == NULL || reconnect == NULL) {
        zval_ptr_dtor(&reopened);
        db_throw_orm("CONNECTION_LOST", "reopened database connection has incomplete cancellation state");
        RETURN_THROWS();
    }
    array_init(return_value);
    zval copy;
    ZVAL_COPY(&copy, pdo);
    zend_hash_str_update(Z_ARRVAL_P(return_value), "pdo", sizeof("pdo") - 1, &copy);
    ZVAL_COPY(&copy, cancel);
    zend_hash_str_update(Z_ARRVAL_P(return_value), "cancelConnection", sizeof("cancelConnection") - 1, &copy);
    ZVAL_COPY(&copy, reconnect);
    zend_hash_str_update(Z_ARRVAL_P(return_value), "reconnect", sizeof("reconnect") - 1, &copy);
    zval_ptr_dtor(&reopened);
}

ZEND_NAMED_FUNCTION(orm_cancel_state_query)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval state_rv, callback_rv;
    zval *state = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "state", sizeof("state") - 1, true, &state_rv);
    if (state == NULL || Z_TYPE_P(state) != IS_OBJECT) {
        zend_throw_error(NULL, "invalid cancellation connection state");
        RETURN_THROWS();
    }
    zval *callback = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelConnection", sizeof("cancelConnection") - 1, true, &callback_rv);
    if (callback == NULL || Z_TYPE_P(callback) == IS_NULL) RETURN_NULL();
    if (Z_TYPE_P(callback) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(callback), zend_ce_closure)) {
        zend_throw_error(NULL, "invalid cancellation connection callback");
        RETURN_THROWS();
    }
    if (call_user_function(NULL, NULL, callback, return_value, 0, NULL) != SUCCESS || EG(exception) != NULL) {
        RETURN_THROWS();
    }
}

ZEND_NAMED_FUNCTION(orm_cancel_pg_same_connection)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv;
    zval *pdo = zend_read_property(zend_standard_class_def, Z_OBJ_P(ZEND_THIS), "pdo", sizeof("pdo") - 1, true, &rv);
    if (pdo == NULL || Z_TYPE_P(pdo) != IS_OBJECT) {
        zend_throw_error(NULL, "invalid PostgreSQL cancellation handle");
        RETURN_THROWS();
    }
    if (!pdo_call(pdo, "cancelActive", return_value, 0, NULL, NULL)) RETURN_THROWS();
}

static bool orm_store_cancellation_callbacks(zval *db, zval *pdo, zend_string *dsn, zval *config, zend_string *driver)
{
    if (zend_string_equals_literal(driver, "postgres")) {
        zval context, cancel, state_rv;
        object_init(&context);
        zend_update_property(zend_standard_class_def, Z_OBJ(context), "pdo", sizeof("pdo") - 1, pdo);
        if (!orm_fake_closure(&cancel, orm_cancel_pg_same_connection, "cancel", &context)) {
            zval_ptr_dtor(&context);
            return false;
        }
        zval_ptr_dtor(&context);
        zval *state = orm_connection_state(db, &state_rv);
        zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelConnection", sizeof("cancelConnection") - 1, &cancel);
        zval null_value; ZVAL_NULL(&null_value);
        zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "reconnect", sizeof("reconnect") - 1, &null_value);
        zval state_callback_rv;
        zval *state_callback = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelQuery", sizeof("cancelQuery") - 1, true, &state_callback_rv);
        if (state_callback == NULL || Z_TYPE_P(state_callback) != IS_OBJECT) {
            zval callback_context, callback;
            object_init(&callback_context);
            zend_update_property(Z_OBJCE(callback_context), Z_OBJ(callback_context), "state", sizeof("state") - 1, state);
            if (!orm_fake_closure(&callback, orm_cancel_state_query, "cancelQuery", &callback_context)) {
                zval_ptr_dtor(&callback_context); zval_ptr_dtor(&cancel); return false;
            }
            zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelQuery", sizeof("cancelQuery") - 1, &callback);
            zval_ptr_dtor(&callback); zval_ptr_dtor(&callback_context);
        }
        zval_ptr_dtor(&cancel);
        return EG(exception) == NULL;
    }
    zend_long id;
    if (!orm_connection_id(pdo, driver, &id)) return false;
    zval cancel_context, reopen_context, cancel, reopen, state_rv;
    object_init(&cancel_context);
    zend_update_property_str(zend_standard_class_def, Z_OBJ(cancel_context), "dsn", sizeof("dsn") - 1, dsn);
    zend_update_property(zend_standard_class_def, Z_OBJ(cancel_context), "config", sizeof("config") - 1, config);
    zend_update_property_str(zend_standard_class_def, Z_OBJ(cancel_context), "driver", sizeof("driver") - 1, driver);
    zend_update_property_long(zend_standard_class_def, Z_OBJ(cancel_context), "connectionId", sizeof("connectionId") - 1, id);
    bool made_cancel = orm_fake_closure(&cancel, orm_cancel_backend, "cancel", &cancel_context);
    zval_ptr_dtor(&cancel_context);
    if (!made_cancel) return false;
    object_init(&reopen_context);
    zend_update_property_str(zend_standard_class_def, Z_OBJ(reopen_context), "dsn", sizeof("dsn") - 1, dsn);
    zend_update_property(zend_standard_class_def, Z_OBJ(reopen_context), "config", sizeof("config") - 1, config);
    bool made_reopen = orm_fake_closure(&reopen, orm_reopen_backend, "reopen", &reopen_context);
    zval_ptr_dtor(&reopen_context);
    if (!made_reopen) {
        zval_ptr_dtor(&cancel);
        return false;
    }
    zval *state = orm_connection_state(db, &state_rv);
    zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelConnection", sizeof("cancelConnection") - 1, &cancel);
    zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "reconnect", sizeof("reconnect") - 1, &reopen);
    zval state_callback_rv;
    zval *state_callback = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelQuery", sizeof("cancelQuery") - 1, true, &state_callback_rv);
    if (state_callback == NULL || Z_TYPE_P(state_callback) != IS_OBJECT) {
        zval context, callback;
        object_init(&context);
        zend_update_property(Z_OBJCE(context), Z_OBJ(context), "state", sizeof("state") - 1, state);
        if (!orm_fake_closure(&callback, orm_cancel_state_query, "cancelQuery", &context)) {
            zval_ptr_dtor(&context); zval_ptr_dtor(&cancel); zval_ptr_dtor(&reopen);
            return false;
        }
        zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "cancelQuery", sizeof("cancelQuery") - 1, &callback);
        zval_ptr_dtor(&callback);
        zval_ptr_dtor(&context);
    }
    zval_ptr_dtor(&cancel);
    zval_ptr_dtor(&reopen);
    return EG(exception) == NULL;
}

static bool orm_connect_sql(zend_string *dsn, zval *config, zval *out, bool listener)
{
    zval parsed;
    ZVAL_UNDEF(&parsed);
    if (!orm_parse_dsn(dsn, &parsed)) return false;
    if (!orm_config_check(config)) { zval_ptr_dtor(&parsed); return false; }
    zval *driver = zend_hash_index_find(Z_ARRVAL(parsed), 0);
    zval *pdo_dsn = zend_hash_index_find(Z_ARRVAL(parsed), 1);
    zval *user = zend_hash_index_find(Z_ARRVAL(parsed), 2);
    zval *password = zend_hash_index_find(Z_ARRVAL(parsed), 3);
    zval *pragmas = zend_hash_index_find(Z_ARRVAL(parsed), 4);
    zval *ssl_ca = zend_hash_index_find(Z_ARRVAL(parsed), 5);
    if (driver == NULL || pdo_dsn == NULL || Z_TYPE_P(driver) != IS_STRING || Z_TYPE_P(pdo_dsn) != IS_STRING) {
        zval_ptr_dtor(&parsed);
        db_throw_orm("IR_INVALID", "the DSN parser did not produce a driver and PDO DSN");
        return false;
    }
    if (zend_string_equals_literal(Z_STR_P(driver), "postgres")) {
        bool pgsql_driver = zend_hash_str_exists(CG(class_table), "pdo\\pgsql", sizeof("pdo\\pgsql") - 1);
        bool pgsql_functions = zend_hash_str_exists(CG(function_table), "pg_connect", sizeof("pg_connect") - 1);
        if (!pgsql_driver || !pgsql_functions) {
            db_throw_orm("CONFIG", "postgres:// DSNs require PHP extensions ext-pdo_pgsql and ext-pgsql; install both extensions");
            zval_ptr_dtor(&parsed);
            return false;
        }
    }
    zend_long timeout = zval_get_long(orm_config_value(config, "statementTimeoutMs"));
    zend_string *final_dsn = zend_string_copy(Z_STR_P(pdo_dsn));
    zval options;
    array_init(&options);
    if (zend_string_equals_literal(Z_STR_P(driver), "mysql")) {
        zval found_rows, init_command, constant_name;
        if (!orm_constant("Pdo\\Mysql::ATTR_FOUND_ROWS", &found_rows)) goto fail;
        add_index_bool(&options, Z_LVAL(found_rows), true);
        zval_ptr_dtor(&found_rows);
        smart_str command = {0};
        smart_str_appends(&command, "SET time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
        if (timeout > 0) {
            smart_str_appends(&command, ", SESSION max_execution_time = ");
            smart_str_append_long(&command, timeout);
        }
        smart_str_0(&command);
        ZVAL_STRING(&constant_name, "Pdo\\Mysql::ATTR_INIT_COMMAND");
        if (!orm_constant(Z_STRVAL(constant_name), &init_command)) {
            zval_ptr_dtor(&constant_name); smart_str_free(&command); goto fail;
        }
        add_index_str(&options, Z_LVAL(init_command), command.s);
        zval_ptr_dtor(&constant_name); zval_ptr_dtor(&init_command);
        if (ssl_ca != NULL && Z_TYPE_P(ssl_ca) == IS_STRING) {
            zval arg, tls;
            ZVAL_COPY(&arg, ssl_ca);
            if (!scall("Polyspec\\Orm\\Orm::mysqlTlsOptions", &tls, 1, &arg)) { zval_ptr_dtor(&arg); goto fail; }
            zval_ptr_dtor(&arg);
            if (Z_TYPE(tls) == IS_ARRAY) {
                zend_ulong index; zval *value;
                ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL(tls), index, value) {
                    zval copy; ZVAL_COPY(&copy, value); zend_hash_index_update(Z_ARRVAL(options), index, &copy);
                } ZEND_HASH_FOREACH_END();
            }
            zval_ptr_dtor(&tls);
        }
    }
    zval connect_args[4], pdo;
    ZVAL_STR_COPY(&connect_args[0], final_dsn);
    if (user == NULL || Z_TYPE_P(user) == IS_NULL) ZVAL_NULL(&connect_args[1]); else ZVAL_COPY(&connect_args[1], user);
    if (password == NULL || Z_TYPE_P(password) == IS_NULL) ZVAL_NULL(&connect_args[2]); else ZVAL_COPY(&connect_args[2], password);
    ZVAL_COPY(&connect_args[3], &options);
    ZVAL_UNDEF(&pdo);
    bool connected;
    if (zend_string_equals_literal(Z_STR_P(driver), "postgres")) {
        zval_ptr_dtor(&connect_args[0]);
        ZVAL_STR_COPY(&connect_args[0], Z_STR_P(pdo_dsn));
        zval_ptr_dtor(&connect_args[3]);
        ZVAL_LONG(&connect_args[3], timeout);
        connected = scall("Polyspec\\Orm\\Internal\\PgsqlPdoAdapter::connectDsn", &pdo, 4, connect_args);
    } else {
        connected = scall("PDO::connect", &pdo, 4, connect_args);
    }
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&connect_args[i]);
    if (!connected) {
        zend_object *cause = EG(exception) != NULL ? take_exception() : NULL;
        orm_connect_failure(cause);
        goto fail;
    }
    if (!orm_set_attribute(&pdo, "PDO::ATTR_ERRMODE", "PDO::ERRMODE_EXCEPTION")) goto pdo_fail;
    if (zend_string_equals_literal(Z_STR_P(driver), "sqlite")) {
        zval server_version, attr, version;
        if (!orm_constant("PDO::ATTR_SERVER_VERSION", &attr)) goto pdo_fail;
        bool got_version = pdo_call(&pdo, "getAttribute", &server_version, 1, &attr, NULL);
        zval_ptr_dtor(&attr);
        if (!got_version) goto pdo_fail;
        zend_string *version_text = zval_get_string(&server_version);
        ZVAL_STRING(&version, "3.46");
        zval version_args[3], older;
        ZVAL_COPY(&version_args[0], &server_version); ZVAL_COPY_VALUE(&version_args[1], &version); ZVAL_STRING(&version_args[2], "<");
        bool compared = scall("version_compare", &older, 3, version_args);
        zval_ptr_dtor(&version_args[0]); zval_ptr_dtor(&version_args[1]); zval_ptr_dtor(&version_args[2]); zval_ptr_dtor(&server_version);
        if (!compared) { zend_string_release(version_text); zval_ptr_dtor(&pdo); goto fail; }
        bool too_old = zend_is_true(&older); zval_ptr_dtor(&older);
        if (too_old) {
            db_throw_orm("CAPABILITY_UNSUPPORTED", "SQLite %s is older than 3.46", ZSTR_VAL(version_text));
            zend_string_release(version_text);
            zval_ptr_dtor(&pdo); goto fail;
        }
        zend_string_release(version_text);
        if (!orm_exec(&pdo, "PRAGMA foreign_keys = ON") || !orm_exec(&pdo, "PRAGMA busy_timeout = 5000")) goto pdo_fail;
        if (pragmas != NULL && Z_TYPE_P(pragmas) == IS_ARRAY) {
            zval *entry;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pragmas), entry) {
                zval *name = Z_TYPE_P(entry) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(entry), 0) : NULL;
                zval *value = Z_TYPE_P(entry) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(entry), 1) : NULL;
                if (name == NULL || value == NULL || Z_TYPE_P(name) != IS_STRING || Z_TYPE_P(value) != IS_STRING) continue;
                smart_str sql = {0}; smart_str_appends(&sql, "PRAGMA "); smart_str_append(&sql, Z_STR_P(name));
                smart_str_appends(&sql, " = "); smart_str_append(&sql, Z_STR_P(value)); smart_str_0(&sql);
                bool ok = orm_exec(&pdo, ZSTR_VAL(sql.s)); smart_str_free(&sql); if (!ok) goto pdo_fail;
            } ZEND_HASH_FOREACH_END();
        }
    }
    zval timezone, ctor[4];
    ZVAL_STRING(&timezone, "UTC");
    if (!newobj("DateTimeZone", &ctor[3], 1, &timezone)) { zval_ptr_dtor(&timezone); goto pdo_fail; }
    zval_ptr_dtor(&timezone);
    ZVAL_COPY(&ctor[0], &pdo); ZVAL_COPY(&ctor[1], driver); ZVAL_COPY(&ctor[2], config);
    if (!newobj("Polyspec\\Orm\\Db", out, 4, ctor)) {
        for (int i = 0; i < 4; i++) zval_ptr_dtor(&ctor[i]);
        zval_ptr_dtor(&pdo); goto fail;
    }
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&ctor[i]);
    if (!listener && (zend_string_equals_literal(Z_STR_P(driver), "mysql") || zend_string_equals_literal(Z_STR_P(driver), "postgres"))
        && !orm_store_cancellation_callbacks(out, &pdo, dsn, config, Z_STR_P(driver))) {
        zval_ptr_dtor(out);
        zval_ptr_dtor(&pdo);
        zval_ptr_dtor(&options);
        zend_string_release(final_dsn);
        zval_ptr_dtor(&parsed);
        return false;
    }
    if (zend_string_equals_literal(Z_STR_P(driver), "postgres") && !listener) {
        zval context, closure, set_result;
        object_init(&context);
        zend_update_property_str(zend_standard_class_def, Z_OBJ(context), "dsn", sizeof("dsn") - 1, dsn);
        zend_update_property(zend_standard_class_def, Z_OBJ(context), "config", sizeof("config") - 1, config);
        zend_internal_function *fn = pemalloc(sizeof(*fn), 1);
        memset(fn, 0, sizeof(*fn));
        fn->type = ZEND_INTERNAL_FUNCTION;
        fn->fn_flags = ZEND_ACC_PUBLIC;
        fn->scope = zend_standard_class_def;
        fn->function_name = zend_string_init_interned("open", sizeof("open") - 1, 1);
        fn->handler = orm_listener_open;
        fn->num_args = 0;
        fn->required_num_args = 0;
        zend_create_fake_closure(&closure, (zend_function *)fn, zend_standard_class_def, zend_standard_class_def, &context);
        pefree(fn, 1);
        zval_ptr_dtor(&context);
        bool set = pdo_call(out, "setListener", &set_result, 1, &closure, NULL);
        zval_ptr_dtor(&closure);
        if (set) zval_ptr_dtor(&set_result);
        if (!set) {
            zval_ptr_dtor(out);
            zval_ptr_dtor(&pdo); zval_ptr_dtor(&options); zend_string_release(final_dsn); zval_ptr_dtor(&parsed);
            return false;
        }
    }
    zval_ptr_dtor(&pdo);
    zval_ptr_dtor(&options); zend_string_release(final_dsn); zval_ptr_dtor(&parsed);
    return true;
pdo_fail:
    if (EG(exception) != NULL) {
        zend_object *cause = take_exception();
        orm_connect_failure(cause);
    }
    if (Z_TYPE(pdo) == IS_OBJECT) zval_ptr_dtor(&pdo);
fail:
    zval_ptr_dtor(&options); zend_string_release(final_dsn); zval_ptr_dtor(&parsed);
    return false;
}

/* Opens the database that the scheme of the DSN selects, as Orm::connect does: markdown:// the markdown IR executor, the
 * others a PDO connection. */
static bool orm_connect_dsn(zend_string *dsn, zval *config, zval *out)
{
    zend_string *scheme = NULL;
    if (!orm_scheme(dsn, &scheme)) return false;
    bool markdown = zend_string_equals_literal(scheme, "markdown");
    zend_string_release(scheme);
    return markdown ? orm_connect_markdown(dsn, config, out) : orm_connect_sql(dsn, config, out, false);
}

ZEND_METHOD(Polyspec_Orm_Orm, connect)
{
    zend_string *dsn;
    zval *config;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(dsn)
        Z_PARAM_OBJECT(config)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *config_name = zend_string_init("Polyspec\\Orm\\Config", sizeof("Polyspec\\Orm\\Config") - 1, 0);
    zend_class_entry *config_ce = zend_lookup_class(config_name);
    zend_string_release(config_name);
    if (config_ce == NULL || !instanceof_function(Z_OBJCE_P(config), config_ce)) {
        zend_type_error("Polyspec\\Orm\\Orm::connect(): Argument #2 ($config) must be of type "
            "Polyspec\\Orm\\Config, %s given", zend_zval_type_name(config));
        RETURN_THROWS();
    }
    if (!orm_connect_dsn(dsn, config, return_value)) ZVAL_UNDEF(return_value);
}

ZEND_METHOD(Polyspec_Orm_Orm, connectSchema)
{
    zend_string *dsn;
    zval *schema, *config;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(dsn)
        Z_PARAM_OBJECT(schema)
        Z_PARAM_OBJECT(config)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *schema_name = zend_string_init("Polyspec\\Orm\\Schema", sizeof("Polyspec\\Orm\\Schema") - 1, 0);
    zend_class_entry *schema_ce = zend_lookup_class(schema_name);
    zend_string_release(schema_name);
    if (schema_ce == NULL || !instanceof_function(Z_OBJCE_P(schema), schema_ce)) {
        zend_type_error("Polyspec\\Orm\\Orm::connectSchema(): Argument #2 ($schema) must be of type "
            "Polyspec\\Orm\\Schema, %s given", zend_zval_type_name(schema));
        RETURN_THROWS();
    }
    zend_string *config_name = zend_string_init("Polyspec\\Orm\\Config", sizeof("Polyspec\\Orm\\Config") - 1, 0);
    zend_class_entry *config_ce = zend_lookup_class(config_name);
    zend_string_release(config_name);
    if (config_ce == NULL || !instanceof_function(Z_OBJCE_P(config), config_ce)) {
        zend_type_error("Polyspec\\Orm\\Orm::connectSchema(): Argument #3 ($config) must be of type "
            "Polyspec\\Orm\\Config, %s given", zend_zval_type_name(config));
        RETURN_THROWS();
    }
    zval verified;
    if (!pdo_call(schema, "verify", &verified, 0, NULL, NULL)) RETURN_THROWS();
    zval_ptr_dtor(&verified);
    zval db;
    if (!orm_connect_dsn(dsn, config, &db)) RETURN_THROWS();
    zval registered;
    bool ok = pdo_call(&db, "registerSet", &registered, 1, schema, NULL);
    if (!ok) { zval_ptr_dtor(&db); RETURN_THROWS(); }
    zval_ptr_dtor(&registered);
    ZVAL_COPY_VALUE(return_value, &db);
}

static bool orm_connect_markdown(zend_string *dsn, zval *config, zval *out)
{
    zval dsn_arg, parsed;
    ZVAL_STR_COPY(&dsn_arg, dsn);
    if (!scall("Polyspec\\Orm\\Orm::parseMarkdownDsn", &parsed, 1, &dsn_arg)) {
        zval_ptr_dtor(&dsn_arg);
        return false;
    }
    zval_ptr_dtor(&dsn_arg);
    if (!orm_config_check(config)) {
        zval_ptr_dtor(&parsed);
        return false;
    }
    if (zval_get_long(orm_config_value(config, "statementTimeoutMs")) > 0) {
        zval_ptr_dtor(&parsed);
        db_throw_orm("CAPABILITY_UNSUPPORTED", "markdown does not support statement timeout");
        return false;
    }
    zval *address = zend_hash_index_find(Z_ARRVAL(parsed), 0);
    zval *corpus = zend_hash_index_find(Z_ARRVAL(parsed), 1);
    zval *token = zend_hash_index_find(Z_ARRVAL(parsed), 2);
    if (address == NULL || corpus == NULL || token == NULL || Z_TYPE_P(address) != IS_STRING
        || Z_TYPE_P(corpus) != IS_STRING || Z_TYPE_P(token) != IS_STRING) {
        zval_ptr_dtor(&parsed);
        db_throw_orm("INTERNAL", "the Markdown DSN parser returned invalid session arguments");
        return false;
    }
    zval session_args[3], session;
    ZVAL_COPY(&session_args[0], address);
    ZVAL_COPY(&session_args[1], corpus);
    ZVAL_COPY(&session_args[2], token);
    bool connected = scall("Polyspec\\Orm\\MarkdownSession::dial", &session, 3, session_args);
    for (size_t i = 0; i < 3; i++) zval_ptr_dtor(&session_args[i]);
    if (!connected) {
        zval_ptr_dtor(&parsed);
        return false;
    }
    zval zone, utc;
    ZVAL_STRING(&utc, "UTC");
    bool zone_ok = newobj("DateTimeZone", &zone, 1, &utc);
    zval_ptr_dtor(&utc);
    if (!zone_ok) {
        zval_ptr_dtor(&session);
        zval_ptr_dtor(&parsed);
        return false;
    }
    zval ctor[5];
    ZVAL_NULL(&ctor[0]);
    ZVAL_STRING(&ctor[1], "markdown");
    ZVAL_COPY(&ctor[2], config);
    ZVAL_COPY_VALUE(&ctor[3], &zone);
    ZVAL_COPY_VALUE(&ctor[4], &session);
    bool ok = newobj("Polyspec\\Orm\\Db", out, 5, ctor);
    zval_ptr_dtor(&ctor[1]);
    zval_ptr_dtor(&ctor[2]);
    zval_ptr_dtor(&ctor[3]);
    zval_ptr_dtor(&parsed);
    return ok;
}


/* MarkdownSession and MarkdownLinks are native classes so loading this extension never loads their PHP files. */
static zend_class_entry *markdown_session_class(void)
{
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\MarkdownSession"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    return ce;
}

static void markdown_raise(const char *code, zend_string *message, zend_object *previous)
{
    zval args[3], exception;
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], message);
    if (previous == NULL) ZVAL_NULL(&args[2]); else ZVAL_OBJ(&args[2], previous);
    if (newobj("Polyspec\\Orm\\OrmException", &exception, 3, args)) zend_throw_exception_object(&exception);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
}

static void markdown_encode_failure(void)
{
    zend_object *cause = take_exception();
    zval cause_value, cause_message;
    ZVAL_OBJ(&cause_value, cause);
    zend_call_method_with_0_params(cause, cause->ce, NULL, "getmessage", &cause_message);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&cause_value);
        return;
    }
    zend_string *detail = zval_get_string(&cause_message);
    zval_ptr_dtor(&cause_message);
    smart_str message = {0};
    smart_str_appends(&message, "writing the message: ");
    smart_str_append(&message, detail);
    zend_string_release(detail);
    markdown_raise("INTERNAL", smart_str_extract(&message), cause);
}

static void markdown_session_close(zval *self)
{
    zend_class_entry *ce = markdown_session_class();
    if (ce == NULL) return;
    zval rv, *conn = zend_read_property(ce, Z_OBJ_P(self), "conn", sizeof("conn") - 1, 1, &rv);
    if (conn != NULL && Z_TYPE_P(conn) == IS_RESOURCE) {
        zval args[1], result;
        ZVAL_COPY(&args[0], conn);
        if (scall("fclose", &result, 1, args)) zval_ptr_dtor(&result);
        zval_ptr_dtor(&args[0]);
    }
    zval null;
    ZVAL_NULL(&null);
    zend_update_property(ce, Z_OBJ_P(self), "conn", sizeof("conn") - 1, &null);
}

static zend_string *markdown_quote(zend_string *value)
{
    zval arg, result;
    ZVAL_STR_COPY(&arg, value);
    if (!scall("json_encode", &result, 1, &arg)) {
        zval_ptr_dtor(&arg);
        return zend_string_init("", 0, 0);
    }
    zval_ptr_dtor(&arg);
    if (Z_TYPE(result) != IS_STRING) {
        zval_ptr_dtor(&result);
        return zend_string_init("", 0, 0);
    }
    return Z_STR(result);
}

static bool markdown_session_call(zval *self, zval *message, zval *out)
{
    zend_class_entry *ce = markdown_session_class();
    zval rv, *conn = ce == NULL ? NULL : zend_read_property(ce, Z_OBJ_P(self), "conn", sizeof("conn") - 1, 1, &rv);
    if (conn == NULL || Z_TYPE_P(conn) == IS_NULL) {
        db_throw_orm("CONNECTION_LOST", "the flowmark session has ended");
        return false;
    }
    if (Z_TYPE_P(conn) != IS_RESOURCE) {
        db_throw_orm("CONNECTION_LOST", "the flowmark session has ended");
        return false;
    }
    zval flags_arg, encode_args[2], encoded;
    if (!orm_constant("Polyspec\\Orm\\Model::JSON_FLAGS", &flags_arg)) return false;
    ZVAL_COPY(&encode_args[0], message);
    ZVAL_COPY_VALUE(&encode_args[1], &flags_arg);
    if (!scall("json_encode", &encoded, 2, encode_args)) {
        zval_ptr_dtor(&encode_args[0]);
        zval_ptr_dtor(&encode_args[1]);
        if (EG(exception) != NULL) markdown_encode_failure();
        return false;
    }
    zval_ptr_dtor(&encode_args[0]);
    zval_ptr_dtor(&encode_args[1]);
    if (Z_TYPE(encoded) != IS_STRING) {
        zval_ptr_dtor(&encoded);
        db_throw_orm("INTERNAL", "writing the message did not produce JSON");
        return false;
    }
    smart_str line = {0};
    smart_str_append(&line, Z_STR(encoded));
    smart_str_appendc(&line, '\n');
    smart_str_0(&line);
    zval_ptr_dtor(&encoded);
    php_stream *stream;
    php_stream_from_zval_no_verify(stream, conn);
    if (stream == NULL) {
        smart_str_free(&line);
        markdown_session_close(self);
        db_throw_orm("CONNECTION_LOST", "the flowmark server connection broke while the message was written");
        return false;
    }
    size_t written = 0;
    while (written < ZSTR_LEN(line.s)) {
        ssize_t n = php_stream_write(stream, ZSTR_VAL(line.s) + written, ZSTR_LEN(line.s) - written);
        if (n <= 0) {
            smart_str_free(&line);
            markdown_session_close(self);
            db_throw_orm("CONNECTION_LOST", "the flowmark server connection broke while the message was written");
            return false;
        }
        written += (size_t)n;
    }
    smart_str_free(&line);
    size_t line_len = 0;
    char *raw_line = php_stream_get_line(stream, NULL, 0, &line_len);
    if (raw_line == NULL) {
        markdown_session_close(self);
        db_throw_orm("CONNECTION_LOST", "the flowmark server connection broke: the server closed the connection");
        return false;
    }
    while (line_len > 0 && raw_line[line_len - 1] == '\n') line_len--;
    zend_string *answer = zend_string_init(raw_line, line_len, 0);
    efree(raw_line);
    if (ZSTR_LEN(answer) == 0 || ZSTR_VAL(answer)[0] != '{') {
        zend_string *quoted = markdown_quote(answer);
        smart_str detail = {0};
        smart_str_appends(&detail, "the flowmark server answered ");
        smart_str_append(&detail, quoted);
        smart_str_appends(&detail, ", not a JSON object");
        zend_string_release(quoted);
        zend_string_release(answer);
        markdown_session_close(self);
        zend_string *msg = smart_str_extract(&detail);
        db_throw_orm("INTERNAL", "%s", ZSTR_VAL(msg));
        zend_string_release(msg);
        return false;
    }
    zval decode_args[4], decoded;
    ZVAL_STR_COPY(&decode_args[0], answer);
    ZVAL_TRUE(&decode_args[1]);
    ZVAL_LONG(&decode_args[2], 512);
    ZVAL_LONG(&decode_args[3], 2);
    bool decoded_ok = scall("json_decode", &decoded, 4, decode_args);
    for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&decode_args[i]);
    if (!decoded_ok || Z_TYPE(decoded) != IS_ARRAY) {
        if (decoded_ok) zval_ptr_dtor(&decoded);
        zend_string *quoted = markdown_quote(answer);
        smart_str detail = {0};
        smart_str_appends(&detail, "the flowmark server answered ");
        smart_str_append(&detail, quoted);
        smart_str_appends(&detail, ", not a JSON object");
        zend_string_release(quoted);
        zend_string_release(answer);
        markdown_session_close(self);
        zend_string *msg = smart_str_extract(&detail);
        db_throw_orm("INTERNAL", "%s", ZSTR_VAL(msg));
        zend_string_release(msg);
        return false;
    }
    zend_string_release(answer);
    zval *remote = zend_hash_str_find(Z_ARRVAL(decoded), "error", sizeof("error") - 1);
    if (remote != NULL) {
        zval *code = Z_TYPE_P(remote) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(remote), "code", sizeof("code") - 1) : NULL;
        zval *text = Z_TYPE_P(remote) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(remote), "message", sizeof("message") - 1) : NULL;
        if (code == NULL || Z_TYPE_P(code) != IS_STRING || Z_STRLEN_P(code) == 0) {
            zval error_copy;
            ZVAL_COPY(&error_copy, remote);
            zval json_error;
            if (!scall("json_encode", &json_error, 1, &error_copy)) ZVAL_FALSE(&json_error);
            zval_ptr_dtor(&error_copy);
            zend_string *quoted = Z_TYPE(json_error) == IS_STRING ? Z_STR(json_error) : zend_string_init("", 0, 0);
            smart_str detail = {0};
            smart_str_appends(&detail, "the flowmark server answered the error ");
            smart_str_append(&detail, quoted);
            smart_str_appends(&detail, " without a code");
            if (Z_TYPE(json_error) == IS_STRING) ZVAL_UNDEF(&json_error); else zend_string_release(quoted);
            if (Z_TYPE(json_error) != IS_UNDEF) zval_ptr_dtor(&json_error);
            zval_ptr_dtor(&decoded);
            markdown_session_close(self);
            zend_string *msg = smart_str_extract(&detail);
            db_throw_orm("INTERNAL", "%s", ZSTR_VAL(msg));
            zend_string_release(msg);
            return false;
        }
        zend_string *code_copy = zend_string_copy(Z_STR_P(code));
        zend_string *message = text == NULL ? zend_string_init("", 0, 0) : zval_get_string(text);
        if (zend_string_equals_literal(code_copy, "CONNECTION_LOST")) markdown_session_close(self);
        zval_ptr_dtor(&decoded);
        db_throw_orm(ZSTR_VAL(code_copy), "%s", ZSTR_VAL(message));
        zend_string_release(code_copy);
        zend_string_release(message);
        return false;
    }
    ZVAL_COPY_VALUE(out, &decoded);
    return true;
}

static bool markdown_session_dial(zend_string *address, zend_string *corpus, zend_string *token, zval *out)
{
    smart_str uri = {0};
    smart_str_appends(&uri, "tcp://");
    smart_str_append(&uri, address);
    smart_str_0(&uri);
    zend_string *error = NULL;
    int error_code = 0;
    php_stream *stream = php_stream_xport_create(ZSTR_VAL(uri.s), ZSTR_LEN(uri.s), 0,
        STREAM_XPORT_CLIENT | STREAM_XPORT_CONNECT, NULL, NULL, NULL, &error, &error_code);
    if (stream == NULL) {
        db_throw_orm("DRIVER", "connecting to the flowmark server %s: %s; start flowmark serve for the corpus",
            ZSTR_VAL(address), error == NULL ? "connection failed" : ZSTR_VAL(error));
        if (error != NULL) zend_string_release(error);
        smart_str_free(&uri);
        return false;
    }
    if (error != NULL) zend_string_release(error);
    zval connection;
    php_stream_to_zval(stream, &connection);
    zend_class_entry *ce = markdown_session_class();
    if (ce == NULL) {
        zval_ptr_dtor(&connection);
        smart_str_free(&uri);
        db_throw_orm("INTERNAL", "the MarkdownSession class is unavailable");
        return false;
    }
    object_init_ex(out, ce);
    zend_update_property(ce, Z_OBJ_P(out), "conn", sizeof("conn") - 1, &connection);
    zval timeout_args[2], timeout_result;
    ZVAL_COPY(&timeout_args[0], &connection);
    ZVAL_LONG(&timeout_args[1], -1);
    bool timeout_ok = scall("stream_set_timeout", &timeout_result, 2, timeout_args);
    zval_ptr_dtor(&timeout_args[0]);
    zval_ptr_dtor(&timeout_args[1]);
    zval_ptr_dtor(&connection);
    if (timeout_ok) zval_ptr_dtor(&timeout_result);
    if (!timeout_ok) {
        zval_ptr_dtor(out);
        ZVAL_UNDEF(out);
        smart_str_free(&uri);
        return false;
    }
    smart_str_free(&uri);
    zval message, response;
    array_init(&message);
    add_assoc_string(&message, "op", "connect");
    add_assoc_str(&message, "corpus", zend_string_copy(corpus));
    add_assoc_str(&message, "token", zend_string_copy(token));
    if (!markdown_session_call(out, &message, &response)) {
        zval_ptr_dtor(&message);
        zend_object *failure = EG(exception) == NULL ? NULL : take_exception();
        markdown_session_close(out);
        zval_ptr_dtor(out);
        ZVAL_UNDEF(out);
        if (failure != NULL) {
            zval failure_value;
            ZVAL_OBJ(&failure_value, failure);
            zend_throw_exception_object(&failure_value);
        }
        return false;
    }
    zval_ptr_dtor(&message);
    zval_ptr_dtor(&response);
    return true;
}

ZEND_METHOD(Polyspec_Orm_MarkdownSession, __construct)
{
    zval *conn;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_RESOURCE(conn) ZEND_PARSE_PARAMETERS_END();
    zend_class_entry *ce = markdown_session_class();
    if (ce != NULL) init_prop(ZEND_THIS, "conn", conn);
}

ZEND_METHOD(Polyspec_Orm_MarkdownSession, dial)
{
    zend_string *address, *corpus, *token;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(address) Z_PARAM_STR(corpus) Z_PARAM_STR(token)
    ZEND_PARSE_PARAMETERS_END();
    if (!markdown_session_dial(address, corpus, token, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_MarkdownSession, close)
{
    ZEND_PARSE_PARAMETERS_NONE();
    markdown_session_close(ZEND_THIS);
}

ZEND_METHOD(Polyspec_Orm_MarkdownSession, call)
{
    zval *message;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(message) ZEND_PARSE_PARAMETERS_END();
    if (!markdown_session_call(ZEND_THIS, message, return_value)) RETURN_THROWS();
}
