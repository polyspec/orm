/* Native Request, StyledValue, Page, Func and PendingTime helpers (T182-6). */
#include "model_types.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "ext/spl/spl_exceptions.h"
#include "ext/json/php_json.h"

zend_class_entry *polyspec_request_ce;
zend_class_entry *polyspec_styled_value_ce;
zend_class_entry *polyspec_page_ce;
zend_class_entry *polyspec_func_ce;
zend_class_entry *polyspec_pending_time_ce;

#define ORM_NS "Polyspec\\Orm"
#define REQUEST_CLASS ORM_NS "\\Request"
#define STYLED_VALUE_CLASS ORM_NS "\\StyledValue"
#define PAGE_CLASS ORM_NS "\\Page"
#define ORM_EXCEPTION_CLASS ORM_NS "\\OrmException"

static bool model_types_scalar_argument(zval *value, uint32_t argument, uint32_t mask, const char *expected)
{
    ZVAL_DEREF(value);
    if (mask & (1u << Z_TYPE_P(value))) {
        return true;
    }
    if (zend_verify_scalar_type_hint(mask, value, ZEND_ARG_USES_STRICT_TYPES(), false)) {
        return true;
    }
    if (EG(exception) == NULL) {
        zend_argument_type_error(argument, "must be of type %s, %s given", expected, zend_zval_value_name(value));
    }
    return false;
}

ZEND_METHOD(Polyspec_Orm_Request, __construct)
{
    zval *kind, *manifest_hash;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(kind)
        Z_PARAM_ZVAL(manifest_hash)
    ZEND_PARSE_PARAMETERS_END();
    if (!model_types_scalar_argument(kind, 1, MAY_BE_STRING, "string") ||
        !model_types_scalar_argument(manifest_hash, 2, MAY_BE_STRING, "string")) {
        RETURN_THROWS();
    }

    zval ir;
    array_init_size(&ir, 3);
    add_assoc_long(&ir, "ir_version", 1);
    add_assoc_str(&ir, "manifest_hash", zend_string_copy(Z_STR_P(manifest_hash)));
    add_assoc_str(&ir, "kind", zend_string_copy(Z_STR_P(kind)));
    zend_update_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "ir", sizeof("ir") - 1, &ir);
    zval_ptr_dtor(&ir);
}

ZEND_METHOD(Polyspec_Orm_Request, param)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ZVAL(value)
    ZEND_PARSE_PARAMETERS_END();

    zval rv, *params = zend_read_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "params", sizeof("params") - 1, 0, &rv);
    if (Z_TYPE_P(params) != IS_ARRAY) {
        zend_throw_error(NULL, "Request::$params must be an array");
        RETURN_THROWS();
    }
    SEPARATE_ARRAY(params);
    zval copy;
    ZVAL_COPY(&copy, value);
    zend_hash_next_index_insert(Z_ARRVAL_P(params), &copy);
    RETURN_LONG((zend_long)zend_hash_num_elements(Z_ARRVAL_P(params)) - 1);
}

static bool orm_types_throw(const char *code, const char *message)
{
    zend_string *name = zend_string_init(ORM_EXCEPTION_CLASS, sizeof(ORM_EXCEPTION_CLASS) - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) {
        if (EG(exception) == NULL) {
            zend_throw_error(NULL, "class Polyspec\\Orm\\OrmException is not loaded");
        }
        return false;
    }
    zval ex, args[2], rv;
    object_init_ex(&ex, ce);
    ZVAL_STRING(&args[0], code);
    ZVAL_STRING(&args[1], message);
    zend_call_method(Z_OBJ(ex), ce, NULL, ZEND_STRL("__construct"), &rv, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&ex);
        return false;
    }
    zend_throw_exception_object(&ex);
    return false;
}

static int types_bucket_compare(Bucket *left, Bucket *right)
{
    zval result;
    compare_function(&result, &left->val, &right->val);
    int order = Z_TYPE(result) == IS_LONG ? (int)Z_LVAL(result) : 0;
    zval_ptr_dtor(&result);
    return order;
}

