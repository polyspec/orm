/*
 * Polyspec\Orm\Planner of the PHP library (packages/php/src/Planner.php) in C. The statements, bind slots, assembly and error codes
 * are those of Planner.php. Its helper classes (PlanBinds, PlanScope, PlanSteps, PlanStep, PlanAssemble, PlanRelation and PlanChild)
 * are C structs here, and their toArray forms are the arrays of the plan. The library code that the planner calls is called through
 * the engine by its public name: Polyspec\Orm\RuntimeModel::column, ::encrypted and the constant HOST_STAGES (the schema model), the
 * public methods of Polyspec\Orm\Dialect (the dialect's SQL), and Polyspec\Orm\Validator, which validator.c implements. The closures
 * that Dialect::valueFunction and Dialect::containsBinary take are fake closures of this file that call back into the planner while
 * the dialect call runs.
 */
#include "planner.h"
#include "validator.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_interfaces.h"
#include <stdarg.h>
#include <string.h>

#define RUNTIME_MODEL "Polyspec\\Orm\\RuntimeModel"
#define ORM_EXCEPTION "Polyspec\\Orm\\OrmException"

#define OKP(x)                \
    do {                      \
        if ((x) == NULL) {    \
            return NULL;      \
        }                     \
    } while (0)

#define OKB(x)                \
    do {                      \
        if (!(x)) {           \
            return false;     \
        }                     \
    } while (0)

/* ---- engine helpers ---- */

typedef struct vtemp {
    zval v;
    struct vtemp *next;
} vtemp;

typedef struct mem {
    void *p;
    struct mem *next;
} mem;

typedef struct pctx {
    zval *self;           /* $this */
    zval *dialect;        /* $this->d */
    zval *model;          /* $this->m */
    HashTable *entities;  /* $this->m->entities, borrowed */
    vtemp *temps;         /* values kept until the public call returns */
    mem *mems;            /* the planner's C structs, freed with the values */
} pctx;

/* A zval kept until release(). */
static zval *keep(pctx *c)
{
    vtemp *t = emalloc(sizeof(vtemp));
    ZVAL_UNDEF(&t->v);
    t->next = c->temps;
    c->temps = t;
    return &t->v;
}

/* A zeroed C struct kept until release(). */
static void *arena(pctx *c, size_t n)
{
    mem *m = emalloc(sizeof(mem));
    m->p = ecalloc(1, n);
    m->next = c->mems;
    c->mems = m;
    return m->p;
}

static void release(pctx *c)
{
    vtemp *t = c->temps;
    while (t != NULL) {
        vtemp *next = t->next;
        zval_ptr_dtor(&t->v);
        efree(t);
        t = next;
    }
    c->temps = NULL;
    mem *m = c->mems;
    while (m != NULL) {
        mem *next = m->next;
        efree(m->p);
        efree(m);
        m = next;
    }
    c->mems = NULL;
}

/* Throws an OrmException with the code and the formatted message, and returns NULL for the caller to return. */
static void *fail(const char *code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    zend_string *msg = zend_vstrpprintf(0, fmt, ap);
    va_end(ap);
    zend_string *cn = zend_string_init(ORM_EXCEPTION, sizeof(ORM_EXCEPTION) - 1, 0);
    zend_class_entry *ce = zend_lookup_class(cn);
    zend_string_release(cn);
    if (ce == NULL) {
        zend_string_release(msg);
        return NULL;
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
        return NULL;
    }
    zend_throw_exception_object(&ex);
    return NULL;
}

/* $h[$k] with ?? semantics: NULL when the key is missing or null. */
static zval *get(HashTable *h, const char *k)
{
    if (h == NULL) {
        return NULL;
    }
    zval *v = zend_hash_str_find(h, k, strlen(k));
    if (v == NULL) {
        return NULL;
    }
    ZVAL_DEREF(v);
    return Z_TYPE_P(v) == IS_NULL ? NULL : v;
}

/* $h[$k] when it is an array, or NULL. */
static HashTable *ga(HashTable *h, const char *k)
{
    zval *v = get(h, k);
    return (v != NULL && Z_TYPE_P(v) == IS_ARRAY) ? Z_ARRVAL_P(v) : NULL;
}

/* A list, or the empty array when it is missing (the ?? [] of the PHP code). */
static HashTable *lst(HashTable *h, const char *k)
{
    HashTable *a = ga(h, k);
    return a != NULL ? a : (HashTable *)&zend_empty_array;
}

/* A string value of z: the empty string for NULL, and the string form of any other scalar. */
static zend_string *zstr(pctx *c, zval *z)
{
    if (z == NULL) {
        return ZSTR_EMPTY_ALLOC();
    }
    if (Z_TYPE_P(z) == IS_STRING) {
        return Z_STR_P(z);
    }
    zval *k = keep(c);
    ZVAL_STR(k, zval_get_string(z));
    return Z_STR_P(k);
}

/* $h[$k] as a string (the ?? '' of the PHP code). */
static zend_string *gs(pctx *c, HashTable *h, const char *k)
{
    return zstr(c, get(h, k));
}

/* $h[$k] as an integer, def when missing. */
static zend_long gl(HashTable *h, const char *k, zend_long def)
{
    zval *v = get(h, k);
    return v == NULL ? def : zval_get_long(v);
}

/* empty($h[$k]) is its negation: the truth of the value, false when missing. */
static bool gt(HashTable *h, const char *k)
{
    zval *v = get(h, k);
    return v != NULL && zend_is_true(v);
}

/* isset($h[$k]). */
static bool isset_(HashTable *h, const char *k)
{
    return get(h, k) != NULL;
}

static zend_long count_of(HashTable *h)
{
    return h == NULL ? 0 : (zend_long)zend_hash_num_elements(h);
}

/* The values of a list, by position. */
static zval *at(HashTable *h, zend_long i)
{
    zval *v = zend_hash_index_find(h, (zend_ulong)i);
    if (v != NULL) {
        ZVAL_DEREF(v);
    }
    return v;
}

/* A formatted string, kept until release(). */
static zend_string *fmt(pctx *c, const char *f, ...)
{
    va_list ap;
    va_start(ap, f);
    zend_string *s = zend_vstrpprintf(0, f, ap);
    va_end(ap);
    zval *k = keep(c);
    ZVAL_STR(k, s);
    return s;
}

static zval *newlist(pctx *c)
{
    zval *z = keep(c);
    array_init(z);
    return z;
}

/* Appends a copy of v to a list. */
static void lpush(zval *list, zval *v)
{
    zval cp;
    ZVAL_COPY(&cp, v);
    add_next_index_zval(list, &cp);
}

/* Sets $arr[$key] to a copy of v. */
static void put(zval *arr, const char *key, zval *v)
{
    zval cp;
    ZVAL_COPY(&cp, v);
    zend_hash_str_update(Z_ARRVAL_P(arr), key, strlen(key), &cp);
}

static void puts_(zval *arr, const char *key, zend_string *s)
{
    zval z;
    ZVAL_STR_COPY(&z, s);
    zend_hash_str_update(Z_ARRVAL_P(arr), key, strlen(key), &z);
}

static void putc_(zval *arr, const char *key, const char *s)
{
    zval z;
    ZVAL_STRING(&z, s);
    zend_hash_str_update(Z_ARRVAL_P(arr), key, strlen(key), &z);
}

static void putl(zval *arr, const char *key, zend_long n)
{
    zval z;
    ZVAL_LONG(&z, n);
    zend_hash_str_update(Z_ARRVAL_P(arr), key, strlen(key), &z);
}

static void putb(zval *arr, const char *key, bool b)
{
    zval z;
    ZVAL_BOOL(&z, b);
    zend_hash_str_update(Z_ARRVAL_P(arr), key, strlen(key), &z);
}

/* A kept string, integer, boolean, or array (a copy of the reference of h). */
static zval *Zs(pctx *c, zend_string *s)
{
    zval *z = keep(c);
    ZVAL_STR_COPY(z, s);
    return z;
}

static zval *Zl(pctx *c, zend_long n)
{
    zval *z = keep(c);
    ZVAL_LONG(z, n);
    return z;
}

static zval *Zb(pctx *c, bool b)
{
    zval *z = keep(c);
    ZVAL_BOOL(z, b);
    return z;
}

static zval *Za(pctx *c, HashTable *h)
{
    zval *z = keep(c);
    zval tmp;
    ZVAL_ARR(&tmp, h);
    ZVAL_COPY(z, &tmp);
    return z;
}

/* The strings of a list joined by sep. */
static zend_string *implode(pctx *c, const char *sep, HashTable *list)
{
    smart_str buf = {0};
    zval *v;
    bool first = true;
    ZEND_HASH_FOREACH_VAL(list, v) {
        ZVAL_DEREF(v);
        if (!first) {
            smart_str_appends(&buf, sep);
        }
        first = false;
        smart_str_append(&buf, zstr(c, v));
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&buf);
    if (buf.s == NULL) {
        return ZSTR_EMPTY_ALLOC();
    }
    zval *k = keep(c);
    ZVAL_STR(k, buf.s);
    return buf.s;
}

/* $list === $other for two lists of strings. */
static bool same_list(HashTable *a, HashTable *b)
{
    if (count_of(a) != count_of(b)) {
        return false;
    }
    for (zend_long i = 0; i < count_of(a); i++) {
        zval *va = at(a, i), *vb = at(b, i);
        if (va == NULL || vb == NULL || Z_TYPE_P(va) != Z_TYPE_P(vb)) {
            return false;
        }
        if (Z_TYPE_P(va) == IS_STRING ? !zend_string_equals(Z_STR_P(va), Z_STR_P(vb)) : Z_LVAL_P(va) != Z_LVAL_P(vb)) {
            return false;
        }
    }
    return true;
}

