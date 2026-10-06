/*
 * PHP 객체 graph(Polyspec\Orm\Dbspec\Native\Document와 그 하위 class)와 C model을 양방향으로 바꾼다. 사용자가 고친
 * Document를 그대로 받으므로, 배열 property의 원소는 그 자리의 class인지 확인하고 아니면 TypeError다.
 */
#include "dbspec.h"
#include "Zend/zend_exceptions.h"

#define DBS_DEFINE_CE(n) zend_class_entry *dbs_ce_##n;
DBS_CLASSES(DBS_DEFINE_CE)
#undef DBS_DEFINE_CE

void obj_new(zval *out, zend_class_entry *ce)
{
    object_init_ex(out, ce);
}

static zval *slot(zend_object *o, const char *name)
{
    zend_property_info *info = zend_hash_str_find_ptr(&o->ce->properties_info, name, strlen(name));
    ZEND_ASSERT(info != NULL);
    return OBJ_PROP(o, info->offset);
}

void obj_put(zval *obj, const char *name, zval *v)
{
    zval *p = slot(Z_OBJ_P(obj), name);
    zval_ptr_dtor(p);
    ZVAL_COPY_VALUE(p, v);
    Z_PROP_FLAG_P(p) = 0;
}

void obj_put_str(zval *obj, const char *name, str s)
{
    zval v;
    ZVAL_STR(&v, str_zend(s));
    obj_put(obj, name, &v);
}

void obj_put_long(zval *obj, const char *name, zend_long n)
{
    zval v;
    ZVAL_LONG(&v, n);
    obj_put(obj, name, &v);
}

void obj_put_bool(zval *obj, const char *name, bool b)
{
    zval v;
    ZVAL_BOOL(&v, b);
    obj_put(obj, name, &v);
}

void obj_put_null(zval *obj, const char *name)
{
    zval v;
    ZVAL_NULL(&v);
    obj_put(obj, name, &v);
}

void obj_put_strs(zval *obj, const char *name, const strs *l)
{
    zval v;
    zv_strs(&v, l);
    obj_put(obj, name, &v);
}

zval *obj_get(zval *obj, const char *name)
{
    zend_object *o = Z_OBJ_P(obj);
    zval *p = slot(o, name);
    if (Z_TYPE_P(p) == IS_UNDEF) {
        if (EG(exception) == NULL) {
            zend_throw_error(NULL, "Typed property %s::$%s must not be accessed before initialization", ZSTR_VAL(o->ce->name), name);
        }
        return NULL;
    }
    ZVAL_DEREF(p);
    return p;
}

void zv_strs(zval *out, const strs *l)
{
    if (l->n == 0) {
        ZVAL_EMPTY_ARRAY(out);
        return;
    }
    array_init_size(out, (uint32_t)l->n);
    for (size_t i = 0; i < l->n; i++) {
        add_next_index_str(out, str_zend(l->v[i]));
    }
}

void zv_diags(zval *out, const diags *d)
{
    if (d->n == 0) {
        ZVAL_EMPTY_ARRAY(out);
        return;
    }
    array_init_size(out, (uint32_t)d->n);
    for (size_t i = 0; i < d->n; i++) {
        zval o;
        obj_new(&o, dbs_ce_Diagnostic);
        obj_put_str(&o, "rule", d->v[i].rule);
        obj_put_long(&o, "line", d->v[i].line);
        obj_put_long(&o, "column", d->v[i].column);
        obj_put_str(&o, "message", d->v[i].message);
        add_next_index_zval(out, &o);
    }
}

void zv_result(zval *out, zend_class_entry *ce, const char *first, zval *value, const diags *d)
{
    obj_new(out, ce);
    if (value == NULL) {
        obj_put_null(out, first);
    } else {
        obj_put(out, first, value);
    }
    zval list;
    zv_diags(&list, d);
    obj_put(out, "diagnostics", &list);
}

/* ------------------------------------------------------------------ in */

static bool type_error(const char *what, zval *v, const char *want)
{
    if (EG(exception) == NULL) {
        zend_type_error("%s holds %s, not %s", what, zend_zval_value_name(v), want);
    }
    return false;
}

bool in_str(zval *v, str *out, const char *what)
{
    ZVAL_DEREF(v);
    if (Z_TYPE_P(v) != IS_STRING) {
        return type_error(what, v, "a string");
    }
    *out = str_z(Z_STR_P(v));
    return true;
}

