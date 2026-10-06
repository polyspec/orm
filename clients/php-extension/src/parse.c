/*
 * dbspec 문서 하나를 줄 단위로 읽고 검증한다(PHP client Parser, docs/dbspec.md). 줄 안의 rule은 그 줄에서, table
 * 전체의 rule은 block이 닫힐 때, table 사이의 rule(foreign key 대상, audit history와 기록 table)은 마지막 줄 뒤에
 * 확인한다. diagnostic은 token의 줄과 칸(Unicode code point)을 가지며 줄, 칸, rule 표 순서로 정렬한다. encoding,
 * header, 한도 error는 parse를 멈추고 그 앞에서 찾은 diagnostic 뒤에 온다.
 */
#include "dbspec.h"
#include <setjmp.h>

#define MAX_BYTES (32 * 1024 * 1024)
#define MAX_TABLES 4096
#define MAX_COLUMNS 120000
#define MAX_FOREIGN_KEYS 20000
#define MAX_TABLE_COLUMNS 1000
#define MAX_KEY_COLUMNS 16
#define MAX_KEY_VARCHAR 640

static const char *const rules[] = {
    "header", "syntax", "order", "name.format", "name.length", "name.duplicate", "type", "column", "key",
    "foreign_key", "check", "setting", "use", "diagram", "limit", "encoding", NULL,
};

zend_long dbs_rule_rank(str rule)
{
    for (int i = 0; rules[i] != NULL; i++) {
        if (str_eqc(rule, rules[i])) {
            return i;
        }
    }
    return 99;
}

static const char *const simple_types[] = {"i16", "i32", "i64", "bool", "f64", "text", "bytes", "uuid", "date", NULL};
static const char *const text_stages[] = {"hex", "base64", "ordered_json", "yaml", "serialize", NULL};
static const char *const codec_stages[] = {"ordered_json", "aes", "hex", "gz", "base64", "serialize", "yaml", "ip", NULL};
static const char *const fk_actions[] = {"restrict", "cascade", "set_null", NULL};

static bool listed(str s, const char *const *list)
{
    for (int i = 0; list[i] != NULL; i++) {
        if (str_eqc(s, list[i])) {
            return true;
        }
    }
    return false;
}

static int parameterized(str name)
{
    if (str_eqc(name, "decimal")) {
        return 2;
    }
    if (str_eqc(name, "varchar") || str_eqc(name, "time") || str_eqc(name, "datetime")) {
        return 1;
    }
    return 0;
}

/* table 이름 => 정의와 column map. */
typedef struct {
    table *table;
    smap *columns;
} tentry;

/* 사용한 문서의 parse 결과다. */
typedef struct {
    document *doc;
    bool has_reason;
    str reason;
} used_entry;

/* [이름, 칸, 내림차순] */
typedef struct {
    str name;
    zend_long column;
    bool descending;
} lcol;

typedef VEC(lcol) lcols;

typedef struct {
    str name;
    zend_long line, column;
    bool rejected;
} identity_rec;

typedef struct {
    fkey *fk;
    zend_long line, column;
    bool known;
} tfk_rec;

typedef struct {
    check *check;
    zend_long line;
    tokens toks;
    zend_long end;
} tcheck_rec;

typedef struct {
    token keyword;
    VEC(token) columns;
} audit_list;

typedef VEC(audit_list) audit_lists;

typedef struct {
    str kind;
    tokens args;
    zend_long line, at;
    audit_lists lists;
} tsetting_rec;

typedef struct {
    smap *columns;
    fkey *fk;
    zend_long line, at, target_at;
    lcols parents;
    bool known;
} dfk_rec;

/* audit이 기록하는 column을 정한다. include이면 목록의 column만, 아니면 목록 밖의 column을 기록한다. */
typedef struct {
    bool include;
    str audit;
    smap listed;
} recorder;

typedef struct {
    table *audited;
    smap *columns;
    tokens args;
    ctype *audit_type;
    zend_long line;
    recorder *recorded;
} daudit_rec;

typedef struct {
    table *audited;
    column *col;
    tokens args;
    zend_long line;
    bool failed_keys;
} drecord_rec;

enum { S_TOP, S_TABLE, S_SETTINGS, S_DIAGRAM };

typedef struct parser {
    const smap *documents;
    strs using;
    smap *used;

    diags diagnostics;
    document *doc;
    smap tables;
    smap constraint_names, used_documents, diagram_names, failed_tables, used_table_names;
    smap syntax_lines;
    smap types;
    zend_long table_count, column_count, fk_count;

    zend_long line;
    str text;
    tokens t;
    strs comments;

    int state, top_phase;
    zend_long block_open[2], settings_open[2];
    table *table;
    zend_long table_name[2];
    int table_phase;
    smap *columns;
    smap invalid_types;
    VEC(identity_rec) identities;
    VEC(tfk_rec) table_fks;
    VEC(tcheck_rec) table_checks;
    VEC(tsetting_rec) table_settings;
    smap setting_keys;
    bool failed_primary;
    smap failed_key_tables;
    diagram *diagram;
    smap diagram_tables;

    VEC(dfk_rec) deferred_fks;
    VEC(daudit_rec) deferred_audits;
    VEC(drecord_rec) deferred_records;
    smap failed_primary_tables;

    jmp_buf stop_jump;
} parser;

static void error(parser *p, const char *rule, zend_long line, zend_long column, str message)
{
    if (strcmp(rule, "syntax") == 0) {
        str key = fmt("%d", line);
        if (smap_has(&p->syntax_lines, key)) {
            return;
        }
        smap_set(&p->syntax_lines, key, TRUEP);
    }
    PUSH(p->diagnostics, mkdiag(str_c(rule), line, column, message));
}

static ZEND_NORETURN void stop(parser *p, const char *rule, zend_long line, zend_long column, str message)
{
    PUSH(p->diagnostics, mkdiag(str_c(rule), line, column, message));
    longjmp(p->stop_jump, 1);
}

static strs take_comments(parser *p)
{
    strs c = p->comments;
    p->comments = (strs){0};
    return c;
}

static zend_long end_column(parser *p)
{
    return (zend_long)utf8_length(p->text) + 1;
}

static const token *tok(parser *p, size_t i)
{
    return i < p->t.n ? &p->t.v[i] : NULL;
}

static bool tok_is(parser *p, size_t i, const char *s)
{
    const token *t = tok(p, i);
    return t != NULL && str_eqc(t->text, s);
}

/* 이름 token의 형식과 길이를 확인한다. */
static bool name_ok(parser *p, str name, zend_long column)
{
    bool format = name.n > 0 && name.s[0] >= 'a' && name.s[0] <= 'z';
    for (size_t i = 1; format && i < name.n; i++) {
        char c = name.s[i];
        format = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
    }
    if (format) {
        for (int i = 0; dbs_reserved[i] != NULL; i++) {
            if (str_eqc(name, dbs_reserved[i])) {
                format = false;
            }
        }
    }
    if (!format) {
        error(p, "name.format", p->line, column, fmt("name `%S` does not match [a-z][a-z0-9_]* or is a reserved word", name));
        return false;
    }
    if (name.n > 63) {
        error(p, "name.length", p->line, column, fmt("name `%S` is longer than 63 bytes", name));
        return false;
    }
    return true;
}

static bool name_tok(parser *p, const token *t)
{
    return name_ok(p, t->text, t->column);
}

static void constraint_name(parser *p, const token *t)
{
    if (!name_tok(p, t)) {
        return;
    }
    if (smap_has(&p->constraint_names, t->text)) {
        error(p, "name.duplicate", p->line, t->column, fmt("constraint name `%S` is already used in the schema", t->text));
        return;
    }
    if (smap_has(&p->tables, t->text) || smap_has(&p->used_table_names, t->text)) {
        error(p, "name.duplicate", p->line, t->column, fmt("constraint name `%S` is the name of a table", t->text));
    }
    smap_set(&p->constraint_names, t->text, TRUEP);
}

static const token *word_at(parser *p, size_t i)
{
    const token *t = tok(p, i);
    if (t == NULL || !str_word(t->text)) {
        error(p, "syntax", p->line, t != NULL ? t->column : end_column(p),
            t == NULL ? SL("expected a name") : fmt("expected a name, found `%S`", t->text));
        return NULL;
    }
    return t;
}

static bool expect_at(parser *p, size_t i, const char *expected)
{
    const token *t = tok(p, i);
    if (t == NULL || !str_eqc(t->text, expected)) {
        error(p, "syntax", p->line, t != NULL ? t->column : end_column(p),
            t == NULL ? fmt("expected `%s`", expected) : fmt("expected `%s`, found `%S`", expected, t->text));
        return false;
    }
    return true;
}

static bool end_at(parser *p, size_t i)
{
    const token *t = tok(p, i);
    if (t != NULL) {
        error(p, "syntax", p->line, t->column, fmt("unexpected `%S`", t->text));
        return false;
    }
    return true;
}

/* `( <column> [asc|desc], ... )`를 token i부터 읽는다. */
static bool column_list(parser *p, size_t i, bool directions, lcols *out, size_t *next)
{
    if (!expect_at(p, i, "(")) {
        return false;
    }
    i++;
    lcols columns = {0};
    for (;;) {
        const token *name = word_at(p, i);
        if (name == NULL) {
            return false;
        }
        i++;
        bool descending = false;
        const token *n = tok(p, i);
        if (directions && n != NULL && (str_eqc(n->text, "asc") || str_eqc(n->text, "desc"))) {
            descending = str_eqc(n->text, "desc");
            i++;
            n = tok(p, i);
        }
        PUSH(columns, ((lcol){name->text, name->column, descending}));
        if (n != NULL && str_eqc(n->text, ",")) {
            i++;
            continue;
        }
        if (!expect_at(p, i, ")")) {
            return false;
        }
        *out = columns;
        *next = i + 1;
        return true;
    }
}

static strs lcol_names(const lcols *l)
{
    strs out = {0};
    for (size_t i = 0; i < l->n; i++) {
        PUSH(out, l->v[i].name);
    }
    return out;
}

