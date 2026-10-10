/*
 * check predicate를 읽고 operand type을 확인한 뒤 canonical text를 쓴다(PHP client Expression). 먼저 predicate를
 * 읽는다: 형식 밖의 token이나 column이 필요한 자리의 literal은 diagnostic 하나로 멈추고 column은 확인하지 않는다.
 * 끝까지 읽은 predicate는 source 순서로 첫 column이나 type diagnostic을 보고한다. tree에는 괄호가 없고 emission은
 * `and` 안의 `or`가 필요로 하는 괄호만 쓴다.
 */
#include "dbspec.h"
#include <setjmp.h>

enum { OP_COLUMN, OP_LITERAL };

typedef struct {
    int kind;
    str text;
    zend_long column;
    column *col;
    size_t literal;
} operand;

typedef VEC(operand) operandv;

enum { N_AND, N_OR, N_COMPARE, N_IN, N_NULL };

typedef struct enode {
    int kind;
    struct enode *l, *r;
    operand left, right;
    str op;
    zend_long op_at;
    operandv list;
    bool negated;
} enode;

typedef struct {
    const tokens *t;
    zend_long line, end;
    const smap *columns, *action;
    size_t at;
    strs literals;
    diags *errors;
    VEC(enode *) predicates;
    jmp_buf stop;
} xparser;

typedef struct {
    zend_long at;
    str message;
} found;

typedef VEC(found) foundv;

static const char *const comparisons[] = {"=", "<>", "<", "<=", ">", ">=", NULL};
static const char *const keywords[] = {"and", "or", "not", "in", "between", "is", "null", "true", "false", NULL};

static bool in_list(str s, const char *const *list)
{
    for (int i = 0; list[i] != NULL; i++) {
        if (str_eqc(s, list[i])) {
            return true;
        }
    }
    return false;
}

static bool ordering(str s)
{
    return str_eqc(s, "<") || str_eqc(s, "<=") || str_eqc(s, ">") || str_eqc(s, ">=");
}

static const str *peek(xparser *p, size_t ahead)
{
    size_t i = p->at + ahead;
    return i < p->t->n ? &p->t->v[i].text : NULL;
}

static bool peek_is(xparser *p, size_t ahead, const char *s)
{
    const str *t = peek(p, ahead);
    return t != NULL && str_eqc(*t, s);
}

static zend_long position(xparser *p)
{
    return p->at < p->t->n ? p->t->v[p->at].column : p->end;
}

static ZEND_NORETURN void fail_at(xparser *p, zend_long column, str message)
{
    PUSH(*p->errors, mkdiag(SL("check"), p->line, column, message));
    longjmp(p->stop, 1);
}

static ZEND_NORETURN void fail(xparser *p, str message)
{
    str found_text = p->at < p->t->n ? p->t->v[p->at].text : SL("the line end");
    if (str_eqc(found_text, "+") || str_eqc(found_text, "-") || str_eqc(found_text, "*") || str_eqc(found_text, "/")) {
        message = SL("a check has no arithmetic, and a minus applies only to a number literal");
    }
    fail_at(p, position(p), fmt("%S, found `%S`", message, found_text));
}

static void expect(xparser *p, const char *token)
{
    if (!peek_is(p, 0, token)) {
        fail(p, fmt("expected `%s`", token));
    }
    p->at++;
}

static enode *disjunction(xparser *p);

static operand literal(xparser *p)
{
    const str *token = peek(p, 0);
    zend_long column = position(p);
    if (token != NULL && str_eqc(*token, "null")) {
        fail(p, SL("a check has no null literal; `is null` tests for null"));
    }
    bool have = false;
    str text = SNULL;
    if (token != NULL && (str_eqc(*token, "true") || str_eqc(*token, "false"))) {
        text = *token;
        have = true;
        p->at++;
    } else if (token != NULL && str_eqc(*token, "-") && p->at + 1 < p->t->n && p->t->v[p->at + 1].column == column + 1
        && literal_number(fmt("-%S", p->t->v[p->at + 1].text), NULL)) {
        text = fmt("-%S", p->t->v[p->at + 1].text);
        have = true;
        p->at += 2;
    } else if (token != NULL) {
        str value;
        if (literal_number(*token, NULL) || literal_string_value(*token, &value)) {
            text = *token;
            have = true;
            p->at++;
        }
    }
    if (!have) {
        fail(p, SL("expected a column, a literal or `(`"));
    }
    PUSH(p->literals, text);
    operand o = {OP_LITERAL, text, column, NULL, p->literals.n - 1};
    return o;
}

static operand xoperand(xparser *p)
{
    const str *token = peek(p, 0);
    if (token != NULL && str_dotted(*token) && !str_digits(*token) && !str_decimal(*token)) {
        if (peek_is(p, 1, "(")) {
            fail(p, SL("a check has no functions"));
        }
        if (!in_list(*token, keywords)) {
            operand o = {OP_COLUMN, *token, position(p), smap_get(p->columns, *token), 0};
            p->at++;
            return o;
        }
    }
    return literal(p);
}

