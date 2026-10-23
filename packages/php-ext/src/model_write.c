/* Native write and CRUD methods for Polyspec\Orm\Model. */
#include "model_write.h"
#include "model_state.h"
#include "model_native_methods.h"
#include "model_dsl.h"
#include "runtime_model.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include <string.h>

static zend_class_entry *creates_callback_ce;
static zend_class_entry *restore_hook_ce;
static zend_class_entry *restore_or_create_callback_ce;
static zend_class_entry *delete_callback_ce;

void model_write_init(zend_class_entry *creates_ce, zend_class_entry *restore_ce,
    zend_class_entry *restore_or_create_ce, zend_class_entry *delete_ce)
{
    creates_callback_ce = creates_ce;
    restore_hook_ce = restore_ce;
    restore_or_create_callback_ce = restore_or_create_ce;
    delete_callback_ce = delete_ce;
}

static zval *model_field(zval *model, const char *field)
{
    return model_state_property(model_state_of(Z_OBJ_P(model)), field);
}

static zval *object_property(zval *object, const char *name)
{
    return zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), 1, &EG(uninitialized_zval));
}

static bool model_call(zval *model, const char *name, zval *result, uint32_t argc, zval *args)
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

static bool model_static_call(zval *model, const char *name, zval *result, uint32_t argc, zval *args)
{
    zend_class_entry *base = model_native_class_entry();
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = zend_hash_find_ptr(&base->function_table, key);
    zend_string_release(key);
    if (fn == NULL) {
        zend_throw_error(NULL, "Native Model helper %s is not registered", name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, NULL, Z_OBJCE_P(model), result, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool dynamic_call(zval *object, const char *name, zval *result, uint32_t argc, zval *args)
{
    zval fn;
    ZVAL_STRING(&fn, name);
    ZVAL_UNDEF(result);
    zend_result status = call_user_function(NULL, object, &fn, result, argc, args);
    zval_ptr_dtor(&fn);
    if (status != SUCCESS && EG(exception) == NULL)
        zend_throw_error(NULL, "Method %s is not callable", name);
    return status == SUCCESS && EG(exception) == NULL;
}

static bool named_call(const char *name, zval *result, uint32_t argc, zval *args)
{
    zval fn;
    ZVAL_STRING(&fn, name);
    ZVAL_UNDEF(result);
    zend_result status = call_user_function(NULL, NULL, &fn, result, argc, args);
    zval_ptr_dtor(&fn);
    if (status != SUCCESS && EG(exception) == NULL)
        zend_throw_error(NULL, "Callable %s is not available", name);
    return status == SUCCESS && EG(exception) == NULL;
}

static void call_result_dtor(zval *result)
{
    if (!Z_ISUNDEF_P(result))
        zval_ptr_dtor(result);
}

static zend_class_entry *lookup_class(const char *name)
{
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static void model_write_throw(const char *code, zend_string *message, zend_object *previous)
{
    if (EG(exception) != NULL) {
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }
    zend_class_entry *ce = lookup_class("Polyspec\\Orm\\OrmException");
    if (ce == NULL || EG(exception) != NULL) {
        if (ce == NULL && EG(exception) == NULL)
            zend_throw_error(NULL, "Class Polyspec\\Orm\\OrmException not found");
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }
    zval exception, fn, args[3], result;
    object_init_ex(&exception, ce);
    if (EG(exception) != NULL) {
        if (!Z_ISUNDEF(exception))
            zval_ptr_dtor(&exception);
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }
    ZVAL_STRING(&fn, "__construct");
    ZVAL_STRING(&args[0], code);
    ZVAL_STR_COPY(&args[1], message);
    uint32_t argc = 2;
    if (previous != NULL) {
        ZVAL_OBJ(&args[2], previous);
        argc = 3;
    }
    ZVAL_UNDEF(&result);
    zend_result status = call_user_function(NULL, &exception, &fn, &result, argc, args);
    zval_ptr_dtor(&fn);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (argc == 3)
        zval_ptr_dtor(&args[2]);
    call_result_dtor(&result);
    if (status != SUCCESS && EG(exception) == NULL)
        zend_throw_error(NULL, "Could not construct Polyspec\\Orm\\OrmException");
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&exception);
        return;
    }
    zend_throw_exception_object(&exception);
}

static void throw_model_error(const char *code, const char *message)
{
    zend_string *text = zend_string_init(message, strlen(message), 0);
    model_write_throw(code, text, NULL);
    zend_string_release(text);
}

static bool model_meta(zval *model, zval *meta)
{
    zend_call_method(NULL, Z_OBJCE_P(model), NULL, "meta", sizeof("meta") - 1, meta, 0, NULL, NULL);
    return EG(exception) == NULL && Z_TYPE_P(meta) == IS_ARRAY;
}

static zval *array_key(zval *array, const char *name)
{
    if (Z_TYPE_P(array) != IS_ARRAY)
        return NULL;
    return zend_hash_str_find(Z_ARRVAL_P(array), name, strlen(name));
}

static zval *array_at(zval *array, zend_ulong index)
{
    if (Z_TYPE_P(array) != IS_ARRAY)
        return NULL;
    return zend_hash_index_find(Z_ARRVAL_P(array), index);
}

static zval *array_at_position(zval *array, zend_ulong position)
{
    if (Z_TYPE_P(array) != IS_ARRAY) return NULL;
    HashPosition cursor;
    zend_hash_internal_pointer_reset_ex(Z_ARRVAL_P(array), &cursor);
    for (zend_ulong i = 0; i <= position; i++) {
        zval *value = zend_hash_get_current_data_ex(Z_ARRVAL_P(array), &cursor);
        if (value == NULL) return NULL;
        if (i == position) return value;
        zend_hash_move_forward_ex(Z_ARRVAL_P(array), &cursor);
    }
    return NULL;
}

static bool request_new(const char *kind, const char *hash, zval *request)
{
    zend_class_entry *ce = lookup_class("Polyspec\\Orm\\Request");
    if (ce == NULL || EG(exception) != NULL)
        return false;
    object_init_ex(request, ce);
    if (EG(exception) != NULL)
        return false;
    zval args[2], ctor;
    ZVAL_STRING(&args[0], kind);
    ZVAL_STRING(&args[1], hash);
    zend_call_method(Z_OBJ_P(request), ce, NULL, "__construct", sizeof("__construct") - 1, &ctor, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    call_result_dtor(&ctor);
    return EG(exception) == NULL;
}

static bool request_param(zval *request, zval *value, zval *index)
{
    return dynamic_call(request, "param", index, 1, value);
}

static bool request_append(zval *request, const char *key, zval *value)
{
    zval *ir = object_property(request, "ir");
    if (ir == NULL || Z_TYPE_P(ir) != IS_ARRAY) {
        zend_throw_error(NULL, "Request::ir must be an array");
        return false;
    }
    SEPARATE_ARRAY(ir);
    zval *list = zend_hash_str_find(Z_ARRVAL_P(ir), key, strlen(key));
    if (list == NULL) {
        zval empty;
        array_init(&empty);
        list = zend_hash_str_update(Z_ARRVAL_P(ir), key, strlen(key), &empty);
    } else {
        SEPARATE_ARRAY(list);
    }
    Z_TRY_ADDREF_P(value);
    return zend_hash_next_index_insert(Z_ARRVAL_P(list), value) != NULL;
}

static bool request_set_ir_value(zval *request, const char *key, zval *value)
{
    zval *ir = object_property(request, "ir");
    if (ir == NULL || Z_TYPE_P(ir) != IS_ARRAY) {
        zend_throw_error(NULL, "Request::ir must be an array");
        return false;
    }
    SEPARATE_ARRAY(ir);
    Z_TRY_ADDREF_P(value);
    zend_hash_str_update(Z_ARRVAL_P(ir), key, strlen(key), value);
    return true;
}

static bool write_of(zval *db, zval *frame, zval *request, zval *after_hook, zval *result)
{
    zval args[3];
    ZVAL_COPY(&args[0], frame);
    ZVAL_COPY(&args[1], request);
    uint32_t argc = 2;
    if (after_hook != NULL) {
        ZVAL_COPY(&args[2], after_hook);
        argc = 3;
    } else {
        ZVAL_NULL(&args[2]);
        argc = 3;
    }
    bool ok = dynamic_call(db, "writeOf", result, argc, args);
    for (uint32_t i = 0; i < argc; i++)
        zval_ptr_dtor(&args[i]);
    return ok;
}

static bool resolve_executor(zval *model, zval *db, zval *frame)
{
    zval result;
    if (!model_call(model, "executor", &result, 0, NULL)) {
        call_result_dtor(&result);
        return false;
    }
    zval *d = array_at(&result, 0), *f = array_at(&result, 1);
    if (d == NULL || Z_TYPE_P(d) != IS_OBJECT || f == NULL) {
        zval_ptr_dtor(&result);
        zend_throw_error(NULL, "Model::executor() returned an invalid pair");
        return false;
    }
    ZVAL_COPY(db, d);
    ZVAL_COPY(frame, f);
    zval_ptr_dtor(&result);
    return true;
}

static bool write_request(zval *model, const char *kind, zval *db, zval *request)
{
    (void)db;
    zval hash, meta;
    if (!model_call(model, "manifestHash", &hash, 0, NULL)) {
        call_result_dtor(&hash);
        return false;
    }
    if (!model_meta(model, &meta)) {
        call_result_dtor(&hash);
        call_result_dtor(&meta);
        return false;
    }
    if (Z_TYPE(hash) != IS_STRING) {
        call_result_dtor(&hash);
        zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Model::manifestHash() must return string");
        return false;
    }
    bool ok = request_new(kind, Z_STRVAL(hash), request);
    if (ok) {
        zval *entity = array_key(&meta, "entity");
        zval *ir = object_property(request, "ir");
        if (entity == NULL || Z_TYPE_P(ir) != IS_ARRAY) {
            zend_throw_error(NULL, "Model metadata or Request::ir is invalid");
            ok = false;
        } else {
            SEPARATE_ARRAY(ir);
            Z_TRY_ADDREF_P(entity);
            zend_hash_str_update(Z_ARRVAL_P(ir), "entity", sizeof("entity") - 1, entity);
        }
    }
    call_result_dtor(&hash);
    zval_ptr_dtor(&meta);
    return ok;
}

static bool encode_value(zval *column, zval *value, zval *result)
{
    zval *codec = array_key(column, "codec");
    if (codec == NULL || Z_TYPE_P(codec) != IS_ARRAY) {
        zend_throw_error(NULL, "Model column codec must be an array");
        return false;
    }
    zval filtered;
    array_init_size(&filtered, zend_hash_num_elements(Z_ARRVAL_P(codec)));
    zval *stage;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(codec), stage) {
        zval arg, host;
        ZVAL_COPY(&arg, stage);
        if (!named_call("Polyspec\\Orm\\Codec::isHostStyle", &host, 1, &arg)) {
            zval_ptr_dtor(&arg);
            zval_ptr_dtor(&filtered);
            call_result_dtor(&host);
            return false;
        }
        zval_ptr_dtor(&arg);
        bool is_host = zend_is_true(&host);
        zval_ptr_dtor(&host);
        if (!is_host) {
            Z_TRY_ADDREF_P(stage);
            add_next_index_zval(&filtered, stage);
        }
    } ZEND_HASH_FOREACH_END();
    if (zend_hash_num_elements(Z_ARRVAL(filtered)) == 0) {
        ZVAL_COPY(result, value);
        zval_ptr_dtor(&filtered);
        return true;
    }
    zend_class_entry *styled_ce = lookup_class("Polyspec\\Orm\\StyledValue");
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&filtered);
        return false;
    }
    if (Z_TYPE_P(value) != IS_OBJECT || styled_ce == NULL || !instanceof_function(Z_OBJCE_P(value), styled_ce)) {
        zval_ptr_dtor(&filtered);
        throw_model_error("CODEC_ENCODE", "styled column requires StyledValue");
        return false;
    }
    zval args[2];
    ZVAL_COPY(&args[0], &filtered);
    ZVAL_COPY(&args[1], value);
    bool ok = named_call("Polyspec\\Orm\\Codec::encode", result, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&filtered);
    return ok;
}

