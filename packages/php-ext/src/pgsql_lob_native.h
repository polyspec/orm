#ifndef POLYSPEC_PGSQL_LOB_NATIVE_H
#define POLYSPEC_PGSQL_LOB_NATIVE_H

#include "php.h"

/* Wrap an already-open PgSql\Lob in an owned PHP stream resource. connection and oid are the connection and the large
 * object's oid that lo_put writes through, so the stream's writes are binary-safe on every PHP composer.json allows. */
int orm_pgsql_lob_stream(zval *native_lob, zval *connection, zend_string *oid, zval *return_value);

#endif
