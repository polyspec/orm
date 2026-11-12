#ifndef POLYSPEC_PGSQL_STATEMENT_ITERATOR_NATIVE_H
#define POLYSPEC_PGSQL_STATEMENT_ITERATOR_NATIVE_H

#include "php.h"

void orm_pgsql_statement_iterator_init(zend_class_entry *iterator_ce);
int orm_pgsql_statement_iterator(zval *statement, zval *return_value);

#endif
