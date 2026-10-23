#include "registry_native.h"

zend_class_entry *polyspec_registry_ce;
zend_class_entry *polyspec_schema_ce;

static bool call_callable(const char *callable, zval *ret, uint32_t argc, zval *argv)
{
    zval fn;
    ZVAL_STRING(&fn, callable);
    zend_result result = call_user_function(NULL, NULL, &fn, ret, argc, argv);
    zval_ptr_dtor(&fn);
    if (result != SUCCESS && EG(exception) == NULL) {
        zend_throw_error(NULL, "%s is not callable", callable);
    }
    return result == SUCCESS && EG(exception) == NULL;
}

static bool call_class_static(zend_string *class_name, const char *method, zval *ret, uint32_t argc, zval *argv)
{
    zval callable, class_value;
    array_init_size(&callable, 2);
    ZVAL_STR_COPY(&class_value, class_name);
    add_next_index_zval(&callable, &class_value);
    add_next_index_string(&callable, (char *)method);
    ZVAL_UNDEF(ret);
    zend_result status = call_user_function(EG(function_table), NULL, &callable, ret, argc, argv);
    zval_ptr_dtor(&callable);
    if (status != SUCCESS && EG(exception) == NULL) {
        zend_throw_error(NULL, "%s::%s is not callable", ZSTR_VAL(class_name), method);
    }
    return status == SUCCESS && EG(exception) == NULL;
}

static bool call_runtime(const char *method, zval *ret, uint32_t argc, zval *argv)
{
    char callable[96];
    snprintf(callable, sizeof(callable), "Polyspec\\Orm\\RuntimeModel::%s", method);
    return call_callable(callable, ret, argc, argv);
}

static zval *static_array(zend_class_entry *ce, const char *name)
{
    zval *value = zend_read_static_property(ce, name, strlen(name), true);
    return value != NULL && Z_TYPE_P(value) == IS_ARRAY ? value : NULL;
}

static bool write_map(zend_class_entry *ce, const char *property, zend_string *key, zval *value)
{
    zval copy;
    ZVAL_COPY(&copy, value);
    zval *current = static_array(ce, property);
    if (current == NULL) {
        zval_ptr_dtor(&copy);
        zend_throw_error(NULL, "Polyspec\\Orm\\Registry::$%s is not initialized as an array", property);
        return false;
    }
    zval map;
    ZVAL_COPY(&map, current);
    SEPARATE_ARRAY(&map);
    zend_hash_update(Z_ARRVAL(map), key, &copy);
    zend_result result = zend_update_static_property(ce, property, strlen(property), &map);
    zval_ptr_dtor(&map);
    return result == SUCCESS && EG(exception) == NULL;
}

static bool write_nested_map(zend_class_entry *ce, const char *property, zend_string *hash,
                             zend_string *key, zval *value)
{
    zval *current = static_array(ce, property);
    if (current == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Registry::$%s is not initialized as an array", property);
        return false;
    }
    zval outer;
    ZVAL_COPY(&outer, current);
    SEPARATE_ARRAY(&outer);
    zval *old = zend_hash_find(Z_ARRVAL(outer), hash);
    zval inner;
    if (old != NULL && Z_TYPE_P(old) == IS_ARRAY) {
        ZVAL_COPY(&inner, old);
        SEPARATE_ARRAY(&inner);
    } else {
        array_init(&inner);
    }
    zval copy;
    ZVAL_COPY(&copy, value);
    zend_hash_update(Z_ARRVAL(inner), key, &copy);
    zend_hash_update(Z_ARRVAL(outer), hash, &inner);
    zend_result result = zend_update_static_property(ce, property, strlen(property), &outer);
    zval_ptr_dtor(&outer);
    return result == SUCCESS && EG(exception) == NULL;
}

