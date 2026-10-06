/*
 * 확장 orm_dbspec의 내부 선언이다. dbspec 연산(parse, emit, manifest, render, plan, Mermaid, introspection,
 * apply)은 이 header의 C model 위에서 PHP client(clients/php/src/Dbspec)의 사양 그대로 동작하고, PHP 객체
 * graph와는 convert.c가 양방향으로 바꾼다. 호출 하나의 할당은 모두 arena 하나에 두고 호출 끝에 한 번에 푼다.
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

/* 지금 실행 중인 확장 메서드의 arena다. 메서드가 PHP code(event handler)를 부르고 그 code가 다시 확장을
 * 부르면 안쪽 메서드가 자기 arena를 두었다가 돌려놓는다(dbs_enter, dbs_leave). */
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

/* byte 문자열 view다. arena가 만든 문자열은 끝에 NUL을 두지만 길이가 기준이다(NUL을 담을 수 있다). */
typedef struct {
    const char *s;
    size_t n;
} str;

#define SL(lit) ((str){(lit), sizeof(lit) - 1})
#define SNULL ((str){NULL, 0})

str str_of(const char *s, size_t n);   /* arena 사본 */
str str_c(const char *s);              /* C 문자열의 arena 사본 */
str str_z(zend_string *z);             /* zend_string의 arena 사본 */
str str_sub(str s, size_t from, size_t len);
bool str_eq(str a, str b);
bool str_eqc(str a, const char *c);
int str_cmp(str a, str b);              /* PHP strcmp와 같은 byte 순서 */
bool str_starts(str s, const char *prefix);
bool str_ends(str s, const char *suffix);
bool str_has(str s, const char *needle);
bool str_hasch(str s, char c);
ssize_t str_find(str s, const char *needle, size_t from);
str str_ltrim_spaces(str s);
str str_trim_set(str s, const char *set); /* PHP trim($s, $set) */
str str_lower(str s);
str str_upper(str s);
bool str_digits(str s);                  /* ctype_digit: 비어 있지 않고 모두 0-9 */
bool str_word(str s);                    /* [A-Za-z0-9_]+ */
str str_replace(str s, const char *from, const char *to);
str str_repeat(const char *s, size_t times);
size_t utf8_length(str s);               /* code point 수(올바른 UTF-8) */
size_t utf8_valid_prefix(str s);         /* 올바른 UTF-8인 앞부분의 byte 수 */
zend_string *str_zend(str s);

/* 문자열 builder. */
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

/* 형식 문자열: %S는 str, %s는 C 문자열, %d는 zend_long, %u는 size_t, %%는 %다. */
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
void strs_sort(strs *l);                    /* byte 순서, 안정 */

/* 안정 merge sort. */
void dbs_sort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *, void *), void *ctx);

/* ------------------------------------------------------------------- maps */

/* 문자열 key의 map이다. PHP 배열처럼 넣은 순서를 지키고, 같은 key를 다시 쓰면 자리를 지킨다. */
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

static inline diag mkdiag(str rule, zend_long line, zend_long column, str message)
{
    diag d = {rule, line, column, message};
    return d;
}

/* ------------------------------------------------------------------- model */