/* in_array($s, $list, true) over a list of strings. */
static bool in_list(HashTable *list, zend_string *s)
{
    zval *v;
    ZEND_HASH_FOREACH_VAL(list, v) {
        ZVAL_DEREF(v);
        if (Z_TYPE_P(v) == IS_STRING && zend_string_equals(Z_STR_P(v), s)) {
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    return false;
}

/* array_column($rows, $key): the values of the rows of a list that have the key. */
static zval *column_of(pctx *c, HashTable *rows, const char *key)
{
    zval *out = newlist(c);
    zval *row;
    ZEND_HASH_FOREACH_VAL(rows, row) {
        ZVAL_DEREF(row);
        if (Z_TYPE_P(row) != IS_ARRAY) {
            continue;
        }
        zval *v = get(Z_ARRVAL_P(row), key);
        if (v != NULL) {
            lpush(out, v);
        }
    } ZEND_HASH_FOREACH_END();
    return out;
}

/* ---- library calls ---- */

/* Calls a public static method of a library class: the result is kept, or NULL with an exception. */
static zval *lib_static(pctx *c, const char *cls, const char *method, uint32_t argc, zval *argv)
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

/* Calls a public method of the Dialect object $this->d: the result is kept, or NULL with an exception. */
static zval *D(pctx *c, const char *method, uint32_t argc, zval *argv)
{
    zval cb;
    zval *ret = keep(c);
    ZVAL_UNDEF(ret);
    array_init(&cb);
    Z_TRY_ADDREF_P(c->dialect);
    add_next_index_zval(&cb, c->dialect);
    add_next_index_string(&cb, method);
    zend_result r = call_user_function(NULL, NULL, &cb, ret, argc, argv);
    zval_ptr_dtor(&cb);
    if (r != SUCCESS || EG(exception) != NULL) {
        return NULL;
    }
    return ret;
}

/* A string result of a Dialect method. NULL with an exception set, or for a null result (the ?string methods). */
static zend_string *Ds(pctx *c, const char *method, uint32_t argc, zval *argv)
{
    zval *r = D(c, method, argc, argv);
    if (r == NULL || Z_TYPE_P(r) == IS_NULL) {
        return NULL;
    }
    return zstr(c, r);
}

/* Dialect::quote($ident). */
static zend_string *quote(pctx *c, zend_string *ident)
{
    zval a[1] = {*Zs(c, ident)};
    return Ds(c, "quote", 1, a);
}

/* The public property $this->d->name. */
static zend_string *dialect_name(pctx *c)
{
    zval rv;
    zval *n = zend_read_property(Z_OBJCE_P(c->dialect), Z_OBJ_P(c->dialect), "name", sizeof("name") - 1, true, &rv);
    return zstr(c, n);
}

/* RuntimeModel::column($ent, $name) in *out: the column array, or NULL when the entity has no such column. False with an exception. */
static bool col_of(pctx *c, HashTable *ent, zend_string *name, HashTable **out)
{
    zval args[2];
    if (ent != NULL) {
        ZVAL_ARR(&args[0], ent);
    } else {
        ZVAL_NULL(&args[0]);
    }
    ZVAL_STR_COPY(&args[1], name);
    zval *r = lib_static(c, RUNTIME_MODEL, "column", 2, args);
    zval_ptr_dtor(&args[1]);
    if (r == NULL) {
        return false;
    }
    *out = Z_TYPE_P(r) == IS_ARRAY ? Z_ARRVAL_P(r) : NULL;
    return true;
}

/* RuntimeModel::encrypted($col) in *yes. False with an exception. */
static bool enc_of(pctx *c, HashTable *col, bool *yes)
{
    zval arg;
    if (col != NULL) {
        ZVAL_ARR(&arg, col);
    } else {
        ZVAL_NULL(&arg);
    }
    zval *r = lib_static(c, RUNTIME_MODEL, "encrypted", 1, &arg);
    if (r == NULL) {
        return false;
    }
    *yes = zend_is_true(r);
    return true;
}

/* RuntimeModel::HOST_STAGES: the styles that the executor runs. */
static HashTable *host_stages(void)
{
    zend_string *cn = zend_string_init(RUNTIME_MODEL, sizeof(RUNTIME_MODEL) - 1, 0);
    zend_string *kn = zend_string_init("HOST_STAGES", sizeof("HOST_STAGES") - 1, 0);
    zval *v = NULL;
    if (zend_lookup_class(cn) != NULL) {
        v = zend_get_class_constant_ex(cn, kn, NULL, 0);
    }
    zend_string_release(cn);
    zend_string_release(kn);
    return (v != NULL && Z_TYPE_P(v) == IS_ARRAY) ? Z_ARRVAL_P(v) : NULL;
}

/* $this->m->entities[$name], NULL when the model has no such entity. */
static HashTable *entity(pctx *c, zend_string *name)
{
    zval *v = zend_symtable_find(c->entities, name);
    if (v == NULL) {
        return NULL;
    }
    ZVAL_DEREF(v);
    return Z_TYPE_P(v) == IS_ARRAY ? Z_ARRVAL_P(v) : NULL;
}

/* ---- PlanBinds: the bind slots of one statement ---- */

typedef struct pbinds {
    zval *slots;   /* the list of slot arrays */
    zend_long subs;
    zval *tables;  /* name => true */
} pbinds;

static pbinds *binds_new(pctx *c)
{
    pbinds *b = arena(c, sizeof(pbinds));
    b->slots = newlist(c);
    b->tables = newlist(c);
    return b;
}

/* Quotes the entity's table name and records it as a table of the statement. */
static zend_string *b_table(pctx *c, pbinds *b, HashTable *ent)
{
    zend_string *t = gs(c, ent, "table");
    zval one;
    ZVAL_TRUE(&one);
    zend_hash_update(Z_ARRVAL_P(b->tables), t, &one);
    return quote(c, t);
}

static int bucket_strcmp(Bucket *a, Bucket *b)
{
    return zend_binary_strcmp(Z_STRVAL(a->val), Z_STRLEN(a->val), Z_STRVAL(b->val), Z_STRLEN(b->val));
}

/* The tables the statement used, sorted by name. */
static zval *b_tables(pctx *c, pbinds *b)
{
    zval *out = newlist(c);
    zend_string *key;
    zend_ulong idx;
    ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(b->tables), idx, key) {
        zval z;
        if (key != NULL) {
            ZVAL_STR_COPY(&z, key);
        } else {
            ZVAL_STR(&z, zend_long_to_str((zend_long)idx));
        }
        add_next_index_zval(out, &z);
    } ZEND_HASH_FOREACH_END();
    zend_hash_sort(Z_ARRVAL_P(out), bucket_strcmp, 1);
    return out;
}

/* Adds a slot and returns its placeholder, the dialect's placeholder of the slot count. */
static zend_string *b_add(pctx *c, pbinds *b, zval *slot)
{
    lpush(b->slots, slot);
    zval *n = Zl(c, count_of(Z_ARRVAL_P(b->slots)));
    return Ds(c, "placeholder", 1, n);
}

/* Adds a typed slot: a planner error when the slot has no declared type. */
static zend_string *b_typed(pctx *c, pbinds *b, zval *slot)
{
    zval *t = get(Z_ARRVAL_P(slot), "col_type");
    if (t == NULL || zstr(c, t)->len == 0) {
        zend_string *from = gs(c, Z_ARRVAL_P(slot), "from");
        return fail("IR_INVALID", "bind slot %d (%s) has no declared type", (int)count_of(Z_ARRVAL_P(b->slots)),
            ZSTR_VAL(from));
    }
    return b_add(c, b, slot);
}

/* The placeholder of request value Params[$i], of dbspec type $type. */
static zend_string *b_param(pctx *c, pbinds *b, zend_long i, zend_string *type, zend_string *transform, HashTable *hostStyles)
{
    zval *slot = newlist(c);
    putc_(slot, "from", "param");
    putl(slot, "param", i);
    if (ZSTR_LEN(transform) > 0) {
        puts_(slot, "transform", transform);
    }
    if (count_of(hostStyles) > 0) {
        put(slot, "host_styles", Za(c, hostStyles));
    }
    puts_(slot, "col_type", type);
    if (zend_string_equals_literal(type, "datetime") || zend_string_equals_literal(type, "time")) {
        putl(slot, "precision", 6);
    }
    return b_typed(c, b, slot);
}

/* The placeholder of request value Params[$i] compared with or assigned to column $col. */
static zend_string *b_col_param(pctx *c, pbinds *b, zend_long i, HashTable *col, zend_string *transform, HashTable *hostStyles)
{
    zval *slot = newlist(c);
    putc_(slot, "from", "param");
    putl(slot, "param", i);
    if (ZSTR_LEN(transform) > 0) {
        puts_(slot, "transform", transform);
    }
    if (count_of(hostStyles) > 0) {
        put(slot, "host_styles", Za(c, hostStyles));
    }
    zend_string *type = gs(c, col, "type");
    puts_(slot, "col_type", type);
    if (zend_string_equals_literal(type, "decimal")) {
        putl(slot, "precision", gl(col, "precision", 0));
        putl(slot, "scale", gl(col, "scale", 0));
    } else if (zend_string_equals_literal(type, "datetime") || zend_string_equals_literal(type, "time")) {
        putl(slot, "precision", gl(col, "precision", 0));
    } else if (zend_string_equals_literal(type, "varchar")) {
        putl(slot, "length", gl(col, "length", 0));
    }
    return b_typed(c, b, slot);
}

/* Plaintext the executor hashes with the blind-index key. */
static zend_string *b_blind_index(pctx *c, pbinds *b, zend_long i, zend_string *type)
{
    zval *hs = newlist(c);
    zval one;
    ZVAL_STRING(&one, "blind_index");
    add_next_index_zval(hs, &one);
    return b_param(c, b, i, type, ZSTR_EMPTY_ALLOC(), Z_ARRVAL_P(hs));
}

/* An executor setting value. */
static zend_string *b_config(pctx *c, pbinds *b, const char *name, zend_string *type)
{
    zval *slot = newlist(c);
    putc_(slot, "from", "config");
    putl(slot, "param", 0);
    putc_(slot, "name", name);
    puts_(slot, "col_type", type);
    return b_typed(c, b, slot);
}

/* The executor's clock, truncated to the given fractional digits. */
static zend_string *b_now(pctx *c, pbinds *b, zend_long precision)
{
    zval *slot = newlist(c);
    putc_(slot, "from", "now");
    putl(slot, "param", 0);
    putl(slot, "precision", precision);
    putc_(slot, "col_type", "datetime");
    return b_typed(c, b, slot);
}

/* The key of the transaction's audit record. */
static zend_string *b_audit(pctx *c, pbinds *b, HashTable *ent)
{
    HashTable *col = NULL;
    if (!col_of(c, ent, gs(c, ent, "audit"), &col)) {
        return NULL;
    }
    zval *slot = newlist(c);
    putc_(slot, "from", "audit");
    putl(slot, "param", 0);
    puts_(slot, "name", gs(c, ent, "audit_record"));
    puts_(slot, "col_type", gs(c, col, "type"));
    return b_typed(c, b, slot) ;
}

/* The one placeholder the executor expands to the parent key values. */
static zend_string *b_parent(pctx *c, pbinds *b, zend_long step, zval *keyTypes)
{
    zval *slot = newlist(c);
    putc_(slot, "from", "parent");
    putl(slot, "param", 0);
    if (step != 0) {
        putl(slot, "step", step);
    }
    put(slot, "key_types", keyTypes);
    return b_add(c, b, slot);
}

/* ---- the scopes and the plan's helper structs ---- */

/* One entity occurrence of a statement: the root, a join, or a subquery root. */
typedef struct pscope {
    HashTable *ent;
    zend_string *alias;
    HashTable *q;
    struct pscope *parent;
    struct pscope *outer;
    zval *joins;  /* rel => IS_PTR to pscope */
    zval *extra;  /* the columns a relation step needs selected */
} pscope;

static pscope *scope_new(pctx *c, HashTable *ent, zend_string *alias, HashTable *q, pscope *parent)
{
    pscope *s = arena(c, sizeof(pscope));
    s->ent = ent;
    s->alias = alias;
    s->q = q;
    s->parent = parent;
    s->joins = newlist(c);
    s->extra = newlist(c);
    return s;
}

/* The scope of a join by its relation name (the join must be there). */
static pscope *join_of(pscope *s, zend_string *name)
{
    zval *v = zend_hash_find(Z_ARRVAL_P(s->joins), name);
    return v == NULL ? NULL : Z_PTR_P(v);
}

/* The statement's assembly of one result: its columns, children and key. */
typedef struct passm {
    zend_string *entity;
    zend_string *alias;
    zval *columns;
    zval *children;  /* IS_PTR to pchild */
    zval *key;
} passm;

static passm *asm_new(pctx *c, zend_string *entity, zend_string *alias)
{
    passm *a = arena(c, sizeof(passm));
    a->entity = entity;
    a->alias = alias;
    a->columns = newlist(c);
    a->children = newlist(c);
    a->key = newlist(c);
    return a;
}

/* A join or relation child of an assembly. */
typedef struct pchild {
    zend_string *rel;
    zend_string *kind;
    zend_long step;
    zval *parentKeys;
    zval *childKeys;
    zval *key;
    bool flatten;
    bool cascade;
    passm *assemble;
} pchild;

static pchild *child_new(pctx *c, zend_string *rel, zend_string *kind)
{
    pchild *ch = arena(c, sizeof(pchild));
    ch->rel = rel;
    ch->kind = kind;
    ch->parentKeys = newlist(c);
    ch->childKeys = newlist(c);
    ch->key = newlist(c);
    return ch;
}

/* The relation a relation step loads. */
typedef struct prel {
    zend_long parentStep;
    passm *parentAsm;
    zval *parentKeys;
    zval *childKeys;
    zend_string *kind;
} prel;

/* One statement of the plan. */
typedef struct pstep {
    zend_long id;
    zend_string *role;
    zend_string *sql;
    zend_string *lock;
    zval *slots;
    zval *tables;
    passm *assemble;
    zval *parent;  /* NULL or the array of the relation */
} pstep;

static pstep *step_new(pctx *c, const char *role, zend_string *sql, zend_string *lock, zval *slots, zval *tables)
{
    pstep *st = arena(c, sizeof(pstep));
    st->role = fmt(c, "%s", role);
    st->lock = lock;
    st->sql = sql;
    st->lock = lock;
    st->slots = slots;
    st->tables = tables;
    return st;
}

/* Adds a statement to the steps: its id is the count of the steps before it. */
static void steps_add(pctx *c, zval *steps, pstep *st)
{
    (void)c;
    st->id = count_of(Z_ARRVAL_P(steps));
    zval z;
    ZVAL_PTR(&z, st);
    add_next_index_zval(steps, &z);
}

static pstep *step_at(zval *steps, zend_long i)
{
    zval *v = at(Z_ARRVAL_P(steps), i);
    return Z_PTR_P(v);
}

/* A copy of a list of values, so that a statement keeps the bind slots it had. */
static zval *copy_list(pctx *c, HashTable *h)
{
    zval *z = keep(c);
    ZVAL_ARR(z, zend_array_dup(h));
    return z;
}

/* PlanStep::toArray(). */
static zval *step_array(pctx *c, pstep *st);
static zval *assemble_array(pctx *c, passm *a);

static zval *child_array(pctx *c, pchild *ch)
{
    zval *out = newlist(c);
    putc_(out, "rel", ZSTR_VAL(ch->rel));
    putc_(out, "kind", ZSTR_VAL(ch->kind));
    if (ch->step != 0) {
        putl(out, "step", ch->step);
    }
    if (count_of(Z_ARRVAL_P(ch->parentKeys)) > 0) {
        put(out, "parent_keys", ch->parentKeys);
    }
    if (count_of(Z_ARRVAL_P(ch->childKeys)) > 0) {
        put(out, "child_keys", ch->childKeys);
    }
    if (count_of(Z_ARRVAL_P(ch->key)) > 0) {
        put(out, "key", ch->key);
    }
    if (ch->flatten) {
        putb(out, "flatten", true);
    }
    if (ch->cascade) {
        putb(out, "cascade", true);
    }
    if (ch->assemble != NULL) {
        put(out, "assemble", assemble_array(c, ch->assemble));
    }
    return out;
}

static zval *assemble_array(pctx *c, passm *a)
{
    zval *out = newlist(c);
    puts_(out, "entity", a->entity);
    puts_(out, "alias", a->alias);
    put(out, "columns", a->columns);
    if (count_of(Z_ARRVAL_P(a->children)) > 0) {
        zval *children = newlist(c);
        zval *v;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(a->children), v) {
            lpush(children, child_array(c, Z_PTR_P(v)));
        } ZEND_HASH_FOREACH_END();
        put(out, "children", children);
    }
    put(out, "key", a->key);
    return out;
}

static zval *step_array(pctx *c, pstep *st)
{
    zval *out = newlist(c);
    putl(out, "id", st->id);
    puts_(out, "role", st->role);
    puts_(out, "sql", st->sql);
    put(out, "tables", st->tables);
    if (ZSTR_LEN(st->lock) > 0) {
        puts_(out, "lock", st->lock);
    }
    put(out, "bind_slots", st->slots);
    if (st->assemble != NULL) {
        put(out, "assemble", assemble_array(c, st->assemble));
    }
    if (st->parent != NULL) {
        put(out, "parent", st->parent);
    }
    return out;
}

/* ---- the helpers of the statement builders ---- */

static zend_string *qcol(pctx *c, pscope *s, zend_string *col);
static zend_string *sub_type(pctx *c, HashTable *sub);

/* Appends a string to a list. */
static void lpushs(zval *list, zend_string *s)
{
    add_next_index_str(list, zend_string_copy(s));
}

/* The position of a projected column of an assembly, -1 with an INTERNAL exception when it is not projected. */
static zend_long index_of(passm *a, zend_string *name)
{
    zval *v;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(a->columns), v) {
        ZVAL_DEREF(v);
        HashTable *col = Z_ARRVAL_P(v);
        zval *n = get(col, "name");
        if (n != NULL && Z_TYPE_P(n) == IS_STRING && zend_string_equals(Z_STR_P(n), name)) {
            return zval_get_long(get(col, "index"));
        }
    } ZEND_HASH_FOREACH_END();
    fail("INTERNAL", "column %s is not projected in %s", ZSTR_VAL(name), ZSTR_VAL(a->entity));
    return -1;
}

/* Planner::keyRefs: the column and its index in the assembly, for each column of the list. */
static zval *key_refs(pctx *c, passm *a, HashTable *cols)
{
    zval *out = newlist(c);
    zval *v;
    ZEND_HASH_FOREACH_VAL(cols, v) {
        ZVAL_DEREF(v);
        zend_string *n = zstr(c, v);
        zend_long i = index_of(a, n);
        if (i < 0) {
            return NULL;
        }
        zval *row = newlist(c);
        puts_(row, "column", n);
        putl(row, "index", i);
        lpush(out, row);
    } ZEND_HASH_FOREACH_END();
    return out;
}

/* The column of an output: its index, name, column, type, styles and whether it is hidden. */
static zval *out_col(pctx *c, zend_long index, zend_string *name, zend_string *column, zend_string *type, zval *styles,
    bool hidden)
{
    zval *o = newlist(c);
    putl(o, "index", index);
    puts_(o, "name", name);
    if (ZSTR_LEN(column) > 0) {
        puts_(o, "column", column);
    }
    puts_(o, "type", type);
    if (count_of(Z_ARRVAL_P(styles)) > 0) {
        put(o, "styles", styles);
    }
    if (hidden) {
        putb(o, "hidden", true);
    }
    return o;
}

/* The styles of a column that the dialect handles (want is true) or does not handle (want is false), in codec order. */
static zval *codec_filter(pctx *c, HashTable *col, const char *method, bool want)
{
    zval *out = newlist(c);
    zval *st;
    ZEND_HASH_FOREACH_VAL(lst(col, "codec"), st) {
        ZVAL_DEREF(st);
        zval a[1] = {*st};
        zval *r = D(c, method, 1, a);
        OKP(r);
        if (zend_is_true(r) == want) {
            lpush(out, st);
        }
    } ZEND_HASH_FOREACH_END();
    return out;
}

/* The styles that the dialect writes in SQL. */
static zval *sql_styles(pctx *c, HashTable *col)
{
    return codec_filter(c, col, "handlesStyle", true);
}

/* The styles that the dialect decodes in SQL on read. */
static zval *read_sql_styles(pctx *c, HashTable *col)
{
    return codec_filter(c, col, "decodesStyle", true);
}

/* The styles that the executor (the client) runs for a column. */
static zval *client_styles(pctx *c, HashTable *col)
{
    return codec_filter(c, col, "decodesStyle", false);
}

/* A column read with its SQL-side read stages; a time(p) column reads as its p-digit text. */
static zend_string *read_column(pctx *c, zend_string *qc, HashTable *col)
{
    zval *styles = read_sql_styles(c, col);
    OKP(styles);
    zval e[2] = {*Zs(c, qc), *styles};
    zend_string *expr = Ds(c, "readExpr", 2, e);
    OKP(expr);
    zend_string *type = gs(c, col, "type");
    if (zend_string_equals_literal(type, "uuid")) {
        zval a[1] = {*Zs(c, expr)};
        return Ds(c, "readUuid", 1, a);
    }
    if (zend_string_equals_literal(type, "time")) {
        zval a[2] = {*Zs(c, expr), *Zl(c, gl(col, "precision", 0))};
        return Ds(c, "readTime", 2, a);
    }
    return expr;
}

/* The type of the value that a SQL-side style function receives at its placeholder: hex receives bytes, ip text. */
static zend_string *style_input_type(pctx *c, zend_string *style)
{
    return fmt(c, "%s", zend_string_equals_literal(style, "ip") ? "text" : "bytes");
}

/* The dbspec type of a value function's result (Validator::functionType). */
static zend_string *function_type(pctx *c, zend_string *name, HashTable *col)
{
    zval *r = keep(c);
    validator_function_type(name, col, r);
    return Z_STR_P(r);
}