bool in_strs(zval *v, strs *out, const char *what)
{
    ZVAL_DEREF(v);
    *out = (strs){0};
    if (Z_TYPE_P(v) != IS_ARRAY) {
        return type_error(what, v, "an array of strings");
    }
    zval *e;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), e) {
        str s;
        if (!in_str(e, &s, what)) {
            return false;
        }
        PUSH(*out, s);
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* obj의 property name을 읽는다. */
#define GET(obj, name) zval *name##_ = obj_get(obj, #name); if (name##_ == NULL) return false

static bool in_obj(zval *v, zend_class_entry *ce, const char *what)
{
    ZVAL_DEREF(v);
    if (Z_TYPE_P(v) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(v), ce)) {
        return type_error(what, v, ZSTR_VAL(ce->name));
    }
    return true;
}

typedef struct {
    HashTable types; /* ColumnType 객체 handle => ctype* */
} in_ctx;

static bool in_ctype(in_ctx *c, zval *v, ctype **out)
{
    ZVAL_DEREF(v);
    ctype *known = zend_hash_index_find_ptr(&c->types, Z_OBJ_HANDLE_P(v));
    if (known != NULL) {
        *out = known;
        return true;
    }
    GET(v, name);
    GET(v, parameters);
    str n;
    if (!in_str(name_, &n, "Polyspec\\Orm\\Dbspec\\Native\\ColumnType::$name")) {
        return false;
    }
    VEC(zend_long) params = {0};
    zval *e;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(parameters_), e) {
        ZVAL_DEREF(e);
        if (Z_TYPE_P(e) != IS_LONG) {
            return type_error("Polyspec\\Orm\\Dbspec\\Native\\ColumnType::$parameters", e, "an int");
        }
        PUSH(params, Z_LVAL_P(e));
    } ZEND_HASH_FOREACH_END();
    *out = ctype_new(n, params.v, params.n);
    zend_hash_index_add_ptr(&c->types, Z_OBJ_HANDLE_P(v), *out);
    return true;
}

static bool in_comments(zval *obj, strs *out, const char *what)
{
    zval *c = obj_get(obj, "comments");
    return c != NULL && in_strs(c, out, what);
}

static bool in_column(in_ctx *c, zval *v, column **out)
{
    GET(v, name);
    GET(v, type);
    GET(v, nullable);
    GET(v, identity);
    GET(v, default);
    column *col = dbs_alloc(sizeof *col);
    col->name = str_z(Z_STR_P(name_));
    if (!in_ctype(c, type_, &col->type)) {
        return false;
    }
    col->nullable = Z_TYPE_P(nullable_) == IS_TRUE;
    col->identity = Z_TYPE_P(identity_) == IS_TRUE;
    if (Z_TYPE_P(default_) == IS_STRING) {
        col->has_default = true;
        col->def = str_z(Z_STR_P(default_));
    }
    col->src = Z_OBJ_P(v);
    if (!in_comments(v, &col->comments, "Polyspec\\Orm\\Dbspec\\Native\\Column::$comments")) {
        return false;
    }
    *out = col;
    return true;
}

/* 배열 property의 객체마다 f를 부른다. */
#define EACH_OBJ(arr, ce, what, ...) do { \
        zval *e_; \
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(arr), e_) { \
            if (!in_obj(e_, ce, what)) return false; \
            zval *item = e_; ZVAL_DEREF(item); \
            __VA_ARGS__ \
        } ZEND_HASH_FOREACH_END(); \
    } while (0)

static bool in_setting(zval *v, setting **out)
{
    GET(v, kind);
    GET(v, arguments);
    GET(v, exclude);
    GET(v, include);
    setting *s = dbs_alloc(sizeof *s);
    s->kind = str_z(Z_STR_P(kind_));
    if (!in_strs(arguments_, &s->args, "Polyspec\\Orm\\Dbspec\\Native\\Setting::$arguments")
        || !in_comments(v, &s->comments, "Polyspec\\Orm\\Dbspec\\Native\\Setting::$comments")) {
        return false;
    }
    if (Z_TYPE_P(exclude_) == IS_ARRAY) {
        s->exclude = dbs_alloc(sizeof(strs));
        if (!in_strs(exclude_, s->exclude, "Polyspec\\Orm\\Dbspec\\Native\\Setting::$exclude")) {
            return false;
        }
    }
    if (Z_TYPE_P(include_) == IS_ARRAY) {
        s->include = dbs_alloc(sizeof(strs));
        if (!in_strs(include_, s->include, "Polyspec\\Orm\\Dbspec\\Native\\Setting::$include")) {
            return false;
        }
    }
    *out = s;
    return true;
}

