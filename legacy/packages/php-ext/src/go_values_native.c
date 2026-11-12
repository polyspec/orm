#include "go_values_native.h"
#include "dbspec.h"
#include "php_function_call.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "ext/spl/spl_exceptions.h"
#include <stdlib.h>
#include <string.h>

static zend_class_entry *go_bytes_ce;
static zend_class_entry *go_map_ce;

static bool printable_rune(zend_string *rune, bool *printable)
{
    zval function, args[2], result;
    ZVAL_STRING(&function, "preg_match");
    ZVAL_STRING(&args[0], "/^[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}\\x{20}]$/u");
    ZVAL_STR_COPY(&args[1], rune);
    ZVAL_UNDEF(&result);
    int status = call_user_function(NULL, NULL, &function, &result, 2, args);
    zval_ptr_dtor(&function);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (status != SUCCESS || EG(exception) != NULL) {
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        return false;
    }
    *printable = Z_TYPE(result) == IS_LONG && Z_LVAL(result) == 1;
    zval_ptr_dtor(&result);
    return true;
}

/* The byte count of the valid multi-byte UTF-8 character that starts tail, or 0 when its first byte starts none. */
static size_t multibyte_rune_width(str tail)
{
    size_t width = utf8_char_width(tail, 0);
    if (width == 1 || width > tail.n || utf8_valid_prefix((str){tail.s, width}) != width) return 0;
    return width;
}

static void append_byte_escape(smart_str *out, unsigned char byte)
{
    static const char digits[] = "0123456789abcdef";
    smart_str_appendc(out, '\\');
    smart_str_appendc(out, 'x');
    smart_str_appendc(out, digits[byte >> 4]);
    smart_str_appendc(out, digits[byte & 0x0f]);
}

static bool go_quote(zend_string *value, zend_string **quoted)
{
    smart_str out = {0};
    const unsigned char *bytes = (const unsigned char *) ZSTR_VAL(value);
    size_t length = ZSTR_LEN(value);
    smart_str_appendc(&out, '"');
    for (size_t i = 0; i < length;) {
        unsigned char c = bytes[i];
        if (c < 0x80) {
            switch (c) {
                case 0x07: smart_str_appends(&out, "\\a"); break;
                case 0x08: smart_str_appends(&out, "\\b"); break;
                case 0x0c: smart_str_appends(&out, "\\f"); break;
                case 0x0a: smart_str_appends(&out, "\\n"); break;
                case 0x0d: smart_str_appends(&out, "\\r"); break;
                case 0x09: smart_str_appends(&out, "\\t"); break;
                case 0x0b: smart_str_appends(&out, "\\v"); break;
                case 0x5c: smart_str_appends(&out, "\\\\"); break;
                case 0x22: smart_str_appends(&out, "\\\""); break;
                default:
                    if (c < 0x20 || c == 0x7f) append_byte_escape(&out, c);
                    else smart_str_appendc(&out, (char)c);
            }
            i++;
            continue;
        }

        str tail = {(const char *)bytes + i, length - i};
        size_t width = multibyte_rune_width(tail);
        if (width == 0) {
            append_byte_escape(&out, c);
            i++;
            continue;
        }
        zend_string *rune = zend_string_init((const char *)bytes + i, width, 0);
        bool printable = false;
        if (!printable_rune(rune, &printable)) {
            zend_string_release(rune);
            smart_str_free(&out);
            return false;
        }
        if (printable) {
            smart_str_append(&out, rune);
        } else {
            size_t decoded_width = 0;
            uint32_t cp = utf8_decode_at((str){(const char *)bytes + i, width}, 0, &decoded_width);
            if (cp < 0x10000) smart_str_append_printf(&out, "\\u%04x", cp);
            else smart_str_append_printf(&out, "\\U%08x", cp);
        }
        zend_string_release(rune);
        i += width;
    }
    smart_str_appendc(&out, '"');
    smart_str_0(&out);
    *quoted = out.s;
    return true;
}

ZEND_METHOD(Polyspec_Orm_Go, quote)
{
    zend_string *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(value)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *quoted = NULL;
    if (!go_quote(value, &quoted)) RETURN_THROWS();
    RETURN_STR(quoted);
}

static void json_hex4(smart_str *out, uint16_t value)
{
    static const char digits[] = "0123456789abcdef";
    smart_str_appends(out, "\\u");
    smart_str_appendc(out, digits[(value >> 12) & 0x0f]);
    smart_str_appendc(out, digits[(value >> 8) & 0x0f]);
    smart_str_appendc(out, digits[(value >> 4) & 0x0f]);
    smart_str_appendc(out, digits[value & 0x0f]);
}