/* ---------------------------------------------------------------- encoding */

size_t utf8_valid_prefix(str s)
{
    size_t i = 0;
    while (i < s.n) {
        unsigned char b = (unsigned char)s.s[i];
        size_t size;
        unsigned char low = 0x80, high = 0xBF;
        if (b < 0x80) {
            i++;
            continue;
        } else if (b >= 0xC2 && b <= 0xDF) {
            size = 2;
        } else if (b == 0xE0) {
            size = 3;
            low = 0xA0;
        } else if (b == 0xED) {
            size = 3;
            high = 0x9F;
        } else if (b >= 0xE1 && b <= 0xEF) {
            size = 3;
        } else if (b == 0xF0) {
            size = 4;
            low = 0x90;
        } else if (b >= 0xF1 && b <= 0xF3) {
            size = 4;
        } else if (b == 0xF4) {
            size = 4;
            high = 0x8F;
        } else {
            return i;
        }
        if (i + size > s.n) {
            return i;
        }
        unsigned char second = (unsigned char)s.s[i + 1];
        if (second < low || second > high) {
            return i;
        }
        for (size_t k = 2; k < size; k++) {
            unsigned char c = (unsigned char)s.s[i + k];
            if (c < 0x80 || c > 0xBF) {
                return i;
            }
        }
        i += size;
    }
    return i;
}

static void check_encoding(parser *p, str source)
{
    if (str_starts(source, "\xEF\xBB\xBF")) {
        stop(p, "encoding", 1, 1, SL("the document starts with a byte order mark"));
    }
    bool bad = false;
    size_t offset = 0;
    const char *message = NULL;
    size_t valid = utf8_valid_prefix(source);
    if (valid < source.n) {
        bad = true;
        offset = valid;
        message = "the document is not valid UTF-8";
    }
    for (size_t i = 0; i < source.n; i++) {
        if (source.s[i] == '\r' && (i + 1 >= source.n || source.s[i + 1] != '\n')) {
            if (!bad || i < offset) {
                bad = true;
                offset = i;
                message = "the document has a carriage return without a line feed";
            }
            break;
        }
    }
    if (bad) {
        size_t start = 0;
        zend_long line = 1;
        for (size_t i = 0; i < offset; i++) {
            if (source.s[i] == '\n') {
                line++;
                start = i + 1;
            }
        }
        stop(p, "encoding", line, (zend_long)utf8_length(str_sub(source, start, offset - start)) + 1, str_c(message));
    }
}

/* -------------------------------------------------------------------- lines */

static bool digitc(char c)
{
    return c >= '0' && c <= '9';
}

static bool wordc(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || digitc(c) || c == '_';
}

/* `[0-9]+\.[0-9]+|[A-Za-z0-9_]+|'(?:[^']|'')*+'|<=|>=|<>|[^ ]`의 token과 그 칸이다. */
static void tokenize(parser *p)
{
    str s = p->text;
    p->t = (tokens){0};
    zend_long column = 1;
    size_t i = 0;
    while (i < s.n) {
        char c = s.s[i];
        size_t len = 0;
        if (c == ' ') {
            i++;
            column++;
            continue;
        }
        if (digitc(c)) {
            size_t j = i;
            while (j < s.n && digitc(s.s[j])) {
                j++;
            }
            if (j < s.n && s.s[j] == '.' && j + 1 < s.n && digitc(s.s[j + 1])) {
                j++;
                while (j < s.n && digitc(s.s[j])) {
                    j++;
                }
                len = j - i;
            }
        }
        if (len == 0 && wordc(c)) {
            size_t j = i;
            while (j < s.n && wordc(s.s[j])) {
                j++;
            }
            len = j - i;
        }
        if (len == 0 && c == '\'') {
            /* 소유 반복이므로 '' 쌍은 되돌아가지 않는다. */
            size_t j = i + 1;
            for (;;) {
                if (j < s.n && s.s[j] != '\'') {
                    j++;
                } else if (j + 1 < s.n && s.s[j] == '\'' && s.s[j + 1] == '\'') {
                    j += 2;
                } else {
                    break;
                }
            }
            if (j < s.n && s.s[j] == '\'') {
                len = j + 1 - i;
            }
        }
        if (len == 0 && i + 1 < s.n && ((c == '<' && s.s[i + 1] == '=') || (c == '>' && s.s[i + 1] == '=') || (c == '<' && s.s[i + 1] == '>'))) {
            len = 2;
        }
        if (len == 0) {
            /* code point 하나 */
            unsigned char b = (unsigned char)c;
            len = b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
            if (i + len > s.n) {
                len = s.n - i;
            }
        }
        str text = str_sub(s, i, len);
        PUSH(p->t, ((token){text, column}));
        column += (zend_long)utf8_length(text);
        i += len;
    }
}

static void fail_column(parser *p, str name)
{
    if (!smap_has(p->columns, name)) {
        smap_set(p->columns, name, column_new(name, ctype_new(SL("invalid"), NULL, 0), false, false, NULL));
        smap_set(&p->invalid_types, name, TRUEP);
    }
}

static void fail_key(parser *p, bool primary)
{
    p->failed_primary = p->failed_primary || primary;
    smap_set(&p->failed_key_tables, p->table->name, TRUEP);
    if (primary) {
        smap_set(&p->failed_primary_tables, p->table->name, TRUEP);
    }
}

/* tab은 구분자가 아니다: 그 줄은 syntax error이고 더 읽지 않는다. 그 줄이 선언했을 column은 실패한 것으로 둔다. */
static bool tab_line(parser *p)
{
    for (size_t i = 0; i < p->t.n; i++) {
        if (!str_eqc(p->t.v[i].text, "\t")) {
            continue;
        }
        error(p, "syntax", p->line, p->t.v[i].column, SL("only the space character separates tokens"));
        str first = SL("");
        for (size_t k = 0; k < p->t.n; k++) {
            if (!str_eqc(p->t.v[k].text, "\t")) {
                first = p->t.v[k].text;
                break;
            }
        }
        if (p->state == S_TABLE && str_word(first)) {
            if (str_eqc(first, "primary")) {
                fail_key(p, true);
            } else if (str_eqc(first, "unique") || str_eqc(first, "index")) {
                fail_key(p, false);
            } else if (str_eqc(first, "foreign") || str_eqc(first, "check") || str_eqc(first, "settings")) {
                /* 아무것도 알지 않는다 */
            } else {
                fail_column(p, first);
            }
        }
        return true;
    }
    return false;
}

/* header error는 `dbspec 1 <name>`에서 벗어난 첫 글자, 빠진 부분이면 줄 끝의 다음 칸을 가리킨다. 그 앞은 모두
 * ASCII이므로 byte offset이 칸이다. */
static void header(parser *p)
{
    const char *prefix = "dbspec 1 ";
    size_t pn = strlen(prefix);
    size_t same = 0;
    while (same < pn && same < p->text.n && p->text.s[same] == prefix[same]) {
        same++;
    }
    if (same < pn) {
        stop(p, "header", 1, (zend_long)(same < p->text.n ? same : p->text.n) + 1, SL("the first line is exactly `dbspec 1 <document>`"));
    }
    size_t end = pn;
    while (end < p->text.n && wordc(p->text.s[end])) {
        end++;
    }
    if (end == pn || end < p->text.n) {
        stop(p, "header", 1, (zend_long)end + 1, SL("the first line is exactly `dbspec 1 <document>`"));
    }
    name_tok(p, &p->t.v[2]);
    p->doc = document_new(p->t.v[2].text);
}

static used_entry *used_document(parser *p, str name);

static void use_line(parser *p)
{
    const token *docname = word_at(p, 1);
    if (docname == NULL) {
        return;
    }
    if (!expect_at(p, 2, "{")) {
        return;
    }
    VEC(token) tables = {0};
    size_t i = 3;
    for (;;) {
        const token *t = word_at(p, i);
        if (t == NULL) {
            return;
        }
        PUSH(tables, *t);
        i++;
        if (tok_is(p, i, ",")) {
            i++;
            continue;
        }
        if (!expect_at(p, i, "}")) {
            return;
        }
        break;
    }
    if (!end_at(p, i + 1)) {
        return;
    }
    str name = docname->text;
    useline *u = dbs_alloc(sizeof *u);
    u->document = name;
    for (size_t k = 0; k < tables.n; k++) {
        PUSH(u->tables, tables.v[k].text);
    }
    u->comments = take_comments(p);
    PUSH(p->doc->uses, u);
#define FAILED() for (size_t k = 0; k < tables.n; k++) smap_set(&p->failed_tables, tables.v[k].text, TRUEP)
    if (!name_tok(p, docname)) {
        FAILED();
        return;
    }
    if (smap_has(&p->used_documents, name)) {
        error(p, "name.duplicate", p->line, docname->column, fmt("document `%S` is already used", name));
        FAILED();
        return;
    }
    smap_set(&p->used_documents, name, TRUEP);
    document *used = NULL;
    bool has_reason = false;
    str reason = SNULL;
    if (str_eq(name, p->doc->name)) {
        has_reason = true;
        reason = SL("a document cannot use itself");
    } else if (strs_has(&p->using, name)) {
        sbuf b = {0};
        sb_c(&b, "use cycle: ");
        for (size_t k = 0; k < p->using.n; k++) {
            sb_s(&b, p->using.v[k]);
            sb_c(&b, " -> ");
        }
        sb_fmt(&b, "%S -> %S", p->doc->name, name);
        has_reason = true;
        reason = sb_str(&b);
    } else if (!smap_has(p->documents, name)) {
        has_reason = true;
        reason = fmt("document `%S` is not in the declared document set", name);
    } else {
        used_entry *e = used_document(p, name);
        used = e->doc;
        has_reason = e->has_reason;
        reason = e->reason;
    }
    if (has_reason) {
        error(p, "use", p->line, docname->column, reason);
        FAILED();
        return;
    }
#undef FAILED
    bool repeated_found = false;
    str repeated = SNULL;
    for (size_t k = 0; k < used->tables.n; k++) {
        table *d = used->tables.v[k];
        smap_set(&p->used_table_names, d->name, TRUEP);
        strs names = {0};
        for (size_t x = 0; x < d->uniques.n; x++) PUSH(names, d->uniques.v[x]->name);
        for (size_t x = 0; x < d->indexes.n; x++) PUSH(names, d->indexes.v[x]->name);
        for (size_t x = 0; x < d->fks.n; x++) PUSH(names, d->fks.v[x]->name);
        for (size_t x = 0; x < d->checks.n; x++) PUSH(names, d->checks.v[x]->name);
        for (size_t x = 0; x < names.n; x++) {
            if (smap_has(&p->constraint_names, names.v[x]) && !repeated_found) {
                repeated_found = true;
                repeated = names.v[x];
            }
            smap_set(&p->constraint_names, names.v[x], TRUEP);
        }
    }
    if (repeated_found) {
        error(p, "name.duplicate", p->line, docname->column,
            fmt("document `%S` repeats the constraint name `%S` of an earlier used document", name, repeated));
    }
    for (size_t k = 0; k < tables.n; k++) {
        token *t = &tables.v[k];
        if (!name_tok(p, t)) {
            smap_set(&p->failed_tables, t->text, TRUEP);
            continue;
        }
        if (smap_has(&p->tables, t->text)) {
            error(p, "name.duplicate", p->line, t->column, fmt("table `%S` is already defined or used", t->text));
            continue;
        }
        table *definition = NULL;
        for (size_t x = 0; x < used->tables.n; x++) {
            if (str_eq(used->tables.v[x]->name, t->text)) {
                definition = used->tables.v[x];
                break;
            }
        }
        if (definition == NULL) {
            error(p, "use", p->line, t->column, fmt("document `%S` does not define table `%S`", name, t->text));
            smap_set(&p->failed_tables, t->text, TRUEP);
            continue;
        }
        tentry *e = dbs_alloc(sizeof *e);
        e->table = definition;
        e->columns = dbs_alloc(sizeof(smap));
        for (size_t x = 0; x < definition->columns.n; x++) {
            if (!smap_has(e->columns, definition->columns.v[x]->name)) {
                smap_set(e->columns, definition->columns.v[x]->name, definition->columns.v[x]);
            }
        }
        smap_set(&p->tables, t->text, e);
    }
}

