/* The native connection factory and the value-function constructors of Polyspec\\Orm\\Orm. */
#include "dbspec.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_closures.h"
#include "main/php_streams.h"

static bool orm_connect_markdown(zend_string *dsn, zval *config, zval *out);
static bool orm_connect_sql(zend_string *dsn, zval *config, zval *out, bool listener);
static bool orm_decoded(zval *input, bool raw, zval *out);

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

static void orm_func(zval *out, const char *name, uint32_t argc, zval *args)
{
    zval ctor[3];
    ZVAL_STRING(&ctor[0], name);
    array_init(&ctor[1]);
    for (uint32_t i = 0; i < argc; i++) {
        zval v;
        ZVAL_COPY(&v, &args[i]);
        add_next_index_zval(&ctor[1], &v);
    }
    ZVAL_FALSE(&ctor[2]);
    if (!newobj("Polyspec\\Orm\\Func", out, 3, ctor)) {
        ZVAL_UNDEF(out);
    }
    zval_ptr_dtor(&ctor[0]);
    zval_ptr_dtor(&ctor[1]);
}

#define ORM_FUNC0(method, value) \
    ZEND_METHOD(Polyspec_Orm_Orm, method) { \
        ZEND_PARSE_PARAMETERS_NONE(); \
        orm_func(return_value, value, 0, NULL); \
    }
