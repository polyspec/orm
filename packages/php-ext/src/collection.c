/* Native ordered Collection storage and its deferred-snapshot iterator. */
#include "collection.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_objects_API.h"
#include "Zend/zend_iterators.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_execute.h"
#include "ext/spl/spl_exceptions.h"
#include "ext/date/php_date.h"

typedef struct {
    zend_object std;
} collection_object;

typedef struct {
    zval owner;
    zval snapshot;
    HashPosition position;
    zend_object std;
} collection_iterator;

typedef struct {
    zend_object_iterator intern;
} collection_iterator_adapter;

typedef struct {
    zval owner;
    zval snapshot;
    bool recursive;
    zend_object std;
} collection_delete_callback;

static zend_class_entry *collection_iterator_ce, *collection_delete_callback_ce;
static zend_object_handlers collection_handlers, iterator_handlers, delete_callback_handlers;

static void collection_null_key_error(void)
{
    zend_string *name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (!ce) {
        zend_throw_error(NULL, "Polyspec\\Orm\\OrmException is not loaded");
        return;
    }
    zval exception, code, message;
    object_init_ex(&exception, ce);
    ZVAL_STRING(&code, "CODEC_DECODE");
    ZVAL_STRING(&message, "collection row identity contains SQL NULL");
    zend_call_method_with_2_params(Z_OBJ(exception), ce, NULL, "__construct", NULL, &code, &message);
    zval_ptr_dtor(&code); zval_ptr_dtor(&message);
    if (EG(exception)) { zval_ptr_dtor(&exception); return; }
    zend_throw_exception_object(&exception);
}

static zval *iterator_entry(collection_iterator *it);
static void iterator_start(collection_iterator *it);
static zval *entry_model(zval *entry);
static zval *entry_key(zval *entry);

#define COBJ(o) ((collection_object *)((char *)(o) - XtOffsetOf(collection_object, std)))
#define IOBJ(o) ((collection_iterator *)((char *)(o) - XtOffsetOf(collection_iterator, std)))
#define DCOBJ(o) ((collection_delete_callback *)((char *)(o) - XtOffsetOf(collection_delete_callback, std)))

static void collection_invalid_storage(const char *what);

static zval *collection_items(zend_object *obj)
{
    zval *items = zend_read_property(obj->ce, obj, "items", sizeof("items") - 1, 1, NULL);
    ZVAL_DEREF(items);
    if (Z_TYPE_P(items) != IS_ARRAY) {
        collection_invalid_storage("items array");
        return NULL;
    }
    return items;
}

static zval *collection_fetched(zend_object *obj)
{
    zval *fetched = zend_read_property(obj->ce, obj, "fetched", sizeof("fetched") - 1, 1, NULL);
    ZVAL_DEREF(fetched);
    if (Z_TYPE_P(fetched) != IS_ARRAY) {
        collection_invalid_storage("fetched array");
        return NULL;
    }
    return fetched;
}
static zend_object *collection_create(zend_class_entry *ce)
{
    collection_object *o = zend_object_alloc(sizeof(*o), ce);
    zend_object_std_init(&o->std, ce);
    object_properties_init(&o->std, ce);
    o->std.handlers = &collection_handlers;
    return &o->std;
}

static zend_object *collection_clone(zend_object *old_object)
{
    zend_object *new_object = collection_create(old_object->ce);
    zend_objects_clone_members(new_object, old_object);
    return new_object;
}

static void collection_free(zend_object *obj)
{
    zend_object_std_dtor(obj);
}

static zend_object *iterator_create(zend_class_entry *ce)
{
    collection_iterator *o = zend_object_alloc(sizeof(*o), ce);
    zend_object_std_init(&o->std, ce);
    object_properties_init(&o->std, ce);
    ZVAL_UNDEF(&o->owner);
    ZVAL_UNDEF(&o->snapshot);
    o->position = 0;
    o->std.handlers = &iterator_handlers;
    return &o->std;
}

static zend_object *delete_callback_create(zend_class_entry *ce)
{
    collection_delete_callback *o = zend_object_alloc(sizeof(*o), ce);
    zend_object_std_init(&o->std, ce);
    object_properties_init(&o->std, ce);
    ZVAL_UNDEF(&o->owner);
    ZVAL_UNDEF(&o->snapshot);
    o->recursive = false;
    o->std.handlers = &delete_callback_handlers;
    return &o->std;
}

static zend_object *delete_callback_clone(zend_object *old_object)
{
    zend_object *new_object = delete_callback_create(old_object->ce);
    collection_delete_callback *old = DCOBJ(old_object), *copy = DCOBJ(new_object);
    if (!Z_ISUNDEF(old->owner)) ZVAL_COPY(&copy->owner, &old->owner);
    if (!Z_ISUNDEF(old->snapshot)) ZVAL_COPY(&copy->snapshot, &old->snapshot);
    copy->recursive = old->recursive;
    zend_objects_clone_members(new_object, old_object);
    return new_object;
}

static void delete_callback_free(zend_object *obj)
{
    collection_delete_callback *o = DCOBJ(obj);
    if (!Z_ISUNDEF(o->owner)) zval_ptr_dtor(&o->owner);
    if (!Z_ISUNDEF(o->snapshot)) zval_ptr_dtor(&o->snapshot);
    zend_object_std_dtor(obj);
}

