#ifndef POLYSPEC_ORM_PENDING_TIME_PARTS_H
#define POLYSPEC_ORM_PENDING_TIME_PARTS_H

static inline bool pending_time_parts(zend_class_entry *class_entry, zval *value,
    zval *text_rv, zval *zone_rv, zval **text_out, zval **zone_out)
{
    *text_out = zend_read_property(class_entry, Z_OBJ_P(value), "text", sizeof("text") - 1, 1, text_rv);
    *zone_out = zend_read_property(class_entry, Z_OBJ_P(value), "zone", sizeof("zone") - 1, 1, zone_rv);
    if (Z_TYPE_P(*text_out) != IS_STRING || Z_TYPE_P(*zone_out) != IS_OBJECT) {
        zend_throw_error(NULL, "PendingTime has an invalid native value");
        return false;
    }
    return true;
}

#endif
