#include "php.h"
#include "ext/pdo/php_pdo_driver.h"
#include "ext/spl/spl_exceptions.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include <string.h>

static zend_string *mysql_code(zend_long number, bool has_number, zend_string *state);
static zend_string *postgres_code(zend_string *state);
static bool call_message(zend_object *error, zend_string **message);
static bool construct_error(zval *out, zend_class_entry *ce, zend_string *code, zend_string *message,
    zend_object *previous, zend_object *rollback, zval *cleanup);

static void write_property(zval *object, const char *name, zval *value)
{
    zend_update_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), value);
}

static void write_nullable_object(zval *object, const char *name, zend_object *value)
{
    zval property;
    if (value == NULL) ZVAL_NULL(&property); else ZVAL_OBJ_COPY(&property, value);
    write_property(object, name, &property);
    zval_ptr_dtor(&property);
}

static zend_class_entry *lookup_class_literal(const char *name)
{
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool call_message(zend_object *error, zend_string **message)
{
    zval result;
    zend_call_method_with_0_params(error, error->ce, NULL, "getmessage", &result);
    if (EG(exception) != NULL) {
        return false;
    }
    *message = zval_get_string(&result);
    zval_ptr_dtor(&result);
    return true;
}

static bool construct_error(zval *out, zend_class_entry *ce, zend_string *code, zend_string *message,
    zend_object *previous, zend_object *rollback, zval *cleanup)
{
    object_init_ex(out, ce);
    zval args[5], rv;
    ZVAL_STR_COPY(&args[0], code);
    ZVAL_STR_COPY(&args[1], message);
    if (previous == NULL) ZVAL_NULL(&args[2]); else ZVAL_OBJ_COPY(&args[2], previous);
    if (rollback == NULL) ZVAL_NULL(&args[3]); else ZVAL_OBJ_COPY(&args[3], rollback);
    if (cleanup == NULL) array_init(&args[4]); else ZVAL_COPY(&args[4], cleanup);
    zend_call_known_function(ce->constructor, Z_OBJ_P(out), ce, &rv, 5, args, NULL);
    for (size_t i = 0; i < 5; i++) zval_ptr_dtor(&args[i]);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(out);
        return false;
    }
    return true;
}

ZEND_METHOD(Polyspec_Orm_OrmException, __construct)
{
    zend_string *code, *message;
    zend_object *previous = NULL, *rollback = NULL;
    zval *cleanup = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 5)
        Z_PARAM_STR(code)
        Z_PARAM_STR(message)
        Z_PARAM_OPTIONAL
        Z_PARAM_OBJ_OF_CLASS_OR_NULL(previous, zend_ce_throwable)
        Z_PARAM_OBJ_OF_CLASS_OR_NULL(rollback, zend_ce_throwable)
        Z_PARAM_ARRAY(cleanup)
    ZEND_PARSE_PARAMETERS_END();

    zval code_value;
    ZVAL_STR_COPY(&code_value, code);
    write_property(ZEND_THIS, "code_", &code_value);
    zval_ptr_dtor(&code_value);
    if (EG(exception) != NULL) RETURN_THROWS();
    write_nullable_object(ZEND_THIS, "rollback", rollback);
    if (EG(exception) != NULL) RETURN_THROWS();
    if (cleanup == NULL) {
        zval empty;
        ZVAL_EMPTY_ARRAY(&empty);
        write_property(ZEND_THIS, "cleanup", &empty);
    } else {
        write_property(ZEND_THIS, "cleanup", cleanup);
    }
    if (EG(exception) != NULL) RETURN_THROWS();

    smart_str full = {0};
    smart_str_append(&full, code);
    smart_str_appends(&full, ": ");
    smart_str_append(&full, message);
    zend_string *full_message = smart_str_extract(&full);
    zval message_value;
    ZVAL_STR(&message_value, full_message);
    zend_update_property_ex(zend_ce_exception, Z_OBJ_P(ZEND_THIS), ZSTR_KNOWN(ZEND_STR_MESSAGE), &message_value);
    if (previous != NULL && EG(exception) == NULL) {
        zval previous_value;
        ZVAL_OBJ(&previous_value, previous);
        zend_update_property_ex(zend_ce_exception, Z_OBJ_P(ZEND_THIS), ZSTR_KNOWN(ZEND_STR_PREVIOUS), &previous_value);
    }
    zend_string_release(full_message);
}

