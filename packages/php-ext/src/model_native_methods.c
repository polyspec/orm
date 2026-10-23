/* Focused native Model methods backed by model_state and model_chain. */
#include "model_native_methods.h"
#include "model_state.h"
#include "model_chain.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_API.h"
#include "Zend/zend_smart_str.h"
#include "ext/date/php_date.h"

static void model_native_fail_code(model_state *s, const char *code_name, const char *message)
{
    if (Z_TYPE_P(model_state_property(s, "error")) != IS_NULL || EG(exception) != NULL) {
        return;
    }
    zend_string *name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\OrmException is not loaded");
        return;
    }
    zval exception, code, text;
    object_init_ex(&exception, ce);
    ZVAL_STRING(&code, code_name);
    ZVAL_STRING(&text, message);
    zend_call_method_with_2_params(Z_OBJ(exception), ce, NULL, "__construct", NULL, &code, &text);
    zval_ptr_dtor(&code);
    zval_ptr_dtor(&text);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&exception);
        return;
    }
    ZVAL_COPY_VALUE(model_state_property(s, "error"), &exception);
}

void model_native_fail(model_state *s, const char *message)
{
    model_native_fail_code(s, "CONFIG", message);
}

bool model_reject_null_scalar_args(zend_execute_data *execute_data, const char *const *types, uint32_t type_count)
{
    uint32_t supplied = ZEND_CALL_NUM_ARGS(execute_data);
    if (supplied > type_count) supplied = type_count;
    for (uint32_t i = 0; i < supplied; i++) {
        if (types[i] == NULL) continue;
        zval *argument = ZEND_CALL_ARG(execute_data, i + 1);
        ZVAL_DEREF(argument);
        if (Z_TYPE_P(argument) == IS_NULL) {
            zend_argument_type_error(i + 1, "must be of type %s, null given", types[i]);
            return false;
        }
    }
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, fail)
{
    static const char *const scalar_types[] = {"string", "string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *message, *code = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_STR(message)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(code)
    ZEND_PARSE_PARAMETERS_END();
    model_native_fail_code(model_state_of(Z_OBJ_P(ZEND_THIS)), code == NULL ? "CONFIG" : ZSTR_VAL(code), ZSTR_VAL(message));
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Model, addItem)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *conn; zval *node;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(conn)
        Z_PARAM_ARRAY(node)
    ZEND_PARSE_PARAMETERS_END();
    const char *error = NULL;
    if (!model_chain_add_item(model_state_of(Z_OBJ_P(ZEND_THIS)), ZSTR_VAL(conn), ZSTR_LEN(conn), node, &error)) {
        model_native_fail(model_state_of(Z_OBJ_P(ZEND_THIS)), error);
    }
    RETURN_NULL();
}

static bool model_group_restricted(model_state *s, const char *message)
{
    if (Z_TYPE_P(model_state_property(s, "group_of")) == IS_NULL) {
        return false;
    }
    model_native_fail(s, message);
    return true;
}

static void model_return_this(zval *return_value, zend_object *object)
{
    ZVAL_OBJ_COPY(return_value, object);
}

ZEND_METHOD(Polyspec_Orm_Model, connect)
{
    zval *db;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(db)
    ZEND_PARSE_PARAMETERS_END();
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    zend_string *name = zend_string_init("Polyspec\\Orm\\Db", sizeof("Polyspec\\Orm\\Db") - 1, 0);
    zend_class_entry *db_ce = zend_lookup_class(name);
    zend_string_release(name);
    if (db_ce == NULL || !instanceof_function(Z_OBJCE_P(db), db_ce)) {
        zend_type_error("Polyspec\\Orm\\Model::connect(): Argument #1 ($db) must be of type Polyspec\\Orm\\Db, %s given", zend_zval_value_name(db));
        RETURN_THROWS();
    }
    if (!model_group_restricted(s, "connect is not allowed inside a group callback")) {
        model_state_reset(s, "conn");
        ZVAL_COPY(model_state_property(s, "conn"), db);
    }
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, __invoke)
{
    zval *db;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(db)
    ZEND_PARSE_PARAMETERS_END();
    zval arg;
    ZVAL_COPY(&arg, db);
    zend_call_method_with_1_params(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "connect", return_value, &arg);
    zval_ptr_dtor(&arg);
    if (EG(exception) != NULL) {
        RETURN_THROWS();
    }
}


