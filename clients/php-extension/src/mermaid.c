/*
 * dbspec 문서를 표준 Mermaid erDiagram으로 쓰고, erDiagram을 dbspec 문서로 읽는다(PHP client Mermaid,
 * docs/mermaid.md). 둘 다 옮기지 못한 것을 [table, kind, name] 순서로 알린다. PHP client의 정규식은 여기서 같은
 * 문법을 읽는 scanner다.
 */
#include "dbspec.h"
#include "ext/spl/spl_exceptions.h"

static void report(unsupportedv *l, const char *kind, str table, str name, str reason)
{
    PUSH(*l, ((unsupported){str_c(kind), table, name, reason}));
}

static int cmp_dropped(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const unsupported *x = a, *y = b;
    sbuf p = {0}, q = {0};
    sb_s(&p, x->table); sb_ch(&p, '\0'); sb_s(&p, x->kind); sb_ch(&p, '\0'); sb_s(&p, x->name);
    sb_s(&q, y->table); sb_ch(&q, '\0'); sb_s(&q, y->kind); sb_ch(&q, '\0'); sb_s(&q, y->name);
    return str_cmp(sb_str(&p), sb_str(&q));
}

static bool settings_commented(const settings *s)
{
    if (s == NULL) {
        return false;
    }
    if (s->comments.n > 0 || s->closing.n > 0) {
        return true;
    }
    for (size_t i = 0; i < s->list.n; i++) {
        if (s->list.v[i]->comments.n > 0) {
            return true;
        }
    }
    return false;
}

/* Mermaid type에는 쉼표가 없으므로 decimal(p,s)를 decimal(p-s)로 쓴다. */
static str mermaid_type(const ctype *t)
{
    if (str_eqc(t->name, "decimal")) {
        return fmt("decimal(%d-%d)", t->p[0], t->p[1]);
    }
    return ctype_text(t);
}

static int cmp_table(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(table *const *)a)->name, (*(table *const *)b)->name);
}

static int cmp_fkey(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(fkey *const *)a)->name, (*(fkey *const *)b)->name);
}

