/*
 * Reads and checks one dbspec document line by line (PHP client Parser, docs/spec/dbspec.md). Rules within a line are checked on that line, and table-wide
 * rules when the block closes; rules between tables (foreign key targets, audit history and record tables) are checked
 * after the last line. Diagnostics carry the token's line and column (Unicode code points) and are sorted by line, column, then rule table order. Encoding,
 * header, and limit errors stop parsing and come after the diagnostics found before them.
 */
#include "message_quote.h"
#include "dbspec.h"
#include "dbspec_str_list.h"
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

/* table name => definition and column map. */
typedef struct {
    table *table;
    smap *columns;
    /* The table comes from a used document. */
    bool used;
    /* The names of the column and foreign key lines of the table that failed (Go's failedName); NULL for a used table. */
    smap *failed;
} tentry;

/* Parse result of a used document. */
typedef struct {
    document *doc;
    bool has_reason;
    str reason;
} used_entry;

/* [name, column, descending] */
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
    /* Go's known: the index check is done only when all child columns are known and do not overlap. */
    bool children_known;
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
    const fkey *fk;
    diag d;
    bool emitted;
} late_fk_rec;

typedef struct {
    smap *columns;
    fkey *fk;
    zend_long line, at, target_at;
    lcols parents;
} dfk_rec;

/* Determines the columns audit records. With include, only the columns in the list; otherwise the columns outside the list. */
typedef struct {
    bool include;
    str audit;
    smap listed;
} recorder;

typedef struct {
    table *audited;
    smap *columns;
    /* The names of the failed column and foreign key lines of the audited table (Go's failedName). */
    smap *failed;
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
    /* constraint_names: a constraint name of a used document => that document's name (str *); local_constraints: a constraint name of this document => tpos *. */
    smap constraint_names, local_constraints, used_documents, diagram_names, failed_tables, used_table_names;
    smap generated_names;
    smap syntax_lines;
    smap types;
    zend_long table_count, column_count, fk_count;

    zend_long line;
    str text;
    tokens t;
    strs comments;

    int state, top_phase;
    zend_long block_open[2], settings_open[2];
    /* The token text that block_open and settings_open point at: the brace, or the keyword when the opening line has no brace (Go's p.open). */
    str block_open_text, settings_open_text;
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
    /* The block a settings line reads: the table's first block, or, for a repeated block, a block not attached to the table (Go's detached settings). */
    settings *settings_block;
    bool detached_block;
    bool failed_primary;
    smap failed_key_tables;
    diagram *diagram;
    smap diagram_tables;

    VEC(dfk_rec) deferred_fks;
    VEC(late_fk_rec) late_fks;
    VEC(daudit_rec) deferred_audits;
    VEC(drecord_rec) deferred_records;
    smap failed_primary_tables;
    /* Number of column lines with syntax errors (Go's failedLines). */
    zend_long failed_lines;
    /* First lex error of the line: column and message. */
    bool lex_failed;
    zend_long lex_column;
    str lex_message;
    /* Name of the failed column and foreign key line (Go failedName). Created anew for each table. */
    smap failed_names;
    /* Class of read tokens: "line:index" => class. The classes of a line are discarded for a line with a syntax error and in the body of an open block (R1, R20). */
    smap marks;
    /* Set of lines that use only lexical classes ("line" => TRUEP). */
    smap lexical;
    /* True while a line is being read: a syntax error then discards that line (R1). */
    bool reading;
    /* Whether classes are recorded: only analysis records them; parse leaves no token data. */
    bool marking;
    /* The body of a block whose open line failed is read but has only lexical classes (R20). */
    bool table_failed;
    bool settings_failed;
    bool diagram_failed;
    /* Declaration positions of a successful parse (run sorts them by line and column). */
    dposv decls;

    jmp_buf stop_jump;
} parser;

static void claim_used_generated(parser *p, table *definition);

/* Error for a block not closed at the end of the document. Reported together with other syntax errors on the same line (Go does not limit it to once per line). */
static void unclosed(parser *p, zend_long line, zend_long column, str message)
{
    PUSH(p->diagnostics, mkdiag(str_c("syntax"), line, column, message));
}

