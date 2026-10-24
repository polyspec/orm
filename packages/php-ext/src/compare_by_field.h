#ifndef POLYSPEC_ORM_COMPARE_BY_FIELD_H
#define POLYSPEC_ORM_COMPARE_BY_FIELD_H

#include "dbspec.h"

#define DBS_CMP_BY_FIELD(function_name, type_name, field_name) \
    static int function_name(const void *a, const void *b, void *ctx) \
    { \
        (void)ctx; \
        return str_cmp((*(type_name *const *)a)->field_name, (*(type_name *const *)b)->field_name); \
    }

#endif
