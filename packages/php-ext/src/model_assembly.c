/* Native runtime model and result assembly helpers. */
#include "model_assembly.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_objects_API.h"
#include "ext/json/php_json.h"
#include "ext/spl/spl_exceptions.h"
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

zend_class_entry *polyspec_frame_ce;
zend_class_entry *polyspec_assembly_ce;
zend_class_entry *polyspec_group_row_ce;
zend_class_entry *polyspec_group_rows_ce;

zend_class_entry *polyspec_group_rows_iterator_ce;
static zend_object_handlers group_rows_iterator_handlers;

typedef struct {
    zval owner;
    zval snapshot;
    HashPosition position;
    zend_object std;
} group_rows_iterator;

typedef struct {
    zend_object_iterator intern;
} group_rows_iterator_adapter;

#define GRI(o) ((group_rows_iterator *)((char *)(o) - XtOffsetOf(group_rows_iterator, std)))

static zval *read_prop_scope(zend_class_entry *scope, zend_object *obj, const char *name)
{
    return zend_read_property(scope, obj, name, strlen(name), 1, NULL);
}

static void write_prop(zend_class_entry *scope, zval *obj, const char *name, zval *value)
{
    zend_update_property(scope, Z_OBJ_P(obj), name, strlen(name), value);
}

static bool call_static(zend_class_entry *ce, const char *method, zval *retval, uint32_t argc, zval *args)
{
    zend_string *key = zend_string_init(method, strlen(method), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = NULL;
    for (zend_class_entry *scope = ce; scope != NULL && fn == NULL; scope = scope->parent) {
        fn = zend_hash_find_ptr(&scope->function_table, key);
    }
    zend_string_release(key);
    if (fn == NULL) {
        zend_throw_error(NULL, "%s::%s is not available", ZSTR_VAL(ce->name), method);
        return false;
    }
    ZVAL_UNDEF(retval);
    zend_call_known_function(fn, NULL, ce, retval, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool call_method(zend_object *obj, const char *method, zval *retval, uint32_t argc, zval *args)
{
    zend_string *key = zend_string_init(method, strlen(method), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *fn = NULL;
    for (zend_class_entry *scope = obj->ce; scope != NULL && fn == NULL; scope = scope->parent) {
        fn = zend_hash_find_ptr(&scope->function_table, key);
    }
    zend_string_release(key);
    if (fn == NULL) {
        zend_throw_error(NULL, "%s::%s is not available", ZSTR_VAL(obj->ce->name), method);
        return false;
    }
    ZVAL_UNDEF(retval);
    zend_call_known_function(fn, obj, obj->ce, retval, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool orm_fail(const char *code, zend_string *message)
{
    zend_string *class_name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (ce == NULL) {
        zend_string_release(message);
        zend_throw_error(NULL, "class Polyspec\\Orm\\OrmException is not loaded");
        return false;
    }
    zval ex, args[2], rv;
    object_init_ex(&ex, ce);
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], message);
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

static bool orm_failf(const char *code, const char *format, ...)
{
    va_list ap;
    va_start(ap, format);
    zend_string *message = zend_vstrpprintf(0, format, ap);
    va_end(ap);
    return orm_fail(code, message);
}

static bool is_assoc_key(zval *key)
{
    return Z_TYPE_P(key) == IS_STRING || Z_TYPE_P(key) == IS_LONG;
}

static zend_ulong object_id(zend_object *obj)
{
    return (zend_ulong)obj->handle;
}

static zval *array_find(zval *array, const char *key)
{
    ZVAL_DEREF(array);
    if (Z_TYPE_P(array) != IS_ARRAY) return NULL;
    return zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key));
}

static zval *array_find_index(zval *array, zend_long index)
{
    ZVAL_DEREF(array);
    if (Z_TYPE_P(array) != IS_ARRAY || index < 0) return NULL;
    return zend_hash_index_find(Z_ARRVAL_P(array), (zend_ulong)index);
}

static bool class_named(const char *name, zend_class_entry **out)
{
    zend_string *s = zend_string_init(name, strlen(name), 0);
    *out = zend_lookup_class(s);
    zend_string_release(s);
    return *out != NULL;
}

/* Frame */

ZEND_METHOD(Polyspec_Orm_Frame, __construct)
{
    zval *root, *outer = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(root)
        Z_PARAM_OBJECT_OR_NULL(outer)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *model_name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\Model"), 0);
    zend_class_entry *model_ce = zend_lookup_class(model_name);
    zend_string_release(model_name);
    if (model_ce == NULL || !instanceof_function(Z_OBJCE_P(root), model_ce) ||
        (outer != NULL && Z_TYPE_P(outer) == IS_OBJECT && !instanceof_function(Z_OBJCE_P(outer), model_ce))) {
        zend_type_error("Polyspec\\Orm\\Frame::__construct(): Argument #1 ($root) and #2 ($outer) must be Model objects");
        RETURN_THROWS();
    }
    write_prop(polyspec_frame_ce, ZEND_THIS, "root", root);
    zval outer_null;
    if (outer == NULL) ZVAL_NULL(&outer_null);
    write_prop(polyspec_frame_ce, ZEND_THIS, "outer", outer == NULL ? &outer_null : outer);
    zval paths, parents, placed, empty;
    array_init(&paths); array_init(&parents); array_init(&placed);
    ZVAL_STR(&empty, ZSTR_EMPTY_ALLOC());
    zend_hash_index_update(Z_ARRVAL(paths), object_id(Z_OBJ_P(root)), &empty);
    write_prop(polyspec_frame_ce, ZEND_THIS, "paths", &paths);
    write_prop(polyspec_frame_ce, ZEND_THIS, "parents", &parents);
    write_prop(polyspec_frame_ce, ZEND_THIS, "placed", &placed);
    zval id;
    ZVAL_LONG(&id, (zend_long)object_id(Z_OBJ_P(root)));
    write_prop(polyspec_frame_ce, ZEND_THIS, "rootId", &id);
    zval_ptr_dtor(&paths); zval_ptr_dtor(&parents); zval_ptr_dtor(&placed);

    zval args[2], ignored;
    ZVAL_COPY(&args[0], ZEND_THIS);
    ZVAL_STRING(&args[1], "");
    if (!call_method(Z_OBJ_P(root), "registerJoins", &ignored, 2, args)) {
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&ignored); zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
}

ZEND_METHOD(Polyspec_Orm_Frame, add)
{
    zval *child, *parent;
    zend_string *path;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT(child)
        Z_PARAM_STR(path)
        Z_PARAM_OBJECT(parent)
    ZEND_PARSE_PARAMETERS_END();
    zval *paths = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "paths");
    zval *parents = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "parents");
    zval v;
    ZVAL_STR_COPY(&v, path);
    zend_hash_index_update(Z_ARRVAL_P(paths), object_id(Z_OBJ_P(child)), &v);
    zval p;
    ZVAL_COPY(&p, parent);
    zend_hash_index_update(Z_ARRVAL_P(parents), object_id(Z_OBJ_P(child)), &p);
}

ZEND_METHOD(Polyspec_Orm_Frame, path)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(model) ZEND_PARSE_PARAMETERS_END();
    zend_long id = (zend_long)object_id(Z_OBJ_P(model));
    zval *paths = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "paths");
    zval *path = zend_hash_index_find(Z_ARRVAL_P(paths), (zend_ulong)id);
    if (path == NULL) {
        zend_error(E_WARNING, "Undefined array key " ZEND_LONG_FMT, id);
        RETURN_NULL();
    }
    RETURN_COPY(path);
}

