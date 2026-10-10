/*
 * 연결의 database를 중간 model로 읽는다(PHP client CatalogRows, CheckDecoder, CatalogTriggers, MysqlCatalog,
 * PostgresCatalog, SqliteCatalog, docs/dialects.md "Introspection"). PDO는 그 객체의 메서드를 Zend API로 불러 쓰므로
 * 하위 class가 고친 메서드와 PDOException의 뜻이 PHP client와 같다.
 */
#include "dbspec.h"
#include "ext/pdo/php_pdo_driver.h"
#include "ext/spl/spl_exceptions.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"

/* ------------------------------------------------------------- PDO calls */

bool pdo_call(zval *obj, const char *name, zval *ret, uint32_t argc, zval *a1, zval *a2)
{
    ZVAL_UNDEF(ret);
    zend_call_method(Z_OBJ_P(obj), Z_OBJCE_P(obj), NULL, name, strlen(name), ret, argc, a1, a2);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(ret);
        ZVAL_UNDEF(ret);
        return false;
    }
    return true;
}

bool pending_pdo_exception(void)
{
    return EG(exception) != NULL && instanceof_function(EG(exception)->ce, php_pdo_get_exception());
}

/* 지금 던져진 예외를 꺼내 그 소유권을 돌려준다. */
zend_object *take_exception(void)
{
    zend_object *e = EG(exception);
    GC_ADDREF(e);
    zend_clear_exception();
    return e;
}

void throw_with_previous(zend_class_entry *ce, str message, zend_object *previous)
{
    zval ex, m;
    object_init_ex(&ex, ce);
    ZVAL_STR(&m, str_zend(message));
    zend_update_property_ex(zend_ce_exception, Z_OBJ(ex), ZSTR_KNOWN(ZEND_STR_MESSAGE), &m);
    zval_ptr_dtor(&m);
    if (previous != NULL) {
        zval p;
        ZVAL_OBJ(&p, previous);
        zend_update_property_ex(zend_ce_exception, Z_OBJ(ex), ZSTR_KNOWN(ZEND_STR_PREVIOUS), &p);
    }
    zend_throw_exception_object(&ex);
}

str exception_message(zend_object *e)
{
    zval rv;
    zval *m = zend_read_property_ex(instanceof_function(e->ce, zend_ce_error) ? zend_ce_error : zend_ce_exception, e,
        ZSTR_KNOWN(ZEND_STR_MESSAGE), true, &rv);
    zend_string *s = zval_get_string(m);
    str out = str_z(s);
    zend_string_release(s);
    return out;
}

/* 'Catalog query failed: SQLSTATE[<0>] <2>\n<query>' */
static str failure_message(str query, zval *info)
{
    str state = SL(""), text = SL("");
    if (Z_TYPE_P(info) == IS_ARRAY) {
        zval *s = zend_hash_index_find(Z_ARRVAL_P(info), 0), *t = zend_hash_index_find(Z_ARRVAL_P(info), 2);
        if (s != NULL && Z_TYPE_P(s) != IS_NULL) {
            zend_string *z = zval_get_string(s);
            state = str_z(z);
            zend_string_release(z);
        }
        if (t != NULL && Z_TYPE_P(t) != IS_NULL) {
            zend_string *z = zval_get_string(t);
            text = str_z(z);
            zend_string_release(z);
        }
    }
    return fmt("Catalog query failed: SQLSTATE[%S] %S\n%S", state, text, query);
}

/*
 * query의 모든 row를 위치 순 값으로 rows에 둔다. connection의 error mode와 무관하게 실패는 RuntimeException이다.
 * PDOException 밖의 예외(PDO 하위 class가 던진 것)는 그대로 지나간다.
 */
bool catalog_read(zval *pdo, str query, zval *rows)
{
    ZVAL_EMPTY_ARRAY(rows);
    zval q, mode, stmt;
    ZVAL_STR(&q, str_zend(query));
    ZVAL_LONG(&mode, 3 /* PDO::FETCH_NUM */);
    zend_object *failure = NULL;
    bool runtime = false;
    str runtime_message = SNULL;
    bool ok = pdo_call(pdo, "query", &stmt, 2, &q, &mode);
    zval_ptr_dtor(&q);
    if (!ok) {
        if (!pending_pdo_exception()) {
            return false;
        }
        failure = take_exception();
    } else if (Z_TYPE(stmt) == IS_FALSE) {
        zval info;
        if (!pdo_call(pdo, "errorInfo", &info, 0, NULL, NULL)) {
            if (!pending_pdo_exception()) {
                return false;
            }
            failure = take_exception();
        } else {
            runtime = true;
            runtime_message = failure_message(query, &info);
            zval_ptr_dtor(&info);
        }
    } else {
        zval fetched;
        if (!pdo_call(&stmt, "fetchAll", &fetched, 0, NULL, NULL)) {
            if (!pending_pdo_exception()) {
                zval_ptr_dtor(&stmt);
                return false;
            }
            failure = take_exception();
        } else {
            zval_ptr_dtor(rows);
            ZVAL_COPY_VALUE(rows, &fetched);
            zval code;
            if (!pdo_call(&stmt, "errorCode", &code, 0, NULL, NULL)) {
                if (!pending_pdo_exception()) {
                    zval_ptr_dtor(&stmt);
                    return false;
                }
                failure = take_exception();
            } else {
                bool clean = Z_TYPE(code) == IS_STRING && zend_string_equals_literal(Z_STR(code), "00000");
                zval_ptr_dtor(&code);
                if (!clean) {
                    zval info;
                    if (!pdo_call(&stmt, "errorInfo", &info, 0, NULL, NULL)) {
                        if (!pending_pdo_exception()) {
                            zval_ptr_dtor(&stmt);
                            return false;
                        }
                        failure = take_exception();
                    } else {
                        runtime = true;
                        runtime_message = failure_message(query, &info);
                        zval_ptr_dtor(&info);
                    }
                }
            }
        }
        zval_ptr_dtor(&stmt);
    }
    if (failure != NULL) {
        throw_with_previous(spl_ce_RuntimeException, fmt("Catalog query failed: %S\n%S", exception_message(failure), query), failure);
        OBJ_RELEASE(failure);
        return false;
    }
    if (runtime) {
        dbs_throw(spl_ce_RuntimeException, runtime_message);
        return false;
    }
    return true;
}

static str first_line(str query)
{
    ssize_t nl = str_find(query, "\n", 0);
    return nl < 0 ? query : str_sub(query, 0, (size_t)nl);
}

/* get_debug_type */
str debug_type(zval *v)
{
    switch (Z_TYPE_P(v)) {
        case IS_NULL: return SL("null");
        case IS_FALSE:
        case IS_TRUE: return SL("bool");
        case IS_LONG: return SL("int");
        case IS_DOUBLE: return SL("float");
        case IS_STRING: return SL("string");
        case IS_ARRAY: return SL("array");
        case IS_OBJECT: return str_z(Z_OBJCE_P(v)->name);
        default: return SL("resource");
    }
}

static zval *row_value(zval *row, zend_long i)
{
    zval *v = Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), (zend_ulong)i) : NULL;
    if (v != NULL) {
        ZVAL_DEREF(v);
    }
    return v;
}

bool row_text(zval *row, zend_long i, str query, str *out)
{
    zval *v = row_value(row, i);
    if (v == NULL || Z_TYPE_P(v) != IS_STRING) {
        zval none;
        ZVAL_NULL(&none);
        return dbs_throw(spl_ce_UnexpectedValueException, fmt("Catalog value %d is %S, not a string, in %S", i, debug_type(v != NULL ? v : &none), first_line(query)));
    }
    *out = str_z(Z_STR_P(v));
    return true;
}

bool row_nullable_text(zval *row, zend_long i, str query, bool *null, str *out)
{
    zval *v = row_value(row, i);
    *null = v == NULL || Z_TYPE_P(v) == IS_NULL;
    if (*null) {
        *out = SNULL;
        return true;
    }
    return row_text(row, i, query, out);
}

static bool integer_text(str s)
{
    size_t i = s.n > 0 && s.s[0] == '-' ? 1 : 0;
    if (i >= s.n) {
        return false;
    }
    for (; i < s.n; i++) {
        if (s.s[i] < '0' || s.s[i] > '9') {
            return false;
        }
    }
    return true;
}

bool value_integer(zval *v, zend_long i, str query, zend_long *out)
{
    if (v != NULL && Z_TYPE_P(v) == IS_LONG) {
        *out = Z_LVAL_P(v);
        return true;
    }
    if (v != NULL && Z_TYPE_P(v) == IS_STRING && integer_text(str_z(Z_STR_P(v)))) {
        /* (int) "...": 범위를 넘는 수는 PHP처럼 끝에서 멈춘다. */
        *out = ZEND_STRTOL(Z_STRVAL_P(v), NULL, 10);
        return true;
    }
    zval none;
    ZVAL_NULL(&none);
    return dbs_throw(spl_ce_UnexpectedValueException, fmt("Catalog value %d is %S, not an integer, in %S", i, debug_type(v != NULL ? v : &none), first_line(query)));
}

bool row_integer(zval *row, zend_long i, str query, zend_long *out)
{
    return value_integer(row_value(row, i), i, query, out);
}

/* var_export($value, true) */
static str exported(zval *v)
{
    zval fn, args[2], ret;
    ZVAL_STRING(&fn, "var_export");
    ZVAL_COPY(&args[0], v);
    ZVAL_TRUE(&args[1]);
    str out = SL("");
    if (call_user_function(NULL, NULL, &fn, &ret, 2, args) == SUCCESS && Z_TYPE(ret) == IS_STRING) {
        out = str_z(Z_STR(ret));
    }
    zval_ptr_dtor(&ret);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&fn);
    return out;
}

bool value_flag(zval *v, zend_long i, str query, bool *out)
{
    if (v != NULL && (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE)) {
        *out = Z_TYPE_P(v) == IS_TRUE;
        return true;
    }
    if (v != NULL && ((Z_TYPE_P(v) == IS_LONG && Z_LVAL_P(v) == 0) || (Z_TYPE_P(v) == IS_STRING && zend_string_equals_literal(Z_STR_P(v), "0")))) {
        *out = false;
        return true;
    }
    if (v != NULL && ((Z_TYPE_P(v) == IS_LONG && Z_LVAL_P(v) == 1) || (Z_TYPE_P(v) == IS_STRING && zend_string_equals_literal(Z_STR_P(v), "1")))) {
        *out = true;
        return true;
    }
    zval none;
    ZVAL_NULL(&none);
    return dbs_throw(spl_ce_UnexpectedValueException, fmt("Catalog value %d is %S, not a boolean, in %S", i, exported(v != NULL ? v : &none), first_line(query)));
}

static bool row_flag(zval *row, zend_long i, str query, bool *out)
{
    return value_flag(row_value(row, i), i, query, out);
}

#define TRY(x) do { if (!(x)) return NULL; } while (0)
#define EACH_ROW(rows, row) ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row)

static ctype *simple_type(const char *name)
{
    return ctype_new(str_c(name), NULL, 0);
}

static ctype *one_param(const char *name, zend_long p)
{
    return ctype_new(str_c(name), &p, 1);
}

static zend_long parse_long(str digits)
{
    return ZEND_STRTOL(str_of(digits.s, digits.n).s, NULL, 10);
}

static bool all_digits(str s)
{
    return str_digits(s);
}

/* `^-?\d+(\.\d+)?$` */
static bool number_default(str s)
{
    size_t i = s.n > 0 && s.s[0] == '-' ? 1 : 0;
    size_t start = i;
    while (i < s.n && s.s[i] >= '0' && s.s[i] <= '9') i++;
    if (i == start) return false;
    if (i == s.n) return true;
    if (s.s[i] != '.') return false;
    start = ++i;
    while (i < s.n && s.s[i] >= '0' && s.s[i] <= '9') i++;
    return i > start && i == s.n;
}

/* PHP strcasecmp(...) === 0: ASCII 대소문자만 무시한다. */
static bool ascii_ieq(const char *a, const char *b, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        char x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
        if (y >= 'A' && y <= 'Z') y = (char)(y - 'A' + 'a');
        if (x != y) return false;
    }
    return true;
}

/* ---------------------------------------------------------- check decoder */

enum { T_IDENT, T_WORD, T_NUMBER, T_STRING, T_OP, T_PUNCT };

typedef struct {
    int kind;
    str text;
} ctoken;

typedef VEC(ctoken) ctokens;

/* operand: kind column|number|string|bool. predicate: op and|or|compare|in|null */
typedef struct cnode {
    bool predicate;
    str kind;          /* operand의 kind */
    str text;          /* operand의 text */
    str op;            /* predicate의 op */
    struct cnode *left, *right;
    str operator_;
    VEC(struct cnode *) list;
    bool negated;
} cnode;

