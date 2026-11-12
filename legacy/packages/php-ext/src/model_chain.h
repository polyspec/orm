/*
 * The condition chain of a Polyspec\Orm\Model in C (T182-6, group 2): the where state of model_state.h and the rules of
 * Model::addItem and of the connector call without an argument (packages/php/src/Model.php). A rule that fails returns
 * false and names the message; the method body raises it as the client does, so no failure is dropped or hidden here.
 */
#ifndef POLYSPEC_ORM_MODEL_CHAIN_H
#define POLYSPEC_ORM_MODEL_CHAIN_H

#include "model_state.h"

/* Model::addItem: appends the condition or group `node` (an array) to the where items, joined by the pending connector or by
 * `conn` ('' or 'and' or 'or'). It takes the pending connector, drops the connector of the first item, and fails for a
 * connector that follows a connector, or a condition without a connector after another one. */
bool model_chain_add_item(model_state *s, const char *conn, size_t conn_len, zval *node, const char **error);

/* Model::connector with no argument: records the connector as pending for the next condition; it fails when a connector is
 * already pending. */
bool model_chain_pending(model_state *s, const char *conn, size_t conn_len, const char **error);
/* Model::limit: the offset and the count of the limit, or false with the message of the failed rule. */
bool model_chain_limit(model_state *s, zend_long offset, zend_long count, const char **error);

/* Model::orderByRandom: appends the random ordering to the order list. */
void model_chain_order_random(model_state *s);

/* Model::addAllColumns and Model::removeAllColumns: sets the column mode to 'all' or 'none'. */
void model_chain_column_mode(model_state *s, const char *mode, size_t mode_len);

/* Model::parentNode: sets the parent-node flag. */
void model_chain_parent_node(model_state *s);

/* Model::groupLimit: keeps the count, or fails unless the count is positive. */
bool model_chain_group_limit(model_state *s, zend_long count, const char **error);

/* Model::expectRevision: keeps the column and the revision as the pair the write checks. */
void model_chain_expect_revision(model_state *s, const char *column, size_t column_len, zend_long revision);

/* Model::deleteLock: sets the delete-lock flag. */
void model_chain_delete_lock(model_state *s);

/* Model::forUpdate, forShare, forUpdateNoWait and forShareNoWait: sets the lock mode, one of 'update', 'share',
 * 'update_nowait' and 'share_nowait'. */
void model_chain_lock(model_state *s, const char *mode, size_t mode_len);

/* Model::fetchKey and Model::fetchValue: keeps the closure, which the fetch calls. */
void model_chain_fetch_key(model_state *s, zval *fn);
void model_chain_fetch_value(model_state *s, zval *fn);

/* Model::duplication: keeps the model of the duplicate-key update. */
void model_chain_duplication(model_state *s, zval *model);

#endif
