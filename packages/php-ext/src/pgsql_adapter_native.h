#ifndef POLYSPEC_PGSQL_ADAPTER_NATIVE_H
#define POLYSPEC_PGSQL_ADAPTER_NATIVE_H

#include "php.h"

void pgsql_adapter_native_register(zend_class_entry *adapter_ce, zend_class_entry *statement_ce);
bool pgsql_adapter_native_is_adapter(zval *value);

#endif