ZEND_METHOD(Polyspec_Orm_OrmException, rollback)
{
    zend_object *cause, *rollback_error;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJ_OF_CLASS(cause, zend_ce_throwable)
        Z_PARAM_OBJ_OF_CLASS(rollback_error, zend_ce_throwable)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *cause_message = NULL, *rollback_message = NULL;
    if (!call_message(cause, &cause_message) || !call_message(rollback_error, &rollback_message)) {
        if (cause_message != NULL) zend_string_release(cause_message);
        RETURN_THROWS();
    }
    smart_str message = {0};
    smart_str_appends(&message, "transaction failed (");
    smart_str_append(&message, cause_message);
    smart_str_appends(&message, ") and rollback failed (");
    smart_str_append(&message, rollback_message);
    smart_str_appendc(&message, ')');
    zend_string_release(cause_message);
    zend_string_release(rollback_message);
    zend_string *text = smart_str_extract(&message);
    zend_string *code = zend_string_init("ROLLBACK", sizeof("ROLLBACK") - 1, 0);
    zend_class_entry *ce = zend_get_called_scope(execute_data);
    if (ce == NULL || !construct_error(return_value, ce, code, text, cause, rollback_error, NULL)) {
        zend_string_release(code);
        zend_string_release(text);
        RETURN_THROWS();
    }
    zend_string_release(code);
    zend_string_release(text);
}

ZEND_METHOD(Polyspec_Orm_OrmException, withCleanup)
{
    zend_object *primary, *cleanup_error;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJ_OF_CLASS(primary, zend_ce_throwable)
        Z_PARAM_OBJ_OF_CLASS(cleanup_error, zend_ce_throwable)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *message = NULL;
    if (!call_message(primary, &message)) RETURN_THROWS();

    zend_string *code = zend_string_init("DRIVER", sizeof("DRIVER") - 1, 0);
    zend_class_entry *ce = zend_get_called_scope(execute_data);
    if (ce != NULL && instanceof_function(primary->ce, ce)) {
        zval rv;
        zval *value = zend_read_property(ce, primary, "code_", sizeof("code_") - 1, true, &rv);
        if (Z_TYPE_P(value) == IS_STRING) {
            zend_string_release(code);
            code = zend_string_copy(Z_STR_P(value));
        }
    }
    zval cleanup;
    array_init(&cleanup);
    zval entry;
    ZVAL_OBJ_COPY(&entry, cleanup_error);
    add_next_index_zval(&cleanup, &entry);
    ce = zend_get_called_scope(execute_data);
    bool ok = ce != NULL && construct_error(return_value, ce, code, message, primary, NULL, &cleanup);
    zval_ptr_dtor(&cleanup);
    zend_string_release(code);
    zend_string_release(message);
    if (!ok) RETURN_THROWS();
}

static zend_string *mysql_code(zend_long number, bool has_number, zend_string *state)
{
    const char *code = "DRIVER";
    if ((has_number && number == 3572) || zend_string_equals_literal(state, "ER_LOCK_NOWAIT")) code = "LOCK_NOT_AVAILABLE";
    else if ((has_number && number == 1213) || zend_string_equals_literal(state, "40001")) code = "DEADLOCK";
    else if ((has_number && number == 1062) || (!has_number && zend_string_equals_literal(state, "23000"))) code = "DUPLICATE_KEY";
    else if (has_number && (number == 1451 || number == 1452)) code = "FOREIGN_KEY";
    else if (has_number && (number == 1205 || number == 1317 || number == 3024)) code = "CANCELED";
    else if (has_number && (number == 1290 || number == 1792)) code = "READ_ONLY";
    else if (has_number && (number == 3819 || number == 4025)) code = "CONSTRAINT";
    else if (has_number && (number == 2006 || number == 2013 || number == 4031)) code = "CONNECTION_LOST";
    return zend_string_init(code, strlen(code), 0);
}