static zend_class_entry *model_class_entry(void)
{
    zend_string *name = zend_string_init("Polyspec\\Orm\\Model", sizeof("Polyspec\\Orm\\Model") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    return ce;
}

static zend_string *model_debug_type(zval *value)
{
    ZVAL_DEREF(value);
    if (Z_TYPE_P(value) == IS_OBJECT) return Z_OBJCE_P(value)->name;
    const char *name = "unknown";
    switch (Z_TYPE_P(value)) {
        case IS_NULL: name = "null"; break;
        case IS_FALSE: case IS_TRUE: name = "bool"; break;
        case IS_LONG: name = "int"; break;
        case IS_DOUBLE: name = "float"; break;
        case IS_STRING: name = "string"; break;
        case IS_ARRAY: name = "array"; break;
        case IS_RESOURCE: name = "resource"; break;
        case IS_UNDEF: name = "null"; break;
        default: break;
    }
    return zend_string_init(name, strlen(name), 0);
}

static void model_copy_error(model_state *destination, model_state *source)
{
    if (Z_TYPE_P(model_state_property(destination, "error")) == IS_NULL && Z_TYPE_P(model_state_property(source, "error")) != IS_NULL) {
        ZVAL_COPY(model_state_property(destination, "error"), model_state_property(source, "error"));
    }
}

static zval *model_where_items(model_state *s)
{
    zval *items = zend_hash_str_find(Z_ARRVAL_P(model_state_property(s, "where")), "items", sizeof("items") - 1);
    return items;
}

static zend_string *model_pending(model_state *s)
{
    zval *pending = zend_hash_str_find(Z_ARRVAL_P(model_state_property(s, "where")), "pending", sizeof("pending") - 1);
    return Z_STR_P(pending);
}

static bool model_call_group(zval *owner, zval *callback, const char *conn, size_t conn_len, bool negated)
{
    model_state *parent = model_state_of(Z_OBJ_P(owner));
    zval group;
    object_init_ex(&group, Z_OBJCE_P(owner));
    if (EG(exception) != NULL) return false;
    model_state *child = model_state_of(Z_OBJ(group));
    ZVAL_COPY(model_state_property(child, "group_of"), owner);

    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(callback, 0, &fci, &fcc, NULL, NULL) != SUCCESS) {
        zval_ptr_dtor(&group);
        return false;
    }
    zval arg, retval;
    ZVAL_COPY(&arg, &group);
    ZVAL_UNDEF(&retval);
    fci.retval = &retval;
    fci.params = &arg;
    fci.param_count = 1;
    zend_call_function(&fci, &fcc);
    zval_ptr_dtor(&arg);
    if (Z_TYPE(retval) != IS_UNDEF) zval_ptr_dtor(&retval);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&group);
        return false;
    }

    model_copy_error(parent, child);
    if (Z_TYPE_P(model_state_property(parent, "error")) == IS_NULL) {
        zval *items = model_where_items(child);
        if (items == NULL || Z_TYPE_P(items) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(items)) == 0) {
            char message[128];
            snprintf(message, sizeof(message), "%.*s%s group callback added no condition",
                (int)conn_len, conn, negated ? " not" : "");
            model_native_fail(parent, message);
        } else if (ZSTR_LEN(model_pending(child)) != 0) {
            zend_string *pending = model_pending(child);
            smart_str message = {0};
            smart_str_append_printf(&message, "connector %s without a following condition", ZSTR_VAL(pending));
            zend_string *text = smart_str_extract(&message);
            model_native_fail(parent, ZSTR_VAL(text));
            zend_string_release(text);
        } else {
            zval node, group_items;
            array_init(&node);
            ZVAL_COPY(&group_items, items);
            add_assoc_zval(&node, "group", &group_items);
            if (negated) add_assoc_bool(&node, "not", true);
            const char *error = NULL;
            if (!model_chain_add_item(parent, conn, conn_len, &node, &error)) model_native_fail(parent, error);
            zval_ptr_dtor(&node);
        }
    }
    zval_ptr_dtor(&group);
    return EG(exception) == NULL;
}

static bool model_subject_is(zval *model, zend_object *candidate)
{
    model_state *s = model_state_of(Z_OBJ_P(model));
    while (Z_TYPE_P(model_state_property(s, "group_of")) == IS_OBJECT) s = model_state_of(Z_OBJ_P(model_state_property(s, "group_of")));
    return s == candidate;
}

static void model_connector_apply(zval *owner, zval **args, uint32_t count, const char *conn, zval *result)
{
    model_state *s = model_state_of(Z_OBJ_P(owner));
    size_t conn_len = strlen(conn);
    if (count == 0) {
        const char *error = NULL;
        if (!model_chain_pending(s, conn, conn_len, &error)) model_native_fail(s, error);
        model_return_this(result, Z_OBJ_P(owner));
        return;
    }
    if (count > 1) {
        char message[64];
        snprintf(message, sizeof(message), "%s accepts at most one argument", conn);
        model_native_fail(s, message);
        model_return_this(result, Z_OBJ_P(owner));
        return;
    }
    zval *arg = &args[0][0];
    if (Z_TYPE_P(arg) == IS_OBJECT && instanceof_function(Z_OBJCE_P(arg), zend_ce_closure)) {
        model_call_group(owner, arg, conn, conn_len, false);
    } else {
        zend_class_entry *ce = model_class_entry();
        if (Z_TYPE_P(arg) == IS_OBJECT && ce != NULL && instanceof_function(Z_OBJCE_P(arg), ce)) {
            if (model_subject_is(owner, Z_OBJ_P(arg))) {
                char message[96];
                snprintf(message, sizeof(message), "%s cannot place the model inside itself", conn);
                model_native_fail(s, message);
            } else {
                zval node;
                array_init(&node);
                zval joined;
                ZVAL_COPY(&joined, arg);
                add_assoc_zval(&node, "joined", &joined);
                const char *error = NULL;
                if (!model_chain_add_item(s, conn, conn_len, &node, &error)) model_native_fail(s, error);
                zval_ptr_dtor(&node);
            }
        } else {
            zend_string *type = model_debug_type(arg);
            smart_str message = {0};
            smart_str_append_printf(&message, "%s accepts a callback or a joined model, not %s", conn, ZSTR_VAL(type));
            zend_string *text = smart_str_extract(&message);
            model_native_fail(s, ZSTR_VAL(text));
            zend_string_release(text);
            if (Z_TYPE_P(arg) != IS_OBJECT) zend_string_release(type);
        }
    }
    model_return_this(result, Z_OBJ_P(owner));
}

static void model_connector(INTERNAL_FUNCTION_PARAMETERS, const char *conn)
{
    zval *args = NULL;
    uint32_t count = 0;
    ZEND_PARSE_PARAMETERS_START(0, -1)
        Z_PARAM_VARIADIC('*', args, count)
    ZEND_PARSE_PARAMETERS_END();
    model_connector_apply(ZEND_THIS, &args, count, conn, return_value);
}

ZEND_METHOD(Polyspec_Orm_Model, connector)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *conn; zval *values;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(conn)
        Z_PARAM_ARRAY(values)
    ZEND_PARSE_PARAMETERS_END();
    uint32_t count = zend_hash_num_elements(Z_ARRVAL_P(values));
    zval *flat = count == 0 ? NULL : safe_emalloc(count, sizeof(zval), 0);
    uint32_t index = 0; zval *value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(values), value) { ZVAL_COPY(&flat[index++], value); } ZEND_HASH_FOREACH_END();
    model_connector_apply(ZEND_THIS, &flat, count, ZSTR_VAL(conn), return_value);
    for (uint32_t i = 0; i < count; i++) zval_ptr_dtor(&flat[i]);
    if (flat != NULL) efree(flat);
    if (EG(exception) != NULL) RETURN_THROWS();
}