/* The dbspec type of an interval amount (Validator::intervalType). */
static zend_string *interval_type(pctx *c, zend_string *name)
{
    zval *r = keep(c);
    validator_interval_type(name, r);
    return Z_STR_P(r);
}

/* A column function of a scope: the dialect's expression of the function on the column. */
static zend_string *column_function(pctx *c, pscope *s, zend_string *column, HashTable *f)
{
    zend_string *name = gs(c, f, "name");
    zend_string *q = qcol(c, s, column);
    OKP(q);
    zval e[2] = {*Zs(c, name), *Zs(c, q)};
    zend_string *r = Ds(c, "columnFunction", 2, e);
    if (r == NULL) {
        if (EG(exception) != NULL) {
            return NULL;
        }
        return fail("CAPABILITY_UNSUPPORTED", "%s is not available on %s", ZSTR_VAL(name), ZSTR_VAL(dialect_name(c)));
    }
    return r;
}

/* The scope of a join by the relation path of a reference; ^ is the outer query and "" the root. */
static pscope *resolve_path(pctx *c, pscope *s, zend_string *path)
{
    pscope *cur = s;
    while (cur->parent != NULL) {
        cur = cur->parent;
    }
    if (zend_string_equals_literal(path, "^")) {
        if (cur->outer == NULL) {
            return fail("IR_INVALID", "^ reference outside a subquery");
        }
        return cur->outer;
    }
    if (ZSTR_LEN(path) == 0) {
        return cur;
    }
    const char *p = ZSTR_VAL(path);
    const char *end = p + ZSTR_LEN(path);
    while (p <= end) {
        const char *slash = memchr(p, '/', end - p);
        size_t n = slash != NULL ? (size_t)(slash - p) : (size_t)(end - p);
        zend_string *seg = zend_string_init(p, n, 0);
        zval *k = keep(c);
        ZVAL_STR(k, seg);
        zval *v = zend_hash_find(Z_ARRVAL_P(cur->joins), seg);
        if (v == NULL) {
            return fail("ENTITY_NOT_JOINED", "%s.%s", ZSTR_VAL(gs(c, cur->ent, "entity")), ZSTR_VAL(seg));
        }
        cur = Z_PTR_P(v);
        if (slash == NULL) {
            break;
        }
        p = slash + 1;
    }
    return cur;
}

/* ---- the statement builders (Planner.php) ---- */

static pscope *scopes(pctx *c, HashTable *q, zend_string *alias, pscope *parent);
static zend_string *render_group(pctx *c, pbinds *b, pscope *s, HashTable *g, bool top);
static zend_string *render_pred(pctx *c, pbinds *b, pscope *s, HashTable *p);
static zend_string *render_joins(pctx *c, pbinds *b, pscope *s);
static bool collect_join_where(pctx *c, pbinds *b, pscope *s, zval *where);
static zend_string *render_order(pctx *c, pbinds *b, pscope *s, HashTable *q);
static zend_string *sub_select(pctx *c, pbinds *b, pscope *outer, HashTable *sub);
static zend_string *value_function_sql(pctx *c, pbinds *b, zend_string *fn, zend_long ps0);
static zend_string *contains_binary_sql(pctx *c, pbinds *b, zend_string *lhs, HashTable *col, zend_long p);
static pstep *select_step(pctx *c, zval *steps, HashTable *q, const char *kind, zend_string *agg, prel *rc);
static bool relation_steps(pctx *c, zval *steps, pscope *s, passm *ast, zend_long stepId);
static zend_string *select_list(pctx *c, pbinds *b, pscope *s, passm *ast, zend_long *idx, zval *outNames);
static zval *projection(pctx *c, pscope *s);
static zend_string *render_value(pctx *c, pbinds *b, HashTable *col, zend_long i);

/* The positional parameters of a predicate (its ps list). */
static HashTable *ps_of(HashTable *p)
{
    return lst(p, "ps");
}

/* A kept null value. */
static zval *keep_null(pctx *c)
{
    zval *z = keep(c);
    ZVAL_NULL(z);
    return z;
}

/* ksort with SORT_STRING: the keys compared as their bytes. */
static int bucket_key_cmp(Bucket *a, Bucket *b)
{
    char ba[32], bb[32];
    const char *pa, *pb;
    size_t la, lb;
    if (a->key != NULL) {
        pa = ZSTR_VAL(a->key);
        la = ZSTR_LEN(a->key);
    } else {
        la = (size_t)snprintf(ba, sizeof(ba), ZEND_LONG_FMT, (zend_long)a->h);
        pa = ba;
    }
    if (b->key != NULL) {
        pb = ZSTR_VAL(b->key);
        lb = ZSTR_LEN(b->key);
    } else {
        lb = (size_t)snprintf(bb, sizeof(bb), ZEND_LONG_FMT, (zend_long)b->h);
        pb = bb;
    }
    return zend_binary_strcmp(pa, la, pb, lb);
}

/* The scope of a statement's entity (Planner::scopes): the joins are scoped by their path, nested joins prefixed by their parent. */
static pscope *scopes(pctx *c, HashTable *q, zend_string *alias, pscope *parent)
{
    HashTable *ent = entity(c, gs(c, q, "entity"));
    pscope *s = scope_new(c, ent, alias, q, parent);
    zval *j;
    ZEND_HASH_FOREACH_VAL(lst(q, "joins"), j) {
        ZVAL_DEREF(j);
        HashTable *jh = Z_ARRVAL_P(j);
        zend_string *rel = gs(c, jh, "rel");
        zend_string *ja = rel;
        if (parent != NULL || !zend_string_equals_literal(alias, "a")) {
            ja = fmt(c, "%s__%s", ZSTR_VAL(alias), ZSTR_VAL(rel));
        }
        pscope *child = scopes(c, ga(jh, "query"), ja, s);
        if (child == NULL) {
            return NULL;
        }
        zval z;
        ZVAL_PTR(&z, child);
        zend_hash_update(Z_ARRVAL_P(s->joins), rel, &z);
    } ZEND_HASH_FOREACH_END();
    return s;
}

/* Quotes a column of a scope: qcol. */
static zend_string *qcol(pctx *c, pscope *s, zend_string *col)
{
    zend_string *a = quote(c, s->alias);
    OKP(a);
    zend_string *q = quote(c, col);
    OKP(q);
    return fmt(c, "%s.%s", ZSTR_VAL(a), ZSTR_VAL(q));
}

/* The quoted columns of a list, qualified by the scope. */
static zval *qualified(pctx *c, pscope *s, HashTable *cols)
{
    zval *out = newlist(c);
    zval *v;
    ZEND_HASH_FOREACH_VAL(cols, v) {
        ZVAL_DEREF(v);
        zend_string *q = qcol(c, s, zstr(c, v));
        OKP(q);
        lpushs(out, q);
    } ZEND_HASH_FOREACH_END();
    return out;
}

/* The projection of a scope: its columns, the columns its relations need, and its named functions and subqueries. */
static zval *projection(pctx *c, pscope *s)
{
    HashTable *cols = ga(s->q, "columns");
    zend_string *mode = gs(c, cols, "mode");
    zval *base = newlist(c);
    zval *col;
    ZEND_HASH_FOREACH_VAL(lst(s->ent, "columns"), col) {
        ZVAL_DEREF(col);
        HashTable *ch = Z_ARRVAL_P(col);
        bool keep_col;
        if (zend_string_equals_literal(mode, "all")) {
            keep_col = true;
        } else if (zend_string_equals_literal(mode, "none")) {
            keep_col = gt(ch, "pk") || gt(ch, "foreign_key");
        } else {
            keep_col = gt(ch, "select");
        }
        if (keep_col) {
            lpushs(base, gs(c, ch, "name"));
        }
    } ZEND_HASH_FOREACH_END();
    zval *a;
    ZEND_HASH_FOREACH_VAL(lst(cols, "add"), a) {
        ZVAL_DEREF(a);
        zend_string *x = zstr(c, a);
        if (!in_list(Z_ARRVAL_P(base), x)) {
            lpushs(base, x);
        }
    } ZEND_HASH_FOREACH_END();
    if (count_of(lst(cols, "remove")) > 0) {
        zval *nb = newlist(c);
        zval *x;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(base), x) {
            zend_string *n = Z_STR_P(x);
            bool kept = !in_list(lst(cols, "remove"), n);
            if (!kept) {
                HashTable *xc = NULL;
                if (!col_of(c, s->ent, n, &xc)) {
                    return NULL;
                }
                kept = gt(xc, "pk");
            }
            if (kept) {
                lpushs(nb, n);
            }
        } ZEND_HASH_FOREACH_END();
        base = nb;
    }
    zval *need = newlist(c);
    zval *x;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(s->extra), x) {
        lpush(need, x);
    } ZEND_HASH_FOREACH_END();
    zval *r;
    ZEND_HASH_FOREACH_VAL(lst(s->q, "relations"), r) {
        ZVAL_DEREF(r);
        HashTable *rh = Z_ARRVAL_P(r);
        zval *k;
        ZEND_HASH_FOREACH_VAL(lst(rh, "keys"), k) {
            zval *left = get(Z_ARRVAL_P(k), "left");
            if (left != NULL) {
                lpush(need, left);
            }
        } ZEND_HASH_FOREACH_END();
        HashTable *qh = ga(rh, "query");
        if (isset_(qh, "if_parent")) {
            zval *col2 = get(ga(qh, "if_parent"), "column");
            if (col2 != NULL) {
                lpush(need, col2);
            }
        }
    } ZEND_HASH_FOREACH_END();
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(need), x) {
        ZVAL_DEREF(x);
        zend_string *n = zstr(c, x);
        if (!in_list(Z_ARRVAL_P(base), n)) {
            lpushs(base, n);
        }
    } ZEND_HASH_FOREACH_END();
    zval *pk;
    ZEND_HASH_FOREACH_VAL(lst(s->ent, "pk"), pk) {
        ZVAL_DEREF(pk);
        zend_string *n = zstr(c, pk);
        if (!in_list(Z_ARRVAL_P(base), n)) {
            /* array_unshift: the key goes first */
            zval *nb = newlist(c);
            lpushs(nb, n);
            zval *v;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(base), v) {
                lpush(nb, v);
            } ZEND_HASH_FOREACH_END();
            base = nb;
        }
    } ZEND_HASH_FOREACH_END();
    zval *out = newlist(c);
    zval *bv;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(base), bv) {
        zend_string *n = Z_STR_P(bv);
        zval *e = newlist(c);
        puts_(e, "name", n);
        puts_(e, "column", n);
        lpush(out, e);
    } ZEND_HASH_FOREACH_END();
    const char *kinds[] = {"fn", "sub"};
    for (int k = 0; k < 2; k++) {
        HashTable *named = lst(cols, kinds[k]);
        zval *sorted = keep(c);
        ZVAL_ARR(sorted, zend_array_dup(named));
        zend_hash_sort(Z_ARRVAL_P(sorted), bucket_key_cmp, 0);
        zend_string *key;
        zend_ulong kidx;
        zval *v;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(sorted), kidx, key, v) {
            ZVAL_DEREF(v);
            zend_string *name = key != NULL ? key : zend_long_to_str((zend_long)kidx);
            zval *e = newlist(c);
            puts_(e, "name", name);
            if (k == 0) {
                puts_(e, "column", zstr(c, get(Z_ARRVAL_P(v), "column")));
                put(e, "fn", get(Z_ARRVAL_P(v), "fn") != NULL ? get(Z_ARRVAL_P(v), "fn") : keep_null(c));
            } else {
                puts_(e, "column", ZSTR_EMPTY_ALLOC());
                put(e, "sub", v);
            }
            lpush(out, e);
        } ZEND_HASH_FOREACH_END();
    }
    return out;
}

/* Planner::renderJoins: the joins of a scope, each with its ON condition and its nested joins. */
static zend_string *render_joins(pctx *c, pbinds *b, pscope *s)
{
    zend_string *sql = ZSTR_EMPTY_ALLOC();
    zval *j;
    ZEND_HASH_FOREACH_VAL(lst(s->q, "joins"), j) {
        ZVAL_DEREF(j);
        HashTable *jh = Z_ARRVAL_P(j);
        pscope *js = join_of(s, gs(c, jh, "rel"));
        if (js == NULL) {
            return fail("INTERNAL", "join %s is not in the scope", ZSTR_VAL(gs(c, jh, "rel")));
        }
        const char *kw = zend_string_equals_literal(gs(c, jh, "kind"), "left") ? " LEFT JOIN " : " INNER JOIN ";
        zend_string *lq = qcol(c, s, gs(c, jh, "left"));
        OKP(lq);
        zend_string *rq = qcol(c, js, gs(c, jh, "right"));
        OKP(rq);
        zval *conds = newlist(c);
        lpushs(conds, fmt(c, "%s = %s", ZSTR_VAL(lq), ZSTR_VAL(rq)));
        zend_string *soft = gs(c, js->ent, "soft_delete");
        if (ZSTR_LEN(soft) > 0) {
            zend_string *sq = qcol(c, js, soft);
            OKP(sq);
            lpushs(conds, fmt(c, "%s IS NULL", ZSTR_VAL(sq)));
        }
        zend_string *tbl = b_table(c, b, js->ent);
        OKP(tbl);
        zend_string *qa = quote(c, js->alias);
        OKP(qa);
        zend_string *on = implode(c, " AND ", Z_ARRVAL_P(conds));
        zend_string *part = fmt(c, "%s%s AS %s ON %s", kw, ZSTR_VAL(tbl), ZSTR_VAL(qa), ZSTR_VAL(on));
        HashTable *onGroup = ga(ga(jh, "query"), "on");
        if (count_of(lst(onGroup, "items")) > 0) {
            zend_string *g = render_group(c, b, js, onGroup, true);
            OKP(g);
            part = fmt(c, "%s AND %s", ZSTR_VAL(part), ZSTR_VAL(g));
        }
        zend_string *nested = render_joins(c, b, js);
        OKP(nested);
        sql = fmt(c, "%s%s%s", ZSTR_VAL(sql), ZSTR_VAL(part), ZSTR_VAL(nested));
    } ZEND_HASH_FOREACH_END();
    return sql;
}

/* The joins that a where group places (placedJoins): their relation names as keys. */
static void placed_joins(pctx *c, HashTable *g, HashTable *out)
{
    zval *it;
    ZEND_HASH_FOREACH_VAL(lst(g, "items"), it) {
        ZVAL_DEREF(it);
        HashTable *ih = Z_ARRVAL_P(it);
        if (isset_(ih, "joined")) {
            zval t;
            ZVAL_TRUE(&t);
            zend_hash_update(out, gs(c, ga(ih, "joined"), "join"), &t);
        }
        if (isset_(ih, "group")) {
            placed_joins(c, ga(ih, "group"), out);
        }
    } ZEND_HASH_FOREACH_END();
}

