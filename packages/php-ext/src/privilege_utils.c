/* Native PostgreSQL table privileges for Polyspec\Orm\PrivilegeUtils. */
#include "dbspec.h"
#include "Zend/zend_interfaces.h"

static zend_class_entry *privilege_utils_ce;

static bool privilege_utils_method(zval *object, const char *method, zval *result, uint32_t argc, zval *argv)
{
    ZVAL_UNDEF(result);
    return dbs_call_method(object, method, result, argc, argv);
}

static zval *privilege_utils_db(zval *object)
{
    zval rv;
    return zend_read_property(privilege_utils_ce, Z_OBJ_P(object), "db", sizeof("db") - 1, true, &rv);
}

static bool privilege_utils_identifier(zend_string *value, bool qualified_role)
{
    if (ZSTR_LEN(value) == 0) return false;
    const unsigned char *text = (const unsigned char *)ZSTR_VAL(value);
    if (!((text[0] >= 'A' && text[0] <= 'Z') || (text[0] >= 'a' && text[0] <= 'z') || text[0] == '_')) return false;
    for (size_t i = 1; i < ZSTR_LEN(value); i++) {
        unsigned char ch = text[i];
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_') continue;
        if (qualified_role && ch == '.') continue;
        return false;
    }
    return true;
}

static bool privilege_utils_table(zval *db, zend_string *table, zend_string **quoted, zend_string **schema)
{
    zval driver;
    if (!privilege_utils_method(db, "driver", &driver, 0, NULL)) return false;
    bool postgres = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR(driver), "postgres");
    zval_ptr_dtor(&driver);
    if (!postgres) {
        db_throw_orm("CAPABILITY_UNSUPPORTED", "table privileges are supported only by postgres");
        return false;
    }
    const char *dot = memchr(ZSTR_VAL(table), '.', ZSTR_LEN(table));
    if (dot == NULL || memchr(dot + 1, '.', ZSTR_LEN(table) - (size_t)(dot + 1 - ZSTR_VAL(table))) != NULL) {
        db_throw_orm("CONFIG", "a qualified table name is required");
        return false;
    }
    size_t schema_len = (size_t)(dot - ZSTR_VAL(table));
    size_t name_len = ZSTR_LEN(table) - schema_len - 1;
    zend_string *schema_name = zend_string_init(ZSTR_VAL(table), schema_len, 0);
    zend_string *table_name = zend_string_init(dot + 1, name_len, 0);
    bool valid = privilege_utils_identifier(schema_name, false) && privilege_utils_identifier(table_name, false);
    if (!valid) {
        zend_string_release(schema_name);
        zend_string_release(table_name);
        db_throw_orm("CONFIG", "a qualified table name is required");
        return false;
    }
    *schema = schema_name;
    *quoted = strpprintf(0, "\"%s\".\"%s\"", ZSTR_VAL(schema_name), ZSTR_VAL(table_name));
    zend_string_release(table_name);
    return true;
}

static bool privilege_utils_role(zend_string *role, zend_string **quoted)
{
    if (!privilege_utils_identifier(role, true)) {
        db_throw_orm("CONFIG", "role %s is invalid", ZSTR_VAL(role));
        return false;
    }
    *quoted = strpprintf(0, "\"%s\"", ZSTR_VAL(role));
    return true;
}

static bool privilege_utils_trim_character(unsigned char character)
{
    return character == ' ' || character == '\n' || character == '\r' || character == '\t'
        || character == '\v' || character == '\0';
}

typedef struct {
    zval *tables;
    zend_string *first_sql;
    zend_string *second_sql;
    bool two_statements;
} privilege_transaction;

