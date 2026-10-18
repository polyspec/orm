/*
 * Internal declarations of the orm_dbspec extension. The dbspec operations (parse, emit, manifest, render, plan, Mermaid, introspection,
 * apply) run on this header's C model exactly as specified by the PHP client (packages/php/src/Dbspec), and the PHP object
 * graph is converted in both directions by convert.c. All allocations of one call go into one arena, which is freed at once at the end of the call.
 */
#ifndef ORM_DBSPEC_H
#define ORM_DBSPEC_H

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "php.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_exceptions.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* ------------------------------------------------------------------ arena */

typedef struct dbs_block {
    struct dbs_block *next;
    size_t used, cap;
    char data[];
} dbs_block;

typedef struct {
    dbs_block *head;
} dbs_arena;

/* The arena of the extension method currently running. When the method calls PHP code (an event handler) and that code calls the extension again,
 * the inner method sets its own arena aside and restores it (dbs_enter, dbs_leave). */
#ifdef ZTS
#define DBS_TLS __thread
#else
#define DBS_TLS
#endif
extern DBS_TLS dbs_arena *dbs_current;

void *dbs_alloc(size_t size);
void dbs_arena_free(dbs_arena *a);
void dbs_enter(dbs_arena *mine, dbs_arena **saved);
void dbs_leave(dbs_arena *mine, dbs_arena *saved);

/* ---------------------------------------------------------------- strings */

/* View of a byte string. Strings made by the arena end with a NUL, but the length is the reference (it can contain NUL). */
typedef struct {
    const char *s;
    size_t n;
} str;

#define SL(lit) ((str){(lit), sizeof(lit) - 1})
#define SNULL ((str){NULL, 0})

str str_of(const char *s, size_t n);   /* Arena copy */
str str_c(const char *s);              /* Arena copy of a C string */
str str_z(zend_string *z);             /* Arena copy of a zend_string */
str str_sub(str s, size_t from, size_t len);
bool str_eq(str a, str b);
bool str_eqc(str a, const char *c);
int str_cmp(str a, str b);              /* Byte order same as PHP strcmp */
bool str_starts(str s, const char *prefix);
bool str_ends(str s, const char *suffix);
bool str_has(str s, const char *needle);
bool str_hasch(str s, char c);
ssize_t str_find(str s, const char *needle, size_t from);
str str_ltrim_spaces(str s);
str str_trim_set(str s, const char *set); /* PHP trim($s, $set) */
str str_lower(str s);
str str_upper(str s);
bool str_digits(str s);                  /* ctype_digit: not empty and all 0-9 */
bool str_word(str s);                    /* [A-Za-z0-9_]+ */
bool str_dotted(str s);                  /* a Go word token: a run of word runes, [A-Za-z0-9_.] or a Unicode letter or digit */
bool str_decimal(str s);                 /* [0-9]+\.[0-9]+ */
str str_replace(str s, const char *from, const char *to);
str str_repeat(const char *s, size_t times);
size_t utf8_length(str s);               /* Number of code points (valid UTF-8) */
uint32_t utf8_decode_at(str s, size_t i, size_t *width); /* Code point value at position i and its byte count */
size_t word_rune_width(str s, size_t i); /* Byte count of the character at position i if it is Go's isWordRune, otherwise 0 */
size_t word_run_end(str s, size_t i);  /* Position where the word token starting at position i ends */
bool name_rule(str name, const char **rule, str *message); /* Go's nameDiagnostics: the rule and message for a name with a wrong format or length */
size_t utf8_valid_prefix(str s);         /* Byte count of the valid UTF-8 prefix */
size_t utf8_char_width(str s, size_t i); /* Byte count of the code point at position i: its length if a valid UTF-8 character, otherwise 1 (R15) */
size_t utf8_count(str s);                /* Code point count; each invalid byte also counts as one (R15) */
zend_string *str_zend(str s);

/* String builder. */
typedef struct {
    char *s;
    size_t n, cap;
} sbuf;