typedef struct {
    dialect d;
    smap columns;   /* column => ctype* */
    ctokens tokens;
    size_t i;
    bool failed;
    str failure;
} cdecoder;

static void cfail(cdecoder *c, str message)
{
    if (!c->failed) {
        c->failed = true;
        c->failure = message;
    }
}

static str unescape_mysql_clause(str text)
{
    sbuf b = {0};
    for (size_t i = 0; i < text.n; i++) {
        if (text.s[i] == '\\' && i + 1 < text.n && (text.s[i + 1] == '\\' || text.s[i + 1] == '\'')) {
            sb_ch(&b, text.s[i + 1]);
            i++;
            continue;
        }
        sb_ch(&b, text.s[i]);
    }
    return sb_str(&b);
}

static bool cdigit(char c) { return c >= '0' && c <= '9'; }
static bool calpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

/* text 앞의 문자열 literal을 읽어 값과 길이를 돌려준다. PostgreSQL과 SQLite는 ''만 escape이고 MySQL은 backslash도 쓴다. */
static bool sql_string(cdecoder *c, str text, str *value, size_t *length)
{
    sbuf out = {0};
    size_t n = text.n;
    for (size_t i = 1; i < n; i++) {
        char ch = text.s[i];
        if (ch == '\'' && i + 1 < n && text.s[i + 1] == '\'') {
            sb_ch(&out, '\'');
            i++;
        } else if (ch == '\'') {
            *value = sb_str(&out);
            *length = i + 1;
            return true;
        } else if (ch == '\\' && c->d == D_MYSQL && i + 1 < n) {
            i++;
            switch (text.s[i]) {
                case '0': sb_ch(&out, '\0'); break;
                case 'b': sb_ch(&out, '\x08'); break;
                case 'n': sb_ch(&out, '\n'); break;
                case 'r': sb_ch(&out, '\r'); break;
                case 't': sb_ch(&out, '\t'); break;
                case 'Z': sb_ch(&out, '\x1a'); break;
                default: sb_ch(&out, text.s[i]); break;
            }
        } else {
            sb_ch(&out, ch);
        }
    }
    cfail(c, SL("unclosed string literal"));
    return false;
}

static bool ctokenize(cdecoder *c, str text)
{
    size_t n = text.n, i = 0;
    while (i < n) {
        char ch = text.s[i];
        if (ch == ' ') {
            i++;
        } else if (ch == '`' || ch == '"') {
            ssize_t j = -1;
            for (size_t k = i + 1; k < n; k++) {
                if (text.s[k] == ch) {
                    j = (ssize_t)k;
                    break;
                }
            }
            if (j < 0) {
                cfail(c, SL("unclosed identifier"));
                return false;
            }
            PUSH(c->tokens, ((ctoken){T_IDENT, str_sub(text, i + 1, (size_t)j - i - 1)}));
            i = (size_t)j + 1;
        } else if (ch == '\'') {
            str value;
            size_t length;
            if (!sql_string(c, str_sub(text, i, n - i), &value, &length)) {
                return false;
            }
            PUSH(c->tokens, ((ctoken){T_STRING, value}));
            i += length;
        } else if (cdigit(ch)) {
            size_t j = i;
            while (j < n && (cdigit(text.s[j]) || text.s[j] == '.')) {
                j++;
            }
            PUSH(c->tokens, ((ctoken){T_NUMBER, str_sub(text, i, j - i)}));
            i = j;
        } else if (ch == '_' || calpha(ch)) {
            size_t j = i;
            while (j < n && (text.s[j] == '_' || calpha(text.s[j]) || cdigit(text.s[j]))) {
                j++;
            }
            str word = str_sub(text, i, j - i);
            /* MySQL 문자열 앞의 character set introducer는 값이 아니다. */
            if (c->d == D_MYSQL && str_starts(word, "_") && j < n && text.s[j] == '\'') {
                i = j;
                continue;
            }
            PUSH(c->tokens, ((ctoken){T_WORD, word}));
            i = j;
        } else if (i + 1 < n && ((ch == ':' && text.s[i + 1] == ':') || (ch == '<' && text.s[i + 1] == '>') || (ch == '<' && text.s[i + 1] == '=') || (ch == '>' && text.s[i + 1] == '='))) {
            PUSH(c->tokens, ((ctoken){T_OP, str_sub(text, i, 2)}));
            i += 2;
        } else if (ch == '=' || ch == '<' || ch == '>' || ch == '-') {
            PUSH(c->tokens, ((ctoken){T_OP, str_sub(text, i, 1)}));
            i++;
        } else if (ch == '(' || ch == ')' || ch == ',' || ch == '[' || ch == ']') {
            PUSH(c->tokens, ((ctoken){T_PUNCT, str_sub(text, i, 1)}));
            i++;
        } else {
            cfail(c, fmt("unexpected character \"%S\"", str_sub(text, i, 1)));
            return false;
        }
    }
    return true;
}

static ctoken cpeek(cdecoder *c)
{
    if (c->i < c->tokens.n) {
        return c->tokens.v[c->i];
    }
    return (ctoken){-1, SL("")};
}

static bool cword(cdecoder *c, const char *text)
{
    ctoken t = cpeek(c);
    if (t.kind == T_WORD && t.text.n == strlen(text) && ascii_ieq(t.text.s, text, t.text.n)) {
        c->i++;
        return true;
    }
    return false;
}

static bool cpunct(cdecoder *c, const char *text)
{
    ctoken t = cpeek(c);
    if (t.kind == T_PUNCT && str_eqc(t.text, text)) {
        c->i++;
        return true;
    }
    return false;
}

static void cexpect(cdecoder *c, const char *text)
{
    if (!cpunct(c, text)) {
        cfail(c, fmt("expected \"%s\" at token %u", text, c->i));
    }
}

static cnode *operand_node(const char *kind, str text)
{
    cnode *n = dbs_alloc(sizeof *n);
    n->kind = str_c(kind);
    n->text = text;
    return n;
}

static cnode *cexpression(cdecoder *c);
static cnode *cterm(cdecoder *c);

static cnode *coperand(cdecoder *c)
{
    ctoken t = cpeek(c);
    if (t.kind == T_IDENT) {
        c->i++;
        return operand_node("column", t.text);
    }
    if (t.kind == T_NUMBER || t.kind == T_STRING) {
        c->i++;
        return operand_node(t.kind == T_NUMBER ? "number" : "string", t.text);
    }
    if (t.kind == T_OP && str_eqc(t.text, "-")) {
        c->i++;
        bool parenthesized = cpunct(c, "(");
        ctoken next = cpeek(c);
        if (next.kind != T_NUMBER) {
            cfail(c, parenthesized ? SL("expected a number after -(") : SL("expected a number after -"));
            return operand_node("number", SL("0"));
        }
        c->i++;
        if (parenthesized) {
            cexpect(c, ")");
        }
        return operand_node("number", fmt("-%S", next.text));
    }
    if (t.kind == T_WORD && t.text.n == 4 && ascii_ieq(t.text.s, "true", 4)) {
        c->i++;
        return operand_node("bool", SL("true"));
    }
    if (t.kind == T_WORD && t.text.n == 5 && ascii_ieq(t.text.s, "false", 5)) {
        c->i++;
        return operand_node("bool", SL("false"));
    }
    if (t.kind == T_WORD) {
        c->i++;
        return operand_node("column", t.text);
    }
    cfail(c, fmt("unexpected \"%S\"", t.text));
    c->i = c->tokens.n;
    return operand_node("column", SL(""));
}

/* `::` 뒤의 type 이름을 읽는다: 단어들과 (n), []. */
static str cast_type(cdecoder *c)
{
    strs words = {0};
    for (;;) {
        ctoken t = cpeek(c);
        str low = str_lower(t.text);
        if (t.kind == T_WORD && !str_eqc(low, "and") && !str_eqc(low, "or") && !str_eqc(low, "is") && !str_eqc(low, "not") && !str_eqc(low, "in")) {
            PUSH(words, t.text);
            c->i++;
        } else if (t.kind == T_PUNCT && str_eqc(t.text, "[") && c->i + 1 < c->tokens.n && str_eqc(c->tokens.v[c->i + 1].text, "]")) {
            c->i += 2;
        } else {
            return strs_join(&words, " ");
        }
    }
}

static cnode *cterm(cdecoder *c)
{
    cnode *node;
    if (cpunct(c, "(")) {
        node = cexpression(c);
        cexpect(c, ")");
    } else {
        node = coperand(c);
    }
    while (!c->failed) {
        ctoken t = cpeek(c);
        if (!(t.kind == T_OP && str_eqc(t.text, "::"))) {
            break;
        }
        c->i++;
        str type = cast_type(c);
        if (node->predicate) {
            cfail(c, SL("a cast of a predicate"));
            break;
        }
        if (str_eqc(node->kind, "string") && (str_eqc(type, "smallint") || str_eqc(type, "integer") || str_eqc(type, "bigint")
            || str_eqc(type, "numeric") || str_eqc(type, "double precision") || str_eqc(type, "real"))) {
            node->kind = SL("number");
        }
    }
    return node;
}

static cnode *literal_list(cdecoder *c, bool array)
{
    cnode *holder = dbs_alloc(sizeof *holder);
    for (;;) {
        cnode *n = cterm(c);
        if (c->failed) {
            return holder;
        }
        if (n->predicate || str_eqc(n->kind, "column")) {
            cfail(c, array ? SL("an array holds literals only") : SL("an in list holds literals only"));
            return holder;
        }
        PUSH(holder->list, n);
        if (cpunct(c, array ? "]" : ")")) {
            return holder;
        }
        cexpect(c, ",");
        if (c->failed) {
            return holder;
        }
    }
}

/* PostgreSQL의 ANY나 ALL 뒤의 (ARRAY[...]) 또는 ((ARRAY[...])::type[])를 읽는다. */
static cnode *array_literals(cdecoder *c)
{
    cexpect(c, "(");
    bool wrapped = cpunct(c, "(");
    if (!cword(c, "array")) {
        cfail(c, SL("expected ARRAY"));
        return dbs_alloc(sizeof(cnode));
    }
    cexpect(c, "[");
    cnode *holder = literal_list(c, true);
    if (c->failed) {
        return holder;
    }
    if (wrapped) {
        cexpect(c, ")");
        if (str_eqc(cpeek(c).text, "::")) {
            c->i++;
            cast_type(c);
        }
    }
    cexpect(c, ")");
    return holder;
}

static cnode *cpredicate(cdecoder *c)
{
    cnode *left = cterm(c);
    if (c->failed || left->predicate) {
        return left;
    }
    ctoken t = cpeek(c);
    if (t.kind == T_OP && (str_eqc(t.text, "=") || str_eqc(t.text, "<>") || str_eqc(t.text, "<") || str_eqc(t.text, "<=") || str_eqc(t.text, ">") || str_eqc(t.text, ">="))) {
        c->i++;
        if (cword(c, "any") || cword(c, "all")) {
            cnode *list = array_literals(c);
            if (c->failed) {
                return left;
            }
            if (!str_eqc(t.text, "=") && !str_eqc(t.text, "<>")) {
                cfail(c, fmt("%S with ANY or ALL", t.text));
                return left;
            }
            cnode *n = dbs_alloc(sizeof *n);
            n->predicate = true;
            n->op = SL("in");
            n->left = left;
            n->list = list->list;
            n->negated = str_eqc(t.text, "<>");
            return n;
        }
        cnode *right = cterm(c);
        if (c->failed) {
            return left;
        }
        if (right->predicate) {
            cfail(c, SL("a comparison with a predicate"));
            return left;
        }
        cnode *n = dbs_alloc(sizeof *n);
        n->predicate = true;
        n->op = SL("compare");
        n->left = left;
        n->right = right;
        n->operator_ = t.text;
        return n;
    }
    if (cword(c, "is")) {
        bool negated = cword(c, "not");
        if (!cword(c, "null")) {
            cfail(c, SL("expected null after is"));
            return left;
        }
        cnode *n = dbs_alloc(sizeof *n);
        n->predicate = true;
        n->op = SL("null");
        n->left = left;
        n->negated = negated;
        return n;
    }
    if (cword(c, "not")) {
        if (!cword(c, "in")) {
            cfail(c, SL("not outside not in"));
            return left;
        }
        cexpect(c, "(");
        cnode *list = c->failed ? left : literal_list(c, false);
        cnode *n = dbs_alloc(sizeof *n);
        n->predicate = true;
        n->op = SL("in");
        n->left = left;
        n->list = list->list;
        n->negated = true;
        return n;
    }
    if (cword(c, "in")) {
        cexpect(c, "(");
        cnode *list = c->failed ? left : literal_list(c, false);
        cnode *n = dbs_alloc(sizeof *n);
        n->predicate = true;
        n->op = SL("in");
        n->left = left;
        n->list = list->list;
        return n;
    }
    return left;
}

