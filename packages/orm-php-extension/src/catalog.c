/*
 * introspection과 Mermaid import가 채우는 중립 중간 model이다(PHP client Catalog, CatalogTable). catalog_document가
 * 그것을 dbspec text로 쓰고 parse하며, parse가 거부한 줄의 객체를 미지원으로 보고하고 빼서 다시 만든다.
 */
#include "dbspec.h"
#include "ext/spl/spl_exceptions.h"

itable *itable_new(str name)
{
    itable *t = dbs_alloc(sizeof *t);
    t->name = name;
    return t;
}

itable *catalog_table(catalog *c, str name)
{
    for (size_t i = 0; i < c->tables.n; i++) {
        if (str_eq(c->tables.v[i]->name, name)) {
            return c->tables.v[i];
        }
    }
    return NULL;
}

void catalog_report(catalog *c, str kind, str table, str name, str reason)
{
    PUSH(c->unsupported, ((unsupported){kind, table, name, reason}));
}

smap itable_types(const itable *t)
{
    smap out = {0};
    for (size_t i = 0; i < t->columns.n; i++) {
        smap_set(&out, t->columns.v[i].name, t->columns.v[i].type);
    }
    return out;
}

void itable_drop_column(itable *t, str name)
{
    size_t k = 0;
    for (size_t i = 0; i < t->columns.n; i++) {
        if (!str_eq(t->columns.v[i].name, name)) {
            t->columns.v[k++] = t->columns.v[i];
        }
    }
    t->columns.n = k;
}

str catalog_action_name(str rule, bool *ok)
{
    str u = str_upper(rule);
    *ok = true;
    if (str_eqc(u, "RESTRICT")) return SL("restrict");
    if (str_eqc(u, "CASCADE")) return SL("cascade");
    if (str_eqc(u, "SET NULL")) return SL("set_null");
    *ok = false;
    return SL("");
}

/* 10^scale을 곱한 정수 text를 scale 자리 소수로 쓴다. */
str catalog_unscaled_decimal(str text, zend_long scale)
{
    bool negative = str_starts(text, "-");
    str digits = negative ? str_sub(text, 1, text.n - 1) : text;
    if (scale > 0) {
        if ((zend_long)digits.n <= scale) {
            digits = fmt("%S%S", str_repeat("0", (size_t)(scale - (zend_long)digits.n + 1)), digits);
        }
        digits = fmt("%S.%S", str_sub(digits, 0, digits.n - (size_t)scale), str_sub(digits, digits.n - (size_t)scale, (size_t)scale));
    }
    return negative ? fmt("-%S", digits) : digits;
}

static str first_word(str line)
{
    ssize_t space = str_find(line, " ", 0);
    return space < 0 ? line : str_sub(line, 0, (size_t)space);
}

/* 줄의 객체: kind, table, name */
typedef struct {
    str kind, table, name;
} object;

typedef struct {
    strs lines;
    VEC(object) objects; /* objects.v[k]는 줄 번호 k의 객체, kind가 비면 객체가 없는 줄 */
} written;

static void add_line(written *w, str line, const char *kind, str table, str name)
{
    PUSH(w->lines, line);
    while (w->objects.n < w->lines.n) {
        PUSH(w->objects, ((object){SNULL, SNULL, SNULL}));
    }
    PUSH(w->objects, ((object){str_c(kind), table, name}));
}

static int cmp_itable(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(itable *const *)a)->name, (*(itable *const *)b)->name);
}