static bool array_is_list_native(HashTable *ht)
{
    zend_ulong expected = 0, index;
    zend_string *key;
    ZEND_HASH_FOREACH_KEY(ht, index, key) {
        if (key != NULL || index != expected++) {
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

typedef struct {
    HashTable *params;
    HashTable *out;
    HashTable *used;
} request_walk;

static bool request_node(request_walk *walk, zval *input, zval *output);

static bool request_index(request_walk *walk, zend_long p, zend_long *result)
{
    if (p < 0 || (zend_ulong)p >= zend_hash_num_elements(walk->params)) {
        zend_string *message = zend_strpprintf(0, "param index " ZEND_LONG_FMT " out of range (n_params %lu)", p,
            (unsigned long)zend_hash_num_elements(walk->params));
        zend_string *exception_name = zend_string_init(ORM_EXCEPTION_CLASS, sizeof(ORM_EXCEPTION_CLASS) - 1, 0);
        zend_class_entry *exception_ce = zend_lookup_class(exception_name);
        zend_string_release(exception_name);
        if (exception_ce == NULL) { zend_string_release(message); return false; }
        zval exception, args[2], result;
        object_init_ex(&exception, exception_ce);
        ZVAL_STRING(&args[0], "IR_INVALID");
        ZVAL_STR(&args[1], message);
        zend_call_method(Z_OBJ(exception), exception_ce, NULL, ZEND_STRL("__construct"), &result, 2, &args[0], &args[1]);
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&result);
        if (EG(exception) != NULL) { zval_ptr_dtor(&exception); return false; }
        zend_throw_exception_object(&exception);
        return false;
    }
    zval missing;
    zval *value = zend_hash_index_find(walk->params, (zend_ulong)p);
    if (value == NULL) {
        zend_error(E_WARNING, "Undefined array key " ZEND_LONG_FMT, p);
        ZVAL_NULL(&missing);
        value = &missing;
    }
    zend_hash_index_add_empty_element(walk->used, (zend_ulong)p);
    zval copy;
    ZVAL_COPY(&copy, value);
    if (zend_hash_next_index_insert(walk->out, &copy) == NULL) {
        zval_ptr_dtor(&copy);
        return false;
    }
    *result = (zend_long)zend_hash_num_elements(walk->out) - 1;
    return true;
}

static bool request_ints(request_walk *walk, HashTable *input, zval *output)
{
    array_init_size(output, zend_hash_num_elements(input));
    zval *value;
    ZEND_HASH_FOREACH_VAL(input, value) {
        zend_long p = zval_get_long(value), new_p;
        if (!request_index(walk, p, &new_p)) {
            zval_ptr_dtor(output);
            ZVAL_UNDEF(output);
            return false;
        }
        add_next_index_long(output, new_p);
    } ZEND_HASH_FOREACH_END();
    return true;
}

static bool request_list(request_walk *walk, HashTable *input, zval *output)
{
    zend_ulong count = zend_hash_num_elements(input);
    array_init(output);
    if (count == 0) {
        return true;
    }
    zval values;
    array_init_size(&values, count);
    zval *entry;
    ZEND_HASH_FOREACH_VAL(input, entry) {
        zval copy;
        ZVAL_COPY(&copy, entry);
        add_next_index_zval(&values, &copy);
    } ZEND_HASH_FOREACH_END();
    zval *last = zend_hash_index_find(Z_ARRVAL(values), count - 1);
    if (last == NULL) {
        zend_error(E_WARNING, "Undefined array key %lu", (unsigned long)(count - 1));
        zval_ptr_dtor(&values);
        zval_ptr_dtor(output);
        ZVAL_UNDEF(output);
        return false;
    }
    zend_ulong bucket = 1;
    while (bucket < count) {
        if (bucket > ZEND_LONG_MAX / 2) {
            zend_throw_error(NULL, "IN list is too large to canonicalize");
            zval_ptr_dtor(&values);
            zval_ptr_dtor(output);
            ZVAL_UNDEF(output);
            return false;
        }
        bucket <<= 1;
    }
    for (zend_ulong i = 0; i < bucket; i++) {
        zval *value = i < count ? zend_hash_index_find(Z_ARRVAL(values), i) : last;
        if (value == NULL) {
            zend_error(E_WARNING, "Undefined array key %lu", (unsigned long)i);
            zval_ptr_dtor(&values);
            zval_ptr_dtor(output);
            ZVAL_UNDEF(output);
            return false;
        }
        zend_long p = zval_get_long(value), new_p;
        if (!request_index(walk, p, &new_p)) {
            zval_ptr_dtor(&values);
            zval_ptr_dtor(output);
            ZVAL_UNDEF(output);
            return false;
        }
        add_next_index_long(output, new_p);
    }
    zval_ptr_dtor(&values);
    return true;
}

static bool request_rows(request_walk *walk, HashTable *input, zval *output)
{
    array_init_size(output, zend_hash_num_elements(input));
    zval *row;
    ZEND_HASH_FOREACH_VAL(input, row) {
        zval row_array, new_row;
        if (Z_TYPE_P(row) == IS_ARRAY) {
            ZVAL_COPY(&row_array, row);
        } else {
            ZVAL_COPY(&row_array, row);
            convert_to_array(&row_array);
        }
        if (!request_ints(walk, Z_ARRVAL(row_array), &new_row)) {
            zval_ptr_dtor(&row_array);
            zval_ptr_dtor(output);
            ZVAL_UNDEF(output);
            return false;
        }
        zval_ptr_dtor(&row_array);
        add_next_index_zval(output, &new_row);
    } ZEND_HASH_FOREACH_END();
    return true;
}

static bool key_equals(zend_string *key, const char *literal)
{
    return zend_string_equals_cstr(key, literal, strlen(literal));
}

static bool request_assoc(request_walk *walk, HashTable *input, zval *output)
{
    zval keys, *op_value, *sub_value;
    zend_string *key;
    array_init_size(&keys, zend_hash_num_elements(input));
    zend_ulong numeric_key;
    ZEND_HASH_FOREACH_KEY(input, numeric_key, key) {
        if (key != NULL) {
            add_next_index_str(&keys, zend_string_copy(key));
        } else {
            add_next_index_long(&keys, (zend_long)numeric_key);
        }
    } ZEND_HASH_FOREACH_END();
    /* Associative IR keys are strings; preserve unusual numeric keys in insertion order if any. */
    zend_hash_sort(Z_ARRVAL(keys), types_bucket_compare, 1);

    op_value = zend_hash_str_find(input, "op", sizeof("op") - 1);
    sub_value = zend_hash_str_find(input, "sub", sizeof("sub") - 1);
    if (op_value != NULL) ZVAL_DEREF(op_value);
    if (sub_value != NULL) ZVAL_DEREF(sub_value);
    bool in_list = (sub_value == NULL || Z_TYPE_P(sub_value) == IS_NULL) && op_value != NULL && Z_TYPE_P(op_value) == IS_STRING
        && (zend_string_equals_literal(Z_STR_P(op_value), "in") || zend_string_equals_literal(Z_STR_P(op_value), "not_in"));

    array_init_size(output, zend_hash_num_elements(input));
    zval *key_value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(keys), key_value) {
        zval *source = NULL;
        if (Z_TYPE_P(key_value) == IS_STRING) {
            key = Z_STR_P(key_value);
            source = zend_hash_find(input, key);
        } else {
            zend_ulong index = (zend_ulong)Z_LVAL_P(key_value);
            source = zend_hash_index_find(input, index);
            key = NULL;
        }
        if (source == NULL) {
            continue;
        }
        ZVAL_DEREF(source);
        zval transformed;
        ZVAL_UNDEF(&transformed);
        if (key != NULL && Z_TYPE_P(source) == IS_LONG
            && (key_equals(key, "p") || key_equals(key, "plus_p") || key_equals(key, "minus_p"))) {
            zend_long mapped;
            if (!request_index(walk, Z_LVAL_P(source), &mapped)) {
                zval_ptr_dtor(&keys);
                zval_ptr_dtor(output);
                ZVAL_UNDEF(output);
                return false;
            }
            ZVAL_LONG(&transformed, mapped);
        } else if (key != NULL && key_equals(key, "ps") && Z_TYPE_P(source) == IS_ARRAY) {
            bool ok = in_list ? request_list(walk, Z_ARRVAL_P(source), &transformed) : request_ints(walk, Z_ARRVAL_P(source), &transformed);
            if (!ok) {
                zval_ptr_dtor(&keys);
                zval_ptr_dtor(output);
                ZVAL_UNDEF(output);
                return false;
            }
        } else if (key != NULL && key_equals(key, "rows") && Z_TYPE_P(source) == IS_ARRAY) {
            if (!request_rows(walk, Z_ARRVAL_P(source), &transformed)) {
                zval_ptr_dtor(&keys);
                zval_ptr_dtor(output);
                ZVAL_UNDEF(output);
                return false;
            }
        } else if (!request_node(walk, source, &transformed)) {
            zval_ptr_dtor(&keys);
            zval_ptr_dtor(output);
            ZVAL_UNDEF(output);
            return false;
        }
        if (key != NULL) {
            zend_hash_update(Z_ARRVAL_P(output), key, &transformed);
        } else {
            zend_hash_index_update(Z_ARRVAL_P(output), (zend_ulong)Z_LVAL_P(key_value), &transformed);
        }
    } ZEND_HASH_FOREACH_END();
    zval ordered;
    array_init_size(&ordered, zend_hash_num_elements(input));
    zend_ulong ordered_index;
    zend_string *ordered_key;
    ZEND_HASH_FOREACH_KEY(input, ordered_index, ordered_key) {
        zval *transformed = ordered_key == NULL
            ? zend_hash_index_find(Z_ARRVAL_P(output), ordered_index)
            : zend_hash_find(Z_ARRVAL_P(output), ordered_key);
        if (transformed == NULL) {
            continue;
        }
        zval copy;
        ZVAL_COPY(&copy, transformed);
        if (ordered_key == NULL) {
            zend_hash_index_update(Z_ARRVAL(ordered), ordered_index, &copy);
        } else {
            zend_hash_update(Z_ARRVAL(ordered), ordered_key, &copy);
        }
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(output);
    ZVAL_COPY_VALUE(output, &ordered);
    zval_ptr_dtor(&keys);
    return true;
}

static bool request_node(request_walk *walk, zval *input, zval *output)
{
    ZVAL_DEREF(input);
    if (Z_TYPE_P(input) != IS_ARRAY) {
        ZVAL_COPY(output, input);
        return true;
    }
    HashTable *table = Z_ARRVAL_P(input);
    if (array_is_list_native(table)) {
        array_init_size(output, zend_hash_num_elements(table));
        zval *value;
        ZEND_HASH_FOREACH_VAL(table, value) {
            zval child;
            if (!request_node(walk, value, &child)) {
                zval_ptr_dtor(output);
                ZVAL_UNDEF(output);
                return false;
            }
            add_next_index_zval(output, &child);
        } ZEND_HASH_FOREACH_END();
        return true;
    }
    return request_assoc(walk, table, output);
}

ZEND_METHOD(Polyspec_Orm_Request, padIn)
{
    zval *values;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(values)
    ZEND_PARSE_PARAMETERS_END();
    zend_ulong count = zend_hash_num_elements(Z_ARRVAL_P(values));
    ZVAL_COPY(return_value, values);
    zend_ulong bucket = 1;
    while (bucket < count) bucket <<= 1;
    if (bucket <= count) return;
    SEPARATE_ARRAY(return_value);
    while (zend_hash_num_elements(Z_ARRVAL_P(return_value)) < bucket) {
        zend_long last_index = (zend_long)zend_hash_num_elements(Z_ARRVAL_P(return_value)) - 1;
        zval *value = zend_hash_index_find(Z_ARRVAL_P(return_value), (zend_ulong)last_index);
        if (value == NULL) {
            zend_error(E_WARNING, "Undefined array key " ZEND_LONG_FMT, last_index);
            if (EG(exception) != NULL) {
                zval_ptr_dtor(return_value);
                ZVAL_UNDEF(return_value);
                RETURN_THROWS();
            }
            zval null_value;
            ZVAL_NULL(&null_value);
            zend_hash_next_index_insert(Z_ARRVAL_P(return_value), &null_value);
        } else {
            zval copy;
            ZVAL_COPY(&copy, value);
            zend_hash_next_index_insert(Z_ARRVAL_P(return_value), &copy);
        }
    }
}

ZEND_METHOD(Polyspec_Orm_Request, canonicalize)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *canonical = zend_read_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "canonical", sizeof("canonical") - 1, 0, &rv);
    if (zend_is_true(canonical)) {
        RETURN_NULL();
    }
    zval ir_rv, params_rv;
    zval *ir = zend_read_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "ir", sizeof("ir") - 1, 0, &ir_rv);
    zval *params = zend_read_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "params", sizeof("params") - 1, 0, &params_rv);
    ZVAL_DEREF(ir);
    ZVAL_DEREF(params);
    if (Z_TYPE_P(ir) != IS_ARRAY || Z_TYPE_P(params) != IS_ARRAY) {
        zend_throw_error(NULL, "Request::$ir and Request::$params must be arrays");
        RETURN_THROWS();
    }
    zval out_params, out_ir;
    array_init(&out_params);
    ZVAL_UNDEF(&out_ir);
    HashTable used;
    zend_hash_init(&used, zend_hash_num_elements(Z_ARRVAL_P(params)), NULL, NULL, 0);
    request_walk walk = {Z_ARRVAL_P(params), Z_ARRVAL(out_params), &used};
    bool ok = request_node(&walk, ir, &out_ir);
    if (ok) {
        zend_ulong param_index;
        zend_string *param_key;
        zval *value;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(params), param_index, param_key, value) {
            if (param_key != NULL || !zend_hash_index_exists(&used, param_index)) {
                zval copy;
                ZVAL_COPY(&copy, value);
                zend_hash_next_index_insert(Z_ARRVAL(out_params), &copy);
            }
        } ZEND_HASH_FOREACH_END();
        zend_update_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "ir", sizeof("ir") - 1, &out_ir);
        zend_update_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "params", sizeof("params") - 1, &out_params);
        zval one;
        ZVAL_TRUE(&one);
        zend_update_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "canonical", sizeof("canonical") - 1, &one);
    }
    zend_hash_destroy(&used);
    if (!ok || EG(exception) != NULL) {
        if (Z_TYPE(out_params) != IS_UNDEF) zval_ptr_dtor(&out_params);
        if (Z_TYPE(out_ir) != IS_UNDEF) zval_ptr_dtor(&out_ir);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&out_params);
    zval_ptr_dtor(&out_ir);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Request, shape)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *ir = zend_read_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "ir", sizeof("ir") - 1, 0, &rv);
    zval params_rv, *params = zend_read_property(polyspec_request_ce, Z_OBJ_P(ZEND_THIS), "params", sizeof("params") - 1, 0, &params_rv);
    ZVAL_DEREF(ir);
    ZVAL_DEREF(params);
    if (Z_TYPE_P(ir) != IS_ARRAY || Z_TYPE_P(params) != IS_ARRAY) {
        zend_throw_error(NULL, "Request::$ir and Request::$params must be arrays");
        RETURN_THROWS();
    }
    array_init_size(return_value, zend_hash_num_elements(Z_ARRVAL_P(ir)) + 1);
    zend_hash_copy(Z_ARRVAL_P(return_value), Z_ARRVAL_P(ir), zval_add_ref);
    zval count;
    ZVAL_LONG(&count, (zend_long)zend_hash_num_elements(Z_ARRVAL_P(params)));
    zend_hash_str_add_new(Z_ARRVAL_P(return_value), "n_params", sizeof("n_params") - 1, &count);
}

