#ifndef POLYSPEC_ORM_MODEL_QUERY_H
#define POLYSPEC_ORM_MODEL_QUERY_H
#include "php.h"
ZEND_METHOD(Polyspec_Orm_Model, executor);
ZEND_METHOD(Polyspec_Orm_Model, manifestHash);
ZEND_METHOD(Polyspec_Orm_Model, build);
ZEND_METHOD(Polyspec_Orm_Model, resultName);
ZEND_METHOD(Polyspec_Orm_Model, revisionGuard);
ZEND_METHOD(Polyspec_Orm_Model, value);
ZEND_METHOD(Polyspec_Orm_Model, resolved);
ZEND_METHOD(Polyspec_Orm_Model, columnValue);
ZEND_METHOD(Polyspec_Orm_Model, putSet);
ZEND_METHOD(Polyspec_Orm_Model, query);
ZEND_METHOD(Polyspec_Orm_Model, relationIr);
ZEND_METHOD(Polyspec_Orm_Model, columnsIr);
ZEND_METHOD(Polyspec_Orm_Model, subqueryIr);
ZEND_METHOD(Polyspec_Orm_Model, groupIr);
ZEND_METHOD(Polyspec_Orm_Model, predIr);
ZEND_METHOD(Polyspec_Orm_Model, getQuery);
ZEND_METHOD(Polyspec_Orm_Model, timeValue);
/* new Frame($model, $outer) in frame; outer is NULL for none. False with an exception. */
bool query_make_frame(zval *model, zval *outer, zval *frame);
#endif
