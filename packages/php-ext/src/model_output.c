/* Ordered row output and JSON conversion methods for native Model. */
#include "model_output.h"
#include "model_state.h"
#include "model_native_methods.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "ext/json/php_json.h"

static zend_class_entry *output_class(const char *name)
{
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool output_instance(zval *value, const char *name)
{
    zend_class_entry *ce = output_class(name);
    return ce != NULL && Z_TYPE_P(value) == IS_OBJECT && instanceof_function(Z_OBJCE_P(value), ce);
}

static zval *output_assoc(zval *array, const char *key)
{
    if (array == NULL || Z_TYPE_P(array) != IS_ARRAY) return NULL;
    return zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key));
}

static void output_call(zval *object, const char *method, zval *result, uint32_t argc, zval *args)
{
    ZVAL_UNDEF(result);
    zend_call_method(Z_OBJ_P(object), Z_OBJCE_P(object), NULL, method, strlen(method), result, argc, argc ? args : NULL, argc > 1 ? args + 1 : NULL);
}

static void output_format_datetime(zval *value, const char *format, zval *result)
{
    zval arg;
    ZVAL_STRING(&arg, format);
    ZVAL_UNDEF(result);
    zend_call_method(Z_OBJ_P(value), Z_OBJCE_P(value), NULL, "format", sizeof("format") - 1, result, 1, &arg, NULL);
    zval_ptr_dtor(&arg);
}

static void output_array_value(zval *value, zval *result)
{
    if (output_instance(value, "DateTimeInterface")) {
        output_format_datetime(value, "Y-m-d H:i:s.u", result);
    } else {
        ZVAL_COPY(result, value);
    }
}

static zend_string *output_six_digits(zend_string *input)
{
    const char *bytes = ZSTR_VAL(input);
    size_t dot = ZSTR_LEN(input);
    for (size_t i = 0; i < ZSTR_LEN(input); i++) if (bytes[i] == '.') { dot = i; break; }
    if (dot == ZSTR_LEN(input)) {
        smart_str out = {0}; smart_str_append(&out, input); smart_str_appends(&out, ".000000");
        return smart_str_extract(&out);
    }
    smart_str out = {0};
    smart_str_appendl(&out, bytes, dot + 1);
    size_t have = ZSTR_LEN(input) - dot - 1;
    for (size_t i = 0; i < 6; i++) smart_str_appendc(&out, i < have ? bytes[dot + 1 + i] : '0');
    return smart_str_extract(&out);
}

static void output_column_value(zval *column, zval *value, zval *result)
{
    zval *type = output_assoc(column, "type");
    if (Z_TYPE_P(value) == IS_STRING && type != NULL && Z_TYPE_P(type) == IS_STRING &&
        (zend_string_equals_literal(Z_STR_P(type), "time") || zend_string_equals_literal(Z_STR_P(type), "datetime"))) {
        ZVAL_STR(result, output_six_digits(Z_STR_P(value)));
        return;
    }
    if (output_instance(value, "DateTimeInterface")) {
        const char *format = "Y-m-d H:i:s.u";
        if (type != NULL && Z_TYPE_P(type) == IS_STRING && zend_string_equals_literal(Z_STR_P(type), "date")) format = "Y-m-d";
        else if (type != NULL && Z_TYPE_P(type) == IS_STRING && zend_string_equals_literal(Z_STR_P(type), "time")) format = "H:i:s.u";
        output_format_datetime(value, format, result);
        return;
    }
    output_array_value(value, result);
}

static void output_append(zval *out, HashTable *seen, zend_string *name, zval *value)
{
    if (zend_hash_exists(seen, name)) return;
    zend_hash_add_empty_element(seen, name);
    zend_hash_update(Z_ARRVAL_P(out), name, value);
}

static void output_append_converted(zval *out, HashTable *seen, zend_string *name, zval *value)
{
    zval converted;
    if (output_instance(value, "Polyspec\\Orm\\Model") || output_instance(value, "Polyspec\\Orm\\Collection")) {
        output_call(value, "toArray", &converted, 0, NULL);
    } else if (output_instance(value, "Polyspec\\Orm\\StyledValue")) {
        output_call(value, "jsonSerialize", &converted, 0, NULL);
    } else {
        output_array_value(value, &converted);
    }
    if (EG(exception) == NULL) output_append(out, seen, name, &converted);
    else if (Z_TYPE(converted) != IS_UNDEF) zval_ptr_dtor(&converted);
}

