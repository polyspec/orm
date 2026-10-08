/*
 * plan 문서를 읽고 쓰며(PlanText), chain으로 잇고(PlanChain), source에서 target까지의 diff를 만들고(PlanDiff,
 * PlanObjects), schema text를 비교한다(SchemaComparison). 문서 집합과 database의 비교(externalDifferences,
 * installedDifferences, addTablesAndColumnsSteps)도 여기 있다. 모두 PHP client(packages/orm-php/src/Dbspec)의 사양이다.
 */
#include "dbspec.h"
#include "plandiff.h"

static diag plan_diag(zend_long line, str message)
{
    return mkdiag(SL("plan"), line, 1, message);
}

str *str_ptr(str s)
{
    str *p = dbs_alloc(sizeof *p);
    *p = s;
    return p;
}

/* ------------------------------------------------------------- plan text */

static bool name_char(char c, bool first)
{
    return (c >= 'a' && c <= 'z') || (!first && ((c >= '0' && c <= '9') || c == '_'));
}

/* s의 i에서 [a-z][a-z0-9_]*를 읽는다. */
static bool read_name(str s, size_t *i, str *out)
{
    size_t start = *i;
    if (start >= s.n || !name_char(s.s[start], true)) {
        return false;
    }
    size_t j = start + 1;
    while (j < s.n && name_char(s.s[j], false)) {
        j++;
    }
    *out = str_sub(s, start, j - start);
    *i = j;
    return true;
}

static bool lit(str s, size_t *i, const char *text)
{
    size_t n = strlen(text);
    if (*i + n > s.n || memcmp(s.s + *i, text, n) != 0) {
        return false;
    }
    *i += n;
    return true;
}

/* 줄 전체가 prefix 뒤 이름들(구분자 sep)인지 읽는다. seps[k]는 k번째 이름 앞의 구분자다. */
static bool names_line(str line, const char *prefix, const char *const *seps, size_t count, str *names)
{
    size_t i = 0;
    if (!lit(line, &i, prefix)) {
        return false;
    }
    for (size_t k = 0; k < count; k++) {
        if (k > 0 && !lit(line, &i, seps[k])) {
            return false;
        }
        if (!read_name(line, &i, &names[k])) {
            return false;
        }
    }
    return i == line.n;
}

static bool reserved_or_long(str n)
{
    if (n.n > 63) {
        return true;
    }
    for (int i = 0; dbs_reserved[i] != NULL; i++) {
        if (str_eqc(n, dbs_reserved[i])) {
            return true;
        }
    }
    return false;
}

static bool names_error(const str *names, size_t count, str *message)
{
    for (size_t i = 0; i < count; i++) {
        if (reserved_or_long(names[i])) {
            *message = fmt("name \"%S\" is reserved or longer than 63 bytes", names[i]);
            return true;
        }
    }
    return false;
}

static plan *plan_fail(diags *out, zend_long line, str message)
{
    PUSH(*out, plan_diag(line, message));
    return NULL;
}

