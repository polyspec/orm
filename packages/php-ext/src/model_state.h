#ifndef POLYSPEC_ORM_MODEL_STATE_H
#define POLYSPEC_ORM_MODEL_STATE_H

#include "php.h"

/* The declared private properties are the canonical state and therefore retain PHP clone/GC/serialization semantics. */
typedef zend_object model_state;

static inline model_state *model_state_of(zend_object *object) { return object; }
zval *model_state_property(model_state *object, const char *field);
void model_state_set_ce(zend_class_entry *ce);
zend_class_entry *model_native_class_entry(void);
void model_state_property_set(model_state *object, const char *field, zval *value);
void model_state_property_separate(model_state *object, const char *field);
void model_state_reset(model_state *object, const char *field);

#endif
