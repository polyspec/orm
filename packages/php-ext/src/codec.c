/*
 * Polyspec\Orm\Codec of the PHP library (packages/php/src/Codec.php) in C. The dispatch of the stages, the byte work (gz with
 * libz, base64 strictly as the encoder writes it, the ip packing), the reader of the serialize format, the YAML reader of orm
 * (docs/spec/codec.md COD-74 to COD-80), the value checks and the error codes are made here, the same as Codec.php. The parsers and
 * writers that the library itself calls are called through the engine by the same public names: Polyspec\OrderedJson\parse (the
 * ordered-json value), Purr\Yaml (the YAML node model and the Dumper, which only write), and serialize, json_encode,
 * get_object_vars, random_bytes and openssl of PHP's own core. Each refusal is the rule
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

/* ---- YAML: the reader of orm (docs/spec/codec.md COD-74 to COD-80), as the reader of Codec.php ---- */

static bool yaml_rule(const char *rule)
{
    return orm_failf("CODEC_DECODE", "yaml: %s", rule);
}

/* Whether a character may appear in a YAML stream (YAML 1.2.2, 5.1, c-printable), as Codec::yamlStream. A byte order mark is
 * the encoding mark at the start of the stream (5.2) and never content. */
static bool yaml_printable(unsigned long cp)
{
    if (cp == '\t' || cp == '\n' || cp == '\r' || (cp >= 0x20 && cp <= 0x7E) || cp == 0x85) return true;
    if (cp == 0xFEFF) return false;
    return (cp >= 0xA0 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

/* The stream rules of YAML 1.2 that hold before the reader reads the stream (COD-66, COD-75), as Codec::yamlStream: the stream
 * is UTF-8, a byte order mark may start it and appears nowhere else, and every character is printable. */
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

/* Where a block node starts (s-l+block-node), Codec::Y_AT_*: on the next lines, after `-`, `?` or the `:` of an explicit entry,
 * after the `:` of an implicit key, or after `---`. */
#define Y_AT_LINES 0
#define Y_AT_INDICATOR 1
#define Y_AT_COLON 2
#define Y_AT_DOCUMENT 3

/* The frames of the reader, Codec::Y_*: the open collections, the pair of a flow sequence, and the rest of the line after a flow
 * node of a block collection. */
#define Y_BLOCK_SEQUENCE 1
#define Y_BLOCK_MAPPING 2
#define Y_FLOW_SEQUENCE 3
#define Y_FLOW_MAPPING 4
#define Y_PAIR 5
#define Y_TRAIL 6

/* What a step of the reader gives: a pending error, nothing yet, or a node read (a frame that ends). */
#define Y_ERROR (-1)
#define Y_NONE 0
#define Y_DONE 1

/* A frame of the reader, Codec::yamlFrame: its type, its state, its indentation, the array of a collection, the key of the open
 * entry (a long or a string, or undef), whether that key is a JSON node, the place of a node that is no key, and whether the
 * read ahead already knows the first key. */
typedef struct {
    int t;
    int st;
    zend_long m;
    zval v;
    zval k;
    bool j;
    zend_long f;
    bool known;
} yaml_frame;

/* The node that the reader reads next: a block node of a collection indented by n (s-l+block-node) with flag for block-out and
 * mode for where it starts, or a flow node whose lines are indented by n (ns-flow-node) with flag for a flow collection and
 * mode for an implicit key, which is one line; key reads it by the rules of a key. */
typedef struct {
    bool set;
    bool block;
    zend_long n;
    bool flag;
    int mode;
    bool key;
} yaml_request;

/* The state of one read: the stream after the byte order mark with its line breaks as LF, ended by a NUL that no stream holds
 * (c-printable); the end of what the reader reads, which the read ahead and a node that is no key move; the place; the level
 * of the open collections; the scratch text of a scalar; the explicit stack of the frames in heap memory; and the error. */
typedef struct {
    char *s;
    zend_long len;
    zend_long end;
    bool trunc;
    zend_long p;
    zend_long level;
    smart_str text;
    yaml_frame *frames;
    size_t count;
    size_t cap;
    const char *rule;
    zend_long at;
} yaml_reader;

static void yaml_text_reset(yaml_reader *r)
{
    if (r->text.s != NULL) {
        ZSTR_LEN(r->text.s) = 0;
    }
}

static void yaml_repeat(smart_str *out, char c, zend_long n)
{
    for (zend_long i = 0; i < n; i++) {
        smart_str_appendc(out, c);
    }
}

/* A rule of the reader (COD-70), met where its node starts. */
static bool yaml_fail_rule(yaml_reader *r, const char *rule)
{
    r->rule = rule;
    return false;
}

/* yaml-parse at the byte at of the stream, Codec::yamlParseError. */
static bool yaml_fail_parse(yaml_reader *r, zend_long at)
{
    r->rule = NULL;
    r->at = at;
    return false;
}

/* The character at p, or NUL at the end of what the reader reads, Codec::yamlAt. */
static unsigned char yaml_at(const yaml_reader *r, zend_long p)
{
    return p < r->end ? (unsigned char)r->s[p] : '\0';
}

/* The character at p of the whole stream, $s[$p] of Codec.php, which ignores the end of what the reader reads. */
static unsigned char yaml_ch(const yaml_reader *r, zend_long p)
{
    return p < r->len ? (unsigned char)r->s[p] : '\0';
}

/* Whether c is white space, a line break or the end, which an indicator is followed by (s-white, b-break). */
static bool yaml_sep(unsigned char c)
{
    return c == '\0' || c == ' ' || c == '\t' || c == '\n';
}

/* Whether c is a flow indicator (c-flow-indicator [23]). */
static bool yaml_flow_indicator(unsigned char c)
{
    return c == ',' || c == '[' || c == ']' || c == '{' || c == '}';
}

/* Whether c is one of the characters of set; the NUL of the end is none. */
static bool yaml_one_of(unsigned char c, const char *set)
{
    return c != '\0' && strchr(set, c) != NULL;
}

/* Whether c is ns-plain-safe [127] to [129]: outside a flow collection any ns-char, inside none of the flow indicators. */
static bool yaml_safe(unsigned char c, bool in)
{
    return !yaml_sep(c) && !(in && yaml_flow_indicator(c));
}

/* Whether a plain scalar starts at p (ns-plain-first [126]). */
static bool yaml_plain_first(const yaml_reader *r, zend_long p, bool in)
{
    unsigned char c = yaml_at(r, p);
    if (yaml_sep(c)) {
        return false;
    }
    if (c == '-' || c == '?' || c == ':') {
        return yaml_safe(yaml_at(r, p + 1), in);
    }
    return !yaml_one_of(c, "-?:,[]{}#&*!|>'\"%@`");
}

/* The number of bytes of the UTF-8 character whose first byte is c. */
static zend_long yaml_char_length(unsigned char c)
{
    return c < 0x80 ? 1 : (c < 0xE0 ? 2 : (c < 0xF0 ? 3 : 4));
}

/* Whether c is one ASCII hexadecimal digit (YAML 1.2.2 [35] ns-hex-digit), by its ranges: isxdigit follows the locale. */
static bool yaml_hex_digit(unsigned char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/* Whether c is one ASCII letter or digit, of [38] ns-word-char with the "-" apart, by its ranges: isalnum follows the locale. */
static bool yaml_word_char(unsigned char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/* The place of the line break that ends the line of p, or the end. */
static zend_long yaml_line_stop(const yaml_reader *r, zend_long p)
{
    zend_long from = p < r->end ? p : r->end;
    const char *q = memchr(r->s + from, '\n', (size_t)(r->len - from));
    return q == NULL || q - r->s > r->end ? r->end : q - r->s;
}

/* Whether a node of one line, as an implicit key is, ends at p of the stream: at the end of the stream, at the line break, or at
 * a comment after white space, Codec::yamlLineEnds. */
static bool yaml_line_ends(const yaml_reader *r, zend_long p)
{
    unsigned char c = yaml_ch(r, p);
    return c == '\0' || c == '\n' || (c == '#' && p > 0 && (r->s[p - 1] == ' ' || r->s[p - 1] == '\t'));
}

/* The marker `---` or `...` that starts a line at p (c-forbidden [206]): its first character, or NUL. */
static unsigned char yaml_marker(const yaml_reader *r, zend_long p)
{
    if (p + 3 <= r->end && (memcmp(r->s + p, "---", 3) == 0 || memcmp(r->s + p, "...", 3) == 0) && yaml_sep(yaml_at(r, p + 3))) {
        return (unsigned char)r->s[p];
    }
    return '\0';
}

/* Moves from the start of a line past the empty lines and the comment lines (s-l-comments [79]) to the start of the next line
 * that holds content, and returns the number of spaces that indent it, or -1 at the end. */
static zend_long yaml_next_line(yaml_reader *r)
{
    const char *s = r->s;
    zend_long end = r->end, p = r->p;
    while (p < end) {
        zend_long q = p;
        while (q < end && s[q] == ' ') {
            q++;
        }
        zend_long indent = q - p;
        while (q < end && (s[q] == ' ' || s[q] == '\t')) {
            q++;
        }
        if (q < end && s[q] == '#') {
            q = yaml_line_stop(r, q);
        }
        if (q >= end) {
            break;
        }
        if (s[q] == '\n') {
            p = q + 1;
            continue;
        }
        r->p = p;
        return indent;
    }
    r->p = end;
    return -1;
}

/* The rest of a line after a node or a marker (s-l-comments [79]): white space, a comment after white space, and the line break
 * or the end; the reader then stands at the start of the next line. */
static bool yaml_line_end(yaml_reader *r)
{
    const char *s = r->s;
    zend_long end = r->end, p = r->p;
    bool white = p == 0 || s[p - 1] == '\n';
    while (p < end && (s[p] == ' ' || s[p] == '\t')) {
        p++;
        white = true;
    }
    if (p < end && s[p] == '#') {
        if (!white) {
            return yaml_fail_parse(r, p);
        }
        p = yaml_line_stop(r, p);
    }
    if (p < end && s[p] != '\n') {
        return yaml_fail_parse(r, p);
    }
    r->p = p < end ? p + 1 : p;
    return true;
}

/* The separation between the tokens of a flow collection (s-separate [80]): white space, comments after white space and line
 * breaks; each line after the first that holds a token is indented by at least need spaces (s-flow-line-prefix [69]), and a
 * marker starts none of them. */
static bool yaml_flow_space(yaml_reader *r, zend_long need)
{
    const char *s = r->s;
    zend_long end = r->end, p = r->p;
    bool white = false;
    while (true) {
        while (p < end && (s[p] == ' ' || s[p] == '\t')) {
            p++;
            white = true;
        }
        if (p < end && s[p] == '#') {
            if (!white) {
                return yaml_fail_parse(r, p);
            }
            p = yaml_line_stop(r, p);
        }
        if (p >= end || s[p] != '\n') {
            break;
        }
        p++;
        bool token = false;
        while (true) {
            if (p >= end) {
                token = true;
                break;
            }
            if (yaml_marker(r, p) != '\0') {
                return yaml_fail_parse(r, p);
            }
            zend_long q = p;
            while (q < end && s[q] == ' ') {
                q++;
            }
            zend_long t = q;
            while (t < end && (s[t] == ' ' || s[t] == '\t')) {
                t++;
            }
            if (t < end && s[t] == '#') {
                t = yaml_line_stop(r, t);
            }
            if (t >= end) {
                p = t;
                token = true;
                break;
            }
            if (s[t] == '\n') {
                p = t + 1;
                continue;
            }
            if (q - p < need) {
                return yaml_fail_parse(r, t);
            }
            p = t;
            token = true;
            break;
        }
        if (token) {
            break;
        }
    }
    r->p = p;
    return true;
}

/* The lines after a line break inside a quoted scalar (b-l-folded [74], l-empty [70]): the empty lines, which it counts, then
 * the white space before the next text, whose line is indented by at least need spaces and is no marker. Returns the place of
 * that text, or the place where the scalar leaves the grammar as -1 - place. */
static zend_long yaml_quoted_lines(const yaml_reader *r, zend_long p, zend_long need, zend_long *breaks)
{
    const char *s = r->s;
    zend_long end = r->end;
    *breaks = 0;
    while (true) {
        if (p >= end || yaml_marker(r, p) != '\0') {
            return -1 - p;
        }
        zend_long a = p;
        while (a < end && s[a] == ' ') {
            a++;
        }
        zend_long b = a;
        while (b < end && (s[b] == ' ' || s[b] == '\t')) {
            b++;
        }
        if (b < end && s[b] == '\n') {
            if (b > a && a - p < need) {
                return -1 - a;
            }
            (*breaks)++;
            p = b + 1;
            continue;
        }
        if (b >= end || a - p < need) {
            return -1 - b;
        }
        return b;
    }
}

/* The text of the escape \e of a double-quoted scalar (5.7) appended to out, or false for none. */
static bool yaml_escape(unsigned char e, smart_str *out)
{
    switch (e) {
        case '0': smart_str_appendc(out, '\0'); return true;
        case 'a': smart_str_appendc(out, '\x07'); return true;
        case 'b': smart_str_appendc(out, '\x08'); return true;
        case 't':
        case '\t': smart_str_appendc(out, '\t'); return true;
        case 'n': smart_str_appendc(out, '\n'); return true;
        case 'v': smart_str_appendc(out, '\x0B'); return true;
        case 'f': smart_str_appendc(out, '\x0C'); return true;
        case 'r': smart_str_appendc(out, '\r'); return true;
        case 'e': smart_str_appendc(out, '\x1B'); return true;
        case ' ':
        case '"':
        case '/':
        case '\\': smart_str_appendc(out, (char)e); return true;
        case 'N': smart_str_appendl(out, "\xC2\x85", 2); return true;
        case '_': smart_str_appendl(out, "\xC2\xA0", 2); return true;
        case 'L': smart_str_appendl(out, "\xE2\x80\xA8", 3); return true;
        case 'P': smart_str_appendl(out, "\xE2\x80\xA9", 3); return true;
        default: return false;
    }
}

/* The UTF-8 bytes of the Unicode scalar value code appended to out, mb_chr of Codec.php. */
static void yaml_append_code_point(smart_str *out, unsigned long code)
{
    if (code < 0x80) {
        smart_str_appendc(out, (char)code);
    } else if (code < 0x800) {
        smart_str_appendc(out, (char)(0xC0 | (code >> 6)));
        smart_str_appendc(out, (char)(0x80 | (code & 0x3F)));
    } else if (code < 0x10000) {
        smart_str_appendc(out, (char)(0xE0 | (code >> 12)));
        smart_str_appendc(out, (char)(0x80 | ((code >> 6) & 0x3F)));
        smart_str_appendc(out, (char)(0x80 | (code & 0x3F)));
    } else {
        smart_str_appendc(out, (char)(0xF0 | (code >> 18)));
        smart_str_appendc(out, (char)(0x80 | ((code >> 12) & 0x3F)));
        smart_str_appendc(out, (char)(0x80 | ((code >> 6) & 0x3F)));
        smart_str_appendc(out, (char)(0x80 | (code & 0x3F)));
    }
}

/* The white space and the line break at q of a quoted scalar, which fold (6.5): white space before more text is content, and a
 * line break is a space or the empty lines after it; an implicit key is one line. Returns the place after them, or the place
 * where the scalar leaves the grammar as -1 - place. */
static zend_long yaml_quoted_white(yaml_reader *r, zend_long q, bool multi, zend_long need)
{
    const char *s = r->s;
    zend_long end = r->end, w = q;
    while (w < end && (s[w] == ' ' || s[w] == '\t')) {
        w++;
    }
    if (w >= end || s[w] != '\n') {
        smart_str_appendl(&r->text, s + q, (size_t)(w - q));
        return w;
    }
    if (!multi) {
        return -1 - w;
    }
    zend_long breaks = 0;
    zend_long next = yaml_quoted_lines(r, w + 1, need, &breaks);
    if (next < 0) {
        return next;
    }
    if (breaks == 0) {
        smart_str_appendc(&r->text, ' ');
    } else {
        yaml_repeat(&r->text, '\n', breaks);
    }
    return next;
}

/* A double-quoted scalar from its quote at *p ([107] to [116]) into the text of the reader, with the escapes of 5.7 and the
 * folding of 6.5; an implicit key is one line. Returns -1 with *p after the closing quote, or the place where the scalar leaves
 * the grammar. */
static zend_long yaml_double_quoted(yaml_reader *r, zend_long *p, bool multi, zend_long need)
{
    const char *s = r->s;
    zend_long end = r->end, q = *p + 1;
    yaml_text_reset(r);
    while (true) {
        if (q >= end) {
            return q;
        }
        unsigned char c = (unsigned char)s[q];
        if (c == '"') {
            *p = q + 1;
            return -1;
        }
        if (c == '\\') {
            unsigned char e = yaml_at(r, q + 1);
            if (yaml_escape(e, &r->text)) {
                q += 2;
                continue;
            }
            if (e == 'x' || e == 'u' || e == 'U') {
                zend_long digits = e == 'x' ? 2 : (e == 'u' ? 4 : 8);
                unsigned long code = 0;
                for (zend_long i = q + 2; i < q + 2 + digits; i++) {
                    if (i >= end || !yaml_hex_digit((unsigned char)s[i])) {
                        return i;
                    }
                    unsigned char d = (unsigned char)s[i];
                    code = code * 16 + (unsigned long)(d <= '9' ? d - '0' : (d | 0x20) - 'a' + 10);
                }
                /* A surrogate and a number above U+10FFFF are no Unicode scalar value (COD-78). */
                if ((code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF) {
                    return q;
                }
                yaml_append_code_point(&r->text, code);
                q += 2 + digits;
                continue;
            }
            if (e == '\n' && multi) {
                /* An escaped line break joins the lines and keeps the white space before it (s-double-escaped). */
                zend_long breaks = 0;
                q = yaml_quoted_lines(r, q + 2, need, &breaks);
                if (q < 0) {
                    return -1 - q;
                }
                yaml_repeat(&r->text, '\n', breaks);
                continue;
            }
            return q + 1;
        }
        if (c == ' ' || c == '\t' || c == '\n') {
            q = yaml_quoted_white(r, q, multi, need);
            if (q < 0) {
                return -1 - q;
            }
            continue;
        }
        zend_long run = q;
        while (run < end && !yaml_one_of((unsigned char)s[run], "\"\\ \t\n")) {
            run++;
        }
        smart_str_appendl(&r->text, s + q, (size_t)(run - q));
        q = run;
    }
}

/* A single-quoted scalar from its quote at *p ([117] to [125]) into the text of the reader, whose one escape is '' and whose
 * lines fold as 6.5 states; an implicit key is one line. Returns -1 with *p after the closing quote, or the place where the
 * scalar leaves the grammar. */
static zend_long yaml_single_quoted(yaml_reader *r, zend_long *p, bool multi, zend_long need)
{
    const char *s = r->s;
    zend_long end = r->end, q = *p + 1;
    yaml_text_reset(r);
    while (true) {
        if (q >= end) {
            return q;
        }
        unsigned char c = (unsigned char)s[q];
        if (c == '\'') {
            if (yaml_at(r, q + 1) == '\'') {
                smart_str_appendc(&r->text, '\'');
                q += 2;
                continue;
            }
            *p = q + 1;
            return -1;
        }
        if (c == ' ' || c == '\t' || c == '\n') {
            q = yaml_quoted_white(r, q, multi, need);
            if (q < 0) {
                return -1 - q;
            }
            continue;
        }
        zend_long run = q;
        while (run < end && !yaml_one_of((unsigned char)s[run], "' \t\n")) {
            run++;
        }
        smart_str_appendl(&r->text, s + q, (size_t)(run - q));
        q = run;
    }
}

/* A plain scalar from *p into the text of the reader, whose first character is ns-plain-first ([126] to [135]): it holds no `: `
 * and no ` #`, inside a flow collection (in) no flow indicator, and, unless it is an implicit key, continues on the next lines
 * indented by at least need spaces, which fold (6.5). Returns -1 with *p after its last character. In the read of a node that
 * is no key (COD-80), a scalar that the reader cannot know to end before the place where the key leaves the grammar is not read
 * whole, and that place is returned; a place where a node of one line ends, the end of its line or a comment, ends the scalar,
 * which is then read whole. */
static zend_long yaml_plain(yaml_reader *r, zend_long *p, bool in, bool multi, zend_long need)
{
    const char *s = r->s;
    zend_long end = r->end, q = *p;
    bool reached = false;
    yaml_text_reset(r);
    while (true) {
        zend_long start = q;
        q++;
        while (true) {
            if (q >= end) {
                reached = true;
                break;
            }
            unsigned char c = (unsigned char)s[q];
            if (c == ' ' || c == '\t') {
                zend_long w = q + 1;
                while (w < end && (s[w] == ' ' || s[w] == '\t')) {
                    w++;
                }
                if (w >= end) {
                    reached = true;
                    break;
                }
                unsigned char d = (unsigned char)s[w];
                if (d == '\n' || d == '#' || (in && yaml_flow_indicator(d))) {
                    break;
                }
                if (d == ':') {
                    if (w + 1 >= end) {
                        reached = true;
                    }
                    if (!yaml_safe(yaml_at(r, w + 1), in)) {
                        break;
                    }
                }
                q = w;
                continue;
            }
            if (c == '\n' || (in && yaml_flow_indicator(c))) {
                break;
            }
            if (c == ':') {
                if (q + 1 >= end) {
                    reached = true;
                }
                if (!yaml_safe(yaml_at(r, q + 1), in)) {
                    break;
                }
            }
            q++;
        }
        smart_str_appendl(&r->text, s + start, (size_t)(q - start));
        if (!multi || reached) {
            break;
        }
        zend_long w = q;
        while (w < end && (s[w] == ' ' || s[w] == '\t')) {
            w++;
        }
        if (w >= end || s[w] != '\n') {
            break;
        }
        zend_long breaks = 0, line = w + 1, next = -1;
        while (line < end && yaml_marker(r, line) == '\0') {
            zend_long a = line;
            while (a < end && s[a] == ' ') {
                a++;
            }
            zend_long b = a;
            while (b < end && (s[b] == ' ' || s[b] == '\t')) {
                b++;
            }
            if (b < end && s[b] == '\n') {
                if (b > a && a - line < need) {
                    break;
                }
                breaks++;
                line = b + 1;
                continue;
            }
            if (b >= end || a - line < need) {
                break;
            }
            unsigned char d = (unsigned char)s[b];
            bool colon = d == ':' && !yaml_safe(yaml_at(r, b + 1), in);
            if (d != '#' && !colon && !(in && yaml_flow_indicator(d))) {
                next = b;
            }
            break;
        }
        if (next < 0) {
            break;
        }
        if (breaks == 0) {
            smart_str_appendc(&r->text, ' ');
        } else {
            yaml_repeat(&r->text, '\n', breaks);
        }
        q = next;
    }
    if (reached && r->trunc && !yaml_line_ends(r, end)) {
        return end;
    }
    *p = q;
    return -1;
}

/* A line of the content of a block scalar: an empty line (no text), a line of spaces only beyond the content indentation, or the
 * text of a line from start. */
typedef struct {
    int kind;
    zend_long start;
    zend_long len;
} yaml_block_line;

#define Y_LINE_EMPTY 0
#define Y_LINE_SPACES 1
#define Y_LINE_TEXT 2

static void yaml_block_line_add(yaml_block_line **lines, size_t *count, size_t *cap, int kind, zend_long start, zend_long len)
{
    if (*count == *cap) {
        *cap = *cap == 0 ? 8 : *cap * 2;
        *lines = safe_erealloc(*lines, *cap, sizeof(yaml_block_line), 0);
    }
    (*lines)[*count].kind = kind;
    (*lines)[*count].start = start;
    (*lines)[*count].len = len;
    (*count)++;
}

static void yaml_block_line_append(const yaml_reader *r, const yaml_block_line *line, smart_str *out)
{
    if (line->kind == Y_LINE_SPACES) {
        yaml_repeat(out, ' ', line->len);
    } else if (line->kind == Y_LINE_TEXT) {
        smart_str_appendl(out, r->s + line->start, (size_t)line->len);
    }
}

/* A block scalar from its indicator at the place of the reader ([162] to [182]) inside a block collection indented by n spaces
 * (-1 for the node of a document): its header, its content lines by the content indentation of 8.1.1.1, the folding of a folded
 * scalar and the chomping of 8.1.1.2, as Codec::yamlBlockScalar. The reader then stands at the start of the line that ends it. */
static bool yaml_block_scalar(yaml_reader *r, zend_long n, zval *out)
{
    const char *s = r->s;
    zend_long end = r->end, p = r->p;
    bool folded = s[p] == '>';
    p++;
    zend_long indicator = 0;
    unsigned char chomp = '\0';
    for (int i = 0; i < 2; i++) {
        unsigned char c = yaml_at(r, p);
        if (indicator == 0 && c >= '1' && c <= '9') {
            indicator = c - '0';
            p++;
        } else if (chomp == '\0' && (c == '-' || c == '+')) {
            chomp = c;
            p++;
        }
    }
    bool white = false;
    while (p < end && (s[p] == ' ' || s[p] == '\t')) {
        p++;
        white = true;
    }
    if (p < end && s[p] == '#' && white) {
        p = yaml_line_stop(r, p);
    }
    if (p < end && s[p] != '\n') {
        return yaml_fail_parse(r, p);
    }
    p = p < end ? p + 1 : p;
    /* The content indentation: the indicator, or the spaces of the first line that is not empty (8.1.1.1). */
    zend_long indent;
    if (indicator > 0) {
        indent = n + indicator;
    } else {
        indent = -1;
        zend_long longest = 0, q = p;
        while (q < end) {
            zend_long a = q;
            while (a < end && s[a] == ' ') {
                a++;
            }
            if (a < end && s[a] == '\n') {
                longest = MAX(longest, a - q);
                q = a + 1;
                continue;
            }
            if (a < end && a - q > n && !(a == q && yaml_marker(r, q) != '\0')) {
                indent = a - q;
                if (longest > indent) {
                    return yaml_fail_parse(r, a);
                }
            }
            break;
        }
        if (indent < 0) {
            indent = MAX(longest, n + 1);
        }
    }
    yaml_block_line *lines = NULL;
    size_t count = 0, cap = 0;
    bool final = false;
    while (p < end) {
        if (yaml_marker(r, p) != '\0') {
            break;
        }
        zend_long a = p;
        while (a < end && s[a] == ' ') {
            a++;
        }
        zend_long spaces = a - p;
        if (a < end && s[a] == '\n') {
            if (spaces > indent) {
                yaml_block_line_add(&lines, &count, &cap, Y_LINE_SPACES, 0, spaces - indent);
                final = true;
            } else {
                yaml_block_line_add(&lines, &count, &cap, Y_LINE_EMPTY, 0, 0);
            }
            p = a + 1;
            continue;
        }
        if (a >= end) {
            if (spaces > indent) {
                yaml_block_line_add(&lines, &count, &cap, Y_LINE_SPACES, 0, spaces - indent);
                final = false;
                p = a;
            }
            break;
        }
        if (spaces < indent) {
            break;
        }
        zend_long stop = yaml_line_stop(r, a);
        yaml_block_line_add(&lines, &count, &cap, Y_LINE_TEXT, p + indent, stop - p - indent);
        final = stop < end;
        p = final ? stop + 1 : stop;
    }
    r->p = p;
    zend_long last = -1;
    for (size_t i = 0; i < count; i++) {
        if (lines[i].kind != Y_LINE_EMPTY) {
            last = (zend_long)i;
        }
    }
    zend_long trailing = (zend_long)count - last - 1;
    smart_str body = {0};
    if (last < 0) {
        if (chomp == '+') {
            yaml_repeat(&body, '\n', trailing);
        }
    } else {
        if (folded) {
            zend_long empty = 0;
            int previous = -1;
            for (zend_long i = 0; i <= last; i++) {
                const yaml_block_line *line = &lines[i];
                if (line->kind == Y_LINE_EMPTY) {
                    empty++;
                    continue;
                }
                bool spaced = line->kind == Y_LINE_SPACES
                    || (line->len > 0 && (s[line->start] == ' ' || s[line->start] == '\t'));
                if (previous < 0) {
                    yaml_repeat(&body, '\n', empty);
                } else if (!previous && !spaced) {
                    if (empty == 0) {
                        smart_str_appendc(&body, ' ');
                    } else {
                        yaml_repeat(&body, '\n', empty);
                    }
                } else {
                    yaml_repeat(&body, '\n', empty + 1);
                }
                yaml_block_line_append(r, line, &body);
                previous = spaced ? 1 : 0;
                empty = 0;
            }
        } else {
            for (zend_long i = 0; i <= last; i++) {
                if (i > 0) {
                    smart_str_appendc(&body, '\n');
                }
                yaml_block_line_append(r, &lines[i], &body);
            }
        }
        if (chomp != '-') {
            if (final) {
                smart_str_appendc(&body, '\n');
            }
            if (chomp == '+') {
                yaml_repeat(&body, '\n', trailing);
            }
        }
    }
    if (lines != NULL) {
        efree(lines);
    }
    ZVAL_STR(out, smart_str_extract(&body));
    return true;
}

/* Whether text[*i..n) starts with one or more ASCII decimal digits; *i moves past them. */
static bool yaml_digits(const char *text, size_t n, size_t *i)
{
    size_t start = *i;
    while (*i < n && text[*i] >= '0' && text[*i] <= '9') {
        (*i)++;
    }
    return *i > start;
}

/* Whether the whole text is a float of the core schema, [-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)? (10.3.2). */
static bool yaml_float_text(const char *text, size_t n)
{
    size_t i = 0;
    if (i < n && (text[i] == '-' || text[i] == '+')) {
        i++;
    }
    if (i < n && text[i] == '.') {
        i++;
        if (!yaml_digits(text, n, &i)) {
            return false;
        }
    } else {
        if (!yaml_digits(text, n, &i)) {
            return false;
        }
        if (i < n && text[i] == '.') {
            i++;
            yaml_digits(text, n, &i);
        }
    }
    if (i < n && (text[i] == 'e' || text[i] == 'E')) {
        i++;
        if (i < n && (text[i] == '-' || text[i] == '+')) {
            i++;
        }
        if (!yaml_digits(text, n, &i)) {
            return false;
        }
    }
    return i == n;
}

/* Whether the whole text is a float that is not finite of the core schema, [-+]?(\.inf|\.Inf|\.INF) or \.nan|\.NaN|\.NAN. */
static bool yaml_infinite_text(const char *text, size_t n)
{
    static const char *const names[] = {".inf", ".Inf", ".INF", "+.inf", "+.Inf", "+.INF", "-.inf", "-.Inf", "-.INF",
                                        ".nan", ".NaN", ".NAN"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (n == strlen(names[i]) && memcmp(text, names[i], n) == 0) {
            return true;
        }
    }
    return false;
}

/* The digits of text[from..n) with their leading zeros removed and one digit kept, each of which digit accepts, or false. */
static bool yaml_integer_digits(const char *text, size_t n, size_t from, bool (*digit)(unsigned char), size_t *start)
{
    if (from >= n) {
        return false;
    }
    for (size_t i = from; i < n; i++) {
        if (!digit((unsigned char)text[i])) {
            return false;
        }
    }
    while (from + 1 < n && text[from] == '0') {
        from++;
    }
    *start = from;
    return true;
}

static bool yaml_decimal_digit(unsigned char c)
{
    return c >= '0' && c <= '9';
}

static bool yaml_octal_digit(unsigned char c)
{
    return c >= '0' && c <= '7';
}

/* The text is a key: a value that is not a string or an integer is no key of the value model (yaml-key-scalar). */
#define YAML_KEY_SCALAR "map keys must be strings or integers"
#define YAML_INT_RANGE "integer is outside the i64 range"

/* A plain scalar by the core schema (10.3.2, COD-79), as Codec::yamlResolve: a value, or, as a map key, its string, an integer by
 * its value; the rules of its content are met here, once it is read whole (COD-80). */
static bool yaml_resolve(yaml_reader *r, bool key, zval *out)
{
    smart_str_0(&r->text);
    const char *text = r->text.s != NULL ? ZSTR_VAL(r->text.s) : "";
    size_t n = r->text.s != NULL ? ZSTR_LEN(r->text.s) : 0;
#define YAML_IS(lit) (n == sizeof(lit) - 1 && memcmp(text, lit, n) == 0)
    if (n == 0 || YAML_IS("~") || YAML_IS("null") || YAML_IS("Null") || YAML_IS("NULL")) {
        if (key) {
            return yaml_fail_rule(r, YAML_KEY_SCALAR);
        }
        ZVAL_NULL(out);
        return true;
    }
    if (YAML_IS("true") || YAML_IS("True") || YAML_IS("TRUE") || YAML_IS("false") || YAML_IS("False") || YAML_IS("FALSE")) {
        if (key) {
            return yaml_fail_rule(r, YAML_KEY_SCALAR);
        }
        ZVAL_BOOL(out, text[0] == 't' || text[0] == 'T');
        return true;
    }
#undef YAML_IS
    size_t start = 0;
    bool negative = n > 0 && text[0] == '-';
    size_t from = n > 0 && (text[0] == '-' || text[0] == '+') ? 1 : 0;
    if (yaml_integer_digits(text, n, from, yaml_decimal_digit, &start)) {
        size_t digits = n - start;
        const char *limit = negative ? "9223372036854775808" : "9223372036854775807";
        if (digits > 19 || (digits == 19 && memcmp(text + start, limit, 19) > 0)) {
            return yaml_fail_rule(r, YAML_INT_RANGE);
        }
        zend_ulong value = 0;
        for (size_t i = start; i < n; i++) {
            value = value * 10 + (zend_ulong)(text[i] - '0');
        }
        if (negative) {
            ZVAL_LONG(out, value == (zend_ulong)ZEND_LONG_MAX + 1 ? ZEND_LONG_MIN : -(zend_long)value);
        } else {
            ZVAL_LONG(out, (zend_long)value);
        }
        return true;
    }
    bool octal = n > 2 && text[0] == '0' && text[1] == 'o' && yaml_integer_digits(text, n, 2, yaml_octal_digit, &start);
    bool hex = !octal && n > 2 && text[0] == '0' && text[1] == 'x' && yaml_integer_digits(text, n, 2, yaml_hex_digit, &start);
    if (octal || hex) {
        /* 2^63 - 1 is 21 octal digits and 7fffffffffffffff. */
        size_t digits = n - start;
        if (hex ? digits > 16 || (digits == 16 && (unsigned char)text[start] > '7') : digits > 21) {
            return yaml_fail_rule(r, YAML_INT_RANGE);
        }
        zend_ulong value = 0;
        for (size_t i = start; i < n; i++) {
            unsigned char d = (unsigned char)text[i];
            value = value * (hex ? 16 : 8) + (zend_ulong)(d <= '9' ? d - '0' : (d | 0x20) - 'a' + 10);
        }
        ZVAL_LONG(out, (zend_long)value);
        return true;
    }
    bool isfloat = yaml_float_text(text, n);
    if (isfloat || yaml_infinite_text(text, n)) {
        if (key) {
            return yaml_fail_rule(r, YAML_KEY_SCALAR);
        }
        /* The binary64 nearest to the decimal text, (float) of Codec.php; one that rounds to an infinity is not finite (COD-79). */
        double value = isfloat ? zend_strtod(text, NULL) : INFINITY;
        if (!zend_finite(value)) {
            return yaml_fail_rule(r, "number is not finite");
        }
        ZVAL_DOUBLE(out, value);
        return true;
    }
    ZVAL_STRINGL(out, text, n);
    return true;
}

/* The scratch text of the reader as a string value. */
static void yaml_text_value(yaml_reader *r, zval *out)
{
    if (r->text.s == NULL) {
        ZVAL_EMPTY_STRING(out);
    } else {
        ZVAL_STRINGL(out, ZSTR_VAL(r->text.s), ZSTR_LEN(r->text.s));
    }
}

/* Opens a collection at the level after the open ones, Codec::yamlOpen: its nesting rule, then, for a key, yaml-key-collection. */
static bool yaml_open(yaml_reader *r, bool key)
{
    if (r->level >= DEPTH) {
        return yaml_fail_rule(r, DEPTH_RULE);
    }
    if (key) {
        return yaml_fail_rule(r, "map keys must be scalar strings");
    }
    r->level++;
    return true;
}

/* Pushes a frame on the stack of the reader, in heap memory (Codec::yamlFrame); a pointer to a frame is not kept across it. */
static void yaml_push(yaml_reader *r, int type, int state, zend_long indent)
{
    if (r->count == r->cap) {
        r->cap = r->cap == 0 ? 16 : r->cap * 2;
        r->frames = safe_erealloc(r->frames, r->cap, sizeof(yaml_frame), 0);
    }
    yaml_frame *f = &r->frames[r->count++];
    f->t = type;
    f->st = state;
    f->m = indent;
    if (type == Y_PAIR || type == Y_TRAIL) {
        ZVAL_UNDEF(&f->v);
    } else {
        array_init(&f->v);
    }
    ZVAL_UNDEF(&f->k);
    f->j = false;
    f->f = 0;
    f->known = false;
}

static yaml_frame *yaml_top(yaml_reader *r)
{
    return &r->frames[r->count - 1];
}

/* Sets the member key of the array to value, as $array[$key] = $value of PHP: a string key that is a decimal integer is that
 * integer. It takes the value. */
static void yaml_member(zval *array, zval *key, zval *value)
{
    if (Z_TYPE_P(key) == IS_LONG) {
        zend_hash_index_update(Z_ARRVAL_P(array), (zend_ulong)Z_LVAL_P(key), value);
    } else {
        zend_symtable_update(Z_ARRVAL_P(array), Z_STR_P(key), value);
    }
}

/* Records the key of a map entry, Codec::yamlKey, met where it repeats an earlier one (yaml-duplicate). It takes the key. */
static bool yaml_key(yaml_reader *r, yaml_frame *f, zval *key, bool json)
{
    bool repeated = Z_TYPE_P(key) == IS_LONG
        ? zend_hash_index_exists(Z_ARRVAL(f->v), (zend_ulong)Z_LVAL_P(key))
        : zend_symtable_exists(Z_ARRVAL(f->v), Z_STR_P(key));
    if (repeated) {
        zval_ptr_dtor(key);
        ZVAL_UNDEF(key);
        return yaml_fail_rule(r, "duplicate map key");
    }
    zval_ptr_dtor(&f->k);
    ZVAL_COPY_VALUE(&f->k, key);
    ZVAL_UNDEF(key);
    f->j = json;
    return true;
}

/* The end of the URI characters from p (ns-uri-char [39]), a `%` with two hexadecimal digits among them; with tag, of one tag
 * character at most (ns-tag-char [40]: no `!` and no flow indicator). */
static zend_long yaml_uri(const yaml_reader *r, zend_long p, bool tag)
{
    const char *s = r->s;
    zend_long end = r->end;
    while (p < end) {
        unsigned char c = (unsigned char)s[p];
        if (c == '%') {
            if (p + 2 >= end || !yaml_hex_digit((unsigned char)s[p + 1]) || !yaml_hex_digit((unsigned char)s[p + 2])) {
                break;
            }
            p += 3;
        } else if (yaml_word_char(c) || yaml_one_of(c, "-#;/?:@&=+$,_.!~*'()[]")) {
            if (tag && (c == '!' || yaml_flow_indicator(c))) {
                break;
            }
            p++;
        } else {
            break;
        }
        if (tag) {
            break;
        }
    }
    return p;
}

/* The directives of a document ([82] to [98], COD-75), which its `---` follows, Codec::yamlDirectives: `%YAML 1.2` once, `%TAG`
 * once for a handle, and no other. The reader then stands at the marker. */
static bool yaml_directives(yaml_reader *r)
{
    const char *s = r->s;
    zend_long end = r->end, indent;
    bool version = false, ok = true;
    HashTable handles;
    zend_hash_init(&handles, 4, NULL, NULL, 0);
    while (true) {
        indent = yaml_next_line(r);
        zend_long p = r->p;
        if (indent != 0 || s[p] != '%') {
            break;
        }
        zend_long q = p + 1;
        while (q < end && !yaml_sep((unsigned char)s[q])) {
            q++;
        }
        bool yaml = q - p - 1 == 4 && memcmp(s + p + 1, "YAML", 4) == 0;
        if (!yaml && !(q - p - 1 == 3 && memcmp(s + p + 1, "TAG", 3) == 0)) {
            ok = yaml_fail_parse(r, p);
            break;
        }
        if (q >= end || (s[q] != ' ' && s[q] != '\t')) {
            ok = yaml_fail_parse(r, q);
            break;
        }
        while (q < end && (s[q] == ' ' || s[q] == '\t')) {
            q++;
        }
        zend_long start = q;
        if (yaml) {
            while (q < end && !yaml_sep((unsigned char)s[q])) {
                q++;
            }
            if (version || !(q - start == 3 && memcmp(s + start, "1.2", 3) == 0)) {
                ok = yaml_fail_parse(r, start);
                break;
            }
            version = true;
        } else {
            /* c-tag-handle: !, !! or ! word characters !, then ns-tag-prefix. */
            q = start + 1;
            if (yaml_at(r, start) != '!') {
                ok = yaml_fail_parse(r, start);
                break;
            }
            while (q < end && (yaml_word_char((unsigned char)s[q]) || s[q] == '-')) {
                q++;
            }
            if (yaml_at(r, q) == '!') {
                q++;
            } else if (q > start + 1) {
                ok = yaml_fail_parse(r, q);
                break;
            }
            if (zend_hash_str_exists(&handles, s + start, (size_t)(q - start)) || (q < end && s[q] != ' ' && s[q] != '\t')
                || q >= end) {
                ok = yaml_fail_parse(r, start);
                break;
            }
            zend_hash_str_add_empty_element(&handles, s + start, (size_t)(q - start));
            while (q < end && (s[q] == ' ' || s[q] == '\t')) {
                q++;
            }
            zend_long prefix = q;
            if (yaml_at(r, q) == '!') {
                q++;
            } else if ((q = yaml_uri(r, q, true)) == prefix) {
                ok = yaml_fail_parse(r, prefix);
                break;
            }
            q = yaml_uri(r, q, false);
            if (!yaml_sep(yaml_at(r, q))) {
                ok = yaml_fail_parse(r, q);
                break;
            }
        }
        r->p = q;
        if (!yaml_line_end(r)) {
            ok = false;
            break;
        }
    }
    zend_hash_destroy(&handles);
    if (!ok) {
        return false;
    }
    if (indent != 0 || yaml_marker(r, r->p) != '-') {
        return yaml_fail_parse(r, r->p + MAX(indent, 0));
    }
    return true;
}

/* A frame of an open flow collection of the read ahead: its closing bracket, its state, and whether its key is a JSON node. States:
 * 0 the first entry or the end, 1 an entry after a comma, 2 after `?`, 3 after a key, 4 after `:`, 5 after an entry. */
typedef struct {
    unsigned char close;
    int state;
    bool key_json;
} yaml_ahead_frame;

/* A node of the read ahead is read: the node itself, or the key or the value of the open entry of the top frame. */
static void yaml_ahead_read(yaml_ahead_frame *top, bool json)
{
    if (top->state == 4) {
        top->state = 5;
    } else {
        top->state = 3;
        top->key_json = json;
    }
}

/* The end of the properties and the node at p that the read ahead reads (COD-80), on one line before the end of what the reader
 * reads, as the grammar holds it ([96] to [104], [137] to [161]), Codec::yamlAheadNode; *json is whether the node is a quoted
 * scalar or a flow collection. Returns -1, or the place where the node leaves the grammar. Its frames are an explicit stack in
 * heap memory. */
static zend_long yaml_ahead_node(yaml_reader *r, zend_long p, bool in, zend_long *out, bool *json)
{
    const char *s = r->s;
    zend_long end = r->end, result = -1;
    yaml_ahead_frame *stack = NULL;
    size_t count = 0, cap = 0;
    bool node = true;
    while (true) {
        if (node) {
            node = false;
            bool inside = in || count > 0, properties = false, alias = false, node_json = false;
            while (true) {
                unsigned char c = yaml_at(r, p);
                if (c == '&' || c == '*') {
                    if (c == '*' && properties) {
                        result = p;
                        goto done;
                    }
                    alias = c == '*';
                    zend_long q = p + 1;
                    while (q < end && !yaml_sep((unsigned char)s[q]) && !yaml_flow_indicator((unsigned char)s[q])) {
                        q++;
                    }
                    if (q == p + 1) {
                        result = q;
                        goto done;
                    }
                    p = q;
                } else if (c == '!') {
                    zend_long q = p + 1;
                    if (yaml_at(r, q) == '<') {
                        q = yaml_uri(r, q + 1, false);
                        if (q == p + 2 || yaml_at(r, q) != '>') {
                            result = q;
                            goto done;
                        }
                        q++;
                    } else {
                        zend_long w = q, next;
                        while (w < end && (yaml_word_char((unsigned char)s[w]) || s[w] == '-')) {
                            w++;
                        }
                        if (yaml_at(r, w) == '!') {
                            q = w + 1;
                            zend_long start = q;
                            while ((next = yaml_uri(r, q, true)) > q) {
                                q = next;
                            }
                            if (q == start) {
                                result = q;
                                goto done;
                            }
                        } else {
                            while ((next = yaml_uri(r, q, true)) > q) {
                                q = next;
                            }
                        }
                    }
                    p = q;
                } else {
                    break;
                }
                properties = true;
                if (alias) {
                    break;
                }
                c = yaml_at(r, p);
                if (c != ' ' && c != '\t') {
                    break;
                }
                while (p < end && (s[p] == ' ' || s[p] == '\t')) {
                    p++;
                }
            }
            unsigned char c = yaml_at(r, p);
            if (alias) {
                node_json = false;
            } else if (c == '[' || c == '{') {
                if (count == cap) {
                    cap = cap == 0 ? 8 : cap * 2;
                    stack = safe_erealloc(stack, cap, sizeof(yaml_ahead_frame), 0);
                }
                stack[count].close = c == '[' ? ']' : '}';
                stack[count].state = 0;
                stack[count].key_json = false;
                count++;
                p++;
                continue;
            } else if (c == '"' || c == '\'') {
                zend_long fail = c == '"' ? yaml_double_quoted(r, &p, false, 0) : yaml_single_quoted(r, &p, false, 0);
                if (fail >= 0) {
                    result = fail;
                    goto done;
                }
                node_json = true;
            } else if (yaml_plain_first(r, p, inside)) {
                yaml_plain(r, &p, inside, false, 0);
                node_json = false;
            } else if (properties) {
                node_json = false;
            } else {
                result = p;
                goto done;
            }
            if (count == 0) {
                *out = p;
                *json = node_json;
                result = -1;
                goto done;
            }
            yaml_ahead_read(&stack[count - 1], node_json);
        }
        bool white = false;
        while (p < end && (s[p] == ' ' || s[p] == '\t')) {
            p++;
            white = true;
        }
        if (p >= end || s[p] == '#' || s[p] == '\n') {
            result = p;
            goto done;
        }
        yaml_ahead_frame *top = &stack[count - 1];
        unsigned char close = top->close, c = (unsigned char)s[p];
        int state = top->state;
        bool key_json = top->key_json;
        if (state == 0 || state == 1) {
            if (c == close) {
                count--;
                p++;
                if (count == 0) {
                    *out = p;
                    *json = true;
                    result = -1;
                    goto done;
                }
                yaml_ahead_read(&stack[count - 1], true);
                continue;
            }
            if (c == ',') {
                result = p;
                goto done;
            }
            if (c == '?' && yaml_sep(yaml_at(r, p + 1))) {
                top->state = 2;
                p++;
                continue;
            }
            if (c == ':' && !yaml_safe(yaml_at(r, p + 1), true)) {
                top->state = 4;
                top->key_json = false;
                p++;
                continue;
            }
            node = true;
            continue;
        }
        if (state == 2) {
            if (c == ':' && !yaml_safe(yaml_at(r, p + 1), true)) {
                top->state = 4;
                top->key_json = false;
                p++;
                continue;
            }
            if (c == ',' || c == close) {
                top->state = 5;
                continue;
            }
            node = true;
            continue;
        }
        if (state == 3) {
            if (c == ':' && (key_json || !yaml_safe(yaml_at(r, p + 1), true))) {
                top->state = 4;
                p++;
                continue;
            }
            top->state = 5;
            continue;
        }
        if (state == 4) {
            if (c == ',' || c == close || (!key_json && !white)) {
                top->state = 5;
                continue;
            }
            node = true;
            continue;
        }
        if (c == ',') {
            top->state = 1;
            p++;
            continue;
        }
        if (c == close) {
            top->state = 1;
            continue;
        }
        result = p;
        goto done;
    }
done:
    if (stack != NULL) {
        efree(stack);
    }
    return result;
}

/* The read ahead of COD-80, Codec::yamlAhead: whether the node at p is an implicit key, a node on its line that the grammar holds,
 * of at most 1024 characters before the `:` that follows it (COD-76, COD-77); in is a key of a flow sequence. It applies no rule.
 * For a node that is no key, *fail is the place where the read ahead stops. */
static bool yaml_ahead(yaml_reader *r, zend_long p, bool in, zend_long *fail)
{
    const char *s = r->s;
    zend_long end = r->end, line_end = yaml_line_stop(r, p), limit = p;
    for (int chars = 0; limit < line_end && chars < 1024; chars++) {
        limit += yaml_char_length((unsigned char)s[limit]);
    }
    bool trunc = r->trunc;
    r->end = limit;
    r->trunc = false;
    zend_long after = p;
    bool json = false;
    zend_long stop = yaml_ahead_node(r, p, in, &after, &json);
    r->end = end;
    r->trunc = trunc;
    if (stop >= 0) {
        *fail = stop;
        return false;
    }
    while (after < line_end && (s[after] == ' ' || s[after] == '\t')) {
        after++;
    }
    if (after > limit || after >= line_end || s[after] != ':') {
        *fail = MIN(after, limit);
        return false;
    }
    unsigned char next = yaml_at(r, after + 1);
    if (in ? json || !yaml_safe(next, true) : yaml_sep(next)) {
        return true;
    }
    *fail = after;
    return false;
}

/* The first character after the spaces and tabs from p, where a line of content leaves the grammar. */
static zend_long yaml_text_start(const yaml_reader *r, zend_long p)
{
    while (p < r->end && (r->s[p] == ' ' || r->s[p] == '\t')) {
        p++;
    }
    return p;
}

static void yaml_ask(yaml_request *request, bool block, zend_long n, bool flag, int mode, bool key)
{
    request->set = true;
    request->block = block;
    request->n = n;
    request->flag = flag;
    request->mode = mode;
    request->key = key;
}

/* The properties and the alias, which the codec refuses at the character that starts them (COD-79), Codec::yamlProperty. */
static bool yaml_property(yaml_reader *r, unsigned char c)
{
    if (c == '&') {
        return yaml_fail_rule(r, "anchors are not supported");
    }
    if (c == '!') {
        return yaml_fail_rule(r, "explicit tags are not supported");
    }
    if (c == '*') {
        return yaml_fail_rule(r, "aliases are not supported");
    }
    return true;
}

/* The block node that starts at the place of the reader on its line, Codec::yamlBlockContent: its properties, which the codec
 * refuses where they stand; with compact, after an indicator and spaces, a compact sequence or mapping (s-l+block-indented
 * [185]); a block scalar; or a flow node and the rest of its line (s-l+flow-in-block [197]). */
static int yaml_block_content(yaml_reader *r, zend_long n, bool compact, bool key, yaml_request *request, zval *value, bool *json)
{
    const char *s = r->s;
    zend_long p = r->p;
    unsigned char c = (unsigned char)s[p];
    if (!yaml_property(r, c)) {
        return Y_ERROR;
    }
    if (compact) {
        zend_long column = p;
        while (column > 0 && s[column - 1] != '\n') {
            column--;
        }
        column = p - column;
        unsigned char next = yaml_at(r, p + 1);
        zend_long fail = 0;
        if (c == '-' && yaml_sep(next)) {
            if (!yaml_open(r, key)) {
                return Y_ERROR;
            }
            yaml_push(r, Y_BLOCK_SEQUENCE, 0, column);
            return Y_NONE;
        }
        bool indicator = (c == '?' || c == ':') && yaml_sep(next);
        if (indicator || yaml_ahead(r, p, false, &fail)) {
            if (!yaml_open(r, key)) {
                return Y_ERROR;
            }
            yaml_push(r, Y_BLOCK_MAPPING, 0, column);
            yaml_top(r)->known = !indicator;
            return Y_NONE;
        }
    }
    if (c == '|' || c == '>') {
        if (!yaml_block_scalar(r, n, value)) {
            return Y_ERROR;
        }
        *json = true;
        return Y_DONE;
    }
    yaml_push(r, Y_TRAIL, 0, 0);
    yaml_ask(request, false, n + 1, false, false, key);
    return Y_NONE;
}

/* A block node (s-l+block-node [196]) inside a block collection indented by n spaces, Codec::yamlBlockNode; out for the value of
 * a map entry (block-out, where a sequence may stand at the indentation of its key, seq-space [201]): on the line where it
 * starts, after an indicator, a `:` of an implicit key or `---`, or on the next lines. Gives Y_DONE when it is read as *value;
 * otherwise it has opened a frame or asked for a flow node. */
static int yaml_block_node(yaml_reader *r, zend_long n, bool out, int where, bool key, yaml_request *request, zval *value,
                           bool *json)
{
    const char *s = r->s;
    zend_long end = r->end;
    if (where != Y_AT_LINES) {
        zend_long p = r->p;
        bool spaces = true;
        while (p < end && (s[p] == ' ' || s[p] == '\t')) {
            spaces = spaces && s[p] == ' ';
            p++;
        }
        if (p < end && s[p] != '#' && s[p] != '\n') {
            r->p = p;
            bool compact = where == Y_AT_INDICATOR && spaces;
            return yaml_block_content(r, n, compact, key, request, value, json);
        }
        p = yaml_line_stop(r, p);
        r->p = p < end ? p + 1 : p;
    }
    zend_long indent = yaml_next_line(r);
    if (indent >= 0 && !(indent == 0 && yaml_marker(r, r->p) != '\0')) {
        zend_long q = r->p + indent;
        unsigned char c = (unsigned char)s[q], next = yaml_at(r, q + 1);
        if (c == '-' && yaml_sep(next) && (indent > n || (out && indent == n))) {
            if (!yaml_open(r, key)) {
                return Y_ERROR;
            }
            r->p = q;
            yaml_push(r, Y_BLOCK_SEQUENCE, 0, indent);
            return Y_NONE;
        }
        if (indent > n) {
            zend_long fail = 0;
            bool indicator = (c == '?' || c == ':') && yaml_sep(next);
            if (indicator || yaml_ahead(r, q, false, &fail)) {
                if (!yaml_open(r, key)) {
                    return Y_ERROR;
                }
                r->p = q;
                yaml_push(r, Y_BLOCK_MAPPING, 0, indent);
                yaml_top(r)->known = !indicator;
                return Y_NONE;
            }
            r->p = yaml_text_start(r, q);
            return yaml_block_content(r, n, false, key, request, value, json);
        }
    }
    if (key) {
        yaml_fail_rule(r, YAML_KEY_SCALAR);
        return Y_ERROR;
    }
    ZVAL_NULL(value);
    *json = false;
    return Y_DONE;
}

/* A flow node at the place of the reader (ns-flow-node [161]) whose lines are indented by need spaces, Codec::yamlFlowNode; in
 * inside a flow collection, single for an implicit key, which is one line: a collection opens its frame, and a scalar is read
 * as *value, by the rules of a key with key. Gives Y_DONE when it is read. */
static int yaml_flow_node(yaml_reader *r, zend_long need, bool in, bool single, bool key, zval *value, bool *json)
{
    zend_long p = r->p, fail;
    unsigned char c = yaml_at(r, p);
    if (!yaml_property(r, c)) {
        return Y_ERROR;
    }
    if (c == '[' || c == '{') {
        if (!yaml_open(r, key)) {
            return Y_ERROR;
        }
        yaml_push(r, c == '[' ? Y_FLOW_SEQUENCE : Y_FLOW_MAPPING, 0, need);
        r->p = p + 1;
        return Y_NONE;
    }
    if (c == '"' || c == '\'') {
        fail = c == '"' ? yaml_double_quoted(r, &p, !single, need) : yaml_single_quoted(r, &p, !single, need);
        if (fail < 0) {
            yaml_text_value(r, value);
        }
        *json = true;
    } else if (yaml_plain_first(r, p, in)) {
        fail = yaml_plain(r, &p, in, !single, need);
        if (fail < 0 && !yaml_resolve(r, key, value)) {
            return Y_ERROR;
        }
        *json = false;
    } else {
        fail = p;
    }
    if (fail >= 0) {
        yaml_fail_parse(r, fail);
        return Y_ERROR;
    }
    r->p = p;
    return Y_DONE;
}

/* A step of an open block mapping, Codec::yamlBlockMappingStep; gives Y_DONE when it ends. */
static int yaml_block_mapping_step(yaml_reader *r, yaml_frame *f, yaml_request *request)
{
    const char *s = r->s;
    if (f->st == 0) {
        zend_long p = r->p;
        unsigned char c = (unsigned char)s[p], next = yaml_at(r, p + 1);
        if (c == '?' && yaml_sep(next)) {
            r->p = p + 1;
            yaml_ask(request, true, f->m, true, Y_AT_INDICATOR, true);
            f->st = 2;
            return Y_NONE;
        }
        if (c == ':' && yaml_sep(next)) {
            yaml_fail_rule(r, YAML_KEY_SCALAR);
            return Y_ERROR;
        }
        zend_long fail = 0;
        if (f->known || yaml_ahead(r, p, false, &fail)) {
            yaml_ask(request, false, f->m + 1, false, true, true);
            f->st = 1;
        } else {
            /* A node that is no key: the rules of the nodes before the place where it leaves the grammar, or where the read
             * ahead ends with no `:`, then yaml-parse there (COD-80). */
            r->trunc = true;
            r->end = MIN(r->end, fail);
            f->f = fail;
            yaml_ask(request, false, f->m + 1, false, true, false);
            f->st = 6;
        }
        f->known = false;
        return Y_NONE;
    }
    zend_long indent = yaml_next_line(r);
    if (f->st == 3) {
        zend_long q = r->p + indent;
        if (indent == f->m && s[q] == ':' && yaml_sep(yaml_at(r, q + 1))) {
            r->p = q + 1;
            yaml_ask(request, true, f->m, true, Y_AT_INDICATOR, false);
            f->st = 4;
            return Y_NONE;
        }
        zval null;
        ZVAL_NULL(&null);
        yaml_member(&f->v, &f->k, &null);
        f->st = 5;
    }
    if (indent < 0 || (indent == 0 && yaml_marker(r, r->p) != '\0') || indent < f->m) {
        return Y_DONE;
    }
    zend_long q = r->p + indent;
    if (indent > f->m || s[q] == '\t') {
        yaml_fail_parse(r, yaml_text_start(r, q));
        return Y_ERROR;
    }
    r->p = q;
    f->st = 0;
    return Y_NONE;
}

/* The `,` or the closing bracket after an entry of a flow collection, or its first entry (state 0), Codec.php: a `,` with no
 * entry before it is yaml-parse. Gives Y_DONE at the closing bracket, which it moves past. */
static int yaml_flow_entry(yaml_reader *r, zend_long need, bool after, unsigned char close)
{
    if (!yaml_flow_space(r, need)) {
        return Y_ERROR;
    }
    unsigned char c = yaml_at(r, r->p);
    if (after) {
        if (c != ',' && c != close) {
            yaml_fail_parse(r, r->p);
            return Y_ERROR;
        }
        if (c == ',') {
            r->p++;
            if (!yaml_flow_space(r, need)) {
                return Y_ERROR;
            }
            c = yaml_at(r, r->p);
        }
    } else if (c == ',') {
        yaml_fail_parse(r, r->p);
        return Y_ERROR;
    }
    if (c == close) {
        r->p++;
        return Y_DONE;
    }
    if (c == ',') {
        yaml_fail_parse(r, r->p);
        return Y_ERROR;
    }
    return Y_NONE;
}

/* A step of an open flow sequence ([137] to [139]), Codec::yamlFlowSequenceStep; an entry that is an implicit key, an explicit `?`
 * or an empty key is a pair, a map of one entry that opens its own frame (ns-flow-pair [150]). Gives Y_DONE when it ends. */
static int yaml_flow_sequence_step(yaml_reader *r, yaml_frame *f, yaml_request *request)
{
    zend_long m = f->m;
    if (f->st == 0 || f->st == 3) {
        int entry = yaml_flow_entry(r, m, f->st == 3, ']');
        if (entry != Y_NONE) {
            return entry;
        }
        f->st = 1;
    }
    zend_long p = r->p, fail = 0;
    unsigned char c = yaml_at(r, p), next = yaml_at(r, p + 1);
    f->st = 2;
    /* f is not used after a push, which may move the frames. */
    if (c == '?' && yaml_sep(next)) {
        if (!yaml_open(r, false)) {
            return Y_ERROR;
        }
        r->p = p + 1;
        yaml_push(r, Y_PAIR, 0, m);
        return Y_NONE;
    }
    if (c == ':' && !yaml_safe(next, true)) {
        if (yaml_open(r, false)) {
            yaml_fail_rule(r, YAML_KEY_SCALAR);
        }
        return Y_ERROR;
    }
    if (c != '\0' && yaml_ahead(r, p, true, &fail)) {
        if (!yaml_open(r, false)) {
            return Y_ERROR;
        }
        yaml_push(r, Y_PAIR, 1, m);
        yaml_ask(request, false, m, true, true, true);
        return Y_NONE;
    }
    yaml_ask(request, false, m, true, false, false);
    return Y_NONE;
}

/* A step of an open flow mapping ([140] to [149]), Codec::yamlFlowMappingStep; gives Y_DONE when it ends. */
static int yaml_flow_mapping_step(yaml_reader *r, yaml_frame *f, yaml_request *request)
{
    if (f->st == 5) {
        if (!yaml_flow_space(r, f->m)) {
            return Y_ERROR;
        }
        zend_long p = r->p;
        unsigned char c = yaml_at(r, p);
        if (c == ':' && (f->j || !yaml_safe(yaml_at(r, p + 1), true))) {
            r->p = p + 1;
            if (f->j || yaml_sep(yaml_at(r, p + 1))) {
                if (!yaml_flow_space(r, f->m)) {
                    return Y_ERROR;
                }
                c = yaml_at(r, r->p);
                if (c != ',' && c != '}') {
                    yaml_ask(request, false, f->m, true, false, false);
                    f->st = 3;
                    return Y_NONE;
                }
            }
        } else if (c != ',' && c != '}') {
            yaml_fail_parse(r, p);
            return Y_ERROR;
        }
        zval null;
        ZVAL_NULL(&null);
        yaml_member(&f->v, &f->k, &null);
        f->st = 4;
    }
    if (f->st == 0 || f->st == 4) {
        int entry = yaml_flow_entry(r, f->m, f->st == 4, '}');
        if (entry != Y_NONE) {
            return entry;
        }
    }
    zend_long p = r->p;
    unsigned char c = yaml_at(r, p), next = yaml_at(r, p + 1);
    if (c == '?' && yaml_sep(next)) {
        r->p = p + 1;
        if (!yaml_flow_space(r, f->m)) {
            return Y_ERROR;
        }
        p = r->p;
        c = yaml_at(r, p);
        next = yaml_at(r, p + 1);
        if (c == ',' || c == '}') {
            yaml_fail_rule(r, YAML_KEY_SCALAR);
            return Y_ERROR;
        }
    }
    if (c == ':' && !yaml_safe(next, true)) {
        yaml_fail_rule(r, YAML_KEY_SCALAR);
        return Y_ERROR;
    }
    yaml_ask(request, false, f->m, true, false, true);
    f->st = 2;
    return Y_NONE;
}

/* A step of the pair of a flow sequence, Codec::yamlPairStep: after `?`, its key; after its key, the `:` and the value, which is
 * empty when nothing follows (e-node). Gives Y_DONE when the pair ends with a null value. */
static int yaml_pair_step(yaml_reader *r, yaml_frame *f, yaml_request *request)
{
    if (f->st == 0) {
        if (!yaml_flow_space(r, f->m)) {
            return Y_ERROR;
        }
        zend_long p = r->p;
        unsigned char c = yaml_at(r, p);
        if ((c == ':' && !yaml_safe(yaml_at(r, p + 1), true)) || c == ',' || c == ']' || c == '}') {
            yaml_fail_rule(r, YAML_KEY_SCALAR);
            return Y_ERROR;
        }
        yaml_ask(request, false, f->m, true, false, true);
        f->st = 2;
        return Y_NONE;
    }
    if (f->st == 5) {
        if (!yaml_flow_space(r, f->m)) {
            return Y_ERROR;
        }
        zend_long p = r->p;
        if (yaml_at(r, p) != ':' || !(f->j || !yaml_safe(yaml_at(r, p + 1), true))) {
            return Y_DONE;
        }
        r->p = p + 1;
    }
    /* The value after the `:`, which follows a key that is no JSON node only after white space (c-ns-flow-map-separate-value). */
    if (!f->j && !yaml_sep(yaml_at(r, r->p))) {
        return Y_DONE;
    }
    if (!yaml_flow_space(r, f->m)) {
        return Y_ERROR;
    }
    unsigned char c = yaml_at(r, r->p);
    if (c == ',' || c == ']' || c == '}') {
        return Y_DONE;
    }
    yaml_ask(request, false, f->m, true, false, false);
    f->st = 3;
    return Y_NONE;
}

/* Pops the top frame: its array, or a map of its one pair, which takes pair, for a pair, is the value read; with no value, as for
 * the rest of a line, nothing is. Its open key is freed. */
static void yaml_pop(yaml_reader *r, zval *value, zval *pair)
{
    yaml_frame f = r->frames[--r->count];
    if (value == NULL) {
        zval_ptr_dtor(&f.v);
    } else if (f.t == Y_PAIR) {
        array_init(value);
        yaml_member(value, &f.k, pair);
    } else {
        ZVAL_COPY_VALUE(value, &f.v);
    }
    zval_ptr_dtor(&f.k);
}

/* The `:` after the key of an implicit entry, met on the line of the key. */
static bool yaml_colon(yaml_reader *r)
{
    zend_long p = r->p;
    while (p < r->end && (r->s[p] == ' ' || r->s[p] == '\t')) {
        p++;
    }
    if (yaml_at(r, p) != ':') {
        return yaml_fail_parse(r, p);
    }
    r->p = p + 1;
    return true;
}

/* Gives the node read, *value, to the top frame, Codec::yamlRead; *have stays true when a frame ends with it. */
static bool yaml_give(yaml_reader *r, zval *value, bool *json, bool *have, yaml_request *request)
{
    yaml_frame *f = yaml_top(r);
    switch (f->t) {
        case Y_TRAIL:
            if (!yaml_line_end(r)) {
                return false;
            }
            yaml_pop(r, NULL, NULL);
            *have = true;
            return true;
        case Y_BLOCK_SEQUENCE:
            zend_hash_next_index_insert(Z_ARRVAL(f->v), value);
            ZVAL_UNDEF(value);
            f->st = 2;
            return true;
        case Y_BLOCK_MAPPING:
            if (f->st == 1) {
                if (!yaml_key(r, f, value, *json) || !yaml_colon(r)) {
                    return false;
                }
                yaml_ask(request, true, f->m, true, Y_AT_COLON, false);
                f->st = 4;
            } else if (f->st == 2) {
                if (!yaml_key(r, f, value, *json)) {
                    return false;
                }
                f->st = 3;
            } else if (f->st == 4) {
                yaml_member(&f->v, &f->k, value);
                ZVAL_UNDEF(value);
                f->st = 5;
            } else {
                return yaml_fail_parse(r, f->f);
            }
            return true;
        case Y_FLOW_SEQUENCE:
            zend_hash_next_index_insert(Z_ARRVAL(f->v), value);
            ZVAL_UNDEF(value);
            f->st = 3;
            return true;
        case Y_FLOW_MAPPING:
            if (f->st == 2) {
                if (!yaml_key(r, f, value, *json)) {
                    return false;
                }
                f->st = 5;
            } else {
                yaml_member(&f->v, &f->k, value);
                ZVAL_UNDEF(value);
                f->st = 4;
            }
            return true;
        default:
            if (f->st == 3) {
                zval item;
                ZVAL_COPY_VALUE(&item, value);
                r->level--;
                yaml_pop(r, value, &item);
                *json = true;
                *have = true;
                return true;
            }
            zval_ptr_dtor(&f->k);
            ZVAL_COPY_VALUE(&f->k, value);
            ZVAL_UNDEF(value);
            f->j = *json;
            if (f->st == 1) {
                if (!yaml_colon(r)) {
                    return false;
                }
                f->st = 4;
            } else {
                f->st = 5;
            }
            return true;
    }
}

/* The node of a document, read by the frames of the open collections in an explicit stack in heap memory, so that no depth of the
 * stream and no depth of the caller decides the read (COD-70), Codec::yamlRead. where is where the node starts: on the next lines,
 * or on the line of `---`. */
static bool yaml_read_node(yaml_reader *r, int where, zval *out)
{
    yaml_request request;
    yaml_ask(&request, true, -1, false, where, false);
    bool have = false, json = false;
    zval value;
    ZVAL_UNDEF(&value);
    while (true) {
        if (request.set) {
            yaml_request asked = request;
            request.set = false;
            zval_ptr_dtor(&value);
            ZVAL_UNDEF(&value);
            int read = asked.block
                ? yaml_block_node(r, asked.n, asked.flag, asked.mode, asked.key, &request, &value, &json)
                : yaml_flow_node(r, asked.n, asked.flag, asked.mode != 0, asked.key, &value, &json);
            if (read == Y_ERROR) {
                break;
            }
            have = read == Y_DONE;
            continue;
        }
        if (r->count == 0) {
            ZVAL_COPY_VALUE(out, &value);
            return true;
        }
        if (have) {
            have = false;
            if (!yaml_give(r, &value, &json, &have, &request)) {
                break;
            }
            continue;
        }
        yaml_frame *f = yaml_top(r);
        int close = Y_NONE;
        switch (f->t) {
            case Y_BLOCK_SEQUENCE:
                if (f->st == 0) {
                    r->p++;
                    yaml_ask(&request, true, f->m, false, Y_AT_INDICATOR, false);
                    f->st = 1;
                    break;
                }
                {
                    zend_long indent = yaml_next_line(r);
                    if (indent < 0 || (indent == 0 && yaml_marker(r, r->p) != '\0')) {
                        close = Y_DONE;
                        break;
                    }
                    zend_long q = r->p + indent;
                    if (indent == f->m && r->s[q] == '-' && yaml_sep(yaml_at(r, q + 1))) {
                        r->p = q;
                        f->st = 0;
                    } else if (indent > f->m) {
                        yaml_fail_parse(r, yaml_text_start(r, q));
                        close = Y_ERROR;
                    } else {
                        close = Y_DONE;
                    }
                }
                break;
            case Y_BLOCK_MAPPING:
                close = yaml_block_mapping_step(r, f, &request);
                break;
            case Y_FLOW_SEQUENCE:
                close = yaml_flow_sequence_step(r, f, &request);
                break;
            case Y_FLOW_MAPPING:
                close = yaml_flow_mapping_step(r, f, &request);
                break;
            default: {
                int pair = yaml_pair_step(r, f, &request);
                if (pair == Y_DONE) {
                    zval null;
                    ZVAL_NULL(&null);
                    r->level--;
                    zval_ptr_dtor(&value);
                    yaml_pop(r, &value, &null);
                    json = true;
                    have = true;
                } else if (pair == Y_ERROR) {
                    close = Y_ERROR;
                }
                break;
            }
        }
        if (close == Y_ERROR) {
            break;
        }
        if (close == Y_DONE) {
            r->level--;
            zval_ptr_dtor(&value);
            yaml_pop(r, &value, NULL);
            json = true;
            have = true;
        }
    }
    zval_ptr_dtor(&value);
    return false;
}

/* The documents of the stream ([202] to [211], COD-75), Codec::yamlDocuments: directives, markers, comments and one document,
 * whose node is the value; a second document is met where it starts, and the reader reads nothing of it. */
static bool yaml_documents(yaml_reader *r, zval *out)
{
    bool read = false;
    ZVAL_NULL(out);
    while (true) {
        zend_long indent = yaml_next_line(r);
        if (indent < 0) {
            break;
        }
        zend_long p = r->p;
        if (read && (indent > 0 || yaml_marker(r, p) != '.')) {
            return yaml_fail_rule(r, "multiple documents are not supported");
        }
        if (indent == 0 && r->s[p] == '%') {
            if (!yaml_directives(r)) {
                return false;
            }
            p = r->p;
        }
        unsigned char marker = indent == 0 ? yaml_marker(r, p) : '\0';
        if (marker == '.') {
            r->p = p + 3;
            if (!yaml_line_end(r)) {
                return false;
            }
            continue;
        }
        if (marker == '-') {
            r->p = p + 3;
        }
        if (!yaml_read_node(r, marker == '-' ? Y_AT_DOCUMENT : Y_AT_LINES, out)) {
            return false;
        }
        read = true;
        indent = yaml_next_line(r);
        if (indent < 0) {
            break;
        }
        marker = indent == 0 ? yaml_marker(r, r->p) : '\0';
        if (marker == '-') {
            return yaml_fail_rule(r, "multiple documents are not supported");
        }
        if (marker != '.') {
            return yaml_fail_parse(r, r->p + indent);
        }
        r->p += 3;
        if (!yaml_line_end(r)) {
            return false;
        }
    }
    if (!read) {
        return yaml_fail_rule(r, "no document");
    }
    return true;
}

/* Codec::yamlDecode: one YAML document read with the YAML reader of orm (docs/spec/codec.md COD-74 to COD-80), the stream rules
 * first, then the stream by the grammar of YAML 1.2.2 in one pass, in its order, with the rules of COD-70 met where their node
 * starts. No library parses on this path; a stream that the grammar does not hold is yaml-parse, whose cause, a RuntimeException
 * as in Codec.php, names the line and the column where the stream leaves the grammar (COD-71, COD-80). Every allocation of the
 * read is freed on every path. */
static bool yaml_decode(zend_string *text, zval *out)
{
    if (!yaml_stream(text)) {
        return false;
    }
    const char *in = ZSTR_VAL(text);
    size_t n = ZSTR_LEN(text);
    if (n >= 3 && memcmp(in, "\xEF\xBB\xBF", 3) == 0) {
        in += 3;
        n -= 3;
    }
    /* A line break is CR LF, CR or LF, and each is one LF inside scalar content (COD-75); the lines and the columns of the text
     * are those of the stream. */
    yaml_reader r = {0};
    r.s = emalloc(n + 1);
    size_t len = 0;
    for (size_t i = 0; i < n; i++) {
        if (in[i] == '\r') {
            r.s[len++] = '\n';
            if (i + 1 < n && in[i + 1] == '\n') {
                i++;
            }
        } else {
            r.s[len++] = in[i];
        }
    }
    r.s[len] = '\0';
    r.len = r.end = (zend_long)len;
    r.at = -1;
    bool ok = yaml_documents(&r, out);
    while (r.count > 0) {
        yaml_frame *f = &r.frames[--r.count];
        zval_ptr_dtor(&f->v);
        zval_ptr_dtor(&f->k);
    }
    if (r.frames != NULL) {
        efree(r.frames);
    }
    smart_str_free(&r.text);
    if (ok) {
        efree(r.s);
        return true;
    }
    zval_ptr_dtor(out);
    ZVAL_UNDEF(out);
    if (r.rule != NULL) {
        efree(r.s);
        return yaml_rule(r.rule);
    }
    /* The line and the column of the place, each from 1, the column in Unicode characters, Codec::yamlParseError. */
    zend_long at = MIN(r.at, r.len), line = 1, start = 0, column = 1;
    for (zend_long i = 0; i < at; i++) {
        if (r.s[i] == '\n') {
            line++;
            start = i + 1;
        }
    }
    for (zend_long i = start; i < at; i++) {
        if (((unsigned char)r.s[i] & 0xC0) != 0x80) {
            column++;
        }
    }
    efree(r.s);
    zend_object *cause = library_cause("the stream leaves the YAML grammar at line " ZEND_LONG_FMT ", column " ZEND_LONG_FMT, line,
                                       column);
    return orm_failf_previous("CODEC_DECODE", cause, "yaml: the stream does not parse");
}

/* ---- YAML: the writer, the node model of purr and its Dumper, through the PHP library calls of the client ---- */

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
