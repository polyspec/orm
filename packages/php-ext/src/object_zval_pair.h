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

static inline zval *object_array_iterator_current(zval *snapshot, HashPosition *position)
{
    if (Z_ISUNDEF_P(snapshot) || Z_TYPE_P(snapshot) != IS_ARRAY) return NULL;
    return zend_hash_get_current_data_ex(Z_ARRVAL_P(snapshot), position);
}

#endif