str mermaid_export(const document *d, unsupportedv *dropped)
{
    unsupportedv out = {0};
    for (size_t i = 0; i < d->uses.n; i++) {
        report(&out, "use", SL(""), d->uses.v[i]->document, SL("export writes the tables of one document; used tables appear only as relationship ends"));
        if (d->uses.v[i]->comments.n > 0) {
            report(&out, "comment", SL(""), d->uses.v[i]->document, SL("Mermaid has no comments on use lines"));
        }
    }
    for (size_t i = 0; i < d->diagrams.n; i++) {
        const diagram *g = d->diagrams.v[i];
        report(&out, "diagram", SL(""), g->name, SL("a dbspec diagram has no Mermaid form"));
        bool commented = g->comments.n > 0 || g->closing.n > 0;
        for (size_t k = 0; k < g->placements.n; k++) {
            commented = commented || g->placements.v[k]->comments.n > 0;
        }
        if (commented) {
            report(&out, "comment", SL(""), g->name, SL("Mermaid has no diagram comments"));
        }
    }
    if (d->trailing.n > 0) {
        report(&out, "comment", SL(""), d->name, SL("Mermaid has no comments after the last block"));
    }
    VEC(table *) tables = {0};
    for (size_t i = 0; i < d->tables.n; i++) {
        PUSH(tables, d->tables.v[i]);
    }
    dbs_sort(tables.v, tables.n, sizeof(table *), cmp_table, NULL);
    sbuf b = {0};
    sb_c(&b, "erDiagram\n");
    for (size_t i = 0; i < tables.n; i++) {
        const table *t = tables.v[i];
        if (t->comments.n > 0 || t->closing.n > 0 || (t->pk != NULL && t->pk->comments.n > 0) || settings_commented(t->settings)) {
            report(&out, "comment", t->name, t->name, SL("Mermaid has no comments on the table, primary key and settings lines"));
        }
        sb_fmt(&b, "    %S {\n", t->name);
        for (size_t k = 0; k < t->columns.n; k++) {
            const column *c = t->columns.v[k];
            if (c->comments.n > 0) {
                report(&out, "comment", t->name, c->name, SL("Mermaid has no column comments"));
            }
            sbuf line = {0};
            sb_fmt(&line, "        %S %S", mermaid_type(c->type), c->name);
            strs keys = {0};
            if (t->pk != NULL && strs_has(&t->pk->columns, c->name)) {
                PUSH(keys, SL("PK"));
            }
            for (size_t f = 0; f < t->fks.n; f++) {
                if (strs_has(&t->fks.v[f]->columns, c->name)) {
                    PUSH(keys, SL("FK"));
                    break;
                }
            }
            for (size_t u = 0; u < t->uniques.n; u++) {
                if (strs_has(&t->uniques.v[u]->columns, c->name)) {
                    PUSH(keys, SL("UK"));
                    break;
                }
            }
            if (keys.n > 0) {
                sb_fmt(&line, " %S", strs_join(&keys, ", "));
            }
            strs suffix = {0};
            if (c->nullable) {
                PUSH(suffix, SL("null"));
            }
            if (c->identity) {
                PUSH(suffix, SL("identity"));
            }
            if (c->has_default) {
                if (str_hasch(c->def, '"')) {
                    report(&out, "default", t->name, c->name, SL("a Mermaid comment cannot hold the default, which contains a double quote"));
                } else {
                    PUSH(suffix, fmt("default %S", c->def));
                }
            }
            if (suffix.n > 0) {
                sb_fmt(&line, " \"%S\"", strs_join(&suffix, " "));
            }
            sb_fmt(&b, "%S\n", sb_str(&line));
        }
        sb_c(&b, "    }\n");
        for (size_t k = 0; k < t->uniques.n; k++) {
            report(&out, "unique", t->name, t->uniques.v[k]->name, SL("Mermaid marks the columns of a unique key with UK but has no key"));
            if (t->uniques.v[k]->comments.n > 0) {
                report(&out, "comment", t->name, t->uniques.v[k]->name, SL("Mermaid has no key comments"));
            }
        }
        for (size_t k = 0; k < t->indexes.n; k++) {
            report(&out, "index", t->name, t->indexes.v[k]->name, SL("Mermaid has no indexes"));
            if (t->indexes.v[k]->comments.n > 0) {
                report(&out, "comment", t->name, t->indexes.v[k]->name, SL("Mermaid has no key comments"));
            }
        }
        for (size_t k = 0; k < t->checks.n; k++) {
            report(&out, "check", t->name, t->checks.v[k]->name, SL("Mermaid has no checks"));
            if (t->checks.v[k]->comments.n > 0) {
                report(&out, "comment", t->name, t->checks.v[k]->name, SL("Mermaid has no key comments"));
            }
        }
        for (size_t k = 0; k < t->fks.n; k++) {
            const fkey *f = t->fks.v[k];
            if (!str_eqc(f->on_delete, "restrict") || !str_eqc(f->on_update, "restrict")) {
                report(&out, "foreign_key", t->name, f->name, SL("Mermaid has no foreign key actions"));
            }
            if (f->comments.n > 0) {
                report(&out, "comment", t->name, f->name, SL("Mermaid has no key comments"));
            }
        }
        if (t->settings != NULL) {
            report(&out, "settings", t->name, t->name, SL("Mermaid has no settings"));
        }
    }
    for (size_t i = 0; i < tables.n; i++) {
        const table *t = tables.v[i];
        fkey **f = dbs_alloc(sizeof(fkey *) * (t->fks.n + 1));
        memcpy(f, t->fks.v, sizeof(fkey *) * t->fks.n);
        dbs_sort(f, t->fks.n, sizeof(fkey *), cmp_fkey, NULL);
        for (size_t k = 0; k < t->fks.n; k++) {
            const char *marker = "||--o{";
            for (size_t m = 0; m < f[k]->columns.n; m++) {
                for (size_t c = 0; c < t->columns.n; c++) {
                    if (str_eq(t->columns.v[c]->name, f[k]->columns.v[m]) && t->columns.v[c]->nullable) {
                        marker = "|o--o{";
                    }
                }
            }
            sb_fmt(&b, "    %S %s %S : \"%S (%S) references (%S)\"\n", f[k]->table, marker, t->name, f[k]->name, strs_join(&f[k]->columns, ", "),
                strs_join(&f[k]->refs, ", "));
        }
    }
    dbs_sort(out.v, out.n, sizeof(unsupported), cmp_dropped, NULL);
    *dropped = out;
    return sb_str(&b);
}

