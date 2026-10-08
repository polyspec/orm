/*
 * plan diff의 step을 한 dialect로 쓴다. 각 step은 rollback statement와 효과를 가진다(PHP client PlanSteps,
 * docs/plans.md "Steps").
 */
#include "dbspec.h"
#include "plandiff.h"
#include "ext/spl/spl_exceptions.h"

#define IRREVERSIBLE_PRECISION "narrowing the precision rounds the values written since"
#define REBUILD_TABLE "dbspec$rebuild"

typedef struct {
    pdiff *d;
    renderer r;
    str hold_prefix;
    planstepv out;
    smap rebuilt;      /* SQLite에서 다시 만드는 target table */
    smap holds;        /* 보관 이름: "table.column", table, "+table.column" => str* */
    strs hold_order;
} writer;

static effect present(const char *kind, str table, str name)
{
    return (effect){str_c(kind), table, name, true};
}

static effect absent(const char *kind, str table, str name)
{
    return (effect){str_c(kind), table, name, false};
}

static effect repeat_effect(void)
{
    return (effect){SL("repeat"), SL(""), SL(""), true};
}

static planstep step(str statement, str rollback, str irreversible, effect e)
{
    planstep s = {0};
    s.statement = statement;
    s.rollback = rollback;
    s.irreversible = irreversible;
    s.effect = e;
    s.restore = SL("");
    s.rollback_restore = SL("");
    return s;
}

static void add(writer *w, planstep s)
{
    PUSH(w->out, s);
}

static str q(writer *w, str name)
{
    return r_q(&w->r, name);
}

static str hold(writer *w, str key)
{
    str *h = smap_get(&w->holds, key);
    if (h == NULL) {
        zend_throw_exception_ex(spl_ce_LogicException, 0, "No holding name for %s", str_of(key.s, key.n).s);
        return SL("");
    }
    return *h;
}

static str tbl_of(writer *w, str name)
{
    str *s = smap_get(&w->d->table_of, name);
    return s == NULL ? name : *s;
}

static table *src_of(writer *w, str name)
{
    return smap_get(&w->d->source, tbl_of(w, name));
}

static table *tgt_of(writer *w, str name)
{
    return smap_get(&w->d->target, name);
}

static strs *list_of(const smap *m, str key)
{
    return smap_get(m, key);
}

static void number_holds(writer *w)
{
    pdiff *d = w->d;
    size_t n = 0;
#define NEXT(key) do { n++; str k_ = (key); smap_set(&w->holds, k_, str_ptr(fmt("%S%u", w->hold_prefix, n))); PUSH(w->hold_order, k_); } while (0)
    for (size_t i = 0; i < d->matched.n; i++) {
        strs *removed = list_of(&d->removed, d->matched.v[i]);
        for (size_t k = 0; removed != NULL && k < removed->n; k++) {
            NEXT(fmt("%S.%S", tbl_of(w, d->matched.v[i]), removed->v[k]));
        }
    }
    for (size_t i = 0; i < d->dropped.n; i++) {
        NEXT(d->dropped.v[i]);
    }
    for (size_t i = 0; i < d->matched.n; i++) {
        strs *added = list_of(&d->added, d->matched.v[i]);
        for (size_t k = 0; added != NULL && k < added->n; k++) {
            NEXT(fmt("+%S.%S", d->matched.v[i], added->v[k]));
        }
    }
#undef NEXT
}

static column *column_must(const table *t, str name)
{
    column *c = table_column(t, name);
    if (c == NULL) {
        zend_throw_exception_ex(spl_ce_LogicException, 0, "Table %s has no column %s", str_of(t->name.s, t->name.n).s, str_of(name.s, name.n).s);
        static column none;
        static ctype invalid = {{"invalid", 7}, NULL, 0};
        none.type = &invalid;
        return &none;
    }
    return c;
}

/* source table의 target 이름이다. 지우는 table은 source 이름 그대로다. */
static str target_name(writer *w, str source)
{
    SMAP_EACH(&w->d->table_of, i) {
        if (str_eq(*(str *)w->d->table_of.e[i].val, source)) {
            return w->d->table_of.e[i].key;
        }
    }
    return source;
}

static str rename_column_sql(writer *w, str table, str from, str to)
{
    return fmt("ALTER TABLE %S RENAME COLUMN %S TO %S", q(w, table), q(w, from), q(w, to));
}

/* SQLite가 table을 다시 만들어야 하는지: 이름, column, foreign key, check 중 하나라도 바뀌면 그렇다. */
static bool sqlite_rebuilds(writer *w, str name)
{
    pdiff *d = w->d;
    if (!str_eq(tbl_of(w, name), name) || smap_has(&d->added, name) || smap_has(&d->removed, name) || smap_has(&d->altered, name)) {
        return true;
    }
    for (size_t i = 0; i < d->renamed_columns.n; i++) {
        if (str_eq(d->renamed_columns.v[i].table, name)) {
            return true;
        }
    }
    objrefv *lists[2] = {smap_get(&d->drop_objects, tbl_of(w, name)), smap_get(&d->add_objects, name)};
    for (int l = 0; l < 2; l++) {
        for (size_t i = 0; lists[l] != NULL && i < lists[l]->n; i++) {
            str kind = lists[l]->v[i].kind;
            if (str_eqc(kind, "foreign_key") || str_eqc(kind, "check")) {
                return true;
            }
        }
    }
    return false;
}

/* source column c를 non-null로 되돌리는 rollback의 null 검사다. */
static nullcheck null_check(writer *w, str table, str column_name, const column *c)
{
    nullcheck n = {table, column_name, c->has_default, SL("")};
    if (c->has_default) {
        n.def = r_default_text(&w->r, c->type, c->def);
    }
    return n;
}