/* Appends each join's where group that no joined item placed (collectJoinWhere). */
static bool collect_join_where(pctx *c, pbinds *b, pscope *s, zval *where)
{
    zval placed_z;
    array_init(&placed_z);
    if (isset_(s->q, "where")) {
        placed_joins(c, ga(s->q, "where"), Z_ARRVAL(placed_z));
    }
    zval *j;
    ZEND_HASH_FOREACH_VAL(lst(s->q, "joins"), j) {
        ZVAL_DEREF(j);
        HashTable *jh = Z_ARRVAL_P(j);
        zend_string *rel = gs(c, jh, "rel");
        pscope *js = join_of(s, rel);
        if (js == NULL) {
            zval_ptr_dtor(&placed_z);
            fail("INTERNAL", "join %s is not in the scope", ZSTR_VAL(rel));
            return false;
        }
        HashTable *jw = ga(ga(jh, "query"), "where");
        if (count_of(lst(jw, "items")) > 0 && zend_hash_find(Z_ARRVAL(placed_z), rel) == NULL) {
            zend_string *g = render_group(c, b, js, jw, false);
            if (g == NULL) {
                zval_ptr_dtor(&placed_z);
                return false;
            }
            lpushs(where, g);
        }
        if (!collect_join_where(c, b, js, where)) {
            zval_ptr_dtor(&placed_z);
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&placed_z);
    return true;
}

/* A group; the top group has no parentheses (Planner::renderGroup). */
static zend_string *render_group(pctx *c, pbinds *b, pscope *s, HashTable *g, bool top)
{
    zval *parts = newlist(c);
    zval *it;
    zend_long i = 0;
    ZEND_HASH_FOREACH_VAL(lst(g, "items"), it) {
        ZVAL_DEREF(it);
        HashTable *ih = Z_ARRVAL_P(it);
        zend_string *conn;
        zend_string *text;
        if (isset_(ih, "pred")) {
            HashTable *ph = ga(ih, "pred");
            conn = gs(c, ph, "conn");
            text = render_pred(c, b, s, ph);
        } else if (isset_(ih, "group")) {
            HashTable *gh = ga(ih, "group");
            conn = gs(c, gh, "conn");
            text = render_group(c, b, s, gh, false);
        } else {
            HashTable *jh = ga(ih, "joined");
            conn = gs(c, jh, "conn");
            pscope *js = join_of(s, gs(c, jh, "join"));
            if (js == NULL) {
                return fail("INTERNAL", "join %s is not in the scope", ZSTR_VAL(gs(c, jh, "join")));
            }
            text = render_group(c, b, js, ga(js->q, "where"), false);
        }
        OKP(text);
        if (i > 0) {
            lpushs(parts, fmt(c, "%s", zend_string_equals_literal(conn, "or") ? "OR" : "AND"));
        }
        lpushs(parts, text);
        i++;
    } ZEND_HASH_FOREACH_END();
    zend_string *out = implode(c, " ", Z_ARRVAL_P(parts));
    zend_string *grouped = top ? out : fmt(c, "(%s)", ZSTR_VAL(out));
    if (!gt(g, "not")) {
        return grouped;
    }
    return fmt(c, "NOT %s", ZSTR_VAL(grouped));
}

/* Planner::cmp: the SQL comparison of an operator name. */
static const char *cmp_of(const char *op)
{
    if (strcmp(op, "eq") == 0) {
        return "=";
    }
    if (strcmp(op, "not_eq") == 0) {
        return "!=";
    }
    if (strcmp(op, "gt") == 0) {
        return ">";
    }
    if (strcmp(op, "gte") == 0) {
        return ">=";
    }
    if (strcmp(op, "lt") == 0) {
        return "<";
    }
    if (strcmp(op, "lte") == 0) {
        return "<=";
    }
    return "=";
}

/* The blind index of an AES column for equality search. */
static zend_string *blind_index_of(pctx *c, pscope *s, HashTable *col)
{
    zend_string *bi = gs(c, col, "blind_index");
    if (ZSTR_LEN(bi) == 0) {
        return fail("IR_INVALID", "%s.%s requires a declared blind index for equality search",
            ZSTR_VAL(gs(c, s->ent, "entity")), ZSTR_VAL(gs(c, col, "name")));
    }
    return bi;
}

/* One predicate of a where group (Planner::renderPred). */
static zend_string *render_pred(pctx *c, pbinds *b, pscope *s, HashTable *p)
{
    zend_string *op = gs(c, p, "op");
    const char *ops = ZSTR_VAL(op);
    if (strcmp(ops, "tuple_in") == 0 || strcmp(ops, "tuple_not_in") == 0) {
        HashTable *cols = lst(p, "cols");
        HashTable *ps = lst(p, "ps");
        zend_long n = count_of(cols);
        zval *rows = newlist(c);
        for (zend_long start = 0; n > 0 && start < count_of(ps); start += n) {
            zval *row = newlist(c);
            zend_long k = 0;
            zval *name;
            ZEND_HASH_FOREACH_VAL(cols, name) {
                ZVAL_DEREF(name);
                HashTable *colh = NULL;
                if (!col_of(c, s->ent, zstr(c, name), &colh)) {
                    return NULL;
                }
                zval *vi = at(ps, start + k);
                zend_string *ph = render_value(c, b, colh, vi != NULL ? zval_get_long(vi) : 0);
                OKP(ph);
                lpushs(row, ph);
                k++;
            } ZEND_HASH_FOREACH_END();
            lpush(rows, row);
        }
        zval *qcols = qualified(c, s, cols);
        OKP(qcols);
        zval a[3] = {*qcols, *rows, *Zb(c, strcmp(ops, "tuple_not_in") == 0)};
        return Ds(c, "tupleIn", 3, a);
    }
    HashTable *colh = NULL;
    if (!col_of(c, s->ent, gs(c, p, "column"), &colh)) {
        return NULL;
    }
    zend_string *lhs = qcol(c, s, gs(c, p, "column"));
    OKP(lhs);
    if (isset_(p, "sub")) {
        zend_string *inner = sub_select(c, b, s, ga(p, "sub"));
        OKP(inner);
        return fmt(c, "%s%s(%s)", ZSTR_VAL(lhs), strcmp(ops, "not_in") == 0 ? " NOT IN " : " IN ", ZSTR_VAL(inner));
    }
    if (isset_(p, "value")) {
        HashTable *vh = ga(p, "value");
        zend_string *fn = gs(c, vh, "name");
        zval *p0 = at(lst(vh, "ps"), 0);
        zend_long ps0 = p0 != NULL ? zval_get_long(p0) : 0;
        zend_string *v = value_function_sql(c, b, fn, ps0);
        OKP(v);
        if (zend_string_equals_literal(gs(c, colh, "type"), "datetime") && !zend_string_equals_literal(fn, "today")) {
            zval a[2] = {*Zs(c, lhs), *Zl(c, gl(colh, "precision", 0))};
            lhs = Ds(c, "clockOperand", 2, a);
            OKP(lhs);
        }
        return fmt(c, "%s %s %s", ZSTR_VAL(lhs), cmp_of(ops), ZSTR_VAL(v));
    }
    if (isset_(p, "fn")) {
        HashTable *fh = ga(p, "fn");
        zend_string *fnc = column_function(c, s, gs(c, p, "column"), fh);
        OKP(fnc);
        zend_string *type = function_type(c, gs(c, fh, "name"), colh);
        OKP(type);
        if (strcmp(ops, "in") == 0 || strcmp(ops, "not_in") == 0) {
            zval *phs = newlist(c);
            zval *pi;
            ZEND_HASH_FOREACH_VAL(ps_of(p), pi) {
                zend_string *ph = b_param(c, b, zval_get_long(pi), type, ZSTR_EMPTY_ALLOC(), NULL);
                OKP(ph);
                lpushs(phs, ph);
            } ZEND_HASH_FOREACH_END();
            return fmt(c, "%s%s(%s)", ZSTR_VAL(fnc), strcmp(ops, "not_in") == 0 ? " NOT IN " : " IN ",
                ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(phs))));
        }
        if (strcmp(ops, "between") == 0) {
            zend_string *a1 = b_param(c, b, zval_get_long(at(ps_of(p), 0)), type, ZSTR_EMPTY_ALLOC(), NULL);
            OKP(a1);
            zend_string *a2 = b_param(c, b, zval_get_long(at(ps_of(p), 1)), type, ZSTR_EMPTY_ALLOC(), NULL);
            OKP(a2);
            return fmt(c, "%s BETWEEN %s AND %s", ZSTR_VAL(fnc), ZSTR_VAL(a1), ZSTR_VAL(a2));
        }
        zend_string *ph = b_param(c, b, gl(p, "p", 0), type, ZSTR_EMPTY_ALLOC(), NULL);
        OKP(ph);
        return fmt(c, "%s %s %s", ZSTR_VAL(fnc), cmp_of(ops), ZSTR_VAL(ph));
    }
    bool aes = false;
    if (!enc_of(c, colh, &aes)) {
        return NULL;
    }
    if (strcmp(ops, "eq") == 0 || strcmp(ops, "not_eq") == 0 || strcmp(ops, "gt") == 0 || strcmp(ops, "gte") == 0
        || strcmp(ops, "lt") == 0 || strcmp(ops, "lte") == 0) {
        if (aes) {
            if (strcmp(ops, "eq") != 0 && strcmp(ops, "not_eq") != 0) {
                return fail("OPERATOR_NOT_ALLOWED", "AES columns support only equality through a declared blind index");
            }
            zend_string *index = blind_index_of(c, s, colh);
            OKP(index);
            HashTable *ich = NULL;
            if (!col_of(c, s->ent, index, &ich)) {
                return NULL;
            }
            zend_string *qi = qcol(c, s, index);
            OKP(qi);
            zend_string *ph = b_blind_index(c, b, gl(p, "p", 0), gs(c, ich, "type"));
            OKP(ph);
            return fmt(c, "%s %s %s", ZSTR_VAL(qi), cmp_of(ops), ZSTR_VAL(ph));
        }
        zend_string *v = render_value(c, b, colh, gl(p, "p", 0));
        OKP(v);
        return fmt(c, "%s %s %s", ZSTR_VAL(lhs), cmp_of(ops), ZSTR_VAL(v));
    }
    if (ZSTR_LEN(op) > 4 && strcmp(ops + ZSTR_LEN(op) - 4, "_col") == 0) {
        char base[32];
        size_t n = ZSTR_LEN(op) - 4;
        memcpy(base, ops, n);
        base[n] = '\0';
        pscope *rs = resolve_path(c, s, gs(c, ga(p, "ref"), "path"));
        OKP(rs);
        zend_string *ref = gs(c, ga(p, "ref"), "column");
        HashTable *rc = NULL;
        if (!col_of(c, rs->ent, ref, &rc)) {
            return NULL;
        }
        if (rc == NULL) {
            return fail("COLUMN_UNKNOWN", "%s.%s", ZSTR_VAL(gs(c, rs->ent, "entity")), ZSTR_VAL(ref));
        }
        zend_string *rq = qcol(c, rs, ref);
        OKP(rq);
        return fmt(c, "%s %s %s", ZSTR_VAL(lhs), cmp_of(base), ZSTR_VAL(rq));
    }
    if (strcmp(ops, "in") == 0 || strcmp(ops, "not_in") == 0) {
        const char *keyword = strcmp(ops, "not_in") == 0 ? "NOT IN" : "IN";
        zend_string *l = lhs;
        zval *values = newlist(c);
        if (aes) {
            zend_string *index = blind_index_of(c, s, colh);
            OKP(index);
            l = qcol(c, s, index);
            OKP(l);
            HashTable *ich = NULL;
            if (!col_of(c, s->ent, index, &ich)) {
                return NULL;
            }
            zend_string *indexType = gs(c, ich, "type");
            zval *pi;
            ZEND_HASH_FOREACH_VAL(ps_of(p), pi) {
                zend_string *ph = b_blind_index(c, b, zval_get_long(pi), indexType);
                OKP(ph);
                lpushs(values, ph);
            } ZEND_HASH_FOREACH_END();
        } else {
            zval *pi;
            ZEND_HASH_FOREACH_VAL(ps_of(p), pi) {
                zend_string *ph = render_value(c, b, colh, zval_get_long(pi));
                OKP(ph);
                lpushs(values, ph);
            } ZEND_HASH_FOREACH_END();
        }
        return fmt(c, "%s %s (%s)", ZSTR_VAL(l), keyword, ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(values))));
    }
    if (strcmp(ops, "between") == 0) {
        zend_string *lo = render_value(c, b, colh, zval_get_long(at(ps_of(p), 0)));
        OKP(lo);
        zend_string *hi = render_value(c, b, colh, zval_get_long(at(ps_of(p), 1)));
        OKP(hi);
        return fmt(c, "%s BETWEEN %s AND %s", ZSTR_VAL(lhs), ZSTR_VAL(lo), ZSTR_VAL(hi));
    }
    if (strcmp(ops, "is_null") == 0) {
        return fmt(c, "%s IS NULL", ZSTR_VAL(lhs));
    }
    if (strcmp(ops, "is_not_null") == 0) {
        return fmt(c, "%s IS NOT NULL", ZSTR_VAL(lhs));
    }
    if (strcmp(ops, "contains") == 0) {
        zend_string *ph = b_col_param(c, b, gl(p, "p", 0), colh, fmt(c, "like_contains"), NULL);
        OKP(ph);
        zval a[2] = {*Zs(c, lhs), *Zs(c, ph)};
        return Ds(c, "contains", 2, a);
    }
    if (strcmp(ops, "contains_binary") == 0) {
        return contains_binary_sql(c, b, lhs, colh, gl(p, "p", 0));
    }
    return fail("OPERATOR_UNKNOWN", "%s", ops);
}

/* Planner::renderOrder: the ORDER BY of a request, or the empty string. */
static zend_string *render_order(pctx *c, pbinds *b, pscope *s, HashTable *q)
{
    (void)b;
    zval *parts = newlist(c);
    zval *o;
    ZEND_HASH_FOREACH_VAL(lst(q, "order"), o) {
        ZVAL_DEREF(o);
        HashTable *oh = Z_ARRVAL_P(o);
        if (gt(oh, "random")) {
            zend_string *r = Ds(c, "random", 0, NULL);
            OKP(r);
            lpushs(parts, r);
        } else {
            zend_string *col;
            if (isset_(oh, "fn")) {
                col = column_function(c, s, gs(c, oh, "column"), ga(oh, "fn"));
            } else {
                col = qcol(c, s, gs(c, oh, "column"));
            }
            OKP(col);
            HashTable *cc = NULL;
            if (!col_of(c, s->ent, gs(c, oh, "column"), &cc)) {
                return NULL;
            }
            zend_string *nulls = ZSTR_EMPTY_ALLOC();
            if (gt(cc, "nullable")) {
                zval a[1] = {*Zb(c, gt(oh, "desc"))};
                nulls = Ds(c, "nullsOrder", 1, a);
                OKP(nulls);
            }
            lpushs(parts, fmt(c, "%s%s%s", ZSTR_VAL(col), gt(oh, "desc") ? " DESC" : " ASC", ZSTR_VAL(nulls)));
        }
    } ZEND_HASH_FOREACH_END();
    if (count_of(Z_ARRVAL_P(parts)) == 0) {
        return ZSTR_EMPTY_ALLOC();
    }
    return fmt(c, " ORDER BY %s", ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(parts))));
}

/* Planner::renderValue: one value bound for a column, wrapped for the SQL-side stages. */
static zend_string *render_value(pctx *c, pbinds *b, HashTable *col, zend_long i)
{
    zval *styles = sql_styles(c, col);
    OKP(styles);
    HashTable *stages = host_stages();
    if (stages == NULL) {
        stages = (HashTable *)&zend_empty_array;
    }
    zval *host = newlist(c);
    zval *st;
    ZEND_HASH_FOREACH_VAL(lst(col, "codec"), st) {
        ZVAL_DEREF(st);
        if (Z_TYPE_P(st) == IS_STRING && in_list(stages, Z_STR_P(st))) {
            zval a[1] = {*st};
            zval *h = D(c, "handlesStyle", 1, a);
            OKP(h);
            if (!zend_is_true(h)) {
                lpush(host, st);
            }
        }
    } ZEND_HASH_FOREACH_END();
    if (count_of(Z_ARRVAL_P(styles)) == 0) {
        zend_string *ph = b_col_param(c, b, i, col, ZSTR_EMPTY_ALLOC(), Z_ARRVAL_P(host));
        OKP(ph);
        zend_string *type = gs(c, col, "type");
        if (zend_string_equals_literal(type, "time")) {
            zval a[1] = {*Zs(c, ph)};
            return Ds(c, "writeTime", 1, a);
        }
        if (zend_string_equals_literal(type, "uuid")) {
            zval a[1] = {*Zs(c, ph)};
            return Ds(c, "writeUuid", 1, a);
        }
        return ph;
    }
    zend_string *inputType = style_input_type(c, zstr(c, at(Z_ARRVAL_P(styles), 0)));
    zend_string *ph = b_param(c, b, i, inputType, ZSTR_EMPTY_ALLOC(), Z_ARRVAL_P(host));
    OKP(ph);
    zval a[2] = {*Zs(c, ph), *styles};
    return Ds(c, "writeExpr", 2, a);
}

