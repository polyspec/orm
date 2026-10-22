/*
 * Polyspec\Orm\Validator of the PHP library (packages/php/src/Validator.php) in C. The checks, their order and their error codes and
 * messages are those of Validator.php. The library code that the validator calls is called through the engine by its public name:
 * Polyspec\Orm\RuntimeModel::column and ::numeric (the schema model), Polyspec\Orm\Dbspec\Meet::kind (the type classes that join
 * compares), Polyspec\Orm\Dialect::isValueFunction and the Dialect constants of the function tables. The request is read as PHP arrays.
 */
#include "validator.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_interfaces.h"
#include <stdarg.h>
#include <string.h>

#define RUNTIME_MODEL "Polyspec\\Orm\\RuntimeModel"
#define META_MEET "Polyspec\\Orm\\Dbspec\\Meet"
#define DIALECT "Polyspec\\Orm\\Dialect"
#define IR_INVALID "IR_INVALID"

/* ---- engine helpers ---- */

/* Values kept until the public call returns: they are released by release(). */
typedef struct vtemp {
    zval v;
    struct vtemp *next;
} vtemp;

typedef struct {
    zval *self;           /* the Validator object, NULL in the static methods */
    HashTable *entities;  /* the entities of the RuntimeModel, borrowed from the model */
    zend_long n;          /* the n_params of the request */
    vtemp *temps;
} vctx;

/* A scope of the query tree: root, outer (NULL outside a subquery) and node, each an array (name, ent, joins). */
typedef struct {
    zval *root;
    zval *outer;
    zval *node;
} vat;

static zval *keep(vctx *c)
{
    vtemp *t = emalloc(sizeof(vtemp));
    ZVAL_UNDEF(&t->v);
    t->next = c->temps;
    c->temps = t;
    return &t->v;
}

static void release(vctx *c)
{
    vtemp *t = c->temps;
    while (t != NULL) {
        vtemp *next = t->next;
        zval_ptr_dtor(&t->v);
        efree(t);
        t = next;
    }
    c->temps = NULL;
}

