/*
 * Polyspec\Orm\Planner of the PHP library (packages/php/src/Planner.php), implemented in planner.c. planner_construct stores the
 * RuntimeModel and the Dialect as the properties m and d; planner_compile leaves the plan in ret, or returns false with a PHP
 * exception set: an OrmException of the code the PHP client gives, or a TypeError the client would also raise.
 */
#ifndef POLYSPEC_ORM_PLANNER_H
#define POLYSPEC_ORM_PLANNER_H

#include "php.h"

bool planner_construct(zval *self, zval *model, zval *dialect);
bool planner_compile(zval *self, HashTable *r, zval *ret);

#endif