static void output_merge_child(zval *out, HashTable *seen, zval *child)
{
    zval values;
    output_call(child, "toArray", &values, 0, NULL);
    if (EG(exception) != NULL || Z_TYPE(values) != IS_ARRAY) {
        if (Z_TYPE(values) != IS_UNDEF) zval_ptr_dtor(&values);
        return;
    }
    zend_string *name;
    zend_ulong index;
    zval *value;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL(values), index, name, value) {
        zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index);
        zval copy;
        ZVAL_COPY(&copy, value);
        output_append(out, seen, key, &copy);
        zend_string_release(key);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&values);
}

static void model_output_array(zend_object *object, zval *out)
{
    array_init(out);
    HashTable seen;
    zend_hash_init(&seen, 8, NULL, NULL, 0);
    model_state *state = model_state_of(object);
    zval *row = model_state_property(state, "row");
    zval *sets = model_state_property(state, "sets");
    zval *names = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "names") : NULL;
    zval meta;
    ZVAL_UNDEF(&meta);
    zend_call_method_with_0_params(NULL, object->ce, NULL, "meta", &meta);
    if (EG(exception) != NULL || Z_TYPE(meta) != IS_ARRAY) goto done;
    zval *columns = output_assoc(&meta, "columns");
    zval *hidden = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "hidden") : NULL;
    zval *extra = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "extra") : NULL;
    if (names == NULL && sets != NULL && Z_TYPE_P(sets) == IS_ARRAY) {
        zend_string *name;
        zend_ulong index;
        ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(sets), index, name) {
            zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index);
            zval *column = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(columns), key) : NULL;
            if (column != NULL) {
                zval arg, value, converted;
                ZVAL_UNDEF(&value); ZVAL_STR_COPY(&arg, key);
                zend_call_method(object, object->ce, NULL, "readcolumn", sizeof("readcolumn") - 1, &value, 1, &arg, NULL);
                zval_ptr_dtor(&arg);
                if (EG(exception) == NULL) {
                    output_column_value(column, &value, &converted);
                    output_append(out, &seen, key, &converted);
                }
                if (Z_TYPE(value) != IS_UNDEF) zval_ptr_dtor(&value);
            }
            zend_string_release(key);
            if (EG(exception) != NULL) break;
        } ZEND_HASH_FOREACH_END();
    } else if (names != NULL && Z_TYPE_P(names) == IS_ARRAY) {
        zval *name_value;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(names), name_value) {
            if (Z_TYPE_P(name_value) != IS_STRING) continue;
            zend_string *key = Z_STR_P(name_value);
            zval *hidden_value = hidden != NULL && Z_TYPE_P(hidden) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(hidden), key) : NULL;
            if (hidden_value != NULL && zend_is_true(hidden_value)) continue;
            zval *column = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(columns), key) : NULL;
            if (column != NULL) {
                zval arg, value, converted;
                ZVAL_UNDEF(&value); ZVAL_STR_COPY(&arg, key);
                zend_call_method(object, object->ce, NULL, "readcolumn", sizeof("readcolumn") - 1, &value, 1, &arg, NULL);
                zval_ptr_dtor(&arg);
                if (EG(exception) == NULL) {
                    output_column_value(column, &value, &converted);
                    output_append(out, &seen, key, &converted);
                }
                if (Z_TYPE(value) != IS_UNDEF) zval_ptr_dtor(&value);
            } else {
                zval *value = extra != NULL && Z_TYPE_P(extra) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(extra), key) : NULL;
                if (value == NULL) { zval null_value; ZVAL_NULL(&null_value); output_append_converted(out, &seen, key, &null_value); }
                else output_append_converted(out, &seen, key, value);
            }
            if (EG(exception) != NULL) break;
        } ZEND_HASH_FOREACH_END();
    }
    if (EG(exception) == NULL) {
        zval *news = model_state_property(state, "news");
        if (news != NULL && Z_TYPE_P(news) == IS_ARRAY) {
            zend_string *name; zend_ulong index; zval *value;
            ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(news), index, name, value) {
                zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index);
                output_append_converted(out, &seen, key, value);
                zend_string_release(key);
                if (EG(exception) != NULL) break;
            } ZEND_HASH_FOREACH_END();
        }
    }
    if (EG(exception) == NULL) {
        zval *related = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "related") : NULL;
        if (related != NULL && Z_TYPE_P(related) == IS_ARRAY) {
            zend_string *name; zend_ulong index; zval *value;
            ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(related), index, name, value) {
                zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index);
                output_append_converted(out, &seen, key, value);
                zend_string_release(key);
                if (EG(exception) != NULL) break;
            } ZEND_HASH_FOREACH_END();
        }
        zval *flat = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "flat") : NULL;
        if (flat != NULL && Z_TYPE_P(flat) == IS_ARRAY && related != NULL && Z_TYPE_P(related) == IS_ARRAY) {
            zval *flat_name;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(flat), flat_name) {
                if (Z_TYPE_P(flat_name) != IS_STRING) continue;
                zval *child = zend_hash_find(Z_ARRVAL_P(related), Z_STR_P(flat_name));
                if (child != NULL && output_instance(child, "Polyspec\\Orm\\Model")) output_merge_child(out, &seen, child);
                if (EG(exception) != NULL) break;
            } ZEND_HASH_FOREACH_END();
        }
    }