void sb_add(sbuf *b, const char *s, size_t n);
void sb_s(sbuf *b, str s);
void sb_c(sbuf *b, const char *c);
void sb_ch(sbuf *b, char c);
void sb_long(sbuf *b, zend_long v);
void sb_fmt(sbuf *b, const char *fmt, ...);
str sb_str(sbuf *b);

/* Format string: %S is str, %s is a C string, %d is zend_long, %u is size_t, %% is %. */
str fmt(const char *format, ...);

/* ----------------------------------------------------------------- vectors */

#define VEC(T) struct { T *v; size_t n, cap; }
void vec_grow(void **v, size_t *cap, size_t need, size_t size);
#define PUSH(vec, x) do { \
        if ((vec).n == (vec).cap) vec_grow((void **)&(vec).v, &(vec).cap, (vec).n + 1, sizeof *(vec).v); \
        (vec).v[(vec).n++] = (x); \
    } while (0)

typedef VEC(str) strs;

bool strs_has(const strs *l, str s);
bool strs_eq(const strs *a, const strs *b);
str strs_join(const strs *l, const char *sep);
strs strs_copy(const strs *l);
strs strs_split(str s, char sep);          /* PHP explode */
void strs_sort(strs *l);                    /* Byte order, stable */

/* Stable merge sort. */
void dbs_sort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *, void *), void *ctx);

/* ------------------------------------------------------------------- maps */

/* Map with string keys. Like a PHP array, it keeps insertion order, and rewriting the same key keeps its position. */
typedef struct {
    str key;
    void *val;
    bool live;
} sment;

typedef struct {
    sment *e;
    size_t n, cap, live;
    int32_t *idx;
    size_t icap;
} smap;

void *smap_get(const smap *m, str key);
bool smap_has(const smap *m, str key);
void smap_set(smap *m, str key, void *val);
void smap_del(smap *m, str key);
#define SMAP_EACH(m, i) for (size_t i = 0; i < (m)->n; i++) if ((m)->e[i].live)
void smap_keys_sorted(const smap *m, strs *out);
#define TRUEP ((void *)1)

/* ------------------------------------------------------------- diagnostics */

typedef struct {
    str rule;
    zend_long line, column;
    str message;
} diag;

typedef VEC(diag) diags;

/* Position of a declaration (docs/dbspec.md "Declaration positions"): kind, name path, line and column (code point). */
typedef struct {
    str kind;
    strs path;
    zend_long line, column;
} dpos;

typedef VEC(dpos) dposv;

/* A token with its line, column (code point, from 0), end column, and class (docs/dbspec.md "Syntax analysis"). */
typedef struct {
    zend_long line, start, end;
    str class;
} dtoken;
typedef VEC(dtoken) dtokv;

static inline diag mkdiag(str rule, zend_long line, zend_long column, str message)
{
    diag d = {rule, line, column, message};
    return d;
}

/* ------------------------------------------------------------------- model */

typedef struct {
    str name;           /* "invalid" is a type that parse does not recognize */
    zend_long *p;
    size_t np;
} ctype;

str ctype_text(const ctype *t);
bool ctype_integer(const ctype *t);
bool ctype_same(const ctype *a, const ctype *b);
ctype *ctype_new(str name, const zend_long *p, size_t np);

typedef struct {
    str name;
    ctype *type;
    bool nullable, identity;
    bool has_default;
    str def;
    strs comments;
    zend_object *src;
} column;

typedef struct {
    strs columns;
    strs comments;
} pkey;

typedef struct {
    str name;
    strs columns;
    strs comments;
} ukey;

typedef struct {
    str name;
    bool descending;
} icol;

typedef VEC(icol) icols;

typedef struct {
    str name;
    icols columns;
    strs comments;
} xindex;

typedef struct {
    str name;
    strs columns;
    str table;
    strs refs;
    str on_delete, on_update;
    strs comments;
} fkey;