static cnode *cconjunction(cdecoder *c)
{
    cnode *left = cpredicate(c);
    while (!c->failed && cword(c, "and")) {
        cnode *n = dbs_alloc(sizeof *n);
        n->predicate = true;
        n->op = SL("and");
        n->left = left;
        n->right = cpredicate(c);
        left = n;
    }
    return left;
}

static cnode *cexpression(cdecoder *c)
{
    cnode *left = cconjunction(c);
    while (!c->failed && cword(c, "or")) {
        cnode *n = dbs_alloc(sizeof *n);
        n->predicate = true;
        n->op = SL("or");
        n->left = left;
        n->right = cconjunction(c);
        left = n;
    }
    return left;
}

static ctype *type_of(cdecoder *c, const cnode *a, const cnode *b)
{
    const cnode *ops[2] = {a, b};
    for (int i = 0; i < 2; i++) {
        if (ops[i] != NULL && str_eqc(ops[i]->kind, "column")) {
            return smap_get(&c->columns, ops[i]->text);
        }
    }
    return NULL;
}

/* operand를 dbspec 표기로 쓴다. bool column의 1과 0은 true와 false, SQLite decimal의 정수는 scale을 나눈 값이다. */
static str operand_text(cdecoder *c, const cnode *o, const ctype *type)
{
    if (str_eqc(o->kind, "column")) {
        if (!smap_has(&c->columns, o->text)) {
            cfail(c, fmt("unknown column %S", o->text));
        }
        return o->text;
    }
    if (str_eqc(o->kind, "string")) {
        return literal_quote(o->text);
    }
    if (str_eqc(o->kind, "bool")) {
        return o->text;
    }
    if (type != NULL && str_eqc(type->name, "bool") && str_eqc(o->text, "1")) {
        return SL("true");
    }
    if (type != NULL && str_eqc(type->name, "bool") && str_eqc(o->text, "0")) {
        return SL("false");
    }
    if (type != NULL && str_eqc(type->name, "decimal") && c->d == D_SQLITE) {
        return catalog_unscaled_decimal(o->text, type->p[1]);
    }
    return o->text;
}

static str cwrite(cdecoder *c, const cnode *p);

static str cside(cdecoder *c, const cnode *n)
{
    if (!n->predicate) {
        cfail(c, SL("an operand alone is not a predicate"));
        return SL("");
    }
    return cwrite(c, n);
}

/* predicate를 dbspec text로 쓴다. 괄호는 필요한 곳보다 많아도 되며 canonical form은 parse가 정한다. */
static str cwrite(cdecoder *c, const cnode *p)
{
    if (str_eqc(p->op, "and") || str_eqc(p->op, "or")) {
        str l = cside(c, p->left), r = cside(c, p->right);
        return fmt("(%S %S %S)", l, p->op, r);
    }
    if (str_eqc(p->op, "compare")) {
        const ctype *type = type_of(c, p->left, p->right);
        str l = operand_text(c, p->left, type);
        str r = operand_text(c, p->right, type);
        return fmt("%S %S %S", l, p->operator_, r);
    }
    if (str_eqc(p->op, "in")) {
        const ctype *type = type_of(c, p->left, NULL);
        strs items = {0};
        for (size_t i = 0; i < p->list.n; i++) {
            PUSH(items, operand_text(c, p->list.v[i], type));
        }
        str l = operand_text(c, p->left, type);
        return fmt("%S%s%S)", l, p->negated ? " not in (" : " in (", strs_join(&items, ", "));
    }
    if (str_eqc(p->op, "null")) {
        return fmt("%S%s", operand_text(c, p->left, NULL), p->negated ? " is not null" : " is null");
    }
    cfail(c, fmt("unknown predicate %S", p->op));
    return SL("");
}

/* check 식을 dbspec predicate text로 읽는다. 읽을 수 없으면 false와 이유다. */
bool check_decode(dialect d, str text, const smap *columns, str *out, str *failure)
{
    cdecoder *c = dbs_alloc(sizeof *c);
    c->d = d;
    SMAP_EACH(columns, i) {
        smap_set(&c->columns, columns->e[i].key, columns->e[i].val);
    }
    if (d == D_MYSQL) {
        text = unescape_mysql_clause(text);
    }
    if (d == D_POSTGRES) {
        if (!str_starts(text, "CHECK ")) {
            *failure = fmt("constraint definition \"%S\" does not start with CHECK", text);
            return false;
        }
        text = str_sub(text, 6, text.n - 6);
    }
    if (ctokenize(c, text)) {
        cnode *node = cexpression(c);
        if (!c->failed && c->i != c->tokens.n) {
            cfail(c, fmt("unexpected \"%S\"", c->tokens.v[c->i].text));
        }
        if (!c->failed && !node->predicate) {
            cfail(c, SL("an operand alone is not a predicate"));
        }
        if (!c->failed) {
            str written = cwrite(c, node);
            if (!c->failed) {
                *out = written;
                return true;
            }
        }
    }
    *failure = c->failure;
    return false;
}

/* --------------------------------------------------------------- triggers */

typedef struct {
    str name;
    strs statements;
} itrigger;

typedef VEC(itrigger) itriggerv;

/* renderer statement 목록에서 trigger 이름을 순서대로 꺼낸다. */
static strs trigger_order(const strs *statements)
{
    strs names = {0};
    for (size_t i = 0; i < statements->n; i++) {
        str s = statements->v[i];
        if (!str_starts(s, "CREATE TRIGGER ")) {
            continue;
        }
        str rest = str_sub(s, 15, s.n - 15);
        ssize_t end = -1;
        for (size_t k = 1; k < rest.n; k++) {
            if (rest.s[k] == rest.s[0]) {
                end = (ssize_t)k;
                break;
            }
        }
        /* substr($rest, 1, $end - 1): 닫는 따옴표가 없으면 끝의 한 byte를 뺀다. */
        PUSH(names, end < 0 ? str_sub(rest, 1, rest.n >= 2 ? rest.n - 2 : 0) : str_sub(rest, 1, (size_t)end - 1));
    }
    return names;
}

/* trigger statement에서 본문을 꺼낸다: MySQL은 FOR EACH ROW 뒤, PostgreSQL은 function의 BEGIN 뒤, SQLite는 BEGIN 뒤다. */
static str trigger_body(const strs *statements)
{
    const char *markers[] = {"$$BEGIN ", "FOR EACH ROW BEGIN ", "FOR EACH ROW "};
    for (size_t i = 0; statements != NULL && i < statements->n; i++) {
        for (int m = 0; m < 3; m++) {
            ssize_t at = str_find(statements->v[i], markers[m], 0);
            if (at >= 0) {
                size_t from = (size_t)at + strlen(markers[m]);
                return str_sub(statements->v[i], from, statements->v[i].n - from);
            }
        }
    }
    return SL("");
}

static bool quote_char(char c)
{
    return c == '`' || c == '"';
}

static bool audit_name_char(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
}

/* `[`"]([a-z0-9_]+)[`"]` 를 i에서 읽는다. */
static bool quoted_name(str s, size_t *i, str *out)
{
    size_t p = *i;
    if (p >= s.n || !quote_char(s.s[p])) {
        return false;
    }
    size_t q = p + 1;
    while (q < s.n && audit_name_char(s.s[q])) {
        q++;
    }
    if (q == p + 1 || q >= s.n || !quote_char(s.s[q])) {
        return false;
    }
    *out = str_sub(s, p + 1, q - p - 1);
    *i = q + 1;
    return true;
}

static bool slit(str s, size_t *i, const char *text)
{
    size_t n = strlen(text);
    if (*i + n > s.n || memcmp(s.s + *i, text, n) != 0) {
        return false;
    }
    *i += n;
    return true;
}

/* AUDIT_INSERT: `^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES ` */
static bool audit_insert(str body, str *history, str *columns)
{
    size_t i = 0;
    if (!slit(body, &i, "INSERT INTO ") || !quoted_name(body, &i, history) || !slit(body, &i, " (")) {
        return false;
    }
    size_t start = i;
    while (i < body.n && body.s[i] != ')') {
        i++;
    }
    if (i >= body.n) {
        return false;
    }
    *columns = str_sub(body, start, i - start);
    return slit(body, &i, ") VALUES ");
}

/* AUDIT_UPDATE: `VALUES \('update', OLD\.[`"]([a-z0-9_]+)[`"],` 의 첫 자리 */
static bool audit_update(str body, str *column)
{
    const char *prefix = "VALUES ('update', OLD.";
    for (ssize_t at = str_find(body, prefix, 0); at >= 0; at = str_find(body, prefix, (size_t)at + 1)) {
        size_t i = (size_t)at + strlen(prefix);
        if (quoted_name(body, &i, column) && i < body.n && body.s[i] == ',') {
            return true;
        }
    }
    return false;
}

/* audit insert trigger의 column 목록과 update trigger의 audit column으로 audit setting을 만든다. */
static setting *audit_setting(const itable *t, str history, const strs *quoted, str column)
{
    strs names = {0};
    for (size_t i = 0; i < quoted->n; i++) {
        str q = quoted->v[i];
        size_t k = 0;
        str name;
        if (!quoted_name(q, &k, &name) || k != q.n) {
            return NULL;
        }
        PUSH(names, name);
    }
    strs recorded = {0};
    for (size_t i = 2; i < names.n; i++) {
        PUSH(recorded, names.v[i]);
    }
    if (recorded.n == 0 || !strs_has(&recorded, column)) {
        return NULL;
    }
    str references = SL("");
    for (size_t i = 0; i < t->fks.n; i++) {
        if (t->fks.v[i].columns.n == 1 && str_eq(t->fks.v[i].columns.v[0], column)) {
            if (references.n > 0) {
                return NULL;
            }
            references = t->fks.v[i].table;
        }
    }
    if (references.n == 0) {
        return NULL;
    }
    strs *excluded = dbs_alloc(sizeof *excluded);
    for (size_t i = 0; i < t->columns.n; i++) {
        if (!strs_has(&recorded, t->columns.v[i].name)) {
            PUSH(*excluded, t->columns.v[i].name);
        }
    }
    setting *s = dbs_alloc(sizeof *s);
    s->kind = SL("audit");
    PUSH(s->args, history);
    PUSH(s->args, column);
    PUSH(s->args, references);
    PUSH(s->args, names.v[0]);
    PUSH(s->args, names.v[1]);
    s->exclude = excluded->n == 0 ? NULL : excluded;
    return s;
}

/* trigger 집합이 같은 renderer 출력을 주는 setting의 줄, 없으면 NULL이다. */
static strs *trigger_setting(dialect d, const itable *t, itriggerv *list)
{
    smap names = {0};
    for (size_t i = 0; i < list->n; i++) {
        smap_set(&names, list->v[i].name, &list->v[i]);
    }
    table *model = table_new(t->name);
    for (size_t i = 0; i < t->columns.n; i++) {
        PUSH(model->columns, column_new(t->columns.v[i].name, t->columns.v[i].type, false, false, NULL));
    }
    settingv candidates = {0};
    if (list->n == 2) {
        setting *s = dbs_alloc(sizeof *s);
        s->kind = SL("immutable");
        PUSH(candidates, s);
    }
    itrigger *insert = smap_get(&names, fmt("%S$audit_insert", t->name));
    if (insert != NULL && list->n == 3) {
        itrigger *update = smap_get(&names, fmt("%S$audit_update", t->name));
        str history, columns, column;
        if (audit_insert(trigger_body(&insert->statements), &history, &columns) && audit_update(trigger_body(update != NULL ? &update->statements : NULL), &column)) {
            strs parts = {0};
            /* explode(', ', $m[2]) */
            size_t start = 0;
            for (;;) {
                ssize_t at = str_find(columns, ", ", start);
                if (at < 0) {
                    PUSH(parts, str_sub(columns, start, columns.n - start));
                    break;
                }
                PUSH(parts, str_sub(columns, start, (size_t)at - start));
                start = (size_t)at + 2;
            }
            setting *a = audit_setting(t, history, &parts, column);
            if (a != NULL) {
                PUSH(candidates, a);
            }
        }
    }
    renderer r = {0};
    r.d = d;
    for (size_t i = 0; i < candidates.n; i++) {
        setting *s = candidates.v[i];
        model->settings = dbs_alloc(sizeof(settings));
        PUSH(model->settings->list, s);
        strs want = r_triggers(&r, model);
        strs got = {0};
        strs order = trigger_order(&want);
        bool complete = true;
        for (size_t k = 0; k < order.n; k++) {
            itrigger *tr = smap_get(&names, order.v[k]);
            if (tr == NULL) {
                complete = false;
                break;
            }
            for (size_t m = 0; m < tr->statements.n; m++) {
                PUSH(got, tr->statements.v[m]);
            }
        }
        if (!complete) {
            got = (strs){0};
        }
        if (strs_eq(&got, &want)) {
            strs *line = dbs_alloc(sizeof *line);
            if (str_eqc(s->kind, "immutable")) {
                PUSH(*line, SL("immutable"));
            } else {
                PUSH(*line, setting_audit_line(s, "exclude", s->exclude));
            }
            return line;
        }
    }
    return NULL;
}

