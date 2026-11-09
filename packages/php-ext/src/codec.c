/*
 * Polyspec\Orm\Codec of the PHP library (packages/php/src/Codec.php) in C. The dispatch of the stages, the byte work (gz with
 * libz, base64 strictly as the encoder writes it, the ip packing), the reader of the serialize format, the value checks and the
 * error codes are made here, the same as Codec.php. The parsers and writers that the library itself calls are called through the
 * engine by the same public names: Polyspec\OrderedJson\parse (the ordered-json value), Purr\Yaml (the YAML node model, CoreSchema
 * and the Dumper), and serialize, json_encode, get_object_vars, random_bytes and openssl of PHP's own core. Each refusal is the rule
 * of COD-70 with its code and its one text, the same as Codec.php, and a failure of a library keeps its failure as the previous
 * exception (COD-71).
 */
#include "codec.h"
#include "aes_keyring.h"
#include "ext/json/php_json.h"
#include "ext/spl/spl_exceptions.h"
#include "ext/standard/base64.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_enum.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_strtod.h"
#include <arpa/inet.h>
#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <string.h>
#include <zlib.h>

/* The nesting that the ordered-json parser reads (json-depth of COD-70), Codec::JSON_DEPTH. */
#define JSON_DEPTH 256

#define TEXT_UNICODE "the text is not a sequence of Unicode scalar values"

/* The nesting that every value stage reads and writes, the outermost list or map at level 1 (COD-70), Codec::DEPTH, and the text of
 * its rules after the stage, Codec::DEPTH_RULE. */
#define DEPTH 256
#define DEPTH_RULE "value nesting exceeds 256 levels"

/* ---- engine helpers ---- */

/* The class of a name, loaded by the autoloader. A class that cannot be loaded throws an Error and gives NULL. */
static zend_class_entry *class_named(const char *name)
{
    zend_string *n = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(n);
    zend_string_release(n);
    if (ce == NULL) {
        zend_throw_error(NULL, "class %s is not loaded", name);
    }
    return ce;
}

/* Whether obj is an instance of the class named; false with an exception when that class cannot be loaded. */
static bool is_instance(zval *obj, const char *name, bool *yes)
{
    zend_class_entry *ce = class_named(name);
    if (ce == NULL) {
        return false;
    }
    *yes = Z_TYPE_P(obj) == IS_OBJECT && instanceof_function(Z_OBJCE_P(obj), ce);
    return true;
}

#define IS_A(obj, name, yes)              \
    do {                                  \
        if (!is_instance(obj, name, &yes)) { \
            return false;                 \
        }                                 \
    } while (0)

/* Whether an object is an instance of the class or interface named. A class that is not loaded has no instance, so the lookup
 * loads nothing and throws nothing, and it may run while an exception is pending. */
static bool object_is(zend_object *obj, const char *name)
{
    if (obj == NULL) {
        return false;
    }
    zend_string *n = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class_ex(n, NULL, ZEND_FETCH_CLASS_NO_AUTOLOAD);
    zend_string_release(n);
    return ce != NULL && instanceof_function(obj->ce, ce);
}

/* Whether the pending exception is an instance of the class named. */
static bool exception_is(const char *name)
{
    return object_is(EG(exception), name);
}

/* Whether an exception is a Polyspec\OrderedJson\ParseError of the kind named, the public property kind of the parser. */
static bool parse_error_kind(zend_object *ex, const char *kind)
{
    if (!object_is(ex, "Polyspec\\OrderedJson\\ParseError")) {
        return false;
    }
    zval rv;
    zval *value = zend_read_property(ex->ce, ex, "kind", sizeof("kind") - 1, true, &rv);
    return value != NULL && Z_TYPE_P(value) == IS_STRING && zend_string_equals_cstr(Z_STR_P(value), kind, strlen(kind));
}

/* Releases a string that may be NULL (a style that is not set). */
static void str_free(zend_string *s)
{
    if (s != NULL) {
        zend_string_release(s);
    }
}

/* Returns the message of an exception after its caller has detached it from EG(exception). */
static zend_string *exception_message(zend_object *ex)
{
    zval rv;
    zend_call_method_with_0_params(ex, ex->ce, NULL, "getmessage", &rv);
    zend_string *msg = zval_get_string(&rv);
    zval_ptr_dtor(&rv);
    return msg;
}

/* Runs a callable with the arguments. ret is undefined when the call throws. */
static bool invoke(zval *callable, zval *ret, uint32_t argc, zval *argv)
{
    ZVAL_UNDEF(ret);
    if (call_user_function(NULL, NULL, callable, ret, argc, argv) != SUCCESS) {
        return false;
    }
    return EG(exception) == NULL;
}

static bool call_fn(const char *name, zval *ret, uint32_t argc, zval *argv)
{
    zval cb;
    ZVAL_STRING(&cb, name);
    bool ok = invoke(&cb, ret, argc, argv);
    zval_ptr_dtor(&cb);
    return ok;
}

static bool call_static(const char *cls, const char *method, zval *ret, uint32_t argc, zval *argv)
{
    zval cb;
    array_init(&cb);
    add_next_index_string(&cb, cls);
    add_next_index_string(&cb, method);
    bool ok = invoke(&cb, ret, argc, argv);
    zval_ptr_dtor(&cb);
    return ok;
}

static bool call_method(zval *obj, const char *method, zval *ret, uint32_t argc, zval *argv)
{
    zval cb, self;
    ZVAL_COPY(&self, obj);
    array_init(&cb);
    add_next_index_zval(&cb, &self);
    add_next_index_string(&cb, method);
    bool ok = invoke(&cb, ret, argc, argv);
    zval_ptr_dtor(&cb);
    return ok;
}

static zval *read_prop(zval *obj, const char *name, zval *rv)
{
    return zend_read_property(Z_OBJCE_P(obj), Z_OBJ_P(obj), name, strlen(name), true, rv);
}

/* A new object of the class, built as `new` builds it: its constructor runs with no arguments. */
static bool new_object(zval *obj, zend_class_entry *ce)
{
    object_init_ex(obj, ce);
    if (ce->constructor == NULL) {
        return true;
    }
    zval rv;
    zend_call_method(Z_OBJ_P(obj), ce, NULL, ZEND_STRL("__construct"), &rv, 0, NULL, NULL);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(obj);
        return false;
    }
    return true;
}

/* Throws an OrmException with the code, message and optional previous exception; it takes ownership of both. */
static bool orm_fail_previous(const char *code, zend_string *msg, zend_object *previous)
{
    zend_class_entry *ce = class_named("Polyspec\\Orm\\OrmException");
    if (ce == NULL) {
        zend_string_release(msg);
        if (previous != NULL) {
            OBJ_RELEASE(previous);
        }
        return false;
    }
    zval ex, args[3], rv;
    object_init_ex(&ex, ce);
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], msg);
    uint32_t argc = 2;
    if (previous != NULL) {
        ZVAL_OBJ(&args[2], previous);
        argc = 3;
    }
    ZVAL_UNDEF(&rv);
    zend_call_known_function(ce->constructor, Z_OBJ(ex), ce, &rv, argc, args, NULL);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (previous != NULL) {
        zval_ptr_dtor(&args[2]);
    }
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&ex);
        return false;
    }
    zend_throw_exception_object(&ex);
    return false;
}

static bool orm_fail(const char *code, zend_string *msg)
{
    return orm_fail_previous(code, msg, NULL);
}

static zend_object *take_exception(void)
{
    zend_object *previous = EG(exception);
    EG(exception) = NULL;
    return previous;
}

static bool orm_failf(const char *code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    return orm_fail(code, msg);
}

static bool orm_failf_previous(const char *code, zend_object *previous, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    return orm_fail_previous(code, msg, previous);
}

/* The cause of a library call that reported its failure only by its result (COD-71): a RuntimeException that holds what the
 * library reports, as Codec::libraryCall. It is not thrown; the caller gives it to the error of its rule. */
static zend_object *library_cause(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    zend_throw_exception(spl_ce_RuntimeException, ZSTR_VAL(msg), 0);
    zend_string_release(msg);
    return take_exception();
}

/* The style at index i of a list, as a new string, or NULL when it is not set. */
static zend_string *style_at(HashTable *styles, zend_long i)
{
    zval *z = zend_hash_index_find(styles, (zend_ulong)i);
    return z != NULL ? zval_get_string(z) : NULL;
}

static bool streq(zend_string *s, const char *lit)
{
    return s != NULL && zend_string_equals_cstr(s, lit, strlen(lit));
}

static bool need_string(zval *v, const char *fn)
{
    if (Z_TYPE_P(v) == IS_STRING) {
        return true;
    }
    zend_type_error("%s(): Argument must be of type string, %s given", fn, zend_zval_type_name(v));
    return false;
}

/* ---- gz and the UTF-8 check ---- */

/* gzuncompress: the zlib stream of in, or NULL with the message of zlib when it is not one. */
static zend_string *gz_inflate(zend_string *in, const char **message)
{
    z_stream zs;
    memset(&zs, 0, sizeof zs);
    int r = inflateInit(&zs);
    if (r != Z_OK) {
        *message = zs.msg != NULL ? zs.msg : zError(r);
        return NULL;
    }
    size_t cap = ZSTR_LEN(in) * 4 + 256, produced = 0;
    zend_string *out = zend_string_alloc(cap, 0);
    zs.next_in = (Bytef *)ZSTR_VAL(in);
    zs.avail_in = (uInt)ZSTR_LEN(in);
    for (;;) {
        zs.next_out = (Bytef *)ZSTR_VAL(out) + produced;
        zs.avail_out = (uInt)(cap - produced);
        r = inflate(&zs, Z_NO_FLUSH);
        produced = cap - zs.avail_out;
        if (r == Z_STREAM_END) {
            break;
        }
        if (r == Z_OK && zs.avail_out == 0) {
            cap *= 2;
            out = zend_string_extend(out, cap, 0);
            continue;
        }
        /* A stream that ends before its end is Z_BUF_ERROR or Z_OK with input left: zlib names it a data error. */
        *message = zs.msg != NULL ? zs.msg : zError(r == Z_OK || r == Z_BUF_ERROR ? Z_DATA_ERROR : r);
        inflateEnd(&zs);
        zend_string_release(out);
        return NULL;
    }
    inflateEnd(&zs);
    ZSTR_LEN(out) = produced;
    ZSTR_VAL(out)[produced] = '\0';
    return out;
}

/* gzcompress($data, 9): a zlib stream with the memory level of php_zlib_encode (MAX_MEM_LEVEL), or NULL with the message of zlib. */
static zend_string *gz_deflate(zend_string *in, const char **message)
{
    z_stream zs;
    memset(&zs, 0, sizeof zs);
    int r = deflateInit2(&zs, 9, Z_DEFLATED, MAX_WBITS, MAX_MEM_LEVEL, Z_DEFAULT_STRATEGY);
    if (r != Z_OK) {
        *message = zs.msg != NULL ? zs.msg : zError(r);
        return NULL;
    }
    uLong bound = deflateBound(&zs, (uLong)ZSTR_LEN(in));
    zend_string *out = zend_string_alloc(bound, 0);
    zs.next_in = (Bytef *)ZSTR_VAL(in);
    zs.avail_in = (uInt)ZSTR_LEN(in);
    zs.next_out = (Bytef *)ZSTR_VAL(out);
    zs.avail_out = (uInt)bound;
    r = deflate(&zs, Z_FINISH);
    size_t produced = bound - zs.avail_out;
    if (r != Z_STREAM_END) {
        *message = zs.msg != NULL ? zs.msg : zError(r);
        deflateEnd(&zs);
        zend_string_release(out);
        return NULL;
    }
    deflateEnd(&zs);
    ZSTR_LEN(out) = produced;
    ZSTR_VAL(out)[produced] = '\0';
    return out;
}

