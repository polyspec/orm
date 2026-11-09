/* Native result assembly and read terminals for Polyspec\Orm\Model. */
#include "model_read.h"
#include "model_output.h"
#include "codec.h"
#include "model_state.h"
#include "php_function_call.h"
#include "model_types.h"
#include "model_native_methods.h"
#include "object_method_lookup.h"
#include "model_assembly.h"
#include "collection.h"
#include "runtime_model.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "ext/date/php_date.h"
#include "Zend/zend_smart_str.h"
#include "orm_exception_object.h"
#include "aes_keyring.h"
#include <math.h>
#include <stdint.h>
#include <string.h>

static bool cell_value(zend_string *entity, zend_string *name, zval *col, zval *raw, bool sqlite, bool integer_text, zval *zone,
    zval *out);
static bool cell_refuse(zend_string *entity, zend_string *name, const char *type, zend_object *previous);
static bool cell_refusal(zend_string *entity, zend_string *name, zend_string *message, zend_object *previous, zval *out);

static bool read_aggregate(zval *model, const char *fn, zval *return_value);
static zval *read_array(zval *array, const char *key);
static bool exact_integer(zval *raw, zend_long *out);
static int exact_number(zval *raw, double *out);

static zend_class_entry *read_lookup_class(const char *name)
{
    zend_string *s = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(s);
    zend_string_release(s);
    return ce;
}

static bool read_throw(const char *code, const char *message)
{
    zend_class_entry *ce = read_lookup_class("Polyspec\\Orm\\OrmException");
    if (ce == NULL) {
        zend_throw_error(NULL, "Class Polyspec\\Orm\\OrmException is not loaded");
        return false;
    }
    zval ex, args[2], result;
    object_init_ex(&ex, ce);
    if (EG(exception) != NULL) return false;
    ZVAL_STRING(&args[0], code);
    ZVAL_STRING(&args[1], message);
    zend_call_method(Z_OBJ(ex), ce, NULL, "__construct", sizeof("__construct") - 1, &result, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&ex);
        return false;
    }
    zend_throw_exception_object(&ex);
    return false;
}

static bool read_call(zval *object, const char *name, zval *result, uint32_t argc, zval *args)
{
    zend_function *fn = object_method_lookup(Z_OBJCE_P(object), name);
    if (fn == NULL) {
        zend_throw_error(NULL, "Method %s::%s is not registered", ZSTR_VAL(Z_OBJCE_P(object)->name), name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, Z_OBJ_P(object), Z_OBJCE_P(object), result, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool read_model_call(zval *model, const char *name, zval *result, uint32_t argc, zval *args)
{
    return native_model_method_call(model_native_class_entry(), model, name, false, result, argc, args);
}

static bool read_model_static_call(zval *model, const char *name, zval *result, uint32_t argc, zval *args)
{
    return native_model_method_call(model_native_class_entry(), model, name, true, result, argc, args);
}

static bool read_child_result(zval *items, zend_string *name, bool relation, zval **child_out, zval **many_out)
{
    *child_out = NULL;
    if (many_out != NULL) *many_out = NULL;
    if (items == NULL || Z_TYPE_P(items) != IS_ARRAY) return true;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(items), zval *item) {
        zval *child = read_array(item, "child");
        zval *many = relation ? read_array(item, "many") : NULL;
        if (child == NULL || Z_TYPE_P(child) != IS_OBJECT || (relation && many == NULL)) continue;
        zval result, argument;
        if (relation) ZVAL_COPY(&argument, many); else ZVAL_FALSE(&argument);
        bool ok = read_model_call(child, "resultName", &result, 1, &argument);
        if (relation) zval_ptr_dtor(&argument);
        if (!ok) return false;
        bool same = Z_TYPE(result) == IS_STRING && zend_string_equals(Z_STR(result), name);
        zval_ptr_dtor(&result);
        if (same) {
            *child_out = child;
            if (many_out != NULL) *many_out = many;
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

static bool read_non_null_string_argument(zend_execute_data *execute_data)
{
    static const char *const scalar_types[] = {"string"};
    return model_reject_null_scalar_args(execute_data, scalar_types, 1);
}

ZEND_METHOD(Polyspec_Orm_Model, newRow)
{
    zval *conn = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT_OR_NULL(conn) ZEND_PARSE_PARAMETERS_END();
    object_init_ex(return_value, Z_OBJCE_P(ZEND_THIS));
    if (EG(exception) != NULL) RETURN_THROWS();
    zend_function *constructor = zend_hash_str_find_ptr(&Z_OBJCE_P(return_value)->function_table,
        "__construct", sizeof("__construct") - 1);
    if (constructor != NULL) {
        zend_call_known_function(constructor, Z_OBJ_P(return_value), model_native_class_entry(), NULL, 0, NULL, NULL);
    }
    if (EG(exception) != NULL) RETURN_THROWS();
    zval copy;
    if (conn == NULL) ZVAL_NULL(&copy); else ZVAL_COPY(&copy, conn);
    model_state_property_set(model_state_of(Z_OBJ_P(return_value)), "conn", &copy);
    zval_ptr_dtor(&copy);
}

static bool read_static_meta(zval *model, zval *meta)
{
    zend_class_entry *ce = Z_OBJCE_P(model);
    zend_function *fn = zend_hash_str_find_ptr(&ce->function_table, "meta", sizeof("meta") - 1);
    if (fn == NULL) {
        zend_throw_error(NULL, "%s::meta is not registered", ZSTR_VAL(ce->name));
        return false;
    }
    ZVAL_UNDEF(meta);
    zend_call_known_function(fn, NULL, ce, meta, 0, NULL, NULL);
    return EG(exception) == NULL && Z_TYPE_P(meta) == IS_ARRAY;
}

static zval *read_array(zval *array, const char *key)
{
    ZVAL_DEREF(array);
    if (Z_TYPE_P(array) != IS_ARRAY) return NULL;
    zval *value = zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key));
    if (value != NULL) ZVAL_DEREF(value);
    return value;
}

static bool read_is_true(zval *array, const char *key)
{
    zval *v = read_array(array, key);
    return v != NULL && zend_is_true(v);
}

static bool read_string_is(zval *v, const char *text)
{
    return v != NULL && Z_TYPE_P(v) == IS_STRING &&
        Z_STRLEN_P(v) == strlen(text) && memcmp(Z_STRVAL_P(v), text, strlen(text)) == 0;
}

static bool read_append_pair(zval *array, zend_long index, zval *name, zval *kind)
{
    zval pair;
    array_init_size(&pair, kind == NULL ? 2 : 3);
    zval idx; ZVAL_LONG(&idx, index); add_next_index_zval(&pair, &idx);
    Z_TRY_ADDREF_P(name); add_next_index_zval(&pair, name);
    if (kind != NULL) { Z_TRY_ADDREF_P(kind); add_next_index_zval(&pair, kind); }
    return add_next_index_zval(array, &pair) == SUCCESS;
}

ZEND_METHOD(Polyspec_Orm_Model, rowShape)
{
    zval *assemble_decl;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(assemble_decl) ZEND_PARSE_PARAMETERS_END();
    zval meta;
    if (!read_static_meta(ZEND_THIS, &meta)) RETURN_THROWS();
    zval *columns = read_array(assemble_decl, "columns");
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) {
        zval_ptr_dtor(&meta); read_throw("INTERNAL", "assemble node has no columns"); RETURN_THROWS();
    }
    array_init(return_value);
    const char *groups[] = {"int", "float", "decimal", "bool", "date", "string", "codec", "extra", "names", "hidden", "original"};
    for (size_t i = 0; i < sizeof(groups) / sizeof(groups[0]); i++) {
        zval group; array_init(&group); add_assoc_zval(return_value, groups[i], &group);
    }
    add_assoc_null(return_value, "key");
    zval *meta_columns = read_array(&meta, "columns");
    zval *names = zend_hash_str_find(Z_ARRVAL_P(return_value), "names", sizeof("names") - 1);
    zval *hidden = zend_hash_str_find(Z_ARRVAL_P(return_value), "hidden", sizeof("hidden") - 1);
    zval *original = zend_hash_str_find(Z_ARRVAL_P(return_value), "original", sizeof("original") - 1);
    zval *groups_arr[] = {
        zend_hash_str_find(Z_ARRVAL_P(return_value), "int", 3),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "float", 5),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "decimal", 7),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "bool", 4),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "date", 4),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "string", 6),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "codec", 5),
        zend_hash_str_find(Z_ARRVAL_P(return_value), "extra", 5)
    };
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), zval *col) {
        zval *name = read_array(col, "name"), *index = read_array(col, "index"), *column = read_array(col, "column");
        if (name == NULL || Z_TYPE_P(name) != IS_STRING || index == NULL || Z_TYPE_P(index) != IS_LONG) {
            zval_ptr_dtor(&meta); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); read_throw("INTERNAL", "assemble column is incomplete"); RETURN_THROWS();
        }
        zval name_copy; ZVAL_COPY(&name_copy, name); add_next_index_zval(names, &name_copy);
        if (read_is_true(col, "hidden")) {
            zval flag; ZVAL_TRUE(&flag); Z_TRY_ADDREF_P(&flag); zend_hash_update(Z_ARRVAL_P(hidden), Z_STR_P(name), &flag);
        }
        zval *meta_col = NULL;
        if (read_string_is(column, Z_STRVAL_P(name)) && meta_columns != NULL && Z_TYPE_P(meta_columns) == IS_ARRAY)
            meta_col = zend_hash_find(Z_ARRVAL_P(meta_columns), Z_STR_P(name));
        if (meta_col != NULL && Z_TYPE_P(meta_col) == IS_ARRAY) {
            zval *codec = read_array(meta_col, "codec"), *type = read_array(meta_col, "type");
            zval kind;
            if (codec != NULL && Z_TYPE_P(codec) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0) ZVAL_STRING(&kind, "codec");
            else if (type != NULL && Z_TYPE_P(type) == IS_STRING) ZVAL_COPY(&kind, type);
            else { zval_ptr_dtor(&meta); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); read_throw("INTERNAL", "model column has no type"); RETURN_THROWS(); }
            size_t group = 5;
            if (read_string_is(&kind, "i16") || read_string_is(&kind, "i32") || read_string_is(&kind, "i64")) group = 0;
            else if (read_string_is(&kind, "f64")) group = 1;
            else if (read_string_is(&kind, "decimal")) group = 2;
            else if (read_string_is(&kind, "bool")) group = 3;
            else if (read_string_is(&kind, "date") || read_string_is(&kind, "datetime")) group = 4;
            else if (read_string_is(&kind, "codec")) group = 6;
            zval *target = groups_arr[group]; SEPARATE_ARRAY(target);
            read_append_pair(target, Z_LVAL_P(index), name, &kind); zval_ptr_dtor(&kind);
        } else {
            zval *target = groups_arr[7]; SEPARATE_ARRAY(target);
            zval *type = read_array(col, "type");
            zval empty; ZVAL_EMPTY_STRING(&empty);
            read_append_pair(target, Z_LVAL_P(index), name, type != NULL && Z_TYPE_P(type) != IS_NULL ? type : &empty);
        }
    } ZEND_HASH_FOREACH_END();
    zval *keys = read_array(assemble_decl, "key");
    if (keys != NULL && Z_TYPE_P(keys) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), zval *key) {
            zval *key_index = read_array(key, "index");
            if (key_index == NULL || Z_TYPE_P(key_index) != IS_LONG) continue;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), zval *col) {
                zval *index = read_array(col, "index"), *name = read_array(col, "name");
                if (index != NULL && Z_TYPE_P(index) == IS_LONG && Z_LVAL_P(index) == Z_LVAL_P(key_index) && name != NULL) {
                    zval copy; ZVAL_COPY(&copy, name); add_next_index_zval(original, &copy); break;
                }
            } ZEND_HASH_FOREACH_END();
        } ZEND_HASH_FOREACH_END();
        if (zend_hash_num_elements(Z_ARRVAL_P(keys)) == 1) {
            zval *key = zend_hash_index_find(Z_ARRVAL_P(keys), 0), *index = key != NULL ? read_array(key, "index") : NULL;
            /* A bool or datetime key goes through read_key_cells: its cell is an integer or a text, and the key keeps the declared type (INT-11, PRT-35). */
            bool typed = false;
            if (index != NULL && Z_TYPE_P(index) == IS_LONG) {
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), zval *col) {
                    zval *at = read_array(col, "index"), *type = read_array(col, "type");
                    if (at != NULL && Z_TYPE_P(at) == IS_LONG && Z_LVAL_P(at) == Z_LVAL_P(index) && type != NULL && (read_string_is(type, "bool") || read_string_is(type, "datetime"))) typed = true;
                } ZEND_HASH_FOREACH_END();
            }
            if (index != NULL && !typed) { zval copy; ZVAL_COPY(&copy, index); zend_hash_str_update(Z_ARRVAL_P(return_value), "key", 3, &copy); }
        }
    }
    zval *updated = read_array(&meta, "updated");
    if (updated != NULL && Z_TYPE_P(updated) == IS_STRING && Z_STRLEN_P(updated) != 0) {
        bool selected = false;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(names), zval *name) {
            if (Z_TYPE_P(name) == IS_STRING && zend_string_equals(Z_STR_P(name), Z_STR_P(updated))) {
                selected = true;
                break;
            }
        } ZEND_HASH_FOREACH_END();
        if (selected) { zval copy; ZVAL_COPY(&copy, updated); add_next_index_zval(original, &copy); }
    }
    zval row; array_init(&row);
    add_assoc_bool(&row, "loaded", true);
    zval copy; ZVAL_COPY(&copy, names); add_assoc_zval(&row, "names", &copy);
    ZVAL_COPY(&copy, hidden); add_assoc_zval(&row, "hidden", &copy);
    zval empty; array_init(&empty); add_assoc_zval(&row, "original", &empty);
    array_init(&empty); add_assoc_zval(&row, "extra", &empty);
    array_init(&empty); add_assoc_zval(&row, "extra_date", &empty);
    array_init(&empty); add_assoc_zval(&row, "related", &empty);
    array_init(&empty); add_assoc_zval(&row, "cascade", &empty);
    array_init(&empty); add_assoc_zval(&row, "flat", &empty);
    add_assoc_zval(return_value, "row", &row);
    zval_ptr_dtor(&meta);
}

static bool read_static_call(zend_class_entry *ce, const char *name, zval *result, uint32_t argc, zval *args)
{
    zend_function *fn = object_method_lookup(ce, name);
    if (fn == NULL) {
        zend_throw_error(NULL, "Static method %s::%s is not registered", ZSTR_VAL(ce->name), name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, NULL, ce, result, argc, args, NULL);
    return EG(exception) == NULL;
}

static zval *read_object_prop(zval *object, const char *name)
{
    return zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), 1, &EG(uninitialized_zval));
}