/* table마다 trigger 집합이 immutable이나 audit의 renderer 출력과 같으면 그 setting을 더하고, 아니면 모든 trigger를 보고한다. */
static void recognize_triggers(catalog *c, dialect d, smap *triggers)
{
    strs tables = {0};
    smap_keys_sorted(triggers, &tables);
    for (size_t i = 0; i < tables.n; i++) {
        itriggerv *list = smap_get(triggers, tables.v[i]);
        itable *t = catalog_table(c, tables.v[i]);
        if (t == NULL) {
            for (size_t k = 0; k < list->n; k++) {
                catalog_report(c, SL("trigger"), tables.v[i], list->v[k].name, SL("the table is not read"));
            }
            continue;
        }
        strs *lines = trigger_setting(d, t, list);
        if (lines == NULL) {
            for (size_t k = 0; k < list->n; k++) {
                catalog_report(c, SL("trigger"), tables.v[i], list->v[k].name, SL("the trigger is not the renderer output of immutable or audit"));
            }
            continue;
        }
        for (size_t k = 0; k < lines->n; k++) {
            PUSH(t->settings, lines->v[k]);
        }
    }
}

static void add_trigger(smap *triggers, str table, str name, strs statements)
{
    itriggerv *list = smap_get(triggers, table);
    if (list == NULL) {
        list = dbs_alloc(sizeof *list);
        smap_set(triggers, table, list);
    }
    PUSH(*list, ((itrigger){name, statements}));
}

/* ------------------------------------------------------------------ MySQL */

static const char MYSQL_TABLES[] = "SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES\n"
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME";
static const char MYSQL_COLUMNS[] = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,\n"
    "IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')\n"
    "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME, ORDINAL_POSITION";
static const char MYSQL_INDEXES[] = "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),\n"
    "SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS\n"
    "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX";
static const char MYSQL_FOREIGN_KEYS[] = "SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,\n"
    "rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc\n"
    "JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA\n"
    "AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME\n"
    "WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION";
static const char MYSQL_CHECK_CLAUSES[] = "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS\n"
    "WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME";
static const char MYSQL_CHECKS[] = "SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS\n"
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' ORDER BY TABLE_NAME, CONSTRAINT_NAME";
static const char MYSQL_TRIGGERS[] = "SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT\n"
    "FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME";
static const char MYSQL_ROUTINES[] = "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME";
static const char MYSQL_EVENTS[] = "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME";

#define Q(name) ((str){name, sizeof(name) - 1})

/* COLUMN_TYPE과 character set, collation을 dbspec type으로 읽는다. needs는 renderer CHECK이 있어야 그 type이 되는 catalog type이다. */
static ctype *mysql_type(str column_type, str charset, str collation, str *needs)
{
    *needs = SL("");
    static const char *const words[] = {"smallint", "int", "bigint", "tinyint(1)", "double", "longtext", "longblob", "date", "char(36)", "time", "datetime", NULL};
    bool text = str_eqc(charset, "utf8mb4") && str_eqc(collation, "utf8mb4_0900_bin");
    str word = SNULL, digits = SL("");
    bool matched = false;
    for (int k = 0; words[k] != NULL && !matched; k++) {
        size_t n = strlen(words[k]);
        if (column_type.n < n || memcmp(column_type.s, words[k], n) != 0) {
            continue;
        }
        str rest = str_sub(column_type, n, column_type.n - n);
        if (rest.n == 0) {
            matched = true;
        } else if (rest.n >= 3 && rest.s[0] == '(' && rest.s[rest.n - 1] == ')' && all_digits(str_sub(rest, 1, rest.n - 2))) {
            matched = true;
            digits = str_sub(rest, 1, rest.n - 2);
        }
        if (matched) {
            word = str_c(words[k]);
        }
    }
    if (!matched) {
        size_t i = 0;
        str a, b;
        if (slit(column_type, &i, "decimal(")) {
            size_t s = i;
            while (i < column_type.n && cdigit(column_type.s[i])) i++;
            a = str_sub(column_type, s, i - s);
            if (a.n > 0 && slit(column_type, &i, ",")) {
                s = i;
                while (i < column_type.n && cdigit(column_type.s[i])) i++;
                b = str_sub(column_type, s, i - s);
                if (b.n > 0 && slit(column_type, &i, ")") && i == column_type.n) {
                    if (charset.n != 0) {
                        return NULL;
                    }
                    zend_long p[2] = {parse_long(a), parse_long(b)};
                    return ctype_new(SL("decimal"), p, 2);
                }
            }
            return NULL;
        }
        i = 0;
        if (slit(column_type, &i, "varchar(")) {
            size_t s = i;
            while (i < column_type.n && cdigit(column_type.s[i])) i++;
            a = str_sub(column_type, s, i - s);
            if (a.n > 0 && slit(column_type, &i, ")") && i == column_type.n) {
                return text ? one_param("varchar", parse_long(a)) : NULL;
            }
        }
        return NULL;
    }
    zend_long precision = digits.n == 0 ? 0 : parse_long(digits);
    bool none = digits.n == 0;
    if (str_eqc(word, "smallint")) return none ? simple_type("i16") : NULL;
    if (str_eqc(word, "int")) return none ? simple_type("i32") : NULL;
    if (str_eqc(word, "bigint")) return none ? simple_type("i64") : NULL;
    if (str_eqc(word, "tinyint(1)")) {
        *needs = column_type;
        return simple_type("bool");
    }
    if (str_eqc(word, "double")) return none ? simple_type("f64") : NULL;
    if (str_eqc(word, "longtext")) return text ? simple_type("text") : NULL;
    if (str_eqc(word, "longblob")) return simple_type("bytes");
    if (str_eqc(word, "char(36)")) {
        *needs = column_type;
        return str_eqc(charset, "ascii") && str_eqc(collation, "ascii_bin") ? simple_type("uuid") : NULL;
    }
    if (str_eqc(word, "date")) return none ? simple_type("date") : NULL;
    if (str_eqc(word, "time")) {
        *needs = column_type;
        return one_param("time", precision);
    }
    return one_param("datetime", precision);
}

/* CHECK_CLAUSE가 0x80 이상의 byte를 가지면 true다. MySQL 8.4는 non-ASCII literal을 두 번 인코딩해 보여 준다. */
static bool has_non_ascii(str clause)
{
    for (size_t i = 0; i < clause.n; i++) {
        if ((unsigned char)clause.s[i] >= 0x80) {
            return true;
        }
    }
    return false;
}

/* 식 text의 `\` 와 `'` 를 escape한다. unescape_mysql_clause의 역이다. */
static str escape_mysql_clause(str text)
{
    char *out = dbs_alloc(text.n * 2 + 1);
    size_t n = 0;
    for (size_t i = 0; i < text.n; i++) {
        if (text.s[i] == '\\' || text.s[i] == '\'') {
            out[n++] = '\\';
        }
        out[n++] = text.s[i];
    }
    out[n] = '\0';
    return (str){out, n};
}

/* SHOW CREATE TABLE 문장에서 name인 CHECK의 본문을 CHECK_CLAUSE 형식으로 out에 쓴다.
 * 문자열 literal은 `\` 와 `'` 를 한 번 escape하므로 literal을 건너뛰고, 본문 끝은 CHECK (의 짝인 )다. */
static bool shown_check(str create, str name, str *out)
{
    ssize_t at = str_find(create, "CONSTRAINT `", 0);
    while (at >= 0) {
        size_t start = (size_t)at + sizeof("CONSTRAINT `") - 1;
        ssize_t close = str_find(create, "` CHECK (", start);
        if (close < 0) {
            return false;
        }
        size_t body = (size_t)close + sizeof("` CHECK (") - 1;
        if (str_eq(str_sub(create, start, (size_t)close - start), name)) {
            size_t depth = 1;
            for (size_t i = body; i < create.n; i++) {
                char c = create.s[i];
                if (c == '\'') {
                    for (i++; i < create.n && create.s[i] != '\''; i++) {
                        if (create.s[i] == '\\') {
                            i++;
                        }
                    }
                } else if (c == '(') {
                    depth++;
                } else if (c == ')' && --depth == 0) {
                    *out = escape_mysql_clause(str_sub(create, body, i - body));
                    return true;
                }
            }
            return false;
        }
        at = str_find(create, "CONSTRAINT `", start);
    }
    return false;
}

/* table의 SHOW CREATE TABLE 문장을 out에 읽는다. */
static bool show_create_table(zval *pdo, str table, str *out)
{
    zval rows, *row;
    str q = fmt("SHOW CREATE TABLE `%S`", str_replace(table, "`", "``"));
    bool ok = catalog_read(pdo, q, &rows);
    if (ok) {
        bool found = false;
        EACH_ROW(rows, row) {
            found = row_text(row, 1, q, out);
            ok = found;
            break;
        } ZEND_HASH_FOREACH_END();
        if (ok && !found) {
            ok = dbs_throw(spl_ce_RuntimeException, fmt("SHOW CREATE TABLE %S returned no row", table));
        }
    }
    zval_ptr_dtor(&rows);
    return ok;
}

/* CHECK_CLAUSE가 non-ASCII를 깨뜨린 check의 본문을 SHOW CREATE TABLE에서 out에 읽는다. table별로
 * SHOW CREATE TABLE을 한 번만 읽으며 creates에 모은다. */
static bool shown_clause(zval *pdo, str table, str name, smap *creates, str *out)
{
    str *create = smap_get(creates, table);
    if (create == NULL) {
        create = dbs_alloc(sizeof *create);
        if (!show_create_table(pdo, table, create)) {
            return false;
        }
        smap_set(creates, table, create);
    }
    if (!shown_check(*create, name, out)) {
        return dbs_throw(spl_ce_RuntimeException, fmt("check %S.%S has no CHECK in SHOW CREATE TABLE", table, name));
    }
    return true;
}

/* character set introducer와 time literal의 0 소수를 뺀 CHECK_CLAUSE다. */
static str without_introducers(str clause)
{
    sbuf b = {0};
    size_t i = 0;
    while (i < clause.n) {
        if (clause.s[i] == '_') {
            size_t j = i + 1;
            while (j < clause.n && ((clause.s[j] >= 'a' && clause.s[j] <= 'z') || cdigit(clause.s[j]))) {
                j++;
            }
            if (j > i + 1 && j + 1 < clause.n && clause.s[j] == '\\' && clause.s[j + 1] == '\'') {
                sb_c(&b, "\\'");
                i = j + 2;
                continue;
            }
        }
        sb_ch(&b, clause.s[i]);
        i++;
    }
    str first = sb_str(&b);
    sbuf c = {0};
    i = 0;
    while (i < first.n) {
        /* \'(\d\d:\d\d:\d\d)\.0+\' */
        if (i + 14 <= first.n && first.s[i] == '\\' && first.s[i + 1] == '\'') {
            size_t p = i + 2;
            str t = str_sub(first, p, 8);
            bool clock = t.n == 8 && cdigit(t.s[0]) && cdigit(t.s[1]) && t.s[2] == ':' && cdigit(t.s[3]) && cdigit(t.s[4]) && t.s[5] == ':'
                && cdigit(t.s[6]) && cdigit(t.s[7]);
            if (clock && p + 8 < first.n && first.s[p + 8] == '.') {
                size_t z = p + 9;
                while (z < first.n && first.s[z] == '0') {
                    z++;
                }
                if (z > p + 9 && z + 1 < first.n && first.s[z] == '\\' && first.s[z + 1] == '\'') {
                    sb_fmt(&c, "\\'%S\\'", t);
                    i = z + 2;
                    continue;
                }
            }
        }
        sb_ch(&c, first.s[i]);
        i++;
    }
    return sb_str(&c);
}

/* renderer CHECK이 CHECK_CLAUSE에 남는 형식 */
static str mysql_renderer_check(const icolumn *column)
{
    str c = fmt("`%S`", column->name);
    if (str_eqc(column->type->name, "bool")) return fmt("(%S in (0,1))", c);
    if (str_eqc(column->type->name, "uuid")) return fmt("regexp_like(%S,_utf8mb4\\'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$\\',_utf8mb4\\'c\\')", c);
    if (str_eqc(column->type->name, "time")) return fmt("((%S >= _utf8mb4\\'00:00:00\\') and (%S < _utf8mb4\\'24:00:00\\'))", c, c);
    return SL("");
}

static str mysql_default_literal(str value, const ctype *type)
{
    if (str_eqc(type->name, "bool") && (str_eqc(value, "1") || str_eqc(value, "0"))) {
        return str_eqc(value, "1") ? SL("true") : SL("false");
    }
    const char *numeric[] = {"i16", "i32", "i64", "decimal", "f64"};
    for (int i = 0; i < 5; i++) {
        if (str_eqc(type->name, numeric[i])) {
            return value;
        }
    }
    return literal_quote(value);
}

