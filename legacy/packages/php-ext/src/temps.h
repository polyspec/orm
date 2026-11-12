/* The temp values of an engine context: each zval is kept until release_temps(), so that a result that refers to it
 * stays valid for the whole call (KSTD-5-46). The planner and the validator keep their temps in this one list. */
#ifndef POLYSPEC_ORM_TEMPS_H
#define POLYSPEC_ORM_TEMPS_H

typedef struct vtemp {
    zval v;
    struct vtemp *next;
} vtemp;

/* Returns a zval that stays alive until release_temps(*head) releases the list. */
static zval *keep_temp(vtemp **head)
{
    vtemp *t = emalloc(sizeof(vtemp));
    ZVAL_UNDEF(&t->v);
    t->next = *head;
    *head = t;
    return &t->v;
}

/* Releases each zval kept in the list and empties it. */
static void release_temps(vtemp **head)
{
    vtemp *t = *head;
    while (t != NULL) {
        vtemp *next = t->next;
        zval_ptr_dtor(&t->v);
        efree(t);
        t = next;
    }
    *head = NULL;
}

#endif
