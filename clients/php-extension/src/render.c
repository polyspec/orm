/*
 * 문서 집합의 table을 만드는 statement를 한 dialect로 쓴다(PHP client Renderer, docs/dialects.md "Rendered
 * statements"). 실패는 InvalidArgumentException이고, 실패 뒤의 계산 결과는 호출자가 버린다.
 */
#include "dbspec.h"
#include "ext/spl/spl_exceptions.h"

const char *const dbs_dialect_names[3] = {"mysql", "postgres", "sqlite"};

#define UUID_PATTERN "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

bool dbs_dialect(str name, dialect *out)
{
    for (int i = 0; i < 3; i++) {
        if (str_eqc(name, dbs_dialect_names[i])) {
            *out = (dialect)i;
            return true;
        }
    }
    return dbs_throw(spl_ce_InvalidArgumentException, fmt("Unknown dialect `%S`; the dialects are mysql, postgres and sqlite", name));
}

static bool invalid(const char *what, str detail)
{
    return dbs_throw(spl_ce_InvalidArgumentException, fmt("%s%S", what, detail));
}

str r_q(const renderer *r, str name)
{
    return r->d == D_MYSQL ? fmt("`%S`", name) : fmt("\"%S\"", name);
}

str r_list(const renderer *r, const strs *names)
{
    sbuf b = {0};
    for (size_t i = 0; i < names->n; i++) {
        if (i > 0) {
            sb_c(&b, ", ");
        }
        sb_s(&b, r_q(r, names->v[i]));
    }
    return sb_str(&b);
}