static bool delete_map_key(zend_class_entry *ce, const char *property, zend_string *key)
{
    zval *current = static_array(ce, property);
    if (current == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Registry::$%s is not initialized as an array", property);
        return false;
    }
    if (!zend_hash_exists(Z_ARRVAL_P(current), key)) return true;
    zval map;
    ZVAL_COPY(&map, current);
    SEPARATE_ARRAY(&map);
    zend_hash_del(Z_ARRVAL(map), key);
    zend_result result = zend_update_static_property(ce, property, strlen(property), &map);
    zval_ptr_dtor(&map);
    return result == SUCCESS && EG(exception) == NULL;
}

static bool hash_text(zend_string *text, zend_string *external, zend_string **out)
{
    zend_string *input = zend_string_alloc(ZSTR_LEN(text) + ZSTR_LEN(external), 0);
    memcpy(ZSTR_VAL(input), ZSTR_VAL(text), ZSTR_LEN(text));
    memcpy(ZSTR_VAL(input) + ZSTR_LEN(text), ZSTR_VAL(external), ZSTR_LEN(external));
    ZSTR_VAL(input)[ZSTR_LEN(input)] = '\0';
    zval args[3], result;
    ZVAL_STRING(&args[0], "sha256");
    ZVAL_STR_COPY(&args[1], input);
    ZVAL_FALSE(&args[2]);
    bool ok = call_callable("hash", &result, 3, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zend_string_release(input);
    if (!ok) return false;
    if (Z_TYPE(result) != IS_STRING) {
        zval_ptr_dtor(&result);
        zend_throw_error(NULL, "hash('sha256') did not return a string");
        return false;
    }
    *out = strpprintf(0, "sha256:%s", Z_STRVAL(result));
    zval_ptr_dtor(&result);
    return true;
}

static void throw_orm(const char *code, zend_string *message)
{
    zend_string *name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return;
    zval args[2], exception, ignored;
    ZVAL_UNDEF(&ignored);
    ZVAL_STRING(&args[0], code);
    ZVAL_STR_COPY(&args[1], message);
    object_init_ex(&exception, ce);
    zend_function *ctor = zend_hash_str_find_ptr(&ce->function_table, "__construct", sizeof("__construct") - 1);
    if (ctor != NULL) zend_call_known_function(ctor, Z_OBJ(exception), ce, &ignored, 2, args, NULL);
    if (EG(exception) == NULL) zend_throw_exception_object(&exception);
    else zval_ptr_dtor(&exception);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
}

static void throw_unloaded(zend_string *hash)
{
    zend_string *message = strpprintf(0, "no loaded generated models registered manifest %s", ZSTR_VAL(hash));
    throw_orm("SCHEMA_HASH_MISMATCH", message);
    zend_string_release(message);
}

ZEND_METHOD(Polyspec_Orm_Registry, generated)
{
    zend_string *hash, *text, *external = NULL, *actual = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(hash)
        Z_PARAM_STR(text)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(external)
    ZEND_PARSE_PARAMETERS_END();
    if (external == NULL) external = ZSTR_EMPTY_ALLOC();
    if (!hash_text(text, external, &actual)) RETURN_THROWS();
    if (!zend_string_equals(hash, actual)) {
        zend_string *message = strpprintf(0, "generated code declares manifest %s, its manifest text hashes to %s: generate the models again", ZSTR_VAL(hash), ZSTR_VAL(actual));
        throw_orm("SCHEMA_HASH_MISMATCH", message);
        zend_string_release(message);
        zend_string_release(actual);
        RETURN_THROWS();
    }
    zval zv;
    ZVAL_STR_COPY(&zv, text);
    if (!write_map(polyspec_registry_ce, "texts", hash, &zv)) { zval_ptr_dtor(&zv); zend_string_release(actual); RETURN_THROWS(); }
    zval_ptr_dtor(&zv);
    ZVAL_STR_COPY(&zv, external);
    if (!write_map(polyspec_registry_ce, "externals", hash, &zv)) { zval_ptr_dtor(&zv); zend_string_release(actual); RETURN_THROWS(); }
    zval_ptr_dtor(&zv);
    zval *models = static_array(polyspec_registry_ce, "models");
    if (models != NULL && zend_hash_find(Z_ARRVAL_P(models), hash) == NULL) {
        zval empty; array_init(&empty);
        write_map(polyspec_registry_ce, "models", hash, &empty);
        zval_ptr_dtor(&empty);
    }
    zval *runtime = static_array(polyspec_registry_ce, "runtime");
    if (runtime != NULL) {
        if (!delete_map_key(polyspec_registry_ce, "runtime", hash)) { zend_string_release(actual); RETURN_THROWS(); }
    }
    zend_string_release(actual);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Registry, schema)
{
    zval *schema;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT_OF_CLASS(schema, polyspec_schema_ce) ZEND_PARSE_PARAMETERS_END();
    zval *hash = zend_read_property(polyspec_schema_ce, Z_OBJ_P(schema), "manifestHash", sizeof("manifestHash") - 1, true, NULL);
    zval *text = zend_read_property(polyspec_schema_ce, Z_OBJ_P(schema), "manifestText", sizeof("manifestText") - 1, true, NULL);
    zval *external = zend_read_property(polyspec_schema_ce, Z_OBJ_P(schema), "externalText", sizeof("externalText") - 1, true, NULL);
    if (hash == NULL || text == NULL || external == NULL) RETURN_THROWS();
    zval *texts = static_array(polyspec_registry_ce, "texts"), *externals = static_array(polyspec_registry_ce, "externals");
    if (texts == NULL || externals == NULL) RETURN_THROWS();
    if (zend_hash_find(Z_ARRVAL_P(texts), Z_STR_P(hash)) == NULL) write_map(polyspec_registry_ce, "texts", Z_STR_P(hash), text);
    if (EG(exception) != NULL) RETURN_THROWS();
    if (zend_hash_find(Z_ARRVAL_P(externals), Z_STR_P(hash)) == NULL) write_map(polyspec_registry_ce, "externals", Z_STR_P(hash), external);
    if (EG(exception) != NULL) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Registry, register)
{
    zend_string *class_name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(class_name) ZEND_PARSE_PARAMETERS_END();
    zval args[1], meta;
    ZVAL_STR_COPY(&args[0], class_name);
    bool ok = call_class_static(class_name, "meta", &meta, 0, NULL);
    zval_ptr_dtor(&args[0]);
    if (!ok) RETURN_THROWS();
    if (Z_TYPE(meta) != IS_ARRAY) { zval_ptr_dtor(&meta); zend_throw_error(NULL, "%s::meta() must return an array", ZSTR_VAL(class_name)); RETURN_THROWS(); }
    zval *hash = zend_hash_str_find(Z_ARRVAL(meta), "manifest_hash", sizeof("manifest_hash") - 1);
    zval *entity = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
    if (hash == NULL || entity == NULL || Z_TYPE_P(hash) != IS_STRING || Z_TYPE_P(entity) != IS_STRING) { zval_ptr_dtor(&meta); zend_throw_error(NULL, "%s::meta() lacks string manifest_hash/entity", ZSTR_VAL(class_name)); RETURN_THROWS(); }
    zval *models = static_array(polyspec_registry_ce, "models");
    zval *set = models == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(models), Z_STR_P(hash));
    if (set == NULL) {
        zend_string *message = strpprintf(0, "%s is registered before the models of manifest %s are loaded", ZSTR_VAL(class_name), Z_STRVAL_P(hash));
        throw_orm("CONFIG", message); zend_string_release(message); zval_ptr_dtor(&meta); RETURN_THROWS();
    }
    zval *loaded = Z_TYPE_P(set) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(set), Z_STR_P(entity)) : NULL;
    if (loaded != NULL && Z_TYPE_P(loaded) == IS_STRING && !zend_string_equals(Z_STR_P(loaded), class_name)) {
        zend_string *message = strpprintf(0, "entity %s of manifest %s is generated as both %s and %s", Z_STRVAL_P(entity), Z_STRVAL_P(hash), Z_STRVAL_P(loaded), ZSTR_VAL(class_name));
        throw_orm("CONFIG", message); zend_string_release(message); zval_ptr_dtor(&meta); RETURN_THROWS();
    }
    zval class_value; ZVAL_STR_COPY(&class_value, class_name);
    bool written = write_nested_map(polyspec_registry_ce, "models", Z_STR_P(hash), Z_STR_P(entity), &class_value);
    zval_ptr_dtor(&class_value);
    if (written) {
        if (!delete_map_key(polyspec_registry_ce, "runtime", Z_STR_P(hash))) written = false;
    }
    zval_ptr_dtor(&meta);
    if (!written) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Registry, unloaded)
{
    zend_string *hash;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(hash) ZEND_PARSE_PARAMETERS_END();
    zend_string *message = strpprintf(0, "no loaded generated models registered manifest %s", ZSTR_VAL(hash));
    zend_string *name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) { zend_string_release(message); RETURN_THROWS(); }
    zval args[2];
    ZVAL_STRING(&args[0], "SCHEMA_HASH_MISMATCH");
    ZVAL_STR(&args[1], message);
    object_init_ex(return_value, ce);
    zval ignored;
    ZVAL_UNDEF(&ignored);
    zend_function *ctor = zend_hash_str_find_ptr(&ce->function_table, "__construct", sizeof("__construct") - 1);
    if (ctor != NULL) zend_call_known_function(ctor, Z_OBJ_P(return_value), ce, &ignored, 2, args, NULL);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Registry, loaded)
{
    zend_string *hash;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(hash) ZEND_PARSE_PARAMETERS_END();
    zval *models = static_array(polyspec_registry_ce, "models");
    RETURN_BOOL(models != NULL && zend_hash_exists(Z_ARRVAL_P(models), hash));
}

