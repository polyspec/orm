/*
 * Reads a check predicate, checks the operand types, then writes canonical text (PHP client Expression). First, the predicate is
 * read: a token outside the format, or a literal where a column is needed, stops with one diagnostic and the column is not checked.
 * A predicate read to the end reports the first column or type diagnostic in source order. The tree has no parentheses, and emission
 * writes only the parentheses that an `or` inside `and` needs.
 */
#include "dbspec.h"
#include "dbspec_str_list.h"
#include <setjmp.h>

enum { OP_COLUMN, OP_LITERAL };

typedef struct {
    int kind;
    str text;
    zend_long column;
    column *col;
    size_t literal;
    /* The source text of a literal: a string keeps its quotes, a '-' and a number are joined (Go's token.describe). */
    str source;
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
    str table;
    /* Class of a read token, "line:index" => class (same as parse's marks). */
    smap *marks;
    size_t at;
    strs literals;
    diags *errors;
    VEC(enode *) predicates;
    jmp_buf stop;
} xparser;

typedef struct {
    zend_long at;
    str message;
    const char *rule; /* NULL means check */
} found;

#define FOUND(at, message) ((found){(at), (message), NULL})

typedef VEC(found) foundv;

static const char *const comparisons[] = {"=", "<>", "<", "<=", ">", ">=", NULL};
static const char *const keywords[] = {"and", "or", "not", "in", "between", "is", "null", "true", "false", NULL};

static bool ordering(str s)
{
    return str_eqc(s, "<") || str_eqc(s, "<=") || str_eqc(s, ">") || str_eqc(s, ">=");
}

