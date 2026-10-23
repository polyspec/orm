/* Model query-chain state helpers backed by declared private Model properties. */
#include "model_chain.h"

static zval *where_items(model_state *object)
{
    zval *where = model_state_property(object, "where");
    if (where == NULL || Z_TYPE_P(where) != IS_ARRAY) return NULL;
    return zend_hash_str_find(Z_ARRVAL_P(where), "items", sizeof("items") - 1);
}

static zval *where_pending(model_state *object)
{
    zval *where = model_state_property(object, "where");
    if (where == NULL || Z_TYPE_P(where) != IS_ARRAY) return NULL;
    return zend_hash_str_find(Z_ARRVAL_P(where), "pending", sizeof("pending") - 1);
}

static void set_pending(model_state *object, const char *value, size_t length)
{
    zval *where = model_state_property(object, "where");
    if (where == NULL || Z_TYPE_P(where) != IS_ARRAY) return;
    SEPARATE_ARRAY(where);
    zval replacement;
    ZVAL_STRINGL(&replacement, value, length);
    zend_hash_str_update(Z_ARRVAL_P(where), "pending", sizeof("pending") - 1, &replacement);
}

bool model_chain_add_item(model_state *object, const char *conn, size_t conn_len, zval *node, const char **error)
{
    zval *pending = where_pending(object);
    zval *items = where_items(object);
    if (pending == NULL || Z_TYPE_P(pending) != IS_STRING || items == NULL || Z_TYPE_P(items) != IS_ARRAY) {
        *error = "where state has an invalid shape";
        return false;
    }
    const char *use = conn;
    size_t use_len = conn_len;
    if (Z_STRLEN_P(pending) != 0 && conn_len != 0) {
        *error = "connector follows connector";
        return false;
    }
    if (Z_STRLEN_P(pending) != 0) {
        use = Z_STRVAL_P(pending);
        use_len = Z_STRLEN_P(pending);
        set_pending(object, "", 0);
        items = where_items(object);
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(items)) == 0) {
        use = "";
        use_len = 0;
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(items)) != 0 && use_len == 0) {
        *error = "condition without and/or after another condition";
        return false;
    }
    if (Z_TYPE_P(node) != IS_ARRAY) {
        *error = "a chain item is an array";
        return false;
    }
    zval *where = model_state_property(object, "where");
    SEPARATE_ARRAY(where);
    items = where_items(object);
    SEPARATE_ARRAY(items);
    add_assoc_stringl(node, "conn", use, use_len);
    if (zend_hash_next_index_insert(Z_ARRVAL_P(items), node) == NULL) {
        *error = "the where items are full";
        return false;
    }
    return true;
}

bool model_chain_pending(model_state *object, const char *conn, size_t conn_len, const char **error)
{
    zval *pending = where_pending(object);
    if (pending == NULL || Z_TYPE_P(pending) != IS_STRING) {
        *error = "where pending state has an invalid shape";
        return false;
    }
    if (Z_STRLEN_P(pending) != 0) {
        *error = "connector follows connector";
        return false;
    }
    set_pending(object, conn, conn_len);
    return EG(exception) == NULL;
}

bool model_chain_limit(model_state *object, zend_long offset, zend_long count, const char **error)
{
    if (offset < 0 || count < 1) {
        *error = "limit requires a non-negative offset and a positive count";
        return false;
    }
    zval limit;
    array_init(&limit);
    add_assoc_long(&limit, "offset", offset);
    add_assoc_long(&limit, "count", count);
    model_state_property_set(object, "limit", &limit);
    zval_ptr_dtor(&limit);
    return EG(exception) == NULL;
}

static void append_to_array(model_state *object, const char *field, zval *value)
{
    zval *array = model_state_property(object, field);
    if (array == NULL || Z_TYPE_P(array) != IS_ARRAY) return;
    SEPARATE_ARRAY(array);
    zend_hash_next_index_insert(Z_ARRVAL_P(array), value);
}

void model_chain_order_random(model_state *object)
{
    zval random;
    array_init(&random);
    add_assoc_bool(&random, "random", true);
    append_to_array(object, "order", &random);
}

void model_chain_column_mode(model_state *object, const char *mode, size_t mode_len)
{
    zval value;
    ZVAL_STRINGL(&value, mode, mode_len);
    model_state_property_set(object, "column_mode", &value);
    zval_ptr_dtor(&value);
}

void model_chain_parent_node(model_state *object)
{
    zval value;
    ZVAL_TRUE(&value);
    model_state_property_set(object, "parent_node", &value);
}

bool model_chain_group_limit(model_state *object, zend_long count, const char **error)
{
    if (count < 1) {
        *error = "groupLimit requires a positive count";
        return false;
    }
    zval value;
    ZVAL_LONG(&value, count);
    model_state_property_set(object, "group_limit", &value);
    return EG(exception) == NULL;
}

void model_chain_expect_revision(model_state *object, const char *column, size_t column_len, zend_long revision)
{
    zval pair;
    array_init(&pair);
    add_next_index_stringl(&pair, column, column_len);
    add_next_index_long(&pair, revision);
    model_state_property_set(object, "expected_revision", &pair);
    zval_ptr_dtor(&pair);
}

void model_chain_delete_lock(model_state *object)
{
    zval value;
    ZVAL_TRUE(&value);
    model_state_property_set(object, "delete_lock", &value);
}

void model_chain_lock(model_state *object, const char *mode, size_t mode_len)
{
    zval value;
    ZVAL_STRINGL(&value, mode, mode_len);
    model_state_property_set(object, "lock", &value);
    zval_ptr_dtor(&value);
}

void model_chain_fetch_key(model_state *object, zval *fn)
{
    model_state_property_set(object, "fetch_key", fn);
}

void model_chain_fetch_value(model_state *object, zval *fn)
{
    model_state_property_set(object, "fetch_value", fn);
}

void model_chain_duplication(model_state *object, zval *model)
{
    model_state_property_set(object, "duplication", model);
}