typedef struct {
    str name;
    str expression;
    strs comments;
} check;

typedef struct {
    str kind;
    strs args;
    strs comments;
    strs *exclude, *include; /* NULL means there is no list */
    str form;                /* Shape of the state_machine line; other settings are SNULL */
    strs *requires;          /* require list of state_machine; NULL if none */
} setting;

typedef VEC(setting *) settingv;

typedef struct {
    settingv list;
    strs closing;
    strs comments;
} settings;

typedef VEC(column *) columnv;
typedef VEC(ukey *) ukeyv;
typedef VEC(xindex *) indexv;
typedef VEC(fkey *) fkeyv;
typedef VEC(check *) checkv;

typedef struct {
    str name;
    strs comments;
    columnv columns;
    pkey *pk;
    ukeyv uniques;
    indexv indexes;
    fkeyv fks;
    checkv checks;
    settings *settings;
    strs closing;
    /* The table line failed (no name, no `{`, or more text after `{`). This is Go's failed table. */
    bool header_failed;
} table;

typedef struct {
    str table;
    zend_long x, y;
    strs comments;
} placement;

typedef VEC(placement *) placementv;

typedef struct {
    str name;
    strs comments;
    placementv placements;
    strs closing;
} diagram;

typedef struct {
    str document;
    strs tables;
    strs comments;
} useline;

typedef VEC(useline *) usev;
typedef VEC(table *) tablev;
typedef VEC(diagram *) diagramv;

typedef struct {
    str name;
    usev uses;
    tablev tables;
    diagramv diagrams;
    strs trailing;
    bool external;
    zend_object *src;    /* Original of the document changed from a PHP object */
} document;

typedef VEC(document *) documentv;

column *column_new(str name, ctype *type, bool nullable, bool identity, const str *def);
column *table_column(const table *t, str name);
bool setting_records(const setting *s, str column);
strs setting_excluded(const setting *s, const table *t);
str setting_audit_line(const setting *s, const char *list, const strs *columns);
bool fkey_changes_child_rows(const fkey *f);
document *document_new(str name);
table *table_new(str name);

extern const char *const dbs_reserved[];
bool dbs_valid_name(str name);

/* ------------------------------------------------------------------- parse */

/* Parses text as a document set (name => text). If there are no documents, diagnostics contain at least one entry. */
document *dbs_parse(str text, const smap *documents, diags *out, dposv *pos);
/* The name that the parser's header step reads from the text, empty when the header fails (Dbspec::parseSet). */
str dbs_header_name(str text);
/* Same as dbs_parse, and also gives the tokens (none if it is a limit error). */
document *dbs_analyze(str text, const smap *documents, diags *out, dposv *pos, dtokv *tokens);

/* Table of rules in check order. */
zend_long dbs_rule_rank(str rule);

/* Literal */
typedef struct {
    bool negative;
    str digits;
    bool has_fraction;
    str fraction;
} number;

bool literal_number(str text, number *out);
bool literal_integer(str text, str *out);
bool literal_string_value(str token, str *out);
str literal_quote(str value);
/* Canonical default of a column type, or a problem. */
bool literal_column_default(const ctype *type, str text, str *canonical, str *problem);
str literal_shortest_decimal(double value);

/* check expression */
typedef struct {
    str text;
    zend_long column;
    /* the line and the index in the line of a token the lexer made; a token the parser makes has line 0 */
    zend_long line;
    zend_long index;
} token;

typedef VEC(token) tokens;

typedef struct {
    str rule;
    zend_long line, column;
    str message;
} raw_error;

/* columns: name => column*, action: name => foreign key name (str*) */
bool expression_parse(const tokens *t, zend_long line, zend_long end, const smap *columns, const smap *action, str *text, diags *errors, smap *marks);

/* ------------------------------------------------------------- emit, set */

typedef enum { VIEW_CANONICAL, VIEW_MANIFEST, VIEW_SCHEMA } dbs_view;

