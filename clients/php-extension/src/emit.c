/*
 * 문서를 canonical text로, 또는 manifest text와 schema text로 쓴다(PHP client Emitter, docs/dbspec.md
 * "Canonical form", "Manifest and hashes"). 문서 집합의 검사(DocumentSet)와 manifest도 여기 있다.
 */
#include "dbspec.h"

static const char *const setting_kinds[] = {
    "entity", "updated", "soft_delete", "select_explicit", "codec", "aes_version", "blind_index", "navigation", "immutable", "audit", NULL,
};

static int kind_rank(str kind)
{
    for (int i = 0; setting_kinds[i] != NULL; i++) {
        if (str_eqc(kind, setting_kinds[i])) {
            return i;
        }
    }
    /* PHP의 $rank[$kind]는 알 수 없는 kind에 null이고, null은 모든 순위보다 작다. */
    return -1;
}

static void comments(sbuf *b, const strs *c, const char *indent, dbs_view view)
{
    if (view != VIEW_CANONICAL) {
        return;
    }
    for (size_t i = 0; i < c->n; i++) {
        sb_c(b, indent);
        sb_s(b, c->v[i]);
        sb_ch(b, '\n');
    }
}

#define BYNAME(T, field) \
    static int cmp_##T(const void *a, const void *b, void *ctx) \
    { \
        (void)ctx; \
        return str_cmp((*(T *const *)a)->field, (*(T *const *)b)->field); \
    }

BYNAME(useline, document)
BYNAME(ukey, name)
BYNAME(xindex, name)
BYNAME(fkey, name)
BYNAME(check, name)

/* 이름의 byte 순서로 안정 정렬한 사본이다. */
static void *sorted_copy(void *items, size_t n, size_t size, int (*cmp)(const void *, const void *, void *))
{
    void *copy = dbs_alloc(n * size + 1);
    if (n > 0) {
        memcpy(copy, items, n * size);
    }
    dbs_sort(copy, n, size, cmp, NULL);
    return copy;
}

static int cmp_setting(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const setting *x = *(setting *const *)a, *y = *(setting *const *)b;
    int rx = kind_rank(x->kind), ry = kind_rank(y->kind);
    if (rx != ry) {
        return rx < ry ? -1 : 1;
    }
    if (str_eqc(x->kind, "codec") || str_eqc(x->kind, "blind_index") || str_eqc(x->kind, "navigation")) {
        str ax = x->args.n > 0 ? x->args.v[0] : SL(""), ay = y->args.n > 0 ? y->args.v[0] : SL("");
        return str_cmp(ax, ay);
    }
    return 0;
}

static str setting_text(const setting *s, const table *t, dbs_view view)
{
    if (str_eqc(s->kind, "select_explicit")) {
        return fmt("select explicit %S", strs_join(&s->args, " "));
    }
    if (str_eqc(s->kind, "audit")) {
        /* schema text는 database 상태로 정해지므로 기록하지 않는 column을 column 순서의 exclude 목록으로 쓴다. */
        if (view == VIEW_SCHEMA) {
            strs excluded = setting_excluded(s, t);
            return setting_audit_line(s, "exclude", &excluded);
        }
        if (s->include != NULL) {
            return setting_audit_line(s, "include", s->include);
        }
        return setting_audit_line(s, "exclude", s->exclude);
    }
    strs parts = {0};
    PUSH(parts, s->kind);
    for (size_t i = 0; i < s->args.n; i++) {
        PUSH(parts, s->args.v[i]);
    }
    return strs_join(&parts, " ");
}