/* mb_check_encoding($s, 'UTF-8') of Codec.php: whether the bytes are valid UTF-8 (no overlong form, no surrogate, nothing above
 * U+10FFFF), which is a sequence of Unicode scalar values. */
static bool valid_utf8(const unsigned char *s, size_t n)
{
    size_t i = 0;
    while (i < n) {
        unsigned char c = s[i];
        size_t len;
        unsigned long cp;
        if (c < 0x80) {
            i++;
            continue;
        } else if (c >= 0xC2 && c <= 0xDF) {
            len = 2;
            cp = c & 0x1F;
        } else if (c >= 0xE0 && c <= 0xEF) {
            len = 3;
            cp = c & 0x0F;
        } else if (c >= 0xF0 && c <= 0xF4) {
            len = 4;
            cp = c & 0x07;
        } else {
            return false;
        }
        if (i + len > n) {
            return false;
        }
        for (size_t k = 1; k < len; k++) {
            if ((s[i + k] & 0xC0) != 0x80) {
                return false;
            }
            cp = (cp << 6) | (s[i + k] & 0x3F);
        }
        if ((len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF))) {
            return false;
        }
        i += len;
    }
    return true;
}

bool codec_valid_utf8(const char *s, size_t n)
{
    return valid_utf8((const unsigned char *)s, n);
}

static bool str_utf8(zend_string *s)
{
    return valid_utf8((const unsigned char *)ZSTR_VAL(s), ZSTR_LEN(s));
}

/* ---- the common value model ---- */

/* Codec::codecValueRule: the rule of COD-70 that a value under a first serialize or yaml stage breaks, or NULL for a value of the
 * common value model of COD-16: the first node that breaks one, keys before their values, and a list or a map past the 256 levels at
 * its start, depth being the level of its container (serialize-depth-write, yaml-depth-write). */
static const char *codec_value_rule(zval *v, zend_long depth)
{
    ZVAL_DEREF(v);
    switch (Z_TYPE_P(v)) {
        case IS_NULL:
        case IS_FALSE:
        case IS_TRUE:
        case IS_LONG:
            return NULL;
        case IS_STRING:
            return str_utf8(Z_STR_P(v)) ? NULL : TEXT_UNICODE;
        case IS_DOUBLE:
            return zend_finite(Z_DVAL_P(v)) ? NULL : "number is not finite";
        case IS_ARRAY: {
            if (depth + 1 > DEPTH) {
                return DEPTH_RULE;
            }
            zend_string *key;
            zval *item;
            ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(v), key, item)
            {
                if (key != NULL && !str_utf8(key)) {
                    return TEXT_UNICODE;
                }
                const char *rule = codec_value_rule(item, depth + 1);
                if (rule != NULL) {
                    return rule;
                }
            }
            ZEND_HASH_FOREACH_END();
            return NULL;
        }
        case IS_OBJECT:
            if (object_is(Z_OBJ_P(v), "Polyspec\\OrderedJson\\Value")) {
                return "an ordered-json value is written only by the ordered_json stage";
            }
            return "the value is not a codec value";
        default:
            return "the value is not a codec value";
    }
}

/* Codec::checkCodecValue: a value under the first stage is refused by the rule it breaks, prefixed by the stage. */
static bool check_codec_value(const char *stage, zval *v)
{
    const char *rule = codec_value_rule(v, 0);
    return rule == NULL || orm_failf("CODEC_ENCODE", "%s: %s", stage, rule);
}

/* ---- YAML: the node model of purr, its core schema and its Dumper ---- */

static bool yaml_rule(const char *rule)
{
    return orm_failf("CODEC_DECODE", "yaml: %s", rule);
}

/* Codec.php yamlIntegerInRange: an integer of the core schema outside i64 is not a value of the common value model (COD-16); the
 * reader turns a decimal one into a float and wraps an octal or hexadecimal one, so the plain text is checked here. */
static bool yaml_integer_in_range(zval *node)
{
    zval style, value;
    if (!call_method(node, "getStyle", &style, 0, NULL)) {
        return false;
    }
    bool plain = Z_TYPE(style) == IS_OBJECT && zend_string_equals_literal(Z_STR_P(zend_enum_fetch_case_name(Z_OBJ(style))), "Plain");
    zval_ptr_dtor(&style);
    if (!plain) {
        return true;
    }
    if (!call_method(node, "getValue", &value, 0, NULL)) {
        return false;
    }
    const char *s = Z_STRVAL(value);
    size_t n = Z_STRLEN(value), i = 0, digits;
    bool in_range = true, integer = false;
    if (n > 2 && s[0] == '0' && (s[1] == 'o' || s[1] == 'x')) {
        bool hex = s[1] == 'x';
        for (i = 2; i < n && (hex ? isxdigit((unsigned char)s[i]) : (s[i] >= '0' && s[i] <= '7')); i++) {
        }
        if (i == n) {
            integer = true;
            for (i = 2; i + 1 < n && s[i] == '0'; i++) {
            }
            digits = n - i;
            /* 2^63 - 1 is 21 octal digits, all 7, and 7fffffffffffffff. */
            in_range = hex ? digits < 16 || (digits == 16 && s[i] >= '0' && s[i] <= '7') : digits <= 21;
        }
    } else {
        size_t start = n > 0 && (s[0] == '+' || s[0] == '-') ? 1 : 0;
        for (i = start; i < n && s[i] >= '0' && s[i] <= '9'; i++) {
        }
        if (i == n && n > start) {
            integer = true;
            for (i = start; i + 1 < n && s[i] == '0'; i++) {
            }
            digits = n - i;
            const char *max = s[0] == '-' ? "9223372036854775808" : "9223372036854775807";
            in_range = digits < 19 || (digits == 19 && memcmp(s + i, max, 19) <= 0);
        }
    }
    zval_ptr_dtor(&value);
    return !integer || in_range || yaml_rule("integer is outside the i64 range");
}

/* Codec::yamlProperties: the properties of a node that the codec refuses, an alias, an anchor and an explicit tag, in that order. */
static bool yaml_properties(zval *node)
{
    bool yes;
    IS_A(node, "Purr\\Yaml\\Node\\AliasNode", yes);
    if (yes) {
        return yaml_rule("aliases are not supported");
    }
    zval rv;
    if (!call_method(node, "hasAnchor", &rv, 0, NULL)) {
        return false;
    }
    bool anchored = Z_TYPE(rv) == IS_TRUE;
    zval_ptr_dtor(&rv);
    if (anchored) {
        return yaml_rule("anchors are not supported");
    }
    if (!call_method(node, "findTag", &rv, 0, NULL)) {
        return false;
    }
    bool tagged = Z_TYPE(rv) != IS_NULL;
    zval_ptr_dtor(&rv);
    return !tagged || yaml_rule("explicit tags are not supported");
}

/* The items of a purr list (a NodeList or a MappingEntryList) as a PHP list, as iterator_to_array($list, false). */
static bool yaml_items(zval *node, const char *method, zval *items)
{
    zval list;
    if (!call_method(node, method, &list, 0, NULL)) {
        return false;
    }
    zval args[2];
    ZVAL_COPY_VALUE(&args[0], &list);
    ZVAL_FALSE(&args[1]);
    bool ok = call_fn("iterator_to_array", items, 2, args);
    zval_ptr_dtor(&list);
    return ok;
}

/* Codec::yamlDepth: a sequence or a mapping inside a container at level depth past the 256 levels is yaml-depth. */
static bool yaml_depth(zend_long depth)
{
    return depth + 1 <= DEPTH || yaml_rule(DEPTH_RULE);
}

/* Codec.php yamlNode: a purr node as a PHP value, with the rules of the codec. The node model of purrphp/yaml has four kinds (its
 * NodeVisitor): an alias, which yaml_properties refuses, a scalar, a sequence and a mapping, which is the last; a node of another
 * kind has no getEntries, and the failure of that call is yaml-parse (COD-72). A node is met where it starts (COD-70): its
 * properties, then the nesting rule of its level, depth being the level of its container, then its own rules, and a key before its
 * value. */
static bool yaml_node(zval *node, zval *schema, zval *out, zend_long depth)
{
    bool yes;
    if (!yaml_properties(node)) {
        return false;
    }

    IS_A(node, "Purr\\Yaml\\Node\\ScalarNode", yes);
    if (yes) {
        if (!yaml_integer_in_range(node)) {
            return false;
        }
        zval arg;
        ZVAL_COPY(&arg, node);
        bool ok = call_method(schema, "resolve", out, 1, &arg);
        zval_ptr_dtor(&arg);
        if (!ok) {
            return false;
        }
        /* A float beyond the f64 range is read as INF, so the rule covers it with .inf and .nan (COD-16). */
        if (Z_TYPE_P(out) == IS_DOUBLE && !zend_finite(Z_DVAL_P(out))) {
            zval_ptr_dtor(out);
            return yaml_rule("number is not finite");
        }
        return true;
    }

    if (!yaml_depth(depth)) {
        return false;
    }
    IS_A(node, "Purr\\Yaml\\Node\\SequenceNode", yes);
    if (yes) {
        zval items;
        if (!yaml_items(node, "getItems", &items)) {
            return false;
        }
        array_init(out);
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(items), item)
        {
            zval val;
            if (!yaml_node(item, schema, &val, depth + 1)) {
                zval_ptr_dtor(&items);
                zval_ptr_dtor(out);
                return false;
            }
            zend_hash_next_index_insert(Z_ARRVAL_P(out), &val);
        }
        ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&items);
        return true;
    }

    zval entries;
    if (!yaml_items(node, "getEntries", &entries)) {
        return false;
    }
    array_init(out);
    zval *entry;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(entries), entry)
    {
        /* << is an ordinary key: YAML 1.2 has no merge key (COD-29). */
        zval keynode, key, valnode, val;
        bool sequence, mapping;
        if (!call_method(entry, "getKey", &keynode, 0, NULL)) {
            goto fail;
        }
        if (!is_instance(&keynode, "Purr\\Yaml\\Node\\SequenceNode", &sequence)
            || !is_instance(&keynode, "Purr\\Yaml\\Node\\MappingNode", &mapping)) {
            zval_ptr_dtor(&keynode);
            goto fail;
        }
        if (sequence || mapping) {
            if (yaml_properties(&keynode) && yaml_depth(depth + 1)) {
                (void)yaml_rule("map keys must be scalar strings");
            }
            zval_ptr_dtor(&keynode);
            goto fail;
        }
        bool read = yaml_node(&keynode, schema, &key, depth + 1);
        zval_ptr_dtor(&keynode);
        if (!read) {
            goto fail;
        }
        if (Z_TYPE(key) != IS_STRING && Z_TYPE(key) != IS_LONG) {
            zval_ptr_dtor(&key);
            (void)yaml_rule("map keys must be strings or integers");
            goto fail;
        }
        zval *exists = Z_TYPE(key) == IS_STRING ? zend_symtable_find(Z_ARRVAL_P(out), Z_STR(key))
                                                : zend_hash_index_find(Z_ARRVAL_P(out), (zend_ulong)Z_LVAL(key));
        if (exists != NULL) {
            zval_ptr_dtor(&key);
            (void)yaml_rule("duplicate map key");
            goto fail;
        }
        if (!call_method(entry, "getValue", &valnode, 0, NULL)) {
            zval_ptr_dtor(&key);
            goto fail;
        }
        read = yaml_node(&valnode, schema, &val, depth + 1);
        zval_ptr_dtor(&valnode);
        if (!read) {
            zval_ptr_dtor(&key);
            goto fail;
        }
        if (Z_TYPE(key) == IS_STRING) {
            zend_symtable_update(Z_ARRVAL_P(out), Z_STR(key), &val);
        } else {
            zend_hash_index_update(Z_ARRVAL_P(out), (zend_ulong)Z_LVAL(key), &val);
        }
        zval_ptr_dtor(&key);
        continue;
    fail:
        zval_ptr_dtor(&entries);
        zval_ptr_dtor(out);
        return false;
    }
    ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&entries);
    return true;
}

