#ifndef POLYSPEC_ORM_VALUE_EXPORT_H
#define POLYSPEC_ORM_VALUE_EXPORT_H

#include "dbspec.h"

/* PHP's var_export($value, true) as an arena-backed string. */
static inline str dbs_export_value(zval *value)
{
    zval fn, args[2], ret;
    ZVAL_STRING(&fn, "var_export");
    ZVAL_COPY(&args[0], value);
    ZVAL_TRUE(&args[1]);
    ZVAL_UNDEF(&ret);
    str out = SL("");
    if (call_user_function(NULL, NULL, &fn, &ret, 2, args) == SUCCESS && Z_TYPE(ret) == IS_STRING) {
        out = str_z(Z_STR(ret));
    }
    zval_ptr_dtor(&ret);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&fn);
    return out;
}

#endif
