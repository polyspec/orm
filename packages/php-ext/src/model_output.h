#ifndef POLYSPEC_ORM_MODEL_OUTPUT_H
#define POLYSPEC_ORM_MODEL_OUTPUT_H
#include "php.h"
ZEND_METHOD(Polyspec_Orm_Model, toArray);
ZEND_METHOD(Polyspec_Orm_Model, toJson);
ZEND_METHOD(Polyspec_Orm_Model, jsonSerialize);
ZEND_METHOD(Polyspec_Orm_Model, jsonText);
ZEND_METHOD(Polyspec_Orm_Model, pairs);
ZEND_METHOD(Polyspec_Orm_Model, columnArrayValue);
ZEND_METHOD(Polyspec_Orm_Model, sixFractionDigits);
ZEND_METHOD(Polyspec_Orm_Model, arrayValue);
ZEND_METHOD(Polyspec_Orm_Model, holdsOrderedJson);
#endif