static bool assign_ir(zval *model, zval *request, zend_string *column, zval *spec, zval *result)
{
    zval meta;
    if (!model_meta(model, &meta)) {
        call_result_dtor(&meta);
        return false;
    }
    zval *columns = array_key(&meta, "columns");
    zval *col = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(columns), column) : NULL;
    if (col == NULL) {
        zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Model set refers to a missing metadata column");
        return false;
    }
    array_init_size(result, 3);
    add_assoc_str(result, "column", zend_string_copy(column));
    zval *value;
    if ((value = array_key(spec, "null")) != NULL && Z_TYPE_P(value) != IS_NULL) {
        add_assoc_bool(result, "null", true);
    } else if ((value = array_key(spec, "plus")) != NULL) {
        zval index;
        if (!request_param(request, value, &index)) {
            zval_ptr_dtor(result); ZVAL_UNDEF(result);
            zval_ptr_dtor(&meta);
            call_result_dtor(&index);
            return false;
        }
        add_assoc_zval(result, "plus_p", &index);
    } else if ((value = array_key(spec, "minus")) != NULL) {
        zval index;
        if (!request_param(request, value, &index)) {
            zval_ptr_dtor(result); ZVAL_UNDEF(result);
            zval_ptr_dtor(&meta);
            call_result_dtor(&index);
            return false;
        }
        add_assoc_zval(result, "minus_p", &index);
    } else {
        value = array_key(spec, "value");
        if (value == NULL) {
            zval_ptr_dtor(result); ZVAL_UNDEF(result);
            zval_ptr_dtor(&meta);
            zend_throw_error(NULL, "Model write spec has no value");
            return false;
        }
        zval encoded;
        if (!encode_value(col, value, &encoded)) {
            zval_ptr_dtor(result); ZVAL_UNDEF(result);
            zval_ptr_dtor(&meta);
            call_result_dtor(&encoded);
            return false;
        }
        if (Z_TYPE(encoded) == IS_NULL) {
            add_assoc_bool(result, "null", true);
        } else {
            zval index;
            if (!request_param(request, &encoded, &index)) {
                zval_ptr_dtor(result); ZVAL_UNDEF(result);
                zval_ptr_dtor(&meta);
                zval_ptr_dtor(&encoded);
                call_result_dtor(&index);
                return false;
            }
            add_assoc_zval(result, "p", &index);
        }
        zval_ptr_dtor(&encoded);
    }
    zval_ptr_dtor(&meta);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, writeRequest)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *kind;
    zval *db;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(kind)
        Z_PARAM_OBJECT(db)
    ZEND_PARSE_PARAMETERS_END();
    if (!write_request(ZEND_THIS, ZSTR_VAL(kind), db, return_value))
        RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, assignIr)
{
    static const char *const scalar_types[] = {NULL, "string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 3)) RETURN_THROWS();
    zval *request, *spec;
    zend_string *column;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT(request)
        Z_PARAM_STR(column)
        Z_PARAM_ARRAY(spec)
    ZEND_PARSE_PARAMETERS_END();
    if (!assign_ir(ZEND_THIS, request, column, spec, return_value))
        RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, encodeValue)
{
    zval *column, *value;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(column)
        Z_PARAM_ZVAL(value)
    ZEND_PARSE_PARAMETERS_END();
    if (!encode_value(column, value, return_value))
        RETURN_THROWS();
}

static bool model_column_value(zval *model, zval *column, zval *value, zval *db, zval *result)
{
    zval zone, args[3];
    if (!dynamic_call(db, "zone", &zone, 0, NULL)) {
        call_result_dtor(&zone);
        return false;
    }
    ZVAL_COPY(&args[0], column);
    ZVAL_COPY(&args[1], value);
    ZVAL_COPY(&args[2], &zone);
    bool ok = model_static_call(model, "columnValue", result, 3, args);
    for (size_t i = 0; i < 3; i++)
        zval_ptr_dtor(&args[i]);
    zval_ptr_dtor(&zone);
    return ok;
}

static bool array_has_key(zval *array, zend_string *key)
{
    return Z_TYPE_P(array) == IS_ARRAY && zend_hash_exists(Z_ARRVAL_P(array), key);
}

static bool array_has_string_value(zval *array, zend_string *needle)
{
    if (Z_TYPE_P(array) != IS_ARRAY) return false;
    zval *value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(array), value) {
        if (Z_TYPE_P(value) == IS_STRING && zend_string_equals(Z_STR_P(value), needle)) return true;
    } ZEND_HASH_FOREACH_END();
    return false;
}

