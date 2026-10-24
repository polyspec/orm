#ifndef POLYSPEC_ORM_OBJECT_ZVAL_PAIR_H
#define POLYSPEC_ORM_OBJECT_ZVAL_PAIR_H

#include "Zend/zend_objects_API.h"

static inline void object_zval_pair_destroy(zval *first, zval *second)
{
    if (!Z_ISUNDEF_P(first)) zval_ptr_dtor(first);
    if (!Z_ISUNDEF_P(second)) zval_ptr_dtor(second);
}

static inline HashTable *object_zval_pair_get_gc(zend_object *object, zval *first, zval **table, int *count)
{
    *table = first;
    *count = 2;
    return zend_std_get_properties(object);
}

#endif