/* ---- the value closures: Dialect::valueFunction and Dialect::containsBinary call them while they run ---- */

typedef struct pthunk {
    pctx *c;
    pbinds *b;
    zend_long p;
    zend_long ps0;
    zend_string *fn;
    HashTable *col;
} pthunk;

static pthunk *g_arg;    /* fn() => $b->param(ps0, intervalType(fn)) */
static pthunk *g_now;    /* fn() => $b->now(6) */
static pthunk *g_value;  /* fn(string $transform) => $b->colParam(p, col, transform) */

static zend_internal_function fn_arg_def, fn_now_def, fn_value_def;
static bool fn_defs_ready = false;

static void fn_def(zend_internal_function *f, const char *name, void (*h)(zend_execute_data *, zval *), uint32_t nargs)
{
    memset(f, 0, sizeof(*f));
    f->type = ZEND_INTERNAL_FUNCTION;
    f->fn_flags = ZEND_ACC_PUBLIC;
    f->function_name = zend_string_init_interned(name, strlen(name), 1);
    f->handler = h;
    f->num_args = nargs;
    f->required_num_args = nargs;
}

ZEND_NAMED_FUNCTION(planner_thunk_arg)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_string *iv = interval_type(g_arg->c, g_arg->fn);
    zend_string *ph = iv != NULL ? b_param(g_arg->c, g_arg->b, g_arg->ps0, iv, ZSTR_EMPTY_ALLOC(), NULL) : NULL;
    if (ph == NULL) {
        RETURN_NULL();
    }
    RETURN_STR_COPY(ph);
}

ZEND_NAMED_FUNCTION(planner_thunk_now)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_string *ph = b_now(g_now->c, g_now->b, 6);
    if (ph == NULL) {
        RETURN_NULL();
    }
    RETURN_STR_COPY(ph);
}

ZEND_NAMED_FUNCTION(planner_thunk_value)
{
    zend_string *tr = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(tr)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *ph = b_col_param(g_value->c, g_value->b, g_value->p, g_value->col, tr, NULL);
    if (ph == NULL) {
        RETURN_NULL();
    }
    RETURN_STR_COPY(ph);
}

static void fns_init(void)
{
    if (fn_defs_ready) {
        return;
    }
    fn_defs_ready = true;
    fn_def(&fn_arg_def, "planner-arg", planner_thunk_arg, 0);
    fn_def(&fn_now_def, "planner-now", planner_thunk_now, 0);
    fn_def(&fn_value_def, "planner-value", planner_thunk_value, 1);
}

/* A Closure of an internal function of this file, kept. */
static zval *make_closure(pctx *c, zend_internal_function *f)
{
    zval *z = keep(c);
    zend_create_fake_closure(z, (zend_function *)f, NULL, NULL, NULL);
    return z;
}

/* Dialect::valueFunction($fn, $arg, $now): the dialect's SQL of a value function, or a CAPABILITY_UNSUPPORTED error. */
static zend_string *value_function_sql(pctx *c, pbinds *b, zend_string *fn, zend_long ps0)
{
    fns_init();
    pthunk ta = {c, b, 0, ps0, fn, NULL};
    pthunk tn = {c, b, 0, 0, fn, NULL};
    pthunk *sa = g_arg, *sn = g_now;
    g_arg = &ta;
    g_now = &tn;
    zval *ca = make_closure(c, &fn_arg_def);
    zval *cn = make_closure(c, &fn_now_def);
    zval a[3] = {*Zs(c, fn), *ca, *cn};
    zend_string *r = Ds(c, "valueFunction", 3, a);
    g_arg = sa;
    g_now = sn;
    if (r == NULL) {
        if (EG(exception) != NULL) {
            return NULL;
        }
        return fail("CAPABILITY_UNSUPPORTED", "%s is not available on %s", ZSTR_VAL(fn), ZSTR_VAL(dialect_name(c)));
    }
    return r;
}

/* Dialect::containsBinary($lhs, $value): the dialect's SQL of a binary containment. */
static zend_string *contains_binary_sql(pctx *c, pbinds *b, zend_string *lhs, HashTable *col, zend_long p)
{
    fns_init();
    pthunk tv = {c, b, p, 0, NULL, col};
    pthunk *sv = g_value;
    g_value = &tv;
    zval *cv = make_closure(c, &fn_value_def);
    zval a[2] = {*Zs(c, lhs), *cv};
    zend_string *r = Ds(c, "containsBinary", 2, a);
    g_value = sv;
    if (r == NULL) {
        if (EG(exception) != NULL) {
            return NULL;
        }
        return fail("INTERNAL", "containsBinary gives no string");
    }
    return r;
}

/* Planner::groupCountList: the grouped columns and the row count of a grouped count. */
static zend_string *group_count_list(pctx *c, pscope *s, passm *ast, zend_long *idx, zval *outNames)
{
    zval *parts = newlist(c);
    zval *g;
    ZEND_HASH_FOREACH_VAL(lst(s->q, "group_by"), g) {
        zend_string *name = zstr(c, g);
        HashTable *col = NULL;
        if (!col_of(c, s->ent, name, &col)) {
            return NULL;
        }
        zend_string *q = qcol(c, s, name);
        OKP(q);
        zend_string *expr = read_column(c, q, col);
        OKP(expr);
        zend_string *out = fmt(c, "%s__%s", ZSTR_VAL(s->alias), ZSTR_VAL(name));
        zend_string *qo = quote(c, out);
        OKP(qo);
        lpushs(parts, fmt(c, "%s AS %s", ZSTR_VAL(expr), ZSTR_VAL(qo)));
        lpushs(outNames, out);
        zval *styles = client_styles(c, col);
        OKP(styles);
        lpush(ast->columns, out_col(c, (*idx)++, name, name, gs(c, col, "type"), styles, false));
    } ZEND_HASH_FOREACH_END();
    zend_string *out = fmt(c, "%s__row_count", ZSTR_VAL(s->alias));
    zend_string *qo = quote(c, out);
    OKP(qo);
    lpushs(parts, fmt(c, "COUNT(*) AS %s", ZSTR_VAL(qo)));
    lpushs(outNames, out);
    lpush(ast->columns, out_col(c, (*idx)++, fmt(c, "row_count"), ZSTR_EMPTY_ALLOC(), fmt(c, "i64"), newlist(c), false));
    return implode(c, ", ", Z_ARRVAL_P(parts));
}

/* Planner::selectList: the projection of a scope and of its joins; join columns become join children. */
static zend_string *select_list(pctx *c, pbinds *b, pscope *s, passm *ast, zend_long *idx, zval *outNames)
{
    zval *parts = newlist(c);
    bool hasAes = false;
    zval *proj = projection(c, s);
    OKP(proj);
    zval *pc;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(proj), pc) {
        HashTable *ch = Z_ARRVAL_P(pc);
        zend_string *cname = gs(c, ch, "column");
        zend_string *name = gs(c, ch, "name");
        HashTable *col = NULL;
        if (ZSTR_LEN(cname) > 0) {
            if (!col_of(c, s->ent, cname, &col)) {
                return NULL;
            }
        }
        if (col != NULL) {
            bool e = false;
            if (!enc_of(c, col, &e)) {
                return NULL;
            }
            if (e) {
                hasAes = true;
            }
        }
        zend_string *expr;
        zend_string *type = fmt(c, "string");
        zval *styles = newlist(c);
        bool fnBranch = false;
        if (isset_(ch, "fn")) {
            HashTable *fh = ga(ch, "fn");
            expr = column_function(c, s, cname, fh);
            OKP(expr);
            type = function_type(c, gs(c, fh, "name"), col);
            OKP(type);
            col = NULL;
            fnBranch = true;
        } else if (isset_(ch, "sub")) {
            HashTable *sh = ga(ch, "sub");
            zend_string *inner = sub_select(c, b, s, sh);
            OKP(inner);
            expr = fmt(c, "(%s)", ZSTR_VAL(inner));
            type = sub_type(c, sh);
            OKP(type);
        } else {
            zend_string *q = qcol(c, s, cname);
            OKP(q);
            expr = read_column(c, q, col);
            OKP(expr);
            styles = client_styles(c, col);
            OKP(styles);
        }
        (void)fnBranch;
        lpushs(parts, fmt(c, "%s AS %s", ZSTR_VAL(expr), ZSTR_VAL(quote(c, fmt(c, "%s__%s", ZSTR_VAL(s->alias), ZSTR_VAL(name))))));
        lpushs(outNames, fmt(c, "%s__%s", ZSTR_VAL(s->alias), ZSTR_VAL(name)));
        if (col != NULL) {
            type = gs(c, col, "type");
        }
        lpush(ast->columns, out_col(c, (*idx)++, name, cname, type, styles, false));
    } ZEND_HASH_FOREACH_END();
    if (hasAes) {
        zend_string *ver = gs(c, s->ent, "aes_version");
        zval *cols = column_of(c, Z_ARRVAL_P(proj), "column");
        if (!in_list(Z_ARRVAL_P(cols), ver)) {
            HashTable *vcol = NULL;
            if (!col_of(c, s->ent, ver, &vcol)) {
                return NULL;
            }
            if (vcol == NULL) {
                return fail("SCHEMA_INVALID", "%s: an AES column requires the aes_version setting",
                    ZSTR_VAL(gs(c, s->ent, "entity")));
            }
            zend_string *qv = qcol(c, s, ver);
            OKP(qv);
            zend_string *alias_name = fmt(c, "%s__%s", ZSTR_VAL(s->alias), ZSTR_VAL(ver));
            lpushs(parts, fmt(c, "%s AS %s", ZSTR_VAL(qv), ZSTR_VAL(quote(c, alias_name))));
            lpushs(outNames, alias_name);
            lpush(ast->columns, out_col(c, (*idx)++, ver, ver, gs(c, vcol, "type"), newlist(c), true));
        }
    }
    ZEND_HASH_FOREACH_VAL(lst(s->q, "joins"), pc) {
        ZVAL_DEREF(pc);
        HashTable *jh = Z_ARRVAL_P(pc);
        zend_string *rel = gs(c, jh, "rel");
        pscope *js = join_of(s, rel);
        if (js == NULL) {
            return fail("INTERNAL", "join %s is not in the scope", ZSTR_VAL(rel));
        }
        pchild *child = child_new(c, rel, fmt(c, "join"));
        child->assemble = asm_new(c, gs(c, js->ent, "entity"), js->alias);
        zend_string *part = select_list(c, b, js, child->assemble, idx, outNames);
        OKP(part);
        lpushs(parts, part);
        zval cz;
        ZVAL_PTR(&cz, child);
        add_next_index_zval(ast->children, &cz);
    } ZEND_HASH_FOREACH_END();
    zval *ak = key_refs(c, ast, lst(s->ent, "pk"));
    OKP(ak);
    ast->key = ak;
    return implode(c, ", ", Z_ARRVAL_P(parts));
}

/* Planner::subSelect: a subquery for an IN list or a scalar column; ^ references resolve against outer. */
static zend_string *sub_select(pctx *c, pbinds *b, pscope *outer, HashTable *sub)
{
    HashTable *q = ga(sub, "query");
    b->subs++;
    zend_string *alias = fmt(c, "s%ld", (long)b->subs);
    pscope *root = scopes(c, q, alias, NULL);
    OKP(root);
    root->outer = outer;
    zend_string *column = gs(c, sub, "column");
    zend_string *agg = gs(c, sub, "agg");
    zend_string *sel;
    if (zend_string_equals_literal(agg, "sum")) {
        zend_string *qc = qcol(c, root, column);
        OKP(qc);
        sel = fmt(c, "COALESCE(SUM(%s), 0)", ZSTR_VAL(qc));
    } else if (zend_string_equals_literal(agg, "avg")) {
        zend_string *qc = qcol(c, root, column);
        OKP(qc);
        sel = fmt(c, "AVG(%s)", ZSTR_VAL(qc));
    } else if (zend_string_equals_literal(agg, "count")) {
        sel = fmt(c, "COUNT(*)");
    } else {
        sel = qcol(c, root, column);
        OKP(sel);
    }
    zend_string *tbl = b_table(c, b, root->ent);
    OKP(tbl);
    zend_string *qa = quote(c, root->alias);
    OKP(qa);
    zend_string *sql = fmt(c, "SELECT %s FROM %s AS %s", ZSTR_VAL(sel), ZSTR_VAL(tbl), ZSTR_VAL(qa));
    zend_string *joins = render_joins(c, b, root);
    OKP(joins);
    sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(joins));
    zval *where = newlist(c);
    zend_string *soft = gs(c, root->ent, "soft_delete");
    if (ZSTR_LEN(soft) > 0) {
        zend_string *sq = qcol(c, root, soft);
        OKP(sq);
        lpushs(where, fmt(c, "%s IS NULL", ZSTR_VAL(sq)));
    }
    HashTable *qw = ga(q, "where");
    if (count_of(lst(qw, "items")) > 0) {
        zend_string *g = render_group(c, b, root, qw, true);
        OKP(g);
        lpushs(where, g);
    }
    if (!collect_join_where(c, b, root, where)) {
        return NULL;
    }
    if (count_of(Z_ARRVAL_P(where)) > 0) {
        sql = fmt(c, "%s WHERE %s", ZSTR_VAL(sql), ZSTR_VAL(implode(c, " AND ", Z_ARRVAL_P(where))));
    }
    if (ZSTR_LEN(agg) == 0 && isset_(q, "limit")) {
        zend_string *ord = render_order(c, b, root, q);
        OKP(ord);
        HashTable *lh = ga(q, "limit");
        zval a[2] = {*Zl(c, gl(lh, "offset", 0)), *Zl(c, gl(lh, "count", 0))};
        zend_string *lim = Ds(c, "limit", 2, a);
        OKP(lim);
        sql = fmt(c, "%s%s%s", ZSTR_VAL(sql), ZSTR_VAL(ord), ZSTR_VAL(lim));
    }
    return sql;
}

/* Planner::subType: the dbspec type of a subquery's result. */
static zend_string *sub_type(pctx *c, HashTable *sub)
{
    zend_string *agg = gs(c, sub, "agg");
    if (zend_string_equals_literal(agg, "count")) {
        return fmt(c, "i64");
    }
    if (zend_string_equals_literal(agg, "avg")) {
        return fmt(c, "f64");
    }
    HashTable *col = NULL;
    if (!col_of(c, entity(c, gs(c, ga(sub, "query"), "entity")), gs(c, sub, "column"), &col)) {
        return NULL;
    }
    zval *t = col != NULL ? get(col, "type") : NULL;
    return t != NULL ? zstr(c, t) : fmt(c, "string");
}

