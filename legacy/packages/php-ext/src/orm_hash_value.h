#ifndef POLYSPEC_ORM_HASH_VALUE_H
#define POLYSPEC_ORM_HASH_VALUE_H

#include "Zend/zend_hash.h"

static inline zval *orm_hash_value(HashTable *table, const char *key, size_t key_length, bool numeric_string_keys)
{
    if (table == NULL) return NULL;
    zval *value = numeric_string_keys ? zend_symtable_str_find(table, key, key_length)
        : zend_hash_str_find(table, key, key_length);
    if (value == NULL) return NULL;
    ZVAL_DEREF(value);
    return Z_TYPE_P(value) == IS_NULL ? NULL : value;
}

#endif