static bool privilege_utils_run(zval *db, void *context, zval *result)
{
    privilege_transaction *transaction = context;
    zval kind, tx, sql, args[5], ignored;
    ZVAL_STRING(&kind, "utility");
    ZVAL_UNDEF(&tx);
    if (!privilege_utils_method(db, "transactionNumber", &tx, 0, NULL)) {
        zval_ptr_dtor(&kind);
        return false;
    }
    ZVAL_STR_COPY(&sql, transaction->first_sql);
    ZVAL_COPY(&args[0], &kind);
    ZVAL_COPY(&args[1], transaction->tables);
    ZVAL_COPY(&args[2], &tx);
    ZVAL_COPY(&args[3], &sql);
    bool ok = privilege_utils_method(db, "run", &ignored, 4, args);
    zval_ptr_dtor(&ignored);
    for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    zval_ptr_dtor(&sql);
    if (ok && transaction->two_statements) {
        ZVAL_STR_COPY(&sql, transaction->second_sql);
        ZVAL_COPY(&args[0], &kind);
        ZVAL_COPY(&args[1], transaction->tables);
        ZVAL_COPY(&args[2], &tx);
        ZVAL_COPY(&args[3], &sql);
        ZVAL_UNDEF(&ignored);
        ok = privilege_utils_method(db, "run", &ignored, 4, args);
        zval_ptr_dtor(&ignored);
        for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
        zval_ptr_dtor(&sql);
    }
    zval_ptr_dtor(&kind);
    zval_ptr_dtor(&tx);
    if (ok) ZVAL_NULL(result);
    return ok;
}

