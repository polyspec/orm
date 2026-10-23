/* Native result assembly and read terminals for Polyspec\Orm\Model. */
#include "model_read.h"
#include "model_state.h"
#include "model_types.h"
#include "model_native_methods.h"
#include "model_assembly.h"
#include "collection.h"
#include "runtime_model.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include <math.h>
#include <stdint.h>
#include <string.h>

static bool read_aggregate(zval *model, const char *fn, zval *return_value);

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
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = NULL;
    for (zend_class_entry *scope = Z_OBJCE_P(object); scope != NULL && fn == NULL; scope = scope->parent) {
        fn = zend_hash_find_ptr(&scope->function_table, key);
    }
    zend_string_release(key);
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
    zend_class_entry *ce = model_native_class_entry();
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = zend_hash_find_ptr(&ce->function_table, key);
    zend_string_release(key);
    if (fn == NULL) {
        zend_throw_error(NULL, "Native Model helper %s is not registered", name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, Z_OBJ_P(model), Z_OBJCE_P(model), result, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool read_model_static_call(zval *model, const char *name, zval *result, uint32_t argc, zval *args)
{
    zend_class_entry *ce = model_native_class_entry();
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = zend_hash_find_ptr(&ce->function_table, key);
    zend_string_release(key);
    if (fn == NULL) {
        zend_throw_error(NULL, "Native Model helper %s is not registered", name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, NULL, Z_OBJCE_P(model), result, argc, args, NULL);
    return EG(exception) == NULL;
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
    if (Z_TYPE_P(array) != IS_ARRAY) return NULL;
    return zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key));
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
            if (index != NULL) { zval copy; ZVAL_COPY(&copy, index); zend_hash_str_update(Z_ARRVAL_P(return_value), "key", 3, &copy); }
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
    array_init(&empty); add_assoc_zval(&row, "related", &empty);
    array_init(&empty); add_assoc_zval(&row, "cascade", &empty);
    array_init(&empty); add_assoc_zval(&row, "flat", &empty);
    add_assoc_zval(return_value, "row", &row);
    zval_ptr_dtor(&meta);
}

static bool read_static_call(zend_class_entry *ce, const char *name, zval *result, uint32_t argc, zval *args)
{
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = NULL;
    for (zend_class_entry *scope = ce; scope != NULL && fn == NULL; scope = scope->parent) {
        fn = zend_hash_find_ptr(&scope->function_table, key);
    }
    zend_string_release(key);
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

static bool read_is_numeric(zval *value, bool *numeric)
{
    zval function, argument, result;
    ZVAL_STRING(&function, "is_numeric"); ZVAL_COPY(&argument, value); ZVAL_UNDEF(&result);
    zend_result status = call_user_function(EG(function_table), NULL, &function, &result, 1, &argument);
    zval_ptr_dtor(&function); zval_ptr_dtor(&argument);
    if (status != SUCCESS || EG(exception) != NULL) { if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result); return false; }
    *numeric = zend_is_true(&result); zval_ptr_dtor(&result); return true;
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

static bool read_column_convert(zval *model, zval *db, zval *zone, zval *column, zval *raw, zval *out)
{
    if (Z_TYPE_P(raw) == IS_NULL) { ZVAL_NULL(out); return true; }
    zval value; ZVAL_COPY(&value, raw);
    zval *type = read_array(column, "type"), *codec = read_array(column, "codec");
    if (codec != NULL && Z_TYPE_P(codec) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0) {
        ZVAL_COPY_VALUE(out, &value); return true;
    }
    if (read_string_is(type, "i16") || read_string_is(type, "i32") || read_string_is(type, "i64")) {
        ZVAL_LONG(out, zval_get_long(&value)); zval_ptr_dtor(&value); return true;
    }
    if (read_string_is(type, "f64")) {
        ZVAL_DOUBLE(out, zval_get_double(&value)); zval_ptr_dtor(&value); return true;
    }
    if (read_string_is(type, "decimal")) {
        zval *precision = read_array(column, "precision"), *scale = read_array(column, "scale");
        if (precision == NULL || scale == NULL || Z_TYPE_P(precision) != IS_LONG || Z_TYPE_P(scale) != IS_LONG) {
            zval_ptr_dtor(&value); read_throw("INTERNAL", "decimal column has no precision or scale"); return false;
        }
        zval args[3], result;
        ZVAL_COPY(&args[0], &value); ZVAL_LONG(&args[1], Z_LVAL_P(precision)); ZVAL_LONG(&args[2], Z_LVAL_P(scale));
        bool sqlite = false;
        zval driver;
        if (!read_call(db, "driver", &driver, 0, NULL)) { zval_ptr_dtor(&value); return false; }
        sqlite = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR(driver), "sqlite"); zval_ptr_dtor(&driver);
        zend_class_entry *decimal = read_lookup_class("Polyspec\\Orm\\Decimal");
        bool ok = decimal != NULL && read_static_call(decimal, sqlite ? "fromScaled" : "decode", &result, 3, args);
        for (int i=0;i<3;i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&value);
        if (!ok) return false;
        ZVAL_COPY_VALUE(out, &result); return true;
    }
    if (read_string_is(type, "bool")) {
        ZVAL_BOOL(out, zend_is_true(&value)); zval_ptr_dtor(&value); return true;
    }
    if (read_string_is(type, "date") || read_string_is(type, "datetime")) {
        if (Z_TYPE(value) == IS_STRING) {
            object_init_ex(out, polyspec_pending_time_ce);
            if (EG(exception) != NULL) { zval_ptr_dtor(&value); return false; }
            zval args[2], rv; ZVAL_COPY(&args[0], &value); ZVAL_COPY(&args[1], zone);
            zend_call_method(Z_OBJ_P(out), polyspec_pending_time_ce, NULL, "__construct", sizeof("__construct") - 1, &rv, 2, &args[0], &args[1]);
            zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); if (!Z_ISUNDEF(rv)) zval_ptr_dtor(&rv);
            zval_ptr_dtor(&value); return EG(exception) == NULL;
        }
        bool ok = model_time_value_in_zone(&value, zone, out); zval_ptr_dtor(&value); return ok;
    }
    if (!read_convert_resource(&value)) { zval_ptr_dtor(&value); return false; }
    if (Z_TYPE(value) == IS_STRING) { ZVAL_COPY_VALUE(out, &value); return true; }
    zend_string *text = zval_get_string(&value); zval_ptr_dtor(&value);
    if (EG(exception) != NULL) return false;
    ZVAL_STR(out, text); (void)model; return true;
}

