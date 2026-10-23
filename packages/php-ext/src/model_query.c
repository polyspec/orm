/* Model request and row-value helpers backed by the native dependencies. */
#include "model_query.h"
#include "model_state.h"
#include "model_native_methods.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "ext/standard/php_string.h"

static bool query_subject(zval *model, zval *subject);

static zend_class_entry *query_class(const char *name)
{
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool query_instance(zval *value, const char *name)
{
    zend_class_entry *ce = query_class(name);
    return ce != NULL && Z_TYPE_P(value) == IS_OBJECT && instanceof_function(Z_OBJCE_P(value), ce);
}

static bool query_meta(zend_object *model, zval *meta)
{
    ZVAL_UNDEF(meta);
    zend_call_method_with_0_params(NULL, model->ce, NULL, "meta", meta);
    if (EG(exception) != NULL) return false;
    if (Z_TYPE_P(meta) != IS_ARRAY) {
        zend_throw_error(NULL, "Model::meta() must return an array");
        return false;
    }
    return true;
}

static void query_throw_orm(const char *code_name, zend_string *message)
{
    zend_class_entry *ce = query_class("Polyspec\\Orm\\OrmException");
    if (ce == NULL) { zend_throw_error(NULL, "Polyspec\\Orm\\OrmException is not loaded"); return; }
    zval exception, code, text;
    object_init_ex(&exception, ce);
    ZVAL_STRING(&code, code_name);
    ZVAL_STR_COPY(&text, message);
    zend_call_method_with_2_params(Z_OBJ(exception), ce, NULL, "__construct", NULL, &code, &text);
    zval_ptr_dtor(&code); zval_ptr_dtor(&text);
    if (EG(exception) != NULL) { zval_ptr_dtor(&exception); return; }
    zend_throw_exception_object(&exception);
}

static void query_throw_config(const char *message)
{
    zend_string *text = zend_string_init(message, strlen(message), 0);
    query_throw_orm("CONFIG", text);
    zend_string_release(text);
}

static bool query_is_group(model_state *state)
{
    zval *group = model_state_property(state, "group_of");
    return group != NULL && Z_TYPE_P(group) != IS_NULL;
}

ZEND_METHOD(Polyspec_Orm_Model, executor)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (query_is_group(state)) {
        query_throw_config("a terminal is not allowed inside a group callback");
        RETURN_THROWS();
    }
    zval *error = model_state_property(state, "error");
    if (error != NULL && Z_TYPE_P(error) == IS_OBJECT) {
        zval copy; ZVAL_COPY(&copy, error); zend_throw_exception_object(&copy); RETURN_THROWS();
    }
    zval *conn = model_state_property(state, "conn");
    zval null_conn, resolved;
    if (conn == NULL || Z_TYPE_P(conn) == IS_NULL) ZVAL_NULL(&null_conn); else ZVAL_COPY(&null_conn, conn);
    zend_class_entry *db_ce = query_class("Polyspec\\Orm\\Db");
    if (db_ce == NULL) { zval_ptr_dtor(&null_conn); zend_throw_error(NULL, "Polyspec\\Orm\\Db is not loaded"); RETURN_THROWS(); }
    zend_call_method_with_1_params(NULL, db_ce, NULL, "resolve", &resolved, &null_conn);
    zval_ptr_dtor(&null_conn);
    if (EG(exception) != NULL) RETURN_THROWS();
    if (Z_TYPE(resolved) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL(resolved)) < 2) {
        if (Z_TYPE(resolved) != IS_UNDEF) zval_ptr_dtor(&resolved);
        zend_throw_error(NULL, "Db::resolve() returned an invalid executor tuple");
        RETURN_THROWS();
    }
    RETURN_COPY_VALUE(&resolved);
}

ZEND_METHOD(Polyspec_Orm_Model, manifestHash)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_class_entry *called_scope = zend_get_called_scope(EG(current_execute_data));
    if (called_scope == NULL) {
        zend_throw_error(NULL, "Model::manifestHash() requires a called model class");
        RETURN_THROWS();
    }
    zval meta;
    ZVAL_UNDEF(&meta);
    zend_call_method_with_0_params(NULL, called_scope, NULL, "meta", &meta);
    if (EG(exception) != NULL) RETURN_THROWS();
    zval *hash_value = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "manifest_hash", sizeof("manifest_hash") - 1) : NULL;
    zval *entity_value = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1) : NULL;
    zend_string *hash = hash_value != NULL ? zval_get_string(hash_value) : zend_string_init("", 0, 0);
    zend_string *entity = entity_value != NULL ? zval_get_string(entity_value) : zend_string_init("", 0, 0);
    if (EG(exception) != NULL) { zend_string_release(hash); zend_string_release(entity); zval_ptr_dtor(&meta); RETURN_THROWS(); }
    zend_class_entry *registry_ce = query_class("Polyspec\\Orm\\Registry");
    if (registry_ce == NULL) {
        zend_string_release(hash); zend_string_release(entity); zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Polyspec\\Orm\\Registry is not loaded");
        RETURN_THROWS();
    }
    zval hash_arg, models;
    ZVAL_STR_COPY(&hash_arg, hash);
    zend_call_method_with_1_params(NULL, registry_ce, NULL, "models", &models, &hash_arg);
    zval_ptr_dtor(&hash_arg);
    if (EG(exception) != NULL) { zend_string_release(hash); zend_string_release(entity); zval_ptr_dtor(&meta); RETURN_THROWS(); }
    zval *registered = Z_TYPE(models) == IS_ARRAY ? zend_hash_find(Z_ARRVAL(models), entity) : NULL;
    if (registered == NULL || Z_TYPE_P(registered) != IS_STRING || !zend_string_equals(Z_STR_P(registered), called_scope->name)) {
        smart_str message = {0};
        smart_str_append(&message, called_scope->name);
        smart_str_appends(&message, " is not registered by the generated models of manifest ");
        smart_str_append(&message, hash);
        zend_string *text = smart_str_extract(&message);
        query_throw_orm("SCHEMA_HASH_MISMATCH", text);
        zend_string_release(text);
        if (Z_TYPE(models) != IS_UNDEF) zval_ptr_dtor(&models);
        zend_string_release(hash); zend_string_release(entity); zval_ptr_dtor(&meta);
        RETURN_THROWS();
    }
    if (Z_TYPE(models) != IS_UNDEF) zval_ptr_dtor(&models);
    zval_ptr_dtor(&meta);
    zend_string_release(entity);
    RETURN_STR(hash);
}

ZEND_METHOD(Polyspec_Orm_Model, resultName)
{
    static const char *const scalar_types[] = {"bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    bool many;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_BOOL(many)
    ZEND_PARSE_PARAMETERS_END();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval *alias = model_state_property(state, "alias");
    if (alias != NULL && Z_TYPE_P(alias) == IS_STRING && Z_STRLEN_P(alias) != 0) RETURN_COPY(alias);
    zval meta;
    if (!query_meta(Z_OBJ_P(ZEND_THIS), &meta)) RETURN_THROWS();
    zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
    if (entity == NULL) {
        zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Model::meta() must contain entity");
        RETURN_THROWS();
    }
    zend_string *name = zval_get_string(entity);
    zval_ptr_dtor(&meta);
    if (EG(exception) != NULL) { zend_string_release(name); RETURN_THROWS(); }
    smart_str result = {0}; smart_str_append(&result, name); smart_str_appends(&result, many ? "_models" : "_model");
    zend_string_release(name);
    RETURN_STR(smart_str_extract(&result));
}

ZEND_METHOD(Polyspec_Orm_Model, build)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *kind;
    zval *db;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(kind)
        Z_PARAM_OBJECT(db)
    ZEND_PARSE_PARAMETERS_END();
    zend_class_entry *db_ce = query_class("Polyspec\\Orm\\Db");
    if (db_ce == NULL || !instanceof_function(Z_OBJCE_P(db), db_ce)) {
        zend_argument_type_error(2, "must be of type Polyspec\\Orm\\Db, %s given", zend_zval_value_name(db));
        RETURN_THROWS();
    }
    zend_class_entry *request_ce = query_class("Polyspec\\Orm\\Request");
    zend_class_entry *frame_ce = query_class("Polyspec\\Orm\\Frame");
    if (request_ce == NULL || frame_ce == NULL) {
        zend_throw_error(NULL, "Model request dependencies are not loaded");
        RETURN_THROWS();
    }
    zval hash;
    ZVAL_UNDEF(&hash);
    zend_call_method_with_0_params(NULL, Z_OBJCE_P(ZEND_THIS), NULL, "manifesthash", &hash);
    if (EG(exception) != NULL) RETURN_THROWS();
    zval request;
    object_init_ex(&request, request_ce);
    if (EG(exception) != NULL) { zval_ptr_dtor(&hash); RETURN_THROWS(); }
    zval ctor_result, kind_arg, hash_arg;
    ZVAL_STRINGL(&kind_arg, ZSTR_VAL(kind), ZSTR_LEN(kind));
    ZVAL_COPY(&hash_arg, &hash);
    zend_call_method_with_2_params(Z_OBJ(request), request_ce, NULL, "__construct", &ctor_result, &kind_arg, &hash_arg);
    zval_ptr_dtor(&kind_arg); zval_ptr_dtor(&hash_arg); zval_ptr_dtor(&hash);
    if (Z_TYPE(ctor_result) != IS_UNDEF) zval_ptr_dtor(&ctor_result);
    if (EG(exception) != NULL) { zval_ptr_dtor(&request); RETURN_THROWS(); }
    zval frame;
    object_init_ex(&frame, frame_ce);
    if (EG(exception) != NULL) { zval_ptr_dtor(&request); RETURN_THROWS(); }
    zval model_arg, null_arg, frame_ctor_result;
    ZVAL_COPY(&model_arg, ZEND_THIS); ZVAL_NULL(&null_arg);
    zend_call_method_with_2_params(Z_OBJ(frame), frame_ce, NULL, "__construct", &frame_ctor_result, &model_arg, &null_arg);
    zval_ptr_dtor(&model_arg);
    if (Z_TYPE(frame_ctor_result) != IS_UNDEF) zval_ptr_dtor(&frame_ctor_result);
    if (EG(exception) != NULL) { zval_ptr_dtor(&request); zval_ptr_dtor(&frame); RETURN_THROWS(); }
    zval query;
    ZVAL_UNDEF(&query);
    zend_call_method(Z_OBJ_P(ZEND_THIS), model_native_class_entry(), NULL, "query", sizeof("query") - 1, &query, 2, &request, &frame);
    zval_ptr_dtor(&frame);
    if (EG(exception) != NULL) { if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query); zval_ptr_dtor(&request); RETURN_THROWS(); }
    if (Z_TYPE(query) != IS_ARRAY) {
        if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query);
        zval_ptr_dtor(&request);
        zend_throw_error(NULL, "Model::query() must return an array");
        RETURN_THROWS();
    }
    zval *ir = zend_read_property(request_ce, Z_OBJ(request), "ir", sizeof("ir") - 1, 1, NULL);
    if (Z_TYPE_P(ir) != IS_ARRAY) {
        zval_ptr_dtor(&query); zval_ptr_dtor(&request);
        zend_throw_error(NULL, "Request::ir has an invalid shape");
        RETURN_THROWS();
    }
    SEPARATE_ARRAY(ir);
    zend_string *key; zval *value;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(query), key, value) {
        if (key != NULL && !zend_hash_exists(Z_ARRVAL_P(ir), key)) {
            zval copy; ZVAL_COPY(&copy, value); zend_hash_add(Z_ARRVAL_P(ir), key, &copy);
        }
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&query);
    RETURN_COPY_VALUE(&request);
}