ZEND_METHOD(Polyspec_Orm_Frame, joined)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(model) ZEND_PARSE_PARAMETERS_END();
    zend_long id = (zend_long)object_id(Z_OBJ_P(model));
    zval *root_id = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "rootId");
    zval *paths = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "paths");
    RETURN_BOOL(Z_TYPE_P(root_id) == IS_LONG && Z_LVAL_P(root_id) != id &&
        zend_hash_index_exists(Z_ARRVAL_P(paths), (zend_ulong)id));
}

ZEND_METHOD(Polyspec_Orm_Frame, parentOf)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(model) ZEND_PARSE_PARAMETERS_END();
    zval *parents = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "parents");
    zval *parent = zend_hash_index_find(Z_ARRVAL_P(parents), object_id(Z_OBJ_P(model)));
    if (parent == NULL) RETURN_NULL();
    RETURN_COPY(parent);
}

ZEND_METHOD(Polyspec_Orm_Frame, place)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(model) ZEND_PARSE_PARAMETERS_END();
    zval *placed = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "placed");
    zend_ulong id = object_id(Z_OBJ_P(model));
    if (zend_hash_index_exists(Z_ARRVAL_P(placed), id)) RETURN_FALSE;
    zval yes; ZVAL_TRUE(&yes);
    zend_hash_index_update(Z_ARRVAL_P(placed), id, &yes);
    RETURN_TRUE;
}