static void model_negated(INTERNAL_FUNCTION_PARAMETERS, const char *conn, size_t conn_len)
{
    zval *callback;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(callback, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    model_call_group(ZEND_THIS, callback, conn, conn_len, true);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, negated)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *conn; zval *callback;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(conn)
        Z_PARAM_OBJECT_OF_CLASS(callback, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    model_call_group(ZEND_THIS, callback, ZSTR_VAL(conn), ZSTR_LEN(conn), true);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Model, and) { model_connector(INTERNAL_FUNCTION_PARAM_PASSTHRU, "and"); }
ZEND_METHOD(Polyspec_Orm_Model, or) { model_connector(INTERNAL_FUNCTION_PARAM_PASSTHRU, "or"); }
ZEND_METHOD(Polyspec_Orm_Model, not) { model_negated(INTERNAL_FUNCTION_PARAM_PASSTHRU, "", 0); }
ZEND_METHOD(Polyspec_Orm_Model, andNot) { model_negated(INTERNAL_FUNCTION_PARAM_PASSTHRU, "and", 3); }
ZEND_METHOD(Polyspec_Orm_Model, orNot) { model_negated(INTERNAL_FUNCTION_PARAM_PASSTHRU, "or", 2); }


ZEND_METHOD(Polyspec_Orm_Model, on)
{
    zval *callback;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(callback, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    model_state *parent = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (model_group_restricted(parent, "on is not allowed inside a group callback")) {
        model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
        return;
    }
    zval group;
    object_init_ex(&group, Z_OBJCE_P(ZEND_THIS));
    if (EG(exception) != NULL) RETURN_THROWS();
    model_state *child = model_state_of(Z_OBJ(group));
    ZVAL_COPY(model_state_property(child, "group_of"), ZEND_THIS);
    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(callback, 0, &fci, &fcc, NULL, NULL) != SUCCESS) {
        zval_ptr_dtor(&group);
        RETURN_THROWS();
    }
    zval arg, retval;
    ZVAL_COPY(&arg, &group);
    ZVAL_UNDEF(&retval);
    fci.retval = &retval;
    fci.params = &arg;
    fci.param_count = 1;
    zend_call_function(&fci, &fcc);
    zval_ptr_dtor(&arg);
    if (Z_TYPE(retval) != IS_UNDEF) zval_ptr_dtor(&retval);
    if (EG(exception) == NULL) {
        model_copy_error(parent, child);
        if (Z_TYPE_P(model_state_property(parent, "error")) == IS_NULL) {
            zval *items = model_where_items(child);
            if (ZSTR_LEN(model_pending(child)) != 0) {
                zend_string *pending = model_pending(child);
                smart_str message = {0};
                smart_str_append_printf(&message, "connector %s without a following condition", ZSTR_VAL(pending));
                zend_string *text = smart_str_extract(&message);
                model_native_fail(parent, ZSTR_VAL(text));
                zend_string_release(text);
            } else if (items == NULL || Z_TYPE_P(items) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(items)) == 0) {
                model_native_fail(parent, "on callback added no condition");
            } else {
                model_state_reset(parent, "on");
                model_state_property_set(parent, "on", items);
            }
        }
    }
    zval_ptr_dtor(&group);
    if (EG(exception) != NULL) RETURN_THROWS();
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

static void model_relation(INTERNAL_FUNCTION_PARAMETERS, bool many)
{
    zval *child_value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(child_value)
    ZEND_PARSE_PARAMETERS_END();
    model_state *parent = model_state_of(Z_OBJ_P(ZEND_THIS));
    zend_class_entry *ce = model_class_entry();
    if (ce == NULL || !instanceof_function(Z_OBJCE_P(child_value), ce)) {
        zend_type_error("Polyspec\\Orm\\Model::relation(): Argument #1 ($child) must be of type Polyspec\\Orm\\Model, %s given", zend_zval_value_name(child_value));
        RETURN_THROWS();
    }
    if (!model_group_restricted(parent, "relation is not allowed inside a group callback")) {
        model_state *child = model_state_of(Z_OBJ_P(child_value));
        if (zend_hash_num_elements(Z_ARRVAL_P(model_state_property(child, "matches"))) == 0) {
            zend_string *entity = zend_string_init("", 0, 0);
            /* The complete method reads static meta()['entity']; retain a clear error if metadata dispatch is unavailable. */
            zval meta;
            ZVAL_UNDEF(&meta);
            zend_call_method_with_0_params(NULL, ce, NULL, "meta", &meta);
            if (EG(exception) == NULL && Z_TYPE(meta) == IS_ARRAY) {
                zval *entity_value = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
                if (entity_value != NULL) entity = zval_get_string(entity_value);
            }
            if (Z_TYPE(meta) != IS_UNDEF) zval_ptr_dtor(&meta);
            if (EG(exception) != NULL) { zend_string_release(entity); RETURN_THROWS(); }
            smart_str message = {0};
            smart_str_append_printf(&message, "relation child %s requires match<L>With<R>()", ZSTR_VAL(entity));
            zend_string *text = smart_str_extract(&message);
            model_native_fail(parent, ZSTR_VAL(text));
            zend_string_release(text);
            zend_string_release(entity);
        } else {
            zval relation;
            array_init(&relation);
            add_assoc_bool(&relation, "many", many);
            zval related;
            ZVAL_COPY(&related, child_value);
            add_assoc_zval(&relation, "child", &related);
            model_state_property_separate(parent, "relations");
            if (EG(exception) != NULL) { zval_ptr_dtor(&relation); RETURN_THROWS(); }
            zend_hash_next_index_insert(Z_ARRVAL_P(model_state_property(parent, "relations")), &relation);
        }
    }
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, addRelation)
{
    static const char *const scalar_types[] = {"bool", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    bool many; zval *child_value;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_BOOL(many)
        Z_PARAM_OBJECT(child_value)
    ZEND_PARSE_PARAMETERS_END();
    zend_class_entry *model_ce = model_class_entry();
    if (model_ce == NULL || !instanceof_function(Z_OBJCE_P(child_value), model_ce)) {
        zend_type_error("Polyspec\\Orm\\Model::addRelation(): Argument #2 ($child) must be of type Polyspec\\Orm\\Model, %s given", zend_zval_value_name(child_value));
        RETURN_THROWS();
    }
    model_state *parent = model_state_of(Z_OBJ_P(ZEND_THIS));
    model_state *child = model_state_of(Z_OBJ_P(child_value));
    if (Z_TYPE_P(model_state_property(parent, "group_of")) != IS_NULL) {
        model_native_fail(parent, "relation is not allowed inside a group callback");
    } else if (zend_hash_num_elements(Z_ARRVAL_P(model_state_property(child, "matches"))) == 0) {
        zval meta; ZVAL_UNDEF(&meta);
        zend_call_method_with_0_params(NULL, Z_OBJCE_P(child_value), NULL, "meta", &meta);
        if (EG(exception) != NULL || Z_TYPE(meta) != IS_ARRAY) { if (Z_TYPE(meta) != IS_UNDEF) zval_ptr_dtor(&meta); RETURN_THROWS(); }
        zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
        zend_string *entity_name = entity == NULL ? zend_string_init("Model", sizeof("Model") - 1, 0) : zval_get_string(entity);
        zval_ptr_dtor(&meta);
        if (EG(exception) != NULL) { zend_string_release(entity_name); RETURN_THROWS(); }
        zend_string *message = strpprintf(0, "relation child %s requires match<L>With<R>()", ZSTR_VAL(entity_name));
        model_native_fail(parent, ZSTR_VAL(message)); zend_string_release(message); zend_string_release(entity_name);
    } else {
        zval relation; array_init(&relation); add_assoc_bool(&relation, "many", many);
        zval child_copy; ZVAL_COPY(&child_copy, child_value); add_assoc_zval(&relation, "child", &child_copy);
        model_state_property_separate(parent, "relations");
        if (EG(exception) != NULL) { zval_ptr_dtor(&relation); RETURN_THROWS(); }
        zend_hash_next_index_insert(Z_ARRVAL_P(model_state_property(parent, "relations")), &relation);
    }
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, relation) { model_relation(INTERNAL_FUNCTION_PARAM_PASSTHRU, false); }
ZEND_METHOD(Polyspec_Orm_Model, relations) { model_relation(INTERNAL_FUNCTION_PARAM_PASSTHRU, true); }

ZEND_METHOD(Polyspec_Orm_Model, limit)
{
    static const char *const scalar_types[] = {"int", "int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_long offset, count;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_LONG(offset)
        Z_PARAM_LONG(count)
    ZEND_PARSE_PARAMETERS_END();
    const char *error = NULL;
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (!model_chain_limit(s, offset, count, &error)) model_native_fail(s, error);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, orderByRandom)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_chain_order_random(model_state_of(Z_OBJ_P(ZEND_THIS)));
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, removeAllColumns)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_chain_column_mode(model_state_of(Z_OBJ_P(ZEND_THIS)), "none", sizeof("none") - 1);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, addAllColumns)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_chain_column_mode(model_state_of(Z_OBJ_P(ZEND_THIS)), "all", sizeof("all") - 1);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, parentNode)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_chain_parent_node(model_state_of(Z_OBJ_P(ZEND_THIS)));
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, groupLimit)
{
    static const char *const scalar_types[] = {"int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_long count;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_LONG(count)
    ZEND_PARSE_PARAMETERS_END();
    const char *error = NULL;
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (!model_chain_group_limit(s, count, &error)) model_native_fail(s, error);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, expectRevision)
{
    static const char *const scalar_types[] = {"string", "int"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *column;
    zend_long revision;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_LONG(revision)
    ZEND_PARSE_PARAMETERS_END();
    model_chain_expect_revision(model_state_of(Z_OBJ_P(ZEND_THIS)), ZSTR_VAL(column), ZSTR_LEN(column), revision);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, deleteLock)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_chain_delete_lock(model_state_of(Z_OBJ_P(ZEND_THIS)));
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

static void model_set_fetch_callback(INTERNAL_FUNCTION_PARAMETERS, bool key)
{
    zval *fn;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(fn, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (key) model_chain_fetch_key(s, fn); else model_chain_fetch_value(s, fn);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, fetchKey) { model_set_fetch_callback(INTERNAL_FUNCTION_PARAM_PASSTHRU, true); }
ZEND_METHOD(Polyspec_Orm_Model, fetchValue) { model_set_fetch_callback(INTERNAL_FUNCTION_PARAM_PASSTHRU, false); }

#define MODEL_LOCK_METHOD(method, mode) \
    ZEND_METHOD(Polyspec_Orm_Model, method) { \
        ZEND_PARSE_PARAMETERS_NONE(); \
        model_chain_lock(model_state_of(Z_OBJ_P(ZEND_THIS)), mode, sizeof(mode) - 1); \
        model_return_this(return_value, Z_OBJ_P(ZEND_THIS)); \
    }
MODEL_LOCK_METHOD(forUpdate, "update")
MODEL_LOCK_METHOD(forShare, "share")
MODEL_LOCK_METHOD(forUpdateNoWait, "update_nowait")
MODEL_LOCK_METHOD(forShareNoWait, "share_nowait")

ZEND_METHOD(Polyspec_Orm_Model, duplication)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(model)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *name = zend_string_init("Polyspec\\Orm\\Model", sizeof("Polyspec\\Orm\\Model") - 1, 0);
    zend_class_entry *model_ce = zend_lookup_class(name);
    zend_string_release(name);
    if (model_ce == NULL || !instanceof_function(Z_OBJCE_P(model), model_ce)) {
        zend_type_error("Polyspec\\Orm\\Model::duplication(): Argument #1 ($model) must be of type Polyspec\\Orm\\Model, %s given", zend_zval_value_name(model));
        RETURN_THROWS();
    }
    model_chain_duplication(model_state_of(Z_OBJ_P(ZEND_THIS)), model);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, connection)
{
    ZEND_PARSE_PARAMETERS_NONE();
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (Z_TYPE_P(model_state_property(s, "conn")) == IS_NULL) RETURN_NULL();
    RETURN_COPY(model_state_property(s, "conn"));
}

static zend_class_entry *model_lookup_class(const char *name)
{
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool model_call_method_args(zval *object, const char *method, zval *retval, uint32_t argc, zval *args)
{
    zval callable, method_name, target;
    array_init(&callable);
    ZVAL_COPY(&target, object);
    ZVAL_STRING(&method_name, method);
    add_next_index_zval(&callable, &target);
    add_next_index_zval(&callable, &method_name);
    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(&callable, 0, &fci, &fcc, NULL, NULL) != SUCCESS) {
        zval_ptr_dtor(&callable);
        return false;
    }
    ZVAL_UNDEF(retval);
    fci.retval = retval;
    fci.params = args;
    fci.param_count = argc;
    zend_call_function(&fci, &fcc);
    zval_ptr_dtor(&callable);
    return EG(exception) == NULL;
}

static bool model_result_name(zend_object *object, bool many, zend_string **result)
{
    model_state *state = model_state_of(object);
    zval *alias = model_state_property(state, "alias");
    if (alias == NULL || Z_TYPE_P(alias) != IS_STRING) {
        zend_throw_error(NULL, "Model alias has an invalid native state");
        return false;
    }
    if (Z_STRLEN_P(alias) != 0) {
        *result = zend_string_copy(Z_STR_P(alias));
        return true;
    }
    zval meta;
    ZVAL_UNDEF(&meta);
    zend_call_method_with_0_params(NULL, object->ce, NULL, "meta", &meta);
    if (EG(exception) != NULL) return false;
    zval *entity = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1) : NULL;
    if (entity == NULL || Z_TYPE_P(entity) != IS_STRING) {
        if (Z_TYPE(meta) != IS_UNDEF) zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "Model::meta() must contain a string entity");
        return false;
    }
    smart_str name = {0};
    smart_str_append(&name, Z_STR_P(entity));
    smart_str_appends(&name, many ? "_models" : "_model");
    *result = smart_str_extract(&name);
    zval_ptr_dtor(&meta);
    return true;
}

