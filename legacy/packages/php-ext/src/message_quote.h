#ifndef POLYSPEC_ORM_MESSAGE_QUOTE_H
#define POLYSPEC_ORM_MESSAGE_QUOTE_H

#include "php.h"
#include "zend_smart_str.h"

/* The value of the hexadecimal digit c, or -1. */
static inline int orm_hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* The length of the well-formed UTF-8 sequence at s[i] of a text of n bytes, or 0 when the byte there starts none. */
static inline size_t orm_message_utf8_width(const unsigned char *s, size_t n, size_t i)
{
    unsigned char b = s[i];
#define ORM_CONT(k, lo, hi) (i + (k) < n && s[i + (k)] >= (lo) && s[i + (k)] <= (hi))
    if (b < 0x80) return 1;
    if (b >= 0xc2 && b <= 0xdf) return ORM_CONT(1, 0x80, 0xbf) ? 2 : 0;
    if (b == 0xe0) return ORM_CONT(1, 0xa0, 0xbf) && ORM_CONT(2, 0x80, 0xbf) ? 3 : 0;
    if (b == 0xed) return ORM_CONT(1, 0x80, 0x9f) && ORM_CONT(2, 0x80, 0xbf) ? 3 : 0;
    if (b >= 0xe1 && b <= 0xef) return ORM_CONT(1, 0x80, 0xbf) && ORM_CONT(2, 0x80, 0xbf) ? 3 : 0;
    if (b == 0xf0) return ORM_CONT(1, 0x90, 0xbf) && ORM_CONT(2, 0x80, 0xbf) && ORM_CONT(3, 0x80, 0xbf) ? 4 : 0;
    if (b >= 0xf1 && b <= 0xf3) return ORM_CONT(1, 0x80, 0xbf) && ORM_CONT(2, 0x80, 0xbf) && ORM_CONT(3, 0x80, 0xbf) ? 4 : 0;
    if (b == 0xf4) return ORM_CONT(1, 0x80, 0x8f) && ORM_CONT(2, 0x80, 0xbf) && ORM_CONT(3, 0x80, 0xbf) ? 4 : 0;
#undef ORM_CONT
    return 0;
}

/* The quoting of a name or a text in an error message, which every runtime shares (INT-187, DBS-144): the delimiter, then
 * the delimiter or a backslash after a backslash, BEL, BS, FF, LF, CR, TAB and VT as \a \b \f \n \r \t \v, any other code
 * point below U+0020 and U+007F as \x and two lower-case hex digits, a byte that is not part of UTF-8 as \x and its two
 * lower-case hex digits, and every other code point as it is; then the delimiter. The caller releases the result. */
static inline zend_string *orm_message_quote(const char *text, size_t n, char delim)
{
    static const char digits[] = "0123456789abcdef";
    const unsigned char *s = (const unsigned char *) text;
    smart_str out = {0};
    smart_str_appendc(&out, delim);
    for (size_t i = 0; i < n;) {
        size_t width = orm_message_utf8_width(s, n, i);
        unsigned char c = s[i];
        if (width == 0 || (width == 1 && (c < 0x20 || c == 0x7f) && c != 0x07 && c != 0x08 && c != 0x0c && c != 0x0a && c != 0x0d && c != 0x09 && c != 0x0b)) {
            smart_str_appendc(&out, '\\');
            smart_str_appendc(&out, 'x');
            smart_str_appendc(&out, digits[c >> 4]);
            smart_str_appendc(&out, digits[c & 0x0f]);
            i++;
            continue;
        }
        if (width > 1) {
            smart_str_appendl(&out, text + i, width);
            i += width;
            continue;
        }
        switch (c) {
            case 0x07: smart_str_appends(&out, "\\a"); break;
            case 0x08: smart_str_appends(&out, "\\b"); break;
            case 0x0c: smart_str_appends(&out, "\\f"); break;
            case 0x0a: smart_str_appends(&out, "\\n"); break;
            case 0x0d: smart_str_appends(&out, "\\r"); break;
            case 0x09: smart_str_appends(&out, "\\t"); break;
            case 0x0b: smart_str_appends(&out, "\\v"); break;
            default:
                if (c == (unsigned char) delim || c == '\\') smart_str_appendc(&out, '\\');
                smart_str_appendc(&out, (char) c);
        }
        i++;
    }
    smart_str_appendc(&out, delim);
    return smart_str_extract(&out);
}

#endif