static void require_column(xparser *p, const operand *o, const char *keyword)
{
    if (o->kind == OP_LITERAL) {
        fail_at(p, o->column, fmt("`%s` takes a column on its left, found `%S`", keyword, o->text));
    }
}

static enode *predicate(xparser *p)
{
    operand left = xoperand(p);
    const str *next = peek(p, 0);
    if (next != NULL && in_list(*next, comparisons)) {
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_COMPARE;
        n->op = *next;
        n->op_at = position(p);
        p->at++;
        n->left = left;
        n->right = xoperand(p);
        if (left.kind == OP_LITERAL && n->right.kind == OP_LITERAL) {
            fail_at(p, left.column, fmt("a comparison needs a column operand, found `%S` %S `%S`", left.text, n->op, n->right.text));
        }
        PUSH(p->predicates, n);
        return n;
    }
    bool negated = next != NULL && str_eqc(*next, "not") && peek_is(p, 1, "in");
    if (negated) {
        require_column(p, &left, "in");
        p->at++;
        next = peek(p, 0);
    }
    if (next != NULL && str_eqc(*next, "in")) {
        require_column(p, &left, "in");
        p->at++;
        expect(p, "(");
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_IN;
        n->left = left;
        n->negated = negated;
        PUSH(n->list, literal(p));
        while (peek_is(p, 0, ",")) {
            p->at++;
            PUSH(n->list, literal(p));
        }
        expect(p, ")");
        PUSH(p->predicates, n);
        return n;
    }
    if (next != NULL && str_eqc(*next, "is")) {
        require_column(p, &left, "is");
        p->at++;
        bool is_not = peek_is(p, 0, "not");
        if (is_not) {
            p->at++;
        }
        expect(p, "null");
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_NULL;
        n->left = left;
        n->negated = is_not;
        PUSH(p->predicates, n);
        return n;
    }
    /* 비교, in, is가 따르지 않는 operand: and, or, )나 끝이 따르면 operand에서, 아니면 따르는 token에서 보고한다. */
    if (next != NULL && !str_eqc(*next, "and") && !str_eqc(*next, "or") && !str_eqc(*next, ")")) {
        fail(p, fmt("`%S` is not allowed here", *next));
    }
    fail_at(p, left.column, fmt("`%S` alone is not a predicate", left.text));
}

static enode *group(xparser *p)
{
    if (peek_is(p, 0, "(")) {
        p->at++;
        enode *inner = disjunction(p);
        expect(p, ")");
        return inner;
    }
    return predicate(p);
}

static enode *conjunction(xparser *p)
{
    enode *left = group(p);
    while (peek_is(p, 0, "and")) {
        p->at++;
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_AND;
        n->l = left;
        n->r = group(p);
        left = n;
    }
    return left;
}

static enode *disjunction(xparser *p)
{
    enode *left = conjunction(p);
    while (peek_is(p, 0, "or")) {
        p->at++;
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_OR;
        n->l = left;
        n->r = conjunction(p);
        left = n;
    }
    return left;
}

static str operand_text(xparser *p, const operand *o)
{
    return o->kind == OP_COLUMN ? o->text : p->literals.v[o->literal];
}

static str node_text(xparser *p, const enode *n)
{
    switch (n->kind) {
        case N_AND:
        case N_OR: {
            const char *op = n->kind == N_AND ? " and " : " or ";
            sbuf b = {0};
            const enode *sides[2] = {n->l, n->r};
            for (int i = 0; i < 2; i++) {
                if (i > 0) {
                    sb_c(&b, op);
                }
                str t = node_text(p, sides[i]);
                if (n->kind == N_AND && sides[i]->kind == N_OR) {
                    sb_fmt(&b, "(%S)", t);
                } else {
                    sb_s(&b, t);
                }
            }
            return sb_str(&b);
        }
        case N_COMPARE:
            return fmt("%S %S %S", operand_text(p, &n->left), n->op, operand_text(p, &n->right));
        case N_IN: {
            sbuf b = {0};
            sb_s(&b, operand_text(p, &n->left));
            sb_c(&b, n->negated ? " not in (" : " in (");
            for (size_t i = 0; i < n->list.n; i++) {
                if (i > 0) {
                    sb_c(&b, ", ");
                }
                sb_s(&b, operand_text(p, &n->list.v[i]));
            }
            sb_ch(&b, ')');
            return sb_str(&b);
        }
        default:
            return fmt("%S%s", operand_text(p, &n->left), n->negated ? " is not null" : " is null");
    }
}