/* Throws an OrmException with the code and the formatted message; returns false for the caller to return. */
static bool fail(const char *code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    zend_string *cn = zend_string_init("Polyspec\\Orm\\OrmException", sizeof("Polyspec\\Orm\\OrmException") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(cn);
    zend_string_release(cn);
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

#define TRY(expr)              \
    do {                       \
        if (!(expr)) {         \
            return false;      \
        }                      \
    } while (0)

/* A string value of z as a kept C string; NULL and missing values give "". */
static const char *sv(vctx *c, zval *z)
{
    if (z == NULL) {
        return "";
    }
    if (Z_TYPE_P(z) == IS_STRING) {
        return Z_STRVAL_P(z);
    }
    zval *k = keep(c);
    ZVAL_STR(k, zval_get_string(z));
    return Z_STRVAL_P(k);
}

static const char *kstrl(vctx *c, const char *s, size_t len)
{
    zval *k = keep(c);
    ZVAL_STRINGL(k, s, len);
    return Z_STRVAL_P(k);
}

static HashTable *ha(zval *z)
{
    return (z != NULL && Z_TYPE_P(z) == IS_ARRAY) ? Z_ARRVAL_P(z) : NULL;
}

/* The array of h or the empty array, for iterating an absent list. */
static HashTable *arr_or_empty(HashTable *h)
{
    return h != NULL ? h : (HashTable *)&zend_empty_array;
}

/* $h[$k] with ?? semantics: NULL when the key is missing or null. */
static zval *get(HashTable *h, const char *k)
{
    if (h == NULL) {
        return NULL;
    }
    zval *v = zend_symtable_str_find(h, k, strlen(k));
    if (v == NULL) {
        return NULL;
    }
    ZVAL_DEREF(v);
    return Z_TYPE_P(v) == IS_NULL ? NULL : v;
}

static bool has(HashTable *h, const char *k)
{
    return get(h, k) != NULL;
}

static const char *str(vctx *c, HashTable *h, const char *k, const char *dflt)
{
    zval *v = get(h, k);
    return v != NULL ? sv(c, v) : dflt;
}

static zend_long num(HashTable *h, const char *k, zend_long dflt)
{
    zval *v = get(h, k);
    return v != NULL ? zval_get_long(v) : dflt;
}

static bool flag(HashTable *h, const char *k)
{
    zval *v = get(h, k);
    return v != NULL && zend_is_true(v);
}

/* count($x) > 0 for ($x ?? []) !== []. */
static bool has_items(HashTable *h)
{
    return h != NULL && zend_hash_num_elements(h) > 0;
}

static bool streq(const char *a, const char *b)
{
    return strcmp(a, b) == 0;
}

static bool zv_eq_str(zval *z, const char *s)
{
    return z != NULL && Z_TYPE_P(z) == IS_STRING && streq(Z_STRVAL_P(z), s);
}

static bool in_strs(const char *s, const char *const *list, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (streq(s, list[i])) {
            return true;
        }
    }
    return false;
}

#define IN(s, list) in_strs((s), (list), sizeof(list) / sizeof((list)[0]))

static void set_add(HashTable *set, const char *k)
{
    zval t;
    ZVAL_TRUE(&t);
    zend_symtable_str_update(set, k, strlen(k), &t);
}

static bool set_has(HashTable *set, const char *k)
{
    return zend_symtable_str_find(set, k, strlen(k)) != NULL;
}

/* A new empty PHP array held by the context. */
static HashTable *new_set(vctx *c)
{
    zval *z = keep(c);
    array_init(z);
    return Z_ARRVAL_P(z);
}

/* ---- library calls ---- */

/* Calls a public static method of a library class; the result is kept, or NULL with an exception. */
static zval *lib_call(vctx *c, const char *cls, const char *method, uint32_t argc, zval *argv)
{
    zval cb;
    zval *ret = keep(c);
    ZVAL_UNDEF(ret);
    array_init(&cb);
    add_next_index_string(&cb, cls);
    add_next_index_string(&cb, method);
    zend_result r = call_user_function(NULL, NULL, &cb, ret, argc, argv);
    zval_ptr_dtor(&cb);
    if (r != SUCCESS || EG(exception) != NULL) {
        return NULL;
    }
    return ret;
}

/* RuntimeModel::column($entity, $name): the column array, or NULL when the entity has no such column. */
static bool col_of(vctx *c, HashTable *ent, const char *name, HashTable **out)
{
    zval args[2];
    zval e;
    if (ent != NULL) {
        ZVAL_ARR(&e, ent);
    } else {
        ZVAL_NULL(&e);
    }
    ZVAL_COPY_VALUE(&args[0], &e);
    ZVAL_STRING(&args[1], name);
    zval *r = lib_call(c, RUNTIME_MODEL, "column", 2, args);
    zval_ptr_dtor(&args[1]);
    if (r == NULL) {
        return false;
    }
    *out = Z_TYPE_P(r) == IS_ARRAY ? Z_ARRVAL_P(r) : NULL;
    return true;
}

/* RuntimeModel::numeric($column). */
static bool numeric(vctx *c, HashTable *col, bool *yes)
{
    zval arg;
    ZVAL_ARR(&arg, col);
    zval *r = lib_call(c, RUNTIME_MODEL, "numeric", 1, &arg);
    if (r == NULL) {
        return false;
    }
    *yes = zend_is_true(r);
    return true;
}

/* Meet::kind of a column: its type, scale and precision. */
static bool kind_of(vctx *c, HashTable *col, zend_string **out)
{
    zval args[3];
    zval *t = get(col, "type");
    if (t != NULL) {
        ZVAL_COPY_VALUE(&args[0], t);
    } else {
        ZVAL_EMPTY_STRING(&args[0]);
    }
    ZVAL_LONG(&args[1], num(col, "scale", 0));
    ZVAL_LONG(&args[2], num(col, "precision", 0));
    zval *r = lib_call(c, META_MEET, "kind", 3, args);
    if (r == NULL) {
        return false;
    }
    *out = Z_STR_P(r);
    return true;
}

static bool meets(vctx *c, HashTable *a, HashTable *b, bool *yes)
{
    zend_string *ka, *kb;
    if (!kind_of(c, a, &ka) || !kind_of(c, b, &kb)) {
        return false;
    }
    *yes = zend_string_equals(ka, kb);
    return true;
}

/* Dialect::isValueFunction($name). */
static bool is_value_function(vctx *c, const char *name, bool *yes)
{
    zval arg;
    ZVAL_STRING(&arg, name);
    zval *r = lib_call(c, DIALECT, "isValueFunction", 1, &arg);
    zval_ptr_dtor(&arg);
    if (r == NULL) {
        return false;
    }
    *yes = zend_is_true(r);
    return true;
}

/* A public constant of Dialect (its function tables). */
static HashTable *dialect_table(vctx *c, const char *name)
{
    zend_string *cn = zend_string_init(DIALECT, sizeof(DIALECT) - 1, 0);
    zend_string *kn = zend_string_init(name, strlen(name), 0);
    zval *v = NULL;
    if (zend_lookup_class(cn) != NULL) {
        v = zend_get_class_constant_ex(cn, kn, NULL, 0);
    }
    zend_string_release(cn);
    zend_string_release(kn);
    (void)c;
    return (v != NULL && Z_TYPE_P(v) == IS_ARRAY) ? Z_ARRVAL_P(v) : NULL;
}

/* ---- the operator tables of Validator.php ---- */

static const char *const CMP_OPS[] = {"eq", "not_eq", "gt", "gte", "lt", "lte"};
static const char *const ORDERED[] = {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"};
static const char *const EQUALITY[] = {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"};
static const char *const VARCHAR_OPS[] = {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "contains_binary", "is_null", "is_not_null"};
static const char *const TEXT_OPS[] = {"eq", "not_eq", "gt", "gte", "lt", "lte", "contains", "contains_binary", "is_null", "is_not_null"};
static const char *const BOOL_OPS[] = {"eq", "not_eq", "is_null", "is_not_null"};
static const char *const COL_OPS[] = {"eq_col", "not_eq_col", "gt_col", "gte_col", "lt_col", "lte_col"};

typedef struct {
    const char *type;
    const char *const *ops;
    size_t n;
} type_ops;

#define OPS(name) name, sizeof(name) / sizeof((name)[0])
static const type_ops OPS_BY_TYPE[] = {
    {"i16", OPS(ORDERED)}, {"i32", OPS(ORDERED)}, {"i64", OPS(ORDERED)}, {"f64", OPS(ORDERED)}, {"decimal", OPS(ORDERED)},
    {"date", OPS(ORDERED)}, {"time", OPS(ORDERED)}, {"datetime", OPS(ORDERED)},
    {"varchar", OPS(VARCHAR_OPS)}, {"text", OPS(TEXT_OPS)}, {"uuid", OPS(EQUALITY)}, {"bool", OPS(BOOL_OPS)}, {"bytes", OPS(EQUALITY)},
};

static const type_ops *ops_of_type(const char *type)
{
    for (size_t i = 0; i < sizeof(OPS_BY_TYPE) / sizeof(OPS_BY_TYPE[0]); i++) {
        if (streq(OPS_BY_TYPE[i].type, type)) {
            return &OPS_BY_TYPE[i];
        }
    }
    return NULL;
}

/* Whether the list of a column (codec) is exactly the one name given. */
static bool codec_is(HashTable *col, const char *name)
{
    HashTable *codec = ha(get(col, "codec"));
    if (codec == NULL || zend_hash_num_elements(codec) != 1) {
        return false;
    }
    zval *first = zend_hash_index_find(codec, 0);
    return first != NULL && zv_eq_str(first, name);
}

static bool has_codec(HashTable *col)
{
    return has_items(ha(get(col, "codec")));
}

/* Validator::opAllowed. */
bool validator_op_allowed(HashTable *col, zend_string *op)
{
    const char *o = ZSTR_VAL(op);
    if (IN(o, COL_OPS)) {
        return true;
    }
    HashTable *codec = ha(get(col, "codec"));
    if (has_items(codec)) {
        bool hex_ip_only = true;
        zval *v;
        ZEND_HASH_FOREACH_VAL(codec, v)
        {
            if (!zv_eq_str(v, "hex") && !zv_eq_str(v, "ip")) {
                hex_ip_only = false;
            }
        }
        ZEND_HASH_FOREACH_END();
        zval *first = zend_hash_index_find(codec, 0);
        if (zv_eq_str(first, "aes") || hex_ip_only) {
            return IN(o, EQUALITY);
        }
        return streq(o, "is_null") || streq(o, "is_not_null");
    }
    zval *t = get(col, "type");
    if (t == NULL || Z_TYPE_P(t) != IS_STRING) {
        return false;
    }
    const type_ops *ops = ops_of_type(Z_STRVAL_P(t));
    return ops != NULL && in_strs(o, ops->ops, ops->n);
}

/* Validator::colPairOpAllowed. */
static bool col_pair_op_allowed(HashTable *left, HashTable *right, const char *op)
{
    size_t len = strlen(op);
    char base[64];
    size_t blen = len >= 4 ? len - 4 : 0;
    memcpy(base, op, blen);
    base[blen] = '\0';
    if (!has_codec(left) && !has_codec(right)) {
        zval *t = get(left, "type");
        const type_ops *ops = (t != NULL && Z_TYPE_P(t) == IS_STRING) ? ops_of_type(Z_STRVAL_P(t)) : NULL;
        return ops != NULL && in_strs(base, ops->ops, ops->n);
    }
    return codec_is(left, "ip") && codec_is(right, "ip") && (streq(base, "eq") || streq(base, "not_eq"));
}

/* ---- the request shape (Validator::shape, typed) ---- */

typedef struct {
    const char *field;
    const char *type;
} field_t;

#define FIELDS(name) name, sizeof(name) / sizeof((name)[0])

static const field_t QUERY_FIELDS[] = {
    {"entity", "string"}, {"columns", "Columns"}, {"on", "Group"}, {"where", "Group"}, {"joins", "list<Join>"},
    {"relations", "list<Relation>"}, {"order", "list<Order>"}, {"group_by", "list<string>"},
    {"limit", "Limit"}, {"force_index", "string"}, {"lock", "string"}, {"key_by", "string"}, {"flatten", "bool"},
    {"limit_per_parent", "int"}, {"if_parent", "IfParent"}, {"no_cascade_delete", "bool"},
};
static const field_t REQUEST_FIELDS[] = {
    {"entity", "string"}, {"columns", "Columns"}, {"on", "Group"}, {"where", "Group"}, {"joins", "list<Join>"},
    {"relations", "list<Relation>"}, {"order", "list<Order>"}, {"group_by", "list<string>"},
    {"limit", "Limit"}, {"force_index", "string"}, {"lock", "string"}, {"key_by", "string"}, {"flatten", "bool"},
    {"limit_per_parent", "int"}, {"if_parent", "IfParent"}, {"no_cascade_delete", "bool"},
    {"ir_version", "int"}, {"manifest_hash", "string"}, {"kind", "string"}, {"load", "bool"}, {"set", "list<Assign>"},
    {"on_duplicate", "list<Assign>"}, {"rows", "list<list<int>>"}, {"optimistic", "Optimist"}, {"agg", "string"}, {"n_params", "int"},
};
static const field_t COLUMNS_FIELDS[] = {{"mode", "string"}, {"add", "list<string>"}, {"remove", "list<string>"}, {"fn", "map<ColFunc>"}, {"sub", "map<Sub>"}};
static const field_t FUNC_FIELDS[] = {{"name", "string"}, {"ps", "list<int>"}};
static const field_t COLFUNC_FIELDS[] = {{"column", "string"}, {"fn", "Func"}};
static const field_t SUB_FIELDS[] = {{"query", "Query"}, {"column", "string"}, {"agg", "string"}};
static const field_t JOIN_FIELDS[] = {{"rel", "string"}, {"kind", "string"}, {"query", "Query"}, {"left", "string"}, {"right", "string"}};
static const field_t RELATION_FIELDS[] = {{"rel", "string"}, {"query", "Query"}, {"kind", "string"}, {"keys", "list<KeyPair>"}};
static const field_t KEYPAIR_FIELDS[] = {{"left", "string"}, {"right", "string"}};
static const field_t GROUP_FIELDS[] = {{"conn", "string"}, {"not", "bool"}, {"items", "list<Item>"}};
static const field_t ITEM_FIELDS[] = {{"pred", "Pred"}, {"group", "Group"}, {"joined", "JoinedRef"}};
static const field_t JOINEDREF_FIELDS[] = {{"conn", "string"}, {"join", "string"}};
static const field_t PRED_FIELDS[] = {
    {"conn", "string"}, {"column", "string"}, {"op", "string"}, {"p", "int"}, {"ps", "list<int>"}, {"ref", "ColRef"},
    {"fn", "Func"}, {"value", "Func"}, {"cols", "list<string>"}, {"sub", "Sub"},
};
static const field_t COLREF_FIELDS[] = {{"path", "string"}, {"column", "string"}};
static const field_t ORDER_FIELDS[] = {{"column", "string"}, {"desc", "bool"}, {"random", "bool"}, {"fn", "Func"}};
static const field_t LIMIT_FIELDS[] = {{"offset", "int"}, {"count", "int"}};
static const field_t IFPARENT_FIELDS[] = {{"column", "string"}, {"p", "int"}};
static const field_t ASSIGN_FIELDS[] = {{"column", "string"}, {"p", "int"}, {"null", "bool"}, {"plus_p", "int"}, {"minus_p", "int"}};
static const field_t OPTIMIST_FIELDS[] = {{"column", "string"}, {"p", "int"}};

typedef struct {
    const char *name;
    const field_t *fields;
    size_t n;
} record_t;

static const record_t RECORDS[] = {
    {"Request", FIELDS(REQUEST_FIELDS)}, {"Query", FIELDS(QUERY_FIELDS)}, {"Columns", FIELDS(COLUMNS_FIELDS)},
    {"Func", FIELDS(FUNC_FIELDS)}, {"ColFunc", FIELDS(COLFUNC_FIELDS)}, {"Sub", FIELDS(SUB_FIELDS)}, {"Join", FIELDS(JOIN_FIELDS)},
    {"Relation", FIELDS(RELATION_FIELDS)}, {"KeyPair", FIELDS(KEYPAIR_FIELDS)}, {"Group", FIELDS(GROUP_FIELDS)},
    {"Item", FIELDS(ITEM_FIELDS)}, {"JoinedRef", FIELDS(JOINEDREF_FIELDS)}, {"Pred", FIELDS(PRED_FIELDS)},
    {"ColRef", FIELDS(COLREF_FIELDS)}, {"Order", FIELDS(ORDER_FIELDS)}, {"Limit", FIELDS(LIMIT_FIELDS)},
    {"IfParent", FIELDS(IFPARENT_FIELDS)}, {"Assign", FIELDS(ASSIGN_FIELDS)}, {"Optimist", FIELDS(OPTIMIST_FIELDS)},
};

static const record_t *record_of(const char *name)
{
    for (size_t i = 0; i < sizeof(RECORDS) / sizeof(RECORDS[0]); i++) {
        if (streq(RECORDS[i].name, name)) {
            return &RECORDS[i];
        }
    }
    return NULL;
}

static bool shape(vctx *c, const char *record, zval *value, const char *path);

static bool typed(vctx *c, const char *type, zval *v, const char *path)
{
    ZVAL_DEREF(v);
    if (Z_TYPE_P(v) == IS_NULL) {
        return true;
    }
    size_t len = strlen(type);
    if (strncmp(type, "list<", 5) == 0) {
        if (Z_TYPE_P(v) != IS_ARRAY || !zend_array_is_list(Z_ARRVAL_P(v))) {
            return fail(IR_INVALID, "%s: list required", path);
        }
        const char *inner = kstrl(c, type + 5, len - 6);
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), item)
        {
            TRY(typed(c, inner, item, path));
        }
        ZEND_HASH_FOREACH_END();
        return true;
    }
    if (strncmp(type, "map<", 4) == 0) {
        if (Z_TYPE_P(v) != IS_ARRAY || (zend_hash_num_elements(Z_ARRVAL_P(v)) > 0 && zend_array_is_list(Z_ARRVAL_P(v)))) {
            return fail(IR_INVALID, "%s: object required", path);
        }
        const char *inner = kstrl(c, type + 4, len - 5);
        zval *item;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), item)
        {
            TRY(typed(c, inner, item, path));
        }
        ZEND_HASH_FOREACH_END();
        return true;
    }
    bool ok;
    if (streq(type, "int")) {
        ok = Z_TYPE_P(v) == IS_LONG;
    } else if (streq(type, "string")) {
        ok = Z_TYPE_P(v) == IS_STRING;
    } else if (streq(type, "bool")) {
        ok = Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE;
    } else {
        return shape(c, type, v, path);
    }
    if (!ok) {
        return fail(IR_INVALID, "%s: %s required", path, type);
    }
    return true;
}

static bool shape(vctx *c, const char *record, zval *value, const char *path)
{
    if (Z_TYPE_P(value) != IS_ARRAY || (zend_hash_num_elements(Z_ARRVAL_P(value)) > 0 && zend_array_is_list(Z_ARRVAL_P(value)))) {
        if (*path == '\0') {
            return fail(IR_INVALID, "object required");
        }
        return fail(IR_INVALID, "%s: object required", path);
    }
    const record_t *rec = record_of(record);
    zend_string *key;
    zend_ulong idx;
    zval *v;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(value), idx, key, v)
    {
        const char *k = key != NULL ? ZSTR_VAL(key) : kstrl(c, "", 0);
        char nbuf[32];
        if (key == NULL) {
            snprintf(nbuf, sizeof(nbuf), "%lu", (unsigned long)idx);
            k = nbuf;
        }
        const char *type = NULL;
        for (size_t i = 0; i < rec->n; i++) {
            if (streq(rec->fields[i].field, k)) {
                type = rec->fields[i].type;
                break;
            }
        }
        if (type == NULL) {
            return fail(IR_INVALID, "json: unknown field \"%s\"", k);
        }
        const char *sub_path = *path == '\0' ? kstrl(c, k, strlen(k)) : NULL;
        if (sub_path == NULL) {
            zval *p = keep(c);
            ZVAL_STR(p, zend_strpprintf(0, "%s.%s", path, k));
            sub_path = Z_STRVAL_P(p);
        }
        TRY(typed(c, type, v, sub_path));
    }
    ZEND_HASH_FOREACH_END();
    return true;
}

