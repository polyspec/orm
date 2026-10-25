#ifndef POLYSPEC_ORM_ENGINE_NATIVE_H
#define POLYSPEC_ORM_ENGINE_NATIVE_H

#include "php.h"

extern zend_class_entry *polyspec_engine_ce;
extern zend_class_entry *polyspec_assemble_ce;
/* Assemble::index on a plan, in place; false with an exception on failure. */
bool assemble_index(zval *plan, zval *model);
void polyspec_engine_register(zend_class_entry *engine_ce, zend_class_entry *assemble_ce);

#endif