static bool in_table(in_ctx *c, zval *v, table **out)
{
    GET(v, name);
    GET(v, columns);
    GET(v, primaryKey);
    GET(v, uniqueKeys);
    GET(v, indexes);
    GET(v, foreignKeys);
    GET(v, checks);
    GET(v, settings);
    GET(v, closingComments);
    table *t = table_new(str_z(Z_STR_P(name_)));
    if (!in_comments(v, &t->comments, "Polyspec\\Orm\\Dbspec\\Native\\Table::$comments")
        || !in_strs(closingComments_, &t->closing, "Polyspec\\Orm\\Dbspec\\Native\\Table::$closingComments")) {
        return false;
    }
    EACH_OBJ(columns_, dbs_ce_Column, "Polyspec\\Orm\\Dbspec\\Native\\Table::$columns", {
        column *col;
        if (!in_column(c, item, &col)) return false;
        PUSH(t->columns, col);
    });
    if (Z_TYPE_P(primaryKey_) == IS_OBJECT) {
        GET(primaryKey_, columns);
        t->pk = dbs_alloc(sizeof(pkey));
        if (!in_strs(columns_, &t->pk->columns, "Polyspec\\Orm\\Dbspec\\Native\\PrimaryKey::$columns")
            || !in_comments(primaryKey_, &t->pk->comments, "Polyspec\\Orm\\Dbspec\\Native\\PrimaryKey::$comments")) {
            return false;
        }
    }
    EACH_OBJ(uniqueKeys_, dbs_ce_UniqueKey, "Polyspec\\Orm\\Dbspec\\Native\\Table::$uniqueKeys", {
        GET(item, name);
        GET(item, columns);
        ukey *u = dbs_alloc(sizeof *u);
        u->name = str_z(Z_STR_P(name_));
        if (!in_strs(columns_, &u->columns, "Polyspec\\Orm\\Dbspec\\Native\\UniqueKey::$columns")
            || !in_comments(item, &u->comments, "Polyspec\\Orm\\Dbspec\\Native\\UniqueKey::$comments")) return false;
        PUSH(t->uniques, u);
    });
    EACH_OBJ(indexes_, dbs_ce_Index, "Polyspec\\Orm\\Dbspec\\Native\\Table::$indexes", {
        GET(item, name);
        GET(item, columns);
        xindex *x = dbs_alloc(sizeof *x);
        x->name = str_z(Z_STR_P(name_));
        zval *ic;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns_), ic) {
            if (!in_obj(ic, dbs_ce_IndexColumn, "Polyspec\\Orm\\Dbspec\\Native\\Index::$columns")) return false;
            ZVAL_DEREF(ic);
            zval *icname = obj_get(ic, "name"), *desc = obj_get(ic, "descending");
            if (icname == NULL || desc == NULL) return false;
            PUSH(x->columns, ((icol){str_z(Z_STR_P(icname)), Z_TYPE_P(desc) == IS_TRUE}));
        } ZEND_HASH_FOREACH_END();
        if (!in_comments(item, &x->comments, "Polyspec\\Orm\\Dbspec\\Native\\Index::$comments")) return false;
        PUSH(t->indexes, x);
    });
    EACH_OBJ(foreignKeys_, dbs_ce_ForeignKey, "Polyspec\\Orm\\Dbspec\\Native\\Table::$foreignKeys", {
        GET(item, name);
        GET(item, columns);
        GET(item, table);
        GET(item, referencedColumns);
        GET(item, onDelete);
        GET(item, onUpdate);
        fkey *f = dbs_alloc(sizeof *f);
        f->name = str_z(Z_STR_P(name_));
        f->table = str_z(Z_STR_P(table_));
        f->on_delete = str_z(Z_STR_P(onDelete_));
        f->on_update = str_z(Z_STR_P(onUpdate_));
        if (!in_strs(columns_, &f->columns, "Polyspec\\Orm\\Dbspec\\Native\\ForeignKey::$columns")
            || !in_strs(referencedColumns_, &f->refs, "Polyspec\\Orm\\Dbspec\\Native\\ForeignKey::$referencedColumns")
            || !in_comments(item, &f->comments, "Polyspec\\Orm\\Dbspec\\Native\\ForeignKey::$comments")) return false;
        PUSH(t->fks, f);
    });
    EACH_OBJ(checks_, dbs_ce_Check, "Polyspec\\Orm\\Dbspec\\Native\\Table::$checks", {
        GET(item, name);
        GET(item, expression);
        check *k = dbs_alloc(sizeof *k);
        k->name = str_z(Z_STR_P(name_));
        k->expression = str_z(Z_STR_P(expression_));
        if (!in_comments(item, &k->comments, "Polyspec\\Orm\\Dbspec\\Native\\Check::$comments")) return false;
        PUSH(t->checks, k);
    });
    if (Z_TYPE_P(settings_) == IS_OBJECT) {
        zval *block = settings_;
        zval *lines = obj_get(block, "settings"), *closing = obj_get(block, "closingComments");
        if (lines == NULL || closing == NULL) {
            return false;
        }
        settings *s = dbs_alloc(sizeof *s);
        if (!in_comments(block, &s->comments, "Polyspec\\Orm\\Dbspec\\Native\\Settings::$comments")
            || !in_strs(closing, &s->closing, "Polyspec\\Orm\\Dbspec\\Native\\Settings::$closingComments")) {
            return false;
        }
        EACH_OBJ(lines, dbs_ce_Setting, "Polyspec\\Orm\\Dbspec\\Native\\Settings::$settings", {
            setting *one;
            if (!in_setting(item, &one)) return false;
            PUSH(s->list, one);
        });
        t->settings = s;
    }
    *out = t;
    return true;
}