/* Planner::selectStep: the statement of a select, count, sum or avg, with its relation steps. */
static pstep *select_step(pctx *c, zval *steps, HashTable *q, const char *kind, zend_string *agg, prel *rc)
{
    pbinds *b = binds_new(c);
    pscope *root = scopes(c, q, fmt(c, "a"), NULL);
    OKP(root);
    if (rc != NULL) {
        zval *ck;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rc->childKeys), ck) {
            lpush(root->extra, ck);
        } ZEND_HASH_FOREACH_END();
        zend_string *kb = gs(c, q, "key_by");
        if (ZSTR_LEN(kb) > 0) {
            lpushs(root->extra, kb);
        }
    }
    HashTable *pk = lst(root->ent, "pk");
    HashTable *groupBy = lst(q, "group_by");
    passm *ast = asm_new(c, gs(c, root->ent, "entity"), root->alias);
    zval *outNames = newlist(c);
    zend_long idx = 0;
    bool groupCount = strcmp(kind, "count") == 0 && count_of(groupBy) > 0;
    zend_string *sel;
    if (strcmp(kind, "count") == 0) {
        sel = groupCount ? fmt(c, "1") : fmt(c, "COUNT(*)");
    } else if (strcmp(kind, "sum") == 0) {
        zend_string *qc = qcol(c, root, agg);
        OKP(qc);
        sel = fmt(c, "COALESCE(SUM(%s), 0)", ZSTR_VAL(qc));
    } else if (strcmp(kind, "avg") == 0) {
        zend_string *qc = qcol(c, root, agg);
        OKP(qc);
        sel = fmt(c, "AVG(%s)", ZSTR_VAL(qc));
    } else if (strcmp(kind, "group_count") == 0) {
        sel = group_count_list(c, root, ast, &idx, outNames);
        OKP(sel);
        zval *ak = key_refs(c, ast, groupBy);
        OKP(ak);
        ast->key = ak;
    } else {
        sel = select_list(c, b, root, ast, &idx, outNames);
        OKP(sel);
        zval *ak = key_refs(c, ast, pk);
        OKP(ak);
        ast->key = ak;
    }
    zend_long perParent = 0;
    if (rc != NULL) {
        perParent = gl(q, "limit_per_parent", 0);
        if (perParent == 0 && zend_string_equals_literal(rc->kind, "one") && count_of(lst(q, "order")) > 0) {
            perParent = 1;
        }
    }
    zend_string *sql = fmt(c, "SELECT %s", ZSTR_VAL(sel));
    if (perParent > 0) {
        zend_string *order = render_order(c, b, root, q);
        OKP(order);
        if (ZSTR_LEN(order) == 0) {
            zend_string *oq = qcol(c, root, zstr(c, at(pk, 0)));
            OKP(oq);
            order = fmt(c, " ORDER BY %s ASC", ZSTR_VAL(oq));
        }
        zval *pq = qualified(c, root, Z_ARRVAL_P(rc->childKeys));
        OKP(pq);
        zend_string *rn = quote(c, fmt(c, "orm_rn"));
        OKP(rn);
        sql = fmt(c, "%s, ROW_NUMBER() OVER (PARTITION BY %s%s) AS %s", ZSTR_VAL(sql),
            ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(pq))), ZSTR_VAL(order), ZSTR_VAL(rn));
    }
    zend_string *tbl = b_table(c, b, root->ent);
    OKP(tbl);
    zend_string *qa = quote(c, root->alias);
    OKP(qa);
    sql = fmt(c, "%s FROM %s AS %s", ZSTR_VAL(sql), ZSTR_VAL(tbl), ZSTR_VAL(qa));
    zend_string *fi = gs(c, q, "force_index");
    if (ZSTR_LEN(fi) > 0) {
        zval a[1] = {*Zs(c, fi)};
        zend_string *f = Ds(c, "forceIndex", 1, a);
        OKP(f);
        sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(f));
    }
    zend_string *joins = render_joins(c, b, root);
    OKP(joins);
    sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(joins));
    zval *where = newlist(c);
    if (rc != NULL) {
        zval *keyTypes = newlist(c);
        zval *ck;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rc->childKeys), ck) {
            HashTable *cc = NULL;
            if (!col_of(c, root->ent, zstr(c, ck), &cc)) {
                return NULL;
            }
            lpushs(keyTypes, gs(c, cc, "type"));
        } ZEND_HASH_FOREACH_END();
        if (count_of(Z_ARRVAL_P(rc->childKeys)) == 1) {
            zend_string *qc0 = qcol(c, root, zstr(c, at(Z_ARRVAL_P(rc->childKeys), 0)));
            OKP(qc0);
            zend_string *ph = b_parent(c, b, rc->parentStep, keyTypes);
            OKP(ph);
            lpushs(where, fmt(c, "%s IN (%s)", ZSTR_VAL(qc0), ZSTR_VAL(ph)));
        } else {
            zval *pq = qualified(c, root, Z_ARRVAL_P(rc->childKeys));
            OKP(pq);
            zend_string *ph = b_parent(c, b, rc->parentStep, keyTypes);
            OKP(ph);
            lpushs(where, fmt(c, "(%s) IN ((%s))", ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(pq))), ZSTR_VAL(ph)));
        }
    }
    zend_string *soft = gs(c, root->ent, "soft_delete");
    if (ZSTR_LEN(soft) > 0) {
        zend_string *sq = qcol(c, root, soft);
        OKP(sq);
        lpushs(where, fmt(c, "%s IS NULL", ZSTR_VAL(sq)));
    }
    HashTable *qw = ga(q, "where");
    if (count_of(lst(qw, "items")) > 0) {
        zend_string *g = render_group(c, b, root, qw, rc == NULL);
        OKP(g);
        lpushs(where, g);
    }
    if (!collect_join_where(c, b, root, where)) {
        return NULL;
    }
    if (count_of(Z_ARRVAL_P(where)) > 0) {
        sql = fmt(c, "%s WHERE %s", ZSTR_VAL(sql), ZSTR_VAL(implode(c, " AND ", Z_ARRVAL_P(where))));
    }
    if (count_of(groupBy) > 0) {
        zval *gq = qualified(c, root, groupBy);
        OKP(gq);
        sql = fmt(c, "%s GROUP BY %s", ZSTR_VAL(sql), ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(gq))));
    }
    if (groupCount) {
        zend_string *go = quote(c, fmt(c, "orm_g"));
        OKP(go);
        sql = fmt(c, "SELECT COUNT(*) FROM (%s) AS %s", ZSTR_VAL(sql), ZSTR_VAL(go));
    }
    zend_string *lock = gs(c, q, "lock");
    if (strcmp(kind, "one") == 0 || strcmp(kind, "all") == 0 || strcmp(kind, "group_count") == 0) {
        if (perParent > 0) {
            zend_string *w = quote(c, fmt(c, "orm_w"));
            OKP(w);
            zval *cols = newlist(c);
            zval *n;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(outNames), n) {
                zend_string *qn = quote(c, Z_STR_P(n));
                OKP(qn);
                lpushs(cols, fmt(c, "%s.%s", ZSTR_VAL(w), ZSTR_VAL(qn)));
            } ZEND_HASH_FOREACH_END();
            zval *keys = newlist(c);
            zval *k;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rc->childKeys), k) {
                zend_string *qk = quote(c, fmt(c, "%s__%s", ZSTR_VAL(root->alias), ZSTR_VAL(zstr(c, k))));
                OKP(qk);
                lpushs(keys, fmt(c, "%s.%s", ZSTR_VAL(w), ZSTR_VAL(qk)));
            } ZEND_HASH_FOREACH_END();
            zend_string *orn = quote(c, fmt(c, "orm_rn"));
            OKP(orn);
            sql = fmt(c, "SELECT %s FROM (%s) AS %s WHERE %s.%s <= %ld ORDER BY %s, %s.%s",
                ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(cols))), ZSTR_VAL(sql), ZSTR_VAL(w), ZSTR_VAL(w), ZSTR_VAL(orn),
                (long)perParent, ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(keys))), ZSTR_VAL(w), ZSTR_VAL(orn));
        } else {
            zend_string *ord = render_order(c, b, root, q);
            OKP(ord);
            sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(ord));
            if (strcmp(kind, "one") == 0 && rc == NULL) {
                zval a[2] = {*Zl(c, 0), *Zl(c, 1)};
                zend_string *lim = Ds(c, "limit", 2, a);
                OKP(lim);
                sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(lim));
            } else if (isset_(q, "limit")) {
                HashTable *lh = ga(q, "limit");
                zval a[2] = {*Zl(c, gl(lh, "offset", 0)), *Zl(c, gl(lh, "count", 0))};
                zend_string *lim = Ds(c, "limit", 2, a);
                OKP(lim);
                sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(lim));
            }
            if (ZSTR_LEN(lock) > 0) {
                zval a[1] = {*Zs(c, lock)};
                zend_string *suffix = Ds(c, "rowLock", 1, a);
                if (suffix == NULL) {
                    if (EG(exception) != NULL) {
                        return NULL;
                    }
                    return fail("CAPABILITY_UNSUPPORTED", "%s row lock \"%s\" is not supported",
                        ZSTR_VAL(dialect_name(c)), ZSTR_VAL(lock));
                }
                sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(suffix));
            }
        }
    }
    zval *slots = copy_list(c, Z_ARRVAL_P(b->slots));
    zval *tables = b_tables(c, b);
    OKP(tables);
    pstep *st = step_new(c, "main", sql, lock, slots, tables);
    if (strcmp(kind, "count") == 0 && count_of(Z_ARRVAL_P(steps)) > 0) {
        st->role = fmt(c, "count");
    } else if (rc != NULL) {
        st->role = fmt(c, "relation");
        zval *parent = newlist(c);
        putl(parent, "step", rc->parentStep);
        zval *keys = key_refs(c, rc->parentAsm, Z_ARRVAL_P(rc->parentKeys));
        OKP(keys);
        put(parent, "keys", keys);
        if (isset_(q, "if_parent")) {
            HashTable *ip = ga(q, "if_parent");
            zend_string *column = gs(c, ip, "column");
            zend_long index = index_of(rc->parentAsm, column);
            if (index < 0) {
                return NULL;
            }
            zval *ipa = newlist(c);
            puts_(ipa, "column", column);
            putl(ipa, "index", index);
            putl(ipa, "param", gl(ip, "p", 0));
            put(parent, "if_parent", ipa);
        }
        st->parent = parent;
    }
    if (strcmp(kind, "one") == 0 || strcmp(kind, "all") == 0 || strcmp(kind, "group_count") == 0) {
        st->assemble = ast;
    }
    steps_add(c, steps, st);
    if (st->assemble != NULL && !relation_steps(c, steps, root, ast, st->id)) {
        return NULL;
    }
    return st;
}

/* Planner::relationSteps: a step per relation of a scope and of its joins; records how the rows attach. */
static bool relation_steps(pctx *c, zval *steps, pscope *s, passm *ast, zend_long stepId)
{
    zval *r;
    ZEND_HASH_FOREACH_VAL(lst(s->q, "relations"), r) {
        ZVAL_DEREF(r);
        HashTable *rh = Z_ARRVAL_P(r);
        prel *rc = arena(c, sizeof(prel));
        rc->parentStep = stepId;
        rc->parentAsm = ast;
        rc->parentKeys = column_of(c, lst(rh, "keys"), "left");
        rc->childKeys = column_of(c, lst(rh, "keys"), "right");
        rc->kind = gs(c, rh, "kind");
        HashTable *query = ga(rh, "query");
        HashTable *target = entity(c, gs(c, query, "entity"));
        pstep *st = select_step(c, steps, query, "all", ZSTR_EMPTY_ALLOC(), rc);
        if (st == NULL) {
            return false;
        }
        pchild *child = child_new(c, gs(c, rh, "rel"), rc->kind);
        child->step = st->id;
        zval *pkeys = key_refs(c, ast, Z_ARRVAL_P(rc->parentKeys));
        if (pkeys == NULL) {
            return false;
        }
        child->parentKeys = pkeys;
        zval *ckeys = key_refs(c, st->assemble, Z_ARRVAL_P(rc->childKeys));
        if (ckeys == NULL) {
            return false;
        }
        child->childKeys = ckeys;
        child->flatten = gt(query, "flatten");
        child->cascade = !gt(query, "no_cascade_delete") && same_list(Z_ARRVAL_P(rc->parentKeys), lst(s->ent, "pk"))
            && !same_list(Z_ARRVAL_P(rc->childKeys), lst(target, "pk"));
        zend_string *keyBy = gs(c, query, "key_by");
        zval *keyList = newlist(c);
        if (ZSTR_LEN(keyBy) > 0) {
            lpushs(keyList, keyBy);
        } else {
            zval *pkv;
            ZEND_HASH_FOREACH_VAL(lst(entity(c, st->assemble->entity), "pk"), pkv) {
                lpush(keyList, pkv);
            } ZEND_HASH_FOREACH_END();
        }
        zval *kk = key_refs(c, st->assemble, Z_ARRVAL_P(keyList));
        if (kk == NULL) {
            return false;
        }
        child->key = kk;
        zval cz;
        ZVAL_PTR(&cz, child);
        add_next_index_zval(ast->children, &cz);
    } ZEND_HASH_FOREACH_END();
    zval *j;
    ZEND_HASH_FOREACH_VAL(lst(s->q, "joins"), j) {
        ZVAL_DEREF(j);
        zend_string *rel = gs(c, Z_ARRVAL_P(j), "rel");
        zval *cv;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ast->children), cv) {
            pchild *ch = Z_PTR_P(cv);
            if (zend_string_equals_literal(ch->kind, "join") && zend_string_equals(ch->rel, rel)) {
                pscope *js = join_of(s, rel);
                if (js == NULL || !relation_steps(c, steps, js, ch->assemble, stepId)) {
                    return false;
                }
            }
        } ZEND_HASH_FOREACH_END();
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* ---- the write statements and the compile (Planner::insertStep and the other statements) ---- */

/* RuntimeModel::encrypted of a column, as a bool, through the same call as the PHP code. */
static bool is_enc(pctx *c, HashTable *col, bool *yes)
{
    return enc_of(c, col, yes);
}