static void error(parser *p, const char *rule, zend_long line, zend_long column, str message)
{
    if (strcmp(rule, "syntax") == 0) {
        /* A syntax error while reading discards that line (R1); errors in the check phase are not discarded. */
        if (p->reading && p->marking) {
            smap_set(&p->lexical, fmt("%d", line), TRUEP);
        }
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

/* Writes the escape of a control character as Go's strconv quoting does: \a \b \f \n \r \t \v, otherwise \xNN. */
str dbs_quote_with(str s, char delim)
{
    zend_string *quoted = orm_message_quote(s.s, s.n, delim);
    sbuf b = {0};
    sb_add(&b, ZSTR_VAL(quoted), ZSTR_LEN(quoted));
    zend_string_release(quoted);
    return sb_str(&b);
}

str dbs_quote(str s)
{
    return dbs_quote_with(s, '"');
}

/* A closed string literal token; its text keeps the quotes. */
static bool string_text(str s)
{
    return s.n >= 2 && s.s[0] == '\'' && s.s[s.n - 1] == '\'';
}

str dbs_describe(str token)
{
    if (string_text(token)) {
        return fmt("string '%S'", str_replace(str_sub(token, 1, token.n - 2), "''", "'"));
    }
    return fmt("'%S'", token);
}

/* The character at s[i] of the given width in single quotes, with the message quoting of INT-187. */
static str quote_rune(str s, size_t i, size_t width)
{
    return dbs_quote_with(str_sub(s, i, width), '\'');
}

/* Go's lexical word token (not a number): a run of word runes that is not digits with an optional fraction. */
static bool number_text(str s);

static bool word_text(str s)
{
    return str_dotted(s) && !number_text(s);
}

/* Go's cursor.fail: the syntax error at token i, or at the line end when the line has no token i. Returns false. */
static bool syntax_fail(parser *p, size_t i, const char *expected);
static bool value_at(parser *p, size_t i, const char *what, token *out, size_t *next);

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

static strs path1(str a)
{
    strs s = {0};
    PUSH(s, a);
    return s;
}

static strs path2(str a, str b)
{
    strs s = {0};
    PUSH(s, a);
    PUSH(s, b);
    return s;
}

/* Records the declaration in p->decls: its line and column come from the name token (for settings and primary key, the keyword). A failed parse does not write it. */
static void declare(parser *p, str kind, zend_long line, zend_long column, strs path)
{
    dpos d = {kind, path, line, column};
    PUSH(p->decls, d);
}

/* Identifying arguments of a setting (docs/spec/dbspec.md "Declaration positions"): for codec, markdown, navigation, and blind_index, the first argument;
 * the rest have none. */
static void declare_setting(parser *p, str keyword, zend_long column, const strs *args)
{
    strs path = path2(p->table->name, keyword);
    if (str_eqc(keyword, "codec") || str_eqc(keyword, "markdown") || str_eqc(keyword, "navigation") || str_eqc(keyword, "blind_index")) {
        PUSH(path, args->v[0]);
    }
    declare(p, SL("setting"), p->line, column, path);
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

/* Gives a class to the token read. A token made by the parser (line 0) has no class given. */
static void mark_token(parser *p, const token *t, const char *class)
{
    if (!p->marking || t == NULL || t->line == 0) {
        return;
    }
    smap_set(&p->marks, fmt("%d:%d", (int)t->line, (int)t->index), (void *)class);
}

/* Words in value positions: true, false, null and now are keywords (R6, R18). */
static void mark_value(parser *p, const token *t)
{
    if (t != NULL && (str_eqc(t->text, "true") || str_eqc(t->text, "false") || str_eqc(t->text, "null") || str_eqc(t->text, "now"))) {
        mark_token(p, t, "keyword");
    }
}

/* Go's nameDiagnostics: if a name violates the format or length, writes that rule and message and returns true. */
bool name_rule(str name, const char **rule, str *message)
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
        *rule = "name.format";
        *message = fmt("name %S does not match [a-z][a-z0-9_]* or is a reserved word", dbs_quote(name));
        return true;
    }
    if (name.n > 63) {
        *rule = "name.length";
        *message = fmt("name %S has %u bytes, more than 63", dbs_quote(name), name.n);
        return true;
    }
    return false;
}

/* Checks the format and length of a name token. */
static bool name_ok(parser *p, str name, zend_long column)
{
    const char *rule;
    str message;
    bool invalid = name_rule(name, &rule, &message);
    if (invalid) {
        error(p, rule, p->line, column, message);
    }
    if (name.n > 63 && (!invalid || strcmp(rule, "name.length") != 0)) {
        error(p, "name.length", p->line, column, fmt("name %S has %u bytes, more than 63", dbs_quote(name), name.n));
    }
    return !invalid;
}

static bool name_tok(parser *p, const token *t)
{
    mark_token(p, t, "name");
    return name_ok(p, t->text, t->column);
}

/* Line and column where a local constraint name is placed (value of local_constraints), and whether it already has a name.duplicate. */
typedef struct {
    zend_long line;
    zend_long column;
    bool reported;
} tpos;

/* Go's check of a constraint name of the document: a repeat, a constraint name of a used document (constraint_names maps it to that
 * document's name), then a table name. A table named later reports at the first place of the name (open_table). */
static void constraint_name(parser *p, const token *t)
{
    if (!name_tok(p, t)) {
        return;
    }
    if (smap_has(&p->local_constraints, t->text)) {
        error(p, "name.duplicate", p->line, t->column, fmt("index, unique key, foreign key or check name %S repeats in the schema", dbs_quote(t->text)));
        return;
    }
    tpos *loc = dbs_alloc(sizeof *loc);
    loc->line = p->line;
    loc->column = t->column;
    const str *owner = smap_get(&p->constraint_names, t->text);
    if (owner != NULL) {
        error(p, "name.duplicate", p->line, t->column, fmt("name %S is a constraint name of used document %S", dbs_quote(t->text), dbs_quote(*owner)));
        loc->reported = true;
    } else if (smap_has(&p->tables, t->text) || smap_has(&p->used_table_names, t->text)) {
        error(p, "name.duplicate", p->line, t->column, fmt("name %S is also a table name", dbs_quote(t->text)));
        loc->reported = true;
    }
    smap_set(&p->local_constraints, t->text, loc);
}

static bool syntax_fail(parser *p, size_t i, const char *expected)
{
    const token *t = tok(p, i);
    if (t != NULL) {
        error(p, "syntax", p->line, t->column, fmt("unexpected %S, expected %s", dbs_describe(t->text), expected));
    } else {
        error(p, "syntax", p->line, end_column(p), fmt("line ends, expected %s", expected));
    }
    return false;
}

/* Go's cursor.name: a word or a number token. */
static const token *word_at(parser *p, size_t i, const char *what)
{
    const token *t = tok(p, i);
    if (t == NULL || !str_dotted(t->text)) {
        syntax_fail(p, i, what);
        return NULL;
    }
    return t;
}

static bool expect_at(parser *p, size_t i, const char *expected)
{
    const token *t = tok(p, i);
    if (t == NULL || !str_eqc(t->text, expected)) {
        return syntax_fail(p, i, fmt("'%s'", expected).s);
    }
    /* A word the grammar expects is one of its fixed words (R12); punctuation keeps its lexical class. */
    if (expected[0] >= 'a' && expected[0] <= 'z') {
        mark_token(p, t, "keyword");
    }
    return true;
}

static bool end_at(parser *p, size_t i)
{
    return tok(p, i) == NULL || syntax_fail(p, i, "the end of the line");
}

/* Reads `( <column> [asc|desc], ... )` from token i onward. */
static bool column_list(parser *p, size_t i, bool directions, lcols *out, size_t *next)
{
    if (!expect_at(p, i, "(")) {
        return false;
    }
    i++;
    lcols columns = {0};
    for (;;) {
        const token *name = word_at(p, i, "a column name");
        if (name == NULL) {
            return false;
        }
        mark_token(p, name, "name");
        i++;
        bool descending = false;
        const token *n = tok(p, i);
        if (directions && n != NULL && (str_eqc(n->text, "asc") || str_eqc(n->text, "desc"))) {
            mark_token(p, n, "keyword");
            descending = str_eqc(n->text, "desc");
            i++;
            n = tok(p, i);
        }
        PUSH(columns, ((lcol){name->text, name->column, descending}));
        if (n != NULL && str_eqc(n->text, ",")) {
            i++;
            continue;
        }
        if (n == NULL || !str_eqc(n->text, ")")) {
            return syntax_fail(p, i, "',' or ')'");
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

/* The first encoding error after the byte order mark, as its line, column and message. A bare CR is not a line end,
 * so it is an error; the lines before the error's line are complete and valid (Go's splitSource). */
static bool encoding_error(str source, zend_long *line_out, zend_long *column_out, const char **message_out)
{
    bool bad = false;
    size_t offset = 0;
    const char *message = NULL;
    size_t valid = utf8_valid_prefix(source);
    if (valid < source.n) {
        bad = true;
        offset = valid;
        message = "text is not valid UTF-8";
    }
    for (size_t i = 0; i < source.n; i++) {
        if (source.s[i] == '\r' && (i + 1 >= source.n || source.s[i + 1] != '\n')) {
            if (!bad || i < offset) {
                bad = true;
                offset = i;
                message = "carriage return without a following line feed";
            }
            break;
        }
    }
    if (!bad) {
        return false;
    }
    size_t start = 0;
    zend_long line = 1;
    for (size_t i = 0; i < offset; i++) {
        if (source.s[i] == '\n') {
            line++;
            start = i + 1;
        }
    }
    *line_out = line;
    *column_out = (zend_long)utf8_length(str_sub(source, start, offset - start)) + 1;
    *message_out = message;
    return true;
}

/* -------------------------------------------------------------------- lines */

static bool digitc(char c)
{
    return c >= '0' && c <= '9';
}

/* A document name in the header is made only of ASCII letters, digits, and _, as in Go's isHeaderNameRune. */
static bool header_name_char(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || digitc(c) || c == '_';
}

/* Go's lexLine: splits a line into tokens. The first error is kept in p->lex_*. In recover mode, it keeps reading, skipping error characters
 * (Go's lexRecover is the same as replacing that character with a space and reading again). A word character is a character for which Go's isWordRune is true
 * (word_rune_width). */
static void lex_line(parser *p, bool recover)
{
    str s = p->text;
    /* The buffer of the line is reused: a line keeps no pointer into it past its own reading, and the arena keeps no copy of it. */
    p->t.n = 0;
    p->lex_failed = false;
    zend_long column = 1;
    size_t i = 0;
    while (i < s.n) {
        unsigned char c = (unsigned char)s.s[i];
        size_t len = 0;
        if (c == ' ') {
            i++;
            column++;
            continue;
        }
        if (c == '(' || c == ')' || c == '{' || c == '}' || c == ',' || c == '=' || c == '+' || c == '-' || c == '*' || c == '/') {
            len = 1;
        } else if (c == '<' || c == '>') {
            len = (i + 1 < s.n && (s.s[i + 1] == '=' || (c == '<' && s.s[i + 1] == '>'))) ? 2 : 1;
        } else if (c == '\'') {
            size_t j = i + 1;
            bool closed = false;
            while (j < s.n) {
                if (s.s[j] == '\'') {
                    if (j + 1 < s.n && s.s[j + 1] == '\'') {
                        j += 2;
                        continue;
                    }
                    j++;
                    closed = true;
                    break;
                }
                j++;
            }
            if (!closed) {
                if (!recover) {
                    p->lex_failed = true;
                    p->lex_column = column;
                    p->lex_message = SL("string is not closed on its line");
                    return;
                }
                i++;
                column++;
                continue;
            }
            len = j - i;
        } else if (word_rune_width(s, i) > 0) {
            len = word_run_end(s, i) - i;
        } else {
            size_t width = utf8_char_width(s, i);
            if (!recover) {
                p->lex_failed = true;
                p->lex_column = column;
                p->lex_message = fmt("character %S is not allowed here", quote_rune(s, i, width));
                return;
            }
            i += width;
            column++;
            continue;
        }
        str text = str_sub(s, i, len);
        zend_long index = (zend_long)p->t.n;
        PUSH(p->t, ((token){text, column, p->line, index}));
        column += (zend_long)utf8_count(text);
        i += len;
    }
}

static void tokenize(parser *p)
{
    lex_line(p, false);
}

static void fail_column(parser *p, str name)
{
    smap_set(&p->failed_names, name, TRUEP);
    if (!smap_has(p->columns, name)) {
        smap_set(p->columns, name, column_new(name, ctype_new(SL("invalid"), NULL, 0), false, false, NULL));
        smap_set(&p->invalid_types, name, TRUEP);
    }
}

static void fail_key(parser *p, bool primary)
{
    if (primary) {
        p->failed_primary = true;
        smap_set(&p->failed_primary_tables, p->table->name, TRUEP);
        return;
    }
    smap_set(&p->failed_key_tables, p->table->name, TRUEP);
}

/* A column line with a syntax error keeps only the syntax error, as in Go: name and type checks are done only when the line matches the syntax. */
static void keep_syntax_since(parser *p, size_t mark)
{
    size_t out = mark;
    for (size_t i = mark; i < p->diagnostics.n; i++) {
        if (str_eqc(p->diagnostics.v[i].rule, "syntax")) {
            p->diagnostics.v[out++] = p->diagnostics.v[i];
        }
    }
    p->diagnostics.n = out;
}

/* Checks whether the line had a syntax error (same key as the syntax line record of error). */
static bool syntax_here(parser *p)
{
    return smap_has(&p->syntax_lines, fmt("%d", p->line));
}

/* Opens a settings block. A repeated block is not attached to the table; only its syntax is read (Go's detached settings block). */
static void open_settings_block(parser *p, settings *s)
{
    p->detached_block = p->table->settings != NULL;
    if (!p->detached_block) {
        p->table->settings = s;
    }
    p->settings_block = p->detached_block ? s : p->table->settings;
    p->settings_failed = syntax_here(p);
}

static void start_settings_block(parser *p)
{
    token first = p->t.v[0];
    settings *s = dbs_alloc(sizeof *s);
    s->comments = take_comments(p);
    open_settings_block(p, s);
    p->settings_open[0] = p->line;
    bool brace = p->t.n > 1 && str_eqc(p->t.v[1].text, "{");
    p->settings_open[1] = brace ? p->t.v[1].column : first.column;
    p->settings_open_text = brace ? SL("{") : first.text;
    p->state = S_SETTINGS;
}

/* A table line with a lex error (not }) keeps only its state and failed name, as in Go's tableLine. */
static void lexed_table_line(parser *p)
{
    token first = p->t.v[0];
    str w = first.text;
    if (str_eqc(w, "settings")) {
        p->table_phase = 2;
        start_settings_block(p);
        return;
    }
    if (str_eqc(w, "primary")) {
        fail_key(p, true);
    } else if (str_eqc(w, "unique") || str_eqc(w, "index")) {
        fail_key(p, false);
    } else if (str_eqc(w, "foreign")) {
        if (p->t.n > 2 && str_dotted(p->t.v[2].text)) {
            smap_set(&p->failed_names, p->t.v[2].text, TRUEP);
        }
    } else if (str_eqc(w, "check")) {
        /* Does not know anything */
    } else {
        p->failed_lines++;
        if (str_dotted(w)) {
            fail_column(p, w);
        }
    }
}

/* Checks whether a line with a lex error has anything to read: a closing } line or the top line goes to normal dispatch. */
static bool lexed_line(parser *p)
{
    if (p->t.n == 0) {
        return true;
    }
    if (str_eqc(p->t.v[0].text, "}")) {
        return false;
    }
    switch (p->state) {
        case S_TOP:
            return false;
        case S_TABLE:
            lexed_table_line(p);
            return true;
        default:
            return true;
    }
}

/* A header error points at the first character deviating from `dbspec 1 <name>`, or, if a part is missing, at the next column after the line's end. Everything before it is
 * ASCII, so the byte offset is the column. */
static void header(parser *p)
{
    const char *prefix = "dbspec 1 ";
    size_t pn = strlen(prefix);
    size_t same = 0;
    while (same < pn && same < p->text.n && p->text.s[same] == prefix[same]) {
        same++;
    }
    if (same < pn) {
        stop(p, "header", 1, (zend_long)(same < p->text.n ? same : p->text.n) + 1, SL("the first line is exactly dbspec 1 <document>"));
    }
    size_t end = pn;
    while (end < p->text.n && header_name_char(p->text.s[end])) {
        end++;
    }
    if (end == pn || end < p->text.n) {
        stop(p, "header", 1, (zend_long)end + 1, SL("the first line is exactly dbspec 1 <document>"));
    }
    mark_token(p, &p->t.v[0], "keyword");
    name_tok(p, &p->t.v[2]);
    p->doc = document_new(p->t.v[2].text);
    declare(p, SL("document"), p->line, p->t.v[2].column, path1(p->t.v[2].text));
}

static used_entry *used_document(parser *p, str name);

static str use_cycle_reason(parser *p, str name)
{
    (void)p;
    return fmt("using document %S closes a use cycle", dbs_quote(name));
}

static void use_line(parser *p)
{
    const token *docname = word_at(p, 1, "a document name");
    if (docname == NULL) {
        return;
    }
    mark_token(p, docname, "name");
    if (!expect_at(p, 2, "{")) {
        return;
    }
    VEC(token) tables = {0};
    size_t i = 3;
    for (;;) {
        const token *t = word_at(p, i, "a table name");
        if (t == NULL) {
            return;
        }
        mark_token(p, t, "name");
        PUSH(tables, *t);
        i++;
        if (tok_is(p, i, ",")) {
            i++;
            continue;
        }
        if (!tok_is(p, i, "}")) {
            syntax_fail(p, i, "',' or '}'");
            return;
        }
        break;
    }
    if (!end_at(p, i + 1)) {
        return;
    }
    if (p->top_phase > 0) {
        error(p, "order", p->line, p->t.v[0].column, SL("use lines come before table and diagram blocks"));
    }
    str name = docname->text;
    useline *u = dbs_alloc(sizeof *u);
    u->document = name;
    for (size_t k = 0; k < tables.n; k++) {
        PUSH(u->tables, tables.v[k].text);
    }
    u->comments = take_comments(p);
    PUSH(p->doc->uses, u);
    declare(p, SL("use"), p->line, docname->column, path1(name));
    for (size_t k = 0; k < tables.n; k++) {
        declare(p, SL("use_table"), p->line, tables.v[k].column, path2(name, tables.v[k].text));
    }
#define FAILED() for (size_t k = 0; k < tables.n; k++) smap_set(&p->failed_tables, tables.v[k].text, TRUEP)
    if (!name_tok(p, docname)) {
        FAILED();
        return;
    }
    if (smap_has(&p->used_documents, name)) {
        error(p, "name.duplicate", p->line, docname->column, fmt("document %S is used twice", dbs_quote(name)));
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
        has_reason = true;
        reason = use_cycle_reason(p, name);
    } else if (!smap_has(p->documents, name)) {
        has_reason = true;
        reason = fmt("document %S is not in the declared document set", dbs_quote(name));
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
    for (size_t k = 0; k < used->tables.n; k++) {
        table *d = used->tables.v[k];
        smap_set(&p->used_table_names, d->name, TRUEP);
        strs names = {0};
        for (size_t x = 0; x < d->uniques.n; x++) PUSH(names, d->uniques.v[x]->name);
        for (size_t x = 0; x < d->indexes.n; x++) PUSH(names, d->indexes.v[x]->name);
        for (size_t x = 0; x < d->fks.n; x++) PUSH(names, d->fks.v[x]->name);
        for (size_t x = 0; x < d->checks.n; x++) PUSH(names, d->checks.v[x]->name);
        for (size_t x = 0; x < names.n; x++) {
            const str *owner = smap_get(&p->constraint_names, names.v[x]);
            if (owner != NULL && !str_eq(*owner, name) && !repeated_found) {
                repeated_found = true;
                error(p, "name.duplicate", p->line, docname->column, fmt("document %S repeats constraint name %S of document %S",
                    dbs_quote(name), dbs_quote(names.v[x]), dbs_quote(*owner)));
            }
            if (owner == NULL) {
                str *document_name = dbs_alloc(sizeof *document_name);
                *document_name = name;
                smap_set(&p->constraint_names, names.v[x], document_name);
            }
        }
    }
    smap listed = {0};
    for (size_t k = 0; k < tables.n; k++) {
        token *t = &tables.v[k];
        if (!name_tok(p, t)) {
            smap_set(&p->failed_tables, t->text, TRUEP);
            continue;
        }
        if (smap_has(&listed, t->text)) {
            error(p, "name.duplicate", p->line, t->column, fmt("table %S is listed twice", dbs_quote(t->text)));
            continue;
        }
        smap_set(&listed, t->text, TRUEP);
        table *definition = NULL;
        for (size_t x = 0; x < used->tables.n; x++) {
            if (str_eq(used->tables.v[x]->name, t->text)) {
                definition = used->tables.v[x];
                break;
            }
        }
        if (definition == NULL) {
            error(p, "use", p->line, t->column, fmt("document %S does not define table %S", dbs_quote(name), dbs_quote(t->text)));
            smap_set(&p->failed_tables, t->text, TRUEP);
            continue;
        }
        if (smap_has(&p->tables, t->text)) {
            error(p, "name.duplicate", p->line, t->column, fmt("table %S is already used from another document", dbs_quote(t->text)));
            continue;
        }
        tentry *e = dbs_alloc(sizeof *e);
        e->table = definition;
        e->used = true;
        e->columns = dbs_alloc(sizeof(smap));
        for (size_t x = 0; x < definition->columns.n; x++) {
            if (!smap_has(e->columns, definition->columns.v[x]->name)) {
                smap_set(e->columns, definition->columns.v[x]->name, definition->columns.v[x]);
            }
        }
        claim_used_generated(p, definition);
        smap_set(&p->tables, t->text, e);
    }
}

static void open_table(parser *p, bool out_of_order)
{
    if (++p->table_count > MAX_TABLES) {
        stop(p, "limit", p->line, p->t.v[0].column, fmt("document has more than %d tables", (zend_long)MAX_TABLES));
    }
    const token *n = tok(p, 1);
    token name;
    bool header_failed = false;
    bool brace = false;
    if (n == NULL || !str_dotted(n->text)) {
        syntax_fail(p, 1, "a table name");
        name = (token){SL(""), p->t.v[0].column, 0, 0};
        header_failed = true;
    } else {
        name = *n;
        if (expect_at(p, 2, "{")) {
            brace = true;
            if (!end_at(p, 3)) {
                header_failed = true;
            }
        } else {
            header_failed = true;
        }
        if (!header_failed) {
            name_tok(p, &name);
            if (out_of_order) {
                error(p, "order", p->line, p->t.v[0].column, SL("table blocks come before diagram blocks"));
            }
        }
    }
    table *t = table_new(name.text);
    t->comments = take_comments(p);
    t->header_failed = header_failed;
    /* R20: the body of a block whose opening line failed (a syntax diagnostic on it) keeps lexical classes. */
    p->table_failed = syntax_here(p);
    PUSH(p->doc->tables, t);
    declare(p, SL("table"), p->line, name.column, path1(name.text));
    if (name.text.n > 0) {
        if (smap_has(&p->tables, name.text)) {
            /* Go does not report a duplicate name for a table whose table line failed (validate.go's failed table). */
            if (!header_failed) {
                const tentry *before = smap_get(&p->tables, name.text);
                error(p, "name.duplicate", p->line, name.column, before->used ? fmt("table %S is also a used table", dbs_quote(name.text))
                    : fmt("table %S is defined twice", dbs_quote(name.text)));
            }
        } else {
            /* Go reports a constraint with the same name as a table at the constraint's position (even if the table comes later); a
             * constraint name of a used document is reported at the table. */
            tpos *loc = smap_get(&p->local_constraints, name.text);
            const str *owner = smap_get(&p->constraint_names, name.text);
            if (loc != NULL && !loc->reported) {
                error(p, "name.duplicate", loc->line, loc->column, fmt("name %S is also a table name", dbs_quote(name.text)));
                loc->reported = true;
            }
            if (owner != NULL && !header_failed) {
                error(p, "name.duplicate", p->line, name.column, fmt("table %S is named like a constraint of document %S", dbs_quote(name.text), dbs_quote(*owner)));
            }
            tentry *e = dbs_alloc(sizeof *e);
            e->table = t;
            e->columns = dbs_alloc(sizeof(smap));
            smap_set(&p->tables, name.text, e);
        }
    }
    p->state = S_TABLE;
    p->block_open[0] = p->line;
    p->block_open[1] = brace ? p->t.v[2].column : p->t.v[0].column;
    p->block_open_text = brace ? SL("{") : p->t.v[0].text;
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
    p->failed_names = (smap){0};
    p->failed_primary = false;
    p->failed_lines = 0;
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

/* The message of DBS-162 for a parameterized type whose parameters are wrong. */
static str type_parameters_message(str name)
{
    return str_eqc(name, "decimal") ? SL("decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p")
        : str_eqc(name, "varchar") ? SL("varchar(n) needs 1 <= n <= 16383") : fmt("%S(p) needs 0 <= p <= 6", name);
}

/* Reads the type of token i. NULL if the type is wrong. */
static ctype *read_type(parser *p, size_t i, size_t *next)
{
    mark_token(p, &p->t.v[i], "type");
    str name = p->t.v[i].text;
    zend_long column = p->t.v[i].column;
    bool paren = tok_is(p, i + 1, "(");
    bool simple = dbspec_str_in_list(name, simple_types);
    int arity = parameterized(name);
    if (simple && !paren) {
        *next = i + 1;
        return intern_type(p, name, NULL, 0);
    }
    if (arity == 0 || !paren) {
        error(p, "type", p->line, column, simple ? fmt("%S takes no parameters", name)
            : arity > 0 ? type_parameters_message(name) : fmt("type %S is not a dbspec type", dbs_quote(name)));
        *next = paren ? skip_parentheses(p, i + 1) : i + 1;
        return NULL;
    }
    VEC(zend_long) params = {0};
    size_t j = i + 2;
    bool malformed = false;
    /* As in Go, reads values (numbers, words, `-` numbers) and separators. Another token in a value position, or a separator that is not `,` or `)`, is a syntax error. */
    for (;;) {
        const token *v = tok(p, j);
        if (v != NULL && str_eqc(v->text, "-")) {
            if (tok(p, j + 1) == NULL || !number_text(tok(p, j + 1)->text)) {
                syntax_fail(p, j + 1, "a number after '-'");
                *next = skip_parentheses(p, j);
                return NULL;
            }
            malformed = true;
            PUSH(params, ZEND_LONG_MAX);
            j += 2;
        } else if (v != NULL && str_digits(v->text)) {
            str digits = v->text;
            size_t lead = 0;
            while (lead < digits.n && digits.s[lead] == '0') {
                lead++;
            }
            zend_long value = digits.n - lead > 6 ? ZEND_LONG_MAX : ZEND_STRTOL(str_of(digits.s, digits.n).s, NULL, 10);
            PUSH(params, value);
            j++;
        } else if (v != NULL && str_dotted(v->text)) {
            malformed = true;
            PUSH(params, ZEND_LONG_MAX);
            j++;
        } else {
            syntax_fail(p, j, "a type parameter");
            *next = skip_parentheses(p, j);
            return NULL;
        }
        if (tok_is(p, j, ",")) {
            j++;
            continue;
        }
        if (tok_is(p, j, ")")) {
            j++;
            break;
        }
        syntax_fail(p, j, "',' or ')'");
        *next = skip_parentheses(p, j);
        return NULL;
    }
    if (malformed) {
        error(p, "type", p->line, column, type_parameters_message(name));
        *next = j;
        return NULL;
    }
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
        error(p, "type", p->line, column, type_parameters_message(name));
        *next = j;
        return NULL;
    }
    *next = j;
    return intern_type(p, name, params.v, params.n);
}

/* If a preceding table or a table in the document being written already uses the same renderer name, reports it at the later position (docs/spec/dbspec.md "Names"). */
/* If the table of the document being written, or a preceding table, already wrote this renderer name, reports both sources at the later position (docs/spec/dbspec.md "Names"). */
/* The source of a generated name: the format of its message and the table (and column) it names. The text is made only for a
 * diagnostic, so a column that claims its generated name keeps no formatted text. */
typedef struct {
    const char *form;
    str table, column;
} gsource;

#define GSRC(form, table, column) ((gsource){(form), (table), (column)})

static str gsource_text(const gsource *g)
{
    return fmt(g->form, g->table, g->column);
}

static void record_generated(parser *p, str name, gsource source)
{
    gsource *own = dbs_alloc(sizeof *own);
    *own = source;
    smap_set(&p->generated_names, name, own);
}

static void claim_generated(parser *p, zend_long line, zend_long column, str name, gsource source)
{
    gsource *first = smap_get(&p->generated_names, name);
    if (first != NULL) {
        error(p, "name.duplicate", line, column, fmt("generated name %S of %S repeats the generated name of %S", name, gsource_text(&source), gsource_text(first)));
        return;
    }
    record_generated(p, name, source);
}

/* Records the renderer name written by a table of the document being written. The diagnostic is issued by that document. */
static void claim_used_generated(parser *p, table *definition)
{
    for (size_t x = 0; x < definition->columns.n; x++) {
        column *c = definition->columns.v[x];
        if (c->identity || c->type == NULL || str_eqc(c->type->name, "text") || str_eqc(c->type->name, "bytes")) {
            continue;
        }
        record_generated(p, dbs_renderer_name(definition->name, c->name), GSRC("used table %S", definition->name, SNULL));
    }
    if (definition->settings == NULL) {
        return;
    }
    for (size_t x = 0; x < definition->settings->list.n; x++) {
        setting *s = definition->settings->list.v[x];
        const char *events[3] = {NULL, NULL, NULL};
        size_t count = 0;
        if (str_eqc(s->kind, "immutable")) {
            events[0] = "immutable_update";
            events[1] = "immutable_delete";
            count = 2;
        } else if (str_eqc(s->kind, "audit")) {
            events[0] = "audit_insert";
            events[1] = "audit_update";
            events[2] = "audit_delete";
            count = 3;
        }
        for (size_t e = 0; e < count; e++) {
            record_generated(p, dbs_renderer_name(definition->name, str_c(events[e])), GSRC("used table %S", definition->name, SNULL));
        }
    }
}

static void column_line(parser *p)
{
    const token *t0 = &p->t.v[0];
    if ((zend_long)p->table->columns.n + 1 > MAX_TABLE_COLUMNS) {
        stop(p, "limit", p->line, t0->column, fmt("table has more than %d columns", (zend_long)MAX_TABLE_COLUMNS));
    }
    if (++p->column_count > MAX_COLUMNS) {
        stop(p, "limit", p->line, t0->column, fmt("document has more than %d columns", (zend_long)MAX_COLUMNS));
    }
    const token *name = word_at(p, 0, "a column name, key, index, foreign key, check, settings or '}'");
    if (name == NULL) {
        return;
    }
    bool well_formed = name_tok(p, name);
    if (p->t.n < 2 || !word_text(p->t.v[1].text)) {
        syntax_fail(p, 1, "a type");
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
        mark_token(p, &p->t.v[i], "keyword");
        nullable = true;
        i++;
    }
    if (tok_is(p, i, "identity")) {
        mark_token(p, &p->t.v[i], "keyword");
        identity = &p->t.v[i];
        i++;
    }
    if (tok_is(p, i, "default")) {
        mark_token(p, &p->t.v[i], "keyword");
        keyword = p->t.v[i];
        if (value_at(p, i + 1, "a default value", &value, &i)) {
            has_default = true;
        } else {
            i = p->t.n;
        }
    }
    end_at(p, i);
    bool rejected = false;
    if (identity != NULL) {
        if (nullable) {
            error(p, "column", p->line, identity->column, SL("an identity column cannot be null"));
            rejected = true;
        } else if (type != NULL && !str_eqc(type->name, "i64")) {
            error(p, "column", p->line, identity->column, fmt("an identity column has type i64, not %S", ctype_text(type)));
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
        } else if (type != NULL && (str_eqc(type->name, "text") || str_eqc(type->name, "bytes"))) {
            error(p, "column", p->line, keyword.column, fmt("a %S column has no default", type->name));
        } else if (type != NULL) {
            str problem;
            if (literal_column_default(type, value.text, &canonical, &problem)) {
                has_canonical = true;
            } else {
                error(p, "column", p->line, value.column, fmt("default %S is not a literal of type %S", dbs_describe(value.text), ctype_text(type)));
            }
        }
    }
    column *c = column_new(name->text, type != NULL ? type : ctype_new(SL("invalid"), NULL, 0), nullable, identity != NULL,
        has_canonical ? &canonical : NULL);
    c->comments = take_comments(p);
    /* For a column whose renderer writes a type CHECK, its name <table>$<column> keeps within the name limit. */
    if (identity == NULL && type != NULL && !str_eqc(type->name, "text") && !str_eqc(type->name, "bytes") && well_formed
        && dbs_valid_name(p->table->name)) {
        claim_generated(p, p->line, name->column, dbs_renderer_name(p->table->name, name->text),
            GSRC("table %S column %S", p->table->name, name->text));
    }
    if (smap_has(p->columns, name->text)) {
        error(p, "name.duplicate", p->line, name->column, fmt("column %S repeats in the table", dbs_quote(name->text)));
    } else {
        smap_set(p->columns, name->text, c);
        if (type == NULL) {
            smap_set(&p->invalid_types, name->text, TRUEP);
        }
    }
    PUSH(p->table->columns, c);
    declare(p, SL("column"), p->line, name->column, path2(p->table->name, name->text));
}

static void check_key_columns(parser *p, const lcols *columns, zend_long at, bool primary)
{
    if (columns->n > MAX_KEY_COLUMNS) {
        error(p, "key", p->line, at, fmt("a key or index lists %u columns, more than %d", columns->n, (zend_long)MAX_KEY_COLUMNS));
    }
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
            error(p, "key", p->line, position, fmt("column %S is not a column of table %S", dbs_quote(name), dbs_quote(p->table->name)));
            continue;
        }
        if (smap_has(&seen, name)) {
            error(p, "key", p->line, position, fmt("column %S repeats in the key", dbs_quote(name)));
            continue;
        }
        smap_set(&seen, name, TRUEP);
        bool valid = !smap_has(&p->invalid_types, name);
        if (valid && (str_eqc(c->type->name, "text") || str_eqc(c->type->name, "bytes"))) {
            error(p, "key", p->line, position, fmt("a %S column cannot be part of a key or index", c->type->name));
        }
        if (primary && c->nullable) {
            error(p, "key", p->line, position, fmt("primary key column %S is nullable", dbs_quote(name)));
        }
        if (valid && str_eqc(c->type->name, "varchar")) {
            varchar += c->type->p[0];
        }
    }
    if (varchar > MAX_KEY_VARCHAR) {
        error(p, "key", p->line, at, fmt("the varchar columns of the key total %d characters, more than %d", varchar, (zend_long)MAX_KEY_VARCHAR));
    }
}

/* Go's constraintOrder: a constraint line that reads completely is in order before the settings block. */
static void constraint_order(parser *p, const token *keyword)
{
    if (p->table_phase == 2) {
        error(p, "order", p->line, keyword->column, SL("key, index, foreign key and check lines come before the settings block"));
        return;
    }
    p->table_phase = 1;
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
    constraint_order(p, &first);
    if (p->table->pk != NULL) {
        error(p, "key", p->line, first.column, SL("table has more than one primary key"));
        return;
    }
    pkey *k = dbs_alloc(sizeof *k);
    k->columns = lcol_names(&list);
    k->comments = take_comments(p);
    p->table->pk = k;
    declare(p, SL("constraint"), p->line, first.column, path2(p->table->name, SL("primary key")));
    check_key_columns(p, &list, first.column, true);
}

static void key_line(parser *p, bool index)
{
    const token *name = word_at(p, 1, index ? "a index name" : "a unique name");
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
    constraint_order(p, &p->t.v[0]);
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
    declare(p, SL("constraint"), p->line, name->column, path2(p->table->name, name->text));
    check_key_columns(p, &list, name->column, false);
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
        stop(p, "limit", p->line, p->t.v[0].column, fmt("document has more than %d foreign keys", (zend_long)MAX_FOREIGN_KEYS));
    }
    if (!expect_at(p, 1, "key")) {
        return;
    }
    const token *name = word_at(p, 2, "a foreign key name");
    if (name == NULL) {
        return;
    }
    /* If a line ends in a syntax error, its name is failed (Go markFailed). On success, only the earlier failure mark is kept. */
    bool failed_before = smap_has(&p->failed_names, name->text);
    smap_set(&p->failed_names, name->text, TRUEP);
    lcols children, parents;
    size_t next, after;
    if (!column_list(p, 3, false, &children, &next) || !expect_at(p, next, "references")) {
        return;
    }
    const token *target = word_at(p, next + 1, "a table name");
    if (target == NULL) {
        return;
    }
    if (!column_list(p, next + 2, false, &parents, &after)) {
        return;
    }
    size_t i = after;
    str actions[2] = {SL("restrict"), SL("restrict")};
    token unknown[2];
    bool is_unknown[2] = {false, false};
    /* Go: `on delete <action>`, then `on update <action>`; an action is a word or a number, and only the three actions are keywords. */
    for (int e = 0; e < 2; e++) {
        if (e == 0 ? !(tok_is(p, i, "on") && tok_is(p, i + 1, "delete")) : !tok_is(p, i, "on")) {
            continue;
        }
        mark_token(p, &p->t.v[i], "keyword");
        if (e == 1 && !expect_at(p, i + 1, "update")) {
            return;
        }
        mark_token(p, &p->t.v[i + 1], "keyword");
        const token *action = tok(p, i + 2);
        if (action == NULL || !str_dotted(action->text)) {
            syntax_fail(p, i + 2, "an action");
            return;
        }
        if (dbspec_str_in_list(action->text, fk_actions)) {
            mark_token(p, action, "keyword");
        }
        actions[e] = action->text;
        if (!dbspec_str_in_list(action->text, fk_actions)) {
            unknown[e] = *action;
            is_unknown[e] = true;
        }
        i += 3;
    }
    if (!end_at(p, i)) {
        return;
    }
    constraint_order(p, &p->t.v[0]);
    for (int e = 0; e < 2; e++) {
        if (is_unknown[e]) {
            error(p, "foreign_key", p->line, unknown[e].column, fmt("action %S is not restrict, cascade or set_null", dbs_quote(unknown[e].text)));
        }
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
    declare(p, SL("constraint"), p->line, name->column, path2(p->table->name, name->text));
    bool known = true;
    bool children_known = true;
    smap seen = {0};
    for (size_t k = 0; k < children.n; k++) {
        str c = children.v[k].name;
        zend_long position = children.v[k].column;
        if (!name_ok(p, c, position)) {
            known = false;
            children_known = false;
        } else if (!smap_has(p->columns, c)) {
            error(p, "foreign_key", p->line, position, fmt("column %S is not a column of table %S", dbs_quote(c), dbs_quote(p->table->name)));
            known = false;
            children_known = false;
        } else if (smap_has(&seen, c)) {
            error(p, "foreign_key", p->line, position, fmt("column %S repeats in the foreign key", dbs_quote(c)));
            known = false;
            children_known = false;
        } else if (smap_has(&p->invalid_types, c)) {
            known = false;
        }
        smap_set(&seen, c, TRUEP);
    }
    PUSH(p->table_fks, ((tfk_rec){f, p->line, name->column, known, children_known}));
    for (size_t k = 0; k < parents.n; k++) {
        if (!name_ok(p, parents.v[k].name, parents.v[k].column)) {
            resolvable = false;
        }
    }
    if (resolvable) {
        PUSH(p->deferred_fks, ((dfk_rec){copy_map(p->columns), f, p->line, name->column, target->column, parents}));
    }
    if (!failed_before) {
        smap_del(&p->failed_names, name->text);
    }
}

static void check_line(parser *p)
{
    const token *name = word_at(p, 1, "a check name");
    if (name == NULL || !expect_at(p, 2, "(")) {
        return;
    }
    /* Go: the tokens after `(` end with `)`; otherwise the line fails at its end and declares no check. */
    if (p->t.n <= 3 || !str_eqc(p->t.v[p->t.n - 1].text, ")")) {
        syntax_fail(p, p->t.n, "')' at the end of the check");
        return;
    }
    constraint_order(p, &p->t.v[0]);
    constraint_name(p, name);
    check *k = dbs_alloc(sizeof *k);
    k->name = name->text;
    k->expression = SL("");
    k->comments = take_comments(p);
    PUSH(p->table->checks, k);
    declare(p, SL("constraint"), p->line, name->column, path2(p->table->name, name->text));
    tokens rest = {0};
    for (size_t i = 3; i + 1 < p->t.n; i++) {
        PUSH(rest, p->t.v[i]);
    }
    PUSH(p->table_checks, ((tcheck_rec){k, p->line, rest, p->t.v[p->t.n - 1].column}));
}

/* Reads the audit's `exclude (<column>, ...)` and `include (<column>, ...)` lists of a line whose syntax old_setting_syntax read. */
static void audit_list_tokens(parser *p, const tokens *t, audit_lists *out)
{
    audit_lists lists = {0};
    size_t i = 0;
    while (i < t->n) {
        mark_token(p, &t->v[i], "keyword");
        audit_list l = {t->v[i], {0}};
        /* keyword ( name { , name } ) */
        for (i += 2; i < t->n; i += 2) {
            mark_token(p, &t->v[i], "name");
            PUSH(l.columns, t->v[i]);
            if (str_eqc(t->v[i + 1].text, ")")) {
                break;
            }
        }
        i += 2;
        PUSH(lists, l);
    }
    *out = lists;
}

/* ----------------------------------------------- markdown, store, and mapping settings */

/* Like Go's cursor, reads the tokens of a line in order. The first failure is one syntax error, and the rest of the line is not read. */
typedef struct {
    parser *p;
    const tokens *t;
    size_t i;
} scursor;

/* A name token is a word or a number. */
static bool number_text(str s)
{
    size_t i = 0;
    while (i < s.n && digitc(s.s[i])) {
        i++;
    }
    if (i == 0) {
        return false;
    }
    if (i == s.n) {
        return true;
    }
    if (s.s[i] != '.' || i + 1 == s.n) {
        return false;
    }
    for (size_t k = i + 1; k < s.n; k++) {
        if (!digitc(s.s[k])) {
            return false;
        }
    }
    return true;
}

static bool name_text(str s)
{
    return str_dotted(s) || number_text(s);
}

static bool sc_more(const scursor *c)
{
    return c->i < c->t->n;
}

static bool sc_is(const scursor *c, const char *text)
{
    return sc_more(c) && str_eqc(c->t->v[c->i].text, text);
}

static bool sc_fail(scursor *c, str expected)
{
    if (sc_more(c)) {
        const token *t = &c->t->v[c->i];
        error(c->p, "syntax", c->p->line, t->column, fmt("unexpected %S, expected %S", dbs_describe(t->text), expected));
    } else {
        error(c->p, "syntax", c->p->line, end_column(c->p), fmt("line ends, expected %S", expected));
    }
    return false;
}

static bool sc_name(scursor *c, str what, token *out)
{
    if (sc_more(c) && name_text(c->t->v[c->i].text)) {
        *out = c->t->v[c->i++];
        return true;
    }
    return sc_fail(c, what);
}

static bool sc_oneof(scursor *c, str what, const char *const *words, size_t n, token *out)
{
    for (size_t k = 0; sc_more(c) && k < n; k++) {
        if (str_eqc(c->t->v[c->i].text, words[k])) {
            mark_token(c->p, &c->t->v[c->i], "keyword");
            *out = c->t->v[c->i++];
            return true;
        }
    }
    return sc_fail(c, what);
}

static bool sc_end(scursor *c)
{
    return !sc_more(c) || sc_fail(c, SL("the end of the line"));
}

static bool take_name(scursor *c, str what, tokens *args)
{
    token t;
    if (!sc_name(c, what, &t)) {
        return false;
    }
    mark_token(c->p, &t, "name");
    PUSH(*args, t);
    return true;
}

/* Reads the arguments of the markdown, store, title, body, order, and task_marker lines in the same order as Go's settingsLine. */
static bool new_setting_args(scursor *c, str keyword, tokens *args)
{
    if (str_eqc(keyword, "markdown") || str_eqc(keyword, "title") || str_eqc(keyword, "body") || str_eqc(keyword, "order")
        || str_eqc(keyword, "task_marker")) {
        return take_name(c, SL("a column name"), args) && sc_end(c);
    }
    /* store */
    static const char *const kinds[] = {"files", "document", "block"};
    static const char *const shapes[] = {"list", "table"};
    token kind;
    if (!sc_oneof(c, SL("'files', 'document' or 'block'"), kinds, 3, &kind)) {
        return false;
    }
    PUSH(*args, kind);
    if (str_eqc(kind.text, "block") && !take_name(c, SL("a foreign key name"), args)) {
        return false;
    }
    if (!str_eqc(kind.text, "files")) {
        token shape;
        if (!sc_oneof(c, SL("'list' or 'table'"), shapes, 2, &shape)) {
            return false;
        }
        PUSH(*args, shape);
    }
    /* The shard clause is also read in a block: shard in a block table is a setting error. The `shard` token is kept for its position. */
    if (sc_is(c, "shard")) {
        static const char *const periods[] = {"year", "month", "day"};
        mark_token(c->p, &c->t->v[c->i], "keyword");
        PUSH(*args, c->t->v[c->i]);
        c->i++;
        if (!take_name(c, SL("the shard column"), args)) {
            return false;
        }
        token period;
        if (!sc_oneof(c, SL("'year', 'month' or 'day'"), periods, 3, &period)) {
            return false;
        }
        PUSH(*args, period);
    }
    return sc_end(c);
}

/* A key of a kind this line may use only once. markdown is checked separately, by its column. */
static bool once_kind(str kind)
{
    return str_eqc(kind, "store") || str_eqc(kind, "title") || str_eqc(kind, "body") || str_eqc(kind, "order")
        || str_eqc(kind, "task_marker");
}

static bool new_setting_kind(str keyword)
{
    return str_eqc(keyword, "markdown") || str_eqc(keyword, "store") || str_eqc(keyword, "title")
        || str_eqc(keyword, "body") || str_eqc(keyword, "order") || str_eqc(keyword, "task_marker");
}

/* Number of tokens before the shard clause for each store kind (including the kind; Setting::STORE_ARGUMENTS). */
static size_t store_arguments(str kind)
{
    return str_eqc(kind, "files") ? 1 : str_eqc(kind, "document") ? 2 : 3;
}

/* One setting line of a new kind. args are the tokens the check uses, and the setting's argument is their text. */
static void new_setting(parser *p, token keyword)
{
    scursor c = {p, &p->t, 1};
    tokens args = {0};
    if (!new_setting_args(&c, keyword.text, &args)) {
        return;
    }
    str kind = keyword.text;
    if (!p->detached_block) {
        if (once_kind(kind) || str_eqc(kind, "markdown")) {
            str key = str_eqc(kind, "markdown") ? fmt("markdown %S", args.v[0].text) : kind;
            if (smap_has(&p->setting_keys, key)) {
                error(p, "setting", p->line, keyword.column, str_eqc(kind, "markdown")
                    ? fmt("markdown repeats for %S", dbs_quote(args.v[0].text)) : fmt("setting %S repeats", kind));
                return;
            }
            smap_set(&p->setting_keys, key, TRUEP);
        }
    }
    setting *s = dbs_alloc(sizeof *s);
    s->kind = kind;
    s->comments = take_comments(p);
    /* The `shard` token of store is not an argument: the arguments are the column and period after the kind's arguments. */
    size_t shard = str_eqc(kind, "store") ? store_arguments(args.v[0].text) : args.n;
    for (size_t i = 0; i < args.n; i++) {
        if (i != shard) {
            PUSH(s->args, args.v[i].text);
        }
    }
    PUSH(p->settings_block->list, s);
    if (!p->detached_block) {
        declare_setting(p, kind, keyword.column, &s->args);
        audit_lists none = {0};
        PUSH(p->table_settings, ((tsetting_rec){kind, args, p->line, keyword.column, none}));
    }
}

static bool sc_take(scursor *c, const char *what)
{
    token t;
    return sc_name(c, str_c(what), &t);
}

static bool sc_word(scursor *c, const char *word)
{
    if (sc_is(c, word)) {
        c->i++;
        return true;
    }
    return sc_fail(c, fmt("'%s'", word));
}

/* Go's settingsLine for the settings that the reader below takes by position: the syntax of the line in Go's order, so the
 * first syntax error is Go's. A line that passes reads completely below. */
static bool old_setting_syntax(parser *p, str keyword)
{
    scursor c = {p, &p->t, 1};
    bool ok = true;
    if (str_eqc(keyword, "entity")) {
        ok = sc_take(&c, "an entity name");
    } else if (str_eqc(keyword, "updated") || str_eqc(keyword, "soft_delete") || str_eqc(keyword, "aes_version")) {
        ok = sc_take(&c, "a column name");
    } else if (str_eqc(keyword, "select")) {
        ok = sc_word(&c, "explicit") && sc_take(&c, "a column name");
        while (ok && sc_more(&c)) {
            ok = sc_take(&c, "a column name");
        }
    } else if (str_eqc(keyword, "codec")) {
        ok = sc_take(&c, "a column name") && sc_take(&c, "a codec stage");
        while (ok && sc_more(&c)) {
            ok = sc_take(&c, "a codec stage");
        }
    } else if (str_eqc(keyword, "blind_index")) {
        ok = sc_take(&c, "the AES column") && sc_take(&c, "the index column");
    } else if (str_eqc(keyword, "navigation")) {
        ok = sc_take(&c, "a foreign key name") && sc_take(&c, "the child relation name") && sc_take(&c, "the parent relation name");
    } else if (str_eqc(keyword, "audit")) {
        ok = sc_word(&c, "into") && sc_take(&c, "the history table") && sc_word(&c, "column") && sc_take(&c, "the audit column")
            && sc_word(&c, "references") && sc_take(&c, "the audit record table") && sc_word(&c, "action")
            && sc_take(&c, "the action column") && sc_word(&c, "previous") && sc_take(&c, "the previous column");
        bool tables = false;
        if (ok && sc_is(&c, "tables")) {
            tables = true;
            c.i++;
            ok = sc_take(&c, "the tables table") && sc_word(&c, "(") && sc_take(&c, "the record column") && sc_word(&c, ",")
                && sc_take(&c, "the name column") && sc_word(&c, ")");
        }
        while (ok && (sc_is(&c, "exclude") || sc_is(&c, "include"))) {
            c.i++;
            ok = sc_word(&c, "(") && sc_take(&c, "a column name");
            while (ok && sc_is(&c, ",")) {
                c.i++;
                ok = sc_take(&c, "a column name");
            }
            ok = ok && (sc_is(&c, ")") || sc_fail(&c, SL("',' or ')'")));
            c.i += ok ? 1 : 0;
        }
        if (ok && sc_more(&c)) {
            ok = sc_fail(&c, tables ? SL("'exclude', 'include' or the end of the line") : SL("'tables', 'exclude', 'include' or the end of the line"));
        }
    }
    return ok && sc_end(&c);
}

static void settings_line(parser *p)
{
    token first = p->t.v[0];
    str keyword = first.text;
    zend_long at = first.column;
    if (str_eqc(keyword, "}")) {
        end_at(p, 1);
        p->settings_block->closing = take_comments(p);
        p->state = S_TABLE;
        p->settings_failed = false;
        return;
    }
    if (!word_text(keyword)) {
        syntax_fail(p, 0, "a setting or '}'");
        return;
    }
    mark_token(p, &first, "setting");
    if (new_setting_kind(keyword)) {
        new_setting(p, first);
        return;
    }
    static const char *const kinds[] = {"entity", "updated", "soft_delete", "aes_version", "select", "codec", "blind_index", "navigation",
        "immutable", "audit", NULL};
    if (!dbspec_str_in_list(keyword, kinds)) {
        error(p, "setting", p->line, at, fmt("setting %S is unknown", dbs_quote(keyword)));
        return;
    }
    /* The syntax is read in Go's order first; a line that passes has every argument below at its place. */
    if (!old_setting_syntax(p, keyword)) {
        return;
    }
    tokens args = {0}, rest = {0};
    for (size_t i = 1; i < p->t.n; i++) {
        PUSH(args, p->t.v[i]);
    }
    /* The exclude and include lists of audit come after the column word, and are read separately after checking the preceding word. */
    if (str_eqc(keyword, "audit") && args.n > 10) {
        for (size_t i = 10; i < args.n; i++) {
            PUSH(rest, args.v[i]);
        }
        args.n = 10;
    }
    /* The positions the grammar takes (R3, R4, R11, R12): every argument is a name, except the stages of a codec,
     * and the fixed words of select and audit are keywords. */
    for (size_t i = 0; i < args.n; i++) {
        if (!(str_eqc(keyword, "codec") && i > 0)) {
            mark_token(p, &args.v[i], "name");
        }
    }
    if (str_eqc(keyword, "codec")) {
        for (size_t i = 1; i < args.n; i++) {
            if (dbspec_str_in_list(args.v[i].text, codec_stages)) {
                mark_token(p, &args.v[i], "keyword");
            }
        }
    }
    if (str_eqc(keyword, "select")) {
        mark_token(p, &args.v[0], "keyword");
    }
    if (str_eqc(keyword, "audit")) {
        for (size_t i = 0; i < 10; i += 2) {
            mark_token(p, &args.v[i], "keyword");
        }
    }
    audit_lists lists = {0};
    str kind = keyword;
    if (str_eqc(keyword, "select")) {
        kind = SL("select_explicit");
        tokens shifted = {0};
        for (size_t i = 1; i < args.n; i++) {
            PUSH(shifted, args.v[i]);
        }
        args = shifted;
    } else if (str_eqc(keyword, "audit")) {
        /* The arguments of audit are, in order: history table, audit column, audit record table, action, previous. */
        tokens picked = {0};
        for (int n = 0; n < 5; n++) {
            PUSH(picked, args.v[2 * n + 1]);
        }
        /* `tables <table> (<record>, <name>)` follows previous and precedes the lists; its names are arguments 5 to 7. */
        if (rest.n > 0 && str_eqc(rest.v[0].text, "tables")) {
            mark_token(p, &rest.v[0], "keyword");
            /* rest: tables <table> ( <record> , <name> ) */
            for (size_t k = 1; k <= 5; k += 2) {
                mark_token(p, &rest.v[k], "name");
                PUSH(picked, rest.v[k]);
            }
            tokens left = {0};
            for (size_t k = 7; k < rest.n; k++) {
                PUSH(left, rest.v[k]);
            }
            rest = left;
        }
        args = picked;
        audit_list_tokens(p, &rest, &lists);
    }
    bool per_name = str_eqc(kind, "codec") || str_eqc(kind, "navigation") || str_eqc(kind, "blind_index");
    str key = per_name ? fmt("%S %S", kind, args.v[0].text) : kind;
    if (!p->detached_block) {
        if (smap_has(&p->setting_keys, key)) {
            error(p, "setting", p->line, at, per_name ? fmt("%S repeats for %S", kind, dbs_quote(args.v[0].text)) : fmt("setting %S repeats", keyword));
            return;
        }
        smap_set(&p->setting_keys, key, TRUEP);
    }
    /* All arguments except codec's stage are names. */
    size_t named_args = str_eqc(kind, "codec") ? 1 : args.n;
    for (size_t i = 0; i < named_args; i++) {
        name_tok(p, &args.v[i]);
    }
    /* Names in a list are checked only at their first appearance. The audit column is rejected separately by the check. */
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
    PUSH(p->settings_block->list, s);
    if (!p->detached_block) {
        declare_setting(p, keyword, at, &s->args);
        PUSH(p->table_settings, ((tsetting_rec){kind, args, p->line, at, lists}));
    }
}

static void open_diagram(parser *p)
{
    const token *name = word_at(p, 1, "a diagram name");
    p->diagram_failed = false;
    p->state = S_DIAGRAM;
    p->block_open[0] = p->line;
    p->block_open[1] = p->t.v[0].column;
    p->block_open_text = p->t.v[0].text;
    p->diagram_tables = (smap){0};
    diagram *g = dbs_alloc(sizeof *g);
    g->name = name != NULL ? name->text : SL("");
    g->comments = take_comments(p);
    p->diagram = g;
    PUSH(p->doc->diagrams, g);
    if (name == NULL) {
        p->diagram_failed = true;
        return;
    }
    declare(p, SL("diagram"), p->line, name->column, path1(name->text));
    if (expect_at(p, 2, "{")) {
        p->block_open[1] = p->t.v[2].column;
        p->block_open_text = SL("{");
        if (end_at(p, 3)) {
            name_tok(p, name);
        }
    }
    p->diagram_failed = syntax_here(p);
    if (smap_has(&p->diagram_names, name->text) && !p->diagram_failed) {
        error(p, "name.duplicate", p->line, name->column, fmt("diagram %S is defined twice", dbs_quote(name->text)));
    }
    smap_set(&p->diagram_names, name->text, TRUEP);
}

/* Go's cursor.value at token i: a '-' and a number, a word, a number or a string. On success, *out is the value (a '-' and a
 * number joined at the '-') and *next the token after it. */
static bool value_at(parser *p, size_t i, const char *what, token *out, size_t *next)
{
    const token *t = tok(p, i);
    if (t != NULL && str_eqc(t->text, "-")) {
        const token *number = tok(p, i + 1);
        if (number == NULL || !number_text(number->text)) {
            return syntax_fail(p, i + 1, "a number after '-'");
        }
        *out = (token){fmt("-%S", number->text), t->column, 0, 0};
        *next = i + 2;
        return true;
    }
    if (t == NULL || !(str_dotted(t->text) || string_text(t->text))) {
        return syntax_fail(p, i, what);
    }
    mark_value(p, t);
    *out = *t;
    *next = i + 1;
    return true;
}

/* Go's coordinate: a number token or a '-' and a number, without a fraction, from -2147483648 to 2147483647. */
static bool coordinate_value(str text, zend_long *value)
{
    bool negative = text.n > 0 && text.s[0] == '-';
    str digits = negative ? str_sub(text, 1, text.n - 1) : text;
    if (!str_digits(digits)) {
        return false;
    }
    size_t lead = 0;
    while (lead + 1 < digits.n && digits.s[lead] == '0') {
        lead++;
    }
    digits = str_sub(digits, lead, digits.n - lead);
    if (digits.n > 10 || (digits.n == 10 && str_cmp(digits, negative ? SL("2147483648") : SL("2147483647")) > 0)) {
        return false;
    }
    zend_long v = ZEND_STRTOL(str_of(digits.s, digits.n).s, NULL, 10);
    *value = negative ? -v : v;
    return true;
}

static void diagram_line(parser *p)
{
    if (str_eqc(p->t.v[0].text, "}")) {
        end_at(p, 1);
        p->diagram->closing = take_comments(p);
        p->state = S_TOP;
        p->diagram_failed = false;
        return;
    }
    const token *tname = word_at(p, 0, "a table name or '}'");
    if (tname == NULL || !expect_at(p, 1, "at")) {
        return;
    }
    token coordinates[2];
    size_t i = 2;
    if (!value_at(p, i, "the x coordinate", &coordinates[0], &i)) {
        return;
    }
    const token *minus = tok(p, i);
    if (minus != NULL && str_eqc(minus->text, "-") && tok(p, i + 1) != NULL && word_text(tok(p, i + 1)->text)) {
        /* A '-' before a word is a coordinate that is not an integer, reported at its '-'. */
        coordinates[1] = (token){fmt("-%S", tok(p, i + 1)->text), minus->column, 0, 0};
        i += 2;
    } else if (!value_at(p, i, "the y coordinate", &coordinates[1], &i)) {
        return;
    }
    if (!end_at(p, i)) {
        return;
    }
    str table_name = tname->text;
    bool well_formed = name_tok(p, tname);
    bool valid = well_formed;
    if (valid && !smap_has(&p->tables, table_name) && smap_has(&p->failed_tables, table_name)) {
        /* A table of a failed use line reports nothing more, and Go leaves the entry there (DBS-153). */
        return;
    }
    if (valid && !smap_has(&p->tables, table_name)) {
        error(p, "diagram", p->line, tname->column, fmt("table %S is not a table of this document or a used table", dbs_quote(table_name)));
        valid = false;
    } else if (valid && smap_has(&p->diagram_tables, table_name)) {
        error(p, "diagram", p->line, tname->column, fmt("table %S appears twice in the diagram", dbs_quote(table_name)));
        valid = false;
    }
    if (well_formed) {
        smap_set(&p->diagram_tables, table_name, TRUEP);
    }
    zend_long values[2];
    size_t nvalues = 0;
    for (int n = 0; n < 2; n++) {
        if (!coordinate_value(coordinates[n].text, &values[nvalues])) {
            error(p, "diagram", p->line, coordinates[n].column,
                fmt("coordinate %S is not an integer from -2147483648 to 2147483647", dbs_describe(coordinates[n].text)));
            valid = false;
            continue;
        }
        nvalues++;
    }
    if (valid) {
        placement *pl = dbs_alloc(sizeof *pl);
        pl->table = table_name;
        pl->x = values[0];
        pl->y = values[1];
        pl->comments = take_comments(p);
        PUSH(p->diagram->placements, pl);
        declare(p, SL("diagram_entry"), p->line, tname->column, path2(p->diagram->name, table_name));
    }
}

static void table_line(parser *p);
static void close_table(parser *p);

static void top_line(parser *p)
{
    token first = p->t.v[0];
    if (str_eqc(first.text, "use")) {
        mark_token(p, &first, "keyword");
        size_t uses_before = p->doc->uses.n;
        use_line(p);
        if (p->doc->uses.n == uses_before) {
            /* The words of a use line that fails are names of a failed line, whose references report nothing more (DBS-153). */
            for (size_t k = 2; k < p->t.n; k++) {
                if (str_dotted(p->t.v[k].text)) {
                    smap_set(&p->failed_tables, p->t.v[k].text, TRUEP);
                }
            }
        }
        return;
    }
    if (str_eqc(first.text, "table")) {
        mark_token(p, &first, "keyword");
        bool out_of_order = p->top_phase > 1;
        if (p->top_phase < 1) {
            p->top_phase = 1;
        }
        open_table(p, out_of_order);
        return;
    }
    if (str_eqc(first.text, "diagram")) {
        mark_token(p, &first, "keyword");
        p->top_phase = 2;
        open_diagram(p);
        return;
    }
    syntax_fail(p, 0, "'use', 'table' or 'diagram'");
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
        mark_token(p, &first, "keyword");
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
        mark_token(p, &first, "keyword");
        /* Go reports order on the keyword of a repeated block only when the line has the correct form (just `settings {`). */
        bool well_formed = tok_is(p, 1, "{") && p->t.n == 2;
        if (p->table_phase == 2 && well_formed) {
            error(p, "order", p->line, first.column, SL("a table has at most one settings block, after its other lines"));
        }
        p->table_phase = 2;
        if (expect_at(p, 1, "{")) {
            end_at(p, 2);
        }
        start_settings_block(p);
        return;
    }
    size_t mark = p->diagnostics.n;
    column_line(p);
    if (syntax_here(p)) {
        keep_syntax_since(p, mark);
        p->failed_lines++;
        if (str_dotted(first.text)) {
            fail_column(p, first.text);
        }
    } else if (p->table_phase > 0) {
        /* Go reports order only when the column line matches the syntax (after c.done in columnLine). A line with a syntax error reports only the syntax error. */
        error(p, "order", p->line, first.column, SL("column lines come before key, index, foreign key, check and settings lines"));
    }
}

/* ------------------------------------------------------------- table checks */

static bool recorder_records(const recorder *r, str c)
{
    if (str_eq(c, r->audit)) {
        return true;
    }
    return r->include ? smap_has(&r->listed, c) : !smap_has(&r->listed, c);
}

/* Column reference of the settings check: the column, or NULL after a diagnostic or a failed name and line. */
static column *setting_column(parser *p, str kind, zend_long line, const token *t)
{
    if (!dbs_valid_name(t->text)) {
        return NULL;
    }
    column *c = smap_get(p->columns, t->text);
    if (c == NULL) {
        error(p, "setting", line, t->column, fmt("column %S is not a column of table %S", dbs_quote(t->text), dbs_quote(p->table->name)));
        return NULL;
    }
    (void)kind;
    return smap_has(&p->invalid_types, t->text) ? NULL : c;
}

/* Checks the exclude or include list of audit and returns a recorder that reports whether the column is recorded. */
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
                error(p, "setting", line, t->column, fmt("column %S repeats in audit %S", dbs_quote(t->text), lists->v[l].keyword.text));
                continue;
            }
            if (str_eq(t->text, audit)) {
                error(p, "setting", line, t->column, fmt("the audit column %S is always recorded and is not listed in exclude or include", dbs_quote(t->text)));
            } else {
                setting_column(p, kind, line, t);
            }
            smap_set(&r->listed, t->text, TRUEP);
        }
    }
    r->include = lists->n == 1 && str_eqc(lists->v[0].keyword.text, "include");
    return r;
}