static bool in_document_ctx(in_ctx *c, zval *v, document **out)
{
    if (!in_obj(v, dbs_ce_Document, "the document argument")) {
        return false;
    }
    ZVAL_DEREF(v);
    GET(v, name);
    GET(v, uses);
    GET(v, tables);
    GET(v, diagrams);
    GET(v, trailingComments);
    GET(v, external);
    document *d = document_new(str_z(Z_STR_P(name_)));
    d->external = Z_TYPE_P(external_) == IS_TRUE;
    d->src = Z_OBJ_P(v);
    if (!in_strs(trailingComments_, &d->trailing, "Polyspec\\Orm\\Dbspec\\Native\\Document::$trailingComments")) {
        return false;
    }
    EACH_OBJ(uses_, dbs_ce_UseLine, "Polyspec\\Orm\\Dbspec\\Native\\Document::$uses", {
        GET(item, document);
        GET(item, tables);
        useline *u = dbs_alloc(sizeof *u);
        u->document = str_z(Z_STR_P(document_));
        if (!in_strs(tables_, &u->tables, "Polyspec\\Orm\\Dbspec\\Native\\UseLine::$tables")
            || !in_comments(item, &u->comments, "Polyspec\\Orm\\Dbspec\\Native\\UseLine::$comments")) return false;
        PUSH(d->uses, u);
    });
    EACH_OBJ(tables_, dbs_ce_Table, "Polyspec\\Orm\\Dbspec\\Native\\Document::$tables", {
        table *t;
        if (!in_table(c, item, &t)) return false;
        PUSH(d->tables, t);
    });
    EACH_OBJ(diagrams_, dbs_ce_Diagram, "Polyspec\\Orm\\Dbspec\\Native\\Document::$diagrams", {
        GET(item, name);
        GET(item, placements);
        GET(item, closingComments);
        diagram *g = dbs_alloc(sizeof *g);
        g->name = str_z(Z_STR_P(name_));
        if (!in_comments(item, &g->comments, "Polyspec\\Orm\\Dbspec\\Native\\Diagram::$comments")
            || !in_strs(closingComments_, &g->closing, "Polyspec\\Orm\\Dbspec\\Native\\Diagram::$closingComments")) return false;
        zval *pz;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(placements_), pz) {
            if (!in_obj(pz, dbs_ce_Placement, "Polyspec\\Orm\\Dbspec\\Native\\Diagram::$placements")) return false;
            ZVAL_DEREF(pz);
            zval *pt = obj_get(pz, "table"), *px = obj_get(pz, "x"), *py = obj_get(pz, "y");
            if (pt == NULL || px == NULL || py == NULL) return false;
            placement *p = dbs_alloc(sizeof *p);
            p->table = str_z(Z_STR_P(pt));
            p->x = Z_LVAL_P(px);
            p->y = Z_LVAL_P(py);
            if (!in_comments(pz, &p->comments, "Polyspec\\Orm\\Dbspec\\Native\\Placement::$comments")) return false;
            PUSH(g->placements, p);
        } ZEND_HASH_FOREACH_END();
        PUSH(d->diagrams, g);
    });
    *out = d;
    return true;
}