ZEND_METHOD(Polyspec_Orm_Model, joinChild)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *joins = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "joins");
    if (joins != NULL && Z_TYPE_P(joins) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(joins), zval *join) {
            zval *child = read_array(join, "child");
            if (child == NULL || Z_TYPE_P(child) != IS_OBJECT) continue;
            zval result, args[1]; ZVAL_FALSE(&args[0]);
            if (!read_model_call(child, "resultName", &result, 1, args)) RETURN_THROWS();
            bool same = Z_TYPE(result) == IS_STRING && zend_string_equals(Z_STR(result), name);
            zval_ptr_dtor(&result);
            if (same) RETURN_COPY(child);
        } ZEND_HASH_FOREACH_END();
    }
    zend_string *message = strpprintf(0, "join result %s without a model", ZSTR_VAL(name));
    read_throw("INTERNAL", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, relationChild)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *relations = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "relations");
    if (relations != NULL && Z_TYPE_P(relations) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(relations), zval *relation) {
            zval *child = read_array(relation, "child"), *many = read_array(relation, "many");
            if (child == NULL || Z_TYPE_P(child) != IS_OBJECT || many == NULL) continue;
            zval result, arg; ZVAL_COPY(&arg, many);
            if (!read_model_call(child, "resultName", &result, 1, &arg)) { zval_ptr_dtor(&arg); RETURN_THROWS(); }
            zval_ptr_dtor(&arg);
            bool same = Z_TYPE(result) == IS_STRING && zend_string_equals(Z_STR(result), name);
            zval_ptr_dtor(&result);
            if (same) {
                array_init_size(return_value, 2); zval child_copy, many_copy;
                ZVAL_COPY(&child_copy, child); ZVAL_COPY(&many_copy, many);
                add_next_index_zval(return_value, &child_copy); add_next_index_zval(return_value, &many_copy); return;
            }
        } ZEND_HASH_FOREACH_END();
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
    zval values; array_init(&values);
    const char *convert_groups[] = {"int", "float", "decimal", "bool", "date", "string", "codec"};
    for (size_t g = 0; g < sizeof(convert_groups)/sizeof(convert_groups[0]); g++) {
        zval *group = read_array(&shape, convert_groups[g]);
        if (group == NULL || Z_TYPE_P(group) != IS_ARRAY) continue;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(group), zval *entry) {
            zval *idx = zend_hash_index_find(Z_ARRVAL_P(entry), 0), *column_name = zend_hash_index_find(Z_ARRVAL_P(entry), 1);
            if (idx == NULL || Z_TYPE_P(idx) != IS_LONG || column_name == NULL || Z_TYPE_P(column_name) != IS_STRING) continue;
            zval *raw = zend_hash_index_find(Z_ARRVAL_P(vals), (zend_ulong)Z_LVAL_P(idx));
            if (raw == NULL) { zval_ptr_dtor(&values); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); read_throw("INTERNAL", "row result column is missing"); RETURN_THROWS(); }
            zval converted;
            if (g == 6) {
                ZVAL_COPY(&converted, raw);
            } else {
                zval meta;
                if (!read_static_meta(ZEND_THIS, &meta)) { zval_ptr_dtor(&values); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
                zval *meta_cols = read_array(&meta, "columns");
                zval *column = meta_cols != NULL && Z_TYPE_P(meta_cols) == IS_ARRAY
                    ? zend_hash_find(Z_ARRVAL_P(meta_cols), Z_STR_P(column_name)) : NULL;
                if (column == NULL || !read_column_convert(ZEND_THIS, db, zone, column, raw, &converted)) {
                    zval_ptr_dtor(&meta); zval_ptr_dtor(&values); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS();
                }
                zval_ptr_dtor(&meta);
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
            zval converted; ZVAL_COPY(&converted,raw); if(!read_convert_resource(&converted)){zval_ptr_dtor(&converted);zval_ptr_dtor(&st); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS();}
            if (Z_TYPE(converted) != IS_NULL && kind != NULL) {
                if (read_string_is(kind, "i16") || read_string_is(kind, "i32") || read_string_is(kind, "i64")) {
                    bool numeric;
                    if (!read_is_numeric(&converted, &numeric)) { zval_ptr_dtor(&converted); zval_ptr_dtor(&st); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
                    if (numeric) { zend_long n = zval_get_long(&converted); zval_ptr_dtor(&converted); ZVAL_LONG(&converted, n); }
                } else if (read_string_is(kind, "f64")) {
                    bool numeric;
                    if (!read_is_numeric(&converted, &numeric)) { zval_ptr_dtor(&converted); zval_ptr_dtor(&st); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
                    if (numeric) { double n = zval_get_double(&converted); zval_ptr_dtor(&converted); ZVAL_DOUBLE(&converted, n); }
                } else if (read_string_is(kind, "date") || read_string_is(kind, "datetime")) {
                    zval time;
                    if (!model_time_value_in_zone(&converted, zone, &time)) { zval_ptr_dtor(&converted); zval_ptr_dtor(&st); zval_ptr_dtor(&model); zval_ptr_dtor(&shape); RETURN_THROWS(); }
                    zval_ptr_dtor(&converted); ZVAL_COPY_VALUE(&converted, &time);
                }
            }
            zval *extra_map=read_array(&st,"extra"); if(extra_map!=NULL&&Z_TYPE_P(extra_map)==IS_ARRAY) zend_hash_update(Z_ARRVAL_P(extra_map),Z_STR_P(name),&converted); else zval_ptr_dtor(&converted);
        } ZEND_HASH_FOREACH_END();
    }
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

ZEND_METHOD(Polyspec_Orm_Model, collectionKey)
{
    zval *model, *assemble_decl, *vals;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_OBJECT(model) Z_PARAM_ARRAY(assemble_decl) Z_PARAM_ARRAY(vals) ZEND_PARSE_PARAMETERS_END();
    zval *fetch_key=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"fetch_key");
    if(fetch_key!=NULL&&Z_TYPE_P(fetch_key)==IS_OBJECT){ zval args[1], value;ZVAL_COPY(&args[0],model);ZVAL_UNDEF(&value);zend_result status=call_user_function(EG(function_table),NULL,fetch_key,&value,1,args);zval_ptr_dtor(&args[0]);if(status!=SUCCESS||EG(exception)!=NULL){if(!Z_ISUNDEF(value))zval_ptr_dtor(&value);RETURN_THROWS();}zval keyarg[1],key;ZVAL_COPY(&keyarg[0],&value);zend_class_entry *collection=read_lookup_class("Polyspec\\Orm\\Collection");bool ok=collection!=NULL&&read_static_call(collection,"keyOf",&key,1,keyarg);zval_ptr_dtor(&keyarg[0]);zval_ptr_dtor(&value);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&key);return; }
    zval *key_name=model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)),"key_name");
    if(key_name!=NULL&&Z_TYPE_P(key_name)==IS_STRING&&Z_STRLEN_P(key_name)!=0){ zval *values=model_state_property(model_state_of(Z_OBJ_P(model)),"values"),*row=model_state_property(model_state_of(Z_OBJ_P(model)),"row");zval *value=values!=NULL&&Z_TYPE_P(values)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(values),Z_STR_P(key_name)):NULL;if(value==NULL&&row!=NULL&&Z_TYPE_P(row)==IS_ARRAY){zval *extra=read_array(row,"extra");value=extra!=NULL&&Z_TYPE_P(extra)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(extra),Z_STR_P(key_name)):NULL;}if(value==NULL){read_throw("CODEC_DECODE","collection key is SQL NULL");RETURN_THROWS();}zval arg,key;ZVAL_COPY(&arg,value);zend_class_entry *collection=read_lookup_class("Polyspec\\Orm\\Collection");bool ok=collection!=NULL&&read_static_call(collection,"keyOf",&key,1,&arg);zval_ptr_dtor(&arg);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&key);return; }
    zval *key_index=read_array(assemble_decl,"key");if(key_index==NULL||Z_TYPE_P(key_index)!=IS_ARRAY){read_throw("INTERNAL","collection row has no key declaration");RETURN_THROWS();}
    zval args[2],key;ZVAL_COPY(&args[0],vals);ZVAL_COPY(&args[1],key_index);zend_class_entry *db=read_lookup_class("Polyspec\\Orm\\Db");bool ok=db!=NULL&&read_static_call(db,"rowKey",&key,2,args);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);if(!ok)RETURN_THROWS();if(Z_TYPE(key)==IS_NULL){zval_ptr_dtor(&key);read_throw("CODEC_DECODE","collection row identity contains SQL NULL");RETURN_THROWS();}ZVAL_COPY_VALUE(return_value,&key);
}

