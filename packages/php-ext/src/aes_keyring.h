#ifndef POLYSPEC_ORM_AES_KEYRING_H
#define POLYSPEC_ORM_AES_KEYRING_H

#include "php.h"

void aes_keyring_set_class(zend_class_entry *ce);
void aes_rotation_status_set_class(zend_class_entry *ce);

#endif