static bool mysql_indexes(zval *pdo, catalog *c)
{
    str q = Q(MYSQL_INDEXES);
    zval rows;
    if (!catalog_read(pdo, q, &rows)) {
        zval_ptr_dtor(&rows);
        return false;
    }
    typedef struct {
        str table, name, column, collation, kind;
        bool unique, part, expression;
    } irow;
    VEC(irow) list = {0};
    zval *row;
    bool ok = true;
    EACH_ROW(rows, row) {
        irow r;
        zend_long non_unique;
        if (!(row_text(row, 0, q, &r.table) && row_text(row, 1, q, &r.name) && row_integer(row, 2, q, &non_unique) && row_text(row, 3, q, &r.column)
            && row_text(row, 4, q, &r.collation) && row_flag(row, 5, q, &r.part) && row_flag(row, 6, q, &r.expression) && row_text(row, 7, q, &r.kind))) {
            ok = false;
            break;
        }
        r.unique = non_unique == 0;
        PUSH(list, r);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&rows);
    if (!ok) {
        return false;
    }
    for (size_t i = 0; i < list.n;) {
        size_t j = i;
        while (j < list.n && str_eq(list.v[j].table, list.v[i].table) && str_eq(list.v[j].name, list.v[i].name)) {
            j++;
        }
        size_t from = i;
        i = j;
        itable *t = catalog_table(c, list.v[from].table);
        if (t == NULL) {
            continue;
        }
        ikey key = {list.v[from].name, {0}, {0}};
        bool supported = str_eqc(list.v[from].kind, "BTREE");
        for (size_t k = from; k < j; k++) {
            if (list.v[k].part || list.v[k].expression || list.v[k].column.n == 0) {
                supported = false;
            }
            PUSH(key.columns, list.v[k].column);
            PUSH(key.desc, str_eqc(list.v[k].collation, "D"));
        }
        if (!supported) {
            catalog_report(c, SL("index"), t->name, key.name, fmt("a prefix, expression or %S index has no dbspec definition", str_lower(list.v[from].kind)));
        } else if (str_eqc(key.name, "PRIMARY")) {
            t->primary = key.columns;
        } else if (str_hasch(key.name, '$')) {
            catalog_report(c, SL("index"), t->name, key.name, SL("the name contains $"));
        } else if (list.v[from].unique) {
            PUSH(t->uniques, key);
        } else {
            PUSH(t->indexes, key);
        }
    }
    return true;
}

/* foreign key마다 column row를 모은다. 지원하지 않는 key는 column row마다 보고된다. */
static bool mysql_foreign_keys(zval *pdo, catalog *c)
{
    str q = Q(MYSQL_FOREIGN_KEYS);
    zval rows;
    if (!catalog_read(pdo, q, &rows)) {
        zval_ptr_dtor(&rows);
        return false;
    }
    ifkey *current = NULL;
    itable *current_table = NULL;
    str skipped = SL("");
    zval *row;
    bool ok = true;
    EACH_ROW(rows, row) {
        str v[8];
        for (int k = 0; k < 8 && ok; k++) {
            ok = row_text(row, k, q, &v[k]);
        }
        if (!ok) {
            break;
        }
        str table = v[0], name = v[1];
        if (current != NULL && (!str_eq(current->name, name) || !str_eq(current_table->name, table))) {
            PUSH(current_table->fks, *current);
            current = NULL;
            current_table = NULL;
        }
        sbuf kb = {0};
        sb_s(&kb, table);
        sb_ch(&kb, '\0');
        sb_s(&kb, name);
        str key = sb_str(&kb);
        if (str_eq(skipped, key)) {
            continue;
        }
        skipped = SL("");
        if (current == NULL) {
            itable *t = catalog_table(c, table);
            bool dok, uok;
            str del = catalog_action_name(v[3], &dok), upd = catalog_action_name(v[4], &uok);
            if (t == NULL) {
                continue;
            }
            if (!dok || !uok || !str_eqc(v[5], "NONE")) {
                catalog_report(c, SL("foreign_key"), table, name, fmt("actions %S, %S or match %S have no dbspec definition", v[3], v[4], v[5]));
                skipped = key;
                continue;
            }
            current = dbs_alloc(sizeof *current);
            current->name = name;
            current->table = v[2];
            current->on_delete = del;
            current->on_update = upd;
            current_table = t;
        }
        PUSH(current->columns, v[6]);
        PUSH(current->refs, v[7]);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&rows);
    if (!ok) {
        return false;
    }
    if (current != NULL) {
        PUSH(current_table->fks, *current);
    }
    return true;
}

static catalog *mysql_read(zval *pdo)
{
    catalog *c = dbs_alloc(sizeof *c);
    zval rows, *row;
    str q = Q(MYSQL_TABLES);
    bool ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str name, kind, options;
            if (!(row_text(row, 0, q, &name) && row_text(row, 1, q, &kind) && row_text(row, 2, q, &options))) {
                ok = false;
                break;
            }
            if (!str_eqc(kind, "BASE TABLE")) {
                catalog_report(c, SL("view"), name, name, fmt("a %S has no dbspec definition", str_lower(kind)));
            } else if (str_has(options, "partitioned")) {
                catalog_report(c, SL("partition"), name, name, SL("a partitioned table has no dbspec definition"));
            } else {
                PUSH(c->tables, itable_new(name));
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    smap columns = {0}; /* table => smap*(column => icolumn*) */
    smap pending = {0}; /* table => smap*(column => str* need) */
    q = Q(MYSQL_COLUMNS);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, column_type, nullable, extra, charset, collation, generation, def;
            bool def_null;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_text(row, 2, q, &column_type) && row_text(row, 3, q, &nullable)
                && row_nullable_text(row, 4, q, &def_null, &def) && row_text(row, 5, q, &extra) && row_text(row, 6, q, &charset)
                && row_text(row, 7, q, &collation) && row_text(row, 8, q, &generation))) {
                ok = false;
                break;
            }
            itable *t = catalog_table(c, table);
            if (t == NULL) {
                continue;
            }
            str needs;
            ctype *type = mysql_type(column_type, charset, collation, &needs);
            if (type == NULL || generation.n > 0) {
                catalog_report(c, SL("column"), table, name, fmt("type %S %S %S has no dbspec type", column_type, charset, collation));
                continue;
            }
            icolumn col = {name, type, str_eqc(nullable, "YES"), false, SL("")};
            extra = str_trim_set(extra, " \t\n\r\v\f");
            if (str_eqc(extra, "auto_increment")) {
                col.identity = true;
            } else if (str_eqc(extra, "DEFAULT_GENERATED") && !def_null) {
                bool now = str_eqc(type->name, "datetime") && str_eq(def, type->p[0] == 0 ? SL("CURRENT_TIMESTAMP") : fmt("CURRENT_TIMESTAMP(%d)", type->p[0]));
                if (!now) {
                    catalog_report(c, SL("column"), table, name, fmt("default %S is not a dbspec default", def));
                    continue;
                }
                col.def = SL("now");
            } else if (extra.n > 0) {
                catalog_report(c, SL("column"), table, name, fmt("extra %S has no dbspec definition", extra));
                continue;
            } else if (!def_null) {
                col.def = mysql_default_literal(def, type);
            }
            PUSH(t->columns, col);
            smap *m = smap_get(&columns, table);
            if (m == NULL) {
                m = dbs_alloc(sizeof *m);
                smap_set(&columns, table, m);
            }
            icolumn *copy = dbs_alloc(sizeof *copy);
            *copy = col;
            smap_set(m, name, copy);
            if (needs.n > 0) {
                smap *pm = smap_get(&pending, table);
                if (pm == NULL) {
                    pm = dbs_alloc(sizeof *pm);
                    smap_set(&pending, table, pm);
                }
                str *need = dbs_alloc(sizeof *need);
                *need = needs;
                smap_set(pm, name, need);
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    TRY(mysql_indexes(pdo, c));
    TRY(mysql_foreign_keys(pdo, c));
    smap checked = {0};
    smap clauses = {0};
    q = Q(MYSQL_CHECK_CLAUSES);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str name, clause;
            if (!(row_text(row, 0, q, &name) && row_text(row, 1, q, &clause))) {
                ok = false;
                break;
            }
            str *v = dbs_alloc(sizeof *v);
            *v = clause;
            smap_set(&clauses, name, v);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    smap creates = {0};
    q = Q(MYSQL_CHECKS);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, enforced;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_text(row, 2, q, &enforced))) {
                ok = false;
                break;
            }
            str *clause = smap_get(&clauses, name);
            if (clause == NULL) {
                dbs_throw(spl_ce_RuntimeException, fmt("check %S.%S has no CHECK_CLAUSE", table, name));
                ok = false;
                break;
            }
            if (has_non_ascii(*clause)) {
                str *shown = dbs_alloc(sizeof *shown);
                if (!shown_clause(pdo, table, name, &creates, shown)) {
                    ok = false;
                    break;
                }
                clause = shown;
            }
            itable *t = catalog_table(c, table);
            if (t == NULL) {
                continue;
            }
            if (!str_eqc(enforced, "YES")) {
                catalog_report(c, SL("check"), table, name, SL("the check is not enforced"));
                continue;
            }
            ssize_t dollar = str_find(name, "$", 0);
            if (dollar >= 0) {
                str owner = str_sub(name, 0, (size_t)dollar), column_name = str_sub(name, (size_t)dollar + 1, name.n - (size_t)dollar - 1);
                smap *m = smap_get(&columns, table);
                icolumn *known = m == NULL ? NULL : smap_get(m, column_name);
                if (!str_eq(owner, table) || known == NULL || !str_eq(without_introducers(*clause), without_introducers(mysql_renderer_check(known)))) {
                    catalog_report(c, SL("check"), table, name, fmt("the check %S is not the renderer CHECK", *clause));
                    continue;
                }
                smap *cm = smap_get(&checked, table);
                if (cm == NULL) {
                    cm = dbs_alloc(sizeof *cm);
                    smap_set(&checked, table, cm);
                }
                smap_set(cm, column_name, TRUEP);
                continue;
            }
            smap types = itable_types(t);
            str predicate, failure;
            if (check_decode(D_MYSQL, *clause, &types, &predicate, &failure)) {
                PUSH(t->checks, ((icheck){name, predicate}));
            } else {
                catalog_report(c, SL("check"), table, name, failure);
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    /* renderer CHECK이 있어야 하는 type은 그 CHECK이 없으면 dbspec type이 아니다. */
    SMAP_EACH(&pending, i) {
        smap *cols = pending.e[i].val;
        smap *cm = smap_get(&checked, pending.e[i].key);
        SMAP_EACH(cols, k) {
            if (cm == NULL || !smap_has(cm, cols->e[k].key)) {
                catalog_report(c, SL("column"), pending.e[i].key, cols->e[k].key, fmt("%S without its renderer CHECK has no dbspec type", *(str *)cols->e[k].val));
                itable_drop_column(catalog_table(c, pending.e[i].key), cols->e[k].key);
            }
        }
    }
    q = Q(MYSQL_TRIGGERS);
    smap triggers = {0};
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str v[5];
            for (int k = 0; k < 5 && ok; k++) {
                ok = row_text(row, k, q, &v[k]);
            }
            if (!ok) {
                break;
            }
            strs statements = {0};
            PUSH(statements, fmt("CREATE TRIGGER `%S` %S %S ON `%S` FOR EACH ROW %S", v[1], v[2], v[3], v[0], v[4]));
            add_trigger(&triggers, v[0], v[1], statements);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    recognize_triggers(c, D_MYSQL, &triggers);
    const char *kinds[] = {"routine", "event"};
    str queries[] = {Q(MYSQL_ROUTINES), Q(MYSQL_EVENTS)};
    for (int k = 0; k < 2; k++) {
        ok = catalog_read(pdo, queries[k], &rows);
        if (ok) {
            EACH_ROW(rows, row) {
                str name;
                if (!row_text(row, 0, queries[k], &name)) {
                    ok = false;
                    break;
                }
                catalog_report(c, str_c(kinds[k]), SL(""), name, fmt("a %s has no dbspec definition", kinds[k]));
            } ZEND_HASH_FOREACH_END();
        }
        zval_ptr_dtor(&rows);
        TRY(ok);
    }
    return c;
}

/* ------------------------------------------------------------- PostgreSQL */

static const char PG_TABLES[] = "SELECT c.relname, c.relkind::text, c.relispartition FROM pg_class c\n"
    "WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT LIKE 'dbspec$%' ORDER BY c.relname";
static const char PG_SEQUENCES[] = "SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'S'\n"
    "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY c.relname";