ZEND_METHOD(Polyspec_Orm_Frame, pathOf)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_OBJECT(model) ZEND_PARSE_PARAMETERS_END();
    zend_ulong id = object_id(Z_OBJ_P(model));
    zval *paths = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "paths");
    zval *path = zend_hash_index_find(Z_ARRVAL_P(paths), id);
    if (path != NULL) RETURN_COPY(path);
    zval *outer = read_prop_scope(polyspec_frame_ce, Z_OBJ_P(ZEND_THIS), "outer");
    if (Z_TYPE_P(outer) == IS_OBJECT && Z_OBJ_P(outer) == Z_OBJ_P(model)) RETURN_STRING("^");

    zend_string *meta_name = zend_string_init(ZEND_STRL("meta"), 0);
    zend_function *meta_fn = zend_hash_find_ptr(&Z_OBJCE_P(model)->function_table, meta_name);
    zend_string_release(meta_name);
    zval metadata;
    if (meta_fn != NULL) {
        ZVAL_UNDEF(&metadata);
        zend_call_known_function(meta_fn, NULL, Z_OBJCE_P(model), &metadata, 0, NULL, NULL);
        if (EG(exception) != NULL) RETURN_THROWS();
    } else {
        ZVAL_NULL(&metadata);
    }
    zval *entity = array_find(&metadata, "entity");
    zend_string *entity_name = entity != NULL ? zval_get_string(entity) : zend_string_init("?", 1, 0);
    bool ok = orm_failf("CONFIG", "%s is not part of the statement", ZSTR_VAL(entity_name));
    zend_string_release(entity_name);
    zval_ptr_dtor(&metadata);
    if (!ok) RETURN_THROWS();
}

/* GroupRow */

static bool group_row_checked_count(zval *value, zend_long *out)
{
    ZVAL_DEREF(value);
    if (Z_TYPE_P(value) == IS_LONG) {
        if (Z_LVAL_P(value) < 0) return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("group result row_count is negative"), 0));
        *out = Z_LVAL_P(value);
        return true;
    }
    if (Z_TYPE_P(value) == IS_STRING) {
        zend_string *s = Z_STR_P(value);
        const char *p = ZSTR_VAL(s);
        size_t n = ZSTR_LEN(s);
        bool valid = n > 0 && !(n > 1 && p[0] == '0');
        for (size_t i = 0; valid && i < n; i++) valid = p[i] >= '0' && p[i] <= '9';
        char maxbuf[64];
        int maxlen = snprintf(maxbuf, sizeof(maxbuf), ZEND_LONG_FMT, ZEND_LONG_MAX);
        if (valid && (n > (size_t)maxlen || (n == (size_t)maxlen && memcmp(p, maxbuf, n) > 0))) valid = false;
        if (valid) {
            zend_long count = 0;
            for (size_t i = 0; i < n; i++) count = count * 10 + (p[i] - '0');
            *out = count;
            return true;
        }
    }
    return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("group result row_count is not an exact integer"), 0));
}

ZEND_METHOD(Polyspec_Orm_GroupRow, __construct)
{
    zval *entries;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(entries) ZEND_PARSE_PARAMETERS_END();
    zval values;
    array_init(&values);
    zval *entry;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(entries), entry) {
        zval count_args[1], count_result;
        ZVAL_COPY(&count_args[0], entry);
        zend_function *count_fn = zend_hash_str_find_ptr(CG(function_table), ZEND_STRL("count"));
        if (count_fn == NULL) { zval_ptr_dtor(&count_args[0]); zval_ptr_dtor(&values); zend_throw_error(NULL, "count() is not available"); RETURN_THROWS(); }
        ZVAL_UNDEF(&count_result);
        zend_call_known_function(count_fn, NULL, NULL, &count_result, 1, count_args, NULL);
        zval_ptr_dtor(&count_args[0]);
        if (EG(exception) != NULL) { zval_ptr_dtor(&values); RETURN_THROWS(); }
        bool pair = Z_TYPE(count_result) == IS_LONG && Z_LVAL(count_result) == 2;
        zval_ptr_dtor(&count_result);
        if (!pair) { zval_ptr_dtor(&values); orm_fail("CONFIG", zend_string_init(ZEND_STRL("group result entry must have a name and value"), 0)); RETURN_THROWS(); }
        zval *name = zend_hash_index_find(Z_ARRVAL_P(entry), 0);
        zval *value = zend_hash_index_find(Z_ARRVAL_P(entry), 1);
        if (name == NULL || value == NULL) { zval_ptr_dtor(&values); orm_fail("CONFIG", zend_string_init(ZEND_STRL("group result entry must have a name and value"), 0)); RETURN_THROWS(); }
        zval *name_deref = name;
        ZVAL_DEREF(name_deref);
        if (Z_TYPE_P(name_deref) == IS_STRING && Z_STRLEN_P(name_deref) == 0) {
            zval_ptr_dtor(&values);
            orm_fail("CONFIG", zend_string_init(ZEND_STRL("group result repeats or omits column "), 0));
            RETURN_THROWS();
        }
        if (!is_assoc_key(name_deref)) {
            zval_ptr_dtor(&values);
            zend_type_error("Illegal offset type");
            RETURN_THROWS();
        }
        bool exists = Z_TYPE_P(name_deref) == IS_LONG
            ? zend_hash_index_exists(Z_ARRVAL(values), (zend_ulong)Z_LVAL_P(name_deref))
            : zend_symtable_exists(Z_ARRVAL(values), Z_STR_P(name_deref));
        if (exists) {
            zend_string *label = zval_get_string(name_deref);
            zval_ptr_dtor(&values);
            orm_failf("CONFIG", "group result repeats or omits column %s", ZSTR_VAL(label));
            zend_string_release(label);
            RETURN_THROWS();
        }
        zval copy; ZVAL_COPY(&copy, value);
        if (Z_TYPE_P(name_deref) == IS_LONG) zend_hash_index_update(Z_ARRVAL(values), (zend_ulong)Z_LVAL_P(name_deref), &copy);
        else zend_symtable_update(Z_ARRVAL(values), Z_STR_P(name_deref), &copy);
    } ZEND_HASH_FOREACH_END();
    if (!zend_hash_str_exists(Z_ARRVAL(values), ZEND_STRL("row_count"))) {
        zval_ptr_dtor(&values);
        orm_fail("INTERNAL", zend_string_init(ZEND_STRL("group result has no row_count"), 0));
        RETURN_THROWS();
    }
    zval *row_count = zend_hash_str_find(Z_ARRVAL(values), ZEND_STRL("row_count"));
    zend_long checked;
    if (!group_row_checked_count(row_count, &checked)) { zval_ptr_dtor(&values); RETURN_THROWS(); }
    zval checked_zv; ZVAL_LONG(&checked_zv, checked);
    zend_hash_str_update(Z_ARRVAL(values), ZEND_STRL("row_count"), &checked_zv);
    write_prop(polyspec_group_row_ce, ZEND_THIS, "values", &values);
    write_prop(polyspec_group_row_ce, ZEND_THIS, "count", &checked_zv);
    zval_ptr_dtor(&values);
}

