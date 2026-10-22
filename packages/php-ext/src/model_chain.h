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

#endif