static bool is_bool(const operand *o)
{
    if (o->kind == OP_COLUMN) {
        return o->col != NULL && str_eqc(o->col->type->name, "bool");
    }
    return str_eqc(o->text, "true") || str_eqc(o->text, "false");
}

static bool usable(xparser *p, const operand *o, foundv *f)
{
    if (o->kind == OP_LITERAL) {
        return true;
    }
    if (o->col == NULL) {
        PUSH(*f, ((found){o->column, fmt("`%S` is not a column of the table", o->text)}));
        return false;
    }
    str *fk = smap_get(p->action, o->text);
    if (fk != NULL) {
        PUSH(*f, ((found){o->column, fmt("`%S` is a column of foreign key `%S` with cascade or set_null", o->text, *fk)}));
        return false;
    }
    if (str_eqc(o->col->type->name, "bytes")) {
        PUSH(*f, ((found){o->column, fmt("`%S` is a bytes column, which a check cannot use", o->text)}));
        return false;
    }
    return !str_eqc(o->col->type->name, "invalid");
}

static bool text_type(const ctype *t)
{
    return str_eqc(t->name, "varchar") || str_eqc(t->name, "text");
}

static bool columns_meet(const ctype *a, const ctype *b)
{
    if (ctype_integer(a) || ctype_integer(b)) {
        return ctype_integer(a) && ctype_integer(b);
    }
    if (text_type(a) || text_type(b)) {
        return text_type(a) && text_type(b);
    }
    if (str_eqc(a->name, "decimal")) {
        return str_eqc(b->name, "decimal") && a->p[1] == b->p[1];
    }
    return ctype_same(a, b);
}

static void meet(xparser *p, const operand *left, const operand *right, foundv *f)
{
    bool left_usable = usable(p, left, f);
    if (!usable(p, right, f) || !left_usable) {
        return;
    }
    if (left->kind == OP_COLUMN && right->kind == OP_COLUMN) {
        const ctype *a = left->col->type, *b = right->col->type;
        if (!columns_meet(a, b)) {
            PUSH(*f, ((found){right->column, fmt("`%S` of %S does not meet `%S` of %S", right->text, ctype_text(b), left->text, ctype_text(a))}));
        }
        return;
    }
    const operand *col = left->kind == OP_COLUMN ? left : right;
    const operand *lit = left->kind == OP_COLUMN ? right : left;
    const ctype *type = col->col->type;
    /* text column은 길이 한도 없는 varchar 형식을 받는다. */
    zend_long unlimited = ZEND_LONG_MAX;
    const ctype *literal_type = str_eqc(type->name, "text") ? ctype_new(SL("varchar"), &unlimited, 1) : type;
    str canonical, problem;
    if (!literal_column_default(literal_type, lit->text, &canonical, &problem)) {
        PUSH(*f, ((found){lit->column, fmt("`%S` does not meet `%S` of %S: %S", lit->text, col->text, ctype_text(type), problem)}));
        return;
    }
    p->literals.v[lit->literal] = canonical;
}

static void check_types(xparser *p)
{
    foundv f = {0};
    for (size_t i = 0; i < p->predicates.n; i++) {
        enode *n = p->predicates.v[i];
        switch (n->kind) {
            case N_COMPARE:
                if (ordering(n->op) && (is_bool(&n->left) || is_bool(&n->right))) {
                    PUSH(f, ((found){n->op_at, fmt("a bool operand takes only =, <> and in, found `%S`", n->op)}));
                }
                meet(p, &n->left, &n->right, &f);
                break;
            case N_IN:
                if (usable(p, &n->left, &f)) {
                    for (size_t k = 0; k < n->list.n; k++) {
                        meet(p, &n->left, &n->list.v[k], &f);
                    }
                }
                break;
            case N_NULL:
                usable(p, &n->left, &f);
                break;
        }
    }
    if (f.n == 0) {
        return;
    }
    found first = f.v[0];
    for (size_t i = 0; i < f.n; i++) {
        if (f.v[i].at < first.at) {
            first = f.v[i];
        }
    }
    PUSH(*p->errors, mkdiag(SL("check"), p->line, first.at, first.message));
}

bool expression_parse(const tokens *t, zend_long line, zend_long end, const smap *columns, const smap *action, str *text, diags *errors)
{
    xparser *p = dbs_alloc(sizeof *p);
    p->t = t;
    p->line = line;
    p->end = end;
    p->columns = columns;
    p->action = action;
    p->errors = errors;
    size_t before = errors->n;
    enode *tree;
    if (setjmp(p->stop) != 0) {
        return false;
    }
    tree = disjunction(p);
    expect(p, ")");
    if (p->at < t->n) {
        fail(p, SL("a check predicate ends with its closing parenthesis"));
    }
    check_types(p);
    if (errors->n != before) {
        return false;
    }
    *text = node_text(p, tree);
    return true;
}
