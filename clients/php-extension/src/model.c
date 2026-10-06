/* dbspec 문서 model의 생성과 그 값 메서드(PHP client의 ColumnType, Setting, ForeignKey)다. */
#include "dbspec.h"

const char *const dbs_reserved[] = {
    "dbspec", "use", "table", "diagram", "primary", "unique", "index", "foreign", "check", "settings", "null",
    "identity", "default", "true", "false", "and", "or", "not", "in", "between", "is", NULL,
};

static bool reserved(str name)
{
    for (int i = 0; dbs_reserved[i] != NULL; i++) {
        if (str_eqc(name, dbs_reserved[i])) {
            return true;
        }
    }
    return false;
}

/* [a-z][a-z0-9_]* 이고 예약어가 아니며 63 byte 이하다. */
bool dbs_valid_name(str name)
{
    if (name.n == 0 || name.n > 63 || name.s[0] < 'a' || name.s[0] > 'z') {
        return false;
    }
    for (size_t i = 1; i < name.n; i++) {
        char c = name.s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) {
            return false;
        }
    }
    return !reserved(name);
}

ctype *ctype_new(str name, const zend_long *p, size_t np)
{
    ctype *t = dbs_alloc(sizeof *t);
    t->name = name;
    t->np = np;
    /* 사용자가 만든 type은 parameter가 모자랄 수 있으므로 두 칸은 언제나 있다(값 0). */
    t->p = dbs_alloc((np + 2) * sizeof(zend_long));
    for (size_t i = 0; i < np; i++) {
        t->p[i] = p[i];
    }
    return t;
}

str ctype_text(const ctype *t)
{
    if (t->np == 0) {
        return t->name;
    }
    sbuf b = {0};
    sb_s(&b, t->name);
    sb_ch(&b, '(');
    for (size_t i = 0; i < t->np; i++) {
        if (i > 0) {
            sb_ch(&b, ',');
        }
        sb_long(&b, t->p[i]);
    }
    sb_ch(&b, ')');
    return sb_str(&b);
}

bool ctype_integer(const ctype *t)
{
    return str_eqc(t->name, "i16") || str_eqc(t->name, "i32") || str_eqc(t->name, "i64");
}

bool ctype_same(const ctype *a, const ctype *b)
{
    if (!str_eq(a->name, b->name) || a->np != b->np) {
        return false;
    }
    for (size_t i = 0; i < a->np; i++) {
        if (a->p[i] != b->p[i]) {
            return false;
        }
    }
    return true;
}

column *column_new(str name, ctype *type, bool nullable, bool identity, const str *def)
{
    column *c = dbs_alloc(sizeof *c);
    c->name = name;
    c->type = type;
    c->nullable = nullable;
    c->identity = identity;
    if (def != NULL) {
        c->has_default = true;
        c->def = *def;
    }
    return c;
}

column *table_column(const table *t, str name)
{
    for (size_t i = 0; i < t->columns.n; i++) {
        if (str_eq(t->columns.v[i]->name, name)) {
            return t->columns.v[i];
        }
    }
    return NULL;
}

document *document_new(str name)
{
    document *d = dbs_alloc(sizeof *d);
    d->name = name;
    return d;
}

table *table_new(str name)
{
    table *t = dbs_alloc(sizeof *t);
    t->name = name;
    return t;
}

/* audit trigger가 column을 복사하는지: audit column은 언제나, exclude 목록의 column은 언제나 아니며,
 * include 목록이 있으면 그 column만 복사한다. */
bool setting_records(const setting *s, str column)
{
    if (s->args.n > 1 && str_eq(column, s->args.v[1])) {
        return true;
    }
    if (s->exclude != NULL) {
        return !strs_has(s->exclude, column);
    }
    if (s->include != NULL) {
        return strs_has(s->include, column);
    }
    return true;
}

strs setting_excluded(const setting *s, const table *t)
{
    strs out = {0};
    for (size_t i = 0; i < t->columns.n; i++) {
        if (!setting_records(s, t->columns.v[i]->name)) {
            PUSH(out, t->columns.v[i]->name);
        }
    }
    return out;
}

str setting_audit_line(const setting *s, const char *list, const strs *columns)
{
    str line = fmt("audit into %S column %S references %S action %S previous %S", s->args.v[0], s->args.v[1], s->args.v[2],
        s->args.v[3], s->args.v[4]);
    if (columns == NULL || columns->n == 0) {
        return line;
    }
    return fmt("%S %s (%S)", line, list, strs_join(columns, ", "));
}

bool fkey_changes_child_rows(const fkey *f)
{
    return !str_eqc(f->on_delete, "restrict") || !str_eqc(f->on_update, "restrict");
}