/* ---- Validator state and the model ---- */

static bool ctx_init(vctx *c, zval *self)
{
    c->self = self;
    c->entities = NULL;
    c->n = 0;
    c->temps = NULL;
    if (self == NULL) {
        return true;
    }
    zval rv;
    zval *model = zend_read_property(Z_OBJCE_P(self), Z_OBJ_P(self), "m", 1, true, &rv);
    if (model == NULL || Z_TYPE_P(model) != IS_OBJECT) {
        return false;
    }
    zval *ents = keep(c);
    zval *ents_p = zend_read_property(Z_OBJCE_P(model), Z_OBJ_P(model), "entities", sizeof("entities") - 1, true, ents);
    if (ents_p == NULL || Z_TYPE_P(ents_p) != IS_ARRAY) {
        return false;
    }
    c->entities = Z_ARRVAL_P(ents_p);
    return true;
}

/* The manifest hash of the model of this validator. */
static const char *model_hash(vctx *c)
{
    zval rv;
    zval *model = zend_read_property(Z_OBJCE_P(c->self), Z_OBJ_P(c->self), "m", 1, true, &rv);
    zval *h = keep(c);
    zval *hp = zend_read_property(Z_OBJCE_P(model), Z_OBJ_P(model), "manifestHash", sizeof("manifestHash") - 1, true, h);
    return sv(c, hp);
}

/* $this->m->entities[$name] ?? null, as its array. */
static HashTable *entity_named(vctx *c, const char *name)
{
    if (c->entities == NULL) {
        return NULL;
    }
    return ha(get(c->entities, name));
}

static void set_n(vctx *c, zend_long n)
{
    c->n = n;
    if (c->self != NULL) {
        zend_update_property_long(Z_OBJCE_P(c->self), Z_OBJ_P(c->self), "n", 1, n);
    }
}

/* params: each index is in 0..n_params-1. */
static bool params_one(vctx *c, zend_long i)
{
    if (i < 0 || i >= c->n) {
        return fail(IR_INVALID, "param index %ld out of range (n_params %ld)", (long)i, (long)c->n);
    }
    return true;
}

static bool params(vctx *c, HashTable *list)
{
    zval *v;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(list), v)
    {
        TRY(params_one(c, zval_get_long(v)));
    }
    ZEND_HASH_FOREACH_END();
    return true;
}

static bool has_group_by(HashTable *q)
{
    return has_items(ha(get(q, "group_by")));
}

/* Validator::assign. */
static bool assign(vctx *c, HashTable *ent, HashTable *a)
{
    const char *column = str(c, a, "column", "");
    const char *ename = str(c, ent, "entity", "");
    HashTable *col;
    TRY(col_of(c, ent, column, &col));
    if (col == NULL) {
        return fail("COLUMN_UNKNOWN", "%s.%s", ename, column);
    }
    if (zv_eq_str(get(ent, "audit"), column)) {
        return fail(IR_INVALID, "%s.%s is written by the executor from the audit of the transaction", ename, column);
    }
    int n = (has(a, "p") ? 1 : 0) + (flag(a, "null") ? 1 : 0) + (has(a, "plus_p") ? 1 : 0) + (has(a, "minus_p") ? 1 : 0);
    if (n != 1) {
        return fail(IR_INVALID, "set %s: exactly one of p/null/plus_p/minus_p", column);
    }
    if (flag(a, "null") && !flag(col, "nullable")) {
        return fail(IR_INVALID, "set %s.%s to null but column is NOT NULL", ename, column);
    }
    if (has(a, "plus_p") || has(a, "minus_p")) {
        bool num_ok;
        TRY(numeric(c, col, &num_ok));
        if (!num_ok) {
            return fail("OPERATOR_NOT_ALLOWED", "plus/minus on %s.%s (%s)", ename, column, str(c, col, "type", ""));
        }
    }
    const char *fields[] = {"p", "plus_p", "minus_p"};
    for (size_t i = 0; i < 3; i++) {
        if (has(a, fields[i])) {
            TRY(params_one(c, num(a, fields[i], 0)));
        }
    }
    return true;
}

/* Validator::scopes: the scope tree of q and its joins. */
static zval *scopes(vctx *c, HashTable *q)
{
    zval *s = keep(c);
    array_init(s);
    const char *entity = str(c, q, "entity", "");
    HashTable *ent = entity_named(c, entity);
    zval ent_z;
    if (ent != NULL) {
        ZVAL_ARR(&ent_z, ent);
        Z_TRY_ADDREF(ent_z);
    } else {
        ZVAL_NULL(&ent_z);
    }
    add_assoc_string(s, "name", (char *)entity);
    add_assoc_zval(s, "ent", &ent_z);
    zval joins;
    array_init(&joins);
    HashTable *jh = ha(get(q, "joins"));
    zval *j;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(jh), j)
    {
        HashTable *jq = ha(j);
        const char *rel = str(c, jq, "rel", "");
        HashTable *query = ha(get(jq, "query"));
        if (!zend_symtable_str_find(Z_ARRVAL(joins), rel, strlen(rel)) && query != NULL) {
            zval *sub = scopes(c, query);
            zval cp;
            ZVAL_COPY(&cp, sub);
            zend_symtable_str_update(Z_ARRVAL(joins), rel, strlen(rel), &cp);
        }
    }
    ZEND_HASH_FOREACH_END();
    add_assoc_zval(s, "joins", &joins);
    return s;
}

static zval *scope_join(zval *scope, const char *rel)
{
    HashTable *joins = ha(get(ha(scope), "joins"));
    zval *v = joins != NULL ? zend_symtable_str_find(joins, rel, strlen(rel)) : NULL;
    if (v != NULL) {
        ZVAL_DEREF(v);
    }
    return v;
}

static HashTable *scope_ent(zval *scope)
{
    return ha(get(ha(scope), "ent"));
}

/* Validator::ref: the column that a column-to-column condition compares with. */
static bool ref_resolve(vctx *c, const vat *at, HashTable *ref, HashTable **out)
{
    const char *path = str(c, ref, "path", "");
    const char *column = str(c, ref, "column", "");
    zval *target = at->root;
    if (streq(path, "^")) {
        if (at->outer == NULL) {
            return fail(IR_INVALID, "^ reference outside a subquery");
        }
        target = at->outer;
    } else if (*path != '\0') {
        const char *p = path;
        while (true) {
            const char *slash = strchr(p, '/');
            size_t len = slash != NULL ? (size_t)(slash - p) : strlen(p);
            const char *seg = kstrl(c, p, len);
            zval *next = scope_join(target, seg);
            if (next == NULL) {
                return fail("ENTITY_NOT_JOINED", "%s.%s", str(c, ha(target), "name", ""), seg);
            }
            target = next;
            if (slash == NULL) {
                break;
            }
            p = slash + 1;
        }
    }
    HashTable *tent = scope_ent(target);
    const char *tname = str(c, ha(target), "name", "");
    if (tent == NULL) {
        return fail("ENTITY_UNKNOWN", "%s", tname);
    }
    HashTable *col;
    TRY(col_of(c, tent, column, &col));
    if (col == NULL) {
        return fail("COLUMN_UNKNOWN", "%s.%s", tname, column);
    }
    *out = col;
    return true;
}

/* Validator::conflictKey: the columns of the one key that an insert with on_duplicate conflicts on. */
static bool conflict_key(vctx *c, HashTable *ent, HashTable *set, zval *ret)
{
    HashTable *assigned = new_set(c);
    zval *a;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(set), a)
    {
        HashTable *ac = ha(a);
        zval *cv = ac != NULL ? zend_symtable_str_find(ac, "column", 6) : NULL;
        if (cv != NULL) {
            ZVAL_DEREF(cv);
            set_add(assigned, sv(c, cv));
        }
    }
    ZEND_HASH_FOREACH_END();
    zval *f;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(ent, "columns"))), f)
    {
        HashTable *fh = ha(f);
        const char *bi = str(c, fh, "blind_index", "");
        if (*bi != '\0' && set_has(assigned, str(c, fh, "name", ""))) {
            set_add(assigned, bi);
        }
    }
    ZEND_HASH_FOREACH_END();

    HashTable *pk = ha(get(ent, "pk"));
    HashTable *unique = ha(get(ent, "unique"));
    zval *cands = keep(c);
    array_init(cands);
    bool pk_meets = false;
    zval *pkc;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(pk), pkc)
    {
        if (set_has(assigned, sv(c, pkc))) {
            pk_meets = true;
        }
    }
    ZEND_HASH_FOREACH_END();
    if (pk_meets) {
        smart_str b = {0};
        smart_str_appends(&b, "primary key (");
        zval *x;
        bool first = true;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(pk), x)
        {
            if (!first) {
                smart_str_appends(&b, ", ");
            }
            smart_str_appends(&b, sv(c, x));
            first = false;
        }
        ZEND_HASH_FOREACH_END();
        smart_str_appendc(&b, ')');
        smart_str_0(&b);
        const char *name = kstrl(c, ZSTR_VAL(b.s), ZSTR_LEN(b.s));
        smart_str_free(&b);
        zval e, cz;
        array_init(&e);
        add_assoc_string(&e, "name", (char *)name);
        ZVAL_ARR(&cz, pk);
        Z_TRY_ADDREF(cz);
        add_assoc_zval(&e, "columns", &cz);
        zend_hash_next_index_insert(Z_ARRVAL_P(cands), &e);
    }
    zval *uv;
    zend_string *uk;
    zend_ulong uidx;
    ZEND_HASH_FOREACH_KEY_VAL(arr_or_empty(unique), uidx, uk, uv)
    {
        (void)uidx;
        (void)uk;
        HashTable *uh = ha(uv);
        smart_str b = {0};
        smart_str_appends(&b, "unique (");
        zval *x;
        bool first = true;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(uh), x)
        {
            if (!first) {
                smart_str_appends(&b, ", ");
            }
            smart_str_appends(&b, sv(c, x));
            first = false;
        }
        ZEND_HASH_FOREACH_END();
        smart_str_appendc(&b, ')');
        smart_str_0(&b);
        const char *name = kstrl(c, ZSTR_VAL(b.s), ZSTR_LEN(b.s));
        smart_str_free(&b);
        zval e, cz;
        array_init(&e);
        add_assoc_string(&e, "name", (char *)name);
        ZVAL_ARR(&cz, uh);
        Z_TRY_ADDREF(cz);
        add_assoc_zval(&e, "columns", &cz);
        zend_hash_next_index_insert(Z_ARRVAL_P(cands), &e);
    }
    ZEND_HASH_FOREACH_END();

    uint32_t count = zend_hash_num_elements(Z_ARRVAL_P(cands));
    if (count == 0) {
        return fail(IR_INVALID, "on_duplicate needs exactly one conflict key; no key can meet the row");
    }
    if (count != 1) {
        smart_str b = {0};
        bool first = true;
        zval *e;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(cands), e)
        {
            if (!first) {
                smart_str_appends(&b, ", ");
            }
            smart_str_appends(&b, str(c, ha(e), "name", ""));
            first = false;
        }
        ZEND_HASH_FOREACH_END();
        smart_str_0(&b);
        const char *names = kstrl(c, ZSTR_VAL(b.s), ZSTR_LEN(b.s));
        smart_str_free(&b);
        return fail(IR_INVALID, "on_duplicate needs exactly one conflict key; %s can meet the row", names);
    }
    HashTable *chosen = ha(zend_hash_index_find(Z_ARRVAL_P(cands), 0));
    const char *cname = str(c, chosen, "name", "");
    HashTable *cols = ha(get(chosen, "columns"));
    zval *col;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(cols), col)
    {
        const char *cn = sv(c, col);
        if (!set_has(assigned, cn)) {
            return fail(IR_INVALID, "on_duplicate needs exactly one conflict key; %s can meet the row but the insert does not assign %s", cname, cn);
        }
    }
    ZEND_HASH_FOREACH_END();
    ZVAL_COPY(ret, get(chosen, "columns"));
    return true;
}