done:
    if (Z_TYPE(meta) != IS_UNDEF) zval_ptr_dtor(&meta);
    zend_hash_destroy(&seen);
}

ZEND_METHOD(Polyspec_Orm_Model, toArray)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_output_array(Z_OBJ_P(ZEND_THIS), return_value);
    if (EG(exception) != NULL) RETURN_THROWS();
}

static bool output_has_ordered(zval *value)
{
    if (output_instance(value, "Polyspec\\OrderedJson\\Value")) return true;
    if (Z_TYPE_P(value) != IS_ARRAY) return false;
    zval *item;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(value), item) if (output_has_ordered(item)) return true; ZEND_HASH_FOREACH_END();
    return false;
}

static void output_throw(const char *code_name, const char *message)
{
    zend_class_entry *ce = output_class("Polyspec\\Orm\\OrmException");
    if (ce == NULL) { zend_throw_error(NULL, "Polyspec\\Orm\\OrmException is not loaded"); return; }
    zval exception, code, text;
    object_init_ex(&exception, ce);
    ZVAL_STRING(&code, code_name); ZVAL_STRING(&text, message);
    zend_call_method_with_2_params(Z_OBJ(exception), ce, NULL, "__construct", NULL, &code, &text);
    zval_ptr_dtor(&code); zval_ptr_dtor(&text);
    if (EG(exception) != NULL) { zval_ptr_dtor(&exception); return; }
    zend_throw_exception_object(&exception);
}

static bool output_ordered_stringify(zval *value, zend_string **text)
{
    zval function, result, argument;
    ZVAL_STRING(&function, "Polyspec\\OrderedJson\\stringify");
    ZVAL_COPY(&argument, value);
    ZVAL_UNDEF(&result);
    int status = call_user_function(EG(function_table), NULL, &function, &result, 1, &argument);
    zval_ptr_dtor(&function); zval_ptr_dtor(&argument);
    if (status != SUCCESS || EG(exception) != NULL || Z_TYPE(result) != IS_STRING) {
        if (Z_TYPE(result) != IS_UNDEF) zval_ptr_dtor(&result);
        return false;
    }
    *text = zend_string_copy(Z_STR(result));
    zval_ptr_dtor(&result);
    return true;
}