ZEND_METHOD(Polyspec_Orm_StyledValue, __construct)
{
    zend_string *kind;
    zval *payload = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_STR(kind)
        Z_PARAM_OPTIONAL
        Z_PARAM_ZVAL(payload)
    ZEND_PARSE_PARAMETERS_END();
    zval kind_value, null_value;
    ZVAL_STR_COPY(&kind_value, kind);
    zend_update_property(polyspec_styled_value_ce, Z_OBJ_P(ZEND_THIS), "kind", sizeof("kind") - 1, &kind_value);
    zval_ptr_dtor(&kind_value);
    if (payload == NULL) {
        ZVAL_NULL(&null_value);
        payload = &null_value;
    }
    zend_update_property(polyspec_styled_value_ce, Z_OBJ_P(ZEND_THIS), "payload", sizeof("payload") - 1, payload);
}

ZEND_METHOD(Polyspec_Orm_StyledValue, sqlNull)
{
    ZEND_PARSE_PARAMETERS_NONE();
    object_init_ex(return_value, polyspec_styled_value_ce);
    zval kind, payload;
    ZVAL_STRING(&kind, "sql-null");
    ZVAL_NULL(&payload);
    zend_update_property(polyspec_styled_value_ce, Z_OBJ_P(return_value), "kind", sizeof("kind") - 1, &kind);
    zend_update_property(polyspec_styled_value_ce, Z_OBJ_P(return_value), "payload", sizeof("payload") - 1, &payload);
    zval_ptr_dtor(&kind);
}