static bool model_create(zval *model, zval *result_model)
{
    zval db, frame, meta, request, written;
    ZVAL_UNDEF(&db);
    ZVAL_UNDEF(&frame);
    ZVAL_UNDEF(&meta);
    ZVAL_UNDEF(&request);
    ZVAL_UNDEF(&written);
    if (!resolve_executor(model, &db, &frame))
        goto failed;
    zval *sets = model_field(model, "sets");
    if (sets == NULL || Z_TYPE_P(sets) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(sets)) == 0) {
        throw_model_error("CONFIG", "create requires set<Col> values");
        goto failed;
    }
    if (!model_meta(model, &meta) || !write_request(model, "insert", &db, &request))
        goto failed;

    zend_string *column;
    zval *spec;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(sets), column, spec) {
        if (column == NULL) {
            zend_throw_error(NULL, "Model set columns must have string names");
            goto failed;
        }
        zval item;
        if (!assign_ir(model, &request, column, spec, &item)) {
            call_result_dtor(&item);
            goto failed;
        }
        if (!request_append(&request, "set", &item)) {
            zval_ptr_dtor(&item);
            goto failed;
        }
        zval_ptr_dtor(&item);
    } ZEND_HASH_FOREACH_END();

    zval *duplication = model_field(model, "duplication");
    if (duplication != NULL && Z_TYPE_P(duplication) == IS_OBJECT) {
        zval *dup_sets = model_field((zval *)duplication, "sets");
        if (dup_sets != NULL && Z_TYPE_P(dup_sets) == IS_ARRAY) {
            zend_string *dup_column;
            zval *dup_spec;
            ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(dup_sets), dup_column, dup_spec) {
                if (dup_column == NULL) {
                    zend_throw_error(NULL, "Duplication model set columns must have string names");
                    goto failed;
                }
                zval item;
                if (!assign_ir((zval *)duplication, &request, dup_column, dup_spec, &item)) {
                    call_result_dtor(&item);
                    goto failed;
                }
                if (!request_append(&request, "on_duplicate", &item)) {
                    zval_ptr_dtor(&item);
                    goto failed;
                }
                zval_ptr_dtor(&item);
            } ZEND_HASH_FOREACH_END();
        }
        zval *on_duplicate = array_key(object_property(&request, "ir"), "on_duplicate");
        if (on_duplicate == NULL || Z_TYPE_P(on_duplicate) != IS_ARRAY ||
            zend_hash_num_elements(Z_ARRVAL_P(on_duplicate)) == 0) {
            throw_model_error("CONFIG", "duplication model has no set<Col> values");
            goto failed;
        }
    }

    if (!write_of(&db, &frame, &request, NULL, &written))
        goto failed;
    zval *id = array_at(&written, 0);
    if (!model_call(model, "newRow", result_model, 1, model_field(model, "conn")))
        goto failed;
    if (Z_TYPE_P(result_model) != IS_OBJECT) {
        zend_throw_error(NULL, "Model::newRow() returned an invalid value");
        goto failed;
    }

    zval row, names, hidden, original, extra, related, cascade, flat;
    array_init(&row);
    array_init(&names);
    array_init(&hidden);
    array_init(&original);
    array_init(&extra);
    array_init(&related);
    array_init(&cascade);
    array_init(&flat);
    add_assoc_bool(&row, "loaded", true);
    add_assoc_zval(&row, "names", &names);
    add_assoc_zval(&row, "hidden", &hidden);
    add_assoc_zval(&row, "original", &original);
    add_assoc_zval(&row, "extra", &extra);
    add_assoc_zval(&row, "related", &related);
    add_assoc_zval(&row, "cascade", &cascade);
    add_assoc_zval(&row, "flat", &flat);

    zval *values = model_field(result_model, "values");
    if (values == NULL || Z_TYPE_P(values) != IS_ARRAY) {
        zval_ptr_dtor(&row);
        zend_throw_error(NULL, "Model values state must be an array");
        goto failed;
    }
    model_state_reset(model_state_of(Z_OBJ_P(result_model)), "values");
    values = model_field(result_model, "values");
    zend_string *set_column;
    zval *set_spec;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(sets), set_column, set_spec) {
        if (set_column == NULL)
            continue;
        add_next_index_str(array_key(&row, "names"), zend_string_copy(set_column));
        zval *value = array_key(set_spec, "value");
        if (value != NULL) {
            zval *columns = array_key(&meta, "columns");
            zval *column_meta = columns != NULL ? zend_hash_find(Z_ARRVAL_P(columns), set_column) : NULL;
            zval converted;
            ZVAL_UNDEF(&converted);
            if (column_meta == NULL || !model_column_value(model, column_meta, value, &db, &converted)) {
                zval_ptr_dtor(&row);
                call_result_dtor(&converted);
                goto failed;
            }
            Z_TRY_ADDREF(converted);
            zend_hash_update(Z_ARRVAL_P(values), set_column, &converted);
            zval_ptr_dtor(&converted);
        } else if (array_key(set_spec, "null") != NULL && Z_TYPE_P(array_key(set_spec, "null")) != IS_NULL) {
            zval null_value;
            ZVAL_NULL(&null_value);
            zend_hash_update(Z_ARRVAL_P(values), set_column, &null_value);
        }
    } ZEND_HASH_FOREACH_END();

    zval *identity = array_key(&meta, "identity");
    zend_string *assigned_key = identity != NULL && Z_TYPE_P(identity) == IS_STRING ? Z_STR_P(identity) : NULL;
    if (assigned_key == NULL || ZSTR_LEN(assigned_key) == 0) {
        zval driver;
        if (!dynamic_call(&db, "driver", &driver, 0, NULL)) {
            zval_ptr_dtor(&row);
            call_result_dtor(&driver);
            goto failed;
        }
        zval *pk = array_key(&meta, "pk");
        if (Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR(driver), "markdown") && pk != NULL &&
            Z_TYPE_P(pk) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(pk)) == 1 && id != NULL &&
            Z_TYPE_P(id) != IS_NULL) {
            zval *pk_name = zend_hash_index_find(Z_ARRVAL_P(pk), 0);
            if (pk_name != NULL && Z_TYPE_P(pk_name) == IS_STRING && !array_has_key(sets, Z_STR_P(pk_name)))
                assigned_key = Z_STR_P(pk_name);
        }
        zval_ptr_dtor(&driver);
    }
    if (assigned_key != NULL && ZSTR_LEN(assigned_key) != 0) {
        zval *names_array = array_key(&row, "names");
        bool present = false;
        zval *name;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(names_array), name) {
            if (Z_TYPE_P(name) == IS_STRING && zend_string_equals(Z_STR_P(name), assigned_key)) {
                present = true;
                break;
            }
        } ZEND_HASH_FOREACH_END();
        if (!present)
            add_next_index_str(names_array, zend_string_copy(assigned_key));
        zval *columns = array_key(&meta, "columns");
        zval *column_meta = columns != NULL ? zend_hash_find(Z_ARRVAL_P(columns), assigned_key) : NULL;
        zval null_id;
        if (id == NULL) {
            ZVAL_NULL(&null_id);
            id = &null_id;
        }
        zval converted;
        ZVAL_UNDEF(&converted);
        if (column_meta == NULL || !model_column_value(model, column_meta, id, &db, &converted)) {
            zval_ptr_dtor(&row);
            call_result_dtor(&converted);
            if (id == &null_id)
                zval_ptr_dtor(&null_id);
            goto failed;
        }
        Z_TRY_ADDREF(converted);
        zend_hash_update(Z_ARRVAL_P(values), assigned_key, &converted);
        zval_ptr_dtor(&converted);
        if (id == &null_id)
            zval_ptr_dtor(&null_id);
    }

    zval *pk = array_key(&meta, "pk");
    zval *row_names = array_key(&row, "names");
    zval *row_original = array_key(&row, "original");
    zval *pk_name;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), pk_name) {
        zval *value = Z_TYPE_P(pk_name) == IS_STRING ? zend_hash_find(Z_ARRVAL_P(values), Z_STR_P(pk_name)) : NULL;
        zval current;
        if (value == NULL)
            ZVAL_NULL(&current);
        else
            ZVAL_COPY(&current, value);
        if (Z_TYPE(current) == IS_NULL || (Z_TYPE(current) == IS_LONG && Z_LVAL(current) == 0) ||
            (Z_TYPE(current) == IS_STRING && Z_STRLEN(current) == 0)) {
            zval *loaded = zend_hash_str_find(Z_ARRVAL_P(&row), "loaded", sizeof("loaded") - 1);
            ZVAL_FALSE(loaded);
        }
        if (Z_TYPE_P(pk_name) == IS_STRING) {
            Z_TRY_ADDREF(current);
            zend_hash_update(Z_ARRVAL_P(row_original), Z_STR_P(pk_name), &current);
        }
        zval_ptr_dtor(&current);
    } ZEND_HASH_FOREACH_END();
    (void)row_names;

    model_state_property_set(model_state_of(Z_OBJ_P(result_model)), "row", &row);
    zval_ptr_dtor(&row);
    zval *news = model_field(model, "news");
    if (news != NULL)
        model_state_property_set(model_state_of(Z_OBJ_P(result_model)), "news", news);
    model_state_reset(model_state_of(Z_OBJ_P(model)), "sets");
    model_state_reset(model_state_of(Z_OBJ_P(model)), "duplication");
    zval_ptr_dtor(&db);
    zval_ptr_dtor(&frame);
    zval_ptr_dtor(&meta);
    zval_ptr_dtor(&request);
    zval_ptr_dtor(&written);
    return true;

failed:
    if (Z_TYPE_P(result_model) == IS_OBJECT) {
        zval_ptr_dtor(result_model);
        ZVAL_UNDEF(result_model);
    }
    call_result_dtor(&db);
    call_result_dtor(&frame);
    call_result_dtor(&meta);
    call_result_dtor(&request);
    call_result_dtor(&written);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Model, create)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!model_create(ZEND_THIS, return_value))
        RETURN_THROWS();
}

/* These helpers keep write keys in the same canonical form used by read predicates. */
static bool model_key_values(zval *model, zval *keys)
{
    zval meta;
    if (!model_meta(model, &meta)) {
        call_result_dtor(&meta);
        return false;
    }
    zval *pk = array_key(&meta, "pk");
    zval *row = model_field(model, "row");
    zval *sets = model_field(model, "sets");
    if (pk == NULL || Z_TYPE_P(pk) != IS_ARRAY || sets == NULL || Z_TYPE_P(sets) != IS_ARRAY) {
        zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Model primary-key metadata or sets are invalid");
        return false;
    }
    array_init_size(keys, zend_hash_num_elements(Z_ARRVAL_P(pk)));
    zval *loaded_value = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "loaded") : NULL;
    bool loaded = loaded_value != NULL && zend_is_true(loaded_value);
    zval *name;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), name) {
        if (Z_TYPE_P(name) != IS_STRING) {
            zval_ptr_dtor(keys);
            zval_ptr_dtor(&meta);
            zend_throw_error(NULL, "Model primary-key columns must be strings");
            return false;
        }
        zval *value = NULL;
        if (loaded) {
            zval *original = array_key(row, "original");
            value = original != NULL && Z_TYPE_P(original) == IS_ARRAY
                ? zend_hash_find(Z_ARRVAL_P(original), Z_STR_P(name)) : NULL;
            zval null_value;
            if (value == NULL) { ZVAL_NULL(&null_value); value = &null_value; }
            zval resolved;
            zval arg;
            ZVAL_COPY(&arg, value);
            if (!model_static_call(model, "resolved", &resolved, 1, &arg)) {
                zval_ptr_dtor(&arg);
                zval_ptr_dtor(keys);
                zval_ptr_dtor(&meta);
                call_result_dtor(&resolved);
                return false;
            }
            zval_ptr_dtor(&arg);
            zend_hash_update(Z_ARRVAL_P(keys), Z_STR_P(name), &resolved);
            if (value == &null_value) zval_ptr_dtor(&null_value);
        } else {
            zval *spec = zend_hash_find(Z_ARRVAL_P(sets), Z_STR_P(name));
            value = spec != NULL ? array_key(spec, "value") : NULL;
            if (value == NULL) {
                zval *entity = array_key(&meta, "entity");
                const char *entity_name = entity != NULL && Z_TYPE_P(entity) == IS_STRING
                    ? Z_STRVAL_P(entity) : "Model";
                smart_str message = {0};
                smart_str_append_printf(&message, "%s requires a loaded row or set primary key %s",
                    entity_name, Z_STRVAL_P(name));
                zend_string *text = smart_str_extract(&message);
                throw_model_error("CONFIG", ZSTR_VAL(text));
                zend_string_release(text);
                zval_ptr_dtor(keys);
                zval_ptr_dtor(&meta);
                return false;
            }
            Z_TRY_ADDREF_P(value);
            zend_hash_update(Z_ARRVAL_P(keys), Z_STR_P(name), value);
        }
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&meta);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, keyValues)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!model_key_values(ZEND_THIS, return_value))
        RETURN_THROWS();
}

