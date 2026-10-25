#ifndef POLYSPEC_ORM_PARAM_CHECK_NATIVE_H
#define POLYSPEC_ORM_PARAM_CHECK_NATIVE_H

#include "php.h"

ZEND_METHOD(Polyspec_Orm_ParamCheck, bindSlotType);
ZEND_METHOD(Polyspec_Orm_ParamCheck, useSlotType);
ZEND_METHOD(Polyspec_Orm_ParamCheck, checkAssign);
ZEND_METHOD(Polyspec_Orm_ParamCheck, check);

#endif