ZEND_METHOD(Polyspec_Orm_StyledValue, value)
{
    zval *payload;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ZVAL(payload)
    ZEND_PARSE_PARAMETERS_END();
    object_init_ex(return_value, polyspec_styled_value_ce);
    zval kind;
    ZVAL_STRING(&kind, "value");
    zend_update_property(polyspec_styled_value_ce, Z_OBJ_P(return_value), "kind", sizeof("kind") - 1, &kind);
    zend_update_property(polyspec_styled_value_ce, Z_OBJ_P(return_value), "payload", sizeof("payload") - 1, payload);
    zval_ptr_dtor(&kind);
}

ZEND_METHOD(Polyspec_Orm_StyledValue, payload)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *kind = zend_read_property(polyspec_styled_value_ce, Z_OBJ_P(ZEND_THIS), "kind", sizeof("kind") - 1, 0, &rv);
    if (Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "sql-null")) {
        orm_types_throw("CODEC_DECODE", "SQL NULL has no styled value");
        RETURN_THROWS();
    }
    zval payload_rv;
    zval *payload = zend_read_property(polyspec_styled_value_ce, Z_OBJ_P(ZEND_THIS), "payload", sizeof("payload") - 1, 0, &payload_rv);
    RETURN_COPY(payload);
}

ZEND_METHOD(Polyspec_Orm_StyledValue, jsonSerialize)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, *kind = zend_read_property(polyspec_styled_value_ce, Z_OBJ_P(ZEND_THIS), "kind", sizeof("kind") - 1, 0, &rv);
    array_init_size(return_value, 2);
    zval kind_copy;
    ZVAL_COPY(&kind_copy, kind);
    add_assoc_zval(return_value, "kind", &kind_copy);
    if (!(Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "sql-null"))) {
        zval payload_rv;
        zval *payload = zend_read_property(polyspec_styled_value_ce, Z_OBJ_P(ZEND_THIS), "payload", sizeof("payload") - 1, 0, &payload_rv);
        zval payload_copy;
        ZVAL_COPY(&payload_copy, payload);
        add_assoc_zval(return_value, "value", &payload_copy);
    }
}

