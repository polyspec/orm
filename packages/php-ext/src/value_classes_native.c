/* Native implementations of the public value and notification classes. */
#include "php.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "dbspec.h"
#include "model_native_methods.h"
#include "orm_exception_object.h"
#include "ext/pdo/php_pdo.h"
#include "ext/pdo/php_pdo_driver.h"
#include <math.h>
#include <string.h>

static void value_throw_orm(const char *code, const char *message)
{
    db_throw_orm(code, "%s", message);
}

static bool value_call_method(zend_object *object, const char *method, zval *result, uint32_t argc, zval *params)
{
    zval callable, target;
    array_init_size(&callable, 2);
    ZVAL_OBJ_COPY(&target, object);
    add_next_index_zval(&callable, &target);
    add_next_index_string(&callable, method);
    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(&callable, 0, &fci, &fcc, NULL, NULL) != SUCCESS) {
        zval_ptr_dtor(&callable);
        return false;
    }
    fci.retval = result;
    fci.params = params;
    fci.param_count = argc;
    fci.named_params = NULL;
    zend_result status = zend_call_function(&fci, &fcc);
    zval_ptr_dtor(&callable);
    return status == SUCCESS && EG(exception) == NULL;
}

static zend_string *decimal_normalize(zend_string *input, zend_long precision, zend_long scale)
{
    return model_decimal_normalize(input, precision, scale);
}

static void decimal_decode_error(const char *message)
{
    value_throw_orm("CODEC_DECODE", message);
}

static void decimal_rethrow_decode_error(void)
{
    if (EG(exception) == NULL) return;
    zval message_rv;
    zval *message = zend_read_property(zend_ce_exception, EG(exception), ZEND_STRL("message"), 1, &message_rv);
    zend_string *text = Z_TYPE_P(message) == IS_STRING
        ? zend_strpprintf(0, "invalid decimal cell: %s", Z_STRVAL_P(message))
        : zend_string_init("invalid decimal cell", sizeof("invalid decimal cell") - 1, 0);
    zend_clear_exception();
    decimal_decode_error(ZSTR_VAL(text));
    zend_string_release(text);
}

ZEND_METHOD(Polyspec_Orm_Decimal, normalize)
{
    zend_string *input;
    zend_long precision, scale;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(input)
        Z_PARAM_LONG(precision)
        Z_PARAM_LONG(scale)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *result = decimal_normalize(input, precision, scale);
    if (result == NULL) RETURN_THROWS();
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Decimal, scaled)
{
    zend_string *input;
    zend_long precision, scale;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(input)
        Z_PARAM_LONG(precision)
        Z_PARAM_LONG(scale)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *normalized = decimal_normalize(input, precision, scale);
    if (normalized == NULL) RETURN_THROWS();
    zend_long value = 0;
    bool negative = ZSTR_VAL(normalized)[0] == '-';
    for (size_t i = negative ? 1 : 0; i < ZSTR_LEN(normalized); i++) {
        char c = ZSTR_VAL(normalized)[i];
        if (c == '.') continue;
        value = value * 10 + (c - '0');
    }
    zend_string_release(normalized);
    RETURN_LONG(negative ? -value : value);
}

static bool decimal_integer_text(zend_string *text)
{
    size_t i = 0;
    if (ZSTR_LEN(text) > 0 && ZSTR_VAL(text)[0] == '-') i++;
    if (i == ZSTR_LEN(text)) return false;
    for (; i < ZSTR_LEN(text); i++) {
        if (ZSTR_VAL(text)[i] < '0' || ZSTR_VAL(text)[i] > '9') return false;
    }
    return true;
}