static bool read_convert_resource(zval *value)
{
    if (Z_TYPE_P(value) != IS_RESOURCE) return true;
    zval function, result, arg;
    ZVAL_STRING(&function, "stream_get_contents"); ZVAL_COPY(&arg, value);
    ZVAL_UNDEF(&result);
    zend_result status = call_user_function(EG(function_table), NULL, &function, &result, 1, &arg);
    zval_ptr_dtor(&function); zval_ptr_dtor(&arg);
    if (status != SUCCESS || EG(exception) != NULL) { if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result); return false; }
    zval_ptr_dtor(value); ZVAL_COPY_VALUE(value, &result);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, joinChild)
{
    if (!read_non_null_string_argument(execute_data)) RETURN_THROWS();
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *joins = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "joins");
    zval *child;
    if (!read_child_result(joins, name, false, &child, NULL)) RETURN_THROWS();
    if (child != NULL) RETURN_COPY(child);
    zend_string *message = strpprintf(0, "join result %s without a model", ZSTR_VAL(name));
    read_throw("INTERNAL", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, relationChild)
{
    if (!read_non_null_string_argument(execute_data)) RETURN_THROWS();
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *relations = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "relations");
    zval *child, *many;
    if (!read_child_result(relations, name, true, &child, &many)) RETURN_THROWS();
    if (child != NULL) {
        array_init_size(return_value, 2); zval child_copy, many_copy;
        ZVAL_COPY(&child_copy, child); ZVAL_COPY(&many_copy, many);
        add_next_index_zval(return_value, &child_copy); add_next_index_zval(return_value, &many_copy); return;
    }
    zend_string *message = strpprintf(0, "relation result %s without a model", ZSTR_VAL(name));
    read_throw("INTERNAL", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, assembleRow)
{
    zval *assembly, *assemble_decl, *vals;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_OBJECT(assembly) Z_PARAM_ARRAY(assemble_decl) Z_PARAM_ARRAY(vals) ZEND_PARSE_PARAMETERS_END();
    zval shape_args[1], shape; ZVAL_COPY(&shape_args[0], assemble_decl);
    if (!read_model_call(ZEND_THIS, "rowShape", &shape, 1, shape_args)) { zval_ptr_dtor(&shape_args[0]); RETURN_THROWS(); }
    zval_ptr_dtor(&shape_args[0]);
    zval *conn = read_object_prop(assembly, "conn"), *zone = read_object_prop(assembly, "zone"), *db = read_object_prop(assembly, "db");
    zval conn_arg, model; ZVAL_COPY(&conn_arg, conn);
    if (!read_model_call(ZEND_THIS, "newRow", &model, 1, &conn_arg)) { zval_ptr_dtor(&conn_arg); zval_ptr_dtor(&shape); RETURN_THROWS(); }
    zval_ptr_dtor(&conn_arg);
    zval meta;
    if (!read_static_meta(ZEND_THIS, &meta)) { zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
    zval *entity_value = read_array(&meta, "entity"), driver;
    if (entity_value == NULL || Z_TYPE_P(entity_value) != IS_STRING) {
        zval_ptr_dtor(&meta); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); read_throw("INTERNAL", "the model metadata names no entity"); RETURN_THROWS();
    }
    zend_string *entity = Z_STR_P(entity_value);
    if (!read_call(db, "dialect", &driver, 0, NULL)) { zval_ptr_dtor(&meta); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
    bool sqlite = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR(driver), "sqlite");
    zval_ptr_dtor(&driver);
    zval values; array_init(&values);
    const char *convert_groups[] = {"int", "float", "decimal", "bool", "date", "string", "codec"};
    for (size_t g = 0; g < sizeof(convert_groups)/sizeof(convert_groups[0]); g++) {
        zval *group = read_array(&shape, convert_groups[g]);
        if (group == NULL || Z_TYPE_P(group) != IS_ARRAY) continue;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(group), zval *entry) {
            zval *idx = zend_hash_index_find(Z_ARRVAL_P(entry), 0), *column_name = zend_hash_index_find(Z_ARRVAL_P(entry), 1);
            if (idx == NULL || Z_TYPE_P(idx) != IS_LONG || column_name == NULL || Z_TYPE_P(column_name) != IS_STRING) continue;
            zval *raw = zend_hash_index_find(Z_ARRVAL_P(vals), (zend_ulong)Z_LVAL_P(idx));
            if (raw == NULL) { zval_ptr_dtor(&meta); zval_ptr_dtor(&values); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); read_throw("INTERNAL", "row result column is missing"); RETURN_THROWS(); }
            zval converted;
            if (g == 6 || Z_TYPE_P(raw) == IS_NULL) {
                ZVAL_COPY(&converted, raw);
            } else {
                zval *meta_cols = read_array(&meta, "columns");
                zval *column = meta_cols != NULL && Z_TYPE_P(meta_cols) == IS_ARRAY
                    ? zend_hash_find(Z_ARRVAL_P(meta_cols), Z_STR_P(column_name)) : NULL;
                zval *aes_version = read_array(&meta, "aes_version");
                bool converted_ok;
                if (column == NULL) {
                    converted_ok = read_throw("INTERNAL", "row result column has no declaration");
                } else if (aes_version != NULL && Z_TYPE_P(aes_version) == IS_STRING
                    && zend_string_equals(Z_STR_P(aes_version), Z_STR_P(column_name))) {
                    /* COD-44, COD-53: the key version column holds a stored version, its digits read as its number. */
                    zend_long version;
                    converted_ok = aes_stored_version(raw, &version);
                    if (converted_ok) {
                        ZVAL_LONG(&converted, version);
                    } else {
                        zend_string *message = zend_string_init(ZEND_STRL("aes version is not a positive 32-bit integer"), 0);
                        zval exception;
                        if (cell_refusal(entity, Z_STR_P(column_name), message, NULL, &exception)) zend_throw_exception_object(&exception);
                        zend_string_release(message);
                    }
                } else {
                    converted_ok = cell_value(entity, Z_STR_P(column_name), column, raw, sqlite, !sqlite, zone, &converted);
                }
                if (!converted_ok) {
                    zval_ptr_dtor(&meta); zval_ptr_dtor(&values); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS();
                }
            }
            zend_hash_update(Z_ARRVAL(values), Z_STR_P(column_name), &converted);
        } ZEND_HASH_FOREACH_END();
    }
    model_state_property_set(model_state_of(Z_OBJ(model)), "values", &values);
    zval_ptr_dtor(&values);
    zval *row_state = read_array(&shape, "row"); zval st; ZVAL_COPY(&st, row_state);
    zval *extra = read_array(&shape, "extra");
    if (extra != NULL && Z_TYPE_P(extra) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(extra), zval *entry) {
            zval *idx=zend_hash_index_find(Z_ARRVAL_P(entry),0), *name=zend_hash_index_find(Z_ARRVAL_P(entry),1), *kind=zend_hash_index_find(Z_ARRVAL_P(entry),2);
            zval *raw=idx!=NULL&&Z_TYPE_P(idx)==IS_LONG?zend_hash_index_find(Z_ARRVAL_P(vals),(zend_ulong)Z_LVAL_P(idx)):NULL;
            if(name==NULL||raw==NULL) continue;
            zval converted;
            if (Z_TYPE_P(raw) != IS_NULL && kind != NULL && Z_TYPE_P(name) == IS_STRING && (
                read_string_is(kind, "i16") || read_string_is(kind, "i32") || read_string_is(kind, "i64") ||
                read_string_is(kind, "f64") || read_string_is(kind, "bool") || read_string_is(kind, "date") ||
                read_string_is(kind, "datetime"))) {
                /* INT-160: an added column is decoded by the type of its plan column; an integer may be its exact digits as
                 * text, and a datetime has the precision 6 of an expression. */
                zval column, kind_copy, precision, cell;
                array_init(&column);
                ZVAL_COPY(&kind_copy, kind);
                ZVAL_LONG(&precision, 6);
                zend_hash_str_update(Z_ARRVAL(column), "type", sizeof("type") - 1, &kind_copy);
                zend_hash_str_update(Z_ARRVAL(column), "precision", sizeof("precision") - 1, &precision);
                bool ok = cell_value(entity, Z_STR_P(name), &column, raw, sqlite, true, zone, &cell);
                zval_ptr_dtor(&column);
                if (ok && Z_TYPE(cell) == IS_OBJECT && Z_OBJCE(cell) == polyspec_pending_time_ce) {
                    zval *text = zend_read_property(polyspec_pending_time_ce, Z_OBJ(cell), ZEND_STRL("text"), 1, NULL);
                    ok = text != NULL && model_time_value_in_zone(text, zone, Z_STRVAL_P(kind), &converted);
                    zval_ptr_dtor(&cell);
                } else if (ok) {
                    ZVAL_COPY_VALUE(&converted, &cell);
                }
                if (!ok) { zval_ptr_dtor(&meta); zval_ptr_dtor(&st); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
            } else {
                ZVAL_COPY(&converted, raw);
                if (!read_convert_resource(&converted)) { zval_ptr_dtor(&converted); zval_ptr_dtor(&meta); zval_ptr_dtor(&st); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
            }
            if (kind != NULL && read_string_is(kind, "date")) {
                zval *dates = read_array(&st, "extra_date");
                if (dates != NULL && Z_TYPE_P(dates) == IS_ARRAY) { zval marked; ZVAL_TRUE(&marked); zend_hash_update(Z_ARRVAL_P(dates), Z_STR_P(name), &marked); }
            }
            zval *extra_map=read_array(&st,"extra"); if(extra_map!=NULL&&Z_TYPE_P(extra_map)==IS_ARRAY) zend_hash_update(Z_ARRVAL_P(extra_map),Z_STR_P(name),&converted); else zval_ptr_dtor(&converted);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&meta);
    zval *original=read_array(&shape,"original"), *value_map=model_state_property(model_state_of(Z_OBJ(model)),"values"), *orig_map=read_array(&st,"original");
    if(original!=NULL&&Z_TYPE_P(original)==IS_ARRAY&&orig_map!=NULL&&Z_TYPE_P(orig_map)==IS_ARRAY){ ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(original),zval *name){ zval *v=zend_hash_find(Z_ARRVAL_P(value_map),Z_STR_P(name)); zval copy; if(v==NULL) ZVAL_NULL(&copy); else ZVAL_COPY(&copy,v); zend_hash_update(Z_ARRVAL_P(orig_map),Z_STR_P(name),&copy); } ZEND_HASH_FOREACH_END(); }
    zval *news=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"news"); if(news!=NULL) model_state_property_set(model_state_of(Z_OBJ(model)),"news",news);
    zval *children=read_array(assemble_decl,"children"); zval call_result;
    if(children!=NULL&&Z_TYPE_P(children)==IS_ARRAY){
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(children),zval *ch){ zval *kind=read_array(ch,"kind"), *rel=read_array(ch,"rel"); if(rel==NULL||Z_TYPE_P(rel)!=IS_STRING) continue;
            zval rel_value; ZVAL_NULL(&rel_value); bool cascade=false;
            if(read_string_is(kind,"join")){
                zval child_args[1],child; ZVAL_COPY(&child_args[0],rel);
                if(!read_model_call(ZEND_THIS,"joinChild",&child,1,child_args)){zval_ptr_dtor(&child_args[0]);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();} zval_ptr_dtor(&child_args[0]);
                zval jr_args[2],jrow;ZVAL_COPY(&jr_args[0],ch);ZVAL_COPY(&jr_args[1],vals);
                bool ok=read_call(assembly,"joinRow",&jrow,2,jr_args);zval_ptr_dtor(&jr_args[0]);zval_ptr_dtor(&jr_args[1]);
                if(!ok){zval_ptr_dtor(&child);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}
                if(Z_TYPE(jrow)!=IS_NULL){zval *child_asm=read_array(ch,"assemble");zval args[3],assembled;ZVAL_COPY(&args[0],assembly);ZVAL_COPY(&args[1],child_asm);ZVAL_COPY(&args[2],&jrow);ok=read_model_call(&child,"assembleRow",&assembled,3,args);for(int k=0;k<3;k++)zval_ptr_dtor(&args[k]);if(!ok){zval_ptr_dtor(&jrow);zval_ptr_dtor(&child);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}zval_ptr_dtor(&jrow);ZVAL_COPY_VALUE(&rel_value,&assembled);}
                zval_ptr_dtor(&child);
            } else {
                zval rel_args[1], child_pair; ZVAL_COPY(&rel_args[0],rel);
                if(!read_model_call(ZEND_THIS,"relationChild",&child_pair,1,rel_args)){zval_ptr_dtor(&rel_args[0]);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}zval_ptr_dtor(&rel_args[0]);
                zval *child=zend_hash_index_find(Z_ARRVAL(child_pair),0), *many=zend_hash_index_find(Z_ARRVAL(child_pair),1);
                zval rargs[2],rows;ZVAL_COPY(&rargs[0],ch);ZVAL_COPY(&rargs[1],vals);bool ok=read_call(assembly,"related",&rows,2,rargs);zval_ptr_dtor(&rargs[0]);zval_ptr_dtor(&rargs[1]);
                if(!ok){zval_ptr_dtor(&child_pair);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}
                zval aa[1], child_asm;ZVAL_COPY(&aa[0],ch);ok=read_call(assembly,"relationAssemble",&child_asm,1,aa);zval_ptr_dtor(&aa[0]);
                if(!ok){zval_ptr_dtor(&rows);zval_ptr_dtor(&child_pair);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}
                if(zend_is_true(many)){ object_init_ex(&rel_value,read_lookup_class("Polyspec\\Orm\\Collection")); if(EG(exception)!=NULL){zval_ptr_dtor(&rows);zval_ptr_dtor(&child_asm);zval_ptr_dtor(&child_pair);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}
                    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows),zval *cr){zval args[3],cm;ZVAL_COPY(&args[0],assembly);ZVAL_COPY(&args[1],&child_asm);ZVAL_COPY(&args[2],cr);ok=read_model_call(child,"assembleRow",&cm,3,args);for(int k=0;k<3;k++)zval_ptr_dtor(&args[k]);if(!ok){zval_ptr_dtor(&rows);zval_ptr_dtor(&child_asm);zval_ptr_dtor(&child_pair);zval_ptr_dtor(&rel_value);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}zval keyargs[3],key;ZVAL_COPY(&keyargs[0],&cm);ZVAL_COPY(&keyargs[1],&child_asm);ZVAL_COPY(&keyargs[2],cr);ok=read_model_call(child,"collectionKey",&key,3,keyargs);for(int k=0;k<3;k++)zval_ptr_dtor(&keyargs[k]);if(!ok){zval_ptr_dtor(&cm);zval_ptr_dtor(&rows);zval_ptr_dtor(&child_asm);zval_ptr_dtor(&child_pair);zval_ptr_dtor(&rel_value);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}zval put_args[2];ZVAL_COPY(&put_args[0],&key);ZVAL_COPY(&put_args[1],&cm);ok=read_call(&rel_value,"put",&call_result,2,put_args);zval_ptr_dtor(&put_args[0]);zval_ptr_dtor(&put_args[1]);zval_ptr_dtor(&key);zval_ptr_dtor(&cm);if(!ok){zval_ptr_dtor(&rows);zval_ptr_dtor(&child_asm);zval_ptr_dtor(&child_pair);zval_ptr_dtor(&rel_value);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}zval_ptr_dtor(&call_result);} ZEND_HASH_FOREACH_END();
                } else { zval *first=zend_hash_index_find(Z_ARRVAL(rows),0); if(first==NULL)ZVAL_NULL(&rel_value);else{zval args[3],cm;ZVAL_COPY(&args[0],assembly);ZVAL_COPY(&args[1],&child_asm);ZVAL_COPY(&args[2],first);ok=read_model_call(child,"assembleRow",&cm,3,args);for(int k=0;k<3;k++)zval_ptr_dtor(&args[k]);if(!ok){zval_ptr_dtor(&rows);zval_ptr_dtor(&child_asm);zval_ptr_dtor(&child_pair);zval_ptr_dtor(&st);zval_ptr_dtor(&model);zval_ptr_dtor(&shape);RETURN_THROWS();}ZVAL_COPY_VALUE(&rel_value,&cm);} if(read_is_true(ch,"flatten")){zval *flat=read_array(&st,"flat");if(flat!=NULL){zval n;ZVAL_COPY(&n,rel);add_next_index_zval(flat,&n);}} }
                cascade=read_is_true(ch,"cascade");zval_ptr_dtor(&rows);zval_ptr_dtor(&child_asm);zval_ptr_dtor(&child_pair);
            }
            zval *related=read_array(&st,"related"),*cascades=read_array(&st,"cascade");if(related!=NULL)zend_hash_update(Z_ARRVAL_P(related),Z_STR_P(rel),&rel_value);else zval_ptr_dtor(&rel_value);if(cascades!=NULL){zval flag;ZVAL_BOOL(&flag,cascade);zend_hash_update(Z_ARRVAL_P(cascades),Z_STR_P(rel),&flag);}
        } ZEND_HASH_FOREACH_END();
    }
    model_state_property_set(model_state_of(Z_OBJ(model)),"row",&st);zval_ptr_dtor(&st);
    zval *track=read_object_prop(assembly,"track"); if(zend_is_true(track)){zval *made=read_object_prop(assembly,"made");if(Z_TYPE_P(made)==IS_ARRAY){SEPARATE_ARRAY(made);zend_ulong id=Z_OBJ_HANDLE_P(ZEND_THIS);zval *parents=zend_hash_index_find(Z_ARRVAL_P(made),id);if(parents==NULL){zval list;array_init(&list);parents=zend_hash_index_update(Z_ARRVAL_P(made),id,&list);}else SEPARATE_ARRAY(parents);Z_TRY_ADDREF(model);add_next_index_zval(parents,&model);}}
    zval_ptr_dtor(&shape);ZVAL_COPY_VALUE(return_value,&model);
}

