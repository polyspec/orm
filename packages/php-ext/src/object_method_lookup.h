#ifndef POLYSPEC_ORM_OBJECT_METHOD_LOOKUP_H
#define POLYSPEC_ORM_OBJECT_METHOD_LOOKUP_H

#include <string.h>

static inline zend_function *object_method_lookup(zend_class_entry *class_entry, const char *name)
{
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *function = NULL;
    for (zend_class_entry *scope = class_entry; scope != NULL && function == NULL; scope = scope->parent) {
        function = zend_hash_find_ptr(&scope->function_table, key);
    }
    zend_string_release(key);
    return function;
}

#endif