ZEND_METHOD(Polyspec_Orm_Model, value)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *column;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(column) ZEND_PARSE_PARAMETERS_END();
    zval *values = model_state_property(model_state_of(Z_OBJ_P(ZEND_THIS)), "values");
    zval *value = values != NULL && Z_TYPE_P(values) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(values), column) : NULL;
    if (value == NULL) RETURN_NULL();
    zval argument; ZVAL_STR_COPY(&argument, column);
    zend_call_method(Z_OBJ_P(ZEND_THIS), model_native_class_entry(), NULL, "readcolumn", sizeof("readcolumn") - 1, return_value, 1, &argument, NULL);
    zval_ptr_dtor(&argument);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, resolved)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    if (!query_instance(value, "Polyspec\\Orm\\PendingTime")) RETURN_COPY(value);
    zend_class_entry *pending_ce = query_class("Polyspec\\Orm\\PendingTime");
    zval text_rv, zone_rv;
    zval *text = zend_read_property(pending_ce, Z_OBJ_P(value), "text", sizeof("text") - 1, 1, &text_rv);
    zval *zone = zend_read_property(pending_ce, Z_OBJ_P(value), "zone", sizeof("zone") - 1, 1, &zone_rv);
    if (Z_TYPE_P(text) != IS_STRING || Z_TYPE_P(zone) != IS_OBJECT) {
        zend_throw_error(NULL, "PendingTime has an invalid native value");
        RETURN_THROWS();
    }
    if (!model_time_value_in_zone(text, zone, return_value)) {
        if (EG(exception) != NULL) RETURN_THROWS();
        zend_string *message = strpprintf(0, "invalid date value %s", Z_STRVAL_P(text));
        query_throw_orm("CODEC_DECODE", message);
        zend_string_release(message);
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Model, putSet)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *column;
    zval *spec;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_ARRAY(spec)
    ZEND_PARSE_PARAMETERS_END();
    zval meta;
    if (!query_meta(Z_OBJ_P(ZEND_THIS), &meta)) RETURN_THROWS();
    zval *columns = zend_hash_str_find(Z_ARRVAL(meta), "columns", sizeof("columns") - 1);
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY || !zend_hash_exists(Z_ARRVAL_P(columns), column)) {
        zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
        zend_string *entity_text = entity != NULL ? zval_get_string(entity) : zend_string_init("Model", sizeof("Model") - 1, 0);
        zend_string *message = strpprintf(0, "%s has no column %s", ZSTR_VAL(entity_text), ZSTR_VAL(column));
        model_native_fail(model_state_of(Z_OBJ_P(ZEND_THIS)), ZSTR_VAL(message));
        zend_string_release(message);
        zend_string_release(entity_text);
        zval_ptr_dtor(&meta);
        RETURN_NULL();
    }
    zval_ptr_dtor(&meta);
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    model_state_property_separate(state, "sets");
    if (EG(exception) != NULL) RETURN_THROWS();
    zval copy; ZVAL_COPY(&copy, spec);
    zend_hash_update(Z_ARRVAL_P(model_state_property(state, "sets")), column, &copy);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Model, columnValue)
{
    zval *column, *input, *zone;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY(column)
        Z_PARAM_ZVAL(input)
        Z_PARAM_OBJECT(zone)
    ZEND_PARSE_PARAMETERS_END();
    if (Z_TYPE_P(input) == IS_NULL) RETURN_NULL();
    zval value;
    ZVAL_COPY(&value, input);
    if (Z_TYPE(value) == IS_RESOURCE) {
        zval function, result, arg;
        ZVAL_STRING(&function, "stream_get_contents"); ZVAL_COPY(&arg, &value); ZVAL_UNDEF(&result);
        call_user_function(EG(function_table), NULL, &function, &result, 1, &arg);
        zval_ptr_dtor(&function); zval_ptr_dtor(&arg); zval_ptr_dtor(&value);
        if (EG(exception) != NULL) RETURN_THROWS();
        ZVAL_COPY_VALUE(&value, &result);
    }
    zval *codec = zend_hash_str_find(Z_ARRVAL_P(column), "codec", sizeof("codec") - 1);
    if (codec != NULL && Z_TYPE_P(codec) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0) {
        RETURN_COPY_VALUE(&value);
    }
    zval *type = zend_hash_str_find(Z_ARRVAL_P(column), "type", sizeof("type") - 1);
    if (type == NULL || Z_TYPE_P(type) != IS_STRING) {
        zval_ptr_dtor(&value); zend_throw_error(NULL, "column metadata has no string type"); RETURN_THROWS();
    }
    if (zend_string_equals_literal(Z_STR_P(type), "i16") || zend_string_equals_literal(Z_STR_P(type), "i32") || zend_string_equals_literal(Z_STR_P(type), "i64")) {
        zend_long n = zval_get_long(&value); zval_ptr_dtor(&value); RETURN_LONG(n);
    }
    if (zend_string_equals_literal(Z_STR_P(type), "f64")) {
        double n = zval_get_double(&value); zval_ptr_dtor(&value); RETURN_DOUBLE(n);
    }
    if (zend_string_equals_literal(Z_STR_P(type), "bool")) {
        bool b = zend_is_true(&value); zval_ptr_dtor(&value); RETURN_BOOL(b);
    }
    if (zend_string_equals_literal(Z_STR_P(type), "decimal")) {
        if (Z_TYPE(value) != IS_STRING) {
            zval_ptr_dtor(&value); query_throw_config("decimal cell requires exact text"); RETURN_THROWS();
        }
        zval *precision = zend_hash_str_find(Z_ARRVAL_P(column), "precision", sizeof("precision") - 1);
        zval *scale = zend_hash_str_find(Z_ARRVAL_P(column), "scale", sizeof("scale") - 1);
        zend_string *normalized = model_decimal_normalize(Z_STR(value), precision != NULL ? zval_get_long(precision) : 0, scale != NULL ? zval_get_long(scale) : 0);
        zval_ptr_dtor(&value);
        if (EG(exception) != NULL || normalized == NULL) RETURN_THROWS();
        RETURN_STR(normalized);
    }
    if (zend_string_equals_literal(Z_STR_P(type), "date") || zend_string_equals_literal(Z_STR_P(type), "datetime")) {
        if (!model_time_value_in_zone(&value, zone, return_value)) {
            zval_ptr_dtor(&value);
            if (EG(exception) != NULL) RETURN_THROWS();
            zend_string *text = zval_get_string(input);
            zend_string *message = strpprintf(0, "invalid date value %s", ZSTR_VAL(text));
            query_throw_orm("CODEC_DECODE", message);
            zend_string_release(message); zend_string_release(text); RETURN_THROWS();
        }
        zval_ptr_dtor(&value);
        return;
    }
    if (Z_TYPE(value) != IS_STRING) {
        zend_string *text = zval_try_get_string(&value);
        zval_ptr_dtor(&value);
        if (text == NULL) RETURN_THROWS();
        RETURN_STR(text);
    }
    RETURN_COPY_VALUE(&value);
}