/* Check for a setting of a new kind. A column name is checked for name format as in Go's columnRef; if it is the name of a failed line, it is not reported separately. */

/* A column with a valid type. A column whose type could not be read has an invalid type. */
static bool col_valid(const column *c)
{
    return !str_eqc(c->type->name, "invalid");
}

static bool text_type(const column *c)
{
    return str_eqc(c->type->name, "varchar") || str_eqc(c->type->name, "text");
}

/* Go's columnRef of a name whose format the line already checked: NULL for a malformed name, an unknown column (reported) and the column
 * of a line that failed; a column whose type is wrong is a column. */
static column *known_column(parser *p, zend_long line, const token *t)
{
    if (!dbs_valid_name(t->text)) {
        return NULL;
    }
    column *c = smap_get(p->columns, t->text);
    bool failed = smap_has(&p->failed_names, t->text);
    if (c == NULL) {
        if (!failed) {
            error(p, "setting", line, t->column, fmt("column %S is not a column of table %S", dbs_quote(t->text), dbs_quote(p->table->name)));
        }
        return NULL;
    }
    return failed && !col_valid(c) ? NULL : c;
}

static column *column_ref(parser *p, zend_long line, const token *t)
{
    if (!name_tok(p, t)) {
        return NULL;
    }
    return known_column(p, line, t);
}