static bool model_register_join_paths(zval *model, zval *frame, zend_string *prefix)
{
    model_state *state = model_state_of(Z_OBJ_P(model));
    zval *joins = model_state_property(state, "joins");
    if (joins == NULL || Z_TYPE_P(joins) != IS_ARRAY) {
        zend_throw_error(NULL, "Model joins have an invalid native state");
        return false;
    }
    zval *join;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(joins), join) {
        if (Z_TYPE_P(join) != IS_ARRAY) {
            zend_throw_error(NULL, "Model join has an invalid native state");
            return false;
        }
        zval *child = zend_hash_str_find(Z_ARRVAL_P(join), "child", sizeof("child") - 1);
        if (child == NULL || Z_TYPE_P(child) != IS_OBJECT) {
            zend_throw_error(NULL, "Model join child is missing");
            return false;
        }
        zend_string *base = NULL;
        if (!model_result_name(Z_OBJ_P(child), false, &base)) return false;
        smart_str path_builder = {0};
        smart_str_append(&path_builder, prefix);
        smart_str_append(&path_builder, base);
        zend_string_release(base);
        zend_string *path = smart_str_extract(&path_builder);
        zval args[3], ignored;
        ZVAL_UNDEF(&ignored);
        ZVAL_COPY(&args[0], child);
        ZVAL_STR_COPY(&args[1], path);
        ZVAL_COPY(&args[2], model);
        bool ok = model_call_method_args(frame, "add", &ignored, 3, args);
        for (size_t i = 0; i < 3; i++) zval_ptr_dtor(&args[i]);
        if (Z_TYPE(ignored) != IS_UNDEF) zval_ptr_dtor(&ignored);
        if (!ok) { zend_string_release(path); return false; }
        smart_str nested_builder = {0};
        smart_str_append(&nested_builder, path);
        smart_str_appendc(&nested_builder, '/');
        zend_string *nested_prefix = smart_str_extract(&nested_builder);
        zval recursive_args[2], recursive_result;
        ZVAL_UNDEF(&recursive_result);
        ZVAL_COPY(&recursive_args[0], frame);
        ZVAL_STR(&recursive_args[1], nested_prefix);
        ok = model_call_method_args(child, "registerJoins", &recursive_result, 2, recursive_args);
        zval_ptr_dtor(&recursive_args[0]);
        zval_ptr_dtor(&recursive_args[1]);
        if (Z_TYPE(recursive_result) != IS_UNDEF) zval_ptr_dtor(&recursive_result);
        zend_string_release(path);
        if (!ok) return false;
    } ZEND_HASH_FOREACH_END();
    return true;
}