ZEND_METHOD(Polyspec_Orm_Decimal, fromScaled)
{
    zval *value;
    zend_long precision, scale;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ZVAL(value)
        Z_PARAM_LONG(precision)
        Z_PARAM_LONG(scale)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *digits = NULL;
    if (Z_TYPE_P(value) == IS_LONG) {
        smart_str integer = {0};
        smart_str_append_long(&integer, Z_LVAL_P(value));
        smart_str_0(&integer);
        digits = integer.s;
    }
    else if (Z_TYPE_P(value) == IS_STRING && decimal_integer_text(Z_STR_P(value))) digits = zend_string_copy(Z_STR_P(value));
    if (digits == NULL) {
        decimal_decode_error("decimal scaled cell requires an integer");
        RETURN_THROWS();
    }
    if (scale > 1000) {
        zend_string *message = zend_strpprintf(0, "invalid decimal cell: decimal %s: invalid precision or scale", ZSTR_VAL(digits));
        zend_string_release(digits);
        decimal_decode_error(ZSTR_VAL(message));
        zend_string_release(message);
        RETURN_THROWS();
    }
    bool negative = ZSTR_VAL(digits)[0] == '-';
    size_t start = negative ? 1 : 0;
    smart_str raw = {0};
    if (negative) smart_str_appendc(&raw, '-');
    size_t count = ZSTR_LEN(digits) - start;
    if (scale > 0) {
        if (count > (size_t)scale) {
            smart_str_appendl(&raw, ZSTR_VAL(digits) + start, count - (size_t)scale);
            smart_str_appendc(&raw, '.');
            smart_str_appendl(&raw, ZSTR_VAL(digits) + start + count - (size_t)scale, (size_t)scale);
        } else {
            smart_str_appendc(&raw, '0');
            smart_str_appendc(&raw, '.');
            for (size_t i = count; i < (size_t)scale; i++) smart_str_appendc(&raw, '0');
            smart_str_appendl(&raw, ZSTR_VAL(digits) + start, count);
        }
    } else {
        smart_str_appendl(&raw, ZSTR_VAL(digits) + start, count);
    }
    smart_str_0(&raw);
    zend_string_release(digits);
    zend_string *result = decimal_normalize(raw.s, precision, scale);
    smart_str_free(&raw);
    if (result == NULL) {
        decimal_rethrow_decode_error();
        RETURN_THROWS();
    }
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Decimal, decode)
{
    zval *value;
    zend_long precision, scale;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ZVAL(value)
        Z_PARAM_LONG(precision)
        Z_PARAM_LONG(scale)
    ZEND_PARSE_PARAMETERS_END();
    if (Z_TYPE_P(value) != IS_STRING) {
        decimal_decode_error("decimal cell requires exact text");
        RETURN_THROWS();
    }
    zend_string *result = decimal_normalize(Z_STR_P(value), precision, scale);
    if (result == NULL) {
        decimal_rethrow_decode_error();
        RETURN_THROWS();
    }
    RETURN_STR(result);
}

static zend_string *transform_replace(zend_string *input, const char *from, const char *to)
{
    smart_str result = {0};
    for (size_t i = 0; i < ZSTR_LEN(input); i++) {
        char c = ZSTR_VAL(input)[i];
        if (c == from[0]) smart_str_appends(&result, to);
        else smart_str_appendc(&result, c);
    }
    smart_str_0(&result);
    return result.s == NULL ? zend_string_init("", 0, 0) : result.s;
}

static zend_string *transform_escape(zend_string *input)
{
    zend_string *first = transform_replace(input, "\\", "\\\\");
    zend_string *second = transform_replace(first, "%", "\\%");
    zend_string *third = transform_replace(second, "_", "\\_");
    zend_string_release(first);
    zend_string_release(second);
    return third;
}

static bool transform_split(zend_string *input, zval *parts)
{
    zval trim_fn, trimmed, split_fn, args[4], pattern, input_arg;
    ZVAL_STRING(&trim_fn, "trim");
    ZVAL_STR_COPY(&input_arg, input);
    ZVAL_UNDEF(&trimmed);
    if (call_user_function(EG(function_table), NULL, &trim_fn, &trimmed, 1, &input_arg) != SUCCESS || EG(exception) != NULL) {
        zval_ptr_dtor(&trim_fn);
        zval_ptr_dtor(&input_arg);
        if (!Z_ISUNDEF(trimmed)) zval_ptr_dtor(&trimmed);
        return false;
    }
    zval_ptr_dtor(&trim_fn);
    zval_ptr_dtor(&input_arg);
    ZVAL_STRING(&split_fn, "preg_split");
    ZVAL_STRING(&pattern, "/\\s+/u");
    ZVAL_COPY(&args[0], &pattern);
    ZVAL_COPY(&args[1], &trimmed);
    ZVAL_LONG(&args[2], -1);
    ZVAL_LONG(&args[3], 1);
    ZVAL_UNDEF(parts);
    bool ok = call_user_function(EG(function_table), NULL, &split_fn, parts, 4, args) == SUCCESS && EG(exception) == NULL;
    zval_ptr_dtor(&split_fn);
    zval_ptr_dtor(&pattern);
    zval_ptr_dtor(&trimmed);
    for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    if (!ok) return false;
    if (Z_TYPE_P(parts) == IS_FALSE) {
        array_init(parts);
        return true;
    }
    return Z_TYPE_P(parts) == IS_ARRAY;
}