static void emit_table(sbuf *b, const table *t, dbs_view view)
{
    comments(b, &t->comments, "", view);
    sb_fmt(b, "table %S {\n", t->name);
    for (size_t i = 0; i < t->columns.n; i++) {
        const column *c = t->columns.v[i];
        comments(b, &c->comments, "  ", view);
        sb_fmt(b, "  %S %S", c->name, ctype_text(c->type));
        if (c->nullable) {
            sb_c(b, " null");
        }
        if (c->identity) {
            sb_c(b, " identity");
        }
        if (c->has_default) {
            sb_fmt(b, " default %S", c->def);
        }
        sb_ch(b, '\n');
    }
    if (t->pk != NULL) {
        comments(b, &t->pk->comments, "  ", view);
        sb_fmt(b, "  primary key (%S)\n", strs_join(&t->pk->columns, ", "));
    }
    ukey **u = sorted_copy(t->uniques.v, t->uniques.n, sizeof(ukey *), cmp_ukey);
    for (size_t i = 0; i < t->uniques.n; i++) {
        comments(b, &u[i]->comments, "  ", view);
        sb_fmt(b, "  unique %S (%S)\n", u[i]->name, strs_join(&u[i]->columns, ", "));
    }
    xindex **x = sorted_copy(t->indexes.v, t->indexes.n, sizeof(xindex *), cmp_xindex);
    for (size_t i = 0; i < t->indexes.n; i++) {
        comments(b, &x[i]->comments, "  ", view);
        sb_fmt(b, "  index %S (", x[i]->name);
        for (size_t k = 0; k < x[i]->columns.n; k++) {
            if (k > 0) {
                sb_c(b, ", ");
            }
            sb_s(b, x[i]->columns.v[k].name);
            if (x[i]->columns.v[k].descending) {
                sb_c(b, " desc");
            }
        }
        sb_c(b, ")\n");
    }
    fkey **f = sorted_copy(t->fks.v, t->fks.n, sizeof(fkey *), cmp_fkey);
    for (size_t i = 0; i < t->fks.n; i++) {
        comments(b, &f[i]->comments, "  ", view);
        sb_fmt(b, "  foreign key %S (%S) references %S (%S) on delete %S on update %S\n", f[i]->name, strs_join(&f[i]->columns, ", "),
            f[i]->table, strs_join(&f[i]->refs, ", "), f[i]->on_delete, f[i]->on_update);
    }
    check **k = sorted_copy(t->checks.v, t->checks.n, sizeof(check *), cmp_check);
    for (size_t i = 0; i < t->checks.n; i++) {
        comments(b, &k[i]->comments, "  ", view);
        sb_fmt(b, "  check %S (%S)\n", k[i]->name, k[i]->expression);
    }
    strs closing = t->closing;
    settingv written = {0};
    if (t->settings != NULL) {
        for (size_t i = 0; i < t->settings->list.n; i++) {
            setting *s = t->settings->list.v[i];
            if (view != VIEW_SCHEMA || str_eqc(s->kind, "immutable") || str_eqc(s->kind, "audit")) {
                PUSH(written, s);
            }
        }
    }
    if (t->settings != NULL && written.n == 0) {
        /* 빈 settings block은 뜻이 없으므로 쓰지 않고 그 comment는 table의 `}` 앞에 남긴다. */
        strs merged = strs_copy(&t->settings->comments);
        for (size_t i = 0; i < t->settings->closing.n; i++) PUSH(merged, t->settings->closing.v[i]);
        for (size_t i = 0; i < closing.n; i++) PUSH(merged, closing.v[i]);
        closing = merged;
    } else if (t->settings != NULL) {
        comments(b, &t->settings->comments, "  ", view);
        sb_c(b, "  settings {\n");
        dbs_sort(written.v, written.n, sizeof(setting *), cmp_setting, NULL);
        for (size_t i = 0; i < written.n; i++) {
            comments(b, &written.v[i]->comments, "    ", view);
            sb_fmt(b, "    %S\n", setting_text(written.v[i], t, view));
        }
        comments(b, &t->settings->closing, "    ", view);
        sb_c(b, "  }\n");
    }
    comments(b, &closing, "  ", view);
    sb_c(b, "}\n");
}