static bool output_json_text(zval *value, zend_string **text)
{
    if (output_instance(value, "Polyspec\\Orm\\StyledValue")) {
        zend_class_entry *ce = output_class("Polyspec\\Orm\\StyledValue");
        zval rv;
        zval *kind = zend_read_property(ce, Z_OBJ_P(value), "kind", sizeof("kind") - 1, 1, &rv);
        if (Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "sql-null")) {
            *text = zend_string_init("{\"kind\":\"sql-null\"}", sizeof("{\"kind\":\"sql-null\"}") - 1, 0);
            return true;
        }
        zval payload;
        output_call(value, "payload", &payload, 0, NULL);
        if (EG(exception) != NULL) return false;
        zend_string *payload_text = NULL;
        bool ok = output_json_text(&payload, &payload_text);
        zval_ptr_dtor(&payload);
        if (!ok) return false;
        smart_str out = {0}; smart_str_appends(&out, "{\"kind\":\"value\",\"value\":"); smart_str_append(&out, payload_text); smart_str_appendc(&out, '}');
        zend_string_release(payload_text); *text = smart_str_extract(&out); return true;
    }
    if (output_instance(value, "Polyspec\\OrderedJson\\Value")) return output_ordered_stringify(value, text);
    if (output_instance(value, "Polyspec\\Orm\\Model") || output_instance(value, "Polyspec\\Orm\\Collection")) {
        zval result; output_call(value, "toJson", &result, 0, NULL);
        if (EG(exception) != NULL || Z_TYPE(result) != IS_STRING) { if (Z_TYPE(result) != IS_UNDEF) zval_ptr_dtor(&result); return false; }
        *text = zend_string_copy(Z_STR(result)); zval_ptr_dtor(&result); return true;
    }
    if (Z_TYPE_P(value) == IS_ARRAY && output_has_ordered(value)) {
        smart_str out = {0}; bool list = zend_array_is_list(Z_ARRVAL_P(value));
        smart_str_appendc(&out, list ? '[' : '{'); bool first = true;
        zend_string *key; zend_ulong index; zval *item;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(value), index, key, item) {
            if (!first) smart_str_appendc(&out, ','); first = false;
            if (!list) {
                zend_string *name = key != NULL ? zend_string_copy(key) : zend_long_to_str(index);
                zval name_value; ZVAL_STR(&name_value, name); zend_string *name_text = NULL;
                bool ok = output_json_text(&name_value, &name_text); zval_ptr_dtor(&name_value);
                if (!ok) { smart_str_free(&out); return false; }
                smart_str_append(&out, name_text); smart_str_appendc(&out, ':'); zend_string_release(name_text);
            }
            zend_string *item_text = NULL;
            if (!output_json_text(item, &item_text)) { smart_str_free(&out); return false; }
            smart_str_append(&out, item_text); zend_string_release(item_text);
        } ZEND_HASH_FOREACH_END();
        smart_str_appendc(&out, list ? ']' : '}'); *text = smart_str_extract(&out); return true;
    }
    zval function, result, args[2];
    ZVAL_STRING(&function, "json_encode"); ZVAL_COPY(&args[0], value); ZVAL_LONG(&args[1], PHP_JSON_UNESCAPED_SLASHES | PHP_JSON_UNESCAPED_UNICODE | PHP_JSON_PRESERVE_ZERO_FRACTION | PHP_JSON_THROW_ON_ERROR);
    ZVAL_UNDEF(&result);
    int status = call_user_function(EG(function_table), NULL, &function, &result, 2, args);
    zval_ptr_dtor(&function); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (status != SUCCESS || EG(exception) != NULL || Z_TYPE(result) != IS_STRING) {
        zend_class_entry *json_exception_ce = output_class("JsonException");
        if (EG(exception) != NULL && json_exception_ce != NULL && instanceof_function(EG(exception)->ce, json_exception_ce)) {
            zval rv; zval *message = zend_read_property(zend_ce_exception, EG(exception), "message", sizeof("message") - 1, 1, &rv);
            zend_string *copy = zval_get_string(message);
            zend_object *exception = EG(exception); EG(exception) = NULL; OBJ_RELEASE(exception);
            smart_str error = {0}; smart_str_appends(&error, "json: "); smart_str_append(&error, copy);
            zend_string *message_text = smart_str_extract(&error); output_throw("CODEC_ENCODE", ZSTR_VAL(message_text));
            zend_string_release(message_text); zend_string_release(copy);
        }
        if (Z_TYPE(result) != IS_UNDEF) zval_ptr_dtor(&result);
        return false;
    }
    *text = zend_string_copy(Z_STR(result)); zval_ptr_dtor(&result); return true;
}

ZEND_METHOD(Polyspec_Orm_Model, jsonText)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    zend_string *text = NULL;
    if (!output_json_text(value, &text)) RETURN_THROWS();
    if (EG(exception) != NULL) { zend_string_release(text); RETURN_THROWS(); }
    RETURN_STR(text);
}