str dbs_emit(const document *d, dbs_view view);
/* Set sorted by document name, and its diagnostics. */
void dbs_set_check(const documentv *in, documentv *ordered, diags *out);

typedef struct {
    str manifest_text, schema_text, manifest_hash, schema_hash, external_text;
} manifest;

bool dbs_manifest(const documentv *documents, manifest *m, diags *out);
str dbs_sha256(str text);  /* "sha256:<hex>" */
str dbs_renderer_name(str table, str suffix);  /* Renderer name of <table>$<suffix> */

/* ------------------------------------------------------------------ render */

typedef enum { D_MYSQL, D_POSTGRES, D_SQLITE } dialect;

/* For an unknown dialect, throws InvalidArgumentException and returns false. */
bool dbs_dialect(str name, dialect *out);
extern const char *const dbs_dialect_names[3];

typedef struct {
    dialect d;
    /* State while reading check text */
    strs tokens;
    size_t at;
    const table *table;
    str check_name;
    bool failed;
} renderer;

typedef struct {
    str statement;
    str table;
} rendered;
typedef VEC(rendered) renderedv;

/* A failure is an InvalidArgumentException, and the results after it are discarded. */
void render_statements(const documentv *documents, dialect d, renderedv *out);
str r_q(const renderer *r, str name);
str r_list(const renderer *r, const strs *names);
strs r_table(renderer *r, const table *t);
str r_create_table(renderer *r, const table *t, str name, str (*check_name)(void *, str), void *ctx, const columnv *hidden);
str r_table_check_name(void *ctx, str column);
str r_column(renderer *r, const column *c);
str r_type_text(renderer *r, const ctype *t);
str r_default_text(renderer *r, const ctype *t, str def);
str r_foreign_key(renderer *r, const fkey *f);
str r_type_check(renderer *r, const column *c);
str r_check_text(renderer *r, const table *t, const check *k);
str r_index_columns(renderer *r, const xindex *x);
strs r_triggers(renderer *r, const table *t);

/* ------------------------------------------------------------------- plans */

typedef struct {
    str old, new_;
} trename;

typedef struct {
    str table, old, new_;
} crename;

typedef struct {
    str table, name;
} cname;

typedef VEC(trename) trenamev;
typedef VEC(crename) crenamev;
typedef VEC(cname) cnamev;

typedef struct {
    str name;
    bool has_from;
    str from;
    trenamev rename_tables;
    crenamev rename_columns;
    strs drop_tables;
    cnamev drop_columns;
    document *schema;
    str to;
    zend_object *src;   /* Original of the plan changed from a PHP Plan object */
} plan;

typedef VEC(plan *) planv;

typedef struct {
    str kind, table, name;
    bool present;
} effect;

typedef struct {
    str table, column;
    bool has_default;
    str def;
} nullcheck;

typedef VEC(nullcheck) nullcheckv;

typedef struct {
    str statement, rollback, irreversible;
    effect effect;
    str restore, rollback_restore;
    bool has_restore_if;
    effect restore_if;
    nullcheckv null_checks;
    bool finalize;
} planstep;

typedef VEC(planstep) planstepv;

/* kind, table, name: Change of the diff and Difference of the comparison */
typedef struct {
    str kind, table, name;
} change;

typedef VEC(change) changev;

/* Objects that introspection and Mermaid could not carry over */
typedef struct {
    str kind, table, name, reason;
} unsupported;

typedef VEC(unsupported) unsupportedv;

str effect_text(const effect *e);