/* The row whose key cells hold the declared type of their column: a bool column reads as an integer on MySQL and SQLite, and a datetime column as its text (INT-11, PRT-35). */
static bool read_key_cells(zval *assemble_decl, zval *key_index, zval *vals, zval *out)
{
    ZVAL_DUP(out, vals);
    zval *columns = read_array(assemble_decl, "columns");
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) return true;
    zval *ref, *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(key_index), ref) {
        zval *index = read_array(ref, "index");
        if (index == NULL || Z_TYPE_P(index) != IS_LONG) continue;
        zval *cell = zend_hash_index_find(Z_ARRVAL_P(out), Z_LVAL_P(index));
        if (cell == NULL || Z_TYPE_P(cell) == IS_NULL) continue;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval *at = read_array(column, "index");
            if (at == NULL || Z_TYPE_P(at) != IS_LONG || Z_LVAL_P(at) != Z_LVAL_P(index)) continue;
            zval *type = read_array(column, "type");
            if (type != NULL && read_string_is(type, "bool")) {
                bool truth = zend_is_true(cell);
                zval_ptr_dtor(cell);
                ZVAL_BOOL(cell, truth);
            } else if (type != NULL && read_string_is(type, "datetime") && Z_TYPE_P(cell) == IS_STRING) {
                zval fn, text, date;
                ZVAL_STRING(&fn, "date_create_immutable");
                ZVAL_STR(&text, zend_strpprintf(0, "%s UTC", Z_STRVAL_P(cell)));
                ZVAL_UNDEF(&date);
                zend_result status = call_user_function(EG(function_table), NULL, &fn, &date, 1, &text);
                zval_ptr_dtor(&fn);
                zval_ptr_dtor(&text);
                if (status != SUCCESS || EG(exception) != NULL || Z_TYPE(date) != IS_OBJECT) {
                    zval_ptr_dtor(&date);
                    zval_ptr_dtor(out);
                    if (EG(exception) == NULL) read_throw("CODEC_DECODE", "collection key holds an invalid date and time");
                    return false;
                }
                zval_ptr_dtor(cell);
                ZVAL_COPY_VALUE(cell, &date);
            }
            break;
        } ZEND_HASH_FOREACH_END();
    } ZEND_HASH_FOREACH_END();
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, collectionKey)
{
    zval *model, *assemble_decl, *vals;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_OBJECT(model) Z_PARAM_ARRAY(assemble_decl) Z_PARAM_ARRAY(vals) ZEND_PARSE_PARAMETERS_END();
    zval *fetch_key=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"fetch_key");
    if(fetch_key!=NULL&&Z_TYPE_P(fetch_key)==IS_OBJECT){ zval args[1], value;ZVAL_COPY(&args[0],model);ZVAL_UNDEF(&value);zend_result status=call_user_function(EG(function_table),NULL,fetch_key,&value,1,args);zval_ptr_dtor(&args[0]);if(status!=SUCCESS||EG(exception)!=NULL){if(!Z_ISUNDEF(value))zval_ptr_dtor(&value);RETURN_THROWS();}zval keyarg[1],key;ZVAL_COPY(&keyarg[0],&value);zend_class_entry *collection=read_lookup_class("Polyspec\\Orm\\Collection");bool ok=collection!=NULL&&read_static_call(collection,"keyOf",&key,1,keyarg);zval_ptr_dtor(&keyarg[0]);zval_ptr_dtor(&value);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&key);return; }
    zval *key_name=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"key_name");
    if(key_name!=NULL&&Z_TYPE_P(key_name)==IS_STRING&&Z_STRLEN_P(key_name)!=0){ zval *values=model_state_property(model_state_of(Z_OBJ_P(model)),"values"),*row=model_state_property(model_state_of(Z_OBJ_P(model)),"row");zval *value=values!=NULL&&Z_TYPE_P(values)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(values),Z_STR_P(key_name)):NULL;if(value==NULL&&row!=NULL&&Z_TYPE_P(row)==IS_ARRAY){zval *extra=read_array(row,"extra");value=extra!=NULL&&Z_TYPE_P(extra)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(extra),Z_STR_P(key_name)):NULL;}if(value==NULL){read_throw("CODEC_DECODE","collection key is SQL NULL");RETURN_THROWS();}zval arg,key;ZVAL_COPY(&arg,value);zend_class_entry *collection=read_lookup_class("Polyspec\\Orm\\Collection");bool ok=collection!=NULL&&read_static_call(collection,"keyOf",&key,1,&arg);zval_ptr_dtor(&arg);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&key);return; }
    zval *key_index=read_array(assemble_decl,"key");if(key_index==NULL||Z_TYPE_P(key_index)!=IS_ARRAY){read_throw("INTERNAL","collection row has no key declaration");RETURN_THROWS();}
    zval args[2],key;if(!read_key_cells(assemble_decl,key_index,vals,&args[0]))RETURN_THROWS();ZVAL_COPY(&args[1],key_index);zend_class_entry *db=read_lookup_class("Polyspec\\Orm\\Db");bool ok=db!=NULL&&read_static_call(db,"rowKey",&key,2,args);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);if(!ok)RETURN_THROWS();if(Z_TYPE(key)==IS_NULL){zval_ptr_dtor(&key);read_throw("CODEC_DECODE","collection row identity contains SQL NULL");RETURN_THROWS();}ZVAL_COPY_VALUE(return_value,&key);
}

ZEND_METHOD(Polyspec_Orm_Model, columnOrExtra)
{
    if (!read_non_null_string_argument(execute_data)) RETURN_THROWS();
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *values = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "values");
    zval *value = values != NULL && Z_TYPE_P(values) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(values), name) : NULL;
    if (value != NULL) {
        zval arg, result; ZVAL_STR_COPY(&arg, name);
        if (!read_model_call(ZEND_THIS, "value", &result, 1, &arg)) { zval_ptr_dtor(&arg); RETURN_THROWS(); }
        zval_ptr_dtor(&arg); ZVAL_COPY_VALUE(return_value, &result); return;
    }
    zval *row = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "row");
    zval *extra = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? read_array(row, "extra") : NULL;
    value = extra != NULL && Z_TYPE_P(extra) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(extra), name) : NULL;
    if (value == NULL) RETURN_NULL();
    RETURN_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_Model, matchValues)
{
    static const char *const scalar_types[] = {NULL, "string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zval *model; zend_string *side;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_OBJECT(model) Z_PARAM_STR(side) ZEND_PARSE_PARAMETERS_END();
    zval *matches = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "matches");
    if (matches != NULL) ZVAL_DEREF(matches);
    array_init(return_value);
    if (matches == NULL || Z_TYPE_P(matches) != IS_ARRAY) return;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(matches), zval *match) {
        ZVAL_DEREF(match);
        zval *column = Z_TYPE_P(match) == IS_ARRAY
            ? zend_hash_find(Z_ARRVAL_P(match), side)
            : NULL;
        if (column != NULL) ZVAL_DEREF(column);
        if (column == NULL || Z_TYPE_P(column) != IS_STRING) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); read_throw("INTERNAL", "relation match has no column"); RETURN_THROWS(); }
        zval args[1], value; ZVAL_COPY(&args[0], column);
        if (!read_model_call(model, "columnOrExtra", &value, 1, args)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); }
        zval_ptr_dtor(&args[0]);
        if (Z_TYPE(value) == IS_NULL) { zval_ptr_dtor(&value); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_NULL(); }
        add_next_index_zval(return_value, &value);
    } ZEND_HASH_FOREACH_END();
}

ZEND_METHOD(Polyspec_Orm_Model, matchKey)
{
    zval *values;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(values) ZEND_PARSE_PARAMETERS_END();
    zend_string *out = zend_string_init("", 0, 0);
    zend_ulong count = zend_hash_num_elements(Z_ARRVAL_P(values));
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(values), zval *value) {
        zval args[1], text; ZVAL_COPY(&args[0], value);
        zend_class_entry *db = read_lookup_class("Polyspec\\Orm\\Db");
        if (db == NULL || !read_static_call(db, "scalarText", &text, 1, args)) { zval_ptr_dtor(&args[0]); zend_string_release(out); RETURN_THROWS(); }
        zval_ptr_dtor(&args[0]);
        if (Z_TYPE(text) != IS_STRING) { zval_ptr_dtor(&text); zend_string_release(out); read_throw("INTERNAL", "Db::scalarText did not return text"); RETURN_THROWS(); }
        if (count == 1) {
            zend_string_release(out); ZVAL_STR(return_value, Z_STR(text)); return;
        }
        zend_string *piece = strpprintf(0, "%zu:%s", Z_STRLEN(text), Z_STRVAL(text));
        zend_string *joined = zend_string_concat2(ZSTR_VAL(out), ZSTR_LEN(out), ZSTR_VAL(piece), ZSTR_LEN(piece));
        zend_string_release(out); zend_string_release(piece); zval_ptr_dtor(&text); out = joined;
    } ZEND_HASH_FOREACH_END();
    ZVAL_STR(return_value, out);
}