static bool precision_grows(const ctype *from, const ctype *to)
{
    return (str_eqc(to->name, "time") || str_eqc(to->name, "datetime")) && str_eq(to->name, from->name) && to->p[0] > from->p[0];
}

/* MySQL과 PostgreSQL에서 지우는 column을 nullable로 바꾸고 보관 이름으로 숨긴다. */
static void hide_column(writer *w, str table, const column *c, str h)
{
    if (!c->nullable) {
        column *nullable = column_new(c->name, c->type, true, c->identity, c->has_default ? &c->def : NULL);
        nullcheckv checks = {0};
        PUSH(checks, null_check(w, table, h, c));
        planstep s;
        if (w->r.d == D_MYSQL) {
            s = step(fmt("ALTER TABLE %S MODIFY COLUMN %S", q(w, table), r_column(&w->r, nullable)),
                fmt("ALTER TABLE %S MODIFY COLUMN %S", q(w, table), r_column(&w->r, c)), SL(""), repeat_effect());
        } else {
            str prefix = fmt("ALTER TABLE %S ALTER COLUMN %S", q(w, table), q(w, c->name));
            s = step(fmt("%S DROP NOT NULL", prefix), fmt("%S SET NOT NULL", prefix), SL(""), repeat_effect());
        }
        s.null_checks = checks;
        add(w, s);
    }
    add(w, step(rename_column_sql(w, table, c->name, h), rename_column_sql(w, table, h, c->name), SL(""), present("column", table, h)));
}

static str drop_check_sql(writer *w, str table, str name)
{
    return fmt("ALTER TABLE %S%s%S", q(w, table), w->r.d == D_MYSQL ? " DROP CHECK " : " DROP CONSTRAINT ", q(w, name));
}

static void drop_renderer_check(writer *w, str table, str name, str expression)
{
    add(w, step(drop_check_sql(w, table, name), fmt("ALTER TABLE %S ADD CONSTRAINT %S CHECK (%S)", q(w, table), q(w, name), expression),
        SL(""), absent("constraint", table, name)));
}

static str drop_index_sql(writer *w, str table, str name)
{
    return w->r.d == D_MYSQL ? fmt("DROP INDEX %S ON %S", q(w, name), q(w, table)) : fmt("DROP INDEX %S", q(w, name));
}

typedef struct {
    str name, create, drop;
} indexsql;

typedef VEC(indexsql) indexsqlv;

static int cmp_ukey_name(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(ukey *const *)a)->name, (*(ukey *const *)b)->name);
}

static int cmp_index_name(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(xindex *const *)a)->name, (*(xindex *const *)b)->name);
}

static int cmp_fkey_name(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(fkey *const *)a)->name, (*(fkey *const *)b)->name);
}

/* table t를 name으로 둔 unique key와 index를 renderer 순서로 [이름, 만드는 statement, 지우는 statement]로 돌려준다. */
static indexsqlv index_sqls(writer *w, const table *t, str name)
{
    indexsqlv out = {0};
    if (w->r.d == D_SQLITE) {
        ukey **u = dbs_alloc(sizeof(ukey *) * (t->uniques.n + 1));
        memcpy(u, t->uniques.v, sizeof(ukey *) * t->uniques.n);
        dbs_sort(u, t->uniques.n, sizeof(ukey *), cmp_ukey_name, NULL);
        for (size_t i = 0; i < t->uniques.n; i++) {
            PUSH(out, ((indexsql){u[i]->name, fmt("CREATE UNIQUE INDEX %S ON %S (%S)", q(w, u[i]->name), q(w, name), r_list(&w->r, &u[i]->columns)),
                drop_index_sql(w, name, u[i]->name)}));
        }
    }
    xindex **x = dbs_alloc(sizeof(xindex *) * (t->indexes.n + 1));
    memcpy(x, t->indexes.v, sizeof(xindex *) * t->indexes.n);
    dbs_sort(x, t->indexes.n, sizeof(xindex *), cmp_index_name, NULL);
    for (size_t i = 0; i < t->indexes.n; i++) {
        PUSH(out, ((indexsql){x[i]->name, fmt("CREATE INDEX %S ON %S (%S)", q(w, x[i]->name), q(w, name), r_index_columns(&w->r, x[i])),
            drop_index_sql(w, name, x[i]->name)}));
    }
    return out;
}

/* renderer가 CREATE TABLE 뒤에 쓰는 unique index와 index다. */
static void create_indexes(writer *w, const table *t, str name)
{
    indexsqlv l = index_sqls(w, t, name);
    for (size_t i = 0; i < l.n; i++) {
        add(w, step(l.v[i].create, l.v[i].drop, SL(""), present("index", name, l.v[i].name)));
    }
}

