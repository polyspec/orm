/* Native implementation of the SQL dialect used by the PHP client. */
#include "php.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "dbspec.h"
#include <ctype.h>
#include <string.h>

static zend_string *dialect_name(zval *object)
{
    zval rv;
    zval *name = zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), ZEND_STRL("name"), 1, &rv);
    return Z_STR_P(name);
}

static bool dialect_is(zval *object, const char *name)
{
    return zend_string_equals_cstr(dialect_name(object), name, strlen(name));
}

static zend_string *dialect_quote_with(zend_string *quote, zend_string *ident)
{
    smart_str out = {0};
    const char *value = ZSTR_VAL(ident);
    size_t length = ZSTR_LEN(ident), start = 0, quote_length = ZSTR_LEN(quote);
    for (size_t i = 0; i <= length; i++) {
        if (i == length || value[i] == '.') {
            smart_str_append(&out, quote);
            for (size_t j = start; j < i;) {
                if (quote_length > 0 && j + quote_length <= i
                    && memcmp(value + j, ZSTR_VAL(quote), quote_length) == 0) {
                    smart_str_append(&out, quote);
                    smart_str_append(&out, quote);
                    j += quote_length;
                } else {
                    smart_str_appendc(&out, value[j++]);
                }
            }
            smart_str_append(&out, quote);
            if (i < length) smart_str_appendc(&out, '.');
            start = i + 1;
        }
    }
    smart_str_0(&out);
    return out.s;
}

static zend_string *dialect_quote(zval *object, zend_string *ident)
{
    zend_string *quote = zend_string_init(dialect_is(object, "mysql") ? "`" : "\"", 1, 0);
    if (!dialect_is(object, "sqlite")) {
        zend_string *result = dialect_quote_with(quote, ident);
        zend_string_release(quote);
        return result;
    }
    smart_str replaced = {0};
    for (size_t i = 0; i < ZSTR_LEN(ident); i++) {
        if (ZSTR_VAL(ident)[i] == '.') smart_str_appends(&replaced, "__");
        else smart_str_appendc(&replaced, ZSTR_VAL(ident)[i]);
    }
    smart_str_0(&replaced);
    zend_string *result = dialect_quote_with(quote, replaced.s);
    zend_string_release(quote);
    smart_str_free(&replaced);
    return result;
}

static zend_string *dialect_ascii_lower(zend_string *input)
{
    smart_str out = {0};
    for (int i = 0; i < 26; i++) smart_str_appends(&out, "REPLACE(");
    smart_str_append(&out, input);
    for (int i = 0; i < 26; i++) smart_str_append_printf(&out, ", '%c', '%c')", 'A' + i, 'a' + i);
    smart_str_0(&out);
    return out.s;
}

static zend_string *dialect_join(HashTable *values, const char *separator)
{
    smart_str out = {0};
    zval *value;
    bool first = true;
    ZEND_HASH_FOREACH_VAL(values, value) {
        if (!first) smart_str_appends(&out, separator);
        zend_string *text = zval_get_string(value);
        if (EG(exception) != NULL) {
            if (text != NULL) zend_string_release(text);
            smart_str_free(&out);
            return NULL;
        }
        smart_str_append(&out, text);
        zend_string_release(text);
        first = false;
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&out);
    return out.s == NULL ? ZSTR_EMPTY_ALLOC() : out.s;
}

static bool dialect_call(zval *closure, uint32_t argc, zval *arguments, zval *result)
{
    ZVAL_UNDEF(result);
    return call_user_function(EG(function_table), NULL, closure, result, argc, arguments) == SUCCESS
        && EG(exception) == NULL;
}

static zend_string *dialect_call_text(zval *closure, uint32_t argc, zval *arguments)
{
    zval result;
    if (!dialect_call(closure, argc, arguments, &result)) {
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        return NULL;
    }
    zend_string *text = zval_get_string(&result);
    zval_ptr_dtor(&result);
    return text;
}

static zend_string *dialect_call_zero(zval *closure)
{
    return dialect_call_text(closure, 0, NULL);
}

static const char *dialect_bound(const char *unit)
{
    if (strcmp(unit, "second") == 0) return "315537897600";
    if (strcmp(unit, "minute") == 0) return "5258964960";
    if (strcmp(unit, "hour") == 0) return "87649416";
    if (strcmp(unit, "day") == 0) return "3652059";
    return "119988";
}

