#ifndef POLYSPEC_ORM_QUOTED_STRING_LENGTH_H
#define POLYSPEC_ORM_QUOTED_STRING_LENGTH_H

#include "dbspec.h"

/* Length of a single-quoted expression token, including its backtracking fallback. */
static inline size_t dbs_quoted_string_length(str s, size_t i)
{
    size_t j = i + 1;
    ssize_t last_pair = -1;
    for (;;) {
        if (j < s.n && s.s[j] != '\'') {
            j++;
        } else if (j + 1 < s.n && s.s[j] == '\'' && s.s[j + 1] == '\'') {
            last_pair = (ssize_t)j;
            j += 2;
        } else {
            break;
        }
    }
    if (j < s.n) {
        return j + 1 - i;
    }
    if (last_pair >= 0) {
        return (size_t)last_pair + 1 - i;
    }
    return 0;
}

#endif
