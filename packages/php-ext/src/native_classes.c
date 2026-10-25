/* Native implementations of PHP library value and internal classes. */
#include "php.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"

static zend_class_entry *native_find_class(const char *name, size_t length)
{
    zend_string *class_name = zend_string_init(name, length, 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool native_config_error(const char *message)
{
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return false;
    zval error, args[2], rv;
    object_init_ex(&error, ce);
    ZVAL_STRING(&args[0], "CONFIG");
    ZVAL_STRING(&args[1], message);
    zend_call_known_function(ce->constructor, Z_OBJ(error), ce, &rv, 2, args, NULL);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&error);
        return false;
    }
    zend_throw_exception_object(&error);
    return false;
}

ZEND_METHOD(Polyspec_Orm_Config, __construct)
{
    zend_string *aes_key = ZSTR_EMPTY_ALLOC(), *blind_index_key = ZSTR_EMPTY_ALLOC();
    zend_long aes_version = 1, pool_size = 0, statement_timeout_ms = 0, pool_idle_size = 0, pool_lifetime_ms = 0;
    zend_long plan_cache_size = 256, statement_cache_size = 256;
    HashTable empty_keys;
    HashTable *aes_keys = NULL;
    bool owns_empty_keys = false;
    zval *audit_source = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 11)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(aes_key)
        Z_PARAM_STR(blind_index_key)
        Z_PARAM_LONG(aes_version)
        Z_PARAM_ARRAY_HT(aes_keys)
        Z_PARAM_LONG(pool_size)
        Z_PARAM_LONG(statement_timeout_ms)
        Z_PARAM_LONG(pool_idle_size)
        Z_PARAM_LONG(pool_lifetime_ms)
        Z_PARAM_LONG(plan_cache_size)
        Z_PARAM_LONG(statement_cache_size)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(audit_source, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();

    if (aes_keys == NULL) {
        zend_hash_init(&empty_keys, 0, NULL, ZVAL_PTR_DTOR, 0);
        aes_keys = &empty_keys;
        owns_empty_keys = true;
    }

    /* The stub arginfo supplies the PHP defaults; parse variables are initialized to those same values. */
    if (aes_version < 1 || plan_cache_size < 1 || statement_cache_size < 1) {
        native_config_error("AES version and cache sizes must be positive");
        if (owns_empty_keys) zend_hash_destroy(&empty_keys);
        RETURN_THROWS();
    }
    zval *selected = zend_hash_index_find(aes_keys, (zend_ulong)aes_version);
    if (ZSTR_LEN(aes_key) != 0 && zend_hash_num_elements(aes_keys) != 0
        && (selected == NULL || Z_TYPE_P(selected) != IS_STRING || !zend_string_equals(Z_STR_P(selected), aes_key))) {
        zend_string *message = strpprintf(0, "aesKey differs from aesKeys[" ZEND_LONG_FMT "]", aes_version);
        native_config_error(ZSTR_VAL(message));
        zend_string_release(message);
        if (owns_empty_keys) zend_hash_destroy(&empty_keys);
        RETURN_THROWS();
    }
    bool release_resolved_key = false;
    zend_string *resolved_key = ZSTR_LEN(aes_key) != 0 ? aes_key
        : (selected != NULL && Z_TYPE_P(selected) == IS_STRING ? Z_STR_P(selected) : (release_resolved_key = true, ZSTR_EMPTY_ALLOC()));
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zend_update_property_str(o->ce, o, ZEND_STRL("aesKey"), resolved_key);
    zend_update_property_str(o->ce, o, ZEND_STRL("blindIndexKey"), blind_index_key);
    zend_update_property_long(o->ce, o, ZEND_STRL("aesVersion"), aes_version);
    zval v;
    ZVAL_ARR(&v, zend_array_dup(aes_keys));
    zend_update_property(o->ce, o, ZEND_STRL("aesKeys"), &v);
    zval_ptr_dtor(&v);
    zend_update_property_long(o->ce, o, ZEND_STRL("poolSize"), pool_size);
    zend_update_property_long(o->ce, o, ZEND_STRL("statementTimeoutMs"), statement_timeout_ms);
    zend_update_property_long(o->ce, o, ZEND_STRL("poolIdleSize"), pool_idle_size);
    zend_update_property_long(o->ce, o, ZEND_STRL("poolLifetimeMs"), pool_lifetime_ms);
    zend_update_property_long(o->ce, o, ZEND_STRL("planCacheSize"), plan_cache_size);
    zend_update_property_long(o->ce, o, ZEND_STRL("statementCacheSize"), statement_cache_size);
    if (audit_source == NULL) zend_update_property_null(o->ce, o, ZEND_STRL("auditSource"));
    else zend_update_property(o->ce, o, ZEND_STRL("auditSource"), audit_source);
    if (release_resolved_key) zend_string_release(resolved_key);
    if (owns_empty_keys) zend_hash_destroy(&empty_keys);
}