ZEND_METHOD(Polyspec_Orm_Model, registerJoins)
{
    static const char *const scalar_types[] = {NULL, "string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zval *frame;
    zend_string *prefix;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(frame)
        Z_PARAM_STR(prefix)
    ZEND_PARSE_PARAMETERS_END();
    zend_class_entry *frame_ce = model_lookup_class("Polyspec\\Orm\\Frame");
    if (frame_ce == NULL || !instanceof_function(Z_OBJCE_P(frame), frame_ce)) {
        zend_argument_type_error(1, "must be of type Polyspec\\Orm\\Frame, %s given", zend_zval_value_name(frame));
        RETURN_THROWS();
    }
    zval this_object;
    ZVAL_OBJ_COPY(&this_object, Z_OBJ_P(ZEND_THIS));
    bool ok = model_register_join_paths(&this_object, frame, prefix);
    zval_ptr_dtor(&this_object);
    if (!ok || EG(exception) != NULL) RETURN_THROWS();
    RETURN_NULL();
}


static void model_throw_orm(const char *code_name, const char *message)
{
    zend_string *name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\OrmException is not loaded");
        return;
    }
    zval exception, code, text;
    object_init_ex(&exception, ce);
    ZVAL_STRING(&code, code_name);
    ZVAL_STRING(&text, message);
    zend_call_method_with_2_params(Z_OBJ(exception), ce, NULL, "__construct", NULL, &code, &text);
    zval_ptr_dtor(&code);
    zval_ptr_dtor(&text);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&exception);
        return;
    }
    zend_throw_exception_object(&exception);
}

static bool model_meta(zend_object *object, zval *meta)
{
    ZVAL_UNDEF(meta);
    zend_call_method_with_0_params(NULL, object->ce, NULL, "meta", meta);
    return EG(exception) == NULL && Z_TYPE_P(meta) == IS_ARRAY;
}