static zend_string *dialect_guard_interval(const char *unit, const char *cast, zval *arg)
{
    zend_string *first = dialect_call_zero(arg);
    if (first == NULL) return NULL;
    zend_string *second = dialect_call_zero(arg);
    if (second == NULL) {
        zend_string_release(first);
        return NULL;
    }
    zend_string *operand = cast[0] == '\0' ? zend_string_copy(first)
        : zend_strpprintf(0, "CAST(%s AS %s)", ZSTR_VAL(first), cast);
    zend_string *value = cast[0] == '\0' ? zend_string_copy(second)
        : zend_strpprintf(0, "CAST(%s AS %s)", ZSTR_VAL(second), cast);
    zend_string *result = zend_strpprintf(0, "CASE WHEN %s BETWEEN -%s AND %s THEN %s END",
        ZSTR_VAL(operand), dialect_bound(unit), dialect_bound(unit), ZSTR_VAL(value));
    zend_string_release(first);
    zend_string_release(second);
    zend_string_release(operand);
    zend_string_release(value);
    return result;
}

static zend_string *dialect_guard_result(zend_string *first, zend_string *second)
{
    return zend_strpprintf(0,
        "CASE WHEN %s BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN %s END",
        ZSTR_VAL(first), ZSTR_VAL(second));
}

static HashTable *dialect_persistent_array(uint32_t capacity)
{
    HashTable *values = pemalloc(sizeof(HashTable), 1);
    zend_hash_init(values, capacity, NULL, NULL, 1);
    return values;
}

static void dialect_add_string(HashTable *values, const char *key, const char *value)
{
    zval item;
    ZVAL_INTERNED_STR(&item, zend_string_init_interned(value, strlen(value), 1));
    zend_hash_add_new(values, zend_string_init_interned(key, strlen(key), 1), &item);
}

static void dialect_add_long(HashTable *values, const char *key, zend_long value)
{
    zval item;
    ZVAL_LONG(&item, value);
    zend_hash_add_new(values, zend_string_init_interned(key, strlen(key), 1), &item);
}

static void dialect_declare_array_constant(zend_class_entry *ce, const char *name, HashTable *values, uint32_t flags)
{
    GC_ADD_FLAGS(values, IS_ARRAY_IMMUTABLE);
    zval value;
    ZVAL_ARR(&value, values);
    Z_TYPE_FLAGS(value) = 0;
    zend_string *constant_name = zend_string_init_interned(name, strlen(name), 1);
    zend_declare_typed_class_constant(ce, constant_name, &value, flags, NULL,
        (zend_type)ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
}

void native_dialect_register(zend_class_entry *ce)
{
    static const char *const fn_names[] = {"day_of_week", "year", "month", "date"};
    static const char *const value_names[] = {"seconds_ago", "minutes_ago", "hours_ago", "days_ago", "months_ago",
        "seconds_later", "minutes_later", "hours_later", "days_later", "months_later"};
    static const char *const units[] = {"second", "minute", "hour", "day", "month", "second", "minute", "hour", "day", "month"};
    static const char *const bound_names[] = {"second", "minute", "hour", "day", "month"};
    static const char *const bounds[] = {"315537897600", "5258964960", "87649416", "3652059", "119988"};
    HashTable *arity = dialect_persistent_array(4);
    for (size_t i = 0; i < 4; i++) dialect_add_long(arity, fn_names[i], 0);
    dialect_declare_array_constant(ce, "COLUMN_FUNCTION_ARITY", arity, ZEND_ACC_PUBLIC);

    HashTable *types = dialect_persistent_array(4);
    for (size_t i = 0; i < 4; i++) {
        HashTable *accepted = dialect_persistent_array(2);
        zval date, datetime;
        ZVAL_INTERNED_STR(&date, zend_string_init_interned("date", sizeof("date") - 1, 1));
        ZVAL_INTERNED_STR(&datetime, zend_string_init_interned("datetime", sizeof("datetime") - 1, 1));
        zend_hash_next_index_insert_new(accepted, &date);
        zend_hash_next_index_insert_new(accepted, &datetime);
        GC_ADD_FLAGS(accepted, IS_ARRAY_IMMUTABLE);
        zval item;
        ZVAL_ARR(&item, accepted);
        Z_TYPE_FLAGS(item) = 0;
        zend_hash_add_new(types, zend_string_init_interned(fn_names[i], strlen(fn_names[i]), 1), &item);
    }
    dialect_declare_array_constant(ce, "COLUMN_FUNCTION_TYPES", types, ZEND_ACC_PUBLIC);

    HashTable *units_map = dialect_persistent_array(10);
    for (size_t i = 0; i < 10; i++) dialect_add_string(units_map, value_names[i], units[i]);
    dialect_declare_array_constant(ce, "VALUE_FUNCTION_UNITS", units_map, ZEND_ACC_PUBLIC);

    HashTable *bounds_map = dialect_persistent_array(5);
    for (size_t i = 0; i < 5; i++) dialect_add_string(bounds_map, bound_names[i], bounds[i]);
    dialect_declare_array_constant(ce, "INTERVAL_BOUNDS", bounds_map, ZEND_ACC_PRIVATE);
}

ZEND_METHOD(Polyspec_Orm_Dialect, __construct)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    if (!zend_string_equals_literal(name, "mysql") && !zend_string_equals_literal(name, "postgres")
        && !zend_string_equals_literal(name, "sqlite")) {
        db_throw_orm("DIALECT_UNKNOWN", "%s", ZSTR_VAL(name));
        RETURN_THROWS();
    }
    zend_update_property_str(Z_OBJCE_P(ZEND_THIS), Z_OBJ_P(ZEND_THIS), ZEND_STRL("name"), name);
}