ZEND_METHOD(Polyspec_Orm_GroupRow, count)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *count = read_prop_scope(polyspec_group_row_ce, Z_OBJ_P(ZEND_THIS), "count");
    RETURN_COPY(count);
}

ZEND_METHOD(Polyspec_Orm_GroupRow, value)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *values = read_prop_scope(polyspec_group_row_ce, Z_OBJ_P(ZEND_THIS), "values");
    zval *value = zend_symtable_find(Z_ARRVAL_P(values), name);
    if (value == NULL) {
        orm_failf("COLUMN_UNSELECTED", "group column %s was not selected", ZSTR_VAL(name));
        RETURN_THROWS();
    }
    RETURN_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_GroupRow, toArray)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *values = read_prop_scope(polyspec_group_row_ce, Z_OBJ_P(ZEND_THIS), "values");
    RETURN_COPY(values);
}

ZEND_METHOD(Polyspec_Orm_GroupRow, jsonSerialize)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *values = read_prop_scope(polyspec_group_row_ce, Z_OBJ_P(ZEND_THIS), "values");
    RETURN_COPY(values);
}

/* GroupRows and its lazy array-snapshot iterator. */

static zend_object *group_rows_iterator_create(zend_class_entry *ce)
{
    group_rows_iterator *it = zend_object_alloc(sizeof(*it), ce);
    zend_object_std_init(&it->std, ce);
    object_properties_init(&it->std, ce);
    ZVAL_UNDEF(&it->owner);
    ZVAL_UNDEF(&it->snapshot);
    it->position = 0;
    it->std.handlers = &group_rows_iterator_handlers;
    return &it->std;
}

static void group_rows_iterator_free(zend_object *obj)
{
    group_rows_iterator *it = GRI(obj);
    if (!Z_ISUNDEF(it->owner)) zval_ptr_dtor(&it->owner);
    if (!Z_ISUNDEF(it->snapshot)) zval_ptr_dtor(&it->snapshot);
    zend_object_std_dtor(obj);
}

static HashTable *group_rows_iterator_gc(zend_object *obj, zval **table, int *n)
{
    group_rows_iterator *it = GRI(obj);
    *table = &it->owner;
    *n = 2;
    return zend_std_get_properties(obj);
}

static zval *group_rows_iterator_current(group_rows_iterator *it)
{
    if (Z_ISUNDEF(it->snapshot) || Z_TYPE(it->snapshot) != IS_ARRAY) return NULL;
    return zend_hash_get_current_data_ex(Z_ARRVAL(it->snapshot), &it->position);
}

static void group_rows_iterator_adapter_dtor(zend_object_iterator *iterator)
{
    zval_ptr_dtor(&iterator->data);
}