/* ---------------------------------------------------------------- import */

/* [\t\n\f\r ] */
static bool ws(char c)
{
    return c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' ';
}

/* Go strings.TrimSpace가 지우는 Unicode White_Space의 UTF-8 byte 열의 길이: s의 i에서 시작하면 그 길이, 아니면 0. */
static size_t space_at(str s, size_t i)
{
    unsigned char c = (unsigned char)s.s[i];
    if (c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r' || c == ' ') {
        return 1;
    }
    if (c == 0xC2 && i + 1 < s.n) {
        unsigned char d = (unsigned char)s.s[i + 1];
        return d == 0x85 || d == 0xA0 ? 2 : 0;
    }
    if (c == 0xE1 && i + 2 < s.n) {
        return (unsigned char)s.s[i + 1] == 0x9A && (unsigned char)s.s[i + 2] == 0x80 ? 3 : 0;
    }
    if (c == 0xE2 && i + 2 < s.n) {
        unsigned char d = (unsigned char)s.s[i + 1], e = (unsigned char)s.s[i + 2];
        if (d == 0x80 && ((e >= 0x80 && e <= 0x8A) || e == 0xA8 || e == 0xA9 || e == 0xAF)) {
            return 3;
        }
        return d == 0x81 && e == 0x9F ? 3 : 0;
    }
    if (c == 0xE3 && i + 2 < s.n) {
        return (unsigned char)s.s[i + 1] == 0x80 && (unsigned char)s.s[i + 2] == 0x80 ? 3 : 0;
    }
    return 0;
}

/* `^SPACE+|SPACE+$`를 지운다. 끝의 공백은 그것으로만 끝까지 이어지는 가장 앞의 자리에서 시작한다. */
static str trim_space(str s)
{
    size_t a = 0;
    for (;;) {
        if (a >= s.n) {
            return SL("");
        }
        size_t n = space_at(s, a);
        if (n == 0) {
            break;
        }
        a += n;
    }
    /* a부터 시작해 끝까지 공백만 이어지는 가장 앞의 자리 */
    for (size_t p = a; p < s.n; p++) {
        size_t q = p;
        while (q < s.n) {
            size_t n = space_at(s, q);
            if (n == 0) {
                break;
            }
            q += n;
        }
        if (q == s.n && q > p) {
            return str_sub(s, a, p - a);
        }
    }
    return str_sub(s, a, s.n - a);
}