static bool model_key_where(zval *request, zval *keys)
{
    zval items;
    array_init_size(&items, zend_hash_num_elements(Z_ARRVAL_P(keys)));
    zend_string *column;
    zval *value;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(keys), column, value) {
        if (column == NULL) {
            zval_ptr_dtor(&items);
            zend_throw_error(NULL, "Model primary-key names must be strings");
            return false;
        }
        zval pred, item, index;
        array_init(&pred);
        add_assoc_str(&pred, "column", zend_string_copy(column));
        add_assoc_string(&pred, "op", "eq");
        if (!request_param(request, value, &index)) {
            zval_ptr_dtor(&pred);
            zval_ptr_dtor(&items);
            call_result_dtor(&index);
            return false;
        }
        add_assoc_zval(&pred, "p", &index);
        if (zend_hash_num_elements(Z_ARRVAL(items)) != 0)
            add_assoc_string(&pred, "conn", "and");
        array_init(&item);
        add_assoc_zval(&item, "pred", &pred);
        add_next_index_zval(&items, &item);
    } ZEND_HASH_FOREACH_END();
    zval where;
    array_init(&where);
    add_assoc_zval(&where, "items", &items);
    if (!request_set_ir_value(request, "where", &where)) {
        zval_ptr_dtor(&where);
        return false;
    }
    zval_ptr_dtor(&where);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, keyWhere)
{
    zval *request, *keys;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(request)
        Z_PARAM_ARRAY(keys)
    ZEND_PARSE_PARAMETERS_END();
    if (!model_key_where(request, keys))
        RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Model, withAesColumns)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval meta;
    if (!model_meta(ZEND_THIS, &meta)) {
        call_result_dtor(&meta);
        RETURN_THROWS();
    }
    zval *sets = model_field(ZEND_THIS, "sets");
    zval *version = array_key(&meta, "aes_version");
    if (sets == NULL || Z_TYPE_P(sets) != IS_ARRAY || version == NULL) {
        zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Model AES metadata or sets are invalid");
        RETURN_THROWS();
    }
    ZVAL_COPY(return_value, sets);
    if (Z_TYPE_P(version) == IS_STRING && Z_STRLEN_P(version) == 0) {
        zval_ptr_dtor(&meta);
        return;
    }
    zval *columns = array_key(&meta, "columns");
    bool changed = false;
    bool separated = false;
    zend_string *key;
    ZEND_HASH_FOREACH_STR_KEY(Z_ARRVAL_P(return_value), key) {
        zval *column = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY && key != NULL
            ? zend_hash_find(Z_ARRVAL_P(columns), key) : NULL;
        if (column == NULL) {
            zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);
            zval_ptr_dtor(&meta);
            zend_throw_error(NULL, "Model set references missing column metadata");
            RETURN_THROWS();
        }
        zval arg, encrypted;
        ZVAL_COPY(&arg, column);
        if (!named_call("Polyspec\\Orm\\RuntimeModel::encrypted", &encrypted, 1, &arg)) {
            zval_ptr_dtor(&arg);
            zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);
            zval_ptr_dtor(&meta);
            call_result_dtor(&encrypted);
            RETURN_THROWS();
        }
        zval_ptr_dtor(&arg);
        changed |= zend_is_true(&encrypted);
        zval_ptr_dtor(&encrypted);
    } ZEND_HASH_FOREACH_END();
    if (changed) {
        zval *row = model_field(ZEND_THIS, "row");
        zval *names = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "names") : NULL;
        zend_string *name;
        zval *column;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(columns), name, column) {
            zval arg, encrypted;
            ZVAL_COPY(&arg, column);
            if (!named_call("Polyspec\\Orm\\RuntimeModel::encrypted", &encrypted, 1, &arg)) {
                zval_ptr_dtor(&arg);
                zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);
                zval_ptr_dtor(&meta);
                call_result_dtor(&encrypted);
                RETURN_THROWS();
            }
            zval_ptr_dtor(&arg);
            bool is_encrypted = zend_is_true(&encrypted);
            zval_ptr_dtor(&encrypted);
            if (!is_encrypted || name == NULL || zend_hash_exists(Z_ARRVAL_P(return_value), name))
                continue;
            bool loaded = false;
            if (names != NULL && Z_TYPE_P(names) == IS_ARRAY) {
                zval *loaded_name;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(names), loaded_name) {
                    if (Z_TYPE_P(loaded_name) == IS_STRING && zend_string_equals(Z_STR_P(loaded_name), name)) {
                        loaded = true;
                        break;
                    }
                } ZEND_HASH_FOREACH_END();
            }
            if (!loaded) {
                smart_str message = {0};
                zval *entity = array_key(&meta, "entity");
                smart_str_append_printf(&message, "changing an AES column of %s requires a row loaded with %s",
                    entity != NULL && Z_TYPE_P(entity) == IS_STRING ? Z_STRVAL_P(entity) : "Model", ZSTR_VAL(name));
                zend_string *text = smart_str_extract(&message);
                throw_model_error("CONFIG", ZSTR_VAL(text));
                zend_string_release(text);
                zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);
                zval_ptr_dtor(&meta);
                RETURN_THROWS();
            }
            zval args[1], value, new_spec;
            ZVAL_STR_COPY(&args[0], name);
            if (!model_call(ZEND_THIS, "value", &value, 1, args)) {
                zval_ptr_dtor(&args[0]);
                zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);
                zval_ptr_dtor(&meta);
                call_result_dtor(&value);
                RETURN_THROWS();
            }
            zval_ptr_dtor(&args[0]);
            array_init(&new_spec);
            if (Z_TYPE(value) == IS_NULL)
                add_assoc_bool(&new_spec, "null", true);
            else
                add_assoc_zval(&new_spec, "value", &value);
            if (!separated) {
                SEPARATE_ARRAY(return_value);
                separated = true;
            }
            zend_hash_update(Z_ARRVAL_P(return_value), name, &new_spec);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&meta);
}

static bool model_update(zval *model, bool optimistic, zval *result)
{
    zval db, frame, meta, request, keys, sets, revision, written;
    ZVAL_UNDEF(&db); ZVAL_UNDEF(&frame); ZVAL_UNDEF(&meta); ZVAL_UNDEF(&request);
    ZVAL_UNDEF(&keys); ZVAL_UNDEF(&sets); ZVAL_UNDEF(&revision); ZVAL_UNDEF(&written);
    if (!resolve_executor(model, &db, &frame)) goto failed;
    if (!model_meta(model, &meta)) goto failed;
    if (!write_request(model, "update", &db, &request)) goto failed;
    if (!model_key_values(model, &keys)) goto failed;
    zval *row = model_field(model, "row");
    zval *loaded_zv = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "loaded") : NULL;
    bool loaded = loaded_zv != NULL && zend_is_true(loaded_zv);
    zval *expected = model_field(model, "expectedRevision");
    bool has_expected = expected != NULL && Z_TYPE_P(expected) == IS_ARRAY;
    zval aes_arg;
    ZVAL_UNDEF(&aes_arg);
    if (!model_call(model, "withAesColumns", &sets, 0, NULL)) goto failed;
    if (Z_TYPE(sets) != IS_ARRAY) {
        zend_throw_error(NULL, "Model::withAesColumns() must return array");
        goto failed;
    }
    zend_string *column;
    zval *spec;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(sets), column, spec) {
        if (column == NULL) {
            zend_throw_error(NULL, "Model set columns must have string names");
            goto failed;
        }
        zval *pk = array_key(&meta, "pk");
        if (!loaded && pk != NULL && array_has_string_value(pk, column))
            continue;
        zval item;
        if (!assign_ir(model, &request, column, spec, &item)) {
            call_result_dtor(&item);
            goto failed;
        }
        if (!request_append(&request, "set", &item)) {
            zval_ptr_dtor(&item);
            goto failed;
        }
        zval_ptr_dtor(&item);
    } ZEND_HASH_FOREACH_END();
    zval *ir = object_property(&request, "ir");
    zval *set_list = array_key(ir, "set");
    if ((set_list == NULL || Z_TYPE_P(set_list) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(set_list)) == 0)
        && !has_expected) {
        ZVAL_OBJ_COPY(result, Z_OBJ_P(model));
        goto success;
    }
    if (!model_key_where(&request, &keys)) goto failed;
    zval guard_args[3];
    ZVAL_COPY(&guard_args[0], &request);
    ZVAL_TRUE(&guard_args[1]);
    ZVAL_BOOL(&guard_args[2], optimistic);
    if (!model_call(model, "revisionGuard", &revision, 3, guard_args)) {
        for (int i = 0; i < 3; i++) zval_ptr_dtor(&guard_args[i]);
        goto failed;
    }
    for (int i = 0; i < 3; i++) zval_ptr_dtor(&guard_args[i]);
    if (optimistic) {
        zval *updated = array_key(&meta, "updated");
        zval *original = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "original") : NULL;
        zval *raw = loaded && updated != NULL && Z_TYPE_P(updated) == IS_STRING && original != NULL
            && Z_TYPE_P(original) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(original), Z_STR_P(updated)) : NULL;
        if (raw == NULL || Z_TYPE_P(raw) == IS_NULL) {
            throw_model_error("CONFIG", "update(true) requires a row loaded with its update time column");
            goto failed;
        }
        zval formatted;
        zend_class_entry *pending_ce = lookup_class("Polyspec\\Orm\\PendingTime");
        if (pending_ce != NULL && Z_TYPE_P(raw) == IS_OBJECT && instanceof_function(Z_OBJCE_P(raw), pending_ce)) {
            zval *text = object_property(raw, "text");
            if (Z_TYPE_P(text) != IS_STRING) {
                throw_model_error("CONFIG", "update(true) requires a row loaded with its update time column");
                goto failed;
            }
            ZVAL_COPY(&formatted, text);
        } else if (Z_TYPE_P(raw) == IS_OBJECT) {
            zval resolved_arg, resolved;
            ZVAL_COPY(&resolved_arg, raw);
            if (!model_static_call(model, "resolved", &resolved, 1, &resolved_arg)) {
                zval_ptr_dtor(&resolved_arg); call_result_dtor(&resolved); goto failed;
            }
            zval_ptr_dtor(&resolved_arg);
            zval args[1], zone, changed, format_arg;
            zend_class_entry *zone_ce = lookup_class("DateTimeZone");
            if (zone_ce == NULL) goto failed;
            object_init_ex(&zone, zone_ce);
            ZVAL_STRING(&args[0], "UTC");
            zend_call_method(Z_OBJ(zone), zone_ce, NULL, "__construct", sizeof("__construct") - 1,
                NULL, 1, &args[0], NULL);
            zval_ptr_dtor(&args[0]);
            if (EG(exception) != NULL) { zval_ptr_dtor(&zone); goto failed; }
            ZVAL_COPY(&args[0], &zone);
            bool ok = dynamic_call(&resolved, "setTimezone", &changed, 1, args);
            zval_ptr_dtor(&args[0]); zval_ptr_dtor(&zone);
            zval_ptr_dtor(&resolved);
            if (!ok) { call_result_dtor(&changed); goto failed; }
            ZVAL_STRING(&format_arg, "Y-m-d H:i:s.u");
            ok = dynamic_call(&changed, "format", &formatted, 1, &format_arg);
            zval_ptr_dtor(&format_arg); zval_ptr_dtor(&changed);
            if (!ok) { call_result_dtor(&formatted); goto failed; }
        } else {
            ZVAL_COPY(&formatted, raw);
        }
        zval index;
        if (!request_param(&request, &formatted, &index)) {
            zval_ptr_dtor(&formatted); call_result_dtor(&index); goto failed;
        }
        zval optimistic_node;
        array_init(&optimistic_node);
        if (updated != NULL) { Z_TRY_ADDREF_P(updated); add_assoc_zval(&optimistic_node, "column", updated); }
        add_assoc_zval(&optimistic_node, "p", &index);
        request_set_ir_value(&request, "optimistic", &optimistic_node);
        zval_ptr_dtor(&optimistic_node); zval_ptr_dtor(&formatted);
    }
    if (!write_of(&db, &frame, &request, NULL, &written)) goto failed;
    zval *affected = array_at(&written, 1);
    if (Z_TYPE(revision) == IS_STRING && affected != NULL && Z_TYPE_P(affected) == IS_LONG && Z_LVAL_P(affected) == 0) {
        smart_str message = {0};
        zval *expected_revision = model_field(model, "expectedRevision");
        zval *expected_value = expected_revision != NULL && Z_TYPE_P(expected_revision) == IS_ARRAY
            ? array_at(expected_revision, 1) : NULL;
        if (expected_value != NULL && Z_TYPE_P(expected_value) == IS_LONG)
            smart_str_append_printf(&message, "the row's %s is not " ZEND_LONG_FMT, Z_STRVAL(revision), Z_LVAL_P(expected_value));
        else
            smart_str_append_printf(&message, "the row's %s is not the expected revision", Z_STRVAL(revision));
        zend_string *text = smart_str_extract(&message);
        throw_model_error("REVISION_CHANGED", ZSTR_VAL(text)); zend_string_release(text);
        goto failed;
    }
    model_state_reset(model_state_of(Z_OBJ_P(model)), "expectedRevision");
    if (loaded) {
        SEPARATE_ARRAY(row);
        row = model_field(model, "row");
        zval *pk = array_key(&meta, "pk");
        zval *original = array_key(row, "original");
        if (original != NULL && Z_TYPE_P(original) == IS_ARRAY) SEPARATE_ARRAY(original);
        zend_string *set_column;
        zval *set_spec;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(model_field(model, "sets")), set_column, set_spec) {
            if (set_column == NULL || pk == NULL || !array_has_string_value(pk, set_column)) continue;
            zval *new_value = array_key(set_spec, "value");
            if (new_value == NULL) continue;
            Z_TRY_ADDREF_P(new_value);
            zend_hash_update(Z_ARRVAL_P(original), set_column, new_value);
        } ZEND_HASH_FOREACH_END();
        zval *updated = array_key(&meta, "updated");
        if (updated != NULL && Z_TYPE_P(updated) == IS_STRING)
            zend_hash_del(Z_ARRVAL_P(original), Z_STR_P(updated));
    }
    model_state_reset(model_state_of(Z_OBJ_P(model)), "sets");
    ZVAL_OBJ_COPY(result, Z_OBJ_P(model));
