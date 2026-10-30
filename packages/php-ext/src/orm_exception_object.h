#ifndef POLYSPEC_ORM_EXCEPTION_OBJECT_H
#define POLYSPEC_ORM_EXCEPTION_OBJECT_H

#include "Zend/zend_interfaces.h"
#include "Zend/zend_exceptions.h"
#include <stdarg.h>

static inline bool orm_exception_object(const char *missing_class_message, const char *code_name,
    zend_string *message, zval *exception)
{
    zend_string *class_name = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *class_entry = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (class_entry == NULL) {
        if (missing_class_message != NULL) zend_throw_error(NULL, "%s", missing_class_message);
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

static inline bool orm_throw_formatted_exception(const char *missing_class_message, const char *code_name,
    const char *format, va_list args)
{
    zend_string *message = zend_vstrpprintf(0, format, args);
    zval exception;
    bool ok = orm_exception_object(missing_class_message, code_name, message, &exception);
    zend_string_release(message);
    if (ok) zend_throw_exception_object(&exception);
    return ok;
}

/* Throws the OrmException of code_name with message; it throws nothing when the class is missing. A failure path of
 * a native method returns the false it returns. */
static inline bool orm_throw_exception(const char *code_name, zend_string *message)
{
    zval exception;
    if (orm_exception_object(NULL, code_name, message, &exception)) zend_throw_exception_object(&exception);
    return false;
}

/* Throws the OrmException of code_name with message, whose previous is the native exception previous when it is not NULL, as
 * the PHP library passes the exception it caught (KSTD-5-94, T292); it takes previous over and releases it when no exception is
 * thrown. A failure path of a native method returns the false it returns. */
static inline bool orm_throw_exception_previous(const char *code_name, zend_string *message, zend_object *previous)
{
    zval exception;
    if (!orm_exception_object(NULL, code_name, message, &exception)) {
        if (previous != NULL) OBJ_RELEASE(previous);
        return false;
    }
    if (previous != NULL) zend_exception_set_previous(Z_OBJ(exception), previous);
    zend_throw_exception_object(&exception);
    return false;
}

#endif