/* Whether the entity has an AES column (Planner::hasAes). */
static bool has_aes(pctx *c, HashTable *ent, bool *out)
{
    zval *col;
    ZEND_HASH_FOREACH_VAL(lst(ent, "columns"), col) {
        ZVAL_DEREF(col);
        bool e = false;
        if (!is_enc(c, Z_ARRVAL_P(col), &e)) {
            return false;
        }
        if (e) {
            *out = true;
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    *out = false;
    return true;
}

/* Whether the set assigns an AES column (Planner::assignsAes). */
static bool assigns_aes(pctx *c, HashTable *ent, HashTable *set, bool *out)
{
    zval *a;
    ZEND_HASH_FOREACH_VAL(set, a) {
        ZVAL_DEREF(a);
        HashTable *col = NULL;
        if (!col_of(c, ent, gs(c, Z_ARRVAL_P(a), "column"), &col)) {
            return false;
        }
        bool e = false;
        if (!is_enc(c, col, &e)) {
            return false;
        }
        if (e) {
            *out = true;
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    *out = false;
    return true;
}

/* Whether the set assigns a column (Planner::assigned). */
static bool assigned(pctx *c, HashTable *set, zend_string *column)
{
    zval *a;
    ZEND_HASH_FOREACH_VAL(set, a) {
        ZVAL_DEREF(a);
        if (zend_string_equals(gs(c, Z_ARRVAL_P(a), "column"), column)) {
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    return false;
}

/* Whether the set assigns a parameter value to a column (Planner::assignsValue). */
static bool assigns_value(pctx *c, HashTable *set, zend_string *column)
{
    zval *a;
    ZEND_HASH_FOREACH_VAL(set, a) {
        ZVAL_DEREF(a);
        HashTable *ah = Z_ARRVAL_P(a);
        if (zend_string_equals(gs(c, ah, "column"), column) && isset_(ah, "p")) {
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    return false;
}

/* One key version describes the row: an AES write replaces every AES column (Planner::checkAesAssignments). */
static bool check_aes_assignments(pctx *c, HashTable *ent, HashTable *set, bool complete)
{
    bool hasa = false;
    if (!has_aes(c, ent, &hasa)) {
        return false;
    }
    if (!hasa) {
        return true;
    }
    zend_string *ver = gs(c, ent, "aes_version");
    if (assigned(c, set, ver)) {
        fail("IR_INVALID", "%s is the AES key version column, which the AES writer manages", ZSTR_VAL(ver));
        return false;
    }
    if (!complete) {
        return true;
    }
    bool as = false;
    if (!assigns_aes(c, ent, set, &as)) {
        return false;
    }
    if (!as) {
        return true;
    }
    zval *col;
    ZEND_HASH_FOREACH_VAL(lst(ent, "columns"), col) {
        ZVAL_DEREF(col);
        HashTable *ch = Z_ARRVAL_P(col);
        bool e = false;
        if (!is_enc(c, ch, &e)) {
            return false;
        }
        zend_string *name = gs(c, ch, "name");
        if (e && !assigned(c, set, name)) {
            fail("IR_INVALID", "AES update must assign every AES column; missing %s", ZSTR_VAL(name));
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* An insert specifies every required column (Planner::checkRequiredAssignments). */
static bool check_required_assignments(pctx *c, HashTable *ent, HashTable *set)
{
    bool hasa = false;
    if (!has_aes(c, ent, &hasa)) {
        return false;
    }
    zend_string *version = hasa ? gs(c, ent, "aes_version") : ZSTR_EMPTY_ALLOC();
    zend_string *identity = gs(c, ent, "identity");
    zend_string *audit = gs(c, ent, "audit");
    zval *col;
    ZEND_HASH_FOREACH_VAL(lst(ent, "columns"), col) {
        ZVAL_DEREF(col);
        HashTable *ch = Z_ARRVAL_P(col);
        zend_string *name = gs(c, ch, "name");
        bool skip = gt(ch, "nullable") || gt(ch, "default") || zend_string_equals(name, identity)
            || zend_string_equals(name, version) || zend_string_equals(name, audit) || assigned(c, set, name);
        if (!skip) {
            fail("IR_INVALID", "required column %s.%s is not set", ZSTR_VAL(gs(c, ent, "entity")), ZSTR_VAL(name));
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* The set with the derived blind-index assignments added (Planner::withBlindIndexes). */
static zval *with_blind_indexes(pctx *c, HashTable *ent, HashTable *set)
{
    zval *out = newlist(c);
    zval *a;
    ZEND_HASH_FOREACH_VAL(set, a) {
        lpush(out, a);
    } ZEND_HASH_FOREACH_END();
    ZEND_HASH_FOREACH_VAL(set, a) {
        ZVAL_DEREF(a);
        HashTable *ah = Z_ARRVAL_P(a);
        HashTable *col = NULL;
        if (!col_of(c, ent, gs(c, ah, "column"), &col)) {
            return NULL;
        }
        bool e = false;
        if (!is_enc(c, col, &e)) {
            return NULL;
        }
        zend_string *target = gs(c, col, "blind_index");
        if (e && ZSTR_LEN(target) > 0 && !assigned(c, Z_ARRVAL_P(out), target)) {
            zval *derived = newlist(c);
            puts_(derived, "column", target);
            if (isset_(ah, "p")) {
                put(derived, "p", get(ah, "p"));
            }
            if (gt(ah, "null")) {
                putb(derived, "null", true);
            }
            lpush(out, derived);
        }
    } ZEND_HASH_FOREACH_END();
    return out;
}

/* The AES source column of a blind index (Planner::blindIndexSource), NULL when there is none. */
static HashTable *block_index_source(pctx *c, HashTable *ent, zend_string *target)
{
    zval *cv;
    ZEND_HASH_FOREACH_VAL(lst(ent, "columns"), cv) {
        ZVAL_DEREF(cv);
        if (zend_string_equals(gs(c, Z_ARRVAL_P(cv), "blind_index"), target)) {
            return Z_ARRVAL_P(cv);
        }
    } ZEND_HASH_FOREACH_END();
    return NULL;
}

/* The type of a model column, '' when the column does not exist (RuntimeModel::column(...)['type']). */
static zend_string *col_type_of(pctx *c, HashTable *ent, zend_string *name)
{
    HashTable *col = NULL;
    if (!col_of(c, ent, name, &col)) {
        return NULL;
    }
    return gs(c, col, "type");
}

/* Marks the param slots of b from start as the assignment of col (Planner::markAssigned); returns sql. */
static zend_string *mark_assigned(pctx *c, pbinds *b, zend_long start, HashTable *col, zend_string *sql)
{
    if (!gt(col, "nullable")) {
        for (zend_long k = start; k < count_of(Z_ARRVAL_P(b->slots)); k++) {
            zval *slot = at(Z_ARRVAL_P(b->slots), k);
            if (slot == NULL || Z_TYPE_P(slot) != IS_ARRAY) {
                continue;
            }
            if (!zend_string_equals_literal(gs(c, Z_ARRVAL_P(slot), "from"), "param")) {
                continue;
            }
            if (GC_REFCOUNT(Z_ARR_P(slot)) > 1) {
                HashTable *dup = zend_array_dup(Z_ARRVAL_P(slot));
                zval_ptr_dtor(slot);
                ZVAL_ARR(slot, dup);
            }
            putb(slot, "not_null", true);
            puts_(slot, "column", gs(c, col, "name"));
        }
    }
    return sql;
}

/* Planner::renderAssign: one assignment of a column, its value in SQL. */
static zend_string *render_assign(pctx *c, pbinds *b, HashTable *ent, HashTable *col, HashTable *a)
{
    if (block_index_source(c, ent, gs(c, col, "name")) != NULL) {
        if (isset_(a, "plus_p") || isset_(a, "minus_p")) {
            return fail("IR_INVALID", "blind index assignment must use its AES source value");
        }
        if (gt(a, "null")) {
            return fmt(c, "NULL");
        }
        zend_long start = count_of(Z_ARRVAL_P(b->slots));
        zend_string *ph = b_blind_index(c, b, gl(a, "p", 0), gs(c, col, "type"));
        OKP(ph);
        return mark_assigned(c, b, start, col, ph);
    }
    zend_string *qt = quote(c, gs(c, ent, "table"));
    OKP(qt);
    zend_string *qn = quote(c, gs(c, col, "name"));
    OKP(qn);
    zend_string *q = fmt(c, "%s.%s", ZSTR_VAL(qt), ZSTR_VAL(qn));
    if (isset_(a, "plus_p")) {
        zend_string *ph = b_col_param(c, b, gl(a, "plus_p", 0), col, ZSTR_EMPTY_ALLOC(), NULL);
        OKP(ph);
        return fmt(c, "%s + %s", ZSTR_VAL(q), ZSTR_VAL(ph));
    }
    if (isset_(a, "minus_p")) {
        zend_string *ph = b_col_param(c, b, gl(a, "minus_p", 0), col, ZSTR_EMPTY_ALLOC(), NULL);
        OKP(ph);
        zend_string *ph2 = b_col_param(c, b, gl(a, "minus_p", 0), col, ZSTR_EMPTY_ALLOC(), NULL);
        OKP(ph2);
        return fmt(c, "CASE WHEN %s > %s THEN %s - %s ELSE 0 END", ZSTR_VAL(q), ZSTR_VAL(ph), ZSTR_VAL(q), ZSTR_VAL(ph2));
    }
    if (gt(a, "null")) {
        return fmt(c, "NULL");
    }
    zend_long start = count_of(Z_ARRVAL_P(b->slots));
    zend_string *v = render_value(c, b, col, gl(a, "p", 0));
    OKP(v);
    return mark_assigned(c, b, start, col, v);
}

/* The statement time that updated and soft delete write (Planner::clock). */
static zend_string *clock_of(pctx *c, pbinds *b, HashTable *col)
{
    zval *hn = D(c, "hostNow", 0, NULL);
    OKP(hn);
    zend_long precision = gl(col, "precision", 0);
    if (zend_is_true(hn)) {
        return b_now(c, b, precision);
    }
    zval a[1] = {*Zl(c, precision)};
    return Ds(c, "now", 1, a);
}

/* The config value of the AES key version column (its type from the model). */
static zend_string *aes_version_slot(pctx *c, pbinds *b, HashTable *ent)
{
    zend_string *t = col_type_of(c, ent, gs(c, ent, "aes_version"));
    OKP(t);
    return b_config(c, b, "aes_version", t);
}

/* The statement of an insert, with its rows and upsert (Planner::insertStep). */
static pstep *insert_step(pctx *c, HashTable *r)
{
    pbinds *b = binds_new(c);
    HashTable *ent = entity(c, gs(c, r, "entity"));
    zval *setz = with_blind_indexes(c, ent, lst(r, "set"));
    OKP(setz);
    HashTable *set = Z_ARRVAL_P(setz);
    if (!check_aes_assignments(c, ent, set, false) || !check_required_assignments(c, ent, set)) {
        return NULL;
    }
    bool versioned = false;
    if (!has_aes(c, ent, &versioned)) {
        return NULL;
    }
    bool audited = ZSTR_LEN(gs(c, ent, "audit")) > 0;
    zval *clocked = newlist(c);
    zval *hn = D(c, "hostNow", 0, NULL);
    OKP(hn);
    if (zend_is_true(hn)) {
        zval *cv;
        ZEND_HASH_FOREACH_VAL(lst(ent, "columns"), cv) {
            ZVAL_DEREF(cv);
            HashTable *ch = Z_ARRVAL_P(cv);
            if (gt(ch, "default_now") && !assigned(c, set, gs(c, ch, "name"))) {
                lpush(clocked, cv);
            }
        } ZEND_HASH_FOREACH_END();
    }
    bool load = gt(r, "load");
    zend_string *identity = gs(c, ent, "identity");
    if (load && ZSTR_LEN(identity) > 0 && !assigns_value(c, set, identity)) {
        return fail("IR_INVALID", "load of %s needs a value for the identity column %s",
            ZSTR_VAL(gs(c, ent, "entity")), ZSTR_VAL(identity));
    }
    zval *cols = newlist(c);
    zval *vals = newlist(c);
    zval *a;
    ZEND_HASH_FOREACH_VAL(set, a) {
        ZVAL_DEREF(a);
        HashTable *ah = Z_ARRVAL_P(a);
        HashTable *col = NULL;
        if (!col_of(c, ent, gs(c, ah, "column"), &col)) {
            return NULL;
        }
        if (zend_string_equals(gs(c, col, "name"), identity) && !load) {
            return fail("IR_INVALID", "cannot set identity column %s", ZSTR_VAL(gs(c, ah, "column")));
        }
        zend_string *qc = quote(c, gs(c, ah, "column"));
        OKP(qc);
        lpushs(cols, qc);
        zend_string *v = render_assign(c, b, ent, col, ah);
        OKP(v);
        lpushs(vals, v);
    } ZEND_HASH_FOREACH_END();
    if (versioned) {
        zend_string *qv = quote(c, gs(c, ent, "aes_version"));
        OKP(qv);
        lpushs(cols, qv);
        zend_string *cv = aes_version_slot(c, b, ent);
        OKP(cv);
        lpushs(vals, cv);
    }
    if (audited) {
        zend_string *qa = quote(c, gs(c, ent, "audit"));
        OKP(qa);
        lpushs(cols, qa);
        zend_string *au = b_audit(c, b, ent);
        OKP(au);
        lpushs(vals, au);
    }
    zval *cl;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(clocked), cl) {
        ZVAL_DEREF(cl);
        zend_string *qn = quote(c, gs(c, Z_ARRVAL_P(cl), "name"));
        OKP(qn);
        lpushs(cols, qn);
        zend_string *now = b_now(c, b, gl(Z_ARRVAL_P(cl), "precision", 0));
        OKP(now);
        lpushs(vals, now);
    } ZEND_HASH_FOREACH_END();
    zend_string *tbl = b_table(c, b, ent);
    OKP(tbl);
    zend_string *sql = fmt(c, "INSERT INTO %s (%s) VALUES (%s)", ZSTR_VAL(tbl), ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(cols))),
        ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(vals))));
    HashTable *rows = lst(r, "rows");
    if (count_of(rows) > 0) {
        HashTable *rset = lst(r, "set");
        zval *given = column_of(c, rset, "column");
        zend_long n = count_of(set);
        zend_long *src = emalloc(sizeof(zend_long) * (n > 0 ? n : 1));
        for (zend_long i = 0; i < n; i++) {
            zval *av = at(set, i);
            HashTable *ah = Z_ARRVAL_P(av);
            if (i < count_of(rset)) {
                src[i] = i;
            } else {
                HashTable *bsrc = block_index_source(c, ent, gs(c, ah, "column"));
                src[i] = 0;
                if (bsrc != NULL) {
                    zend_string *nm = gs(c, bsrc, "name");
                    zval *gv;
                    zend_long gi = 0;
                    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(given), gv) {
                        if (Z_TYPE_P(gv) == IS_STRING && zend_string_equals(Z_STR_P(gv), nm)) {
                            src[i] = gi;
                            break;
                        }
                        gi++;
                    } ZEND_HASH_FOREACH_END();
                }
            }
        }
        zval *rowz;
        ZEND_HASH_FOREACH_VAL(rows, rowz) {
            ZVAL_DEREF(rowz);
            HashTable *row = Z_ARRVAL_P(rowz);
            zval *more = newlist(c);
            for (zend_long i = 0; i < n; i++) {
                zval *av = at(set, i);
                HashTable *ah = Z_ARRVAL_P(av);
                HashTable *col = NULL;
                if (!col_of(c, ent, gs(c, ah, "column"), &col)) {
                    efree(src);
                    return NULL;
                }
                zval *tmp = newlist(c);
                puts_(tmp, "column", gs(c, ah, "column"));
                zval *pv = at(row, src[i]);
                if (pv != NULL) {
                    put(tmp, "p", pv);
                }
                zend_string *v = render_assign(c, b, ent, col, Z_ARRVAL_P(tmp));
                if (v == NULL) {
                    efree(src);
                    return NULL;
                }
                lpushs(more, v);
            }
            if (versioned) {
                zend_string *cv = aes_version_slot(c, b, ent);
                OKP(cv);
                lpushs(more, cv);
            }
            if (audited) {
                zend_string *au = b_audit(c, b, ent);
                OKP(au);
                lpushs(more, au);
            }
            zval *cl2;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(clocked), cl2) {
                ZVAL_DEREF(cl2);
                zend_string *now = b_now(c, b, gl(Z_ARRVAL_P(cl2), "precision", 0));
                OKP(now);
                lpushs(more, now);
            } ZEND_HASH_FOREACH_END();
            sql = fmt(c, "%s, (%s)", ZSTR_VAL(sql), ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(more))));
        } ZEND_HASH_FOREACH_END();
        efree(src);
        zval *slots = copy_list(c, Z_ARRVAL_P(b->slots));
        zval *tables = b_tables(c, b);
        OKP(tables);
        return step_new(c, "main", sql, ZSTR_EMPTY_ALLOC(), slots, tables);
    }
    HashTable *dup = lst(r, "on_duplicate");
    if (count_of(dup) > 0) {
        zval *dupz = with_blind_indexes(c, ent, dup);
        OKP(dupz);
        if (!check_aes_assignments(c, ent, Z_ARRVAL_P(dupz), true)) {
            return NULL;
        }
        zval *sets = newlist(c);
        zval *da;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(dupz), da) {
            ZVAL_DEREF(da);
            HashTable *dah = Z_ARRVAL_P(da);
            HashTable *col = NULL;
            if (!col_of(c, ent, gs(c, dah, "column"), &col)) {
                return NULL;
            }
            zend_string *qc = quote(c, gs(c, dah, "column"));
            OKP(qc);
            zend_string *v = render_assign(c, b, ent, col, dah);
            OKP(v);
            lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qc), ZSTR_VAL(v)));
        } ZEND_HASH_FOREACH_END();
        bool as = false;
        if (!assigns_aes(c, ent, Z_ARRVAL_P(dupz), &as)) {
            return NULL;
        }
        if (as) {
            zend_string *qv = quote(c, gs(c, ent, "aes_version"));
            OKP(qv);
            zend_string *cv = aes_version_slot(c, b, ent);
            OKP(cv);
            lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qv), ZSTR_VAL(cv)));
        }
        if (audited) {
            zend_string *qa = quote(c, gs(c, ent, "audit"));
            OKP(qa);
            zend_string *au = b_audit(c, b, ent);
            OKP(au);
            lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qa), ZSTR_VAL(au)));
        }
        if (ZSTR_LEN(identity) > 0) {
            zval *irid = D(c, "insertReturningId", 0, NULL);
            OKP(irid);
            if (!zend_is_true(irid)) {
                zend_string *qi = quote(c, identity);
                OKP(qi);
                lpushs(sets, fmt(c, "%s = LAST_INSERT_ID(%s)", ZSTR_VAL(qi), ZSTR_VAL(qi)));
            }
        }
        zval *conf = keep(c);
        if (!validator_conflict_key(ent, set, conf)) {
            return NULL;
        }
        zval up[2] = {*Za(c, Z_ARRVAL_P(conf)), *Zs(c, implode(c, ", ", Z_ARRVAL_P(sets)))};
        zend_string *upsert = Ds(c, "upsert", 2, up);
        OKP(upsert);
        sql = fmt(c, "%s%s", ZSTR_VAL(sql), ZSTR_VAL(upsert));
    }
    zval *irid2 = D(c, "insertReturningId", 0, NULL);
    OKP(irid2);
    if (zend_is_true(irid2) && ZSTR_LEN(identity) > 0) {
        zend_string *qi = quote(c, identity);
        OKP(qi);
        sql = fmt(c, "%s RETURNING %s", ZSTR_VAL(sql), ZSTR_VAL(qi));
    }
    zval *slots = copy_list(c, Z_ARRVAL_P(b->slots));
    zval *tables = b_tables(c, b);
    OKP(tables);
    return step_new(c, "main", sql, ZSTR_EMPTY_ALLOC(), slots, tables);
}

