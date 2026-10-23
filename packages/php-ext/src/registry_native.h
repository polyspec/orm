#ifndef POLYSPEC_REGISTRY_NATIVE_H
#define POLYSPEC_REGISTRY_NATIVE_H
#include "dbspec.h"

extern zend_class_entry *polyspec_registry_ce;
extern zend_class_entry *polyspec_schema_ce;
void polyspec_registry_schema_register(zend_class_entry *registry_ce, zend_class_entry *schema_ce);

#endif
