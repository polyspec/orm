#ifndef POLYSPEC_ORM_PARENT_SLOT_SQL_H
#define POLYSPEC_ORM_PARENT_SLOT_SQL_H

#include "php.h"

zend_string *expand_numbered_parent_slots(const char *src, size_t len, zend_long parent, zend_long copies, zend_long width);

#endif