static void foreign_key_ref(parser *p, zend_long line, const token *t)
{
    if (!name_tok(p, t) || smap_has(&p->failed_names, t->text)) {
        return;
    }
    bool found = false;
    for (size_t k = 0; k < p->table->fks.n; k++) {
        found = found || str_eq(p->table->fks.v[k]->name, t->text);
    }
    if (!found) {
        error(p, "setting", line, t->column, fmt("foreign key %S is not a foreign key of the table", dbs_quote(t->text)));
    }
}

/* Checks whether the expression text references the column named name: yes, if a word outside string literals is the same. */
static bool expression_mentions(str s, str name)
{
    size_t i = 0;
    while (i < s.n) {
        char c = s.s[i];
        if (c == '\'') {
            i++;
            while (i < s.n && s.s[i] != '\'') {
                i++;
            }
            i++;
        } else if (word_rune_width(s, i) > 0) {
            size_t j = word_run_end(s, i);
            if (str_eq(str_sub(s, i, j - i), name)) {
                return true;
            }
            i = j;
        } else {
            i++;
        }
    }
    return false;
}

/* Checks whether the name is a column of a primary key, unique key, index, foreign key, or check. */
static bool in_key_or_check(const table *t, str name)
{
    if (t->pk != NULL && strs_has(&t->pk->columns, name)) {
        return true;
    }
    for (size_t i = 0; i < t->uniques.n; i++) {
        if (strs_has(&t->uniques.v[i]->columns, name)) {
            return true;
        }
    }
    for (size_t i = 0; i < t->indexes.n; i++) {
        for (size_t k = 0; k < t->indexes.v[i]->columns.n; k++) {
            if (str_eq(t->indexes.v[i]->columns.v[k].name, name)) {
                return true;
            }
        }
    }
    for (size_t i = 0; i < t->fks.n; i++) {
        if (strs_has(&t->fks.v[i]->columns, name)) {
            return true;
        }
    }
    for (size_t i = 0; i < t->checks.n; i++) {
        if (expression_mentions(t->checks.v[i]->expression, name)) {
            return true;
        }
    }
    return false;
}