ZEND_METHOD(Polyspec_Orm_Model, revisionGuard)
{
    static const char *const scalar_types[] = {NULL, "bool", "bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 3)) RETURN_THROWS();
    zval *request;
    bool update, optimistic;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT(request)
        Z_PARAM_BOOL(update)
        Z_PARAM_BOOL(optimistic)
    ZEND_PARSE_PARAMETERS_END();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval *expected = model_state_property(state, "expected_revision");
    if (expected == NULL || Z_TYPE_P(expected) == IS_NULL) RETURN_NULL();
    if (Z_TYPE_P(expected) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(expected)) != 2) {
        zend_throw_error(NULL, "Model expectedRevision has an invalid native state"); RETURN_THROWS();
    }
    zval *column_value = zend_hash_index_find(Z_ARRVAL_P(expected), 0);
    zval *revision_value = zend_hash_index_find(Z_ARRVAL_P(expected), 1);
    if (column_value == NULL || Z_TYPE_P(column_value) != IS_STRING || revision_value == NULL) {
        zend_throw_error(NULL, "Model expectedRevision has an invalid native state"); RETURN_THROWS();
    }
    zend_string *column_name = Z_STR_P(column_value);
    zval meta;
    if (!query_meta(Z_OBJ_P(ZEND_THIS), &meta)) RETURN_THROWS();
    zval *columns = zend_hash_str_find(Z_ARRVAL(meta), "columns", sizeof("columns") - 1);
    zval *col = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(columns), column_name) : NULL;
    zval *col_type = col != NULL && Z_TYPE_P(col) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(col), "type", sizeof("type") - 1) : NULL;
    zval *codec = col != NULL && Z_TYPE_P(col) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(col), "codec", sizeof("codec") - 1) : NULL;
    zval *pk = zend_hash_str_find(Z_ARRVAL(meta), "pk", sizeof("pk") - 1);
    bool pk_member = false;
    if (pk != NULL && Z_TYPE_P(pk) == IS_ARRAY) {
        zval *pk_column;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), pk_column) {
            if (Z_TYPE_P(pk_column) == IS_STRING && zend_string_equals(Z_STR_P(pk_column), column_name)) { pk_member = true; break; }
        } ZEND_HASH_FOREACH_END();
    }
    if (col == NULL || col_type == NULL || Z_TYPE_P(col_type) != IS_STRING ||
        !(zend_string_equals_literal(Z_STR_P(col_type), "i16") || zend_string_equals_literal(Z_STR_P(col_type), "i32") || zend_string_equals_literal(Z_STR_P(col_type), "i64")) ||
        codec == NULL || Z_TYPE_P(codec) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0 || pk_member) {
        zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
        zend_string *entity_text = entity != NULL ? zval_get_string(entity) : zend_string_init("Model", sizeof("Model") - 1, 0);
        zend_string *message = strpprintf(0, "expectRevision: %s is not an integer column of %s outside its primary key", ZSTR_VAL(column_name), ZSTR_VAL(entity_text));
        query_throw_orm("CONFIG", message); zend_string_release(message); zend_string_release(entity_text); zval_ptr_dtor(&meta); RETURN_THROWS();
    }
    zval *sets = model_state_property(state, "sets");
    if (sets != NULL && Z_TYPE_P(sets) == IS_ARRAY && zend_hash_exists(Z_ARRVAL_P(sets), column_name)) {
        zend_string *message = strpprintf(0, "expectRevision: %s is also set in the write", ZSTR_VAL(column_name));
        query_throw_orm("CONFIG", message); zend_string_release(message); zval_ptr_dtor(&meta); RETURN_THROWS();
    }
    if (optimistic) {
        zval_ptr_dtor(&meta); query_throw_config("expectRevision does not combine with update(true)"); RETURN_THROWS();
    }
    zend_class_entry *request_ce = query_class("Polyspec\\Orm\\Request");
    if (request_ce == NULL || !instanceof_function(Z_OBJCE_P(request), request_ce)) {
        zval_ptr_dtor(&meta); zend_throw_error(NULL, "revisionGuard requires Request"); RETURN_THROWS();
    }
    zval revision_arg, p_result;
    ZVAL_UNDEF(&p_result);
    ZVAL_COPY(&revision_arg, revision_value);
    zend_call_method_with_1_params(Z_OBJ_P(request), request_ce, NULL, "param", &p_result, &revision_arg);
    zval_ptr_dtor(&revision_arg);
    if (EG(exception) != NULL) { zval_ptr_dtor(&meta); RETURN_THROWS(); }
    zval *ir = zend_read_property(request_ce, Z_OBJ_P(request), "ir", sizeof("ir") - 1, 1, NULL);
    if (Z_TYPE_P(ir) != IS_ARRAY) { zval_ptr_dtor(&p_result); zval_ptr_dtor(&meta); zend_throw_error(NULL, "Request::ir has an invalid shape"); RETURN_THROWS(); }
    SEPARATE_ARRAY(ir);
    zval *where = zend_hash_str_find(Z_ARRVAL_P(ir), "where", sizeof("where") - 1);
    if (where == NULL) { zval fresh; array_init(&fresh); zend_hash_str_update(Z_ARRVAL_P(ir), "where", sizeof("where") - 1, &fresh); where = zend_hash_str_find(Z_ARRVAL_P(ir), "where", sizeof("where") - 1); }
    if (Z_TYPE_P(where) != IS_ARRAY) { zval_ptr_dtor(&p_result); zval_ptr_dtor(&meta); zend_throw_error(NULL, "Request::ir.where has an invalid shape"); RETURN_THROWS(); }
    SEPARATE_ARRAY(where);
    zval *items = zend_hash_str_find(Z_ARRVAL_P(where), "items", sizeof("items") - 1);
    if (items == NULL) { zval fresh; array_init(&fresh); zend_hash_str_update(Z_ARRVAL_P(where), "items", sizeof("items") - 1, &fresh); items = zend_hash_str_find(Z_ARRVAL_P(where), "items", sizeof("items") - 1); }
    if (Z_TYPE_P(items) != IS_ARRAY) { zval_ptr_dtor(&p_result); zval_ptr_dtor(&meta); zend_throw_error(NULL, "Request::ir.where.items has an invalid shape"); RETURN_THROWS(); }
    SEPARATE_ARRAY(items);
    zval pred, node; array_init(&pred); array_init(&node);
    add_assoc_str(&pred, "column", zend_string_copy(column_name)); add_assoc_string(&pred, "op", "eq");
    add_assoc_zval(&pred, "p", &p_result); add_assoc_string(&pred, "conn", "and"); add_assoc_zval(&node, "pred", &pred);
    zend_hash_next_index_insert(Z_ARRVAL_P(items), &node);
    if (update) {
        zval one, one_p;
        ZVAL_LONG(&one, 1);
        zend_call_method_with_1_params(Z_OBJ_P(request), request_ce, NULL, "param", &one_p, &one);
        zval_ptr_dtor(&one);
        if (EG(exception) != NULL) { zval_ptr_dtor(&meta); RETURN_THROWS(); }
        zval *set = zend_hash_str_find(Z_ARRVAL_P(ir), "set", sizeof("set") - 1);
        if (set == NULL) { zval fresh; array_init(&fresh); zend_hash_str_update(Z_ARRVAL_P(ir), "set", sizeof("set") - 1, &fresh); set = zend_hash_str_find(Z_ARRVAL_P(ir), "set", sizeof("set") - 1); }
        if (Z_TYPE_P(set) != IS_ARRAY) { zval_ptr_dtor(&one_p); zval_ptr_dtor(&meta); zend_throw_error(NULL, "Request::ir.set has an invalid shape"); RETURN_THROWS(); }
        SEPARATE_ARRAY(set);
        zval increment; array_init(&increment); add_assoc_str(&increment, "column", zend_string_copy(column_name)); add_assoc_zval(&increment, "plus_p", &one_p);
        zend_hash_next_index_insert(Z_ARRVAL_P(set), &increment);
    }
    zval_ptr_dtor(&meta);
    RETURN_STR_COPY(column_name);
}

ZEND_METHOD(Polyspec_Orm_Model, getQuery)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval resolved;
    ZVAL_UNDEF(&resolved);
    zend_call_method_with_0_params(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "executor", &resolved);
    if (EG(exception) != NULL) {
        if (Z_TYPE(resolved) != IS_UNDEF) zval_ptr_dtor(&resolved);
        RETURN_THROWS();
    }
    if (Z_TYPE(resolved) != IS_ARRAY || zend_hash_index_find(Z_ARRVAL(resolved), 0) == NULL ||
        Z_TYPE_P(zend_hash_index_find(Z_ARRVAL(resolved), 0)) != IS_OBJECT) {
        if (Z_TYPE(resolved) != IS_UNDEF) zval_ptr_dtor(&resolved);
        zend_throw_error(NULL, "Model::executor() returned an invalid database tuple");
        RETURN_THROWS();
    }
    zval *db = zend_hash_index_find(Z_ARRVAL(resolved), 0);
    zval kind, request;
    ZVAL_STRING(&kind, "all");
    ZVAL_UNDEF(&request);
    zend_call_method_with_2_params(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "build", &request, &kind, db);
    zval_ptr_dtor(&kind);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&resolved);
        if (Z_TYPE(request) != IS_UNDEF) zval_ptr_dtor(&request);
        RETURN_THROWS();
    }
    zval result;
    ZVAL_UNDEF(&result);
    zend_call_method(Z_OBJ_P(db), Z_OBJCE_P(db), NULL, "statement", sizeof("statement") - 1, &result, 1, &request, NULL);
    zval_ptr_dtor(&request);
    zval_ptr_dtor(&resolved);
    if (EG(exception) != NULL) {
        if (Z_TYPE(result) != IS_UNDEF) zval_ptr_dtor(&result);
        RETURN_THROWS();
    }
    if (Z_TYPE(result) != IS_ARRAY) {
        if (Z_TYPE(result) != IS_UNDEF) zval_ptr_dtor(&result);
        zend_throw_error(NULL, "Db::statement() must return an array");
        RETURN_THROWS();
    }
    ZVAL_COPY_VALUE(return_value, &result);
}