ZEND_METHOD(Polyspec_Orm_Registry, manifestText)
{
    zend_string *hash;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(hash) ZEND_PARSE_PARAMETERS_END();
    zval *texts = static_array(polyspec_registry_ce, "texts");
    zval *text = texts == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(texts), hash);
    if (text == NULL) { throw_unloaded(hash); RETURN_THROWS(); }
    RETURN_COPY(text);
}

ZEND_METHOD(Polyspec_Orm_Registry, models)
{
    zend_string *hash;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(hash) ZEND_PARSE_PARAMETERS_END();
    zval *models = static_array(polyspec_registry_ce, "models");
    zval *set = models == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(models), hash);
    if (set == NULL) { throw_unloaded(hash); RETURN_THROWS(); }
    RETURN_COPY(set);
}

ZEND_METHOD(Polyspec_Orm_Registry, model)
{
    zend_string *hash;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(hash) ZEND_PARSE_PARAMETERS_END();
    zval *runtime = static_array(polyspec_registry_ce, "runtime");
    zval *cached = runtime == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(runtime), hash);
    if (cached != NULL) RETURN_COPY(cached);
    zval *texts = static_array(polyspec_registry_ce, "texts");
    zval *text = texts == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(texts), hash);
    if (text == NULL) { throw_unloaded(hash); RETURN_THROWS(); }
    zval *externals = static_array(polyspec_registry_ce, "externals");
    zval *external = externals == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(externals), hash);
    if (external == NULL) external = NULL;
    zval *models = static_array(polyspec_registry_ce, "models");
    zval *set = models == NULL ? NULL : zend_hash_find(Z_ARRVAL_P(models), hash);
    zval args[4], result;
    ZVAL_STR_COPY(&args[0], hash); ZVAL_COPY(&args[1], text);
    if (external != NULL) ZVAL_COPY(&args[3], external); else ZVAL_EMPTY_STRING(&args[3]);
    bool ok;
    if (set != NULL && zend_hash_num_elements(Z_ARRVAL_P(set)) > 0) {
        array_init(&args[2]);
        zval *cls;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(set), cls) { zval copy; ZVAL_COPY(&copy, cls); add_next_index_zval(&args[2], &copy); } ZEND_HASH_FOREACH_END();
        ok = call_runtime("fromModels", &result, 4, args);
    } else {
        zval load_args[2], docs;
        ZVAL_COPY(&load_args[0], &args[1]); ZVAL_COPY(&load_args[1], &args[3]);
        ok = call_runtime("loadSet", &docs, 2, load_args);
        zval_ptr_dtor(&load_args[0]); zval_ptr_dtor(&load_args[1]);
        if (ok) { zval build_args[1]; ZVAL_COPY(&build_args[0], &docs); ok = call_runtime("build", &result, 1, build_args); zval_ptr_dtor(&build_args[0]); zval_ptr_dtor(&docs); }
    }
    for (int i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    if (!ok) RETURN_THROWS();
    zval cache_value; ZVAL_COPY(&cache_value, &result);
    if (!write_map(polyspec_registry_ce, "runtime", hash, &cache_value)) { zval_ptr_dtor(&cache_value); zval_ptr_dtor(&result); RETURN_THROWS(); }
    zval_ptr_dtor(&cache_value);
    RETURN_ZVAL(&result, 0, 0);
}

