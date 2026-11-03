#ifndef POLYSPEC_RUNTIME_MODEL_H
#define POLYSPEC_RUNTIME_MODEL_H
#include "dbspec.h"
extern zend_class_entry *polyspec_runtime_model_ce;
/* RuntimeModel::FORMAT, the format of the entities that generated code holds. */
#define POLYSPEC_RUNTIME_MODEL_FORMAT 1
void polyspec_runtime_model_register(zend_class_entry *ce);

#endif