static HashTable *delete_callback_gc(zend_object *obj, zval **table, int *n)
{
    collection_delete_callback *o = DCOBJ(obj);
    *table = &o->owner;
    *n = 2;
    return zend_std_get_properties(obj);
}

static zend_object *iterator_clone(zend_object *old_object)
{
    zend_object *new_object = iterator_create(old_object->ce);
    collection_iterator *old = IOBJ(old_object), *copy = IOBJ(new_object);
    if (!Z_ISUNDEF(old->owner)) ZVAL_COPY(&copy->owner, &old->owner);
    if (!Z_ISUNDEF(old->snapshot)) ZVAL_COPY(&copy->snapshot, &old->snapshot);
    copy->position = old->position;
    zend_objects_clone_members(new_object, old_object);
    return new_object;
}

static void iterator_free(zend_object *obj)
{
    collection_iterator *o = IOBJ(obj);
    if (!Z_ISUNDEF(o->owner)) zval_ptr_dtor(&o->owner);
    if (!Z_ISUNDEF(o->snapshot)) zval_ptr_dtor(&o->snapshot);
    zend_object_std_dtor(obj);
}

static void iterator_adapter_dtor(zend_object_iterator *iterator)
{
    zval_ptr_dtor(&iterator->data);
}

static zend_result iterator_adapter_valid(zend_object_iterator *iterator)
{
    collection_iterator *it = IOBJ(Z_OBJ(iterator->data));
    return iterator_entry(it) == NULL || EG(exception) ? FAILURE : SUCCESS;
}

static zval *iterator_adapter_current(zend_object_iterator *iterator)
{
    return iterator_entry(IOBJ(Z_OBJ(iterator->data))) == NULL ? NULL
        : entry_model(iterator_entry(IOBJ(Z_OBJ(iterator->data))));
}

static void iterator_adapter_key(zend_object_iterator *iterator, zval *key)
{
    zval *entry = iterator_entry(IOBJ(Z_OBJ(iterator->data)));
    if (entry == NULL) {
        ZVAL_NULL(key);
        return;
    }
    zval *value = entry_key(entry);
    if (value == NULL) {
        ZVAL_NULL(key);
        return;
    }
    ZVAL_COPY(key, value);
}

static void iterator_adapter_next(zend_object_iterator *iterator)
{
    collection_iterator *it = IOBJ(Z_OBJ(iterator->data));
    if (!Z_ISUNDEF(it->snapshot) && Z_TYPE(it->snapshot) == IS_ARRAY) {
        zend_hash_move_forward_ex(Z_ARRVAL(it->snapshot), &it->position);
    }
}

static void iterator_adapter_rewind(zend_object_iterator *iterator)
{
    iterator_start(IOBJ(Z_OBJ(iterator->data)));
}

static HashTable *iterator_adapter_gc(zend_object_iterator *iterator, zval **table, int *n)
{
    *table = &iterator->data;
    *n = 1;
    return NULL;
}

static const zend_object_iterator_funcs iterator_adapter_funcs = {
    iterator_adapter_dtor,
    iterator_adapter_valid,
    iterator_adapter_current,
    iterator_adapter_key,
    iterator_adapter_next,
    iterator_adapter_rewind,
    NULL,
    iterator_adapter_gc
};

static zend_object_iterator *iterator_adapter_create(zval *iterator_object)
{
    collection_iterator_adapter *adapter = emalloc(sizeof(*adapter));
    zend_iterator_init(&adapter->intern);
    ZVAL_COPY(&adapter->intern.data, iterator_object);
    adapter->intern.funcs = &iterator_adapter_funcs;
    return &adapter->intern;
}

static zend_object_iterator *collection_iterator_get_iterator(zend_class_entry *ce, zval *object, int by_ref)
{
    if (by_ref) {
        zend_throw_error(NULL, "An iterator cannot be used with foreach by reference");
        return NULL;
    }
    return iterator_adapter_create(object);
}

static HashTable *iterator_gc(zend_object *obj, zval **table, int *n)
{
    collection_iterator *o = IOBJ(obj);
    *table = &o->owner;
    *n = 2;
    return zend_std_get_properties(obj);
}

static zend_string *typed_string_identity(char kind, const char *bytes, size_t length)
{
    smart_str id = {0};
    smart_str_appendc(&id, kind);
    smart_str_appendl(&id, bytes, length);
    return smart_str_extract(&id);
}

static zend_string *bytes_identity(zval *bytes_object)
{
    zval rv;
    zval *bytes = zend_read_property(Z_OBJCE_P(bytes_object), Z_OBJ_P(bytes_object), "bytes", sizeof("bytes") - 1, 1, &rv);
    ZVAL_DEREF(bytes);
    if (Z_TYPE_P(bytes) != IS_STRING) {
        zend_throw_error(NULL, "Bytes::bytes must be a string");
        return NULL;
    }
    static const char hex[] = "0123456789abcdef";
    size_t length = Z_STRLEN_P(bytes);
    if (length > (SIZE_MAX - 2) / 2) {
        zend_throw_error(NULL, "Bytes key is too large to identify");
        return NULL;
    }
    zend_string *identity = zend_string_alloc(1 + length * 2, 0);
    char *out = ZSTR_VAL(identity);
    out[0] = 'x';
    for (size_t i = 0; i < length; i++) {
        unsigned char byte = (unsigned char)Z_STRVAL_P(bytes)[i];
        out[1 + i * 2] = hex[byte >> 4];
        out[2 + i * 2] = hex[byte & 0x0f];
    }
    out[1 + length * 2] = '\0';
    return identity;
}

