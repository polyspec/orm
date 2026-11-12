#ifndef POLYSPEC_ORM_COLLECTION_H
#define POLYSPEC_ORM_COLLECTION_H

#include "php.h"

/* Called after generated arginfo registration of Collection and @internal CollectionIterator. */
void collection_init(zend_class_entry *collection_ce, zend_class_entry *iterator_ce,
    zend_class_entry *delete_callback_ce);

ZEND_METHOD(Polyspec_Orm_Collection, put);
ZEND_METHOD(Polyspec_Orm_Collection, keyOf);
ZEND_METHOD(Polyspec_Orm_Collection, identityOf);
ZEND_METHOD(Polyspec_Orm_Collection, get);
ZEND_METHOD(Polyspec_Orm_Collection, has);
ZEND_METHOD(Polyspec_Orm_Collection, first);
ZEND_METHOD(Polyspec_Orm_Collection, keys);
ZEND_METHOD(Polyspec_Orm_Collection, all);
ZEND_METHOD(Polyspec_Orm_Collection, entries);
ZEND_METHOD(Polyspec_Orm_Collection, count);
ZEND_METHOD(Polyspec_Orm_Collection, getIterator);
ZEND_METHOD(Polyspec_Orm_Collection, fetchValues);
ZEND_METHOD(Polyspec_Orm_Collection, fetchedValue);
ZEND_METHOD(Polyspec_Orm_Collection, fetchedValues);
ZEND_METHOD(Polyspec_Orm_Collection, connect);
ZEND_METHOD(Polyspec_Orm_Collection, __invoke);
ZEND_METHOD(Polyspec_Orm_Collection, delete);
ZEND_METHOD(Polyspec_Orm_Collection, toArray);
ZEND_METHOD(Polyspec_Orm_Collection, toJson);
ZEND_METHOD(Polyspec_Orm_Collection, jsonSerialize);
ZEND_METHOD(Polyspec_Orm_CollectionIterator, rewind);
ZEND_METHOD(Polyspec_Orm_CollectionIterator, valid);
ZEND_METHOD(Polyspec_Orm_CollectionIterator, next);
ZEND_METHOD(Polyspec_Orm_CollectionIterator, current);
ZEND_METHOD(Polyspec_Orm_CollectionIterator, key);
ZEND_METHOD(Polyspec_Orm_CollectionDeleteCallback, __invoke);

#endif
