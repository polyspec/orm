/* Shared RuntimeModel column lookup for the native planner and validator. */
#ifndef POLYSPEC_ORM_RUNTIME_COLUMN_LOOKUP_H
#define POLYSPEC_ORM_RUNTIME_COLUMN_LOOKUP_H

#include "php.h"

typedef zval *(*orm_runtime_column_resolver)(void *context, zval *args);

static inline bool orm_runtime_column_lookup(
    void *context,
    orm_runtime_column_resolver resolve,
    HashTable *entity,
    const char *name,
    HashTable **column
)
{
    zval args[2];
    if (entity != NULL) {
        ZVAL_ARR(&args[0], entity);
    } else {
        ZVAL_NULL(&args[0]);
    }
    ZVAL_STRING(&args[1], name);
    zval *result = resolve(context, args);
    zval_ptr_dtor(&args[1]);
    if (result == NULL) {
        return false;
    }
    *column = Z_TYPE_P(result) == IS_ARRAY ? Z_ARRVAL_P(result) : NULL;
    return true;
}

#endif