/* Keys preserve their PHP type. Prefixes keep integer, text and boolean identities disjoint. */
static zend_string *key_identity(zval *key)
{
    ZVAL_DEREF(key);
    switch (Z_TYPE_P(key)) {
        case IS_LONG: return strpprintf(0, "i" ZEND_LONG_FMT, Z_LVAL_P(key));
        case IS_STRING: return typed_string_identity('s', Z_STRVAL_P(key), Z_STRLEN_P(key));
        case IS_TRUE: return zend_string_init("b1", 2, 0);
        case IS_FALSE: return zend_string_init("b0", 2, 0);
        case IS_NULL:
            collection_null_key_error();
            return NULL;
        case IS_OBJECT: {
            zend_class_entry *ce = Z_OBJCE_P(key);
            if (zend_string_equals_literal(ce->name, "Polyspec\\Orm\\Bytes")) {
                return bytes_identity(key);
            }
            if (instanceof_function(ce, php_date_get_interface_ce())) {
                zval obj, arg, zone, utc, formatted;
                ZVAL_UNDEF(&obj); ZVAL_UNDEF(&zone); ZVAL_UNDEF(&utc); ZVAL_UNDEF(&formatted);
                zend_call_method_with_1_params(NULL, php_date_get_immutable_ce(), NULL, "createfrominterface", &obj, key);
                if (EG(exception)) { if (!Z_ISUNDEF(obj)) zval_ptr_dtor(&obj); return NULL; }
                ZVAL_STRING(&arg, "UTC");
                object_init_ex(&zone, php_date_get_timezone_ce());
                zend_call_method_with_1_params(Z_OBJ(zone), Z_OBJCE(zone), NULL, "__construct", NULL, &arg);
                zval_ptr_dtor(&arg);
                if (EG(exception)) {
                    zval_ptr_dtor(&zone); zval_ptr_dtor(&obj); return NULL;
                }
                zend_call_method_with_1_params(Z_OBJ(obj), Z_OBJCE(obj), NULL, "settimezone", &utc, &zone);
                zval_ptr_dtor(&zone); zval_ptr_dtor(&obj);
                if (EG(exception)) { if (!Z_ISUNDEF(utc)) zval_ptr_dtor(&utc); return NULL; }
                ZVAL_STRING(&arg, "Y-m-d H:i:s.u");
                zend_call_method_with_1_params(Z_OBJ(utc), Z_OBJCE(utc), NULL, "format", &formatted, &arg);
                zval_ptr_dtor(&arg); zval_ptr_dtor(&utc);
                if (EG(exception)) { if (!Z_ISUNDEF(formatted)) zval_ptr_dtor(&formatted); return NULL; }
                zend_string *id = typed_string_identity('d', Z_STRVAL(formatted), Z_STRLEN(formatted));
                zval_ptr_dtor(&formatted);
                return id;
            }
        }
        default: {
            zend_string *text = zval_try_get_string(key);
            if (!text) return NULL;
            zend_string *id = typed_string_identity('s', ZSTR_VAL(text), ZSTR_LEN(text));
            zend_string_release(text);
            return id;
        }
    }
    return NULL;
}