ZEND_METHOD(Polyspec_Orm_Dialect, isValueFunction)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    static const char *const names[] = {"seconds_ago", "minutes_ago", "hours_ago", "days_ago", "months_ago",
        "seconds_later", "minutes_later", "hours_later", "days_later", "months_later", "now", "today"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (zend_string_equals_cstr(name, names[i], strlen(names[i]))) RETURN_TRUE;
    }
    RETURN_FALSE;
}

ZEND_METHOD(Polyspec_Orm_Dialect, quoteWith)
{
    zend_string *quote, *ident;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(quote)
        Z_PARAM_STR(ident)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(dialect_quote_with(quote, ident));
}

ZEND_METHOD(Polyspec_Orm_Dialect, quote)
{
    zend_string *ident;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(ident)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(dialect_quote(ZEND_THIS, ident));
}

ZEND_METHOD(Polyspec_Orm_Dialect, placeholder)
{
    zend_long n;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_LONG(n)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "postgres")) RETURN_STR(zend_strpprintf(0, "$" ZEND_LONG_FMT, n));
    RETURN_STRING("?");
}

ZEND_METHOD(Polyspec_Orm_Dialect, limit)
{
    zend_long offset, count;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_LONG(offset)
        Z_PARAM_LONG(count)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "mysql")) {
        RETURN_STR(zend_strpprintf(0, " LIMIT " ZEND_LONG_FMT ", " ZEND_LONG_FMT, offset, count));
    }
    RETURN_STR(zend_strpprintf(0, " LIMIT " ZEND_LONG_FMT " OFFSET " ZEND_LONG_FMT, count, offset));
}

ZEND_METHOD(Polyspec_Orm_Dialect, limitParams)
{
    zend_string *offset, *count;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(offset)
        Z_PARAM_STR(count)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "mysql")) RETURN_STR(zend_strpprintf(0, " LIMIT %s, %s", ZSTR_VAL(offset), ZSTR_VAL(count)));
    RETURN_STR(zend_strpprintf(0, " LIMIT %s OFFSET %s", ZSTR_VAL(count), ZSTR_VAL(offset)));
}

ZEND_METHOD(Polyspec_Orm_Dialect, forceIndex)
{
    zend_string *index;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(index)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "postgres")) RETURN_EMPTY_STRING();
    zend_string *quote = zend_string_init(dialect_is(ZEND_THIS, "mysql") ? "`" : "\"", 1, 0);
    zend_string *quoted = dialect_quote_with(quote, index);
    zend_string_release(quote);
    zend_string *result = strpprintf(0, dialect_is(ZEND_THIS, "mysql") ? " FORCE INDEX (%s)" : " INDEXED BY %s", ZSTR_VAL(quoted));
    zend_string_release(quoted);
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, insertReturningId)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_BOOL(!dialect_is(ZEND_THIS, "mysql"));
}

ZEND_METHOD(Polyspec_Orm_Dialect, now)
{
    zend_long precision;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_LONG(precision)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "mysql") && precision > 0) RETURN_STR(zend_strpprintf(0, "CURRENT_TIMESTAMP(" ZEND_LONG_FMT ")", precision));
    RETURN_STRING("CURRENT_TIMESTAMP");
}

ZEND_METHOD(Polyspec_Orm_Dialect, handlesStyle)
{
    zend_string *style;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(style)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(dialect_is(ZEND_THIS, "mysql") && zend_string_equals_literal(style, "ip"));
}

ZEND_METHOD(Polyspec_Orm_Dialect, decodesStyle)
{
    zend_string *style;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(style)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(dialect_is(ZEND_THIS, "mysql") && zend_string_equals_literal(style, "ip"));
}

ZEND_METHOD(Polyspec_Orm_Dialect, hostNow)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_BOOL(!dialect_is(ZEND_THIS, "mysql"));
}

