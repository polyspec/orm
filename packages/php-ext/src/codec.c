/*
 * Polyspec\Orm\Codec of the PHP library (packages/php/src/Codec.php) in C. The dispatch of the stages, the byte work (gz with
 * libz, base64 strictly as the encoder writes it, the ip packing), the value checks and the error codes are made here, the same
 * as Codec.php. The parsers and writers that the library itself calls are called through the engine by the same public names:
 * Polyspec\OrderedJson\parse and stringify (the ordered-json value), Purr\Yaml (the YAML node model and CoreSchema) and
 * Symfony\Component\Yaml\Yaml::dump, and serialize, unserialize, json_encode and get_object_vars of PHP's own core. Each step
 * keeps the order and the exception classes of Codec.php, so a failure gives the same code.
 */
#include "codec.h"
#include "ext/json/php_json.h"
#include "ext/standard/base64.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include <arpa/inet.h>
#include <math.h>
#include <stdarg.h>
#include <string.h>
#include <zlib.h>

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

/* Whether the pending exception is an instance of the class named. */
static bool exception_is(const char *name)
{
    if (EG(exception) == NULL) {
        return false;
    }
    zend_string *n = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(n);
    zend_string_release(n);
    return ce != NULL && instanceof_function(EG(exception)->ce, ce);
}

/* Releases a string that may be NULL (a style that is not set). */
static void str_free(zend_string *s)
{
    if (s != NULL) {
        zend_string_release(s);
    }
}

/* Takes the pending exception and returns its message (a new string). */
static zend_string *take_message(void)
{
    zend_object *ex = EG(exception);
    zval rv;
    EG(exception) = NULL;
    zend_call_method_with_0_params(ex, ex->ce, NULL, "getmessage", &rv);
    zend_string *msg = zval_get_string(&rv);
    zval_ptr_dtor(&rv);
    OBJ_RELEASE(ex);
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

/* Calls a function with the warnings of its call silenced, as the @ operator does in Codec.php. */
static bool call_silenced(const char *name, zval *ret, uint32_t argc, zval *argv)
{
    zend_long saved = EG(error_reporting);
    EG(error_reporting) = 0;
    bool ok = call_fn(name, ret, argc, argv);
    EG(error_reporting) = saved;
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

/* Throws an OrmException with the code and the message (the message takes ownership). */
static bool orm_fail(const char *code, zend_string *msg)
{
    zend_class_entry *ce = class_named("Polyspec\\Orm\\OrmException");
    if (ce == NULL) {
        zend_string_release(msg);
        return false;
    }
    zval ex, args[2], rv;
    object_init_ex(&ex, ce);
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], msg);
    zend_call_method(Z_OBJ(ex), ce, NULL, ZEND_STRL("__construct"), &rv, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&ex);
        return false;
    }
    zend_throw_exception_object(&ex);
    return false;
}

static bool orm_failf(const char *code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    return orm_fail(code, msg);
}

/* A YAML step failed: its PHP exception (any Throwable, as Codec.php catches) or its own message in err. */
static bool yaml_fail(const char *code, zend_string *err)
{
    zend_string *msg = err;
    if (EG(exception) != NULL) {
        str_free(err);
        msg = take_message();
    }
    bool r = orm_failf(code, "yaml: %s", msg != NULL ? ZSTR_VAL(msg) : "unknown error");
    str_free(msg);
    return r;
}