static bool query_make_frame(zval *model, zval *outer, zval *frame)
{
    zend_class_entry *frame_ce = query_class("Polyspec\\Orm\\Frame");
    if (frame_ce == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Frame is not loaded");
        return false;
    }
    object_init_ex(frame, frame_ce);
    if (EG(exception) != NULL) return false;
    zval model_arg, outer_arg, ctor_result;
    ZVAL_COPY(&model_arg, model);
    if (outer == NULL) ZVAL_NULL(&outer_arg); else ZVAL_COPY(&outer_arg, outer);
    ZVAL_UNDEF(&ctor_result);
    zend_call_method_with_2_params(Z_OBJ_P(frame), frame_ce, NULL, "__construct", &ctor_result, &model_arg, &outer_arg);
    zval_ptr_dtor(&model_arg);
    zval_ptr_dtor(&outer_arg);
    if (Z_TYPE(ctor_result) != IS_UNDEF) zval_ptr_dtor(&ctor_result);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Model, relationIr)
{
    static const char *const scalar_types[] = {"bool", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    bool many;
    zval *request;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_BOOL(many)
        Z_PARAM_OBJECT(request)
    ZEND_PARSE_PARAMETERS_END();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval *limit = model_state_property(state, "limit");
    if (limit != NULL && Z_TYPE_P(limit) != IS_NULL) {
        zval meta;
        if (!query_meta(Z_OBJ_P(ZEND_THIS), &meta)) RETURN_THROWS();
        zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
        zend_string *name = entity != NULL ? zval_get_string(entity) : zend_string_init("Model", sizeof("Model") - 1, 0);
        zend_string *message = strpprintf(0, "%s relation uses limit; use groupLimit", ZSTR_VAL(name));
        query_throw_orm("LIMIT_IN_RELATION", message);
        zend_string_release(message); zend_string_release(name); zval_ptr_dtor(&meta);
        RETURN_THROWS();
    }
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!query_make_frame(ZEND_THIS, NULL, &frame)) {
        if (Z_TYPE(frame) != IS_UNDEF) zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    zval query;
    ZVAL_UNDEF(&query);
    zend_call_method(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "query", sizeof("query") - 1, &query, 2, request, &frame);
    zval_ptr_dtor(&frame);
    if (EG(exception) != NULL) { if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query); RETURN_THROWS(); }
    if (Z_TYPE(query) != IS_ARRAY) { if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query); zend_throw_error(NULL, "Model::query() must return an array"); RETURN_THROWS(); }
    if (zend_is_true(model_state_property(state, "parent_node"))) add_assoc_bool(&query, "flatten", true);
    zval *group_limit = model_state_property(state, "group_limit");
    if (group_limit != NULL && Z_TYPE_P(group_limit) == IS_LONG && Z_LVAL_P(group_limit) > 0) add_assoc_long(&query, "limit_per_parent", Z_LVAL_P(group_limit));
    if (zend_is_true(model_state_property(state, "delete_lock"))) add_assoc_bool(&query, "no_cascade_delete", true);
    zval *key_name = model_state_property(state, "key_name");
    if (key_name != NULL && Z_TYPE_P(key_name) == IS_STRING && Z_STRLEN_P(key_name) > 0) add_assoc_str(&query, "key_by", zend_string_copy(Z_STR_P(key_name)));
    zval *possible = model_state_property(state, "possible");
    if (possible != NULL && Z_TYPE_P(possible) == IS_ARRAY) {
        zval *column = zend_hash_str_find(Z_ARRVAL_P(possible), "column", sizeof("column") - 1);
        zval *value = zend_hash_str_find(Z_ARRVAL_P(possible), "value", sizeof("value") - 1);
        if (column == NULL || Z_TYPE_P(column) != IS_STRING || value == NULL) {
            zval_ptr_dtor(&query); zend_throw_error(NULL, "Model possible has an invalid native state"); RETURN_THROWS();
        }
        zval p, if_parent;
        ZVAL_UNDEF(&p);
        zend_call_method(Z_OBJ_P(request), Z_OBJCE_P(request), NULL, "param", sizeof("param") - 1, &p, 1, value, NULL);
        if (EG(exception) != NULL) { zval_ptr_dtor(&query); if (Z_TYPE(p) != IS_UNDEF) zval_ptr_dtor(&p); RETURN_THROWS(); }
        array_init(&if_parent);
        add_assoc_str(&if_parent, "column", zend_string_copy(Z_STR_P(column)));
        add_assoc_zval(&if_parent, "p", &p);
        add_assoc_zval(&query, "if_parent", &if_parent);
    }
    zval name, many_arg;
    ZVAL_UNDEF(&name); ZVAL_BOOL(&many_arg, many);
    zend_call_method_with_1_params(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "resultname", &name, &many_arg);
    if (EG(exception) != NULL) { zval_ptr_dtor(&query); if (Z_TYPE(name) != IS_UNDEF) zval_ptr_dtor(&name); RETURN_THROWS(); }
    if (Z_TYPE(name) != IS_STRING) { zval_ptr_dtor(&query); if (Z_TYPE(name) != IS_UNDEF) zval_ptr_dtor(&name); zend_throw_error(NULL, "Model::resultName() must return a string"); RETURN_THROWS(); }
    array_init(return_value);
    add_assoc_str(return_value, "rel", Z_STR(name));
    add_assoc_zval(return_value, "query", &query);
    add_assoc_string(return_value, "kind", many ? "many" : "one");
    zval *matches = model_state_property(state, "matches");
    if (matches == NULL || Z_TYPE_P(matches) != IS_ARRAY) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "Model matches has an invalid native state"); RETURN_THROWS(); }
    zval copy; ZVAL_COPY(&copy, matches); add_assoc_zval(return_value, "keys", &copy);
}

ZEND_METHOD(Polyspec_Orm_Model, subqueryIr)
{
    static const char *const scalar_types[] = {NULL, NULL, "bool"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 3)) RETURN_THROWS();
    zval *request, *outer;
    bool scalar;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT(request)
        Z_PARAM_OBJECT(outer)
        Z_PARAM_BOOL(scalar)
    ZEND_PARSE_PARAMETERS_END();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval *conn = model_state_property(state, "conn");
    if (conn != NULL && Z_TYPE_P(conn) != IS_NULL) { query_throw_config("a subquery model cannot have its own connection"); RETURN_THROWS(); }
    zval *relations = model_state_property(state, "relations");
    if (relations != NULL && Z_TYPE_P(relations) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(relations)) != 0) { query_throw_config("a subquery model cannot load relations"); RETURN_THROWS(); }
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!query_make_frame(ZEND_THIS, outer, &frame)) { if (Z_TYPE(frame) != IS_UNDEF) zval_ptr_dtor(&frame); RETURN_THROWS(); }
    zval query;
    ZVAL_UNDEF(&query);
    zend_call_method(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "query", sizeof("query") - 1, &query, 2, request, &frame);
    zval_ptr_dtor(&frame);
    if (EG(exception) != NULL) { if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query); RETURN_THROWS(); }
    if (Z_TYPE(query) != IS_ARRAY) { if (Z_TYPE(query) != IS_UNDEF) zval_ptr_dtor(&query); zend_throw_error(NULL, "Model::query() must return an array"); RETURN_THROWS(); }
    zend_hash_str_del(Z_ARRVAL(query), "columns", sizeof("columns") - 1);
    zval *agg = model_state_property(state, "agg");
    zval *agg_fn = model_state_property(state, "agg_fn");
    if (scalar && agg != NULL && Z_TYPE_P(agg) == IS_STRING && Z_STRLEN_P(agg) > 0) {
        array_init(return_value);
        add_assoc_zval(return_value, "query", &query);
        add_assoc_str(return_value, "column", zend_string_copy(Z_STR_P(agg)));
        if (agg_fn != NULL && Z_TYPE_P(agg_fn) == IS_STRING) add_assoc_str(return_value, "agg", zend_string_copy(Z_STR_P(agg_fn)));
        else { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "Model aggregate function has invalid native state"); RETURN_THROWS(); }
        return;
    }
    zval *columns = model_state_property(state, "add_columns");
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(columns)) != 1) {
        zval_ptr_dtor(&query); query_throw_config("a subquery model must add exactly one column with addColumn<Col>()"); RETURN_THROWS();
    }
    zval *column = zend_hash_index_find(Z_ARRVAL_P(columns), 0);
    if (column == NULL || Z_TYPE_P(column) != IS_STRING) { zval_ptr_dtor(&query); zend_throw_error(NULL, "Model addColumns has invalid native state"); RETURN_THROWS(); }
    array_init(return_value);
    add_assoc_zval(return_value, "query", &query);
    add_assoc_str(return_value, "column", zend_string_copy(Z_STR_P(column)));
}