static bool read_same_scalar(zval *left, zval *right, bool *same)
{
    zval args[2], result; ZVAL_COPY(&args[0], left); ZVAL_COPY(&args[1], right);
    zend_class_entry *db = read_lookup_class("Polyspec\\Orm\\Db");
    bool ok = db != NULL && read_static_call(db, "sameScalar", &result, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (!ok) return false;
    *same = zend_is_true(&result); zval_ptr_dtor(&result); return true;
}

ZEND_METHOD(Polyspec_Orm_Model, attachExternal)
{
    static const char *const scalar_types[] = {NULL, "bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zval *parents; bool many;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ARRAY(parents) Z_PARAM_BOOL(many) ZEND_PARSE_PARAMETERS_END();
    zval values, seen; array_init(&values); array_init(&seen);
    zval *possible = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "possible");
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(parents), zval *parent) {
        if (possible != NULL && Z_TYPE_P(possible) == IS_ARRAY) {
            zval *column = read_array(possible, "column"), *expected = read_array(possible, "value");
            if (column != NULL && expected != NULL) {
                zval arg, actual; ZVAL_COPY(&arg, column);
                if (!read_model_call(parent, "columnOrExtra", &actual, 1, &arg)) { zval_ptr_dtor(&arg); zval_ptr_dtor(&values); zval_ptr_dtor(&seen); RETURN_THROWS(); }
                zval_ptr_dtor(&arg); bool same;
                if (!read_same_scalar(&actual, expected, &same)) { zval_ptr_dtor(&actual); zval_ptr_dtor(&values); zval_ptr_dtor(&seen); RETURN_THROWS(); }
                zval_ptr_dtor(&actual); if (!same) continue;
            }
        }
        zval side, args[2], match_values; ZVAL_STRING(&side, "left"); ZVAL_COPY(&args[0], parent); ZVAL_COPY(&args[1], &side);
        if (!read_model_call(ZEND_THIS, "matchValues", &match_values, 2, args)) { zval_ptr_dtor(&side); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&values); zval_ptr_dtor(&seen); RETURN_THROWS(); }
        zval_ptr_dtor(&side); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
        if (Z_TYPE(match_values) == IS_NULL) { zval_ptr_dtor(&match_values); continue; }
        zval key_args[1], key; ZVAL_COPY(&key_args[0], &match_values);
        if (!read_model_static_call(ZEND_THIS, "matchKey", &key, 1, key_args)) { zval_ptr_dtor(&key_args[0]); zval_ptr_dtor(&match_values); zval_ptr_dtor(&values); zval_ptr_dtor(&seen); RETURN_THROWS(); }
        zval_ptr_dtor(&key_args[0]);
        if (zend_hash_exists(Z_ARRVAL(seen), Z_STR(key))) { zval_ptr_dtor(&key); zval_ptr_dtor(&match_values); continue; }
        zval flag; ZVAL_TRUE(&flag); zend_hash_update(Z_ARRVAL(seen), Z_STR(key), &flag);
        zval *matches = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "matches");
        bool scalar = matches != NULL && zend_hash_num_elements(Z_ARRVAL_P(matches)) == 1;
        zval add;
        if (scalar) { ZVAL_COPY(&add, zend_hash_index_find(Z_ARRVAL(match_values), 0)); }
        else { ZVAL_COPY(&add, &match_values); }
        add_next_index_zval(&values, &add); zval_ptr_dtor(&key); zval_ptr_dtor(&match_values);
    } ZEND_HASH_FOREACH_END();

    zval by_key; array_init(&by_key);
    if (zend_hash_num_elements(Z_ARRVAL(values)) != 0) {
        zval clone; ZVAL_OBJ(&clone, zend_objects_clone_obj(Z_OBJ_P(ZEND_THIS)));
        if (EG(exception) != NULL) { zval_ptr_dtor(&values); zval_ptr_dtor(&seen); zval_ptr_dtor(&by_key); RETURN_THROWS(); }
        zval empty; array_init(&empty); model_state_property_set(model_state_of(Z_OBJ(clone)), "matches", &empty); zval_ptr_dtor(&empty);
        zval alias; ZVAL_EMPTY_STRING(&alias); model_state_property_set(model_state_of(Z_OBJ(clone)), "alias", &alias); zval_ptr_dtor(&alias);
        zval *matches = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "matches"); zval rights; array_init(&rights);
        if (matches != NULL) ZVAL_DEREF(matches);
        if (matches != NULL && Z_TYPE_P(matches) == IS_ARRAY) ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(matches), zval *match) { ZVAL_DEREF(match); zval *right=Z_TYPE_P(match)==IS_ARRAY?zend_hash_str_find(Z_ARRVAL_P(match),"right",sizeof("right")-1):NULL; if(right!=NULL){ZVAL_DEREF(right);zval c;ZVAL_COPY(&c,right);add_next_index_zval(&rights,&c);} } ZEND_HASH_FOREACH_END();
        zval predicate;
        if (zend_hash_num_elements(Z_ARRVAL(rights)) == 1) {
            zval pred; array_init(&pred); zval *col=zend_hash_index_find(Z_ARRVAL(rights),0); zval c; ZVAL_COPY(&c,col); add_assoc_zval(&pred,"column",&c); add_assoc_string(&pred,"op","in"); ZVAL_COPY(&c,&values); add_assoc_zval(&pred,"value",&c); add_assoc_string(&pred,"kind","list");
            array_init(&predicate); add_assoc_zval(&predicate,"pred",&pred);
        } else {
            zval pred; array_init(&pred); add_assoc_string(&pred,"op","tuple_in"); zval c; ZVAL_COPY(&c,&rights); add_assoc_zval(&pred,"cols",&c); ZVAL_COPY(&c,&values); add_assoc_zval(&pred,"value",&c); add_assoc_string(&pred,"kind","tuple");
            array_init(&predicate); add_assoc_zval(&predicate,"pred",&pred);
        }
        zval *where=model_state_property(model_state_of(Z_OBJ(clone)),"where");
        if(where!=NULL&&Z_TYPE_P(where)==IS_ARRAY){
            model_state_array_separate(where); zval *items=zend_hash_str_find(Z_ARRVAL_P(where),"items",5);
            if(items!=NULL&&Z_TYPE_P(items)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(items))>0){
                zval group; array_init(&group); add_assoc_string(&group,"conn",""); zval copied; ZVAL_COPY(&copied,items); add_assoc_zval(&group,"group",&copied);
                zval *conn=zend_hash_str_find(Z_ARRVAL(predicate),"conn",4); if(conn==NULL)add_assoc_string(&predicate,"conn","and");
                zval new_items; array_init(&new_items); add_next_index_zval(&new_items,&group); Z_TRY_ADDREF(predicate); add_next_index_zval(&new_items,&predicate); zend_hash_str_update(Z_ARRVAL_P(where),"items",5,&new_items);
            } else { zval new_items; array_init(&new_items); add_assoc_string(&predicate,"conn",""); Z_TRY_ADDREF(predicate); add_next_index_zval(&new_items,&predicate); zend_hash_str_update(Z_ARRVAL_P(where),"items",5,&new_items); }
        }
        zval rows; if (!read_model_call(&clone,"gets",&rows,0,NULL)) { zval_ptr_dtor(&predicate); zval_ptr_dtor(&rights); zval_ptr_dtor(&clone); zval_ptr_dtor(&values); zval_ptr_dtor(&seen); zval_ptr_dtor(&by_key); RETURN_THROWS(); }
        zval entries; if (!read_call(&rows,"entries",&entries,0,NULL)) { zval_ptr_dtor(&rows); zval_ptr_dtor(&predicate); zval_ptr_dtor(&rights); zval_ptr_dtor(&clone); zval_ptr_dtor(&values); zval_ptr_dtor(&seen); zval_ptr_dtor(&by_key); RETURN_THROWS(); }
        zval_ptr_dtor(&rows);
        zval *group_limit=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"group_limit"); zend_long max=group_limit!=NULL?zval_get_long(group_limit):0;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(entries), zval *entry) {
            zval *key=zend_hash_index_find(Z_ARRVAL_P(entry),0), *model=zend_hash_index_find(Z_ARRVAL_P(entry),1); if(key==NULL||model==NULL)continue;
            zval side, args[2], components, keyarg[1], match_key; ZVAL_STRING(&side,"right"); ZVAL_COPY(&args[0],model); ZVAL_COPY(&args[1],&side);
            bool ok=read_model_call(ZEND_THIS,"matchValues",&components,2,args);zval_ptr_dtor(&side);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);if(!ok){zval_ptr_dtor(&entries);zval_ptr_dtor(&predicate);zval_ptr_dtor(&rights);zval_ptr_dtor(&clone);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}
            if(Z_TYPE(components)==IS_NULL){zval_ptr_dtor(&components);continue;}ZVAL_COPY(&keyarg[0],&components);ok=read_model_static_call(ZEND_THIS,"matchKey",&match_key,1,keyarg);zval_ptr_dtor(&keyarg[0]);zval_ptr_dtor(&components);if(!ok){zval_ptr_dtor(&entries);zval_ptr_dtor(&predicate);zval_ptr_dtor(&rights);zval_ptr_dtor(&clone);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}
            zval *bucket=zend_hash_find(Z_ARRVAL(by_key),Z_STR(match_key)); if(max>0&&bucket!=NULL&&zend_hash_num_elements(Z_ARRVAL_P(bucket))>=(zend_ulong)max){zval_ptr_dtor(&match_key);continue;}
            if(bucket==NULL){zval empty;array_init(&empty);bucket=zend_hash_update(Z_ARRVAL(by_key),Z_STR(match_key),&empty);}else SEPARATE_ARRAY(bucket);
            zval pair;array_init_size(&pair,2);zval c;ZVAL_COPY(&c,key);add_next_index_zval(&pair,&c);ZVAL_COPY(&c,model);add_next_index_zval(&pair,&c);add_next_index_zval(bucket,&pair);zval_ptr_dtor(&match_key);
        } ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&entries);zval_ptr_dtor(&predicate);zval_ptr_dtor(&rights);zval_ptr_dtor(&clone);
    }
    zval result_name_arg, result_name; ZVAL_BOOL(&result_name_arg,many);
    if(!read_model_call(ZEND_THIS,"resultName",&result_name,1,&result_name_arg)){zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(parents), zval *parent) {
        zval *row=model_state_property(model_state_of(Z_OBJ_P(parent)),"row");
        if(row!=NULL&&Z_TYPE_P(row)==IS_ARRAY)SEPARATE_ARRAY(row);
        zval *related=row!=NULL&&Z_TYPE_P(row)==IS_ARRAY?read_array(row,"related"):NULL;
        if(related!=NULL&&Z_TYPE_P(related)==IS_ARRAY&&zend_hash_exists(Z_ARRVAL_P(related),Z_STR(result_name))){zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);read_throw("CONFIG","relation result name is used twice");RETURN_THROWS();}
        zval side,args[2],components,keyarg[1],key;ZVAL_STRING(&side,"left");ZVAL_COPY(&args[0],parent);ZVAL_COPY(&args[1],&side);
        if(!read_model_call(ZEND_THIS,"matchValues",&components,2,args)){zval_ptr_dtor(&side);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}zval_ptr_dtor(&side);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);
        zval *matched=NULL;if(Z_TYPE(components)!=IS_NULL){ZVAL_COPY(&keyarg[0],&components);if(!read_model_static_call(ZEND_THIS,"matchKey",&key,1,keyarg)){zval_ptr_dtor(&keyarg[0]);zval_ptr_dtor(&components);zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}zval_ptr_dtor(&keyarg[0]);matched=zend_hash_find(Z_ARRVAL(by_key),Z_STR(key));zval_ptr_dtor(&key);}zval_ptr_dtor(&components);
        if(possible!=NULL&&Z_TYPE_P(possible)==IS_ARRAY){zval *col=read_array(possible,"column"),*expected=read_array(possible,"value");if(col!=NULL&&expected!=NULL){zval arg,actual;ZVAL_COPY(&arg,col);if(!read_model_call(parent,"columnOrExtra",&actual,1,&arg)){zval_ptr_dtor(&arg);zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}zval_ptr_dtor(&arg);bool same;if(!read_same_scalar(&actual,expected,&same)){zval_ptr_dtor(&actual);zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}zval_ptr_dtor(&actual);if(!same)matched=NULL;}}
        zval relation_value;ZVAL_NULL(&relation_value);
        if(many){object_init_ex(&relation_value,read_lookup_class("Polyspec\\Orm\\Collection"));if(EG(exception)!=NULL){zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}
            if(matched!=NULL&&Z_TYPE_P(matched)==IS_ARRAY)ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(matched),zval *pair){zval *k=zend_hash_index_find(Z_ARRVAL_P(pair),0),*m=zend_hash_index_find(Z_ARRVAL_P(pair),1);if(k==NULL||m==NULL)continue;zval put[2],rv;ZVAL_COPY(&put[0],k);ZVAL_COPY(&put[1],m);bool ok=read_call(&relation_value,"put",&rv,2,put);zval_ptr_dtor(&put[0]);zval_ptr_dtor(&put[1]);if(!ok){zval_ptr_dtor(&relation_value);zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);RETURN_THROWS();}zval_ptr_dtor(&rv);}ZEND_HASH_FOREACH_END();
        }else if(matched!=NULL&&Z_TYPE_P(matched)==IS_ARRAY){zval *first=zend_hash_index_find(Z_ARRVAL_P(matched),0),*m=first!=NULL?zend_hash_index_find(Z_ARRVAL_P(first),1):NULL;if(m!=NULL)ZVAL_COPY(&relation_value,m);}
        if(related!=NULL&&Z_TYPE_P(related)==IS_ARRAY){SEPARATE_ARRAY(related);zend_hash_update(Z_ARRVAL_P(related),Z_STR(result_name),&relation_value);}else zval_ptr_dtor(&relation_value);
        if(!many&&model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"parent_node")!=NULL&&zend_is_true(model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"parent_node"))){zval *flat=read_array(row,"flat");if(flat!=NULL&&Z_TYPE_P(flat)==IS_ARRAY){SEPARATE_ARRAY(flat);zval c;ZVAL_COPY(&c,&result_name);add_next_index_zval(flat,&c);}}
        zval *cascade=read_array(row,"cascade");if(cascade!=NULL&&Z_TYPE_P(cascade)==IS_ARRAY){SEPARATE_ARRAY(cascade);zval *lock=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"delete_lock");zval flag;ZVAL_BOOL(&flag,lock==NULL||!zend_is_true(lock));zend_hash_update(Z_ARRVAL_P(cascade),Z_STR(result_name),&flag);}
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&result_name);zval_ptr_dtor(&values);zval_ptr_dtor(&seen);zval_ptr_dtor(&by_key);
}

ZEND_METHOD(Polyspec_Orm_Model, assemble)
{
    zval *db,*request,*plan,*result;
    ZEND_PARSE_PARAMETERS_START(4,4) Z_PARAM_OBJECT(db) Z_PARAM_OBJECT(request) Z_PARAM_ARRAY(plan) Z_PARAM_ARRAY(result) ZEND_PARSE_PARAMETERS_END();
    zval *external=read_object_prop(request,"external");bool track=external!=NULL&&Z_TYPE_P(external)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(external))>0;
    object_init_ex(return_value,read_lookup_class("Polyspec\\Orm\\Assembly"));if(EG(exception)!=NULL)RETURN_THROWS();
    zval args[4],ctor;ZVAL_COPY(&args[0],db);zval *conn=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"conn");if(conn!=NULL)ZVAL_COPY(&args[1],conn);else ZVAL_NULL(&args[1]);ZVAL_COPY(&args[2],result);ZVAL_BOOL(&args[3],track);
    bool constructed=read_call(return_value,"__construct",&ctor,4,args);
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    if (!Z_ISUNDEF(ctor)) zval_ptr_dtor(&ctor);
    if (!constructed) RETURN_THROWS();
    zval *steps=read_array(plan,"steps"),*first=steps!=NULL&&Z_TYPE_P(steps)==IS_ARRAY?zend_hash_index_find(Z_ARRVAL_P(steps),0):NULL,*step_asm=first!=NULL?read_array(first,"assemble"):NULL;
    if(step_asm==NULL){zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);read_throw("INTERNAL","plan has no root assemble node");RETURN_THROWS();}
    zend_class_entry *collection_ce=read_lookup_class("Polyspec\\Orm\\Collection");zval items;object_init_ex(&items,collection_ce);if(EG(exception)!=NULL){zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}
    zval *fetch_key=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"fetch_key"),*key_name=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"key_name");
    bool auto_index=(fetch_key==NULL||Z_TYPE_P(fetch_key)==IS_NULL)&&(key_name==NULL||Z_TYPE_P(key_name)!=IS_STRING||Z_STRLEN_P(key_name)==0);zval index;ZVAL_NULL(&index);
    if(auto_index){zval arg;ZVAL_COPY(&arg,step_asm);if(!read_model_call(ZEND_THIS,"rowShape",&index,1,&arg)){zval_ptr_dtor(&arg);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}zval_ptr_dtor(&arg);zval *key=read_array(&index,"key");if(key!=NULL){zval copy;ZVAL_COPY(&copy,key);zval_ptr_dtor(&index);ZVAL_COPY_VALUE(&index,&copy);}else ZVAL_NULL(&index);}
    zval *main=read_array(result,"main");if(main!=NULL&&Z_TYPE_P(main)==IS_ARRAY)ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(main),zval *rowvals){zval a[3],model;ZVAL_COPY(&a[0],return_value);ZVAL_COPY(&a[1],step_asm);ZVAL_COPY(&a[2],rowvals);if(!read_model_call(ZEND_THIS,"assembleRow",&model,3,a)){for(int i=0;i<3;i++)zval_ptr_dtor(&a[i]);zval_ptr_dtor(&index);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}for(int i=0;i<3;i++)zval_ptr_dtor(&a[i]);zval key;
        if(Z_TYPE(index)!=IS_NULL){zval *raw=zend_hash_index_find(Z_ARRVAL_P(rowvals),(zend_ulong)zval_get_long(&index));if(raw==NULL){zval_ptr_dtor(&model);zval_ptr_dtor(&index);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);read_throw("INTERNAL","root key column is missing");RETURN_THROWS();}if(Z_TYPE_P(raw)==IS_LONG||Z_TYPE_P(raw)==IS_STRING)ZVAL_COPY(&key,raw);else{zval args[1];ZVAL_COPY(&args[0],raw);if(!read_static_call(collection_ce,"keyOf",&key,1,args)){zval_ptr_dtor(&args[0]);zval_ptr_dtor(&model);zval_ptr_dtor(&index);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}zval_ptr_dtor(&args[0]);}}
        else{zval ka[3];ZVAL_COPY(&ka[0],&model);ZVAL_COPY(&ka[1],step_asm);ZVAL_COPY(&ka[2],rowvals);if(!read_model_call(ZEND_THIS,"collectionKey",&key,3,ka)){for(int i=0;i<3;i++)zval_ptr_dtor(&ka[i]);zval_ptr_dtor(&model);zval_ptr_dtor(&index);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}for(int i=0;i<3;i++)zval_ptr_dtor(&ka[i]);}
        zval put[2],rv;ZVAL_COPY(&put[0],&key);ZVAL_COPY(&put[1],&model);bool ok=read_call(&items,"put",&rv,2,put);zval_ptr_dtor(&put[0]);zval_ptr_dtor(&put[1]);zval_ptr_dtor(&key);zval_ptr_dtor(&model);if(!ok){zval_ptr_dtor(&index);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}zval_ptr_dtor(&rv);
    }ZEND_HASH_FOREACH_END();zval_ptr_dtor(&index);
    if(track&&external!=NULL){ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(external),zend_ulong id,zend_string *strid,zval *relations){zend_ulong object_id=id;(void)strid;zval *made=read_object_prop(return_value,"made"),*parents=made!=NULL&&Z_TYPE_P(made)==IS_ARRAY?zend_hash_index_find(Z_ARRVAL_P(made),object_id):NULL;if(parents==NULL||zend_hash_num_elements(Z_ARRVAL_P(parents))==0)continue;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(relations),zval *rel){zval *child=read_array(rel,"child"),*many=read_array(rel,"many");if(child==NULL||many==NULL)continue;zval args[2],rv;ZVAL_COPY(&args[0],parents);ZVAL_COPY(&args[1],many);bool ok=read_model_call(child,"attachExternal",&rv,2,args);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);if(!ok){zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}}ZEND_HASH_FOREACH_END();}ZEND_HASH_FOREACH_END();}
    zval *fetch_value=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"fetch_value");if(fetch_value!=NULL&&Z_TYPE_P(fetch_value)==IS_OBJECT){zval arg,rv;ZVAL_COPY(&arg,fetch_value);if(!read_call(&items,"fetchValues",&rv,1,&arg)){zval_ptr_dtor(&arg);zval_ptr_dtor(&items);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}zval_ptr_dtor(&arg);if(!Z_ISUNDEF(rv))zval_ptr_dtor(&rv);}
    zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);ZVAL_COPY_VALUE(return_value,&items);
}