/* Gives a class to the token read. */
static void mark_at(xparser *p, size_t at, const char *class)
{
    const token *t = &p->t->v[at];
    if (p->marks == NULL || t->line == 0) {
        return;
    }
    smap_set(p->marks, fmt("%d:%d", (int)t->line, (int)t->index), (void *)class);
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

/* Go's expressionParser.fail: the token at the reader, or the check's closing parenthesis at the end, with the reason. */
static ZEND_NORETURN void fail(xparser *p, const char *reason)
{
    if (p->at >= p->t->n) {
        fail_at(p, p->end, SL("check expression ends early"));
    }
    fail_at(p, position(p), fmt("%S %s in a check expression", dbs_describe(p->t->v[p->at].text), reason));
}

static bool number_token(str s)
{
    return str_digits(s) || str_decimal(s);
}

static bool string_token(str s)
{
    return s.n >= 2 && s.s[0] == '\'' && s.s[s.n - 1] == '\'';
}

static enode *disjunction(xparser *p);

/* Go's literal: a number, a '-' and a number, a string, true or false. */
static bool literal(xparser *p, operand *out)
{
    const str *token = peek(p, 0);
    if (token == NULL) {
        return false;
    }
    zend_long column = position(p);
    str text;
    if (number_token(*token) || string_token(*token)) {
        text = *token;
        p->at++;
    } else if (str_eqc(*token, "-") && p->at + 1 < p->t->n && number_token(p->t->v[p->at + 1].text)) {
        text = fmt("-%S", p->t->v[p->at + 1].text);
        p->at += 2;
    } else if (str_eqc(*token, "true") || str_eqc(*token, "false")) {
        text = *token;
        mark_at(p, p->at, "keyword");
        p->at++;
    } else {
        return false;
    }
    PUSH(p->literals, text);
    *out = (operand){OP_LITERAL, text, column, NULL, p->literals.n - 1, text};
    return true;
}

/* Go's operand: a literal or a column; arithmetic, functions and the keywords are not operands. */
static operand xoperand(xparser *p)
{
    operand o;
    if (literal(p, &o)) {
        return o;
    }
    if (p->at >= p->t->n) {
        fail(p, "");
    }
    str token = p->t->v[p->at].text;
    if (!str_dotted(token) || number_token(token) || dbspec_str_in_list(token, keywords)) {
        fail(p, "is not allowed here");
    }
    if (peek_is(p, 1, "(")) {
        fail(p, "is a function; check predicates have no functions");
    }
    o = (operand){OP_COLUMN, token, position(p), smap_get(p->columns, token), 0, token};
    mark_at(p, p->at, "name");
    p->at++;
    return o;
}

/* An operand not followed by a comparison, in, or is: followed by and, or, ), or the end, it is reported at the operand; otherwise
 * at the following token. */
static ZEND_NORETURN void alone(xparser *p, const operand *o)
{
    const str *next = peek(p, 0);
    if (next != NULL && !str_eqc(*next, "and") && !str_eqc(*next, "or") && !str_eqc(*next, ")")) {
        fail(p, "is not allowed here");
    }
    fail_at(p, o->column, fmt("%S alone is not a predicate", dbs_describe(o->source)));
}

static enode *predicate(xparser *p)
{
    operand left = xoperand(p);
    const str *next = peek(p, 0);
    if (next == NULL) {
        alone(p, &left);
    }
    if (dbspec_str_in_list(*next, comparisons)) {
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_COMPARE;
        n->op = *next;
        n->op_at = position(p);
        p->at++;
        n->left = left;
        n->right = xoperand(p);
        if (left.kind == OP_LITERAL && n->right.kind == OP_LITERAL) {
            fail_at(p, left.column, fmt("%S is compared with a literal; a comparison needs a column", dbs_describe(left.source)));
        }
        PUSH(p->predicates, n);
        return n;
    }
    bool not_in = str_eqc(*next, "not") && peek_is(p, 1, "in");
    if (left.kind == OP_LITERAL && (str_eqc(*next, "is") || str_eqc(*next, "in") || not_in)) {
        fail_at(p, left.column, fmt("%S is not a column", dbs_describe(left.source)));
    }
    if (str_eqc(*next, "is")) {
        mark_at(p, p->at, "keyword");
        p->at++;
        bool is_not = peek_is(p, 0, "not");
        if (is_not) {
            mark_at(p, p->at, "keyword");
            p->at++;
        }
        if (!peek_is(p, 0, "null")) {
            fail(p, "is not allowed here; expected null");
        }
        mark_at(p, p->at, "keyword");
        p->at++;
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_NULL;
        n->left = left;
        n->negated = is_not;
        PUSH(p->predicates, n);
        return n;
    }
    if (not_in) {
        mark_at(p, p->at, "keyword");
        p->at++;
    }
    if (peek_is(p, 0, "in")) {
        mark_at(p, p->at, "keyword");
        p->at++;
        if (!peek_is(p, 0, "(")) {
            fail(p, "is not allowed here; expected (");
        }
        p->at++;
        enode *n = dbs_alloc(sizeof *n);
        n->kind = N_IN;
        n->left = left;
        n->negated = not_in;
        for (;;) {
            operand l;
            if (!literal(p, &l)) {
                fail(p, "is not a literal");
            }
            PUSH(n->list, l);
            if (peek_is(p, 0, ")")) {
                p->at++;
                break;
            }
            if (!peek_is(p, 0, ",")) {
                fail(p, "is not allowed here; expected , or )");
            }
            p->at++;
        }
        PUSH(p->predicates, n);
        return n;
    }
    alone(p, &left);
}

static enode *group(xparser *p)
{
    if (peek_is(p, 0, "(")) {
        p->at++;
        enode *inner = disjunction(p);
        if (!peek_is(p, 0, ")")) {
            fail(p, "is not allowed here; expected )");
        }
        p->at++;
        return inner;
    }
    return predicate(p);
}

static enode *conjunction(xparser *p)
{
    enode *left = group(p);
    while (peek_is(p, 0, "and")) {
        mark_at(p, p->at, "keyword");
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
        mark_at(p, p->at, "keyword");
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

static bool bool_literal(const operand *o)
{
    return o->kind == OP_LITERAL && (str_eqc(o->text, "true") || str_eqc(o->text, "false"));
}

/* Go's checkTyper.column: the column of an operand, or NULL after an unknown column, a column of a cascade or set_null foreign key and
 * a bytes column (reported), and for a column whose type is wrong or whose line failed. */
static column *usable(xparser *p, const operand *o, foundv *f)
{
    if (o->col == NULL) {
        /* Go's ref: a reference in the wrong format reports its name rule and is not resolved. */
        const char *rule;
        str message;
        if (name_rule(o->text, &rule, &message)) {
            PUSH(*f, ((found){o->column, message, rule}));
        } else {
            PUSH(*f, FOUND(o->column, fmt("column %S is not a column of table %S", dbs_quote(o->text), dbs_quote(p->table))));
        }
        return NULL;
    }
    if (smap_get(p->action, o->text) != NULL) {
        PUSH(*f, FOUND(o->column, fmt("column %S belongs to a foreign key with cascade or set_null", dbs_quote(o->text))));
        return NULL;
    }
    if (str_eqc(o->col->type->name, "invalid")) {
        return NULL;
    }
    if (str_eqc(o->col->type->name, "bytes")) {
        PUSH(*f, FOUND(o->column, fmt("bytes column %S cannot be part of a check", dbs_quote(o->text))));
        return NULL;
    }
    return o->col;
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

/* Go's checkTyper.literal: the literal in the canonical default form of a column of the type. A text column takes the varchar form with
 * no length limit. */
static void literal_meets(xparser *p, const operand *lit, const ctype *type, foundv *f)
{
    zend_long unlimited = ZEND_LONG_MAX;
    const ctype *literal_type = str_eqc(type->name, "text") ? ctype_new(SL("varchar"), &unlimited, 1) : type;
    str canonical, problem;
    if (!literal_column_default(literal_type, lit->text, &canonical, &problem)) {
        PUSH(*f, FOUND(lit->column, fmt("%S is not a %S value", dbs_describe(lit->source), ctype_text(type))));
        return;
    }
    p->literals.v[lit->literal] = canonical;
}

/* Go's checkTyper.comparison. */
static void comparison(xparser *p, const enode *n, foundv *f)
{
    const operand *left = &n->left, *right = &n->right;
    column *lc = left->kind == OP_COLUMN ? usable(p, left, f) : NULL;
    column *rc = right->kind == OP_COLUMN ? usable(p, right, f) : NULL;
    if ((left->kind == OP_COLUMN && lc == NULL) || (right->kind == OP_COLUMN && rc == NULL)) {
        return;
    }
    const column *typed = lc != NULL ? lc : rc;
    if (ordering(n->op) && (str_eqc(typed->type->name, "bool") || bool_literal(left) || bool_literal(right))) {
        PUSH(*f, FOUND(n->op_at, fmt("%S does not order bool values", n->op)));
    }
    if (lc != NULL && rc != NULL) {
        if (!columns_meet(lc->type, rc->type)) {
            PUSH(*f, FOUND(right->column, fmt("column %S is %S and does not meet %S", dbs_quote(right->text), ctype_text(rc->type), ctype_text(lc->type))));
        }
    } else if (lc != NULL) {
        literal_meets(p, right, lc->type, f);
    } else {
        literal_meets(p, left, rc->type, f);
    }
}

static zend_long found_rank(const found *x)
{
    return dbs_rule_rank(x->rule != NULL ? str_c(x->rule) : SL("check"));
}

static void check_types(xparser *p)
{
    foundv f = {0};
    for (size_t i = 0; i < p->predicates.n; i++) {
        enode *n = p->predicates.v[i];
        switch (n->kind) {
            case N_COMPARE:
                comparison(p, n, &f);
                break;
            case N_IN: {
                column *c = usable(p, &n->left, &f);
                for (size_t k = 0; c != NULL && k < n->list.n; k++) {
                    literal_meets(p, &n->list.v[k], c->type, &f);
                }
                break;
            }
            case N_NULL:
                usable(p, &n->left, &f);
                break;
        }
    }
    if (f.n == 0) {
        return;
    }
    /* The first in source order (Go's sortDiagnostics: column, then the rule table, then the order found). */
    found first = f.v[0];
    for (size_t i = 1; i < f.n; i++) {
        if (f.v[i].at < first.at || (f.v[i].at == first.at && found_rank(&f.v[i]) < found_rank(&first))) {
            first = f.v[i];
        }
    }
    PUSH(*p->errors, mkdiag(first.rule != NULL ? str_c(first.rule) : SL("check"), p->line, first.at, first.message));
}

bool expression_parse(const tokens *t, zend_long line, zend_long end, str table, const smap *columns, const smap *action, str *text, diags *errors, smap *marks)
{
    xparser *p = dbs_alloc(sizeof *p);
    p->table = table;
    p->marks = marks;
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
    if (p->at < t->n) {
        fail(p, "is not allowed here");
    }
    check_types(p);
    if (errors->n != before) {
        return false;
    }
    *text = node_text(p, tree);
    return true;
}
