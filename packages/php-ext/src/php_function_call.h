/* A call of a PHP function with one argument from native code, which the value conversions of several files make
 * (KSTD-5-89-22). */
#ifndef POLYSPEC_ORM_PHP_FUNCTION_CALL_H
#define POLYSPEC_ORM_PHP_FUNCTION_CALL_H

#include "php.h"

/* Calls the PHP function name with the argument value. On success result holds its return value, which the caller
 * releases; a failed call or a pending exception releases what it returned and returns false. */
static inline bool php_function_call1(const char *name, zval *value, zval *result)
{
    zval function, argument;
    ZVAL_STRING(&function, name);
    ZVAL_COPY(&argument, value);
    ZVAL_UNDEF(result);
    zend_result status = call_user_function(EG(function_table), NULL, &function, result, 1, &argument);
    zval_ptr_dtor(&function);
    zval_ptr_dtor(&argument);
    if (status != SUCCESS || EG(exception) != NULL) {
        if (!Z_ISUNDEF_P(result)) zval_ptr_dtor(result);
        ZVAL_UNDEF(result);
        return false;
    }
    return true;
}

#endif