str dbs_emit(const document *d, dbs_view view)
{
    sbuf b = {0};
    sb_fmt(&b, "dbspec 1 %S\n", d->name);
    if (d->uses.n > 0) {
        sb_ch(&b, '\n');
        useline **u = sorted_copy(d->uses.v, d->uses.n, sizeof(useline *), cmp_useline);
        for (size_t i = 0; i < d->uses.n; i++) {
            comments(&b, &u[i]->comments, "", view);
            sb_fmt(&b, "use %S { %S }\n", u[i]->document, strs_join(&u[i]->tables, ", "));
        }
    }
    for (size_t i = 0; i < d->tables.n; i++) {
        sb_ch(&b, '\n');
        emit_table(&b, d->tables.v[i], view);
    }
    if (view != VIEW_CANONICAL) {
        return sb_str(&b);
    }
    for (size_t i = 0; i < d->diagrams.n; i++) {
        const diagram *g = d->diagrams.v[i];
        sb_ch(&b, '\n');
        comments(&b, &g->comments, "", view);
        sb_fmt(&b, "diagram %S {\n", g->name);
        for (size_t k = 0; k < g->placements.n; k++) {
            const placement *p = g->placements.v[k];
            comments(&b, &p->comments, "  ", view);
            sb_fmt(&b, "  %S at %d %d\n", p->table, p->x, p->y);
        }
        comments(&b, &g->closing, "  ", view);
        sb_c(&b, "}\n");
    }
    if (d->trailing.n > 0) {
        sb_ch(&b, '\n');
        comments(&b, &d->trailing, "", view);
    }
    return sb_str(&b);
}

/* ------------------------------------------------------------------- set */

static int cmp_document(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(document *const *)a)->name, (*(document *const *)b)->name);
}

static void walk(document *d, const smap *by_name, smap *reached)
{
    for (size_t i = 0; i < d->uses.n; i++) {
        document *next = smap_get(by_name, d->uses.v[i]->document);
        if (next != NULL && !smap_has(reached, next->name)) {
            smap_set(reached, next->name, TRUEP);
            walk(next, by_name, reached);
        }
    }
}

void dbs_set_check(const documentv *in, documentv *ordered, diags *out)
{
    documentv docs = {0};
    for (size_t i = 0; i < in->n; i++) {
        PUSH(docs, in->v[i]);
    }
    dbs_sort(docs.v, docs.n, sizeof(document *), cmp_document, NULL);
    smap names = {0};
    for (size_t i = 0; i < docs.n; i++) {
        smap_set(&names, docs.v[i]->name, TRUEP);
    }
    zend_long header = (zend_long)strlen("dbspec 1 ") + 1;
    for (size_t i = 0; i < docs.n; i++) {
        document *d = docs.v[i];
        if (i > 0 && str_eq(docs.v[i - 1]->name, d->name)) {
            PUSH(*out, mkdiag(SL("name.duplicate"), 1, header, fmt("document %S appears twice in the document set", d->name)));
        }
        strs used = {0};
        for (size_t k = 0; k < d->uses.n; k++) {
            PUSH(used, d->uses.v[k]->document);
        }
        strs_sort(&used);
        for (size_t k = 0; k < used.n; k++) {
            if (!smap_has(&names, used.v[k])) {
                PUSH(*out, mkdiag(SL("use"), 1, header, fmt("document %S uses %S, which is not in the document set", d->name, used.v[k])));
            }
        }
    }
    /* 외부 문서는 소유한 문서에서 use를 따라 닿는 문서다. */
    smap by_name = {0};
    for (size_t i = 0; i < docs.n; i++) {
        if (!smap_has(&by_name, docs.v[i]->name)) {
            smap_set(&by_name, docs.v[i]->name, docs.v[i]);
        }
    }
    smap reached = {0};
    for (size_t i = 0; i < docs.n; i++) {
        if (!docs.v[i]->external) {
            walk(docs.v[i], &by_name, &reached);
        }
    }
    for (size_t i = 0; i < docs.n; i++) {
        if (docs.v[i]->external && !smap_has(&reached, docs.v[i]->name)) {
            PUSH(*out, mkdiag(SL("use"), 1, header, fmt("external document %S is not used by a document of the set", docs.v[i]->name)));
        }
    }
    *ordered = docs;
}