ZEND_METHOD(Polyspec_Orm_Dialect, clockOperand)
{
    zend_string *column;
    zend_long precision;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_LONG(precision)
    ZEND_PARSE_PARAMETERS_END();
    if (!dialect_is(ZEND_THIS, "sqlite") || precision >= 6) RETURN_STR_COPY(column);
    zend_long zeros = 6 - precision;
    if (precision == 0) RETURN_STR(zend_strpprintf(0, "(%s || '.000000')", ZSTR_VAL(column)));
    smart_str result = {0};
    smart_str_append_printf(&result, "(%s || '", ZSTR_VAL(column));
    for (zend_long i = 0; i < zeros; i++) smart_str_appendc(&result, '0');
    smart_str_appends(&result, "')");
    smart_str_0(&result);
    RETURN_STR(result.s);
}

ZEND_METHOD(Polyspec_Orm_Dialect, asciiLower)
{
    zend_string *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(value)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(dialect_ascii_lower(value));
}

ZEND_METHOD(Polyspec_Orm_Dialect, contains)
{
    zend_string *column, *placeholder;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_STR(placeholder)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "mysql")) {
        zend_string *left = dialect_ascii_lower(column);
        zend_string *right = dialect_ascii_lower(placeholder);
        zend_string *result = zend_strpprintf(0, "%s LIKE %s", ZSTR_VAL(left), ZSTR_VAL(right));
        zend_string_release(left);
        zend_string_release(right);
        RETURN_STR(result);
    }
    if (dialect_is(ZEND_THIS, "postgres")) RETURN_STR(zend_strpprintf(0, "%s ILIKE %s", ZSTR_VAL(column), ZSTR_VAL(placeholder)));
    RETURN_STR(zend_strpprintf(0, "%s LIKE %s ESCAPE '\\'", ZSTR_VAL(column), ZSTR_VAL(placeholder)));
}

ZEND_METHOD(Polyspec_Orm_Dialect, containsBinary)
{
    zend_string *column;
    zval *value;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_OBJECT_OF_CLASS(value, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zval argument;
    ZVAL_STRING(&argument, dialect_is(ZEND_THIS, "sqlite") ? "" : "like_contains");
    zend_string *placeholder = dialect_call_text(value, 1, &argument);
    zval_ptr_dtor(&argument);
    if (placeholder == NULL) RETURN_THROWS();
    zend_string *result = dialect_is(ZEND_THIS, "sqlite")
        ? zend_strpprintf(0, "instr(%s, %s) > 0", ZSTR_VAL(column), ZSTR_VAL(placeholder))
        : zend_strpprintf(0, "%s LIKE %s", ZSTR_VAL(column), ZSTR_VAL(placeholder));
    zend_string_release(placeholder);
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, fulltext)
{
    HashTable *columns;
    zval *value;
    bool boolean;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY_HT(columns)
        Z_PARAM_OBJECT_OF_CLASS(value, zend_ce_closure)
        Z_PARAM_BOOL(boolean)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "sqlite")) RETURN_NULL();

    if (dialect_is(ZEND_THIS, "mysql")) {
        zend_string *joined = dialect_join(columns, ", ");
        if (joined == NULL) RETURN_THROWS();
        zval tag;
        ZVAL_STRING(&tag, boolean ? "fulltext_boolean" : "");
        zend_string *placeholder = dialect_call_text(value, 1, &tag);
        zval_ptr_dtor(&tag);
        if (placeholder == NULL) {
            zend_string_release(joined);
            RETURN_THROWS();
        }
        zend_string *result = zend_strpprintf(0, "MATCH (%s) AGAINST (%s IN %s MODE)",
            ZSTR_VAL(joined), ZSTR_VAL(placeholder), boolean ? "BOOLEAN" : "NATURAL LANGUAGE");
        zend_string_release(joined);
        zend_string_release(placeholder);
        RETURN_STR(result);
    }

    smart_str expressions = {0};
    zval *column;
    bool first = true;
    ZEND_HASH_FOREACH_VAL(columns, column) {
        if (!first) smart_str_appends(&expressions, " || ' ' || ");
        zend_string *text = zval_get_string(column);
        if (EG(exception) != NULL) {
            if (text != NULL) zend_string_release(text);
            smart_str_free(&expressions);
            RETURN_THROWS();
        }
        smart_str_append_printf(&expressions, "coalesce(%s, '')", ZSTR_VAL(text));
        zend_string_release(text);
        first = false;
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&expressions);

    zval tag;
    ZVAL_EMPTY_STRING(&tag);
    zend_string *placeholder = dialect_call_text(value, 1, &tag);
    zval_ptr_dtor(&tag);
    if (placeholder == NULL) {
        smart_str_free(&expressions);
        RETURN_THROWS();
    }
    zend_string *result = zend_strpprintf(0, "to_tsvector('simple', %s) @@ %s('simple', %s)",
        expressions.s == NULL ? "" : ZSTR_VAL(expressions.s),
        boolean ? "websearch_to_tsquery" : "plainto_tsquery", ZSTR_VAL(placeholder));
    smart_str_free(&expressions);
    zend_string_release(placeholder);
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, upsert)
{
    HashTable *conflict;
    zend_string *assigns;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(conflict)
        Z_PARAM_STR(assigns)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "mysql")) RETURN_STR(zend_strpprintf(0, " ON DUPLICATE KEY UPDATE %s", ZSTR_VAL(assigns)));
    zend_string *quote = zend_string_init("\"", 1, 0);
    smart_str columns = {0};
    zval *column;
    bool first = true;
    ZEND_HASH_FOREACH_VAL(conflict, column) {
        zend_string *name = zval_get_string(column);
        if (EG(exception) != NULL) {
            if (name != NULL) zend_string_release(name);
            zend_string_release(quote);
            smart_str_free(&columns);
            RETURN_THROWS();
        }
        zend_string *quoted = dialect_quote_with(quote, name);
        if (!first) smart_str_appends(&columns, ", ");
        smart_str_append(&columns, quoted);
        zend_string_release(name);
        zend_string_release(quoted);
        first = false;
    } ZEND_HASH_FOREACH_END();
    zend_string_release(quote);
    smart_str_0(&columns);
    zend_string *result = zend_strpprintf(0, " ON CONFLICT (%s) DO UPDATE SET %s",
        columns.s == NULL ? "" : ZSTR_VAL(columns.s), ZSTR_VAL(assigns));
    smart_str_free(&columns);
    RETURN_STR(result);
}