static zend_result group_rows_iterator_adapter_valid(zend_object_iterator *iterator)
{
    return group_rows_iterator_current(GRI(Z_OBJ(iterator->data))) == NULL || EG(exception) ? FAILURE : SUCCESS;
}

static zval *group_rows_iterator_adapter_current(zend_object_iterator *iterator)
{
    return group_rows_iterator_current(GRI(Z_OBJ(iterator->data)));
}

static void group_rows_iterator_adapter_key(zend_object_iterator *iterator, zval *key)
{
    group_rows_iterator *it = GRI(Z_OBJ(iterator->data));
    if (group_rows_iterator_current(it) == NULL) { ZVAL_NULL(key); return; }
    zend_string *string_key = NULL; zend_ulong index = 0;
    int kind = zend_hash_get_current_key_ex(Z_ARRVAL(it->snapshot), &string_key, &index, &it->position);
    if (kind == HASH_KEY_IS_STRING) ZVAL_STR_COPY(key, string_key);
    else if (kind == HASH_KEY_IS_LONG) ZVAL_LONG(key, (zend_long)index);
    else ZVAL_NULL(key);
}

static void group_rows_iterator_adapter_next(zend_object_iterator *iterator)
{
    group_rows_iterator *it = GRI(Z_OBJ(iterator->data));
    if (!Z_ISUNDEF(it->snapshot) && Z_TYPE(it->snapshot) == IS_ARRAY)
        zend_hash_move_forward_ex(Z_ARRVAL(it->snapshot), &it->position);
}

static void group_rows_iterator_adapter_rewind(zend_object_iterator *iterator)
{
    group_rows_iterator *it = GRI(Z_OBJ(iterator->data));
    if (Z_ISUNDEF(it->owner) || Z_TYPE(it->owner) != IS_OBJECT) return;
    zval *rows = read_prop_scope(polyspec_group_rows_ce, Z_OBJ(it->owner), "rows");
    if (!Z_ISUNDEF(it->snapshot)) zval_ptr_dtor(&it->snapshot);
    ZVAL_COPY(&it->snapshot, rows);
    zend_hash_internal_pointer_reset_ex(Z_ARRVAL(it->snapshot), &it->position);
}

static HashTable *group_rows_iterator_adapter_gc(zend_object_iterator *iterator, zval **table, int *n)
{
    *table = &iterator->data;
    *n = 1;
    return NULL;
}

static const zend_object_iterator_funcs group_rows_iterator_adapter_funcs = {
    group_rows_iterator_adapter_dtor,
    group_rows_iterator_adapter_valid,
    group_rows_iterator_adapter_current,
    group_rows_iterator_adapter_key,
    group_rows_iterator_adapter_next,
    group_rows_iterator_adapter_rewind,
    NULL,
    group_rows_iterator_adapter_gc
};

static zend_object_iterator *group_rows_iterator_get_iterator(zend_class_entry *ce, zval *object, int by_ref)
{
    if (by_ref) {
        zend_throw_error(NULL, "An iterator cannot be used with foreach by reference");
        return NULL;
    }
    group_rows_iterator_adapter *adapter = emalloc(sizeof(*adapter));
    zend_iterator_init(&adapter->intern);
    ZVAL_COPY(&adapter->intern.data, object);
    adapter->intern.funcs = &group_rows_iterator_adapter_funcs;
    return &adapter->intern;
}

ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, current)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *value = group_rows_iterator_current(GRI(Z_OBJ_P(ZEND_THIS)));
    if (value == NULL) RETURN_NULL();
    RETURN_COPY(value);
}

ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, key)
{
    ZEND_PARSE_PARAMETERS_NONE();
    group_rows_iterator *it = GRI(Z_OBJ_P(ZEND_THIS));
    if (group_rows_iterator_current(it) == NULL) RETURN_NULL();
    zend_string *key = NULL; zend_ulong idx = 0;
    int type = zend_hash_get_current_key_ex(Z_ARRVAL(it->snapshot), &key, &idx, &it->position);
    if (type == HASH_KEY_IS_STRING) RETURN_STR_COPY(key);
    if (type == HASH_KEY_IS_LONG) RETURN_LONG((zend_long)idx);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, next)
{
    ZEND_PARSE_PARAMETERS_NONE();
    group_rows_iterator *it = GRI(Z_OBJ_P(ZEND_THIS));
    if (!Z_ISUNDEF(it->snapshot) && Z_TYPE(it->snapshot) == IS_ARRAY) zend_hash_move_forward_ex(Z_ARRVAL(it->snapshot), &it->position);
}

ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, rewind)
{
    ZEND_PARSE_PARAMETERS_NONE();
    group_rows_iterator *it = GRI(Z_OBJ_P(ZEND_THIS));
    if (Z_ISUNDEF(it->owner) || Z_TYPE(it->owner) != IS_OBJECT) RETURN_NULL();
    zval *rows = read_prop_scope(polyspec_group_rows_ce, Z_OBJ(it->owner), "rows");
    if (!Z_ISUNDEF(it->snapshot)) zval_ptr_dtor(&it->snapshot);
    ZVAL_COPY(&it->snapshot, rows);
    zend_hash_internal_pointer_reset_ex(Z_ARRVAL(it->snapshot), &it->position);
}

ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, valid)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_BOOL(group_rows_iterator_current(GRI(Z_OBJ_P(ZEND_THIS))) != NULL);
}

