#ifndef POLYSPEC_ORM_PARENT_SLOT_SQL_H
#define POLYSPEC_ORM_PARENT_SLOT_SQL_H

#include "php.h"
#include "Zend/zend_smart_str.h"

zend_string *expand_numbered_parent_slots(const char *src, size_t len, zend_long parent, zend_long copies, zend_long width);
void orm_append_repeated_placeholders(smart_str *sql, const char *separator, zend_long count, zend_long width,
    bool numbered, zend_long first);

#endif