ZEND_METHOD(Polyspec_Orm_Model, columnOrExtra)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
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
    array_init(return_value);
    if (matches == NULL || Z_TYPE_P(matches) != IS_ARRAY) return;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(matches), zval *match) {
        zval *column = zend_hash_find(Z_ARRVAL_P(match), side);
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
        if (matches != NULL && Z_TYPE_P(matches) == IS_ARRAY) ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(matches), zval *match) { zval *right=read_array(match,"right"); if(right!=NULL){zval c;ZVAL_COPY(&c,right);add_next_index_zval(&rights,&c);} } ZEND_HASH_FOREACH_END();
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
            SEPARATE_ARRAY(where); zval *items=zend_hash_str_find(Z_ARRVAL_P(where),"items",5);
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
    for(int i=0;i<4;i++)zval_ptr_dtor(&args[i]);if(!Z_ISUNDEF(ctor))zval_ptr_dtor(&ctor);if(!constructed)RETURN_THROWS();
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
    if(zend_string_equals_literal(Z_STR_P(name),"row_count")){ZVAL_COPY(return_value,raw);return;}
    zval meta; if(!read_static_meta(ZEND_THIS,&meta))RETURN_THROWS();
    zval *declared=NULL,*declared_cols=read_array(&meta,"columns"),*source_col=read_array(column,"column");
    if(read_string_is(source_col,Z_STRVAL_P(name))&&declared_cols!=NULL&&Z_TYPE_P(declared_cols)==IS_ARRAY)declared=zend_hash_find(Z_ARRVAL_P(declared_cols),Z_STR_P(name));
    if(Z_TYPE_P(raw)==IS_NULL){if(declared!=NULL&&!read_is_true(declared,"nullable")){zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"group column %s is SQL NULL",Z_STRVAL_P(name));read_throw("CODEC_DECODE",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval_ptr_dtor(&meta);RETURN_NULL();}
    zval value;ZVAL_COPY(&value,raw);if(!read_convert_resource(&value)){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);RETURN_THROWS();}
    if(Z_TYPE(value)==IS_FALSE){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"group column %s could not be read",Z_STRVAL_P(name));read_throw("CODEC_DECODE",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}
    if(declared!=NULL){zval styled_arg[1],styled;ZVAL_COPY(&styled_arg[0],declared);bool ok=read_static_call(polyspec_runtime_model_ce,"styled",&styled,1,styled_arg);zval_ptr_dtor(&styled_arg[0]);if(!ok){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);RETURN_THROWS();}bool is_styled=zend_is_true(&styled);zval_ptr_dtor(&styled);if(is_styled){if(Z_TYPE(value)!=IS_OBJECT||!instanceof_function(Z_OBJCE(value),polyspec_styled_value_ce)){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"group column %s is not StyledValue",Z_STRVAL_P(name));read_throw("CODEC_DECODE",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval_ptr_dtor(&meta);ZVAL_COPY_VALUE(return_value,&value);return;}}
    zval *type=declared!=NULL?read_array(declared,"type"):read_array(column,"type");if(type==NULL||Z_TYPE_P(type)!=IS_STRING){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);read_throw("INTERNAL","group column has no type");RETURN_THROWS();}
    if(read_string_is(type,"i16")||read_string_is(type,"i32")||read_string_is(type,"i64")){zval args[3],rv;ZVAL_COPY(&args[0],&value);ZVAL_COPY(&args[1],type);ZVAL_COPY(&args[2],name);bool ok=read_model_static_call(ZEND_THIS,"groupInteger",&rv,3,args);for(int i=0;i<3;i++)zval_ptr_dtor(&args[i]);zval_ptr_dtor(&value);zval_ptr_dtor(&meta);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&rv);return;}
    if (read_string_is(type, "bool")) {
        bool valid_true = Z_TYPE(value) == IS_TRUE ||
            (Z_TYPE(value) == IS_LONG && Z_LVAL(value) == 1) ||
            (Z_TYPE(value) == IS_STRING && (zend_string_equals_literal(Z_STR(value), "1") ||
                zend_string_equals_literal(Z_STR(value), "t") || zend_string_equals_literal(Z_STR(value), "true")));
        bool valid_false = Z_TYPE(value) == IS_FALSE ||
            (Z_TYPE(value) == IS_LONG && Z_LVAL(value) == 0) ||
            (Z_TYPE(value) == IS_STRING && (zend_string_equals_literal(Z_STR(value), "0") ||
                zend_string_equals_literal(Z_STR(value), "f") || zend_string_equals_literal(Z_STR(value), "false")));
        if (!valid_true && !valid_false) {
            zval_ptr_dtor(&value); zval_ptr_dtor(&meta);
            zend_string *message = strpprintf(0, "group column %s is not boolean", Z_STRVAL_P(name));
            read_throw("CODEC_DECODE", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
        }
        zval_ptr_dtor(&value); zval_ptr_dtor(&meta); RETURN_BOOL(valid_true);
    }
    if(read_string_is(type,"f64")){zval args[2],rv;ZVAL_COPY(&args[0],&value);ZVAL_COPY(&args[1],name);bool ok=read_model_static_call(ZEND_THIS,"groupFloat",&rv,2,args);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);zval_ptr_dtor(&value);zval_ptr_dtor(&meta);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&rv);return;}
    if(read_string_is(type,"decimal")){if(declared==NULL){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"decimal group column %s has no declaration",Z_STRVAL_P(name));read_throw("INTERNAL",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval *precision=read_array(declared,"precision"),*scale=read_array(declared,"scale");zval driver;if(precision==NULL||scale==NULL||!read_call(db,"driver",&driver,0,NULL)){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);RETURN_THROWS();}bool sqlite=Z_TYPE(driver)==IS_STRING&&zend_string_equals_literal(Z_STR(driver),"sqlite");zval_ptr_dtor(&driver);zval args[3],rv;ZVAL_COPY(&args[0],&value);ZVAL_COPY(&args[1],precision);ZVAL_COPY(&args[2],scale);zend_class_entry *decimal=read_lookup_class("Polyspec\\Orm\\Decimal");bool ok=decimal!=NULL&&read_static_call(decimal,sqlite?"fromScaled":"decode",&rv,3,args);for(int i=0;i<3;i++)zval_ptr_dtor(&args[i]);zval_ptr_dtor(&value);zval_ptr_dtor(&meta);if(!ok)RETURN_THROWS();ZVAL_COPY_VALUE(return_value,&rv);return;}
    if(read_string_is(type,"date")||read_string_is(type,"datetime")){zval zone;if(!read_call(db,"zone",&zone,0,NULL)){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);RETURN_THROWS();}bool ok=model_time_value_in_zone(&value,&zone,return_value);zval_ptr_dtor(&zone);zval_ptr_dtor(&value);zval_ptr_dtor(&meta);if(!ok)RETURN_THROWS();return;}
    if(read_string_is(type,"varchar")||read_string_is(type,"text")||read_string_is(type,"time")||read_string_is(type,"uuid")||read_string_is(type,"bytes")){if(Z_TYPE(value)!=IS_STRING){zval_ptr_dtor(&value);zval_ptr_dtor(&meta);zend_string *message=strpprintf(0,"group column %s is not text or bytes",Z_STRVAL_P(name));read_throw("CODEC_DECODE",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval_ptr_dtor(&meta);ZVAL_COPY_VALUE(return_value,&value);return;}
    zend_string *message=strpprintf(0,"group column %s has unsupported type %s",Z_STRVAL_P(name),Z_STRVAL_P(type));zval_ptr_dtor(&value);zval_ptr_dtor(&meta);read_throw("INTERNAL",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, getsCount)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval executor;if(!read_model_call(ZEND_THIS,"executor",&executor,0,NULL))RETURN_THROWS();zval *dbp=zend_hash_index_find(Z_ARRVAL(executor),0),*framep=zend_hash_index_find(Z_ARRVAL(executor),1);if(dbp==NULL||framep==NULL){zval_ptr_dtor(&executor);read_throw("INTERNAL","executor result is incomplete");RETURN_THROWS();}zval db,frame;ZVAL_COPY(&db,dbp);ZVAL_COPY(&frame,framep);
    zval kind,args[2],request;ZVAL_STRING(&kind,"group_count");ZVAL_COPY(&args[0],&kind);ZVAL_COPY(&args[1],&db);if(!read_model_call(ZEND_THIS,"build",&request,2,args)){zval_ptr_dtor(&kind);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);RETURN_THROWS();}zval_ptr_dtor(&kind);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);
    zval *external=read_object_prop(&request,"external");if(external!=NULL&&Z_TYPE_P(external)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(external))!=0){zval_ptr_dtor(&request);zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);read_throw("CONFIG","group count cannot return relations");RETURN_THROWS();}
    zval select_args[2],selected;ZVAL_COPY(&select_args[0],&frame);ZVAL_COPY(&select_args[1],&request);bool ok=read_call(&db,"select",&selected,2,select_args);zval_ptr_dtor(&select_args[0]);zval_ptr_dtor(&select_args[1]);zval_ptr_dtor(&request);zval_ptr_dtor(&executor);zval_ptr_dtor(&frame);if(!ok){zval_ptr_dtor(&db);RETURN_THROWS();}
    zval *plan=zend_hash_index_find(Z_ARRVAL(selected),0),*result=zend_hash_index_find(Z_ARRVAL(selected),1);zval *steps=plan!=NULL?read_array(plan,"steps"):NULL,*step=steps!=NULL&&Z_TYPE_P(steps)==IS_ARRAY?zend_hash_index_find(Z_ARRVAL_P(steps),0):NULL,*assembly=step!=NULL?read_array(step,"assemble"):NULL,*columns=assembly!=NULL?read_array(assembly,"columns"):NULL;
    if(columns==NULL||Z_TYPE_P(columns)!=IS_ARRAY){zval_ptr_dtor(&selected);zval_ptr_dtor(&db);read_throw("INTERNAL","group count has no result declaration");RETURN_THROWS();}
    zval names;array_init(&names);bool has_count=false;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns),zval *column){if(read_is_true(column,"hidden"))continue;zval *name=read_array(column,"name");if(name==NULL||Z_TYPE_P(name)!=IS_STRING||Z_STRLEN_P(name)==0||zend_hash_exists(Z_ARRVAL(names),Z_STR_P(name))){zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);zend_string *message=strpprintf(0,"group result repeats or omits column %s",name!=NULL&&Z_TYPE_P(name)==IS_STRING?Z_STRVAL_P(name):"");read_throw("CONFIG",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval flag;ZVAL_TRUE(&flag);zend_hash_update(Z_ARRVAL(names),Z_STR_P(name),&flag);if(zend_string_equals_literal(Z_STR_P(name),"row_count"))has_count=true;}ZEND_HASH_FOREACH_END();
    if(!has_count){zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);read_throw("INTERNAL","group result has no row_count");RETURN_THROWS();}
    zval rows;array_init(&rows);zval *main=read_array(result,"main");if(main!=NULL&&Z_TYPE_P(main)==IS_ARRAY)ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(main),zval *raw_row){zval entries;array_init(&entries);ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns),zval *column){if(read_is_true(column,"hidden"))continue;zval *idx=read_array(column,"index"),*name=read_array(column,"name");if(idx==NULL||Z_TYPE_P(idx)!=IS_LONG||name==NULL){zval_ptr_dtor(&entries);zval_ptr_dtor(&rows);zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);read_throw("INTERNAL","group result column declaration is incomplete");RETURN_THROWS();}zval *raw=zend_hash_index_find(Z_ARRVAL_P(raw_row),(zend_ulong)Z_LVAL_P(idx));if(raw==NULL){zval_ptr_dtor(&entries);zval_ptr_dtor(&rows);zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);zend_string *message=strpprintf(0,"group result column %s is missing",Z_STRVAL_P(name));read_throw("INTERNAL",ZSTR_VAL(message));zend_string_release(message);RETURN_THROWS();}zval args[3],value;ZVAL_COPY(&args[0],&db);ZVAL_COPY(&args[1],column);ZVAL_COPY(&args[2],raw);if(!read_model_call(ZEND_THIS,"groupValue",&value,3,args)){for(int k=0;k<3;k++)zval_ptr_dtor(&args[k]);zval_ptr_dtor(&entries);zval_ptr_dtor(&rows);zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);RETURN_THROWS();}for(int k=0;k<3;k++)zval_ptr_dtor(&args[k]);zval pair;array_init_size(&pair,2);zval c;ZVAL_COPY(&c,name);add_next_index_zval(&pair,&c);add_next_index_zval(&pair,&value);add_next_index_zval(&entries,&pair);}ZEND_HASH_FOREACH_END();
      zval group_row;object_init_ex(&group_row,polyspec_group_row_ce);zval ctor;zend_call_method(Z_OBJ(group_row),polyspec_group_row_ce,NULL,"__construct",sizeof("__construct")-1,&ctor,1,&entries,NULL);zval_ptr_dtor(&entries);if(!Z_ISUNDEF(ctor))zval_ptr_dtor(&ctor);if(EG(exception)!=NULL){zval_ptr_dtor(&rows);zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);zval_ptr_dtor(&group_row);RETURN_THROWS();}add_next_index_zval(&rows,&group_row);
    }ZEND_HASH_FOREACH_END();
    object_init_ex(return_value,polyspec_group_rows_ce);zval ctor;zend_call_method(Z_OBJ_P(return_value),polyspec_group_rows_ce,NULL,"__construct",sizeof("__construct")-1,&ctor,1,&rows,NULL);zval_ptr_dtor(&rows);if(!Z_ISUNDEF(ctor))zval_ptr_dtor(&ctor);zval_ptr_dtor(&names);zval_ptr_dtor(&selected);zval_ptr_dtor(&db);if(EG(exception)!=NULL)RETURN_THROWS();
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