success:
    call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&request);
    call_result_dtor(&keys); call_result_dtor(&sets); call_result_dtor(&revision); call_result_dtor(&written);
    return true;
failed:
    call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&request);
    call_result_dtor(&keys); call_result_dtor(&sets); call_result_dtor(&revision); call_result_dtor(&written);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Model, update)
{
    static const char *const scalar_types[] = {"bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    bool optimistic = false;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_BOOL(optimistic) ZEND_PARSE_PARAMETERS_END();
    if (!model_update(ZEND_THIS, optimistic, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, save)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval db, frame, meta;
    ZVAL_UNDEF(&db); ZVAL_UNDEF(&frame); ZVAL_UNDEF(&meta);
    if (!resolve_executor(ZEND_THIS, &db, &frame)) RETURN_THROWS();
    if (!model_meta(ZEND_THIS, &meta)) {
        call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); RETURN_THROWS();
    }
    zval *row = model_field(ZEND_THIS, "row");
    zval *loaded_value = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "loaded") : NULL;
    bool keyed = loaded_value != NULL && zend_is_true(loaded_value);
    zval *pk = array_key(&meta, "pk"), *sets = model_field(ZEND_THIS, "sets");
    if (!keyed && pk != NULL && Z_TYPE_P(pk) == IS_ARRAY && sets != NULL && Z_TYPE_P(sets) == IS_ARRAY) {
        keyed = zend_hash_num_elements(Z_ARRVAL_P(pk)) > 0;
        zval *name;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), name) {
            zval *spec = Z_TYPE_P(name) == IS_STRING ? zend_hash_find(Z_ARRVAL_P(sets), Z_STR_P(name)) : NULL;
            if (spec == NULL || array_key(spec, "value") == NULL) { keyed = false; break; }
        } ZEND_HASH_FOREACH_END();
    }
    call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta);
    if (keyed) {
        zval arg;
        ZVAL_FALSE(&arg);
        zend_call_method(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "update", sizeof("update") - 1,
            return_value, 1, &arg, NULL);
    } else {
        zend_call_method(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "create", sizeof("create") - 1,
            return_value, 0, NULL, NULL);
    }
    if (EG(exception) != NULL) RETURN_THROWS();
}

static void callback_property(zval *object, const char *name, zval *value)
{
    zend_update_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), value);
}

static zval *callback_field(zval *object, const char *name)
{
    return zend_read_property(Z_OBJCE_P(object), Z_OBJ_P(object), name, strlen(name), 1, NULL);
}

static bool make_native_closure(zval *callback, zval *closure)
{
    zval arg;
    ZVAL_COPY(&arg, callback);
    bool ok = named_call("Closure::fromCallable", closure, 1, &arg);
    zval_ptr_dtor(&arg);
    if (ok && Z_TYPE_P(closure) != IS_OBJECT) {
        call_result_dtor(closure);
        zend_throw_error(NULL, "Closure::fromCallable() did not return a Closure");
        return false;
    }
    return ok;
}