/* Whether a character may appear in a YAML stream (YAML 1.2.2, 5.1, c-printable), as Codec::yamlStream. A byte order mark is
 * the encoding mark at the start of the stream (5.2) and never content. */
static bool yaml_printable(unsigned long cp)
{
    if (cp == '\t' || cp == '\n' || cp == '\r' || (cp >= 0x20 && cp <= 0x7E) || cp == 0x85) return true;
    if (cp == 0xFEFF) return false;
    return (cp >= 0xA0 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

/* The stream rules of YAML 1.2 that the reader does not apply, as Codec::yamlStream: the stream is UTF-8, a byte order mark
 * may start it and appears nowhere else, and every character is printable. */
static bool yaml_stream(zend_string *text)
{
    const unsigned char *s = (const unsigned char *)ZSTR_VAL(text);
    size_t n = ZSTR_LEN(text), i = 0;
    if (!valid_utf8(s, n)) {
        return yaml_rule("the stream is not UTF-8");
    }
    if (n >= 3 && s[0] == 0xEF && s[1] == 0xBB && s[2] == 0xBF) i = 3;
    while (i < n) {
        size_t len = s[i] < 0x80 ? 1 : s[i] < 0xE0 ? 2 : s[i] < 0xF0 ? 3 : 4;
        unsigned long cp = len == 1 ? s[i] : len == 2 ? s[i] & 0x1F : len == 3 ? s[i] & 0x0F : s[i] & 0x07;
        for (size_t k = 1; k < len; k++) cp = (cp << 6) | (s[i + k] & 0x3F);
        i += len;
        if (!yaml_printable(cp)) {
            return yaml_rule("the stream holds a character that is not printable");
        }
    }
    return true;
}

/* The read of yamlDecode: one YAML document, read by purr and resolved by its core schema. A rule is a pending OrmException, and
 * a failure of the library is its own pending exception. */
static bool yaml_read(zend_string *text, zval *out)
{
    if (!yaml_stream(text)) {
        return false;
    }
    zend_class_entry *stream_ce = class_named("Purr\\Yaml\\YamlStream");
    zend_class_entry *schema_ce = stream_ce != NULL ? class_named("Purr\\Yaml\\Schema\\CoreSchema") : NULL;
    if (schema_ce == NULL) {
        return false;
    }
    zval stream, docs, arg, count, doc, root, schema;
    if (!new_object(&stream, stream_ce)) {
        return false;
    }
    ZVAL_STR_COPY(&arg, text);
    bool ok = call_method(&stream, "fromString", &docs, 1, &arg);
    zval_ptr_dtor(&arg);
    zval_ptr_dtor(&stream);
    if (!ok) {
        return false;
    }
    ok = call_fn("count", &count, 1, &docs);
    zend_long n = ok ? zval_get_long(&count) : 0;
    if (!ok) {
        zval_ptr_dtor(&docs);
        return false;
    }
    if (n == 0 || n > 1) {
        zval_ptr_dtor(&docs);
        return yaml_rule(n == 0 ? "no document" : "multiple documents are not supported");
    }
    zval index;
    ZVAL_LONG(&index, 0);
    ok = call_method(&docs, "at", &doc, 1, &index);
    zval_ptr_dtor(&docs);
    if (!ok) {
        return false;
    }
    ok = call_method(&doc, "getRoot", &root, 0, NULL);
    zval_ptr_dtor(&doc);
    if (!ok) {
        return false;
    }
    if (!new_object(&schema, schema_ce)) {
        zval_ptr_dtor(&root);
        return false;
    }
    ok = yaml_node(&root, &schema, out, 0);
    zval_ptr_dtor(&root);
    zval_ptr_dtor(&schema);
    return ok;
}

/* Codec::yamlDecode: the read, whose rules pass as they are; the parser resolves an alias as it reads it and refuses one whose
 * anchor is not in the stream with a ReferenceException, which is yaml-alias, and any other failure of the library is yaml-parse,
 * with the failure as the previous exception (COD-71). */
static bool yaml_decode(zend_string *text, zval *out)
{
    if (yaml_read(text, out)) {
        return true;
    }
    if (EG(exception) == NULL || exception_is("Polyspec\\Orm\\OrmException")) {
        return false;
    }
    bool alias = exception_is("Purr\\Yaml\\Exception\\ReferenceException");
    zend_object *cause = take_exception();
    return orm_failf_previous("CODEC_DECODE", cause, "yaml: %s", alias ? "aliases are not supported" : "the stream does not parse");
}

/* A new object of the class, built as `new` builds it with the arguments; it takes no ownership of them. */
static bool new_with(zval *obj, const char *cls, uint32_t argc, zval *argv)
{
    zend_class_entry *ce = class_named(cls);
    if (ce == NULL) {
        return false;
    }
    object_init_ex(obj, ce);
    zend_call_known_instance_method(ce->constructor, Z_OBJ_P(obj), NULL, argc, argv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(obj);
        return false;
    }
    return true;
}

/* A case of an enum of purrphp/yaml, such as ScalarStyle::DoubleQuoted. */
static bool enum_case(zval *out, const char *cls, const char *name)
{
    zend_class_entry *ce = class_named(cls);
    if (ce == NULL) {
        return false;
    }
    ZVAL_OBJ_COPY(out, zend_enum_get_case_cstr(ce, name));
    return true;
}

/* new ScalarNode($text) or, with quoted, new ScalarNode($text, ScalarStyle::DoubleQuoted); it takes ownership of text. */
static bool yaml_scalar(zend_string *text, bool quoted, zval *out)
{
    zval args[2];
    ZVAL_STR(&args[0], text);
    uint32_t argc = 1;
    if (quoted) {
        if (!enum_case(&args[1], "Purr\\Yaml\\Node\\ScalarStyle", "DoubleQuoted")) {
            zval_ptr_dtor(&args[0]);
            return false;
        }
        argc = 2;
    }
    bool ok = new_with(out, "Purr\\Yaml\\Node\\ScalarNode", argc, args);
    for (uint32_t i = 0; i < argc; i++) {
        zval_ptr_dtor(&args[i]);
    }
    return ok;
}

/* yamlNodeOf of Codec.php: the YAML node of a common value, its strings and keys double-quoted and a float by its shortest
 * text with its fraction. The value is one that codec_value_rule passed, so an array is the last kind. */
static bool yaml_node_of(zval *v, zval *out)
{
    ZVAL_DEREF(v);
    switch (Z_TYPE_P(v)) {
        case IS_NULL:
            return yaml_scalar(zend_string_init(ZEND_STRL("null"), 0), false, out);
        case IS_TRUE:
            return yaml_scalar(zend_string_init(ZEND_STRL("true"), 0), false, out);
        case IS_FALSE:
            return yaml_scalar(zend_string_init(ZEND_STRL("false"), 0), false, out);
        case IS_LONG:
            return yaml_scalar(zend_long_to_str(Z_LVAL_P(v)), false, out);
        case IS_DOUBLE: {
            zval args[2], text;
            ZVAL_COPY(&args[0], v);
            ZVAL_LONG(&args[1], PHP_JSON_PRESERVE_ZERO_FRACTION | PHP_JSON_THROW_ON_ERROR);
            bool ok = call_fn("json_encode", &text, 2, args);
            zval_ptr_dtor(&args[0]);
            return ok && yaml_scalar(Z_STR(text), false, out);
        }
        case IS_STRING:
            return yaml_scalar(zend_string_copy(Z_STR_P(v)), true, out);
        default:
            break;
    }
    ZEND_ASSERT(Z_TYPE_P(v) == IS_ARRAY);
    HashTable *ht = Z_ARRVAL_P(v);
    uint32_t n = zend_hash_num_elements(ht), i = 0;
    bool list = zend_array_is_list(ht);
    zval *items = n > 0 ? safe_emalloc(n, sizeof(zval), 0) : NULL;
    bool ok = true;
    zend_string *key;
    zend_ulong idx;
    zval *item;
    ZEND_HASH_FOREACH_KEY_VAL(ht, idx, key, item)
    {
        zval node;
        if (!yaml_node_of(item, &node)) {
            ok = false;
            break;
        }
        if (list) {
            ZVAL_COPY_VALUE(&items[i++], &node);
            continue;
        }
        zval pair[2];
        ZVAL_COPY_VALUE(&pair[1], &node);
        if (!yaml_scalar(key != NULL ? zend_string_copy(key) : zend_long_to_str((zend_long)idx), true, &pair[0])) {
            zval_ptr_dtor(&pair[1]);
            ok = false;
            break;
        }
        ok = new_with(&items[i], "Purr\\Yaml\\Node\\MappingEntry", 2, pair);
        zval_ptr_dtor(&pair[0]);
        zval_ptr_dtor(&pair[1]);
        if (!ok) {
            break;
        }
        i++;
    }
    ZEND_HASH_FOREACH_END();
    zval collection, args[2];
    uint32_t argc = 1;
    if (ok) {
        ok = new_with(&collection, list ? "Purr\\Yaml\\Node\\NodeList" : "Purr\\Yaml\\Node\\MappingEntryList", i, items);
    }
    for (uint32_t k = 0; k < i; k++) {
        zval_ptr_dtor(&items[k]);
    }
    if (items != NULL) {
        efree(items);
    }
    if (!ok) {
        return false;
    }
    ZVAL_COPY_VALUE(&args[0], &collection);
    if (n == 0) {
        if (!enum_case(&args[1], "Purr\\Yaml\\Node\\CollectionStyle", "Flow")) {
            zval_ptr_dtor(&args[0]);
            return false;
        }
        argc = 2;
    }
    ok = new_with(out, list ? "Purr\\Yaml\\Node\\SequenceNode" : "Purr\\Yaml\\Node\\MappingNode", argc, args);
    for (uint32_t k = 0; k < argc; k++) {
        zval_ptr_dtor(&args[k]);
    }
    return ok;
}

/* The text that the Dumper of purrphp/yaml writes for the node of a value, then a line break; a failure is a pending exception. */
static bool yaml_dump(zval *value, zval *out)
{
    zval root, document, dumper, text;
    if (!yaml_node_of(value, &root)) {
        return false;
    }
    bool ok = new_with(&document, "Purr\\Yaml\\Document", 1, &root);
    zval_ptr_dtor(&root);
    if (!ok) {
        return false;
    }
    zend_class_entry *dumper_ce = class_named("Purr\\Yaml\\Dumper\\Dumper");
    ok = dumper_ce != NULL && new_object(&dumper, dumper_ce);
    if (ok) {
        ok = call_method(&dumper, "dumpDocument", &text, 1, &document);
        zval_ptr_dtor(&dumper);
    }
    zval_ptr_dtor(&document);
    if (!ok) {
        return false;
    }
    ZVAL_STR(out, zend_string_concat2(Z_STRVAL(text), Z_STRLEN(text), "\n", 1));
    zval_ptr_dtor(&text);
    return true;
}

/* Codec::yamlText: the rules of the value, the text that the Dumper writes, and the text read back, which must be the value
 * (yaml-read-back). */
static bool yaml_text(zval *value, zval *out)
{
    if (!check_codec_value("yaml", value)) {
        return false;
    }
    zval text, back;
    if (!yaml_dump(value, &text)) {
        zend_object *cause = EG(exception) != NULL ? take_exception() : NULL;
        return orm_failf_previous("CODEC_ENCODE", cause, "yaml: the value has no YAML text");
    }
    if (!yaml_decode(Z_STR(text), &back)) {
        zval_ptr_dtor(&text);
        zend_object *cause = EG(exception) != NULL ? take_exception() : NULL;
        return orm_failf_previous("CODEC_ENCODE", cause, "yaml: the written text does not read back as the value");
    }
    bool same = zend_is_identical(&back, value);
    zval_ptr_dtor(&back);
    if (!same) {
        zval_ptr_dtor(&text);
        return orm_failf("CODEC_ENCODE", "yaml: the written text does not read back as the value");
    }
    ZVAL_COPY_VALUE(out, &text);
    return true;
}

/* ---- ordered JSON: the text of a value, as Codec.php jsonText ---- */

static bool json_scalar(zval *v, smart_str *out)
{
    zval args[2], s;
    ZVAL_COPY(&args[0], v);
    ZVAL_LONG(&args[1], PHP_JSON_UNESCAPED_SLASHES | PHP_JSON_UNESCAPED_UNICODE | PHP_JSON_THROW_ON_ERROR);
    bool ok = call_fn("json_encode", &s, 2, args);
    zval_ptr_dtor(&args[0]);
    if (ok) {
        smart_str_append(out, Z_STR(s));
        zval_ptr_dtor(&s);
    }
    return ok;
}

static bool json_text(zval *v, zend_long depth, smart_str *out);

static bool json_depth_error(void)
{
    return orm_failf("CODEC_ENCODE", "json: value nesting exceeds %d levels", JSON_DEPTH);
}

/* The map form of Codec.php: each key as its string's JSON text, then ':' and the member's text. */
static bool json_map(HashTable *ht, zend_long depth, smart_str *out)
{
    smart_str_appendc(out, '{');
    bool first = true;
    zend_string *key;
    zend_ulong idx;
    zval *item;
    ZEND_HASH_FOREACH_KEY_VAL(ht, idx, key, item)
    {
        if (!first) {
            smart_str_appendc(out, ',');
        }
        first = false;
        zval kz;
        ZVAL_STR(&kz, key != NULL ? zend_string_copy(key) : zend_long_to_str((zend_long)idx));
        bool ok = json_text(&kz, depth, out);
        zval_ptr_dtor(&kz);
        if (!ok) {
            return false;
        }
        smart_str_appendc(out, ':');
        if (!json_text(item, depth, out)) {
            return false;
        }
    }
    ZEND_HASH_FOREACH_END();
    smart_str_appendc(out, '}');
    return true;
}

/* The stored text of a JSON text: insignificant whitespace outside the string literals is removed, and every other
   byte, the member order and the repeated member names included, stays in place (DIA-26). */
static void compact_json_text(const char *text, size_t len, smart_str *out)
{
    bool in_string = false;
    bool escaped = false;
    for (size_t i = 0; i < len; i++) {
        char c = text[i];
        if (in_string) {
            smart_str_appendc(out, c);
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                in_string = false;
            }
            continue;
        }
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            continue;
        }
        if (c == '"') {
            in_string = true;
        }
        smart_str_appendc(out, c);
    }
}