static void open_table(parser *p)
{
    if (++p->table_count > MAX_TABLES) {
        stop(p, "limit", p->line, p->t.v[0].column, fmt("the document has more than %d tables", (zend_long)MAX_TABLES));
    }
    const token *n = tok(p, 1);
    token name;
    if (n == NULL || !str_word(n->text)) {
        error(p, "syntax", p->line, n != NULL ? n->column : end_column(p), SL("expected a table name"));
        name = (token){SL(""), p->t.v[0].column};
    } else {
        name = *n;
        name_tok(p, &name);
    }
    if (expect_at(p, 2, "{")) {
        end_at(p, 3);
    }
    table *t = table_new(name.text);
    t->comments = take_comments(p);
    PUSH(p->doc->tables, t);
    if (name.text.n > 0) {
        if (smap_has(&p->tables, name.text)) {
            error(p, "name.duplicate", p->line, name.column, fmt("table `%S` is already defined or used", name.text));
        } else {
            if (smap_has(&p->constraint_names, name.text)) {
                error(p, "name.duplicate", p->line, name.column, fmt("table `%S` is named like an index, key, foreign key or check", name.text));
            }
            tentry *e = dbs_alloc(sizeof *e);
            e->table = t;
            e->columns = dbs_alloc(sizeof(smap));
            smap_set(&p->tables, name.text, e);
        }
    }
    p->state = S_TABLE;
    p->block_open[0] = p->line;
    p->block_open[1] = p->t.n > 2 ? p->t.v[2].column : p->t.v[0].column;
    p->table = t;
    p->table_name[0] = p->line;
    p->table_name[1] = name.column;
    p->table_phase = 0;
    p->columns = dbs_alloc(sizeof(smap));
    p->invalid_types = (smap){0};
    p->identities.n = 0;
    p->table_fks = (typeof(p->table_fks)){0};
    p->table_checks = (typeof(p->table_checks)){0};
    p->table_settings = (typeof(p->table_settings)){0};
    p->identities = (typeof(p->identities)){0};
    p->setting_keys = (smap){0};
    p->failed_primary = false;
}

static ctype *intern_type(parser *p, str name, const zend_long *params, size_t np)
{
    ctype probe = {name, (zend_long *)params, np};
    str text = ctype_text(&probe);
    ctype *t = smap_get(&p->types, text);
    if (t == NULL) {
        t = ctype_new(name, params, np);
        smap_set(&p->types, text, t);
    }
    return t;
}

static size_t skip_parentheses(parser *p, size_t i)
{
    size_t count = p->t.n;
    while (i < count && !str_eqc(p->t.v[i].text, ")")) {
        i++;
    }
    return i + 1 < count ? i + 1 : count;
}

/* token i의 type을 읽는다. type이 잘못되면 NULL이다. */
static ctype *read_type(parser *p, size_t i, size_t *next)
{
    str name = p->t.v[i].text;
    zend_long column = p->t.v[i].column;
    bool paren = tok_is(p, i + 1, "(");
    bool simple = listed(name, simple_types);
    int arity = parameterized(name);
    if (simple && !paren) {
        *next = i + 1;
        return intern_type(p, name, NULL, 0);
    }
    if (arity == 0 || !paren) {
        error(p, "type", p->line, column, simple ? fmt("type `%S` has no parameters", name)
            : arity > 0 ? fmt("type `%S` needs its parameters", name) : fmt("unknown type `%S`", name));
        *next = paren ? skip_parentheses(p, i + 1) : i + 1;
        return NULL;
    }
    VEC(zend_long) params = {0};
    size_t j = i + 2;
    bool well_formed = false;
    while (j < p->t.n && str_digits(p->t.v[j].text)) {
        str digits = p->t.v[j].text;
        size_t lead = 0;
        while (lead < digits.n && digits.s[lead] == '0') {
            lead++;
        }
        zend_long value = digits.n - lead > 6 ? ZEND_LONG_MAX : ZEND_STRTOL(str_of(digits.s, digits.n).s, NULL, 10);
        PUSH(params, value);
        j++;
        if (tok_is(p, j, ",")) {
            j++;
            continue;
        }
        well_formed = tok_is(p, j, ")");
        break;
    }
    if (!well_formed) {
        error(p, "type", p->line, column, fmt("type `%S` has malformed parameters", name));
        *next = skip_parentheses(p, i + 1);
        return NULL;
    }
    j++;
    bool valid = (int)params.n == arity;
    if (valid) {
        if (str_eqc(name, "decimal")) {
            valid = params.v[0] >= 1 && params.v[0] <= 18 && params.v[1] <= params.v[0];
        } else if (str_eqc(name, "varchar")) {
            valid = params.v[0] >= 1 && params.v[0] <= 16383;
        } else {
            valid = params.v[0] <= 6;
        }
    }
    if (!valid) {
        str message = str_eqc(name, "decimal") ? SL("decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p")
            : str_eqc(name, "varchar") ? SL("varchar(n) needs 1 <= n <= 16383") : fmt("%S(p) needs 0 <= p <= 6", name);
        error(p, "type", p->line, column, message);
        *next = j;
        return NULL;
    }
    *next = j;
    return intern_type(p, name, params.v, params.n);
}

/* renderer가 만드는 이름이 63 byte를 넘으면 보고한다(docs/dbspec.md "Names"). */
static void generated_name(parser *p, zend_long line, zend_long column, str name)
{
    if (name.n <= 63) {
        return;
    }
    ssize_t dollar = str_find(name, "$", 0);
    str table = dollar < 0 ? name : str_sub(name, 0, (size_t)dollar);
    if (dbs_valid_name(table)) {
        error(p, "name.length", line, column, fmt("the generated name `%S` has %u bytes, more than 63", name, name.n));
    }
}

static void column_line(parser *p)
{
    const token *t0 = &p->t.v[0];
    if ((zend_long)p->table->columns.n + 1 > MAX_TABLE_COLUMNS) {
        stop(p, "limit", p->line, t0->column, fmt("a table has more than %d columns", (zend_long)MAX_TABLE_COLUMNS));
    }
    if (++p->column_count > MAX_COLUMNS) {
        stop(p, "limit", p->line, t0->column, fmt("the document has more than %d columns", (zend_long)MAX_COLUMNS));
    }
    const token *name = word_at(p, 0);
    if (name == NULL) {
        return;
    }
    bool well_formed = name_tok(p, name);
    if (p->t.n < 2) {
        error(p, "syntax", p->line, end_column(p), SL("expected a column type"));
        fail_column(p, name->text);
        return;
    }
    size_t i;
    ctype *type = read_type(p, 1, &i);
    bool nullable = false;
    const token *identity = NULL;
    bool has_default = false;
    token keyword = {0}, value = {0};
    if (tok_is(p, i, "null")) {
        nullable = true;
        i++;
    }
    if (tok_is(p, i, "identity")) {
        identity = &p->t.v[i];
        i++;
    }
    if (tok_is(p, i, "default")) {
        keyword = p->t.v[i];
        const token *v = tok(p, i + 1);
        if (v == NULL) {
            error(p, "syntax", p->line, end_column(p), SL("expected a default value"));
            i++;
        } else if (str_eqc(v->text, "-") && i + 2 < p->t.n && p->t.v[i + 2].column == v->column + 1) {
            has_default = true;
            value = (token){fmt("-%S", p->t.v[i + 2].text), v->column};
            i += 3;
        } else {
            has_default = true;
            value = *v;
            i += 2;
        }
    }
    if (i < p->t.n) {
        error(p, "syntax", p->line, p->t.v[i].column, fmt("unexpected `%S` in a column line", p->t.v[i].text));
    }
    bool rejected = false;
    if (identity != NULL) {
        if (nullable) {
            error(p, "column", p->line, identity->column, SL("an identity column cannot be null"));
            rejected = true;
        } else if (type != NULL && !str_eqc(type->name, "i64")) {
            error(p, "column", p->line, identity->column, SL("an identity column has the type i64"));
            rejected = true;
        }
        if (!rejected && p->identities.n > 0) {
            error(p, "column", p->line, identity->column, SL("a table has at most one identity column"));
            rejected = true;
        }
        PUSH(p->identities, ((identity_rec){name->text, p->line, identity->column, rejected}));
    }
    bool has_canonical = false;
    str canonical = SNULL;
    if (has_default) {
        if (identity != NULL) {
            error(p, "column", p->line, keyword.column, SL("an identity column has no default"));
        } else if (type != NULL) {
            str problem;
            if (literal_column_default(type, value.text, &canonical, &problem)) {
                has_canonical = true;
            } else {
                bool lob = str_eqc(type->name, "text") || str_eqc(type->name, "bytes");
                error(p, "column", p->line, lob ? keyword.column : value.column, problem);
            }
        }
    }
    column *c = column_new(name->text, type != NULL ? type : ctype_new(SL("invalid"), NULL, 0), nullable, identity != NULL,
        has_canonical ? &canonical : NULL);
    c->comments = take_comments(p);
    /* renderer가 type CHECK를 쓰는 column은 그 이름 <table>$<column>이 이름 한도를 지킨다. */
    if (identity == NULL && type != NULL && !str_eqc(type->name, "text") && !str_eqc(type->name, "bytes") && well_formed) {
        generated_name(p, p->line, name->column, fmt("%S$%S", p->table->name, name->text));
    }
    if (smap_has(p->columns, name->text)) {
        error(p, "name.duplicate", p->line, name->column, fmt("column `%S` is already defined", name->text));
    } else {
        smap_set(p->columns, name->text, c);
        if (type == NULL) {
            smap_set(&p->invalid_types, name->text, TRUEP);
        }
    }
    PUSH(p->table->columns, c);
}