static bool creates_callback_run(zval *callback)
{
    zval *model = callback_field(callback, "model");
    zval *rows = callback_field(callback, "rows");
    zval *columns = callback_field(callback, "columns");
    zval *parts = callback_field(callback, "parts");
    zval *offset_zv = callback_field(callback, "offset");
    zval *total_zv = callback_field(callback, "total");
    zval *conn = model_field(model, "conn");
    if (Z_TYPE_P(rows) != IS_ARRAY || Z_TYPE_P(columns) != IS_ARRAY || Z_TYPE_P(parts) != IS_ARRAY ||
        Z_TYPE_P(offset_zv) != IS_LONG || Z_TYPE_P(total_zv) != IS_LONG) {
        zend_throw_error(NULL, "ModelCreatesCallback context is invalid");
        return false;
    }
    zval *part;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(parts), part) {
        if (Z_TYPE_P(part) != IS_LONG || Z_LVAL_P(part) < 1) {
            zend_throw_error(NULL, "ModelCreatesCallback batch size is invalid");
            return false;
        }
        zend_long start = Z_LVAL_P(offset_zv), size = Z_LVAL_P(part);
        zval resolved[2], resolve_args[1];
        ZVAL_COPY(&resolve_args[0], conn);
        if (!named_call("Polyspec\\Orm\\Db::resolve", &resolved[0], 1, resolve_args)) {
            zval_ptr_dtor(&resolve_args[0]); call_result_dtor(&resolved[0]); return false;
        }
        zval_ptr_dtor(&resolve_args[0]);
        zval *db = array_at(&resolved[0], 0), *frame = array_at(&resolved[0], 1);
        if (db == NULL || Z_TYPE_P(db) != IS_OBJECT || frame == NULL) {
            zval_ptr_dtor(&resolved[0]);
            zend_throw_error(NULL, "Db::resolve() returned an invalid pair");
            return false;
        }
        zval write_args[2], request;
        ZVAL_STRING(&write_args[0], "insert"); ZVAL_COPY(&write_args[1], db);
        bool ok = model_call(model, "writeRequest", &request, 2, write_args);
        zval_ptr_dtor(&write_args[0]); zval_ptr_dtor(&write_args[1]);
        if (!ok) { zval_ptr_dtor(&resolved[0]); call_result_dtor(&request); return false; }
        for (zend_long i = 0; i < size; i++) {
            zval *row = array_at_position(rows, start + i);
            if (row == NULL || Z_TYPE_P(row) != IS_OBJECT) {
                zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request);
                zend_throw_error(NULL, "ModelCreatesCallback row is invalid"); return false;
            }
            zval *row_sets = model_field(row, "sets");
            zval params; array_init_size(&params, zend_hash_num_elements(Z_ARRVAL_P(columns)));
            zval *column;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
                zval *spec = column != NULL && Z_TYPE_P(column) == IS_STRING && row_sets != NULL && Z_TYPE_P(row_sets) == IS_ARRAY
                    ? zend_hash_find(Z_ARRVAL_P(row_sets), Z_STR_P(column)) : NULL;
                if (spec == NULL) {
                    zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request);
                    zend_throw_error(NULL, "ModelCreatesCallback row lost a declared set column"); return false;
                }
                zval value;
                zval *null_spec = array_key(spec, "null");
                if (null_spec != NULL && Z_TYPE_P(null_spec) != IS_NULL) ZVAL_NULL(&value);
                else {
                    zval *raw = array_key(spec, "value");
                    if (raw == NULL) {
                        zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request);
                        zend_throw_error(NULL, "ModelCreatesCallback accepts stored values only"); return false;
                    }
                    zval *meta = callback_field(callback, "meta");
                    zval *col_map = array_key(meta, "columns");
                    zval *col_meta = col_map != NULL ? zend_hash_find(Z_ARRVAL_P(col_map), Z_STR_P(column)) : NULL;
                    zval args[2];
                    if (col_meta == NULL) { zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request); zend_throw_error(NULL, "ModelCreatesCallback column metadata is missing"); return false; }
                    ZVAL_COPY(&args[0], col_meta); ZVAL_COPY(&args[1], raw);
                    ok = model_static_call(model, "encodeValue", &value, 2, args);
                    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
                    if (!ok) { zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request); call_result_dtor(&value); return false; }
                }
                zval index;
                if (!request_param(&request, &value, &index)) {
                    zval_ptr_dtor(&value); zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request); call_result_dtor(&index); return false;
                }
                zval_ptr_dtor(&value);
                if (i == 0) {
                    zval item; array_init(&item);
                    Z_TRY_ADDREF_P(column); add_assoc_zval(&item, "column", column);
                    add_assoc_zval(&item, "p", &index);
                    if (!request_append(&request, "set", &item)) { zval_ptr_dtor(&item); zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request); return false; }
                    zval_ptr_dtor(&item);
                } else add_next_index_zval(&params, &index);
            } ZEND_HASH_FOREACH_END();
            if (i > 0 && !request_append(&request, "rows", &params)) {
                zval_ptr_dtor(&params); zval_ptr_dtor(&resolved[0]); zval_ptr_dtor(&request); return false;
            }
            zval_ptr_dtor(&params);
        }
        zval written;
        if (!write_of(db, frame, &request, NULL, &written)) {
            zval_ptr_dtor(&request); zval_ptr_dtor(&resolved[0]); call_result_dtor(&written); return false;
        }
        zval *affected = array_at(&written, 1);
        if (affected == NULL || Z_TYPE_P(affected) != IS_LONG) {
            zval_ptr_dtor(&written); zval_ptr_dtor(&request); zval_ptr_dtor(&resolved[0]);
            zend_throw_error(NULL, "Db::writeOf() returned an invalid affected-row count"); return false;
        }
        zend_long affected_count = Z_LVAL_P(affected);
        zval_ptr_dtor(&written); zval_ptr_dtor(&request); zval_ptr_dtor(&resolved[0]);
        zval next; ZVAL_LONG(&next, start + size); callback_property(callback, "offset", &next);
        ZVAL_LONG(&next, Z_LVAL_P(total_zv) + affected_count);
        callback_property(callback, "total", &next);
    } ZEND_HASH_FOREACH_END();
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_ModelCreatesCallback, __invoke)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!creates_callback_run(ZEND_THIS)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, creates)
{
    static const char *const scalar_types[] = {NULL, "int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zval *rows; zend_long batch;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ARRAY(rows) Z_PARAM_LONG(batch) ZEND_PARSE_PARAMETERS_END();
    if (batch < 1) {
        smart_str msg = {0}; smart_str_append_printf(&msg, "creates batch must be a positive integer, got " ZEND_LONG_FMT, batch);
        zend_string *text = smart_str_extract(&msg); throw_model_error("CONFIG", ZSTR_VAL(text)); zend_string_release(text); RETURN_THROWS();
    }
    zval db, frame, meta;
    ZVAL_UNDEF(&db); ZVAL_UNDEF(&frame); ZVAL_UNDEF(&meta);
    if (!resolve_executor(ZEND_THIS, &db, &frame)) RETURN_THROWS();
    if (zend_hash_num_elements(Z_ARRVAL_P(rows)) == 0) { ZVAL_LONG(return_value, 0); call_result_dtor(&db); call_result_dtor(&frame); return; }
    zval *first = zend_hash_index_find(Z_ARRVAL_P(rows), 0);
    if (first == NULL || Z_TYPE_P(first) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(first), Z_OBJCE_P(ZEND_THIS))) {
        call_result_dtor(&db); call_result_dtor(&frame); throw_model_error("CONFIG", "creates requires models with set<Col> values"); RETURN_THROWS();
    }
    zval *first_sets = model_field(first, "sets");
    if (first_sets == NULL || Z_TYPE_P(first_sets) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(first_sets)) == 0) {
        call_result_dtor(&db); call_result_dtor(&frame); throw_model_error("CONFIG", "creates requires models with set<Col> values"); RETURN_THROWS();
    }
    zval columns; array_init_size(&columns, zend_hash_num_elements(Z_ARRVAL_P(first_sets)));
    zend_string *key; zval *spec;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(first_sets), key, spec) {
        (void)spec;
        if (key == NULL) { zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); throw_model_error("CONFIG", "every model of creates must set the same columns in the same order"); RETURN_THROWS(); }
        add_next_index_str(&columns, zend_string_copy(key));
    } ZEND_HASH_FOREACH_END();
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        zval *sets = Z_TYPE_P(row) == IS_OBJECT ? model_field(row, "sets") : NULL;
        if (Z_TYPE_P(row) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(row), Z_OBJCE_P(ZEND_THIS)) || sets == NULL ||
            Z_TYPE_P(sets) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(sets)) != zend_hash_num_elements(Z_ARRVAL_P(first_sets))) {
            zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); throw_model_error("CONFIG", "every model of creates must set the same columns in the same order"); RETURN_THROWS();
        }
        zend_string *set_key; zval *set_spec; uint32_t index = 0;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(sets), set_key, set_spec) {
            zval *column = zend_hash_index_find(Z_ARRVAL(columns), index++);
            if (set_key == NULL || column == NULL || Z_TYPE_P(column) != IS_STRING || !zend_string_equals(Z_STR_P(column), set_key)) {
                zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); throw_model_error("CONFIG", "every model of creates must set the same columns in the same order"); RETURN_THROWS();
            }
            if (array_key(set_spec, "value") == NULL && (array_key(set_spec, "null") == NULL || Z_TYPE_P(array_key(set_spec, "null")) == IS_NULL)) {
                zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); throw_model_error("CONFIG", "creates accepts stored values only"); RETURN_THROWS();
            }
        } ZEND_HASH_FOREACH_END();
    } ZEND_HASH_FOREACH_END();
    if (!model_meta(ZEND_THIS, &meta)) { zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); RETURN_THROWS(); }
    zval driver, limit_arg, limit, parts_args[2], parts;
    if (!dynamic_call(&db, "driver", &driver, 0, NULL)) { zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&driver); RETURN_THROWS(); }
    ZVAL_COPY(&limit_arg, &driver);
    if (!named_call("Polyspec\\Orm\\Db::bindLimit", &limit, 1, &limit_arg)) { zval_ptr_dtor(&limit_arg); zval_ptr_dtor(&driver); zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&limit); RETURN_THROWS(); }
    zval_ptr_dtor(&limit_arg);
    ZVAL_LONG(&parts_args[0], zend_hash_num_elements(Z_ARRVAL_P(rows))); ZVAL_LONG(&parts_args[1], batch);
    if (!named_call("Polyspec\\Orm\\Db::insertParts", &parts, 2, parts_args)) { zval_ptr_dtor(&driver); zval_ptr_dtor(&limit); zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&parts); RETURN_THROWS(); }
    zend_long i = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(parts), spec) {
        zend_long binds = Z_LVAL_P(spec) * zend_hash_num_elements(Z_ARRVAL(columns));
        if (binds > Z_LVAL(limit)) {
            smart_str msg = {0}; smart_str_append_printf(&msg, "creates batch " ZEND_LONG_FMT " of " ZEND_LONG_FMT " rows binds " ZEND_LONG_FMT " parameters, over the %s limit of " ZEND_LONG_FMT, ++i, Z_LVAL_P(spec), binds, Z_STRVAL(driver), Z_LVAL(limit));
            zend_string *text = smart_str_extract(&msg); throw_model_error("BATCH_TOO_LARGE", ZSTR_VAL(text)); zend_string_release(text);
            zval_ptr_dtor(&driver); zval_ptr_dtor(&limit); zval_ptr_dtor(&parts); zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); zval_ptr_dtor(&meta); RETURN_THROWS();
        }
        i++;
    } ZEND_HASH_FOREACH_END();
    zend_class_entry *ce = creates_callback_ce;
    if (ce == NULL) { zval_ptr_dtor(&driver); zval_ptr_dtor(&limit); zval_ptr_dtor(&parts); zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); zval_ptr_dtor(&meta); zend_throw_error(NULL, "ModelCreatesCallback is not registered"); RETURN_THROWS(); }
    zval callback, closure; object_init_ex(&callback, ce);
    callback_property(&callback, "model", ZEND_THIS); callback_property(&callback, "rows", rows);
    callback_property(&callback, "columns", &columns); callback_property(&callback, "meta", &meta);
    callback_property(&callback, "parts", &parts);
    if (EG(exception) != NULL || !make_native_closure(&callback, &closure)) {
        zval_ptr_dtor(&callback); call_result_dtor(&closure); zval_ptr_dtor(&driver); zval_ptr_dtor(&limit); zval_ptr_dtor(&parts); zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); zval_ptr_dtor(&meta); RETURN_THROWS();
    }
    zval txn_args[2], txn_result;
    zval *conn = model_field(ZEND_THIS, "conn"); ZVAL_COPY(&txn_args[0], conn); ZVAL_COPY(&txn_args[1], &closure);
    bool txn_ok = named_call("Polyspec\\Orm\\Db::inTransaction", &txn_result, 2, txn_args);
    zval_ptr_dtor(&txn_args[0]); zval_ptr_dtor(&txn_args[1]); call_result_dtor(&txn_result); zval_ptr_dtor(&closure);
    if (txn_ok && EG(exception) == NULL) ZVAL_LONG(return_value, Z_LVAL_P(callback_field(&callback, "total")));
    zval_ptr_dtor(&callback); zval_ptr_dtor(&driver); zval_ptr_dtor(&limit); zval_ptr_dtor(&parts); zval_ptr_dtor(&columns); call_result_dtor(&db); call_result_dtor(&frame); zval_ptr_dtor(&meta);
    if (!txn_ok || EG(exception) != NULL) RETURN_THROWS();
}

