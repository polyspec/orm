#ifndef POLYSPEC_ORM_MODEL_ASSEMBLY_H
#define POLYSPEC_ORM_MODEL_ASSEMBLY_H

#include "php.h"

extern zend_class_entry *polyspec_frame_ce;
extern zend_class_entry *polyspec_assembly_ce;
extern zend_class_entry *polyspec_group_row_ce;
extern zend_class_entry *polyspec_group_rows_ce;
extern zend_class_entry *polyspec_group_rows_iterator_ce;

void polyspec_model_assembly_register(zend_class_entry *frame_ce, zend_class_entry *assembly_ce,
    zend_class_entry *group_row_ce, zend_class_entry *group_rows_ce, zend_class_entry *group_rows_iterator_ce);

ZEND_METHOD(Polyspec_Orm_Frame, __construct);
ZEND_METHOD(Polyspec_Orm_Frame, add);
ZEND_METHOD(Polyspec_Orm_Frame, path);
ZEND_METHOD(Polyspec_Orm_Frame, joined);
ZEND_METHOD(Polyspec_Orm_Frame, parentOf);
ZEND_METHOD(Polyspec_Orm_Frame, place);
ZEND_METHOD(Polyspec_Orm_Frame, pathOf);

ZEND_METHOD(Polyspec_Orm_Assembly, __construct);
ZEND_METHOD(Polyspec_Orm_Assembly, joinRow);
ZEND_METHOD(Polyspec_Orm_Assembly, relationAssemble);
ZEND_METHOD(Polyspec_Orm_Assembly, related);

ZEND_METHOD(Polyspec_Orm_GroupRow, __construct);
ZEND_METHOD(Polyspec_Orm_GroupRow, count);
ZEND_METHOD(Polyspec_Orm_GroupRow, value);
ZEND_METHOD(Polyspec_Orm_GroupRow, toArray);
ZEND_METHOD(Polyspec_Orm_GroupRow, jsonSerialize);

ZEND_METHOD(Polyspec_Orm_GroupRows, __construct);
ZEND_METHOD(Polyspec_Orm_GroupRows, count);
ZEND_METHOD(Polyspec_Orm_GroupRows, all);
ZEND_METHOD(Polyspec_Orm_GroupRows, getIterator);
ZEND_METHOD(Polyspec_Orm_GroupRows, toArray);
ZEND_METHOD(Polyspec_Orm_GroupRows, jsonSerialize);
ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, current);
ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, key);
ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, next);
ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, rewind);
ZEND_METHOD(Polyspec_Orm_GroupRowsIterator, valid);

#endif