static bool is_hex64(str s)
{
    if (s.n != 64) {
        return false;
    }
    for (size_t i = 0; i < 64; i++) {
        char c = s.s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

/* PCRE의 \s: 공백, \t, \n, \v, \f, \r */
static bool pcre_space(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
}

plan *plan_parse(str text, diags *out)
{
    if (!str_ends(text, "\n")) {
        zend_long lines = 1;
        for (size_t i = 0; i < text.n; i++) {
            lines += text.s[i] == '\n';
        }
        return plan_fail(out, lines, SL("a plan ends with a line end"));
    }
    strs lines = strs_split(str_sub(text, 0, text.n - 1), '\n');
    str head[1];
    if (!names_line(lines.v[0], "dbplan 1 ", NULL, 1, head) || reserved_or_long(head[0])) {
        return plan_fail(out, 1, SL("the first line is exactly `dbplan 1 <name>`"));
    }
    str plan_name = head[0];
    bool has_from = false;
    str from = SNULL;
    bool from_ok = false;
    if (lines.n >= 2) {
        str l = lines.v[1];
        if (str_eqc(l, "from empty")) {
            from_ok = true;
        } else if (str_starts(l, "from sha256:") && is_hex64(str_sub(l, 12, l.n - 12))) {
            from_ok = true;
            has_from = true;
            from = str_sub(l, 5, l.n - 5);
        }
    }
    if (!from_ok) {
        return plan_fail(out, 2, SL("the second line is `from empty` or `from <schemaHash>`"));
    }
    trenamev rt = {0};
    crenamev rc = {0};
    strs dt = {0};
    cnamev dc = {0};
    smap seen = {0}, given = {0};
    size_t i = 2;
    for (; i < lines.n && lines.v[i].n > 0; i++) {
        str line = lines.v[i];
        zend_long n = (zend_long)i + 1;
        zend_long *earlier = smap_get(&seen, line);
        if (earlier != NULL) {
            return plan_fail(out, n, fmt("line %d repeats this line", *earlier));
        }
        zend_long *at = dbs_alloc(sizeof *at);
        *at = n;
        smap_set(&seen, line, at);
        str r[3];
        str message;
        static const char *const rt_seps[] = {NULL, " "};
        static const char *const rc_seps[] = {NULL, ".", " "};
        static const char *const dc_seps[] = {NULL, "."};
        if (names_line(line, "rename table ", rt_seps, 2, r)) {
            if (names_error(r, 2, &message)) {
                return plan_fail(out, n, message);
            }
            str key = fmt("table %S", r[1]);
            zend_long *g = smap_get(&given, key);
            if (g != NULL) {
                return plan_fail(out, n, fmt("line %d renames another table to %S", *g, r[1]));
            }
            smap_set(&given, key, at);
            PUSH(rt, ((trename){r[0], r[1]}));
        } else if (names_line(line, "rename column ", rc_seps, 3, r)) {
            if (names_error(r, 3, &message)) {
                return plan_fail(out, n, message);
            }
            str key = fmt("column %S.%S", r[0], r[2]);
            zend_long *g = smap_get(&given, key);
            if (g != NULL) {
                return plan_fail(out, n, fmt("line %d renames another column to %S.%S", *g, r[0], r[2]));
            }
            smap_set(&given, key, at);
            PUSH(rc, ((crename){r[0], r[1], r[2]}));
        } else if (names_line(line, "allow drop table ", NULL, 1, r)) {
            if (names_error(r, 1, &message)) {
                return plan_fail(out, n, message);
            }
            PUSH(dt, r[0]);
        } else if (names_line(line, "allow drop column ", dc_seps, 2, r)) {
            if (names_error(r, 2, &message)) {
                return plan_fail(out, n, message);
            }
            PUSH(dc, ((cname){r[0], r[1]}));
        } else {
            return plan_fail(out, n, SL("a header line is `rename table`, `rename column`, `allow drop table` or `allow drop column`"));
        }
    }
    if (i >= lines.n) {
        return plan_fail(out, (zend_long)i + 1, SL("a blank line and the target schema text follow the header"));
    }
    size_t offset = i + 1;
    /* plan은 database 전체를 하나의 schema로 옮긴다. 외부 문서를 쓰는 set의 table은 install과 addTablesAndColumns가 만든다. */
    for (size_t k = offset; k < lines.n; k++) {
        str l = lines.v[k];
        if (str_starts(l, "use ")) {
            size_t a = 3;
            while (a < l.n && pcre_space(l.s[a])) {
                a++;
            }
            size_t b = a;
            while (b < l.n && !pcre_space(l.s[b])) {
                b++;
            }
            return plan_fail(out, (zend_long)k + 1, fmt("a plan targets a whole database, and its target uses the external document %S: install a set that uses external documents with install or addTablesAndColumns",
                str_sub(l, a, b - a)));
        }
    }
    sbuf b = {0};
    for (size_t k = offset; k < lines.n; k++) {
        if (k > offset) {
            sb_ch(&b, '\n');
        }
        sb_s(&b, lines.v[k]);
    }
    sb_ch(&b, '\n');
    str schema_text = sb_str(&b);
    smap none = {0};
    diags found = {0};
    document *d = dbs_parse(schema_text, &none, &found);
    if (d == NULL) {
        /* target diagnostic은 plan 안의 위치로 옮긴다. */
        for (size_t k = 0; k < found.n; k++) {
            diag x = found.v[k];
            x.line += (zend_long)offset;
            PUSH(*out, x);
        }
        return NULL;
    }
    if (!is_schema_text(d) || !str_eq(dbs_emit(d, VIEW_CANONICAL), schema_text)) {
        return plan_fail(out, (zend_long)offset + 1, SL("the target is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings"));
    }
    return plan_to(plan_name, has_from, from, rt, rc, dt, dc, d, schema_text, out);
}

plan *plan_to(str name, bool has_from, str from, trenamev rt, crenamev rc, strs dt, cnamev dc, document *schema, str schema_text, diags *out)
{
    str to = dbs_sha256(schema_text);
    if (has_from && str_eq(to, from)) {
        return plan_fail(out, 2, SL("the plan starts from its own target schema"));
    }
    plan *p = dbs_alloc(sizeof *p);
    p->name = name;
    p->has_from = has_from;
    p->from = from;
    p->rename_tables = rt;
    p->rename_columns = rc;
    p->drop_tables = dt;
    p->drop_columns = dc;
    p->schema = schema;
    p->to = to;
    return p;
}

static int cmp_trename(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp(((const trename *)a)->old, ((const trename *)b)->old);
}

static int cmp_crename(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const crename *x = a, *y = b;
    return str_cmp(fmt("%S.%S", x->table, x->old), fmt("%S.%S", y->table, y->old));
}

static int cmp_cname(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const cname *x = a, *y = b;
    return str_cmp(fmt("%S.%S", x->table, x->name), fmt("%S.%S", y->table, y->name));
}

trenamev sorted_trenames(const trenamev *l)
{
    trenamev out = {0};
    for (size_t i = 0; i < l->n; i++) PUSH(out, l->v[i]);
    dbs_sort(out.v, out.n, sizeof(trename), cmp_trename, NULL);
    return out;
}

crenamev sorted_crenames(const crenamev *l)
{
    crenamev out = {0};
    for (size_t i = 0; i < l->n; i++) PUSH(out, l->v[i]);
    dbs_sort(out.v, out.n, sizeof(crename), cmp_crename, NULL);
    return out;
}

str plan_emit(const plan *p)
{
    sbuf b = {0};
    sb_fmt(&b, "dbplan 1 %S\nfrom %S\n", p->name, p->has_from ? p->from : SL("empty"));
    trenamev rt = sorted_trenames(&p->rename_tables);
    for (size_t i = 0; i < rt.n; i++) {
        sb_fmt(&b, "rename table %S %S\n", rt.v[i].old, rt.v[i].new_);
    }
    crenamev rc = sorted_crenames(&p->rename_columns);
    for (size_t i = 0; i < rc.n; i++) {
        sb_fmt(&b, "rename column %S.%S %S\n", rc.v[i].table, rc.v[i].old, rc.v[i].new_);
    }
    strs dt = strs_copy(&p->drop_tables);
    strs_sort(&dt);
    for (size_t i = 0; i < dt.n; i++) {
        sb_fmt(&b, "allow drop table %S\n", dt.v[i]);
    }
    cnamev dc = {0};
    for (size_t i = 0; i < p->drop_columns.n; i++) PUSH(dc, p->drop_columns.v[i]);
    dbs_sort(dc.v, dc.n, sizeof(cname), cmp_cname, NULL);
    for (size_t i = 0; i < dc.n; i++) {
        sb_fmt(&b, "allow drop column %S.%S\n", dc.v[i].table, dc.v[i].name);
    }
    sb_ch(&b, '\n');
    sb_s(&b, dbs_emit(p->schema, VIEW_CANONICAL));
    return sb_str(&b);
}

str effect_text(const effect *e)
{
    if (str_eqc(e->kind, "repeat")) {
        return SL("repeat");
    }
    sbuf b = {0};
    sb_fmt(&b, "%s %S", e->present ? "present" : "absent", e->kind);
    if (e->table.n > 0) {
        sb_fmt(&b, " %S", e->table);
    }
    if (e->name.n > 0) {
        sb_fmt(&b, " %S", e->name);
    }
    return sb_str(&b);
}

/* ----------------------------------------------------------------- chain */

static diag chain_diag(str message)
{
    return mkdiag(SL("chain"), 1, 1, message);
}

bool plan_chain(const planv *plans, planv *out, diags *d)
{
    *out = (planv){0};
    /* plan이 없으면 table이 없는 database의 빈 chain이다. */
    if (plans->n == 0) {
        return true;
    }
    /* from이 없는 plan은 ''에 모은다. schemaHash는 비어 있지 않다. */
    smap by_from = {0}; /* from => VEC(size_t)* (plans의 index) */
    typedef VEC(size_t) idxv;
    for (size_t i = 0; i < plans->n; i++) {
        str key = plans->v[i]->has_from ? plans->v[i]->from : SL("");
        idxv *list = smap_get(&by_from, key);
        if (list == NULL) {
            list = dbs_alloc(sizeof *list);
            smap_set(&by_from, key, list);
        }
        PUSH(*list, i);
    }
    strs froms = {0};
    smap_keys_sorted(&by_from, &froms);
    size_t before = d->n;
    for (size_t k = 0; k < froms.n; k++) {
        idxv *list = smap_get(&by_from, froms.v[k]);
        if (list->n > 1) {
            strs names = {0};
            for (size_t i = 0; i < list->n; i++) {
                PUSH(names, plans->v[list->v[i]]->name);
            }
            strs_sort(&names);
            PUSH(*d, chain_diag(fmt("plans %S start from the same schema", strs_join(&names, ", "))));
        }
    }
    if (!smap_has(&by_from, SL(""))) {
        PUSH(*d, chain_diag(SL("no plan starts from empty")));
    }
    if (d->n != before) {
        return false;
    }
    bool *visited = dbs_alloc(plans->n + 1);
    idxv *start = smap_get(&by_from, SL(""));
    ssize_t at = (ssize_t)start->v[0];
    while (at >= 0) {
        const plan *p = plans->v[at];
        if (visited[at]) {
            *out = (planv){0};
            PUSH(*d, chain_diag(fmt("plan %S closes a cycle", p->name)));
            return false;
        }
        visited[at] = true;
        PUSH(*out, plans->v[at]);
        idxv *next = smap_get(&by_from, p->to);
        at = next == NULL ? -1 : (ssize_t)next->v[0];
    }
    strs unreached = {0};
    for (size_t i = 0; i < plans->n; i++) {
        if (!visited[i]) {
            PUSH(unreached, plans->v[i]->name);
        }
    }
    if (unreached.n > 0) {
        *out = (planv){0};
        strs_sort(&unreached);
        PUSH(*d, chain_diag(fmt("no chain reaches plans %S", strs_join(&unreached, ", "))));
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------ diff */

static diag diff_error(str message)
{
    return mkdiag(SL("plan"), 1, 1, message);
}

column *diff_column(const table *t, str name)
{
    return table_column(t, name);
}

/* 세 database에서 모든 값을 지키는 type 변경인지 알린다. */
bool type_widens(const ctype *from, const ctype *to)
{
    const zend_long *f = from->p, *t = to->p;
    if (str_eqc(from->name, "i16")) {
        return str_eqc(to->name, "i32") || str_eqc(to->name, "i64");
    }
    if (str_eqc(from->name, "i32")) {
        return str_eqc(to->name, "i64");
    }
    if (str_eqc(from->name, "varchar")) {
        return (str_eqc(to->name, "varchar") && t[0] >= f[0]) || str_eqc(to->name, "text");
    }
    if (str_eqc(from->name, "decimal")) {
        return str_eqc(to->name, "decimal") && t[1] == f[1] && t[0] >= f[0];
    }
    if (str_eqc(from->name, "time") || str_eqc(from->name, "datetime")) {
        return str_eq(to->name, from->name) && t[0] >= f[0];
    }
    return false;
}

bool table_has_triggers(const table *t)
{
    if (t->settings == NULL) {
        return false;
    }
    for (size_t i = 0; i < t->settings->list.n; i++) {
        str k = t->settings->list.v[i]->kind;
        if (str_eqc(k, "immutable") || str_eqc(k, "audit")) {
            return true;
        }
    }
    return false;
}

static strs *strs_at(smap *m, str key)
{
    strs *l = smap_get(m, key);
    if (l == NULL) {
        l = dbs_alloc(sizeof *l);
        smap_set(m, key, l);
    }
    return l;
}

static objrefv *refs_at(smap *m, str key)
{
    objrefv *l = smap_get(m, key);
    if (l == NULL) {
        l = dbs_alloc(sizeof *l);
        smap_set(m, key, l);
    }
    return l;
}

static smap *map_at(smap *m, str key)
{
    smap *l = smap_get(m, key);
    if (l == NULL) {
        l = dbs_alloc(sizeof *l);
        smap_set(m, key, l);
    }
    return l;
}

static str lookup(const smap *m, str key, str otherwise)
{
    str *v = m == NULL ? NULL : smap_get(m, key);
    return v == NULL ? otherwise : *v;
}

/* --------------------------------------------------------------- objects */

static const char *const check_keywords[] = {"and", "or", "not", "in", "between", "is", "null", "true", "false", NULL};

/* `'(?:[^']|'')*'`가 i에서 맞는 길이(되돌아가는 반복), 없으면 0이다. */
size_t quoted_length(str s, size_t i)
{
    size_t j = i + 1;
    ssize_t last_pair = -1;
    for (;;) {
        if (j < s.n && s.s[j] != '\'') {
            j++;
        } else if (j + 1 < s.n && s.s[j] == '\'' && s.s[j + 1] == '\'') {
            last_pair = (ssize_t)j;
            j += 2;
        } else {
            break;
        }
    }
    if (j < s.n) {
        return j + 1 - i;
    }
    if (last_pair >= 0) {
        return (size_t)last_pair + 1 - i;
    }
    return 0;
}

static bool is_check_column(str t)
{
    if (t.n == 0 || t.s[0] < 'a' || t.s[0] > 'z') {
        return false;
    }
    for (size_t i = 1; i < t.n; i++) {
        char c = t.s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) {
            return false;
        }
    }
    for (int i = 0; check_keywords[i] != NULL; i++) {
        if (str_eqc(t, check_keywords[i])) {
            return false;
        }
    }
    return true;
}

static bool wordc(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

/* canonical check text의 token: `'(?:[^']|'')*'|[A-Za-z0-9_]+|.`(/s, byte 단위) */
static strs check_tokens(str e)
{
    strs out = {0};
    size_t i = 0;
    while (i < e.n) {
        size_t len = 0;
        if (e.s[i] == '\'') {
            len = quoted_length(e, i);
        }
        if (len == 0 && wordc(e.s[i])) {
            size_t j = i;
            while (j < e.n && wordc(e.s[j])) {
                j++;
            }
            len = j - i;
        }
        if (len == 0) {
            len = 1;
        }
        PUSH(out, str_sub(e, i, len));
        i += len;
    }
    return out;
}

/* column 이름을 f로 바꾼 canonical check text다. */
str check_text_renamed(str expression, str (*f)(void *, str), void *ctx)
{
    strs t = check_tokens(expression);
    sbuf b = {0};
    for (size_t i = 0; i < t.n; i++) {
        sb_s(&b, is_check_column(t.v[i]) ? f(ctx, t.v[i]) : t.v[i]);
    }
    return sb_str(&b);
}

static strs check_columns(str expression)
{
    strs t = check_tokens(expression), out = {0};
    for (size_t i = 0; i < t.n; i++) {
        if (is_check_column(t.v[i])) {
            PUSH(out, t.v[i]);
        }
    }
    return out;
}

static ukey *named_ukey(const ukeyv *items, str name)
{
    for (size_t i = 0; i < items->n; i++) if (str_eq(items->v[i]->name, name)) return items->v[i];
    return NULL;
}
static xindex *named_index(const indexv *items, str name)
{
    for (size_t i = 0; i < items->n; i++) if (str_eq(items->v[i]->name, name)) return items->v[i];
    return NULL;
}
static fkey *named_fkey(const fkeyv *items, str name)
{
    for (size_t i = 0; i < items->n; i++) if (str_eq(items->v[i]->name, name)) return items->v[i];
    return NULL;
}
static check *named_check(const checkv *items, str name)
{
    for (size_t i = 0; i < items->n; i++) if (str_eq(items->v[i]->name, name)) return items->v[i];
    return NULL;
}

ukey *find_ukey(const table *t, str name) { return named_ukey(&t->uniques, name); }
xindex *find_index(const table *t, str name) { return named_index(&t->indexes, name); }
fkey *find_fkey(const table *t, str name) { return named_fkey(&t->fks, name); }
check *find_check(const table *t, str name) { return named_check(&t->checks, name); }

typedef struct {
    const pdiff *d;
    str target;   /* column rename을 적용할 target table */
} renamer;

static str rename_column(void *ctx, str c)
{
    renamer *r = ctx;
    return lookup(smap_get(&r->d->renamed_column, r->target), c, c);
}

static str same_name(void *ctx, str c)
{
    (void)ctx;
    return c;
}

str index_def(const xindex *x, str (*f)(void *, str), void *ctx)
{
    sbuf b = {0};
    for (size_t i = 0; i < x->columns.n; i++) {
        sb_s(&b, f(ctx, x->columns.v[i].name));
        if (x->columns.v[i].descending) {
            sb_c(&b, " desc");
        }
        sb_ch(&b, ',');
    }
    return sb_str(&b);
}

str fkey_def(const strs *cols, str parent, const strs *refs, const fkey *f)
{
    return fmt("%S>%S(%S)%S/%S", strs_join(cols, ","), parent, strs_join(refs, ","), f->on_delete, f->on_update);
}

static strs mapped(const strs *l, str (*f)(void *, str), void *ctx)
{
    strs out = {0};
    for (size_t i = 0; i < l->n; i++) {
        PUSH(out, f(ctx, l->v[i]));
    }
    return out;
}

/* source foreign key를 target 이름으로 읽은 column, parent, 참조 column이다. */
static void source_fkey(const pdiff *d, str name, const fkey *f, strs *cols, str *parent, strs *refs)
{
    renamer child = {d, name};
    *cols = mapped(&f->columns, rename_column, &child);
    *parent = lookup(&d->renamed_from, f->table, f->table);
    renamer up = {d, *parent};
    *refs = mapped(&f->refs, rename_column, &up);
}

static bool forced_fk(const smap *altered_column, const smap *dropped_keys, str name, const strs *cols, str parent, const strs *refs)
{
    for (size_t i = 0; i < cols->n; i++) {
        if (smap_has(altered_column, fmt("%S.%S", name, cols->v[i]))) {
            return true;
        }
    }
    for (size_t i = 0; i < refs->n; i++) {
        if (smap_has(altered_column, fmt("%S.%S", parent, refs->v[i]))) {
            return true;
        }
    }
    str prefix = fmt("%S,", strs_join(cols, ","));
    SMAP_EACH(dropped_keys, k) {
        str key = fmt("%S,", dropped_keys->e[k].key);
        if (key.n >= prefix.n && memcmp(key.s, prefix.s, prefix.n) == 0) {
            return true;
        }
    }
    return false;
}

static bool forced_check(const smap *renamed_col, const smap *altered_column, str name, const check *k)
{
    strs cols = check_columns(k->expression);
    for (size_t i = 0; i < cols.n; i++) {
        str key = fmt("%S.%S", name, cols.v[i]);
        if (smap_has(renamed_col, key) || smap_has(altered_column, key)) {
            return true;
        }
    }
    return false;
}

/* strcmp("kind\0name", ...)의 순서다. */
static str joined0(str a, str b)
{
    sbuf s = {0};
    sb_s(&s, a);
    sb_ch(&s, '\0');
    sb_s(&s, b);
    return sb_str(&s);
}

static int cmp_objref(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const objref *x = a, *y = b;
    return str_cmp(joined0(x->kind, x->name), joined0(y->kind, y->name));
}

static void push_ref(smap *m, str table, const char *kind, str name)
{
    PUSH(*refs_at(m, table), ((objref){str_c(kind), name}));
}

static void compare_objects(pdiff *d)
{
    smap altered_column = {0}, renamed_col = {0};
    SMAP_EACH(&d->altered, i) {
        strs *cols = d->altered.e[i].val;
        for (size_t k = 0; k < cols->n; k++) {
            smap_set(&altered_column, fmt("%S.%S", d->altered.e[i].key, cols->v[k]), TRUEP);
        }
    }
    SMAP_EACH(&d->renamed_column, i) {
        smap *m = d->renamed_column.e[i].val;
        SMAP_EACH(m, k) {
            smap_set(&renamed_col, fmt("%S.%S", d->renamed_column.e[i].key, *(str *)m->e[k].val), TRUEP);
        }
    }
    for (size_t mi = 0; mi < d->matched.n; mi++) {
        str name = d->matched.v[mi];
        const table *src = smap_get(&d->source, lookup(&d->table_of, name, name));
        const table *tgt = smap_get(&d->target, name);
        renamer ren = {d, name};
        smap dropped_keys = {0};
        for (size_t i = 0; i < src->uniques.n; i++) {
            const ukey *u = src->uniques.v[i];
            strs cols = mapped(&u->columns, rename_column, &ren);
            str def = strs_join(&cols, ",");
            const ukey *t = named_ukey(&tgt->uniques, u->name);
            if (t == NULL || !str_eq(strs_join(&t->columns, ","), def)) {
                push_ref(&d->drop_objects, src->name, "unique", u->name);
                smap_set(&dropped_keys, def, TRUEP);
            }
        }
        for (size_t i = 0; i < tgt->uniques.n; i++) {
            const ukey *u = tgt->uniques.v[i];
            const ukey *s = named_ukey(&src->uniques, u->name);
            strs cols = s == NULL ? (strs){0} : mapped(&s->columns, rename_column, &ren);
            if (s == NULL || !str_eq(strs_join(&cols, ","), strs_join(&u->columns, ","))) {
                push_ref(&d->add_objects, name, "unique", u->name);
            }
        }
        for (size_t i = 0; i < src->indexes.n; i++) {
            const xindex *x = src->indexes.v[i];
            const xindex *t = named_index(&tgt->indexes, x->name);
            if (t == NULL || !str_eq(index_def(x, rename_column, &ren), index_def(t, same_name, NULL))) {
                push_ref(&d->drop_objects, src->name, "index", x->name);
                strs names = {0};
                for (size_t k = 0; k < x->columns.n; k++) {
                    PUSH(names, rename_column(&ren, x->columns.v[k].name));
                }
                smap_set(&dropped_keys, strs_join(&names, ","), TRUEP);
            }
        }
        for (size_t i = 0; i < tgt->indexes.n; i++) {
            const xindex *x = tgt->indexes.v[i];
            const xindex *s = named_index(&src->indexes, x->name);
            if (s == NULL || !str_eq(index_def(s, rename_column, &ren), index_def(x, same_name, NULL))) {
                push_ref(&d->add_objects, name, "index", x->name);
            }
        }
        for (size_t i = 0; i < src->fks.n; i++) {
            const fkey *f = src->fks.v[i];
            strs cols, refs;
            str parent;
            source_fkey(d, name, f, &cols, &parent, &refs);
            const fkey *t = named_fkey(&tgt->fks, f->name);
            if (t == NULL || !str_eq(fkey_def(&cols, parent, &refs, f), fkey_def(&t->columns, t->table, &t->refs, t))
                || forced_fk(&altered_column, &dropped_keys, name, &cols, parent, &refs)) {
                push_ref(&d->drop_objects, src->name, "foreign_key", f->name);
            }
        }
        for (size_t i = 0; i < tgt->fks.n; i++) {
            const fkey *f = tgt->fks.v[i];
            const fkey *s = named_fkey(&src->fks, f->name);
            bool keep = false;
            if (s != NULL) {
                strs cols, refs;
                str parent;
                source_fkey(d, name, s, &cols, &parent, &refs);
                keep = str_eq(fkey_def(&cols, parent, &refs, s), fkey_def(&f->columns, f->table, &f->refs, f))
                    && !forced_fk(&altered_column, &dropped_keys, name, &cols, parent, &refs);
            }
            if (!keep) {
                push_ref(&d->add_objects, name, "foreign_key", f->name);
            }
        }
        /* 이름 바뀐 column이나 바뀐 column을 쓰는 check는 다시 만든다. */
        for (size_t i = 0; i < src->checks.n; i++) {
            const check *k = src->checks.v[i];
            const check *t = named_check(&tgt->checks, k->name);
            if (t == NULL || !str_eq(check_text_renamed(k->expression, rename_column, &ren), t->expression)
                || forced_check(&renamed_col, &altered_column, name, t)) {
                push_ref(&d->drop_objects, src->name, "check", k->name);
            }
        }
        for (size_t i = 0; i < tgt->checks.n; i++) {
            const check *k = tgt->checks.v[i];
            const check *s = named_check(&src->checks, k->name);
            if (s == NULL || !str_eq(check_text_renamed(s->expression, rename_column, &ren), k->expression)
                || forced_check(&renamed_col, &altered_column, name, k)) {
                push_ref(&d->add_objects, name, "check", k->name);
            }
        }
    }
    /* 지우는 table 자신의 foreign key는 table과 함께 지운다. */
    for (size_t i = 0; i < d->dropped.n; i++) {
        const table *t = smap_get(&d->source, d->dropped.v[i]);
        for (size_t k = 0; k < t->fks.n; k++) {
            push_ref(&d->drop_objects, d->dropped.v[i], "foreign_key", t->fks.v[k]->name);
        }
    }
    SMAP_EACH(&d->drop_objects, i) {
        objrefv *l = d->drop_objects.e[i].val;
        dbs_sort(l->v, l->n, sizeof(objref), cmp_objref, NULL);
    }
    SMAP_EACH(&d->add_objects, i) {
        objrefv *l = d->add_objects.e[i].val;
        dbs_sort(l->v, l->n, sizeof(objref), cmp_objref, NULL);
    }
}

/* 세 dialect 중 하나에서라도 렌더링한 trigger statement가 다른 table을 표시한다. */
static void trigger_changes(pdiff *d)
{
    for (size_t i = 0; i < d->matched.n; i++) {
        str name = d->matched.v[i];
        const table *src = smap_get(&d->source, lookup(&d->table_of, name, name));
        const table *tgt = smap_get(&d->target, name);
        for (int k = 0; k < 3; k++) {
            renderer r = {0};
            r.d = (dialect)k;
            strs a = r_triggers(&r, src), b = r_triggers(&r, tgt);
            if (!strs_eq(&a, &b)) {
                smap_set(&d->triggers, name, TRUEP);
                break;
            }
        }
    }
}

static void add_change(pdiff *d, str kind, str table, str name)
{
    PUSH(d->changes, ((change){kind, table, name}));
}

static void collect_changes(pdiff *d)
{
    for (size_t i = 0; i < d->matched.n; i++) {
        str name = d->matched.v[i];
        str src = lookup(&d->table_of, name, name);
        if (smap_has(&d->triggers, name) && table_has_triggers(smap_get(&d->source, src))) {
            add_change(d, SL("drop_triggers"), src, SL(""));
        }
    }
    strs keys = {0};
    smap_keys_sorted(&d->drop_objects, &keys);
    for (size_t i = 0; i < keys.n; i++) {
        objrefv *l = smap_get(&d->drop_objects, keys.v[i]);
        for (size_t k = 0; k < l->n; k++) {
            add_change(d, fmt("drop_%S", l->v[k].kind), keys.v[i], l->v[k].name);
        }
    }
    trenamev rt = sorted_trenames(&d->renamed_tables);
    for (size_t i = 0; i < rt.n; i++) {
        add_change(d, SL("rename_table"), rt.v[i].old, rt.v[i].new_);
    }
    crenamev rc = sorted_crenames(&d->renamed_columns);
    for (size_t i = 0; i < rc.n; i++) {
        add_change(d, SL("rename_column"), rc.v[i].table, fmt("%S %S", rc.v[i].old, rc.v[i].new_));
    }
    for (size_t i = 0; i < d->matched.n; i++) {
        strs *removed = smap_get(&d->removed, d->matched.v[i]);
        for (size_t k = 0; removed != NULL && k < removed->n; k++) {
            add_change(d, SL("drop_column"), lookup(&d->table_of, d->matched.v[i], d->matched.v[i]), removed->v[k]);
        }
    }
    for (size_t i = 0; i < d->dropped.n; i++) {
        add_change(d, SL("drop_table"), d->dropped.v[i], SL(""));
    }
    for (size_t i = 0; i < d->created.n; i++) {
        add_change(d, SL("create_table"), d->created.v[i], SL(""));
    }
    for (size_t i = 0; i < d->matched.n; i++) {
        str name = d->matched.v[i];
        strs *added = smap_get(&d->added, name), *altered = smap_get(&d->altered, name);
        for (size_t k = 0; added != NULL && k < added->n; k++) {
            add_change(d, SL("add_column"), name, added->v[k]);
        }
        for (size_t k = 0; altered != NULL && k < altered->n; k++) {
            add_change(d, SL("alter_column"), name, altered->v[k]);
        }
    }
    keys = (strs){0};
    smap_keys_sorted(&d->add_objects, &keys);
    for (size_t i = 0; i < keys.n; i++) {
        objrefv *l = smap_get(&d->add_objects, keys.v[i]);
        for (size_t k = 0; k < l->n; k++) {
            add_change(d, fmt("add_%S", l->v[k].kind), keys.v[i], l->v[k].name);
        }
    }
    for (size_t i = 0; i < d->matched.n; i++) {
        str name = d->matched.v[i];
        if (smap_has(&d->triggers, name) && table_has_triggers(smap_get(&d->target, name))) {
            add_change(d, SL("create_triggers"), name, SL(""));
        }
    }
}

pdiff *pdiff_of(const document *source, const plan *p, diags *out)
{
    bool has = false;
    str from = SNULL;
    if (source != NULL) {
        documentv one = {0};
        PUSH(one, (document *)source);
        manifest m;
        if (!dbs_manifest(&one, &m, out)) {
            return NULL;
        }
        has = true;
        from = m.schema_hash;
    }
    if (has != p->has_from || (has && !str_eq(from, p->from))) {
        PUSH(*out, diff_error(fmt("the plan starts from %S, and the source schema is %S", p->has_from ? p->from : SL("empty"), has ? from : SL("empty"))));
        return NULL;
    }
    pdiff *d = dbs_alloc(sizeof *d);
    for (size_t i = 0; source != NULL && i < source->tables.n; i++) {
        smap_set(&d->source, source->tables.v[i]->name, source->tables.v[i]);
    }
    for (size_t i = 0; i < p->schema->tables.n; i++) {
        smap_set(&d->target, p->schema->tables.v[i]->name, p->schema->tables.v[i]);
    }
    diags errs = {0};
    trenamev rt = sorted_trenames(&p->rename_tables);
    for (size_t i = 0; i < rt.n; i++) {
        trename r = rt.v[i];
        if (!smap_has(&d->source, r.old)) {
            PUSH(errs, diff_error(fmt("rename table %S: the source has no table %S", r.old, r.old)));
        } else if (smap_has(&d->source, r.new_)) {
            PUSH(errs, diff_error(fmt("rename table %S: the source already has a table %S", r.old, r.new_)));
        } else if (!smap_has(&d->target, r.new_)) {
            PUSH(errs, diff_error(fmt("rename table %S: the target has no table %S", r.old, r.new_)));
        } else {
            smap_set(&d->renamed_from, r.old, str_ptr(r.new_));
            PUSH(d->renamed_tables, r);
        }
    }
    strs keys = {0};
    smap_keys_sorted(&d->source, &keys);
    for (size_t i = 0; i < keys.n; i++) {
        str t = lookup(&d->renamed_from, keys.v[i], keys.v[i]);
        if (smap_has(&d->target, t)) {
            smap_set(&d->table_of, t, str_ptr(keys.v[i]));
        } else {
            PUSH(d->dropped, keys.v[i]);
        }
    }
    keys = (strs){0};
    smap_keys_sorted(&d->target, &keys);
    for (size_t i = 0; i < keys.n; i++) {
        if (smap_has(&d->table_of, keys.v[i])) {
            PUSH(d->matched, keys.v[i]);
        } else {
            PUSH(d->created, keys.v[i]);
        }
    }
    smap allowed_tables = {0};
    for (size_t i = 0; i < p->drop_tables.n; i++) {
        str t = p->drop_tables.v[i];
        smap_set(&allowed_tables, t, TRUEP);
        if (!strs_has(&d->dropped, t)) {
            PUSH(errs, diff_error(fmt("allow drop table %S drops nothing", t)));
        }
    }
    for (size_t i = 0; i < d->dropped.n; i++) {
        if (!smap_has(&allowed_tables, d->dropped.v[i])) {
            PUSH(errs, diff_error(fmt("table %S is dropped without allow drop table %S", d->dropped.v[i], d->dropped.v[i])));
        }
    }
    crenamev rc = sorted_crenames(&p->rename_columns);
    for (size_t i = 0; i < rc.n; i++) {
        crename r = rc.v[i];
        str *src = smap_get(&d->table_of, r.table);
        if (src == NULL) {
            PUSH(errs, diff_error(fmt("rename column %S.%S: %S is not a table of both schemas", r.table, r.old, r.table)));
        } else if (table_column(smap_get(&d->source, *src), r.old) == NULL) {
            PUSH(errs, diff_error(fmt("rename column %S.%S: the source table has no column %S", r.table, r.old, r.old)));
        } else if (table_column(smap_get(&d->source, *src), r.new_) != NULL) {
            PUSH(errs, diff_error(fmt("rename column %S.%S: the source table already has a column %S", r.table, r.old, r.new_)));
        } else if (table_column(smap_get(&d->target, r.table), r.new_) == NULL) {
            PUSH(errs, diff_error(fmt("rename column %S.%S: the target table has no column %S", r.table, r.old, r.new_)));
        } else {
            smap_set(map_at(&d->renamed_column, r.table), r.old, str_ptr(r.new_));
            PUSH(d->renamed_columns, r);
        }
    }
    smap allowed_columns = {0}, used_permissions = {0};
    for (size_t i = 0; i < p->drop_columns.n; i++) {
        smap_set(&allowed_columns, fmt("%S.%S", p->drop_columns.v[i].table, p->drop_columns.v[i].name), TRUEP);
    }
    for (size_t mi = 0; mi < d->matched.n; mi++) {
        str name = d->matched.v[mi];
        const table *src = smap_get(&d->source, lookup(&d->table_of, name, name));
        const table *tgt = smap_get(&d->target, name);
        const smap *renamed = smap_get(&d->renamed_column, name);
        smap *column_of = map_at(&d->column_of, name);
        for (size_t i = 0; i < src->columns.n; i++) {
            const column *c = src->columns.v[i];
            str n = lookup(renamed, c->name, c->name);
            if (table_column(tgt, n) == NULL) {
                str ref = fmt("%S.%S", src->name, c->name);
                if (!smap_has(&allowed_columns, ref)) {
                    PUSH(errs, diff_error(fmt("column %S is dropped without allow drop column %S", ref, ref)));
                }
                smap_set(&used_permissions, ref, TRUEP);
                PUSH(*strs_at(&d->removed, name), c->name);
                continue;
            }
            smap_set(column_of, n, str_ptr(c->name));
        }
        for (size_t i = 0; i < tgt->columns.n; i++) {
            const column *c = tgt->columns.v[i];
            str *old = smap_get(column_of, c->name);
            if (old == NULL) {
                if (!c->nullable && !c->has_default) {
                    PUSH(errs, diff_error(fmt("column %S.%S is added non-null without a default; add it null, fill it, and make it non-null in a later plan", name, c->name)));
                }
                if (c->identity) {
                    PUSH(errs, diff_error(fmt("column %S.%S adds an identity, which changes the primary key", name, c->name)));
                }
                PUSH(*strs_at(&d->added, name), c->name);
                continue;
            }
            const column *sc = table_column(src, *old);
            if (sc->identity != c->identity) {
                PUSH(errs, diff_error(fmt("column %S.%S changes identity; it needs a new table", name, c->name)));
                continue;
            }
            bool same = ctype_same(sc->type, c->type);
            if (!same && !type_widens(sc->type, c->type)) {
                PUSH(errs, diff_error(fmt("column %S.%S changes type from %S to %S, which does not keep every value; it needs a new column", name, c->name, ctype_text(sc->type), ctype_text(c->type))));
                continue;
            }
            bool same_default = sc->has_default == c->has_default && (!sc->has_default || str_eq(sc->def, c->def));
            if (!same || sc->nullable != c->nullable || !same_default) {
                PUSH(*strs_at(&d->altered, name), c->name);
            }
        }
        /* PostgreSQL은 column 자리를 정하지 못하므로 남는 column의 순서는 그대로이고 더한 column은 남는 column 뒤에 온다. */
        strs kept = {0}, kept_target = {0};
        for (size_t i = 0; i < src->columns.n; i++) {
            str n = lookup(renamed, src->columns.v[i]->name, src->columns.v[i]->name);
            if (table_column(tgt, n) != NULL) {
                PUSH(kept, n);
            }
        }
        ssize_t last_kept = -1;
        for (size_t i = 0; i < tgt->columns.n; i++) {
            if (smap_has(column_of, tgt->columns.v[i]->name)) {
                PUSH(kept_target, tgt->columns.v[i]->name);
                last_kept = (ssize_t)i;
            }
        }
        if (!strs_eq(&kept, &kept_target)) {
            PUSH(errs, diff_error(fmt("table %S reorders its columns; columns keep their order", name)));
        }
        for (size_t i = 0; i < tgt->columns.n; i++) {
            if (!smap_has(column_of, tgt->columns.v[i]->name) && (ssize_t)i < last_kept) {
                PUSH(errs, diff_error(fmt("column %S.%S is added before a kept column; added columns come last", name, tgt->columns.v[i]->name)));
            }
        }
        strs source_key = {0};
        const strs empty = {0};
        const strs *sk = src->pk != NULL ? &src->pk->columns : &empty;
        for (size_t i = 0; i < sk->n; i++) {
            PUSH(source_key, lookup(renamed, sk->v[i], sk->v[i]));
        }
        if (!strs_eq(&source_key, tgt->pk != NULL ? &tgt->pk->columns : &empty)) {
            PUSH(errs, diff_error(fmt("table %S changes its primary key; it needs a new table", name)));
        }
    }
    for (size_t i = 0; i < p->drop_columns.n; i++) {
        str ref = fmt("%S.%S", p->drop_columns.v[i].table, p->drop_columns.v[i].name);
        if (!smap_has(&used_permissions, ref)) {
            PUSH(errs, diff_error(fmt("allow drop column %S drops nothing", ref)));
        }
    }
    if (errs.n > 0) {
        for (size_t i = 0; i < errs.n; i++) {
            PUSH(*out, errs.v[i]);
        }
        return NULL;
    }
    compare_objects(d);
    trigger_changes(d);
    collect_changes(d);
    return d;
}

bool plan_diff(const document *source, const plan *p, changev *out, diags *d)
{
    pdiff *diff = pdiff_of(source, p, d);
    if (diff == NULL) {
        return false;
    }
    *out = diff->changes;
    return true;
}

/* -------------------------------------------------------------- compare */

static const char *const compare_kinds[] = {
    "create_table", "drop_table",
    "drop_column", "add_column", "alter_column", "change_column_type", "change_column_identity",
    "reorder_columns", "change_primary_key",
    "drop_unique", "add_unique", "drop_index", "add_index",
    "drop_foreign_key", "add_foreign_key", "drop_check", "add_check",
    "drop_immutable", "add_immutable", "drop_audit", "add_audit", NULL,
};

static int compare_rank(str kind)
{
    for (int i = 0; compare_kinds[i] != NULL; i++) {
        if (str_eqc(kind, compare_kinds[i])) {
            return i;
        }
    }
    return 99;
}

static int cmp_difference(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const change *x = a, *y = b;
    int rx = compare_rank(x->kind), ry = compare_rank(y->kind);
    if (rx != ry) {
        return rx < ry ? -1 : 1;
    }
    return str_cmp(x->name, y->name);
}

static int cmp_table_name(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(table *const *)a)->name, (*(table *const *)b)->name);
}

/* 문서의 canonical emission이 그 문서 하나의 schema text인지 알린다. */
bool is_schema_text(const document *d)
{
    if (!str_eqc(d->name, "schema")) {
        return false;
    }
    document *schema = document_new(SL("schema"));
    for (size_t i = 0; i < d->tables.n; i++) {
        PUSH(schema->tables, d->tables.v[i]);
    }
    dbs_sort(schema->tables.v, schema->tables.n, sizeof(table *), cmp_table_name, NULL);
    for (size_t i = 0; i < d->uses.n; i++) {
        strs tables = {0};
        for (size_t k = 0; k < d->uses.v[i]->tables.n; k++) {
            if (!strs_has(&tables, d->uses.v[i]->tables.v[k])) {
                PUSH(tables, d->uses.v[i]->tables.v[k]);
            }
        }
        strs_sort(&tables);
        useline *u = dbs_alloc(sizeof *u);
        u->document = d->uses.v[i]->document;
        u->tables = tables;
        PUSH(schema->uses, u);
    }
    return str_eq(dbs_emit(d, VIEW_CANONICAL), dbs_emit(schema, VIEW_SCHEMA));
}

typedef struct {
    changev *found;
    str table;
} adder;

static void add_difference(adder *a, const char *kind, str name)
{
    PUSH(*a->found, ((change){str_c(kind), a->table, name}));
}

/* table에 하나뿐인 setting의 정의, 없으면 NULL이다. audit은 두 쪽에 다 있는 column 가운데 기록하지 않는 column까지 비교한다. */
static str *setting_def(const table *x, const char *kind, const table *s, const table *t)
{
    if (x->settings == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < x->settings->list.n; i++) {
        const setting *st = x->settings->list.v[i];
        if (!str_eqc(st->kind, kind)) {
            continue;
        }
        strs def = strs_copy(&st->args);
        if (strcmp(kind, "audit") == 0) {
            for (size_t k = 0; k < t->columns.n; k++) {
                str c = t->columns.v[k]->name;
                if (table_column(s, c) != NULL && !setting_records(st, c)) {
                    PUSH(def, c);
                }
            }
        }
        return str_ptr(strs_join(&def, " "));
    }
    return NULL;
}

static void compare_tables(adder *a, const table *s, const table *t)
{
    for (size_t i = 0; i < s->columns.n; i++) {
        if (table_column(t, s->columns.v[i]->name) == NULL) {
            add_difference(a, "drop_column", s->columns.v[i]->name);
        }
    }
    strs kept_target = {0};
    ssize_t last_kept = -1, first_added = -1;
    for (size_t i = 0; i < t->columns.n; i++) {
        const column *c = t->columns.v[i];
        const column *sc = table_column(s, c->name);
        if (sc == NULL) {
            add_difference(a, "add_column", c->name);
            if (first_added < 0) {
                first_added = (ssize_t)i;
            }
            continue;
        }
        PUSH(kept_target, c->name);
        last_kept = (ssize_t)i;
        bool same = ctype_same(sc->type, c->type);
        bool same_default = sc->has_default == c->has_default && (!sc->has_default || str_eq(sc->def, c->def));
        if ((!same && type_widens(sc->type, c->type)) || sc->nullable != c->nullable || !same_default) {
            add_difference(a, "alter_column", c->name);
        }
        if (!same && !type_widens(sc->type, c->type)) {
            add_difference(a, "change_column_type", c->name);
        }
        if (sc->identity != c->identity) {
            add_difference(a, "change_column_identity", c->name);
        }
    }
    strs kept = {0};
    for (size_t i = 0; i < s->columns.n; i++) {
        if (table_column(t, s->columns.v[i]->name) != NULL) {
            PUSH(kept, s->columns.v[i]->name);
        }
    }
    if (!strs_eq(&kept, &kept_target) || (first_added >= 0 && first_added < last_kept)) {
        add_difference(a, "reorder_columns", SL(""));
    }
    const strs empty = {0};
    if (!strs_eq(s->pk != NULL ? &s->pk->columns : &empty, t->pk != NULL ? &t->pk->columns : &empty)) {
        add_difference(a, "change_primary_key", SL(""));
    }
    /* 이름으로 맞춘 객체가 한쪽에만 있으면 drop이나 add를, 정의가 다르면 둘 다 더한다. */
#define OBJECTS(kind, list, find, def) do { \
        for (size_t i = 0; i < s->list.n; i++) { \
            const void *other = find(&t->list, s->list.v[i]->name); \
            if (other == NULL || !str_eq(def(other), def(s->list.v[i]))) add_difference(a, "drop_" kind, s->list.v[i]->name); \
        } \
        for (size_t i = 0; i < t->list.n; i++) { \
            const void *other = find(&s->list, t->list.v[i]->name); \
            if (other == NULL || !str_eq(def(other), def(t->list.v[i]))) add_difference(a, "add_" kind, t->list.v[i]->name); \
        } \
    } while (0)
#define UDEF(u) strs_join(&((const ukey *)(u))->columns, ",")
#define XDEF(x) index_def((const xindex *)(x), same_name, NULL)
#define FDEF(f) fkey_def(&((const fkey *)(f))->columns, ((const fkey *)(f))->table, &((const fkey *)(f))->refs, (const fkey *)(f))
#define KDEF(k) (((const check *)(k))->expression)
    OBJECTS("unique", uniques, named_ukey, UDEF);
    OBJECTS("index", indexes, named_index, XDEF);
    OBJECTS("foreign_key", fks, named_fkey, FDEF);
    OBJECTS("check", checks, named_check, KDEF);
    const char *kinds[] = {"immutable", "audit"};
    for (int k = 0; k < 2; k++) {
        str *sd = setting_def(s, kinds[k], s, t), *td = setting_def(t, kinds[k], s, t);
        bool differ = (sd == NULL) != (td == NULL) || (sd != NULL && !str_eq(*sd, *td));
        if (differ) {
            if (sd != NULL) {
                add_difference(a, k == 0 ? "drop_immutable" : "drop_audit", SL(""));
            }
            if (td != NULL) {
                add_difference(a, k == 0 ? "add_immutable" : "add_audit", SL(""));
            }
        }
    }
}

bool schema_compare(const document *source, const document *target, changev *out, diags *d)
{
    const document *sides[2] = {source, target};
    const char *names[2] = {"source", "target"};
    size_t before = d->n;
    for (int i = 0; i < 2; i++) {
        if (!is_schema_text(sides[i])) {
            PUSH(*d, mkdiag(SL("compare"), 1, 1, fmt("the %s is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings", names[i])));
        }
    }
    if (d->n != before) {
        return false;
    }
    smap st = {0}, tt = {0}, all = {0};
    for (size_t i = 0; i < source->tables.n; i++) {
        smap_set(&st, source->tables.v[i]->name, source->tables.v[i]);
        smap_set(&all, source->tables.v[i]->name, TRUEP);
    }
    for (size_t i = 0; i < target->tables.n; i++) {
        smap_set(&tt, target->tables.v[i]->name, target->tables.v[i]);
        smap_set(&all, target->tables.v[i]->name, TRUEP);
    }
    strs keys = {0};
    smap_keys_sorted(&all, &keys);
    *out = (changev){0};
    for (size_t i = 0; i < keys.n; i++) {
        changev found = {0};
        adder a = {&found, keys.v[i]};
        const table *s = smap_get(&st, keys.v[i]), *t = smap_get(&tt, keys.v[i]);
        if (s == NULL) {
            add_difference(&a, "create_table", SL(""));
        } else if (t == NULL) {
            add_difference(&a, "drop_table", SL(""));
        } else {
            compare_tables(&a, s, t);
        }
        dbs_sort(found.v, found.n, sizeof(change), cmp_difference, NULL);
        for (size_t k = 0; k < found.n; k++) {
            PUSH(*out, found.v[k]);
        }
    }
    return true;
}

/* ------------------------------------------------------------ the set */

strs external_differences(const document *live, const documentv *documents)
{
    smap external = {0};
    for (size_t i = 0; i < documents->n; i++) {
        if (documents->v[i]->external) {
            smap_set(&external, documents->v[i]->name, documents->v[i]);
        }
    }
    smap tables = {0};
    for (size_t i = 0; i < documents->n; i++) {
        const document *d = documents->v[i];
        if (d->external) {
            continue;
        }
        for (size_t u = 0; u < d->uses.n; u++) {
            const document *source = smap_get(&external, d->uses.v[u]->document);
            if (source == NULL) {
                continue;
            }
            for (size_t k = 0; k < d->uses.v[u]->tables.n; k++) {
                str name = d->uses.v[u]->tables.v[k];
                for (size_t x = 0; x < source->tables.n; x++) {
                    if (str_eq(source->tables.v[x]->name, name) && !smap_has(&tables, name)) {
                        smap_set(&tables, name, source->tables.v[x]);
                    }
                }
            }
        }
    }
    strs names = {0};
    smap_keys_sorted(&tables, &names);
    smap live_tables = {0};
    for (size_t i = 0; i < live->tables.n; i++) {
        smap_set(&live_tables, live->tables.v[i]->name, live->tables.v[i]);
    }
    strs out = {0};
    for (size_t i = 0; i < names.n; i++) {
        str name = names.v[i];
        const table *want = smap_get(&tables, name);
        const table *got = smap_get(&live_tables, name);
        if (got == NULL) {
            PUSH(out, fmt("table %S does not exist", name));
            continue;
        }
        smap got_columns = {0};
        for (size_t k = 0; k < got->columns.n; k++) {
            smap_set(&got_columns, got->columns.v[k]->name, got->columns.v[k]);
        }
        for (size_t k = 0; k < want->columns.n; k++) {
            const column *c = want->columns.v[k];
            const column *g = smap_get(&got_columns, c->name);
            if (g == NULL) {
                PUSH(out, fmt("column %S.%S does not exist", name, c->name));
            } else if (!str_eq(ctype_text(g->type), ctype_text(c->type))) {
                PUSH(out, fmt("column %S.%S is %S, not %S", name, c->name, ctype_text(g->type), ctype_text(c->type)));
            } else if (g->nullable != c->nullable) {
                PUSH(out, fmt("column %S.%S is %s, not %s", name, c->name, g->nullable ? "null" : "not null", c->nullable ? "null" : "not null"));
            }
        }
        const strs empty = {0};
        const strs *gk = got->pk != NULL ? &got->pk->columns : &empty, *wk = want->pk != NULL ? &want->pk->columns : &empty;
        if (!strs_eq(gk, wk)) {
            PUSH(out, fmt("table %S has the primary key (%S), not (%S)", name, strs_join(gk, ", "), strs_join(wk, ", ")));
        }
        for (size_t k = 0; k < want->uniques.n; k++) {
            bool found = false;
            for (size_t g = 0; g < got->uniques.n; g++) {
                found = found || strs_eq(&got->uniques.v[g]->columns, &want->uniques.v[k]->columns);
            }
            if (!found) {
                PUSH(out, fmt("table %S has no unique key (%S)", name, strs_join(&want->uniques.v[k]->columns, ", ")));
            }
        }
    }
    return out;
}

static str qualified(str table, str name)
{
    return name.n == 0 ? table : fmt("%S.%S", table, name);
}

/* database에 있는 set의 table(source)과 set을 비교한다. 읽지 못한 객체가 있으면 source 없이 그 객체를 차이로 돌려준다. */
static document *compare_set(const document *live, const unsupportedv *skipped, const document *target, smap *declared,
    changev *differences, bool *compared, strs *out)
{
    for (size_t i = 0; i < target->tables.n; i++) {
        smap_set(declared, target->tables.v[i]->name, target->tables.v[i]);
    }
    for (size_t i = 0; i < skipped->n; i++) {
        const unsupported *u = &skipped->v[i];
        if (smap_has(declared, u->table)) {
            PUSH(*out, fmt("unsupported_%S %S: %S", u->kind, qualified(u->table, u->name), u->reason));
        }
    }
    *compared = false;
    if (out->n > 0) {
        return NULL;
    }
    document *source = document_new(SL("schema"));
    for (size_t i = 0; i < live->tables.n; i++) {
        if (smap_has(declared, live->tables.v[i]->name)) {
            PUSH(source->tables, live->tables.v[i]);
        }
    }
    diags d = {0};
    *compared = schema_compare(source, target, differences, &d);
    for (size_t i = 0; i < d.n; i++) {
        PUSH(*out, fmt("%S: %S", d.v[i].rule, d.v[i].message));
    }
    return source;
}

strs installed_differences(const document *live, const unsupportedv *skipped, const document *target)
{
    smap declared = {0};
    changev differences = {0};
    bool compared;
    strs out = {0};
    document *source = compare_set(live, skipped, target, &declared, &differences, &compared, &out);
    if (source == NULL) {
        return out;
    }
    for (size_t i = 0; i < differences.n; i++) {
        PUSH(out, fmt("%S %S", differences.v[i].kind, qualified(differences.v[i].table, differences.v[i].name)));
    }
    return out;
}

void add_tables_and_columns_steps(const document *live, const unsupportedv *skipped, const document *target, str dialect_name,
    strs *added_out, planstepv *steps_out, strs *differences_out)
{
    *added_out = (strs){0};
    *steps_out = (planstepv){0};
    smap declared = {0};
    changev comparison = {0};
    bool compared;
    strs differences = {0};
    document *source = compare_set(live, skipped, target, &declared, &comparison, &compared, &differences);
    if (source == NULL) {
        *differences_out = differences;
        return;
    }
    smap adding = {0};
    for (size_t i = 0; i < comparison.n; i++) {
        const change *d = &comparison.v[i];
        if (str_eqc(d->kind, "create_table")) {
            smap_set(&adding, d->table, TRUEP);
            continue;
        }
        if (str_eqc(d->kind, "add_column")) {
            const table *t = smap_get(&declared, d->table);
            const column *c = NULL;
            for (size_t k = 0; k < t->columns.n; k++) {
                if (str_eq(t->columns.v[k]->name, d->name)) {
                    c = t->columns.v[k];
                }
            }
            if (c == NULL || c->identity || (!c->nullable && !c->has_default)) {
                PUSH(differences, fmt("add_column %S without null or default", qualified(d->table, d->name)));
                continue;
            }
            smap_set(&adding, qualified(d->table, d->name), TRUEP);
            continue;
        }
        if (str_eqc(d->kind, "add_index")) {
            /* index는 행을 거부하지 않으므로 있는 table에도 더한다. */
            smap_set(&adding, qualified(d->table, d->name), TRUEP);
            continue;
        }
        if (str_eqc(d->kind, "add_unique")) {
            /* unique key는 있는 행이 겹치면 실패하므로 plan과 apply가 다룬다. */
            PUSH(differences, fmt("add_unique %S: a missing unique key can fail on the existing rows; add it with a plan", qualified(d->table, d->name)));
            continue;
        }
        PUSH(differences, fmt("%S %S", d->kind, qualified(d->table, d->name)));
    }
    if (differences.n > 0 || adding.live == 0) {
        *differences_out = differences;
        return;
    }
    /* 만드는 table과 더하는 column과 index는 table 이름 순, table 안에서는 column 순서 뒤 index 순서다. */
    strs added = {0};
    for (size_t i = 0; i < target->tables.n; i++) {
        const table *t = target->tables.v[i];
        if (smap_has(&adding, t->name)) {
            PUSH(added, t->name);
            continue;
        }
        for (size_t k = 0; k < t->columns.n; k++) {
            str q = qualified(t->name, t->columns.v[k]->name);
            if (smap_has(&adding, q)) {
                PUSH(added, q);
            }
        }
        for (size_t k = 0; k < t->indexes.n; k++) {
            str q = qualified(t->name, t->indexes.v[k]->name);
            if (smap_has(&adding, q)) {
                PUSH(added, q);
            }
        }
    }
    /* 더하는 table과 column은 plan 하나로 쓴다. plan은 database에 있는 set의 table에서 시작한다(없으면 빈 database). */
    diags d = {0};
    planstepv steps = {0};
    const document *start = source->tables.n == 0 ? NULL : source;
    bool has_from = false;
    str from = SNULL;
    if (start != NULL) {
        documentv one = {0};
        PUSH(one, (document *)start);
        manifest m;
        if (dbs_manifest(&one, &m, &d)) {
            has_from = true;
            from = m.schema_hash;
        }
    }
    if (d.n == 0) {
        /* target은 외부 문서를 쓰는 set의 schema text일 수 있으므로 plan 문서를 parse하지 않고 target으로 plan을 만든다. */
        plan *p = plan_to(SL("add_tables_and_columns"), has_from, from, (trenamev){0}, (crenamev){0}, (strs){0}, (cnamev){0},
            (document *)target, dbs_emit(target, VIEW_CANONICAL), &d);
        dialect dl;
        /* PHP client처럼 dialect는 step을 쓸 때 확인한다. */
        if (p != NULL && dbs_dialect(dialect_name, &dl)) {
            plan_steps(start, p, dl, &steps, &d);
        }
    }
    for (size_t i = 0; i < d.n; i++) {
        PUSH(differences, fmt("%S: %S", d.v[i].rule, d.v[i].message));
    }
    if (differences.n > 0) {
        *differences_out = differences;
        return;
    }
    *added_out = added;
    *steps_out = steps;
    *differences_out = (strs){0};
}
