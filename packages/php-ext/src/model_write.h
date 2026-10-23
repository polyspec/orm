#ifndef POLYSPEC_ORM_MODEL_WRITE_H
#define POLYSPEC_ORM_MODEL_WRITE_H

#include "php.h"

void model_write_init(zend_class_entry *creates_ce, zend_class_entry *restore_ce,
    zend_class_entry *restore_or_create_ce, zend_class_entry *delete_ce);

ZEND_METHOD(Polyspec_Orm_Model, writeRequest);
ZEND_METHOD(Polyspec_Orm_Model, assignIr);
ZEND_METHOD(Polyspec_Orm_Model, encodeValue);
ZEND_METHOD(Polyspec_Orm_Model, create);
ZEND_METHOD(Polyspec_Orm_Model, creates);
ZEND_METHOD(Polyspec_Orm_Model, keyValues);
ZEND_METHOD(Polyspec_Orm_Model, keyWhere);
ZEND_METHOD(Polyspec_Orm_Model, withAesColumns);
ZEND_METHOD(Polyspec_Orm_Model, update);
ZEND_METHOD(Polyspec_Orm_Model, save);
ZEND_METHOD(Polyspec_Orm_Model, delete);
ZEND_METHOD(Polyspec_Orm_Model, deleteRow);
ZEND_METHOD(Polyspec_Orm_Model, restore);
ZEND_METHOD(Polyspec_Orm_Model, restoreOrCreate);
ZEND_METHOD(Polyspec_Orm_Model, restoreStep);
ZEND_METHOD(Polyspec_Orm_Model, restoreKeyValue);

ZEND_METHOD(Polyspec_Orm_ModelCreatesCallback, __invoke);
ZEND_METHOD(Polyspec_Orm_ModelRestoreHook, __invoke);
ZEND_METHOD(Polyspec_Orm_ModelRestoreOrCreateCallback, __invoke);
ZEND_METHOD(Polyspec_Orm_ModelDeleteCallback, __invoke);

#endif