static zend_class_entry *collection_lookup_class(const char *name, size_t length)
{
    zend_string *class_name = zend_string_init(name, length, 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool collection_is_bytes(zend_class_entry *ce)
{
    return zend_string_equals_literal(ce->name, "Polyspec\\Orm\\Bytes");
}

static bool collection_key_argument(zval *key, uint32_t argument)
{
    ZVAL_DEREF(key);
    if (Z_TYPE_P(key) == IS_LONG || Z_TYPE_P(key) == IS_STRING || Z_TYPE_P(key) == IS_TRUE || Z_TYPE_P(key) == IS_FALSE) return true;
    if (Z_TYPE_P(key) == IS_OBJECT) {
        if (collection_is_bytes(Z_OBJCE_P(key)) || instanceof_function(Z_OBJCE_P(key), php_date_get_interface_ce())) return true;
    }
    if (zend_verify_scalar_type_hint(MAY_BE_LONG | MAY_BE_STRING | MAY_BE_BOOL, key,
            ZEND_ARG_USES_STRICT_TYPES(), false)) return true;
    if (EG(exception)) return false;
    zend_argument_type_error(argument,
        "must be of type int|string|bool|Polyspec\\Orm\\Bytes|DateTimeInterface, %s given",
        zend_zval_value_name(key));
    return false;
}

static bool collection_model_argument(zval *model, uint32_t argument)
{
    zend_class_entry *model_ce = collection_lookup_class("Polyspec\\Orm\\Model", sizeof("Polyspec\\Orm\\Model") - 1);
    if (model_ce && Z_TYPE_P(model) == IS_OBJECT && instanceof_function(Z_OBJCE_P(model), model_ce)) return true;
    zend_argument_type_error(argument, "must be of type Polyspec\\Orm\\Model, %s given", zend_zval_value_name(model));
    return false;
}

static bool collection_db_argument(zval *db, uint32_t argument)
{
    zend_class_entry *db_ce = collection_lookup_class("Polyspec\\Orm\\Db", sizeof("Polyspec\\Orm\\Db") - 1);
    if (db_ce && Z_TYPE_P(db) == IS_OBJECT && instanceof_function(Z_OBJCE_P(db), db_ce)) return true;
    zend_argument_type_error(argument, "must be of type Polyspec\\Orm\\Db, %s given", zend_zval_value_name(db));
    return false;
}

static void collection_invalid_storage(const char *what)
{
    zend_throw_exception_ex(spl_ce_UnexpectedValueException, 0, "Collection %s is malformed", what);
}

static bool entry_parts(zval *entry, zval **key, zval **model)
{
    if (Z_TYPE_P(entry) != IS_ARRAY) {
        collection_invalid_storage("entry");
        return false;
    }
    *key = zend_hash_index_find(Z_ARRVAL_P(entry), 0);
    *model = zend_hash_index_find(Z_ARRVAL_P(entry), 1);
    if (!*key || !*model) {
        collection_invalid_storage("entry");
        return false;
    }
    ZVAL_DEREF(*key);
    ZVAL_DEREF(*model);
    zval *key_value = *key;
    bool key_ok = Z_TYPE_P(key_value) == IS_LONG || Z_TYPE_P(key_value) == IS_STRING || Z_TYPE_P(key_value) == IS_TRUE || Z_TYPE_P(key_value) == IS_FALSE;
    if (Z_TYPE_P(key_value) == IS_OBJECT) {
        key_ok = collection_is_bytes(Z_OBJCE_P(key_value)) || instanceof_function(Z_OBJCE_P(key_value), php_date_get_interface_ce());
    }
    zend_class_entry *model_ce = collection_lookup_class("Polyspec\\Orm\\Model", sizeof("Polyspec\\Orm\\Model") - 1);
    bool model_ok = model_ce && Z_TYPE_P(*model) == IS_OBJECT && instanceof_function(Z_OBJCE_P(*model), model_ce);
    if (!key_ok || !model_ok) {
        if (!EG(exception)) collection_invalid_storage("entry");
        return false;
    }
    return true;
}

static zval *entry_model(zval *entry)
{
    zval *key, *model;
    return entry_parts(entry, &key, &model) ? model : NULL;
}

static zval *entry_key(zval *entry)
{
    zval *key, *model;
    return entry_parts(entry, &key, &model) ? key : NULL;
}

PHP_METHOD(Polyspec_Orm_CollectionDeleteCallback, __invoke)
{
    ZEND_PARSE_PARAMETERS_NONE();
    collection_delete_callback *state = DCOBJ(Z_OBJ_P(ZEND_THIS));
    if (Z_TYPE(state->owner) != IS_OBJECT) {
        zend_throw_error(NULL, "Collection delete callback has no owner");
        RETURN_THROWS();
    }
    collection_object *collection = COBJ(Z_OBJ(state->owner));
    zval *items = collection_items(&collection->std);
    if (items == NULL) RETURN_THROWS();
    if (!Z_ISUNDEF(state->snapshot)) zval_ptr_dtor(&state->snapshot);
    ZVAL_ARR(&state->snapshot, zend_array_dup(Z_ARRVAL_P(items)));
    zval *entry;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(state->snapshot), entry) {
        zval *model = entry_model(entry), recursive;
        if (!model) { if (EG(exception)) { zval_ptr_dtor(&state->snapshot); ZVAL_UNDEF(&state->snapshot); RETURN_THROWS(); } continue; }
        ZVAL_BOOL(&recursive, state->recursive);
        zval result;
        ZVAL_UNDEF(&result);
        zend_call_method_with_1_params(Z_OBJ_P(model), Z_OBJCE_P(model), NULL, "deleterow", &result, &recursive);
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        if (EG(exception)) {
            zval_ptr_dtor(&state->snapshot);
            ZVAL_UNDEF(&state->snapshot);
            RETURN_THROWS();
        }
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&state->snapshot);
    ZVAL_UNDEF(&state->snapshot);
}

PHP_METHOD(Polyspec_Orm_Collection, put)
{
    zval *key, *model, entry;
    ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_ZVAL(key) Z_PARAM_OBJECT(model) ZEND_PARSE_PARAMETERS_END();
    if (!collection_key_argument(key, 1) || !collection_model_argument(model, 2)) RETURN_THROWS();
    zend_string *id = key_identity(key); if (!id) RETURN_THROWS();
    array_init_size(&entry, 2); Z_TRY_ADDREF_P(key); add_next_index_zval(&entry, key); Z_TRY_ADDREF_P(model); add_next_index_zval(&entry, model);
    zval *items = collection_items(Z_OBJ_P(ZEND_THIS));
    if (items == NULL) { zval_ptr_dtor(&entry); zend_string_release(id); RETURN_THROWS(); }
    SEPARATE_ARRAY(items);
    zend_hash_update(Z_ARRVAL_P(items), id, &entry);
    zend_string_release(id);
    RETURN_NULL();
}

PHP_METHOD(Polyspec_Orm_Collection, keyOf)
{
    zval *key; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_ZVAL(key) ZEND_PARSE_PARAMETERS_END();
    ZVAL_DEREF(key);
    if (Z_TYPE_P(key) == IS_NULL) { collection_null_key_error(); RETURN_THROWS(); }
    if (Z_TYPE_P(key) == IS_LONG || Z_TYPE_P(key) == IS_STRING || Z_TYPE_P(key) == IS_TRUE || Z_TYPE_P(key) == IS_FALSE) RETURN_COPY(key);
    if (Z_TYPE_P(key) == IS_OBJECT && (collection_is_bytes(Z_OBJCE_P(key)) || instanceof_function(Z_OBJCE_P(key), php_date_get_interface_ce()))) RETURN_COPY(key);
    zend_string *text = zval_try_get_string(key);
    if (!text) RETURN_THROWS();
    RETURN_STR(text);
}

PHP_METHOD(Polyspec_Orm_Collection, identityOf)
{
    zval *key; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_ZVAL(key) ZEND_PARSE_PARAMETERS_END();
    zend_string *identity = key_identity(key);
    if (!identity) RETURN_THROWS();
    RETURN_STR(identity);
}

PHP_METHOD(Polyspec_Orm_Collection, get)
{
    zval *key; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_ZVAL(key) ZEND_PARSE_PARAMETERS_END();
    if (!collection_key_argument(key, 1)) RETURN_THROWS();
    zend_string *id = key_identity(key); if (!id) RETURN_THROWS();
    zval *items = collection_items(Z_OBJ_P(ZEND_THIS));
    if (items == NULL) { zend_string_release(id); RETURN_THROWS(); }
    zval *entry = zend_hash_find(Z_ARRVAL_P(items), id); zend_string_release(id);
    if (!entry) RETURN_NULL();
    zval *model = entry_model(entry); if (!model) { if (EG(exception)) RETURN_THROWS(); RETURN_NULL(); } RETURN_COPY(model);
}

PHP_METHOD(Polyspec_Orm_Collection, has)
{
    zval *key; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_ZVAL(key) ZEND_PARSE_PARAMETERS_END();
    if (!collection_key_argument(key, 1)) RETURN_THROWS();
    zend_string *id = key_identity(key); if (!id) RETURN_THROWS();
    zval *items = collection_items(Z_OBJ_P(ZEND_THIS));
    if (items == NULL) { zend_string_release(id); RETURN_THROWS(); }
    bool found = zend_hash_exists(Z_ARRVAL_P(items), id); zend_string_release(id); RETURN_BOOL(found);
}

PHP_METHOD(Polyspec_Orm_Collection, count)
{ ZEND_PARSE_PARAMETERS_NONE(); zval *items = collection_items(Z_OBJ_P(ZEND_THIS)); if (items == NULL) RETURN_THROWS(); RETURN_LONG(zend_hash_num_elements(Z_ARRVAL_P(items))); }

PHP_METHOD(Polyspec_Orm_Collection, keys)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval *items = collection_items(Z_OBJ_P(ZEND_THIS)); if (items == NULL) RETURN_THROWS(); array_init(return_value); zval *entry;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(items), entry) { zval *key = entry_key(entry); if (key) { Z_TRY_ADDREF_P(key); add_next_index_zval(return_value,key); } else if (EG(exception)) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } } ZEND_HASH_FOREACH_END();
}

