/*
 * Writes a document as canonical text, or as manifest text and schema text (PHP client Emitter, docs/dbspec.md
 * "Canonical form", "Manifest and hashes"). The document set check (DocumentSet) and the manifest are also here.
 */
#include "dbspec.h"

/* Canonical order: mapping settings (markdown through state_machine) come before immutable and audit. */
static const char *const setting_kinds[] = {
    "entity", "updated", "soft_delete", "select_explicit", "codec", "aes_version", "blind_index", "navigation", "markdown", "store",
    "key_prefix", "title", "body", "order", "checkbox", "state_machine", "immutable", "audit", NULL,
};

static int kind_rank(str kind)
{
    for (int i = 0; setting_kinds[i] != NULL; i++) {
        if (str_eqc(kind, setting_kinds[i])) {
            return i;
        }
    }
    /* In PHP, $rank[$kind] is null for an unknown kind, and null is less than every rank. */
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

/* A copy stably sorted by name byte order. */
static void *sorted_copy(void *items, size_t n, size_t size, int (*cmp)(const void *, const void *, void *))
{
    void *copy = dbs_alloc(n * size + 1);
    if (n > 0) {
        memcpy(copy, items, n * size);
    }
    dbs_sort(copy, n, size, cmp, NULL);
    return copy;
}

/* Order of state_machine lines: transitions, initial and terminal lines, history, limit; within the same kind, declaration order. */
static int state_form_rank(const setting *s)
{
    if (s->form.s != NULL && str_eqc(s->form, "history")) {
        return 1;
    }
    if (s->form.s != NULL && str_eqc(s->form, "limit")) {
        return 2;
    }
    return 0;
}

static int cmp_setting(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const setting *x = *(setting *const *)a, *y = *(setting *const *)b;
    int rx = kind_rank(x->kind), ry = kind_rank(y->kind);
    if (rx != ry) {
        return rx < ry ? -1 : 1;
    }
    if (str_eqc(x->kind, "codec") || str_eqc(x->kind, "blind_index") || str_eqc(x->kind, "navigation") || str_eqc(x->kind, "markdown")) {
        str ax = x->args.n > 0 ? x->args.v[0] : SL(""), ay = y->args.n > 0 ? y->args.v[0] : SL("");
        return str_cmp(ax, ay);
    }
    if (str_eqc(x->kind, "state_machine")) {
        int fx = state_form_rank(x), fy = state_form_rank(y);
        return fx < fy ? -1 : fx > fy ? 1 : 0;
    }
    return 0;
}

/* Canonical text of a row count: leading zeros removed (Go strconv.FormatInt). A number that passes the check is a positive integer. */
static str count_text(str s)
{
    size_t i = 0;
    while (i + 1 < s.n && s.s[i] == '0') {
        i++;
    }
    return str_sub(s, i, s.n - i);
}

/* Text of one state_machine line. args are the column and the format's arguments, and requires is the require list of transition and terminal lines. */
static str state_machine_text(const setting *s)
{
    const strs *a = &s->args;
    str column = a->v[0], form = s->form;
    if (str_eqc(form, "initial")) {
        return fmt("state_machine %S initial %S", column, a->v[1]);
    }
    if (str_eqc(form, "history")) {
        return fmt("state_machine %S history %S row %S from %S to %S at %S", column, a->v[1], a->v[2], a->v[3], a->v[4], a->v[5]);
    }
    if (str_eqc(form, "limit")) {
        return fmt("state_machine %S limit %S %S", column, a->v[1], count_text(a->v[2]));
    }
    str text = str_eqc(form, "terminal") ? fmt("state_machine %S terminal %S", column, a->v[1])
        : fmt("state_machine %S %S -> %S", column, a->v[1], a->v[2]);
    if (s->requires != NULL && s->requires->n > 0) {
        text = fmt("%S require (%S)", text, strs_join(s->requires, ", "));
    }
    return text;
}

static str setting_text(const setting *s, const table *t, dbs_view view)
{
    if (str_eqc(s->kind, "select_explicit")) {
        return fmt("select explicit %S", strs_join(&s->args, " "));
    }
    if (str_eqc(s->kind, "audit")) {
        /* Schema text is determined by the database state, so the columns not recorded are used as an exclude list in column order. */
        if (view == VIEW_SCHEMA) {
            strs excluded = setting_excluded(s, t);
            return setting_audit_line(s, "exclude", &excluded);
        }
        if (s->include != NULL) {
            return setting_audit_line(s, "include", s->include);
        }
        return setting_audit_line(s, "exclude", s->exclude);
    }
    if (str_eqc(s->kind, "state_machine")) {
        return state_machine_text(s);
    }
    if (str_eqc(s->kind, "key_prefix")) {
        return fmt("key_prefix %S", literal_quote(s->args.v[0]));
    }
    if (str_eqc(s->kind, "checkbox")) {
        return fmt("checkbox %S %S %S", s->args.v[0], s->args.v[1], literal_quote(s->args.v[2]));
    }
    /* For store, if the shard clause's column and period follow the kind's arguments, `shard` is written before them (Setting::STORE_ARGUMENTS). */
    size_t shard = s->args.n;
    if (str_eqc(s->kind, "store")) {
        shard = str_eqc(s->args.v[0], "files") ? 1 : str_eqc(s->args.v[0], "document") ? 2 : 3;
    }
    strs parts = {0};
    PUSH(parts, s->kind);
    for (size_t i = 0; i < s->args.n; i++) {
        if (i == shard) {
            PUSH(parts, SL("shard"));
        }
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
        /* An empty settings block has no meaning, so it is not written, and its comment is kept before the table's `}`. */
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
    /* An external document is one reached by following use from the owning document. */
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

/* A document holding only the columns, primary key, and unique keys of tables from the external document, in document order. NULL if the table does not exist. */
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
    smap used = {0}; /* document name => strs* */
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
    /* Schema text is one document `schema` holding all tables the set owns, in name order, so it does not depend on how documents are split. */
    dbs_sort(tables.v, tables.n, sizeof(table *), cmp_table, NULL);
    schema->tables = tables;
    m->manifest_text = sb_str(&manifest_text);
    m->external_text = sb_str(&external_text);
    m->schema_text = dbs_emit(schema, VIEW_SCHEMA);
    m->manifest_hash = dbs_sha256(fmt("%S%S", m->manifest_text, m->external_text));
    m->schema_hash = dbs_sha256(m->schema_text);
    return true;
}
