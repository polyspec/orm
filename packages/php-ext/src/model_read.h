#ifndef POLYSPEC_ORM_MODEL_READ_H
#define POLYSPEC_ORM_MODEL_READ_H
#include "php.h"

ZEND_METHOD(Polyspec_Orm_Model, newRow);
ZEND_METHOD(Polyspec_Orm_Model, rowShape);
ZEND_METHOD(Polyspec_Orm_Model, assembleRow);
ZEND_METHOD(Polyspec_Orm_Model, joinChild);
ZEND_METHOD(Polyspec_Orm_Model, relationChild);
ZEND_METHOD(Polyspec_Orm_Model, collectionKey);
ZEND_METHOD(Polyspec_Orm_Model, assemble);
ZEND_METHOD(Polyspec_Orm_Model, matchValues);
ZEND_METHOD(Polyspec_Orm_Model, matchKey);
ZEND_METHOD(Polyspec_Orm_Model, attachExternal);
ZEND_METHOD(Polyspec_Orm_Model, columnOrExtra);
ZEND_METHOD(Polyspec_Orm_Model, load);
ZEND_METHOD(Polyspec_Orm_Model, get);
ZEND_METHOD(Polyspec_Orm_Model, gets);
ZEND_METHOD(Polyspec_Orm_Model, getsCount);
ZEND_METHOD(Polyspec_Orm_Model, groupValue);
ZEND_METHOD(Polyspec_Orm_Model, groupInteger);
ZEND_METHOD(Polyspec_Orm_Model, groupFloat);
ZEND_METHOD(Polyspec_Orm_Model, getCount);
ZEND_METHOD(Polyspec_Orm_Model, getSum);
ZEND_METHOD(Polyspec_Orm_Model, getAvg);
ZEND_METHOD(Polyspec_Orm_Model, aggregate);
ZEND_METHOD(Polyspec_Orm_Model, aggregateNumber);
ZEND_METHOD(Polyspec_Orm_Model, getsPage);

#endif