/* Codec::jsonTextDepth: the deepest nesting of arrays and objects in a JSON text, its string literals aside. */
static zend_long json_text_depth(const char *text, size_t len)
{
    zend_long depth = 0, deepest = 0;
    bool in_string = false, escaped = false;
    for (size_t i = 0; i < len; i++) {
        char c = text[i];
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                in_string = false;
            }
        } else if (c == '"') {
            in_string = true;
        } else if (c == '[' || c == '{') {
            if (++depth > deepest) {
                deepest = depth;
            }
        } else if (c == ']' || c == '}') {
            depth--;
        }
    }
    return deepest;
}

/* Codec::jsonText: the JSON text of an ordered-json value or of the common value model, at the depth of its container. Each node is
 * checked in order: a nesting past the 256 levels of the parser, a string that is not UTF-8, a float that is not finite and a value
 * outside the JSON value model are their rules of COD-70. */
static bool json_text(zval *v, zend_long depth, smart_str *out)
{
    bool yes;
    ZVAL_DEREF(v);
    if (Z_TYPE_P(v) == IS_OBJECT) {
        IS_A(v, "Polyspec\\OrderedJson\\Value", yes);
        if (yes) {
            zval s;
            /* The source text keeps the member order and the repeated names that the member map collapses (DIA-26). */
            if (!call_method(v, "raw", &s, 0, NULL)) {
                return false;
            }
            if (depth + json_text_depth(Z_STRVAL(s), Z_STRLEN(s)) > JSON_DEPTH) {
                zval_ptr_dtor(&s);
                return json_depth_error();
            }
            smart_str_append(out, Z_STR(s));
            zval_ptr_dtor(&s);
            return true;
        }
    }
    bool std_class = false;
    if (Z_TYPE_P(v) == IS_OBJECT) {
        IS_A(v, "stdClass", std_class);
    }
    if (Z_TYPE_P(v) == IS_ARRAY || std_class) {
        if (depth + 1 > JSON_DEPTH) {
            return json_depth_error();
        }
        if (std_class) {
            zval props;
            if (!call_fn("get_object_vars", &props, 1, v)) {
                return false;
            }
            bool ok = json_map(Z_ARRVAL(props), depth + 1, out);
            zval_ptr_dtor(&props);
            return ok;
        }
        HashTable *ht = Z_ARRVAL_P(v);
        if (!zend_array_is_list(ht)) {
            return json_map(ht, depth + 1, out);
        }
        smart_str_appendc(out, '[');
        bool first = true;
        zval *item;
        ZEND_HASH_FOREACH_VAL(ht, item)
        {
            if (!first) {
                smart_str_appendc(out, ',');
            }
            first = false;
            if (!json_text(item, depth + 1, out)) {
                return false;
            }
        }
        ZEND_HASH_FOREACH_END();
        smart_str_appendc(out, ']');
        return true;
    }
    if (Z_TYPE_P(v) == IS_OBJECT) {
        IS_A(v, "JsonSerializable", yes);
        if (yes) {
            zval s;
            if (!call_method(v, "jsonSerialize", &s, 0, NULL)) {
                return false;
            }
            bool ok = json_text(&s, depth, out);
            zval_ptr_dtor(&s);
            return ok;
        }
    }
    if (Z_TYPE_P(v) == IS_STRING && !str_utf8(Z_STR_P(v))) {
        return orm_failf("CODEC_ENCODE", "json: " TEXT_UNICODE);
    }
    if (Z_TYPE_P(v) == IS_DOUBLE && !zend_finite(Z_DVAL_P(v))) {
        return orm_failf("CODEC_ENCODE", "json: non-finite number");
    }
    if (Z_TYPE_P(v) == IS_OBJECT || Z_TYPE_P(v) == IS_RESOURCE) {
        return orm_fail("CODEC_ENCODE", zend_string_init(ZEND_STRL("json: the value is not a JSON value"), 0));
    }
    return json_scalar(v, out);
}

/* Codec::orderedJsonText: the JSON text of the value, read by the ordered-json parser and written compact. A failure of the JSON
 * writer, or an InvalidArgumentException of a JsonSerializable, or any failure of the parser is json-text. */
static bool ordered_json_text(zval *value, zval *out)
{
    smart_str buf = {0};
    if (!json_text(value, 0, &buf)) {
        smart_str_free(&buf);
        if (exception_is("JsonException") || exception_is("InvalidArgumentException")) {
            return orm_failf_previous("CODEC_ENCODE", take_exception(), "json: the value has no JSON text");
        }
        return false;
    }
    zval text, parsed, s;
    ZVAL_STR(&text, smart_str_extract(&buf));
    bool ok = call_fn("Polyspec\\OrderedJson\\parse", &parsed, 1, &text);
    zval_ptr_dtor(&text);
    if (ok) {
        ok = call_method(&parsed, "raw", &s, 0, NULL);
        zval_ptr_dtor(&parsed);
    }
    if (!ok) {
        zend_object *cause = EG(exception) != NULL ? take_exception() : NULL;
        return orm_failf_previous("CODEC_ENCODE", cause, "json: the value has no JSON text");
    }
    smart_str stored = {0};
    compact_json_text(Z_STRVAL(s), Z_STRLEN(s), &stored);
    zval_ptr_dtor(&s);
    ZVAL_STR(out, smart_str_extract(&stored));
    return true;
}

/* ---- serialize: a reader of PHP's serialize format, as Codec::unserialized ---- */

static bool serialize_rule(const char *rule)
{
    return orm_failf("CODEC_DECODE", "serialize: %s", rule);
}

/* Moves past the delimiter at *at, or refuses the cell as serialize-expected. */
static bool serialized_delimiter(const char *s, size_t n, size_t *at, char delimiter)
{
    if (*at >= n || s[*at] != delimiter) {
        return orm_failf("CODEC_DECODE", "serialize: expected %c", delimiter);
    }
    (*at)++;
    return true;
}

/* The field from *at up to the delimiter that ends it, moving past the delimiter. */
static bool serialized_field(const char *s, size_t n, size_t *at, char delimiter, const char **field, size_t *len)
{
    const char *end = *at < n ? memchr(s + *at, delimiter, n - *at) : NULL;
    if (end == NULL) {
        return orm_failf("CODEC_DECODE", "serialize: expected %c", delimiter);
    }
    *field = s + *at;
    *len = (size_t)(end - *field);
    *at = (size_t)(end - s) + 1;
    return true;
}

/* The length of a string or an array: digits only, as the grammar of unserialize reads it; a length past SIZE_MAX is SIZE_MAX,
 * which is past the end of any cell. */
static bool serialized_length(const char *f, size_t len, const char *what, size_t *out)
{
    if (len == 0) {
        return orm_failf("CODEC_DECODE", "serialize: bad %s length", what);
    }
    size_t value = 0;
    for (size_t i = 0; i < len; i++) {
        if (f[i] < '0' || f[i] > '9') {
            return orm_failf("CODEC_DECODE", "serialize: bad %s length", what);
        }
        size_t digit = (size_t)(f[i] - '0');
        value = value > (SIZE_MAX - digit) / 10 ? SIZE_MAX : value * 10 + digit;
    }
    *out = value;
    return true;
}

/* An i field: an optional sign and digits, in the i64 range (COD-16), which unserialize would clamp. */
static bool serialized_int(const char *f, size_t len, zend_long *out)
{
    size_t i = 0;
    bool negative = false;
    if (i < len && (f[i] == '+' || f[i] == '-')) {
        negative = f[i] == '-';
        i++;
    }
    if (i == len) {
        return serialize_rule("bad int");
    }
    for (size_t k = i; k < len; k++) {
        if (f[k] < '0' || f[k] > '9') {
            return serialize_rule("bad int");
        }
    }
    while (i + 1 < len && f[i] == '0') {
        i++;
    }
    const char *limit = negative ? "9223372036854775808" : "9223372036854775807";
    size_t digits = len - i;
    if (digits > 19 || (digits == 19 && memcmp(f + i, limit, 19) > 0)) {
        return serialize_rule("integer is outside the i64 range");
    }
    zend_ulong value = 0;
    for (; i < len; i++) {
        value = value * 10 + (zend_ulong)(f[i] - '0');
    }
    *out = !negative ? (zend_long)value : value == (zend_ulong)ZEND_LONG_MAX + 1 ? ZEND_LONG_MIN : -(zend_long)value;
    return true;
}

/* A d field of the grammar of unserialize: an optional sign, digits with an optional fraction and an optional exponent, or NAN,
 * INF and -INF, which with a float beyond the f64 range are not finite (COD-16). The value is zend_strtod's, as the cast of
 * Codec.php reads it. */