static bool dialect_check_style(zend_string *style)
{
    if (zend_string_equals_literal(style, "ip")) return true;
    zend_throw_exception(zend_ce_unhandled_match_error, "Unhandled match case", 0);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Dialect, readExpr)
{
    zend_string *column;
    HashTable *styles;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_ARRAY_HT(styles)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *result = zend_string_copy(column);
    for (zend_long i = (zend_long)zend_hash_num_elements(styles) - 1; i >= 0; i--) {
        zval *style = zend_hash_index_find(styles, (zend_ulong)i);
        if (style == NULL || Z_TYPE_P(style) != IS_STRING || !dialect_check_style(Z_STR_P(style))) {
            zend_string_release(result);
            RETURN_THROWS();
        }
        zend_string *next = zend_strpprintf(0, "INET6_NTOA(%s)", ZSTR_VAL(result));
        zend_string_release(result);
        result = next;
    }
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, writeExpr)
{
    zend_string *placeholder;
    HashTable *styles;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(placeholder)
        Z_PARAM_ARRAY_HT(styles)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *result = zend_string_copy(placeholder);
    zval *style;
    ZEND_HASH_FOREACH_VAL(styles, style) {
        if (Z_TYPE_P(style) != IS_STRING || !dialect_check_style(Z_STR_P(style))) {
            zend_string_release(result);
            RETURN_THROWS();
        }
        zend_string *next = zend_strpprintf(0, "INET6_ATON(%s)", ZSTR_VAL(result));
        zend_string_release(result);
        result = next;
    } ZEND_HASH_FOREACH_END();
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, readTime)
{
    zend_string *column;
    zend_long precision;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_LONG(precision)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "mysql")) RETURN_STR(zend_strpprintf(0, "CAST(%s AS CHAR)", ZSTR_VAL(column)));
    if (dialect_is(ZEND_THIS, "postgres")) {
        if (precision == 0) RETURN_STR(zend_strpprintf(0, "to_char(%s, 'HH24:MI:SS')", ZSTR_VAL(column)));
        RETURN_STR(zend_strpprintf(0, "substr(to_char(%s, 'HH24:MI:SS.US'), 1, " ZEND_LONG_FMT ")",
            ZSTR_VAL(column), 9 + precision));
    }
    RETURN_STR_COPY(column);
}

ZEND_METHOD(Polyspec_Orm_Dialect, writeTime)
{
    zend_string *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(value)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "postgres")) RETURN_STR(zend_strpprintf(0, "CAST(CAST(%s AS text) AS time)", ZSTR_VAL(value)));
    RETURN_STR_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_Dialect, readUuid)
{
    zend_string *column;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(column)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "postgres")) RETURN_STR(zend_strpprintf(0, "CAST(%s AS text)", ZSTR_VAL(column)));
    RETURN_STR_COPY(column);
}