static void err_set(zend_string **err, const char *msg)
{
    *err = zend_string_init(msg, strlen(msg), 0);
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

/* gzuncompress: the zlib stream of in, or NULL when it is not one. */
static zend_string *gz_inflate(zend_string *in)
{
    z_stream zs;
    memset(&zs, 0, sizeof zs);
    if (inflateInit(&zs) != Z_OK) {
        return NULL;
    }
    size_t cap = ZSTR_LEN(in) * 4 + 256, produced = 0;
    zend_string *out = zend_string_alloc(cap, 0);
    zs.next_in = (Bytef *)ZSTR_VAL(in);
    zs.avail_in = (uInt)ZSTR_LEN(in);
    for (;;) {
        zs.next_out = (Bytef *)ZSTR_VAL(out) + produced;
        zs.avail_out = (uInt)(cap - produced);
        int r = inflate(&zs, Z_NO_FLUSH);
        produced = cap - zs.avail_out;
        if (r == Z_STREAM_END) {
            break;
        }
        if (r == Z_OK && zs.avail_out == 0) {
            cap *= 2;
            out = zend_string_extend(out, cap, 0);
            continue;
        }
        inflateEnd(&zs);
        zend_string_release(out);
        return NULL;
    }
    inflateEnd(&zs);
    ZSTR_LEN(out) = produced;
    ZSTR_VAL(out)[produced] = '\0';
    return out;
}

/* gzcompress($data, 9): a zlib stream with the memory level of php_zlib_encode (MAX_MEM_LEVEL). */
static zend_string *gz_deflate(zend_string *in)
{
    z_stream zs;
    memset(&zs, 0, sizeof zs);
    if (deflateInit2(&zs, 9, Z_DEFLATED, MAX_WBITS, MAX_MEM_LEVEL, Z_DEFAULT_STRATEGY) != Z_OK) {
        return NULL;
    }
    uLong bound = deflateBound(&zs, (uLong)ZSTR_LEN(in));
    zend_string *out = zend_string_alloc(bound, 0);
    zs.next_in = (Bytef *)ZSTR_VAL(in);
    zs.avail_in = (uInt)ZSTR_LEN(in);
    zs.next_out = (Bytef *)ZSTR_VAL(out);
    zs.avail_out = (uInt)bound;
    int r = deflate(&zs, Z_FINISH);
    size_t produced = bound - zs.avail_out;
    deflateEnd(&zs);
    if (r != Z_STREAM_END) {
        zend_string_release(out);
        return NULL;
    }
    ZSTR_LEN(out) = produced;
    ZSTR_VAL(out)[produced] = '\0';
    return out;
}

/* preg_match('//u'): whether the bytes are valid UTF-8 (surrogates and code points above U+10FFFF are not). */
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

/* ---- YAML: the value model and the node model of purr, and Symfony's dump ---- */

/* validateYamlValue: the error message of a value that YAML cannot hold, or true. */
static bool yaml_validate(zval *v, zend_string **err)
{
    if (Z_TYPE_P(v) == IS_DOUBLE && !isfinite(Z_DVAL_P(v))) {
        err_set(err, "non-finite numbers are not supported");
        return false;
    }
    if (Z_TYPE_P(v) == IS_ARRAY) {
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), item)
        {
            if (!yaml_validate(item, err)) {
                return false;
            }
        }
        ZEND_HASH_FOREACH_END();
        return true;
    }
    switch (Z_TYPE_P(v)) {
        case IS_NULL:
        case IS_FALSE:
        case IS_TRUE:
        case IS_LONG:
        case IS_DOUBLE:
        case IS_STRING:
            return true;
        default:
            err_set(err, "value type is not supported");
            return false;
    }
}

static zend_string *line_message(const char *fmt, zend_long line)
{
    return zend_strpprintf(0, fmt, line);
}

static bool node_line(zval *node, zend_long *line)
{
    zval rv;
    if (!call_method(node, "getLine", &rv, 0, NULL)) {
        return false;
    }
    *line = zval_get_long(&rv);
    zval_ptr_dtor(&rv);
    return true;
}