static bool query_ir_callable(zval *function, zval *request, zval *ir)
{
    zval callable, request_copy, method;
    array_init(&callable);
    ZVAL_COPY(&request_copy, request);
    ZVAL_STRING(&method, "param");
    add_next_index_zval(&callable, &request_copy);
    add_next_index_zval(&callable, &method);
    zval arg;
    ZVAL_COPY(&arg, &callable);
    ZVAL_UNDEF(ir);
    zend_call_method(Z_OBJ_P(function), Z_OBJCE_P(function), NULL, "ir", sizeof("ir") - 1, ir, 1, &arg, NULL);
    zval_ptr_dtor(&arg);
    zval_ptr_dtor(&callable);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Model, columnsIr)
{
    zval *request;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(request) ZEND_PARSE_PARAMETERS_END();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval out; array_init(&out);
    zval *mode = model_state_property(state, "column_mode");
    if (mode != NULL && Z_TYPE_P(mode) == IS_STRING && Z_STRLEN_P(mode) > 0) {
        zval copy; ZVAL_COPY(&copy, mode); add_assoc_zval(&out, "mode", &copy);
    }
    zval *add = model_state_property(state, "add_columns");
    if (add != NULL && Z_TYPE_P(add) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(add)) > 0) {
        zval copy; ZVAL_COPY(&copy, add); add_assoc_zval(&out, "add", &copy);
    }
    zval *remove = model_state_property(state, "remove_columns");
    if (remove != NULL && Z_TYPE_P(remove) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(remove)) > 0) {
        zval copy; ZVAL_COPY(&copy, remove); add_assoc_zval(&out, "remove", &copy);
    }
    zval *outputs = model_state_property(state, "outputs");
    if (outputs != NULL && Z_TYPE_P(outputs) == IS_ARRAY) {
        zend_string *name; zval *spec;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(outputs), name, spec) {
            if (name == NULL || Z_TYPE_P(spec) != IS_ARRAY) continue;
            zval *fn_spec = zend_hash_str_find(Z_ARRVAL_P(spec), "fn", sizeof("fn") - 1);
            if (fn_spec != NULL && Z_TYPE_P(fn_spec) == IS_ARRAY) {
                zval *column = zend_hash_index_find(Z_ARRVAL_P(fn_spec), 0);
                zval *function = zend_hash_index_find(Z_ARRVAL_P(fn_spec), 1);
                if (column == NULL || Z_TYPE_P(column) != IS_STRING || function == NULL || Z_TYPE_P(function) != IS_OBJECT) {
                    zval_ptr_dtor(&out); zend_throw_error(NULL, "Model output function has invalid native state"); RETURN_THROWS();
                }
                zval fn_ir;
                if (!query_ir_callable(function, request, &fn_ir)) { zval_ptr_dtor(&out); if (Z_TYPE(fn_ir) != IS_UNDEF) zval_ptr_dtor(&fn_ir); RETURN_THROWS(); }
                zval item; array_init(&item);
                zval col_copy; ZVAL_COPY(&col_copy, column); add_assoc_zval(&item, "column", &col_copy); add_assoc_zval(&item, "fn", &fn_ir);
                zval *fn_out = zend_hash_str_find(Z_ARRVAL(out), "fn", sizeof("fn") - 1);
                if (fn_out == NULL) { zval fresh; array_init(&fresh); zend_hash_str_update(Z_ARRVAL(out), "fn", sizeof("fn") - 1, &fresh); fn_out = zend_hash_str_find(Z_ARRVAL(out), "fn", sizeof("fn") - 1); }
                if (Z_TYPE_P(fn_out) != IS_ARRAY) { zval_ptr_dtor(&item); zval_ptr_dtor(&out); zend_throw_error(NULL, "columns IR fn has invalid shape"); RETURN_THROWS(); }
                SEPARATE_ARRAY(fn_out); zend_hash_update(Z_ARRVAL_P(fn_out), name, &item);
                continue;
            }
            zval *closure = zend_hash_str_find(Z_ARRVAL_P(spec), "sub", sizeof("sub") - 1);
            if (closure == NULL || Z_TYPE_P(closure) != IS_OBJECT) { zval_ptr_dtor(&out); zend_throw_error(NULL, "Model output subquery has invalid native state"); RETURN_THROWS(); }
            zval model, retval; ZVAL_UNDEF(&retval);
            ZVAL_COPY(&model, ZEND_THIS);
            zend_fcall_info fci; zend_fcall_info_cache fcc;
            if (zend_fcall_info_init(closure, 0, &fci, &fcc, NULL, NULL) != SUCCESS) { zval_ptr_dtor(&model); zval_ptr_dtor(&out); RETURN_THROWS(); }
            fci.retval = &retval; fci.params = &model; fci.param_count = 1;
            zend_call_function(&fci, &fcc); zval_ptr_dtor(&model);
            if (EG(exception) != NULL) { if (Z_TYPE(retval) != IS_UNDEF) zval_ptr_dtor(&retval); zval_ptr_dtor(&out); RETURN_THROWS(); }
            zend_class_entry *model_ce = query_class("Polyspec\\Orm\\Model");
            if (Z_TYPE(retval) != IS_OBJECT || model_ce == NULL || !instanceof_function(Z_OBJCE(retval), model_ce)) {
                if (Z_TYPE(retval) != IS_UNDEF) zval_ptr_dtor(&retval);
                zval_ptr_dtor(&out); zend_string *message = strpprintf(0, "the %s callback must return a model", ZSTR_VAL(name)); query_throw_orm("CONFIG", message); zend_string_release(message); RETURN_THROWS();
            }
            zval scalar, sub_ir; ZVAL_TRUE(&scalar); ZVAL_UNDEF(&sub_ir);
            zval callable, target, method, args[3]; array_init(&callable); ZVAL_COPY(&target, &retval); ZVAL_STRING(&method, "subqueryIr"); add_next_index_zval(&callable, &target); add_next_index_zval(&callable, &method);
            zend_fcall_info call_info; zend_fcall_info_cache call_cache;
            if (zend_fcall_info_init(&callable, 0, &call_info, &call_cache, NULL, NULL) != SUCCESS) { zval_ptr_dtor(&callable); zval_ptr_dtor(&retval); zval_ptr_dtor(&out); RETURN_THROWS(); }
            ZVAL_COPY(&args[0], request); ZVAL_COPY(&args[1], ZEND_THIS); ZVAL_COPY(&args[2], &scalar);
            call_info.retval = &sub_ir; call_info.params = args; call_info.param_count = 3; zend_call_function(&call_info, &call_cache);
            for (size_t arg_index = 0; arg_index < 3; arg_index++) zval_ptr_dtor(&args[arg_index]); zval_ptr_dtor(&callable);
            zval_ptr_dtor(&retval);
            if (EG(exception) != NULL) { if (Z_TYPE(sub_ir) != IS_UNDEF) zval_ptr_dtor(&sub_ir); zval_ptr_dtor(&out); RETURN_THROWS(); }
            zval *sub_out = zend_hash_str_find(Z_ARRVAL(out), "sub", sizeof("sub") - 1);
            if (sub_out == NULL) { zval fresh; array_init(&fresh); zend_hash_str_update(Z_ARRVAL(out), "sub", sizeof("sub") - 1, &fresh); sub_out = zend_hash_str_find(Z_ARRVAL(out), "sub", sizeof("sub") - 1); }
            if (Z_TYPE_P(sub_out) != IS_ARRAY) { zval_ptr_dtor(&sub_ir); zval_ptr_dtor(&out); zend_throw_error(NULL, "columns IR sub has invalid shape"); RETURN_THROWS(); }
            SEPARATE_ARRAY(sub_out); zend_hash_update(Z_ARRVAL_P(sub_out), name, &sub_ir);
        } ZEND_HASH_FOREACH_END();
    }
    if (zend_hash_num_elements(Z_ARRVAL(out)) == 0) { zval_ptr_dtor(&out); RETURN_NULL(); }
    ZVAL_COPY_VALUE(return_value, &out);
}


static bool query_subject(zval *model, zval *subject)
{
    if (Z_TYPE_P(model) != IS_OBJECT) return false;
    ZVAL_COPY(subject, model);
    while (true) {
        zval *group = model_state_property(model_state_of(Z_OBJ_P(subject)), "group_of");
        if (group == NULL || Z_TYPE_P(group) != IS_OBJECT) return EG(exception) == NULL;
        zval next; ZVAL_COPY(&next, group); zval_ptr_dtor(subject); ZVAL_COPY_VALUE(subject, &next);
    }
}