/* 외부 문서에서 tables의 column, primary key, unique key만 문서 순서로 담은 문서다. 그 table이 없으면 NULL이다. */
static document *external_document(const document *d, const strs *tables)
{
    document *out = document_new(d->name);
    for (size_t i = 0; i < d->tables.n; i++) {
        table *t = d->tables.v[i];
        if (!strs_has(tables, t->name)) {
            continue;
        }
        table *trimmed = table_new(t->name);
        trimmed->columns = t->columns;
        if (t->pk != NULL) {
            trimmed->pk = dbs_alloc(sizeof(pkey));
            trimmed->pk->columns = t->pk->columns;
        }
        for (size_t k = 0; k < t->uniques.n; k++) {
            ukey *u = dbs_alloc(sizeof *u);
            u->name = t->uniques.v[k]->name;
            u->columns = t->uniques.v[k]->columns;
            PUSH(trimmed->uniques, u);
        }
        PUSH(out->tables, trimmed);
    }
    return out->tables.n == 0 ? NULL : out;
}

static int cmp_table(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(table *const *)a)->name, (*(table *const *)b)->name);
}

bool dbs_manifest(const documentv *documents, manifest *m, diags *out)
{
    documentv ordered;
    size_t before = out->n;
    dbs_set_check(documents, &ordered, out);
    if (out->n != before) {
        return false;
    }
    smap used = {0}; /* 문서 이름 => strs* */
    for (size_t i = 0; i < ordered.n; i++) {
        document *d = ordered.v[i];
        if (d->external) {
            continue;
        }
        for (size_t k = 0; k < d->uses.n; k++) {
            useline *u = d->uses.v[k];
            strs *list = smap_get(&used, u->document);
            if (list == NULL) {
                list = dbs_alloc(sizeof *list);
                smap_set(&used, u->document, list);
            }
            for (size_t x = 0; x < u->tables.n; x++) {
                if (!strs_has(list, u->tables.v[x])) {
                    PUSH(*list, u->tables.v[x]);
                }
            }
        }
    }
    sbuf manifest_text = {0}, external_text = {0};
    tablev tables = {0};
    document *schema = document_new(SL("schema"));
    for (size_t i = 0; i < ordered.n; i++) {
        document *d = ordered.v[i];
        if (d->external) {
            strs *names = smap_get(&used, d->name);
            strs empty = {0};
            document *trimmed = external_document(d, names != NULL ? names : &empty);
            if (trimmed != NULL) {
                sb_s(&external_text, dbs_emit(trimmed, VIEW_MANIFEST));
                strs sorted = strs_copy(names);
                strs_sort(&sorted);
                useline *u = dbs_alloc(sizeof *u);
                u->document = d->name;
                u->tables = sorted;
                PUSH(schema->uses, u);
            }
            continue;
        }
        sb_s(&manifest_text, dbs_emit(d, VIEW_MANIFEST));
        for (size_t k = 0; k < d->tables.n; k++) {
            PUSH(tables, d->tables.v[k]);
        }
    }
    /* schema text는 집합이 소유한 모든 table을 이름 순으로 담은 문서 `schema` 하나이므로 문서를 나누는 방식과 무관하다. */
    dbs_sort(tables.v, tables.n, sizeof(table *), cmp_table, NULL);
    schema->tables = tables;
    m->manifest_text = sb_str(&manifest_text);
    m->external_text = sb_str(&external_text);
    m->schema_text = dbs_emit(schema, VIEW_SCHEMA);
    m->manifest_hash = dbs_sha256(fmt("%S%S", m->manifest_text, m->external_text));
    m->schema_hash = dbs_sha256(m->schema_text);
    return true;
}