/* table t(name으로 둔)의 객체를 더하는 statement, 지우는 statement, 효과의 종류다. */
static void object_sqls(writer *w, const table *t, str name, objref o, str *create, str *drop, const char **kind)
{
    dialect dl = w->r.d;
    if (str_eqc(o.kind, "unique")) {
        ukey *u = find_ukey(t, o.name);
        if (dl == D_SQLITE) {
            *create = fmt("CREATE UNIQUE INDEX %S ON %S (%S)", q(w, u->name), q(w, name), r_list(&w->r, &u->columns));
            *drop = drop_index_sql(w, name, u->name);
            *kind = "index";
            return;
        }
        *create = fmt("ALTER TABLE %S ADD CONSTRAINT %S UNIQUE (%S)", q(w, name), q(w, u->name), r_list(&w->r, &u->columns));
        if (dl == D_MYSQL) {
            *drop = fmt("ALTER TABLE %S DROP INDEX %S", q(w, name), q(w, u->name));
            *kind = "index";
            return;
        }
        *drop = fmt("ALTER TABLE %S DROP CONSTRAINT %S", q(w, name), q(w, u->name));
        *kind = "constraint";
        return;
    }
    if (str_eqc(o.kind, "index")) {
        xindex *x = find_index(t, o.name);
        *create = fmt("CREATE INDEX %S ON %S (%S)", q(w, x->name), q(w, name), r_index_columns(&w->r, x));
        *drop = drop_index_sql(w, name, x->name);
        *kind = "index";
        return;
    }
    if (str_eqc(o.kind, "check")) {
        check *k = find_check(t, o.name);
        *create = fmt("ALTER TABLE %S ADD CONSTRAINT %S CHECK (%S)", q(w, name), q(w, k->name), r_check_text(&w->r, t, k));
        *drop = drop_check_sql(w, name, k->name);
        *kind = "constraint";
        return;
    }
    if (str_eqc(o.kind, "foreign_key")) {
        fkey *f = find_fkey(t, o.name);
        *drop = fmt("ALTER TABLE %S%s%S", q(w, name), dl == D_MYSQL ? " DROP FOREIGN KEY " : " DROP CONSTRAINT ", q(w, f->name));
        *create = fmt("ALTER TABLE %S ADD %S", q(w, name), r_foreign_key(&w->r, f));
        *kind = "constraint";
        return;
    }
    zend_throw_exception_ex(spl_ce_LogicException, 0, "Unknown object kind %s", str_of(o.kind.s, o.kind.n).s);
    *create = *drop = SL("");
    *kind = "constraint";
}

/* source table t의 객체를 지우고, rollback은 source 정의로 다시 만든다. */
static void drop_object(writer *w, const table *t, objref o)
{
    str create, drop;
    const char *kind;
    object_sqls(w, t, t->name, o, &create, &drop, &kind);
    add(w, step(drop, create, SL(""), absent(kind, t->name, o.name)));
}

static void add_object(writer *w, str table, objref o)
{
    str create, drop;
    const char *kind;
    object_sqls(w, tgt_of(w, table), table, o, &create, &drop, &kind);
    add(w, step(create, drop, SL(""), present(kind, table, o.name)));
}

/* table의 renderer CHECK 이름과 식이다. */
static smap renderer_checks(writer *w, const table *t)
{
    smap out = {0};
    for (size_t i = 0; i < t->columns.n; i++) {
        str check = r_type_check(&w->r, t->columns.v[i]);
        if (check.n > 0) {
            smap_set(&out, fmt("%S$%S", t->name, t->columns.v[i]->name), str_ptr(check));
        }
    }
    return out;
}

typedef struct {
    str name, create, function;
} triggerpart;

typedef VEC(triggerpart) triggerpartv;

/* 렌더링한 trigger statement에서 trigger 이름, CREATE TRIGGER와 PostgreSQL function을 짝짓는다. */
static triggerpartv trigger_parts(writer *w, const table *t)
{
    triggerpartv out = {0};
    str function = SL("");
    strs statements = r_triggers(&w->r, t);
    for (size_t i = 0; i < statements.n; i++) {
        str s = statements.v[i];
        if (str_starts(s, "CREATE FUNCTION ")) {
            function = s;
            continue;
        }
        str rest = str_sub(s, strlen("CREATE TRIGGER "), s.n - strlen("CREATE TRIGGER "));
        ssize_t space = str_find(rest, " ", 0);
        str quoted = str_sub(rest, 0, space < 0 ? 0 : (size_t)space);
        PUSH(out, ((triggerpart){quoted.n >= 2 ? str_sub(quoted, 1, quoted.n - 2) : SL(""), s, function}));
        function = SL("");
    }
    return out;
}

static void drop_triggers(writer *w, const table *t)
{
    triggerpartv parts = trigger_parts(w, t);
    for (size_t i = 0; i < parts.n; i++) {
        triggerpart *p = &parts.v[i];
        if (w->r.d == D_POSTGRES) {
            add(w, step(fmt("DROP TRIGGER %S ON %S", q(w, p->name), q(w, t->name)), p->create, SL(""), absent("trigger", t->name, p->name)));
            add(w, step(fmt("DROP FUNCTION %S()", q(w, p->name)), p->function, SL(""), absent("function", SL(""), p->name)));
            continue;
        }
        add(w, step(fmt("DROP TRIGGER %S", q(w, p->name)), p->create, SL(""), absent("trigger", t->name, p->name)));
    }
}

static void create_triggers(writer *w, const table *t)
{
    triggerpartv parts = trigger_parts(w, t);
    for (size_t i = 0; i < parts.n; i++) {
        triggerpart *p = &parts.v[i];
        if (w->r.d == D_POSTGRES) {
            add(w, step(p->function, fmt("DROP FUNCTION %S()", q(w, p->name)), SL(""), present("function", SL(""), p->name)));
            add(w, step(p->create, fmt("DROP TRIGGER %S ON %S", q(w, p->name), q(w, t->name)), SL(""), present("trigger", t->name, p->name)));
            continue;
        }
        add(w, step(p->create, fmt("DROP TRIGGER %S", q(w, p->name)), SL(""), present("trigger", t->name, p->name)));
    }
}

/* SQLite 다시 만들기에서 source 값을 target column 형식으로 옮기는 식이다. 늘어난 소수 자리는 0으로 채운다. */
static str copy_value(writer *w, const column *from, const column *to)
{
    str qn = q(w, to->name);
    if (precision_grows(from->type, to->type)) {
        str pad = str_repeat("0", (size_t)(to->type->p[0] - from->type->p[0]));
        if (from->type->p[0] == 0) {
            pad = fmt(".%S", pad);
        }
        return fmt("%S || '%S'", qn, pad);
    }
    return qn;
}

typedef struct {
    const pdiff *d;
    str target;
} colmap;