static bool entity_char(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

/* `([A-Za-z0-9_-]+|"[^"]*")` */
static bool entity_name(str s, size_t *i, str *out)
{
    size_t p = *i;
    if (p < s.n && s.s[p] == '"') {
        size_t q = p + 1;
        while (q < s.n && s.s[q] != '"') {
            q++;
        }
        if (q >= s.n) {
            return false;
        }
        *out = str_sub(s, p, q + 1 - p);
        *i = q + 1;
        return true;
    }
    size_t q = p;
    while (q < s.n && entity_char(s.s[q])) {
        q++;
    }
    if (q == p) {
        return false;
    }
    *out = str_sub(s, p, q - p);
    *i = q;
    return true;
}

static size_t skip_ws(str s, size_t i)
{
    while (i < s.n && ws(s.s[i])) {
        i++;
    }
    return i;
}

/* `^NAME[\t\n\f\r ]*\{$` */
static bool entity_start(str line, str *name)
{
    size_t i = 0;
    if (!entity_name(line, &i, name)) {
        return false;
    }
    i = skip_ws(line, i);
    return i + 1 == line.n && line.s[i] == '{';
}

static bool key_at(str s, size_t i)
{
    return i + 1 < s.n && ((s.s[i] == 'P' && s.s[i + 1] == 'K') || (s.s[i] == 'F' && s.s[i + 1] == 'K') || (s.s[i] == 'U' && s.s[i + 1] == 'K'));
}

typedef struct {
    str type, name, comment;
    strs keys;
} attribute;

static bool type_char(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '(' || c == ')' || c == '[' || c == ']' || c == '-';
}

static bool alpha(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/* ATTRIBUTE: `^(type)WS+(name)((?:WS+KEY(?:WS*,WS*KEY)*)?)(?:WS+"([^"]*)")?$` */
static bool attribute_line(str line, attribute *a)
{
    size_t i = 0;
    if (i >= line.n || !alpha(line.s[i])) {
        return false;
    }
    while (i < line.n && type_char(line.s[i])) {
        i++;
    }
    a->type = str_sub(line, 0, i);
    size_t w = skip_ws(line, i);
    if (w == i) {
        return false;
    }
    i = w;
    if (i >= line.n || !(alpha(line.s[i]) || line.s[i] == '_' || line.s[i] == '*')) {
        return false;
    }
    size_t start = i++;
    while (i < line.n && (alpha(line.s[i]) || (line.s[i] >= '0' && line.s[i] <= '9') || line.s[i] == '_' || line.s[i] == '-')) {
        i++;
    }
    a->name = str_sub(line, start, i - start);
    /* key 목록: WS+ KEY, 그 뒤 WS* , WS* KEY의 반복 */
    size_t keys_start = i, keys_end = i;
    size_t k = skip_ws(line, i);
    if (k > i && key_at(line, k)) {
        keys_end = k + 2;
        for (;;) {
            size_t r = skip_ws(line, keys_end);
            if (r >= line.n || line.s[r] != ',') {
                break;
            }
            r = skip_ws(line, r + 1);
            if (!key_at(line, r)) {
                break;
            }
            keys_end = r + 2;
        }
    }
    str raw = str_sub(line, keys_start, keys_end - keys_start);
    i = keys_end;
    a->comment = SL("");
    size_t c = skip_ws(line, i);
    if (c > i && c < line.n && line.s[c] == '"') {
        size_t q = c + 1;
        while (q < line.n && line.s[q] != '"') {
            q++;
        }
        if (q < line.n) {
            a->comment = str_sub(line, c + 1, q - c - 1);
            i = q + 1;
        }
    }
    if (i != line.n) {
        return false;
    }
    a->keys = (strs){0};
    strs parts = strs_split(raw, ',');
    for (size_t p = 0; p < parts.n; p++) {
        str key = str_trim_set(parts.v[p], " \t\n\f\r");
        if (key.n > 0) {
            PUSH(a->keys, key);
        }
    }
    return true;
}

typedef struct {
    str left, left_card, right_card, right, label;
} relation;

static bool lit(str s, size_t *i, const char *text)
{
    size_t n = strlen(text);
    if (*i + n > s.n || memcmp(s.s + *i, text, n) != 0) {
        return false;
    }
    *i += n;
    return true;
}

/* RELATION: `^NAME WS+ (|o|\|\||}o|}\|)(--|\.\.)(o\||\|\||o{|\|{) WS+ NAME WS* : WS* ("[^"]*"|[^\t\n\f\r "]+)$` */
static bool relation_line(str line, relation *r)
{
    size_t i = 0;
    if (!entity_name(line, &i, &r->left)) {
        return false;
    }
    size_t w = skip_ws(line, i);
    if (w == i) {
        return false;
    }
    i = w;
    const char *lefts[] = {"|o", "||", "}o", "}|"};
    const char *rights[] = {"o|", "||", "o{", "|{"};
    bool found = false;
    for (int k = 0; k < 4 && !found; k++) {
        size_t j = i;
        if (lit(line, &j, lefts[k])) {
            r->left_card = str_c(lefts[k]);
            i = j;
            found = true;
        }
    }
    if (!found || !(lit(line, &i, "--") || lit(line, &i, ".."))) {
        return false;
    }
    found = false;
    for (int k = 0; k < 4 && !found; k++) {
        size_t j = i;
        if (lit(line, &j, rights[k])) {
            r->right_card = str_c(rights[k]);
            i = j;
            found = true;
        }
    }
    if (!found) {
        return false;
    }
    w = skip_ws(line, i);
    if (w == i) {
        return false;
    }
    i = w;
    if (!entity_name(line, &i, &r->right)) {
        return false;
    }
    i = skip_ws(line, i);
    if (i >= line.n || line.s[i] != ':') {
        return false;
    }
    i = skip_ws(line, i + 1);
    if (i < line.n && line.s[i] == '"') {
        size_t q = i + 1;
        while (q < line.n && line.s[q] != '"') {
            q++;
        }
        if (q + 1 == line.n) {
            r->label = str_sub(line, i, q + 1 - i);
            return true;
        }
    }
    size_t q = i;
    while (q < line.n && !ws(line.s[q]) && line.s[q] != '"') {
        q++;
    }
    if (q == i || q != line.n) {
        return false;
    }
    r->label = str_sub(line, i, q - i);
    return true;
}

static bool lower_name(str s, size_t *i, str *out)
{
    size_t p = *i;
    if (p >= s.n || s.s[p] < 'a' || s.s[p] > 'z') {
        return false;
    }
    size_t q = p + 1;
    while (q < s.n && ((s.s[q] >= 'a' && s.s[q] <= 'z') || (s.s[q] >= '0' && s.s[q] <= '9') || s.s[q] == '_')) {
        q++;
    }
    *out = str_sub(s, p, q - p);
    *i = q;
    return true;
}

static bool list_chars(str s, size_t *i, str *out)
{
    size_t p = *i, q = p;
    while (q < s.n && ((s.s[q] >= 'a' && s.s[q] <= 'z') || (s.s[q] >= '0' && s.s[q] <= '9') || s.s[q] == '_' || s.s[q] == ',' || s.s[q] == ' ')) {
        q++;
    }
    if (q == p) {
        return false;
    }
    *out = str_sub(s, p, q - p);
    *i = q;
    return true;
}

/* LABEL: `^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) references \(([a-z0-9_, ]+)\)$` */
static bool label_parts(str label, str *name, str *columns, str *refs)
{
    size_t i = 0;
    return lower_name(label, &i, name) && lit(label, &i, " (") && list_chars(label, &i, columns) && lit(label, &i, ") references (")
        && list_chars(label, &i, refs) && lit(label, &i, ")") && i == label.n;
}

static bool digits_at(str s, size_t *i, str *out)
{
    size_t p = *i, q = p;
    while (q < s.n && s.s[q] >= '0' && s.s[q] <= '9') {
        q++;
    }
    if (q == p) {
        return false;
    }
    *out = str_sub(s, p, q - p);
    *i = q;
    return true;
}

/* 숫자 text가 lo 이상 hi 이하인 값이면 그 값이다. 9자리를 넘는 수는 범위 밖이다. */
static bool within(str digits, zend_long lo, zend_long hi, zend_long *out)
{
    size_t z = 0;
    while (z < digits.n && digits.s[z] == '0') {
        z++;
    }
    str d = str_sub(digits, z, digits.n - z);
    if (d.n > 9) {
        return false;
    }
    zend_long n = d.n == 0 ? 0 : ZEND_STRTOL(str_of(d.s, d.n).s, NULL, 10);
    if (n < lo || n > hi) {
        return false;
    }
    *out = n;
    return true;
}

/* Mermaid type이 dbspec type이면 그 type, 아니면 NULL이다. */
static ctype *import_type(str s)
{
    static const char *const simple[] = {"i16", "i32", "i64", "bool", "f64", "text", "bytes", "uuid", "date", NULL};
    for (int k = 0; simple[k] != NULL; k++) {
        if (str_eqc(s, simple[k])) {
            return ctype_new(s, NULL, 0);
        }
    }
    size_t i = 0;
    str a, b;
    zend_long p[2];
    if (lit(s, &i, "varchar(") && digits_at(s, &i, &a) && lit(s, &i, ")") && i == s.n) {
        return within(a, 1, 16383, &p[0]) ? ctype_new(SL("varchar"), p, 1) : NULL;
    }
    const char *timed[] = {"time(", "datetime("};
    for (int k = 0; k < 2; k++) {
        i = 0;
        if (lit(s, &i, timed[k]) && i < s.n && s.s[i] >= '0' && s.s[i] <= '9' && i + 2 == s.n && s.s[i + 1] == ')') {
            a = str_sub(s, i, 1);
            return within(a, 0, 6, &p[0]) ? ctype_new(k == 0 ? SL("time") : SL("datetime"), p, 1) : NULL;
        }
    }
    i = 0;
    if (lit(s, &i, "decimal(") && digits_at(s, &i, &a) && lit(s, &i, "-") && digits_at(s, &i, &b) && lit(s, &i, ")") && i == s.n) {
        if (!within(a, 1, 18, &p[0]) || !within(b, 0, p[0], &p[1])) {
            return NULL;
        }
        return ctype_new(SL("decimal"), p, 2);
    }
    return NULL;
}

/* Go의 %q처럼 따옴표로 감싼다. ASCII escape는 Go와 같고, ASCII가 아닌 byte는 그대로 둔다. */
static str quoted(str s)
{
    sbuf b = {0};
    sb_ch(&b, '"');
    for (size_t i = 0; i < s.n; i++) {
        unsigned char c = (unsigned char)s.s[i];
        switch (c) {
            case 0x07: sb_c(&b, "\\a"); break;
            case 0x08: sb_c(&b, "\\b"); break;
            case '\f': sb_c(&b, "\\f"); break;
            case '\n': sb_c(&b, "\\n"); break;
            case '\r': sb_c(&b, "\\r"); break;
            case '\t': sb_c(&b, "\\t"); break;
            case '\v': sb_c(&b, "\\v"); break;
            case '\\': sb_c(&b, "\\\\"); break;
            case '"': sb_c(&b, "\\\""); break;
            default:
                if (c < 0x20 || c == 0x7F) {
                    char hex[8];
                    snprintf(hex, sizeof hex, "\\x%02x", c);
                    sb_c(&b, hex);
                } else {
                    sb_ch(&b, (char)c);
                }
        }
    }
    sb_ch(&b, '"');
    return sb_str(&b);
}

static strs split_names(str s)
{
    strs parts = strs_split(s, ','), out = {0};
    for (size_t i = 0; i < parts.n; i++) {
        PUSH(out, str_trim_set(parts.v[i], " \t\n\v\f\r"));
    }
    return out;
}

typedef VEC(attribute) attributev;

typedef struct {
    str name;
    attributev attributes;
} entity;

static entity *entity_of(smap *by_name, str raw)
{
    str n = str_trim_set(raw, "\"");
    entity *e = smap_get(by_name, n);
    if (e == NULL) {
        e = dbs_alloc(sizeof *e);
        e->name = n;
        smap_set(by_name, n, e);
    }
    return e;
}

static document *import_fail(diags *out, zend_long line, const char *message)
{
    PUSH(*out, mkdiag(SL("mermaid"), line, 1, str_c(message)));
    return NULL;
}

static bool has_key(const attribute *a, const char *key)
{
    for (size_t i = 0; i < a->keys.n; i++) {
        if (str_eqc(a->keys.v[i], key)) {
            return true;
        }
    }
    return false;
}

static icolumn *column_in(itable *t, str n)
{
    for (size_t i = 0; i < t->columns.n; i++) {
        if (str_eq(t->columns.v[i].name, n)) {
            return &t->columns.v[i];
        }
    }
    return NULL;
}

/* SUFFIX: `^(?:(null) )?(?:(identity) )?(?:default (.+) )?$`를 comment . ' '에 맞춘다. */
static bool column_suffix(str comment, icolumn *c)
{
    str s = fmt("%S ", comment);
    size_t i = 0;
    bool null = false, identity = false;
    str def = SL("");
    if (lit(s, &i, "null ")) {
        null = true;
    }
    if (lit(s, &i, "identity ")) {
        identity = true;
    }
    size_t j = i;
    if (lit(s, &j, "default ")) {
        /* (.+) 뒤의 마지막 공백까지: .은 줄 바꿈이 아닌 byte */
        str rest = str_sub(s, j, s.n - j);
        bool newline = false;
        for (size_t k = 0; k + 1 < rest.n; k++) {
            newline = newline || rest.s[k] == '\n';
        }
        if (rest.n >= 2 && !newline) {
            def = str_sub(rest, 0, rest.n - 1);
            i = s.n;
        }
    }
    if (i != s.n) {
        return false;
    }
    c->null = null;
    c->identity = identity;
    c->def = def;
    return true;
}

document *mermaid_import(str text, str name, unsupportedv *dropped, diags *out)
{
    strs lines = strs_split(str_ends(text, "\n") ? str_sub(text, 0, text.n - 1) : text, '\n');
    smap by_name = {0};
    VEC(relation) relations = {0};
    entity *open = NULL;
    bool header = false;
    for (size_t idx = 0; idx < lines.n; idx++) {
        zend_long n = (zend_long)idx + 1;
        str raw = lines.v[idx];
        if (str_ends(raw, "\r")) {
            raw = str_sub(raw, 0, raw.n - 1);
        }
        str line = trim_space(raw);
        if (line.n == 0 || str_starts(line, "%%")) {
            continue;
        }
        if (!header) {
            if (!str_eqc(line, "erDiagram")) {
                return import_fail(out, n, "a Mermaid entity relationship diagram starts with erDiagram");
            }
            header = true;
        } else if (open != NULL) {
            if (str_eqc(line, "}")) {
                open = NULL;
                continue;
            }
            attribute a;
            if (!attribute_line(line, &a)) {
                return import_fail(out, n, "an attribute is <type> <name> [PK|FK|UK, ...] [\"comment\"]");
            }
            PUSH(open->attributes, a);
        } else {
            str en;
            relation r;
            if (entity_start(line, &en)) {
                open = entity_of(&by_name, en);
            } else if (relation_line(line, &r)) {
                r.left = entity_of(&by_name, r.left)->name;
                r.right = entity_of(&by_name, r.right)->name;
                r.label = str_trim_set(r.label, "\"");
                PUSH(relations, r);
            } else {
                return import_fail(out, n, "a line is an entity block, an attribute, a relationship, a %% comment or blank");
            }
        }
    }
    if (!header) {
        return import_fail(out, 1, "a Mermaid entity relationship diagram starts with erDiagram");
    }
    if (open != NULL) {
        PUSH(*out, mkdiag(SL("mermaid"), (zend_long)lines.n, 1, fmt("entity %S has no closing brace", open->name)));
        return NULL;
    }
    catalog *c = dbs_alloc(sizeof *c);
    smap used_fks = {0}; /* entity => smap*(column => true) */
    SMAP_EACH(&by_name, i) {
        entity *e = by_name.e[i].val;
        if (!dbs_valid_name(e->name)) {
            catalog_report(c, SL("table"), e->name, e->name, SL("the entity name is not a dbspec name"));
            continue;
        }
        itable *t = itable_new(e->name);
        for (size_t k = 0; k < e->attributes.n; k++) {
            attribute *a = &e->attributes.v[k];
            if (!dbs_valid_name(a->name)) {
                catalog_report(c, SL("column"), e->name, a->name, SL("the attribute name is not a dbspec name"));
                continue;
            }
            ctype *type = import_type(a->type);
            if (type == NULL) {
                catalog_report(c, SL("column"), e->name, a->name, fmt("type %S is not a dbspec type", a->type));
                continue;
            }
            icolumn col = {a->name, type, false, false, SL("")};
            if (a->comment.n > 0 && !column_suffix(a->comment, &col)) {
                catalog_report(c, SL("comment"), e->name, a->name, fmt("the comment %S is not a dbspec column suffix", quoted(a->comment)));
            }
            PUSH(t->columns, col);
            if (has_key(a, "PK")) {
                PUSH(t->primary, a->name);
            }
            if (has_key(a, "UK")) {
                catalog_report(c, SL("unique"), e->name, a->name, SL("Mermaid does not say which UK attributes form one key"));
            }
        }
        PUSH(c->tables, t);
    }
    for (size_t i = 0; i < relations.n; i++) {
        relation *r = &relations.v[i];
        str parent = r->left, child = r->right, parent_card = r->left_card, child_card = r->right_card;
        bool many_right = str_ends(r->right_card, "{");
        bool many_left = str_starts(r->left_card, "}");
        if (many_left == many_right) {
            catalog_report(c, SL("relationship"), r->left, r->label, fmt("the relationship to %S is not one to many", r->right));
            continue;
        }
        if (many_left) {
            parent = r->right;
            child = r->left;
            parent_card = r->right_card;
            child_card = r->left_card;
        }
        itable *pt = catalog_table(c, parent), *ct = catalog_table(c, child);
        str fk_name, cols_text, refs_text;
        if (!label_parts(r->label, &fk_name, &cols_text, &refs_text) || pt == NULL || ct == NULL) {
            catalog_report(c, SL("relationship"), child, r->label, SL("the label does not give the foreign key columns, or an end is not a table"));
            continue;
        }
        strs columns = split_names(cols_text), refs = split_names(refs_text);
        /* column 수가 참조 column 수와 다르면 foreign key가 아니므로 column을 보지 않는다. */
        bool ok = columns.n == refs.n;
        bool nullable = false;
        entity *ce = smap_get(&by_name, child);
        for (size_t k = 0; ok && k < columns.n; k++) {
            icolumn *cc = column_in(ct, columns.v[k]);
            bool fk = false;
            for (size_t a = 0; a < ce->attributes.n; a++) {
                if (str_eq(ce->attributes.v[a].name, columns.v[k])) {
                    fk = has_key(&ce->attributes.v[a], "FK");
                    break;
                }
            }
            if (cc == NULL || !fk || column_in(pt, refs.v[k]) == NULL) {
                ok = false;
                break;
            }
            nullable = nullable || cc->null;
        }
        if (!ok) {
            catalog_report(c, SL("relationship"), child, fk_name, fmt("its columns are not FK attributes of %S or its referenced columns are not attributes of %S", child, parent));
            continue;
        }
        const char *want_parent = nullable ? "|o" : "||";
        if (many_left) {
            want_parent = nullable ? "o|" : "||";
        }
        if (!str_eqc(parent_card, want_parent) || (!str_eqc(child_card, "o{") && !str_eqc(child_card, "}o"))) {
            catalog_report(c, SL("cardinality"), child, fk_name, SL("the cardinalities differ from the ones the foreign key's nullability gives"));
        }
        PUSH(ct->fks, ((ifkey){fk_name, columns, parent, refs, SL("restrict"), SL("restrict")}));
        smap *used = smap_get(&used_fks, child);
        if (used == NULL) {
            used = dbs_alloc(sizeof *used);
            smap_set(&used_fks, child, used);
        }
        for (size_t k = 0; k < columns.n; k++) {
            smap_set(used, columns.v[k], TRUEP);
        }
        str index = fmt("ix_%S_%S", child, strs_join(&columns, "_"));
        /* 같은 column의 foreign key가 이미 더한 index는 다시 더하지 않는다. */
        bool indexed = false;
        for (size_t k = 0; k < ct->indexes.n; k++) {
            indexed = indexed || str_eq(ct->indexes.v[k].name, index);
        }
        /* array_slice($ct->primary, 0, count($columns)) === $columns */
        bool leading = ct->primary.n >= columns.n;
        for (size_t k = 0; leading && k < columns.n; k++) {
            leading = str_eq(ct->primary.v[k], columns.v[k]);
        }
        if (!leading && !indexed) {
            ikey x = {index, columns, {0}};
            for (size_t k = 0; k < columns.n; k++) {
                PUSH(x.desc, false);
            }
            PUSH(ct->indexes, x);
            catalog_report(c, SL("index"), child, index, SL("Mermaid has no indexes; the foreign key needs one"));
        }
    }
    SMAP_EACH(&by_name, i) {
        entity *e = by_name.e[i].val;
        for (size_t k = 0; k < e->attributes.n; k++) {
            attribute *a = &e->attributes.v[k];
            smap *used = smap_get(&used_fks, e->name);
            if (has_key(a, "FK") && !(used != NULL && smap_has(used, a->name)) && catalog_table(c, e->name) != NULL) {
                catalog_report(c, SL("foreign_key"), e->name, a->name, SL("no relationship gives the foreign key of this FK attribute"));
            }
        }
    }
    document *d = catalog_document(c, name, dropped);
    if (d == NULL && EG(exception) != NULL && instanceof_function(EG(exception)->ce, spl_ce_RuntimeException)) {
        /* catalog가 문서를 만들지 못하면 import의 mermaid diagnostic이다. */
        zval rv;
        zval *message = zend_read_property_ex(zend_ce_exception, EG(exception), ZSTR_KNOWN(ZEND_STR_MESSAGE), true, &rv);
        zend_string *text_of = zval_get_string(message);
        str m = str_z(text_of);
        zend_string_release(text_of);
        zend_clear_exception();
        PUSH(*out, mkdiag(SL("mermaid"), 1, 1, m));
        return NULL;
    }
    return d;
}