ZEND_METHOD(Polyspec_Orm_Config, keyring)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zval rv, *keys = zend_read_property(o->ce, o, ZEND_STRL("aesKeys"), 1, &rv);
    zval *version = zend_read_property(o->ce, o, ZEND_STRL("aesVersion"), 1, &rv);
    zval *key = zend_read_property(o->ce, o, ZEND_STRL("aesKey"), 1, &rv);
    zval key_array;
    if (zend_hash_num_elements(Z_ARRVAL_P(keys)) == 0) {
        if (Z_STRLEN_P(key) == 0) {
            native_config_error("secret aes is not configured");
            RETURN_THROWS();
        }
        array_init(&key_array);
        Z_TRY_ADDREF_P(key);
        zend_hash_index_update(Z_ARRVAL(key_array), (zend_ulong)Z_LVAL_P(version), key);
        keys = &key_array;
    } else {
        ZVAL_COPY(&key_array, keys);
    }
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\AesKeyring"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) {
        zval_ptr_dtor(&key_array);
        RETURN_THROWS();
    }
    object_init_ex(return_value, ce);
    zval args[2], rv_call;
    ZVAL_COPY_VALUE(&args[0], &key_array);
    ZVAL_COPY(&args[1], version);
    zend_call_known_function(ce->constructor, Z_OBJ_P(return_value), ce, &rv_call, 2, args, NULL);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&rv_call);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_TxFrame, __construct)
{
    zval *db;
    bool read_only;
    zend_string *isolation;
    zend_long number;
    zend_class_entry *db_ce = native_find_class(ZEND_STRL("Polyspec\\Orm\\Db"));
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_OBJECT_OF_CLASS(db, db_ce)
        Z_PARAM_BOOL(read_only)
        Z_PARAM_STR(isolation)
        Z_PARAM_LONG(number)
    ZEND_PARSE_PARAMETERS_END();
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zend_update_property(o->ce, o, ZEND_STRL("db"), db);
    zend_update_property_bool(o->ce, o, ZEND_STRL("readOnly"), read_only);
    zend_update_property_str(o->ce, o, ZEND_STRL("isolation"), isolation);
    zend_update_property_long(o->ce, o, ZEND_STRL("number"), number);
}

