#ifndef POLYSPEC_PGSQL_LOB_NATIVE_H
#define POLYSPEC_PGSQL_LOB_NATIVE_H

#include "php.h"

/* Wrap an already-open PgSql\Lob in an owned PHP stream resource. */
int orm_pgsql_lob_stream(zval *native_lob, zval *return_value);

#endif