ZEND_METHOD(Polyspec_Orm_Dialect, writeUuid)
{
    zend_string *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(value)
    ZEND_PARSE_PARAMETERS_END();
    if (dialect_is(ZEND_THIS, "postgres")) RETURN_STR(zend_strpprintf(0, "CAST(CAST(%s AS text) AS uuid)", ZSTR_VAL(value)));
    RETURN_STR_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_Dialect, rowLock)
{
    zend_string *mode;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(mode)
    ZEND_PARSE_PARAMETERS_END();
    if (!zend_string_equals_literal(mode, "update") && !zend_string_equals_literal(mode, "share")
        && !zend_string_equals_literal(mode, "update_nowait") && !zend_string_equals_literal(mode, "share_nowait")) {
        RETURN_NULL();
    }
    if (dialect_is(ZEND_THIS, "sqlite")) RETURN_EMPTY_STRING();
    zend_string *upper = zend_string_copy(mode);
    for (size_t i = 0; i < ZSTR_LEN(upper); i++) {
        ZSTR_VAL(upper)[i] = ZSTR_VAL(upper)[i] == '_' ? ' ' : (char)toupper((unsigned char)ZSTR_VAL(upper)[i]);
    }
    zend_string *result = zend_strpprintf(0, " FOR %s", ZSTR_VAL(upper));
    zend_string_release(upper);
    RETURN_STR(result);
}

static zend_string *dialect_literal_string(zend_string *text)
{
    smart_str out = {0};
    smart_str_appendc(&out, '\'');
    for (size_t i = 0; i < ZSTR_LEN(text); i++) {
        smart_str_appendc(&out, ZSTR_VAL(text)[i]);
        if (ZSTR_VAL(text)[i] == '\'') smart_str_appendc(&out, '\'');
    }
    smart_str_appendc(&out, '\'');
    smart_str_0(&out);
    return out.s;
}

ZEND_METHOD(Polyspec_Orm_Dialect, literal)
{
    zend_string *text;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(text)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(dialect_literal_string(text));
}

ZEND_METHOD(Polyspec_Orm_Dialect, restartIdentity)
{
    zend_string *table, *column;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(table)
        Z_PARAM_STR(column)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *quote = zend_string_init(dialect_is(ZEND_THIS, "mysql") ? "`" : "\"", 1, 0);
    zend_string *quoted_table = dialect_quote_with(quote, table);
    zend_string *quoted_column = dialect_quote_with(quote, column);
    zend_string_release(quote);
    if (dialect_is(ZEND_THIS, "mysql")) {
        zend_string *result = zend_strpprintf(0, "ALTER TABLE %s AUTO_INCREMENT = 1", ZSTR_VAL(quoted_table));
        zend_string_release(quoted_table);
        zend_string_release(quoted_column);
        RETURN_STR(result);
    }
    if (dialect_is(ZEND_THIS, "postgres")) {
        zend_string *table_literal = dialect_literal_string(quoted_table);
        zend_string *column_literal = dialect_literal_string(column);
        zend_string *result = zend_strpprintf(0,
            "SELECT setval(pg_get_serial_sequence(%s, %s), COALESCE(MAX(%s), 0) + 1, false) FROM %s",
            ZSTR_VAL(table_literal), ZSTR_VAL(column_literal), ZSTR_VAL(quoted_column), ZSTR_VAL(quoted_table));
        zend_string_release(table_literal);
        zend_string_release(column_literal);
        zend_string_release(quoted_table);
        zend_string_release(quoted_column);
        RETURN_STR(result);
    }
    zend_string *literal_table = dialect_literal_string(table);
    zend_string *result = zend_strpprintf(0,
        "UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(%s), 0) FROM %s) WHERE name = %s",
        ZSTR_VAL(quoted_column), ZSTR_VAL(quoted_table), ZSTR_VAL(literal_table));
    zend_string_release(literal_table);
    zend_string_release(quoted_table);
    zend_string_release(quoted_column);
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, random)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_STRING(dialect_is(ZEND_THIS, "mysql") ? "RAND()" : "random()");
}

ZEND_METHOD(Polyspec_Orm_Dialect, nullsOrder)
{
    bool desc;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_BOOL(desc)
    ZEND_PARSE_PARAMETERS_END();
    if (!dialect_is(ZEND_THIS, "postgres")) RETURN_EMPTY_STRING();
    RETURN_STRING(desc ? " NULLS LAST" : " NULLS FIRST");
}

