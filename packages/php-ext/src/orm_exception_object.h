#ifndef POLYSPEC_ORM_EXCEPTION_OBJECT_H
#define POLYSPEC_ORM_EXCEPTION_OBJECT_H

#include "Zend/zend_interfaces.h"

static inline bool orm_exception_object(const char *missing_class_message, const char *code_name,
    zend_string *message, zval *exception)
{
    zend_string *class_name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *class_entry = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (class_entry == NULL) {
        zend_throw_error(NULL, "%s", missing_class_message);
        return false;
    }
    ZVAL_UNDEF(exception);
    object_init_ex(exception, class_entry);
    if (EG(exception) != NULL) {
        if (Z_TYPE_P(exception) != IS_UNDEF) zval_ptr_dtor(exception);
        ZVAL_UNDEF(exception);
        return false;
    }
    zval code, text, result;
    ZVAL_STRING(&code, code_name);
    ZVAL_STR_COPY(&text, message);
    ZVAL_UNDEF(&result);
    zend_call_method_with_2_params(Z_OBJ_P(exception), class_entry, NULL, "__construct", &result, &code, &text);
    zval_ptr_dtor(&code);
    zval_ptr_dtor(&text);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(exception);
        ZVAL_UNDEF(exception);
        return false;
    }
    return true;
}

#endif
