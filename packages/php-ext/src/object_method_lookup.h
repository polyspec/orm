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

static inline bool native_model_method_call(zend_class_entry *class_entry, zval *model, const char *name, bool static_call,
    zval *result, uint32_t argc, zval *args)
{
    zend_string *key = zend_string_init(name, strlen(name), 0);
    zend_str_tolower(ZSTR_VAL(key), ZSTR_LEN(key));
    zend_function *function = zend_hash_find_ptr(&class_entry->function_table, key);
    zend_string_release(key);
    if (function == NULL) {
        zend_throw_error(NULL, "Native Model helper %s is not registered", name);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(function, static_call ? NULL : Z_OBJ_P(model),
        Z_OBJCE_P(model), result, argc, args, NULL);
    return EG(exception) == NULL;
}

#endif