#define ORM_FUNC1(method, value) \
    ZEND_METHOD(Polyspec_Orm_Orm, method) { \
        zend_long n; \
        ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_LONG(n) ZEND_PARSE_PARAMETERS_END(); \
        zval arg; ZVAL_LONG(&arg, n); \
        orm_func(return_value, value, 1, &arg); \
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
ORM_FUNC0(dayOfWeek, "day_of_week")
ORM_FUNC0(year, "year")
ORM_FUNC0(month, "month")
ORM_FUNC0(date, "date")

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

static bool orm_query_allowed(zval *parts, const char *driver, const char *const *allowed, size_t n)
{
    zval *raw = orm_part(parts, "query");
    if (raw == NULL || Z_TYPE_P(raw) != IS_STRING) return true;
    const char *p = Z_STRVAL_P(raw);
    size_t len = Z_STRLEN_P(raw), start = 0;
    for (size_t i = 0; i <= len; i++) {
        if (i < len && p[i] != '&') continue;
        if (i > start) {
            const char *eq = memchr(p + start, '=', i - start);
            size_t key_len = eq == NULL ? i - start : (size_t)(eq - (p + start));
            zval encoded, decoded;
            ZVAL_STRINGL(&encoded, p + start, key_len);
            if (!orm_decoded(&encoded, false, &decoded)) { zval_ptr_dtor(&encoded); return false; }
            zval_ptr_dtor(&encoded);
            bool found = false;
            for (size_t k = 0; k < n; k++) {
                if (Z_STRLEN(decoded) == strlen(allowed[k]) && memcmp(Z_STRVAL(decoded), allowed[k], Z_STRLEN(decoded)) == 0) found = true;
            }
            if (!found) {
                smart_str accepted = {0};
                for (size_t k = 0; k < n; k++) {
                    if (k != 0) smart_str_appends(&accepted, ", ");
                    smart_str_appends(&accepted, allowed[k]);
                }
                smart_str_0(&accepted);
                db_throw_orm("CONFIG", "%s DSN has the unknown parameter %s; it accepts %s",
                    driver, Z_STRVAL(decoded), ZSTR_VAL(accepted.s));
                smart_str_free(&accepted);
                zval_ptr_dtor(&decoded);
                return false;
            }
            zval_ptr_dtor(&decoded);
        }
        start = i + 1;
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

static bool orm_sqlite_pragmas(zval *parts, zval *out)
{
    zval *raw = orm_part(parts, "query");
    if (raw == NULL || Z_TYPE_P(raw) != IS_STRING) return true;
    const char *p = Z_STRVAL_P(raw);
    size_t n = Z_STRLEN_P(raw), start = 0;
    for (size_t i = 0; i <= n; i++) {
        if (i < n && p[i] != '&') continue;
        if (i > start) {
            const char *eq = memchr(p + start, '=', i - start);
            size_t kn = eq == NULL ? i - start : (size_t)(eq - (p + start));
            zval key_raw, key;
            ZVAL_STRINGL(&key_raw, p + start, kn);
            if (!orm_decoded(&key_raw, false, &key)) { zval_ptr_dtor(&key_raw); return false; }
            zval_ptr_dtor(&key_raw);
            if (zend_string_equals_literal(Z_STR(key), "_pragma")) {
                const char *v = eq == NULL ? "" : eq + 1;
                size_t vn = eq == NULL ? 0 : i - (size_t)(eq - p) - 1;
                zval value_raw, value;
                ZVAL_STRINGL(&value_raw, v, vn);
                if (!orm_decoded(&value_raw, false, &value)) { zval_ptr_dtor(&value_raw); zval_ptr_dtor(&key); return false; }
                zval_ptr_dtor(&value_raw);
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
        }
        start = i + 1;
    }
    return true;
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
    zval *raw_query = orm_part(&parts, "query");
    zend_string *token = NULL;
    size_t found = 0;
    if (raw_query != NULL && Z_TYPE_P(raw_query) == IS_STRING) {
        const char *p = Z_STRVAL_P(raw_query);
        size_t n = Z_STRLEN_P(raw_query), start = 0;
        for (size_t i = 0; i <= n; i++) {
            if (i < n && p[i] != '&') continue;
            if (i > start) {
                const char *eq = memchr(p + start, '=', i - start);
                size_t kn = eq == NULL ? i - start : (size_t)(eq - (p + start));
                zval key_raw, key;
                ZVAL_STRINGL(&key_raw, p + start, kn);
                if (!orm_decoded(&key_raw, false, &key)) {
                    zval_ptr_dtor(&key_raw); zval_ptr_dtor(&corpus); zval_ptr_dtor(&parts); RETURN_THROWS();
                }
                zval_ptr_dtor(&key_raw);
                if (!zend_string_equals_literal(Z_STR(key), "token")) {
                    zend_string *key_copy = zend_string_copy(Z_STR(key));
                    zval_ptr_dtor(&key); zval_ptr_dtor(&corpus); zval_ptr_dtor(&parts);
                    db_throw_orm("CONFIG", "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; it does not accept %s", ZSTR_VAL(key_copy));
                    zend_string_release(key_copy); RETURN_THROWS();
                }
                zval_ptr_dtor(&key);
                zval value_raw, value;
                const char *v = eq == NULL ? "" : eq + 1;
                size_t vn = eq == NULL ? 0 : i - (size_t)(eq - p) - 1;
                ZVAL_STRINGL(&value_raw, v, vn);
                if (!orm_decoded(&value_raw, false, &value)) {
                    zval_ptr_dtor(&value_raw); zval_ptr_dtor(&corpus); zval_ptr_dtor(&parts); RETURN_THROWS();
                }
                zval_ptr_dtor(&value_raw);
                found++;
                if (token != NULL) zend_string_release(token);
                token = zend_string_copy(Z_STR(value));
                zval_ptr_dtor(&value);
            }
            start = i + 1;
        }
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
    } else if (zend_string_equals_literal(Z_STR_P(driver), "postgres")) {
        smart_str dsn_options = {0};
        smart_str_append(&dsn_options, final_dsn);
        smart_str_appends(&dsn_options, ";options='-c TimeZone=UTC");
        if (timeout > 0) {
            smart_str_appends(&dsn_options, " -c statement_timeout=");
            smart_str_append_long(&dsn_options, timeout);
        }
        smart_str_appendc(&dsn_options, '\'');
        smart_str_0(&dsn_options);
        zend_string_release(final_dsn);
        final_dsn = dsn_options.s;
    }
    zval connect_args[4], pdo;
    ZVAL_STR_COPY(&connect_args[0], final_dsn);
    if (user == NULL || Z_TYPE_P(user) == IS_NULL) ZVAL_NULL(&connect_args[1]); else ZVAL_COPY(&connect_args[1], user);
    if (password == NULL || Z_TYPE_P(password) == IS_NULL) ZVAL_NULL(&connect_args[2]); else ZVAL_COPY(&connect_args[2], password);
    ZVAL_COPY(&connect_args[3], &options);
    ZVAL_UNDEF(&pdo);
    bool connected = scall("PDO::connect", &pdo, 4, connect_args);
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

ZEND_METHOD(Polyspec_Orm_Orm, connect)
{
    zend_string *dsn;
    zval *config;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(dsn)
        Z_PARAM_OBJECT(config)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *scheme = NULL;
    if (!orm_scheme(dsn, &scheme)) RETURN_THROWS();
    bool markdown = zend_string_equals_literal(scheme, "markdown");
    zend_string_release(scheme);
    bool connected = markdown ? orm_connect_markdown(dsn, config, return_value)
        : orm_connect_sql(dsn, config, return_value, false);
    if (!connected) ZVAL_UNDEF(return_value);
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
    zval verified;
    if (!pdo_call(schema, "verify", &verified, 0, NULL, NULL)) RETURN_THROWS();
    zval_ptr_dtor(&verified);
    zval db;
    if (!orm_connect_sql(dsn, config, &db, false)) RETURN_THROWS();
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
    smart_str uri = {0};
    smart_str_appends(&uri, "tcp://");
    smart_str_append(&uri, Z_STR_P(address));
    smart_str_0(&uri);
    zend_string *error = NULL;
    int error_code = 0;
    php_stream *stream = php_stream_xport_create(ZSTR_VAL(uri.s), ZSTR_LEN(uri.s), 0,
        STREAM_XPORT_CLIENT | STREAM_XPORT_CONNECT, NULL, NULL, NULL, &error, &error_code);
    if (stream == NULL) {
        db_throw_orm("DRIVER", "connecting to the flowmark server %s: %s; start flowmark serve for the corpus",
            Z_STRVAL_P(address), error == NULL ? "connection failed" : ZSTR_VAL(error));
        if (error != NULL) zend_string_release(error);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        return false;
    }
    if (error != NULL) zend_string_release(error);
    zval message, encoded, args[2];
    array_init(&message);
    add_assoc_string(&message, "op", "connect");
    add_assoc_str(&message, "corpus", zend_string_copy(Z_STR_P(corpus)));
    add_assoc_str(&message, "token", zend_string_copy(Z_STR_P(token)));
    ZVAL_COPY(&args[0], &message);
    if (!orm_constant("Polyspec\\Orm\\Model::JSON_FLAGS", &args[1])) {
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&message);
        php_stream_close(stream);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        return false;
    }
    bool encoded_ok = scall("json_encode", &encoded, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&message);
    if (!encoded_ok || Z_TYPE(encoded) != IS_STRING) {
        if (encoded_ok) zval_ptr_dtor(&encoded);
        php_stream_close(stream);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        db_throw_orm("INTERNAL", "writing the markdown connect message did not produce JSON");
        return false;
    }
    smart_str wire = {0};
    smart_str_append(&wire, Z_STR(encoded));
    smart_str_appendc(&wire, '\n');
    smart_str_0(&wire);
    zval_ptr_dtor(&encoded);
    size_t sent = 0;
    while (sent < ZSTR_LEN(wire.s)) {
        ssize_t n = php_stream_write(stream, ZSTR_VAL(wire.s) + sent, ZSTR_LEN(wire.s) - sent);
        if (n <= 0) {
            php_stream_close(stream);
            smart_str_free(&uri);
            smart_str_free(&wire);
            zval_ptr_dtor(&parsed);
            db_throw_orm("CONNECTION_LOST", "the flowmark server connection broke while the connect message was written");
            return false;
        }
        sent += (size_t)n;
    }
    smart_str_free(&wire);
    size_t line_len = 0;
    char *line = php_stream_get_line(stream, NULL, 0, &line_len);
    if (line == NULL) {
        php_stream_close(stream);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        db_throw_orm("CONNECTION_LOST", "the flowmark server connection broke: the server closed the connection");
        return false;
    }
    if (line_len != 0 && line[line_len - 1] == '\n') line_len--;
    zval raw, decode_args[4], response;
    ZVAL_STRINGL(&raw, line, line_len);
    efree(line);
    ZVAL_COPY(&decode_args[0], &raw);
    ZVAL_TRUE(&decode_args[1]);
    ZVAL_LONG(&decode_args[2], 512);
    ZVAL_LONG(&decode_args[3], 2);
    bool decoded = scall("json_decode", &response, 4, decode_args);
    zval_ptr_dtor(&decode_args[0]);
    zval_ptr_dtor(&raw);
    if (!decoded || Z_TYPE(response) != IS_ARRAY) {
        if (decoded) zval_ptr_dtor(&response);
        php_stream_close(stream);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        db_throw_orm("INTERNAL", "the flowmark server answered a line that is not a JSON object");
        return false;
    }
    zval *remote = zend_hash_str_find(Z_ARRVAL(response), "error", 5);
    if (remote != NULL) {
        zval *code = Z_TYPE_P(remote) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(remote), "code", 4) : NULL;
        zval *text = Z_TYPE_P(remote) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(remote), "message", 7) : NULL;
        if (code == NULL || Z_TYPE_P(code) != IS_STRING || Z_STRLEN_P(code) == 0) {
            zval_ptr_dtor(&response);
            php_stream_close(stream);
            smart_str_free(&uri);
            zval_ptr_dtor(&parsed);
            db_throw_orm("INTERNAL", "the flowmark server answered an error without a code");
            return false;
        }
        zend_string *code_copy = zend_string_copy(Z_STR_P(code));
        zend_string *text_copy = text == NULL ? zend_string_init("", 0, 0) : zval_get_string(text);
        zval_ptr_dtor(&response);
        php_stream_close(stream);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        db_throw_orm(ZSTR_VAL(code_copy), "%s", ZSTR_VAL(text_copy));
        zend_string_release(code_copy);
        zend_string_release(text_copy);
        return false;
    }
    zval_ptr_dtor(&response);
    zend_string *class_name = zend_string_init("Polyspec\\Orm\\MarkdownSession", sizeof("Polyspec\\Orm\\MarkdownSession") - 1, 0);
    zend_class_entry *session_ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (session_ce == NULL) {
        php_stream_close(stream);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        db_throw_orm("INTERNAL", "the MarkdownSession class is unavailable");
        return false;
    }
    zval session, connection;
    object_init_ex(&session, session_ce);
    php_stream_to_zval(stream, &connection);
    zval timeout_args[2], timeout_result;
    ZVAL_COPY(&timeout_args[0], &connection);
    ZVAL_LONG(&timeout_args[1], -1);
    bool timeout_set = scall("stream_set_timeout", &timeout_result, 2, timeout_args);
    zval_ptr_dtor(&timeout_args[0]);
    zval_ptr_dtor(&timeout_args[1]);
    if (!timeout_set) {
        zval_ptr_dtor(&connection);
        zval_ptr_dtor(&session);
        smart_str_free(&uri);
        zval_ptr_dtor(&parsed);
        return false;
    }
    zval_ptr_dtor(&timeout_result);
    zend_update_property(session_ce, Z_OBJ(session), "conn", sizeof("conn") - 1, &connection);
    zval_ptr_dtor(&connection);
    zval zone, utc;
    ZVAL_STRING(&utc, "UTC");
    bool zone_ok = newobj("DateTimeZone", &zone, 1, &utc);
    zval_ptr_dtor(&utc);
    if (!zone_ok) {
        zval_ptr_dtor(&session);
        smart_str_free(&uri);
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
    smart_str_free(&uri);
    zval_ptr_dtor(&parsed);
    return ok;
}