typedef struct {
    str name;           /* "invalid"은 parse가 알 수 없는 type이다 */
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
    strs *exclude, *include; /* NULL이면 목록이 없다 */
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
    zend_object *src;    /* PHP 객체에서 바꾼 문서의 원본 */
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

/* 문서 집합(이름 => text)으로 text를 parse한다. 문서가 없으면 diagnostics에 하나 이상이 있다. */
document *dbs_parse(str text, const smap *documents, diags *out);

/* 확인 순서의 rule 표다. */
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
/* column type의 canonical default, 또는 problem. */
bool literal_column_default(const ctype *type, str text, str *canonical, str *problem);
str literal_shortest_decimal(double value);

/* check 식 */
typedef struct {
    str text;
    zend_long column;
} token;

typedef VEC(token) tokens;

typedef struct {
    str rule;
    zend_long line, column;
    str message;
} raw_error;

/* columns: 이름 => column*, action: 이름 => foreign key 이름(str*) */
bool expression_parse(const tokens *t, zend_long line, zend_long end, const smap *columns, const smap *action, str *text, diags *errors);

/* ------------------------------------------------------------- emit, set */

typedef enum { VIEW_CANONICAL, VIEW_MANIFEST, VIEW_SCHEMA } dbs_view;

str dbs_emit(const document *d, dbs_view view);
/* 문서 이름 순으로 정렬한 집합과 그 diagnostic이다. */
void dbs_set_check(const documentv *in, documentv *ordered, diags *out);

typedef struct {
    str manifest_text, schema_text, manifest_hash, schema_hash, external_text;
} manifest;

bool dbs_manifest(const documentv *documents, manifest *m, diags *out);
str dbs_sha256(str text);  /* "sha256:<hex>" */

/* ------------------------------------------------------------------ render */

typedef enum { D_MYSQL, D_POSTGRES, D_SQLITE } dialect;

/* 알 수 없는 dialect면 InvalidArgumentException을 던지고 false다. */
bool dbs_dialect(str name, dialect *out);
extern const char *const dbs_dialect_names[3];

typedef struct {
    dialect d;
    /* check text를 읽는 중의 상태 */
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

/* 실패는 InvalidArgumentException이고 그 뒤의 결과는 버린다. */
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

/* -------------------------------------------------------------- PHP objects */

#define DBS_CLASSES(X) X(Diagnostic) X(Document) X(UseLine) X(Table) X(Column) X(ColumnType) X(PrimaryKey) X(UniqueKey) \
    X(Index) X(IndexColumn) X(ForeignKey) X(Check) X(Settings) X(Setting) X(Diagram) X(Placement) X(ReadResult) \
    X(ParseResult) X(Manifest) X(ManifestResult) X(RenderResult) X(Plan) X(PlanStep) X(Effect) X(NullCheck) X(Change) \
    X(Difference) X(Unsupported) X(TableRename) X(ColumnRename) X(ColumnName) X(ApplyEvent) X(ApplyError) \
    X(ApplyCleanupError) X(PlanParseResult) X(PlanStepsResult) X(ChainResult) X(DiffResult) X(ComparisonResult) \
    X(MermaidExportResult) X(MermaidImportResult) X(IntrospectResult) X(Dbspec)

#define DBS_DECLARE_CE(n) extern zend_class_entry *dbs_ce_##n;
DBS_CLASSES(DBS_DECLARE_CE)
#undef DBS_DECLARE_CE

/* 새 객체를 만든다(생성자는 부르지 않는다). */
void obj_new(zval *out, zend_class_entry *ce);
/* 선언된 property의 자리에 값을 둔다. v의 소유권을 가져간다. readonly property도 처음 한 번 둘 수 있다. */
void obj_put(zval *obj, const char *name, zval *v);
void obj_put_str(zval *obj, const char *name, str s);
void obj_put_long(zval *obj, const char *name, zend_long v);
void obj_put_bool(zval *obj, const char *name, bool v);
void obj_put_null(zval *obj, const char *name);
void obj_put_strs(zval *obj, const char *name, const strs *l);
/* property 값(참조를 푼 것), 초기화되지 않았으면 Error를 던지고 NULL이다. */
zval *obj_get(zval *obj, const char *name);

void zv_strs(zval *out, const strs *l);
void zv_diags(zval *out, const diags *d);
/* 결과 객체 둘: 첫 property와 diagnostics. first가 NULL이면 null이다. */
void zv_result(zval *out, zend_class_entry *ce, const char *first, zval *value, const diags *d);

/* PHP 값을 C 값으로 바꾼다. 실패하면 TypeError를 던지고 false다. */
bool in_str(zval *v, str *out, const char *what);
bool in_strs(zval *v, strs *out, const char *what);
bool in_document(zval *v, document **out);
bool in_documents(zval *v, documentv *out, const char *what);
/* C 문서를 PHP Document 객체로 바꾼다. */
void out_document(const document *d, zval *out);

/* ------------------------------------------------------------- exceptions */

/* PHP 예외를 던진다. 호출한 쪽은 false를 돌려 연산을 멈춘다. */
bool dbs_throw(zend_class_entry *ce, str message);
#define dbs_failed() (EG(exception) != NULL)

#endif