/* Plan text. On failure, there is no plan, only diagnostics. */
plan *plan_parse(str text, diags *out);
plan *plan_to(str name, bool has_from, str from, trenamev rt, crenamev rc, strs dt, cnamev dc, document *schema, str schema_text, diags *out);
str plan_emit(const plan *p);
/* Plan in chain order, or chain diagnostics */
bool plan_chain(const planv *plans, planv *out, diags *d);
/* Changes from source (NULL means an empty database) to the plan target, or plan diagnostics */
bool plan_diff(const document *source, const plan *p, changev *out, diags *d);
/* Failures (such as an unknown dialect) are exceptions. */
bool plan_steps(const document *source, const plan *p, dialect d, planstepv *out, diags *diag);
bool schema_compare(const document *source, const document *target, changev *out, diags *d);
bool is_schema_text(const document *d);
strs external_differences(const document *live, const documentv *documents);
strs installed_differences(const document *live, const unsupportedv *skipped, const document *target);
/* Tables and columns to create, steps, differences */
void add_tables_and_columns_steps(const document *live, const unsupportedv *skipped, const document *target, str dialect_name,
    strs *added, planstepv *steps, strs *differences);

/* ---------------------------------------------------------------- catalog */

/* Neutral intermediate model of introspection and the Mermaid import (PHP client Catalog, CatalogTable). */
typedef struct {
    str name;
    ctype *type;
    bool null, identity;
    str def;    /* Empty means there is no default */
} icolumn;

typedef struct {
    str name;
    strs columns;
    VEC(bool) desc;
} ikey;

typedef struct {
    str name;
    strs columns;
    str table;
    strs refs;
    str on_delete, on_update;
} ifkey;

typedef struct {
    str name, predicate;
} icheck;

typedef struct {
    str name;
    VEC(icolumn) columns;
    strs primary;
    VEC(ikey) uniques;
    VEC(ikey) indexes;
    VEC(ifkey) fks;
    VEC(icheck) checks;
    strs settings;
} itable;

typedef struct {
    VEC(itable *) tables;
    unsupportedv unsupported;
} catalog;

itable *itable_new(str name);
itable *catalog_table(catalog *c, str name);
void catalog_report(catalog *c, str kind, str table, str name, str reason);
/* Document and missing objects. If a line that parse cannot handle does not belong to an object, it is a RuntimeException and NULL. */
document *catalog_document(catalog *c, str name, unsupportedv *out);
smap itable_types(const itable *t);   /* column name => ctype* */
void itable_drop_column(itable *t, str name);
str catalog_action_name(str rule, bool *ok);
str catalog_unscaled_decimal(str text, zend_long scale);

/* ----------------------------------------------------------- introspection */

/* Calls a method of a PDO object through the Zend API. If an exception is left, it is false and ret is UNDEF. */
bool pdo_call(zval *obj, const char *name, zval *ret, uint32_t argc, zval *a1, zval *a2);
bool pending_pdo_exception(void);
zend_object *take_exception(void);
void throw_with_previous(zend_class_entry *ce, str message, zend_object *previous);
str exception_message(zend_object *e);
str debug_type(zval *v);
/* CatalogRows: all rows of query and the rules for reading values. A failure is a PHP exception and returns false. */
bool catalog_read(zval *pdo, str query, zval *rows);
bool row_text(zval *row, zend_long i, str query, str *out);
bool row_nullable_text(zval *row, zend_long i, str query, bool *null, str *out);
bool row_integer(zval *row, zend_long i, str query, zend_long *out);
bool value_integer(zval *v, zend_long i, str query, zend_long *out);
bool value_flag(zval *v, zend_long i, str query, bool *out);
/* Reads the connection's database as one document and missing objects. A failure is a PHP exception and NULL. */
document *dbs_introspect(zval *pdo, dialect d, str name, unsupportedv *out);

/* ------------------------------------------------------------------ apply */

/* Entry of PlanApply::EFFECT_QUERIES. The list ends with an entry whose dialect is NULL. */
typedef struct {
    const char *dialect, *kind, *query;
} dbs_effect_query;
extern const dbs_effect_query dbs_effect_queries[];
/* op is apply, recover, rollback, or finalize. A failure is a PHP exception and false. */
bool dbs_apply(const char *op, zval *c, str dialect_name, zval *plans, zval *now, zval *events);
bool dbs_effect_on(zval *c, str dialect_name, const effect *e, bool *out);