static bool query_invoke(zval *object, const char *method_name, zval *args, uint32_t argc, zval *result)
{
    zend_class_entry *base = model_native_class_entry();
    zend_string *key = zend_string_init(method_name, strlen(method_name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = zend_hash_find_ptr(&base->function_table, key);
    zend_string_release(key);
    if (fn == NULL) {
        zend_throw_error(NULL, "Native Model helper %s is not registered", method_name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, Z_OBJ_P(object), Z_OBJCE_P(object), result, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool query_param(zval *request, zval *value, zval *param)
{
    ZVAL_UNDEF(param);
    zend_call_method(Z_OBJ_P(request), Z_OBJCE_P(request), NULL, "param", sizeof("param") - 1, param, 1, value, NULL);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Model, predIr)
{
    zval *predicate, *request, *frame;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY(predicate)
        Z_PARAM_OBJECT(request)
        Z_PARAM_OBJECT(frame)
    ZEND_PARSE_PARAMETERS_END();
    zval *kind = zend_hash_str_find(Z_ARRVAL_P(predicate), "kind", sizeof("kind") - 1);
    zval *op = zend_hash_str_find(Z_ARRVAL_P(predicate), "op", sizeof("op") - 1);
    if (kind == NULL || Z_TYPE_P(kind) != IS_STRING || op == NULL || Z_TYPE_P(op) != IS_STRING) { zend_throw_error(NULL, "predicate has invalid native shape"); RETURN_THROWS(); }
    array_init(return_value);
    if (!zend_string_equals_literal(Z_STR_P(kind), "tuple")) {
        zval *column = zend_hash_str_find(Z_ARRVAL_P(predicate), "column", sizeof("column") - 1);
        if (column == NULL) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "predicate column is missing"); RETURN_THROWS(); }
        zval copy; ZVAL_COPY(&copy, column); add_assoc_zval(return_value, "column", &copy);
    }
    zval op_copy; ZVAL_COPY(&op_copy, op); add_assoc_zval(return_value, "op", &op_copy);
    zval *value = zend_hash_str_find(Z_ARRVAL_P(predicate), "value", sizeof("value") - 1);
    if (zend_string_equals_literal(Z_STR_P(kind), "tuple")) {
        zval *cols = zend_hash_str_find(Z_ARRVAL_P(predicate), "cols", sizeof("cols") - 1);
        if (cols == NULL || value == NULL || Z_TYPE_P(value) != IS_ARRAY) goto invalid_pred;
        zval copy; ZVAL_COPY(&copy, cols); add_assoc_zval(return_value, "cols", &copy);
        zval ps; array_init(&ps); zval *row, *cell;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(value), row) {
            if (Z_TYPE_P(row) != IS_ARRAY) { zval_ptr_dtor(&ps); goto invalid_pred; }
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), cell) { zval p; if (!query_param(request, cell, &p)) { zval_ptr_dtor(&ps); goto exception_pred; } add_next_index_zval(&ps, &p); } ZEND_HASH_FOREACH_END();
        } ZEND_HASH_FOREACH_END();
        add_assoc_zval(return_value, "ps", &ps);
    } else if (zend_string_equals_literal(Z_STR_P(kind), "between")) {
        if (value == NULL || Z_TYPE_P(value) != IS_ARRAY) goto invalid_pred;
        zval ps; array_init(&ps); zval *cell;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(value), cell) { zval p; if (!query_param(request, cell, &p)) { zval_ptr_dtor(&ps); goto exception_pred; } add_next_index_zval(&ps, &p); } ZEND_HASH_FOREACH_END();
        add_assoc_zval(return_value, "ps", &ps);
    } else if (zend_string_equals_literal(Z_STR_P(kind), "list")) {
        if (value == NULL || Z_TYPE_P(value) != IS_ARRAY) goto invalid_pred;
        zend_class_entry *request_ce = Z_OBJCE_P(request);
        zval callable, method, values; array_init(&callable); ZVAL_STRING(&method, "padIn"); add_next_index_str(&callable, zend_string_copy(request_ce->name)); add_next_index_zval(&callable, &method); ZVAL_COPY(&values, value);
        zval padded; ZVAL_UNDEF(&padded); zval args[1]; ZVAL_COPY(&args[0], &values);
        zend_fcall_info fci; zend_fcall_info_cache fcc;
        if (zend_fcall_info_init(&callable, 0, &fci, &fcc, NULL, NULL) != SUCCESS) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&values); zval_ptr_dtor(&callable); goto exception_pred; }
        fci.retval = &padded; fci.params = args; fci.param_count = 1; zend_call_function(&fci, &fcc); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&values); zval_ptr_dtor(&callable);
        if (EG(exception) != NULL || Z_TYPE(padded) != IS_ARRAY) { if (Z_TYPE(padded) != IS_UNDEF) zval_ptr_dtor(&padded); goto exception_pred; }
        zval ps; array_init(&ps); zval *cell;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(padded), cell) { zval p; if (!query_param(request, cell, &p)) { zval_ptr_dtor(&padded); zval_ptr_dtor(&ps); goto exception_pred; } add_next_index_zval(&ps, &p); } ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&padded); add_assoc_zval(return_value, "ps", &ps);
    } else if (zend_string_equals_literal(Z_STR_P(kind), "null")) {
        /* Null predicates carry no bound value. */
    } else if (zend_string_equals_literal(Z_STR_P(kind), "ref")) {
        zval *reference = zend_hash_str_find(Z_ARRVAL_P(predicate), "ref", sizeof("ref") - 1);
        zval *ref_column = zend_hash_str_find(Z_ARRVAL_P(predicate), "refCol", sizeof("refCol") - 1);
        if (reference == NULL || Z_TYPE_P(reference) != IS_OBJECT || ref_column == NULL) goto invalid_pred;
        zval subject; ZVAL_UNDEF(&subject); query_subject(reference, &subject);
        if (EG(exception) != NULL || Z_TYPE(subject) != IS_OBJECT) { if (Z_TYPE(subject) != IS_UNDEF) zval_ptr_dtor(&subject); goto exception_pred; }
        zval path; ZVAL_UNDEF(&path); zend_call_method(Z_OBJ_P(frame), Z_OBJCE_P(frame), NULL, "pathof", sizeof("pathof") - 1, &path, 1, &subject, NULL); zval_ptr_dtor(&subject);
        if (EG(exception) != NULL || Z_TYPE(path) != IS_STRING) { if (Z_TYPE(path) != IS_UNDEF) zval_ptr_dtor(&path); goto exception_pred; }
        zval ref_ir; array_init(&ref_ir); add_assoc_zval(&ref_ir, "path", &path); zval copy; ZVAL_COPY(&copy, ref_column); add_assoc_zval(&ref_ir, "column", &copy); add_assoc_zval(return_value, "ref", &ref_ir);
    } else if (zend_string_equals_literal(Z_STR_P(kind), "sub")) {
        zval *sub = zend_hash_str_find(Z_ARRVAL_P(predicate), "sub", sizeof("sub") - 1);
        if (sub == NULL || Z_TYPE_P(sub) != IS_OBJECT) goto invalid_pred;
        zval subject, scalar, args[3], sub_ir; ZVAL_UNDEF(&subject); ZVAL_FALSE(&scalar);
        query_subject(ZEND_THIS, &subject);
        if (EG(exception) != NULL) goto exception_pred;
        ZVAL_COPY(&args[0], request); ZVAL_COPY(&args[1], &subject); ZVAL_COPY(&args[2], &scalar);
        bool ok = query_invoke(sub, "subqueryIr", args, 3, &sub_ir);
        for (int i = 0; i < 3; i++) zval_ptr_dtor(&args[i]); zval_ptr_dtor(&subject);
        if (!ok) { if (Z_TYPE(sub_ir) != IS_UNDEF) zval_ptr_dtor(&sub_ir); goto exception_pred; }
        add_assoc_zval(return_value, "sub", &sub_ir);
    } else if (zend_string_equals_literal(Z_STR_P(kind), "fn")) {
        zval *function = zend_hash_str_find(Z_ARRVAL_P(predicate), "fn", sizeof("fn") - 1);
        if (function == NULL || Z_TYPE_P(function) != IS_OBJECT || value == NULL) goto invalid_pred;
        zval fn_ir, p;
        if (!query_ir_callable(function, request, &fn_ir) || !query_param(request, value, &p)) { if (Z_TYPE(fn_ir) != IS_UNDEF) zval_ptr_dtor(&fn_ir); goto exception_pred; }
        add_assoc_zval(return_value, "fn", &fn_ir); add_assoc_zval(return_value, "p", &p);
    } else if (zend_string_equals_literal(Z_STR_P(kind), "valueFn")) {
        zval *function = zend_hash_str_find(Z_ARRVAL_P(predicate), "fn", sizeof("fn") - 1);
        if (function == NULL || Z_TYPE_P(function) != IS_OBJECT) goto invalid_pred;
        zval fn_ir; if (!query_ir_callable(function, request, &fn_ir)) goto exception_pred; add_assoc_zval(return_value, "value", &fn_ir);
    } else {
        if (value == NULL) goto invalid_pred;
        zval p; if (!query_param(request, value, &p)) goto exception_pred; add_assoc_zval(return_value, "p", &p);
    }
    return;
invalid_pred:
    zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "predicate has invalid native shape"); RETURN_THROWS();
exception_pred:
    zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS();
}

static void query_config_text(const char *text)
{
    zend_string *message = zend_string_init(text, strlen(text), 0);
    query_throw_orm("CONFIG", message);
    zend_string_release(message);
}