static void check_key_columns(parser *p, const lcols *columns, zend_long at, bool primary, str what)
{
    smap seen = {0};
    zend_long varchar = 0;
    for (size_t i = 0; i < columns->n; i++) {
        str name = columns->v[i].name;
        zend_long position = columns->v[i].column;
        if (!name_ok(p, name, position)) {
            continue;
        }
        column *c = smap_get(p->columns, name);
        if (c == NULL) {
            error(p, "key", p->line, position, fmt("%S lists unknown column `%S`", what, name));
            continue;
        }
        if (smap_has(&seen, name)) {
            error(p, "key", p->line, position, fmt("%S repeats column `%S`", what, name));
            continue;
        }
        smap_set(&seen, name, TRUEP);
        if (primary && c->nullable) {
            error(p, "key", p->line, position, fmt("primary key column `%S` is null", name));
        }
        if (smap_has(&p->invalid_types, name)) {
            continue;
        }
        if (str_eqc(c->type->name, "text") || str_eqc(c->type->name, "bytes")) {
            error(p, "key", p->line, position, fmt("%S cannot hold the %S column `%S`", what, c->type->name, name));
        } else if (str_eqc(c->type->name, "varchar")) {
            varchar += c->type->p[0];
        }
    }
    if (columns->n > MAX_KEY_COLUMNS) {
        error(p, "key", p->line, at, fmt("%S lists more than %d columns", what, (zend_long)MAX_KEY_COLUMNS));
    }
    if (varchar > MAX_KEY_VARCHAR) {
        error(p, "key", p->line, at, fmt("%S totals %d varchar characters, more than %d", what, varchar, (zend_long)MAX_KEY_VARCHAR));
    }
}

static void primary_key_line(parser *p)
{
    const token first = p->t.v[0];
    if (!expect_at(p, 1, "key")) {
        fail_key(p, true);
        return;
    }
    lcols list;
    size_t next;
    if (!column_list(p, 2, false, &list, &next) || !end_at(p, next)) {
        fail_key(p, true);
        return;
    }
    if (p->table->pk != NULL) {
        error(p, "key", p->line, first.column, SL("a table has exactly one primary key"));
        return;
    }
    pkey *k = dbs_alloc(sizeof *k);
    k->columns = lcol_names(&list);
    k->comments = take_comments(p);
    p->table->pk = k;
    check_key_columns(p, &list, first.column, true, SL("primary key"));
}

static void key_line(parser *p, bool index)
{
    const token *name = word_at(p, 1);
    if (name == NULL) {
        fail_key(p, false);
        return;
    }
    lcols list;
    size_t next;
    if (!column_list(p, 2, index, &list, &next) || !end_at(p, next)) {
        fail_key(p, false);
        return;
    }
    constraint_name(p, name);
    if (index) {
        xindex *x = dbs_alloc(sizeof *x);
        x->name = name->text;
        for (size_t i = 0; i < list.n; i++) {
            PUSH(x->columns, ((icol){list.v[i].name, list.v[i].descending}));
        }
        x->comments = take_comments(p);
        PUSH(p->table->indexes, x);
    } else {
        ukey *u = dbs_alloc(sizeof *u);
        u->name = name->text;
        u->columns = lcol_names(&list);
        u->comments = take_comments(p);
        PUSH(p->table->uniques, u);
    }
    check_key_columns(p, &list, name->column, false, fmt("%s `%S`", index ? "index" : "unique key", name->text));
}

static smap *copy_map(const smap *m)
{
    smap *c = dbs_alloc(sizeof *c);
    SMAP_EACH(m, i) {
        smap_set(c, m->e[i].key, m->e[i].val);
    }
    return c;
}

static void foreign_key_line(parser *p)
{
    if (++p->fk_count > MAX_FOREIGN_KEYS) {
        stop(p, "limit", p->line, p->t.v[0].column, fmt("the document has more than %d foreign keys", (zend_long)MAX_FOREIGN_KEYS));
    }
    if (!expect_at(p, 1, "key")) {
        return;
    }
    const token *name = word_at(p, 2);
    if (name == NULL) {
        return;
    }
    lcols children, parents;
    size_t next, after;
    if (!column_list(p, 3, false, &children, &next) || !expect_at(p, next, "references")) {
        return;
    }
    const token *target = word_at(p, next + 1);
    if (target == NULL) {
        return;
    }
    if (!column_list(p, next + 2, false, &parents, &after)) {
        return;
    }
    size_t i = after;
    str actions[2] = {SL("restrict"), SL("restrict")};
    const char *events[2] = {"delete", "update"};
    for (int e = 0; e < 2; e++) {
        if (tok_is(p, i, "on") && tok_is(p, i + 1, events[e])) {
            const token *action = tok(p, i + 2);
            if (action == NULL || !listed(action->text, fk_actions)) {
                error(p, "syntax", p->line, action != NULL ? action->column : end_column(p), SL("expected `restrict`, `cascade` or `set_null`"));
                return;
            }
            actions[e] = action->text;
            i += 3;
        }
    }
    if (!end_at(p, i)) {
        return;
    }
    bool resolvable = name_tok(p, target);
    constraint_name(p, name);
    fkey *f = dbs_alloc(sizeof *f);
    f->name = name->text;
    f->columns = lcol_names(&children);
    f->table = target->text;
    f->refs = lcol_names(&parents);
    f->on_delete = actions[0];
    f->on_update = actions[1];
    f->comments = take_comments(p);
    PUSH(p->table->fks, f);
    bool known = true;
    smap seen = {0};
    for (size_t k = 0; k < children.n; k++) {
        str c = children.v[k].name;
        zend_long position = children.v[k].column;
        if (!name_ok(p, c, position)) {
            known = false;
        } else if (!smap_has(p->columns, c)) {
            error(p, "foreign_key", p->line, position, fmt("foreign key `%S` lists unknown column `%S`", name->text, c));
            known = false;
        } else if (smap_has(&seen, c)) {
            error(p, "foreign_key", p->line, position, fmt("foreign key `%S` repeats column `%S`", name->text, c));
            known = false;
        } else if (smap_has(&p->invalid_types, c)) {
            known = false;
        }
        smap_set(&seen, c, TRUEP);
    }
    PUSH(p->table_fks, ((tfk_rec){f, p->line, name->column, known}));
    for (size_t k = 0; k < parents.n; k++) {
        if (!name_ok(p, parents.v[k].name, parents.v[k].column)) {
            resolvable = false;
        }
    }
    if (resolvable) {
        PUSH(p->deferred_fks, ((dfk_rec){copy_map(p->columns), f, p->line, name->column, target->column, parents, known}));
    }
}

static void check_line(parser *p)
{
    const token *name = word_at(p, 1);
    if (name == NULL || !expect_at(p, 2, "(")) {
        return;
    }
    constraint_name(p, name);
    check *k = dbs_alloc(sizeof *k);
    k->name = name->text;
    k->expression = SL("");
    k->comments = take_comments(p);
    PUSH(p->table->checks, k);
    tokens rest = {0};
    for (size_t i = 3; i < p->t.n; i++) {
        PUSH(rest, p->t.v[i]);
    }
    PUSH(p->table_checks, ((tcheck_rec){k, p->line, rest, end_column(p)}));
}

/* audit의 `exclude (<column>, ...)`와 `include (<column>, ...)` 목록을 읽는다. */
static bool audit_list_tokens(parser *p, const tokens *t, audit_lists *out)
{
    audit_lists lists = {0};
    size_t i = 0;
    while (i < t->n) {
        token keyword = t->v[i];
        if (!str_eqc(keyword.text, "exclude") && !str_eqc(keyword.text, "include")) {
            error(p, "syntax", p->line, keyword.column, fmt("expected `exclude`, `include` or the end of the line, not `%S`", keyword.text));
            return false;
        }
        if (!(i + 1 < t->n && str_eqc(t->v[i + 1].text, "("))) {
            error(p, "syntax", p->line, i + 1 < t->n ? t->v[i + 1].column : end_column(p), SL("expected `(`"));
            return false;
        }
        i += 2;
        audit_list l = {keyword, {0}};
        for (;;) {
            const token *name = i < t->n ? &t->v[i] : NULL;
            if (name == NULL || !str_word(name->text)) {
                error(p, "syntax", p->line, name != NULL ? name->column : end_column(p), SL("expected a column name"));
                return false;
            }
            PUSH(l.columns, *name);
            const token *nx = i + 1 < t->n ? &t->v[i + 1] : NULL;
            i += 2;
            if (nx != NULL && str_eqc(nx->text, ")")) {
                break;
            }
            if (nx == NULL || !str_eqc(nx->text, ",")) {
                error(p, "syntax", p->line, nx != NULL ? nx->column : end_column(p), SL("expected `,` or `)`"));
                return false;
            }
        }
        PUSH(lists, l);
    }
    *out = lists;
    return true;
}