/* ---------------------------------------------------------------- Mermaid */

str mermaid_export(const document *d, unsupportedv *dropped);
/* A document, or one diagnostic. Exceptions (outside RuntimeException) are thrown. */
document *mermaid_import(str text, str name, unsupportedv *dropped, diags *out);

/* ---------------------------------------------------------------- sets */

/* Dbspec::readSet (set.c): the SetResult of the set file at path into return_value. */
void dbs_read_set(zend_string *path, zval *return_value);

/* -------------------------------------------------------------- PHP objects */

#define DBS_CLASSES(X) X(Analysis) X(Token) X(FormatResult) X(Names) X(Diagnostic) X(Document) X(UseLine) X(Table) X(Column) X(ColumnType) X(PrimaryKey) X(UniqueKey) \
    X(Index) X(IndexColumn) X(ForeignKey) X(Check) X(Settings) X(Setting) X(Diagram) X(Placement) X(Position) X(ReadResult) \
    X(ParseResult) X(Manifest) X(ManifestResult) X(RenderResult) X(Plan) X(PlanStep) X(Effect) X(NullCheck) X(Change) \
    X(Difference) X(Unsupported) X(TableRename) X(ColumnRename) X(ColumnName) X(ApplyEvent) X(ApplyError) \
    X(ApplyCleanupError) X(PlanParseResult) X(PlanStepsResult) X(ChainResult) X(DiffResult) X(ComparisonResult) \
    X(MermaidExportResult) X(MermaidImportResult) X(IntrospectResult) X(Dbspec) X(PlanApply) X(SetFile) X(SetError) X(SetResult) X(SetDocument)

#define DBS_DECLARE_CE(n) extern zend_class_entry *dbs_ce_##n;
DBS_CLASSES(DBS_DECLARE_CE)
#undef DBS_DECLARE_CE

/* Creates a new object (does not call the constructor). */
void obj_new(zval *out, zend_class_entry *ce);
/* Places a value in a declared property's slot. Takes ownership of v. A readonly property can also be set once, the first time. */
void obj_put(zval *obj, const char *name, zval *v);
void obj_put_str(zval *obj, const char *name, str s);
void obj_put_long(zval *obj, const char *name, zend_long v);
void obj_put_bool(zval *obj, const char *name, bool v);
void obj_put_null(zval *obj, const char *name);
void obj_put_strs(zval *obj, const char *name, const strs *l);
/* Property value (dereferenced); if it is uninitialized, throws Error and returns NULL. */
zval *obj_get(zval *obj, const char *name);

void zv_strs(zval *out, const strs *l);
void zv_diags(zval *out, const diags *d);
void zv_positions(zval *out, const dposv *d);
void zv_tokens(zval *out, const dtokv *t);
/* Two result objects: the first property and diagnostics. If first is NULL, it is null. */
void zv_result(zval *out, zend_class_entry *ce, const char *first, zval *value, const diags *d);

/* Converts a PHP value to a C value. On failure, throws TypeError and returns false. */
bool in_str(zval *v, str *out, const char *what);
bool in_strs(zval *v, strs *out, const char *what);
bool in_document(zval *v, document **out);
bool in_documents(zval *v, documentv *out, const char *what);
/* Converts a C document to a PHP Document object. */
void out_document(const document *d, zval *out);
bool in_plan(zval *v, plan **out);
bool in_plans(zval *v, planv *out, const char *what);
void out_plan(const plan *p, zval *out);
void out_steps(const planstepv *steps, zval *out);
void out_changes(const changev *changes, zend_class_entry *ce, zval *out);
bool in_unsupported(zval *v, unsupportedv *out, const char *what);
void out_unsupported(const unsupportedv *list, zval *out);

/* ------------------------------------------------------------- exceptions */

/* Throws a PHP exception. The caller stops the operation by returning false. */
bool dbs_throw(zend_class_entry *ce, str message);
#define dbs_failed() (EG(exception) != NULL)

#endif