ZEND_METHOD(Polyspec_Orm_PrivilegeUtils, __construct)
{
    zval *db, *utils;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(db)
        Z_PARAM_OBJECT(utils)
    ZEND_PARSE_PARAMETERS_END();
    if (!dbs_bind_db_utils(ZEND_THIS, privilege_utils_ce, db, utils, "PrivilegeUtils")) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_PrivilegeUtils, grantTable)
{
    zend_string *table, *role;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(table)
        Z_PARAM_STR(role)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = privilege_utils_db(ZEND_THIS);
    zend_string *qualified = NULL, *schema = NULL, *quoted_role = NULL;
    if (!privilege_utils_table(db, table, &qualified, &schema) || !privilege_utils_role(role, &quoted_role)) {
        if (qualified != NULL) zend_string_release(qualified);
        if (schema != NULL) zend_string_release(schema);
        RETURN_THROWS();
    }
    zend_string *first = strpprintf(0, "GRANT USAGE ON SCHEMA \"%s\" TO %s", ZSTR_VAL(schema), ZSTR_VAL(quoted_role));
    zend_string *second = strpprintf(0, "GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO %s", ZSTR_VAL(qualified), ZSTR_VAL(quoted_role));
    zval tables, result;
    array_init(&tables);
    add_next_index_str(&tables, zend_string_copy(table));
    privilege_transaction transaction = {&tables, first, second, true};
    ZVAL_UNDEF(&result);
    bool ok = db_transaction_native(db, privilege_utils_run, &transaction, &result);
    if (ok) zval_ptr_dtor(&result);
    zval_ptr_dtor(&tables);
    zend_string_release(first);
    zend_string_release(second);
    zend_string_release(qualified);
    zend_string_release(schema);
    zend_string_release(quoted_role);
    if (!ok) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_PrivilegeUtils, revokeTable)
{
    zend_string *table, *privilege, *role;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(table)
        Z_PARAM_STR(privilege)
        Z_PARAM_STR(role)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = privilege_utils_db(ZEND_THIS);
    zend_string *qualified = NULL, *schema = NULL, *quoted_role = NULL;
    if (!privilege_utils_table(db, table, &qualified, &schema) || !privilege_utils_role(role, &quoted_role)) {
        if (qualified != NULL) zend_string_release(qualified);
        if (schema != NULL) zend_string_release(schema);
        RETURN_THROWS();
    }
    size_t start = 0, end = ZSTR_LEN(privilege);
    while (start < end && privilege_utils_trim_character((unsigned char)ZSTR_VAL(privilege)[start])) start++;
    while (end > start && privilege_utils_trim_character((unsigned char)ZSTR_VAL(privilege)[end - 1])) end--;
    zend_string *normalized = zend_string_alloc(end - start, 0);
    for (size_t i = 0; i < end - start; i++) ZSTR_VAL(normalized)[i] = (char)toupper((unsigned char)ZSTR_VAL(privilege)[start + i]);
    ZSTR_VAL(normalized)[end - start] = '\0';
    static const char *const allowed[] = {"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"};
    bool accepted = false;
    for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
        if (zend_string_equals_cstr(normalized, allowed[i], strlen(allowed[i]))) accepted = true;
    }
    if (!accepted) {
        db_throw_orm("CONFIG", "unsupported table privilege %s", ZSTR_VAL(normalized));
        zend_string_release(normalized);
        zend_string_release(qualified);
        zend_string_release(schema);
        zend_string_release(quoted_role);
        RETURN_THROWS();
    }
    zend_string *sql = strpprintf(0, "REVOKE %s ON %s FROM %s", ZSTR_VAL(normalized), ZSTR_VAL(qualified), ZSTR_VAL(quoted_role));
    zval tables, result;
    array_init(&tables);
    add_next_index_str(&tables, zend_string_copy(table));
    privilege_transaction transaction = {&tables, sql, NULL, false};
    ZVAL_UNDEF(&result);
    bool ok = db_transaction_native(db, privilege_utils_run, &transaction, &result);
    if (ok) zval_ptr_dtor(&result);
    zval_ptr_dtor(&tables);
    zend_string_release(sql);
    zend_string_release(normalized);
    zend_string_release(qualified);
    zend_string_release(schema);
    zend_string_release(quoted_role);
    if (!ok) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_PrivilegeUtils, inspectTable)
{
    zend_string *table;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(table)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = privilege_utils_db(ZEND_THIS);
    zend_string *qualified = NULL, *schema = NULL;
    if (!privilege_utils_table(db, table, &qualified, &schema)) RETURN_THROWS();
    zend_string_release(schema);
    zend_string *sql = zend_string_init(
        "SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), "
        "has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), "
        "has_table_privilege(current_user, $1, 'TRUNCATE')",
        sizeof("SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), "
        "has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), "
        "has_table_privilege(current_user, $1, 'TRUNCATE')") - 1,
        0
    );
    zval tables, args, tx, rows;
    array_init(&tables);
    add_next_index_str(&tables, zend_string_copy(table));
    array_init(&args);
    add_next_index_str(&args, zend_string_copy(qualified));
    zend_string_release(qualified);
    ZVAL_UNDEF(&tx);
    ZVAL_UNDEF(&rows);
    bool ok = privilege_utils_method(db, "transactionNumber", &tx, 0, NULL);
    zval fetch_args[5];
    ZVAL_STRING(&fetch_args[0], "utility");
    ZVAL_COPY(&fetch_args[1], &tables);
    ZVAL_COPY(&fetch_args[2], &tx);
    ZVAL_STR_COPY(&fetch_args[3], sql);
    ZVAL_COPY(&fetch_args[4], &args);
    if (ok) ok = privilege_utils_method(db, "fetch", &rows, 5, fetch_args);
    for (size_t i = 0; i < 5; i++) zval_ptr_dtor(&fetch_args[i]);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&tables);
    zval_ptr_dtor(&tx);
    zend_string_release(sql);
    if (!ok) RETURN_THROWS();
    zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
    if (row == NULL || Z_TYPE_P(row) != IS_ARRAY) {
        zval_ptr_dtor(&rows);
        db_throw_orm("INTERNAL", "PostgreSQL table privilege query returned no row");
        RETURN_THROWS();
    }
    static const char *const names[] = {"insert", "select", "update", "delete", "truncate"};
    array_init(return_value);
    for (zend_ulong i = 0; i < 5; i++) {
        zval *value = zend_hash_index_find(Z_ARRVAL_P(row), i);
        zval truth;
        ZVAL_BOOL(&truth, value != NULL && zend_is_true(value));
        zend_hash_str_update(Z_ARRVAL_P(return_value), names[i], strlen(names[i]), &truth);
    }
    zval_ptr_dtor(&rows);
}

void privilege_utils_set_class(zend_class_entry *ce)
{
    privilege_utils_ce = ce;
}