static const char PG_COLUMNS[] = "SELECT c.relname, a.attname, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,\n"
    "pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, coalesce(co.collname, '')\n"
    "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid\n"
    "LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum\n"
    "LEFT JOIN pg_collation co ON co.oid = a.attcollation\n"
    "WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname NOT LIKE 'dbspec$%'\n"
    "ORDER BY c.relname, a.attnum";
static const char PG_CONSTRAINTS[] = "SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid), con.condeferrable,\n"
    "con.convalidated, con.confmatchtype::text, con.confdeltype::text, con.confupdtype::text, CASE WHEN r.relnamespace = c.relnamespace THEN r.relname ELSE '' END,\n"
    "array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)\n"
    "  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), ','),\n"
    "array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)\n"
    "  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), ',')\n"
    "FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class r ON r.oid = con.confrelid\n"
    "WHERE c.relnamespace = current_schema()::regnamespace AND con.contype <> 'n' ORDER BY c.relname, con.conname";
static const char PG_INDEXES[] = "SELECT c.relname, i.relname, x.indisunique, x.indpred IS NOT NULL, x.indexprs IS NOT NULL,\n"
    "x.indnatts <> x.indnkeyatts, am.amname,\n"
    "array_to_string(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(n, o)\n"
    "  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n ORDER BY k.o), ','),\n"
    "array_to_string(ARRAY(SELECT (o & 1)::text FROM unnest(x.indoption::int2[]) o), ',')\n"
    "FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam\n"
    "WHERE c.relnamespace = current_schema()::regnamespace\n"
    "AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))\n"
    "ORDER BY c.relname, i.relname";
static const char PG_TRIGGERS[] = "SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), p.proname, p.prosrc, l.lanname\n"
    "FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang\n"
    "WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname, t.tgname";
static const char PG_ROUTINES[] = "SELECT p.proname FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace ORDER BY p.proname";

static ctype *pg_type(str formatted, str collation)
{
    static const char *const simple[] = {"smallint", "integer", "bigint", "boolean", "double precision", "text", "bytea", "uuid", "date", NULL};
    static const char *const mapped[] = {"i16", "i32", "i64", "bool", "f64", "text", "bytes", "uuid", "date"};
    for (int k = 0; simple[k] != NULL; k++) {
        if (str_eqc(formatted, simple[k])) {
            if (k == 5 && !str_eqc(collation, "C")) {
                return NULL;
            }
            return simple_type(mapped[k]);
        }
    }
    size_t i = 0;
    str a, b;
    if (slit(formatted, &i, "numeric(")) {
        size_t s = i;
        while (i < formatted.n && cdigit(formatted.s[i])) i++;
        a = str_sub(formatted, s, i - s);
        if (a.n > 0 && slit(formatted, &i, ",")) {
            s = i;
            while (i < formatted.n && cdigit(formatted.s[i])) i++;
            b = str_sub(formatted, s, i - s);
            if (b.n > 0 && slit(formatted, &i, ")") && i == formatted.n) {
                zend_long p[2] = {parse_long(a), parse_long(b)};
                return ctype_new(SL("decimal"), p, 2);
            }
        }
        return NULL;
    }
    i = 0;
    if (slit(formatted, &i, "character varying(")) {
        size_t s = i;
        while (i < formatted.n && cdigit(formatted.s[i])) i++;
        a = str_sub(formatted, s, i - s);
        if (a.n > 0 && slit(formatted, &i, ")") && i == formatted.n) {
            return str_eqc(collation, "C") ? one_param("varchar", parse_long(a)) : NULL;
        }
        return NULL;
    }
    const char *timed[] = {"time(", "timestamp("};
    for (int k = 0; k < 2; k++) {
        i = 0;
        if (slit(formatted, &i, timed[k]) && i < formatted.n && cdigit(formatted.s[i])) {
            str d = str_sub(formatted, i, 1);
            i++;
            if (slit(formatted, &i, ") without time zone") && i == formatted.n) {
                return one_param(k == 0 ? "time" : "datetime", parse_long(d));
            }
        }
    }
    return NULL;
}

/* pg_get_expr의 default를 dbspec literal이나 now로 읽는다. 아니면 false다. */
static bool pg_default_literal(str text, const ctype *type, str *out)
{
    if (str_eqc(text, "statement_timestamp()")) {
        *out = SL("now");
        return str_eqc(type->name, "datetime");
    }
    /* `^'((?:[^']|'')*)'::([a-z ]+)$` */
    if (text.n > 0 && text.s[0] == '\'') {
        VEC(size_t) candidates = {0};
        size_t j = 1;
        while (j < text.n) {
            if (text.s[j] != '\'') {
                j++;
            } else if (j + 1 < text.n && text.s[j + 1] == '\'') {
                PUSH(candidates, j);
                j += 2;
            } else {
                PUSH(candidates, j);
                break;
            }
        }
        for (size_t k = candidates.n; k-- > 0;) {
            size_t close = candidates.v[k];
            size_t p = close + 1;
            if (!slit(text, &p, "::") || p >= text.n) {
                continue;
            }
            bool letters = true;
            for (size_t m = p; m < text.n; m++) {
                letters = letters && ((text.s[m] >= 'a' && text.s[m] <= 'z') || text.s[m] == ' ');
            }
            if (!letters) {
                continue;
            }
            str value = str_replace(str_sub(text, 1, close - 1), "''", "'");
            const char *numeric[] = {"i16", "i32", "i64", "decimal", "f64"};
            for (int n = 0; n < 5; n++) {
                if (str_eqc(type->name, numeric[n])) {
                    *out = value;
                    return true;
                }
            }
            *out = literal_quote(value);
            return true;
        }
    }
    if (str_eqc(text, "true") || str_eqc(text, "false")) {
        *out = text;
        return str_eqc(type->name, "bool");
    }
    if (number_default(text)) {
        *out = text;
        return true;
    }
    return false;
}

static bool pg_action(str code, str *out)
{
    if (str_eqc(code, "r")) { *out = SL("restrict"); return true; }
    if (str_eqc(code, "c")) { *out = SL("cascade"); return true; }
    if (str_eqc(code, "n")) { *out = SL("set_null"); return true; }
    return false;
}

static str pg_kind(str contype)
{
    if (str_eqc(contype, "p") || str_eqc(contype, "u")) return SL("unique");
    if (str_eqc(contype, "f")) return SL("foreign_key");
    if (str_eqc(contype, "c")) return SL("check");
    return SL("index");
}

static bool non_space(char c)
{
    return !(c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r');
}

/* TRIGGER: `^CREATE TRIGGER (\S+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON (?:\S+\.)?(\S+) FOR EACH ROW EXECUTE FUNCTION (\S+)\(\)$` */
static bool pg_trigger_def(str d, str *name, str *timing, str *event, str *table, str *function)
{
    size_t i = 0;
    if (!slit(d, &i, "CREATE TRIGGER ")) return false;
    size_t s = i;
    while (i < d.n && non_space(d.s[i])) i++;
    if (i == s) return false;
    *name = str_sub(d, s, i - s);
    if (!slit(d, &i, " ")) return false;
    if (slit(d, &i, "BEFORE")) *timing = SL("BEFORE");
    else if (slit(d, &i, "AFTER")) *timing = SL("AFTER");
    else return false;
    if (!slit(d, &i, " ")) return false;
    if (slit(d, &i, "INSERT")) *event = SL("INSERT");
    else if (slit(d, &i, "UPDATE")) *event = SL("UPDATE");
    else if (slit(d, &i, "DELETE")) *event = SL("DELETE");
    else return false;
    if (!slit(d, &i, " ON ")) return false;
    s = i;
    while (i < d.n && non_space(d.s[i])) i++;
    str token = str_sub(d, s, i - s);
    if (token.n == 0) return false;
    /* (?:\S+\.)?(\S+): 남는 부분이 비지 않는 가장 긴 '.'로 끝나는 앞부분을 뺀다. */
    *table = token;
    for (size_t k = token.n - 1; k >= 2; k--) {
        if (token.s[k - 1] == '.') {
            *table = str_sub(token, k, token.n - k);
            break;
        }
    }
    if (!slit(d, &i, " FOR EACH ROW EXECUTE FUNCTION ")) return false;
    s = i;
    while (i < d.n && non_space(d.s[i])) i++;
    if (i != d.n) return false;
    str fn = str_sub(d, s, i - s);
    if (fn.n < 3 || !str_ends(fn, "()")) return false;
    *function = str_sub(fn, 0, fn.n - 2);
    return true;
}

static catalog *pg_read(zval *pdo)
{
    catalog *c = dbs_alloc(sizeof *c);
    zval rows, *row;
    str q = Q(PG_TABLES);
    bool ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str name, kind;
            bool partition;
            if (!(row_text(row, 0, q, &name) && row_text(row, 1, q, &kind))) {
                ok = false;
                break;
            }
            if (str_eqc(kind, "p")) {
                catalog_report(c, SL("partition"), name, name, SL("a partitioned table or a partition has no dbspec definition"));
                continue;
            }
            if (!row_flag(row, 2, q, &partition)) {
                ok = false;
                break;
            }
            if (partition) {
                catalog_report(c, SL("partition"), name, name, SL("a partitioned table or a partition has no dbspec definition"));
            } else if (str_eqc(kind, "r")) {
                PUSH(c->tables, itable_new(name));
            } else {
                catalog_report(c, SL("view"), name, name, fmt("a relation of kind %S has no dbspec definition", kind));
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    q = Q(PG_SEQUENCES);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str name;
            if (!row_text(row, 0, q, &name)) {
                ok = false;
                break;
            }
            catalog_report(c, SL("sequence"), SL(""), name, SL("a sequence outside identity has no dbspec definition"));
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    smap quoted = {0}, pending = {0}; /* table => smap* */
    q = Q(PG_COLUMNS);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, quoted_name, formatted, def, identity, generated, collation;
            bool not_null, def_null;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_text(row, 2, q, &quoted_name) && row_text(row, 3, q, &formatted)
                && row_flag(row, 4, q, &not_null) && row_nullable_text(row, 5, q, &def_null, &def) && row_text(row, 6, q, &identity)
                && row_text(row, 7, q, &generated) && row_text(row, 8, q, &collation))) {
                ok = false;
                break;
            }
            itable *t = catalog_table(c, table);
            if (t == NULL) {
                continue;
            }
            ctype *type = pg_type(formatted, collation);
            if (type == NULL || generated.n > 0) {
                catalog_report(c, SL("column"), table, name, fmt("type %S with collation \"%S\" has no dbspec type", formatted, collation));
                continue;
            }
            icolumn col = {name, type, !not_null, false, SL("")};
            if (str_eqc(identity, "d")) {
                col.identity = true;
            } else if (str_eqc(identity, "a")) {
                catalog_report(c, SL("column"), table, name, SL("an identity generated always has no dbspec definition"));
                continue;
            }
            if (!def_null) {
                str value;
                if (!pg_default_literal(def, type, &value)) {
                    catalog_report(c, SL("column"), table, name, fmt("default %S is not a dbspec default", def));
                    continue;
                }
                col.def = value;
            }
            PUSH(t->columns, col);
            smap *qm = smap_get(&quoted, table);
            if (qm == NULL) {
                qm = dbs_alloc(sizeof *qm);
                smap_set(&quoted, table, qm);
            }
            str *qn = dbs_alloc(sizeof *qn);
            *qn = quoted_name;
            smap_set(qm, name, qn);
            if (str_eqc(type->name, "time")) {
                smap *pm = smap_get(&pending, table);
                if (pm == NULL) {
                    pm = dbs_alloc(sizeof *pm);
                    smap_set(&pending, table, pm);
                }
                smap_set(pm, name, TRUEP);
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    smap checked = {0};
    q = Q(PG_CONSTRAINTS);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, kind, definition, match, on_delete, on_update, ref_table, columns, refs;
            bool deferrable, validated;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_text(row, 2, q, &kind) && row_text(row, 3, q, &definition)
                && row_flag(row, 4, q, &deferrable) && row_flag(row, 5, q, &validated) && row_text(row, 6, q, &match) && row_text(row, 7, q, &on_delete)
                && row_text(row, 8, q, &on_update) && row_text(row, 9, q, &ref_table) && row_text(row, 10, q, &columns) && row_text(row, 11, q, &refs))) {
                ok = false;
                break;
            }
            itable *t = catalog_table(c, table);
            if (t == NULL) {
                continue;
            }
            strs list = strs_split(columns, ',');
            if (!validated || deferrable) {
                catalog_report(c, pg_kind(kind), table, name, SL("a deferrable or not validated constraint has no dbspec definition"));
            } else if (str_eqc(kind, "p")) {
                t->primary = list;
            } else if (str_eqc(kind, "u")) {
                if (str_hasch(name, '$') || !str_starts(definition, "UNIQUE (")) {
                    catalog_report(c, SL("unique"), table, name, fmt("the unique constraint %S has no dbspec definition", definition));
                    continue;
                }
                ikey key = {name, list, {0}};
                for (size_t k = 0; k < list.n; k++) {
                    PUSH(key.desc, false);
                }
                PUSH(t->uniques, key);
            } else if (str_eqc(kind, "f") && ref_table.n == 0) {
                /* 다른 schema의 table을 가리키는 foreign key는 이 문서 밖의 table을 가리킨다. */
                catalog_report(c, SL("foreign_key"), table, name, SL("the referenced table is outside the current schema"));
            } else if (str_eqc(kind, "f")) {
                str del, upd;
                bool dok = pg_action(on_delete, &del), uok = pg_action(on_update, &upd);
                if (!dok || !uok || !str_eqc(match, "s")) {
                    catalog_report(c, SL("foreign_key"), table, name, fmt("actions %S, %S or match %S have no dbspec definition", on_delete, on_update, match));
                    continue;
                }
                PUSH(t->fks, ((ifkey){name, list, ref_table, strs_split(refs, ','), del, upd}));
            } else if (str_eqc(kind, "c")) {
                ssize_t dollar = str_find(name, "$", 0);
                if (dollar >= 0) {
                    str owner = str_sub(name, 0, (size_t)dollar), column_name = str_sub(name, (size_t)dollar + 1, name.n - (size_t)dollar - 1);
                    smap *qm = smap_get(&quoted, table);
                    str *qn = qm == NULL ? NULL : smap_get(qm, column_name);
                    str want = fmt("CHECK ((%S < '24:00:00'::time without time zone))", qn != NULL ? *qn : SL(""));
                    smap *pm = smap_get(&pending, table);
                    if (!str_eq(owner, table) || pm == NULL || !smap_has(pm, column_name) || !str_eq(definition, want)) {
                        catalog_report(c, SL("check"), table, name, fmt("the check %S is not the renderer CHECK", definition));
                        continue;
                    }
                    smap *cm = smap_get(&checked, table);
                    if (cm == NULL) {
                        cm = dbs_alloc(sizeof *cm);
                        smap_set(&checked, table, cm);
                    }
                    smap_set(cm, column_name, TRUEP);
                    continue;
                }
                smap types = itable_types(t);
                str predicate, failure;
                if (check_decode(D_POSTGRES, definition, &types, &predicate, &failure)) {
                    PUSH(t->checks, ((icheck){name, predicate}));
                } else {
                    catalog_report(c, SL("check"), table, name, failure);
                }
            } else {
                catalog_report(c, pg_kind(kind), table, name, fmt("a constraint of kind %S has no dbspec definition", kind));
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    SMAP_EACH(&pending, i) {
        smap *cols = pending.e[i].val;
        smap *cm = smap_get(&checked, pending.e[i].key);
        SMAP_EACH(cols, k) {
            if (cm == NULL || !smap_has(cm, cols->e[k].key)) {
                catalog_report(c, SL("column"), pending.e[i].key, cols->e[k].key, SL("time without its renderer CHECK has no dbspec type"));
                itable_drop_column(catalog_table(c, pending.e[i].key), cols->e[k].key);
            }
        }
    }
    q = Q(PG_INDEXES);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, method, columns, options;
            bool unique, partial, expression, include;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_flag(row, 2, q, &unique) && row_flag(row, 3, q, &partial)
                && row_flag(row, 4, q, &expression) && row_flag(row, 5, q, &include) && row_text(row, 6, q, &method) && row_text(row, 7, q, &columns)
                && row_text(row, 8, q, &options))) {
                ok = false;
                break;
            }
            itable *t = catalog_table(c, table);
            if (t == NULL) {
                continue;
            }
            if (unique || partial || expression || include || !str_eqc(method, "btree") || str_hasch(name, '$')) {
                catalog_report(c, SL("index"), table, name, fmt("a unique, partial, expression, covering or %S index has no dbspec index", method));
                continue;
            }
            ikey key = {name, strs_split(columns, ','), {0}};
            strs o = strs_split(options, ',');
            for (size_t k = 0; k < o.n; k++) {
                PUSH(key.desc, str_eqc(o.v[k], "1"));
            }
            PUSH(t->indexes, key);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    smap triggers = {0}, functions = {0};
    q = Q(PG_TRIGGERS);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str v[6];
            for (int k = 0; k < 6 && ok; k++) {
                ok = row_text(row, k, q, &v[k]);
            }
            if (!ok) {
                break;
            }
            str table = v[0], name = v[1], definition = v[2], function = v[3], source = v[4], language = v[5];
            smap_set(&functions, function, TRUEP);
            str tname, timing, event, ttable, tfunction;
            strs statements = {0};
            if (!pg_trigger_def(definition, &tname, &timing, &event, &ttable, &tfunction) || !str_eqc(language, "plpgsql")
                || !str_eq(str_trim_set(tname, "\""), name) || !str_eq(str_trim_set(tfunction, "\""), function)) {
                PUSH(statements, definition);
                add_trigger(&triggers, table, name, statements);
                continue;
            }
            PUSH(statements, fmt("CREATE FUNCTION \"%S\"() RETURNS trigger LANGUAGE plpgsql AS $$%S$$", function, source));
            PUSH(statements, fmt("CREATE TRIGGER \"%S\" %S %S ON \"%S\" FOR EACH ROW EXECUTE FUNCTION \"%S\"()", name, timing, event, str_trim_set(ttable, "\""), function));
            add_trigger(&triggers, table, name, statements);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    recognize_triggers(c, D_POSTGRES, &triggers);
    q = Q(PG_ROUTINES);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str name;
            if (!row_text(row, 0, q, &name)) {
                ok = false;
                break;
            }
            if (!smap_has(&functions, name)) {
                catalog_report(c, SL("routine"), SL(""), name, SL("a function outside the renderer triggers has no dbspec definition"));
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    return c;
}