PHP_METHOD(Polyspec_Orm_Collection, all)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval *items = collection_items(Z_OBJ_P(ZEND_THIS)); if (items == NULL) RETURN_THROWS(); array_init(return_value); zval *entry;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(items), entry) { zval *model = entry_model(entry); if (model) { Z_TRY_ADDREF_P(model); add_next_index_zval(return_value,model); } else if (EG(exception)) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } } ZEND_HASH_FOREACH_END();
}

PHP_METHOD(Polyspec_Orm_Collection, entries)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval *items = collection_items(Z_OBJ_P(ZEND_THIS)); if (items == NULL) RETURN_THROWS(); array_init(return_value); zval *entry;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(items), entry) { zval *key, *model; if (!entry_parts(entry, &key, &model)) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } Z_TRY_ADDREF_P(entry); add_next_index_zval(return_value,entry); } ZEND_HASH_FOREACH_END();
}

PHP_METHOD(Polyspec_Orm_Collection, first)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval *storage = collection_items(Z_OBJ_P(ZEND_THIS)); if (storage == NULL) RETURN_THROWS(); HashPosition pos; HashTable *items = Z_ARRVAL_P(storage); zend_hash_internal_pointer_reset_ex(items, &pos); zval *entry = zend_hash_get_current_data_ex(items, &pos);
    if (!entry) RETURN_NULL(); zval *model = entry_model(entry); if (!model) { if (EG(exception)) RETURN_THROWS(); RETURN_NULL(); } RETURN_COPY(model);
}