static int cmp_key_bucket(Bucket *a, Bucket *b)
{
    if (a->key == NULL || b->key == NULL) {
        return 0;
    }
    return zend_binary_strcmp(ZSTR_VAL(a->key), ZSTR_LEN(a->key), ZSTR_VAL(b->key), ZSTR_LEN(b->key));
}

static bool covered(HashTable *valued, HashTable *columns)
{
    if (!has_items(columns)) {
        return false;
    }
    zval *col;
    ZEND_HASH_FOREACH_VAL(columns, col)
    {
        if (!set_has(valued, sv(NULL, col))) {
            return false;
        }
    }
    ZEND_HASH_FOREACH_END();
    return true;
}

/* Validator::restoreKey: the parts of a restore: its key, its where, and its new values. */
static bool restore_key(vctx *c, HashTable *ent, HashTable *r, zval *ret)
{
    const char *ename = str(c, ent, "entity", "");
    zval *sd = get(ent, "soft_delete");
    if (sd != NULL && Z_TYPE_P(sd) == IS_STRING && Z_STRLEN_P(sd) == 0) {
        return fail(IR_INVALID, "restore of %s, which has no soft_delete setting", ename);
    }
    HashTable *items = ha(get(ha(get(r, "where")), "items"));
    HashTable *valued = new_set(c);
    zval *item;
    zend_ulong i = 0;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(items), item)
    {
        HashTable *it = ha(item);
        HashTable *pick = ha(get(it, "pred"));
        if (pick == NULL) {
            pick = ha(get(it, "group"));
        }
        if (pick == NULL) {
            pick = ha(get(it, "joined"));
        }
        const char *conn = str(c, pick, "conn", "");
        if (i > 0 && streq(conn, "or")) {
            return fail(IR_INVALID, "restore of %s joins the conditions of its where with and", ename);
        }
        HashTable *pr = ha(get(it, "pred"));
        if (pr != NULL && streq(str(c, pr, "op", ""), "eq") && has(pr, "p") && !has(pr, "fn") && !has(pr, "value") && !has(pr, "ref") && !has(pr, "sub")) {
            set_add(valued, str(c, pr, "column", ""));
        }
        i++;
    }
    ZEND_HASH_FOREACH_END();
    HashTable *set = ha(get(r, "set"));
    zval *a;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(set), a)
    {
        if (has(ha(a), "p")) {
            set_add(valued, str(c, ha(a), "column", ""));
        }
    }
    ZEND_HASH_FOREACH_END();

    HashTable *key = NULL;
    HashTable *pk = ha(get(ent, "pk"));
    if (covered(valued, pk)) {
        key = pk;
    } else {
        HashTable *unique = ha(get(ent, "unique"));
        HashTable *sorted = zend_array_dup(arr_or_empty(unique));
        zend_hash_sort(sorted, cmp_key_bucket, 0);
        zval *cz = keep(c);
        ZVAL_ARR(cz, sorted);
        zval *u;
        ZEND_HASH_FOREACH_VAL(sorted, u)
        {
            if (covered(valued, ha(u))) {
                key = ha(u);
                break;
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    if (key == NULL) {
        return fail(IR_INVALID, "restore of %s gives no primary key or unique key a value in its set or in an eq condition of its where", ename);
    }

    HashTable *where_items = new_set(c);
    (void)where_items;
    zval *items_out = keep(c);
    array_init(items_out);
    ZEND_HASH_FOREACH_VAL(arr_or_empty(items), item)
    {
        zval cp;
        ZVAL_COPY(&cp, item);
        zend_hash_next_index_insert(Z_ARRVAL_P(items_out), &cp);
    }
    ZEND_HASH_FOREACH_END();
    zval *set_out = keep(c);
    array_init(set_out);
    ZEND_HASH_FOREACH_VAL(arr_or_empty(set), a)
    {
        HashTable *ah = ha(a);
        const char *column = str(c, ah, "column", "");
        bool in_key = false;
        zval *kc;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(key), kc)
        {
            if (streq(sv(c, kc), column)) {
                in_key = true;
            }
        }
        ZEND_HASH_FOREACH_END();
        if (has(ah, "p") && in_key) {
            zval pred;
            array_init(&pred);
            if (zend_hash_num_elements(Z_ARRVAL_P(items_out)) > 0) {
                add_assoc_string(&pred, "conn", "and");
            }
            add_assoc_string(&pred, "column", (char *)column);
            add_assoc_string(&pred, "op", "eq");
            zval pv;
            ZVAL_COPY(&pv, get(ah, "p"));
            add_assoc_zval(&pred, "p", &pv);
            zval wrap;
            array_init(&wrap);
            add_assoc_zval(&wrap, "pred", &pred);
            zend_hash_next_index_insert(Z_ARRVAL_P(items_out), &wrap);
            continue;
        }
        HashTable *col;
        TRY(col_of(c, ent, column, &col));
        if ((col != NULL && flag(col, "pk")) || zv_eq_str(get(ent, "identity"), column) || zv_eq_str(get(ent, "soft_delete"), column)) {
            return fail(IR_INVALID, "restore cannot assign %s", column);
        }
        zval cp;
        ZVAL_COPY(&cp, a);
        zend_hash_next_index_insert(Z_ARRVAL_P(set_out), &cp);
    }
    ZEND_HASH_FOREACH_END();

    zval keyz, where, items_z, setz;
    ZVAL_ARR(&keyz, key);
    Z_TRY_ADDREF(keyz);
    array_init(&where);
    ZVAL_COPY(&items_z, items_out);
    add_assoc_zval(&where, "items", &items_z);
    ZVAL_COPY(&setz, set_out);
    array_init(ret);
    add_assoc_zval(ret, "key", &keyz);
    add_assoc_zval(ret, "where", &where);
    add_assoc_zval(ret, "set", &setz);
    return true;
}

bool validator_restore_key(HashTable *ent, HashTable *r, zval *ret)
{
    vctx c;
    ctx_init(&c, NULL);
    bool ok = restore_key(&c, ent, r, ret);
    release(&c);
    return ok;
}

bool validator_conflict_key(HashTable *ent, HashTable *set, zval *ret)
{
    vctx c;
    ctx_init(&c, NULL);
    bool ok = conflict_key(&c, ent, set, ret);
    release(&c);
    return ok;
}

/* ---- the checks of a request (Validator::query, group, pred, columnFunc, sub) ---- */

static bool column_func(vctx *c, HashTable *ent, HashTable *col, HashTable *f)
{
    const char *fn = str(c, f, "name", "");
    HashTable *types_t = dialect_table(c, "COLUMN_FUNCTION_TYPES");
    zval *types = types_t != NULL ? zend_symtable_str_find(types_t, fn, strlen(fn)) : NULL;
    if (types == NULL) {
        return fail("FUNCTION_UNKNOWN", "%s", fn);
    }
    const char *ctype = str(c, col, "type", "");
    bool type_ok = false;
    zval *tv;
    ZEND_HASH_FOREACH_VAL(ha(types), tv)
    {
        if (streq(sv(c, tv), ctype)) {
            type_ok = true;
        }
    }
    ZEND_HASH_FOREACH_END();
    if (has_codec(col) || !type_ok) {
        return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", fn, str(c, ent, "entity", ""), str(c, col, "name", ""), ctype);
    }
    HashTable *arity_t = dialect_table(c, "COLUMN_FUNCTION_ARITY");
    zval *arity = arity_t != NULL ? zend_symtable_str_find(arity_t, fn, strlen(fn)) : NULL;
    zend_long want = arity != NULL ? zval_get_long(arity) : 0;
    if ((zend_long)zend_hash_num_elements(arr_or_empty(ha(get(f, "ps")))) != want) {
        return fail(IR_INVALID, "%s takes %ld arguments", fn, (long)want);
    }
    return params(c, ha(get(f, "ps")));
}

static bool sub(vctx *c, HashTable *s, bool scalar, zval *outer);
static bool query(vctx *c, HashTable *q, const vat *at, bool is_join, bool is_relation);

static bool group(vctx *c, const vat *at, HashTable *g, HashTable *joined);

static bool pred(vctx *c, const vat *at, HashTable *p)
{
    HashTable *ent = scope_ent(at->node);
    if (ent == NULL) {
        return fail("ENTITY_UNKNOWN", "%s", "");
    }
    TRY(params(c, ha(get(p, "ps"))));
    if (has(p, "p")) {
        TRY(params_one(c, num(p, "p", 0)));
    }
    const char *name = str(c, ent, "entity", "");
    const char *column = str(c, p, "column", "");
    const char *op = str(c, p, "op", "");
    if (streq(op, "tuple_in") || streq(op, "tuple_not_in")) {
        HashTable *cols = ha(get(p, "cols"));
        uint32_t cn = cols != NULL ? zend_hash_num_elements(cols) : 0;
        if (cn < 2) {
            return fail(IR_INVALID, "%s needs at least two columns", op);
        }
        zval *cv;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(cols), cv)
        {
            const char *cname = sv(c, cv);
            HashTable *cc;
            TRY(col_of(c, ent, cname, &cc));
            if (cc == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s", name, cname);
            }
            if (has_codec(cc)) {
                return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s", op, name, cname);
            }
        }
        ZEND_HASH_FOREACH_END();
        HashTable *ps = ha(get(p, "ps"));
        if (!has_items(ps)) {
            smart_str b = {0};
            bool first = true;
            ZEND_HASH_FOREACH_VAL(arr_or_empty(cols), cv)
            {
                if (!first) {
                    smart_str_appendc(&b, ',');
                }
                smart_str_appends(&b, sv(c, cv));
                first = false;
            }
            ZEND_HASH_FOREACH_END();
            smart_str_0(&b);
            const char *list = kstrl(c, ZSTR_VAL(b.s), ZSTR_LEN(b.s));
            smart_str_free(&b);
            return fail("EMPTY_IN", "%s(%s)", name, list);
        }
        if (zend_hash_num_elements(ps) % cn != 0) {
            return fail(IR_INVALID, "%s: %ld values for %ld columns", op, (long)zend_hash_num_elements(ps), (long)cn);
        }
        return true;
    }
    if (streq(op, "fulltext") || streq(op, "fulltext_boolean")) {
        /* PRT-75: cols and p only; each column is a text column without a codec (DIA-6, DIA-187). */
        HashTable *fcols = ha(get(p, "cols"));
        if (!has_items(fcols) || !has(p, "p") || *str(c, p, "column", "") != '\0' || has_items(ha(get(p, "ps"))) || has(p, "sub") || has(p, "fn") || has(p, "value") || has(p, "ref")) {
            return fail(IR_INVALID, "%s takes cols and p only", op);
        }
        zval *fv;
        ZEND_HASH_FOREACH_VAL(fcols, fv)
        {
            const char *fname = sv(c, fv);
            HashTable *fc = NULL;
            TRY(col_of(c, ent, fname, &fc));
            if (fc == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s", name, fname);
            }
            zval *ft = get(fc, "type");
            bool text = ft != NULL && Z_TYPE_P(ft) == IS_STRING && (streq(Z_STRVAL_P(ft), "varchar") || streq(Z_STRVAL_P(ft), "text"));
            if (!text || has_codec(fc)) {
                return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s", op, name, fname);
            }
        }
        ZEND_HASH_FOREACH_END();
        return true;
    }
    if (has_items(ha(get(p, "cols")))) {
        return fail(IR_INVALID, "cols is only valid with tuple_in or tuple_not_in");
    }
    if (has(p, "sub")) {
        HashTable *cc;
        TRY(col_of(c, ent, column, &cc));
        if (cc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", name, column);
        }
        if (!streq(op, "in") && !streq(op, "not_in")) {
            return fail(IR_INVALID, "subquery needs in or not_in");
        }
        if (has(p, "p") || has_items(ha(get(p, "ps"))) || has(p, "fn") || has(p, "value")) {
            return fail(IR_INVALID, "subquery pred may not carry values");
        }
        TRY(sub(c, ha(get(p, "sub")), false, at->node));
        HashTable *sq = ha(get(ha(get(p, "sub")), "query"));
        const char *sname = str(c, sq, "entity", "");
        HashTable *sub_ent = entity_named(c, sname);
        HashTable *sc;
        TRY(col_of(c, sub_ent, str(c, ha(get(p, "sub")), "column", ""), &sc));
        if (sc != NULL) {
            bool yes;
            HashTable *own;
            TRY(col_of(c, ent, column, &own));
            TRY(meets(c, own, sc, &yes));
            if (!yes) {
                return fail("OPERATOR_NOT_ALLOWED", "%s.%s does not meet the subquery column %s.%s", name, column, sname, str(c, ha(get(p, "sub")), "column", ""));
            }
        }
        return true;
    }
    if (has(p, "fn") || has(p, "value")) {
        HashTable *cc;
        TRY(col_of(c, ent, column, &cc));
        if (cc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", name, column);
        }
        if (has(p, "fn") && has(p, "value")) {
            return fail(IR_INVALID, "fn and value cannot be combined");
        }
        if (has(p, "fn")) {
            TRY(column_func(c, ent, cc, ha(get(p, "fn"))));
            if (IN(op, CMP_OPS)) {
                if (!has(p, "p")) {
                    return fail(IR_INVALID, "%s needs a value (p)", op);
                }
            } else if (streq(op, "in") || streq(op, "not_in")) {
                if (!has_items(ha(get(p, "ps")))) {
                    return fail("EMPTY_IN", "%s.%s", name, column);
                }
            } else if (streq(op, "between")) {
                if (zend_hash_num_elements(arr_or_empty(ha(get(p, "ps")))) != 2) {
                    return fail(IR_INVALID, "between needs 2 params (ps)");
                }
            } else {
                return fail("OPERATOR_NOT_ALLOWED", "%s with a column function", op);
            }
            return true;
        }
        const char *fn = str(c, ha(get(p, "value")), "name", "");
        bool is_fn;
        TRY(is_value_function(c, fn, &is_fn));
        if (!is_fn) {
            return fail("FUNCTION_UNKNOWN", "%s", fn);
        }
        const char *ctype = str(c, cc, "type", "");
        if (has_codec(cc) || (!streq(ctype, "date") && !streq(ctype, "datetime"))) {
            return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", fn, name, column, ctype);
        }
        HashTable *units = dialect_table(c, "VALUE_FUNCTION_UNITS");
        zend_long want = (units != NULL && zend_symtable_str_find(units, fn, strlen(fn)) != NULL) ? 1 : 0;
        if ((zend_long)zend_hash_num_elements(arr_or_empty(ha(get(ha(get(p, "value")), "ps")))) != want) {
            return fail(IR_INVALID, "%s takes %ld arguments", fn, (long)want);
        }
        if (has(p, "p") || has_items(ha(get(p, "ps")))) {
            return fail(IR_INVALID, "value function pred may not carry p or ps");
        }
        if (!IN(op, CMP_OPS)) {
            return fail("OPERATOR_NOT_ALLOWED", "%s with a value function", op);
        }
        return params(c, ha(get(ha(get(p, "value")), "ps")));
    }
    HashTable *cc;
    TRY(col_of(c, ent, column, &cc));
    if (cc == NULL) {
        return fail("COLUMN_UNKNOWN", "%s.%s", name, column);
    }
    zend_string *opz = zend_string_init(op, strlen(op), 0);
    bool allowed = validator_op_allowed(cc, opz);
    zend_string_release(opz);
    if (!allowed) {
        return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", op, name, column, str(c, cc, "type", ""));
    }
    if (streq(op, "is_null") || streq(op, "is_not_null")) {
        return true;
    }
    if (streq(op, "in") || streq(op, "not_in")) {
        if (!has_items(ha(get(p, "ps")))) {
            return fail("EMPTY_IN", "%s.%s", name, column);
        }
        return true;
    }
    if (streq(op, "between")) {
        if (zend_hash_num_elements(arr_or_empty(ha(get(p, "ps")))) != 2) {
            return fail(IR_INVALID, "between needs 2 params (ps)");
        }
        return true;
    }
    if (IN(op, COL_OPS)) {
        if (!has(p, "ref")) {
            return fail(IR_INVALID, "%s needs ref", op);
        }
        HashTable *other;
        TRY(ref_resolve(c, at, ha(get(p, "ref")), &other));
        bool yes;
        TRY(meets(c, cc, other, &yes));
        const char *refcol = str(c, ha(get(p, "ref")), "column", "");
        if (!yes) {
            return fail("OPERATOR_NOT_ALLOWED", "%s.%s does not meet %s", name, column, refcol);
        }
        if (!col_pair_op_allowed(cc, other, op)) {
            return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s) and %s (%s)", op, name, column, str(c, cc, "type", ""), refcol, str(c, other, "type", ""));
        }
        return true;
    }
    if (!has(p, "p")) {
        return fail(IR_INVALID, "%s %s.%s needs a value (p)", op, name, column);
    }
    return true;
}