static bool restore_key_value(zval *model, zval *request, zval *own, zend_string *column, zval *value)
{
    zval *ir = object_property(request, "ir");
    zval *sets = model_field(model, "sets");
    zval *params = object_property(request, "params");
    zval *set_list = array_key(ir, "set");
    if (set_list != NULL && Z_TYPE_P(set_list) == IS_ARRAY) {
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(set_list), item) {
            zval *item_column = array_key(item, "column"), *index = array_key(item, "p");
            if (item_column == NULL || Z_TYPE_P(item_column) != IS_STRING || !zend_string_equals(Z_STR_P(item_column), column) || index == NULL || Z_TYPE_P(index) != IS_LONG)
                continue;
            zval *owner_column = zend_hash_index_find(Z_ARRVAL_P(own), Z_LVAL_P(index));
            if (owner_column != NULL && Z_TYPE_P(owner_column) == IS_STRING && zend_string_equals(Z_STR_P(owner_column), column)) {
                zval *spec = sets != NULL && Z_TYPE_P(sets) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(sets), column) : NULL;
                zval *raw = spec != NULL ? array_key(spec, "value") : NULL;
                if (raw == NULL) break;
                ZVAL_COPY(value, raw); return true;
            }
            zval *raw = params != NULL && Z_TYPE_P(params) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(params), Z_LVAL_P(index)) : NULL;
            if (raw != NULL) { ZVAL_COPY(value, raw); return true; }
        } ZEND_HASH_FOREACH_END();
    }
    zval *where = array_key(ir, "where"), *items = array_key(where, "items");
    if (items != NULL && Z_TYPE_P(items) == IS_ARRAY) {
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(items), item) {
            zval *pred = array_key(item, "pred");
            zval *item_column = array_key(pred, "column"), *op = array_key(pred, "op"), *index = array_key(pred, "p");
            if (item_column == NULL || Z_TYPE_P(item_column) != IS_STRING || !zend_string_equals(Z_STR_P(item_column), column) ||
                op == NULL || Z_TYPE_P(op) != IS_STRING || !zend_string_equals_literal(Z_STR_P(op), "eq") ||
                index == NULL || Z_TYPE_P(index) != IS_LONG || array_key(pred, "fn") != NULL || array_key(pred, "value") != NULL ||
                array_key(pred, "ref") != NULL || array_key(pred, "sub") != NULL) continue;
            zval *raw = params != NULL && Z_TYPE_P(params) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(params), Z_LVAL_P(index)) : NULL;
            if (raw != NULL) { ZVAL_COPY(value, raw); return true; }
        } ZEND_HASH_FOREACH_END();
    }
    smart_str message = {0}; smart_str_append_printf(&message, "restore key column %s has no value in the request", ZSTR_VAL(column));
    zend_string *text = smart_str_extract(&message); throw_model_error("INTERNAL", ZSTR_VAL(text)); zend_string_release(text);
    return false;
}

ZEND_METHOD(Polyspec_Orm_ModelRestoreHook, __invoke)
{
    zval *hooked;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(hooked) ZEND_PARSE_PARAMETERS_END();
    zval *model = callback_field(ZEND_THIS, "model"), *own = callback_field(ZEND_THIS, "own");
    zval *ir = object_property(hooked, "ir");
    zval meta, args[2], selected;
    ZVAL_UNDEF(&meta); ZVAL_UNDEF(&selected);
    if (!model_meta(model, &meta)) { call_result_dtor(&meta); RETURN_THROWS(); }
    ZVAL_COPY(&args[0], &meta); ZVAL_COPY(&args[1], ir);
    bool ok = named_call("Polyspec\\Orm\\Validator::restoreKey", &selected, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&meta);
    if (!ok) { call_result_dtor(&selected); RETURN_THROWS(); }
    zval *key = array_key(&selected, "key");
    if (key == NULL || Z_TYPE_P(key) != IS_ARRAY) {
        zval_ptr_dtor(&selected); zend_throw_error(NULL, "Validator::restoreKey() returned an invalid key"); RETURN_THROWS();
    }
    zval keys, values; array_init_size(&keys, zend_hash_num_elements(Z_ARRVAL_P(key))); array_init_size(&values, zend_hash_num_elements(Z_ARRVAL_P(key)));
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(key), column) {
        if (Z_TYPE_P(column) != IS_STRING) {
            zval_ptr_dtor(&keys); zval_ptr_dtor(&values); zval_ptr_dtor(&selected);
            zend_throw_error(NULL, "Validator restore key names must be strings"); RETURN_THROWS();
        }
        zval node; array_init(&node);
        add_assoc_string(&node, "conn", zend_hash_num_elements(Z_ARRVAL(keys)) == 0 ? "" : "and");
        add_assoc_string(&node, "op", ""); Z_TRY_ADDREF_P(column); add_assoc_zval(&node, "column", column);
        zval empty; array_init(&empty); add_assoc_zval(&node, "columns", &empty); add_assoc_string(&node, "compare", "");
        add_next_index_zval(&keys, &node);
        zval value;
        if (!restore_key_value(model, hooked, own, Z_STR_P(column), &value)) {
            zval_ptr_dtor(&keys); zval_ptr_dtor(&values); zval_ptr_dtor(&selected); RETURN_THROWS();
        }
        add_next_index_zval(&values, &value);
    } ZEND_HASH_FOREACH_END();
    callback_property(ZEND_THIS, "keys", &keys); callback_property(ZEND_THIS, "args", &values);
    zval_ptr_dtor(&keys); zval_ptr_dtor(&values); zval_ptr_dtor(&selected);
}

static bool model_restore_step(zval *model, zval *restored_count, zval *query)
{
    zval db, frame, request, own;
    ZVAL_UNDEF(&db); ZVAL_UNDEF(&frame); ZVAL_UNDEF(&request); ZVAL_UNDEF(&own);
    if (!resolve_executor(model, &db, &frame)) goto failed;
    zval build_args[2]; ZVAL_STRING(&build_args[0], "restore"); ZVAL_COPY(&build_args[1], &db);
    if (!model_call(model, "build", &request, 2, build_args)) { zval_ptr_dtor(&build_args[0]); zval_ptr_dtor(&build_args[1]); goto failed; }
    zval_ptr_dtor(&build_args[0]); zval_ptr_dtor(&build_args[1]);
    array_init(&own);
    zval *sets = model_field(model, "sets");
    zend_string *column; zval *spec;
    if (sets == NULL || Z_TYPE_P(sets) != IS_ARRAY) { zend_throw_error(NULL, "Model sets state is invalid"); goto failed; }
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(sets), column, spec) {
        if (column == NULL) { zend_throw_error(NULL, "Model set columns must have string names"); goto failed; }
        zval item;
        if (!assign_ir(model, &request, column, spec, &item)) { call_result_dtor(&item); goto failed; }
        zval *index = array_key(&item, "p");
        if (index != NULL && Z_TYPE_P(index) == IS_LONG) {
            zval own_column; ZVAL_STR_COPY(&own_column, column); zend_hash_index_update(Z_ARRVAL(own), Z_LVAL_P(index), &own_column);
        }
        if (!request_append(&request, "set", &item)) { zval_ptr_dtor(&item); goto failed; }
        zval_ptr_dtor(&item);
    } ZEND_HASH_FOREACH_END();
    if (restore_hook_ce == NULL) { zend_throw_error(NULL, "ModelRestoreHook is not registered"); goto failed; }
    zval hook, closure; object_init_ex(&hook, restore_hook_ce);
    callback_property(&hook, "model", model); callback_property(&hook, "own", &own);
    if (EG(exception) != NULL || !make_native_closure(&hook, &closure)) {
        zval_ptr_dtor(&hook); call_result_dtor(&closure); goto failed;
    }
    zval write_args[3], written; ZVAL_COPY(&write_args[0], &frame); ZVAL_COPY(&write_args[1], &request); ZVAL_COPY(&write_args[2], &closure);
    bool ok = dynamic_call(&db, "writeOf", &written, 3, write_args);
    for (int i = 0; i < 3; i++) zval_ptr_dtor(&write_args[i]); zval_ptr_dtor(&closure);
    if (!ok) { zval_ptr_dtor(&hook); call_result_dtor(&written); goto failed; }
    zval *count = array_at(&written, 1);
    if (count == NULL) { zval_ptr_dtor(&hook); zval_ptr_dtor(&written); zend_throw_error(NULL, "Db::writeOf() returned no restore count"); goto failed; }
    ZVAL_COPY(restored_count, count);
    zval_ptr_dtor(&written);
    object_init_ex(query, Z_OBJCE_P(model));
    if (EG(exception) != NULL) { zval_ptr_dtor(&hook); goto failed; }
    zval *conn = model_field(model, "conn");
    if (conn != NULL) model_state_property_set(model_state_of(Z_OBJ_P(query)), "conn", conn);
    zval *keys = callback_field(&hook, "keys"), *values = callback_field(&hook, "args");
    zend_string *empty = zend_string_init("", 0, 0);
    bool where_ok = model_dsl_where_chain(query, empty, keys, values);
    zend_string_release(empty);
    if (!where_ok) { zval_ptr_dtor(&hook); goto failed; }
    zval_ptr_dtor(&hook); zval_ptr_dtor(&db); zval_ptr_dtor(&frame); zval_ptr_dtor(&request); zval_ptr_dtor(&own);
    return true;
failed:
    call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&request); call_result_dtor(&own);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Model, restoreStep)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval count, query; ZVAL_UNDEF(&count); ZVAL_UNDEF(&query);
    if (!model_restore_step(ZEND_THIS, &count, &query)) { call_result_dtor(&count); call_result_dtor(&query); RETURN_THROWS(); }
    array_init_size(return_value, 2); add_next_index_zval(return_value, &count); add_next_index_zval(return_value, &query);
}