static zval *model_meta_column(zval *meta, zend_string *column)
{
    zval *columns = zend_hash_str_find(Z_ARRVAL_P(meta), "columns", sizeof("columns") - 1);
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) return NULL;
    return zend_hash_find(Z_ARRVAL_P(columns), column);
}

static bool model_column_styled(zval *column)
{
    zval *codec = zend_hash_str_find(Z_ARRVAL_P(column), "codec", sizeof("codec") - 1);
    if (codec == NULL || Z_TYPE_P(codec) != IS_ARRAY) return false;
    static const char *const stages[] = {"ordered_json", "serialize", "yaml", "gz", "base64"};
    zval *stage;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(codec), stage) {
        if (Z_TYPE_P(stage) != IS_STRING) continue;
        for (size_t i = 0; i < sizeof(stages) / sizeof(stages[0]); i++) {
            if (zend_string_equals_cstr(Z_STR_P(stage), stages[i], strlen(stages[i]))) return true;
        }
    } ZEND_HASH_FOREACH_END();
    return false;
}


static bool model_zone(model_state *s, zval *zone)
{
    if (Z_TYPE_P(model_state_property(s, "conn")) == IS_OBJECT) {
        zend_call_method_with_0_params(Z_OBJ_P(model_state_property(s, "conn")), Z_OBJCE(*model_state_property(s, "conn")), NULL, "zone", zone);
        return EG(exception) == NULL && Z_TYPE_P(zone) == IS_OBJECT;
    }
    zend_string *name = zend_string_init("DateTimeZone", sizeof("DateTimeZone") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return false;
    object_init_ex(zone, ce);
    if (EG(exception) != NULL) return false;
    zval utc;
    ZVAL_STRING(&utc, "UTC");
    zend_call_method_with_1_params(Z_OBJ_P(zone), ce, NULL, "__construct", NULL, &utc);
    zval_ptr_dtor(&utc);
    return EG(exception) == NULL;
}

bool model_time_value_in_zone(zval *input, zval *zone, zval *ret)
{
    zend_class_entry *immutable = php_date_get_immutable_ce();
    zend_class_entry *interface = php_date_get_interface_ce();
    zval time;
    ZVAL_UNDEF(&time);
    if (Z_TYPE_P(input) == IS_OBJECT && instanceof_function(Z_OBJCE_P(input), interface)) {
        zend_call_method_with_1_params(NULL, immutable, NULL, "createfrominterface", &time, input);
    } else {
        zend_string *text = zval_try_get_string(input);
        if (text == NULL) { /* caller owns zone */ return false; }
        const char *format = NULL;
        switch (ZSTR_LEN(text)) {
            case 19: format = "!Y-m-d H:i:s"; break;
            case 26: format = "!Y-m-d H:i:s.u"; break;
            case 10: format = "!Y-m-d"; break;
            default: break;
        }
        zval input_text;
        ZVAL_STR_COPY(&input_text, text);
        if (format != NULL) {
            zval callable, fmt, class_name, method_name, args[3];
            array_init(&callable);
            ZVAL_STRING(&class_name, "DateTimeImmutable");
            ZVAL_STRING(&method_name, "createFromFormat");
            add_next_index_zval(&callable, &class_name);
            add_next_index_zval(&callable, &method_name);
            ZVAL_STRING(&fmt, format);
            ZVAL_COPY(&args[0], &fmt);
            ZVAL_COPY(&args[1], &input_text);
            ZVAL_COPY(&args[2], zone);
            call_user_function(NULL, NULL, &callable, &time, 3, args);
            for (size_t j = 0; j < 3; j++) zval_ptr_dtor(&args[j]);
            zval_ptr_dtor(&fmt);
            zval_ptr_dtor(&callable);
        }
        if (Z_TYPE(time) != IS_OBJECT && EG(exception) == NULL) {
            /* Date strings carrying an explicit UTC offset are parsed by DateTimeImmutable's standard constructor. */
            bool has_offset = false;
            for (size_t i = 0; i < ZSTR_LEN(text); i++) {
                if ((text->val[i] == '+' || text->val[i] == '-') && i > 0 && ZSTR_LEN(text) - i >= 3
                    && text->val[i + 1] >= '0' && text->val[i + 1] <= '9'
                    && text->val[i + 2] >= '0' && text->val[i + 2] <= '9') {
                    has_offset = true;
                    break;
                }
            }
            if (has_offset) {
                object_init_ex(&time, immutable);
                if (EG(exception) == NULL) zend_call_method_with_2_params(Z_OBJ(time), immutable, NULL, "__construct", NULL, &input_text, zone);
            }
        }
        zval_ptr_dtor(&input_text);
        zend_string_release(text);
    }
    if (EG(exception) != NULL) {
        zend_object *exception = EG(exception);
        EG(exception) = NULL;
        OBJ_RELEASE(exception);
        /* caller owns zone */
        if (Z_TYPE(time) != IS_UNDEF) zval_ptr_dtor(&time);
        return false;
    }
    if (Z_TYPE(time) != IS_OBJECT) {
        /* caller owns zone */
        return false;
    }
    zend_call_method_with_1_params(Z_OBJ(time), Z_OBJCE(time), NULL, "settimezone", ret, zone);
    zval_ptr_dtor(&time);
    /* caller owns zone */
    return EG(exception) == NULL && Z_TYPE_P(ret) == IS_OBJECT;
}


static bool model_time_value(model_state *s, zval *input, zval *ret)
{
    zval zone;
    ZVAL_UNDEF(&zone);
    if (!model_zone(s, &zone)) {
        if (Z_TYPE(zone) != IS_UNDEF) zval_ptr_dtor(&zone);
        return false;
    }
    bool ok = model_time_value_in_zone(input, &zone, ret);
    zval_ptr_dtor(&zone);
    return ok;
}

zend_string *model_decimal_normalize(zend_string *input, zend_long precision, zend_long scale)
{
    const char *s = ZSTR_VAL(input);
    if (precision < 1 || precision > 18 || scale < 0 || scale > precision) {
        smart_str msg = {0}; smart_str_append_printf(&msg, "decimal %s: invalid precision or scale", s);
        zend_string *text = smart_str_extract(&msg); model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text);
        return NULL;
    }

    size_t n = ZSTR_LEN(input), i = 0;
    bool negative = false;
    if (i < n && (s[i] == '+' || s[i] == '-')) { negative = s[i] == '-'; i++; }
    size_t whole_start = i;
    while (i < n && s[i] >= '0' && s[i] <= '9') i++;
    if (i == whole_start) goto invalid;
    size_t whole_end = i, frac_start = i, frac_end = i;
    if (i < n && s[i] == '.') {
        frac_start = ++i;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
        frac_end = i;
        if (frac_start == frac_end) goto invalid;
    }
    if (i != n) goto invalid;
    if (frac_end - frac_start > (size_t)scale) {
        smart_str msg = {0}; smart_str_append_printf(&msg, "decimal %s: fraction exceeds scale", s);
        zend_string *text = smart_str_extract(&msg); model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text); return NULL;
    }
    size_t first_nonzero = whole_start;
    while (first_nonzero < whole_end && s[first_nonzero] == '0') first_nonzero++;
    size_t whole_digits = first_nonzero == whole_end ? 1 : whole_end - first_nonzero;
    if ((first_nonzero == whole_end ? 0 : whole_digits) + (size_t)scale > (size_t)precision) {
        smart_str msg = {0}; smart_str_append_printf(&msg, "decimal %s: value exceeds precision", s);
        zend_string *text = smart_str_extract(&msg); model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text); return NULL;
    }
    size_t frac_len = frac_end - frac_start;
    bool zero = first_nonzero == whole_end;
    for (size_t j = frac_start; j < frac_end && zero; j++) if (s[j] != '0') zero = false;
    if (zero) negative = false;
    smart_str out = {0};
    if (negative) smart_str_appendc(&out, '-');
    if (first_nonzero == whole_end) smart_str_appendc(&out, '0');
    else smart_str_appendl(&out, s + first_nonzero, whole_end - first_nonzero);
    if (scale > 0) {
        smart_str_appendc(&out, '.');
        if (frac_len > 0) smart_str_appendl(&out, s + frac_start, frac_len);
        for (size_t j = frac_len; j < (size_t)scale; j++) smart_str_appendc(&out, '0');
    }
    return smart_str_extract(&out);