PHP_METHOD(Polyspec_Orm_Collection, fetchValues)
{
    zval *fn; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_OBJECT_OF_CLASS(fn, zend_ce_closure) ZEND_PARSE_PARAMETERS_END();
    collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS)); zval *entry; zend_string *id;
    zval *items = collection_items(&o->std); if (items == NULL) RETURN_THROWS();
    HashTable *snapshot = zend_array_dup(Z_ARRVAL_P(items));
    ZEND_HASH_FOREACH_STR_KEY_VAL(snapshot, id, entry) {
        zval *key, *model, result;
        if (id == NULL) { zend_array_destroy(snapshot); collection_invalid_storage("item identity"); RETURN_THROWS(); }
        if (!entry_parts(entry, &key, &model)) { zend_array_destroy(snapshot); RETURN_THROWS(); }
        ZVAL_UNDEF(&result); zval param; ZVAL_COPY(&param, model); call_user_function(EG(function_table), NULL, fn, &result, 1, &param); zval_ptr_dtor(&param);
        if (EG(exception)) { if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result); zend_array_destroy(snapshot); RETURN_THROWS(); }
        zval *fetched = collection_fetched(&o->std);
        if (fetched == NULL) { zval_ptr_dtor(&result); zend_array_destroy(snapshot); RETURN_THROWS(); }
        SEPARATE_ARRAY(fetched);
        zend_hash_update(Z_ARRVAL_P(fetched), id, &result);
    } ZEND_HASH_FOREACH_END();
    zend_array_destroy(snapshot);
}

PHP_METHOD(Polyspec_Orm_Collection, fetchedValue)
{
    zval *key; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_ZVAL(key) ZEND_PARSE_PARAMETERS_END();
    if (!collection_key_argument(key, 1)) RETURN_THROWS();
    zend_string *id = key_identity(key); if (!id) RETURN_THROWS();
    zval *fetched = collection_fetched(Z_OBJ_P(ZEND_THIS));
    if (fetched == NULL) { zend_string_release(id); RETURN_THROWS(); }
    zval *v = zend_hash_find(Z_ARRVAL_P(fetched), id); zend_string_release(id); if (!v) RETURN_NULL(); RETURN_COPY(v);
}

PHP_METHOD(Polyspec_Orm_Collection, fetchedValues)
{
    ZEND_PARSE_PARAMETERS_NONE(); collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS));
    zval *items = collection_items(&o->std); if (items == NULL) RETURN_THROWS();
    zval *fetched = collection_fetched(&o->std); if (fetched == NULL) RETURN_THROWS();
    array_init(return_value); zend_string *id;
    zval *entry;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(items), id, entry) { zval *key, *model; if (id == NULL) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); collection_invalid_storage("item identity"); RETURN_THROWS(); } if (!entry_parts(entry, &key, &model)) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } zval *v = zend_hash_find(Z_ARRVAL_P(fetched), id); if (v) { Z_TRY_ADDREF_P(v); add_next_index_zval(return_value,v); } else add_next_index_null(return_value); } ZEND_HASH_FOREACH_END();
}

PHP_METHOD(Polyspec_Orm_Collection, connect)
{
    zval *db; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_OBJECT(db) ZEND_PARSE_PARAMETERS_END();
    if (!collection_db_argument(db, 1)) RETURN_THROWS();
    zval *entry; collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS));
    zval *items = collection_items(&o->std); if (items == NULL) RETURN_THROWS();
    HashTable *snapshot = zend_array_dup(Z_ARRVAL_P(items));
    ZEND_HASH_FOREACH_VAL(snapshot, entry) {
        zval *model = entry_model(entry), result;
        if (!model) { if (EG(exception)) { zend_array_destroy(snapshot); RETURN_THROWS(); } continue; }
        ZVAL_UNDEF(&result); zend_call_method_with_1_params(Z_OBJ_P(model), Z_OBJCE_P(model), NULL, "connect", &result, db);
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        if (EG(exception)) { zend_array_destroy(snapshot); RETURN_THROWS(); }
    } ZEND_HASH_FOREACH_END();
    zend_array_destroy(snapshot);
    RETURN_ZVAL(ZEND_THIS, 1, 0);
}

PHP_METHOD(Polyspec_Orm_Collection, __invoke)
{
    zval *db; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_OBJECT(db) ZEND_PARSE_PARAMETERS_END();
    if (!collection_db_argument(db, 1)) RETURN_THROWS();
    zval result; ZVAL_UNDEF(&result);
    zend_call_method_with_1_params(Z_OBJ_P(ZEND_THIS), Z_OBJCE_P(ZEND_THIS), NULL, "connect", &result, db);
    if (EG(exception)) RETURN_THROWS();
    RETURN_ZVAL(&result, 0, 1);
}

