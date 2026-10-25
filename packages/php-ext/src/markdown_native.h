#ifndef POLYSPEC_ORM_MARKDOWN_NATIVE_H
#define POLYSPEC_ORM_MARKDOWN_NATIVE_H

#include "php.h"

extern zend_class_entry *polyspec_markdown_ce;
extern zend_class_entry *polyspec_markdown_links_ce;
void polyspec_markdown_register(zend_class_entry *markdown_ce, zend_class_entry *markdown_links_ce);

ZEND_METHOD(Polyspec_Orm_Markdown, beginMessage);
ZEND_METHOD(Polyspec_Orm_Markdown, unsupported);
ZEND_METHOD(Polyspec_Orm_Markdown, read);
ZEND_METHOD(Polyspec_Orm_Markdown, scalar);
ZEND_METHOD(Polyspec_Orm_Markdown, write);
ZEND_METHOD(Polyspec_Orm_Markdown, links);

#endif