ZEND_METHOD(Polyspec_Orm_Model, load)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *kind;ZEND_PARSE_PARAMETERS_START(1,1)Z_PARAM_STR(kind)ZEND_PARSE_PARAMETERS_END();
    zval executor;if(!read_model_call(ZEND_THIS,"executor",&executor,0,NULL))RETURN_THROWS();
    zval *dbp=zend_hash_index_find(Z_ARRVAL(executor),0),*framep=zend_hash_index_find(Z_ARRVAL(executor),1);if(dbp==NULL||framep==NULL){zval_ptr_dtor(&executor);read_throw("INTERNAL","executor result is incomplete");RETURN_THROWS();}
    zval db,frame,args[2],request;ZVAL_COPY(&db,dbp);ZVAL_COPY(&frame,framep);ZVAL_STR_COPY(&args[0],kind);ZVAL_COPY(&args[1],&db);
    if(!read_model_call(ZEND_THIS,"build",&request,2,args)){zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);RETURN_THROWS();}zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);
    zval select_args[2],selected;ZVAL_COPY(&select_args[0],&frame);ZVAL_COPY(&select_args[1],&request);bool ok=read_call(&db,"select",&selected,2,select_args);zval_ptr_dtor(&select_args[0]);zval_ptr_dtor(&select_args[1]);zval_ptr_dtor(&executor);zval_ptr_dtor(&frame);
    if(!ok){zval_ptr_dtor(&request);zval_ptr_dtor(&db);RETURN_THROWS();}
    zval *plan=zend_hash_index_find(Z_ARRVAL(selected),0),*result=zend_hash_index_find(Z_ARRVAL(selected),1);if(plan==NULL||result==NULL){zval_ptr_dtor(&selected);zval_ptr_dtor(&request);zval_ptr_dtor(&db);read_throw("INTERNAL","select result is incomplete");RETURN_THROWS();}
    zval assemble_args[4];ZVAL_COPY(&assemble_args[0],&db);ZVAL_COPY(&assemble_args[1],&request);ZVAL_COPY(&assemble_args[2],plan);ZVAL_COPY(&assemble_args[3],result);ok=read_model_call(ZEND_THIS,"assemble",return_value,4,assemble_args);for(int i=0;i<4;i++)zval_ptr_dtor(&assemble_args[i]);zval_ptr_dtor(&selected);zval_ptr_dtor(&request);zval_ptr_dtor(&db);if(!ok)RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, groupValue)
{
    zval *db, *column, *raw;
    ZEND_PARSE_PARAMETERS_START(3,3) Z_PARAM_OBJECT(db) Z_PARAM_ARRAY(column) Z_PARAM_ZVAL(raw) ZEND_PARSE_PARAMETERS_END();
    zval *name=read_array(column,"name");if(name==NULL||Z_TYPE_P(name)!=IS_STRING){read_throw("INTERNAL","group column has no name");RETURN_THROWS();}
    zval *source_col=read_array(column,"column");
    if (zend_string_equals_literal(Z_STR_P(name), "row_count") &&
        (source_col == NULL || Z_TYPE_P(source_col) != IS_STRING || Z_STRLEN_P(source_col) == 0)) {
        ZVAL_COPY(return_value, raw);
        return;
    }
    zval meta; if(!read_static_meta(ZEND_THIS,&meta))RETURN_THROWS();
    zval *declared=NULL,*declared_cols=read_array(&meta,"columns");
    if(read_string_is(source_col,Z_STRVAL_P(name))&&declared_cols!=NULL&&Z_TYPE_P(declared_cols)==IS_ARRAY)declared=zend_hash_find(Z_ARRVAL_P(declared_cols),Z_STR_P(name));
    if(Z_TYPE_P(raw)==IS_NULL){if(declared!=NULL&&!read_is_true(declared,"nullable")){zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"group column %s is SQL NULL",Z_STRVAL_P(name));read_throw("CODEC_DECODE",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval_ptr_dtor(&meta);RETURN_NULL();}
    if(declared!=NULL){zval styled_arg[1],styled;ZVAL_COPY(&styled_arg[0],declared);bool ok=read_static_call(polyspec_runtime_model_ce,"styled",&styled,1,styled_arg);zval_ptr_dtor(&styled_arg[0]);if(!ok){zval_ptr_dtor(&meta);RETURN_THROWS();}bool is_styled=zend_is_true(&styled);zval_ptr_dtor(&styled);if(is_styled){if(Z_TYPE_P(raw)!=IS_OBJECT||!instanceof_function(Z_OBJCE_P(raw),polyspec_styled_value_ce)){zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"group column %s is not StyledValue",Z_STRVAL_P(name));read_throw("CODEC_DECODE",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval_ptr_dtor(&meta);RETURN_COPY(raw);}}
    zval *type=declared!=NULL?read_array(declared,"type"):read_array(column,"type");if(type==NULL||Z_TYPE_P(type)!=IS_STRING){zval_ptr_dtor(&meta);read_throw("INTERNAL","group column has no type");RETURN_THROWS();}
    if(read_string_is(type,"decimal")&&declared==NULL){zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"decimal group column %s has no declaration",Z_STRVAL_P(name));read_throw("INTERNAL",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}
    zval *entity=read_array(&meta,"entity");if(entity==NULL||Z_TYPE_P(entity)!=IS_STRING){zval_ptr_dtor(&meta);read_throw("INTERNAL","the model metadata names no entity");RETURN_THROWS();}
    zval driver,zone;if(!read_call(db,"dialect",&driver,0,NULL)){zval_ptr_dtor(&meta);RETURN_THROWS();}bool sqlite=Z_TYPE(driver)==IS_STRING&&zend_string_equals_literal(Z_STR(driver),"sqlite");zval_ptr_dtor(&driver);
    if(!read_call(db,"zone",&zone,0,NULL)){zval_ptr_dtor(&meta);RETURN_THROWS();}
    /* A group column is refused as a model column is, by its entity and name (COD-1), and reads an integer from its exact
     * digits on every database; a datetime of an expression has the precision 6. */
    zval fallback,cell;bool use_fallback=declared==NULL;
    if(use_fallback){zval type_copy,precision;array_init(&fallback);ZVAL_COPY(&type_copy,type);ZVAL_LONG(&precision,6);zend_hash_str_update(Z_ARRVAL(fallback),"type",sizeof("type")-1,&type_copy);zend_hash_str_update(Z_ARRVAL(fallback),"precision",sizeof("precision")-1,&precision);}
    bool ok=cell_value(Z_STR_P(entity),Z_STR_P(name),use_fallback?&fallback:declared,raw,sqlite,true,&zone,&cell);
    if(use_fallback)zval_ptr_dtor(&fallback);
    if(ok&&Z_TYPE(cell)==IS_OBJECT&&Z_OBJCE(cell)==polyspec_pending_time_ce){zval *text=zend_read_property(polyspec_pending_time_ce,Z_OBJ(cell),ZEND_STRL("text"),1,NULL);ok=text!=NULL&&model_time_value_in_zone(text,&zone,Z_STRVAL_P(type),return_value);zval_ptr_dtor(&cell);}
    else if(ok)ZVAL_COPY_VALUE(return_value,&cell);
    zval_ptr_dtor(&zone);
    if(!ok){zval_ptr_dtor(&meta);RETURN_THROWS();}
    /* A bytes column without a codec stage holds its bytes as a Bytes, as in the array form of a model (COD-27). */
    zval *stages = declared != NULL ? read_array(declared, "codec") : NULL;
    bool no_stage = stages == NULL || Z_TYPE_P(stages) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(stages)) == 0;
    zval_ptr_dtor(&meta);
    if (read_string_is(type, "bytes") && no_stage && !model_output_bytes(return_value)) RETURN_THROWS();
}

/* The GroupRows of the main step of a group_count or a group_lookahead_paginate result: the selected values of each row
 * by the column declarations of the plan, and its checked row_count (INT-68). db, plan and result are borrowed. */
static bool group_rows_of(zval *self, zval *db, zval *plan, zval *result, zval *out)
{
    zval *steps = plan != NULL ? read_array(plan, "steps") : NULL;
    zval *step = steps != NULL && Z_TYPE_P(steps) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(steps), 0) : NULL;
    zval *assembly = step != NULL ? read_array(step, "assemble") : NULL;
    zval *columns = assembly != NULL ? read_array(assembly, "columns") : NULL;
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) return read_throw("INTERNAL", "group count has no result declaration");
    zval names;
    array_init(&names);
    bool has_count = false;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), zval *column) {
        if (read_is_true(column, "hidden")) continue;
        zval *name = read_array(column, "name");
        if (name == NULL || Z_TYPE_P(name) != IS_STRING || Z_STRLEN_P(name) == 0 || zend_hash_exists(Z_ARRVAL(names), Z_STR_P(name))) {
            zval_ptr_dtor(&names);
            zend_string *message = strpprintf(0, "group result repeats or omits column %s", name != NULL && Z_TYPE_P(name) == IS_STRING ? Z_STRVAL_P(name) : "");
            read_throw("CONFIG", ZSTR_VAL(message));
            zend_string_release(message);
            return false;
        }
        zval flag;
        ZVAL_TRUE(&flag);
        zend_hash_update(Z_ARRVAL(names), Z_STR_P(name), &flag);
        if (zend_string_equals_literal(Z_STR_P(name), "row_count")) has_count = true;
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&names);
    if (!has_count) return read_throw("INTERNAL", "group result has no row_count");
    zval rows;
    array_init(&rows);
    zval *main = read_array(result, "main");
    if (main != NULL && Z_TYPE_P(main) == IS_ARRAY) ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(main), zval *raw_row) {
        zval entries;
        array_init(&entries);
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), zval *column) {
            if (read_is_true(column, "hidden")) continue;
            zval *idx = read_array(column, "index"), *name = read_array(column, "name");
            if (idx == NULL || Z_TYPE_P(idx) != IS_LONG || name == NULL) {
                zval_ptr_dtor(&entries);
                zval_ptr_dtor(&rows);
                return read_throw("INTERNAL", "group result column declaration is incomplete");
            }
            zval *raw = zend_hash_index_find(Z_ARRVAL_P(raw_row), (zend_ulong)Z_LVAL_P(idx));
            if (raw == NULL) {
                zval_ptr_dtor(&entries);
                zval_ptr_dtor(&rows);
                zend_string *message = strpprintf(0, "group result column %s is missing", Z_STRVAL_P(name));
                read_throw("INTERNAL", ZSTR_VAL(message));
                zend_string_release(message);
                return false;
            }
            zval args[3], value;
            ZVAL_COPY(&args[0], db);
            ZVAL_COPY(&args[1], column);
            ZVAL_COPY(&args[2], raw);
            bool ok = read_model_call(self, "groupValue", &value, 3, args);
            for (int k = 0; k < 3; k++) zval_ptr_dtor(&args[k]);
            if (!ok) {
                zval_ptr_dtor(&entries);
                zval_ptr_dtor(&rows);
                return false;
            }
            zval pair;
            array_init_size(&pair, 2);
            zval c;
            ZVAL_COPY(&c, name);
            add_next_index_zval(&pair, &c);
            add_next_index_zval(&pair, &value);
            add_next_index_zval(&entries, &pair);
        } ZEND_HASH_FOREACH_END();
        zval group_row, ctor;
        object_init_ex(&group_row, polyspec_group_row_ce);
        zend_call_method(Z_OBJ(group_row), polyspec_group_row_ce, NULL, "__construct", sizeof("__construct") - 1, &ctor, 1, &entries, NULL);
        zval_ptr_dtor(&entries);
        if (!Z_ISUNDEF(ctor)) zval_ptr_dtor(&ctor);
        if (EG(exception) != NULL) {
            zval_ptr_dtor(&rows);
            zval_ptr_dtor(&group_row);
            return false;
        }
        add_next_index_zval(&rows, &group_row);
    } ZEND_HASH_FOREACH_END();
    zval ctor;
    object_init_ex(out, polyspec_group_rows_ce);
    zend_call_method(Z_OBJ_P(out), polyspec_group_rows_ce, NULL, "__construct", sizeof("__construct") - 1, &ctor, 1, &rows, NULL);
    zval_ptr_dtor(&rows);
    if (!Z_ISUNDEF(ctor)) zval_ptr_dtor(&ctor);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Model, getsCount)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval executor;if(!read_model_call(ZEND_THIS,"executor",&executor,0,NULL))RETURN_THROWS();zval *dbp=zend_hash_index_find(Z_ARRVAL(executor),0),*framep=zend_hash_index_find(Z_ARRVAL(executor),1);if(dbp==NULL||framep==NULL){zval_ptr_dtor(&executor);read_throw("INTERNAL","executor result is incomplete");RETURN_THROWS();}zval db,frame;ZVAL_COPY(&db,dbp);ZVAL_COPY(&frame,framep);
    zval kind,args[2],request;ZVAL_STRING(&kind,"group_count");ZVAL_COPY(&args[0],&kind);ZVAL_COPY(&args[1],&db);if(!read_model_call(ZEND_THIS,"build",&request,2,args)){zval_ptr_dtor(&kind);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);RETURN_THROWS();}zval_ptr_dtor(&kind);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);
    zval *external=read_object_prop(&request,"external");if(external!=NULL&&Z_TYPE_P(external)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(external))!=0){zval_ptr_dtor(&request);zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);read_throw("CONFIG","group count cannot return relations");RETURN_THROWS();}
    zval select_args[2],selected;ZVAL_COPY(&select_args[0],&frame);ZVAL_COPY(&select_args[1],&request);bool ok=read_call(&db,"select",&selected,2,select_args);zval_ptr_dtor(&select_args[0]);zval_ptr_dtor(&select_args[1]);zval_ptr_dtor(&request);zval_ptr_dtor(&executor);zval_ptr_dtor(&frame);if(!ok){zval_ptr_dtor(&db);RETURN_THROWS();}
    ok = group_rows_of(ZEND_THIS, &db, zend_hash_index_find(Z_ARRVAL(selected), 0), zend_hash_index_find(Z_ARRVAL(selected), 1), return_value);
    zval_ptr_dtor(&selected);
    zval_ptr_dtor(&db);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, aggregate)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *fn;ZEND_PARSE_PARAMETERS_START(1,1)Z_PARAM_STR(fn)ZEND_PARSE_PARAMETERS_END();
    if(!read_aggregate(ZEND_THIS,ZSTR_VAL(fn),return_value))RETURN_THROWS();
}

/* Accepts only the canonical decimal integer spelling and checks it against zend_long without overflow. */
static bool exact_integer(zval *raw, zend_long *out)
{
    if (Z_TYPE_P(raw) == IS_LONG) {
        *out = Z_LVAL_P(raw);
        return true;
    }
    if (Z_TYPE_P(raw) != IS_STRING) return false;
    zend_string *s = Z_STR_P(raw);
    size_t n = ZSTR_LEN(s), i = 0;
    const char *p = ZSTR_VAL(s);
    bool negative = false;
    if (n == 0) return false;
    if (p[0] == '-') { negative = true; i++; }
    if (i == n) return false;
    if (p[i] == '0' && i + 1 != n) return false;
    for (size_t k = i; k < n; k++) if (p[k] < '0' || p[k] > '9') return false;
    zend_ulong magnitude = 0;
    zend_ulong limit = negative ? ((zend_ulong)ZEND_LONG_MAX + 1u) : (zend_ulong)ZEND_LONG_MAX;
    for (size_t k = i; k < n; k++) {
        zend_ulong digit = (zend_ulong)(p[k] - '0');
        if (magnitude > (limit - digit) / 10u) return false;
        magnitude = magnitude * 10u + digit;
    }
    if (negative) {
        *out = magnitude == (zend_ulong)ZEND_LONG_MAX + 1u ? ZEND_LONG_MIN : -(zend_long)magnitude;
    } else {
        *out = (zend_long)magnitude;
    }
    return true;
}

/* The text of every refused sum or average scalar in every client (DSL-66). */
#define AGGREGATE_REFUSED "aggregate scalar is not a finite number"

/* The decimal places that the average of an exact column keeps beyond the scale of the column (DSL-161). */
#define AVG_SCALE_EXTRA 16

/* Accepts the same finite decimal/exponent grammar as Model::aggregateNumber. */
static int exact_number(zval *raw, double *out)
{
    if (Z_TYPE_P(raw) == IS_LONG) {
        *out = (double)Z_LVAL_P(raw);
        return isfinite(*out) ? 1 : 2;
    }
    if (Z_TYPE_P(raw) == IS_DOUBLE) {
        *out = Z_DVAL_P(raw);
        return isfinite(*out) ? 1 : 2;
    }
    if (Z_TYPE_P(raw) != IS_STRING) return 0;
    const char *s = Z_STRVAL_P(raw);
    size_t n = Z_STRLEN_P(raw), i = 0;
    if (i < n && s[i] == '-') i++;
    if (i == n) return 0;
    if (s[i] == '0') i++;
    else if (s[i] >= '1' && s[i] <= '9') { do { i++; } while (i < n && s[i] >= '0' && s[i] <= '9'); }
    else return 0;
    if (i < n && s[i] == '.') {
        i++;
        size_t begin = i;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
        if (i == begin) return 0;
    }
    if (i < n && (s[i] == 'e' || s[i] == 'E')) {
        i++;
        if (i < n && (s[i] == '+' || s[i] == '-')) i++;
        size_t begin = i;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
        if (i == begin) return 0;
    }
    if (i != n) return 0;
    zend_string *copy = zend_string_init(s, n, 0);
    *out = zend_strtod(ZSTR_VAL(copy), NULL);
    zend_string_release(copy);
    return isfinite(*out) ? 1 : 2;
}