bool in_document(zval *v, document **out)
{
    in_ctx c;
    zend_hash_init(&c.types, 8, NULL, NULL, 0);
    bool ok = in_document_ctx(&c, v, out);
    zend_hash_destroy(&c.types);
    return ok;
}

bool in_documents(zval *v, documentv *out, const char *what)
{
    *out = (documentv){0};
    zval *e;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), e) {
        if (!in_obj(e, dbs_ce_Document, what)) {
            return false;
        }
        document *d;
        if (!in_document(e, &d)) {
            return false;
        }
        PUSH(*out, d);
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* ----------------------------------------------------------------- out */

typedef struct {
    HashTable types; /* ctype* => ColumnType 객체 */
} out_ctx;

static void out_ctype(out_ctx *c, ctype *t, zval *out)
{
    zval *known = zend_hash_index_find(&c->types, (zend_ulong)(uintptr_t)t);
    if (known != NULL) {
        ZVAL_COPY(out, known);
        return;
    }
    obj_new(out, dbs_ce_ColumnType);
    obj_put_str(out, "name", t->name);
    zval params;
    if (t->np == 0) {
        ZVAL_EMPTY_ARRAY(&params);
    } else {
        array_init_size(&params, (uint32_t)t->np);
        for (size_t i = 0; i < t->np; i++) {
            add_next_index_long(&params, t->p[i]);
        }
    }
    obj_put(out, "parameters", &params);
    Z_ADDREF_P(out);
    zend_hash_index_add_new(&c->types, (zend_ulong)(uintptr_t)t, out);
}

static void out_comments(zval *obj, const strs *c)
{
    obj_put_strs(obj, "comments", c);
}

static void out_list_begin(zval *arr, size_t n)
{
    if (n == 0) {
        ZVAL_EMPTY_ARRAY(arr);
    } else {
        array_init_size(arr, (uint32_t)n);
    }
}

static void out_setting(const setting *s, zval *out)
{
    obj_new(out, dbs_ce_Setting);
    obj_put_str(out, "kind", s->kind);
    obj_put_strs(out, "arguments", &s->args);
    out_comments(out, &s->comments);
    if (s->exclude != NULL) {
        obj_put_strs(out, "exclude", s->exclude);
    } else {
        obj_put_null(out, "exclude");
    }
    if (s->include != NULL) {
        obj_put_strs(out, "include", s->include);
    } else {
        obj_put_null(out, "include");
    }
}

static void out_table(out_ctx *c, const table *t, zval *out)
{
    obj_new(out, dbs_ce_Table);
    obj_put_str(out, "name", t->name);
    out_comments(out, &t->comments);
    zval list;
    out_list_begin(&list, t->columns.n);
    for (size_t i = 0; i < t->columns.n; i++) {
        const column *col = t->columns.v[i];
        zval o, type;
        obj_new(&o, dbs_ce_Column);
        obj_put_str(&o, "name", col->name);
        out_ctype(c, col->type, &type);
        obj_put(&o, "type", &type);
        obj_put_bool(&o, "nullable", col->nullable);
        obj_put_bool(&o, "identity", col->identity);
        if (col->has_default) {
            obj_put_str(&o, "default", col->def);
        } else {
            obj_put_null(&o, "default");
        }
        out_comments(&o, &col->comments);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "columns", &list);
    if (t->pk != NULL) {
        zval o;
        obj_new(&o, dbs_ce_PrimaryKey);
        obj_put_strs(&o, "columns", &t->pk->columns);
        out_comments(&o, &t->pk->comments);
        obj_put(out, "primaryKey", &o);
    }
    out_list_begin(&list, t->uniques.n);
    for (size_t i = 0; i < t->uniques.n; i++) {
        zval o;
        obj_new(&o, dbs_ce_UniqueKey);
        obj_put_str(&o, "name", t->uniques.v[i]->name);
        obj_put_strs(&o, "columns", &t->uniques.v[i]->columns);
        out_comments(&o, &t->uniques.v[i]->comments);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "uniqueKeys", &list);
    out_list_begin(&list, t->indexes.n);
    for (size_t i = 0; i < t->indexes.n; i++) {
        const xindex *x = t->indexes.v[i];
        zval o, cols;
        obj_new(&o, dbs_ce_Index);
        obj_put_str(&o, "name", x->name);
        out_list_begin(&cols, x->columns.n);
        for (size_t k = 0; k < x->columns.n; k++) {
            zval ic;
            obj_new(&ic, dbs_ce_IndexColumn);
            obj_put_str(&ic, "name", x->columns.v[k].name);
            obj_put_bool(&ic, "descending", x->columns.v[k].descending);
            add_next_index_zval(&cols, &ic);
        }
        obj_put(&o, "columns", &cols);
        out_comments(&o, &x->comments);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "indexes", &list);
    out_list_begin(&list, t->fks.n);
    for (size_t i = 0; i < t->fks.n; i++) {
        const fkey *f = t->fks.v[i];
        zval o;
        obj_new(&o, dbs_ce_ForeignKey);
        obj_put_str(&o, "name", f->name);
        obj_put_strs(&o, "columns", &f->columns);
        obj_put_str(&o, "table", f->table);
        obj_put_strs(&o, "referencedColumns", &f->refs);
        obj_put_str(&o, "onDelete", f->on_delete);
        obj_put_str(&o, "onUpdate", f->on_update);
        out_comments(&o, &f->comments);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "foreignKeys", &list);
    out_list_begin(&list, t->checks.n);
    for (size_t i = 0; i < t->checks.n; i++) {
        zval o;
        obj_new(&o, dbs_ce_Check);
        obj_put_str(&o, "name", t->checks.v[i]->name);
        obj_put_str(&o, "expression", t->checks.v[i]->expression);
        out_comments(&o, &t->checks.v[i]->comments);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "checks", &list);
    if (t->settings != NULL) {
        zval o, items;
        obj_new(&o, dbs_ce_Settings);
        out_list_begin(&items, t->settings->list.n);
        for (size_t i = 0; i < t->settings->list.n; i++) {
            zval s;
            out_setting(t->settings->list.v[i], &s);
            add_next_index_zval(&items, &s);
        }
        obj_put(&o, "settings", &items);
        obj_put_strs(&o, "closingComments", &t->settings->closing);
        out_comments(&o, &t->settings->comments);
        obj_put(out, "settings", &o);
    }
    obj_put_strs(out, "closingComments", &t->closing);
}

void out_document(const document *d, zval *out)
{
    out_ctx c;
    zend_hash_init(&c.types, 8, NULL, ZVAL_PTR_DTOR, 0);
    obj_new(out, dbs_ce_Document);
    obj_put_str(out, "name", d->name);
    zval list;
    out_list_begin(&list, d->uses.n);
    for (size_t i = 0; i < d->uses.n; i++) {
        zval o;
        obj_new(&o, dbs_ce_UseLine);
        obj_put_str(&o, "document", d->uses.v[i]->document);
        obj_put_strs(&o, "tables", &d->uses.v[i]->tables);
        out_comments(&o, &d->uses.v[i]->comments);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "uses", &list);
    out_list_begin(&list, d->tables.n);
    for (size_t i = 0; i < d->tables.n; i++) {
        zval o;
        out_table(&c, d->tables.v[i], &o);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "tables", &list);
    out_list_begin(&list, d->diagrams.n);
    for (size_t i = 0; i < d->diagrams.n; i++) {
        const diagram *g = d->diagrams.v[i];
        zval o, places;
        obj_new(&o, dbs_ce_Diagram);
        obj_put_str(&o, "name", g->name);
        out_comments(&o, &g->comments);
        out_list_begin(&places, g->placements.n);
        for (size_t k = 0; k < g->placements.n; k++) {
            zval p;
            obj_new(&p, dbs_ce_Placement);
            obj_put_str(&p, "table", g->placements.v[k]->table);
            obj_put_long(&p, "x", g->placements.v[k]->x);
            obj_put_long(&p, "y", g->placements.v[k]->y);
            out_comments(&p, &g->placements.v[k]->comments);
            add_next_index_zval(&places, &p);
        }
        obj_put(&o, "placements", &places);
        obj_put_strs(&o, "closingComments", &g->closing);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "diagrams", &list);
    obj_put_strs(out, "trailingComments", &d->trailing);
    obj_put_bool(out, "external", d->external);
    zend_hash_destroy(&c.types);
}

/* ------------------------------------------------------------------ plans */

static bool in_str_prop(zval *obj, const char *name, str *out)
{
    zval *v = obj_get(obj, name);
    if (v == NULL) {
        return false;
    }
    *out = str_z(Z_STR_P(v));
    return true;
}

bool in_plan(zval *v, plan **out)
{
    if (!in_obj(v, dbs_ce_Plan, "the plan argument")) {
        return false;
    }
    ZVAL_DEREF(v);
    GET(v, name);
    GET(v, from);
    GET(v, renameTables);
    GET(v, renameColumns);
    GET(v, dropTables);
    GET(v, dropColumns);
    GET(v, schema);
    GET(v, to);
    plan *p = dbs_alloc(sizeof *p);
    p->name = str_z(Z_STR_P(name_));
    if (Z_TYPE_P(from_) == IS_STRING) {
        p->has_from = true;
        p->from = str_z(Z_STR_P(from_));
    }
    p->to = str_z(Z_STR_P(to_));
    p->src = Z_OBJ_P(v);
    EACH_OBJ(renameTables_, dbs_ce_TableRename, "Polyspec\\Orm\\Dbspec\\Native\\Plan::$renameTables", {
        trename r;
        if (!in_str_prop(item, "old", &r.old) || !in_str_prop(item, "new", &r.new_)) return false;
        PUSH(p->rename_tables, r);
    });
    EACH_OBJ(renameColumns_, dbs_ce_ColumnRename, "Polyspec\\Orm\\Dbspec\\Native\\Plan::$renameColumns", {
        crename r;
        if (!in_str_prop(item, "table", &r.table) || !in_str_prop(item, "old", &r.old) || !in_str_prop(item, "new", &r.new_)) return false;
        PUSH(p->rename_columns, r);
    });
    if (!in_strs(dropTables_, &p->drop_tables, "Polyspec\\Orm\\Dbspec\\Native\\Plan::$dropTables")) {
        return false;
    }
    EACH_OBJ(dropColumns_, dbs_ce_ColumnName, "Polyspec\\Orm\\Dbspec\\Native\\Plan::$dropColumns", {
        cname c;
        if (!in_str_prop(item, "table", &c.table) || !in_str_prop(item, "name", &c.name)) return false;
        PUSH(p->drop_columns, c);
    });
    if (!in_document(schema_, &p->schema)) {
        return false;
    }
    *out = p;
    return true;
}

bool in_plans(zval *v, planv *out, const char *what)
{
    *out = (planv){0};
    zval *e;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), e) {
        if (!in_obj(e, dbs_ce_Plan, what)) {
            return false;
        }
        plan *p;
        if (!in_plan(e, &p)) {
            return false;
        }
        PUSH(*out, p);
    } ZEND_HASH_FOREACH_END();
    return true;
}

