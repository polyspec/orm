#ifndef POLYSPEC_RUNTIME_MODEL_H
#define POLYSPEC_RUNTIME_MODEL_H
#include "dbspec.h"
extern zend_class_entry *polyspec_runtime_model_ce;
/* RuntimeModel::FORMAT, the format of the entities that generated code holds. */
#define POLYSPEC_RUNTIME_MODEL_FORMAT 2
void polyspec_runtime_model_register(zend_class_entry *ce);
void polyspec_runtime_model_from_parsed(zval *out, zend_string *hash, zend_string *text, zval *entities, zend_string *external);

#endif
