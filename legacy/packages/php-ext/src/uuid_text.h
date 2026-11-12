#ifndef POLYSPEC_ORM_UUID_TEXT_H
#define POLYSPEC_ORM_UUID_TEXT_H

#include <stdbool.h>
#include <stddef.h>

/* The lower-case canonical text of a uuid and its 16 bytes (DIA-27): the 32 hex digits of the text write the bytes in their
 * order, two digits to a byte, with no field swapped. */

static inline int orm_uuid_hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Writes into out the 36 characters of the lower-case canonical text of the 16 bytes b; out is not terminated. */
static inline void orm_uuid_text(const unsigned char *b, char *out)
{
    static const char digits[] = "0123456789abcdef";
    size_t n = 0;
    for (size_t i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            out[n++] = '-';
        }
        out[n++] = digits[b[i] >> 4];
        out[n++] = digits[b[i] & 15];
    }
}

/* True if the n bytes s are the lower-case canonical text of a uuid, ^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$. */
static inline bool orm_uuid_canonical(const char *s, size_t n)
{
    if (n != 36) {
        return false;
    }
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-') return false;
        } else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) {
            return false;
        }
    }
    return true;
}

/* Writes into out the 16 bytes of the canonical text s of n bytes; false if s is not that text. */
static inline bool orm_uuid_bytes(const char *s, size_t n, unsigned char *out)
{
    if (!orm_uuid_canonical(s, n)) {
        return false;
    }
    size_t k = 0;
    for (size_t i = 0; i < 36; i++) {
        if (s[i] == '-') {
            continue;
        }
        out[k / 2] = (unsigned char)(k % 2 == 0 ? orm_uuid_hex_digit(s[i]) << 4 : out[k / 2] | orm_uuid_hex_digit(s[i]));
        k++;
    }
    return true;
}

#endif