/* COD-1: the message of a cell that its column type refuses, one text per type that names no value and no host type. */
static zend_string *cell_message(const char *type)
{
    if (!strcmp(type, "i16") || !strcmp(type, "i32") || !strcmp(type, "i64")) {
        return strpprintf(0, "%s cell is not an exact integer in its range", type);
    }
    if (!strcmp(type, "f64")) return zend_string_init(ZEND_STRL("f64 cell is not a finite number"), 0);
    if (!strcmp(type, "bool")) return zend_string_init(ZEND_STRL("bool cell is not boolean"), 0);
    if (!strcmp(type, "decimal")) return zend_string_init(ZEND_STRL("decimal cell is not a decimal of its precision and scale"), 0);
    if (!strcmp(type, "date") || !strcmp(type, "datetime") || !strcmp(type, "time")) {
        return strpprintf(0, "%s cell is not a %s", type, type);
    }
    if (!strcmp(type, "bytes")) return zend_string_init(ZEND_STRL("bytes cell is not bytes"), 0);
    return strpprintf(0, "%s cell is not text", type);
}

/* The CODEC_DECODE of a read cell, <entity>.<column>: <message> (COD-1, COD-41), made with previous as its previous, which it
 * takes over; false when it cannot be made. */
static bool cell_refusal(zend_string *entity, zend_string *name, zend_string *message, zend_object *previous, zval *out)
{
    zend_string *text = strpprintf(0, "%s.%s: %s", ZSTR_VAL(entity), ZSTR_VAL(name), ZSTR_VAL(message));
    bool ok = orm_exception_object(NULL, "CODEC_DECODE", text, out);
    zend_string_release(text);
    if (!ok) {
        if (previous != NULL) OBJ_RELEASE(previous);
        return false;
    }
    if (previous != NULL) zend_exception_set_previous(Z_OBJ_P(out), previous);
    return true;
}

/* Throws the refusal of a read cell of a column type; it returns false. */
static bool cell_refuse(zend_string *entity, zend_string *name, const char *type, zend_object *previous)
{
    zend_string *message = cell_message(type);
    zval exception;
    if (cell_refusal(entity, name, message, previous, &exception)) zend_throw_exception_object(&exception);
    zend_string_release(message);
    return false;
}

static bool cell_digits(const char *s, size_t n)
{
    for (size_t i = 0; i < n; i++) if (s[i] < '0' || s[i] > '9') return false;
    return true;
}

static int cell_number(const char *s, size_t n)
{
    int v = 0;
    for (size_t i = 0; i < n; i++) v = v * 10 + (s[i] - '0');
    return v;
}

/* Whether a year, a month and a day name a day of the proleptic Gregorian calendar, the year 0000 included. */
static bool cell_valid_date(int year, int month, int day)
{
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12 || day < 1) return false;
    bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    return day <= (month == 2 && leap ? 29 : days[month - 1]);
}

/* A date YYYY-MM-DD of a real day at s. */
static bool cell_date_at(const char *s)
{
    return cell_digits(s, 4) && s[4] == '-' && cell_digits(s + 5, 2) && s[7] == '-' && cell_digits(s + 8, 2)
        && cell_valid_date(cell_number(s, 4), cell_number(s + 5, 2), cell_number(s + 8, 2));
}

/* A time HH:MM:SS of a real time of day at s. */
static bool cell_clock_at(const char *s)
{
    return cell_digits(s, 2) && s[2] == ':' && cell_digits(s + 3, 2) && s[5] == ':' && cell_digits(s + 6, 2)
        && cell_number(s, 2) <= 23 && cell_number(s + 3, 2) <= 59 && cell_number(s + 6, 2) <= 59;
}

/* Reads an optional fraction of one to nine digits at s[*i]; false when the dot has no digit or more than nine follow. */
static bool cell_fraction_at(const char *s, size_t n, size_t *i, const char **digits, size_t *count)
{
    *digits = s + *i;
    *count = 0;
    if (*i >= n || s[*i] != '.') return true;
    size_t begin = ++*i;
    while (*i < n && s[*i] >= '0' && s[*i] <= '9') (*i)++;
    *digits = s + begin;
    *count = *i - begin;
    return *count >= 1 && *count <= 9;
}

/* Appends the fraction of a time text at its precision, as Model::fractionDigits; false when a digit beyond the precision is
 * not zero. */
static bool cell_fraction(const char *digits, size_t count, zend_long precision, smart_str *out)
{
    for (size_t i = (size_t)precision; i < count; i++) if (digits[i] != '0') return false;
    if (precision == 0) return true;
    smart_str_appendc(out, '.');
    for (zend_long i = 0; i < precision; i++) smart_str_appendc(out, (size_t)i < count ? digits[i] : '0');
    return true;
}

/* The canonical text of a date, a time or a datetime cell, or NULL when the text is none, as Model::timeText: a date
 * YYYY-MM-DD of a real day; a time HH:MM:SS with a fraction of up to nine digits, none beyond the precision but zeros; a
 * datetime YYYY-MM-DD HH:MM:SS (or with T) of a real instant with such a fraction and an optional Z or offset, written with six
 * fraction digits and its offset. */
static zend_string *cell_time_text(const char *type, const char *s, size_t n, zend_long precision)
{
    smart_str out = {0};
    const char *digits;
    size_t count, i;
    if (!strcmp(type, "date")) {
        return n == 10 && cell_date_at(s) ? zend_string_init(s, n, 0) : NULL;
    }
    if (!strcmp(type, "time")) {
        i = 8;
        if (n < 8 || !cell_clock_at(s) || !cell_fraction_at(s, n, &i, &digits, &count) || i != n) return NULL;
        smart_str_appendl(&out, s, 8);
        if (!cell_fraction(digits, count, precision, &out)) { smart_str_free(&out); return NULL; }
        return smart_str_extract(&out);
    }
    i = 19;
    if (n < 19 || !cell_date_at(s) || (s[10] != ' ' && s[10] != 'T') || !cell_clock_at(s + 11)
        || !cell_fraction_at(s, n, &i, &digits, &count)) {
        return NULL;
    }
    while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\v' || s[i] == '\f' || s[i] == '\r')) i++;
    const char *offset = s + i;
    size_t offset_length = 0;
    if (i < n && s[i] == 'Z') {
        i++;
        offset = "+00:00";
        offset_length = 6;
    } else if (i < n && (s[i] == '+' || s[i] == '-')) {
        if (i + 3 > n || !cell_digits(s + i + 1, 2)) return NULL;
        size_t end = i + 3;
        if (end < n && s[end] == ':') {
            if (end + 3 > n || !cell_digits(s + end + 1, 2)) return NULL;
            end += 3;
        } else if (end + 2 <= n && cell_digits(s + end, 2)) {
            end += 2;
        }
        offset_length = end - i;
        i = end;
    }
    if (i != n) return NULL;
    smart_str scratch = {0};
    bool fraction_ok = cell_fraction(digits, count, precision, &scratch);
    smart_str_free(&scratch);
    if (!fraction_ok) return NULL;
    smart_str_appendl(&out, s, 10);
    smart_str_appendc(&out, ' ');
    smart_str_appendl(&out, s + 11, 8);
    smart_str_appendc(&out, '.');
    for (size_t k = 0; k < 6; k++) smart_str_appendc(&out, k < count ? digits[k] : '0');
    smart_str_appendl(&out, offset, offset_length);
    return smart_str_extract(&out);
}

/* The value of a read cell of a column type, as Model::cellValue of the PHP library (COD-1): out is the value, or the
 * refusal is thrown. */
static bool cell_value(zend_string *entity, zend_string *name, zval *col, zval *raw, bool sqlite, bool integer_text, zval *zone,
    zval *out)
{
    zval *type_value = read_array(col, "type");
    if (type_value == NULL || Z_TYPE_P(type_value) != IS_STRING) return read_throw("INTERNAL", "cell column has no type");
    const char *type = Z_STRVAL_P(type_value);
    zval v;
    ZVAL_COPY_DEREF(&v, raw);
    if (Z_TYPE(v) == IS_RESOURCE) {
        if (!read_convert_resource(&v)) { zval_ptr_dtor(&v); return false; }
        if (Z_TYPE(v) != IS_STRING) { zval_ptr_dtor(&v); return cell_refuse(entity, name, type, NULL); }
    }
    if (!strcmp(type, "i16") || !strcmp(type, "i32") || !strcmp(type, "i64")) {
        zend_long n = 0, low = ZEND_LONG_MIN, high = ZEND_LONG_MAX;
        if (!strcmp(type, "i16")) { low = INT16_MIN; high = INT16_MAX; }
        if (!strcmp(type, "i32")) { low = INT32_MIN; high = INT32_MAX; }
        bool have = false;
        if (Z_TYPE(v) == IS_LONG) {
            n = Z_LVAL(v);
            have = true;
        } else if (Z_TYPE(v) == IS_DOUBLE) {
            double d = Z_DVAL(v);
            if (zend_finite(d) && floor(d) == d && d >= -9.2233720368547758E18 && d < 9.2233720368547758E18) {
                n = (zend_long)d;
                have = true;
            }
        } else if (Z_TYPE(v) == IS_STRING && integer_text) {
            have = exact_integer(&v, &n);
        }
        zval_ptr_dtor(&v);
        if (!have || n < low || n > high) return cell_refuse(entity, name, type, NULL);
        ZVAL_LONG(out, n);
        return true;
    }
    if (!strcmp(type, "f64")) {
        double d;
        int status = exact_number(&v, &d);
        zval_ptr_dtor(&v);
        if (status != 1) return cell_refuse(entity, name, type, NULL);
        ZVAL_DOUBLE(out, d);
        return true;
    }
    if (!strcmp(type, "bool")) {
        bool truthy = Z_TYPE(v) == IS_TRUE || (Z_TYPE(v) == IS_LONG && Z_LVAL(v) == 1) ||
            (Z_TYPE(v) == IS_STRING && (zend_string_equals_literal(Z_STR(v), "1") ||
                zend_string_equals_literal(Z_STR(v), "t") || zend_string_equals_literal(Z_STR(v), "true")));
        bool falsy = Z_TYPE(v) == IS_FALSE || (Z_TYPE(v) == IS_LONG && Z_LVAL(v) == 0) ||
            (Z_TYPE(v) == IS_STRING && (zend_string_equals_literal(Z_STR(v), "0") ||
                zend_string_equals_literal(Z_STR(v), "f") || zend_string_equals_literal(Z_STR(v), "false")));
        zval_ptr_dtor(&v);
        if (!truthy && !falsy) return cell_refuse(entity, name, type, NULL);
        ZVAL_BOOL(out, truthy);
        return true;
    }
    if (!strcmp(type, "decimal")) {
        zval *precision = read_array(col, "precision"), *scale = read_array(col, "scale");
        zend_class_entry *decimal = read_lookup_class("Polyspec\\Orm\\Decimal");
        if (precision == NULL || scale == NULL || Z_TYPE_P(precision) != IS_LONG || Z_TYPE_P(scale) != IS_LONG || decimal == NULL) {
            zval_ptr_dtor(&v);
            return read_throw("INTERNAL", "decimal column has no precision or scale");
        }
        zval args[3];
        ZVAL_COPY_VALUE(&args[0], &v);
        ZVAL_LONG(&args[1], Z_LVAL_P(precision));
        ZVAL_LONG(&args[2], Z_LVAL_P(scale));
        bool ok = read_static_call(decimal, sqlite ? "fromScaled" : "decode", out, 3, args);
        zval_ptr_dtor(&v);
        if (ok) return true;
        zend_object *previous = EG(exception);
        if (previous == NULL) return false;
        GC_ADDREF(previous);
        zend_clear_exception();
        return cell_refuse(entity, name, type, previous);
    }
    if (!strcmp(type, "date") || !strcmp(type, "datetime") || !strcmp(type, "time")) {
        zval *precision_value = read_array(col, "precision");
        zend_long precision = !strcmp(type, "date") ? 0
            : (precision_value != NULL && Z_TYPE_P(precision_value) == IS_LONG ? Z_LVAL_P(precision_value) : -1);
        if (precision < 0 || precision > 9) { zval_ptr_dtor(&v); return read_throw("INTERNAL", "time column has no precision"); }
        if (strcmp(type, "time") && Z_TYPE(v) == IS_OBJECT && instanceof_function(Z_OBJCE(v), php_date_get_interface_ce())) {
            /* A time that the driver read; a datetime has no fraction digit beyond its precision. */
            bool whole = true;
            if (!strcmp(type, "datetime")) {
                zval format, micro;
                ZVAL_STRING(&format, "u");
                bool ok = read_call(&v, "format", &micro, 1, &format);
                zval_ptr_dtor(&format);
                if (!ok) { zval_ptr_dtor(&v); return false; }
                zend_long units = 1;
                for (zend_long k = precision; k < 6; k++) units *= 10;
                whole = Z_TYPE(micro) == IS_STRING && ZEND_STRTOL(Z_STRVAL(micro), NULL, 10) % units == 0;
                zval_ptr_dtor(&micro);
            }
            if (!whole) { zval_ptr_dtor(&v); return cell_refuse(entity, name, type, NULL); }
            bool ok = model_time_value_in_zone(&v, zone, type, out);
            zval_ptr_dtor(&v);
            return ok;
        }
        zend_string *text = Z_TYPE(v) == IS_STRING ? cell_time_text(type, Z_STRVAL(v), Z_STRLEN(v), precision) : NULL;
        zval_ptr_dtor(&v);
        if (text == NULL) return cell_refuse(entity, name, type, NULL);
        if (!strcmp(type, "time")) {
            ZVAL_STR(out, text);
            return true;
        }
        /* The text is checked now; the getter parses it in the connection's zone when it is first read (T189). */
        object_init_ex(out, polyspec_pending_time_ce);
        if (EG(exception) != NULL) { zend_string_release(text); return false; }
        zval args[3], rv;
        ZVAL_STR(&args[0], text);
        ZVAL_COPY(&args[1], zone);
        ZVAL_STRING(&args[2], type);
        zend_call_known_instance_method(polyspec_pending_time_ce->constructor, Z_OBJ_P(out), &rv, 3, args);
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&args[1]);
        zval_ptr_dtor(&args[2]);
        if (!Z_ISUNDEF(rv)) zval_ptr_dtor(&rv);
        if (EG(exception) != NULL) { zval_ptr_dtor(out); ZVAL_UNDEF(out); return false; }
        return true;
    }
    if (Z_TYPE(v) != IS_STRING) { zval_ptr_dtor(&v); return cell_refuse(entity, name, type, NULL); }
    /* COD-69: a text cell that is not valid UTF-8 is refused, never returned as its bytes. */
    if (strcmp(type, "bytes") && !codec_valid_utf8(Z_STRVAL(v), Z_STRLEN(v))) {
        zval_ptr_dtor(&v);
        zend_string *message = zend_string_init(ZEND_STRL("text is not valid UTF-8"), 0);
        zval exception;
        if (cell_refusal(entity, name, message, NULL, &exception)) zend_throw_exception_object(&exception);
        zend_string_release(message);
        return false;
    }
    ZVAL_COPY_VALUE(out, &v);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, cellMessage)
{
    zend_string *type;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(type) ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(cell_message(ZSTR_VAL(type)));
}