static void settings_line(parser *p)
{
    token first = p->t.v[0];
    str keyword = first.text;
    zend_long at = first.column;
    if (str_eqc(keyword, "}")) {
        end_at(p, 1);
        p->table->settings->closing = take_comments(p);
        p->state = S_TABLE;
        return;
    }
    size_t min, max;
    if (str_eqc(keyword, "entity") || str_eqc(keyword, "updated") || str_eqc(keyword, "soft_delete") || str_eqc(keyword, "aes_version")) {
        min = max = 1;
    } else if (str_eqc(keyword, "select") || str_eqc(keyword, "codec")) {
        min = 2;
        max = SIZE_MAX;
    } else if (str_eqc(keyword, "blind_index")) {
        min = max = 2;
    } else if (str_eqc(keyword, "navigation")) {
        min = max = 3;
    } else if (str_eqc(keyword, "immutable")) {
        min = max = 0;
    } else if (str_eqc(keyword, "audit")) {
        min = max = 10;
    } else {
        error(p, "setting", p->line, at, fmt("unknown setting `%S`", keyword));
        return;
    }
    tokens args = {0}, rest = {0};
    for (size_t i = 1; i < p->t.n; i++) {
        PUSH(args, p->t.v[i]);
    }
    /* audit의 exclude와 include 목록은 열 낱말 뒤에 오며 앞의 낱말을 검사한 뒤 따로 읽는다. */
    if (str_eqc(keyword, "audit") && args.n > 10) {
        for (size_t i = 10; i < args.n; i++) {
            PUSH(rest, args.v[i]);
        }
        args.n = 10;
    }
    for (size_t i = 0; i < args.n; i++) {
        if (!str_word(args.v[i].text)) {
            error(p, "syntax", p->line, args.v[i].column, fmt("unexpected `%S` in a setting", args.v[i].text));
            return;
        }
        if (i >= max) {
            error(p, "syntax", p->line, args.v[i].column, fmt("setting `%S` ends before `%S`", keyword, args.v[i].text));
            return;
        }
    }
    if (args.n < min) {
        error(p, "syntax", p->line, end_column(p), fmt("setting `%S` needs more arguments", keyword));
        return;
    }
    audit_lists lists = {0};
    str kind = keyword;
    if (str_eqc(keyword, "select")) {
        if (!str_eqc(args.v[0].text, "explicit")) {
            error(p, "syntax", p->line, args.v[0].column, SL("expected `select explicit`"));
            return;
        }
        kind = SL("select_explicit");
        tokens shifted = {0};
        for (size_t i = 1; i < args.n; i++) {
            PUSH(shifted, args.v[i]);
        }
        args = shifted;
    } else if (str_eqc(keyword, "audit")) {
        const char *words[] = {"into", "column", "references", "action", "previous"};
        for (int n = 0; n < 5; n++) {
            if (!str_eqc(args.v[2 * n].text, words[n])) {
                error(p, "syntax", p->line, args.v[2 * n].column, fmt("expected `%s`", words[n]));
                return;
            }
        }
        /* audit의 인자는 history table, audit column, audit 기록 table, action, previous 순이다. */
        tokens picked = {0};
        for (int n = 0; n < 5; n++) {
            PUSH(picked, args.v[2 * n + 1]);
        }
        args = picked;
        if (rest.n > 0 && !audit_list_tokens(p, &rest, &lists)) {
            return;
        }
    }
    bool per_name = str_eqc(kind, "codec") || str_eqc(kind, "navigation") || str_eqc(kind, "blind_index");
    str key = per_name ? fmt("%S %S", kind, args.v[0].text) : kind;
    if (smap_has(&p->setting_keys, key)) {
        error(p, "setting", p->line, at, per_name ? fmt("setting `%S` repeats for `%S`", kind, args.v[0].text) : fmt("setting `%S` repeats", keyword));
        return;
    }
    smap_set(&p->setting_keys, key, TRUEP);
    /* codec의 단계 말고는 모든 인자가 이름이다. */
    size_t named_args = str_eqc(kind, "codec") ? 1 : args.n;
    for (size_t i = 0; i < named_args; i++) {
        name_tok(p, &args.v[i]);
    }
    /* 목록의 이름은 처음 나올 때만 검사한다. audit column은 검사가 따로 거부한다. */
    smap named = {0};
    for (size_t l = 0; l < lists.n; l++) {
        for (size_t k = 0; k < lists.v[l].columns.n; k++) {
            token *c = &lists.v[l].columns.v[k];
            if (!smap_has(&named, c->text) && !str_eq(c->text, args.v[1].text)) {
                name_tok(p, c);
            }
            smap_set(&named, c->text, TRUEP);
        }
    }
    setting *s = dbs_alloc(sizeof *s);
    s->kind = kind;
    for (size_t i = 0; i < args.n; i++) {
        PUSH(s->args, args.v[i].text);
    }
    s->comments = take_comments(p);
    for (size_t l = 0; l < lists.n; l++) {
        strs *names = dbs_alloc(sizeof *names);
        for (size_t k = 0; k < lists.v[l].columns.n; k++) {
            PUSH(*names, lists.v[l].columns.v[k].text);
        }
        if (str_eqc(lists.v[l].keyword.text, "exclude")) {
            s->exclude = names;
        } else {
            s->include = names;
        }
    }
    PUSH(p->table->settings->list, s);
    PUSH(p->table_settings, ((tsetting_rec){kind, args, p->line, at, lists}));
}

static void open_diagram(parser *p)
{
    const token *name = word_at(p, 1);
    p->state = S_DIAGRAM;
    p->block_open[0] = p->line;
    p->block_open[1] = p->t.n > 2 ? p->t.v[2].column : p->t.v[0].column;
    p->diagram_tables = (smap){0};
    diagram *g = dbs_alloc(sizeof *g);
    g->name = name != NULL ? name->text : SL("");
    g->comments = take_comments(p);
    p->diagram = g;
    PUSH(p->doc->diagrams, g);
    if (name == NULL) {
        return;
    }
    name_tok(p, name);
    if (expect_at(p, 2, "{")) {
        end_at(p, 3);
    }
    if (smap_has(&p->diagram_names, name->text)) {
        error(p, "name.duplicate", p->line, name->column, fmt("diagram `%S` is already defined", name->text));
    }
    smap_set(&p->diagram_names, name->text, TRUEP);
}

static void diagram_line(parser *p)
{
    if (str_eqc(p->t.v[0].text, "}")) {
        end_at(p, 1);
        p->diagram->closing = take_comments(p);
        p->state = S_TOP;
        return;
    }
    const token *tname = word_at(p, 0);
    if (tname == NULL || !expect_at(p, 1, "at")) {
        return;
    }
    token coordinates[2];
    size_t i = 2;
    for (int n = 0; n < 2; n++) {
        const token *t = tok(p, i);
        if (t == NULL) {
            error(p, "syntax", p->line, end_column(p), SL("expected a coordinate"));
            return;
        }
        str text = t->text;
        i++;
        if (str_eqc(text, "-") && i < p->t.n && p->t.v[i].column == t->column + 1) {
            text = fmt("%S%S", text, p->t.v[i].text);
            i++;
        }
        coordinates[n] = (token){text, t->column};
    }
    if (!end_at(p, i)) {
        return;
    }
    str table_name = tname->text;
    bool valid = name_tok(p, tname);
    if (!valid || (!smap_has(&p->tables, table_name) && smap_has(&p->failed_tables, table_name))) {
        valid = false;
    } else if (!smap_has(&p->tables, table_name)) {
        error(p, "diagram", p->line, tname->column, fmt("diagram names unknown table `%S`", table_name));
        valid = false;
    } else if (smap_has(&p->diagram_tables, table_name)) {
        error(p, "diagram", p->line, tname->column, fmt("diagram places table `%S` twice", table_name));
        valid = false;
    }
    smap_set(&p->diagram_tables, table_name, TRUEP);
    zend_long values[2];
    size_t nvalues = 0;
    for (int n = 0; n < 2; n++) {
        str integer;
        bool ok = literal_integer(coordinates[n].text, &integer);
        str digits = ok ? (integer.s[0] == '-' ? str_sub(integer, 1, integer.n - 1) : integer) : SL("");
        if (!ok || digits.n > 10 || (digits.n == 10 && str_cmp(digits, integer.s[0] == '-' ? SL("2147483648") : SL("2147483647")) > 0)) {
            error(p, "diagram", p->line, coordinates[n].column,
                fmt("coordinate `%S` is not an integer from -2147483648 to 2147483647", coordinates[n].text));
            valid = false;
            continue;
        }
        values[nvalues++] = ZEND_STRTOL(str_of(integer.s, integer.n).s, NULL, 10);
    }
    if (valid) {
        placement *pl = dbs_alloc(sizeof *pl);
        pl->table = table_name;
        pl->x = values[0];
        pl->y = values[1];
        pl->comments = take_comments(p);
        PUSH(p->diagram->placements, pl);
    }
}

static void table_line(parser *p);
static void close_table(parser *p);