ZEND_METHOD(Polyspec_Orm_Page, __construct)
{
    zval *items, *total_count_value, *total_pages_value, *page_value, *per_page_value;
    zend_string *collection_name = zend_string_init(ORM_NS "\\Collection", sizeof(ORM_NS "\\Collection") - 1, 0);
    zend_class_entry *collection_ce = zend_lookup_class(collection_name);
    zend_string_release(collection_name);
    if (collection_ce == NULL) RETURN_THROWS();
    ZEND_PARSE_PARAMETERS_START(5, 5)
        Z_PARAM_OBJECT_OF_CLASS(items, collection_ce)
        Z_PARAM_ZVAL(total_count_value)
        Z_PARAM_ZVAL(total_pages_value)
        Z_PARAM_ZVAL(page_value)
        Z_PARAM_ZVAL(per_page_value)
    ZEND_PARSE_PARAMETERS_END();
    if (!model_types_scalar_argument(total_count_value, 2, MAY_BE_LONG, "int") ||
        !model_types_scalar_argument(total_pages_value, 3, MAY_BE_LONG, "int") ||
        !model_types_scalar_argument(page_value, 4, MAY_BE_LONG, "int") ||
        !model_types_scalar_argument(per_page_value, 5, MAY_BE_LONG, "int")) {
        RETURN_THROWS();
    }
    zend_update_property_long(polyspec_page_ce, Z_OBJ_P(ZEND_THIS), "totalCount", sizeof("totalCount") - 1, Z_LVAL_P(total_count_value));
    zend_update_property_long(polyspec_page_ce, Z_OBJ_P(ZEND_THIS), "totalPages", sizeof("totalPages") - 1, Z_LVAL_P(total_pages_value));
    zend_update_property_long(polyspec_page_ce, Z_OBJ_P(ZEND_THIS), "page", sizeof("page") - 1, Z_LVAL_P(page_value));
    zend_update_property_long(polyspec_page_ce, Z_OBJ_P(ZEND_THIS), "perPage", sizeof("perPage") - 1, Z_LVAL_P(per_page_value));
    zend_update_property(polyspec_page_ce, Z_OBJ_P(ZEND_THIS), "items", sizeof("items") - 1, items);
}