ZEND_METHOD(Polyspec_Orm_Model, restoreKeyValue)
{
    static const char *const scalar_types[] = {NULL, NULL, "string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 3)) RETURN_THROWS();
    zval *request, *own; zend_string *column;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_OBJECT(request) Z_PARAM_ARRAY(own) Z_PARAM_STR(column) ZEND_PARSE_PARAMETERS_END();
    if (!restore_key_value(ZEND_THIS, request, own, column, return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, restore)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval count, query, row;
    ZVAL_UNDEF(&count); ZVAL_UNDEF(&query); ZVAL_UNDEF(&row);
    if (!model_restore_step(ZEND_THIS, &count, &query)) { call_result_dtor(&count); call_result_dtor(&query); RETURN_THROWS(); }
    bool ok = dynamic_call(&query, "get", &row, 0, NULL);
    zval_ptr_dtor(&count); zval_ptr_dtor(&query);
    if (!ok) { call_result_dtor(&row); RETURN_THROWS(); }
    if (Z_TYPE(row) == IS_NULL) {
        zval_ptr_dtor(&row); throw_model_error("NO_ROWS", "restore: no row holds the key"); RETURN_THROWS();
    }
    ZVAL_COPY_VALUE(return_value, &row);
}

ZEND_METHOD(Polyspec_Orm_ModelRestoreOrCreateCallback, __invoke)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *model = callback_field(ZEND_THIS, "model");
    zval count, query, row;
    ZVAL_UNDEF(&count); ZVAL_UNDEF(&query); ZVAL_UNDEF(&row);
    if (!model_restore_step(model, &count, &query)) { call_result_dtor(&count); call_result_dtor(&query); RETURN_THROWS(); }
    if (Z_TYPE(count) == IS_LONG && Z_LVAL(count) > 0) {
        bool ok = dynamic_call(&query, "get", &row, 0, NULL);
        zval_ptr_dtor(&count); zval_ptr_dtor(&query);
        if (!ok) { call_result_dtor(&row); RETURN_THROWS(); }
        callback_property(ZEND_THIS, "row", &row); zval_ptr_dtor(&row); return;
    }
    zval count_result;
    if (!dynamic_call(&query, "getCount", &count_result, 0, NULL)) {
        zval_ptr_dtor(&count); zval_ptr_dtor(&query); call_result_dtor(&count_result); RETURN_THROWS();
    }
    zval_ptr_dtor(&query);
    if (zend_is_true(&count_result)) {
        zval_ptr_dtor(&count_result); zval_ptr_dtor(&count);
        throw_model_error("ROW_NOT_DELETED", "restoreOrCreate: a row that is not deleted holds the key"); RETURN_THROWS();
    }
    zval_ptr_dtor(&count_result); zval_ptr_dtor(&count);
    if (!model_call(model, "create", &row, 0, NULL)) { call_result_dtor(&row); RETURN_THROWS(); }
    callback_property(ZEND_THIS, "row", &row); zval_ptr_dtor(&row);
}

ZEND_METHOD(Polyspec_Orm_Model, restoreOrCreate)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (restore_or_create_callback_ce == NULL) { zend_throw_error(NULL, "ModelRestoreOrCreateCallback is not registered"); RETURN_THROWS(); }
    zval callback, closure; object_init_ex(&callback, restore_or_create_callback_ce);
    callback_property(&callback, "model", ZEND_THIS);
    if (EG(exception) != NULL || !make_native_closure(&callback, &closure)) { zval_ptr_dtor(&callback); call_result_dtor(&closure); RETURN_THROWS(); }
    zval *conn = model_field(ZEND_THIS, "conn");
    zval args[2], result; ZVAL_COPY(&args[0], conn); ZVAL_COPY(&args[1], &closure);
    bool ok = named_call("Polyspec\\Orm\\Db::inTransaction", &result, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); call_result_dtor(&result); zval_ptr_dtor(&closure);
    if (ok && EG(exception) == NULL) ZVAL_COPY(return_value, callback_field(&callback, "row"));
    zval_ptr_dtor(&callback);
    if (!ok || EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_ModelDeleteCallback, __invoke)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *model = callback_field(ZEND_THIS, "model");
    zval arg, result; ZVAL_TRUE(&arg);
    if (!model_call(model, "deleteRow", &result, 1, &arg)) { call_result_dtor(&result); RETURN_THROWS(); }
    call_result_dtor(&result);
}

static bool model_delete_row(zval *model, bool recursive)
{
    zval db, frame, meta, request, keys, revision, written;
    ZVAL_UNDEF(&db); ZVAL_UNDEF(&frame); ZVAL_UNDEF(&meta); ZVAL_UNDEF(&request);
    ZVAL_UNDEF(&keys); ZVAL_UNDEF(&revision); ZVAL_UNDEF(&written);
    if (!resolve_executor(model, &db, &frame)) goto failed;
    if (recursive) {
        zval *row = model_field(model, "row");
        zval *related = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "related") : NULL;
        zval *cascade = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? array_key(row, "cascade") : NULL;
        if (related != NULL && Z_TYPE_P(related) == IS_ARRAY) {
            zend_string *name; zval *child;
            ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(related), name, child) {
                zval *cascade_flag = cascade != NULL && Z_TYPE_P(cascade) == IS_ARRAY && name != NULL
                    ? zend_hash_find(Z_ARRVAL_P(cascade), name) : NULL;
                if (cascade_flag == NULL || !zend_is_true(cascade_flag) || Z_TYPE_P(child) == IS_NULL) continue;
                if (Z_TYPE_P(child) != IS_OBJECT) continue;
                zend_class_entry *model_ce = lookup_class("Polyspec\\Orm\\Model");
                zend_class_entry *collection_ce = lookup_class("Polyspec\\Orm\\Collection");
                if (model_ce == NULL || collection_ce == NULL) { call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&request); call_result_dtor(&keys); call_result_dtor(&revision); call_result_dtor(&written); return false; }
                if (instanceof_function(Z_OBJCE_P(child), model_ce)) {
                    zval arg, child_result; ZVAL_TRUE(&arg);
                    if (!model_call(child, "deleteRow", &child_result, 1, &arg)) { call_result_dtor(&child_result); goto failed; }
                    call_result_dtor(&child_result);
                } else if (instanceof_function(Z_OBJCE_P(child), collection_ce)) {
                    zval iterator;
                    if (!dynamic_call(child, "getIterator", &iterator, 0, NULL)) { call_result_dtor(&iterator); goto failed; }
                    for (;;) {
                        zval valid;
                        if (!dynamic_call(&iterator, "valid", &valid, 0, NULL)) { call_result_dtor(&iterator); call_result_dtor(&valid); goto failed; }
                        bool has_child = zend_is_true(&valid); zval_ptr_dtor(&valid);
                        if (!has_child) break;
                        zval item;
                        if (!dynamic_call(&iterator, "current", &item, 0, NULL)) { call_result_dtor(&iterator); call_result_dtor(&item); goto failed; }
                        zval arg, child_result; ZVAL_TRUE(&arg);
                        bool child_ok = model_call(&item, "deleteRow", &child_result, 1, &arg);
                        call_result_dtor(&item); call_result_dtor(&child_result);
                        if (!child_ok) { call_result_dtor(&iterator); goto failed; }
                        zval next;
                        if (!dynamic_call(&iterator, "next", &next, 0, NULL)) { call_result_dtor(&iterator); call_result_dtor(&next); goto failed; }
                        call_result_dtor(&next);
                    }
                    call_result_dtor(&iterator);
                }
            } ZEND_HASH_FOREACH_END();
        }
    }
    if (!model_meta(model, &meta) || !write_request(model, "delete", &db, &request) || !model_key_values(model, &keys)) goto failed;
    if (!model_key_where(&request, &keys)) goto failed;
    zval guard_args[3]; ZVAL_COPY(&guard_args[0], &request); ZVAL_FALSE(&guard_args[1]); ZVAL_FALSE(&guard_args[2]);
    bool guard_ok = model_call(model, "revisionGuard", &revision, 3, guard_args);
    for (int i = 0; i < 3; i++) zval_ptr_dtor(&guard_args[i]);
    if (!guard_ok) goto failed;
    if (!write_of(&db, &frame, &request, NULL, &written)) goto failed;
    zval *affected = array_at(&written, 1), *expected = model_field(model, "expectedRevision");
    if (expected != NULL && Z_TYPE_P(expected) == IS_ARRAY && affected != NULL && Z_TYPE_P(affected) == IS_LONG && Z_LVAL_P(affected) == 0) {
        zval *column = array_at(expected, 0), *value = array_at(expected, 1);
        smart_str message = {0};
        if (column != NULL && Z_TYPE_P(column) == IS_STRING && value != NULL && Z_TYPE_P(value) == IS_LONG)
            smart_str_append_printf(&message, "the row's %s is not " ZEND_LONG_FMT, Z_STRVAL_P(column), Z_LVAL_P(value));
        else
            smart_str_appends(&message, "the row's revision is not the expected value");
        zend_string *text = smart_str_extract(&message); throw_model_error("REVISION_CHANGED", ZSTR_VAL(text)); zend_string_release(text); goto failed;
    }
    model_state_reset(model_state_of(Z_OBJ_P(model)), "expectedRevision");
    call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&request); call_result_dtor(&keys); call_result_dtor(&revision); call_result_dtor(&written);
    return true;
failed:
    call_result_dtor(&db); call_result_dtor(&frame); call_result_dtor(&meta); call_result_dtor(&request); call_result_dtor(&keys); call_result_dtor(&revision); call_result_dtor(&written);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Model, deleteRow)
{
    static const char *const scalar_types[] = {"bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    bool recursive;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_BOOL(recursive) ZEND_PARSE_PARAMETERS_END();
    if (!model_delete_row(ZEND_THIS, recursive)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, delete)
{
    static const char *const scalar_types[] = {"bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    bool recursive = false;
    ZEND_PARSE_PARAMETERS_START(0, 1) Z_PARAM_OPTIONAL Z_PARAM_BOOL(recursive) ZEND_PARSE_PARAMETERS_END();
    zval db, frame;
    ZVAL_UNDEF(&db); ZVAL_UNDEF(&frame);
    if (!resolve_executor(ZEND_THIS, &db, &frame)) RETURN_THROWS();
    call_result_dtor(&db); call_result_dtor(&frame);
    if (!recursive) {
        zval arg, result; ZVAL_FALSE(&arg);
        if (!model_call(ZEND_THIS, "deleteRow", &result, 1, &arg)) { call_result_dtor(&result); RETURN_THROWS(); }
        call_result_dtor(&result); return;
    }
    if (delete_callback_ce == NULL) { zend_throw_error(NULL, "ModelDeleteCallback is not registered"); RETURN_THROWS(); }
    zval callback, closure; object_init_ex(&callback, delete_callback_ce); callback_property(&callback, "model", ZEND_THIS);
    if (EG(exception) != NULL || !make_native_closure(&callback, &closure)) { zval_ptr_dtor(&callback); call_result_dtor(&closure); RETURN_THROWS(); }
    zval *conn = model_field(ZEND_THIS, "conn"); zval args[2], result;
    ZVAL_COPY(&args[0], conn); ZVAL_COPY(&args[1], &closure);
    bool ok = named_call("Polyspec\\Orm\\Db::inTransaction", &result, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); call_result_dtor(&result); zval_ptr_dtor(&closure); zval_ptr_dtor(&callback);
    if (!ok || EG(exception) != NULL) RETURN_THROWS();
}