/* table을 이름 순으로 쓴 dbspec text와 줄마다 그 객체다. 닫는 괄호와 primary key 줄은 table에 속한다. */
static written catalog_text(catalog *c, str name)
{
    VEC(itable *) tables = {0};
    for (size_t i = 0; i < c->tables.n; i++) {
        PUSH(tables, c->tables.v[i]);
    }
    dbs_sort(tables.v, tables.n, sizeof(itable *), cmp_itable, NULL);
    written w = {0};
    PUSH(w.lines, fmt("dbspec 1 %S", name));
    PUSH(w.objects, ((object){SNULL, SNULL, SNULL})); /* 줄 번호 0 */
    PUSH(w.objects, ((object){SNULL, SNULL, SNULL})); /* header 줄 1 */
    for (size_t i = 0; i < tables.n; i++) {
        itable *t = tables.v[i];
        PUSH(w.lines, SL(""));
        add_line(&w, fmt("table %S {", t->name), "table", t->name, t->name);
        for (size_t k = 0; k < t->columns.n; k++) {
            icolumn *col = &t->columns.v[k];
            sbuf b = {0};
            sb_fmt(&b, "  %S %S", col->name, ctype_text(col->type));
            if (col->null) {
                sb_c(&b, " null");
            }
            if (col->identity) {
                sb_c(&b, " identity");
            }
            if (col->def.n > 0) {
                sb_fmt(&b, " default %S", col->def);
            }
            add_line(&w, sb_str(&b), "column", t->name, col->name);
        }
        add_line(&w, fmt("  primary key (%S)", strs_join(&t->primary, ", ")), "table", t->name, t->name);
        for (size_t k = 0; k < t->uniques.n; k++) {
            add_line(&w, fmt("  unique %S (%S)", t->uniques.v[k].name, strs_join(&t->uniques.v[k].columns, ", ")), "unique", t->name, t->uniques.v[k].name);
        }
        for (size_t k = 0; k < t->indexes.n; k++) {
            ikey *x = &t->indexes.v[k];
            strs cols = {0};
            for (size_t m = 0; m < x->columns.n; m++) {
                PUSH(cols, m < x->desc.n && x->desc.v[m] ? fmt("%S desc", x->columns.v[m]) : x->columns.v[m]);
            }
            add_line(&w, fmt("  index %S (%S)", x->name, strs_join(&cols, ", ")), "index", t->name, x->name);
        }
        for (size_t k = 0; k < t->fks.n; k++) {
            ifkey *f = &t->fks.v[k];
            add_line(&w, fmt("  foreign key %S (%S) references %S (%S) on delete %S on update %S", f->name, strs_join(&f->columns, ", "), f->table,
                strs_join(&f->refs, ", "), f->on_delete, f->on_update), "foreign_key", t->name, f->name);
        }
        for (size_t k = 0; k < t->checks.n; k++) {
            add_line(&w, fmt("  check %S (%S)", t->checks.v[k].name, t->checks.v[k].predicate), "check", t->name, t->checks.v[k].name);
        }
        if (t->settings.n > 0) {
            add_line(&w, SL("  settings {"), "table", t->name, t->name);
            for (size_t k = 0; k < t->settings.n; k++) {
                add_line(&w, fmt("    %S", t->settings.v[k]), "trigger", t->name, first_word(t->settings.v[k]));
            }
            add_line(&w, SL("  }"), "table", t->name, t->name);
        }
        add_line(&w, SL("}"), "table", t->name, t->name);
    }
    return w;
}

/* primary key가 없는 table을 뺀다. 그 table을 참조하던 foreign key는 parse가 거부해 빠진다. */
static void drop_tables_without_key(catalog *c)
{
    size_t k = 0;
    for (size_t i = 0; i < c->tables.n; i++) {
        itable *t = c->tables.v[i];
        if (t->primary.n == 0) {
            catalog_report(c, SL("table"), t->name, t->name, SL("the table has no primary key"));
            continue;
        }
        c->tables.v[k++] = t;
    }
    c->tables.n = k;
}

#define WITHOUT(list, field, value) do { \
        size_t k_ = 0; \
        for (size_t i_ = 0; i_ < (list).n; i_++) { \
            if (!str_eq((list).v[i_].field, (value))) (list).v[k_++] = (list).v[i_]; \
        } \
        (list).n = k_; \
    } while (0)

