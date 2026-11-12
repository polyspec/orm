#include "php.h"
#include "Zend/zend_interfaces.h"
#include "pgsql_statement_iterator_native.h"
#include <stddef.h>

typedef struct {
    zval statement;
    zval current;
    zend_long key;
    zend_object std;
} orm_pgsql_statement_iterator_object;

typedef struct {
    zend_object_iterator intern;
    zval current;
} orm_pgsql_statement_iterator_cursor;

static zend_class_entry *orm_pgsql_statement_iterator_ce;
static zend_object_handlers orm_pgsql_statement_iterator_handlers;

static inline orm_pgsql_statement_iterator_object *orm_pgsql_statement_iterator_from_obj(zend_object *object)
{
    return (orm_pgsql_statement_iterator_object *) ((char *) object - XtOffsetOf(orm_pgsql_statement_iterator_object, std));
}

static zend_object *orm_pgsql_statement_iterator_create(zend_class_entry *ce)
{
    orm_pgsql_statement_iterator_object *object = ecalloc(1, sizeof(*object) + zend_object_properties_size(ce));
    ZVAL_UNDEF(&object->statement);
    ZVAL_FALSE(&object->current);
    object->key = 0;
    zend_object_std_init(&object->std, ce);
    object_properties_init(&object->std, ce);
    object->std.handlers = &orm_pgsql_statement_iterator_handlers;
    return &object->std;
}

static void orm_pgsql_statement_iterator_free(zend_object *std)
{
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(std);
    if (!Z_ISUNDEF(object->statement)) {
        zval_ptr_dtor(&object->statement);
    }
    if (!Z_ISUNDEF(object->current)) {
        zval_ptr_dtor(&object->current);
    }
    zend_object_std_dtor(&object->std);
}

static HashTable *orm_pgsql_statement_iterator_gc(zend_object *std, zval **table, int *n)
{
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(std);
    *table = &object->statement;
    *n = 2;
    return NULL;
}

static bool orm_pgsql_statement_iterator_accepts_statement(zval *statement)
{
    if (statement == NULL || Z_TYPE_P(statement) != IS_OBJECT) {
        return false;
    }
    zend_string *name = zend_string_init(
        "Polyspec\\Orm\\Internal\\PgsqlStatementAdapter",
        sizeof("Polyspec\\Orm\\Internal\\PgsqlStatementAdapter") - 1,
        0
    );
    zend_class_entry *statement_ce = zend_lookup_class(name);
    zend_string_release(name);
    return statement_ce != NULL && instanceof_function(Z_OBJCE_P(statement), statement_ce);
}

static bool orm_pgsql_statement_iterator_fetch(zval *statement, zval *row)
{
    ZVAL_UNDEF(row);
    zend_call_method_with_0_params(Z_OBJ_P(statement), Z_OBJCE_P(statement), NULL, "fetch", row);
    return EG(exception) == NULL && !Z_ISUNDEF_P(row);
}

static void orm_pgsql_statement_iterator_set_current(orm_pgsql_statement_iterator_object *object, zval *row)
{
    if (!Z_ISUNDEF(object->current)) {
        zval_ptr_dtor(&object->current);
    }
    ZVAL_COPY_VALUE(&object->current, row);
}

PHP_METHOD(Polyspec_Orm_Internal_PgsqlStatementIterator, __construct)
{
    zval *statement;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(statement)
    ZEND_PARSE_PARAMETERS_END();
    if (!orm_pgsql_statement_iterator_accepts_statement(statement)) {
        zend_type_error("%s::__construct(): Argument #1 ($statement) must be an instance of Polyspec\\Orm\\Internal\\PgsqlStatementAdapter", ZSTR_VAL(orm_pgsql_statement_iterator_ce->name));
        RETURN_THROWS();
    }
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(Z_OBJ_P(ZEND_THIS));
    if (!Z_ISUNDEF(object->statement)) {
        zval_ptr_dtor(&object->statement);
    }
    ZVAL_COPY(&object->statement, statement);
}