/* ----------------------------------------------------------------- SQLite */

static const char SQLITE_MASTER[] = "SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master\n"
    "WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name";
static const char SQLITE_COLUMNS[] = "SELECT m.name, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk, p.hidden FROM sqlite_master m\n"
    "JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND p.name NOT LIKE 'dbspec$%' ORDER BY m.name, p.cid";
static const char SQLITE_INDEXES[] = "SELECT m.name, l.name, l.\"unique\", l.origin, l.partial,\n"
    "IFNULL((SELECT group_concat(IFNULL(x.name, ''), ',') FROM (SELECT name FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), ''),\n"
    "IFNULL((SELECT group_concat(x.\"desc\", ',') FROM (SELECT \"desc\" FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), '')\n"
    "FROM sqlite_master m JOIN pragma_index_list(m.name) l WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, l.name";

typedef struct {
    smap checks;          /* 이름 => str* 식 */
    strs order;
    VEC(ifkey) fks;
    strs primary;
    str identity;
    smap columns;         /* 이름 => str* 항목 */
    str unsupported;
} sqlite_table;

typedef struct {
    str kind, name, reason;
} sqlite_unsupported;

typedef VEC(sqlite_unsupported) sqlite_unsupportedv;

static str trim_space6(str s)
{
    return str_trim_set(s, " \t\n\r\v\f");
}

/* 괄호와 따옴표 밖의 쉼표로 나눈다. */
static strs split_top_level(str text)
{
    strs out = {0};
    int depth = 0;
    size_t start = 0;
    char quote = 0;
    for (size_t i = 0; i < text.n; i++) {
        char ch = text.s[i];
        if (quote != 0) {
            if (ch == quote) {
                quote = 0;
            }
        } else if (ch == '\'' || ch == '"') {
            quote = ch;
        } else if (ch == '(') {
            depth++;
        } else if (ch == ')') {
            depth--;
        } else if (ch == ',' && depth == 0) {
            PUSH(out, trim_space6(str_sub(text, start, i - start)));
            start = i + 1;
        }
    }
    PUSH(out, trim_space6(str_sub(text, start, text.n - start)));
    return out;
}

static strs unquote_list(str text)
{
    strs parts = strs_split(text, ','), out = {0};
    for (size_t i = 0; i < parts.n; i++) {
        PUSH(out, str_trim_set(trim_space6(parts.v[i]), "\""));
    }
    return out;
}

/* `"([^"]+)"` */
static bool dq_name(str s, size_t *i, str *out)
{
    size_t p = *i;
    if (p >= s.n || s.s[p] != '"') {
        return false;
    }
    size_t q = p + 1;
    while (q < s.n && s.s[q] != '"') {
        q++;
    }
    if (q >= s.n || q == p + 1) {
        return false;
    }
    *out = str_sub(s, p + 1, q - p - 1);
    *i = q + 1;
    return true;
}

static bool paren_list(str s, size_t *i, str *out)
{
    if (!slit(s, i, "(")) {
        return false;
    }
    size_t p = *i;
    while (*i < s.n && s.s[*i] != ')') {
        (*i)++;
    }
    if (*i >= s.n) {
        return false;
    }
    *out = str_sub(s, p, *i - p);
    (*i)++;
    return true;
}

static bool sql_action(str s, size_t *i, str *out)
{
    const char *actions[] = {"RESTRICT", "CASCADE", "SET NULL"};
    for (int k = 0; k < 3; k++) {
        if (slit(s, i, actions[k])) {
            *out = str_c(actions[k]);
            return true;
        }
    }
    return false;
}

static bool word_char(char c)
{
    return calpha(c) || cdigit(c) || c == '_';
}

static sqlite_table *sqlite_parse_table(str text, sqlite_unsupportedv *unsupported)
{
    sqlite_table *st = dbs_alloc(sizeof *st);
    st->identity = SL("");
    st->unsupported = SL("");
    ssize_t open = str_find(text, "(", 0);
    if (open < 0 || !str_ends(text, ")")) {
        st->unsupported = SL("the CREATE TABLE text has no column list");
        return st;
    }
    strs items = split_top_level(str_sub(text, (size_t)open + 1, text.n - (size_t)open - 2));
    for (size_t k = 0; k < items.n; k++) {
        str item = items.v[k];
        size_t i = 0;
        str name, a, b, tbl;
        str del, upd;
        /* IDENTITY_COLUMN */
        i = 0;
        if (dq_name(item, &i, &name) && slit(item, &i, " INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT") && i == item.n) {
            st->identity = name;
            st->primary = (strs){0};
            PUSH(st->primary, name);
            continue;
        }
        i = 0;
        if (slit(item, &i, "PRIMARY KEY ") && paren_list(item, &i, &a) && i == item.n) {
            st->primary = unquote_list(a);
            continue;
        }
        i = 0;
        if (slit(item, &i, "CONSTRAINT ") && dq_name(item, &i, &name) && slit(item, &i, " FOREIGN KEY ") && paren_list(item, &i, &a)
            && slit(item, &i, " REFERENCES ") && dq_name(item, &i, &tbl) && slit(item, &i, " ") && paren_list(item, &i, &b)
            && slit(item, &i, " ON DELETE ") && sql_action(item, &i, &del) && slit(item, &i, " ON UPDATE ") && sql_action(item, &i, &upd) && i == item.n) {
            bool ok;
            PUSH(st->fks, ((ifkey){name, unquote_list(a), tbl, unquote_list(b), catalog_action_name(del, &ok), catalog_action_name(upd, &ok)}));
            continue;
        }
        i = 0;
        /* CHECK_ITEM: `^CONSTRAINT "([^"]+)" CHECK \((.*)\)$` (.은 줄 바꿈이 아니다) */
        if (slit(item, &i, "CONSTRAINT ") && dq_name(item, &i, &name) && slit(item, &i, " CHECK (") && str_ends(item, ")") && i <= item.n - 1) {
            str body = str_sub(item, i, item.n - 1 - i);
            if (!str_hasch(body, '\n')) {
                str *v = dbs_alloc(sizeof *v);
                *v = body;
                smap_set(&st->checks, name, v);
                PUSH(st->order, name);
                continue;
            }
        }
        /* CONSTRAINT_ITEM: `^(?:CONSTRAINT "([^"]+)" )?(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b` */
        {
            str cname = SL("");
            size_t starts[2];
            int nstarts = 0;
            i = 0;
            if (slit(item, &i, "CONSTRAINT ") && dq_name(item, &i, &cname) && slit(item, &i, " ")) {
                starts[nstarts++] = i;
            }
            starts[nstarts++] = 0;
            const char *keywords[] = {"CHECK", "UNIQUE", "FOREIGN KEY", "PRIMARY KEY"};
            int found = -1;
            str found_name = SL("");
            for (int s = 0; s < nstarts && found < 0; s++) {
                for (int kw = 0; kw < 4; kw++) {
                    size_t p = starts[s];
                    if (slit(item, &p, keywords[kw]) && (p >= item.n || !word_char(item.s[p]))) {
                        found = kw;
                        found_name = s == 0 && nstarts == 2 ? cname : SL("");
                        break;
                    }
                }
            }
            if (found >= 0) {
                if (found == 3) {
                    st->unsupported = fmt("the primary key \"%S\" has no dbspec definition", item);
                    return st;
                }
                const char *kinds[] = {"check", "unique", "foreign_key"};
                PUSH(*unsupported, ((sqlite_unsupported){str_c(kinds[found]), found_name, fmt("the table item \"%S\" has no dbspec definition", item)}));
                continue;
            }
        }
        i = 0;
        if (dq_name(item, &i, &name) && slit(item, &i, " ")) {
            /* 정의는 pragma_table_xinfo가 읽고, 그 text는 renderer 형식인지 확인한다. */
            str *v = dbs_alloc(sizeof *v);
            *v = item;
            smap_set(&st->columns, name, v);
            continue;
        }
        st->unsupported = fmt("the table item \"%S\" has no dbspec definition", item);
        return st;
    }
    return st;
}

