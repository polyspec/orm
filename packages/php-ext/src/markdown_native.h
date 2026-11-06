#ifndef POLYSPEC_ORM_MARKDOWN_NATIVE_H
#define POLYSPEC_ORM_MARKDOWN_NATIVE_H

#include "php.h"

/* The flowmark session of a markdown connection (src/orm.c): dial opens one and states connect, send writes one message
 * and reads its answer, and close ends it. A refused message is an OrmException with the code and the message of the
 * server; result_code, when not NULL, is the SQLite result code of the refusal, or -1. */
bool markdown_session_dial(zend_string *address, zend_string *corpus, zend_string *token, zval *out);
bool markdown_session_send(zval *self, zval *message, zval *out, zend_long *result_code);
void markdown_session_close(zval *self);
/* Whether session can no longer be used: it was closed, a read or write failed, or the server ended it. */
bool markdown_session_broken(zval *self);
/* Shuts the connection of session down without closing it, so a call that waits for its answer ends now. */
void markdown_session_shutdown(zval *self);
/* Reads a statement or fetch answer into its form; a member of another form is INTERNAL. */
bool markdown_session_answer(const char *what, zval *answer);

/* The markdown connection as the PDO handle of a SQLite connection (Internal\MarkdownPdoAdapter, DIA-185). */
void markdown_pdo_register(zend_class_entry *adapter_ce, zend_class_entry *statement_ce);
bool markdown_pdo_connect(zend_string *address, zend_string *corpus, zend_string *token, zval *pragmas, zval *out);
void markdown_pdo_session(zval *pdo, zval *out);
bool markdown_pdo_is_adapter(zval *value);

#endif