#define BYNAME(T) \
    static int byname_##T(const void *a, const void *b, void *ctx) \
    { \
        (void)ctx; \
        return str_cmp((*(T *const *)a)->name, (*(T *const *)b)->name); \
    } \
    static T **sorted_##T(T *const *items, size_t n) \
    { \
        T **copy = dbs_alloc(n * sizeof(T *) + 1); \
        if (n > 0) memcpy(copy, items, n * sizeof(T *)); \
        dbs_sort(copy, n, sizeof(T *), byname_##T, NULL); \
        return copy; \
    }

BYNAME(ukey)
BYNAME(xindex)
BYNAME(fkey)
BYNAME(check)

str r_type_text(renderer *r, const ctype *t)
{
    str n = t->name;
    zend_long p0 = t->np > 0 ? t->p[0] : 0, p1 = t->np > 1 ? t->p[1] : 0;
#define IS(x) str_eqc(n, x)
    switch (r->d) {
        case D_MYSQL:
            if (IS("i16")) return SL("SMALLINT");
            if (IS("i32")) return SL("INT");
            if (IS("i64")) return SL("BIGINT");
            if (IS("bool")) return SL("tinyint(1)");
            if (IS("decimal")) return fmt("DECIMAL(%d,%d)", p0, p1);
            if (IS("f64")) return SL("DOUBLE");
            if (IS("varchar")) return fmt("varchar(%d) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin", p0);
            if (IS("text")) return SL("LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin");
            if (IS("bytes")) return SL("LONGBLOB");
            if (IS("uuid")) return SL("char(36) CHARACTER SET ascii COLLATE ascii_bin");
            if (IS("date")) return SL("DATE");
            if (IS("time")) return fmt("TIME(%d)", p0);
            if (IS("datetime")) return fmt("DATETIME(%d)", p0);
            break;
        case D_POSTGRES:
            if (IS("i16")) return SL("smallint");
            if (IS("i32")) return SL("integer");
            if (IS("i64")) return SL("bigint");
            if (IS("bool")) return SL("boolean");
            if (IS("decimal")) return fmt("numeric(%d,%d)", p0, p1);
            if (IS("f64")) return SL("double precision");
            if (IS("varchar")) return fmt("varchar(%d) COLLATE \"C\"", p0);
            if (IS("text")) return SL("text COLLATE \"C\"");
            if (IS("bytes")) return SL("bytea");
            if (IS("uuid")) return SL("uuid");
            if (IS("date")) return SL("date");
            if (IS("time")) return fmt("time(%d)", p0);
            if (IS("datetime")) return fmt("timestamp(%d)", p0);
            break;
        case D_SQLITE:
            if (IS("i16")) return SL("smallint");
            if (IS("i32")) return SL("integer");
            if (IS("i64")) return SL("bigint");
            if (IS("bool")) return SL("BOOLEAN");
            if (IS("decimal")) return fmt("DECIMALINT(%d,%d)", p0, p1);
            if (IS("f64")) return SL("REAL");
            if (IS("varchar")) return fmt("varchar(%d)", p0);
            if (IS("text") || IS("uuid")) return SL("TEXT");
            if (IS("bytes")) return SL("BLOB");
            if (IS("date")) return SL("DATE");
            if (IS("time")) return SL("TIME");
            if (IS("datetime")) return SL("DATETIME");
            break;
    }
#undef IS
    invalid("Unknown column type ", ctype_text(t));
    return SL("");
}

/* canonical decimal literal × 10^scale: 소수점과 앞의 0을 뺀 숫자다. */
static str scaled_decimal(str text)
{
    bool negative = str_starts(text, "-");
    str unsigned_text = negative ? str_sub(text, 1, text.n - 1) : text;
    str digits = str_replace(unsigned_text, ".", "");
    size_t i = 0;
    while (i < digits.n && digits.s[i] == '0') {
        i++;
    }
    digits = str_sub(digits, i, digits.n - i);
    if (digits.n == 0) {
        return SL("0");
    }
    return negative ? fmt("-%S", digits) : digits;
}

/* column type t의 canonical literal을 dialect 형식으로 쓴다. */
static str r_literal(renderer *r, const ctype *t, str text)
{
    if (str_eqc(text, "true") || str_eqc(text, "false")) {
        if (r->d == D_POSTGRES) {
            return str_upper(text);
        }
        return str_eqc(text, "true") ? SL("1") : SL("0");
    }
    if (str_starts(text, "'")) {
        return r->d == D_MYSQL ? str_replace(text, "\\", "\\\\") : text;
    }
    if (str_eqc(t->name, "decimal") && r->d == D_SQLITE) {
        return scaled_decimal(text);
    }
    return text;
}

str r_default_text(renderer *r, const ctype *t, str def)
{
    if (!str_eqc(def, "now")) {
        return r_literal(r, t, def);
    }
    zend_long p = t->np > 0 ? t->p[0] : 0;
    if (r->d == D_MYSQL) {
        return fmt("CURRENT_TIMESTAMP(%d)", p);
    }
    if (r->d == D_POSTGRES) {
        return SL("statement_timestamp()");
    }
    if (p == 0) {
        return SL("(strftime('%Y-%m-%d %H:%M:%S', 'now'))");
    }
    if (p <= 3) {
        return fmt("(substr(strftime('%%Y-%%m-%%d %%H:%%M:%%f', 'now'), 1, %d))", 20 + p);
    }
    return fmt("(strftime('%%Y-%%m-%%d %%H:%%M:%%f', 'now') || '%S')", str_repeat("0", (size_t)(p - 3)));
}

str r_column(renderer *r, const column *c)
{
    if (c->identity) {
        const char *tail = r->d == D_MYSQL ? " BIGINT NOT NULL AUTO_INCREMENT"
            : r->d == D_POSTGRES ? " bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL" : " INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT";
        return fmt("%S%s", r_q(r, c->name), tail);
    }
    sbuf b = {0};
    sb_fmt(&b, "%S %S%s", r_q(r, c->name), r_type_text(r, c->type), c->nullable ? " NULL" : " NOT NULL");
    if (c->has_default) {
        sb_fmt(&b, " DEFAULT %S", r_default_text(r, c->type, c->def));
    }
    return sb_str(&b);
}

static str action(str a)
{
    if (str_eqc(a, "restrict")) return SL("RESTRICT");
    if (str_eqc(a, "cascade")) return SL("CASCADE");
    if (str_eqc(a, "set_null")) return SL("SET NULL");
    dbs_throw(spl_ce_InvalidArgumentException, fmt("Unknown foreign key action `%S`", a));
    return SL("");
}

str r_foreign_key(renderer *r, const fkey *f)
{
    return fmt("CONSTRAINT %S FOREIGN KEY (%S) REFERENCES %S (%S) ON DELETE %S ON UPDATE %S", r_q(r, f->name), r_list(r, &f->columns),
        r_q(r, f->table), r_list(r, &f->refs), action(f->on_delete), action(f->on_update));
}

str r_type_check(renderer *r, const column *c)
{
    if (c->identity) {
        return SL("");
    }
    str q = r_q(r, c->name);
    const ctype *t = c->type;
#define IS(x) str_eqc(t->name, x)
    if (r->d == D_MYSQL) {
        if (IS("bool")) return fmt("%S IN (0, 1)", q);
        if (IS("uuid")) return fmt("REGEXP_LIKE(%S, '" UUID_PATTERN "', 'c')", q);
        if (IS("time")) return fmt("%S >= '00:00:00' AND %S < '24:00:00'", q, q);
        return SL("");
    }
    if (r->d == D_POSTGRES) {
        return IS("time") ? fmt("%S < '24:00:00'", q) : SL("");
    }
    str integer = fmt("typeof(%S) IN ('integer', 'null')", q);
    if (IS("i16")) return fmt("%S AND %S BETWEEN -32768 AND 32767", integer, q);
    if (IS("i32")) return fmt("%S AND %S BETWEEN -2147483648 AND 2147483647", integer, q);
    if (IS("i64")) return integer;
    if (IS("bool")) return fmt("%S IN (0, 1)", q);
    if (IS("decimal")) {
        str limit = str_repeat("9", (size_t)t->p[0]);
        return fmt("%S AND %S BETWEEN -%S AND %S", integer, q, limit, limit);
    }
    if (IS("f64")) return fmt("typeof(%S) IN ('real', 'null')", q);
    if (IS("varchar")) return fmt("length(%S) <= %d", q, t->p[0]);
    if (IS("uuid")) {
        str h8 = str_repeat("[0-9a-f]", 8), h4 = str_repeat("[0-9a-f]", 4), h12 = str_repeat("[0-9a-f]", 12);
        return fmt("%S GLOB '%S-%S-%S-%S-%S'", q, h8, h4, h4, h4, h12);
    }
    if (IS("date")) return fmt("%S IS date(%S)", q, q);
    if (IS("time")) {
        zend_long p = t->p[0];
        if (p == 0) {
            return fmt("%S IS time(%S) AND %S < '24:00:00'", q, q, q);
        }
        str clock = fmt("substr(%S, 1, 8)", q);
        return fmt("length(%S) = %d AND %S IS time(%S) AND %S < '24:00:00' AND substr(%S, 9, 1) = '.' AND substr(%S, 10) GLOB '%S'",
            q, 9 + p, clock, clock, clock, q, q, str_repeat("[0-9]", (size_t)p));
    }
    if (IS("datetime")) {
        zend_long p = t->p[0];
        if (p == 0) {
            return fmt("length(%S) = 19 AND %S IS datetime(%S) AND substr(%S, 12, 2) < '24'", q, q, q, q);
        }
        str stamp = fmt("substr(%S, 1, 19)", q);
        return fmt("length(%S) = %d AND %S IS datetime(%S) AND substr(%S, 12, 2) < '24' AND substr(%S, 20, 1) = '.' AND substr(%S, 21) GLOB '%S'",
            q, 20 + p, stamp, stamp, q, q, q, str_repeat("[0-9]", (size_t)p));
    }
#undef IS
    return SL("");
}

/* ------------------------------------------------------------- check text */

static bool word_char(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static bool digit(char c)
{
    return c >= '0' && c <= '9';
}

/* `\G(?:'(?:[^']|'')*'|<>|<=|>=|[=<>(),]|-?[0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9_])|[A-Za-z0-9_]+)`의 길이, 없으면 0. */
static size_t check_token(str s, size_t i)
{
    char c = s.s[i];
    if (c == '\'') {
        /* 되돌아가는 반복이다: 반복이 끝까지 가서 닫는 따옴표가 없으면 마지막 '' 쌍의 첫 따옴표에서 닫는다. */
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
    if (i + 1 < s.n && ((c == '<' && s.s[i + 1] == '>') || (c == '<' && s.s[i + 1] == '=') || (c == '>' && s.s[i + 1] == '='))) {
        return 2;
    }
    if (c == '=' || c == '<' || c == '>' || c == '(' || c == ')' || c == ',') {
        return 1;
    }
    size_t k = i;
    if (c == '-') {
        k++;
    }
    if (k < s.n && digit(s.s[k])) {
        size_t d = k;
        while (d < s.n && digit(s.s[d])) {
            d++;
        }
        if (d + 1 < s.n && s.s[d] == '.' && digit(s.s[d + 1])) {
            size_t f = d + 1;
            while (f < s.n && digit(s.s[f])) {
                f++;
            }
            if (f >= s.n || !word_char(s.s[f])) {
                return f - i;
            }
        }
        if (d >= s.n || !word_char(s.s[d])) {
            return d - i;
        }
    }
    if (word_char(c)) {
        size_t w = i;
        while (w < s.n && word_char(s.s[w])) {
            w++;
        }
        return w - i;
    }
    return 0;
}

static void check_invalid(renderer *r, str problem)
{
    if (!r->failed) {
        r->failed = true;
        dbs_throw(spl_ce_InvalidArgumentException, fmt("Table %S check %S is not a canonical predicate: %S",
            r->table != NULL ? r->table->name : SL(""), r->check_name, problem));
    }
}

static const str *cpeek(renderer *r, size_t ahead)
{
    size_t i = r->at + ahead;
    return i < r->tokens.n ? &r->tokens.v[i] : NULL;
}

static bool cpeek_is(renderer *r, size_t ahead, const char *s)
{
    const str *t = cpeek(r, ahead);
    return t != NULL && str_eqc(*t, s);
}

static void cexpect(renderer *r, const char *t)
{
    if (!cpeek_is(r, 0, t)) {
        const str *f = cpeek(r, 0);
        check_invalid(r, fmt("expected `%s`, found `%S`", t, f != NULL ? *f : SL("the end")));
        return;
    }
    r->at++;
}

typedef struct {
    bool is_column;
    const column *col;
    str text;
} coperand;

static const char *const ckeywords[] = {"and", "or", "not", "in", "between", "is", "null", "true", "false", NULL};

static bool ckeyword(str s)
{
    for (int i = 0; ckeywords[i] != NULL; i++) {
        if (str_eqc(s, ckeywords[i])) {
            return true;
        }
    }
    return false;
}

static coperand check_literal(renderer *r)
{
    const str *t = cpeek(r, 0);
    str v;
    if (t == NULL || (!str_eqc(*t, "true") && !str_eqc(*t, "false") && !literal_number(*t, NULL) && !literal_string_value(*t, &v))) {
        check_invalid(r, fmt("expected a literal, found `%S`", t != NULL ? *t : SL("the end")));
        coperand none = {false, NULL, SL("")};
        return none;
    }
    r->at++;
    coperand o = {false, NULL, *t};
    return o;
}

static coperand coperand_read(renderer *r)
{
    const str *t = cpeek(r, 0);
    if (t != NULL && str_word(*t) && !str_digits(*t) && !ckeyword(*t)) {
        r->at++;
        const column *c = table_column(r->table, *t);
        if (c == NULL) {
            check_invalid(r, fmt("`%S` is not a column of the table", *t));
        }
        coperand o = {true, c, *t};
        return o;
    }
    return check_literal(r);
}

static const ctype *operand_type(renderer *r, const coperand *a, const coperand *b)
{
    if (a->is_column && a->col != NULL) {
        return a->col->type;
    }
    if (b != NULL && b->is_column && b->col != NULL) {
        return b->col->type;
    }
    if (!a->is_column && !(b != NULL && b->is_column)) {
        check_invalid(r, SL("a predicate has no column operand"));
    }
    return NULL;
}

static str coperand_text(renderer *r, const ctype *type, const coperand *o, bool needs_type)
{
    if (o->is_column) {
        return r_q(r, o->col != NULL ? o->col->name : o->text);
    }
    if (type == NULL) {
        if (needs_type) {
            check_invalid(r, fmt("literal `%S` meets no column", o->text));
        }
        return o->text;
    }
    return r_literal(r, type, o->text);
}

static str cdisjunction(renderer *r);

static str cpredicate(renderer *r)
{
    coperand left = coperand_read(r);
    const str *next = cpeek(r, 0);
    if (next != NULL && (str_eqc(*next, "=") || str_eqc(*next, "<>") || str_eqc(*next, "<") || str_eqc(*next, "<=") || str_eqc(*next, ">") || str_eqc(*next, ">="))) {
        str op = *next;
        r->at++;
        coperand right = coperand_read(r);
        const ctype *type = operand_type(r, &left, &right);
        return fmt("%S %S %S", coperand_text(r, type, &left, true), op, coperand_text(r, type, &right, true));
    }
    bool negated = next != NULL && str_eqc(*next, "not") && cpeek_is(r, 1, "in");
    if (negated) {
        r->at++;
        next = cpeek(r, 0);
    }
    if (next != NULL && str_eqc(*next, "in")) {
        const ctype *type = operand_type(r, &left, NULL);
        r->at++;
        cexpect(r, "(");
        sbuf b = {0};
        coperand first = check_literal(r);
        sb_s(&b, coperand_text(r, type, &first, true));
        while (cpeek_is(r, 0, ",") && !r->failed) {
            r->at++;
            coperand item = check_literal(r);
            sb_c(&b, ", ");
            sb_s(&b, coperand_text(r, type, &item, true));
        }
        cexpect(r, ")");
        return fmt("%S%s IN (%S)", coperand_text(r, type, &left, true), negated ? " NOT" : "", sb_str(&b));
    }
    if (next != NULL && str_eqc(*next, "is")) {
        r->at++;
        bool is_not = cpeek_is(r, 0, "not");
        if (is_not) {
            r->at++;
        }
        cexpect(r, "null");
        return fmt("%S%s", coperand_text(r, NULL, &left, true), is_not ? " IS NOT NULL" : " IS NULL");
    }
    check_invalid(r, fmt("`%S` alone is not a predicate", left.text));
    return SL("");
}

static str cgroup(renderer *r)
{
    if (cpeek_is(r, 0, "(")) {
        r->at++;
        str text = fmt("(%S)", cdisjunction(r));
        cexpect(r, ")");
        return text;
    }
    return cpredicate(r);
}

static str cconjunction(renderer *r)
{
    sbuf b = {0};
    sb_s(&b, cgroup(r));
    while (cpeek_is(r, 0, "and") && !r->failed) {
        r->at++;
        sb_fmt(&b, " AND %S", cgroup(r));
    }
    return sb_str(&b);
}

static str cdisjunction(renderer *r)
{
    sbuf b = {0};
    sb_s(&b, cconjunction(r));
    while (cpeek_is(r, 0, "or") && !r->failed) {
        r->at++;
        sb_fmt(&b, " OR %S", cconjunction(r));
    }
    return sb_str(&b);
}

/* canonical check text를 dialect 형식으로 쓴다: column은 인용하고 keyword는 대문자로, literal은 그것이 만나는
 * column의 type으로 쓴다. */
str r_check_text(renderer *r, const table *t, const check *k)
{
    renderer *c = dbs_alloc(sizeof *c);
    c->d = r->d;
    c->table = t;
    c->check_name = k->name;
    str e = k->expression;
    size_t offset = 0;
    while (offset < e.n) {
        if (e.s[offset] == ' ') {
            offset++;
            continue;
        }
        size_t len = check_token(e, offset);
        if (len == 0) {
            check_invalid(c, fmt("unexpected text at byte %u", offset));
            return SL("");
        }
        PUSH(c->tokens, str_sub(e, offset, len));
        offset += len;
    }
    str text = cdisjunction(c);
    if (!c->failed && c->at < c->tokens.n) {
        check_invalid(c, fmt("unexpected `%S`", c->tokens.v[c->at]));
    }
    return text;
}

/* ------------------------------------------------------------------ tables */

/* table t를 name으로 만드는 CREATE TABLE이다. check_name은 column의 renderer CHECK 이름이고, hidden은 t의 column
 * 뒤에 nullable이며 CHECK 없이 더하는 column이다. */
str r_create_table(renderer *r, const table *t, str name, str (*check_name)(void *, str), void *ctx, const columnv *hidden)
{
    strs parts = {0};
    bool identity = false;
    for (size_t i = 0; i < t->columns.n; i++) {
        PUSH(parts, r_column(r, t->columns.v[i]));
        identity = identity || t->columns.v[i]->identity;
    }
    for (size_t i = 0; hidden != NULL && i < hidden->n; i++) {
        const column *h = hidden->v[i];
        column *c = column_new(h->name, h->type, true, false, h->has_default ? &h->def : NULL);
        PUSH(parts, r_column(r, c));
    }
    if (t->pk == NULL) {
        invalid("Table ", fmt("%S has no primary key", t->name));
        return SL("");
    }
    if (!(r->d == D_SQLITE && identity)) {
        PUSH(parts, fmt("PRIMARY KEY (%S)", r_list(r, &t->pk->columns)));
    }
    if (r->d != D_SQLITE) {
        ukey **u = sorted_ukey(t->uniques.v, t->uniques.n);
        for (size_t i = 0; i < t->uniques.n; i++) {
            PUSH(parts, fmt("CONSTRAINT %S UNIQUE (%S)", r_q(r, u[i]->name), r_list(r, &u[i]->columns)));
        }
    } else {
        fkey **f = sorted_fkey(t->fks.v, t->fks.n);
        for (size_t i = 0; i < t->fks.n; i++) {
            PUSH(parts, r_foreign_key(r, f[i]));
        }
    }
    for (size_t i = 0; i < t->columns.n; i++) {
        str check = r_type_check(r, t->columns.v[i]);
        if (check.n > 0) {
            PUSH(parts, fmt("CONSTRAINT %S CHECK (%S)", r_q(r, check_name(ctx, t->columns.v[i]->name)), check));
        }
    }
    check **k = sorted_check(t->checks.v, t->checks.n);
    for (size_t i = 0; i < t->checks.n; i++) {
        PUSH(parts, fmt("CONSTRAINT %S CHECK (%S)", r_q(r, k[i]->name), r_check_text(r, t, k[i])));
    }
    str create = fmt("CREATE TABLE %S (%S)", r_q(r, name), strs_join(&parts, ", "));
    if (r->d == D_MYSQL) {
        create = fmt("%S ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin", create);
    }
    return create;
}

str r_table_check_name(void *ctx, str column)
{
    return fmt("%S$%S", ((const table *)ctx)->name, column);
}

strs r_table(renderer *r, const table *t)
{
    strs out = {0};
    PUSH(out, r_create_table(r, t, t->name, r_table_check_name, (void *)t, NULL));
    if (r->d == D_SQLITE) {
        ukey **u = sorted_ukey(t->uniques.v, t->uniques.n);
        for (size_t i = 0; i < t->uniques.n; i++) {
            PUSH(out, fmt("CREATE UNIQUE INDEX %S ON %S (%S)", r_q(r, u[i]->name), r_q(r, t->name), r_list(r, &u[i]->columns)));
        }
    }
    xindex **x = sorted_xindex(t->indexes.v, t->indexes.n);
    for (size_t i = 0; i < t->indexes.n; i++) {
        PUSH(out, fmt("CREATE INDEX %S ON %S (%S)", r_q(r, x[i]->name), r_q(r, t->name), r_index_columns(r, x[i])));
    }
    return out;
}

str r_index_columns(renderer *r, const xindex *x)
{
    sbuf b = {0};
    for (size_t k = 0; k < x->columns.n; k++) {
        if (k > 0) {
            sb_c(&b, ", ");
        }
        sb_s(&b, r_q(r, x->columns.v[k].name));
        if (x->columns.v[k].descending) {
            sb_c(&b, " DESC");
        }
    }
    return sb_str(&b);
}

/* ---------------------------------------------------------------- triggers */

/* <table>$<event> trigger의 본문은 statement 하나다. PostgreSQL은 같은 이름의 함수로 감싼다. */
static void trigger(renderer *r, const table *t, const char *event, const char *timing, str body, bool rejects, strs *out)
{
    str name = r_q(r, fmt("%S$%s", t->name, event));
    str on = fmt(" %s ON %S FOR EACH ROW ", timing, r_q(r, t->name));
    switch (r->d) {
        case D_MYSQL:
            PUSH(*out, fmt("CREATE TRIGGER %S%S%S", name, on, body));
            break;
        case D_POSTGRES:
            PUSH(*out, fmt("CREATE FUNCTION %S() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN %S; %sEND$$", name, body, rejects ? "" : "RETURN NULL; "));
            PUSH(*out, fmt("CREATE TRIGGER %S%SEXECUTE FUNCTION %S()", name, on, name));
            break;
        case D_SQLITE:
            PUSH(*out, fmt("CREATE TRIGGER %S%SBEGIN %S; END", name, on, body));
            break;
    }
}

static void reject(renderer *r, const table *t, const char *event, const char *timing, str message, strs *out)
{
    str body = r->d == D_MYSQL ? fmt("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '%S'", message)
        : r->d == D_POSTGRES ? fmt("RAISE EXCEPTION '%S'", message) : fmt("SELECT RAISE(ABORT, '%S')", message);
    trigger(r, t, event, timing, body, true, out);
}

static void history(renderer *r, const table *t, const setting *audit, const char *event, const char *timing, str action_value, str previous_value, strs *out)
{
    strs columns = {0}, values = {0};
    PUSH(columns, r_q(r, audit->args.v[3]));
    PUSH(columns, r_q(r, audit->args.v[4]));
    PUSH(values, action_value);
    PUSH(values, previous_value);
    for (size_t i = 0; i < t->columns.n; i++) {
        str name = t->columns.v[i]->name;
        if (!setting_records(audit, name)) {
            continue;
        }
        PUSH(columns, r_q(r, name));
        PUSH(values, fmt("NEW.%S", r_q(r, name)));
    }
    str body = fmt("INSERT INTO %S (%S) VALUES (%S)", r_q(r, audit->args.v[0]), strs_join(&columns, ", "), strs_join(&values, ", "));
    trigger(r, t, event, timing, body, false, out);
}

strs r_triggers(renderer *r, const table *t)
{
    strs out = {0};
    if (t->settings == NULL) {
        return out;
    }
    bool immutable = false;
    const setting *audit = NULL;
    for (size_t i = 0; i < t->settings->list.n; i++) {
        const setting *s = t->settings->list.v[i];
        if (str_eqc(s->kind, "immutable")) {
            immutable = true;
        } else if (str_eqc(s->kind, "audit")) {
            audit = s;
        }
    }
    if (immutable) {
        str message = fmt("table %S is immutable", t->name);
        reject(r, t, "immutable_update", "BEFORE UPDATE", message, &out);
        reject(r, t, "immutable_delete", "BEFORE DELETE", message, &out);
    }
    if (audit != NULL && audit->args.n >= 5) {
        history(r, t, audit, "audit_insert", "AFTER INSERT", SL("'insert'"), SL("NULL"), &out);
        history(r, t, audit, "audit_update", "AFTER UPDATE", SL("'update'"), fmt("OLD.%S", r_q(r, audit->args.v[1])), &out);
        reject(r, t, "audit_delete", "BEFORE DELETE", fmt("table %S deletes through its soft delete column", t->name), &out);
    }
    return out;
}

/* ------------------------------------------------------------- statements */

static void visit(str name, const smap *by_name, smap *done, documentv *out)
{
    if (smap_has(done, name)) {
        return;
    }
    smap_set(done, name, TRUEP);
    document *d = smap_get(by_name, name);
    strs used = {0};
    for (size_t i = 0; i < d->uses.n; i++) {
        PUSH(used, d->uses.v[i]->document);
    }
    strs_sort(&used);
    for (size_t i = 0; i < used.n; i++) {
        /* 집합 밖의 문서는 DocumentSet 검사가 거부하므로 여기 오지 않는다. */
        if (smap_has(by_name, used.v[i])) {
            visit(used.v[i], by_name, done, out);
        }
    }
    PUSH(*out, d);
}

/* 사용되는 문서가 그것을 사용하는 문서보다 먼저, 같은 순위는 문서 이름 순이다. */
static documentv use_order(const documentv *documents)
{
    smap by_name = {0};
    for (size_t i = 0; i < documents->n; i++) {
        smap_set(&by_name, documents->v[i]->name, documents->v[i]);
    }
    strs names = {0};
    smap_keys_sorted(&by_name, &names);
    smap done = {0};
    documentv out = {0};
    for (size_t i = 0; i < names.n; i++) {
        visit(names.v[i], &by_name, &done, &out);
    }
    return out;
}

void render_statements(const documentv *documents, dialect d, renderedv *out)
{
    renderer r = {0};
    r.d = d;
    documentv all = use_order(documents);
    documentv ordered = {0};
    for (size_t i = 0; i < all.n; i++) {
        if (!all.v[i]->external) {
            PUSH(ordered, all.v[i]);
        }
    }
#define ADD(tname, list) do { strs l_ = (list); for (size_t k_ = 0; k_ < l_.n; k_++) PUSH(*out, ((rendered){l_.v[k_], (tname)})); } while (0)
    for (size_t i = 0; i < ordered.n; i++) {
        for (size_t k = 0; k < ordered.v[i]->tables.n; k++) {
            table *t = ordered.v[i]->tables.v[k];
            ADD(t->name, r_table(&r, t));
        }
    }
    if (d != D_SQLITE) {
        for (size_t i = 0; i < ordered.n; i++) {
            for (size_t k = 0; k < ordered.v[i]->tables.n; k++) {
                table *t = ordered.v[i]->tables.v[k];
                fkey **f = sorted_fkey(t->fks.v, t->fks.n);
                for (size_t x = 0; x < t->fks.n; x++) {
                    PUSH(*out, ((rendered){fmt("ALTER TABLE %S ADD %S", r_q(&r, t->name), r_foreign_key(&r, f[x])), t->name}));
                }
            }
        }
    }
    for (size_t i = 0; i < ordered.n; i++) {
        for (size_t k = 0; k < ordered.v[i]->tables.n; k++) {
            table *t = ordered.v[i]->tables.v[k];
            ADD(t->name, r_triggers(&r, t));
        }
    }
#undef ADD
}