invalid:
    {
        smart_str msg = {0}; smart_str_append_printf(&msg, "decimal %s: invalid text", s);
        zend_string *text = smart_str_extract(&msg); model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text); return NULL;
    }
}

ZEND_METHOD(Polyspec_Orm_Model, readColumn)
{
    static const char *const scalar_types[] = {"string"};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 1)) RETURN_THROWS();
    zend_string *column;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(column)
    ZEND_PARSE_PARAMETERS_END();
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    zval *value = zend_hash_find(Z_ARRVAL_P(model_state_property(s, "values")), column);
    if (value == NULL) {
        smart_str message = {0};
        smart_str_append_printf(&message, "%s was not selected", ZSTR_VAL(column));
        zend_string *text = smart_str_extract(&message);
        model_throw_orm("COLUMN_UNSELECTED", ZSTR_VAL(text));
        zend_string_release(text);
        RETURN_THROWS();
    }
    zend_string *pending_name = zend_string_init("Polyspec\\Orm\\PendingTime", sizeof("Polyspec\\Orm\\PendingTime") - 1, 0);
    zend_class_entry *pending_ce = zend_lookup_class(pending_name);
    zend_string_release(pending_name);
    if (pending_ce != NULL && Z_TYPE_P(value) == IS_OBJECT && instanceof_function(Z_OBJCE_P(value), pending_ce)) {
        zval text_rv, zone_rv;
        zval *text = zend_read_property(pending_ce, Z_OBJ_P(value), "text", sizeof("text") - 1, 1, &text_rv);
        zval *zone = zend_read_property(pending_ce, Z_OBJ_P(value), "zone", sizeof("zone") - 1, 1, &zone_rv);
        if (Z_TYPE_P(text) != IS_STRING || Z_TYPE_P(zone) != IS_OBJECT) {
            zend_throw_error(NULL, "PendingTime has an invalid native value");
            RETURN_THROWS();
        }
        zval converted;
        ZVAL_UNDEF(&converted);
        if (!model_time_value_in_zone(text, zone, &converted)) {
            if (EG(exception) != NULL) RETURN_THROWS();
            smart_str message = {0};
            smart_str_append_printf(&message, "invalid date value %s", Z_STRVAL_P(text));
            zend_string *error = smart_str_extract(&message);
            model_throw_orm("CODEC_DECODE", ZSTR_VAL(error));
            zend_string_release(error);
            RETURN_THROWS();
        }
        zval_ptr_dtor(value);
        ZVAL_COPY_VALUE(value, &converted);
    }
    RETURN_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_Model, writeColumn)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *column;
    zval *input;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(column)
        Z_PARAM_ZVAL(input)
    ZEND_PARSE_PARAMETERS_END();
    model_state *s = model_state_of(Z_OBJ_P(ZEND_THIS));
    if (model_group_restricted(s, "set is not allowed inside a group callback")) {
        model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
        return;
    }
    zval meta;
    if (!model_meta(Z_OBJ_P(ZEND_THIS), &meta)) {
        if (Z_TYPE(meta) != IS_UNDEF) zval_ptr_dtor(&meta);
        if (EG(exception) != NULL) RETURN_THROWS();
        zend_throw_error(NULL, "Model::meta() must return an array");
        RETURN_THROWS();
    }
    zval *col = model_meta_column(&meta, column);
    if (col == NULL || Z_TYPE_P(col) != IS_ARRAY) {
        zval_ptr_dtor(&meta);
        zend_throw_error(NULL, "generated Model setter refers to a missing column");
        RETURN_THROWS();
    }
    zval *type = zend_hash_str_find(Z_ARRVAL_P(col), "type", sizeof("type") - 1);
    zval *nullable = zend_hash_str_find(Z_ARRVAL_P(col), "nullable", sizeof("nullable") - 1);
    zval value, set_value;
    ZVAL_COPY(&value, input);
    ZVAL_COPY(&set_value, input);
    if (Z_TYPE_P(input) != IS_NULL && type != NULL && Z_TYPE_P(type) == IS_STRING
        && zend_string_equals_literal(Z_STR_P(type), "decimal")) {
        if (Z_TYPE_P(input) != IS_STRING) {
            zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value);
            smart_str message = {0};
            smart_str_append_printf(&message, "%s requires exact decimal text", ZSTR_VAL(column));
            zend_string *text = smart_str_extract(&message);
            model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text);
            RETURN_THROWS();
        }
        zval *precision = zend_hash_str_find(Z_ARRVAL_P(col), "precision", sizeof("precision") - 1);
        zval *scale = zend_hash_str_find(Z_ARRVAL_P(col), "scale", sizeof("scale") - 1);
        zend_string *canonical = model_decimal_normalize(Z_STR_P(input),
            precision != NULL ? zval_get_long(precision) : 0, scale != NULL ? zval_get_long(scale) : 0);
        if (canonical == NULL) {
            zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value);
            RETURN_THROWS();
        }
        zval_ptr_dtor(&value);
        zval_ptr_dtor(&set_value);
        ZVAL_STR(&value, canonical);
        ZVAL_STR_COPY(&set_value, canonical);
    }
    if (Z_TYPE_P(input) != IS_NULL && type != NULL && Z_TYPE_P(type) == IS_STRING
        && (zend_string_equals_literal(Z_STR_P(type), "date") || zend_string_equals_literal(Z_STR_P(type), "datetime"))) {
        if (Z_TYPE_P(input) != IS_STRING) {
            zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value);
            smart_str message = {0};
            smart_str_append_printf(&message, "%s requires its text form", ZSTR_VAL(column));
            zend_string *text = smart_str_extract(&message);
            model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text);
            RETURN_THROWS();
        }
        zval parsed;
        ZVAL_UNDEF(&parsed);
        if (!model_time_value(s, input, &parsed)) {
            zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value);
            if (EG(exception) != NULL) RETURN_THROWS();
            smart_str message = {0};
            smart_str_append_printf(&message, "invalid date value %s", Z_STRVAL_P(input));
            zend_string *text = smart_str_extract(&message);
            model_throw_orm("CODEC_DECODE", ZSTR_VAL(text)); zend_string_release(text);
            RETURN_THROWS();
        }
        zval_ptr_dtor(&value);
        ZVAL_COPY_VALUE(&value, &parsed);
    }
    zval *codec = zend_hash_str_find(Z_ARRVAL_P(col), "codec", sizeof("codec") - 1);
    if (codec != NULL && Z_TYPE_P(codec) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0) {
        if (model_column_styled(col)) {
            zend_string *class_name = zend_string_init("Polyspec\\Orm\\StyledValue", sizeof("Polyspec\\Orm\\StyledValue") - 1, 0);
            zend_class_entry *styled_ce = zend_lookup_class(class_name);
            zend_string_release(class_name);
            if (Z_TYPE_P(input) != IS_OBJECT || styled_ce == NULL || !instanceof_function(Z_OBJCE_P(input), styled_ce)) {
                zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value);
                smart_str message = {0};
                smart_str_append_printf(&message, "%s requires StyledValue", ZSTR_VAL(column));
                zend_string *text = smart_str_extract(&message);
                model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text);
                RETURN_THROWS();
            }
            zval rv;
            zval *kind = zend_read_property(styled_ce, Z_OBJ_P(input), "kind", sizeof("kind") - 1, 1, &rv);
            if (nullable != NULL && Z_TYPE_P(nullable) == IS_FALSE && Z_TYPE_P(kind) == IS_STRING
                && zend_string_equals_literal(Z_STR_P(kind), "sql-null")) {
                zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value);
                smart_str message = {0};
                smart_str_append_printf(&message, "%s does not accept SQL NULL", ZSTR_VAL(column));
                zend_string *text = smart_str_extract(&message);
                model_throw_orm("CODEC_ENCODE", ZSTR_VAL(text)); zend_string_release(text);
                RETURN_THROWS();
            }
            zval_ptr_dtor(&set_value);
            ZVAL_COPY(&set_value, input);
            zval_ptr_dtor(&value);
            ZVAL_COPY(&value, input);
        }
    }

    model_state_property_separate(s, "values");
    if (EG(exception) != NULL) { zval_ptr_dtor(&meta); zval_ptr_dtor(&value); zval_ptr_dtor(&set_value); RETURN_THROWS(); }
    zend_hash_update(Z_ARRVAL_P(model_state_property(s, "values")), column, &value);
    zval spec;
    array_init(&spec);
    bool sql_null = Z_TYPE_P(input) == IS_NULL;
    if (!sql_null && Z_TYPE_P(input) == IS_OBJECT) {
        zend_string *styled_name = zend_string_init("Polyspec\\Orm\\StyledValue", sizeof("Polyspec\\Orm\\StyledValue") - 1, 0);
        zend_class_entry *styled_ce = zend_lookup_class(styled_name);
        zend_string_release(styled_name);
        if (styled_ce != NULL && instanceof_function(Z_OBJCE_P(input), styled_ce)) {
            zval rv;
            zval *kind = zend_read_property(styled_ce, Z_OBJ_P(input), "kind", sizeof("kind") - 1, 1, &rv);
            sql_null = Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "sql-null");
        }
    }
    if (sql_null) {
        zval_ptr_dtor(&set_value);
        add_assoc_bool(&spec, "null", true);
    } else {
        add_assoc_zval(&spec, "value", &set_value);
    }
    model_state_property_separate(s, "sets");
    if (EG(exception) != NULL) { zval_ptr_dtor(&meta); zval_ptr_dtor(&spec); RETURN_THROWS(); }
    zend_hash_update(Z_ARRVAL_P(model_state_property(s, "sets")), column, &spec);
    zval_ptr_dtor(&meta);
    model_return_this(return_value, Z_OBJ_P(ZEND_THIS));
}

ZEND_METHOD(Polyspec_Orm_Model, __clone)
{
    (void)return_value;
    ZEND_PARSE_PARAMETERS_NONE();
    /* PHP clone semantics are provided by the object's clone handler. */
}

void model_native_init(zend_class_entry *ce)
{
    model_state_set_ce(ce);
}