ZEND_METHOD(Polyspec_Orm_Schema, __construct)
{
    zend_string *manifest_text, *manifest_hash, *external_text = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(manifest_text)
        Z_PARAM_STR(manifest_hash)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(external_text)
    ZEND_PARSE_PARAMETERS_END();
    if (external_text == NULL) external_text = ZSTR_EMPTY_ALLOC();
    zend_update_property_str(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "manifestText", sizeof("manifestText") - 1, manifest_text);
    zend_update_property_str(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "manifestHash", sizeof("manifestHash") - 1, manifest_hash);
    zend_update_property_str(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "externalText", sizeof("externalText") - 1, external_text);
}

ZEND_METHOD(Polyspec_Orm_Schema, verify)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *text = zend_read_property(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "manifestText", sizeof("manifestText") - 1, true, NULL);
    zval *hash = zend_read_property(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "manifestHash", sizeof("manifestHash") - 1, true, NULL);
    zval *external = zend_read_property(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "externalText", sizeof("externalText") - 1, true, NULL);
    zend_string *actual = NULL;
    if (text == NULL || hash == NULL || external == NULL || !hash_text(Z_STR_P(text), Z_STR_P(external), &actual)) RETURN_THROWS();
    if (!zend_string_equals(actual, Z_STR_P(hash))) {
        zend_string *message = strpprintf(0, "invalid schema manifest: the manifest text hashes to %s, not to its declared manifestHash %s", ZSTR_VAL(actual), Z_STRVAL_P(hash));
        throw_orm("CONFIG", message); zend_string_release(message); zend_string_release(actual); RETURN_THROWS();
    }
    zend_string_release(actual);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Schema, documents)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *text = zend_read_property(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "manifestText", sizeof("manifestText") - 1, true, NULL);
    zval *external = zend_read_property(polyspec_schema_ce, Z_OBJ_P(ZEND_THIS), "externalText", sizeof("externalText") - 1, true, NULL);
    if (text == NULL || external == NULL) RETURN_THROWS();
    zval args[2]; ZVAL_COPY(&args[0], text); ZVAL_COPY(&args[1], external);
    bool ok = call_runtime("loadSet", return_value, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (!ok) RETURN_THROWS();
}

void polyspec_registry_schema_register(zend_class_entry *registry_ce, zend_class_entry *schema_ce)
{
    polyspec_registry_ce = registry_ce;
    polyspec_schema_ce = schema_ce;
}
