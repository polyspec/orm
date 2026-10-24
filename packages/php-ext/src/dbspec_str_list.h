#ifndef POLYSPEC_ORM_DBSPEC_STR_LIST_H
#define POLYSPEC_ORM_DBSPEC_STR_LIST_H

static inline bool dbspec_str_in_list(str value, const char *const *values)
{
    for (size_t i = 0; values[i] != NULL; i++) {
        if (str_eqc(value, values[i])) {
            return true;
        }
    }
    return false;
}

#endif