/* target table의 column 중 source column c를 가리키는 것, 없으면 c다. */
static str target_column(const pdiff *d, str table, str c)
{
    smap *m = smap_get(&d->column_of, table);
    if (m != NULL) {
        SMAP_EACH(m, i) {
            if (str_eq(*(str *)m->e[i].val, c)) {
                return m->e[i].key;
            }
        }
    }
    return c;
}

static str rename_in(void *ctx, str c)
{
    colmap *m = ctx;
    return target_column(m->d, m->target, c);
}

/* target table name의 source table에 이름 바꾸기를 적용한 정의다. 지우는 table을 참조하는 foreign key는 source 이름을 유지한다. */
static table *renamed_source(writer *w, str name)
{
    pdiff *d = w->d;
    const table *src = src_of(w, name);
    colmap self = {d, name};
    table *t = table_new(name);
    for (size_t i = 0; i < src->columns.n; i++) {
        const column *c = src->columns.v[i];
        PUSH(t->columns, column_new(target_column(d, name, c->name), c->type, c->nullable, c->identity, c->has_default ? &c->def : NULL));
    }
    t->pk = dbs_alloc(sizeof(pkey));
    if (src->pk != NULL) {
        for (size_t i = 0; i < src->pk->columns.n; i++) {
            PUSH(t->pk->columns, rename_in(&self, src->pk->columns.v[i]));
        }
    }
    for (size_t i = 0; i < src->uniques.n; i++) {
        ukey *u = dbs_alloc(sizeof *u);
        u->name = src->uniques.v[i]->name;
        for (size_t k = 0; k < src->uniques.v[i]->columns.n; k++) {
            PUSH(u->columns, rename_in(&self, src->uniques.v[i]->columns.v[k]));
        }
        PUSH(t->uniques, u);
    }
    for (size_t i = 0; i < src->indexes.n; i++) {
        xindex *x = dbs_alloc(sizeof *x);
        x->name = src->indexes.v[i]->name;
        for (size_t k = 0; k < src->indexes.v[i]->columns.n; k++) {
            icol c = src->indexes.v[i]->columns.v[k];
            PUSH(x->columns, ((icol){rename_in(&self, c.name), c.descending}));
        }
        PUSH(t->indexes, x);
    }
    for (size_t i = 0; i < src->fks.n; i++) {
        const fkey *f = src->fks.v[i];
        /* array_flip($d->tableOf): 같은 source를 가리키는 target이 여럿이면 마지막 것이다. */
        str parent = f->table;
        SMAP_EACH(&d->table_of, k) {
            if (str_eq(*(str *)d->table_of.e[k].val, f->table)) {
                parent = d->table_of.e[k].key;
            }
        }
        fkey *g = dbs_alloc(sizeof *g);
        g->name = f->name;
        for (size_t k = 0; k < f->columns.n; k++) {
            PUSH(g->columns, rename_in(&self, f->columns.v[k]));
        }
        g->table = parent;
        colmap up = {d, parent};
        for (size_t k = 0; k < f->refs.n; k++) {
            PUSH(g->refs, rename_in(&up, f->refs.v[k]));
        }
        g->on_delete = f->on_delete;
        g->on_update = f->on_update;
        PUSH(t->fks, g);
    }
    for (size_t i = 0; i < src->checks.n; i++) {
        check *k = dbs_alloc(sizeof *k);
        k->name = src->checks.v[i]->name;
        k->expression = check_text_renamed(src->checks.v[i]->expression, rename_in, &self);
        PUSH(t->checks, k);
    }
    return t;
}

typedef struct {
    str table;
} checkname_ctx;

static str check_name_of(void *ctx, str c)
{
    return fmt("%S$%S", ((checkname_ctx *)ctx)->table, c);
}

typedef struct {
    const pdiff *d;
    str name;
    str src;
} oldcheck_ctx;

static str old_check_name(void *ctx, str c)
{
    oldcheck_ctx *o = ctx;
    smap *m = smap_get(&o->d->column_of, o->name);
    str *s = m == NULL ? NULL : smap_get(m, c);
    return fmt("%S$%S", o->src, s == NULL ? c : *s);
}

static str sequence_sql(str to, str from)
{
    return fmt("INSERT INTO sqlite_sequence (name, seq) SELECT '%S', seq FROM sqlite_sequence WHERE name = '%S'", to, from);
}

static str unsequence_sql(str n)
{
    return fmt("DELETE FROM sqlite_sequence WHERE name = '%S'", n);
}

static str join(const strs *l)
{
    return strs_join(l, ", ");
}