static zend_string *postgres_code(zend_string *state)
{
    const char *code = "DRIVER";
    if (zend_string_equals_literal(state, "55P03")) code = "LOCK_NOT_AVAILABLE";
    else if (zend_string_equals_literal(state, "40P01") || zend_string_equals_literal(state, "40001")) code = "DEADLOCK";
    else if (zend_string_equals_literal(state, "23505")) code = "DUPLICATE_KEY";
    else if (zend_string_equals_literal(state, "23503")) code = "FOREIGN_KEY";
    else if (zend_string_equals_literal(state, "57014")) code = "CANCELED";
    else if (zend_string_equals_literal(state, "25006")) code = "READ_ONLY";
    else if (zend_string_equals_literal(state, "23514")) code = "CONSTRAINT";
    else if (ZSTR_LEN(state) >= 2 && ZSTR_VAL(state)[0] == '0' && ZSTR_VAL(state)[1] == '8') code = "CONNECTION_LOST";
    else if (zend_string_equals_literal(state, "57P01") || zend_string_equals_literal(state, "57P02") || zend_string_equals_literal(state, "57P05")) code = "CONNECTION_LOST";
    return zend_string_init(code, strlen(code), 0);
}

ZEND_METHOD(Polyspec_Orm_OrmException, mysqlCode)
{
    zend_long number = 0;
    zend_string *state;
    bool is_null = false;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_LONG_OR_NULL(number, is_null)
        Z_PARAM_STR(state)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(mysql_code(number, !is_null, state));
}

ZEND_METHOD(Polyspec_Orm_OrmException, postgresCode)
{
    zend_string *state;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(state)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(postgres_code(state));
}