ZEND_METHOD(Polyspec_Orm_Model, groupIr)
{
    zval *nodes, *request, *frame;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY(nodes)
        Z_PARAM_OBJECT(request)
        Z_PARAM_OBJECT(frame)
    ZEND_PARSE_PARAMETERS_END();
    array_init(return_value);
    zval items; array_init(&items);
    zval *node;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(nodes), node) {
        if (Z_TYPE_P(node) != IS_ARRAY) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "where item has invalid native shape"); RETURN_THROWS(); }
        zval *conn = zend_hash_str_find(Z_ARRVAL_P(node), "conn", sizeof("conn") - 1);
        zval *pred = zend_hash_str_find(Z_ARRVAL_P(node), "pred", sizeof("pred") - 1);
        zval *group = zend_hash_str_find(Z_ARRVAL_P(node), "group", sizeof("group") - 1);
        zval *joined = zend_hash_str_find(Z_ARRVAL_P(node), "joined", sizeof("joined") - 1);
        zval item; array_init(&item);
        if (pred != NULL) {
            if (Z_TYPE_P(pred) != IS_ARRAY) { zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "predicate has invalid native shape"); RETURN_THROWS(); }
            zval args[3], pred_ir; ZVAL_COPY(&args[0], pred); ZVAL_COPY(&args[1], request); ZVAL_COPY(&args[2], frame);
            bool ok = query_invoke(ZEND_THIS, "predIr", args, 3, &pred_ir); for (int i=0;i<3;i++) zval_ptr_dtor(&args[i]);
            if (!ok) { zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); if (Z_TYPE(pred_ir)!=IS_UNDEF) zval_ptr_dtor(&pred_ir); RETURN_THROWS(); }
            if (conn != NULL && Z_TYPE_P(conn) == IS_STRING && Z_STRLEN_P(conn) > 0) { zval c; ZVAL_COPY(&c, conn); add_assoc_zval(&pred_ir, "conn", &c); }
            add_assoc_zval(&item, "pred", &pred_ir);
        } else if (group != NULL) {
            if (Z_TYPE_P(group) != IS_ARRAY) { zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "where group has invalid native shape"); RETURN_THROWS(); }
            zval args[3], group_ir; ZVAL_COPY(&args[0], group); ZVAL_COPY(&args[1], request); ZVAL_COPY(&args[2], frame);
            bool ok = query_invoke(ZEND_THIS, "groupIr", args, 3, &group_ir); for (int i=0;i<3;i++) zval_ptr_dtor(&args[i]);
            if (!ok) { zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); if (Z_TYPE(group_ir)!=IS_UNDEF) zval_ptr_dtor(&group_ir); RETURN_THROWS(); }
            if (conn != NULL && Z_TYPE_P(conn) == IS_STRING && Z_STRLEN_P(conn) > 0) { zval c; ZVAL_COPY(&c, conn); add_assoc_zval(&group_ir, "conn", &c); }
            zval *negated = zend_hash_str_find(Z_ARRVAL_P(node), "not", sizeof("not") - 1); if (negated != NULL && zend_is_true(negated)) add_assoc_bool(&group_ir, "not", true);
            add_assoc_zval(&item, "group", &group_ir);
        } else if (joined != NULL && Z_TYPE_P(joined) == IS_OBJECT) {
            zval joined_arg, is_joined; ZVAL_COPY(&joined_arg, joined); ZVAL_UNDEF(&is_joined);
            zend_call_method(Z_OBJ_P(frame), Z_OBJCE_P(frame), NULL, "joined", sizeof("joined") - 1, &is_joined, 1, &joined_arg, NULL); zval_ptr_dtor(&joined_arg);
            if (EG(exception) != NULL) { zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); if (Z_TYPE(is_joined)!=IS_UNDEF) zval_ptr_dtor(&is_joined); RETURN_THROWS(); }
            if (!zend_is_true(&is_joined)) { zval_ptr_dtor(&is_joined); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); query_config_text("joined model is not joined in the statement"); RETURN_THROWS(); }
            zval parent_arg, parent; ZVAL_COPY(&parent_arg, joined); ZVAL_UNDEF(&parent);
            zend_call_method(Z_OBJ_P(frame), Z_OBJCE_P(frame), NULL, "parentof", sizeof("parentof") - 1, &parent, 1, &parent_arg, NULL); zval_ptr_dtor(&parent_arg);
            if (EG(exception) != NULL) { zval_ptr_dtor(&is_joined); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); if (Z_TYPE(parent)!=IS_UNDEF) zval_ptr_dtor(&parent); RETURN_THROWS(); }
            zval subject; query_subject(ZEND_THIS, &subject);
            bool parent_ok = Z_TYPE(parent) == IS_OBJECT && Z_OBJ(parent) == Z_OBJ(subject); zval_ptr_dtor(&parent); zval_ptr_dtor(&subject);
            if (!parent_ok) { zval_ptr_dtor(&is_joined); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); query_config_text("joined model conditions must be placed in the model it is joined to"); RETURN_THROWS(); }
            zval placed_arg, placed; ZVAL_COPY(&placed_arg, joined); ZVAL_UNDEF(&placed);
            zend_call_method(Z_OBJ_P(frame), Z_OBJCE_P(frame), NULL, "place", sizeof("place") - 1, &placed, 1, &placed_arg, NULL); zval_ptr_dtor(&placed_arg);
            if (EG(exception) != NULL) { zval_ptr_dtor(&is_joined); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); if (Z_TYPE(placed)!=IS_UNDEF) zval_ptr_dtor(&placed); RETURN_THROWS(); }
            if (!zend_is_true(&placed)) { zval_ptr_dtor(&placed); zval_ptr_dtor(&is_joined); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); query_config_text("joined model conditions are placed twice"); RETURN_THROWS(); }
            zval *child_where = model_state_property(model_state_of(Z_OBJ_P(joined)), "where");
            zval *child_items = child_where != NULL && Z_TYPE_P(child_where)==IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(child_where), "items", sizeof("items")-1) : NULL;
            if (child_items == NULL || Z_TYPE_P(child_items) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(child_items)) == 0) { zval_ptr_dtor(&placed); zval_ptr_dtor(&is_joined); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); query_config_text("joined model has no condition to place"); RETURN_THROWS(); }
            zval path_arg, path; ZVAL_COPY(&path_arg, joined); ZVAL_UNDEF(&path);
            zend_call_method(Z_OBJ_P(frame), Z_OBJCE_P(frame), NULL, "path", sizeof("path") - 1, &path, 1, &path_arg, NULL); zval_ptr_dtor(&path_arg); zval_ptr_dtor(&is_joined); zval_ptr_dtor(&placed);
            if (EG(exception) != NULL || Z_TYPE(path) != IS_STRING) { if (Z_TYPE(path)!=IS_UNDEF) zval_ptr_dtor(&path); zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); }
            const char *path_bytes = Z_STRVAL(path); size_t path_len = Z_STRLEN(path), last = 0;
            for (size_t i=0;i<path_len;i++) if (path_bytes[i]=='/') last=i+1;
            zval join_name; ZVAL_STR(&join_name, zend_string_init(path_bytes+last, path_len-last, 0)); zval joined_ir; array_init(&joined_ir); add_assoc_zval(&joined_ir, "join", &join_name); zval_ptr_dtor(&path);
            if (conn != NULL && Z_TYPE_P(conn)==IS_STRING && Z_STRLEN_P(conn)>0) { zval c; ZVAL_COPY(&c, conn); add_assoc_zval(&joined_ir, "conn", &c); }
            add_assoc_zval(&item, "joined", &joined_ir);
        } else { zval_ptr_dtor(&item); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "where item must be a predicate, group, or joined model"); RETURN_THROWS(); }
        add_next_index_zval(&items, &item);
    } ZEND_HASH_FOREACH_END();
    add_assoc_zval(return_value, "items", &items);
}

