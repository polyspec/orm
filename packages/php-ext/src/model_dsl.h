#ifndef POLYSPEC_ORM_MODEL_DSL_H
#define POLYSPEC_ORM_MODEL_DSL_H
#include "php.h"
#include "model_state.h"
ZEND_METHOD(Polyspec_Orm_Model, __call);
ZEND_METHOD(Polyspec_Orm_Model, prefixed);
ZEND_METHOD(Polyspec_Orm_Model, arity);
ZEND_METHOD(Polyspec_Orm_Model, outputName);
ZEND_METHOD(Polyspec_Orm_Model, addColumnCall);
ZEND_METHOD(Polyspec_Orm_Model, addJoin);
ZEND_METHOD(Polyspec_Orm_Model, named);
ZEND_METHOD(Polyspec_Orm_Model, whereChain);
ZEND_METHOD(Polyspec_Orm_Model, predicate);
ZEND_METHOD(Polyspec_Orm_Model, by);
bool model_dsl_where_chain(zval *model, zend_string *conn, zval *keys, zval *args);
#endif