ZEND_METHOD(Polyspec_Orm_Dialect, tupleIn)
{
    HashTable *columns, *rows;
    bool negate;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY_HT(columns)
        Z_PARAM_ARRAY_HT(rows)
        Z_PARAM_BOOL(negate)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *column_sql = dialect_join(columns, ", ");
    if (column_sql == NULL) RETURN_THROWS();
    smart_str tuples = {0};
    zval *row;
    bool first_row = true;
    ZEND_HASH_FOREACH_VAL(rows, row) {
        if (Z_TYPE_P(row) != IS_ARRAY) {
            zend_string_release(column_sql);
            smart_str_free(&tuples);
            zend_type_error("Dialect::tupleIn(): each row must be an array");
            RETURN_THROWS();
        }
        if (!first_row) smart_str_appends(&tuples, ", ");
        smart_str_appendc(&tuples, '(');
        zend_string *row_sql = dialect_join(Z_ARRVAL_P(row), ", ");
        if (row_sql == NULL) {
            zend_string_release(column_sql);
            smart_str_free(&tuples);
            RETURN_THROWS();
        }
        smart_str_append(&tuples, row_sql);
        zend_string_release(row_sql);
        smart_str_appendc(&tuples, ')');
        first_row = false;
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&tuples);
    zend_string *result = zend_strpprintf(0, "(%s)%s(%s%s)", ZSTR_VAL(column_sql), negate ? " NOT IN " : " IN ",
        dialect_is(ZEND_THIS, "sqlite") ? "VALUES " : "", tuples.s == NULL ? "" : ZSTR_VAL(tuples.s));
    zend_string_release(column_sql);
    smart_str_free(&tuples);
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, columnFunction)
{
    zend_string *fn, *column;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(fn)
        Z_PARAM_STR(column)
    ZEND_PARSE_PARAMETERS_END();
    const char *expression = NULL;
    if (zend_string_equals_literal(fn, "day_of_week")) {
        expression = dialect_is(ZEND_THIS, "mysql") ? "DAYOFWEEK(%s)"
            : dialect_is(ZEND_THIS, "postgres") ? "(EXTRACT(DOW FROM %s)::int + 1)"
            : "(CAST(strftime('%w', %s) AS INTEGER) + 1)";
    } else if (zend_string_equals_literal(fn, "year")) {
        expression = dialect_is(ZEND_THIS, "mysql") ? "YEAR(%s)"
            : dialect_is(ZEND_THIS, "postgres") ? "EXTRACT(YEAR FROM %s)::int"
            : "CAST(strftime('%Y', %s) AS INTEGER)";
    } else if (zend_string_equals_literal(fn, "month")) {
        expression = dialect_is(ZEND_THIS, "mysql") ? "MONTH(%s)"
            : dialect_is(ZEND_THIS, "postgres") ? "EXTRACT(MONTH FROM %s)::int"
            : "CAST(strftime('%m', %s) AS INTEGER)";
    } else if (zend_string_equals_literal(fn, "date")) {
        expression = dialect_is(ZEND_THIS, "mysql") ? "DATE(%s)"
            : dialect_is(ZEND_THIS, "postgres") ? "CAST(%s AS date)" : "date(%s)";
    }
    if (expression == NULL) RETURN_NULL();
    RETURN_STR(zend_strpprintf(0, expression, ZSTR_VAL(column)));
}

static const char *dialect_unit(zend_string *fn)
{
    if (zend_string_equals_literal(fn, "seconds_ago") || zend_string_equals_literal(fn, "seconds_later")) return "second";
    if (zend_string_equals_literal(fn, "minutes_ago") || zend_string_equals_literal(fn, "minutes_later")) return "minute";
    if (zend_string_equals_literal(fn, "hours_ago") || zend_string_equals_literal(fn, "hours_later")) return "hour";
    if (zend_string_equals_literal(fn, "days_ago") || zend_string_equals_literal(fn, "days_later")) return "day";
    if (zend_string_equals_literal(fn, "months_ago") || zend_string_equals_literal(fn, "months_later")) return "month";
    return NULL;
}

