/*
 * The codec of Polyspec\Orm\Codec (packages/php/src/Codec.php), implemented in codec.c. Each function leaves its result in ret
 * and returns true, or returns false with a PHP exception set (an OrmException of the code the PHP client gives, or a
 * PHP error the client would also raise).
 */
#ifndef POLYSPEC_ORM_CODEC_H
#define POLYSPEC_ORM_CODEC_H

#include "php.h"

bool codec_decode(HashTable *styles, zval *raw, zval *ret);
bool codec_encode(HashTable *styles, zval *styled, zval *ret);
bool codec_host_encode(zval *v, HashTable *styles, zend_string *aes_key, zval *ret);
bool codec_is_host_style(zend_string *style);
/* Throws CODEC_UNSUPPORTED for a public method the extension does not implement yet; `row` names the item that does. */
bool codec_unsupported(const char *method, const char *row);

#endif