static bool serialized_float(const char *f, size_t len, double *out)
{
    if ((len == 3 && (memcmp(f, "NAN", 3) == 0 || memcmp(f, "INF", 3) == 0)) || (len == 4 && memcmp(f, "-INF", 4) == 0)) {
        return serialize_rule("non-finite float");
    }
    size_t i = 0, whole = 0, fraction = 0;
    if (i < len && (f[i] == '+' || f[i] == '-')) {
        i++;
    }
    for (; i < len && f[i] >= '0' && f[i] <= '9'; i++) {
        whole++;
    }
    if (i < len && f[i] == '.') {
        for (i++; i < len && f[i] >= '0' && f[i] <= '9'; i++) {
            fraction++;
        }
    }
    bool form = whole + fraction > 0;
    if (form && i < len && (f[i] == 'e' || f[i] == 'E')) {
        size_t exponent = 0;
        i++;
        if (i < len && (f[i] == '+' || f[i] == '-')) {
            i++;
        }
        for (; i < len && f[i] >= '0' && f[i] <= '9'; i++) {
            exponent++;
        }
        form = exponent > 0;
    }
    if (!form || i != len) {
        return serialize_rule("bad float");
    }
    /* The field ends at its ';', so zend_strtod stops at the end of the field. */
    double value = zend_strtod(f, NULL);
    if (!zend_finite(value)) {
        return serialize_rule("non-finite float");
    }
    *out = value;
    return true;
}

/* Codec::serializedScalar: a value of the type letter t other than an array, read from *at. */
static bool serialized_scalar(const char *s, size_t n, size_t *at, char t, zval *out)
{
    const char *f;
    size_t len;
    switch (t) {
        case 'N':
            if (!serialized_delimiter(s, n, at, ';')) {
                return false;
            }
            ZVAL_NULL(out);
            return true;
        case 'b':
            if (!serialized_delimiter(s, n, at, ':') || !serialized_field(s, n, at, ';', &f, &len)) {
                return false;
            }
            if (len != 1 || (f[0] != '0' && f[0] != '1')) {
                return serialize_rule("bad bool");
            }
            ZVAL_BOOL(out, f[0] == '1');
            return true;
        case 'i': {
            zend_long value;
            if (!serialized_delimiter(s, n, at, ':') || !serialized_field(s, n, at, ';', &f, &len) || !serialized_int(f, len, &value)) {
                return false;
            }
            ZVAL_LONG(out, value);
            return true;
        }
        case 'd': {
            double value;
            if (!serialized_delimiter(s, n, at, ':') || !serialized_field(s, n, at, ';', &f, &len) || !serialized_float(f, len, &value)) {
                return false;
            }
            ZVAL_DOUBLE(out, value);
            return true;
        }
        case 's': {
            size_t size;
            if (!serialized_delimiter(s, n, at, ':') || !serialized_field(s, n, at, ':', &f, &len)
                || !serialized_length(f, len, "string", &size) || !serialized_delimiter(s, n, at, '"')) {
                return false;
            }
            if (size > n - *at) {
                return serialize_rule("string overruns input");
            }
            const char *bytes = s + *at;
            *at += size;
            if (!valid_utf8((const unsigned char *)bytes, size)) {
                return serialize_rule("string is not valid UTF-8");
            }
            if (!serialized_delimiter(s, n, at, '"') || !serialized_delimiter(s, n, at, ';')) {
                return false;
            }
            ZVAL_STRINGL(out, bytes, size);
            return true;
        }
        case 'O':
        case 'C':
        case 'r':
        case 'R':
            return orm_fail("CODEC_UNSUPPORTED", zend_string_init(ZEND_STRL("serialize: objects and references are not supported"), 0));
        default:
            return serialize_rule("unknown type");
    }
}

/* An open array of the reader: its items, the members left, whether its key is read, and the key. */
typedef struct {
    zval items;
    size_t left;
    bool keyed;
    zval key;
} serialized_frame;

/* Codec::unserialized: a serialized cell read by the grammar of PHP's unserialize, with the rules of COD-70: the values of the
 * common value model (COD-16), no object or reference (COD-34), and nothing after the value. An array opens a frame, so a nesting
 * of any depth reads without recursion; an array key is a whole value, an integer or a string, and a key that repeats an earlier one
 * is refused, which unserialize would let replace it; an array past the 256 levels is refused at its start. */
static bool unserialized(zend_string *in, zval *out)
{
    const char *s = ZSTR_VAL(in);
    size_t n = ZSTR_LEN(in), at = 0, depth = 0, cap = 0;
    serialized_frame *open = NULL;
    bool ok = true, done = false;
    while (!done) {
        zval value;
        if (at >= n) {
            ok = serialize_rule("unexpected end");
            break;
        }
        char t = s[at++];
        if (t == 'a') {
            /* An array is met where it starts: the nesting rule of its level before its fields (serialize-depth). */
            if (depth + 1 > DEPTH) {
                ok = serialize_rule(DEPTH_RULE);
                break;
            }
            const char *f;
            size_t len, members;
            if (!serialized_delimiter(s, n, &at, ':') || !serialized_field(s, n, &at, ':', &f, &len)
                || !serialized_length(f, len, "array", &members) || !serialized_delimiter(s, n, &at, '{')) {
                ok = false;
                break;
            }
            if (members > 0) {
                if (depth == cap) {
                    cap = cap == 0 ? 8 : cap * 2;
                    open = safe_erealloc(open, cap, sizeof(serialized_frame), 0);
                }
                array_init(&open[depth].items);
                open[depth].left = members;
                open[depth].keyed = false;
                ZVAL_UNDEF(&open[depth].key);
                depth++;
                continue;
            }
            if (!serialized_delimiter(s, n, &at, '}')) {
                ok = false;
                break;
            }
            array_init(&value);
        } else if (!serialized_scalar(s, n, &at, t, &value)) {
            ok = false;
            break;
        }
        for (;;) {
            if (depth == 0) {
                if (at != n) {
                    zval_ptr_dtor(&value);
                    ok = serialize_rule("trailing data");
                } else {
                    ZVAL_COPY_VALUE(out, &value);
                }
                done = true;
                break;
            }
            serialized_frame *top = &open[depth - 1];
            if (!top->keyed) {
                if (Z_TYPE(value) != IS_LONG && Z_TYPE(value) != IS_STRING) {
                    zval_ptr_dtor(&value);
                    ok = serialize_rule("array key must be int or string");
                    done = true;
                    break;
                }
                /* A PHP array key is an integer by its decimal string, so that i:1; and s:1:"1"; are one key and i:1; and s:2:"01";
                 * are two; the key that repeats one is met before its value (serialize-duplicate). */
                zval *exists = Z_TYPE(value) == IS_STRING ? zend_symtable_find(Z_ARRVAL(top->items), Z_STR(value))
                                                          : zend_hash_index_find(Z_ARRVAL(top->items), (zend_ulong)Z_LVAL(value));
                if (exists != NULL) {
                    zval_ptr_dtor(&value);
                    ok = serialize_rule("duplicate array key");
                    done = true;
                    break;
                }
                ZVAL_COPY_VALUE(&top->key, &value);
                top->keyed = true;
                break;
            }
            if (Z_TYPE(top->key) == IS_LONG) {
                zend_hash_index_update(Z_ARRVAL(top->items), (zend_ulong)Z_LVAL(top->key), &value);
            } else {
                zend_symtable_update(Z_ARRVAL(top->items), Z_STR(top->key), &value);
                zval_ptr_dtor(&top->key);
            }
            ZVAL_UNDEF(&top->key);
            top->keyed = false;
            if (--top->left > 0) {
                break;
            }
            if (!serialized_delimiter(s, n, &at, '}')) {
                ok = false;
                done = true;
                break;
            }
            ZVAL_COPY_VALUE(&value, &top->items);
            depth--;
        }
    }
    for (size_t i = 0; i < depth; i++) {
        zval_ptr_dtor(&open[i].items);
        if (open[i].keyed) {
            zval_ptr_dtor(&open[i].key);
        }
    }
    if (open != NULL) {
        efree(open);
    }
    return ok;
}

/* ---- host stages: the ip packing (INET6_ATON) ---- */

/* packIp: the packed address of the exact text s, or false with the error of ip-text. */
static bool ip_pack(zend_string *s, zend_string **packed)
{
    /* A NUL byte, and a zone (%eth0), which inet_pton accepts, are no part of an address (COD-38). */
    if (memchr(ZSTR_VAL(s), '\0', ZSTR_LEN(s)) != NULL || memchr(ZSTR_VAL(s), '%', ZSTR_LEN(s)) != NULL) {
        return orm_failf("CODEC_ENCODE", "ip: the text is not an address");
    }
    unsigned char buf[16];
    if (inet_pton(AF_INET, ZSTR_VAL(s), buf) == 1) {
        *packed = zend_string_init((char *)buf, 4, 0);
        return true;
    }
    if (inet_pton(AF_INET6, ZSTR_VAL(s), buf) == 1) {
        /* 16 bytes, an IPv4-mapped address included, as MySQL INET6_ATON packs it (COD-38). */
        *packed = zend_string_init((char *)buf, 16, 0);
        return true;
    }
    return orm_failf_previous("CODEC_ENCODE", library_cause("inet_pton returned false"), "ip: the text is not an address");
}

static bool make_bytes(zend_string *bytes, zval *ret)
{
    zend_class_entry *ce = class_named("Polyspec\\Orm\\Bytes");
    if (ce == NULL) {
        zend_string_release(bytes);
        return false;
    }
    zval arg, rv;
    ZVAL_STR(&arg, bytes);
    object_init_ex(ret, ce);
    zend_call_method(Z_OBJ_P(ret), ce, NULL, ZEND_STRL("__construct"), &rv, 1, &arg, NULL);
    zval_ptr_dtor(&arg);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(ret);
        return false;
    }
    return true;
}

/* ---- the public methods ---- */

bool codec_is_host_style(zend_string *style)
{
    return zend_string_equals_literal(style, "aes") || zend_string_equals_literal(style, "hex") || zend_string_equals_literal(style, "ip");
}

/* The cell of a decode: a stream read to its contents and a Bytes as its bytes; any other value as it is. */
static bool codec_cell(zval *raw, zval *value)
{
    ZVAL_COPY(value, raw);
    if (Z_TYPE_P(value) == IS_RESOURCE) {
        zval contents;
        if (!call_fn("stream_get_contents", &contents, 1, value)) {
            zval_ptr_dtor(value);
            return false;
        }
        zval_ptr_dtor(value);
        ZVAL_COPY_VALUE(value, &contents);
    }
    bool bytes;
    if (!is_instance(value, "Polyspec\\Orm\\Bytes", &bytes)) {
        zval_ptr_dtor(value);
        return false;
    }
    if (bytes) {
        zval rv;
        zend_string *s = zval_get_string(read_prop(value, "bytes", &rv));
        zval_ptr_dtor(value);
        ZVAL_STR(value, s);
    }
    return true;
}

/* checkStyles of Codec.php: a style that no stage names, and a value stage outside the first position, are refused before
 * any value or cell is read (COD-35). */
static bool check_styles(HashTable *styles)
{
    zend_long n = zend_hash_num_elements(styles);
    for (zend_long i = 0; i < n; i++) {
        zend_string *st = style_at(styles, i);
        bool ok = true;
        if (streq(st, "serialize") || streq(st, "yaml") || streq(st, "ordered_json")) {
            if (i != 0) {
                ok = orm_failf("CODEC_UNSUPPORTED", "%s must be the first style", ZSTR_VAL(st));
            }
        } else if (!streq(st, "gz") && !streq(st, "base64")) {
            ok = orm_failf("CODEC_UNSUPPORTED", "style %s", st != NULL ? ZSTR_VAL(st) : "");
        }
        str_free(st);
        if (!ok) {
            return false;
        }
    }
    return true;
}

/* plainBytes of Codec.php: Bytes as given and a string as its bytes; a value of another kind is CODEC_ENCODE (COD-1), and a string
 * that is not UTF-8 is no sequence of Unicode scalar values (host-input-unicode). */