static bool group(vctx *c, const vat *at, HashTable *g, HashTable *joined)
{
    HashTable *items = ha(get(g, "items"));
    zend_ulong i = 0;
    zval *it;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(items), it)
    {
        HashTable *ih = ha(it);
        int n = 0;
        const char *conn = "";
        const char *kinds[] = {"pred", "group", "joined"};
        for (size_t k = 0; k < 3; k++) {
            if (has(ih, kinds[k])) {
                n++;
                conn = str(c, ha(get(ih, kinds[k])), "conn", "");
            }
        }
        if (n != 1) {
            return fail(IR_INVALID, "where item must be exactly one of pred/group/joined");
        }
        if (*conn != '\0' && !streq(conn, "and") && !streq(conn, "or")) {
            return fail(IR_INVALID, "conn \"%s\"", conn);
        }
        if (i == 0 && streq(conn, "or")) {
            return fail("OR_AT_GROUP_START", "a group may not start with OR");
        }
        if (i == 0 && *conn != '\0') {
            return fail(IR_INVALID, "the first item of a group takes no conn (\"%s\")", conn);
        }
        if (has(ih, "joined")) {
            const char *name = str(c, ha(get(ih, "joined")), "join", "");
            zval *j = zend_symtable_str_find(joined, name, strlen(name));
            if (j == NULL) {
                return fail("ENTITY_NOT_JOINED", "%s is not joined in this statement", name);
            }
            if (!has_items(ha(get(ha(get(ha(get(ha(j), "query")), "where")), "items")))) {
                return fail(IR_INVALID, "joined %s has no conditions", name);
            }
        } else if (has(ih, "pred")) {
            TRY(pred(c, at, ha(get(ih, "pred"))));
        } else {
            HashTable *grp = ha(get(ih, "group"));
            if (!has_items(ha(get(grp, "items")))) {
                return fail(IR_INVALID, "empty group");
            }
            TRY(group(c, at, grp, joined));
        }
        i++;
    }
    ZEND_HASH_FOREACH_END();
    return true;
}

static bool joined_refs(vctx *c, HashTable *g, HashTable *seen)
{
    zval *it;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(g, "items"))), it)
    {
        HashTable *ih = ha(it);
        if (has(ih, "joined")) {
            const char *name = str(c, ha(get(ih, "joined")), "join", "");
            if (set_has(seen, name)) {
                return fail(IR_INVALID, "joined %s is placed twice", name);
            }
            set_add(seen, name);
        }
        if (has(ih, "group")) {
            TRY(joined_refs(c, ha(get(ih, "group")), seen));
        }
    }
    ZEND_HASH_FOREACH_END();
    return true;
}