static void go_json_string(zend_string *value, smart_str *out)
{
    const unsigned char *bytes = (const unsigned char *)ZSTR_VAL(value);
    size_t length = ZSTR_LEN(value);
    smart_str_appendc(out, '"');
    for (size_t i = 0; i < length;) {
        unsigned char c = bytes[i];
        if (c < 0x80) {
            switch (c) {
                case '"': smart_str_appends(out, "\\\""); break;
                case '\\': smart_str_appends(out, "\\\\"); break;
                case '\n': smart_str_appends(out, "\\n"); break;
                case '\r': smart_str_appends(out, "\\r"); break;
                case '\t': smart_str_appends(out, "\\t"); break;
                case '\b': smart_str_appends(out, "\\b"); break;
                case '\f': smart_str_appends(out, "\\f"); break;
                case '<': smart_str_appends(out, "\\u003c"); break;
                case '>': smart_str_appends(out, "\\u003e"); break;
                case '&': smart_str_appends(out, "\\u0026"); break;
                default:
                    if (c < 0x20) json_hex4(out, c);
                    else smart_str_appendc(out, (char)c);
            }
            i++;
            continue;
        }
        /* An invalid UTF-8 byte is the replacement character; a valid character is copied, except the line and
         * paragraph separators, which JSON in a script escapes. */
        const char *rune = (const char *)bytes + i;
        size_t width = multibyte_rune_width((str){rune, length - i});
        size_t decoded_width = 0;
        uint32_t cp = width == 0 ? 0xfffd : utf8_decode_at((str){rune, width}, 0, &decoded_width);
        if (width == 0) smart_str_appends(out, "\\ufffd");
        else if (cp == 0x2028 || cp == 0x2029) json_hex4(out, (uint16_t)cp);
        else smart_str_appendl(out, rune, width);
        i += width == 0 ? 1 : width;
    }
    smart_str_appendc(out, '"');
}

static void append_indent(smart_str *out, zend_string *prefix)
{
    if (prefix != NULL) smart_str_append(out, prefix);
}

static zend_string *nested_prefix(zend_string *prefix, zend_string *indent)
{
    size_t prefix_length = prefix == NULL ? 0 : ZSTR_LEN(prefix);
    size_t indent_length = indent == NULL ? 0 : ZSTR_LEN(indent);
    zend_string *nested = zend_string_alloc(prefix_length + indent_length, 0);
    if (prefix_length != 0) memcpy(ZSTR_VAL(nested), ZSTR_VAL(prefix), prefix_length);
    if (indent_length != 0) memcpy(ZSTR_VAL(nested) + prefix_length, ZSTR_VAL(indent), indent_length);
    ZSTR_VAL(nested)[prefix_length + indent_length] = '\0';
    return nested;
}

static bool json_value(zval *value, zend_string *indent, zend_string *prefix, smart_str *out);

static bool json_list(HashTable *items, zend_string *indent, zend_string *prefix, smart_str *out)
{
    smart_str_appendc(out, '[');
    uint32_t count = zend_hash_num_elements(items);
    if (count == 0) {
        smart_str_appendc(out, ']');
        return true;
    }
    bool pretty = indent != NULL && ZSTR_LEN(indent) != 0;
    zend_string *inner = pretty ? nested_prefix(prefix, indent) : NULL;
    zval *item;
    uint32_t index = 0;
    ZEND_HASH_FOREACH_VAL(items, item) {
        if (index != 0) smart_str_appendc(out, ',');
        if (pretty) {
            smart_str_appendc(out, '\n');
            append_indent(out, inner);
        }
        if (!json_value(item, indent, inner, out)) {
            if (inner != NULL) zend_string_release(inner);
            return false;
        }
        index++;
    } ZEND_HASH_FOREACH_END();
    if (pretty) {
        smart_str_appendc(out, '\n');
        append_indent(out, prefix);
        zend_string_release(inner);
    }
    smart_str_appendc(out, ']');
    return true;
}

typedef struct {
    zend_string *key;
    zval *value;
} go_json_entry;

static int compare_entries(const void *left, const void *right)
{
    const go_json_entry *a = left, *b = right;
    size_t count = ZSTR_LEN(a->key) < ZSTR_LEN(b->key) ? ZSTR_LEN(a->key) : ZSTR_LEN(b->key);
    int order = memcmp(ZSTR_VAL(a->key), ZSTR_VAL(b->key), count);
    if (order != 0) return order;
    if (ZSTR_LEN(a->key) < ZSTR_LEN(b->key)) return -1;
    if (ZSTR_LEN(a->key) > ZSTR_LEN(b->key)) return 1;
    return 0;
}

static zend_string *array_key_string(zend_string *key, zend_ulong index)
{
    return key == NULL ? zend_long_to_str((zend_long)index) : zend_string_copy(key);
}