PHP_METHOD(Polyspec_Orm_Collection, delete)
{
    bool recursive = false;
    ZEND_PARSE_PARAMETERS_START(0,1) Z_PARAM_OPTIONAL Z_PARAM_BOOL(recursive) ZEND_PARSE_PARAMETERS_END();
    collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS));
    zval *storage = collection_items(&o->std); if (storage == NULL) RETURN_THROWS();
    HashPosition pos; HashTable *items = Z_ARRVAL_P(storage); zend_hash_internal_pointer_reset_ex(items, &pos);
    zval *first = zend_hash_get_current_data_ex(items, &pos);
    if (!first) RETURN_NULL();
    zval *first_model = entry_model(first), connection;
    if (!first_model) { if (EG(exception)) RETURN_THROWS(); RETURN_NULL(); }
    ZVAL_UNDEF(&connection);
    zend_call_method_with_0_params(Z_OBJ_P(first_model), Z_OBJCE_P(first_model), NULL, "connection", &connection);
    if (EG(exception)) { if (!Z_ISUNDEF(connection)) zval_ptr_dtor(&connection); RETURN_THROWS(); }

    zval callback_owner, callback;
    object_init_ex(&callback_owner, collection_delete_callback_ce);
    collection_delete_callback *callback_state = DCOBJ(Z_OBJ(callback_owner));
    ZVAL_OBJ_COPY(&callback_state->owner, &o->std);
    callback_state->recursive = recursive;
    ZVAL_UNDEF(&callback);
    zend_call_method(NULL, zend_ce_closure, NULL, "fromcallable", sizeof("fromcallable") - 1,
        &callback, 1, &callback_owner, NULL);
    zval_ptr_dtor(&callback_owner);
    if (EG(exception)) { if (!Z_ISUNDEF(callback)) zval_ptr_dtor(&callback); zval_ptr_dtor(&connection); RETURN_THROWS(); }
    zend_string *db_name = zend_string_init("Polyspec\\Orm\\Db", sizeof("Polyspec\\Orm\\Db")-1, 0);
    zend_class_entry *db_class = zend_lookup_class(db_name); zend_string_release(db_name);
    if (!db_class) {
        zval_ptr_dtor(&callback); zval_ptr_dtor(&connection);
        zend_throw_error(NULL, "Polyspec\\Orm\\Db is not loaded"); RETURN_THROWS();
    }
    zval args[2], result;
    ZVAL_COPY(&args[0], &connection); ZVAL_COPY_VALUE(&args[1], &callback); ZVAL_UNDEF(&result);
    zend_call_method(NULL, db_class, NULL, "intransaction", sizeof("intransaction")-1, &result, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&connection);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    if (EG(exception)) RETURN_THROWS();
}

PHP_METHOD(Polyspec_Orm_Collection, toArray)
{
    ZEND_PARSE_PARAMETERS_NONE(); collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS));
    zval *items = collection_items(&o->std); if (items == NULL) RETURN_THROWS();
    array_init(return_value); zval *entry; HashTable *snapshot = zend_array_dup(Z_ARRVAL_P(items));
    ZEND_HASH_FOREACH_VAL(snapshot, entry) { zval *model = entry_model(entry); if (!model) { if (EG(exception)) { zend_array_destroy(snapshot); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } continue; } zval value; ZVAL_UNDEF(&value); zend_call_method_with_0_params(Z_OBJ_P(model), Z_OBJCE_P(model), NULL, "toarray", &value); if (EG(exception)) { if (!Z_ISUNDEF(value)) zval_ptr_dtor(&value); zend_array_destroy(snapshot); zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } add_next_index_zval(return_value, &value); } ZEND_HASH_FOREACH_END(); zend_array_destroy(snapshot);
}

PHP_METHOD(Polyspec_Orm_Collection, toJson)
{
    ZEND_PARSE_PARAMETERS_NONE(); smart_str out = {0}; smart_str_appends(&out, "["); collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS)); zval *entry; bool comma = false;
    zval *items = collection_items(&o->std); if (items == NULL) { smart_str_free(&out); RETURN_THROWS(); }
    HashTable *snapshot = zend_array_dup(Z_ARRVAL_P(items));
    ZEND_HASH_FOREACH_VAL(snapshot, entry) { zval *model = entry_model(entry); if (!model) { if (EG(exception)) { smart_str_free(&out); zend_array_destroy(snapshot); RETURN_THROWS(); } continue; } zval json; ZVAL_UNDEF(&json); zend_call_method_with_0_params(Z_OBJ_P(model), Z_OBJCE_P(model), NULL, "tojson", &json); if (EG(exception)) { if (!Z_ISUNDEF(json)) zval_ptr_dtor(&json); smart_str_free(&out); zend_array_destroy(snapshot); RETURN_THROWS(); } if (comma) smart_str_appendc(&out, ','); comma = true; if (Z_TYPE(json) == IS_STRING) smart_str_append(&out, Z_STR(json)); else { zend_string *s = zval_try_get_string(&json); if (!s) { zval_ptr_dtor(&json); smart_str_free(&out); zend_array_destroy(snapshot); RETURN_THROWS(); } smart_str_append(&out, s); zend_string_release(s); } zval_ptr_dtor(&json); } ZEND_HASH_FOREACH_END(); zend_array_destroy(snapshot);
    smart_str_appendc(&out, ']'); smart_str_0(&out); RETURN_STR(out.s);
}

PHP_METHOD(Polyspec_Orm_Collection, jsonSerialize)
{ ZEND_PARSE_PARAMETERS_NONE(); collection_object *o = COBJ(Z_OBJ_P(ZEND_THIS)); zval *items = collection_items(&o->std); if (items == NULL) RETURN_THROWS(); array_init(return_value); zval *entry; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(items), entry) { zval *model = entry_model(entry); if (!model) { if (EG(exception)) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); } continue; } Z_TRY_ADDREF_P(model); add_next_index_zval(return_value, model); } ZEND_HASH_FOREACH_END(); }

PHP_METHOD(Polyspec_Orm_Collection, getIterator)
{
    ZEND_PARSE_PARAMETERS_NONE();
    object_init_ex(return_value, collection_iterator_ce);
    collection_iterator *it = IOBJ(Z_OBJ_P(return_value));
    ZVAL_OBJ_COPY(&it->owner, Z_OBJ_P(ZEND_THIS));
}