static bool sub(vctx *c, HashTable *s, bool scalar, zval *outer)
{
    HashTable *q = ha(get(s, "query"));
    if (q == NULL) {
        return fail(IR_INVALID, "subquery needs a query");
    }
    const char *ename = str(c, q, "entity", "");
    HashTable *ent = entity_named(c, ename);
    if (ent == NULL) {
        return fail("ENTITY_UNKNOWN", "%s", ename);
    }
    const char *agg = str(c, s, "agg", "");
    const char *column = str(c, s, "column", "");
    const char *ent_name = str(c, ent, "entity", "");
    if (streq(agg, "")) {
        if (*column == '\0') {
            return fail(IR_INVALID, "subquery needs a column");
        }
    } else if (streq(agg, "sum") || streq(agg, "avg")) {
        if (!scalar) {
            return fail(IR_INVALID, "%s subquery is only valid as a column", agg);
        }
        HashTable *cc;
        TRY(col_of(c, ent, column, &cc));
        if (cc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", ent_name, column);
        }
        bool yes;
        TRY(numeric(c, cc, &yes));
        if (!yes) {
            return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", agg, ent_name, column, str(c, cc, "type", ""));
        }
    } else if (streq(agg, "count")) {
        if (!scalar) {
            return fail(IR_INVALID, "count subquery is only valid as a column");
        }
    } else {
        return fail(IR_INVALID, "subquery agg \"%s\"", agg);
    }
    if (*column != '\0') {
        HashTable *cc;
        TRY(col_of(c, ent, column, &cc));
        if (cc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", ent_name, column);
        }
    }
    bool scalar_column = scalar && streq(agg, "");
    if (has_items(ha(get(q, "relations"))) || (*str(c, q, "lock", "") != '\0') || has(q, "columns") || (has(q, "limit") && !scalar_column)) {
        return fail(IR_INVALID, "subquery may not use limit, relations, lock or columns");
    }
    if (scalar_column) {
        if (!has(q, "limit") || num(ha(get(q, "limit")), "count", 0) != 1) {
            return fail(IR_INVALID, "a scalar column subquery needs limit with count 1");
        }
        HashTable *order = ha(get(q, "order"));
        zval *o;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(order), o)
        {
            if (flag(ha(o), "random")) {
                return fail(IR_INVALID, "a scalar column subquery may not order by random");
            }
        }
        ZEND_HASH_FOREACH_END();
        zval *pk;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(ent, "pk"))), pk)
        {
            const char *pkn = sv(c, pk);
            bool found = false;
            zval *ov;
            ZEND_HASH_FOREACH_VAL(arr_or_empty(order), ov)
            {
                if (streq(str(c, ha(ov), "column", ""), pkn) && !has(ha(ov), "fn")) {
                    found = true;
                }
            }
            ZEND_HASH_FOREACH_END();
            if (!found) {
                return fail(IR_INVALID, "a scalar column subquery needs an order that includes the primary key column %s", pkn);
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    zval *scope = scopes(c, q);
    vat at = {scope, outer, scope};
    return query(c, q, &at, false, false);
}

/* Validator::query: checks q, with its joins, conditions, relations and options. */
static bool query(vctx *c, HashTable *q, const vat *at, bool is_join, bool is_relation)
{
    const char *entity = str(c, q, "entity", "");
    HashTable *ent = entity_named(c, entity);
    if (ent == NULL) {
        return fail("ENTITY_UNKNOWN", "%s", entity);
    }
    const char *ent_name = str(c, ent, "entity", "");
    HashTable *cols = ha(get(q, "columns"));
    if (cols != NULL) {
        const char *mode = str(c, cols, "mode", "");
        if (*mode != '\0' && !streq(mode, "all") && !streq(mode, "none")) {
            return fail(IR_INVALID, "columns.mode \"%s\"", mode);
        }
        const char *lists[] = {"add", "remove"};
        for (size_t k = 0; k < 2; k++) {
            zval *cv;
            ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(cols, lists[k]))), cv)
            {
                const char *cn = sv(c, cv);
                HashTable *x;
                TRY(col_of(c, ent, cn, &x));
                if (x == NULL) {
                    return fail("COLUMN_UNKNOWN", "%s.%s", entity, cn);
                }
            }
            ZEND_HASH_FOREACH_END();
        }
        zval *outputs_z = keep(c);
        array_init(outputs_z);
        HashTable *outputs = Z_ARRVAL_P(outputs_z);
        zend_string *key;
        zend_ulong idx;
        zval *cf;
        ZEND_HASH_FOREACH_KEY_VAL(arr_or_empty(ha(get(cols, "fn"))), idx, key, cf)
        {
            char nb[32];
            const char *out = key != NULL ? ZSTR_VAL(key) : (snprintf(nb, sizeof(nb), "%lu", (unsigned long)idx), nb);
            out = kstrl(c, out, strlen(out));
            HashTable *x;
            TRY(col_of(c, ent, out, &x));
            if (x != NULL || set_has(outputs, out)) {
                return fail("COLUMN_ALIAS_CONFLICT", "%s.%s is already a row name", entity, out);
            }
            set_add(outputs, out);
            const char *ccol = str(c, ha(cf), "column", "");
            HashTable *col;
            TRY(col_of(c, ent, ccol, &col));
            if (col == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s", entity, ccol);
            }
            HashTable *fn = ha(get(ha(cf), "fn"));
            TRY(column_func(c, ent, col, fn != NULL ? fn : (HashTable *)&zend_empty_array));
        }
        ZEND_HASH_FOREACH_END();
        ZEND_HASH_FOREACH_KEY_VAL(arr_or_empty(ha(get(cols, "sub"))), idx, key, cf)
        {
            char nb[32];
            const char *out = key != NULL ? ZSTR_VAL(key) : (snprintf(nb, sizeof(nb), "%lu", (unsigned long)idx), nb);
            out = kstrl(c, out, strlen(out));
            HashTable *x;
            TRY(col_of(c, ent, out, &x));
            if (x != NULL || set_has(outputs, out)) {
                return fail("COLUMN_ALIAS_CONFLICT", "%s.%s is already a row name", entity, out);
            }
            set_add(outputs, out);
            TRY(sub(c, ha(cf), true, at->node));
        }
        ZEND_HASH_FOREACH_END();
    }

    zval *joined_z = keep(c);
    array_init(joined_z);
    HashTable *joined = Z_ARRVAL_P(joined_z);
    zval *jv;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(q, "joins"))), jv)
    {
        HashTable *j = ha(jv);
        const char *kind = str(c, j, "kind", "");
        const char *rel = str(c, j, "rel", "");
        if (!streq(kind, "inner") && !streq(kind, "left")) {
            return fail(IR_INVALID, "join kind \"%s\"", kind);
        }
        if (*rel == '\0' || set_has(joined, rel)) {
            return fail(IR_INVALID, "join name \"%s\" is empty or used twice", rel);
        }
        const char *left = str(c, j, "left", "");
        const char *right = str(c, j, "right", "");
        HashTable *jq = ha(get(j, "query"));
        if (*left == '\0' || *right == '\0' || jq == NULL) {
            return fail(IR_INVALID, "join %s: left, right and query are required", rel);
        }
        const char *tname = str(c, jq, "entity", "");
        HashTable *target = entity_named(c, tname);
        if (target == NULL) {
            return fail("ENTITY_UNKNOWN", "%s", tname);
        }
        HashTable *lc, *rc;
        TRY(col_of(c, ent, left, &lc));
        if (lc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", ent_name, left);
        }
        TRY(col_of(c, target, right, &rc));
        if (rc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", str(c, target, "entity", ""), right);
        }
        bool yes;
        TRY(meets(c, lc, rc, &yes));
        if (!yes) {
            return fail("OPERATOR_NOT_ALLOWED", "join %s: %s.%s does not meet %s.%s", rel, ent_name, left, str(c, target, "entity", ""), right);
        }
        zval jcp;
        ZVAL_COPY(&jcp, jv);
        zend_symtable_str_update(joined, rel, strlen(rel), &jcp);
        zval *node = scope_join(at->node, rel);
        if (node == NULL) {
            return fail(IR_INVALID, "join %s has no scope", rel);
        }
        vat sat = {at->root, at->outer, node};
        TRY(query(c, jq, &sat, true, false));
    }
    ZEND_HASH_FOREACH_END();

    if (!is_join && has(q, "on")) {
        return fail(IR_INVALID, "on[] is only valid on join children");
    }
    if (flag(ha(get(q, "on")), "not") || flag(ha(get(q, "where")), "not")) {
        return fail(IR_INVALID, "not applies to a nested group");
    }
    const char *tops[] = {"on", "where"};
    for (size_t k = 0; k < 2; k++) {
        const char *conn = str(c, ha(get(q, tops[k])), "conn", "");
        if (*conn != '\0') {
            return fail(IR_INVALID, "the top-level group takes no conn (\"%s\")", conn);
        }
    }
    if (has(q, "on")) {
        TRY(group(c, at, ha(get(q, "on")), joined));
    }
    if (has(q, "where")) {
        TRY(group(c, at, ha(get(q, "where")), joined));
        HashTable *seen = new_set(c);
        TRY(joined_refs(c, ha(get(q, "where")), seen));
    }

    HashTable *rel_names = new_set(c);
    zval *rv;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(q, "relations"))), rv)
    {
        HashTable *r = ha(rv);
        const char *rel = str(c, r, "rel", "");
        if (*rel == '\0' || set_has(rel_names, rel)) {
            return fail("COLUMN_ALIAS_CONFLICT", "relation name \"%s\" is empty or used twice", rel);
        }
        set_add(rel_names, rel);
        HashTable *same;
        TRY(col_of(c, ent, rel, &same));
        if (same != NULL) {
            return fail("COLUMN_ALIAS_CONFLICT", "%s.%s is already a column", entity, rel);
        }
        HashTable *child = ha(get(r, "query"));
        if (child == NULL) {
            return fail(IR_INVALID, "relation %s needs a query", rel);
        }
        const char *kind = str(c, r, "kind", "");
        HashTable *keys = ha(get(r, "keys"));
        if (!has_items(keys) || (!streq(kind, "one") && !streq(kind, "many"))) {
            return fail(IR_INVALID, "relation %s: keys and kind one|many are required", rel);
        }
        const char *tname = str(c, child, "entity", "");
        HashTable *target = entity_named(c, tname);
        if (target == NULL) {
            return fail("ENTITY_UNKNOWN", "%s", tname);
        }
        HashTable *lefts = new_set(c);
        HashTable *rights = new_set(c);
        zval *kv;
        ZEND_HASH_FOREACH_VAL(keys, kv)
        {
            HashTable *k = ha(kv);
            const char *left = str(c, k, "left", "");
            const char *right = str(c, k, "right", "");
            if (*left == '\0' || *right == '\0') {
                return fail(IR_INVALID, "relation %s: every key needs left and right", rel);
            }
            HashTable *lc, *rc;
            TRY(col_of(c, ent, left, &lc));
            if (lc == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s", entity, left);
            }
            TRY(col_of(c, target, right, &rc));
            if (rc == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s", str(c, target, "entity", ""), right);
            }
            bool yes;
            TRY(meets(c, lc, rc, &yes));
            if (!yes) {
                return fail("OPERATOR_NOT_ALLOWED", "relation %s: %s.%s does not meet %s.%s", rel, entity, left, str(c, target, "entity", ""), right);
            }
            if (set_has(lefts, left) || set_has(rights, right)) {
                return fail(IR_INVALID, "relation %s: key column %s or %s is used twice", rel, left, right);
            }
            set_add(lefts, left);
            set_add(rights, right);
        }
        ZEND_HASH_FOREACH_END();
        if (has(child, "limit")) {
            return fail("LIMIT_IN_RELATION", "%s: use limit_per_parent", rel);
        }
        if (flag(child, "flatten") && !streq(kind, "one")) {
            return fail(IR_INVALID, "relation %s: flatten needs a one relation", rel);
        }
        const char *child_kb = str(c, child, "key_by", "");
        if (*child_kb != '\0' && !streq(kind, "many")) {
            return fail(IR_INVALID, "relation %s: key_by needs a many relation", rel);
        }
        if (has(child, "if_parent")) {
            const char *ipc = str(c, ha(get(child, "if_parent")), "column", "");
            HashTable *ic;
            TRY(col_of(c, ent, ipc, &ic));
            if (ic == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s (if_parent)", entity, ipc);
            }
        }
        zval *scope = scopes(c, child);
        vat cat = {scope, NULL, scope};
        TRY(query(c, child, &cat, false, true));
    }
    ZEND_HASH_FOREACH_END();

    const char *key_by = str(c, q, "key_by", "");
    if (*key_by != '\0') {
        HashTable *kc;
        TRY(col_of(c, ent, key_by, &kc));
        if (kc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", entity, key_by);
        }
        if (flag(kc, "nullable")) {
            return fail(IR_INVALID, "key_by %s is nullable", key_by);
        }
    }
    if (has(q, "if_parent")) {
        TRY(params_one(c, num(ha(get(q, "if_parent")), "p", 0)));
    }
    if (!is_relation && (*key_by != '\0' || flag(q, "flatten") || num(q, "limit_per_parent", 0) > 0 || has(q, "if_parent") || flag(q, "no_cascade_delete"))) {
        return fail(IR_INVALID, "relation-only options on %s", entity);
    }
    zval *ov;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(q, "order"))), ov)
    {
        HashTable *o = ha(ov);
        const char *column = str(c, o, "column", "");
        int kinds = (*column != '\0' ? 1 : 0) + (flag(o, "random") ? 1 : 0);
        if (kinds != 1) {
            return fail(IR_INVALID, "order needs exactly one of column, random");
        }
        if (*column != '\0') {
            HashTable *oc;
            TRY(col_of(c, ent, column, &oc));
            if (oc == NULL) {
                return fail("COLUMN_UNKNOWN", "%s.%s", entity, column);
            }
            if (has(o, "fn")) {
                TRY(column_func(c, ent, oc, ha(get(o, "fn"))));
            }
        } else if (has(o, "fn")) {
            return fail(IR_INVALID, "order function needs a column");
        }
    }
    ZEND_HASH_FOREACH_END();
    HashTable *gb = ha(get(q, "group_by"));
    zval *gv;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(gb), gv)
    {
        HashTable *gc;
        const char *gn = sv(c, gv);
        TRY(col_of(c, ent, gn, &gc));
        if (gc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", entity, gn);
        }
    }
    ZEND_HASH_FOREACH_END();
    if (has_group_by(q)) {
        if (is_join || is_relation || at->outer != NULL) {
            return fail(IR_INVALID, "group_by is only valid on the request's root query");
        }
        zval *o2;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(q, "order"))), o2)
        {
            const char *oc = str(c, ha(o2), "column", "");
            bool in_group = false;
            zval *gg;
            ZEND_HASH_FOREACH_VAL(arr_or_empty(gb), gg)
            {
                if (streq(sv(c, gg), oc)) {
                    in_group = true;
                }
            }
            ZEND_HASH_FOREACH_END();
            if (*oc != '\0' && !in_group) {
                return fail(IR_INVALID, "order by %s, which is not a group column", oc);
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    if (has(q, "limit")) {
        HashTable *lim = ha(get(q, "limit"));
        if (num(lim, "offset", 0) < 0 || num(lim, "count", 0) <= 0) {
            return fail(IR_INVALID, "limit offset>=0, count>0");
        }
    }
    const char *lock = str(c, q, "lock", "");
    const char *locks[] = {"update", "share", "update_nowait", "share_nowait"};
    if (*lock != '\0' && !IN(lock, locks)) {
        return fail(IR_INVALID, "lock \"%s\": want update, share, update_nowait or share_nowait", lock);
    }
    if (*lock != '\0' && (is_join || is_relation || has(q, "group_by") || num(q, "limit_per_parent", 0) > 0)) {
        return fail(IR_INVALID, "row lock is only valid on a root row select");
    }
    const char *index = str(c, q, "force_index", "");
    if (*index != '\0') {
        HashTable *indexes = ha(get(ent, "indexes"));
        if (indexes == NULL || zend_symtable_str_find(indexes, index, strlen(index)) == NULL) {
            return fail("INDEX_UNKNOWN", "%s.%s", entity, index);
        }
    }
    return true;
}

/* ---- the public entry points ---- */

bool validator_construct(zval *self, zval *model)
{
    zend_class_entry *ce = zend_lookup_class(zend_string_init(RUNTIME_MODEL, sizeof(RUNTIME_MODEL) - 1, 0));
    if (ce == NULL || Z_TYPE_P(model) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(model), ce)) {
        zend_type_error("Polyspec\\Orm\\Validator::__construct(): Argument #1 ($m) must be of type Polyspec\\Orm\\RuntimeModel, %s given", zend_zval_type_name(model));
        return false;
    }
    zend_update_property(Z_OBJCE_P(self), Z_OBJ_P(self), "m", 1, model);
    return true;
}