static zend_string *transform_fulltext_boolean(zend_string *input)
{
    zval terms;
    if (!transform_split(input, &terms)) return NULL;
    smart_str result = {0};
    size_t used = 0;
    zval *word;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(terms), word) {
        if (Z_TYPE_P(word) != IS_STRING) continue;
        smart_str term = {0};
        for (size_t i = 0; i < Z_STRLEN_P(word); i++) {
            char c = Z_STRVAL_P(word)[i];
            if (strchr("+-<>~*\"@()", c) == NULL) smart_str_appendc(&term, c);
        }
        smart_str_0(&term);
        if (term.s != NULL && ZSTR_LEN(term.s) > 0) {
            if (used++ > 0) smart_str_appendc(&result, ' ');
            smart_str_appendc(&result, '+');
            smart_str_append(&result, term.s);
        }
        smart_str_free(&term);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&terms);
    smart_str_0(&result);
    if (result.s == NULL) return zend_string_init("", 0, 0);
    if (used == 0) {
        smart_str_free(&result);
        return zend_string_init("", 0, 0);
    }
    smart_str_appendc(&result, '*');
    smart_str_0(&result);
    return result.s;
}

ZEND_METHOD(Polyspec_Orm_Transform, fulltextBoolean)
{
    zend_string *input;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(input)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *result = transform_fulltext_boolean(input);
    if (result == NULL) RETURN_THROWS();
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Transform, apply)
{
    zend_string *kind, *input;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(kind)
        Z_PARAM_STR(input)
    ZEND_PARSE_PARAMETERS_END();
    if (zend_string_equals_literal(kind, "fulltext_boolean")) {
        zend_string *result = transform_fulltext_boolean(input);
        if (result == NULL) RETURN_THROWS();
        RETURN_STR(result);
    }
    if (!zend_string_equals_literal(kind, "like_contains") && !zend_string_equals_literal(kind, "like_starts")
        && !zend_string_equals_literal(kind, "like_ends")) RETURN_STR_COPY(input);
    zend_string *escaped = transform_escape(input);
    smart_str result = {0};
    if (zend_string_equals_literal(kind, "like_contains") || zend_string_equals_literal(kind, "like_ends")) smart_str_appendc(&result, '%');
    smart_str_append(&result, escaped);
    if (zend_string_equals_literal(kind, "like_contains") || zend_string_equals_literal(kind, "like_starts")) smart_str_appendc(&result, '%');
    zend_string_release(escaped);
    smart_str_0(&result);
    RETURN_STR(result.s);
}

ZEND_METHOD(Polyspec_Orm_Transform, param)
{
    zend_string *kind;
    zval *value;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(kind)
        Z_PARAM_ZVAL(value)
    ZEND_PARSE_PARAMETERS_END();
    if (Z_TYPE_P(value) == IS_NULL) RETURN_NULL();
    if (Z_TYPE_P(value) != IS_STRING) {
        db_throw_orm("CODEC_ENCODE", "%s requires a string value", ZSTR_VAL(kind));
        RETURN_THROWS();
    }
    if (zend_string_equals_literal(kind, "fulltext_boolean")) {
        zend_string *term = transform_fulltext_boolean(Z_STR_P(value));
        if (term == NULL) RETURN_THROWS();
        bool empty = ZSTR_LEN(term) == 0;
        zend_string_release(term);
        if (empty) {
            db_throw_orm("IR_INVALID", "fulltext search text has no term");
            RETURN_THROWS();
        }
    }
    if (zend_string_equals_literal(kind, "fulltext_boolean")) {
        zend_string *result = transform_fulltext_boolean(Z_STR_P(value));
        if (result == NULL) RETURN_THROWS();
        RETURN_STR(result);
    }
    if (!zend_string_equals_literal(kind, "like_contains") && !zend_string_equals_literal(kind, "like_starts")
        && !zend_string_equals_literal(kind, "like_ends")) RETURN_STR_COPY(Z_STR_P(value));
    zend_string *escaped = transform_escape(Z_STR_P(value));
    smart_str result = {0};
    if (zend_string_equals_literal(kind, "like_contains") || zend_string_equals_literal(kind, "like_ends")) smart_str_appendc(&result, '%');
    smart_str_append(&result, escaped);
    if (zend_string_equals_literal(kind, "like_contains") || zend_string_equals_literal(kind, "like_starts")) smart_str_appendc(&result, '%');
    zend_string_release(escaped);
    smart_str_0(&result);
    RETURN_STR(result.s);
}

ZEND_METHOD(Polyspec_Orm_Transform, esc)
{
    zend_string *input;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(input)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(transform_escape(input));
}