/* Iterator::rewind is the first point at which foreach starts. The snapshot is deliberately
 * taken here rather than in getIterator(), matching a generator's deferred start behavior. */
static zval *iterator_entry(collection_iterator *it)
{
    if (Z_ISUNDEF(it->snapshot) || Z_TYPE(it->snapshot) != IS_ARRAY) return NULL;
    return zend_hash_get_current_data_ex(Z_ARRVAL(it->snapshot), &it->position);
}

static void iterator_start(collection_iterator *it)
{
    if (Z_ISUNDEF(it->owner) || Z_TYPE(it->owner) != IS_OBJECT) return;
    collection_object *owner = COBJ(Z_OBJ(it->owner));
    if (Z_ISUNDEF(it->snapshot)) {
        zval *items = collection_items(&owner->std);
        if (items == NULL) return;
        ZVAL_ARR(&it->snapshot, zend_array_dup(Z_ARRVAL_P(items)));
    }
    zend_hash_internal_pointer_reset_ex(Z_ARRVAL(it->snapshot), &it->position);
}

static zend_object_iterator *collection_get_iterator(zend_class_entry *ce, zval *object, int by_ref)
{
    zval iterator;
    ZVAL_UNDEF(&iterator);
    zend_call_method_with_0_params(Z_OBJ_P(object), ce, NULL, "getiterator", &iterator);
    if (EG(exception) || Z_TYPE(iterator) != IS_OBJECT) {
        if (!Z_ISUNDEF(iterator)) zval_ptr_dtor(&iterator);
        return NULL;
    }
    zend_object_iterator *result = collection_iterator_get_iterator(collection_iterator_ce, &iterator, by_ref);
    zval_ptr_dtor(&iterator);
    return result;
}

PHP_METHOD(Polyspec_Orm_CollectionIterator, rewind)
{
    ZEND_PARSE_PARAMETERS_NONE(); collection_iterator *it = IOBJ(Z_OBJ_P(ZEND_THIS));
    iterator_start(it);
}

PHP_METHOD(Polyspec_Orm_CollectionIterator, valid)
{
    ZEND_PARSE_PARAMETERS_NONE(); RETURN_BOOL(iterator_entry(IOBJ(Z_OBJ_P(ZEND_THIS))) != NULL);
}

PHP_METHOD(Polyspec_Orm_CollectionIterator, next)
{
    ZEND_PARSE_PARAMETERS_NONE(); collection_iterator *it = IOBJ(Z_OBJ_P(ZEND_THIS));
    if (!Z_ISUNDEF(it->snapshot) && Z_TYPE(it->snapshot) == IS_ARRAY) zend_hash_move_forward_ex(Z_ARRVAL(it->snapshot), &it->position);
}

PHP_METHOD(Polyspec_Orm_CollectionIterator, current)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval *entry = iterator_entry(IOBJ(Z_OBJ_P(ZEND_THIS)));
    if (!entry) RETURN_NULL(); zval *model = entry_model(entry); if (!model) { if (EG(exception)) RETURN_THROWS(); RETURN_NULL(); } RETURN_COPY(model);
}

PHP_METHOD(Polyspec_Orm_CollectionIterator, key)
{
    ZEND_PARSE_PARAMETERS_NONE(); zval *entry = iterator_entry(IOBJ(Z_OBJ_P(ZEND_THIS)));
    if (!entry) RETURN_NULL(); zval *key = entry_key(entry); if (!key) { if (EG(exception)) RETURN_THROWS(); RETURN_NULL(); } RETURN_COPY(key);
}

/* Wire generated Collection metadata to native storage and register the private helper iterator. */
void collection_init(zend_class_entry *collection_ce, zend_class_entry *iterator_ce,
    zend_class_entry *delete_callback_ce)
{
    collection_iterator_ce = iterator_ce;
    collection_delete_callback_ce = delete_callback_ce;
    collection_iterator_ce->ce_flags |= ZEND_ACC_NOT_SERIALIZABLE;
    collection_delete_callback_ce->ce_flags |= ZEND_ACC_NOT_SERIALIZABLE;
    collection_iterator_ce->create_object = iterator_create;
    collection_iterator_ce->get_iterator = collection_iterator_get_iterator;
    iterator_handlers = std_object_handlers;
    iterator_handlers.offset = XtOffsetOf(collection_iterator, std);
    iterator_handlers.free_obj = iterator_free;
    iterator_handlers.get_gc = iterator_gc;
    iterator_handlers.clone_obj = iterator_clone;

    collection_delete_callback_ce->create_object = delete_callback_create;
    delete_callback_handlers = std_object_handlers;
    delete_callback_handlers.offset = XtOffsetOf(collection_delete_callback, std);
    delete_callback_handlers.free_obj = delete_callback_free;
    delete_callback_handlers.get_gc = delete_callback_gc;
    delete_callback_handlers.clone_obj = delete_callback_clone;

    collection_ce->create_object = collection_create;
    collection_ce->get_iterator = collection_get_iterator;
    collection_handlers = std_object_handlers;
    collection_handlers.offset = XtOffsetOf(collection_object, std);
    collection_handlers.free_obj = collection_free;
    collection_handlers.clone_obj = collection_clone;

}
