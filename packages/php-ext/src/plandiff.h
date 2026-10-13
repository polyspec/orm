/* plan.c의 diff를 steps.c와 함께 쓰는 내부 선언이다(PHP client PlanDiff). */
#ifndef ORM_DBSPEC_PLANDIFF_H
#define ORM_DBSPEC_PLANDIFF_H

#include "dbspec.h"

/* [kind, name] */
typedef struct {
    str kind, name;
} objref;

typedef VEC(objref) objrefv;

typedef struct {
    smap source;          /* 이름 => source table* */
    smap target;          /* 이름 => target table* */
    smap table_of;        /* target table => source table(str*) */
    smap column_of;       /* target table => smap*(target column => source column str*) */
    strs created;
    strs dropped;         /* source 이름 순 */
    strs matched;         /* target 이름 순 */
    smap added;           /* target table => 더한 target column strs* */
    smap removed;         /* target table => 지운 source column strs* */
    smap altered;         /* target table => 바꾼 target column strs* */
    trenamev renamed_tables;
    crenamev renamed_columns;
    smap drop_objects;    /* source table => 지울 objrefv* */
    smap add_objects;     /* target table => 더할 objrefv* */
    smap triggers;        /* target table => trigger가 바뀐다 */
    changev changes;
    smap renamed_from;    /* source table => target table(str*) */
    smap renamed_column;  /* target table => smap*(source column => target column str*) */
} pdiff;

pdiff *pdiff_of(const document *source, const plan *p, diags *out);
str *str_ptr(str s);
bool type_widens(const ctype *from, const ctype *to);
bool table_has_triggers(const table *t);
trenamev sorted_trenames(const trenamev *l);
crenamev sorted_crenames(const crenamev *l);
str check_text_renamed(str expression, str (*f)(void *, str), void *ctx);
size_t quoted_length(str s, size_t i);
ukey *find_ukey(const table *t, str name);
xindex *find_index(const table *t, str name);
fkey *find_fkey(const table *t, str name);
check *find_check(const table *t, str name);

#endif