static bool json_object(zval *container, HashTable *items, bool sorted, zend_string *indent, zend_string *prefix, smart_str *out)
{
    smart_str_appendc(out, '{');
    uint32_t count = zend_hash_num_elements(items);
    if (count == 0) {
        smart_str_appendc(out, '}');
        return true;
    }
    go_json_entry *entries = safe_emalloc(count, sizeof(*entries), 0);
    uint32_t index = 0;
    zend_string *key;
    zend_ulong numeric;
    zval *value;
    ZEND_HASH_FOREACH_KEY_VAL(items, numeric, key, value) {
        entries[index++] = (go_json_entry){array_key_string(key, numeric), value};
    } ZEND_HASH_FOREACH_END();
    if (sorted) qsort(entries, count, sizeof(*entries), compare_entries);
    bool pretty = indent != NULL && ZSTR_LEN(indent) != 0;
    zend_string *inner = pretty ? nested_prefix(prefix, indent) : NULL;
    for (uint32_t i = 0; i < count; i++) {
        if (i != 0) smart_str_appendc(out, ',');
        if (pretty) {
            smart_str_appendc(out, '\n');
            append_indent(out, inner);
        }
        go_json_string(entries[i].key, out);
        smart_str_appendc(out, ':');
        if (pretty) smart_str_appendc(out, ' ');
        if (!json_value(entries[i].value, indent, inner, out)) {
            for (uint32_t j = 0; j < count; j++) zend_string_release(entries[j].key);
            efree(entries);
            if (inner != NULL) zend_string_release(inner);
            return false;
        }
    }
    if (pretty) {
        smart_str_appendc(out, '\n');
        append_indent(out, prefix);
        zend_string_release(inner);
    }
    for (uint32_t i = 0; i < count; i++) zend_string_release(entries[i].key);
    efree(entries);
    smart_str_appendc(out, '}');
    (void)container;
    return true;
}

static bool unsupported_json(zval *value)
{
    zval result;
    if (!php_function_call1("get_debug_type", value, &result)) return false;
    zend_throw_exception_ex(spl_ce_InvalidArgumentException, 0, "unsupported JSON value %s", Z_STRVAL(result));
    zval_ptr_dtor(&result);
    return false;
}

static bool json_value(zval *value, zend_string *indent, zend_string *prefix, smart_str *out)
{
    switch (Z_TYPE_P(value)) {
        case IS_NULL:
            smart_str_appends(out, "null");
            return true;
        case IS_TRUE:
            smart_str_appends(out, "true");
            return true;
        case IS_FALSE:
            smart_str_appends(out, "false");
            return true;
        case IS_LONG:
            smart_str_append_long(out, Z_LVAL_P(value));
            return true;
        case IS_STRING:
            go_json_string(Z_STR_P(value), out);
            return true;
        case IS_ARRAY:
            if (zend_array_is_list(Z_ARRVAL_P(value))) return json_list(Z_ARRVAL_P(value), indent, prefix, out);
            return json_object(value, Z_ARRVAL_P(value), false, indent, prefix, out);
        case IS_OBJECT:
            if (go_map_ce != NULL && instanceof_function(Z_OBJCE_P(value), go_map_ce)) {
                zval rv;
                ZVAL_UNDEF(&rv);
                zval *items = zend_read_property(go_map_ce, Z_OBJ_P(value), "items", sizeof("items") - 1, 1, &rv);
                if (items == NULL || Z_TYPE_P(items) != IS_ARRAY) {
                    if (!Z_ISUNDEF(rv)) zval_ptr_dtor(&rv);
                    return false;
                }
                bool ok = json_object(value, Z_ARRVAL_P(items), true, indent, prefix, out);
                if (items == &rv) zval_ptr_dtor(&rv);
                return ok;
            }
            return unsupported_json(value);
        default:
            return unsupported_json(value);
    }
}

ZEND_METHOD(Polyspec_Orm_Go, json)
{
    zval *value;
    zend_string *indent = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_ZVAL(value)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(indent)
    ZEND_PARSE_PARAMETERS_END();
    if (ZEND_NUM_ARGS() == 1) indent = ZSTR_EMPTY_ALLOC();
    zend_string *prefix = ZSTR_EMPTY_ALLOC();
    smart_str out = {0};
    bool ok = json_value(value, indent, prefix, &out);
    zend_string_release(prefix);
    if (ZEND_NUM_ARGS() == 1) zend_string_release(indent);
    if (!ok) {
        smart_str_free(&out);
        RETURN_THROWS();
    }
    smart_str_0(&out);
    RETURN_STR(out.s);
}

ZEND_METHOD(Polyspec_Orm_GoMap, __construct)
{
    zval *items = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(items)
    ZEND_PARSE_PARAMETERS_END();
    if (items == NULL) {
        zval empty;
        ZVAL_EMPTY_ARRAY(&empty);
        zend_update_property(go_map_ce, Z_OBJ_P(ZEND_THIS), "items", sizeof("items") - 1, &empty);
    } else {
        zend_update_property(go_map_ce, Z_OBJ_P(ZEND_THIS), "items", sizeof("items") - 1, items);
    }
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Bytes, __construct)
{
    zend_string *bytes;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(bytes)
    ZEND_PARSE_PARAMETERS_END();
    zend_update_property_str(go_bytes_ce, Z_OBJ_P(ZEND_THIS), "bytes", sizeof("bytes") - 1, bytes);
    if (EG(exception) != NULL) RETURN_THROWS();
}

void go_values_native_register(zend_class_entry *bytes_ce, zend_class_entry *map_ce)
{
    go_bytes_ce = bytes_ce;
    go_map_ce = map_ce;
    go_bytes_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    go_map_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
}