ZEND_METHOD(Polyspec_Orm_GroupRows, __construct)
{
    zval *rows;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(rows) ZEND_PARSE_PARAMETERS_END();
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        if (Z_TYPE_P(row) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(row), polyspec_group_row_ce)) {
            orm_fail("CONFIG", zend_string_init(ZEND_STRL("group result contains an invalid row"), 0));
            RETURN_THROWS();
        }
    } ZEND_HASH_FOREACH_END();
    write_prop(polyspec_group_rows_ce, ZEND_THIS, "rows", rows);
}

ZEND_METHOD(Polyspec_Orm_GroupRows, count)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *rows = read_prop_scope(polyspec_group_rows_ce, Z_OBJ_P(ZEND_THIS), "rows");
    RETURN_LONG(zend_hash_num_elements(Z_ARRVAL_P(rows)));
}

ZEND_METHOD(Polyspec_Orm_GroupRows, all)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *rows = read_prop_scope(polyspec_group_rows_ce, Z_OBJ_P(ZEND_THIS), "rows");
    RETURN_COPY(rows);
}

ZEND_METHOD(Polyspec_Orm_GroupRows, getIterator)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_object *obj = group_rows_iterator_create(polyspec_group_rows_iterator_ce);
    group_rows_iterator *it = GRI(obj);
    ZVAL_COPY(&it->owner, ZEND_THIS);
    RETURN_OBJ(obj);
}

ZEND_METHOD(Polyspec_Orm_GroupRows, toArray)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *rows = read_prop_scope(polyspec_group_rows_ce, Z_OBJ_P(ZEND_THIS), "rows");
    array_init_size(return_value, zend_hash_num_elements(Z_ARRVAL_P(rows)));
    zend_string *key; zend_ulong index; zval *row;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(rows), index, key, row) {
        zval converted;
        if (!call_method(Z_OBJ_P(row), "toArray", &converted, 0, NULL)) { zval_ptr_dtor(return_value); ZVAL_UNDEF(return_value); RETURN_THROWS(); }
        if (key != NULL) zend_hash_update(Z_ARRVAL_P(return_value), key, &converted);
        else zend_hash_index_update(Z_ARRVAL_P(return_value), index, &converted);
    } ZEND_HASH_FOREACH_END();
}

ZEND_METHOD(Polyspec_Orm_GroupRows, jsonSerialize)
{
    if (!call_method(Z_OBJ_P(ZEND_THIS), "toArray", return_value, 0, NULL)) RETURN_THROWS();
}

/* Assembly */

ZEND_METHOD(Polyspec_Orm_Assembly, __construct)
{
    zval *db, *conn = NULL, *result;
    bool track = false;
    ZEND_PARSE_PARAMETERS_START(3, 4)
        Z_PARAM_OBJECT(db)
        Z_PARAM_OBJECT_OR_NULL(conn)
        Z_PARAM_ARRAY(result)
        Z_PARAM_OPTIONAL
        Z_PARAM_BOOL(track)
    ZEND_PARSE_PARAMETERS_END();
    write_prop(polyspec_assembly_ce, ZEND_THIS, "db", db);
    zval conn_null;
    if (conn == NULL) ZVAL_NULL(&conn_null);
    write_prop(polyspec_assembly_ce, ZEND_THIS, "conn", conn == NULL ? &conn_null : conn);
    write_prop(polyspec_assembly_ce, ZEND_THIS, "result", result);
    zval track_zv; ZVAL_BOOL(&track_zv, track);
    write_prop(polyspec_assembly_ce, ZEND_THIS, "track", &track_zv);
    zval made; array_init(&made); write_prop(polyspec_assembly_ce, ZEND_THIS, "made", &made); zval_ptr_dtor(&made);
    zval *markdown = array_find(result, "markdown");
    zval truth; ZVAL_BOOL(&truth, markdown != NULL && zend_is_true(markdown));
    write_prop(polyspec_assembly_ce, ZEND_THIS, "markdown", &truth);
    zval zone;
    if (!call_method(Z_OBJ_P(db), "zone", &zone, 0, NULL)) RETURN_THROWS();
    write_prop(polyspec_assembly_ce, ZEND_THIS, "zone", &zone);
    zval_ptr_dtor(&zone);
}

