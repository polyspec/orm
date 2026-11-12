#ifndef POLYSPEC_ORM_LITERAL_MATCH_H
#define POLYSPEC_ORM_LITERAL_MATCH_H

#include "dbspec.h"

/* Matches a literal at the current scanner offset and advances only on success. */
static inline bool dbs_match_literal(str source, size_t *offset, const char *literal)
{
    if (*offset > source.n) {
        return false;
    }
    str rest = str_sub(source, *offset, source.n - *offset);
    if (!str_starts(rest, literal)) {
        return false;
    }
    *offset += strlen(literal);
    return true;
}

#endif