/* 객체 하나를 뺀다. table이나 primary key를 빼면 table 전체가 빠진다. */
static void remove_object(catalog *c, object o)
{
    itable *t = catalog_table(c, o.table);
    if (str_eqc(o.kind, "table")) {
        size_t k = 0;
        for (size_t i = 0; i < c->tables.n; i++) {
            if (c->tables.v[i] != t) {
                c->tables.v[k++] = c->tables.v[i];
            }
        }
        c->tables.n = k;
        return;
    }
    if (t == NULL) {
        return;
    }
    if (str_eqc(o.kind, "column")) {
        WITHOUT(t->columns, name, o.name);
    } else if (str_eqc(o.kind, "unique")) {
        WITHOUT(t->uniques, name, o.name);
    } else if (str_eqc(o.kind, "index")) {
        WITHOUT(t->indexes, name, o.name);
    } else if (str_eqc(o.kind, "foreign_key")) {
        WITHOUT(t->fks, name, o.name);
    } else if (str_eqc(o.kind, "check")) {
        WITHOUT(t->checks, name, o.name);
    } else if (str_eqc(o.kind, "trigger")) {
        size_t k = 0;
        for (size_t i = 0; i < t->settings.n; i++) {
            if (!str_eq(first_word(t->settings.v[i]), o.name)) {
                t->settings.v[k++] = t->settings.v[i];
            }
        }
        t->settings.n = k;
    }
}

static str packed(object o)
{
    sbuf b = {0};
    sb_s(&b, o.kind);
    sb_ch(&b, '\0');
    sb_s(&b, o.table);
    sb_ch(&b, '\0');
    sb_s(&b, o.name);
    return sb_str(&b);
}

static int cmp_unsupported(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const unsupported *x = a, *y = b;
    object ox = {x->table, x->kind, x->name}, oy = {y->table, y->kind, y->name};
    return str_cmp(packed(ox), packed(oy));
}

document *catalog_document(catalog *c, str name, unsupportedv *out)
{
    drop_tables_without_key(c);
    for (;;) {
        written w = catalog_text(c, name);
        sbuf b = {0};
        for (size_t i = 0; i < w.lines.n; i++) {
            sb_s(&b, w.lines.v[i]);
            sb_ch(&b, '\n');
        }
        str text = sb_str(&b);
        smap none = {0};
        diags found = {0};
        document *d = dbs_parse(text, &none, &found);
        if (d != NULL) {
            unsupportedv sorted = {0};
            for (size_t i = 0; i < c->unsupported.n; i++) {
                PUSH(sorted, c->unsupported.v[i]);
            }
            dbs_sort(sorted.v, sorted.n, sizeof(unsupported), cmp_unsupported, NULL);
            *out = sorted;
            return d;
        }
        /* 거부된 table의 객체는 table과 함께 빠지므로 따로 보고하지 않는다. */
        smap rejected = {0};
        for (size_t i = 0; i < found.n; i++) {
            zend_long line = found.v[i].line;
            if (line < 0 || (size_t)line >= w.objects.n || w.objects.v[line].kind.s == NULL) {
                sbuf all = {0};
                for (size_t k = 0; k < found.n; k++) {
                    if (k > 0) {
                        sb_ch(&all, '\n');
                    }
                    sb_fmt(&all, "%d:%d %S %S", found.v[k].line, found.v[k].column, found.v[k].rule, found.v[k].message);
                }
                dbs_throw(spl_ce_RuntimeException, fmt("Introspected document does not parse:\n%S\n%S", sb_str(&all), text));
                return NULL;
            }
            object o = w.objects.v[line];
            if (str_eqc(o.kind, "table")) {
                smap_set(&rejected, o.table, TRUEP);
            }
        }
        smap removed = {0};
        for (size_t i = 0; i < found.n; i++) {
            object o = w.objects.v[found.v[i].line];
            if (!str_eqc(o.kind, "table") && smap_has(&rejected, o.table)) {
                continue;
            }
            str key = packed(o);
            if (!smap_has(&removed, key)) {
                smap_set(&removed, key, TRUEP);
                catalog_report(c, o.kind, o.table, o.name, fmt("%S: %S", found.v[i].rule, found.v[i].message));
                remove_object(c, o);
            }
        }
    }
}
