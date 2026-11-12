/* A closure of a native handler with a context object as its $this, which the dial of a markdown connection and the
 * listener of a PostgreSQL connection make. */
#ifndef POLYSPEC_ORM_CONTEXT_CLOSURE_H
#define POLYSPEC_ORM_CONTEXT_CLOSURE_H

#include "php.h"
#include "Zend/zend_closures.h"

/* Writes to out a closure named name that runs handler with context as its $this. The closure copies the function, so
 * the description made here is freed at once. */
static inline void context_closure(zval *out, const char *name, size_t name_len, zif_handler handler, zval *context)
{
    zend_internal_function *fn = pemalloc(sizeof(*fn), 1);
    memset(fn, 0, sizeof(*fn));
    fn->type = ZEND_INTERNAL_FUNCTION;
    fn->fn_flags = ZEND_ACC_PUBLIC;
    fn->scope = zend_standard_class_def;
    fn->function_name = zend_string_init_interned(name, name_len, 1);
    fn->handler = handler;
    zend_create_fake_closure(out, (zend_function *) fn, zend_standard_class_def, zend_standard_class_def, context);
    pefree(fn, 1);
}

#endif