static void top_line(parser *p)
{
    token first = p->t.v[0];
    if (str_eqc(first.text, "use")) {
        if (p->top_phase > 0) {
            error(p, "order", p->line, first.column, SL("`use` lines come before tables and diagrams"));
        }
        use_line(p);
        return;
    }
    if (str_eqc(first.text, "table")) {
        if (p->top_phase > 1) {
            error(p, "order", p->line, first.column, SL("tables come before diagrams"));
        }
        if (p->top_phase < 1) {
            p->top_phase = 1;
        }
        open_table(p);
        return;
    }
    if (str_eqc(first.text, "diagram")) {
        p->top_phase = 2;
        open_diagram(p);
        return;
    }
    error(p, "syntax", p->line, first.column, fmt("expected `use`, `table` or `diagram`, found `%S`", first.text));
}

static void table_line(parser *p)
{
    token first = p->t.v[0];
    str w = first.text;
    if (str_eqc(w, "}")) {
        end_at(p, 1);
        p->table->closing = take_comments(p);
        close_table(p);
        p->state = S_TOP;
        return;
    }
    if (str_eqc(w, "primary") || str_eqc(w, "unique") || str_eqc(w, "index") || str_eqc(w, "foreign") || str_eqc(w, "check")) {
        if (p->table_phase == 2) {
            error(p, "order", p->line, first.column, SL("key, index, foreign key and check lines come before the settings block"));
        } else {
            p->table_phase = 1;
        }
        if (str_eqc(w, "primary")) {
            primary_key_line(p);
        } else if (str_eqc(w, "unique") || str_eqc(w, "index")) {
            key_line(p, str_eqc(w, "index"));
        } else if (str_eqc(w, "foreign")) {
            foreign_key_line(p);
        } else {
            check_line(p);
        }
        return;
    }
    if (str_eqc(w, "settings")) {
        if (p->table_phase == 2) {
            error(p, "order", p->line, first.column, SL("a table has at most one settings block, after its other lines"));
        }
        p->table_phase = 2;
        if (expect_at(p, 1, "{")) {
            end_at(p, 2);
        }
        settings *s = dbs_alloc(sizeof *s);
        s->comments = take_comments(p);
        if (p->table->settings == NULL) {
            p->table->settings = s;
        }
        p->settings_open[0] = p->line;
        p->settings_open[1] = p->t.n > 1 ? p->t.v[1].column : first.column;
        p->state = S_SETTINGS;
        return;
    }
    if (p->table_phase > 0) {
        error(p, "order", p->line, first.column, SL("column lines come before key, index, foreign key, check and settings lines"));
    }
    column_line(p);
}

/* ------------------------------------------------------------- table checks */

static bool recorder_records(const recorder *r, str c)
{
    if (str_eq(c, r->audit)) {
        return true;
    }
    return r->include ? smap_has(&r->listed, c) : !smap_has(&r->listed, c);
}

/* settings 검사의 column 참조: column, 또는 diagnostic이나 실패한 이름과 줄 뒤의 NULL. */
static column *setting_column(parser *p, str kind, zend_long line, const token *t)
{
    if (!dbs_valid_name(t->text)) {
        return NULL;
    }
    column *c = smap_get(p->columns, t->text);
    if (c == NULL) {
        error(p, "setting", line, t->column, fmt("setting `%S` names unknown column `%S`", kind, t->text));
        return NULL;
    }
    return smap_has(&p->invalid_types, t->text) ? NULL : c;
}

/* audit의 exclude나 include 목록을 검사하고 column이 기록되는지 알리는 recorder를 돌려준다. */
static recorder *audit_lists_check(parser *p, const audit_lists *lists, str audit, zend_long line, str kind)
{
    if (lists->n > 1) {
        error(p, "setting", line, lists->v[1].keyword.column, SL("audit names its recorded columns by exclude or by include, not both"));
        return NULL;
    }
    recorder *r = dbs_alloc(sizeof *r);
    r->audit = audit;
    for (size_t l = 0; l < lists->n; l++) {
        for (size_t k = 0; k < lists->v[l].columns.n; k++) {
            const token *t = &lists->v[l].columns.v[k];
            if (smap_has(&r->listed, t->text)) {
                error(p, "setting", line, t->column, fmt("column `%S` repeats in audit %S", t->text, lists->v[l].keyword.text));
                continue;
            }
            if (str_eq(t->text, audit)) {
                error(p, "setting", line, t->column, fmt("the audit column `%S` is always recorded and is not listed in exclude or include", t->text));
            } else {
                setting_column(p, kind, line, t);
            }
            smap_set(&r->listed, t->text, TRUEP);
        }
    }
    r->include = lists->n == 1 && str_eqc(lists->v[0].keyword.text, "include");
    return r;
}

static void check_settings(parser *p, bool changed_by_foreign_keys)
{
    smap kinds = {0}, aes = {0};
    for (size_t i = 0; i < p->table_settings.n; i++) {
        tsetting_rec *s = &p->table_settings.v[i];
        smap_set(&kinds, s->kind, TRUEP);
        if (str_eqc(s->kind, "codec")) {
            for (size_t k = 1; k < s->args.n; k++) {
                if (str_eqc(s->args.v[k].text, "aes")) {
                    smap_set(&aes, s->args.v[0].text, TRUEP);
                }
            }
        }
    }
    smap single = {0};
    for (size_t i = 0; i < p->table->uniques.n; i++) {
        if (p->table->uniques.v[i]->columns.n == 1) {
            smap_set(&single, p->table->uniques.v[i]->columns.v[0], TRUEP);
        }
    }
    for (size_t i = 0; i < p->table->indexes.n; i++) {
        if (p->table->indexes.v[i]->columns.n == 1) {
            smap_set(&single, p->table->indexes.v[i]->columns.v[0].name, TRUEP);
        }
    }
    for (size_t i = 0; i < p->table_settings.n; i++) {
        tsetting_rec *s = &p->table_settings.v[i];
        str kind = s->kind;
        zend_long line = s->line, at = s->at;
        tokens *a = &s->args;
        if (str_eqc(kind, "updated") || str_eqc(kind, "soft_delete")) {
            column *d = setting_column(p, kind, line, &a->v[0]);
            if (d != NULL && (!str_eqc(d->type->name, "datetime") || (str_eqc(kind, "soft_delete") && !d->nullable))) {
                error(p, "setting", line, a->v[0].column, str_eqc(kind, "updated") ? SL("setting `updated` needs a datetime column")
                    : SL("setting `soft_delete` needs a null datetime column"));
            }
        } else if (str_eqc(kind, "select_explicit")) {
            smap seen = {0};
            for (size_t k = 0; k < a->n; k++) {
                if (smap_has(&seen, a->v[k].text)) {
                    error(p, "setting", line, a->v[k].column, fmt("setting `select explicit` repeats `%S`", a->v[k].text));
                    continue;
                }
                smap_set(&seen, a->v[k].text, TRUEP);
                setting_column(p, kind, line, &a->v[k]);
            }
        } else if (str_eqc(kind, "codec")) {
            bool known = true;
            for (size_t k = 1; k < a->n; k++) {
                token *stage = &a->v[k];
                if (!listed(stage->text, codec_stages)) {
                    error(p, "setting", line, stage->column, fmt("unknown codec stage `%S`", stage->text));
                    known = false;
                } else if (str_eqc(stage->text, "ordered_json") && k > 1) {
                    error(p, "setting", line, stage->column, SL("`ordered_json` is the first codec stage"));
                }
            }
            column *d = setting_column(p, kind, line, &a->v[0]);
            if (d != NULL && known) {
                str last = a->v[a->n - 1].text;
                bool text = listed(last, text_stages);
                str type = d->type->name;
                if (text ? !str_eqc(type, "varchar") && !str_eqc(type, "text") : !str_eqc(type, "bytes")) {
                    error(p, "setting", line, a->v[0].column, fmt("the last codec stage `%S` needs %s column", last, text ? "a varchar or text" : "a bytes"));
                }
            }
            if (smap_has(&aes, a->v[0].text) && !smap_has(&kinds, SL("aes_version"))) {
                error(p, "setting", line, at, SL("a codec with `aes` needs the `aes_version` setting"));
            }
        } else if (str_eqc(kind, "aes_version")) {
            if (aes.live == 0) {
                error(p, "setting", line, at, SL("setting `aes_version` needs a column with the `aes` codec"));
            }
            column *d = setting_column(p, kind, line, &a->v[0]);
            if (d != NULL && (!ctype_integer(d->type) || d->nullable)) {
                error(p, "setting", line, a->v[0].column, SL("setting `aes_version` needs a non-null integer column"));
            }
        } else if (str_eqc(kind, "blind_index")) {
            token *source = &a->v[0], *target = &a->v[1];
            column *encrypted = setting_column(p, kind, line, source);
            if (dbs_valid_name(source->text) && smap_has(p->columns, source->text) && !smap_has(&aes, source->text)) {
                error(p, "setting", line, source->column, fmt("setting `blind_index` needs a column with the `aes` codec, not `%S`", source->text));
            }
            column *index = setting_column(p, kind, line, target);
            if (index != NULL) {
                const ctype *type = index->type;
                if (!(str_eqc(type->name, "varchar") && type->p[0] >= 64) || (encrypted != NULL && encrypted->nullable != index->nullable)
                    || smap_has(&aes, target->text) || !smap_has(&single, target->text)) {
                    error(p, "setting", line, target->column, fmt("blind index column `%S` is a varchar(n >= 64) column with the AES column's nullability, not AES-encoded, and the only column of an index or unique key", target->text));
                }
            }
        } else if (str_eqc(kind, "navigation")) {
            if (dbs_valid_name(a->v[0].text)) {
                bool found = false;
                for (size_t k = 0; k < p->table->fks.n; k++) {
                    found = found || str_eq(p->table->fks.v[k]->name, a->v[0].text);
                }
                if (!found) {
                    error(p, "setting", line, a->v[0].column, fmt("setting `navigation` names unknown foreign key `%S`", a->v[0].text));
                }
            }
        } else if (str_eqc(kind, "immutable")) {
            if (changed_by_foreign_keys) {
                error(p, "setting", line, at, SL("setting `immutable` is rejected on a child of a cascade or set_null foreign key"));
            }
            generated_name(p, line, at, fmt("%S$immutable_update", p->table->name));
        } else if (str_eqc(kind, "audit")) {
            if (changed_by_foreign_keys) {
                error(p, "setting", line, at, SL("setting `audit` is rejected on a child of a cascade or set_null foreign key"));
            }
            column *audit = setting_column(p, kind, line, &a->v[1]);
            if (audit != NULL && audit->nullable) {
                error(p, "setting", line, a->v[1].column, SL("the audit column is a non-null column"));
            }
            recorder *recorded = audit_lists_check(p, &s->lists, a->v[1].text, line, kind);
            if (dbs_valid_name(a->v[2].text)) {
                PUSH(p->deferred_records, ((drecord_rec){p->table, audit, *a, line, smap_has(&p->failed_key_tables, p->table->name)}));
            }
            if (dbs_valid_name(a->v[0].text) && dbs_valid_name(a->v[3].text) && dbs_valid_name(a->v[4].text)) {
                PUSH(p->deferred_audits, ((daudit_rec){p->table, p->columns, *a, audit != NULL ? audit->type : NULL, line, recorded}));
            }
            generated_name(p, line, at, fmt("%S$audit_insert", p->table->name));
        }
    }
}