static bool validate_request(vctx *c, zval *rz, HashTable *r)
{
    TRY(shape(c, "Request", rz, ""));
    zval *ir = get(r, "ir_version");
    if (ir == NULL || Z_TYPE_P(ir) != IS_LONG || Z_LVAL_P(ir) != 1) {
        return fail("VERSION_MISMATCH", "ir_version %s, engine 1", ir != NULL ? sv(c, ir) : "0");
    }
    const char *hash = model_hash(c);
    zval *mh = get(r, "manifest_hash");
    if (mh == NULL || Z_TYPE_P(mh) != IS_STRING || !streq(Z_STRVAL_P(mh), hash)) {
        return fail("SCHEMA_HASH_MISMATCH", "client %s, engine %s", mh != NULL ? sv(c, mh) : "", hash);
    }
    const char *kind = str(c, r, "kind", "");
    const char *kinds[] = {"one", "all", "count", "group_count", "sum", "avg", "paginate", "insert", "update", "delete", "restore", "restart_identity"};
    if (!IN(kind, kinds)) {
        return fail(IR_INVALID, "unknown kind \"%s\"", kind);
    }
    const char *entity = str(c, r, "entity", "");
    HashTable *target = entity_named(c, entity);
    const char *owned[] = {"insert", "update", "delete", "restore", "restart_identity"};
    if (target != NULL && flag(target, "external") && IN(kind, owned)) {
        return fail("CONFIG", "%s is owned by another document set", str(c, target, "table", ""));
    }
    if (flag(r, "load") && (!streq(kind, "insert") || has_items(ha(get(r, "on_duplicate"))))) {
        return fail(IR_INVALID, "load is only valid on insert without on_duplicate");
    }
    if (streq(kind, "restart_identity") && (has_items(ha(get(r, "set"))) || has_items(ha(get(r, "rows"))) || has_items(ha(get(r, "on_duplicate"))) || has(r, "where") || has(r, "optimistic"))) {
        return fail(IR_INVALID, "restart_identity takes no set, rows, on_duplicate, where or optimistic");
    }
    set_n(c, num(r, "n_params", 0));
    zval *root = scopes(c, r);
    vat at = {root, NULL, root};
    TRY(query(c, r, &at, false, false));
    const char *lock = str(c, r, "lock", "");
    if (*lock != '\0' && !streq(kind, "one") && !streq(kind, "all")) {
        return fail(IR_INVALID, "row lock is only valid on one or all");
    }
    HashTable *ent = entity_named(c, entity);
    if (ent == NULL) {
        return fail("ENTITY_UNKNOWN", "%s", entity);
    }
    if (streq(kind, "sum") || streq(kind, "avg")) {
        const char *agg = str(c, r, "agg", "");
        HashTable *cc;
        TRY(col_of(c, ent, agg, &cc));
        if (cc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", entity, agg);
        }
        bool yes;
        TRY(numeric(c, cc, &yes));
        if (!yes) {
            return fail("OPERATOR_NOT_ALLOWED", "%s on %s.%s (%s)", kind, entity, agg, str(c, cc, "type", ""));
        }
    }
    if (streq(kind, "group_count") && !has_group_by(r)) {
        return fail(IR_INVALID, "group_count needs group_by");
    }
    if (has_group_by(r) && !streq(kind, "count") && !streq(kind, "group_count")) {
        return fail(IR_INVALID, "group_by is only valid on count or group_count, not %s", kind);
    }
    HashTable *set = ha(get(r, "set"));
    if (streq(kind, "insert") || streq(kind, "update") || streq(kind, "restore")) {
        if (!has_items(set) && !streq(kind, "restore")) {
            return fail(IR_INVALID, "%s needs set[]", kind);
        }
        zval *av;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(set), av)
        {
            HashTable *a = ha(av);
            TRY(assign(c, ent, a));
            if (streq(kind, "insert") && (has(a, "plus_p") || has(a, "minus_p"))) {
                return fail(IR_INVALID, "insert cannot assign %s by plus or minus", str(c, a, "column", ""));
            }
            if (streq(kind, "update")) {
                const char *cn = str(c, a, "column", "");
                HashTable *cc;
                TRY(col_of(c, ent, cn, &cc));
                if ((cc != NULL && flag(cc, "pk")) || zv_eq_str(get(ent, "identity"), cn)) {
                    return fail(IR_INVALID, "cannot update %s", cn);
                }
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    HashTable *rows = ha(get(r, "rows"));
    if (has_items(rows)) {
        if (!streq(kind, "insert") || has_items(ha(get(r, "on_duplicate")))) {
            return fail(IR_INVALID, "rows are only valid on insert without on_duplicate");
        }
        zval *av;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(set), av)
        {
            if (!has(ha(av), "p")) {
                return fail(IR_INVALID, "multi-row insert assigns %s.%s without a value", entity, str(c, ha(av), "column", ""));
            }
        }
        ZEND_HASH_FOREACH_END();
        zend_ulong i = 0;
        zval *row;
        ZEND_HASH_FOREACH_VAL(rows, row)
        {
            uint32_t rc = zend_hash_num_elements(arr_or_empty(ha(row)));
            uint32_t sc = zend_hash_num_elements(arr_or_empty(set));
            if (rc != sc) {
                return fail(IR_INVALID, "insert row %ld has %ld values for %ld columns", (long)(i + 1), (long)rc, (long)sc);
            }
            TRY(params(c, ha(row)));
            i++;
        }
        ZEND_HASH_FOREACH_END();
    }
    HashTable *on_dup = ha(get(r, "on_duplicate"));
    if (has_items(on_dup)) {
        if (!streq(kind, "insert")) {
            return fail(IR_INVALID, "on_duplicate is only valid on insert");
        }
        zval *av;
        ZEND_HASH_FOREACH_VAL(on_dup, av)
        {
            TRY(assign(c, ent, ha(av)));
            HashTable *cc;
            TRY(col_of(c, ent, str(c, ha(av), "column", ""), &cc));
            if (cc != NULL && flag(cc, "pk")) {
                return fail(IR_INVALID, "on_duplicate cannot assign %s.%s", entity, str(c, ha(av), "column", ""));
            }
        }
        ZEND_HASH_FOREACH_END();
        zval dummy;
        ZVAL_UNDEF(&dummy);
        TRY(conflict_key(c, ent, arr_or_empty(set), &dummy));
        zval_ptr_dtor(&dummy);
    }
    if (has(r, "optimistic")) {
        HashTable *opt = ha(get(r, "optimistic"));
        const char *oc = str(c, opt, "column", "");
        HashTable *x;
        TRY(col_of(c, ent, oc, &x));
        if (x == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", entity, oc);
        }
        TRY(params_one(c, num(opt, "p", 0)));
    }
    if ((streq(kind, "update") || streq(kind, "delete")) && !has_items(ha(get(ha(get(r, "where")), "items")))) {
        return fail(IR_INVALID, "%s without where", kind);
    }
    if (streq(kind, "restore")) {
        if (has(r, "optimistic")) {
            return fail(IR_INVALID, "restore takes no optimistic");
        }
        zval dummy;
        ZVAL_UNDEF(&dummy);
        TRY(restore_key(c, ent, r, &dummy));
        zval_ptr_dtor(&dummy);
    }
    return true;
}

bool validator_validate(zval *self, HashTable *r)
{
    vctx c;
    ctx_init(&c, self);
    zval rz;
    ZVAL_ARR(&rz, r);
    bool ok = validate_request(&c, &rz, r);
    release(&c);
    return ok;
}

/* ---- the parameter uses (Validator::paramUses and its helpers) ---- */

static void add_use(vctx *c, HashTable *out, zend_long i, const char *type, HashTable *col, bool assign_use)
{
    if (i < 0 || i >= (zend_long)zend_hash_num_elements(out)) {
        return;
    }
    zval *slot = zend_hash_index_find(out, (zend_ulong)i);
    if (slot == NULL) {
        return;
    }
    zval entry;
    array_init(&entry);
    add_assoc_string(&entry, "type", (char *)type);
    zval cz;
    if (col != NULL) {
        ZVAL_ARR(&cz, col);
        Z_TRY_ADDREF(cz);
    } else {
        ZVAL_NULL(&cz);
    }
    add_assoc_zval(&entry, "column", &cz);
    add_assoc_bool(&entry, "assign", assign_use);
    zend_hash_next_index_insert(Z_ARRVAL_P(slot), &entry);
    (void)c;
}

static void column_use(vctx *c, HashTable *out, zend_long i, HashTable *col)
{
    if (col != NULL) {
        add_use(c, out, i, str(c, col, "type", ""), col, false);
    }
}

static const char *function_type(vctx *c, const char *name, HashTable *col)
{
    if (streq(name, "day_of_week") || streq(name, "year") || streq(name, "month")) {
        return "i64";
    }
    if (streq(name, "date")) {
        return "date";
    }
    zval *t = get(col, "type");
    return t != NULL ? sv(c, t) : "text";
}

static const char *interval_type(vctx *c, const char *name)
{
    HashTable *units = dialect_table(c, "VALUE_FUNCTION_UNITS");
    zval *u = units != NULL ? zend_symtable_str_find(units, name, strlen(name)) : NULL;
    return (u != NULL && streq(sv(c, u), "second")) ? "f64" : "i32";
}

static bool query_uses(vctx *c, HashTable *q, HashTable *parent, HashTable *out);

static void pred_uses(vctx *c, HashTable *p, HashTable *ent, HashTable *out);

static void group_uses(vctx *c, HashTable *g, HashTable *ent, HashTable *out)
{
    zval *item;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(g, "items"))), item)
    {
        HashTable *ih = ha(item);
        if (has(ih, "pred")) {
            pred_uses(c, ha(get(ih, "pred")), ent, out);
        } else if (has(ih, "group")) {
            group_uses(c, ha(get(ih, "group")), ent, out);
        }
    }
    ZEND_HASH_FOREACH_END();
}
static void pred_uses(vctx *c, HashTable *p, HashTable *ent, HashTable *out)
{
    if (has(p, "sub")) {
        query_uses(c, ha(get(ha(get(p, "sub")), "query")), NULL, out);
    }
    const char *op = str(c, p, "op", "");
    if (streq(op, "tuple_in") || streq(op, "tuple_not_in")) {
        HashTable *cols = ha(get(p, "cols"));
        HashTable *ps = ha(get(p, "ps"));
        uint32_t cn = zend_hash_num_elements(arr_or_empty(cols));
        zend_ulong k = 0;
        zval *iv;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(ps), iv)
        {
            if (cn > 0) {
                zval *cname = zend_hash_index_find(cols, k % cn);
                HashTable *cc = NULL;
                if (cname != NULL) {
                    col_of(c, ent, sv(c, cname), &cc);
                }
                column_use(c, out, zval_get_long(iv), cc);
            }
            k++;
        }
        ZEND_HASH_FOREACH_END();
        return;
    }
    if (streq(op, "fulltext") || streq(op, "fulltext_boolean")) {
        if (has(p, "p")) {
            add_use(c, out, num(p, "p", 0), "text", NULL, false);
        }
        return;
    }
    HashTable *col = NULL;
    col_of(c, ent, str(c, p, "column", ""), &col);
    HashTable *value = ha(get(p, "value"));
    if (value != NULL) {
        zval *iv;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(value, "ps"))), iv)
        {
            add_use(c, out, zval_get_long(iv), interval_type(c, str(c, value, "name", "")), NULL, false);
        }
        ZEND_HASH_FOREACH_END();
    }
    if (streq(op, "contains") || streq(op, "contains_binary")) {
        if (has(p, "p")) {
            add_use(c, out, num(p, "p", 0), "text", NULL, false);
        }
        return;
    }
    /* the slots: p first when present, then ps */
    zval *slots = keep(c);
    array_init(slots);
    if (has(p, "p")) {
        add_next_index_long(slots, num(p, "p", 0));
    }
    zval *sv_;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(p, "ps"))), sv_)
    {
        add_next_index_long(slots, zval_get_long(sv_));
    }
    ZEND_HASH_FOREACH_END();
    zval *slot;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(slots), slot)
    {
        zend_long i = zval_get_long(slot);
        if (has(p, "fn")) {
            const char *type = function_type(c, str(c, ha(get(p, "fn")), "name", ""), col);
            if (col != NULL && streq(type, str(c, col, "type", ""))) {
                column_use(c, out, i, col);
            } else {
                add_use(c, out, i, type, NULL, false);
            }
            continue;
        }
        column_use(c, out, i, col);
    }
    ZEND_HASH_FOREACH_END();
}