void out_plan(const plan *p, zval *out)
{
    if (p->src != NULL) {
        ZVAL_OBJ_COPY(out, p->src);
        return;
    }
    obj_new(out, dbs_ce_Plan);
    obj_put_str(out, "name", p->name);
    if (p->has_from) {
        obj_put_str(out, "from", p->from);
    } else {
        obj_put_null(out, "from");
    }
    zval list;
    out_list_begin(&list, p->rename_tables.n);
    for (size_t i = 0; i < p->rename_tables.n; i++) {
        zval o;
        obj_new(&o, dbs_ce_TableRename);
        obj_put_str(&o, "old", p->rename_tables.v[i].old);
        obj_put_str(&o, "new", p->rename_tables.v[i].new_);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "renameTables", &list);
    out_list_begin(&list, p->rename_columns.n);
    for (size_t i = 0; i < p->rename_columns.n; i++) {
        zval o;
        obj_new(&o, dbs_ce_ColumnRename);
        obj_put_str(&o, "table", p->rename_columns.v[i].table);
        obj_put_str(&o, "old", p->rename_columns.v[i].old);
        obj_put_str(&o, "new", p->rename_columns.v[i].new_);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "renameColumns", &list);
    obj_put_strs(out, "dropTables", &p->drop_tables);
    out_list_begin(&list, p->drop_columns.n);
    for (size_t i = 0; i < p->drop_columns.n; i++) {
        zval o;
        obj_new(&o, dbs_ce_ColumnName);
        obj_put_str(&o, "table", p->drop_columns.v[i].table);
        obj_put_str(&o, "name", p->drop_columns.v[i].name);
        add_next_index_zval(&list, &o);
    }
    obj_put(out, "dropColumns", &list);
    zval schema;
    if (p->schema->src != NULL) {
        ZVAL_OBJ_COPY(&schema, p->schema->src);
    } else {
        out_document(p->schema, &schema);
    }
    obj_put(out, "schema", &schema);
    obj_put_str(out, "to", p->to);
}