static bool assembly_markdown_links(zval *parent, const char *field, const char *rel, zval *out)
{
    if (zend_hash_num_elements(Z_ARRVAL_P(parent)) == 0) { ZVAL_NULL(out); return true; }
    zval *last = zend_hash_index_find(Z_ARRVAL_P(parent), zend_hash_num_elements(Z_ARRVAL_P(parent)) - 1);
    if (last == NULL || Z_TYPE_P(last) != IS_OBJECT) { ZVAL_NULL(out); return true; }
    zend_string *class_name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\MarkdownLinks"), 0);
    zend_class_entry *links_ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (links_ce == NULL || !instanceof_function(Z_OBJCE_P(last), links_ce)) { ZVAL_NULL(out); return true; }
    zval *map = zend_read_property(links_ce, Z_OBJ_P(last), field, strlen(field), 1, NULL);
    zval *value = zend_hash_str_find(Z_ARRVAL_P(map), rel, strlen(rel));
    if (value == NULL) ZVAL_NULL(out); else ZVAL_COPY(out, value);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Assembly, joinRow)
{
    zval *child, *parent;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ARRAY(child) Z_PARAM_ARRAY(parent) ZEND_PARSE_PARAMETERS_END();
    zval *markdown = read_prop_scope(polyspec_assembly_ce, Z_OBJ_P(ZEND_THIS), "markdown");
    if (zend_is_true(markdown)) {
        zval *rel = array_find(child, "rel");
        zend_string *key = rel != NULL ? zval_get_string(rel) : ZSTR_EMPTY_ALLOC();
        zval row;
        assembly_markdown_links(parent, "joins", ZSTR_VAL(key), &row);
        if (rel != NULL) zend_string_release(key);
        if (Z_TYPE(row) == IS_NULL) { zval_ptr_dtor(&row); RETURN_NULL(); }
        RETURN_ZVAL(&row, 0, 0);
    }
    zval *assemble = array_find(child, "assemble");
    zval *columns = assemble != NULL ? array_find(assemble, "columns") : NULL;
    zval *first = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(columns), 0) : NULL;
    zval *idx = first != NULL ? array_find(first, "index") : NULL;
    if (idx == NULL || Z_TYPE_P(idx) != IS_LONG) RETURN_NULL();
    zval *cell = array_find_index(parent, Z_LVAL_P(idx));
    if (cell == NULL || Z_TYPE_P(cell) == IS_NULL) RETURN_NULL();
    RETURN_COPY(parent);
}

ZEND_METHOD(Polyspec_Orm_Assembly, relationAssemble)
{
    zval *child;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(child) ZEND_PARSE_PARAMETERS_END();
    zval *markdown = read_prop_scope(polyspec_assembly_ce, Z_OBJ_P(ZEND_THIS), "markdown");
    if (zend_is_true(markdown)) {
        zval *assemble = array_find(child, "assemble");
        if (assemble == NULL) RETURN_NULL();
        RETURN_COPY(assemble);
    }
    zval *result = read_prop_scope(polyspec_assembly_ce, Z_OBJ_P(ZEND_THIS), "result");
    zval *steps = array_find(result, "steps");
    zval *step_index = array_find(child, "step");
    if (steps == NULL || step_index == NULL || Z_TYPE_P(step_index) != IS_LONG) RETURN_NULL();
    zval *sr = array_find_index(steps, Z_LVAL_P(step_index));
    zval *step = sr != NULL ? array_find(sr, "step") : NULL;
    zval *assemble = step != NULL ? array_find(step, "assemble") : NULL;
    if (assemble == NULL) RETURN_NULL();
    RETURN_COPY(assemble);
}