static bool subscription_open(zval *object, zval **pdo)
{
    zval rv;
    *pdo = zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), ZEND_STRL("pdo"), 1, &rv);
    if (Z_TYPE_P(*pdo) == IS_OBJECT) return true;
    db_throw_orm("CONFIG", "the LISTEN subscription is closed");
    return false;
}

static bool subscription_check_channel(zend_string *channel)
{
    if (ZSTR_LEN(channel) < 1 || ZSTR_LEN(channel) > 63 || memchr(ZSTR_VAL(channel), '\0', ZSTR_LEN(channel)) != NULL) {
        db_throw_orm("CONFIG", "a channel is 1 to 63 bytes without U+0000");
        return false;
    }
    return true;
}

static zend_string *subscription_quote_ident(zend_string *channel)
{
    smart_str result = {0};
    smart_str_appendc(&result, '"');
    for (size_t i = 0; i < ZSTR_LEN(channel); i++) {
        if (ZSTR_VAL(channel)[i] == '"') smart_str_appendc(&result, '"');
        smart_str_appendc(&result, ZSTR_VAL(channel)[i]);
    }
    smart_str_appendc(&result, '"');
    smart_str_0(&result);
    return result.s;
}

static bool subscription_call(zval *pdo, const char *method, zval *result, uint32_t argc, zval *a1, zval *a2)
{
    return pdo_call(pdo, method, result, argc, a1, a2);
}

ZEND_METHOD(Polyspec_Orm_Subscription, __construct)
{
    zval *pdo;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(pdo)
    ZEND_PARSE_PARAMETERS_END();
    zend_update_property(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("pdo"), pdo);
}

ZEND_METHOD(Polyspec_Orm_Subscription, checkChannel)
{
    zend_string *channel;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(channel)
    ZEND_PARSE_PARAMETERS_END();
    if (!subscription_check_channel(channel)) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Subscription, quoteIdent)
{
    zend_string *channel;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(channel)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(subscription_quote_ident(channel));
}

static bool subscription_wrap_pdo_error(zend_object *exception)
{
    zend_string *pdo_name = zend_string_init("PDOException", sizeof("PDOException") - 1, 0);
    zend_class_entry *pdo_ce = zend_lookup_class(pdo_name);
    zend_string_release(pdo_name);
    if (pdo_ce == NULL || !instanceof_function(exception->ce, pdo_ce)) return false;
    zval previous, wrapped, code, message;
    ZVAL_OBJ_COPY(&previous, exception);
    zval message_rv;
    zval *message_value = zend_read_property(zend_ce_exception, exception, ZEND_STRL("message"), 1, &message_rv);
    ZVAL_STRING(&code, "CONNECTION_LOST");
    ZVAL_COPY(&message, message_value);
    zend_clear_exception();
    zend_string *orm_name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *orm_ce = zend_lookup_class(orm_name);
    zend_string_release(orm_name);
    if (orm_ce == NULL) {
        zval_ptr_dtor(&previous); zval_ptr_dtor(&code); zval_ptr_dtor(&message);
        return false;
    }
    object_init_ex(&wrapped, orm_ce);
    zval result;
    ZVAL_UNDEF(&result);
    zval params[3];
    ZVAL_COPY(&params[0], &code); ZVAL_COPY(&params[1], &message); ZVAL_COPY(&params[2], &previous);
    value_call_method(Z_OBJ(wrapped), "__construct", &result, 3, params);
    for (size_t i = 0; i < 3; i++) zval_ptr_dtor(&params[i]);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    zval_ptr_dtor(&code); zval_ptr_dtor(&message); zval_ptr_dtor(&previous);
    if (EG(exception) != NULL) { zval_ptr_dtor(&wrapped); return false; }
    zend_throw_exception_object(&wrapped);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Subscription, receive)
{
    double timeout;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_DOUBLE(timeout)
    ZEND_PARSE_PARAMETERS_END();
    zval *pdo;
    if (!subscription_open(ZEND_THIS, &pdo)) RETURN_THROWS();
    double milliseconds = round(timeout * 1000.0);
    zend_long timeout_ms = milliseconds > (double)ZEND_LONG_MAX ? ZEND_LONG_MAX
        : milliseconds < (double)ZEND_LONG_MIN ? ZEND_LONG_MIN : (zend_long)milliseconds;
    zval mode, wait, row;
    ZVAL_LONG(&mode, PDO_FETCH_ASSOC);
    ZVAL_LONG(&wait, timeout_ms);
    ZVAL_UNDEF(&row);
    if (!subscription_call(pdo, "getNotify", &row, 2, &mode, &wait)) {
        if (EG(exception) != NULL) {
            zval closed;
            ZVAL_NULL(&closed);
            zend_update_property(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("pdo"), &closed);
            if (subscription_wrap_pdo_error(EG(exception))) RETURN_THROWS();
        }
        RETURN_THROWS();
    }
    if (Z_TYPE(row) == IS_FALSE) {
        zval ignored;
        zend_call_method_with_0_params(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "close", &ignored);
        if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
        if (EG(exception) != NULL) RETURN_THROWS();
        db_throw_orm("CANCELED", "the receive of the LISTEN subscription expired");
        RETURN_THROWS();
    }
    zval *channel = Z_TYPE(row) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(row), "message", sizeof("message") - 1) : NULL;
    zval *payload = Z_TYPE(row) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(row), "payload", sizeof("payload") - 1) : NULL;
    zval *pid = Z_TYPE(row) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(row), "pid", sizeof("pid") - 1) : NULL;
    zend_string *channel_text = channel == NULL ? zend_string_init("", 0, 0) : zval_get_string(channel);
    zend_string *payload_text = payload == NULL || Z_TYPE_P(payload) == IS_NULL ? zend_string_init("", 0, 0) : zval_get_string(payload);
    zend_long pid_value = pid == NULL ? 0 : zval_get_long(pid);
    if (EG(exception) != NULL) {
        if (channel_text != NULL) zend_string_release(channel_text);
        if (payload_text != NULL) zend_string_release(payload_text);
        zval_ptr_dtor(&row);
        RETURN_THROWS();
    }
    zend_string *class_name = zend_string_init("Polyspec\\Orm\\Notification", sizeof("Polyspec\\Orm\\Notification") - 1, 0);
    zend_class_entry *notification_ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (notification_ce == NULL) {
        zend_string_release(channel_text); zend_string_release(payload_text); zval_ptr_dtor(&row); RETURN_THROWS();
    }
    object_init_ex(return_value, notification_ce);
    zval args[3], ignored;
    ZVAL_STR(&args[0], channel_text); ZVAL_STR(&args[1], payload_text); ZVAL_LONG(&args[2], pid_value);
    ZVAL_UNDEF(&ignored);
    value_call_method(Z_OBJ_P(return_value), "__construct", &ignored, 3, args);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&row);
    if (EG(exception) != NULL) { zval_ptr_dtor(return_value); RETURN_THROWS(); }
}

