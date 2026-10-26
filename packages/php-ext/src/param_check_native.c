/* Native implementation of PHP ParamCheck: validate bind and IR parameter values before a statement runs. */
#include "php.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "dbspec.h"
#include "model_native_methods.h"
#include "param_check_native.h"
#include <math.h>

static zval *param_field(HashTable *values, const char *name, size_t length)
{
    return zend_hash_str_find(values, name, length);
}

static void param_add_zval(zval *array, const char *name, zval *value)
{
    zval copy;
    if (value == NULL || Z_TYPE_P(value) == IS_NULL) {
        ZVAL_NULL(&copy);
    } else {
        ZVAL_COPY(&copy, value);
    }
    zend_hash_str_update(Z_ARRVAL_P(array), name, strlen(name), &copy);
}

static zend_string *param_debug_type(zval *value)
{
    zend_function *function = zend_hash_str_find_ptr(EG(function_table), ZEND_STRL("get_debug_type"));
    if (function == NULL) {
        const char *type = zend_zval_type_name(value);
        return zend_string_init(type, strlen(type), 0);
    }
    zval argument, result;
    ZVAL_COPY(&argument, value);
    ZVAL_UNDEF(&result);
    zend_call_known_function(function, NULL, NULL, &result, 1, &argument, NULL);
    zval_ptr_dtor(&argument);
    if (EG(exception) != NULL || Z_TYPE(result) != IS_STRING) {
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        return NULL;
    }
    zend_string *type = zend_string_copy(Z_STR(result));
    zval_ptr_dtor(&result);
    return type;
}

static zend_string *param_var_export(zval *value)
{
    zend_function *function = zend_hash_str_find_ptr(EG(function_table), ZEND_STRL("var_export"));
    if (function == NULL) return zend_string_init(zend_zval_type_name(value), strlen(zend_zval_type_name(value)), 0);
    zval arguments[2], result;
    ZVAL_COPY(&arguments[0], value);
    ZVAL_TRUE(&arguments[1]);
    ZVAL_UNDEF(&result);
    zend_call_known_function(function, NULL, NULL, &result, 2, arguments, NULL);
    zval_ptr_dtor(&arguments[0]);
    zval_ptr_dtor(&arguments[1]);
    if (EG(exception) != NULL || Z_TYPE(result) != IS_STRING) {
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        return NULL;
    }
    zend_string *text = zend_string_copy(Z_STR(result));
    zval_ptr_dtor(&result);
    return text;
}

/* Throws CODEC_ENCODE while retaining the same previous exception as ParamCheck.php. */
static bool param_throw_encode(zend_string *message, zend_object *previous)
{
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) {
        zend_string_release(message);
        if (EG(exception) == NULL) zend_throw_error(NULL, "Polyspec\\Orm\\OrmException is not loaded");
        return false;
    }
    zval exception, arguments[3], result;
    object_init_ex(&exception, ce);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&exception);
        zend_string_release(message);
        return false;
    }
    ZVAL_STRING(&arguments[0], "CODEC_ENCODE");
    ZVAL_STR_COPY(&arguments[1], message);
    uint32_t count = 2;
    if (previous != NULL) {
        ZVAL_OBJ_COPY(&arguments[2], previous);
        count = 3;
    }
    ZVAL_UNDEF(&result);
    zend_call_known_function(ce->constructor, Z_OBJ(exception), ce, &result, count, arguments, NULL);
    zval_ptr_dtor(&arguments[0]);
    zval_ptr_dtor(&arguments[1]);
    if (previous != NULL) zval_ptr_dtor(&arguments[2]);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    zend_string_release(message);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&exception);
        return false;
    }
    zend_throw_exception_object(&exception);
    return false;
}

static bool param_wrap_pending(zend_long index)
{
    if (EG(exception) == NULL) return false;
    zend_object *previous = EG(exception);
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL || !instanceof_function(previous->ce, ce)) return false;

    zval previous_value, result;
    ZVAL_OBJ_COPY(&previous_value, previous);
    zend_clear_exception();
    ZVAL_UNDEF(&result);
    zend_call_method_with_0_params(Z_OBJ(previous_value), Z_OBJCE(previous_value), NULL, "getMessage", &result);
    if (EG(exception) != NULL || Z_TYPE(result) != IS_STRING) {
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        zend_throw_exception_object(&previous_value);
        return false;
    }
    zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT ": %s", index, Z_STRVAL(result));
    zval_ptr_dtor(&result);
    bool ok = param_throw_encode(message, Z_OBJ(previous_value));
    zval_ptr_dtor(&previous_value);
    return ok;
}