/* column 정의 text가 renderer의 column 형식(이름, 선언 type, NULL이나 NOT NULL, 있으면 DEFAULT)뿐인지 알린다. */
static bool sqlite_column_text(str item, str name, str declared, bool not_null, bool def_null, str def)
{
    str prefix = fmt("\"%S\" ", name);
    if (item.n < prefix.n || memcmp(item.s, prefix.s, prefix.n) != 0) {
        return false;
    }
    str rest = str_sub(item, prefix.n, item.n - prefix.n);
    if (rest.n < declared.n || !ascii_ieq(rest.s, declared.s, declared.n)) {
        return false;
    }
    rest = str_sub(rest, declared.n, rest.n - declared.n);
    const char *tail = not_null ? " NOT NULL" : " NULL";
    if (def_null) {
        return str_eqc(rest, tail);
    }
    return str_eq(rest, fmt("%s DEFAULT %S", tail, def)) || str_eq(rest, fmt("%s DEFAULT (%S)", tail, def));
}

/* 선언 type과 그 column의 renderer CHECK로 dbspec type을 정한다. CHECK은 그 type의 renderer 출력과 정확히 같아야 한다. */
static ctype *sqlite_type(str declared, str column_name, str check, bool has_check)
{
    VEC(ctype *) candidates = {0};
    static const char *const words[] = {"smallint", "integer", "bigint", "BOOLEAN", "REAL", "TEXT", "BLOB", "DATE", "TIME", "DATETIME", "INTEGER", NULL};
    bool matched = false;
    for (int k = 0; words[k] != NULL; k++) {
        if (str_eqc(declared, words[k])) {
            matched = true;
            str w = str_c(words[k]);
            if (str_eqc(w, "smallint")) PUSH(candidates, simple_type("i16"));
            else if (str_eqc(w, "integer") || str_eqc(w, "INTEGER")) PUSH(candidates, simple_type("i32"));
            else if (str_eqc(w, "bigint")) PUSH(candidates, simple_type("i64"));
            else if (str_eqc(w, "BOOLEAN")) PUSH(candidates, simple_type("bool"));
            else if (str_eqc(w, "REAL")) PUSH(candidates, simple_type("f64"));
            else if (str_eqc(w, "TEXT")) {
                PUSH(candidates, simple_type("text"));
                PUSH(candidates, simple_type("uuid"));
            } else if (str_eqc(w, "BLOB")) PUSH(candidates, simple_type("bytes"));
            else if (str_eqc(w, "DATE")) PUSH(candidates, simple_type("date"));
            else {
                for (zend_long p = 0; p <= 6; p++) {
                    PUSH(candidates, one_param(str_eqc(w, "TIME") ? "time" : "datetime", p));
                }
            }
            break;
        }
    }
    if (!matched) {
        size_t i = 0;
        str a, b;
        if (slit(declared, &i, "DECIMALINT(")) {
            size_t s = i;
            while (i < declared.n && cdigit(declared.s[i])) i++;
            a = str_sub(declared, s, i - s);
            if (a.n > 0 && slit(declared, &i, ",")) {
                s = i;
                while (i < declared.n && cdigit(declared.s[i])) i++;
                b = str_sub(declared, s, i - s);
                if (b.n > 0 && slit(declared, &i, ")") && i == declared.n) {
                    zend_long p[2] = {parse_long(a), parse_long(b)};
                    PUSH(candidates, ctype_new(SL("decimal"), p, 2));
                    matched = true;
                }
            }
        }
        i = 0;
        if (!matched && slit(declared, &i, "varchar(")) {
            size_t s = i;
            while (i < declared.n && cdigit(declared.s[i])) i++;
            a = str_sub(declared, s, i - s);
            if (a.n > 0 && slit(declared, &i, ")") && i == declared.n) {
                PUSH(candidates, one_param("varchar", parse_long(a)));
                matched = true;
            }
        }
        if (!matched) {
            return NULL;
        }
    }
    renderer r = {0};
    r.d = D_SQLITE;
    for (size_t k = 0; k < candidates.n; k++) {
        column *col = column_new(column_name, candidates.v[k], false, false, NULL);
        str want = r_type_check(&r, col);
        if ((want.n == 0 && !has_check) || (want.n > 0 && has_check && str_eq(want, check))) {
            return candidates.v[k];
        }
    }
    return NULL;
}

/* dflt_value를 dbspec literal이나 now로 읽는다. decimal은 scale을 곱한 정수이고 bool은 1과 0이다. */
static bool sqlite_default_literal(str text, const ctype *type, str *out)
{
    if (str_eqc(type->name, "datetime")) {
        renderer r = {0};
        r.d = D_SQLITE;
        if (str_eq(fmt("(%S)", text), r_default_text(&r, type, SL("now")))) {
            *out = SL("now");
            return true;
        }
    }
    if (str_eqc(type->name, "bool") && (str_eqc(text, "1") || str_eqc(text, "0"))) {
        *out = str_eqc(text, "1") ? SL("true") : SL("false");
        return true;
    }
    if (number_default(text)) {
        *out = str_eqc(type->name, "decimal") ? catalog_unscaled_decimal(text, type->p[1]) : text;
        return true;
    }
    if (str_starts(text, "'") && str_ends(text, "'")) {
        *out = text;
        return true;
    }
    return false;
}

static catalog *sqlite_read(zval *pdo)
{
    catalog *c = dbs_alloc(sizeof *c);
    smap parsed = {0};
    smap triggers = {0};
    zval rows, *row;
    str q = Q(SQLITE_MASTER);
    bool ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str kind, name, table, text;
            if (!(row_text(row, 0, q, &kind) && row_text(row, 1, q, &name) && row_text(row, 2, q, &table) && row_text(row, 3, q, &text))) {
                ok = false;
                break;
            }
            if (str_eqc(kind, "table")) {
                if (str_starts(text, "CREATE VIRTUAL TABLE") || str_ends(text, "WITHOUT ROWID")) {
                    catalog_report(c, SL("table"), name, name, SL("a virtual or WITHOUT ROWID table has no dbspec definition"));
                    continue;
                }
                sqlite_unsupportedv unsupported = {0};
                sqlite_table *st = sqlite_parse_table(text, &unsupported);
                if (st->unsupported.n > 0) {
                    catalog_report(c, SL("table"), name, name, st->unsupported);
                    continue;
                }
                for (size_t k = 0; k < unsupported.n; k++) {
                    catalog_report(c, unsupported.v[k].kind, name, unsupported.v[k].name, unsupported.v[k].reason);
                }
                smap_set(&parsed, name, st);
                itable *t = itable_new(name);
                t->primary = st->primary;
                for (size_t k = 0; k < st->fks.n; k++) {
                    PUSH(t->fks, st->fks.v[k]);
                }
                PUSH(c->tables, t);
            } else if (str_eqc(kind, "view")) {
                catalog_report(c, SL("view"), name, name, SL("a view has no dbspec definition"));
            } else if (str_eqc(kind, "trigger")) {
                strs statements = {0};
                PUSH(statements, text);
                add_trigger(&triggers, table, name, statements);
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    q = Q(SQLITE_COLUMNS);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, declared, def;
            zend_long not_null, pk, hidden;
            bool def_null;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_text(row, 2, q, &declared) && row_integer(row, 3, q, &not_null)
                && row_nullable_text(row, 4, q, &def_null, &def) && row_integer(row, 5, q, &pk) && row_integer(row, 6, q, &hidden))) {
                ok = false;
                break;
            }
            itable *t = catalog_table(c, table);
            if (t == NULL) {
                continue;
            }
            if (hidden != 0) {
                catalog_report(c, SL("column"), table, name, SL("a generated column has no dbspec definition"));
                continue;
            }
            sqlite_table *st = smap_get(&parsed, table);
            str *item = smap_get(&st->columns, name);
            str item_text = item != NULL ? *item : SL("");
            if (!str_eq(st->identity, name) && !sqlite_column_text(item_text, name, declared, not_null != 0, def_null, def)) {
                catalog_report(c, SL("column"), table, name, fmt("the column definition \"%S\" has clauses that dbspec does not read", item_text));
                continue;
            }
            icolumn col = {name, NULL, not_null == 0, false, SL("")};
            str check_name = fmt("%S$%S", table, name);
            str *checkp = smap_get(&st->checks, check_name);
            bool has_check = checkp != NULL;
            str check = has_check ? *checkp : SL("");
            if (str_eq(st->identity, name)) {
                col.type = simple_type("i64");
                col.identity = true;
            } else {
                ctype *type = sqlite_type(declared, name, check, has_check);
                if (type == NULL) {
                    catalog_report(c, SL("column"), table, name, fmt("declared type %S with CHECK \"%S\" has no dbspec type", declared, check));
                    continue;
                }
                col.type = type;
            }
            smap_del(&st->checks, check_name);
            if (!def_null) {
                str value;
                if (!sqlite_default_literal(def, col.type, &value)) {
                    catalog_report(c, SL("column"), table, name, fmt("default %S is not a dbspec default", def));
                    continue;
                }
                col.def = value;
            }
            PUSH(t->columns, col);
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    for (size_t i = 0; i < c->tables.n; i++) {
        itable *t = c->tables.v[i];
        sqlite_table *st = smap_get(&parsed, t->name);
        for (size_t k = 0; k < st->order.n; k++) {
            str name = st->order.v[k];
            str *expression = smap_get(&st->checks, name);
            if (expression == NULL) {
                continue;
            }
            if (str_hasch(name, '$')) {
                catalog_report(c, SL("check"), t->name, name, fmt("the check %S is not the renderer CHECK", *expression));
                continue;
            }
            smap types = itable_types(t);
            str predicate, failure;
            if (check_decode(D_SQLITE, *expression, &types, &predicate, &failure)) {
                PUSH(t->checks, ((icheck){name, predicate}));
            } else {
                catalog_report(c, SL("check"), t->name, name, failure);
            }
        }
    }
    q = Q(SQLITE_INDEXES);
    ok = catalog_read(pdo, q, &rows);
    if (ok) {
        EACH_ROW(rows, row) {
            str table, name, origin, columns, desc;
            zend_long unique, partial;
            if (!(row_text(row, 0, q, &table) && row_text(row, 1, q, &name) && row_integer(row, 2, q, &unique) && row_text(row, 3, q, &origin)
                && row_integer(row, 4, q, &partial) && row_text(row, 5, q, &columns) && row_text(row, 6, q, &desc))) {
                ok = false;
                break;
            }
            itable *t = catalog_table(c, table);
            /* pk와 u origin index는 primary key와 unique 정의에서 나오며 그 정의를 읽거나 보고한다. */
            if (t == NULL || str_eqc(origin, "pk") || str_eqc(origin, "u")) {
                continue;
            }
            strs list = strs_split(columns, ',');
            if (!str_eqc(origin, "c") || partial != 0 || str_hasch(name, '$') || strs_has(&list, SL(""))) {
                catalog_report(c, SL("index"), table, name, fmt("an index of origin %S, a partial or an expression index has no dbspec definition", origin));
                continue;
            }
            ikey key = {name, list, {0}};
            strs d = strs_split(desc, ',');
            for (size_t k = 0; k < d.n; k++) {
                PUSH(key.desc, str_eqc(d.v[k], "1"));
            }
            if (unique != 0) {
                PUSH(t->uniques, key);
            } else {
                PUSH(t->indexes, key);
            }
        } ZEND_HASH_FOREACH_END();
    }
    zval_ptr_dtor(&rows);
    TRY(ok);
    recognize_triggers(c, D_SQLITE, &triggers);
    return c;
}

/* ------------------------------------------------------------------ API */

/* 연결의 database를 문서 하나와 빠진 객체로 읽는다. 실패는 PHP 예외이고 NULL이다. */
document *dbs_introspect(zval *pdo, dialect d, str name, unsupportedv *out)
{
    catalog *c = d == D_MYSQL ? mysql_read(pdo) : d == D_POSTGRES ? pg_read(pdo) : sqlite_read(pdo);
    if (c == NULL || dbs_failed()) {
        return NULL;
    }
    return catalog_document(c, name, out);
}