ZEND_METHOD(Polyspec_Orm_Func, __construct)
{
    zval *name, *args, *column;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ZVAL(name)
        Z_PARAM_ARRAY(args)
        Z_PARAM_ZVAL(column)
    ZEND_PARSE_PARAMETERS_END();
    if (!model_types_scalar_argument(name, 1, MAY_BE_STRING, "string") ||
        !model_types_scalar_argument(column, 3, MAY_BE_BOOL, "bool")) {
        RETURN_THROWS();
    }
    zend_update_property_str(polyspec_func_ce, Z_OBJ_P(ZEND_THIS), "name", sizeof("name") - 1, Z_STR_P(name));
    zend_update_property(polyspec_func_ce, Z_OBJ_P(ZEND_THIS), "args", sizeof("args") - 1, args);
    zend_update_property_bool(polyspec_func_ce, Z_OBJ_P(ZEND_THIS), "column", sizeof("column") - 1, Z_TYPE_P(column) == IS_TRUE);
}

ZEND_METHOD(Polyspec_Orm_Func, ir)
{
    zval *callback;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ZVAL(callback)
    ZEND_PARSE_PARAMETERS_END();

    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(callback, 0, &fci, &fcc, NULL, NULL) != SUCCESS) RETURN_THROWS();

    zval name_rv, args_rv;
    zval *name = zend_read_property(polyspec_func_ce, Z_OBJ_P(ZEND_THIS), "name", sizeof("name") - 1, 0, &name_rv);
    zval *args = zend_read_property(polyspec_func_ce, Z_OBJ_P(ZEND_THIS), "args", sizeof("args") - 1, 0, &args_rv);
    array_init(return_value);
    zval name_copy;
    ZVAL_COPY(&name_copy, name);
    add_assoc_zval(return_value, "name", &name_copy);

    zval mapped_args;
    array_init(&mapped_args);
    zval *arg;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(args), arg) {
        zval mapped;
        zval argument;
        ZVAL_UNDEF(&mapped);
        ZVAL_COPY(&argument, arg);
        fci.retval = &mapped;
        fci.params = &argument;
        fci.param_count = 1;
        fci.named_params = NULL;
        if (zend_call_function(&fci, &fcc) != SUCCESS || EG(exception) != NULL) {
            zval_ptr_dtor(&argument);
            if (!Z_ISUNDEF(mapped)) zval_ptr_dtor(&mapped);
            zval_ptr_dtor(&mapped_args);
            zval_ptr_dtor(return_value);
            ZVAL_UNDEF(return_value);
            RETURN_THROWS();
        }
        zval_ptr_dtor(&argument);
        add_next_index_zval(&mapped_args, &mapped);
    } ZEND_HASH_FOREACH_END();
    if (zend_hash_num_elements(Z_ARRVAL_P(args)) > 0) {
        add_assoc_zval(return_value, "ps", &mapped_args);
    } else {
        zval_ptr_dtor(&mapped_args);
    }
}

ZEND_METHOD(Polyspec_Orm_PendingTime, __construct)
{
    zval *text, *zone;
    zend_string *zone_name = zend_string_init("DateTimeZone", sizeof("DateTimeZone") - 1, 0);
    zend_class_entry *zone_ce = zend_lookup_class(zone_name);
    zend_string_release(zone_name);
    if (zone_ce == NULL) RETURN_THROWS();
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(text)
        Z_PARAM_OBJECT_OF_CLASS(zone, zone_ce)
    ZEND_PARSE_PARAMETERS_END();
    if (!model_types_scalar_argument(text, 1, MAY_BE_STRING, "string")) RETURN_THROWS();
    zend_update_property_str(polyspec_pending_time_ce, Z_OBJ_P(ZEND_THIS), "text", sizeof("text") - 1, Z_STR_P(text));
    zend_update_property(polyspec_pending_time_ce, Z_OBJ_P(ZEND_THIS), "zone", sizeof("zone") - 1, zone);
}