ZEND_METHOD(Polyspec_Orm_Model, query)
{
    zval *request, *frame;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(request)
        Z_PARAM_OBJECT(frame)
    ZEND_PARSE_PARAMETERS_END();
    model_state *state = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval *error = model_state_property(state, "error");
    if (error != NULL && Z_TYPE_P(error) == IS_OBJECT) { zval copy; ZVAL_COPY(&copy, error); zend_throw_exception_object(&copy); RETURN_THROWS(); }
    zval *where = model_state_property(state, "where");
    zval *pending = where != NULL && Z_TYPE_P(where) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(where), "pending", sizeof("pending") - 1) : NULL;
    if (pending != NULL && Z_TYPE_P(pending) == IS_STRING && Z_STRLEN_P(pending) > 0) {
        zend_string *message = strpprintf(0, "connector %s without a following condition", Z_STRVAL_P(pending)); query_throw_orm("CONFIG", message); zend_string_release(message); RETURN_THROWS();
    }
    zval meta; if (!query_meta(Z_OBJ_P(ZEND_THIS), &meta)) RETURN_THROWS();
    zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
    if (entity == NULL) { zval_ptr_dtor(&meta); zend_throw_error(NULL, "Model::meta() must contain entity"); RETURN_THROWS(); }
    array_init(return_value); zval entity_copy; ZVAL_COPY(&entity_copy, entity); add_assoc_zval(return_value, "entity", &entity_copy); zval_ptr_dtor(&meta);
    zval args[1], columns; ZVAL_COPY(&args[0], request);
    if (!query_invoke(ZEND_THIS, "columnsIr", args, 1, &columns)) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); if (Z_TYPE(columns)!=IS_UNDEF) zval_ptr_dtor(&columns); RETURN_THROWS(); }
    zval_ptr_dtor(&args[0]); if (Z_TYPE(columns) != IS_NULL) add_assoc_zval(return_value, "columns", &columns); else zval_ptr_dtor(&columns);

    zval *joins = model_state_property(state, "joins");
    if (joins != NULL && Z_TYPE_P(joins) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(joins)) > 0) {
        zval join_ir; array_init(&join_ir); zval *join;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(joins), join) {
            if (Z_TYPE_P(join) != IS_ARRAY) { zval_ptr_dtor(&join_ir); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "Model joins has invalid native state"); RETURN_THROWS(); }
            zval *child = zend_hash_str_find(Z_ARRVAL_P(join), "child", sizeof("child")-1), *kind = zend_hash_str_find(Z_ARRVAL_P(join), "kind", sizeof("kind")-1), *left = zend_hash_str_find(Z_ARRVAL_P(join), "left", sizeof("left")-1), *right = zend_hash_str_find(Z_ARRVAL_P(join), "right", sizeof("right")-1);
            if (child == NULL || Z_TYPE_P(child) != IS_OBJECT || kind == NULL || left == NULL || right == NULL) { zval_ptr_dtor(&join_ir); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); zend_throw_error(NULL, "Model join record has invalid native state"); RETURN_THROWS(); }
            zval path_arg, path; ZVAL_COPY(&path_arg, child); ZVAL_UNDEF(&path); zend_call_method(Z_OBJ_P(frame), Z_OBJCE_P(frame), NULL, "path", sizeof("path")-1, &path, 1, &path_arg, NULL); zval_ptr_dtor(&path_arg);
            if (EG(exception)!=NULL || Z_TYPE(path)!=IS_STRING) { if(Z_TYPE(path)!=IS_UNDEF)zval_ptr_dtor(&path); zval_ptr_dtor(&join_ir); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); }
            zend_string *join_path = zend_string_copy(Z_STR(path));
            const char *bytes=Z_STRVAL(path); size_t len=Z_STRLEN(path), last=0; for(size_t i=0;i<len;i++)if(bytes[i]=='/')last=i+1;
            zend_string *name=zend_string_init(bytes+last,len-last,0); zval_ptr_dtor(&path);
            zval names_rv; zval *names=zend_read_property(Z_OBJCE_P(request),Z_OBJ_P(request),"names",sizeof("names")-1,1,&names_rv);
            if(Z_TYPE_P(names)!=IS_ARRAY){zend_string_release(join_path);zend_string_release(name);zval_ptr_dtor(&join_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Request::names has invalid shape");RETURN_THROWS();}
            if(zend_hash_exists(Z_ARRVAL_P(names),join_path)){zend_string *message=strpprintf(0,"join result name %s is used twice; use alias<Name>()",ZSTR_VAL(name));zend_string_release(join_path);zend_string_release(name);zval_ptr_dtor(&join_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);query_throw_orm("CONFIG",message);zend_string_release(message);RETURN_THROWS();}
            SEPARATE_ARRAY(names);
            zval mark; ZVAL_TRUE(&mark); zend_hash_update(Z_ARRVAL_P(names),join_path,&mark); zend_string_release(join_path);
            zval child_args[2], child_query; ZVAL_COPY(&child_args[0],request); ZVAL_COPY(&child_args[1],frame);
            if(!query_invoke(child,"query",child_args,2,&child_query)){for(int i=0;i<2;i++)zval_ptr_dtor(&child_args[i]);zend_string_release(name);zval_ptr_dtor(&join_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);if(Z_TYPE(child_query)!=IS_UNDEF)zval_ptr_dtor(&child_query);RETURN_THROWS();}for(int i=0;i<2;i++)zval_ptr_dtor(&child_args[i]);
            model_state *child_state=model_state_of(Z_OBJ_P(child)); zval *on=model_state_property(child_state,"on");
            if(on!=NULL&&Z_TYPE_P(on)!=IS_NULL){if(Z_TYPE_P(on)!=IS_ARRAY){zval_ptr_dtor(&child_query);zend_string_release(name);zval_ptr_dtor(&join_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Model on has invalid native state");RETURN_THROWS();}zval on_args[3], on_ir;ZVAL_COPY(&on_args[0],on);ZVAL_COPY(&on_args[1],request);ZVAL_COPY(&on_args[2],frame);if(!query_invoke(child,"groupIr",on_args,3,&on_ir)){for(int i=0;i<3;i++)zval_ptr_dtor(&on_args[i]);zval_ptr_dtor(&child_query);zend_string_release(name);zval_ptr_dtor(&join_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);if(Z_TYPE(on_ir)!=IS_UNDEF)zval_ptr_dtor(&on_ir);RETURN_THROWS();}for(int i=0;i<3;i++)zval_ptr_dtor(&on_args[i]);add_assoc_zval(&child_query,"on",&on_ir);}
            zval entry;array_init(&entry);add_assoc_str(&entry,"rel",name);zval kcopy,lcopy,rcopy;ZVAL_COPY(&kcopy,kind);ZVAL_COPY(&lcopy,left);ZVAL_COPY(&rcopy,right);add_assoc_zval(&entry,"kind",&kcopy);add_assoc_zval(&entry,"query",&child_query);add_assoc_zval(&entry,"left",&lcopy);add_assoc_zval(&entry,"right",&rcopy);add_next_index_zval(&join_ir,&entry);
        } ZEND_HASH_FOREACH_END();
        add_assoc_zval(return_value,"joins",&join_ir);
    }
    zval *where_items = where != NULL && Z_TYPE_P(where)==IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(where),"items",sizeof("items")-1):NULL;
    if(where_items!=NULL&&Z_TYPE_P(where_items)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(where_items))>0){zval group_args[3],group_ir;ZVAL_COPY(&group_args[0],where_items);ZVAL_COPY(&group_args[1],request);ZVAL_COPY(&group_args[2],frame);if(!query_invoke(ZEND_THIS,"groupIr",group_args,3,&group_ir)){for(int i=0;i<3;i++)zval_ptr_dtor(&group_args[i]);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);if(Z_TYPE(group_ir)!=IS_UNDEF)zval_ptr_dtor(&group_ir);RETURN_THROWS();}for(int i=0;i<3;i++)zval_ptr_dtor(&group_args[i]);add_assoc_zval(return_value,"where",&group_ir);}
    zval *relations=model_state_property(state,"relations");
    if(relations!=NULL&&Z_TYPE_P(relations)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(relations))>0){zval rel_ir;array_init(&rel_ir);zval *rel;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(relations),rel){if(Z_TYPE_P(rel)!=IS_ARRAY){zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Model relation has invalid native state");RETURN_THROWS();}zval *child=zend_hash_str_find(Z_ARRVAL_P(rel),"child",sizeof("child")-1),*many=zend_hash_str_find(Z_ARRVAL_P(rel),"many",sizeof("many")-1);if(child==NULL||Z_TYPE_P(child)!=IS_OBJECT||many==NULL){zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Model relation record has invalid native state");RETURN_THROWS();}model_state *child_state=model_state_of(Z_OBJ_P(child));zval *child_conn=model_state_property(child_state,"conn");if(child_conn!=NULL&&Z_TYPE_P(child_conn)!=IS_NULL){zval *child_limit=model_state_property(child_state,"limit");if(child_limit!=NULL&&Z_TYPE_P(child_limit)!=IS_NULL){zval child_meta;if(!query_meta(Z_OBJ_P(child),&child_meta)){zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);RETURN_THROWS();}zval *child_entity=zend_hash_str_find(Z_ARRVAL(child_meta),"entity",sizeof("entity")-1);zend_string *entity_text=child_entity!=NULL?zval_get_string(child_entity):zend_string_init("Model",5,0);zend_string *message=strpprintf(0,"%s relation uses limit; use groupLimit",ZSTR_VAL(entity_text));zend_string_release(entity_text);zval_ptr_dtor(&child_meta);zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);query_throw_orm("LIMIT_IN_RELATION",message);zend_string_release(message);RETURN_THROWS();}zval request_rv;zval *external=zend_read_property(Z_OBJCE_P(request),Z_OBJ_P(request),"external",sizeof("external")-1,1,&request_rv);if(Z_TYPE_P(external)!=IS_ARRAY){zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Request::external has invalid shape");RETURN_THROWS();}SEPARATE_ARRAY(external);zval *bucket=zend_hash_index_find(Z_ARRVAL_P(external),Z_OBJ_HANDLE_P(ZEND_THIS));if(bucket==NULL){zval fresh;array_init(&fresh);zend_hash_index_update(Z_ARRVAL_P(external),Z_OBJ_HANDLE_P(ZEND_THIS),&fresh);bucket=zend_hash_index_find(Z_ARRVAL_P(external),Z_OBJ_HANDLE_P(ZEND_THIS));}if(Z_TYPE_P(bucket)!=IS_ARRAY){zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Request::external parent entry has invalid shape");RETURN_THROWS();}SEPARATE_ARRAY(bucket);zval copy;ZVAL_COPY(&copy,rel);zend_hash_next_index_insert(Z_ARRVAL_P(bucket),&copy);}else{zval args[2],item;ZVAL_COPY(&args[0],many);ZVAL_COPY(&args[1],request);if(!query_invoke(child,"relationIr",args,2,&item)){zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);zval_ptr_dtor(&rel_ir);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);if(Z_TYPE(item)!=IS_UNDEF)zval_ptr_dtor(&item);RETURN_THROWS();}zval_ptr_dtor(&args[0]);zval_ptr_dtor(&args[1]);add_next_index_zval(&rel_ir,&item);}}ZEND_HASH_FOREACH_END();if(zend_hash_num_elements(Z_ARRVAL(rel_ir))>0)add_assoc_zval(return_value,"relations",&rel_ir);else zval_ptr_dtor(&rel_ir);}
    zval *order=model_state_property(state,"order");
    if(order!=NULL&&Z_TYPE_P(order)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(order))>0){zval out_order;array_init(&out_order);zval *entry;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(order),entry){if(Z_TYPE_P(entry)!=IS_ARRAY)continue;zval *random=zend_hash_str_find(Z_ARRVAL_P(entry),"random",sizeof("random")-1);zval item;array_init(&item);if(random!=NULL&&zend_is_true(random)){add_assoc_bool(&item,"random",true);}else{zval *column=zend_hash_str_find(Z_ARRVAL_P(entry),"column",sizeof("column")-1),*desc=zend_hash_str_find(Z_ARRVAL_P(entry),"desc",sizeof("desc")-1),*fn=zend_hash_str_find(Z_ARRVAL_P(entry),"fn",sizeof("fn")-1);if(column==NULL){zval_ptr_dtor(&item);zval_ptr_dtor(&out_order);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);zend_throw_error(NULL,"Model order item has no column");RETURN_THROWS();}zval c;ZVAL_COPY(&c,column);add_assoc_zval(&item,"column",&c);if(desc!=NULL&&zend_is_true(desc))add_assoc_bool(&item,"desc",true);if(fn!=NULL){zval fn_ir;if(!query_ir_callable(fn,request,&fn_ir)){zval_ptr_dtor(&item);zval_ptr_dtor(&out_order);zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value);if(Z_TYPE(fn_ir)!=IS_UNDEF)zval_ptr_dtor(&fn_ir);RETURN_THROWS();}add_assoc_zval(&item,"fn",&fn_ir);}}add_next_index_zval(&out_order,&item);}ZEND_HASH_FOREACH_END();add_assoc_zval(return_value,"order",&out_order);}
    zval *group_by=model_state_property(state,"group_by");if(group_by!=NULL&&Z_TYPE_P(group_by)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(group_by))>0){zval c;ZVAL_COPY(&c,group_by);add_assoc_zval(return_value,"group_by",&c);}
    const char *fields[]={"limit","index","lock"};const char *keys[]={"limit","force_index","lock"};for(int i=0;i<3;i++){zval *v=model_state_property(state,fields[i]);if(v==NULL||Z_TYPE_P(v)==IS_NULL)continue;if(i==0&&Z_TYPE_P(v)==IS_ARRAY){zval c;ZVAL_COPY(&c,v);add_assoc_zval(return_value,keys[i],&c);}else if(i>0&&Z_TYPE_P(v)==IS_STRING&&Z_STRLEN_P(v)>0){zval c;ZVAL_COPY(&c,v);add_assoc_zval(return_value,keys[i],&c);}}
}

ZEND_METHOD(Polyspec_Orm_Model, timeValue)
{
    static const char *const scalar_types[] = {NULL, NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zval *input, *zone;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(input)
        Z_PARAM_OBJECT(zone)
    ZEND_PARSE_PARAMETERS_END();
    if (model_time_value_in_zone(input, zone, return_value)) return;
    if (EG(exception) != NULL) RETURN_THROWS();
    zend_string *text = zval_try_get_string(input);
    if (text == NULL) RETURN_THROWS();
    zend_string *message = strpprintf(0, "invalid date value %s", ZSTR_VAL(text));
    query_throw_orm("CODEC_DECODE", message);
    zend_string_release(message);
    zend_string_release(text);
    RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, subject)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!query_subject(ZEND_THIS, return_value)) {
        if (EG(exception) == NULL) zend_throw_error(NULL, "Model subject is invalid");
        RETURN_THROWS();
    }
}