/* SQLite table을 작업 table을 거쳐 다시 만든다(docs/plans.md "Steps"). */
static void rebuild(writer *w, str name)
{
    pdiff *d = w->d;
    const table *t = tgt_of(w, name);
    const table *src = src_of(w, name);
    str rebuild_name = SL(REBUILD_TABLE);
    str work = q(w, rebuild_name);
    strs *removed_list = smap_get(&d->removed, name), *added_list = smap_get(&d->added, name);
    strs removed = removed_list != NULL ? *removed_list : (strs){0};
    strs added = added_list != NULL ? *added_list : (strs){0};
    /* 새 정의: target table과 보관 이름의 지우는 column */
    columnv hidden_dropped = {0};
    for (size_t i = 0; i < removed.n; i++) {
        const column *col = column_must(src, removed.v[i]);
        PUSH(hidden_dropped, column_new(hold(w, fmt("%S.%S", src->name, removed.v[i])), col->type, col->nullable, col->identity, col->has_default ? &col->def : NULL));
    }
    /* 옛 정의: 이름 바꾸기를 적용한 source table과 보관 이름의 더하는 column */
    table *old = renamed_source(w, name);
    columnv hidden_added = {0};
    for (size_t i = 0; i < added.n; i++) {
        const column *col = column_must(t, added.v[i]);
        PUSH(hidden_added, column_new(hold(w, fmt("+%S.%S", name, added.v[i])), col->type, col->nullable, col->identity, col->has_default ? &col->def : NULL));
    }
    checkname_ctx new_names = {t->name};
    oldcheck_ctx old_names = {d, name, src->name};
    str old_create = r_create_table(&w->r, old, name, old_check_name, &old_names, &hidden_added);
    strs new_columns = {0};
    for (size_t i = 0; i < t->columns.n; i++) {
        PUSH(new_columns, t->columns.v[i]->name);
    }
    for (size_t i = 0; i < hidden_dropped.n; i++) {
        PUSH(new_columns, hidden_dropped.v[i]->name);
    }
    str new_list = r_list(&w->r, &new_columns);
    /* 옛 table에서 새 정의로 옮기는 식 */
    strs into = {0}, from = {0}, into_restore = {0}, from_restore = {0};
    smap *column_of = smap_get(&d->column_of, name);
    for (size_t i = 0; i < t->columns.n; i++) {
        const column *c = t->columns.v[i];
        str *old_name = column_of == NULL ? NULL : smap_get(column_of, c->name);
        if (old_name != NULL) {
            str e = copy_value(w, column_must(src, *old_name), c);
            PUSH(into, q(w, c->name));
            PUSH(from, e);
            PUSH(into_restore, q(w, c->name));
            PUSH(from_restore, e);
        } else {
            PUSH(into_restore, q(w, c->name));
            PUSH(from_restore, q(w, hold(w, fmt("+%S.%S", name, c->name))));
        }
    }
    for (size_t i = 0; i < removed.n; i++) {
        PUSH(into, q(w, hidden_dropped.v[i]->name));
        PUSH(from, q(w, removed.v[i]));
        PUSH(into_restore, q(w, hidden_dropped.v[i]->name));
        PUSH(from_restore, q(w, removed.v[i]));
    }
    /* 새 정의에서 옛 정의로 되돌리는 식 */
    strs back_into = {0}, back_from = {0};
    str irreversible = SL("");
    nullcheckv checks = {0};
    for (size_t i = 0; i < old->columns.n; i++) {
        const column *c = old->columns.v[i];
        PUSH(back_into, q(w, c->name));
        str *s = column_of == NULL ? NULL : smap_get(column_of, c->name);
        str source_name = s == NULL ? c->name : *s;
        const column *tc = table_column(t, c->name);
        if (tc != NULL && !strs_has(&removed, source_name)) {
            PUSH(back_from, q(w, c->name));
            if (precision_grows(c->type, tc->type)) {
                irreversible = SL(IRREVERSIBLE_PRECISION);
            }
            if (!c->nullable && tc->nullable) {
                PUSH(checks, null_check(w, name, c->name, c));
            }
            continue;
        }
        /* 지우는 column: 새 정의에서는 보관 이름이다. */
        str h = hold(w, fmt("%S.%S", src->name, source_name));
        PUSH(back_from, q(w, h));
        if (!c->nullable) {
            PUSH(checks, null_check(w, name, h, c));
        }
    }
    /* 옛 table에 숨긴 더한 column이 있으면 그 값도 되돌린다. */
    strs back_into_restore = strs_copy(&back_into), back_from_restore = strs_copy(&back_from);
    for (size_t i = 0; i < added.n; i++) {
        PUSH(back_into_restore, q(w, hidden_added.v[i]->name));
        PUSH(back_from_restore, q(w, added.v[i]));
    }
    bool identity = false;
    for (size_t i = 0; i < t->columns.n; i++) {
        identity = identity || t->columns.v[i]->identity;
    }
    str qn = q(w, name);
#define NEW_CREATE(as) r_create_table(&w->r, t, (as), check_name_of, &new_names, &hidden_dropped)
    add(w, step(NEW_CREATE(rebuild_name), fmt("DROP TABLE %S", work), SL(""), present("table", rebuild_name, SL(""))));
    if (identity) {
        add(w, step(sequence_sql(rebuild_name, name), unsequence_sql(rebuild_name), SL(""), present("sequence", rebuild_name, SL(""))));
    }
    str copy_in = fmt("INSERT INTO %S (%S) SELECT %S FROM %S", work, join(&into), join(&from), qn);
    if (hidden_added.n > 0) {
        planstep s = step(copy_in, fmt("DELETE FROM %S", work), SL(""), present("rows", rebuild_name, SL("")));
        s.restore = fmt("INSERT INTO %S (%S) SELECT %S FROM %S", work, join(&into_restore), join(&from_restore), qn);
        s.has_restore_if = true;
        s.restore_if = present("column", name, hidden_added.v[0]->name);
        add(w, s);
    } else {
        add(w, step(copy_in, fmt("DELETE FROM %S", work), SL(""), present("rows", rebuild_name, SL(""))));
    }
    indexsqlv old_indexes = index_sqls(w, old, name);
    for (size_t i = 0; i < old_indexes.n; i++) {
        add(w, step(old_indexes.v[i].drop, old_indexes.v[i].create, SL(""), absent("index", name, old_indexes.v[i].name)));
    }
    if (irreversible.n > 0) {
        planstep s = step(fmt("DELETE FROM %S", qn), SL(""), irreversible, absent("rows", name, SL("")));
        s.null_checks = checks;
        add(w, s);
    } else if (hidden_added.n > 0) {
        planstep s = step(fmt("DELETE FROM %S", qn), fmt("INSERT INTO %S (%S) SELECT %S FROM %S", qn, join(&back_into), join(&back_from), work),
            SL(""), absent("rows", name, SL("")));
        s.rollback_restore = fmt("INSERT INTO %S (%S) SELECT %S FROM %S", qn, join(&back_into_restore), join(&back_from_restore), work);
        s.has_restore_if = true;
        s.restore_if = present("column", name, hidden_added.v[0]->name);
        s.null_checks = checks;
        add(w, s);
    } else {
        planstep s = step(fmt("DELETE FROM %S", qn), fmt("INSERT INTO %S (%S) SELECT %S FROM %S", qn, join(&back_into), join(&back_from), work),
            SL(""), absent("rows", name, SL("")));
        s.null_checks = checks;
        add(w, s);
    }
    if (identity) {
        add(w, step(unsequence_sql(name), sequence_sql(name, rebuild_name), SL(""), absent("sequence", name, SL(""))));
    }
    add(w, step(fmt("DROP TABLE %S", qn), old_create, SL(""), absent("table", name, SL(""))));
    add(w, step(NEW_CREATE(name), fmt("DROP TABLE %S", qn), SL(""), present("table", name, SL(""))));
    if (identity) {
        add(w, step(sequence_sql(name, rebuild_name), unsequence_sql(name), SL(""), present("sequence", name, SL(""))));
    }
    add(w, step(fmt("INSERT INTO %S (%S) SELECT %S FROM %S", qn, new_list, new_list, work), fmt("DELETE FROM %S", qn), SL(""), present("rows", name, SL(""))));
    add(w, step(fmt("DELETE FROM %S", work), fmt("INSERT INTO %S (%S) SELECT %S FROM %S", work, new_list, new_list, qn), SL(""), absent("rows", rebuild_name, SL(""))));
    if (identity) {
        add(w, step(unsequence_sql(rebuild_name), sequence_sql(rebuild_name, name), SL(""), absent("sequence", rebuild_name, SL(""))));
    }
    add(w, step(fmt("DROP TABLE %S", work), NEW_CREATE(rebuild_name), SL(""), absent("table", rebuild_name, SL(""))));
#undef NEW_CREATE
    create_indexes(w, t, name);
}