/* A check of the column that the first argument of a table setting names; it runs only when the column exists. */
typedef void (*setting_column_check)(parser *p, const tsetting_rec *s, const token *name, column *c);

static void check_setting_column(parser *p, const tsetting_rec *s, setting_column_check check)
{
    const token *name = &s->args.v[0];
    column *c = column_ref(p, s->line, name);
    if (c != NULL) {
        check(p, s, name, c);
    }
}

static void order_check(parser *p, const tsetting_rec *s, const token *name, column *c)
{
    if ((col_valid(c) && !str_eqc(c->type->name, "i32") && !str_eqc(c->type->name, "i64")) || c->nullable || c->has_default) {
        error(p, "setting", s->line, name->column, SL("order needs a non-null i32 or i64 column with no default"));
        return;
    }
    if (in_key_or_check(p->table, name->text)) {
        error(p, "setting", s->line, name->column, fmt("order column %S is in a key, index or check", dbs_quote(name->text)));
    }
}

/* The shard clause of store names a non-null date or datetime column, and rejects it in a block table, a table with a self foreign key, and
 * a table with order. */
static void store_shard_check(parser *p, const tsetting_rec *s, bool order)
{
    size_t at = store_arguments(s->args.v[0].text);
    if (s->args.n <= at) {
        return;
    }
    const token *shard = &s->args.v[at], *name = &s->args.v[at + 1];
    column *c = column_ref(p, s->line, name);
    if (c != NULL && ((col_valid(c) && !str_eqc(c->type->name, "date") && !str_eqc(c->type->name, "datetime")) || c->nullable)) {
        error(p, "setting", s->line, name->column, SL("store shard needs a non-null date or datetime column"));
    }
    if (str_eqc(s->args.v[0].text, "block")) {
        error(p, "setting", s->line, shard->column, SL("store shard is rejected on a block table"));
    }
    for (size_t i = 0; i < p->table->fks.n; i++) {
        if (str_eq(p->table->fks.v[i]->table, p->table->name)) {
            error(p, "setting", s->line, shard->column, SL("store shard is rejected on a table with a self foreign key"));
            break;
        }
    }
    if (order) {
        error(p, "setting", s->line, shard->column, SL("store shard is rejected on a table with order"));
    }
}

