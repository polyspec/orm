#ifndef POLYSPEC_ORM_MODEL_STATE_H
#define POLYSPEC_ORM_MODEL_STATE_H

#include "php.h"

/* The declared private properties are the canonical state and therefore retain PHP clone/GC/serialization semantics. */
typedef zend_object model_state;

static inline model_state *model_state_of(zend_object *object) { return object; }
static inline void model_state_array_separate(zval *value)
{
    ZVAL_DEREF(value);
    if (Z_TYPE_P(value) != IS_ARRAY) return;
    zend_array *array = Z_ARRVAL_P(value);
    if (GC_FLAGS(array) & IS_ARRAY_IMMUTABLE) {
        ZVAL_ARR(value, zend_array_dup(array));
    } else {
        SEPARATE_ARRAY(value);
    }
}
zval *model_state_property(model_state *object, const char *field);
void model_state_set_ce(zend_class_entry *ce);
zend_class_entry *model_native_class_entry(void);
void model_state_property_set(model_state *object, const char *field, zval *value);
void model_state_property_separate(model_state *object, const char *field);
void model_state_reset(model_state *object, const char *field);

#endif