/* Codec.php yamlNode: a purr node as a PHP value, with the checks of the codec's YAML rules. err gets the message of a rule. */
static bool yaml_node(zval *node, zval *schema, zval *out, zend_string **err)
{
    bool yes;
    zval rv;
    zend_long line;

    IS_A(node, "Purr\\Yaml\\Node\\AliasNode", yes);
    if (yes) {
        if (!node_line(node, &line)) {
            return false;
        }
        *err = line_message("aliases are not supported at line " ZEND_LONG_FMT, line);
        return false;
    }
    if (!call_method(node, "hasAnchor", &rv, 0, NULL)) {
        return false;
    }
    if (Z_TYPE(rv) == IS_TRUE) {
        if (!node_line(node, &line)) {
            return false;
        }
        *err = line_message("anchors are not supported at line " ZEND_LONG_FMT, line);
        return false;
    }
    zval tag;
    if (!call_method(node, "findTag", &tag, 0, NULL)) {
        return false;
    }
    if (Z_TYPE(tag) == IS_OBJECT) {
        zend_string *text = zval_get_string(&tag);
        zval_ptr_dtor(&tag);
        if (!node_line(node, &line)) {
            zend_string_release(text);
            return false;
        }
        *err = zend_strpprintf(0, "tag %s at line " ZEND_LONG_FMT " is not supported", ZSTR_VAL(text), line);
        zend_string_release(text);
        return false;
    }
    zval_ptr_dtor(&tag);

    IS_A(node, "Purr\\Yaml\\Node\\ScalarNode", yes);
    if (yes) {
        zval arg;
        ZVAL_COPY(&arg, node);
        bool ok = call_method(schema, "resolve", out, 1, &arg);
        zval_ptr_dtor(&arg);
        return ok;
    }

    IS_A(node, "Purr\\Yaml\\Node\\SequenceNode", yes);
    if (yes) {
        zval list, items;
        if (!call_method(node, "getItems", &list, 0, NULL)) {
            return false;
        }
        zval args[2];
        ZVAL_COPY_VALUE(&args[0], &list);
        ZVAL_FALSE(&args[1]);
        bool ok = call_fn("iterator_to_array", &items, 2, args);
        zval_ptr_dtor(&list);
        if (!ok) {
            return false;
        }
        array_init(out);
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(items), item)
        {
            zval val;
            if (!yaml_node(item, schema, &val, err)) {
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

    IS_A(node, "Purr\\Yaml\\Node\\MappingNode", yes);
    if (yes) {
        zval list, entries;
        if (!call_method(node, "getEntries", &list, 0, NULL)) {
            return false;
        }
        zval args[2];
        ZVAL_COPY_VALUE(&args[0], &list);
        ZVAL_FALSE(&args[1]);
        bool ok = call_fn("iterator_to_array", &entries, 2, args);
        zval_ptr_dtor(&list);
        if (!ok) {
            return false;
        }
        array_init(out);
        zval *entry;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(entries), entry)
        {
            zval merge, keynode, key, valnode, val;
            if (!call_method(entry, "isMerge", &merge, 0, NULL)) {
                goto fail;
            }
            if (Z_TYPE(merge) == IS_TRUE) {
                if (!call_method(entry, "getKey", &keynode, 0, NULL) || !node_line(&keynode, &line)) {
                    goto fail;
                }
                zval_ptr_dtor(&keynode);
                *err = line_message("merge keys are not supported at line " ZEND_LONG_FMT, line);
                goto fail;
            }
            if (!call_method(entry, "getKey", &keynode, 0, NULL)) {
                goto fail;
            }
            if (!yaml_node(&keynode, schema, &key, err)) {
                zval_ptr_dtor(&keynode);
                goto fail;
            }
            if (Z_TYPE(key) != IS_STRING && Z_TYPE(key) != IS_LONG) {
                zend_long kl = 0;
                if (!node_line(&keynode, &kl)) {
                    zval_ptr_dtor(&keynode);
                    zval_ptr_dtor(&key);
                    goto fail;
                }
                *err = line_message("map keys must be strings or integers at line " ZEND_LONG_FMT, kl);
                zval_ptr_dtor(&keynode);
                zval_ptr_dtor(&key);
                goto fail;
            }
            zval *exists = Z_TYPE(key) == IS_STRING ? zend_symtable_find(Z_ARRVAL_P(out), Z_STR(key))
                                                    : zend_hash_index_find(Z_ARRVAL_P(out), (zend_ulong)Z_LVAL(key));
            if (exists != NULL) {
                zend_long kl = 0;
                zend_string *ks = zval_get_string(&key);
                node_line(&keynode, &kl);
                *err = zend_strpprintf(0, "duplicate map key %s at line " ZEND_LONG_FMT, ZSTR_VAL(ks), kl);
                zend_string_release(ks);
                zval_ptr_dtor(&keynode);
                zval_ptr_dtor(&key);
                goto fail;
            }
            zval_ptr_dtor(&keynode);
            if (!call_method(entry, "getValue", &valnode, 0, NULL)) {
                zval_ptr_dtor(&key);
                goto fail;
            }
            if (!yaml_node(&valnode, schema, &val, err)) {
                zval_ptr_dtor(&valnode);
                zval_ptr_dtor(&key);
                goto fail;
            }
            zval_ptr_dtor(&valnode);
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

    *err = zend_strpprintf(0, "node %s is not supported", ZSTR_VAL(Z_OBJCE_P(node)->name));
    return false;
}

/* yamlDecode: one YAML document, read by purr and resolved by its core schema. */
static bool yaml_decode_text(zend_string *text, zval *out, zend_string **err)
{
    zend_class_entry *stream_ce = class_named("Purr\\Yaml\\YamlStream");
    zend_class_entry *schema_ce = class_named("Purr\\Yaml\\Schema\\CoreSchema");
    if (stream_ce == NULL || schema_ce == NULL) {
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
    if (n == 0) {
        zval_ptr_dtor(&docs);
        err_set(err, "no document");
        return false;
    }
    if (n > 1) {
        zval_ptr_dtor(&docs);
        err_set(err, "multiple documents are not supported");
        return false;
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
    ok = yaml_node(&root, &schema, out, err);
    zval_ptr_dtor(&root);
    zval_ptr_dtor(&schema);
    return ok;
}

/* Symfony's dump flags Codec.php passes: DUMP_EXCEPTION_ON_INVALID_TYPE, DUMP_EMPTY_ARRAY_AS_SEQUENCE and DUMP_NUMERIC_KEY_AS_STRING. */
#define YAML_DUMP_FLAGS (16 | 1024 | 4096)

static bool yaml_dump(zval *value, zval *out, zend_string **err)
{
    if (!yaml_validate(value, err)) {
        return false;
    }
    zval args[4];
    ZVAL_COPY(&args[0], value);
    ZVAL_LONG(&args[1], 20);
    ZVAL_LONG(&args[2], 2);
    ZVAL_LONG(&args[3], YAML_DUMP_FLAGS);
    bool ok = call_static("Symfony\\Component\\Yaml\\Yaml", "dump", out, 4, args);
    for (int i = 0; i < 4; i++) {
        zval_ptr_dtor(&args[i]);
    }
    return ok;
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

static bool json_text(zval *v, smart_str *out);

/* The map form of Codec.php: each key as its string's JSON text, then ':' and the member's text. */
static bool json_map(HashTable *ht, smart_str *out)
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
        zend_string *k = key != NULL ? zend_string_copy(key) : zend_long_to_str((zend_long)idx);
        zval kz;
        ZVAL_STR(&kz, k);
        bool ok = json_scalar(&kz, out);
        zval_ptr_dtor(&kz);
        if (!ok) {
            return false;
        }
        smart_str_appendc(out, ':');
        if (!json_text(item, out)) {
            return false;
        }
    }
    ZEND_HASH_FOREACH_END();
    smart_str_appendc(out, '}');
    return true;
}

static bool json_text(zval *v, smart_str *out)
{
    bool yes;
    if (Z_TYPE_P(v) == IS_OBJECT) {
        IS_A(v, "Polyspec\\OrderedJson\\Value", yes);
        if (yes) {
            zval s;
            if (!call_fn("Polyspec\\OrderedJson\\stringify", &s, 1, v)) {
                return false;
            }
            smart_str_append(out, Z_STR(s));
            zval_ptr_dtor(&s);
            return true;
        }
    }
    if (Z_TYPE_P(v) == IS_ARRAY) {
        HashTable *ht = Z_ARRVAL_P(v);
        if (zend_array_is_list(ht)) {
            smart_str_appendc(out, '[');
            bool first = true;
            zval *item;
            ZEND_HASH_FOREACH_VAL(ht, item)
            {
                if (!first) {
                    smart_str_appendc(out, ',');
                }
                first = false;
                if (!json_text(item, out)) {
                    return false;
                }
            }
            ZEND_HASH_FOREACH_END();
            smart_str_appendc(out, ']');
            return true;
        }
        return json_map(ht, out);
    }
    if (Z_TYPE_P(v) == IS_OBJECT) {
        IS_A(v, "stdClass", yes);
        if (yes) {
            zval props;
            if (!call_fn("get_object_vars", &props, 1, v)) {
                return false;
            }
            bool ok = json_map(Z_ARRVAL(props), out);
            zval_ptr_dtor(&props);
            return ok;
        }
        IS_A(v, "JsonSerializable", yes);
        if (yes) {
            zval s;
            if (!call_method(v, "jsonSerialize", &s, 0, NULL)) {
                return false;
            }
            bool ok = json_text(&s, out);
            zval_ptr_dtor(&s);
            return ok;
        }
    }
    if (Z_TYPE_P(v) == IS_OBJECT || Z_TYPE_P(v) == IS_RESOURCE) {
        zval type;
        if (!call_fn("get_debug_type", &type, 1, v)) {
            return false;
        }
        zend_string *msg = zend_strpprintf(0, "json: %s is not a JSON value", Z_STRVAL(type));
        zval_ptr_dtor(&type);
        return orm_fail("CODEC_ENCODE", msg);
    }
    return json_scalar(v, out);
}

/* ---- host stages: the ip packing (INET6_ATON) ---- */

/* packIp: the packed address of the exact text s, or false (the caller gives the error). */
static bool ip_pack(zend_string *s, zend_string **packed)
{
    if (memchr(ZSTR_VAL(s), '\0', ZSTR_LEN(s)) != NULL) {
        return false;
    }
    unsigned char buf[16];
    if (inet_pton(AF_INET, ZSTR_VAL(s), buf) == 1) {
        *packed = zend_string_init((char *)buf, 4, 0);
        return true;
    }
    if (inet_pton(AF_INET6, ZSTR_VAL(s), buf) == 1) {
        static const unsigned char mapped[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff};
        if (memcmp(buf, mapped, 12) == 0) {
            *packed = zend_string_init((char *)buf + 12, 4, 0);
        } else {
            *packed = zend_string_init((char *)buf, 16, 0);
        }
        return true;
    }
    return false;
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

bool codec_unsupported(const char *method, const char *row)
{
    return orm_failf("CODEC_UNSUPPORTED", "Codec::%s is not implemented by the extension yet (%s)", method, row);
}

static bool decode_stages(HashTable *styles, zval *raw, zval *ret)
{
    zend_long n = zend_hash_num_elements(styles);
    zval cur;
    ZVAL_COPY(&cur, raw);

    if (Z_TYPE(cur) == IS_RESOURCE) {
        zval s;
        if (!call_fn("stream_get_contents", &s, 1, &cur)) {
            zval_ptr_dtor(&cur);
            return false;
        }
        zval_ptr_dtor(&cur);
        ZVAL_COPY_VALUE(&cur, &s);
    }
    if (Z_TYPE(cur) == IS_NULL) {
        zval_ptr_dtor(&cur);
        return call_static("Polyspec\\Orm\\StyledValue", "sqlNull", ret, 0, NULL);
    }
    zend_string *last = n > 0 ? style_at(styles, n - 1) : NULL;
    /* An empty cell is CODEC_DECODE, except under a last base64 stage (docs/spec/codec.md, Stage lists). */
    if (Z_TYPE(cur) == IS_STRING && Z_STRLEN(cur) == 0 && !streq(last, "base64")) {
        str_free(last);
        zval_ptr_dtor(&cur);
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("styled cell is empty"), 0));
    }
    if (Z_TYPE(cur) != IS_STRING) {
        str_free(last);
        zval_ptr_dtor(&cur);
        return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("cell is not a string"), 0));
    }
    zval original;
    ZVAL_COPY(&original, &cur);

    for (zend_long i = n - 1; i >= 0; i--) {
        zend_string *st = style_at(styles, i);
        bool ok = true;
        if (streq(st, "gz")) {
            if (!need_string(&cur, "gzuncompress")) {
                ok = false;
            } else {
                zend_string *out = gz_inflate(Z_STR(cur));
                if (out == NULL) {
                    ok = orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("gz: bad zlib stream"), 0));
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
                bool same = false;
                if (dec != NULL) {
                    zend_string *re = php_base64_encode((const unsigned char *)ZSTR_VAL(dec), ZSTR_LEN(dec));
                    same = zend_string_equals(re, Z_STR(cur));
                    zend_string_release(re);
                }
                if (dec == NULL || !same) {
                    if (dec != NULL) {
                        zend_string_release(dec);
                    }
                    ok = orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("base64: bad input"), 0));
                } else {
                    zval_ptr_dtor(&cur);
                    ZVAL_STR(&cur, dec);
                }
            }
        } else if (streq(st, "serialize")) {
            if (!need_string(&cur, "unserialize")) {
                ok = false;
            } else {
                const char *s = Z_STRVAL(cur);
                size_t len = Z_STRLEN(cur);
                bool object_form = len >= 2 && strchr("OCrR", s[0]) != NULL && s[1] == ':';
                if (object_form || zend_memnstr(s, ";O:", 3, s + len) != NULL || zend_memnstr(s, ";C:", 3, s + len) != NULL) {
                    ok = orm_fail("CODEC_UNSUPPORTED", zend_string_init(ZEND_STRL("serialize: objects and references are not supported"), 0));
                } else {
                    zval args[2], opts, result;
                    array_init(&opts);
                    add_assoc_bool(&opts, "allowed_classes", false);
                    ZVAL_COPY(&args[0], &cur);
                    ZVAL_COPY_VALUE(&args[1], &opts);
                    ok = call_silenced("unserialize", &result, 2, args);
                    zval_ptr_dtor(&args[0]);
                    zval_ptr_dtor(&args[1]);
                    if (ok && Z_TYPE(result) == IS_FALSE) {
                        /* $raw !== serialize(false), which is "b:0;" */
                        bool is_false_text = Z_TYPE(original) == IS_STRING && zend_string_equals_literal(Z_STR(original), "b:0;");
                        if (!is_false_text) {
                            zval_ptr_dtor(&result);
                            ok = orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("serialize: bad format"), 0));
                        }
                    }
                    if (ok) {
                        zval_ptr_dtor(&cur);
                        ZVAL_COPY_VALUE(&cur, &result);
                    }
                }
            }
        } else if (streq(st, "yaml")) {
            zend_string *err = NULL;
            zval value;
            if (!need_string(&cur, "Yaml")) {
                ok = false;
            } else if (!yaml_decode_text(Z_STR(cur), &value, &err)) {
                ok = yaml_fail("CODEC_DECODE", err);
            } else if (!yaml_validate(&value, &err)) {
                zval_ptr_dtor(&value);
                ok = yaml_fail("CODEC_DECODE", err);
            } else {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &value);
            }
        } else if (streq(st, "ordered_json")) {
            if (!need_string(&cur, "Polyspec\\OrderedJson\\parse")) {
                ok = false;
            } else {
                zval parsed;
                if (!call_fn("Polyspec\\OrderedJson\\parse", &parsed, 1, &cur)) {
                    if (exception_is("InvalidArgumentException")) {
                        zend_string *m = take_message();
                        ok = orm_failf("CODEC_DECODE", "json: %s", ZSTR_VAL(m));
                        zend_string_release(m);
                    } else {
                        ok = false;
                    }
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
            str_free(last);
            zval_ptr_dtor(&cur);
            zval_ptr_dtor(&original);
            return false;
        }
    }
    zval_ptr_dtor(&original);

    /* Without a value stage (a list that starts with gz or base64) the value is the text of the bytes. */
    zend_string *first = style_at(styles, 0);
    if ((streq(first, "gz") || streq(first, "base64"))) {
        if (!need_string(&cur, "preg_match")) {
            str_free(first);
            str_free(last);
            zval_ptr_dtor(&cur);
            return false;
        }
        if (!valid_utf8((const unsigned char *)Z_STRVAL(cur), Z_STRLEN(cur))) {
            str_free(first);
            str_free(last);
            zval_ptr_dtor(&cur);
            return orm_fail("CODEC_DECODE", zend_string_init(ZEND_STRL("decoded text is not valid UTF-8"), 0));
        }
    }
    str_free(first);
    str_free(last);

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
    if ((streq(first, "gz") || streq(first, "base64")) && Z_TYPE(value) != IS_STRING) {
        zval type;
        bool named = call_fn("get_debug_type", &type, 1, &value);
        if (named) {
            /* "{$styles[0]}: the value is <type>, not a string" */
            orm_failf("CODEC_ENCODE", "%s: the value is %s, not a string", ZSTR_VAL(first), Z_STRVAL(type));
            zval_ptr_dtor(&type);
        }
        str_free(first);
        zval_ptr_dtor(&value);
        return false;
    }
    str_free(first);

    zval cur;
    ZVAL_COPY(&cur, &value);
    for (zend_long i = 0; i < n; i++) {
        zend_string *st = style_at(styles, i);
        bool ok = true;
        if (streq(st, "serialize")) {
            zval s;
            ok = call_fn("serialize", &s, 1, &value);
            if (ok) {
                zval_ptr_dtor(&cur);
                ZVAL_COPY_VALUE(&cur, &s);
            }
        } else if (streq(st, "yaml")) {
            if (i != 0) {
                ok = orm_fail("CODEC_UNSUPPORTED", zend_string_init(ZEND_STRL("yaml must be the first style"), 0));
            } else {
                zend_string *err = NULL;
                zval s;
                if (!yaml_dump(&value, &s, &err)) {
                    ok = yaml_fail("CODEC_ENCODE", err);
                } else {
                    zval_ptr_dtor(&cur);
                    ZVAL_COPY_VALUE(&cur, &s);
                }
            }
        } else if (streq(st, "ordered_json")) {
            smart_str buf = {0};
            zval text, parsed, s;
            if (!json_text(&value, &buf)) {
                ok = false;
            } else {
                ZVAL_STR(&text, smart_str_extract(&buf));
                if (!call_fn("Polyspec\\OrderedJson\\parse", &parsed, 1, &text)) {
                    ok = false;
                } else if (!call_fn("Polyspec\\OrderedJson\\stringify", &s, 1, &parsed)) {
                    zval_ptr_dtor(&parsed);
                    ok = false;
                } else {
                    zval_ptr_dtor(&parsed);
                    zval_ptr_dtor(&cur);
                    ZVAL_COPY_VALUE(&cur, &s);
                }
                zval_ptr_dtor(&text);
            }
            smart_str_free(&buf);
            if (!ok && (exception_is("JsonException") || exception_is("InvalidArgumentException"))) {
                zend_string *m = take_message();
                ok = orm_failf("CODEC_ENCODE", "json: %s", ZSTR_VAL(m));
                zend_string_release(m);
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
                zend_string *enc = gz_deflate(Z_STR(cur));
                if (enc == NULL) {
                    ok = orm_fail("CODEC_ENCODE", zend_string_init(ZEND_STRL("gz: the compression failed"), 0));
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

bool codec_host_encode(zval *v, HashTable *styles, zend_string *aes_key, zval *ret)
{
    if (Z_TYPE_P(v) == IS_NULL) {
        ZVAL_NULL(ret);
        return true;
    }
    zend_string *cur;
    bool yes;
    zval rv;
    IS_A(v, "Polyspec\\Orm\\Bytes", yes);
    if (yes) {
        zval *b = read_prop(v, "bytes", &rv);
        cur = zval_get_string(b);
    } else {
        cur = zval_get_string(v);
    }

    zend_long n = zend_hash_num_elements(styles);
    for (zend_long i = 0; i < n; i++) {
        zend_string *st = style_at(styles, i);
        if (streq(st, "ip")) {
            zend_string *packed = NULL;
            if (!ip_pack(cur, &packed)) {
                str_free(st);
                zend_string_release(cur);
                return orm_failf("CODEC_ENCODE", "ip: \"%s\" is not an address", ZSTR_VAL(cur));
            }
            zend_string_release(cur);
            cur = packed;
        } else {
            bool ok = orm_failf("CODEC_UNSUPPORTED", "host style %s is not implemented by the extension yet (aes and hex are the codec rows T182-2-2 and T182-2-3)", st != NULL ? ZSTR_VAL(st) : "");
            str_free(st);
            zend_string_release(cur);
            return ok;
        }
        str_free(st);
    }
    zend_string *last = n > 0 ? style_at(styles, n - 1) : NULL;
    bool hex = streq(last, "hex");
    str_free(last);
    if (hex) {
        ZVAL_STR(ret, cur);
        return true;
    }
    return make_bytes(cur, ret);
}