ZEND_METHOD(Polyspec_Orm_OrmException, fromMysqli)
{
    zend_object *error;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJ(error)
    ZEND_PARSE_PARAMETERS_END();
    zval code_rv, state_rv;
    zend_call_method_with_0_params(error, error->ce, NULL, "getcode", &code_rv);
    if (EG(exception) != NULL) RETURN_THROWS();
    zend_long number = zval_get_long(&code_rv);
    zval_ptr_dtor(&code_rv);
    zend_call_method_with_0_params(error, error->ce, NULL, "getsqlstate", &state_rv);
    if (EG(exception) != NULL) RETURN_THROWS();
    zend_string *state = zval_get_string(&state_rv);
    zval_ptr_dtor(&state_rv);
    zend_string *code = mysql_code(number, true, state);
    zend_string_release(state);
    zend_string *message = NULL;
    if (!call_message(error, &message)) {
        zend_string_release(code);
        RETURN_THROWS();
    }
    zend_class_entry *ce = zend_get_called_scope(execute_data);
    bool ok = ce != NULL && construct_error(return_value, ce, code, message, error, NULL, NULL);
    zend_string_release(code);
    zend_string_release(message);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_OrmException, fromDriver)
{
    zval *error_value, *pdo_value;
    zend_string *driver;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT(error_value)
        Z_PARAM_STR(driver)
        Z_PARAM_OBJECT_OF_CLASS(pdo_value, php_pdo_get_dbh_ce())
    ZEND_PARSE_PARAMETERS_END();
    zend_string *state = NULL;
    zend_long number = 0;
    bool has_number = false;
    // zend_read_property returns the declared property itself, or the value of __get in error_info_rv, which the reader
    // then owns; error_info_rv is written only in that case. errorInfo is copied so that every path releases its own copy.
    zval error_info_rv, error_info_copy;
    zval *read_info = zend_read_property(Z_OBJCE_P(error_value), Z_OBJ_P(error_value), "errorInfo", sizeof("errorInfo") - 1, true, &error_info_rv);
    ZVAL_COPY(&error_info_copy, read_info);
    if (read_info == &error_info_rv) zval_ptr_dtor(&error_info_rv);
    zval *error_info = &error_info_copy;
    zend_class_entry *pdo_exception_ce = lookup_class_literal("PDOException");
    if (pdo_exception_ce == NULL || !instanceof_function(Z_OBJCE_P(error_value), pdo_exception_ce)) {
        zval_ptr_dtor(&error_info_copy);
        zend_throw_exception(spl_ce_InvalidArgumentException, "OrmException::fromDriver expects a PDOException", 0);
        RETURN_THROWS();
    }
    if (!instanceof_function(Z_OBJCE_P(pdo_value), php_pdo_get_dbh_ce())) {
        zval_ptr_dtor(&error_info_copy);
        zend_throw_exception(spl_ce_InvalidArgumentException, "OrmException::fromDriver expects a PDO connection", 0);
        RETURN_THROWS();
    }
    if (Z_TYPE_P(error_info) == IS_ARRAY) {
        zval *sql_state = zend_hash_index_find(Z_ARRVAL_P(error_info), 0);
        if (sql_state != NULL && Z_TYPE_P(sql_state) != IS_NULL) state = zval_get_string(sql_state);
        zval *native_number = zend_hash_index_find(Z_ARRVAL_P(error_info), 1);
        if (native_number != NULL && Z_TYPE_P(native_number) == IS_LONG) {
            number = Z_LVAL_P(native_number);
            has_number = true;
        }
    }
    if (state == NULL) {
        zval code_rv;
        zend_call_method_with_0_params(Z_OBJ_P(error_value), Z_OBJCE_P(error_value), NULL, "getcode", &code_rv);
        if (EG(exception) != NULL) {
            zval_ptr_dtor(&error_info_copy);
            RETURN_THROWS();
        }
        state = zval_get_string(&code_rv);
        zval_ptr_dtor(&code_rv);
    }

    zend_string *driver_message = NULL;
    zval *error_message = NULL;
    if (Z_TYPE_P(error_info) == IS_ARRAY) error_message = zend_hash_index_find(Z_ARRVAL_P(error_info), 2);
    if (error_message != NULL && Z_TYPE_P(error_message) != IS_NULL) driver_message = zval_get_string(error_message);
    else driver_message = zend_string_init("", 0, 0);

    zend_string *code = NULL;
    if (zend_string_equals_literal(driver, "postgres")) {
        bool connection_lost = (ZSTR_LEN(state) >= 2 && ZSTR_VAL(state)[0] == '0' && ZSTR_VAL(state)[1] == '8')
            || zend_string_equals_literal(state, "57P01") || zend_string_equals_literal(state, "57P02")
            || zend_string_equals_literal(state, "57P05");
        if (!connection_lost && zend_string_equals_literal(state, "HY000")) {
            zend_class_entry *pgsql = lookup_class_literal("Pdo\\Pgsql");
            if (pgsql != NULL && instanceof_function(Z_OBJCE_P(pdo_value), pgsql)) {
                zval pid;
                zend_call_method_with_0_params(Z_OBJ_P(pdo_value), Z_OBJCE_P(pdo_value), NULL, "getpid", &pid);
                if (EG(exception) != NULL) {
                    zend_string_release(state);
                    zend_string_release(driver_message);
                    zval_ptr_dtor(&error_info_copy);
                    RETURN_THROWS();
                }
                connection_lost = zval_get_long(&pid) == 0;
                zval_ptr_dtor(&pid);
            }
        }
        code = connection_lost ? zend_string_init("CONNECTION_LOST", sizeof("CONNECTION_LOST") - 1, 0) : postgres_code(state);
    } else if (zend_string_equals_literal(driver, "sqlite")) {
        const char *mapped = "DRIVER";
        zend_long primary = has_number ? number & 0xff : -1;
        if (has_number && primary == 5) mapped = "CANCELED";
        else if (has_number && (number == 6 || number == 262)) mapped = "DEADLOCK";
        else if (has_number && (number == 2067 || number == 1555
            || (number == 19 && zend_string_starts_with_literal(driver_message, "UNIQUE constraint failed")))) mapped = "DUPLICATE_KEY";
        else if (has_number && (number == 787 || ((number == 19 || number == 1811)
            && zend_string_starts_with_literal(driver_message, "FOREIGN KEY constraint failed")))) mapped = "FOREIGN_KEY";
        else if (has_number && (number == 275 || (number == 19
            && zend_string_starts_with_literal(driver_message, "CHECK constraint failed")))) mapped = "CONSTRAINT";
        else if (has_number && number == 9) mapped = "CANCELED";
        else if (has_number && primary == 8) mapped = "READ_ONLY";
        code = zend_string_init(mapped, strlen(mapped), 0);
    } else {
        code = mysql_code(number, has_number, state);
    }
    zend_string_release(state);

    zval message_rv;
    zend_call_method_with_0_params(Z_OBJ_P(error_value), Z_OBJCE_P(error_value), NULL, "getmessage", &message_rv);
    if (EG(exception) != NULL) {
        zend_string_release(code);
        zend_string_release(driver_message);
        zval_ptr_dtor(&error_info_copy);
        RETURN_THROWS();
    }
    zend_string *message = zval_get_string(&message_rv);
    zval_ptr_dtor(&message_rv);
    zend_string_release(driver_message);
    zval_ptr_dtor(&error_info_copy);
    zend_class_entry *ce = zend_get_called_scope(execute_data);
    bool ok = ce != NULL && construct_error(return_value, ce, code, message, Z_OBJ_P(error_value), NULL, NULL);
    zend_string_release(code);
    zend_string_release(message);
    if (!ok) RETURN_THROWS();
}
