/* Native implementation of Polyspec\\Orm\\RuntimeModel. */
#include "dbspec.h"
#include "runtime_model.h"
#include "ext/spl/spl_exceptions.h"
#include "Zend/zend_interfaces.h"

#define ENTER()                                                                                                                  \
    dbs_arena arena_;                                                                                                            \
    dbs_arena *saved_;                                                                                                           \
    dbs_enter(&arena_, &saved_)
#define LEAVE() dbs_leave(&arena_, saved_)

zend_class_entry *polyspec_runtime_model_ce;
static zend_class_entry *runtime_lookup_class(const char *name) {
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

/* Construct the userland exception for the current request. `previous`, when
 * non-NULL, is an owned reference and is passed through the public constructor. */
static void orm_error_impl(const char *code, str message, zend_object *previous) {
    if (EG(exception) != NULL) {
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }

    zend_class_entry *ce = runtime_lookup_class("Polyspec\\Orm\\OrmException");
    if (ce == NULL) {
        if (EG(exception) == NULL)
            zend_throw_error(NULL, "Class Polyspec\\Orm\\OrmException not found");
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }
    if (EG(exception) != NULL) {
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }

    zval ex, fn, args[3], rv;
    object_init_ex(&ex, ce);
    if (EG(exception) != NULL) {
        if (Z_TYPE(ex) != IS_UNDEF)
            zval_ptr_dtor(&ex);
        if (previous != NULL)
            OBJ_RELEASE(previous);
        return;
    }

    ZVAL_STRING(&fn, "__construct");
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], str_zend(message));
    uint32_t argc = 2;
    if (previous != NULL) {
        ZVAL_OBJ(&args[2], previous);
        argc = 3;
    }
    ZVAL_UNDEF(&rv);
    zend_result status = call_user_function(NULL, &ex, &fn, &rv, argc, args);
    zval_ptr_dtor(&fn);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (argc == 3)
        zval_ptr_dtor(&args[2]);
    if (Z_TYPE(rv) != IS_UNDEF)
        zval_ptr_dtor(&rv);
    if (status != SUCCESS && EG(exception) == NULL)
        zend_throw_error(NULL, "Could not construct Polyspec\\Orm\\OrmException");
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&ex);
        return;
    }
    zend_throw_exception_object(&ex);
}

static void orm_error(const char *code, str message) { orm_error_impl(code, message, NULL); }