static void out_effect(const effect *e, zval *out)
{
    obj_new(out, dbs_ce_Effect);
    obj_put_str(out, "kind", e->kind);
    obj_put_str(out, "table", e->table);
    obj_put_str(out, "name", e->name);
    obj_put_bool(out, "present", e->present);
}

void out_steps(const planstepv *steps, zval *out)
{
    out_list_begin(out, steps->n);
    for (size_t i = 0; i < steps->n; i++) {
        const planstep *s = &steps->v[i];
        zval o, e, checks;
        obj_new(&o, dbs_ce_PlanStep);
        obj_put_str(&o, "statement", s->statement);
        obj_put_str(&o, "rollback", s->rollback);
        obj_put_str(&o, "irreversible", s->irreversible);
        out_effect(&s->effect, &e);
        obj_put(&o, "effect", &e);
        obj_put_str(&o, "restore", s->restore);
        obj_put_str(&o, "rollbackRestore", s->rollback_restore);
        if (s->has_restore_if) {
            zval r;
            out_effect(&s->restore_if, &r);
            obj_put(&o, "restoreIf", &r);
        } else {
            obj_put_null(&o, "restoreIf");
        }
        out_list_begin(&checks, s->null_checks.n);
        for (size_t k = 0; k < s->null_checks.n; k++) {
            const nullcheck *n = &s->null_checks.v[k];
            zval c;
            obj_new(&c, dbs_ce_NullCheck);
            obj_put_str(&c, "table", n->table);
            obj_put_str(&c, "column", n->column);
            if (n->has_default) {
                obj_put_str(&c, "default", n->def);
            } else {
                obj_put_null(&c, "default");
            }
            add_next_index_zval(&checks, &c);
        }
        obj_put(&o, "nullChecks", &checks);
        obj_put_bool(&o, "finalize", s->finalize);
        add_next_index_zval(out, &o);
    }
}