static void alter_column(writer *w, str table, const column *from, const column *to)
{
    str irreversible = precision_grows(from->type, to->type) ? SL(IRREVERSIBLE_PRECISION) : SL("");
    column *source = column_new(to->name, from->type, from->nullable, from->identity, from->has_default ? &from->def : NULL);
    nullcheckv checks = {0};
    if (!from->nullable && to->nullable) {
        PUSH(checks, null_check(w, table, to->name, source));
    }
    if (w->r.d == D_MYSQL) {
        planstep s = step(fmt("ALTER TABLE %S MODIFY COLUMN %S", q(w, table), r_column(&w->r, to)),
            irreversible.n == 0 ? fmt("ALTER TABLE %S MODIFY COLUMN %S", q(w, table), r_column(&w->r, source)) : SL(""), irreversible, repeat_effect());
        s.null_checks = checks;
        add(w, s);
        return;
    }
    str prefix = fmt("ALTER TABLE %S ALTER COLUMN %S", q(w, table), q(w, to->name));
    bool same = ctype_same(from->type, to->type);
    if (!same) {
        add(w, step(fmt("%S TYPE %S", prefix, r_type_text(&w->r, to->type)), irreversible.n == 0 ? fmt("%S TYPE %S", prefix, r_type_text(&w->r, from->type)) : SL(""),
            irreversible, repeat_effect()));
    }
    if (from->nullable != to->nullable) {
        if (to->nullable) {
            planstep s = step(fmt("%S DROP NOT NULL", prefix), fmt("%S SET NOT NULL", prefix), SL(""), repeat_effect());
            s.null_checks = checks;
            add(w, s);
        } else {
            add(w, step(fmt("%S SET NOT NULL", prefix), fmt("%S DROP NOT NULL", prefix), SL(""), repeat_effect()));
        }
    }
    bool same_default = from->has_default == to->has_default && (!from->has_default || str_eq(from->def, to->def));
    if (!same_default || (to->has_default && !same)) {
        str back = !from->has_default ? fmt("%S DROP DEFAULT", prefix) : fmt("%S SET DEFAULT %S", prefix, r_default_text(&w->r, from->type, from->def));
        str forward = !to->has_default ? fmt("%S DROP DEFAULT", prefix) : fmt("%S SET DEFAULT %S", prefix, r_default_text(&w->r, to->type, to->def));
        add(w, step(forward, back, SL(""), repeat_effect()));
    }
}

static int cmp_objref_joined(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    const objref *x = a, *y = b;
    sbuf p = {0}, r = {0};
    sb_s(&p, x->kind);
    sb_ch(&p, '\0');
    sb_s(&p, x->name);
    sb_s(&r, y->kind);
    sb_ch(&r, '\0');
    sb_s(&r, y->name);
    return str_cmp(sb_str(&p), sb_str(&r));
}