static bool param_throw_kind(zend_long index, zval *value, zend_string *type)
{
    zend_string *debug = param_debug_type(value);
    if (debug == NULL) return false;
    zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " (%s) is not a %s value",
        index, ZSTR_VAL(debug), ZSTR_VAL(type));
    zend_string_release(debug);
    return param_throw_encode(message, NULL);
}

static bool param_call_time_value(zval *value, zend_string *type, zend_long precision, zval *zone, zval *result)
{
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\Db"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return false;
    zend_function *function = zend_hash_str_find_ptr(&ce->function_table, ZEND_STRL("timevalue"));
    if (function == NULL) return false;

    zval arguments[4];
    ZVAL_COPY(&arguments[0], value);
    ZVAL_STR_COPY(&arguments[1], type);
    ZVAL_LONG(&arguments[2], precision);
    ZVAL_COPY(&arguments[3], zone);
    ZVAL_UNDEF(result);
    zend_call_known_function(function, NULL, ce, result, 4, arguments, NULL);
    for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&arguments[i]);
    return EG(exception) == NULL;
}

static bool param_uuid(zend_string *value)
{
    static const unsigned char widths[] = {8, 4, 4, 4, 12};
    const unsigned char *text = (const unsigned char *)ZSTR_VAL(value);
    size_t length = ZSTR_LEN(value), offset = 0;
    for (size_t group = 0; group < sizeof(widths); group++) {
        for (size_t i = 0; i < widths[group]; i++, offset++) {
            if (offset >= length) return false;
            unsigned char c = text[offset];
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        if (group + 1 < sizeof(widths)) {
            if (offset >= length || text[offset] != '-') return false;
            offset++;
        }
    }
    return offset == length;
}

static bool param_add_string_cast(zval *array, HashTable *values, const char *source, size_t source_length,
    const char *target, size_t target_length)
{
    zval *value = param_field(values, source, source_length);
    zend_string *string = value == NULL || Z_TYPE_P(value) == IS_NULL
        ? zend_string_init("", 0, 0) : zval_get_string(value);
    if (EG(exception) != NULL) {
        if (string != NULL) zend_string_release(string);
        return false;
    }
    zval cast;
    ZVAL_STR(&cast, string);
    zend_hash_str_update(Z_ARRVAL_P(array), target, target_length, &cast);
    return true;
}

ZEND_METHOD(Polyspec_Orm_ParamCheck, bindSlotType)
{
    HashTable *slot;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY_HT(slot)
    ZEND_PARSE_PARAMETERS_END();

    array_init_size(return_value, 6);
    if (!param_add_string_cast(return_value, slot, ZEND_STRL("col_type"), ZEND_STRL("type"))) RETURN_THROWS();
    zval *precision = param_field(slot, ZEND_STRL("precision"));
    zval *scale = param_field(slot, ZEND_STRL("scale"));
    zval *length = param_field(slot, ZEND_STRL("length"));
    add_assoc_long(return_value, "precision", precision == NULL ? 0 : zval_get_long(precision));
    add_assoc_long(return_value, "scale", scale == NULL ? 0 : zval_get_long(scale));
    add_assoc_long(return_value, "length", length == NULL ? 0 : zval_get_long(length));
    zval *not_null = param_field(slot, ZEND_STRL("not_null"));
    add_assoc_bool(return_value, "not_null", not_null != NULL && zend_is_true(not_null));
    if (!param_add_string_cast(return_value, slot, ZEND_STRL("column"), ZEND_STRL("column"))) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_ParamCheck, useSlotType)
{
    HashTable *use;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY_HT(use)
    ZEND_PARSE_PARAMETERS_END();

    zval *type = param_field(use, ZEND_STRL("type"));
    zval *column = param_field(use, ZEND_STRL("column"));
    zval *column_type = column != NULL && Z_TYPE_P(column) == IS_ARRAY
        ? param_field(Z_ARRVAL_P(column), ZEND_STRL("type")) : NULL;
    bool same_type = type != NULL && column_type != NULL && fast_is_identical_function(type, column_type);
    array_init_size(return_value, 6);
    param_add_zval(return_value, "type", type);
    if (same_type) {
        HashTable *col = Z_ARRVAL_P(column);
        zval *precision = param_field(col, ZEND_STRL("precision"));
        zval *scale = param_field(col, ZEND_STRL("scale"));
        zval *length = param_field(col, ZEND_STRL("length"));
        zval *assign = param_field(use, ZEND_STRL("assign"));
        zval *nullable = param_field(col, ZEND_STRL("nullable"));
        zval *name = param_field(col, ZEND_STRL("name"));
        param_add_zval(return_value, "precision", precision == NULL ? NULL : precision);
        if (precision == NULL || Z_TYPE_P(precision) == IS_NULL) add_assoc_long(return_value, "precision", 0);
        param_add_zval(return_value, "scale", scale == NULL ? NULL : scale);
        if (scale == NULL || Z_TYPE_P(scale) == IS_NULL) add_assoc_long(return_value, "scale", 0);
        param_add_zval(return_value, "length", length == NULL ? NULL : length);
        if (length == NULL || Z_TYPE_P(length) == IS_NULL) add_assoc_long(return_value, "length", 0);
        add_assoc_bool(return_value, "not_null", assign != NULL && zend_is_true(assign)
            && !(nullable != NULL && zend_is_true(nullable)));
        param_add_zval(return_value, "column", name);
        return;
    }
    bool temporal = type != NULL && Z_TYPE_P(type) == IS_STRING
        && (zend_string_equals_literal(Z_STR_P(type), "datetime") || zend_string_equals_literal(Z_STR_P(type), "time"));
    add_assoc_long(return_value, "precision", temporal ? 6 : 0);
    add_assoc_long(return_value, "scale", 0);
    add_assoc_long(return_value, "length", 0);
}

ZEND_METHOD(Polyspec_Orm_ParamCheck, checkAssign)
{
    zend_long index;
    zval *value;
    HashTable *slot;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_LONG(index)
        Z_PARAM_ZVAL(value)
        Z_PARAM_ARRAY_HT(slot)
    ZEND_PARSE_PARAMETERS_END();
    zval *not_null = param_field(slot, ZEND_STRL("not_null"));
    if (Z_TYPE_P(value) != IS_NULL || not_null == NULL || !zend_is_true(not_null)) return;
    zval *column = param_field(slot, ZEND_STRL("column"));
    zend_string *column_name = column == NULL || Z_TYPE_P(column) == IS_NULL
        ? zend_string_init("", 0, 0) : zval_get_string(column);
    if (EG(exception) != NULL) {
        zend_string_release(column_name);
        RETURN_THROWS();
    }
    zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " assigns NULL to the non-null %s",
        index, ZSTR_VAL(column_name));
    zend_string_release(column_name);
    param_throw_encode(message, NULL);
    RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_ParamCheck, check)
{
    zend_long index;
    zval *value, *zone;
    HashTable *slot;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_LONG(index)
        Z_PARAM_ZVAL(value)
        Z_PARAM_ARRAY_HT(slot)
        Z_PARAM_OBJECT(zone)
    ZEND_PARSE_PARAMETERS_END();
    if (Z_TYPE_P(value) == IS_NULL) return;

    zval *slot_type = param_field(slot, ZEND_STRL("type"));
    if (slot_type == NULL || Z_TYPE_P(slot_type) != IS_STRING) return;
    zend_string *type = Z_STR_P(slot_type);
    if (zend_string_equals_literal(type, "i16") || zend_string_equals_literal(type, "i32")
        || zend_string_equals_literal(type, "i64")) {
        if (Z_TYPE_P(value) != IS_LONG) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        zend_long low = ZEND_LONG_MIN, high = ZEND_LONG_MAX;
        if (zend_string_equals_literal(type, "i16")) { low = -32768; high = 32767; }
        else if (zend_string_equals_literal(type, "i32")) { low = -2147483648; high = 2147483647; }
        if (Z_LVAL_P(value) < low || Z_LVAL_P(value) > high) {
            zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " (" ZEND_LONG_FMT ") is outside %s",
                index, Z_LVAL_P(value), ZSTR_VAL(type));
            param_throw_encode(message, NULL);
            RETURN_THROWS();
        }
        return;
    }
    if (zend_string_equals_literal(type, "f64")) {
        if (Z_TYPE_P(value) != IS_LONG && Z_TYPE_P(value) != IS_DOUBLE) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        if (Z_TYPE_P(value) == IS_DOUBLE && !isfinite(Z_DVAL_P(value))) {
            zend_string *shown = param_var_export(value);
            if (shown == NULL) RETURN_THROWS();
            zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " (%s) is not a finite f64",
                index, ZSTR_VAL(shown));
            zend_string_release(shown);
            param_throw_encode(message, NULL);
            RETURN_THROWS();
        }
        return;
    }
    if (zend_string_equals_literal(type, "bool")) {
        if (Z_TYPE_P(value) != IS_TRUE && Z_TYPE_P(value) != IS_FALSE) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        return;
    }
    if (zend_string_equals_literal(type, "decimal")) {
        if (Z_TYPE_P(value) != IS_STRING) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        zval *precision = param_field(slot, ZEND_STRL("precision"));
        zval *scale = param_field(slot, ZEND_STRL("scale"));
        zend_string *normalized = model_decimal_normalize(Z_STR_P(value),
            precision == NULL || Z_TYPE_P(precision) == IS_NULL ? 0 : zval_get_long(precision),
            scale == NULL || Z_TYPE_P(scale) == IS_NULL ? 0 : zval_get_long(scale));
        if (normalized == NULL) {
            if (EG(exception) != NULL) param_wrap_pending(index);
            RETURN_THROWS();
        }
        zend_string_release(normalized);
        return;
    }
    if (zend_string_equals_literal(type, "varchar") || zend_string_equals_literal(type, "text")
        || zend_string_equals_literal(type, "uuid")) {
        if (Z_TYPE_P(value) != IS_STRING) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        str bytes = {Z_STRVAL_P(value), Z_STRLEN_P(value)};
        if (utf8_valid_prefix(bytes) != bytes.n) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        if (memchr(bytes.s, '\0', bytes.n) != NULL) {
            zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " holds U+0000, which no %s value holds",
                index, ZSTR_VAL(type));
            param_throw_encode(message, NULL);
            RETURN_THROWS();
        }
        if (zend_string_equals_literal(type, "varchar")) {
            zval *length = param_field(slot, ZEND_STRL("length"));
            zend_long max = length == NULL || Z_TYPE_P(length) == IS_NULL ? 0 : zval_get_long(length);
            size_t characters = utf8_count(bytes);
            if (max > 0 && characters > (size_t)max) {
                zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " has %zu characters, more than varchar(" ZEND_LONG_FMT ")",
                    index, characters, max);
                param_throw_encode(message, NULL);
                RETURN_THROWS();
            }
        }
        if (zend_string_equals_literal(type, "uuid") && !param_uuid(Z_STR_P(value))) {
            zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " (\"%s\") is not a lower-case canonical uuid",
                index, Z_STRVAL_P(value));
            param_throw_encode(message, NULL);
            RETURN_THROWS();
        }
        return;
    }
    if (zend_string_equals_literal(type, "bytes")) {
        if (Z_TYPE_P(value) == IS_STRING) return;
        zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\Bytes"), 0);
        zend_class_entry *bytes_ce = zend_lookup_class(name);
        zend_string_release(name);
        if (EG(exception) != NULL) RETURN_THROWS();
        if (bytes_ce == NULL || Z_TYPE_P(value) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(value), bytes_ce)) {
            zend_string *bytes_type = zend_string_init("bytes", sizeof("bytes") - 1, 0);
            param_throw_kind(index, value, bytes_type);
            zend_string_release(bytes_type);
            RETURN_THROWS();
        }
        return;
    }
    if (zend_string_equals_literal(type, "date") || zend_string_equals_literal(type, "time")
        || zend_string_equals_literal(type, "datetime")) {
        if (Z_TYPE_P(value) != IS_STRING) {
            param_throw_kind(index, value, type);
            RETURN_THROWS();
        }
        zval *precision = param_field(slot, ZEND_STRL("precision"));
        zval converted;
        bool ok = param_call_time_value(value, type,
            precision == NULL || Z_TYPE_P(precision) == IS_NULL ? 0 : zval_get_long(precision), zone, &converted);
        if (!ok) {
            if (EG(exception) != NULL) param_wrap_pending(index);
            RETURN_THROWS();
        }
        if (!zend_string_equals_literal(type, "time")) {
            bool valid = Z_TYPE(converted) == IS_STRING && Z_STRLEN(converted) >= 5
                && Z_STRVAL(converted)[4] == '-' && memcmp(Z_STRVAL(converted), "0000", 4) != 0
                && Z_STRVAL(converted)[0] >= '0' && Z_STRVAL(converted)[0] <= '9'
                && Z_STRVAL(converted)[1] >= '0' && Z_STRVAL(converted)[1] <= '9'
                && Z_STRVAL(converted)[2] >= '0' && Z_STRVAL(converted)[2] <= '9'
                && Z_STRVAL(converted)[3] >= '0' && Z_STRVAL(converted)[3] <= '9';
            if (!valid) {
                zval_ptr_dtor(&converted);
                zend_string *shown = zval_get_string(value);
                if (EG(exception) != NULL) RETURN_THROWS();
                zend_string *message = zend_strpprintf(0, "parameter " ZEND_LONG_FMT " (\"%s\") is outside 0001-01-01 to 9999-12-31",
                    index, ZSTR_VAL(shown));
                zend_string_release(shown);
                param_throw_encode(message, NULL);
                RETURN_THROWS();
            }
        }
        zval_ptr_dtor(&converted);
    }
}