/* Column checks for title, body, and markdown. markdown allows null; title and body do not. */
static void text_setting_check(parser *p, const tsetting_rec *s, const token *name, column *c)
{
    if (str_eqc(s->kind, "markdown")) {
        if (col_valid(c) && !text_type(c)) {
            error(p, "setting", s->line, name->column, fmt("markdown needs a varchar or text column, not %S", ctype_text(c->type)));
        }
        return;
    }
    if ((col_valid(c) && !text_type(c)) || c->nullable) {
        error(p, "setting", s->line, name->column, fmt("%S needs a non-null varchar or text column", s->kind));
    }
}

/* The column whose value a list row writes between the brackets of its task marker: a varchar(1) column, written as its
 * value, or a bool column, written as the unchecked and the checked task box of GFM. Nullability is free. */
static void task_marker_check(parser *p, const tsetting_rec *s, const token *name, column *c)
{
    if (!col_valid(c)) {
        return;
    }
    const ctype *type = c->type;
    if (!str_eqc(type->name, "bool") && !(str_eqc(type->name, "varchar") && type->p[0] == 1)) {
        error(p, "setting", s->line, name->column, fmt("task_marker needs a varchar(1) or bool column, not %S", ctype_text(type)));
    }
}

static smap copy_failed_names(parser *p)
{
    smap out = {0};
    SMAP_EACH(&p->failed_names, i) {
        smap_set(&out, p->failed_names.e[i].key, TRUEP);
    }
    return out;
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
            if (d != NULL && str_eqc(kind, "updated") && !str_eqc(d->type->name, "datetime")) {
                error(p, "setting", line, a->v[0].column, fmt("updated needs a datetime column, not %S", ctype_text(d->type)));
            } else if (d != NULL && str_eqc(kind, "soft_delete") && (!str_eqc(d->type->name, "datetime") || !d->nullable)) {
                error(p, "setting", line, a->v[0].column, SL("soft_delete needs a nullable datetime column"));
            }
        } else if (str_eqc(kind, "select_explicit")) {
            smap seen = {0};
            for (size_t k = 0; k < a->n; k++) {
                if (smap_has(&seen, a->v[k].text)) {
                    error(p, "setting", line, a->v[k].column, fmt("column %S repeats in select explicit", dbs_quote(a->v[k].text)));
                    continue;
                }
                smap_set(&seen, a->v[k].text, TRUEP);
                setting_column(p, kind, line, &a->v[k]);
            }
        } else if (str_eqc(kind, "codec")) {
            bool known = true;
            for (size_t k = 1; k < a->n; k++) {
                token *stage = &a->v[k];
                if (!dbspec_str_in_list(stage->text, codec_stages)) {
                    error(p, "setting", line, stage->column, fmt("codec stage %S is unknown", dbs_quote(stage->text)));
                    known = false;
                } else if (str_eqc(stage->text, "ordered_json") && k > 1) {
                    error(p, "setting", line, stage->column, SL("ordered_json is the first codec stage"));
                }
            }
            column *d = setting_column(p, kind, line, &a->v[0]);
            if (d != NULL && known) {
                str last = a->v[a->n - 1].text;
                bool text = dbspec_str_in_list(last, text_stages);
                str type = d->type->name;
                if (text ? !str_eqc(type, "varchar") && !str_eqc(type, "text") : !str_eqc(type, "bytes")) {
                    error(p, "setting", line, a->v[0].column, text
                        ? fmt("the last codec stage %S stores text and needs a varchar or text column, not %S", last, ctype_text(d->type))
                        : fmt("the last codec stage %S stores bytes and needs a bytes column, not %S", last, ctype_text(d->type)));
                }
            }
            if (smap_has(&aes, a->v[0].text) && !smap_has(&kinds, SL("aes_version"))) {
                error(p, "setting", line, at, SL("a column with the aes stage requires an aes_version setting"));
            }
        } else if (str_eqc(kind, "aes_version")) {
            if (aes.live == 0) {
                error(p, "setting", line, at, SL("aes_version without a column that uses aes"));
            }
            column *d = setting_column(p, kind, line, &a->v[0]);
            if (d != NULL && (!ctype_integer(d->type) || d->nullable)) {
                error(p, "setting", line, a->v[0].column, SL("aes_version needs a non-null integer column"));
            }
        } else if (str_eqc(kind, "blind_index")) {
            token *source = &a->v[0], *target = &a->v[1];
            /* Go's blindIndex: a column of a line that failed is no column, a column with a wrong type is a column. */
            column *encrypted = known_column(p, line, source);
            if (encrypted != NULL && !smap_has(&aes, source->text)) {
                error(p, "setting", line, at, fmt("blind_index names column %S, which has no codec with the aes stage", dbs_quote(source->text)));
            }
            column *index = known_column(p, line, target);
            if (index != NULL) {
                const ctype *type = index->type;
                if (smap_has(&aes, target->text)) {
                    error(p, "setting", line, target->column, SL("the blind index column is not AES-encoded"));
                } else if (col_valid(index) && !(str_eqc(type->name, "varchar") && type->p[0] >= 64)) {
                    error(p, "setting", line, target->column, fmt("the blind index column is varchar(n) with n >= 64, not %S", ctype_text(type)));
                } else if (encrypted != NULL && encrypted->nullable != index->nullable) {
                    error(p, "setting", line, target->column, SL("the blind index column has the nullability of the AES column"));
                } else if (!smap_has(&single, target->text) && !smap_has(&p->failed_key_tables, p->table->name)) {
                    error(p, "setting", line, target->column, fmt("column %S is not the only column of a declared index or unique key", dbs_quote(target->text)));
                }
            }
        } else if (str_eqc(kind, "navigation")) {
            if (dbs_valid_name(a->v[0].text)) {
                bool found = smap_has(&p->failed_names, a->v[0].text);
                for (size_t k = 0; k < p->table->fks.n; k++) {
                    found = found || str_eq(p->table->fks.v[k]->name, a->v[0].text);
                }
                if (!found) {
                    error(p, "setting", line, a->v[0].column, fmt("foreign key %S is not a foreign key of the table", dbs_quote(a->v[0].text)));
                }
            }
        } else if (str_eqc(kind, "markdown") || str_eqc(kind, "title") || str_eqc(kind, "body")) {
            check_setting_column(p, s, text_setting_check);
        } else if (str_eqc(kind, "store")) {
            if (str_eqc(a->v[0].text, "block")) {
                foreign_key_ref(p, line, &a->v[1]);
            }
            store_shard_check(p, s, smap_has(&kinds, SL("order")));
        } else if (str_eqc(kind, "order")) {
            check_setting_column(p, s, order_check);
        } else if (str_eqc(kind, "task_marker")) {
            check_setting_column(p, s, task_marker_check);
        } else if (str_eqc(kind, "immutable")) {
            if (changed_by_foreign_keys) {
                error(p, "setting", line, at, SL("immutable is rejected on a child of a cascade or set_null foreign key"));
            }
            claim_generated(p, line, at, dbs_renderer_name(p->table->name, SL("immutable_update")), GSRC("table %S setting immutable", p->table->name, SNULL));
            claim_generated(p, line, at, dbs_renderer_name(p->table->name, SL("immutable_delete")), GSRC("table %S setting immutable", p->table->name, SNULL));
        } else if (str_eqc(kind, "audit")) {
            if (changed_by_foreign_keys) {
                error(p, "setting", line, at, SL("audit is rejected on a child of a cascade or set_null foreign key"));
            }
            column *audit = setting_column(p, kind, line, &a->v[1]);
            if (audit != NULL && audit->nullable) {
                error(p, "setting", line, a->v[1].column, SL("the audit column is a non-null column"));
            }
            recorder *recorded = audit_lists_check(p, &s->lists, a->v[1].text, line, kind);
            if (dbs_valid_name(a->v[2].text)) {
                PUSH(p->deferred_records, ((drecord_rec){p->table, audit, *a, line, smap_has(&p->failed_key_tables, p->table->name) || smap_has(&p->failed_primary_tables, p->table->name)}));
            }
            if (dbs_valid_name(a->v[0].text) && dbs_valid_name(a->v[3].text) && dbs_valid_name(a->v[4].text)) {
                smap *failed = dbs_alloc(sizeof *failed);
                *failed = copy_failed_names(p);
                PUSH(p->deferred_audits, ((daudit_rec){p->table, p->columns, failed, *a, audit != NULL ? audit->type : NULL, line, recorded}));
            }
            claim_generated(p, line, at, dbs_renderer_name(p->table->name, SL("audit_insert")), GSRC("table %S setting audit", p->table->name, SNULL));
            claim_generated(p, line, at, dbs_renderer_name(p->table->name, SL("audit_update")), GSRC("table %S setting audit", p->table->name, SNULL));
            claim_generated(p, line, at, dbs_renderer_name(p->table->name, SL("audit_delete")), GSRC("table %S setting audit", p->table->name, SNULL));
        }
    }
}

/* A foreign key diagnostic at the key's name that Go gives after the checks of the referenced table: it is reported after them
 * (emit_late_fk), so the diagnostics at one name keep Go's order. */