/* The statement of an update (Planner::updateStep). */
static pstep *update_step(pctx *c, HashTable *r)
{
    pbinds *b = binds_new(c);
    HashTable *ent = entity(c, gs(c, r, "entity"));
    zval *setz = with_blind_indexes(c, ent, lst(r, "set"));
    OKP(setz);
    HashTable *set = Z_ARRVAL_P(setz);
    if (!check_aes_assignments(c, ent, set, true)) {
        return NULL;
    }
    pscope *root = scopes(c, r, gs(c, ent, "table"), NULL);
    OKP(root);
    zval *sets = newlist(c);
    zval *a;
    ZEND_HASH_FOREACH_VAL(set, a) {
        ZVAL_DEREF(a);
        HashTable *ah = Z_ARRVAL_P(a);
        HashTable *col = NULL;
        if (!col_of(c, ent, gs(c, ah, "column"), &col)) {
            return NULL;
        }
        zend_string *qc = quote(c, gs(c, ah, "column"));
        OKP(qc);
        zend_string *v = render_assign(c, b, ent, col, ah);
        OKP(v);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qc), ZSTR_VAL(v)));
    } ZEND_HASH_FOREACH_END();
    bool as = false;
    if (!assigns_aes(c, ent, set, &as)) {
        return NULL;
    }
    if (as) {
        zend_string *qv = quote(c, gs(c, ent, "aes_version"));
        OKP(qv);
        zend_string *cv = aes_version_slot(c, b, ent);
        OKP(cv);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qv), ZSTR_VAL(cv)));
    }
    zend_string *updated = gs(c, ent, "updated");
    if (ZSTR_LEN(updated) > 0 && !assigned(c, lst(r, "set"), updated)) {
        HashTable *uc = NULL;
        if (!col_of(c, ent, updated, &uc)) {
            return NULL;
        }
        zend_string *qu = quote(c, updated);
        OKP(qu);
        zend_string *ck = clock_of(c, b, uc);
        OKP(ck);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qu), ZSTR_VAL(ck)));
    }
    if (ZSTR_LEN(gs(c, ent, "audit")) > 0) {
        zend_string *qa = quote(c, gs(c, ent, "audit"));
        OKP(qa);
        zend_string *au = b_audit(c, b, ent);
        OKP(au);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qa), ZSTR_VAL(au)));
    }
    zend_string *where = render_group(c, b, root, ga(r, "where"), true);
    OKP(where);
    if (isset_(r, "optimistic")) {
        HashTable *oh = ga(r, "optimistic");
        zend_string *column = gs(c, oh, "column");
        zend_string *qc = qcol(c, root, column);
        OKP(qc);
        HashTable *oc = NULL;
        if (!col_of(c, ent, column, &oc)) {
            return NULL;
        }
        zend_string *v = render_value(c, b, oc, gl(oh, "p", 0));
        OKP(v);
        where = fmt(c, "%s AND %s = %s", ZSTR_VAL(where), ZSTR_VAL(qc), ZSTR_VAL(v));
    }
    zend_string *soft = gs(c, ent, "soft_delete");
    if (ZSTR_LEN(soft) > 0) {
        zend_string *sq = qcol(c, root, soft);
        OKP(sq);
        where = fmt(c, "%s AND %s IS NULL", ZSTR_VAL(where), ZSTR_VAL(sq));
    }
    zend_string *tbl = b_table(c, b, ent);
    OKP(tbl);
    zend_string *sql = fmt(c, "UPDATE %s SET %s WHERE %s", ZSTR_VAL(tbl), ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(sets))),
        ZSTR_VAL(where));
    zval *slots = copy_list(c, Z_ARRVAL_P(b->slots));
    zval *tables = b_tables(c, b);
    OKP(tables);
    return step_new(c, "main", sql, ZSTR_EMPTY_ALLOC(), slots, tables);
}

/* The statement of a delete, a soft delete or an update of the deleted time (Planner::deleteStep). */
static pstep *delete_step(pctx *c, HashTable *r)
{
    pbinds *b = binds_new(c);
    HashTable *ent = entity(c, gs(c, r, "entity"));
    pscope *root = scopes(c, r, gs(c, ent, "table"), NULL);
    OKP(root);
    zend_string *soft = gs(c, ent, "soft_delete");
    zend_string *sets = ZSTR_EMPTY_ALLOC();
    if (ZSTR_LEN(soft) > 0) {
        HashTable *sc = NULL;
        if (!col_of(c, ent, soft, &sc)) {
            return NULL;
        }
        zend_string *qs = quote(c, soft);
        OKP(qs);
        zend_string *ck = clock_of(c, b, sc);
        OKP(ck);
        sets = fmt(c, "%s = %s", ZSTR_VAL(qs), ZSTR_VAL(ck));
        if (ZSTR_LEN(gs(c, ent, "audit")) > 0) {
            zend_string *qa = quote(c, gs(c, ent, "audit"));
            OKP(qa);
            zend_string *au = b_audit(c, b, ent);
            OKP(au);
            sets = fmt(c, "%s, %s = %s", ZSTR_VAL(sets), ZSTR_VAL(qa), ZSTR_VAL(au));
        }
    }
    zend_string *where = render_group(c, b, root, ga(r, "where"), true);
    OKP(where);
    zend_string *sql;
    if (ZSTR_LEN(soft) > 0) {
        zend_string *sq = qcol(c, root, soft);
        OKP(sq);
        where = fmt(c, "%s AND %s IS NULL", ZSTR_VAL(where), ZSTR_VAL(sq));
        zend_string *tbl = b_table(c, b, ent);
        OKP(tbl);
        sql = fmt(c, "UPDATE %s SET %s WHERE %s", ZSTR_VAL(tbl), ZSTR_VAL(sets), ZSTR_VAL(where));
    } else {
        zend_string *tbl = b_table(c, b, ent);
        OKP(tbl);
        sql = fmt(c, "DELETE FROM %s WHERE %s", ZSTR_VAL(tbl), ZSTR_VAL(where));
    }
    zval *slots = copy_list(c, Z_ARRVAL_P(b->slots));
    zval *tables = b_tables(c, b);
    OKP(tables);
    return step_new(c, "main", sql, ZSTR_EMPTY_ALLOC(), slots, tables);
}

/* The restore of one soft-deleted row (Planner::restoreStep); the key comes from Validator::restoreKey. */
static pstep *restore_step(pctx *c, HashTable *r)
{
    HashTable *ent = entity(c, gs(c, r, "entity"));
    zval *parts = keep(c);
    if (!validator_restore_key(ent, r, parts)) {
        return NULL;
    }
    zend_string *soft = gs(c, ent, "soft_delete");
    zval *setz = with_blind_indexes(c, ent, lst(Z_ARRVAL_P(parts), "set"));
    OKP(setz);
    if (!check_aes_assignments(c, ent, Z_ARRVAL_P(setz), true)) {
        return NULL;
    }
    pbinds *b = binds_new(c);
    pscope *root = scopes(c, r, gs(c, ent, "table"), NULL);
    OKP(root);
    zval *sets = newlist(c);
    zval *a;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(setz), a) {
        ZVAL_DEREF(a);
        HashTable *ah = Z_ARRVAL_P(a);
        HashTable *col = NULL;
        if (!col_of(c, ent, gs(c, ah, "column"), &col)) {
            return NULL;
        }
        zend_string *qc = quote(c, gs(c, ah, "column"));
        OKP(qc);
        zend_string *v = render_assign(c, b, ent, col, ah);
        OKP(v);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qc), ZSTR_VAL(v)));
    } ZEND_HASH_FOREACH_END();
    bool as = false;
    if (!assigns_aes(c, ent, Z_ARRVAL_P(setz), &as)) {
        return NULL;
    }
    if (as) {
        zend_string *qv = quote(c, gs(c, ent, "aes_version"));
        OKP(qv);
        zend_string *cv = aes_version_slot(c, b, ent);
        OKP(cv);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qv), ZSTR_VAL(cv)));
    }
    zend_string *qsoft = quote(c, soft);
    OKP(qsoft);
    lpushs(sets, fmt(c, "%s = NULL", ZSTR_VAL(qsoft)));
    if (ZSTR_LEN(gs(c, ent, "audit")) > 0) {
        zend_string *qa = quote(c, gs(c, ent, "audit"));
        OKP(qa);
        zend_string *au = b_audit(c, b, ent);
        OKP(au);
        lpushs(sets, fmt(c, "%s = %s", ZSTR_VAL(qa), ZSTR_VAL(au)));
    }
    zend_string *where = render_group(c, b, root, ga(Z_ARRVAL_P(parts), "where"), true);
    OKP(where);
    zend_string *sq = qcol(c, root, soft);
    OKP(sq);
    where = fmt(c, "%s AND %s IS NOT NULL", ZSTR_VAL(where), ZSTR_VAL(sq));
    zend_string *tbl = b_table(c, b, ent);
    OKP(tbl);
    zend_string *sql = fmt(c, "UPDATE %s SET %s WHERE %s", ZSTR_VAL(tbl), ZSTR_VAL(implode(c, ", ", Z_ARRVAL_P(sets))),
        ZSTR_VAL(where));
    zval *slots = copy_list(c, Z_ARRVAL_P(b->slots));
    zval *tables = b_tables(c, b);
    OKP(tables);
    return step_new(c, "main", sql, ZSTR_EMPTY_ALLOC(), slots, tables);
}

/* The statement that restarts the identity after the largest key (Planner::restartIdentityStep). */
static pstep *restart_identity_step(pctx *c, HashTable *r)
{
    HashTable *ent = entity(c, gs(c, r, "entity"));
    zend_string *identity = gs(c, ent, "identity");
    if (ZSTR_LEN(identity) == 0) {
        return fail("IR_INVALID", "restart_identity of %s, which has no identity column",
            ZSTR_VAL(gs(c, ent, "entity")));
    }
    pbinds *b = binds_new(c);
    zend_string *tbl = b_table(c, b, ent);
    OKP(tbl);
    zval a[2] = {*Zs(c, gs(c, ent, "table")), *Zs(c, identity)};
    zend_string *sql = Ds(c, "restartIdentity", 2, a);
    OKP(sql);
    zval *tables = b_tables(c, b);
    OKP(tables);
    return step_new(c, "main", sql, ZSTR_EMPTY_ALLOC(), newlist(c), tables);
}

/* Planner::compile: the plan of a validated request as the PHP array. */
static bool compile_body(pctx *c, HashTable *r, zval *ret)
{
    zval *steps = newlist(c);
    zend_string *kind = gs(c, r, "kind");
    const char *k = ZSTR_VAL(kind);
    pstep *st = NULL;
    if (strcmp(k, "paginate") == 0) {
        OKB(select_step(c, steps, r, "all", ZSTR_EMPTY_ALLOC(), NULL));
        OKB(select_step(c, steps, r, "count", ZSTR_EMPTY_ALLOC(), NULL));
    } else if (strcmp(k, "insert") == 0) {
        st = insert_step(c, r);
        OKB(st);
        steps_add(c, steps, st);
    } else if (strcmp(k, "update") == 0) {
        st = update_step(c, r);
        OKB(st);
        steps_add(c, steps, st);
    } else if (strcmp(k, "delete") == 0) {
        st = delete_step(c, r);
        OKB(st);
        steps_add(c, steps, st);
    } else if (strcmp(k, "restore") == 0) {
        st = restore_step(c, r);
        OKB(st);
        steps_add(c, steps, st);
    } else if (strcmp(k, "restart_identity") == 0) {
        st = restart_identity_step(c, r);
        OKB(st);
        steps_add(c, steps, st);
    } else {
        OKB(select_step(c, steps, r, k, gs(c, r, "agg"), NULL));
    }
    array_init(ret);
    zval mh_rv;
    zval *mh = zend_read_property(Z_OBJCE_P(c->model), Z_OBJ_P(c->model), "manifestHash", sizeof("manifestHash") - 1, true,
        &mh_rv);
    put(ret, "manifest_hash", mh);
    puts_(ret, "kind", kind);
    zval *list = newlist(c);
    zend_long n = count_of(Z_ARRVAL_P(steps));
    for (zend_long i = 0; i < n; i++) {
        zval *arr = step_array(c, step_at(steps, i));
        OKB(arr);
        lpush(list, arr);
    }
    put(ret, "steps", list);
    return true;
}

/* Polyspec\Orm\Planner::__construct(RuntimeModel $m, Dialect $d): the model and the dialect are the properties m and d. */
/* The class entry of a library class by its name, NULL when it is not loaded. */
static zend_class_entry *lib_class(const char *name)
{
    zend_string *cn = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(cn);
    zend_string_release(cn);
    return ce;
}

bool planner_construct(zval *self, zval *model, zval *dialect)
{
    zend_class_entry *mce = lib_class(RUNTIME_MODEL);
    if (mce == NULL || Z_TYPE_P(model) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(model), mce)) {
        zend_type_error("Polyspec\\Orm\\Planner::__construct(): Argument #1 ($m) must be of type Polyspec\\Orm\\RuntimeModel, %s given",
            zend_zval_type_name(model));
        return false;
    }
    zend_class_entry *dce = lib_class("Polyspec\\Orm\\Dialect");
    if (dce == NULL || Z_TYPE_P(dialect) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(dialect), dce)) {
        zend_type_error("Polyspec\\Orm\\Planner::__construct(): Argument #2 ($d) must be of type Polyspec\\Orm\\Dialect, %s given",
            zend_zval_type_name(dialect));
        return false;
    }
    zend_update_property(Z_OBJCE_P(self), Z_OBJ_P(self), "m", 1, model);
    zend_update_property(Z_OBJCE_P(self), Z_OBJ_P(self), "d", 1, dialect);
    return true;
}

/* Polyspec\Orm\Planner::compile(array $r): array. */
bool planner_compile(zval *self, HashTable *r, zval *ret)
{
    pctx c;
    memset(&c, 0, sizeof(c));
    c.self = self;
    zval rv_m, rv_d, rv_e;
    c.model = zend_read_property(Z_OBJCE_P(self), Z_OBJ_P(self), "m", 1, true, &rv_m);
    c.dialect = zend_read_property(Z_OBJCE_P(self), Z_OBJ_P(self), "d", 1, true, &rv_d);
    zval *ents = zend_read_property(Z_OBJCE_P(c.model), Z_OBJ_P(c.model), "entities", sizeof("entities") - 1, true, &rv_e);
    c.entities = Z_ARRVAL_P(ents);
    bool ok = compile_body(&c, r, ret);
    release(&c);
    return ok;
}