static zend_string *dialect_interval_expression(zval *object, const char *unit, bool later, zval *arg, zval *now)
{
    if (dialect_is(object, "mysql")) {
        zend_string *interval = dialect_guard_interval(unit, "", arg);
        if (interval == NULL) return NULL;
        zend_string *upper = zend_string_init(unit, strlen(unit), 0);
        for (size_t i = 0; i < ZSTR_LEN(upper); i++) {
            ZSTR_VAL(upper)[i] = (char)toupper((unsigned char)ZSTR_VAL(upper)[i]);
        }
        zend_string *result = zend_strpprintf(0, "%s(NOW(6), INTERVAL %s %s)", later ? "DATE_ADD" : "DATE_SUB",
            ZSTR_VAL(interval), ZSTR_VAL(upper));
        zend_string_release(interval);
        zend_string_release(upper);
        return result;
    }
    if (dialect_is(object, "postgres")) {
        const char *field = strcmp(unit, "second") == 0 ? "secs" : strcmp(unit, "minute") == 0 ? "mins"
            : strcmp(unit, "hour") == 0 ? "hours" : strcmp(unit, "day") == 0 ? "days" : "months";
        const char *cast = strcmp(unit, "second") == 0 ? "double precision" : "integer";
        const char *operand_cast = strcmp(unit, "second") == 0 ? "double precision" : "bigint";
        zend_string *clock = dialect_call_zero(now);
        if (clock == NULL) return NULL;
        zend_string *interval = dialect_guard_interval(unit, operand_cast, arg);
        if (interval == NULL) {
            zend_string_release(clock);
            return NULL;
        }
        zend_string *result = zend_strpprintf(0,
            "(CAST(%s AS timestamp(6)) %s make_interval(%s => CAST(%s AS %s)))",
            ZSTR_VAL(clock), later ? "+" : "-", field, ZSTR_VAL(interval), cast);
        zend_string_release(clock);
        zend_string_release(interval);
        return result;
    }
    zend_string *clock = dialect_call_zero(now);
    if (clock == NULL) return NULL;
    zend_string *amount = dialect_call_zero(arg);
    if (amount == NULL) {
        zend_string_release(clock);
        return NULL;
    }
    zend_string *suffix_clock = dialect_call_zero(now);
    if (suffix_clock == NULL) {
        zend_string_release(clock);
        zend_string_release(amount);
        return NULL;
    }
    zend_string *modifier = zend_strpprintf(0, "%s || CAST(%s AS TEXT) || ' %ss'%s",
        later ? "'+'" : "'-'", ZSTR_VAL(amount), unit, strcmp(unit, "month") == 0 ? ", 'floor'" : "");
    zend_string *result = zend_strpprintf(0, "(datetime(%s, %s) || substr(%s, 20))",
        ZSTR_VAL(clock), ZSTR_VAL(modifier), ZSTR_VAL(suffix_clock));
    zend_string_release(clock);
    zend_string_release(amount);
    zend_string_release(suffix_clock);
    zend_string_release(modifier);
    return result;
}

ZEND_METHOD(Polyspec_Orm_Dialect, guardInterval)
{
    zend_string *unit, *cast;
    zval *arg;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(unit)
        Z_PARAM_STR(cast)
        Z_PARAM_OBJECT_OF_CLASS(arg, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *result = dialect_guard_interval(ZSTR_VAL(unit), ZSTR_VAL(cast), arg);
    if (result == NULL) RETURN_THROWS();
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, guardResult)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(value, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *first = dialect_call_zero(value);
    if (first == NULL) RETURN_THROWS();
    zend_string *second = dialect_call_zero(value);
    if (second == NULL) {
        zend_string_release(first);
        RETURN_THROWS();
    }
    zend_string *result = dialect_guard_result(first, second);
    zend_string_release(first);
    zend_string_release(second);
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Dialect, valueFunction)
{
    zend_string *fn;
    zval *arg, *now;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(fn)
        Z_PARAM_OBJECT_OF_CLASS(arg, zend_ce_closure)
        Z_PARAM_OBJECT_OF_CLASS(now, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    bool mysql = dialect_is(ZEND_THIS, "mysql");
    bool postgres = dialect_is(ZEND_THIS, "postgres");
    bool later = ZSTR_LEN(fn) >= 6 && memcmp(ZSTR_VAL(fn) + ZSTR_LEN(fn) - 6, "_later", 6) == 0;
    const char *unit = dialect_unit(fn);
    if (mysql && zend_string_equals_literal(fn, "now")) RETURN_STRING("NOW(6)");
    if (mysql && zend_string_equals_literal(fn, "today")) RETURN_STRING("CURDATE()");
    if (postgres && zend_string_equals_literal(fn, "today")) RETURN_STRING("CURRENT_DATE");
    if (unit == NULL) {
        if (postgres && zend_string_equals_literal(fn, "now")) {
            zend_string *clock = dialect_call_zero(now);
            if (clock == NULL) RETURN_THROWS();
            zend_string *result = zend_strpprintf(0, "CAST(%s AS timestamp(6))", ZSTR_VAL(clock));
            zend_string_release(clock);
            RETURN_STR(result);
        }
        if (!mysql && !postgres && zend_string_equals_literal(fn, "now")) {
            zend_string *clock = dialect_call_zero(now);
            if (clock == NULL) RETURN_THROWS();
            RETURN_STR(clock);
        }
        if (!mysql && !postgres && zend_string_equals_literal(fn, "today")) {
            zend_string *clock = dialect_call_zero(now);
            if (clock == NULL) RETURN_THROWS();
            zend_string *result = zend_strpprintf(0, "date(%s)", ZSTR_VAL(clock));
            zend_string_release(clock);
            RETURN_STR(result);
        }
        RETURN_NULL();
    }
    zend_string *first = dialect_interval_expression(ZEND_THIS, unit, later, arg, now);
    if (first == NULL) RETURN_THROWS();
    zend_string *second = dialect_interval_expression(ZEND_THIS, unit, later, arg, now);
    if (second == NULL) {
        zend_string_release(first);
        RETURN_THROWS();
    }
    zend_string *result = dialect_guard_result(first, second);
    zend_string_release(first);
    zend_string_release(second);
    RETURN_STR(result);
}