ZEND_METHOD(Polyspec_Orm_Model, groupInteger)
{
    static const char *const scalar_types[] = {NULL, "string", "string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 3)) RETURN_THROWS();
    zval *raw;
    zend_string *type, *name;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ZVAL(raw)
        Z_PARAM_STR(type)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    zend_long value;
    if (!exact_integer(raw, &value)) {
        zend_string *message = strpprintf(0, "group column %s is not an exact integer", ZSTR_VAL(name));
        read_throw("CODEC_DECODE", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
    }
    if ((zend_string_equals_literal(type, "i32") && (value < INT32_MIN || value > INT32_MAX)) ||
        (zend_string_equals_literal(type, "i16") && (value < INT16_MIN || value > INT16_MAX))) {
        zend_string *message = strpprintf(0, "group column %s exceeds %s range", ZSTR_VAL(name), ZSTR_VAL(type));
        read_throw("CODEC_DECODE", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
    }
    RETURN_LONG(value);
}

ZEND_METHOD(Polyspec_Orm_Model, groupFloat)
{
    static const char *const scalar_types[] = {NULL, "string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zval *raw;
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ZVAL(raw) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    double value;
    int status = exact_number(raw, &value);
    if (status == 0 || status == 2) {
        zend_string *message = strpprintf(0, "group column %s is %s", ZSTR_VAL(name), status == 0 ? "not a number" : "not finite");
        read_throw("CODEC_DECODE", ZSTR_VAL(message)); zend_string_release(message); RETURN_THROWS();
    }
    RETURN_DOUBLE(value);
}

ZEND_METHOD(Polyspec_Orm_Model, aggregateNumber)
{
    zval *raw;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(raw) ZEND_PARSE_PARAMETERS_END();
    double value;
    int status = exact_number(raw, &value);
    if (status == 0) {
        read_throw("CODEC_DECODE", "aggregate scalar is not a finite number");
        RETURN_THROWS();
    }
    if (status == 2) {
        read_throw("CODEC_DECODE", "aggregate scalar is outside finite binary64 range");
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
        for (int i=0;i<2;i++) zval_ptr_dtor(&call_args[i]); zval_ptr_dtor(&request); zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind); RETURN_THROWS();
    }
    zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&call_args[1]);
    zval_ptr_dtor(&request); zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind);
    if (Z_TYPE(result) == IS_LONG) { ZVAL_COPY_VALUE(return_value, &result); return; }
    zend_long count = zval_get_long(&result); zval_ptr_dtor(&result); RETURN_LONG(count);
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
    zval_ptr_dtor(&request); zval_ptr_dtor(&executor); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&kind);
    if (!ok) return false;
    if (Z_TYPE(result) == IS_NULL) { ZVAL_NULL(return_value); zval_ptr_dtor(&result); return true; }
    if (!read_model_static_call(model, "aggregateNumber", return_value, 1, &result)) { zval_ptr_dtor(&result); return false; }
    zval_ptr_dtor(&result);
    return true;
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

ZEND_METHOD(Polyspec_Orm_Model, getsPage)
{
    static const char *const scalar_types[] = {"int", "int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_long page, per_page;
    ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_LONG(page) Z_PARAM_LONG(per_page) ZEND_PARSE_PARAMETERS_END();
    if (page < 1 || per_page < 1) { read_throw("CONFIG", "getsPage requires a positive page and perPage"); RETURN_THROWS(); }
    zval *limit = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "limit");
    if (limit != NULL && Z_TYPE_P(limit) != IS_NULL) { read_throw("CONFIG", "getsPage cannot be combined with limit"); RETURN_THROWS(); }
    zval executor;
    if (!read_model_call(ZEND_THIS, "executor", &executor, 0, NULL)) RETURN_THROWS();
    zval *dbp=zend_hash_index_find(Z_ARRVAL(executor),0),*framep=zend_hash_index_find(Z_ARRVAL(executor),1);
    if(dbp==NULL||framep==NULL){zval_ptr_dtor(&executor);read_throw("INTERNAL","executor result is incomplete");RETURN_THROWS();}
    zval db,frame;ZVAL_COPY(&db,dbp);ZVAL_COPY(&frame,framep);
    zval clone;ZVAL_OBJ(&clone,zend_objects_clone_obj(Z_OBJ_P(ZEND_THIS)));
    if(EG(exception)!=NULL){zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);RETURN_THROWS();}
    zval page_limit;array_init(&page_limit);zval left,right,offset;ZVAL_LONG(&left,page-1);ZVAL_LONG(&right,per_page);mul_function(&offset,&left,&right);add_assoc_zval(&page_limit,"offset",&offset);add_assoc_long(&page_limit,"count",per_page);
    model_state_property_set(model_state_of(Z_OBJ(clone)),"limit",&page_limit);zval_ptr_dtor(&page_limit);
    zval kind,args[2],request;ZVAL_STRING(&kind,"paginate");ZVAL_COPY(&args[0],&kind);ZVAL_COPY(&args[1],&db);
    if(!read_model_call(&clone,"build",&request,2,args)){zval_ptr_dtor(&kind);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);zval_ptr_dtor(&clone);zval_ptr_dtor(&executor);zval_ptr_dtor(&db);zval_ptr_dtor(&frame);RETURN_THROWS();}zval_ptr_dtor(&kind);zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);
    zval paginate_args[2],result;ZVAL_COPY(&paginate_args[0],&frame);ZVAL_COPY(&paginate_args[1],&request);bool ok=read_call(&db,"paginate",&result,2,paginate_args);zval_ptr_dtor(&paginate_args[0]);zval_ptr_dtor(&paginate_args[1]);zval_ptr_dtor(&clone);zval_ptr_dtor(&executor);zval_ptr_dtor(&frame);
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
    for(int i=0;i<5;i++)zval_ptr_dtor(&page_args[i]);if(!Z_ISUNDEF(ctor))zval_ptr_dtor(&ctor);zval_ptr_dtor(&items);zval_ptr_dtor(&request);zval_ptr_dtor(&result);zval_ptr_dtor(&db);if(EG(exception)!=NULL)RETURN_THROWS();
}

/* Remaining methods are declared in model_read.h and are implemented in the next read-slice batches. */