ZEND_METHOD(Polyspec_Orm_Model, cellRefusal)
{
    zend_string *entity, *name, *message;
    zend_object *previous = NULL;
    ZEND_PARSE_PARAMETERS_START(3, 4)
        Z_PARAM_STR(entity)
        Z_PARAM_STR(name)
        Z_PARAM_STR(message)
        Z_PARAM_OPTIONAL
        Z_PARAM_OBJ_OF_CLASS_OR_NULL(previous, zend_ce_throwable)
    ZEND_PARSE_PARAMETERS_END();
    if (previous != NULL) GC_ADDREF(previous);
    if (!cell_refusal(entity, name, message, previous, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, cellValue)
{
    zend_string *entity, *name;
    zval *col, *v, *zone;
    bool sqlite, integer_text;
    ZEND_PARSE_PARAMETERS_START(7, 7)
        Z_PARAM_STR(entity)
        Z_PARAM_STR(name)
        Z_PARAM_ARRAY(col)
        Z_PARAM_ZVAL(v)
        Z_PARAM_BOOL(sqlite)
        Z_PARAM_BOOL(integer_text)
        Z_PARAM_OBJECT_OF_CLASS(zone, php_date_get_timezone_ce())
    ZEND_PARSE_PARAMETERS_END();
    if (!cell_value(entity, name, col, v, sqlite, integer_text, zone, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, timeText)
{
    zend_string *type, *text;
    zend_long precision;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_STR(type) Z_PARAM_STR(text) Z_PARAM_LONG(precision) ZEND_PARSE_PARAMETERS_END();
    if (precision < 0 || precision > 9) RETURN_NULL();
    zend_string *result = cell_time_text(ZSTR_VAL(type), ZSTR_VAL(text), ZSTR_LEN(text), precision);
    if (result == NULL) RETURN_NULL();
    RETURN_STR(result);
}

ZEND_METHOD(Polyspec_Orm_Model, validDate)
{
    zend_long year, month, day;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_LONG(year) Z_PARAM_LONG(month) Z_PARAM_LONG(day) ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(month >= 1 && month <= 12 && day >= 1 && day <= 31 && cell_valid_date((int)year, (int)month, (int)day));
}

ZEND_METHOD(Polyspec_Orm_Model, fractionDigits)
{
    zend_string *digits;
    zend_long precision;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_STR(digits) Z_PARAM_LONG(precision) ZEND_PARSE_PARAMETERS_END();
    if (precision < 0) RETURN_NULL();
    smart_str out = {0};
    if (!cell_fraction(ZSTR_VAL(digits), ZSTR_LEN(digits), precision, &out)) { smart_str_free(&out); RETURN_NULL(); }
    RETURN_STR(out.s != NULL ? smart_str_extract(&out) : ZSTR_EMPTY_ALLOC());
}

ZEND_METHOD(Polyspec_Orm_Model, aggregateNumber)
{
    zval *raw;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(raw) ZEND_PARSE_PARAMETERS_END();
    double value;
    int status = exact_number(raw, &value);
    if (status != 1) {
        read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
        RETURN_THROWS();
    }
    RETURN_DOUBLE(value);
}

ZEND_METHOD(Polyspec_Orm_Model, get)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval kind, rows, first;
    ZVAL_STRING(&kind, "one");
    if (!read_model_call(ZEND_THIS, "load", &rows, 1, &kind)) { zval_ptr_dtor(&kind); RETURN_THROWS(); }
    zval_ptr_dtor(&kind);
    if (!read_call(&rows, "first", &first, 0, NULL)) { zval_ptr_dtor(&rows); RETURN_THROWS(); }
    zval_ptr_dtor(&rows);
    ZVAL_COPY_VALUE(return_value, &first);
}

ZEND_METHOD(Polyspec_Orm_Model, gets)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval kind;
    ZVAL_STRING(&kind, "all");
    if (!read_model_call(ZEND_THIS, "load", return_value, 1, &kind)) { zval_ptr_dtor(&kind); RETURN_THROWS(); }
    zval_ptr_dtor(&kind);
}

ZEND_METHOD(Polyspec_Orm_Model, getCount)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval executor, db, frame, kind, request, args[2], result;
    if (!read_model_call(ZEND_THIS, "executor", &executor, 0, NULL)) RETURN_THROWS();
    zval *dbp = zend_hash_index_find(Z_ARRVAL(executor), 0);
    zval *framep = zend_hash_index_find(Z_ARRVAL(executor), 1);
    if (dbp == NULL || framep == NULL) { zval_ptr_dtor(&executor); read_throw("INTERNAL", "executor result is incomplete"); RETURN_THROWS(); }
    ZVAL_COPY(&db, dbp); ZVAL_COPY(&frame, framep);
    ZVAL_STRING(&kind, "count"); ZVAL_COPY(&args[0], &kind); ZVAL_COPY(&args[1], &db);
    if (!read_model_call(ZEND_THIS, "build", &request, 2, args)) {
        zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); RETURN_THROWS();
    }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    zval call_args[2]; ZVAL_COPY(&call_args[0], &frame); ZVAL_COPY(&call_args[1], &request);
    if (!read_call(&db, "scalarOf", &result, 2, call_args)) {
        for (int i = 0; i < 2; i++) zval_ptr_dtor(&call_args[i]);
        zval_ptr_dtor(&request); zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind); RETURN_THROWS();
    }
    zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&call_args[1]);
    zval_ptr_dtor(&request); zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind);
    if (Z_TYPE(result) == IS_LONG) { ZVAL_COPY_VALUE(return_value, &result); return; }
    zend_long count = zval_get_long(&result); zval_ptr_dtor(&result); RETURN_LONG(count);
}

/* exact_digits reads the sum cell of an exact column as its sign and the digits of the sum × 10^scale: on SQLite and markdown
 * (scaled) the cell is that integer (DIA-25), on MySQL and PostgreSQL a decimal of at most scale fraction digits. False with
 * CODEC_DECODE thrown. */
static bool exact_digits(zval *raw, zend_long scale, bool scaled, bool *negative, smart_str *digits)
{
    char buf[32];
    const char *s;
    size_t n;
    if (Z_TYPE_P(raw) == IS_LONG) {
        n = (size_t)snprintf(buf, sizeof buf, ZEND_LONG_FMT, Z_LVAL_P(raw));
        s = buf;
    } else if (Z_TYPE_P(raw) == IS_STRING) {
        s = Z_STRVAL_P(raw);
        n = Z_STRLEN_P(raw);
    } else {
        return read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
    }
    size_t i = 0;
    *negative = n > 0 && s[0] == '-';
    if (*negative) i++;
    size_t whole = i;
    while (i < n && s[i] >= '0' && s[i] <= '9') i++;
    size_t whole_end = i, fraction = i, fraction_end = i;
    if (i < n && s[i] == '.') {
        fraction = ++i;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
        fraction_end = i;
        if (fraction_end == fraction) return read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
    }
    zend_long room = scaled ? 0 : scale;
    if (i != n || whole_end == whole || (zend_long)(fraction_end - fraction) > room) return read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
    size_t k = whole;
    while (k < whole_end && s[k] == '0') k++;
    smart_str_appendl(digits, s + k, whole_end - k);
    smart_str_appendl(digits, s + fraction, fraction_end - fraction);
    for (zend_long pad = (zend_long)(fraction_end - fraction); pad < room; pad++) smart_str_appendc(digits, '0');
    smart_str_0(digits);
    /* The fraction digits after a zero whole part can begin with zeros too. */
    if (digits->s != NULL) {
        size_t lead = 0;
        while (lead < ZSTR_LEN(digits->s) && ZSTR_VAL(digits->s)[lead] == '0') lead++;
        if (lead > 0) {
            memmove(ZSTR_VAL(digits->s), ZSTR_VAL(digits->s) + lead, ZSTR_LEN(digits->s) - lead);
            ZSTR_LEN(digits->s) -= lead;
            smart_str_0(digits);
        }
    }
    if (digits->s == NULL || ZSTR_LEN(digits->s) == 0) {
        *negative = false;
        smart_str_appendc(digits, '0');
        smart_str_0(digits);
    }
    return true;
}

/* nearest_binary64 is the nearest binary64 value of the digits × 10^-scale, ties to even; a value beyond the finite range is
 * CODEC_DECODE (DSL-66). */
static bool nearest_binary64(bool negative, const char *digits, zend_long scale, zval *out)
{
    zend_string *text = strpprintf(0, "%s%se-" ZEND_LONG_FMT, negative ? "-" : "", digits, scale);
    double value = zend_strtod(ZSTR_VAL(text), NULL);
    zend_string_release(text);
    if (!zend_finite(value)) return read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
    ZVAL_DOUBLE(out, value);
    return true;
}

/* exact_sum_value is the result of getSum for the sum cell of an exact column (DSL-66, DSL-161). */
static bool exact_sum_value(zval *raw, zend_long scale, bool scaled, zval *out)
{
    bool negative;
    smart_str digits = {0};
    bool ok = exact_digits(raw, scale, scaled, &negative, &digits) && nearest_binary64(negative, ZSTR_VAL(digits.s), scale, out);
    smart_str_free(&digits);
    return ok;
}

/* avg_value is the result of getAvg for the row of the sum and the count of the values of the column: null for no value; for
 * an exact column the exact sum divided by the count, rounded half away from zero to AVG_SCALE_EXTRA places beyond the scale
 * of the column and then converted once (DSL-66, DSL-161); for an f64 column the binary64 sum divided by the count, which is
 * the AVG of every database. The long division keeps its remainder below the count: ten additions of the remainder modulo the
 * count never leave the integer range. */
static bool avg_value(zval *model, zval *row, bool exact, zend_long scale, bool scaled, zval *out)
{
    zval *sum = Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 0) : NULL;
    zval *count_cell = Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 1) : NULL;
    if (sum == NULL || count_cell == NULL) return read_throw("INTERNAL", "an average statement read no sum and count");
    zend_long count = -1;
    if (Z_TYPE_P(count_cell) == IS_LONG) {
        count = Z_LVAL_P(count_cell);
    } else if (Z_TYPE_P(count_cell) == IS_STRING && Z_STRLEN_P(count_cell) > 0) {
        zend_long parsed;
        double ignored;
        if (is_numeric_string(Z_STRVAL_P(count_cell), Z_STRLEN_P(count_cell), &parsed, &ignored, false) == IS_LONG) count = parsed;
    }
    if (count < 0) return read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
    if (count == 0) { ZVAL_NULL(out); return true; }
    if (Z_TYPE_P(sum) == IS_NULL) return read_throw("CODEC_DECODE", AGGREGATE_REFUSED);
    if (!exact) {
        zval number;
        if (!read_model_static_call(model, "aggregateNumber", &number, 1, sum)) return false;
        ZVAL_DOUBLE(out, Z_DVAL(number) / (double)count);
        return true;
    }
    bool negative;
    smart_str digits = {0};
    if (!exact_digits(sum, scale, scaled, &negative, &digits)) { smart_str_free(&digits); return false; }
    smart_str quotient = {0};
    zend_long rest = 0;
    size_t len = ZSTR_LEN(digits.s);
    for (size_t i = 0; i < len + AVG_SCALE_EXTRA + 1; i++) {
        zend_long digit = i < len ? ZSTR_VAL(digits.s)[i] - '0' : 0;
        zend_long q = digit / count, acc = digit % count;
        for (int k = 0; k < 10; k++) {
            if (acc >= count - rest) { acc -= count - rest; q++; } else { acc += rest; }
        }
        rest = acc;
        smart_str_appendc(&quotient, (char)('0' + q));
    }
    smart_str_free(&digits);
    smart_str_0(&quotient);
    char *q = ZSTR_VAL(quotient.s);
    size_t qlen = ZSTR_LEN(quotient.s);
    bool up = q[qlen - 1] >= '5';
    q[--qlen] = '\0';
    for (size_t i = qlen; up && i > 0; i--) {
        if (q[i - 1] == '9') { q[i - 1] = '0'; } else { q[i - 1]++; up = false; }
    }
    smart_str rounded = {0};
    if (up) smart_str_appendc(&rounded, '1');
    size_t lead = 0;
    while (!up && lead + 1 < qlen && q[lead] == '0') lead++;
    smart_str_appendl(&rounded, q + lead, qlen - lead);
    smart_str_0(&rounded);
    smart_str_free(&quotient);
    bool zero = true;
    for (size_t i = 0; i < ZSTR_LEN(rounded.s); i++) if (ZSTR_VAL(rounded.s)[i] != '0') zero = false;
    bool ok = nearest_binary64(negative && !zero, ZSTR_VAL(rounded.s), scale + AVG_SCALE_EXTRA, out);
    smart_str_free(&rounded);
    return ok;
}

/* aggregate_range_error replaces the pending error of a sum or average statement: PostgreSQL refuses an f64 sum beyond the
 * finite range with SQLSTATE 22003, and MySQL refuses it so through the planned addition of 0, which is the nonfinite scalar
 * that the other databases return, so it is CODEC_DECODE with the text of that scalar and the driver error as its cause
 * (DIA-200). */
static void aggregate_range_error(void)
{
    zend_object *error = EG(exception);
    zend_class_entry *orm = read_lookup_class("Polyspec\\Orm\\OrmException");
    if (error == NULL || orm == NULL || !instanceof_function(error->ce, orm)) return;
    zval rv, prv, irv;
    zval *code = zend_read_property(error->ce, error, "code_", sizeof("code_") - 1, true, &rv);
    zval *previous = zend_read_property(zend_ce_exception, error, "previous", sizeof("previous") - 1, true, &prv);
    if (code == NULL || Z_TYPE_P(code) != IS_STRING || !zend_string_equals_literal(Z_STR_P(code), "DRIVER")) return;
    if (previous == NULL || Z_TYPE_P(previous) != IS_OBJECT || read_lookup_class("PDOException") == NULL || !instanceof_function(Z_OBJCE_P(previous), read_lookup_class("PDOException"))) return;
    zval *info = zend_read_property(Z_OBJCE_P(previous), Z_OBJ_P(previous), "errorInfo", sizeof("errorInfo") - 1, true, &irv);
    zval *state = info != NULL && Z_TYPE_P(info) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(info), 0) : NULL;
    if (state == NULL || Z_TYPE_P(state) != IS_STRING || !zend_string_equals_literal(Z_STR_P(state), "22003")) return;
    zval cause, ex, args[3], result;
    ZVAL_OBJ_COPY(&cause, error);
    zend_clear_exception();
    object_init_ex(&ex, orm);
    ZVAL_STRING(&args[0], "CODEC_DECODE");
    ZVAL_STRING(&args[1], AGGREGATE_REFUSED);
    ZVAL_COPY_VALUE(&args[2], &cause);
    zend_call_known_instance_method(orm->constructor, Z_OBJ(ex), &result, 3, args);
    zval_ptr_dtor(&result);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&args[2]);
    if (EG(exception) == NULL) zend_throw_exception_object(&ex); else zval_ptr_dtor(&ex);
}