ZEND_METHOD(Polyspec_Orm_Subscription, unlisten)
{
    zend_string *channel;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(channel)
    ZEND_PARSE_PARAMETERS_END();
    if (!subscription_check_channel(channel)) RETURN_THROWS();
    zval *pdo;
    if (!subscription_open(ZEND_THIS, &pdo)) RETURN_THROWS();
    zend_string *ident = subscription_quote_ident(channel);
    zval result;
    ZVAL_UNDEF(&result);
    zval sql;
    ZVAL_STR(&sql, zend_strpprintf(0, "UNLISTEN %s", ZSTR_VAL(ident)));
    zend_string_release(ident);
    bool ok = subscription_call(pdo, "exec", &result, 1, &sql, NULL);
    zval_ptr_dtor(&sql);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    if (!ok || EG(exception) != NULL) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Subscription, close)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv;
    zval *pdo = zend_read_property(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("pdo"), 1, &rv);
    if (Z_TYPE_P(pdo) != IS_OBJECT) RETURN_NULL();
    zval pdo_copy;
    ZVAL_COPY(&pdo_copy, pdo);
    ZVAL_NULL(&rv);
    zend_update_property(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("pdo"), &rv);
    zval sql, result;
    ZVAL_STRING(&sql, "UNLISTEN *"); ZVAL_UNDEF(&result);
    bool ok = subscription_call(&pdo_copy, "exec", &result, 1, &sql, NULL);
    zval_ptr_dtor(&sql);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    zval_ptr_dtor(&pdo_copy);
    if (!ok || EG(exception) != NULL) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Subscription, open)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *pdo;
    if (!subscription_open(ZEND_THIS, &pdo)) RETURN_THROWS();
    RETURN_COPY(pdo);
}

ZEND_METHOD(Polyspec_Orm_Notification, __construct)
{
    zend_string *channel, *payload;
    zend_long pid;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(channel)
        Z_PARAM_STR(payload)
        Z_PARAM_LONG(pid)
    ZEND_PARSE_PARAMETERS_END();
    zend_update_property_str(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("channel"), channel);
    zend_update_property_str(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("payload"), payload);
    zend_update_property_long(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("pid"), pid);
}