static bool plain_bytes(zval *v, const char *what, zend_string **out)
{
    bool yes;
    IS_A(v, "Polyspec\\Orm\\Bytes", yes);
    if (yes) {
        zval rv;
        *out = zval_get_string(read_prop(v, "bytes", &rv));
        return true;
    }
    if (Z_TYPE_P(v) != IS_STRING) {
        orm_failf("CODEC_ENCODE", "%s input must be text or bytes", what);
        return false;
    }
    if (!str_utf8(Z_STR_P(v))) {
        orm_failf("CODEC_ENCODE", "%s input is not a sequence of Unicode scalar values", what);
        return false;
    }
    *out = zend_string_copy(Z_STR_P(v));
    return true;
}

static bool decode_stages(HashTable *styles, zval *raw, zval *ret)
{
    if (!check_styles(styles)) {
        return false;
    }
    zend_long n = zend_hash_num_elements(styles);
    zval cur;
    if (!codec_cell(raw, &cur)) return false;
    if (Z_TYPE(cur) == IS_NULL) {
        zval_ptr_dtor(&cur);
        return call_static("Polyspec\\Orm\\StyledValue", "sqlNull", ret, 0, NULL);
    }
    if (Z_TYPE(cur) != IS_STRING) {
        zval_ptr_dtor(&cur);
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("cell is not bytes"), 0));
    }
    zend_string *last = n > 0 ? style_at(styles, n - 1) : NULL;
    /* An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage (docs/spec/codec.md COD-14). */
    bool empty = Z_STRLEN(cur) == 0 && n > 0 && !streq(last, "base64");
    str_free(last);
    if (empty) {
        zval_ptr_dtor(&cur);
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("styled cell is empty"), 0));
    }

    for (zend_long i = n - 1; i >= 0; i--) {
        zend_string *st = style_at(styles, i);
        bool ok = true;
        if (streq(st, "gz")) {
            if (!need_string(&cur, "gzuncompress")) {
                ok = false;
            } else {
                const char *message = NULL;
                zend_string *out = gz_inflate(Z_STR(cur), &message);
                if (out == NULL) {
                    ok = orm_failf_previous("CODEC_DECODE", library_cause("%s", message), "gz: bad zlib stream");
                } else {
                    zval_ptr_dtor(&cur);
                    ZVAL_STR(&cur, out);
                }
            }
        } else if (streq(st, "base64")) {
            if (!need_string(&cur, "base64_decode")) {
                ok = false;
            } else {
                zend_string *dec = php_base64_decode_ex((const unsigned char *)Z_STRVAL(cur), Z_STRLEN(cur), true);
                if (dec == NULL) {
                    ok = orm_failf_previous("CODEC_DECODE", library_cause("base64_decode returned false"), "base64: bad input");
                } else {
                    /* PHP's strict mode also accepts whitespace and missing padding, so the text is encoded again and compared. */
                    zend_string *re = php_base64_encode((const unsigned char *)ZSTR_VAL(dec), ZSTR_LEN(dec));
                    bool same = zend_string_equals(re, Z_STR(cur));
                    zend_string_release(re);
                    if (!same) {
                        zend_string_release(dec);
                        ok = orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("base64: bad input"), 0));
                    } else {
                        zval_ptr_dtor(&cur);
                        ZVAL_STR(&cur, dec);
                    }
                }
            }
        } else if (streq(st, "serialize")) {
            zval value;
            if (!need_string(&cur, "unserialize") || !unserialized(Z_STR(cur), &value)) {
                ok = false;
            } else {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &value);
            }
        } else if (streq(st, "yaml")) {
            zval value;
            if (!need_string(&cur, "Yaml") || !yaml_decode(Z_STR(cur), &value)) {
                ok = false;
            } else {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &value);
            }
        } else if (streq(st, "ordered_json")) {
            if (!need_string(&cur, "Polyspec\\OrderedJson\\parse")) {
                ok = false;
            } else {
                /* The ordered-json value keeps the member order, the number text, and {} apart from []. */
                zval parsed;
                if (!call_fn("Polyspec\\OrderedJson\\parse", &parsed, 1, &cur)) {
                    /* The parser names the kind of its refusal; a nesting past its 256 levels is json-depth-read. */
                    zend_object *cause = EG(exception) != NULL ? take_exception() : NULL;
                    bool deep = cause != NULL && parse_error_kind(cause, "maximum_depth_exceeded");
                    ok = orm_failf_previous("CODEC_DECODE", cause, "json: %s", deep ? DEPTH_RULE : "the cell is not JSON");
                } else {
                    zval_ptr_dtor(&cur);
                    ZVAL_COPY_VALUE(&cur, &parsed);
                }
            }
        } else {
            ok = orm_failf("CODEC_UNSUPPORTED", "style %s", st != NULL ? ZSTR_VAL(st) : "");
        }
        str_free(st);
        if (!ok) {
            zval_ptr_dtor(&cur);
            return false;
        }
    }

    /* Without a value stage (no stage, or a list that starts with gz or base64) the value is the text of the bytes. */
    zend_string *first = style_at(styles, 0);
    bool text = first == NULL || streq(first, "gz") || streq(first, "base64");
    str_free(first);
    if (text && Z_TYPE(cur) == IS_STRING && !str_utf8(Z_STR(cur))) {
        zval_ptr_dtor(&cur);
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("decoded text is not valid UTF-8"), 0));
    }

    zval args[1];
    ZVAL_COPY_VALUE(&args[0], &cur);
    bool ok = call_static("Polyspec\\Orm\\StyledValue", "value", ret, 1, args);
    zval_ptr_dtor(&cur);
    return ok;
}

bool codec_decode(HashTable *styles, zval *raw, zval *ret)
{
    return decode_stages(styles, raw, ret);
}

bool codec_encode(HashTable *styles, zval *styled, zval *ret)
{
    bool is_styled;
    IS_A(styled, "Polyspec\\Orm\\StyledValue", is_styled);
    if (!is_styled) {
        zend_argument_type_error(2, "must be of type Polyspec\\Orm\\StyledValue, %s given", zend_zval_type_name(styled));
        return false;
    }
    if (!check_styles(styles)) {
        return false;
    }
    zval rv;
    zval *kind = read_prop(styled, "kind", &rv);
    if (Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "sql-null")) {
        ZVAL_NULL(ret);
        return true;
    }
    zval value;
    if (!call_method(styled, "payload", &value, 0, NULL)) {
        return false;
    }

    zend_long n = zend_hash_num_elements(styles);
    zend_string *first = style_at(styles, 0);
    /* A first gz or base64 stage encodes the string, and an empty stage list writes it as it is. */
    if (first == NULL || streq(first, "gz") || streq(first, "base64")) {
        bool refused = false;
        if (Z_TYPE(value) != IS_STRING) {
            /* "<stage> takes a string value", which names no host type (INT-163). */
            refused = true;
            if (first != NULL) {
                orm_failf("CODEC_ENCODE", "a first %s stage takes a string value", ZSTR_VAL(first));
            } else {
                orm_failf("CODEC_ENCODE", "an empty stage list takes a string value");
            }
        } else if (!str_utf8(Z_STR(value))) {
            refused = true;
            if (first != NULL) {
                orm_failf("CODEC_ENCODE", "%s: " TEXT_UNICODE, ZSTR_VAL(first));
            } else {
                orm_failf("CODEC_ENCODE", TEXT_UNICODE);
            }
        }
        if (refused) {
            str_free(first);
            zval_ptr_dtor(&value);
            return false;
        }
    }
    str_free(first);
    if (n == 0) {
        ZVAL_COPY_VALUE(ret, &value);
        return true;
    }

    zval cur;
    ZVAL_COPY(&cur, &value);
    for (zend_long i = 0; i < n; i++) {
        zend_string *st = style_at(styles, i);
        bool ok = true;
        if (streq(st, "serialize")) {
            /* serialize writes any PHP value, a Bytes or an ordered-json object among them; the stage writes the common value
             * model only (COD-16, COD-63). */
            zval s;
            if (!check_codec_value("serialize", &value)) {
                ok = false;
            } else if ((ok = call_fn("serialize", &s, 1, &value))) {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &s);
            }
        } else if (streq(st, "yaml")) {
            zval s;
            if ((ok = yaml_text(&value, &s))) {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &s);
            }
        } else if (streq(st, "ordered_json")) {
            zval s;
            if ((ok = ordered_json_text(&value, &s))) {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &s);
            }
        } else if (streq(st, "base64")) {
            if (!need_string(&cur, "base64_encode")) {
                ok = false;
            } else {
                zend_string *enc = php_base64_encode((const unsigned char *)Z_STRVAL(cur), Z_STRLEN(cur));
                zval_ptr_dtor(&cur);
                ZVAL_STR(&cur, enc);
            }
        } else if (streq(st, "gz")) {
            if (!need_string(&cur, "gzcompress")) {
                ok = false;
            } else {
                const char *message = NULL;
                zend_string *enc = gz_deflate(Z_STR(cur), &message);
                if (enc == NULL) {
                    ok = orm_failf_previous("CODEC_ENCODE", library_cause("%s", message), "gz: the compression failed");
                } else {
                    zval_ptr_dtor(&cur);
                    ZVAL_STR(&cur, enc);
                }
            }
        } else {
            ok = orm_failf("CODEC_UNSUPPORTED", "style %s", st != NULL ? ZSTR_VAL(st) : "");
        }
        str_free(st);
        if (!ok) {
            zval_ptr_dtor(&cur);
            zval_ptr_dtor(&value);
            return false;
        }
    }
    zval_ptr_dtor(&value);

    zend_string *last = n > 0 ? style_at(styles, n - 1) : NULL;
    bool binary = streq(last, "gz");
    str_free(last);
    if (Z_TYPE(cur) != IS_STRING && Z_TYPE(cur) != IS_NULL) {
        zend_type_error("Codec::encode(): Return value must be of type string|Bytes|null, %s returned", zend_zval_type_name(&cur));
        zval_ptr_dtor(&cur);
        return false;
    }
    if (binary && Z_TYPE(cur) == IS_STRING) {
        zend_string *bytes = Z_STR(cur);
        ZVAL_UNDEF(&cur);
        return make_bytes(bytes, ret);
    }
    ZVAL_COPY_VALUE(ret, &cur);
    return true;
}

static bool aes_seal(zend_string *plain, zend_string *key, zend_string **sealed);
static zend_string *hex_encode_upper(zend_string *in);

/* checkHostStyles of Codec.php: a style other than aes, hex and ip is refused before the value or the cell is read. */
static bool check_host_styles(HashTable *styles)
{
    zend_long n = zend_hash_num_elements(styles);
    for (zend_long i = 0; i < n; i++) {
        zend_string *st = style_at(styles, i);
        bool host = streq(st, "aes") || streq(st, "hex") || streq(st, "ip");
        bool ok = host || orm_failf("CODEC_UNSUPPORTED", "host style %s", st != NULL ? ZSTR_VAL(st) : "");
        str_free(st);
        if (!ok) {
            return false;
        }
    }
    return true;
}

