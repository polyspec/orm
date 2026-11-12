#include "parent_slot_sql.h"

void orm_append_repeated_placeholders(smart_str *sql, const char *separator, zend_long count, zend_long width,
    bool numbered, zend_long first)
{
    for (zend_long tuple = 0; tuple < count; tuple++) {
        if (tuple > 0) {
            smart_str_appends(sql, separator);
        }
        for (zend_long part = 0; part < width; part++) {
            if (part > 0) {
                smart_str_appends(sql, ", ");
            }
            if (numbered) {
                smart_str_appendc(sql, '$');
                smart_str_append_long(sql, first + tuple * width + part);
            } else {
                smart_str_appendc(sql, '?');
            }
        }
    }
}

zend_string *expand_numbered_parent_slots(const char *src, size_t len, zend_long parent, zend_long copies, zend_long width)
{
    smart_str out = {0};
    for (size_t p = 0; p < len; p++) {
        if (src[p] != '$' || p + 1 >= len || src[p + 1] < '0' || src[p + 1] > '9') {
            smart_str_appendc(&out, src[p]);
            continue;
        }
        size_t q = p + 1;
        zend_long slot = 0;
        while (q < len && src[q] >= '0' && src[q] <= '9') {
            slot = slot * 10 + (src[q] - '0');
            q++;
        }
        if (slot == parent) {
            orm_append_repeated_placeholders(&out, width == 1 ? ", " : "), (", copies, width, true, slot);
        } else if (slot > parent) {
            smart_str_appendc(&out, '$');
            smart_str_append_long(&out, slot + copies * width - 1);
        } else {
            smart_str_appendl(&out, src + p, q - p);
        }
        p = q - 1;
    }
    smart_str_0(&out);
    return out.s != NULL ? out.s : zend_string_init("", 0, 0);
}