static bool prefix_equal(const strs *columns, const strs *fk)
{
    /* array_slice($columns, 0, count($fk)) === $fk */
    if (columns->n < fk->n) {
        return false;
    }
    for (size_t i = 0; i < fk->n; i++) {
        if (!str_eq(columns->v[i], fk->v[i])) {
            return false;
        }
    }
    return true;
}

static void close_table(parser *p)
{
    table *t = p->table;
    pkey *primary = t->pk;
    if (p->columns->live == 0) {
        error(p, "column", p->table_name[0], p->table_name[1], fmt("table `%S` has no column", t->name));
    }
    if (primary == NULL && !p->failed_primary) {
        error(p, "key", p->table_name[0], p->table_name[1], fmt("table `%S` has no primary key", t->name));
    }
    for (size_t i = 0; i < p->identities.n; i++) {
        identity_rec *r = &p->identities.v[i];
        bool only = primary != NULL && primary->columns.n == 1 && str_eq(primary->columns.v[0], r->name);
        if (!r->rejected && !p->failed_primary && !only) {
            error(p, "column", r->line, r->column, fmt("identity column `%S` must be the only primary key column", r->name));
        }
    }
    VEC(strs) leading = {0};
    if (primary != NULL) {
        PUSH(leading, primary->columns);
    }
    for (size_t i = 0; i < t->uniques.n; i++) {
        PUSH(leading, t->uniques.v[i]->columns);
    }
    for (size_t i = 0; i < t->indexes.n; i++) {
        strs names = {0};
        for (size_t k = 0; k < t->indexes.v[i]->columns.n; k++) {
            PUSH(names, t->indexes.v[i]->columns.v[k].name);
        }
        PUSH(leading, names);
    }
    smap action = {0};
    for (size_t i = 0; i < p->table_fks.n; i++) {
        tfk_rec *r = &p->table_fks.v[i];
        fkey *f = r->fk;
        if (fkey_changes_child_rows(f)) {
            for (size_t k = 0; k < f->columns.n; k++) {
                if (!smap_has(&action, f->columns.v[k])) {
                    str *name = dbs_alloc(sizeof *name);
                    *name = f->name;
                    smap_set(&action, f->columns.v[k], name);
                }
            }
        }
        if (!r->known) {
            continue;
        }
        bool covered = false;
        for (size_t k = 0; k < leading.n && !covered; k++) {
            covered = prefix_equal(&leading.v[k], &f->columns);
        }
        if (!covered && !smap_has(&p->failed_key_tables, t->name)) {
            error(p, "foreign_key", r->line, r->column, fmt("foreign key `%S` needs an index or key whose leading columns are its columns", f->name));
        }
        if (str_eqc(f->on_delete, "set_null") || str_eqc(f->on_update, "set_null")) {
            for (size_t k = 0; k < f->columns.n; k++) {
                column *c = smap_get(p->columns, f->columns.v[k]);
                if (!c->nullable) {
                    error(p, "foreign_key", r->line, r->column, fmt("foreign key `%S` sets `%S` null but the column is not null", f->name, f->columns.v[k]));
                    break;
                }
            }
        }
    }
    for (size_t i = 0; i < p->table_checks.n; i++) {
        tcheck_rec *r = &p->table_checks.v[i];
        str text = SL("");
        diags errors = {0};
        if (!expression_parse(&r->toks, r->line, r->end, p->columns, &action, &text, &errors)) {
            text = SL("");
        }
        for (size_t k = 0; k < errors.n; k++) {
            error(p, errors.v[k].rule.s, errors.v[k].line, errors.v[k].column, errors.v[k].message);
        }
        r->check->expression = text;
    }
    check_settings(p, action.live > 0);
    tentry *e = smap_get(&p->tables, t->name);
    if (e != NULL && e->table == t) {
        e->columns = p->columns;
    }
    p->table = NULL;
}

/* ------------------------------------------------------- cross-table checks */

static void check_foreign_key_targets(parser *p)
{
    for (size_t i = 0; i < p->deferred_fks.n; i++) {
        dfk_rec *r = &p->deferred_fks.v[i];
        fkey *f = r->fk;
        tentry *target = smap_get(&p->tables, f->table);
        if (target == NULL && smap_has(&p->failed_tables, f->table)) {
            continue;
        }
        if (target == NULL) {
            error(p, "foreign_key", r->line, r->target_at, fmt("foreign key `%S` references unknown table `%S`", f->name, f->table));
            continue;
        }
        bool known = r->known;
        for (size_t k = 0; k < r->parents.n; k++) {
            if (!smap_has(target->columns, r->parents.v[k].name)) {
                error(p, "foreign_key", r->line, r->parents.v[k].column, fmt("table `%S` has no column `%S`", f->table, r->parents.v[k].name));
                known = false;
            }
        }
        if (!known) {
            continue;
        }
        if (f->columns.n != f->refs.n) {
            error(p, "foreign_key", r->line, r->at, fmt("foreign key `%S` lists %u columns and references %u", f->name, f->columns.n, f->refs.n));
            continue;
        }
        table *tt = target->table;
        bool matches = tt->pk != NULL && strs_eq(&tt->pk->columns, &f->refs);
        for (size_t k = 0; k < tt->uniques.n && !matches; k++) {
            matches = strs_eq(&tt->uniques.v[k]->columns, &f->refs);
        }
        if (!matches && !smap_has(&p->failed_key_tables, f->table)) {
            error(p, "foreign_key", r->line, r->at, fmt("foreign key `%S` references columns that are not the primary key or a unique key of `%S`", f->name, f->table));
        }
        for (size_t k = 0; k < f->columns.n; k++) {
            column *parent = smap_get(target->columns, f->refs.v[k]);
            column *child = smap_get(r->columns, f->columns.v[k]);
            const ctype *pt = parent->type;
            if (!str_eqc(pt->name, "invalid") && child->type != pt && !str_eq(ctype_text(child->type), ctype_text(pt))) {
                error(p, "foreign_key", r->line, r->at, fmt("foreign key `%S` column `%S` is %S but `%S` is %S", f->name, f->columns.v[k],
                    ctype_text(child->type), f->refs.v[k], ctype_text(pt)));
                break;
            }
        }
    }
}

static void check_audit_records(parser *p)
{
    for (size_t i = 0; i < p->deferred_records.n; i++) {
        drecord_rec *r = &p->deferred_records.v[i];
        token *history = &r->args.v[0], *col = &r->args.v[1], *refs = &r->args.v[2];
        str name = refs->text;
        tentry *entry = smap_get(&p->tables, name);
        if (entry == NULL && smap_has(&p->failed_tables, name)) {
            continue;
        }
        if (entry == NULL) {
            error(p, "setting", r->line, refs->column, fmt("audit record table `%S` is not a table of this document or a used table", name));
            continue;
        }
        table *record = entry->table;
        if (record == r->audited) {
            error(p, "setting", r->line, refs->column, SL("a table cannot record its audits in itself"));
            continue;
        }
        if (str_eq(name, history->text)) {
            error(p, "setting", r->line, refs->column, SL("the audit record table is another table than the history table"));
            continue;
        }
        if (record->settings != NULL) {
            for (size_t k = 0; k < record->settings->list.n; k++) {
                if (str_eqc(record->settings->list.v[k]->kind, "audit")) {
                    error(p, "setting", r->line, refs->column, fmt("audit record table `%S` is audited itself", name));
                }
            }
        }
        size_t nkey = record->pk != NULL ? record->pk->columns.n : 0;
        if (nkey != 1) {
            if (!smap_has(&p->failed_primary_tables, name)) {
                error(p, "setting", r->line, refs->column, fmt("audit record table `%S` needs a primary key of one column", name));
            }
            continue;
        }
        str key = record->pk->columns.v[0];
        column *pk = smap_get(entry->columns, key);
        if (r->col == NULL || pk == NULL) {
            continue;
        }
        if (!str_eqc(pk->type->name, "invalid") && !str_eqc(r->col->type->name, "invalid") && !str_eq(ctype_text(pk->type), ctype_text(r->col->type))) {
            error(p, "setting", r->line, col->column, fmt("the audit column has type %S, not the type %S of the primary key of `%S`",
                ctype_text(r->col->type), ctype_text(pk->type), name));
            continue;
        }
        bool declared = false;
        for (size_t k = 0; k < r->audited->fks.n && !declared; k++) {
            fkey *f = r->audited->fks.v[k];
            declared = f->columns.n == 1 && str_eq(f->columns.v[0], col->text) && str_eq(f->table, name) && f->refs.n == 1
                && str_eq(f->refs.v[0], key) && str_eqc(f->on_delete, "restrict") && str_eqc(f->on_update, "restrict");
        }
        if (declared) {
            continue;
        }
        if (!r->failed_keys) {
            error(p, "setting", r->line, col->column, fmt("the audit column needs the foreign key (%S) references %S (%S) on delete restrict on update restrict",
                col->text, name, key));
        }
    }
}