bool codec_host_encode(zval *v, HashTable *styles, zend_string *aes_key, zval *ret)
{
    ZVAL_UNDEF(ret);
    zend_long n = zend_hash_num_elements(styles);
    if (n == 0) {
        return orm_fail("CODEC_ENCODE", zend_string_init(ZEND_STRL("host style list is empty"), 0));
    }
    if (!check_host_styles(styles)) {
        return false;
    }
    if (Z_TYPE_P(v) == IS_NULL) {
        ZVAL_NULL(ret);
        return true;
    }
    zend_string *cur;
    if (!plain_bytes(v, "host", &cur)) {
        return false;
    }

    for (zend_long i = 0; i < n; i++) {
        zend_string *st = style_at(styles, i);
        bool ok = true;
        zend_string *next = NULL;
        if (streq(st, "ip")) {
            ok = ip_pack(cur, &next);
        } else if (streq(st, "aes")) {
            if (ZSTR_LEN(aes_key) == 0) {
                ok = orm_fail("CONFIG", zend_string_init(ZEND_STRL("secret aes not configured"), 0));
            } else {
                ok = aes_seal(cur, aes_key, &next);
            }
        } else {
            /* hex, the last kind of host style. */
            next = hex_encode_upper(cur);
        }
        str_free(st);
        zend_string_release(cur);
        if (!ok) {
            return false;
        }
        cur = next;
    }
    zend_string *last = style_at(styles, n - 1);
    bool hex = streq(last, "hex");
    str_free(last);
    if (hex) {
        ZVAL_STR(ret, cur);
        return true;
    }
    return make_bytes(cur, ret);
}

/* ---- host stages: the decode (hostDecode and decodeRows) ---- */

static int hex_digit(unsigned char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

/* hex2bin of the upper-case hex digits only, as Codec.php checks them: the bytes, or NULL for an odd length or any other character. */
static zend_string *hex_decode(zend_string *in)
{
    size_t n = ZSTR_LEN(in);
    if (n % 2 != 0) {
        return NULL;
    }
    zend_string *out = zend_string_alloc(n / 2, 0);
    for (size_t i = 0; i < n / 2; i++) {
        int hi = hex_digit((unsigned char)ZSTR_VAL(in)[2 * i]);
        int lo = hex_digit((unsigned char)ZSTR_VAL(in)[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            zend_string_release(out);
            return NULL;
        }
        ZSTR_VAL(out)[i] = (char)(hi * 16 + lo);
    }
    ZSTR_VAL(out)[n / 2] = '\0';
    return out;
}

/* ---- host stages: AES (the ORM-AES2 envelope), hex encode, the blind index: PHP's own openssl, hash and random functions ---- */

#define AES_PREFIX "ORM-AES2\0"
#define AES_PREFIX_LEN 9
#define AES_NONCE_LEN 12
#define AES_TAG_LEN 16

/* The v2 key of Codec.php: the binary sha256 of the label, a NUL and the configured key. */
static bool aes_v2_key(zend_string *key, zend_string **out)
{
    zend_string *material = zend_string_concat2(ZEND_STRL("polyspec/orm/aes-256-gcm/v2\0"), ZSTR_VAL(key), ZSTR_LEN(key));
    zval a[3], rv;
    ZVAL_STRING(&a[0], "sha256");
    ZVAL_STR(&a[1], material);
    ZVAL_TRUE(&a[2]);
    bool ok = call_fn("hash", &rv, 3, a);
    zval_ptr_dtor(&a[0]);
    zval_ptr_dtor(&a[1]);
    if (!ok) {
        return false;
    }
    *out = Z_STR(rv);
    return true;
}

/* Codec::opensslClear: empties the queue of OpenSSL errors, so that the queue after a call holds only the errors of that call. */
static bool openssl_clear(void)
{
    for (;;) {
        zval e;
        if (!call_fn("openssl_error_string", &e, 0, NULL)) {
            return false;
        }
        bool more = Z_TYPE(e) == IS_STRING;
        zval_ptr_dtor(&e);
        if (!more) {
            return true;
        }
    }
}

/* Codec::opensslFailure: the cause of an OpenSSL call that returned false, the queue of OpenSSL errors or the name of the call. */
static zend_object *openssl_failure(const char *name)
{
    smart_str errors = {0};
    for (;;) {
        zval e;
        if (!call_fn("openssl_error_string", &e, 0, NULL)) {
            smart_str_free(&errors);
            return take_exception();
        }
        if (Z_TYPE(e) != IS_STRING) {
            zval_ptr_dtor(&e);
            break;
        }
        if (errors.s != NULL) {
            smart_str_appends(&errors, "; ");
        }
        smart_str_append(&errors, Z_STR(e));
        zval_ptr_dtor(&e);
    }
    if (errors.s == NULL) {
        return library_cause("%s returned false", name);
    }
    smart_str_0(&errors);
    zend_object *cause = library_cause("%s", ZSTR_VAL(errors.s));
    smart_str_free(&errors);
    return cause;
}

/*
 * Codec.php's aesSeal: openssl_encrypt of cur with AES-256-GCM, the v2 key, a random 12-byte nonce and the envelope prefix as
 * additional data, then the envelope "ORM-AES2\0" . nonce . ciphertext . tag. A failure of the random source or of the cipher is
 * aes-encrypt with the failure as its cause.
 */
static bool aes_seal(zend_string *plain, zend_string *key, zend_string **sealed)
{
    zval len, nonce;
    ZVAL_LONG(&len, AES_NONCE_LEN);
    if (!call_fn("random_bytes", &nonce, 1, &len)) {
        return orm_failf_previous("CODEC_ENCODE", take_exception(), "aes: the encryption failed");
    }
    zend_string *k;
    if (!aes_v2_key(key, &k)) {
        zval_ptr_dtor(&nonce);
        return false;
    }
    if (!openssl_clear()) {
        zend_string_release(k);
        zval_ptr_dtor(&nonce);
        return false;
    }
    zval tag, tagref;
    ZVAL_NULL(&tag);
    ZVAL_NEW_REF(&tagref, &tag);
    zval a[8];
    ZVAL_STR_COPY(&a[0], plain);
    ZVAL_STRING(&a[1], "aes-256-gcm");
    ZVAL_STR(&a[2], k);
    ZVAL_LONG(&a[3], 1);
    ZVAL_COPY_VALUE(&a[4], &nonce);
    ZVAL_COPY_VALUE(&a[5], &tagref);
    ZVAL_STRINGL(&a[6], AES_PREFIX, AES_PREFIX_LEN);
    ZVAL_LONG(&a[7], AES_TAG_LEN);
    zval enc;
    bool called = call_fn("openssl_encrypt", &enc, 8, a);
    zval_ptr_dtor(&a[0]);
    zval_ptr_dtor(&a[1]);
    zval_ptr_dtor(&a[2]);
    zval_ptr_dtor(&a[6]);
    zend_string *tag_s = called ? zval_get_string(Z_REFVAL(tagref)) : NULL;
    zval_ptr_dtor(&tagref);
    if (!called) {
        zval_ptr_dtor(&nonce);
        return orm_failf_previous("CODEC_ENCODE", take_exception(), "aes: the encryption failed");
    }
    if (Z_TYPE(enc) != IS_STRING) {
        zval_ptr_dtor(&nonce);
        zend_string_release(tag_s);
        return orm_failf_previous("CODEC_ENCODE", openssl_failure("openssl_encrypt"), "aes: the encryption failed");
    }
    zend_string *enc_s = Z_STR(enc);
    zend_string *nonce_s = Z_STR(nonce);
    size_t n = AES_PREFIX_LEN + ZSTR_LEN(nonce_s) + ZSTR_LEN(enc_s) + ZSTR_LEN(tag_s);
    zend_string *out = zend_string_alloc(n, 0);
    char *p = ZSTR_VAL(out);
    memcpy(p, AES_PREFIX, AES_PREFIX_LEN);
    p += AES_PREFIX_LEN;
    memcpy(p, ZSTR_VAL(nonce_s), ZSTR_LEN(nonce_s));
    p += ZSTR_LEN(nonce_s);
    memcpy(p, ZSTR_VAL(enc_s), ZSTR_LEN(enc_s));
    p += ZSTR_LEN(enc_s);
    memcpy(p, ZSTR_VAL(tag_s), ZSTR_LEN(tag_s));
    p += ZSTR_LEN(tag_s);
    *p = '\0';
    zend_string_release(tag_s);
    zval_ptr_dtor(&enc);
    zval_ptr_dtor(&nonce);
    *sealed = out;
    return true;
}

/*
 * Codec.php's aesOpen: the envelope of cur opened with the v2 key. Another format and a truncated envelope are their rules, and a
 * failed authentication keeps the failure of openssl_decrypt as its cause.
 */
static bool aes_open(zend_string *cur, zend_string *key, zend_string **plain)
{
    if (ZSTR_LEN(key) == 0) {
        return orm_fail("CONFIG", zend_string_init(ZEND_STRL("secret aes not configured"), 0));
    }
    size_t n = ZSTR_LEN(cur);
    const char *c = ZSTR_VAL(cur);
    if (n < AES_PREFIX_LEN || memcmp(c, AES_PREFIX, AES_PREFIX_LEN) != 0) {
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("aes: unsupported ciphertext format"), 0));
    }
    if (n < AES_PREFIX_LEN + AES_NONCE_LEN + AES_TAG_LEN) {
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("aes: truncated v2 envelope"), 0));
    }
    zend_string *k;
    if (!aes_v2_key(key, &k)) {
        return false;
    }
    if (!openssl_clear()) {
        zend_string_release(k);
        return false;
    }
    zval a[7], res;
    ZVAL_STR(&a[0], zend_string_init(c + AES_PREFIX_LEN + AES_NONCE_LEN, n - AES_PREFIX_LEN - AES_NONCE_LEN - AES_TAG_LEN, 0));
    ZVAL_STRING(&a[1], "aes-256-gcm");
    ZVAL_STR(&a[2], k);
    ZVAL_LONG(&a[3], 1);
    ZVAL_STR(&a[4], zend_string_init(c + AES_PREFIX_LEN, AES_NONCE_LEN, 0));
    ZVAL_STR(&a[5], zend_string_init(c + n - AES_TAG_LEN, AES_TAG_LEN, 0));
    ZVAL_STRINGL(&a[6], AES_PREFIX, AES_PREFIX_LEN);
    bool called = call_fn("openssl_decrypt", &res, 7, a);
    for (int i = 0; i < 7; i++) {
        zval_ptr_dtor(&a[i]);
    }
    if (!called) {
        return orm_failf_previous("CODEC_DECODE", take_exception(), "aes: authentication failed");
    }
    if (Z_TYPE(res) != IS_STRING) {
        zval_ptr_dtor(&res);
        return orm_failf_previous("CODEC_DECODE", openssl_failure("openssl_decrypt"), "aes: authentication failed");
    }
    *plain = Z_STR(res);
    return true;
}

/* bin2hex, upper-case, as Codec.php writes the hex stage. */
static zend_string *hex_encode_upper(zend_string *in)
{
    static const char digits[] = "0123456789ABCDEF";
    size_t n = ZSTR_LEN(in);
    zend_string *out = zend_string_alloc(2 * n, 0);
    for (size_t i = 0; i < n; i++) {
        unsigned char b = (unsigned char)ZSTR_VAL(in)[i];
        ZSTR_VAL(out)[2 * i] = digits[b >> 4];
        ZSTR_VAL(out)[2 * i + 1] = digits[b & 0x0f];
    }
    ZSTR_VAL(out)[2 * n] = '\0';
    return out;
}

/* Codec::blindIndex: hash_hmac sha256 of the plain text with the key, lower-case hex; null passes through. */
bool codec_blind_index(zval *v, zend_string *key, zval *ret)
{
    if (Z_TYPE_P(v) == IS_NULL) {
        ZVAL_NULL(ret);
        return true;
    }
    if (ZSTR_LEN(key) == 0) {
        return orm_fail("CONFIG", zend_string_init(ZEND_STRL("secret blind_index not configured"), 0));
    }
    zend_string *plain;
    if (!plain_bytes(v, "blind index", &plain)) {
        return false;
    }
    zval a[3];
    ZVAL_STRING(&a[0], "sha256");
    ZVAL_STR(&a[1], plain);
    ZVAL_STR_COPY(&a[2], key);
    bool ok = call_fn("hash_hmac", ret, 3, a);
    zval_ptr_dtor(&a[0]);
    zval_ptr_dtor(&a[1]);
    zval_ptr_dtor(&a[2]);
    return ok;
}