PHP_METHOD(Polyspec_Orm_Internal_PgsqlStatementIterator, current)
{
    ZEND_PARSE_PARAMETERS_NONE();
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(Z_OBJ_P(ZEND_THIS));
    RETURN_COPY(&object->current);
}

PHP_METHOD(Polyspec_Orm_Internal_PgsqlStatementIterator, key)
{
    ZEND_PARSE_PARAMETERS_NONE();
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(Z_OBJ_P(ZEND_THIS));
    RETURN_LONG(object->key);
}

/* Fetches the next row of the statement into the current row of object; a fetch that ends without an exception
 * leaves the current row as it is. False when the fetch threw. */
static bool orm_pgsql_statement_iterator_advance(orm_pgsql_statement_iterator_object *object)
{
    zval row;
    if (!orm_pgsql_statement_iterator_fetch(&object->statement, &row)) {
        return EG(exception) == NULL;
    }
    orm_pgsql_statement_iterator_set_current(object, &row);
    return true;
}

PHP_METHOD(Polyspec_Orm_Internal_PgsqlStatementIterator, next)
{
    ZEND_PARSE_PARAMETERS_NONE();
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(Z_OBJ_P(ZEND_THIS));
    object->key++;
    if (!orm_pgsql_statement_iterator_advance(object)) {
        RETURN_THROWS();
    }
    RETURN_NULL();
}

PHP_METHOD(Polyspec_Orm_Internal_PgsqlStatementIterator, rewind)
{
    ZEND_PARSE_PARAMETERS_NONE();
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(Z_OBJ_P(ZEND_THIS));
    object->key = 0;
    if (!orm_pgsql_statement_iterator_advance(object)) {
        RETURN_THROWS();
    }
    RETURN_NULL();
}

PHP_METHOD(Polyspec_Orm_Internal_PgsqlStatementIterator, valid)
{
    ZEND_PARSE_PARAMETERS_NONE();
    orm_pgsql_statement_iterator_object *object = orm_pgsql_statement_iterator_from_obj(Z_OBJ_P(ZEND_THIS));
    RETURN_BOOL(!(Z_TYPE(object->current) == IS_FALSE));
}

static void orm_pgsql_statement_iterator_cursor_destroy(zend_object_iterator *iterator)
{
    orm_pgsql_statement_iterator_cursor *cursor = (orm_pgsql_statement_iterator_cursor *) iterator;
    if (!Z_ISUNDEF(cursor->current)) {
        zval_ptr_dtor(&cursor->current);
    }
    zval_ptr_dtor(&iterator->data);
}

