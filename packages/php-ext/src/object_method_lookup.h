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

/* Calls the method name of object through a [object, name] callable, which applies the visibility and the magic call
 * rules of a userland call; result holds its return value. False when the call fails or leaves an exception. */
static inline bool object_callable_call(zend_object *object, const char *name, zval *result, uint32_t count, zval *args)
{
    zval callable, target;
    array_init_size(&callable, 2);
    ZVAL_OBJ_COPY(&target, object);
    add_next_index_zval(&callable, &target);
    add_next_index_string(&callable, name);
    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(&callable, 0, &fci, &fcc, NULL, NULL) != SUCCESS) {
        zval_ptr_dtor(&callable);
        return false;
    }
    fci.retval = result;
    fci.params = args;
    fci.param_count = count;
    fci.named_params = NULL;
    zend_result status = zend_call_function(&fci, &fcc);
    zval_ptr_dtor(&callable);
    return status == SUCCESS && EG(exception) == NULL;
}

#endif