static void late_fk(parser *p, const fkey *f, zend_long line, zend_long column, str message)
{
    PUSH(p->late_fks, ((late_fk_rec){f, mkdiag(SL("foreign_key"), line, column, message), false}));
}

static void emit_late_fk(parser *p, const fkey *f)
{
    for (size_t i = 0; i < p->late_fks.n; i++) {
        late_fk_rec *r = &p->late_fks.v[i];
        if (!r->emitted && (f == NULL || r->fk == f)) {
            r->emitted = true;
            error(p, "foreign_key", r->d.line, r->d.column, r->d.message);
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
    p->table_failed = false;
    p->settings_failed = false;
    table *t = p->table;
    pkey *primary = t->pk;
    if (p->columns->live == 0 && p->failed_lines == 0) {
        error(p, "column", p->table_name[0], p->table_name[1], fmt("table %S has no column", dbs_quote(t->name)));
    }
    if (primary == NULL && !p->failed_primary) {
        error(p, "key", p->table_name[0], p->table_name[1], fmt("table %S has no primary key", dbs_quote(t->name)));
    }
    bool resolved = primary == NULL;
    if (primary != NULL) {
        resolved = true;
        for (size_t k = 0; k < primary->columns.n; k++) {
            resolved = resolved && dbs_valid_name(primary->columns.v[k]) && !smap_has(&p->failed_names, primary->columns.v[k]);
        }
    }
    for (size_t i = 0; i < p->identities.n && i < 1; i++) {
        identity_rec *r = &p->identities.v[i];
        bool only = primary != NULL && primary->columns.n == 1 && str_eq(primary->columns.v[0], r->name);
        if (!r->rejected && !p->failed_primary && resolved && !only) {
            error(p, "column", r->line, r->column, SL("the identity column must be the only primary key column"));
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
        /* Go runs the set_null check on known children even when child columns are unknown. Only the index check is skipped. */
        if (r->children_known) {
            bool covered = false;
            for (size_t k = 0; k < leading.n && !covered; k++) {
                covered = prefix_equal(&leading.v[k], &f->columns);
            }
            if (!covered && !smap_has(&p->failed_key_tables, t->name) && !smap_has(&p->failed_primary_tables, t->name)) {
                late_fk(p, f, r->line, r->column, SL("the table declares no index or key whose leading columns are the foreign key columns"));
            }
        }
        if (str_eqc(f->on_delete, "set_null") || str_eqc(f->on_update, "set_null")) {
            for (size_t k = 0; k < f->columns.n; k++) {
                column *c = smap_get(p->columns, f->columns.v[k]);
                if (c != NULL && !c->nullable) {
                    late_fk(p, f, r->line, r->column, fmt("set_null requires every foreign key column to be null; %S is not", dbs_quote(f->columns.v[k])));
                    break;
                }
            }
        }
    }
    for (size_t i = 0; i < p->table_checks.n; i++) {
        tcheck_rec *r = &p->table_checks.v[i];
        str text = SL("");
        diags errors = {0};
        if (!expression_parse(&r->toks, r->line, r->end, t->name, p->columns, &action, &text, &errors, p->marking ? &p->marks : NULL)) {
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
        e->failed = dbs_alloc(sizeof *e->failed);
        *e->failed = copy_failed_names(p);
    }
    p->table = NULL;
}

/* ------------------------------------------------------- cross-table checks */

static void check_foreign_key_target(parser *p, dfk_rec *r)
{
    fkey *f = r->fk;
    tentry *target = smap_get(&p->tables, f->table);
    if (target == NULL && smap_has(&p->failed_tables, f->table)) {
        return;
    }
    if (target == NULL) {
        error(p, "foreign_key", r->line, r->target_at, fmt("table %S is not a table of this document or a used table", dbs_quote(f->table)));
        return;
    }
    /* Go does not check the columns, pairing, or types of a target whose table line failed (validate.go's foreignKey). */
    if (target->table->header_failed) {
        return;
    }
    /* Same as Go's foreignKey: the count check is done regardless of whether child columns are known, and the pairing and type checks
     * are done when all referenced columns are known and the target's keys read. The type check stops at the first mismatch. */
    bool refs_known = true;
    for (size_t k = 0; k < r->parents.n; k++) {
        if (!smap_has(target->columns, r->parents.v[k].name)) {
            error(p, "foreign_key", r->line, r->parents.v[k].column, fmt("column %S is not a column of table %S", dbs_quote(r->parents.v[k].name), dbs_quote(f->table)));
            refs_known = false;
        }
    }
    if (f->columns.n != f->refs.n) {
        error(p, "foreign_key", r->line, r->at, fmt("foreign key lists %u columns and %u referenced columns", f->columns.n, f->refs.n));
        return;
    }
    if (!refs_known || smap_has(&p->failed_key_tables, f->table) || smap_has(&p->failed_primary_tables, f->table)) {
        return;
    }
    table *tt = target->table;
    bool matches = tt->pk != NULL && strs_eq(&tt->pk->columns, &f->refs);
    for (size_t k = 0; k < tt->uniques.n && !matches; k++) {
        matches = strs_eq(&tt->uniques.v[k]->columns, &f->refs);
    }
    if (!matches) {
        error(p, "foreign_key", r->line, r->at, fmt("the referenced columns are not the primary key or a unique key of table %S", dbs_quote(f->table)));
    }
    for (size_t k = 0; k < f->columns.n; k++) {
        column *child = smap_get(r->columns, f->columns.v[k]);
        /* Children that are unknown or have an invalid type are not checked for type (Go's typ.valid). */
        if (child == NULL || str_eqc(child->type->name, "invalid")) {
            continue;
        }
        column *parent = smap_get(target->columns, f->refs.v[k]);
        const ctype *pt = parent->type;
        if (!str_eqc(pt->name, "invalid") && child->type != pt && !str_eq(ctype_text(child->type), ctype_text(pt))) {
            error(p, "foreign_key", r->line, r->at, fmt("column %S has type %S, the referenced column has %S", dbs_quote(f->columns.v[k]),
                ctype_text(child->type), ctype_text(pt)));
            break;
        }
    }
}

static void check_foreign_key_targets(parser *p)
{
    for (size_t i = 0; i < p->deferred_fks.n; i++) {
        check_foreign_key_target(p, &p->deferred_fks.v[i]);
        emit_late_fk(p, p->deferred_fks.v[i].fk);
    }
    emit_late_fk(p, NULL);
}

static tentry *audit_table_entry(parser *p, drecord_rec *record, token *name, const char *kind)
{
    tentry *entry = smap_get(&p->tables, name->text);
    if (entry == NULL && smap_has(&p->failed_tables, name->text)) {
        return NULL;
    }
    if (entry == NULL) {
        error(p, "setting", record->line, name->column,
            fmt("%s table %S is not a table of this document or a used table", kind, dbs_quote(name->text)));
        return NULL;
    }
    if (entry->table->header_failed) {
        return NULL;
    }
    return entry;
}

static void check_audit_records(parser *p)
{
    for (size_t i = 0; i < p->deferred_records.n; i++) {
        drecord_rec *r = &p->deferred_records.v[i];
        token *history = &r->args.v[0], *col = &r->args.v[1], *refs = &r->args.v[2];
        str name = refs->text;
        tentry *entry = audit_table_entry(p, r, refs, "audit record");
        if (entry == NULL) continue;
        table *record = entry->table;
        /* Go does not check the key of an audit record table whose table line failed (settings.go's auditRecord). */
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
                    error(p, "setting", r->line, refs->column, fmt("audit record table %S is audited itself", dbs_quote(name)));
                }
            }
        }
        size_t nkey = record->pk != NULL ? record->pk->columns.n : 0;
        if (nkey != 1) {
            if (!smap_has(&p->failed_primary_tables, name)) {
                error(p, "setting", r->line, refs->column, fmt("audit record table %S needs a primary key of one column", dbs_quote(name)));
            }
            continue;
        }
        str key = record->pk->columns.v[0];
        column *pk = smap_get(entry->columns, key);
        if (r->col == NULL || pk == NULL) {
            continue;
        }
        if (!str_eqc(pk->type->name, "invalid") && !str_eqc(r->col->type->name, "invalid") && !str_eq(ctype_text(pk->type), ctype_text(r->col->type))) {
            error(p, "setting", r->line, col->column, fmt("the audit column has type %S, not the type %S of the primary key of %S",
                ctype_text(r->col->type), ctype_text(pk->type), dbs_quote(name)));
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

/* Checks the tables table of `tables <table> (<record>, <name>)`: another table than the audited, the history and the
 * audit record table, not audited itself, with exactly the record and the name column, the name column a varchar(n)
 * with n >= 63, the primary key (record, name) and the foreign key (record) references the audit record table's key
 * with restrict (docs/spec/dbspec.md "Audit"). */
static void check_audit_tables(parser *p)
{
    for (size_t i = 0; i < p->deferred_records.n; i++) {
        drecord_rec *r = &p->deferred_records.v[i];
        if (r->args.n != 8) {
            continue;
        }
        token *history = &r->args.v[0], *refs = &r->args.v[2], *tt = &r->args.v[5], *rec = &r->args.v[6], *nm = &r->args.v[7];
        str name = tt->text;
        tentry *entry = audit_table_entry(p, r, tt, "tables");
        if (entry == NULL) continue;
        table *tables = entry->table;
        if (tables == r->audited || str_eq(name, history->text) || str_eq(name, refs->text)) {
            error(p, "setting", r->line, tt->column, SL("the tables table is another table than the audited, the history and the audit record table"));
            continue;
        }
        bool audited = false;
        if (tables->settings != NULL) {
            for (size_t k = 0; k < tables->settings->list.n; k++) {
                audited = audited || str_eqc(tables->settings->list.v[k]->kind, "audit");
            }
        }
        if (audited) {
            error(p, "setting", r->line, tt->column, fmt("tables table %S is audited itself", dbs_quote(name)));
            continue;
        }
        bool known = true;
        token *both[] = {rec, nm};
        for (int k = 0; k < 2; k++) {
            if (smap_get(entry->columns, both[k]->text) == NULL) {
                error(p, "setting", r->line, both[k]->column, fmt("column %S is not a column of tables table %S", dbs_quote(both[k]->text), dbs_quote(name)));
                known = false;
            }
        }
        if (!known) {
            continue;
        }
        column *nc = smap_get(entry->columns, nm->text);
        if (!str_eqc(nc->type->name, "invalid") && !(str_eqc(nc->type->name, "varchar") && nc->type->np == 1 && nc->type->p[0] >= 63)) {
            error(p, "setting", r->line, nm->column, SL("the name column is a varchar(n) with n >= 63"));
        }
        for (size_t k = 0; k < tables->columns.n; k++) {
            str c = tables->columns.v[k]->name;
            if (!str_eq(c, rec->text) && !str_eq(c, nm->text)) {
                error(p, "setting", r->line, tt->column, fmt("tables table %S has the extra column %S", dbs_quote(name), dbs_quote(c)));
            }
        }
        bool pk_ok = tables->pk != NULL && tables->pk->columns.n == 2 && str_eq(tables->pk->columns.v[0], rec->text) && str_eq(tables->pk->columns.v[1], nm->text);
        if (!pk_ok && !smap_has(&p->failed_primary_tables, name)) {
            error(p, "setting", r->line, tt->column, fmt("the primary key of tables table %S is (%S, %S)", dbs_quote(name), rec->text, nm->text));
        }
        tentry *re = smap_get(&p->tables, refs->text);
        if (re == NULL || re->table->header_failed || re->table->pk == NULL || re->table->pk->columns.n != 1 || smap_has(&p->failed_key_tables, name)) {
            continue;
        }
        str key = re->table->pk->columns.v[0];
        bool declared = false;
        for (size_t k = 0; k < tables->fks.n && !declared; k++) {
            fkey *f = tables->fks.v[k];
            declared = f->columns.n == 1 && str_eq(f->columns.v[0], rec->text) && str_eq(f->table, refs->text) && f->refs.n == 1
                && str_eq(f->refs.v[0], key) && str_eqc(f->on_delete, "restrict") && str_eqc(f->on_update, "restrict");
        }
        if (!declared) {
            error(p, "setting", r->line, tt->column, fmt("tables table %S needs the foreign key (%S) references %S (%S) on delete restrict on update restrict",
                dbs_quote(name), rec->text, refs->text, key));
        }
    }
}

/* A column of a table entry by Go's column: NULL for a column of a line that failed. */
static column *entry_column(const tentry *e, str name)
{
    if (e->failed != NULL && smap_has(e->failed, name)) {
        return NULL;
    }
    return smap_get(e->columns, name);
}

static bool entry_failed(const tentry *e, str name)
{
    return e->failed != NULL && smap_has(e->failed, name);
}

static bool column_valid(const column *c)
{
    return c->type != NULL && !str_eqc(c->type->name, "invalid");
}

static void check_audit_histories(parser *p)
{
    for (size_t i = 0; i < p->deferred_audits.n; i++) {
        daudit_rec *r = &p->deferred_audits.v[i];
        token *history_tok = &r->args.v[0], *action_tok = &r->args.v[3], *previous_tok = &r->args.v[4];
        str history_name = history_tok->text;
        tentry *entry = smap_get(&p->tables, history_name);
        if (entry == NULL && smap_has(&p->failed_tables, history_name)) {
            continue;
        }
        if (entry == NULL) {
            error(p, "setting", r->line, history_tok->column, fmt("history table %S is not a table of this document or a used table", dbs_quote(history_name)));
            continue;
        }
        table *history = entry->table;
        /* Go does not match the columns of a history table whose table line failed (settings.go's audit). */
        if (history->header_failed) {
            continue;
        }
        if (history == r->audited) {
            error(p, "setting", r->line, history_tok->column, SL("a table cannot be its own history table"));
            continue;
        }
        if (history->settings != NULL) {
            for (size_t k = 0; k < history->settings->list.n; k++) {
                if (str_eqc(history->settings->list.v[k]->kind, "audit")) {
                    error(p, "setting", r->line, history_tok->column, fmt("history table %S is audited itself", dbs_quote(history_name)));
                }
            }
        }
        column *identity = NULL;
        if (history->pk != NULL && history->pk->columns.n == 1) {
            identity = entry_column(entry, history->pk->columns.v[0]);
            if (identity != NULL && !(identity->identity && str_eqc(identity->type->name, "i64"))) {
                identity = NULL;
            }
        }
        smap reserved = {0};
        if (identity != NULL) {
            smap_set(&reserved, identity->name, TRUEP);
        } else if (!smap_has(&p->failed_primary_tables, history->name)) {
            error(p, "setting", r->line, history_tok->column, fmt("history table %S needs an i64 identity primary key", dbs_quote(history_name)));
        }
        column *action = entry_column(entry, action_tok->text);
        if (action == NULL) {
            if (!entry_failed(entry, action_tok->text)) {
                error(p, "setting", r->line, action_tok->column, fmt("column %S is not a column of history table %S", dbs_quote(action_tok->text), dbs_quote(history_name)));
            }
        } else if (smap_has(&reserved, action_tok->text)) {
            error(p, "setting", r->line, action_tok->column, SL("the action column is a separate column of the history table"));
        } else if (action->nullable || (column_valid(action) && !str_eqc(ctype_text(action->type), "varchar(8)"))) {
            error(p, "setting", r->line, action_tok->column, SL("the action column is a non-null varchar(8)"));
        }
        smap_set(&reserved, action_tok->text, TRUEP);
        column *previous = entry_column(entry, previous_tok->text);
        if (previous == NULL) {
            if (!entry_failed(entry, previous_tok->text)) {
                error(p, "setting", r->line, previous_tok->column, fmt("column %S is not a column of history table %S", dbs_quote(previous_tok->text), dbs_quote(history_name)));
            }
        } else if (smap_has(&reserved, previous_tok->text)) {
            error(p, "setting", r->line, previous_tok->column, SL("the previous column is a separate column of the history table"));
        } else if (!previous->nullable) {
            error(p, "setting", r->line, previous_tok->column, SL("the previous column is nullable"));
        } else if (r->audit_type != NULL && column_valid(previous) && !str_eqc(r->audit_type->name, "invalid")
            && !str_eq(ctype_text(previous->type), ctype_text(r->audit_type))) {
            error(p, "setting", r->line, previous_tok->column, fmt("the previous column has the audit column type %S, not %S",
                ctype_text(r->audit_type), ctype_text(previous->type)));
        }
        smap_set(&reserved, previous_tok->text, TRUEP);
        /* A setting that uses both lists does not have a fixed recorded column, so its columns are not matched. */
        if (r->recorded == NULL) {
            continue;
        }
        for (size_t k = 0; k < r->audited->columns.n; k++) {
            str name = r->audited->columns.v[k]->name;
            column *c = smap_get(r->columns, name);
            if (c == NULL || (r->failed != NULL && smap_has(r->failed, name)) || !recorder_records(r->recorded, name)) {
                continue;
            }
            column *h = entry_column(entry, name);
            if (h == NULL && entry_failed(entry, name)) {
                continue;
            }
            if (h == NULL || smap_has(&reserved, name)) {
                error(p, "setting", r->line, history_tok->column, fmt("history table %S has no copy of column %S", dbs_quote(history_name), dbs_quote(name)));
            } else if (column_valid(h) && column_valid(c) && !str_eq(ctype_text(h->type), ctype_text(c->type))) {
                error(p, "setting", r->line, history_tok->column, fmt("history column %S has type %S, not %S", dbs_quote(name), ctype_text(h->type), ctype_text(c->type)));
            }
        }
        for (size_t k = 0; k < history->columns.n; k++) {
            str name = history->columns.v[k]->name;
            if (smap_has(&reserved, name) || entry_failed(entry, name) || (r->failed != NULL && smap_has(r->failed, name))) {
                continue;
            }
            if (!smap_has(r->columns, name)) {
                error(p, "setting", r->line, history_tok->column, fmt("history table %S has column %S, which is not a column of table %S",
                    dbs_quote(history_name), dbs_quote(name), dbs_quote(r->audited->name)));
            } else if (!recorder_records(r->recorded, name)) {
                error(p, "setting", r->line, history_tok->column, fmt("history table %S has column %S, which table %S does not record",
                    dbs_quote(history_name), dbs_quote(name), dbs_quote(r->audited->name)));
            }
        }
    }
}

/* ---------------------------------------------------------------------- run */

static void read_source(parser *p, str source)
{
    if (source.n > MAX_BYTES) {
        stop(p, "limit", 1, 1, fmt("document has %u bytes, more than %d", source.n, (zend_long)MAX_BYTES));
    }
    if (str_starts(source, "\xEF\xBB\xBF")) {
        stop(p, "encoding", 1, 1, SL("document starts with a byte order mark"));
    }
    zend_long encoding_line = 0, encoding_column = 0;
    const char *encoding_message = NULL;
    bool encoding = encoding_error(source, &encoding_line, &encoding_column, &encoding_message);
    strs lines = strs_split(source, '\n');
    if (lines.n > 0 && lines.v[lines.n - 1].n == 0) {
        lines.n--;
    }
    if (lines.n == 0) {
        stop(p, "header", 1, 1, SL("document is empty; the first line must be dbspec 1 <document>"));
    }
    for (size_t index = 0; index < lines.n; index++) {
        if (encoding && (zend_long)index + 1 >= encoding_line) {
            break;
        }
        str text = lines.v[index];
        if (text.n > 0 && text.s[text.n - 1] == '\r') {
            text.n--;
        }
        p->line = (zend_long)index + 1;
        p->text = text;
        p->reading = true;
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
        if (p->marking && (p->table_failed || p->settings_failed || p->diagram_failed)) {
            smap_set(&p->lexical, fmt("%d", (int)p->line), TRUEP);
        }
        tokenize(p);
        if (p->lex_failed) {
            error(p, "syntax", p->line, p->lex_column, p->lex_message);
            /* Reads with the error characters removed from the tokens (Go's lexRecover): a table header line on the top line also opens the table. */
            lex_line(p, true);
            if (lexed_line(p)) {
                continue;
            }
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
    p->reading = false;
    if (encoding) {
        stop(p, "encoding", encoding_line, encoding_column, str_c(encoding_message));
    }
    /* Reports only the innermost open block (as in Go): an open settings block does not report the table's `{`. */
    if (p->state == S_SETTINGS) {
        unclosed(p, p->settings_open[0], p->settings_open[1], fmt("block opened at this %S is not closed", dbs_describe(p->settings_open_text)));
        p->state = S_TABLE;
        close_table(p);
    } else if (p->state == S_TABLE) {
        unclosed(p, p->block_open[0], p->block_open[1], fmt("block opened at this %S is not closed", dbs_describe(p->block_open_text)));
        close_table(p);
    } else if (p->state == S_DIAGRAM) {
        unclosed(p, p->block_open[0], p->block_open[1], fmt("block opened at this %S is not closed", dbs_describe(p->block_open_text)));
    }
    p->doc->trailing = take_comments(p);
    check_foreign_key_targets(p);
    check_audit_records(p);
    check_audit_tables(p);
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

/* True if source is read to the end; false if stop halts reading through longjmp. setjmp is only within this function, and this function
 * does not change its own locals between setjmp and longjmp, so no local has an indeterminate value after longjmp
 * (C11 7.13.2.1). */
static bool read_until_stop(parser *p, str source)
{
    if (setjmp(p->stop_jump) != 0) {
        return false;
    }
    read_source(p, source);
    return true;
}

static int cmp_decl(const void *a, const void *b, void *ctx)
{
    const dpos *x = a, *y = b;
    (void)ctx;
    if (x->line != y->line) {
        return x->line < y->line ? -1 : 1;
    }
    if (x->column != y->column) {
        return x->column < y->column ? -1 : 1;
    }
    return 0;
}

/* The class of a token whose line gives it none (docs/spec/dbspec.md "Syntax analysis"). */
static const char *lexical_class(str text)
{
    if (text.n > 0 && text.s[0] == '\'') {
        return "string";
    }
    if (str_eqc(text, "(") || str_eqc(text, ")") || str_eqc(text, "{") || str_eqc(text, "}") || str_eqc(text, ",")) {
        return "punctuation";
    }
    if (str_eqc(text, "=") || str_eqc(text, "<>") || str_eqc(text, "<") || str_eqc(text, "<=") || str_eqc(text, ">")
        || str_eqc(text, ">=") || str_eqc(text, "+") || str_eqc(text, "-") || str_eqc(text, "*") || str_eqc(text, "/")) {
        return "operator";
    }
    if (number_text(text)) {
        return "number";
    }
    return "word";
}

/* The tokens of every line of the source in source order (docs/spec/dbspec.md "Syntax analysis"). Each line is split and
 * lexed as read_source reads it, so a line the parser did not read gets the same tokens. */
static void analysis_tokens(parser *p, str source, dtokv *out)
{
    strs lines = strs_split(source, '\n');
    for (size_t i = 0; i < lines.n; i++) {
        str text = lines.v[i];
        /* A CR before an LF is part of the line end; a bare CR is an offending character (R8, R22). */
        if (i + 1 < lines.n && text.n > 0 && text.s[text.n - 1] == '\r') {
            text.n--;
        }
        zend_long line = (zend_long)i + 1;
        str trimmed = str_ltrim_spaces(text);
        if (trimmed.n == 0) {
            continue;
        }
        if (trimmed.s[0] == '#') {
            dtoken c = {line, (zend_long)(text.n - trimmed.n), 0, SL("comment")};
            c.end = c.start + (zend_long)utf8_count(trimmed);
            PUSH(*out, c);
            continue;
        }
        p->line = line;
        p->text = text;
        lex_line(p, false);
        if (p->lex_failed) {
            lex_line(p, true);
        }
        bool lexical_only = smap_has(&p->lexical, fmt("%d", (int)line));
        for (size_t k = 0; k < p->t.n; k++) {
            const token *t = &p->t.v[k];
            const char *class = lexical_only ? NULL : (const char *)smap_get(&p->marks, fmt("%d:%d", (int)line, (int)k));
            if (class == NULL) {
                class = lexical_class(t->text);
            }
            dtoken d = {line, t->column - 1, t->column - 1 + (zend_long)utf8_count(t->text), str_c(class)};
            PUSH(*out, d);
        }
    }
}

/* The rules judged on the whole document (docs/spec/dbspec.md DBS-144): a stopped document gives none of them,
 * though this parser judges some of them as it reads a table. */
static bool document_rule(str rule)
{
    return str_eqc(rule, "name.duplicate") || str_eqc(rule, "column") || str_eqc(rule, "key") ||
        str_eqc(rule, "foreign_key") || str_eqc(rule, "use") || str_eqc(rule, "diagram");
}

static document *run(parser *p, str source, diags *out, dposv *pos, dtokv *tokens)
{
    p->marking = tokens != NULL;
    bool stopped = !read_until_stop(p, source);
    diag stopd = {0};
    if (stopped) {
        stopd = p->diagnostics.v[--p->diagnostics.n];
        size_t kept = 0;
        for (size_t i = 0; i < p->diagnostics.n; i++) {
            if (!document_rule(p->diagnostics.v[i].rule)) {
                p->diagnostics.v[kept++] = p->diagnostics.v[i];
            }
        }
        p->diagnostics.n = kept;
    }
    /* A limit error gives no tokens, whatever was read before it (R22). */
    if (tokens != NULL && !(stopped && str_eqc(stopd.rule, "limit"))) {
        analysis_tokens(p, source, tokens);
    }
    if (p->diagnostics.n == 0 && !stopped) {
        dbs_sort(p->decls.v, p->decls.n, sizeof(dpos), cmp_decl, NULL);
        *pos = p->decls;
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

/* Mark of the used document being read. */
static used_entry reading;

/* Parses and verifies once a used document of the declared set, together with its own use line. */
static used_entry *used_document(parser *p, str name)
{
    used_entry *e = smap_get(p->used, name);
    if (e == &reading) {
        /* Rewriting a document being read is a use cycle. If the header name differs from the set's name, it cannot be found through the name chain. */
        used_entry *cycle = dbs_alloc(sizeof *cycle);
        cycle->has_reason = true;
        cycle->reason = use_cycle_reason(p, name);
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
    dposv unused = {0};
    document *d = run(child, *text, &found, &unused, NULL);
    e = dbs_alloc(sizeof *e);
    /* Go: a document that did not stop and whose header names another document holds that document; otherwise its first
     * diagnostic in source order makes it invalid. */
    const char *last_rule = found.n > 0 ? found.v[found.n - 1].rule.s : "";
    bool stopped = strcmp(last_rule, "header") == 0 || strcmp(last_rule, "encoding") == 0 || strcmp(last_rule, "limit") == 0;
    if (!stopped && child->doc != NULL && !str_eq(child->doc->name, name)) {
        e->has_reason = true;
        e->reason = fmt("the document set entry %S holds document %S", dbs_quote(name), dbs_quote(child->doc->name));
    } else if (d == NULL) {
        diag first = found.v[0];
        e->has_reason = true;
        e->reason = fmt("used document %S is invalid: line %d column %d %S: %S", dbs_quote(name), first.line, first.column, first.rule, first.message);
    } else {
        e->doc = d;
    }
    smap_set(p->used, name, e);
    return e;
}

document *dbs_parse(str text, const smap *documents, diags *out, dposv *pos)
{
    smap *used = dbs_alloc(sizeof *used);
    parser *p = parser_new(documents, NULL, used);
    return run(p, text, out, pos, NULL);
}

document *dbs_analyze(str text, const smap *documents, diags *out, dposv *pos, dtokv *tokens)
{
    smap *used = dbs_alloc(sizeof *used);
    parser *p = parser_new(documents, NULL, used);
    return run(p, text, out, pos, tokens);
}

/* The name that the header step reads from the text, empty when the header fails (docs/spec/dbspec.md "Parsing a set"):
 * the read runs without used documents, as Go's parseStructure(text, nil), and its diagnostics are dropped. */
str dbs_header_name(str text)
{
    smap none = {0};
    smap *used = dbs_alloc(sizeof *used);
    parser *p = parser_new(&none, NULL, used);
    read_until_stop(p, text);
    return p->doc != NULL ? p->doc->name : (str){0};
}
