/*
 * The condition chain of a Polyspec\Orm\Model in C (T182-6, group 2); see model_chain.h.
 */
#include "model_chain.h"

/* The pending connector of the where state, as its string value; the state is never null (model_state_init sets it). */
static zend_string *where_pending(model_state *s)
{
    zval *pending = zend_hash_str_find(Z_ARRVAL(s->where), "pending", sizeof("pending") - 1);
    return Z_STR_P(pending);
}

static HashTable *where_items_table(model_state *s)
{
    zval *items = zend_hash_str_find(Z_ARRVAL(s->where), "items", sizeof("items") - 1);
    return Z_ARRVAL_P(items);
}

/* Sets the pending connector of the where state to `conn`, which is '' for none. */
static void set_pending(model_state *s, const char *conn, size_t conn_len)
{
    zval *pending = zend_hash_str_find(Z_ARRVAL(s->where), "pending", sizeof("pending") - 1);
    zval_ptr_dtor(pending);
    ZVAL_STRINGL(pending, conn, conn_len);
}

bool model_chain_add_item(model_state *s, const char *conn, size_t conn_len, zval *node, const char **error)
{
    zend_string *pending = where_pending(s);
    HashTable *items = where_items_table(s);
    const char *use = conn;
    size_t use_len = conn_len;

    if (ZSTR_LEN(pending) != 0 && conn_len != 0) {
        *error = "connector follows connector";
        return false;
    }
    if (ZSTR_LEN(pending) != 0) {
        use = ZSTR_VAL(pending);
        use_len = ZSTR_LEN(pending);
        set_pending(s, "", 0);
    }
    /* A connector at the start has nothing to join, so it is dropped: the first condition or group carries no AND or OR. */
    if (zend_hash_num_elements(items) == 0) {
        use = "";
        use_len = 0;
    }
    if (zend_hash_num_elements(items) != 0 && use_len == 0) {
        *error = "condition without and/or after another condition";
        return false;
    }
    if (Z_TYPE_P(node) != IS_ARRAY) {
        *error = "a chain item is an array";
        return false;
    }
    add_assoc_stringl(node, "conn", use, use_len);
    if (zend_hash_next_index_insert(items, node) == NULL) {
        *error = "the where items are full";
        return false;
    }
    return true;
}

bool model_chain_pending(model_state *s, const char *conn, size_t conn_len, const char **error)
{
    if (ZSTR_LEN(where_pending(s)) != 0) {
        *error = "connector follows connector";
        return false;
    }
    set_pending(s, conn, conn_len);
    return true;
}

/* Model::limit: keeps the offset and the count, and fails unless the offset is not negative and the count is positive. */
bool model_chain_limit(model_state *s, zend_long offset, zend_long count, const char **error)
{
    if (offset < 0 || count < 1) {
        *error = "limit requires a non-negative offset and a positive count";
        return false;
    }
    zval limit;
    array_init(&limit);
    add_assoc_long(&limit, "offset", offset);
    add_assoc_long(&limit, "count", count);
    model_state_free_limit(s);
    ZVAL_COPY_VALUE(&s->limit, &limit);
    return true;
}

/* Model::orderByRandom: appends the random ordering to the order list. */
void model_chain_order_random(model_state *s)
{
    zval random;
    array_init(&random);
    add_assoc_bool(&random, "random", true);
    zend_hash_next_index_insert(Z_ARRVAL(s->order), &random);
}

/* Model::addAllColumns and Model::removeAllColumns: set the column mode, 'all' or 'none'. */
void model_chain_column_mode(model_state *s, const char *mode, size_t mode_len)
{
    model_state_free_column_mode(s);
    s->column_mode = zend_string_init(mode, mode_len, 0);
}

void model_chain_parent_node(model_state *s)
{
    s->parent_node = true;
}

bool model_chain_group_limit(model_state *s, zend_long count, const char **error)
{
    if (count < 1) {
        *error = "groupLimit requires a positive count";
        return false;
    }
    s->group_limit = count;
    return true;
}

void model_chain_expect_revision(model_state *s, const char *column, size_t column_len, zend_long revision)
{
    zval pair;
    array_init(&pair);
    add_next_index_stringl(&pair, column, column_len);
    add_next_index_long(&pair, revision);
    model_state_free_expected_revision(s);
    ZVAL_COPY_VALUE(&s->expected_revision, &pair);
}

void model_chain_delete_lock(model_state *s)
{
    s->delete_lock = true;
}

void model_chain_lock(model_state *s, const char *mode, size_t mode_len)
{
    model_state_free_lock(s);
    s->lock = zend_string_init(mode, mode_len, 0);
}

void model_chain_fetch_key(model_state *s, zval *fn)
{
    model_state_free_fetch_key(s);
    ZVAL_COPY(&s->fetch_key, fn);
}

void model_chain_fetch_value(model_state *s, zval *fn)
{
    model_state_free_fetch_value(s);
    ZVAL_COPY(&s->fetch_value, fn);
}

void model_chain_duplication(model_state *s, zval *model)
{
    model_state_free_duplication(s);
    ZVAL_COPY(&s->duplication, model);
}