static bool orm_pgsql_statement_iterator_call(zend_object_iterator *iterator, const char *method, zval *result)
{
    if (Z_TYPE(iterator->data) != IS_OBJECT) {
        zend_throw_error(NULL, "invalid PostgreSQL statement iterator object");
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_method_with_0_params(Z_OBJ(iterator->data), Z_OBJCE(iterator->data), NULL, method, result);
    return EG(exception) == NULL && !Z_ISUNDEF_P(result);
}

static zend_result orm_pgsql_statement_iterator_cursor_valid(zend_object_iterator *iterator)
{
    zval result;
    if (!orm_pgsql_statement_iterator_call(iterator, "valid", &result)) {
        if (!Z_ISUNDEF(result)) {
            zval_ptr_dtor(&result);
        }
        return FAILURE;
    }
    bool valid = zend_is_true(&result);
    zval_ptr_dtor(&result);
    return valid ? SUCCESS : FAILURE;
}

static zval *orm_pgsql_statement_iterator_cursor_current(zend_object_iterator *iterator)
{
    orm_pgsql_statement_iterator_cursor *cursor = (orm_pgsql_statement_iterator_cursor *) iterator;
    if (!Z_ISUNDEF(cursor->current)) {
        zval_ptr_dtor(&cursor->current);
    }
    if (!orm_pgsql_statement_iterator_call(iterator, "current", &cursor->current)) {
        if (!Z_ISUNDEF(cursor->current)) {
            zval_ptr_dtor(&cursor->current);
            ZVAL_UNDEF(&cursor->current);
        }
        return NULL;
    }
    return &cursor->current;
}

static void orm_pgsql_statement_iterator_cursor_key(zend_object_iterator *iterator, zval *key)
{
    if (!orm_pgsql_statement_iterator_call(iterator, "key", key)) {
        if (!Z_ISUNDEF_P(key)) {
            zval_ptr_dtor(key);
        }
        ZVAL_NULL(key);
    }
}

static void orm_pgsql_statement_iterator_cursor_next(zend_object_iterator *iterator)
{
    zval result;
    if (orm_pgsql_statement_iterator_call(iterator, "next", &result)) {
        zval_ptr_dtor(&result);
    } else if (!Z_ISUNDEF(result)) {
        zval_ptr_dtor(&result);
    }
}

static void orm_pgsql_statement_iterator_cursor_rewind(zend_object_iterator *iterator)
{
    zval result;
    if (orm_pgsql_statement_iterator_call(iterator, "rewind", &result)) {
        zval_ptr_dtor(&result);
    } else if (!Z_ISUNDEF(result)) {
        zval_ptr_dtor(&result);
    }
}

static HashTable *orm_pgsql_statement_iterator_cursor_gc(zend_object_iterator *iterator, zval **table, int *n)
{
    *table = &iterator->data;
    *n = 1;
    return NULL;
}

static const zend_object_iterator_funcs orm_pgsql_statement_iterator_cursor_funcs = {
    orm_pgsql_statement_iterator_cursor_destroy,
    orm_pgsql_statement_iterator_cursor_valid,
    orm_pgsql_statement_iterator_cursor_current,
    orm_pgsql_statement_iterator_cursor_key,
    orm_pgsql_statement_iterator_cursor_next,
    orm_pgsql_statement_iterator_cursor_rewind,
    NULL,
    orm_pgsql_statement_iterator_cursor_gc
};

static zend_object_iterator *orm_pgsql_statement_iterator_get_iterator(zend_class_entry *ce, zval *object, int by_ref)
{
    (void) ce;
    if (by_ref) {
        zend_throw_error(NULL, "An iterator cannot be used with foreach by reference");
        return NULL;
    }
    orm_pgsql_statement_iterator_cursor *cursor = ecalloc(1, sizeof(*cursor));
    zend_iterator_init(&cursor->intern);
    ZVAL_COPY(&cursor->intern.data, object);
    ZVAL_UNDEF(&cursor->current);
    cursor->intern.funcs = &orm_pgsql_statement_iterator_cursor_funcs;
    return &cursor->intern;
}

void orm_pgsql_statement_iterator_init(zend_class_entry *iterator_ce)
{
    orm_pgsql_statement_iterator_ce = iterator_ce;
    orm_pgsql_statement_iterator_ce->create_object = orm_pgsql_statement_iterator_create;
    orm_pgsql_statement_iterator_ce->get_iterator = orm_pgsql_statement_iterator_get_iterator;
    orm_pgsql_statement_iterator_handlers = std_object_handlers;
    orm_pgsql_statement_iterator_handlers.offset = XtOffsetOf(orm_pgsql_statement_iterator_object, std);
    orm_pgsql_statement_iterator_handlers.free_obj = orm_pgsql_statement_iterator_free;
    orm_pgsql_statement_iterator_handlers.get_gc = orm_pgsql_statement_iterator_gc;
    orm_pgsql_statement_iterator_handlers.clone_obj = NULL;
}

int orm_pgsql_statement_iterator(zval *statement, zval *return_value)
{
    if (return_value == NULL || orm_pgsql_statement_iterator_ce == NULL) {
        return FAILURE;
    }
    object_init_ex(return_value, orm_pgsql_statement_iterator_ce);
    if (EG(exception) != NULL) {
        return FAILURE;
    }
    zval arg, result;
    ZVAL_COPY(&arg, statement);
    ZVAL_UNDEF(&result);
    zend_call_method_with_1_params(Z_OBJ_P(return_value), orm_pgsql_statement_iterator_ce, NULL, "__construct", &result, &arg);
    zval_ptr_dtor(&arg);
    if (!Z_ISUNDEF(result)) {
        zval_ptr_dtor(&result);
    }
    return EG(exception) == NULL ? SUCCESS : FAILURE;
}