static bool query_uses(vctx *c, HashTable *q, HashTable *parent, HashTable *out)
{
    if (q == NULL) {
        return true;
    }
    HashTable *ent = entity_named(c, str(c, q, "entity", ""));
    if (ent == NULL) {
        return true;
    }
    group_uses(c, ha(get(q, "on")), ent, out);
    group_uses(c, ha(get(q, "where")), ent, out);
    if (has(q, "if_parent") && parent != NULL) {
        HashTable *ip = ha(get(q, "if_parent"));
        HashTable *pc = NULL;
        col_of(c, parent, str(c, ip, "column", ""), &pc);
        column_use(c, out, num(ip, "p", 0), pc);
    }
    zval *s;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(ha(get(q, "columns")), "sub"))), s)
    {
        query_uses(c, ha(get(ha(s), "query")), NULL, out);
    }
    ZEND_HASH_FOREACH_END();
    zval *j;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(q, "joins"))), j)
    {
        query_uses(c, ha(get(ha(j), "query")), NULL, out);
    }
    ZEND_HASH_FOREACH_END();
    zval *rel;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(q, "relations"))), rel)
    {
        query_uses(c, ha(get(ha(rel), "query")), ent, out);
    }
    ZEND_HASH_FOREACH_END();
    return true;
}

/* Validator::paramUses: the uses of each parameter, by index. */
bool validator_param_uses(zval *self, HashTable *r, zval *ret)
{
    vctx c;
    ctx_init(&c, self);
    bool ok = false;
    zend_long n = num(r, "n_params", 0);
    if (n < 0) {
        zend_value_error("array_fill(): Argument #2 ($count) must be greater than or equal to 0");
        release(&c);
        return false;
    }
    array_init(ret);
    for (zend_long i = 0; i < n; i++) {
        zval e;
        array_init(&e);
        zend_hash_next_index_insert(Z_ARRVAL_P(ret), &e);
    }
    HashTable *out = Z_ARRVAL_P(ret);
    HashTable *ent = entity_named(&c, str(&c, r, "entity", ""));
    query_uses(&c, r, NULL, out);
    zval *av;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(r, "set"))), av)
    {
        HashTable *a = ha(av);
        HashTable *col = NULL;
        ok = col_of(&c, ent, str(&c, a, "column", ""), &col);
        if (!ok) {
            goto out;
        }
        if (has(a, "plus_p")) {
            column_use(&c, out, num(a, "plus_p", 0), col);
        }
        if (has(a, "minus_p")) {
            column_use(&c, out, num(a, "minus_p", 0), col);
        }
        if (has(a, "p") && col != NULL) {
            add_use(&c, out, num(a, "p", 0), str(&c, col, "type", ""), col, true);
        }
    }
    ZEND_HASH_FOREACH_END();
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(r, "on_duplicate"))), av)
    {
        HashTable *a = ha(av);
        HashTable *col = NULL;
        ok = col_of(&c, ent, str(&c, a, "column", ""), &col);
        if (!ok) {
            goto out;
        }
        if (has(a, "plus_p")) {
            column_use(&c, out, num(a, "plus_p", 0), col);
        }
        if (has(a, "minus_p")) {
            column_use(&c, out, num(a, "minus_p", 0), col);
        }
        if (has(a, "p") && col != NULL) {
            add_use(&c, out, num(a, "p", 0), str(&c, col, "type", ""), col, true);
        }
    }
    ZEND_HASH_FOREACH_END();
    zend_ulong j = 0;
    zval *row;
    ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(get(r, "rows"))), row)
    {
        zval *iv;
        ZEND_HASH_FOREACH_VAL(arr_or_empty(ha(row)), iv)
        {
            zval *setitem = zend_hash_index_find(arr_or_empty(ha(get(r, "set"))), j);
            HashTable *col = NULL;
            ok = col_of(&c, ent, str(&c, ha(setitem), "column", ""), &col);
            if (!ok) {
                goto out;
            }
            if (col != NULL) {
                add_use(&c, out, zval_get_long(iv), str(&c, col, "type", ""), col, true);
            }
        }
        ZEND_HASH_FOREACH_END();
        j++;
    }
    ZEND_HASH_FOREACH_END();
    if (has(r, "optimistic")) {
        HashTable *opt = ha(get(r, "optimistic"));
        HashTable *col = NULL;
        ok = col_of(&c, ent, str(&c, opt, "column", ""), &col);
        if (!ok) {
            goto out;
        }
        column_use(&c, out, num(opt, "p", 0), col);
    }
    ok = true;
out:
    release(&c);
    return ok;
}

bool validator_function_type(zend_string *name, HashTable *col, zval *ret)
{
    vctx c;
    ctx_init(&c, NULL);
    const char *t = function_type(&c, ZSTR_VAL(name), col);
    ZVAL_STRING(ret, t);
    release(&c);
    return true;
}

bool validator_interval_type(zend_string *name, zval *ret)
{
    vctx c;
    ctx_init(&c, NULL);
    ZVAL_STRING(ret, interval_type(&c, ZSTR_VAL(name)));
    release(&c);
    return true;
}