void out_changes(const changev *changes, zend_class_entry *ce, zval *out)
{
    out_list_begin(out, changes->n);
    for (size_t i = 0; i < changes->n; i++) {
        zval o;
        obj_new(&o, ce);
        obj_put_str(&o, "kind", changes->v[i].kind);
        obj_put_str(&o, "table", changes->v[i].table);
        obj_put_str(&o, "name", changes->v[i].name);
        add_next_index_zval(out, &o);
    }
}

bool in_unsupported(zval *v, unsupportedv *out, const char *what)
{
    *out = (unsupportedv){0};
    EACH_OBJ(v, dbs_ce_Unsupported, what, {
        unsupported u;
        if (!in_str_prop(item, "kind", &u.kind) || !in_str_prop(item, "table", &u.table) || !in_str_prop(item, "name", &u.name)
            || !in_str_prop(item, "reason", &u.reason)) return false;
        PUSH(*out, u);
    });
    return true;
}

void out_unsupported(const unsupportedv *list, zval *out)
{
    out_list_begin(out, list->n);
    for (size_t i = 0; i < list->n; i++) {
        zval o;
        obj_new(&o, dbs_ce_Unsupported);
        obj_put_str(&o, "kind", list->v[i].kind);
        obj_put_str(&o, "table", list->v[i].table);
        obj_put_str(&o, "name", list->v[i].name);
        obj_put_str(&o, "reason", list->v[i].reason);
        add_next_index_zval(out, &o);
    }
}