static void orm_error_previous(const char *code, str message, zend_object *previous) {
    orm_error_impl(code, message, previous);
}
static zval *prop(zval *o, const char *n) { return obj_get(o, n); }
static str zs(zend_string *s) { return (str){ZSTR_VAL(s), ZSTR_LEN(s)}; }
static void append_error(sbuf *b, str label, const diag *d) {
    if (b->n)
        sb_ch(b, '\n');
    sb_fmt(b, "%S:%d:%d: %S: %S", label, d->line, d->column, d->rule, d->message);
}
static void documents_parse(zval *owned, zval *external, zval *out) {
    zval *lists[2] = {owned, external};
    size_t n = zend_hash_num_elements(Z_ARRVAL_P(owned)) + zend_hash_num_elements(Z_ARRVAL_P(external));
    str *texts = dbs_alloc((n + 1) * sizeof(str)), *labels = dbs_alloc((n + 1) * sizeof(str));
    bool *ext = dbs_alloc((n + 1) * sizeof(bool)), *valid = dbs_alloc((n + 1) * sizeof(bool));
    size_t j = 0;
    zend_string *k;
    zend_ulong index;
    zval *v;
    for (int l = 0; l < 2; l++)
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(lists[l]), index, k, v) {
            ZVAL_DEREF(v);
            if (Z_TYPE_P(v) != IS_STRING) {
                zend_throw_exception(spl_ce_InvalidArgumentException, "A document set holds texts", 0);
                return;
            }
            labels[j] = k ? zs(k) : fmt("%d", (zend_long)index);
            texts[j] = zs(Z_STR_P(v));
            ext[j] = l == 1;
            j++;
        }
    ZEND_HASH_FOREACH_END();
    smap named = {0};
    for (size_t i = 0; i < n; i++) {
        str name = dbs_header_name(texts[i]);
        valid[i] = true;
        if (name.n && smap_has(&named, name))
            valid[i] = false;
        else if (name.n) {
            str *t = dbs_alloc(sizeof *t);
            *t = texts[i];
            smap_set(&named, name, t);
        }
    }
    array_init_size(out, (uint32_t)n);
    sbuf errors = {0};
    for (size_t i = 0; i < n; i++) {
        diags ds = {0};
        dposv ps = {0};
        document *d = NULL;
        if (!valid[i])
            PUSH(ds, ((diag){SL("name.duplicate"), 1, 10,
                             fmt("document %S appears twice in the document set", dbs_header_name(texts[i]))}));
        else {
            smap other = {0};
            str own = dbs_header_name(texts[i]);
            SMAP_EACH(&named, x) if (!str_eq(named.e[x].key, own)) smap_set(&other, named.e[x].key, named.e[x].val);
            d = dbs_parse(texts[i], &other, &ds, &ps);
            if (d)
                d->external = ext[i];
        }
        if (ds.n) {
            for (size_t q = 0; q < ds.n; q++)
                append_error(&errors, labels[i], &ds.v[q]);
        }
        if (d) {
            zval z;
            out_document(d, &z);
            add_next_index_zval(out, &z);
        }
    }
    if (errors.n) {
        zval_ptr_dtor(out);
        orm_error("SCHEMA_INVALID", sb_str(&errors));
        ZVAL_UNDEF(out);
    }
}
static str one_setting(const table *t, const char *kind, size_t arg) {
    if (!t->settings)
        return SL("");
    for (size_t i = 0; i < t->settings->list.n; i++) {
        setting *s = t->settings->list.v[i];
        if (str_eqc(s->kind, kind) && s->args.n > arg)
            return s->args.v[arg];
    }
    return SL("");
}
static bool in_strs_exact(const strs *s, str x) { return strs_has(s, x); }
static int cmp_ukey_ptr(const void *a, const void *b, void *ctx) {
    const ukey *x = *(ukey *const *)a, *y = *(ukey *const *)b;
    return str_cmp(x->name, y->name);
}
static int cmp_index_ptr(const void *a, const void *b, void *ctx) {
    const xindex *x = *(xindex *const *)a, *y = *(xindex *const *)b;
    return str_cmp(x->name, y->name);
}
static void table_entity(const table *t, zval *out, bool external) {
    array_init(out);
    str ent = external ? t->name : one_setting(t, "entity", 0);
    if (!ent.n)
        ent = t->name;
    add_assoc_str(out, "entity", str_zend(ent));
    add_assoc_str(out, "table", str_zend(t->name));
    zval pk;
    zv_strs(&pk, &t->pk->columns);
    add_assoc_zval(out, "pk", &pk);
    str identity = SL("");
    for (size_t i = 0; i < t->columns.n; i++)
        if (t->columns.v[i]->identity)
            identity = t->columns.v[i]->name;
    add_assoc_str(out, "identity", str_zend(identity));
    add_assoc_str(out, "updated", str_zend(external ? SL("") : one_setting(t, "updated", 0)));
    add_assoc_str(out, "soft_delete", str_zend(external ? SL("") : one_setting(t, "soft_delete", 0)));
    add_assoc_str(out, "aes_version", str_zend(external ? SL("") : one_setting(t, "aes_version", 0)));
    add_assoc_str(out, "audit", str_zend(external ? SL("") : one_setting(t, "audit", 1)));
    add_assoc_str(out, "audit_record", str_zend(external ? SL("") : one_setting(t, "audit", 2)));
    zval cols;
    array_init_size(&cols, (uint32_t)t->columns.n);
    smap codecs = {0}, blinds = {0}, fks = {0};
    if (!external && t->settings)
        for (size_t i = 0; i < t->settings->list.n; i++) {
            setting *s = t->settings->list.v[i];
            if (str_eqc(s->kind, "codec") && s->args.n > 1) {
                strs *a = dbs_alloc(sizeof *a);
                *a = strs_copy(&(strs){.v = s->args.v + 1, .n = s->args.n - 1});
                smap_set(&codecs, s->args.v[0], a);
            }
            if (str_eqc(s->kind, "blind_index") && s->args.n > 1)
                smap_set(&blinds, s->args.v[0], &s->args.v[1]);
        }
    if (!external)
        for (size_t i = 0; i < t->fks.n; i++)
            for (size_t q = 0; q < t->fks.v[i]->columns.n; q++)
                smap_set(&fks, t->fks.v[i]->columns.v[q], TRUEP);
    strs explicit = {0};
    if (!external && t->settings)
        for (size_t i = 0; i < t->settings->list.n; i++) {
            setting *s = t->settings->list.v[i];
            if (str_eqc(s->kind, "select_explicit"))
                for (size_t q = 0; q < s->args.n; q++)
                    PUSH(explicit, s->args.v[q]);
        }
    for (size_t i = 0; i < t->columns.n; i++) {
        column *c = t->columns.v[i];
        zval col, cv;
        array_init(&col);
        add_assoc_str(&col, "name", str_zend(c->name));
        add_assoc_str(&col, "type", str_zend(c->type->name));
        add_assoc_bool(&col, "nullable", c->nullable);
        add_assoc_bool(&col, "default", c->has_default);
        add_assoc_bool(&col, "default_now", c->has_default && str_eqc(c->def, "now"));
        add_assoc_bool(&col, "select", !in_strs_exact(&explicit, c->name));
        strs *codec = smap_get(&codecs, c->name);
        if (codec)
            zv_strs(&cv, codec);
        else
            array_init(&cv);
        add_assoc_zval(&col, "codec", &cv);
        str *blind = smap_get(&blinds, c->name);
        add_assoc_str(&col, "blind_index", str_zend(blind ? *blind : SL("")));
        add_assoc_bool(&col, "pk", in_strs_exact(&t->pk->columns, c->name));
        add_assoc_bool(&col, "foreign_key", smap_has(&fks, c->name));
        if (str_eqc(c->type->name, "decimal") && c->type->np >= 2) {
            add_assoc_long(&col, "precision", c->type->p[0]);
            add_assoc_long(&col, "scale", c->type->p[1]);
        } else if ((str_eqc(c->type->name, "time") || str_eqc(c->type->name, "datetime")) && c->type->np)
            add_assoc_long(&col, "precision", c->type->p[0]);
        else if (str_eqc(c->type->name, "varchar") && c->type->np)
            add_assoc_long(&col, "length", c->type->p[0]);
        zend_hash_update(Z_ARRVAL(cols), str_zend(c->name), &col);
    }
    add_assoc_zval(out, "columns", &cols);
    zval unique, indexes;
    array_init(&unique);
    array_init(&indexes);
    ukey **ukeys = dbs_alloc((t->uniques.n ? t->uniques.n : 1) * sizeof(*ukeys));
    for (size_t i = 0; i < t->uniques.n; i++)
        ukeys[i] = t->uniques.v[i];
    dbs_sort(ukeys, t->uniques.n, sizeof(*ukeys), cmp_ukey_ptr, NULL);
    for (size_t i = 0; i < t->uniques.n; i++) {
        zval a;
        zv_strs(&a, &ukeys[i]->columns);
        zend_hash_update(Z_ARRVAL(unique), str_zend(ukeys[i]->name), &a);
    }
    xindex **ixs = dbs_alloc((t->indexes.n ? t->indexes.n : 1) * sizeof(*ixs));
    for (size_t i = 0; i < t->indexes.n; i++)
        ixs[i] = t->indexes.v[i];
    dbs_sort(ixs, t->indexes.n, sizeof(*ixs), cmp_index_ptr, NULL);
    for (size_t i = 0; !external && i < t->indexes.n; i++) {
        strs a = {0};
        for (size_t q = 0; q < ixs[i]->columns.n; q++)
            PUSH(a, ixs[i]->columns.v[q].name);
        zval z;
        zv_strs(&z, &a);
        zend_hash_update(Z_ARRVAL(indexes), str_zend(ixs[i]->name), &z);
    }
    add_assoc_zval(out, "unique", &unique);
    add_assoc_zval(out, "indexes", &indexes);
    if (external)
        add_assoc_bool(out, "external", true);
}
static void construct_model(zval *out, str hash, str manifest, zval *entities, str external) {
    object_init_ex(out, polyspec_runtime_model_ce);
    zval v;
    ZVAL_STR(&v, str_zend(hash));
    obj_put(out, "manifestHash", &v);
    ZVAL_STR(&v, str_zend(manifest));
    obj_put(out, "manifestText", &v);
    ZVAL_COPY(&v, entities);
    obj_put(out, "entities", &v);
    ZVAL_STR(&v, str_zend(external));
    obj_put(out, "externalText", &v);
}
static void build_docs(documentv *docs, zval *out) {
    manifest m;
    diags ds = {0};
    if (!dbs_manifest(docs, &m, &ds)) {
        sbuf b = {0};
        for (size_t i = 0; i < ds.n; i++) {
            if (b.n)
                sb_ch(&b, '\n');
            sb_fmt(&b, "%d:%d: %S: %S", ds.v[i].line, ds.v[i].column, ds.v[i].rule, ds.v[i].message);
        }
        orm_error("SCHEMA_INVALID", sb_str(&b));
        return;
    }
    documentv ordered = {0};
    dbs_set_check(docs, &ordered, &ds);
    zval ents;
    array_init(&ents);
    smap used = {0};
    for (size_t i = 0; i < ordered.n; i++) {
        document *d = ordered.v[i];
        if (!d->external)
            for (size_t u = 0; u < d->uses.n; u++) {
                strs *a = smap_get(&used, d->uses.v[u]->document);
                if (!a) {
                    a = dbs_alloc(sizeof *a);
                    *a = (strs){0};
                    smap_set(&used, d->uses.v[u]->document, a);
                }
                for (size_t q = 0; q < d->uses.v[u]->tables.n; q++)
                    PUSH(*a, d->uses.v[u]->tables.v[q]);
            }
    }
    for (size_t i = 0; i < ordered.n; i++) {
        document *d = ordered.v[i];
        for (size_t j = 0; j < d->tables.n; j++) {
            table *t = d->tables.v[j];
            bool ext = d->external;
            if (ext) {
                strs *a = smap_get(&used, d->name);
                if (!a || !strs_has(a, t->name))
                    continue;
            }
            zval e;
            table_entity(t, &e, ext);
            zval *name = zend_hash_str_find(Z_ARRVAL(e), "entity", sizeof("entity") - 1);
            if (zend_hash_exists(Z_ARRVAL(ents), Z_STR_P(name))) {
                str duplicate = fmt("entity %S is declared twice in the document set", zs(Z_STR_P(name)));
                zval_ptr_dtor(&e);
                zval_ptr_dtor(&ents);
                orm_error("SCHEMA_INVALID", duplicate);
                return;
            }
            Z_TRY_ADDREF_P(name);
            zend_hash_update(Z_ARRVAL(ents), Z_STR_P(name), &e);
        }
    }
    construct_model(out, m.manifest_hash, m.manifest_text, &ents, m.external_text);
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, __construct) {
    zend_string *hash, *manifest, *external = NULL;
    zval *entities;
    ZEND_PARSE_PARAMETERS_START(3, 4)
    Z_PARAM_STR(hash)
    Z_PARAM_STR(manifest) Z_PARAM_ARRAY(entities) Z_PARAM_OPTIONAL Z_PARAM_STR(external) ZEND_PARSE_PARAMETERS_END();
    zval v;
    ZVAL_STR_COPY(&v, hash);
    obj_put(ZEND_THIS, "manifestHash", &v);
    ZVAL_STR_COPY(&v, manifest);
    obj_put(ZEND_THIS, "manifestText", &v);
    ZVAL_COPY(&v, entities);
    obj_put(ZEND_THIS, "entities", &v);
    if (external)
        ZVAL_STR_COPY(&v, external);
    else
        ZVAL_EMPTY_STRING(&v);
    obj_put(ZEND_THIS, "externalText", &v);
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, parseSet) {
    zval *owned, *external;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ARRAY(owned) Z_PARAM_ARRAY(external) ZEND_PARSE_PARAMETERS_END();
    zval *v;
    zval *lists[2] = {owned, external};
    for (int i = 0; i < 2; i++)
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(lists[i]), v) {
            ZVAL_DEREF(v);
            if (Z_TYPE_P(v) != IS_STRING) {
                zend_throw_exception(spl_ce_InvalidArgumentException, "A document set holds texts", 0);
                RETURN_THROWS();
            }
        }
    ZEND_HASH_FOREACH_END();
    ENTER();
    documents_parse(owned, external, return_value);
    LEAVE();
    if (EG(exception))
        RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, parse) {
    zval *texts, empty;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(texts) ZEND_PARSE_PARAMETERS_END();
    array_init(&empty);
    zval args[2] = {*texts, empty};
    ZVAL_UNDEF(return_value); /* call native parseSet implementation through its registered method */
    zend_call_method_with_2_params(NULL, polyspec_runtime_model_ce, NULL, "parseset", return_value, &args[0], &args[1]);
    zval_ptr_dtor(&empty);
    if (EG(exception))
        RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, splitManifest) {
    zend_string *text;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(text) ZEND_PARSE_PARAMETERS_END();
    str s = zs(text);
    if (!str_starts(s, "dbspec 1 ")) {
        orm_error("SCHEMA_INVALID", SL("manifest text does not start with a dbspec header"));
        RETURN_THROWS();
    }
    array_init(return_value);
    size_t start = 0;
    while (start < s.n) {
        size_t end = s.n;
        for (size_t i = start + 1; i + 9 <= s.n; i++)
            if (s.s[i - 1] == '\n' && memcmp(s.s + i, "dbspec 1 ", 9) == 0) {
                end = i;
                break;
            }
        char key[48];
        snprintf(key, sizeof key, "document %u", (unsigned)zend_hash_num_elements(Z_ARRVAL_P(return_value)));
        add_assoc_stringl_ex(return_value, key, strlen(key), s.s + start, end - start);
        start = end;
    }
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, loadSet) {
    zend_string *manifest, *external;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_STR(manifest) Z_PARAM_STR(external) ZEND_PARSE_PARAMETERS_END();
    zval m, e, labels;
    ZVAL_UNDEF(&m);
    ZVAL_UNDEF(&e);
    ZVAL_UNDEF(&labels);
    zval a;
    ZVAL_STR_COPY(&a, manifest);
    zend_call_method_with_1_params(NULL, polyspec_runtime_model_ce, NULL, "splitmanifest", &m, &a);
    zval_ptr_dtor(&a);
    if (EG(exception))
        RETURN_THROWS();
    array_init(&e);
    if (ZSTR_LEN(external)) {
        zval x;
        ZVAL_STR_COPY(&a, external);
        zend_call_method_with_1_params(NULL, polyspec_runtime_model_ce, NULL, "splitmanifest", &x, &a);
        zval_ptr_dtor(&a);
        if (EG(exception)) {
            zval_ptr_dtor(&m);
            RETURN_THROWS();
        }
        zend_string *k;
        zval *v;
        ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL(x), k, v) {
            zend_string *n = strpprintf(0, "external %s", ZSTR_VAL(k));
            Z_TRY_ADDREF_P(v);
            zend_hash_update(Z_ARRVAL(e), n, v);
            zend_string_release(n);
        }
        ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&x);
    }
    zend_call_method_with_2_params(NULL, polyspec_runtime_model_ce, NULL, "parseset", return_value, &m, &e);
    zval_ptr_dtor(&m);
    zval_ptr_dtor(&e);
    if (EG(exception))
        RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, build) {
    zval *input;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(input) ZEND_PARSE_PARAMETERS_END();
    ENTER();
    documentv d = {0};
    if (in_documents(input, &d, "RuntimeModel::build expects dbspec Documents"))
        build_docs(&d, return_value);
    LEAVE();
    if (EG(exception))
        RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, entity) {
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *ents = prop(ZEND_THIS, "entities");
    if (!ents)
        RETURN_THROWS();
    zval *v = zend_hash_find(Z_ARRVAL_P(ents), name);
    if (v)
        RETURN_COPY(v);
    RETURN_NULL();
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, column) {
    zval *entity;
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_ARRAY(entity) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval *cols = zend_hash_str_find(Z_ARRVAL_P(entity), "columns", sizeof("columns") - 1);
    if (cols) {
        zval *v = zend_hash_find(Z_ARRVAL_P(cols), name);
        if (v)
            RETURN_COPY(v);
    }
    RETURN_NULL();
}
static bool array_contains(zval *a, const char *needle) {
    if (!a || Z_TYPE_P(a) != IS_ARRAY)
        return false;
    zval *v;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(a), v) {
        if (Z_TYPE_P(v) == IS_STRING && zend_string_equals_cstr(Z_STR_P(v), needle, strlen(needle)))
            return true;
    }
    ZEND_HASH_FOREACH_END();
    return false;
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, styled) {
    zval *c;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(c) ZEND_PARSE_PARAMETERS_END();
    zval *v = zend_hash_str_find(Z_ARRVAL_P(c), "codec", 5);
    RETURN_BOOL(array_contains(v, "ordered_json") || array_contains(v, "serialize") || array_contains(v, "yaml") ||
                array_contains(v, "gz") || array_contains(v, "base64"));
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, encrypted) {
    zval *c;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(c) ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(array_contains(zend_hash_str_find(Z_ARRVAL_P(c), "codec", 5), "aes"));
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, numeric) {
    zval *c, *codec, *type;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(c) ZEND_PARSE_PARAMETERS_END();
    codec = zend_hash_str_find(Z_ARRVAL_P(c), "codec", 5);
    if (codec && Z_TYPE_P(codec) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(codec)))
        RETURN_FALSE;
    type = zend_hash_str_find(Z_ARRVAL_P(c), "type", 4);
    if (!type || Z_TYPE_P(type) != IS_STRING)
        RETURN_FALSE;
    RETURN_BOOL(zend_string_equals_literal(Z_STR_P(type), "i16") || zend_string_equals_literal(Z_STR_P(type), "i32") ||
                zend_string_equals_literal(Z_STR_P(type), "i64") || zend_string_equals_literal(Z_STR_P(type), "f64") ||
                zend_string_equals_literal(Z_STR_P(type), "decimal"));
}
static str difference_path(zval *got, zval *want, str path) {
    if (Z_TYPE_P(got) != IS_ARRAY || Z_TYPE_P(want) != IS_ARRAY)
        return zend_is_identical(got, want) ? SNULL : (path.n ? path : SL("(entity)"));
    zend_string *key;
    zend_ulong idx;
    zval *v;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(want), idx, key, v) {
        zval *found = key ? zend_hash_find(Z_ARRVAL_P(got), key) : zend_hash_index_find(Z_ARRVAL_P(got), idx);
        str part = key ? zs(key) : fmt("%d", (zend_long)idx);
        str at = path.n ? fmt("%S.%S", path, part) : part;
        if (!found)
            return at;
        str d = difference_path(found, v, at);
        if (d.s)
            return d;
    }
    ZEND_HASH_FOREACH_END();
    ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(got), idx, key) {
        bool exists = key ? zend_hash_exists(Z_ARRVAL_P(want), key) : zend_hash_index_exists(Z_ARRVAL_P(want), idx);
        if (!exists) {
            str part = key ? zs(key) : fmt("%d", (zend_long)idx);
            return path.n ? fmt("%S.%S", path, part) : part;
        }
    }
    ZEND_HASH_FOREACH_END();
    return zend_is_identical(got, want) ? SNULL : (path.n ? path : SL("(entity)"));
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, fromModels) {
    zend_string *hash, *text, *external = NULL;
    zval *classes;
    ZEND_PARSE_PARAMETERS_START(3, 4)
    Z_PARAM_STR(hash) Z_PARAM_STR(text) Z_PARAM_ARRAY(classes) Z_PARAM_OPTIONAL Z_PARAM_STR(external) ZEND_PARSE_PARAMETERS_END();
    ENTER();
    zval docs, args[2], built;
    ZVAL_UNDEF(&docs);
    ZVAL_UNDEF(&built);
    ZVAL_STR_COPY(&args[0], text);
    if (external)
        ZVAL_STR_COPY(&args[1], external);
    else
        ZVAL_EMPTY_STRING(&args[1]);
    zend_call_method_with_2_params(NULL, polyspec_runtime_model_ce, NULL, "loadset", &docs, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    if (EG(exception)) {
        LEAVE();
        RETURN_THROWS();
    }
    documentv dv = {0};
    if (in_documents(&docs, &dv, "RuntimeModel::fromModels"))
        build_docs(&dv, &built);
    zval_ptr_dtor(&docs);
    if (EG(exception)) {
        LEAVE();
        RETURN_THROWS();
    }
    zval *manifest = prop(&built, "entities");
    zval entities;
    array_init(&entities);
    zval *cl;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(classes), cl) {
        ZVAL_DEREF(cl);
        if (Z_TYPE_P(cl) != IS_STRING) {
            zend_throw_exception(spl_ce_InvalidArgumentException, "Expected generated model class names", 0);
            break;
        }
        zval callable, meta;
        array_init_size(&callable, 2);
        Z_TRY_ADDREF_P(cl);
        add_next_index_zval(&callable, cl);
        add_next_index_string(&callable, "meta");
        if (call_user_function(NULL, NULL, &callable, &meta, 0, NULL) != SUCCESS || EG(exception)) {
            zval_ptr_dtor(&callable);
            break;
        }
        zval_ptr_dtor(&callable);
        if (Z_TYPE(meta) != IS_ARRAY) {
            zval_ptr_dtor(&meta);
            zend_throw_exception(spl_ce_UnexpectedValueException, "Generated model meta() must return an array", 0);
            break;
        }
        SEPARATE_ARRAY(&meta);
        zend_hash_str_del(Z_ARRVAL(meta), "manifest_hash", sizeof("manifest_hash") - 1);
        zval *nv = zend_hash_str_find(Z_ARRVAL(meta), "entity", sizeof("entity") - 1);
        bool named = nv && Z_TYPE_P(nv) == IS_STRING;
        zval *want = named ? zend_hash_find(Z_ARRVAL_P(manifest), Z_STR_P(nv)) : NULL;
        str path = want ? difference_path(&meta, want, SL("")) : SL("entity");
        if (path.s) {
            str entity = named ? zs(Z_STR_P(nv)) : SL("?");
            orm_error("CONFIG", fmt("generated model %S of entity %S differs from its manifest at %S: generate the models again "
                                    "(orm-gen gen --set <dbspec-set.json> --out <dir> --namespace <namespace>)",
                                    zs(Z_STR_P(cl)), entity, path));
            zval_ptr_dtor(&meta);
            break;
        }
        zend_hash_update(Z_ARRVAL(entities), Z_STR_P(nv), &meta);
    }
    ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&built);
    if (EG(exception)) {
        zval_ptr_dtor(&entities);
        LEAVE();
        RETURN_THROWS();
    }
    construct_model(return_value, zs(hash), zs(text), &entities, external ? zs(external) : SL(""));
    LEAVE();
}
static bool native_static(const char *method, uint32_t argc, zval *argv, zval *ret) {
    zval callable;
    array_init_size(&callable, 2);
    zend_string *cn = zend_string_init("Polyspec\\Orm\\Dbspec\\Dbspec", sizeof("Polyspec\\Orm\\Dbspec\\Dbspec") - 1, 0);
    add_next_index_str(&callable, cn);
    add_next_index_string(&callable, method);
    bool ok = call_user_function(NULL, NULL, &callable, ret, argc, argv) == SUCCESS && EG(exception) == NULL;
    zval_ptr_dtor(&callable);
    return ok;
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, set) {
    zend_string *path;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(path) ZEND_PARSE_PARAMETERS_END();
    ENTER();
    zval arg, set;
    ZVAL_STR_COPY(&arg, path);
    if (!native_static("readSet", 1, &arg, &set)) {
        zval_ptr_dtor(&arg);
        LEAVE();
        RETURN_THROWS();
    }
    zval_ptr_dtor(&arg);
    zval *errors = prop(&set, "errors");
    if (errors && zend_hash_num_elements(Z_ARRVAL_P(errors))) {
        sbuf b = {0};
        zval *e;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(errors), e) {
            zval *r = prop(e, "rule"), *m = prop(e, "message");
            if (b.n)
                sb_ch(&b, '\n');
            sb_fmt(&b, "%S: %S", zs(Z_STR_P(r)), zs(Z_STR_P(m)));
        }
        ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&set);
        orm_error("CONFIG", sb_str(&b));
        LEAVE();
        RETURN_THROWS();
    }
    zval *dl = prop(&set, "documents"), *el = prop(&set, "external");
    zval texts[2];
    array_init(&texts[0]);
    array_init(&texts[1]);
    sbuf errors_text = {0};
    zval *lists[2] = {dl, el};
    for (int l = 0; l < 2; l++) {
        zval *f;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(lists[l]), f) {
            zval *p = prop(f, "path"), *bytes = prop(f, "bytes"), args[2], rr;
            ZVAL_COPY(&args[0], p);
            ZVAL_COPY(&args[1], bytes);
            if (!native_static("readBytes", 2, args, &rr)) {
                zval_ptr_dtor(&args[0]);
                zval_ptr_dtor(&args[1]);
                zval_ptr_dtor(&set);
                zval_ptr_dtor(&texts[0]);
                zval_ptr_dtor(&texts[1]);
                LEAVE();
                RETURN_THROWS();
            }
            zval_ptr_dtor(&args[0]);
            zval_ptr_dtor(&args[1]);
            zval *ds = prop(&rr, "diagnostics"), *text = prop(&rr, "text");
            if (ds && zend_hash_num_elements(Z_ARRVAL_P(ds))) {
                zval *d;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ds), d) {
                    zval *line = prop(d, "line"), *col = prop(d, "column"), *rule = prop(d, "rule"), *msg = prop(d, "message");
                    if (errors_text.n)
                        sb_ch(&errors_text, '\n');
                    sb_fmt(&errors_text, "%S:%d:%d: %S: %S", zs(Z_STR_P(p)), Z_LVAL_P(line), Z_LVAL_P(col), zs(Z_STR_P(rule)),
                           zs(Z_STR_P(msg)));
                }
                ZEND_HASH_FOREACH_END();
            } else if (text && Z_TYPE_P(text) == IS_STRING) {
                Z_TRY_ADDREF_P(text);
                zend_hash_update(Z_ARRVAL(texts[l]), Z_STR_P(p), text);
            }
            zval_ptr_dtor(&rr);
        }
        ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&set);
    if (errors_text.n) {
        zval_ptr_dtor(&texts[0]);
        zval_ptr_dtor(&texts[1]);
        orm_error("SCHEMA_INVALID", sb_str(&errors_text));
        LEAVE();
        RETURN_THROWS();
    }
    documents_parse(&texts[0], &texts[1], return_value);
    zval_ptr_dtor(&texts[0]);
    zval_ptr_dtor(&texts[1]);
    LEAVE();
    if (EG(exception))
        RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_RuntimeModel, files) {
    zval *paths, *external = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2) Z_PARAM_ARRAY(paths) Z_PARAM_OPTIONAL Z_PARAM_ARRAY(external) ZEND_PARSE_PARAMETERS_END();
    if (zend_hash_num_elements(Z_ARRVAL_P(paths)) == 0) {
        orm_error("CONFIG", SL("a document set needs at least one dbspec file"));
        RETURN_THROWS();
    }
    ENTER();
    zval texts[2];
    array_init(&texts[0]);
    array_init(&texts[1]);
    zval *lists[2] = {paths, external};
    for (int l = 0; l < 2; l++) {
        if (!lists[l])
            continue;
        sbuf errors = {0};
        zval *p;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(lists[l]), p) {
            ZVAL_DEREF(p);
            zval a, rr;
            ZVAL_COPY(&a, p);
            if (!native_static("readFile", 1, &a, &rr)) {
                zval_ptr_dtor(&a);
                zend_object *cause = EG(exception);
                if (cause && instanceof_function(cause->ce, spl_ce_RuntimeException)) {
                    GC_ADDREF(cause);
                    zend_clear_exception();
                    orm_error_previous("CONFIG", exception_message(cause), cause);
                }
                zval_ptr_dtor(&texts[0]);
                zval_ptr_dtor(&texts[1]);
                LEAVE();
                RETURN_THROWS();
            }
            zval_ptr_dtor(&a);
            zval *ds = prop(&rr, "diagnostics"), *text = prop(&rr, "text");
            if (ds && zend_hash_num_elements(Z_ARRVAL_P(ds))) {
                zval *d;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(ds), d) {
                    zval *line = prop(d, "line"), *col = prop(d, "column"), *rule = prop(d, "rule"), *msg = prop(d, "message");
                    if (errors.n)
                        sb_ch(&errors, '\n');
                    sb_fmt(&errors, "%S:%d:%d: %S: %S", zs(Z_STR_P(p)), Z_LVAL_P(line), Z_LVAL_P(col), zs(Z_STR_P(rule)),
                           zs(Z_STR_P(msg)));
                }
                ZEND_HASH_FOREACH_END();
            } else if (text && Z_TYPE_P(text) == IS_STRING) {
                Z_TRY_ADDREF_P(text);
                zend_hash_update(Z_ARRVAL(texts[l]), Z_STR_P(p), text);
            }
            zval_ptr_dtor(&rr);
            if (EG(exception))
                break;
        }
        ZEND_HASH_FOREACH_END();
        if (EG(exception)) {
            zval_ptr_dtor(&texts[0]);
            zval_ptr_dtor(&texts[1]);
            LEAVE();
            RETURN_THROWS();
        }
        if (errors.n) {
            str message = sb_str(&errors);
            zval_ptr_dtor(&texts[0]);
            zval_ptr_dtor(&texts[1]);
            orm_error("SCHEMA_INVALID", message);
            LEAVE();
            RETURN_THROWS();
        }
    }
    documents_parse(&texts[0], &texts[1], return_value);
    zval_ptr_dtor(&texts[0]);
    zval_ptr_dtor(&texts[1]);
    LEAVE();
    if (EG(exception))
        RETURN_THROWS();
}
void polyspec_runtime_model_register(zend_class_entry *ce) {
    polyspec_runtime_model_ce = ce;
}