ZEND_METHOD(Polyspec_Orm_TxFrame, recordInserted)
{
    zval *frame, *request, *id;
    zend_class_entry *frame_ce = native_find_class(ZEND_STRL("Polyspec\\Orm\\TxFrame"));
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(frame, frame_ce)
        Z_PARAM_OBJECT(request)
        Z_PARAM_ZVAL(id)
    ZEND_PARSE_PARAMETERS_END();
    if (frame == NULL || Z_TYPE_P(id) == IS_NULL) RETURN_NULL();

    zval rv, *ir = zend_read_property(Z_OBJCE_P(request), Z_OBJ_P(request), ZEND_STRL("ir"), 1, &rv);
    if (Z_TYPE_P(ir) != IS_ARRAY) RETURN_NULL();
    zval *kind = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("kind"));
    zval *rows = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("rows"));
    if (kind == NULL || Z_TYPE_P(kind) != IS_STRING || !zend_string_equals_literal(Z_STR_P(kind), "insert")
        || (rows != NULL && Z_TYPE_P(rows) != IS_NULL)) RETURN_NULL();

    zend_long key;
    if (Z_TYPE_P(id) == IS_LONG) {
        key = Z_LVAL_P(id);
    } else if (Z_TYPE_P(id) == IS_STRING && Z_STRLEN_P(id) > 0) {
        key = 0;
        for (size_t i = 0; i < Z_STRLEN_P(id); i++) {
            unsigned char digit = (unsigned char)Z_STRVAL_P(id)[i] - '0';
            if (digit > 9) RETURN_NULL();
            if (key > (ZEND_LONG_MAX - digit) / 10) key = ZEND_LONG_MAX;
            else key = key * 10 + digit;
        }
    } else {
        RETURN_NULL();
    }
    if (key <= 0) RETURN_NULL();

    zval *hash = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("manifest_hash"));
    zval *entity_name = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("entity"));
    if (hash == NULL || Z_TYPE_P(hash) != IS_STRING || entity_name == NULL || Z_TYPE_P(entity_name) != IS_STRING) {
        RETURN_NULL();
    }
    zend_class_entry *registry_ce = native_find_class(ZEND_STRL("Polyspec\\Orm\\Registry"));
    if (registry_ce == NULL) RETURN_NULL();
    zend_function *model_fn = zend_hash_str_find_ptr(&registry_ce->function_table, ZEND_STRL("model"));
    if (model_fn == NULL) RETURN_NULL();
    zval model_arg, runtime;
    ZVAL_UNDEF(&runtime);
    ZVAL_COPY(&model_arg, hash);
    zend_call_known_function(model_fn, NULL, registry_ce, &runtime, 1, &model_arg, NULL);
    zval_ptr_dtor(&model_arg);
    if (EG(exception) != NULL) {
        if (!Z_ISUNDEF(runtime)) zval_ptr_dtor(&runtime);
        RETURN_THROWS();
    }
    zval entity_arg, entity;
    ZVAL_COPY(&entity_arg, entity_name);
    zend_call_method_with_1_params(Z_OBJ(runtime), Z_OBJCE(runtime), NULL, "entity", &entity, &entity_arg);
    zval_ptr_dtor(&entity_arg);
    zval_ptr_dtor(&runtime);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&entity);
        RETURN_THROWS();
    }
    if (Z_TYPE(entity) != IS_ARRAY) {
        zval_ptr_dtor(&entity);
        RETURN_NULL();
    }
    zval *identity = zend_hash_str_find(Z_ARRVAL(entity), ZEND_STRL("identity"));
    bool has_identity = identity != NULL && Z_TYPE_P(identity) == IS_STRING && Z_STRLEN_P(identity) > 0;
    zval_ptr_dtor(&entity);
    if (!has_identity) RETURN_NULL();

    zval inserted_rv, *inserted = zend_read_property(Z_OBJCE_P(frame), Z_OBJ_P(frame), ZEND_STRL("inserted"), 1, &inserted_rv);
    zval updated;
    if (Z_TYPE_P(inserted) == IS_ARRAY) {
        ZVAL_COPY(&updated, inserted);
        SEPARATE_ARRAY(&updated);
    } else {
        array_init(&updated);
    }
    zval *existing = zend_hash_find(Z_ARRVAL(updated), Z_STR_P(entity_name));
    zval entity_set;
    if (existing != NULL && Z_TYPE_P(existing) == IS_ARRAY) {
        ZVAL_COPY(&entity_set, existing);
        SEPARATE_ARRAY(&entity_set);
    } else {
        array_init(&entity_set);
    }
    zval truth;
    ZVAL_TRUE(&truth);
    zend_hash_index_update(Z_ARRVAL(entity_set), (zend_ulong)key, &truth);
    zend_hash_update(Z_ARRVAL(updated), Z_STR_P(entity_name), &entity_set);
    zend_update_property(Z_OBJCE_P(frame), Z_OBJ_P(frame), ZEND_STRL("inserted"), &updated);
    zval_ptr_dtor(&updated);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Meet, kind)
{
    zend_string *type;
    zend_long scale, precision;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(type)
        Z_PARAM_LONG(scale)
        Z_PARAM_LONG(precision)
    ZEND_PARSE_PARAMETERS_END();

    if (zend_string_equals_literal(type, "i16") || zend_string_equals_literal(type, "i32")
        || zend_string_equals_literal(type, "i64")) {
        RETURN_STRING("integer");
    }
    if (zend_string_equals_literal(type, "varchar") || zend_string_equals_literal(type, "text")) {
        RETURN_STRING("string");
    }
    if (zend_string_equals_literal(type, "decimal")) {
        RETURN_STR(zend_strpprintf(0, "decimal scale " ZEND_LONG_FMT, scale));
    }
    if (zend_string_equals_literal(type, "time") || zend_string_equals_literal(type, "datetime")) {
        RETURN_STR(zend_strpprintf(0, "%s precision " ZEND_LONG_FMT, ZSTR_VAL(type), precision));
    }
    RETURN_STR_COPY(type);
}