/*
 * Codec::hostDecode: undoes the host stages of a read cell, in reverse write order, after the styles are checked. hex and ip are
 * decoded as Codec.php does, and an ip stage ends the decode there, as the PHP loop returns there.
 */
bool codec_host_decode(zval *raw, HashTable *styles, zend_string *aes_key, zval *ret)
{
    if (!check_host_styles(styles)) {
        return false;
    }
    zval cur;
    if (!codec_cell(raw, &cur)) return false;
    if (Z_TYPE(cur) == IS_NULL) {
        ZVAL_NULL(ret);
        return true;
    }
    if (Z_TYPE(cur) != IS_STRING) {
        zval_ptr_dtor(&cur);
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("cell is not bytes"), 0));
    }
    zend_string *s = zend_string_copy(Z_STR(cur));
    zval_ptr_dtor(&cur);

    zend_long n = zend_hash_num_elements(styles);
    for (zend_long i = n - 1; i >= 0; i--) {
        zend_string *st = style_at(styles, i);
        bool is_hex = streq(st, "hex"), is_aes = streq(st, "aes");
        str_free(st);
        if (is_hex) {
            zend_string *out = hex_decode(s);
            zend_string_release(s);
            if (out == NULL) {
                return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("hex: odd length or non-hex input"), 0));
            }
            s = out;
        } else if (is_aes) {
            zend_string *plain;
            bool ok = aes_open(s, aes_key, &plain);
            zend_string_release(s);
            if (!ok) {
                return false;
            }
            s = plain;
        } else {
            /* ip, the last kind of host style: its text ends the decode. */
            size_t len = ZSTR_LEN(s);
            if (len != 4 && len != 16) {
                zend_string_release(s);
                return orm_failf("CODEC_DECODE", "ip: the cell is not 4 or 16 packed bytes");
            }
            /* inet_ntop writes the text of any 4 or 16 bytes into a buffer of INET6_ADDRSTRLEN (COD-72). */
            char text[INET6_ADDRSTRLEN];
            (void)inet_ntop(len == 4 ? AF_INET : AF_INET6, ZSTR_VAL(s), text, sizeof(text));
            zend_string_release(s);
            ZVAL_STRING(ret, text);
            return true;
        }
    }
    ZVAL_STR(ret, s);
    return true;
}

/* COD-44: a stored key version, read by aes_stored_version; any other value is CODEC_DECODE and is never coerced. */
static bool stored_version(zval *v, zend_long *out)
{
    return aes_stored_version(v, out) || aes_stored_version_refused();
}

/* One entry of decodeRows' $cells: [index, host stages, codec stages, whether the host stages include aes, aes_key_version index or null,
 * the <entity>.<column> of the cell, the <entity>.<column> of the version column or null]. */
typedef struct {
    zend_long index;
    HashTable *host;
    HashTable *codec;
    bool aes;
    zval *version;
    zend_string *name;
    zend_string *version_name;
} styled_cell;

static bool cell_parse(zval *c, styled_cell *sc)
{
    ZVAL_DEREF(c);
    zval *index = NULL, *host = NULL, *codec = NULL, *aes = NULL, *version = NULL, *name = NULL, *version_name = NULL;
    if (Z_TYPE_P(c) == IS_ARRAY) {
        HashTable *t = Z_ARRVAL_P(c);
        index = zend_hash_index_find(t, 0);
        host = zend_hash_index_find(t, 1);
        codec = zend_hash_index_find(t, 2);
        aes = zend_hash_index_find(t, 3);
        version = zend_hash_index_find(t, 4);
        name = zend_hash_index_find(t, 5);
        version_name = zend_hash_index_find(t, 6);
    }
    if (index == NULL || host == NULL || codec == NULL || aes == NULL || version == NULL || name == NULL || version_name == NULL) {
        zend_type_error("Codec::decodeRows(): a cell is not [index, host stages, codec stages, aes, version index, entity.column, "
            "version entity.column]");
        return false;
    }
    ZVAL_DEREF(index);
    ZVAL_DEREF(host);
    ZVAL_DEREF(codec);
    ZVAL_DEREF(aes);
    ZVAL_DEREF(version);
    ZVAL_DEREF(name);
    ZVAL_DEREF(version_name);
    if (Z_TYPE_P(index) != IS_LONG || Z_TYPE_P(host) != IS_ARRAY || Z_TYPE_P(codec) != IS_ARRAY || (Z_TYPE_P(version) != IS_LONG && Z_TYPE_P(version) != IS_NULL)
        || Z_TYPE_P(name) != IS_STRING || (Z_TYPE_P(version_name) != IS_STRING && Z_TYPE_P(version_name) != IS_NULL)) {
        zend_type_error("Codec::decodeRows(): a cell has a field of the wrong type");
        return false;
    }
    sc->index = Z_LVAL_P(index);
    sc->host = Z_ARRVAL_P(host);
    sc->codec = Z_ARRVAL_P(codec);
    sc->aes = zend_is_true(aes);
    sc->version = version;
    sc->name = Z_STR_P(name);
    sc->version_name = Z_TYPE_P(version_name) == IS_STRING ? Z_STR_P(version_name) : NULL;
    return true;
}

/* A pending CODEC_DECODE OrmException of a read cell is thrown again with the <entity>.<column> of the cell before its message, with
 * the first as its previous: "CODEC_DECODE: <entity>.<column>: <message>" (COD-41). An exception of another code is left pending. */
static void name_decode_failure(zend_string *name)
{
    zend_class_entry *ce = EG(exception) != NULL ? class_named("Polyspec\\Orm\\OrmException") : NULL;
    if (ce == NULL || !instanceof_function(EG(exception)->ce, ce)) {
        return;
    }
    zval rv;
    zval *code = zend_read_property(ce, EG(exception), "code_", sizeof("code_") - 1, true, &rv);
    if (code == NULL || Z_TYPE_P(code) != IS_STRING || !zend_string_equals_literal(Z_STR_P(code), "CODEC_DECODE")) {
        return;
    }
    zend_object *previous = take_exception();
    zend_string *message = exception_message(previous);
    const size_t prefix = sizeof("CODEC_DECODE: ") - 1;
    zend_string *named = zend_strpprintf(0, "%s: %s", ZSTR_VAL(name), ZSTR_LEN(message) >= prefix ? ZSTR_VAL(message) + prefix : "");
    zend_string_release(message);
    (void)orm_fail_previous("CODEC_DECODE", named, previous);
}

/*
 * Codec::decodeRows: decodes the styled cells of positional rows in place. Each cell takes its host stages first, with the AES key of
 * the cell (the aes_key_version column of the row when it has one), then its codec stages; a resource that no codec stage reads is
 * read to its contents. The rows are written back in their own order, as the PHP method writes them.
 */
bool codec_decode_rows(HashTable *rows, HashTable *cells, zval *config)
{
    bool yes;
    if (!is_instance(config, "Polyspec\\Orm\\Config", &yes)) {
        return false;
    }
    if (!yes) {
        zend_type_error("Codec::decodeRows(): the config must be a Polyspec\\Orm\\Config");
        return false;
    }
    zval keyring;
    ZVAL_UNDEF(&keyring);
    bool need_keyring = false;
    zval *c;
    ZEND_HASH_FOREACH_VAL(cells, c)
    {
        styled_cell sc;
        if (!cell_parse(c, &sc)) {
            return false;
        }
        need_keyring = need_keyring || sc.aes;
    }
    ZEND_HASH_FOREACH_END();
    if (need_keyring && !call_method(config, "keyring", &keyring, 0, NULL)) {
        return false;
    }

    bool ok = true;
    zval *row;
    ZEND_HASH_FOREACH_VAL(rows, row)
    {
        ZVAL_DEREF(row);
        if (Z_TYPE_P(row) != IS_ARRAY) {
            zend_type_error("Codec::decodeRows(): a row is not an array");
            ok = false;
            break;
        }
        SEPARATE_ARRAY(row);
        HashTable *vals = Z_ARRVAL_P(row);
        ZEND_HASH_FOREACH_VAL(cells, c)
        {
            styled_cell sc;
            if (!cell_parse(c, &sc)) {
                ok = false;
                break;
            }
            zval v;
            zval *cell = zend_hash_index_find(vals, (zend_ulong)sc.index);
            if (cell != NULL) {
                ZVAL_DEREF(cell);
                ZVAL_COPY(&v, cell);
            } else {
                zend_error(E_WARNING, "Undefined array key " ZEND_LONG_FMT, sc.index);
                ZVAL_NULL(&v);
            }
            /* COD-44: the version is read only for a non-NULL value, so a NULL cell with a NULL version stays NULL. */
            if (zend_hash_num_elements(sc.host) > 0 && Z_TYPE(v) != IS_NULL) {
                zend_string *key = NULL;
                if (!sc.aes) {
                    zval rv;
                    key = zval_get_string(read_prop(config, "aesKey", &rv));
                } else {
                    zend_long version;
                    if (Z_TYPE_P(sc.version) == IS_NULL || sc.version_name == NULL) {
                        /* COD-44: the planner selects the version column of every AES column, so a plan without one is broken: no version is assumed. */
                        (void)orm_fail("INTERNAL", zend_string_init(ZEND_STRL("an AES column has no version column"), 0));
                        zval_ptr_dtor(&v);
                        ok = false;
                        break;
                    }
                    zval *vi = zend_hash_index_find(vals, (zend_ulong)Z_LVAL_P(sc.version));
                    if (vi == NULL) {
                        /* COD-44: the version cell of a row the client selected is missing: a broken invariant, INTERNAL. */
                        (void)orm_fail("INTERNAL", zend_string_init(ZEND_STRL("the AES version cell is missing from the row"), 0));
                        zval_ptr_dtor(&v);
                        ok = false;
                        break;
                    }
                    if (!stored_version(vi, &version)) {
                        /* The CODEC_DECODE of a stored version names the version column (COD-41, COD-44). */
                        name_decode_failure(sc.version_name);
                        zval_ptr_dtor(&v);
                        ok = false;
                        break;
                    }
                    zval arg, kv;
                    ZVAL_LONG(&arg, version);
                    if (!call_method(&keyring, "key", &kv, 1, &arg)) {
                        zval_ptr_dtor(&v);
                        ok = false;
                        break;
                    }
                    key = zval_get_string(&kv);
                    zval_ptr_dtor(&kv);
                }
                zval host_out;
                bool hd = codec_host_decode(&v, sc.host, key, &host_out);
                zend_string_release(key);
                zval_ptr_dtor(&v);
                if (!hd) {
                    name_decode_failure(sc.name);
                    ok = false;
                    break;
                }
                ZVAL_COPY_VALUE(&v, &host_out);
            }
            if (zend_hash_num_elements(sc.codec) > 0) {
                zval decoded;
                bool cd = codec_decode(sc.codec, &v, &decoded);
                zval_ptr_dtor(&v);
                if (!cd) {
                    name_decode_failure(sc.name);
                    ok = false;
                    break;
                }
                ZVAL_COPY_VALUE(&v, &decoded);
            } else if (Z_TYPE(v) == IS_RESOURCE) {
                zval s;
                bool rd = call_fn("stream_get_contents", &s, 1, &v);
                zval_ptr_dtor(&v);
                if (!rd) {
                    ok = false;
                    break;
                }
                ZVAL_COPY_VALUE(&v, &s);
            }
            zend_hash_index_update(vals, (zend_ulong)sc.index, &v);
        }
        ZEND_HASH_FOREACH_END();
        if (!ok) {
            break;
        }
    }
    ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&keyring);
    return ok;
}