static void write_steps(writer *w)
{
    pdiff *d = w->d;
    bool sqlite = w->r.d == D_SQLITE;
    number_holds(w);
    if (sqlite) {
        for (size_t i = 0; i < d->matched.n; i++) {
            if (sqlite_rebuilds(w, d->matched.v[i])) {
                smap_set(&w->rebuilt, d->matched.v[i], TRUEP);
            }
        }
    }
    /* 1. trigger */
    for (size_t i = 0; i < d->matched.n; i++) {
        const table *src = src_of(w, d->matched.v[i]);
        if (table_has_triggers(src) && (smap_has(&d->triggers, d->matched.v[i]) || smap_has(&w->rebuilt, d->matched.v[i]))) {
            drop_triggers(w, src);
        }
    }
    for (size_t i = 0; i < d->dropped.n; i++) {
        const table *t = smap_get(&d->source, d->dropped.v[i]);
        if (table_has_triggers(t)) {
            drop_triggers(w, t);
        }
    }
    /* 2. foreign key */
    strs keys = {0};
    if (!sqlite) {
        smap_keys_sorted(&d->drop_objects, &keys);
        for (size_t i = 0; i < keys.n; i++) {
            objrefv *l = smap_get(&d->drop_objects, keys.v[i]);
            for (size_t k = 0; k < l->n; k++) {
                if (str_eqc(l->v[k].kind, "foreign_key")) {
                    drop_object(w, smap_get(&d->source, keys.v[i]), l->v[k]);
                }
            }
        }
    }
    /* 3. check, unique, index와 지우는 table의 객체 */
    smap drop_tables = {0};
    SMAP_EACH(&d->drop_objects, i) {
        str s = d->drop_objects.e[i].key;
        if (sqlite && (smap_has(&w->rebuilt, target_name(w, s)) || strs_has(&d->dropped, s))) {
            continue;
        }
        objrefv *l = d->drop_objects.e[i].val;
        for (size_t k = 0; k < l->n; k++) {
            if (!str_eqc(l->v[k].kind, "foreign_key") && !(sqlite && str_eqc(l->v[k].kind, "check"))) {
                objrefv *dl = smap_get(&drop_tables, s);
                if (dl == NULL) {
                    dl = dbs_alloc(sizeof *dl);
                    smap_set(&drop_tables, s, dl);
                }
                PUSH(*dl, l->v[k]);
            }
        }
    }
    for (size_t i = 0; i < d->dropped.n; i++) {
        str s = d->dropped.v[i];
        const table *t = smap_get(&d->source, s);
        objrefv *dl = smap_get(&drop_tables, s);
        if (dl == NULL) {
            dl = dbs_alloc(sizeof *dl);
            smap_set(&drop_tables, s, dl);
        }
        for (size_t k = 0; k < t->uniques.n; k++) PUSH(*dl, ((objref){SL("unique"), t->uniques.v[k]->name}));
        for (size_t k = 0; k < t->indexes.n; k++) PUSH(*dl, ((objref){SL("index"), t->indexes.v[k]->name}));
        if (!sqlite) {
            for (size_t k = 0; k < t->checks.n; k++) PUSH(*dl, ((objref){SL("check"), t->checks.v[k]->name}));
        }
    }
    keys = (strs){0};
    smap_keys_sorted(&drop_tables, &keys);
    for (size_t i = 0; i < keys.n; i++) {
        objrefv *l = smap_get(&drop_tables, keys.v[i]);
        objrefv sorted = {0};
        for (size_t k = 0; k < l->n; k++) PUSH(sorted, l->v[k]);
        dbs_sort(sorted.v, sorted.n, sizeof(objref), cmp_objref_joined, NULL);
        for (size_t k = 0; k < sorted.n; k++) {
            drop_object(w, smap_get(&d->source, keys.v[i]), sorted.v[k]);
        }
    }
    smap before_checks = {0}, after_checks = {0}; /* target table => smap* */
    if (!sqlite) {
        for (size_t i = 0; i < d->matched.n; i++) {
            str name = d->matched.v[i];
            const table *src = src_of(w, name);
            smap *before = dbs_alloc(sizeof *before), *after = dbs_alloc(sizeof *after);
            *before = renderer_checks(w, src);
            *after = renderer_checks(w, tgt_of(w, name));
            smap_set(&before_checks, name, before);
            smap_set(&after_checks, name, after);
            strs names = {0};
            smap_keys_sorted(before, &names);
            for (size_t k = 0; k < names.n; k++) {
                str *b = smap_get(before, names.v[k]), *a = smap_get(after, names.v[k]);
                if (a == NULL || !str_eq(*a, *b)) {
                    drop_renderer_check(w, src->name, names.v[k], *b);
                }
            }
        }
        for (size_t i = 0; i < d->dropped.n; i++) {
            str s = d->dropped.v[i];
            smap before = renderer_checks(w, smap_get(&d->source, s));
            strs names = {0};
            smap_keys_sorted(&before, &names);
            for (size_t k = 0; k < names.n; k++) {
                drop_renderer_check(w, s, names.v[k], *(str *)smap_get(&before, names.v[k]));
            }
        }
    }
    /* 4. rename */
    trenamev rt = sorted_trenames(&d->renamed_tables);
    for (size_t i = 0; i < rt.n; i++) {
        add(w, step(fmt("ALTER TABLE %S RENAME TO %S", q(w, rt.v[i].old), q(w, rt.v[i].new_)),
            fmt("ALTER TABLE %S RENAME TO %S", q(w, rt.v[i].new_), q(w, rt.v[i].old)), SL(""), present("table", rt.v[i].new_, SL(""))));
    }
    crenamev rc = sorted_crenames(&d->renamed_columns);
    for (size_t i = 0; i < rc.n; i++) {
        add(w, step(rename_column_sql(w, rc.v[i].table, rc.v[i].old, rc.v[i].new_), rename_column_sql(w, rc.v[i].table, rc.v[i].new_, rc.v[i].old),
            SL(""), present("column", rc.v[i].table, rc.v[i].new_)));
    }
    /* 5. 지우는 column과 table을 숨긴다 */
    if (!sqlite) {
        for (size_t i = 0; i < d->matched.n; i++) {
            str name = d->matched.v[i];
            const table *src = src_of(w, name);
            strs *removed = smap_get(&d->removed, name);
            for (size_t k = 0; removed != NULL && k < removed->n; k++) {
                hide_column(w, name, column_must(src, removed->v[k]), hold(w, fmt("%S.%S", src->name, removed->v[k])));
            }
        }
    }
    for (size_t i = 0; i < d->dropped.n; i++) {
        str name = d->dropped.v[i];
        str h = hold(w, name);
        add(w, step(fmt("ALTER TABLE %S RENAME TO %S", q(w, name), q(w, h)), fmt("ALTER TABLE %S RENAME TO %S", q(w, h), q(w, name)), SL(""),
            present("table", h, SL(""))));
    }
    /* 6. create table */
    for (size_t i = 0; i < d->created.n; i++) {
        str name = d->created.v[i];
        const table *t = tgt_of(w, name);
        strs created = r_table(&w->r, t);
        add(w, step(created.v[0], fmt("DROP TABLE %S", q(w, name)), SL(""), present("table", name, SL(""))));
        create_indexes(w, t, name);
    }
    /* 7. add, alter column; SQLite 다시 만들기 */
    for (size_t i = 0; i < d->matched.n; i++) {
        str name = d->matched.v[i];
        if (sqlite) {
            if (smap_has(&w->rebuilt, name)) {
                rebuild(w, name);
            }
            continue;
        }
        const table *t = tgt_of(w, name);
        const table *src = src_of(w, name);
        strs *added = smap_get(&d->added, name);
        for (size_t k = 0; added != NULL && k < added->n; k++) {
            str c = added->v[k];
            str h = hold(w, fmt("+%S.%S", name, c));
            planstep s = step(fmt("ALTER TABLE %S ADD COLUMN %S", q(w, name), r_column(&w->r, column_must(t, c))), rename_column_sql(w, name, c, h), SL(""),
                present("column", name, c));
            s.restore = rename_column_sql(w, name, h, c);
            s.has_restore_if = true;
            s.restore_if = present("column", name, h);
            add(w, s);
        }
        strs *altered = smap_get(&d->altered, name);
        smap *column_of = smap_get(&d->column_of, name);
        for (size_t k = 0; altered != NULL && k < altered->n; k++) {
            str c = altered->v[k];
            alter_column(w, name, column_must(src, *(str *)smap_get(column_of, c)), column_must(t, c));
        }
    }
    /* 8. unique, index, check */
    keys = (strs){0};
    smap_keys_sorted(&d->add_objects, &keys);
    for (size_t i = 0; i < keys.n; i++) {
        if (smap_has(&w->rebuilt, keys.v[i])) {
            continue;
        }
        objrefv *l = smap_get(&d->add_objects, keys.v[i]);
        for (size_t k = 0; k < l->n; k++) {
            if (!str_eqc(l->v[k].kind, "foreign_key") && !(sqlite && str_eqc(l->v[k].kind, "check"))) {
                add_object(w, keys.v[i], l->v[k]);
            }
        }
    }
    if (!sqlite) {
        for (size_t i = 0; i < d->matched.n; i++) {
            str name = d->matched.v[i];
            smap *before = smap_get(&before_checks, name), *after = smap_get(&after_checks, name);
            strs names = {0};
            smap_keys_sorted(after, &names);
            for (size_t k = 0; k < names.n; k++) {
                str *b = smap_get(before, names.v[k]), *a = smap_get(after, names.v[k]);
                if (b == NULL || !str_eq(*b, *a)) {
                    add(w, step(fmt("ALTER TABLE %S ADD CONSTRAINT %S CHECK (%S)", q(w, name), q(w, names.v[k]), *a), drop_check_sql(w, name, names.v[k]),
                        SL(""), present("constraint", name, names.v[k])));
                }
            }
        }
    }
    /* 9. foreign key */
    if (!sqlite) {
        for (size_t i = 0; i < d->created.n; i++) {
            const table *t = tgt_of(w, d->created.v[i]);
            fkey **f = dbs_alloc(sizeof(fkey *) * (t->fks.n + 1));
            memcpy(f, t->fks.v, sizeof(fkey *) * t->fks.n);
            dbs_sort(f, t->fks.n, sizeof(fkey *), cmp_fkey_name, NULL);
            for (size_t k = 0; k < t->fks.n; k++) {
                add_object(w, d->created.v[i], ((objref){SL("foreign_key"), f[k]->name}));
            }
        }
        for (size_t i = 0; i < keys.n; i++) {
            objrefv *l = smap_get(&d->add_objects, keys.v[i]);
            for (size_t k = 0; k < l->n; k++) {
                if (str_eqc(l->v[k].kind, "foreign_key")) {
                    add_object(w, keys.v[i], l->v[k]);
                }
            }
        }
    }
    /* 10. trigger */
    for (size_t i = 0; i < d->created.n; i++) {
        create_triggers(w, tgt_of(w, d->created.v[i]));
    }
    for (size_t i = 0; i < d->matched.n; i++) {
        const table *t = tgt_of(w, d->matched.v[i]);
        if (table_has_triggers(t) && (smap_has(&d->triggers, d->matched.v[i]) || smap_has(&w->rebuilt, d->matched.v[i]))) {
            create_triggers(w, t);
        }
    }
    /* 11. finalize */
    for (size_t i = 0; i < w->hold_order.n; i++) {
        str key = w->hold_order.v[i];
        str h = *(str *)smap_get(&w->holds, key);
        if (str_starts(key, "+")) {
            continue;
        }
        ssize_t dot = str_find(key, ".", 0);
        if (dot >= 0) {
            str table = target_name(w, str_sub(key, 0, (size_t)dot));
            planstep s = step(fmt("ALTER TABLE %S DROP COLUMN %S", q(w, table), q(w, h)), SL(""), SL(""), absent("column", table, h));
            s.finalize = true;
            add(w, s);
            continue;
        }
        planstep s = step(fmt("DROP TABLE %S", q(w, h)), SL(""), SL(""), absent("table", h, SL("")));
        s.finalize = true;
        add(w, s);
    }
}

bool plan_steps(const document *source, const plan *p, dialect dl, planstepv *out, diags *diag)
{
    pdiff *d = pdiff_of(source, p, diag);
    if (d == NULL) {
        return false;
    }
    writer *w = dbs_alloc(sizeof *w);
    w->d = d;
    w->r.d = dl;
    str hash = str_sub(p->to, strlen("sha256:"), 12);
    w->hold_prefix = fmt("dbspec$hold$%S$", hash);
    write_steps(w);
    *out = w->out;
    return true;
}