static void check_audit_histories(parser *p)
{
    for (size_t i = 0; i < p->deferred_audits.n; i++) {
        daudit_rec *r = &p->deferred_audits.v[i];
        token *history_tok = &r->args.v[0], *action_tok = &r->args.v[3], *previous_tok = &r->args.v[4];
        tentry *entry = smap_get(&p->tables, history_tok->text);
        if (entry == NULL && smap_has(&p->failed_tables, history_tok->text)) {
            continue;
        }
        if (entry == NULL) {
            error(p, "setting", r->line, history_tok->column, fmt("audit history table `%S` is unknown", history_tok->text));
            continue;
        }
        table *history = entry->table;
        smap *hcols = entry->columns;
        if (history == r->audited) {
            error(p, "setting", r->line, history_tok->column, SL("an audited table is not its own history table"));
            continue;
        }
        if (history->settings != NULL) {
            for (size_t k = 0; k < history->settings->list.n; k++) {
                if (str_eqc(history->settings->list.v[k]->kind, "audit")) {
                    error(p, "setting", r->line, history_tok->column, fmt("history table `%S` is audited itself", history->name));
                }
            }
        }
        column *identity = NULL;
        if (history->pk != NULL && history->pk->columns.n == 1) {
            identity = smap_get(hcols, history->pk->columns.v[0]);
        }
        smap reserved = {0};
        if (identity != NULL && identity->identity && str_eqc(identity->type->name, "i64")) {
            smap_set(&reserved, identity->name, TRUEP);
        } else {
            error(p, "setting", r->line, history_tok->column, fmt("history table `%S` needs an i64 identity primary key", history->name));
        }
        column *action = smap_get(hcols, action_tok->text);
        if (action == NULL || smap_has(&reserved, action_tok->text) || action->nullable || !str_eqc(ctype_text(action->type), "varchar(8)")) {
            error(p, "setting", r->line, action_tok->column, fmt("the audit action column `%S` is a separate non-null varchar(8) column of `%S`", action_tok->text, history->name));
        }
        smap_set(&reserved, action_tok->text, TRUEP);
        column *previous = smap_get(hcols, previous_tok->text);
        if (previous == NULL || smap_has(&reserved, previous_tok->text) || !previous->nullable
            || (r->audit_type != NULL && !str_eq(ctype_text(previous->type), ctype_text(r->audit_type)))) {
            error(p, "setting", r->line, previous_tok->column, fmt("the audit previous column `%S` is a separate null column of `%S` with the audit column's type",
                previous_tok->text, history->name));
        }
        smap_set(&reserved, previous_tok->text, TRUEP);
        /* 두 목록을 다 쓴 setting은 기록하는 column이 정해지지 않으므로 column을 맞추어 보지 않는다. */
        if (r->recorded == NULL) {
            continue;
        }
        SMAP_EACH(r->columns, k) {
            str name = r->columns->e[k].key;
            column *c = r->columns->e[k].val;
            if (!recorder_records(r->recorded, name)) {
                continue;
            }
            column *h = smap_get(hcols, name);
            if (smap_has(&reserved, name) || h == NULL) {
                error(p, "setting", r->line, history_tok->column, fmt("history table `%S` has no copy of column `%S`", history->name, name));
            } else if (!str_eq(ctype_text(h->type), ctype_text(c->type))) {
                error(p, "setting", r->line, history_tok->column, fmt("history column `%S` has type %S, not %S", name, ctype_text(h->type), ctype_text(c->type)));
            }
        }
        SMAP_EACH(hcols, k) {
            str name = hcols->e[k].key;
            if (smap_has(&reserved, name)) {
                continue;
            }
            if (!smap_has(r->columns, name)) {
                error(p, "setting", r->line, history_tok->column, fmt("history table `%S` has column `%S`, which is not a column of `%S`", history->name, name, r->audited->name));
            } else if (!recorder_records(r->recorded, name)) {
                error(p, "setting", r->line, history_tok->column, fmt("history table `%S` has column `%S`, which `%S` does not record", history->name, name, r->audited->name));
            }
        }
    }
}

/* ---------------------------------------------------------------------- run */

static void read_source(parser *p, str source)
{
    if (source.n > MAX_BYTES) {
        stop(p, "limit", 1, 1, SL("the document is larger than 32 MiB"));
    }
    check_encoding(p, source);
    strs lines = strs_split(source, '\n');
    if (lines.n > 0 && lines.v[lines.n - 1].n == 0) {
        lines.n--;
    }
    if (lines.n == 0) {
        stop(p, "header", 1, 1, SL("the first line is not `dbspec 1 <document>`"));
    }
    for (size_t index = 0; index < lines.n; index++) {
        str text = lines.v[index];
        if (text.n > 0 && text.s[text.n - 1] == '\r') {
            text.n--;
        }
        p->line = (zend_long)index + 1;
        p->text = text;
        if (index == 0) {
            tokenize(p);
            header(p);
            continue;
        }
        str trimmed = str_ltrim_spaces(text);
        if (trimmed.n == 0) {
            continue;
        }
        if (trimmed.s[0] == '#') {
            PUSH(p->comments, trimmed);
            continue;
        }
        tokenize(p);
        if (tab_line(p)) {
            continue;
        }
        switch (p->state) {
            case S_TOP:
                top_line(p);
                break;
            case S_TABLE:
                table_line(p);
                break;
            case S_SETTINGS:
                settings_line(p);
                break;
            default:
                diagram_line(p);
                break;
        }
    }
    if (p->state == S_SETTINGS) {
        error(p, "syntax", p->settings_open[0], p->settings_open[1], SL("the settings block is not closed"));
        p->state = S_TABLE;
    }
    if (p->state == S_TABLE) {
        error(p, "syntax", p->block_open[0], p->block_open[1], SL("the table block is not closed"));
        close_table(p);
    } else if (p->state == S_DIAGRAM) {
        error(p, "syntax", p->block_open[0], p->block_open[1], SL("the diagram block is not closed"));
    }
    p->doc->trailing = take_comments(p);
    check_foreign_key_targets(p);
    check_audit_records(p);
    check_audit_histories(p);
}

typedef struct {
    diag d;
    size_t index;
} ranked;

static int cmp_ranked(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const ranked *x = a, *y = b;
    if (x->d.line != y->d.line) {
        return x->d.line < y->d.line ? -1 : 1;
    }
    if (x->d.column != y->d.column) {
        return x->d.column < y->d.column ? -1 : 1;
    }
    zend_long rx = dbs_rule_rank(x->d.rule), ry = dbs_rule_rank(y->d.rule);
    if (rx != ry) {
        return rx < ry ? -1 : 1;
    }
    return x->index < y->index ? -1 : (x->index > y->index ? 1 : 0);
}

static document *run(parser *p, str source, diags *out)
{
    bool stopped = false;
    diag stopd;
    if (setjmp(p->stop_jump) == 0) {
        read_source(p, source);
    } else {
        stopped = true;
        stopd = p->diagnostics.v[--p->diagnostics.n];
    }
    if (p->diagnostics.n == 0 && !stopped) {
        return p->doc;
    }
    ranked *order = dbs_alloc(sizeof(ranked) * (p->diagnostics.n + 1));
    for (size_t i = 0; i < p->diagnostics.n; i++) {
        order[i].d = p->diagnostics.v[i];
        order[i].index = i;
    }
    dbs_sort(order, p->diagnostics.n, sizeof(ranked), cmp_ranked, NULL);
    for (size_t i = 0; i < p->diagnostics.n; i++) {
        PUSH(*out, order[i].d);
    }
    if (stopped) {
        PUSH(*out, stopd);
    }
    return NULL;
}

static parser *parser_new(const smap *documents, const strs *using, smap *used)
{
    parser *p = dbs_alloc(sizeof *p);
    p->documents = documents;
    if (using != NULL) {
        p->using = strs_copy(using);
    }
    p->used = used;
    p->state = S_TOP;
    return p;
}

/* 읽는 중인 사용한 문서의 표시다. */
static used_entry reading;

/* 선언한 집합의 사용한 문서를 그 자신의 use 줄과 함께 한 번 parse하고 검증한다. */
static used_entry *used_document(parser *p, str name)
{
    used_entry *e = smap_get(p->used, name);
    if (e == &reading) {
        /* 읽는 중인 문서를 다시 쓰면 use cycle이다. header 이름이 집합의 이름과 다르면 이름의 사슬로는 찾지 못한다. */
        used_entry *cycle = dbs_alloc(sizeof *cycle);
        sbuf b = {0};
        sb_c(&b, "use cycle: ");
        for (size_t k = 0; k < p->using.n; k++) {
            sb_s(&b, p->using.v[k]);
            sb_c(&b, " -> ");
        }
        sb_fmt(&b, "%S -> %S", p->doc->name, name);
        cycle->has_reason = true;
        cycle->reason = sb_str(&b);
        return cycle;
    }
    if (e != NULL) {
        return e;
    }
    smap_set(p->used, name, &reading);
    strs using = strs_copy(&p->using);
    PUSH(using, p->doc->name);
    parser *child = parser_new(p->documents, &using, p->used);
    diags found = {0};
    str *text = smap_get(p->documents, name);
    document *d = run(child, *text, &found);
    e = dbs_alloc(sizeof *e);
    if (d == NULL) {
        diag first = found.v[0];
        e->has_reason = true;
        e->reason = fmt("used document `%S` is invalid: %d:%d %S %S", name, first.line, first.column, first.rule, first.message);
    } else if (!str_eq(d->name, name)) {
        e->has_reason = true;
        e->reason = fmt("the declared document `%S` is named `%S` in its header", name, d->name);
    } else {
        e->doc = d;
    }
    smap_set(p->used, name, e);
    return e;
}

document *dbs_parse(str text, const smap *documents, diags *out)
{
    smap *used = dbs_alloc(sizeof *used);
    parser *p = parser_new(documents, NULL, used);
    return run(p, text, out);
}