ZEND_METHOD(Polyspec_Orm_Assembly, related)
{
    zval *child, *parent;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ARRAY(child) Z_PARAM_ARRAY(parent) ZEND_PARSE_PARAMETERS_END();
    zval *markdown = read_prop_scope(polyspec_assembly_ce, Z_OBJ_P(ZEND_THIS), "markdown");
    if (zend_is_true(markdown)) {
        zval *rel = array_find(child, "rel");
        zend_string *key = rel != NULL ? zval_get_string(rel) : ZSTR_EMPTY_ALLOC();
        zval rows;
        assembly_markdown_links(parent, "rels", ZSTR_VAL(key), &rows);
        if (rel != NULL) zend_string_release(key);
        if (Z_TYPE(rows) != IS_ARRAY) { zval_ptr_dtor(&rows); array_init(return_value); }
        else RETURN_ZVAL(&rows, 0, 0);
        return;
    }
    zval *result = read_prop_scope(polyspec_assembly_ce, Z_OBJ_P(ZEND_THIS), "result");
    zval *steps = array_find(result, "steps");
    zval *step_index = array_find(child, "step");
    if (steps == NULL || step_index == NULL || Z_TYPE_P(step_index) != IS_LONG) { array_init(return_value); return; }
    zval *sr = array_find_index(steps, Z_LVAL_P(step_index));
    if (sr == NULL) { array_init(return_value); return; }
    zval *step = array_find(sr, "step");
    zval *step_parent = step != NULL ? array_find(step, "parent") : NULL;
    zval *if_parent = step_parent != NULL ? array_find(step_parent, "if_parent") : NULL;
    if (if_parent != NULL && Z_TYPE_P(if_parent) == IS_ARRAY) {
        zval *index = array_find(if_parent, "index"), *param = array_find(if_parent, "param");
        zval *params = array_find(result, "params");
        zval *got = index != NULL && Z_TYPE_P(index) == IS_LONG ? array_find_index(parent, Z_LVAL_P(index)) : NULL;
        zval *want = param != NULL && Z_TYPE_P(param) == IS_LONG && params != NULL ? array_find_index(params, Z_LVAL_P(param)) : NULL;
        if (got == NULL || want == NULL) { array_init(return_value); return; }
        zval args[2], same;
        ZVAL_COPY(&args[0], got); ZVAL_COPY(&args[1], want);
        zend_class_entry *db_ce = NULL;
        if (!class_named("Polyspec\\Orm\\Db", &db_ce) || !call_static(db_ce, "sameScalar", &same, 2, args)) {
            zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); RETURN_THROWS();
        }
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
        bool matches = zend_is_true(&same); zval_ptr_dtor(&same);
        if (!matches) { array_init(return_value); return; }
    }
    zval *parent_keys = array_find(child, "parent_keys");
    if (parent_keys == NULL || Z_TYPE_P(parent_keys) != IS_ARRAY) { array_init(return_value); return; }
    zval args[2], slot;
    ZVAL_COPY(&args[0], parent); ZVAL_COPY(&args[1], parent_keys);
    zend_class_entry *db_ce = NULL;
    if (!class_named("Polyspec\\Orm\\Db", &db_ce) || !call_static(db_ce, "rowSlot", &slot, 2, args)) {
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); RETURN_THROWS();
    }
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (Z_TYPE(slot) == IS_NULL) { zval_ptr_dtor(&slot); array_init(return_value); return; }
    zval *by_key = array_find(sr, "byKey");
    zval *indices = by_key != NULL && Z_TYPE_P(by_key) == IS_ARRAY ? zend_symtable_find(Z_ARRVAL_P(by_key), Z_STR(slot)) : NULL;
    zval *data = array_find(sr, "data");
    array_init(return_value);
    if (indices != NULL && Z_TYPE_P(indices) == IS_ARRAY && data != NULL && Z_TYPE_P(data) == IS_ARRAY) {
        zval *index;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(indices), index) {
            if (Z_TYPE_P(index) == IS_LONG) {
                zval *row = zend_hash_index_find(Z_ARRVAL_P(data), (zend_ulong)Z_LVAL_P(index));
                if (row != NULL) { zval copy; ZVAL_COPY(&copy, row); add_next_index_zval(return_value, &copy); }
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&slot);
}

void polyspec_model_assembly_register(zend_class_entry *frame_ce, zend_class_entry *assembly_ce,
    zend_class_entry *group_row_ce, zend_class_entry *group_rows_ce, zend_class_entry *group_rows_iterator_ce)
{
    polyspec_frame_ce = frame_ce;
    polyspec_assembly_ce = assembly_ce;
    polyspec_group_row_ce = group_row_ce;
    polyspec_group_rows_ce = group_rows_ce;
    polyspec_group_rows_iterator_ce = group_rows_iterator_ce;
    polyspec_group_row_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    polyspec_group_rows_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    polyspec_group_rows_iterator_ce->ce_flags |= ZEND_ACC_NOT_SERIALIZABLE;
    polyspec_group_rows_iterator_ce->create_object = group_rows_iterator_create;
    polyspec_group_rows_iterator_ce->get_iterator = group_rows_iterator_get_iterator;
    group_rows_iterator_handlers = std_object_handlers;
    group_rows_iterator_handlers.offset = XtOffsetOf(group_rows_iterator, std);
    group_rows_iterator_handlers.free_obj = group_rows_iterator_free;
    group_rows_iterator_handlers.get_gc = group_rows_iterator_gc;
    group_rows_iterator_handlers.clone_obj = NULL;
}