ZEND_METHOD(Polyspec_Orm_Model, toJson)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval values;
    model_output_array(Z_OBJ_P(ZEND_THIS), &values);
    if (EG(exception) != NULL) { zval_ptr_dtor(&values); RETURN_THROWS(); }
    smart_str out = {0}; smart_str_appendc(&out, '{'); bool first = true;
    zend_string *name; zval *value;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(values), name, value) {
        if (!first) smart_str_appendc(&out, ','); first = false;
        zval key; ZVAL_STR_COPY(&key, name); zend_string *key_text = NULL;
        if (!output_json_text(&key, &key_text)) { zval_ptr_dtor(&key); smart_str_free(&out); zval_ptr_dtor(&values); RETURN_THROWS(); }
        zval_ptr_dtor(&key); smart_str_append(&out, key_text); smart_str_appendc(&out, ':'); zend_string_release(key_text);
        zend_string *value_text = NULL;
        if (!output_json_text(value, &value_text)) { smart_str_free(&out); zval_ptr_dtor(&values); RETURN_THROWS(); }
        smart_str_append(&out, value_text); zend_string_release(value_text);
    } ZEND_HASH_FOREACH_END();
    smart_str_appendc(&out, '}'); zval_ptr_dtor(&values); RETURN_STR(smart_str_extract(&out));
}

ZEND_METHOD(Polyspec_Orm_Model, jsonSerialize)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval values;
    model_output_array(Z_OBJ_P(ZEND_THIS), &values);
    if (EG(exception) != NULL) { zval_ptr_dtor(&values); RETURN_THROWS(); }
    zend_string *name; zval *value;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(values), name, value) {
        if (output_has_ordered(value)) {
            smart_str message = {0}; smart_str_append_printf(&message, "json_encode cannot write the ordered-json value of %s; use toJson()", ZSTR_VAL(name));
            zend_string *text = smart_str_extract(&message); output_throw("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text);
            zval_ptr_dtor(&values); RETURN_THROWS();
        }
    } ZEND_HASH_FOREACH_END();
    object_init(return_value);
    zend_string *key; zval *item;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(values), key, item) {
        zend_update_property(zend_standard_class_def, Z_OBJ_P(return_value), ZSTR_VAL(key), ZSTR_LEN(key), item);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&values);
}

static void output_pair_append(zval *out, HashTable *seen, zend_string *name, zval *value)
{
    if (zend_hash_exists(seen, name)) { zval_ptr_dtor(value); return; }
    zend_hash_add_empty_element(seen, name);
    zval pair; array_init_size(&pair, 2);
    add_next_index_str(&pair, zend_string_copy(name));
    add_next_index_zval(&pair, value);
    add_next_index_zval(out, &pair);
}