static bool read_aggregate(zval *model, const char *fn, zval *return_value)
{
    zval *agg_fn = model_state_property(model_state_of(Z_OBJ_P(model)), "agg_fn");
    if (agg_fn == NULL || Z_TYPE_P(agg_fn) != IS_STRING || Z_STRLEN_P(agg_fn) != strlen(fn) || memcmp(Z_STRVAL_P(agg_fn), fn, strlen(fn)) != 0) {
        zend_string *display = zend_string_init(fn, strlen(fn), 0);
        if (ZSTR_LEN(display) != 0 && ZSTR_VAL(display)[0] >= 'a' && ZSTR_VAL(display)[0] <= 'z') ZSTR_VAL(display)[0] -= ('a' - 'A');
        zend_string *message = strpprintf(0, "get%s requires %s<Col>()", ZSTR_VAL(display), fn);
        zend_string_release(display); read_throw("CONFIG", ZSTR_VAL(message)); zend_string_release(message); return false;
    }
    zval executor;
    if (!read_model_call(model, "executor", &executor, 0, NULL)) return false;
    zval *dbp = zend_hash_index_find(Z_ARRVAL(executor), 0), *framep = zend_hash_index_find(Z_ARRVAL(executor), 1);
    if (dbp == NULL || framep == NULL) { zval_ptr_dtor(&executor); read_throw("INTERNAL", "executor result is incomplete"); return false; }
    zval db, frame, kind, args[2], request, *agg;
    ZVAL_COPY(&db, dbp); ZVAL_COPY(&frame, framep); ZVAL_STRING(&kind, fn);
    ZVAL_COPY(&args[0], &kind); ZVAL_COPY(&args[1], &db);
    if (!read_model_call(model, "build", &request, 2, args)) {
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind); return false;
    }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    agg = zend_read_property(Z_OBJCE_P(&request), Z_OBJ(request), "ir", sizeof("ir") - 1, 1, &EG(uninitialized_zval));
    if (Z_TYPE_P(agg) == IS_ARRAY) {
        SEPARATE_ARRAY(agg);
        zval *agg_name = model_state_property(model_state_of(Z_OBJ_P(model)), "agg");
        if (agg_name != NULL && Z_TYPE_P(agg_name) == IS_STRING) {
            zval value; ZVAL_COPY(&value, agg_name);
            zend_hash_str_update(Z_ARRVAL_P(agg), "agg", sizeof("agg") - 1, &value);
        }
    }
    zval call_args[2], result; ZVAL_COPY(&call_args[0], &frame); ZVAL_COPY(&call_args[1], &request);
    bool ok = read_call(&db, "scalarOf", &result, 2, call_args);
    zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&call_args[1]);
    zval_ptr_dtor(&request); zval_ptr_dtor(&executor); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind);
    if (!ok) { aggregate_range_error(); zval_ptr_dtor(&db); return false; }
    /* SQLite and markdown hold a decimal as the integer value × 10^scale, and so its sum (DIA-25). */
    zval dialect;
    if (!read_call(&db, "dialect", &dialect, 0, NULL)) { zval_ptr_dtor(&db); zval_ptr_dtor(&result); return false; }
    zval_ptr_dtor(&db);
    bool scaled = Z_TYPE(dialect) == IS_STRING && zend_string_equals_literal(Z_STR(dialect), "sqlite");
    zval_ptr_dtor(&dialect);
    /* The planner has checked the column, so the column of the model is there. */
    zval meta;
    if (!read_static_meta(model, &meta)) { zval_ptr_dtor(&result); return false; }
    zval *columns = read_array(&meta, "columns"), *name = model_state_property(model_state_of(Z_OBJ_P(model)), "agg"), *col = NULL;
    if (columns != NULL && Z_TYPE_P(columns) == IS_ARRAY && name != NULL && Z_TYPE_P(name) == IS_STRING) col = zend_hash_find(Z_ARRVAL_P(columns), Z_STR_P(name));
    zval *type = col != NULL ? read_array(col, "type") : NULL, *scale = col != NULL ? read_array(col, "scale") : NULL;
    if (type == NULL || Z_TYPE_P(type) != IS_STRING) { zval_ptr_dtor(&meta); zval_ptr_dtor(&result); read_throw("INTERNAL", "the column of a planned aggregate is missing"); return false; }
    bool exact = read_string_is(type, "i16") || read_string_is(type, "i32") || read_string_is(type, "i64") || read_string_is(type, "decimal");
    zend_long column_scale = scale != NULL && Z_TYPE_P(scale) == IS_LONG ? Z_LVAL_P(scale) : 0;
    zval_ptr_dtor(&meta);
    bool done;
    if (strcmp(fn, "sum") == 0) {
        if (Z_TYPE(result) == IS_NULL) { ZVAL_NULL(return_value); zval_ptr_dtor(&result); return true; }
        done = exact ? exact_sum_value(&result, column_scale, scaled, return_value)
                     : read_model_static_call(model, "aggregateNumber", return_value, 1, &result);
    } else {
        done = avg_value(model, &result, exact, column_scale, scaled, return_value);
    }
    zval_ptr_dtor(&result);
    return done;
}

ZEND_METHOD(Polyspec_Orm_Model, getSum)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!read_aggregate(ZEND_THIS, "sum", return_value)) RETURN_THROWS();
    if (Z_TYPE_P(return_value) == IS_NULL) ZVAL_DOUBLE(return_value, 0.0);
}

ZEND_METHOD(Polyspec_Orm_Model, getAvg)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!read_aggregate(ZEND_THIS, "avg", return_value)) RETURN_THROWS();
}

/* The arguments of a page checked and its request of kind built: the one request of getsPage and getPagePlanSteps
 * (paginate), and of the lookahead pages, whose limit reads extra rows past the page (INT-164). terminal names the
 * terminal in a refusal. On success the caller owns db, frame, clone and request. */
static bool page_request_of(zval *self, const char *kind, const char *terminal, zend_long extra, zend_long page,
    zend_long per_page, zval *db, zval *frame, zval *clone, zval *request)
{
    if (page < 1 || per_page < 1) {
        zend_string *message = strpprintf(0, "%s requires a positive page and perPage", terminal);
        read_throw("CONFIG", ZSTR_VAL(message));
        zend_string_release(message);
        return false;
    }
    zval *limit = model_state_property(model_state_of(Z_OBJ_P(self)), "limit");
    if (limit != NULL && Z_TYPE_P(limit) != IS_NULL) {
        zend_string *message = strpprintf(0, "%s cannot be combined with limit", terminal);
        read_throw("CONFIG", ZSTR_VAL(message));
        zend_string_release(message);
        return false;
    }
    zval executor;
    if (!read_model_call(self, "executor", &executor, 0, NULL)) return false;
    zval *dbp = zend_hash_index_find(Z_ARRVAL(executor), 0), *framep = zend_hash_index_find(Z_ARRVAL(executor), 1);
    if (dbp == NULL || framep == NULL) { zval_ptr_dtor(&executor); read_throw("INTERNAL", "executor result is incomplete"); return false; }
    ZVAL_COPY(db, dbp);
    ZVAL_COPY(frame, framep);
    zval_ptr_dtor(&executor);
    ZVAL_OBJ(clone, zend_objects_clone_obj(Z_OBJ_P(self)));
    if (EG(exception) != NULL) { zval_ptr_dtor(db); zval_ptr_dtor(frame); return false; }
    zval page_limit, left, right, offset;
    array_init(&page_limit);
    ZVAL_LONG(&left, page - 1);
    ZVAL_LONG(&right, per_page);
    mul_function(&offset, &left, &right);
    add_assoc_zval(&page_limit, "offset", &offset);
    add_assoc_long(&page_limit, "count", per_page + extra);
    model_state_property_set(model_state_of(Z_OBJ_P(clone)), "limit", &page_limit);
    zval_ptr_dtor(&page_limit);
    zval args[2];
    ZVAL_STRING(&args[0], kind);
    ZVAL_COPY(&args[1], db);
    bool built = read_model_call(clone, "build", request, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (!built) { zval_ptr_dtor(clone); zval_ptr_dtor(db); zval_ptr_dtor(frame); return false; }
    return true;
}

/* The request of a page method from its two integer arguments, and a null is refused as the signature of the method does. */
static bool page_method_request(zend_execute_data *execute_data, zend_long *page, zend_long *per_page, zval *db, zval *frame, zval *clone, zval *request)
{
    static const char *const scalar_types[] = {"int", "int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) return false;
    ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_LONG(*page) Z_PARAM_LONG(*per_page) ZEND_PARSE_PARAMETERS_END_EX(return false);
    return page_request_of(ZEND_THIS, "paginate", "getsPage", 0, *page, *per_page, db, frame, clone, request);
}

/* A lookahead page of kind (INT-164): its request, whose limit reads one row past the page, run by Db::lookahead. On
 * success the caller owns db, request, clone and result, the tuple [plan, result, hasNext]. */
static bool lookahead_run(zend_execute_data *execute_data, const char *kind, zend_long *page, zend_long *per_page, zval *db,
    zval *clone, zval *request, zval *result)
{
    static const char *const scalar_types[] = {"int", "int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) return false;
    ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_LONG(*page) Z_PARAM_LONG(*per_page) ZEND_PARSE_PARAMETERS_END_EX(return false);
    zval frame;
    if (!page_request_of(ZEND_THIS, kind, "getsLookaheadPage", 1, *page, *per_page, db, &frame, clone, request)) return false;
    if (strcmp(kind, "group_lookahead_paginate") == 0) {
        zval *external = read_object_prop(request, "external");
        if (external != NULL && Z_TYPE_P(external) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(external)) != 0) {
            zval_ptr_dtor(&frame); zval_ptr_dtor(request); zval_ptr_dtor(clone); zval_ptr_dtor(db);
            return read_throw("CONFIG", "group count cannot return relations");
        }
    }
    zval args[3];
    ZVAL_COPY(&args[0], &frame);
    ZVAL_COPY(&args[1], request);
    ZVAL_LONG(&args[2], *per_page);
    bool ok = read_call(db, "lookahead", result, 3, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&frame);
    if (ok && (Z_TYPE_P(result) != IS_ARRAY || zend_hash_index_find(Z_ARRVAL_P(result), 2) == NULL)) {
        zval_ptr_dtor(result);
        ok = read_throw("INTERNAL", "lookahead result is incomplete");
    }
    if (!ok) { zval_ptr_dtor(request); zval_ptr_dtor(clone); zval_ptr_dtor(db); }
    return ok;
}

/* Builds a lookahead page object of ce from its items, page, perPage and hasNext. */
static bool lookahead_page_object(zend_class_entry *ce, zval *items, zend_long page, zend_long per_page, bool has_next, zval *out)
{
    object_init_ex(out, ce);
    if (EG(exception) != NULL) return false;
    zval args[4], ctor;
    ZVAL_COPY(&args[0], items);
    ZVAL_LONG(&args[1], page);
    ZVAL_LONG(&args[2], per_page);
    ZVAL_BOOL(&args[3], has_next);
    read_call(out, "__construct", &ctor, 4, args);
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    if (!Z_ISUNDEF(ctor)) zval_ptr_dtor(&ctor);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Model, getsLookaheadPage)
{
    zend_long page, per_page;
    zval db, clone, request, result;
    if (!lookahead_run(execute_data, "lookahead_paginate", &page, &per_page, &db, &clone, &request, &result)) RETURN_THROWS();
    zval *plan = zend_hash_index_find(Z_ARRVAL(result), 0), *rows = zend_hash_index_find(Z_ARRVAL(result), 1);
    bool has_next = zend_is_true(zend_hash_index_find(Z_ARRVAL(result), 2));
    bool ok = plan != NULL && rows != NULL;
    if (!ok) read_throw("INTERNAL", "lookahead result is incomplete");
    zval items;
    ZVAL_UNDEF(&items);
    if (ok) {
        zval args[4];
        ZVAL_COPY(&args[0], &db);
        ZVAL_COPY(&args[1], &request);
        ZVAL_COPY(&args[2], plan);
        ZVAL_COPY(&args[3], rows);
        ok = read_model_call(&clone, "assemble", &items, 4, args);
        for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    }
    if (ok) ok = lookahead_page_object(polyspec_lookahead_page_ce, &items, page, per_page, has_next, return_value);
    if (!Z_ISUNDEF(items)) zval_ptr_dtor(&items);
    zval_ptr_dtor(&result); zval_ptr_dtor(&request); zval_ptr_dtor(&clone); zval_ptr_dtor(&db);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, getsCountLookaheadPage)
{
    zend_long page, per_page;
    zval db, clone, request, result;
    if (!lookahead_run(execute_data, "group_lookahead_paginate", &page, &per_page, &db, &clone, &request, &result)) RETURN_THROWS();
    zval *plan = zend_hash_index_find(Z_ARRVAL(result), 0), *rows = zend_hash_index_find(Z_ARRVAL(result), 1);
    bool has_next = zend_is_true(zend_hash_index_find(Z_ARRVAL(result), 2));
    zval groups;
    ZVAL_UNDEF(&groups);
    bool ok = plan != NULL && rows != NULL;
    if (!ok) read_throw("INTERNAL", "lookahead result is incomplete");
    if (ok) ok = group_rows_of(ZEND_THIS, &db, plan, rows, &groups);
    if (ok) ok = lookahead_page_object(polyspec_group_lookahead_page_ce, &groups, page, per_page, has_next, return_value);
    if (!Z_ISUNDEF(groups)) zval_ptr_dtor(&groups);
    zval_ptr_dtor(&result); zval_ptr_dtor(&request); zval_ptr_dtor(&clone); zval_ptr_dtor(&db);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, getPagePlanSteps)
{
    zend_long page, per_page;
    zval db, frame, clone, request;
    if (!page_method_request(execute_data, &page, &per_page, &db, &frame, &clone, &request)) RETURN_THROWS();
    zval args[2];
    ZVAL_COPY(&args[0], &frame);
    ZVAL_COPY(&args[1], &request);
    bool ok = read_call(&db, "pagePlanSteps", return_value, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&request);
    zval_ptr_dtor(&clone);
    zval_ptr_dtor(&frame);
    zval_ptr_dtor(&db);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, getsPage)
{
    zend_long page, per_page;
    zval db,frame,clone,request;
    if(!page_method_request(execute_data,&page,&per_page,&db,&frame,&clone,&request))RETURN_THROWS();
    zval paginate_args[2],result;ZVAL_COPY(&paginate_args[0],&frame);ZVAL_COPY(&paginate_args[1],&request);bool ok=read_call(&db,"paginate",&result,2,paginate_args);zval_ptr_dtor(&paginate_args[0]);zval_ptr_dtor(&paginate_args[1]);zval_ptr_dtor(&clone);zval_ptr_dtor(&frame);
    if(!ok){zval_ptr_dtor(&request);zval_ptr_dtor(&db);RETURN_THROWS();}
    zval *plan=zend_hash_index_find(Z_ARRVAL(result),0),*rows=zend_hash_index_find(Z_ARRVAL(result),1),*total_value=zend_hash_index_find(Z_ARRVAL(result),2);
    if(plan==NULL||rows==NULL||total_value==NULL){zval_ptr_dtor(&request);zval_ptr_dtor(&result);zval_ptr_dtor(&db);read_throw("INTERNAL","paginate result is incomplete");RETURN_THROWS();}
    zend_long total=zval_get_long(total_value);
    zval assemble_args[4],items;ZVAL_COPY(&assemble_args[0],&db);ZVAL_COPY(&assemble_args[1],&request);ZVAL_COPY(&assemble_args[2],plan);ZVAL_COPY(&assemble_args[3],rows);
    /* Db::paginate returns the same Request as its statement input in the result tuple contract. */
    bool assembled=read_model_call(ZEND_THIS,"assemble",&items,4,assemble_args);
    for(int i=0;i<4;i++)zval_ptr_dtor(&assemble_args[i]);
    if(!assembled){zval_ptr_dtor(&request);zval_ptr_dtor(&result);zval_ptr_dtor(&db);RETURN_THROWS();}
    zend_class_entry *page_ce=polyspec_page_ce;object_init_ex(return_value,page_ce);
    if(EG(exception)!=NULL){zval_ptr_dtor(&items);zval_ptr_dtor(&request);zval_ptr_dtor(&result);zval_ptr_dtor(&db);RETURN_THROWS();}
    zval page_args[5],ctor;ZVAL_COPY(&page_args[0],&items);ZVAL_LONG(&page_args[1],total);ZVAL_LONG(&page_args[2],total / per_page + (total % per_page != 0));ZVAL_LONG(&page_args[3],page);ZVAL_LONG(&page_args[4],per_page);
    read_call(return_value,"__construct",&ctor,5,page_args);
    for (int i = 0; i < 5; i++) zval_ptr_dtor(&page_args[i]);
    if (!Z_ISUNDEF(ctor)) zval_ptr_dtor(&ctor);
    zval_ptr_dtor(&items); zval_ptr_dtor(&request); zval_ptr_dtor(&result); zval_ptr_dtor(&db);
    if (EG(exception) != NULL) RETURN_THROWS();
}

/* Remaining methods are declared in model_read.h and are implemented in the next read-slice batches. */
