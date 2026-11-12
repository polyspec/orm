/*
 * Polyspec\Orm\Validator of the PHP library (packages/php/src/Validator.php), implemented in validator.c. Each function leaves its
 * result in ret (or returns the boolean) and returns true, or returns false with a PHP exception set: an OrmException of the code the
 * PHP client gives, or a TypeError the client would also raise.
 */
#ifndef POLYSPEC_ORM_VALIDATOR_H
#define POLYSPEC_ORM_VALIDATOR_H

#include "php.h"

bool validator_construct(zval *self, zval *model);
bool validator_validate(zval *self, HashTable *r);
bool validator_op_allowed(HashTable *col, zend_string *op);
bool validator_restore_key(HashTable *ent, HashTable *r, zval *ret);
bool validator_param_uses(zval *self, HashTable *r, zval *ret);
bool validator_function_type(zend_string *name, HashTable *col, zval *ret);
bool validator_interval_type(zend_string *name, zval *ret);
bool validator_conflict_key(HashTable *ent, HashTable *set, zval *ret);

#endif