static void model_output_pairs(zend_object *object, zval *out)
{
    array_init(out);
    HashTable seen; zend_hash_init(&seen, 8, NULL, NULL, 0);
    model_state *state = model_state_of(object);
    zval *row = model_state_property(state, "row");
    zval *sets = model_state_property(state, "sets");
    zval *names = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "names") : NULL;
    zval meta; ZVAL_UNDEF(&meta);
    zend_call_method_with_0_params(NULL, object->ce, NULL, "meta", &meta);
    if (EG(exception) != NULL || Z_TYPE(meta) != IS_ARRAY) goto done;
    zval *columns = output_assoc(&meta, "columns");
    zval *hidden = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "hidden") : NULL;
    zval *extra = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "extra") : NULL;
    if (names == NULL && sets != NULL && Z_TYPE_P(sets) == IS_ARRAY) {
        zend_string *name; zend_ulong index;
        ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(sets), index, name) {
            zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index);
            zval *column = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(columns), key) : NULL;
            if (column != NULL) {
                zval arg, value, converted; ZVAL_STR_COPY(&arg, key); ZVAL_UNDEF(&value);
                zend_call_method(object, object->ce, NULL, "value", sizeof("value") - 1, &value, 1, &arg, NULL); zval_ptr_dtor(&arg);
                if (EG(exception) == NULL) { output_column_value(column, &value, &converted); output_pair_append(out, &seen, key, &converted); }
                if (Z_TYPE(value) != IS_UNDEF) zval_ptr_dtor(&value);
            }
            zend_string_release(key); if (EG(exception) != NULL) break;
        } ZEND_HASH_FOREACH_END();
    } else if (names != NULL && Z_TYPE_P(names) == IS_ARRAY) {
        zval *name_value;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(names), name_value) {
            if (Z_TYPE_P(name_value) != IS_STRING) continue;
            zend_string *key = Z_STR_P(name_value);
            zval *hidden_value = hidden != NULL && Z_TYPE_P(hidden) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(hidden), key) : NULL;
            if (hidden_value != NULL && zend_is_true(hidden_value)) continue;
            zval *column = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(columns), key) : NULL;
            if (column != NULL) {
                zval arg, value, converted; ZVAL_STR_COPY(&arg, key); ZVAL_UNDEF(&value);
                zend_call_method(object, object->ce, NULL, "value", sizeof("value") - 1, &value, 1, &arg, NULL); zval_ptr_dtor(&arg);
                if (EG(exception) == NULL) { output_column_value(column, &value, &converted); output_pair_append(out, &seen, key, &converted); }
                if (Z_TYPE(value) != IS_UNDEF) zval_ptr_dtor(&value);
            } else {
                zval *value = extra != NULL && Z_TYPE_P(extra) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(extra), key) : NULL;
                zval converted; if (value == NULL) ZVAL_NULL(&converted); else output_array_value(value, &converted);
                if (EG(exception) == NULL) output_pair_append(out, &seen, key, &converted); else zval_ptr_dtor(&converted);
            }
            if (EG(exception) != NULL) break;
        } ZEND_HASH_FOREACH_END();
    }
    if (EG(exception) == NULL) {
        zval *news = model_state_property(state, "news");
        if (news != NULL && Z_TYPE_P(news) == IS_ARRAY) {
            zend_string *name; zend_ulong index; zval *value;
            ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(news), index, name, value) {
                zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index); zval converted;
                output_array_value(value, &converted); output_pair_append(out, &seen, key, &converted); zend_string_release(key);
                if (EG(exception) != NULL) break;
            } ZEND_HASH_FOREACH_END();
        }
    }
    if (EG(exception) == NULL) {
        zval *related = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "related") : NULL;
        if (related != NULL && Z_TYPE_P(related) == IS_ARRAY) {
            zend_string *name; zend_ulong index; zval *value;
            ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(related), index, name, value) {
                zend_string *key = name != NULL ? zend_string_copy(name) : zend_long_to_str(index); zval copy; ZVAL_COPY(&copy, value);
                output_pair_append(out, &seen, key, &copy); zend_string_release(key);
            } ZEND_HASH_FOREACH_END();
        }
        zval *flat = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? output_assoc(row, "flat") : NULL;
        if (flat != NULL && Z_TYPE_P(flat) == IS_ARRAY && related != NULL && Z_TYPE_P(related) == IS_ARRAY) {
            zval *flat_name; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(flat), flat_name) {
                if (Z_TYPE_P(flat_name) != IS_STRING) continue;
                zval *child = zend_hash_find(Z_ARRVAL_P(related), Z_STR_P(flat_name));
                if (child != NULL && output_instance(child, "Polyspec\\Orm\\Model")) {
                    zval child_pairs; output_call(child, "pairs", &child_pairs, 0, NULL);
                    if (EG(exception) == NULL && Z_TYPE(child_pairs) == IS_ARRAY) {
                        zval *pair; ZEND_HASH_FOREACH_VAL(Z_ARRVAL(child_pairs), pair) {
                            if (Z_TYPE_P(pair) != IS_ARRAY) continue;
                            zval *pair_name = zend_hash_index_find(Z_ARRVAL_P(pair), 0), *pair_value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
                            if (pair_name == NULL || Z_TYPE_P(pair_name) != IS_STRING || pair_value == NULL) continue;
                            zval copy; ZVAL_COPY(&copy, pair_value); output_pair_append(out, &seen, Z_STR_P(pair_name), &copy);
                        } ZEND_HASH_FOREACH_END();
                    }
                    if (Z_TYPE(child_pairs) != IS_UNDEF) zval_ptr_dtor(&child_pairs);
                }
                if (EG(exception) != NULL) break;
            } ZEND_HASH_FOREACH_END();
        }
    }
done:
    if (Z_TYPE(meta) != IS_UNDEF) zval_ptr_dtor(&meta);
    zend_hash_destroy(&seen);
}

ZEND_METHOD(Polyspec_Orm_Model, pairs)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_output_pairs(Z_OBJ_P(ZEND_THIS), return_value);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, columnArrayValue)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *type; zval *value;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(type)
        Z_PARAM_ZVAL(value)
    ZEND_PARSE_PARAMETERS_END();
    zval column; array_init(&column); add_assoc_str(&column, "type", zend_string_copy(type));
    output_column_value(&column, value, return_value);
    zval_ptr_dtor(&column);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, sixFractionDigits)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *text;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(text) ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(output_six_digits(text));
}

ZEND_METHOD(Polyspec_Orm_Model, arrayValue)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    output_array_value(value, return_value);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, holdsOrderedJson)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(value) ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(output_has_ordered(value));
}
