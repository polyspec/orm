#ifndef POLYSPEC_ORM_MODEL_NATIVE_METHODS_H
#define POLYSPEC_ORM_MODEL_NATIVE_METHODS_H
#include "php.h"
#include "model_state.h"
#include "model_output.h"
#include "model_query.h"
void model_native_init(zend_class_entry *ce);
bool model_time_value_in_zone(zval *input, zval *zone, zval *ret);
zend_string *model_decimal_normalize(zend_string *input, zend_long precision, zend_long scale);
void model_native_fail(model_state *state, const char *message);
bool model_reject_null_scalar_args(zend_execute_data *execute_data, const char *const *types, uint32_t type_count);
ZEND_METHOD(Polyspec_Orm_Model, connect);
ZEND_METHOD(Polyspec_Orm_Model, __invoke);
ZEND_METHOD(Polyspec_Orm_Model, fail);
ZEND_METHOD(Polyspec_Orm_Model, subject);
ZEND_METHOD(Polyspec_Orm_Model, addItem);
ZEND_METHOD(Polyspec_Orm_Model, negated);
ZEND_METHOD(Polyspec_Orm_Model, connector);
ZEND_METHOD(Polyspec_Orm_Model, addRelation);
ZEND_METHOD(Polyspec_Orm_Model, and);
ZEND_METHOD(Polyspec_Orm_Model, or);
ZEND_METHOD(Polyspec_Orm_Model, not);
ZEND_METHOD(Polyspec_Orm_Model, andNot);
ZEND_METHOD(Polyspec_Orm_Model, orNot);
ZEND_METHOD(Polyspec_Orm_Model, on);
ZEND_METHOD(Polyspec_Orm_Model, relation);
ZEND_METHOD(Polyspec_Orm_Model, relations);
ZEND_METHOD(Polyspec_Orm_Model, limit);
ZEND_METHOD(Polyspec_Orm_Model, orderByRandom);
ZEND_METHOD(Polyspec_Orm_Model, removeAllColumns);
ZEND_METHOD(Polyspec_Orm_Model, addAllColumns);
ZEND_METHOD(Polyspec_Orm_Model, parentNode);
ZEND_METHOD(Polyspec_Orm_Model, groupLimit);
ZEND_METHOD(Polyspec_Orm_Model, expectRevision);
ZEND_METHOD(Polyspec_Orm_Model, deleteLock);
ZEND_METHOD(Polyspec_Orm_Model, fetchKey);
ZEND_METHOD(Polyspec_Orm_Model, fetchValue);
ZEND_METHOD(Polyspec_Orm_Model, forUpdate);
ZEND_METHOD(Polyspec_Orm_Model, forShare);
ZEND_METHOD(Polyspec_Orm_Model, forUpdateNoWait);
ZEND_METHOD(Polyspec_Orm_Model, forShareNoWait);
ZEND_METHOD(Polyspec_Orm_Model, duplication);
ZEND_METHOD(Polyspec_Orm_Model, connection);
ZEND_METHOD(Polyspec_Orm_Model, registerJoins);
ZEND_METHOD(Polyspec_Orm_Model, __clone);
ZEND_METHOD(Polyspec_Orm_Model, readColumn);
ZEND_METHOD(Polyspec_Orm_Model, writeColumn);
#endif
