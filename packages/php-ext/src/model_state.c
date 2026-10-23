/* Private native state uses Model's declared PHP properties as its canonical storage. */
#include "model_state.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_objects.h"

static zend_class_entry *model_state_ce;

void model_state_set_ce(zend_class_entry *ce)
{
    model_state_ce = ce;
}

zend_class_entry *model_native_class_entry(void)
{
    return model_state_ce;
}

static const char *model_property_name(const char *field)
{
    static const struct { const char *field; const char *property; } names[] = {
        {"group_of", "groupOf"}, {"column_mode", "columnMode"}, {"add_columns", "addColumns"},
        {"remove_columns", "removeColumns"}, {"group_by", "groupBy"}, {"agg_fn", "aggFn"},
        {"parent_node", "parentNode"}, {"group_limit", "groupLimit"}, {"delete_lock", "deleteLock"},
        {"expected_revision", "expectedRevision"}, {"key_name", "keyName"},
        {"fetch_key", "fetchKey"}, {"fetch_value", "fetchValue"}
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (strcmp(field, names[i].field) == 0) return names[i].property;
    }
    return field;
}

zval *model_state_property(model_state *object, const char *field)
{
    if (model_state_ce == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Model native state is not initialized");
        return NULL;
    }
    const char *name = model_property_name(field);
    return zend_read_property(model_state_ce, object, name, strlen(name), 1, NULL);
}

void model_state_property_set(model_state *object, const char *field, zval *value)
{
    if (model_state_ce == NULL) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Model native state is not initialized");
        return;
    }
    const char *name = model_property_name(field);
    zend_update_property(model_state_ce, object, name, strlen(name), value);
}

void model_state_property_separate(model_state *object, const char *field)
{
    zval *value = model_state_property(object, field);
    if (value == NULL || Z_TYPE_P(value) != IS_ARRAY) {
        if (EG(exception) == NULL) zend_throw_error(NULL, "Polyspec\\Orm\\Model property %s must be an array", field);
        return;
    }
    SEPARATE_ARRAY(value);
}

void model_state_reset(model_state *object, const char *field)
{
    zval value;
    if (strcmp(field, "conn") == 0 || strcmp(field, "group_of") == 0 || strcmp(field, "error") == 0 ||
        strcmp(field, "on") == 0 || strcmp(field, "limit") == 0 || strcmp(field, "possible") == 0 ||
        strcmp(field, "expected_revision") == 0 || strcmp(field, "fetch_key") == 0 ||
        strcmp(field, "fetch_value") == 0 || strcmp(field, "duplication") == 0 || strcmp(field, "row") == 0) {
        ZVAL_NULL(&value);
    } else if (strcmp(field, "parent_node") == 0 || strcmp(field, "delete_lock") == 0) {
        ZVAL_FALSE(&value);
    } else if (strcmp(field, "group_limit") == 0) {
        ZVAL_LONG(&value, 0);
    } else if (strcmp(field, "where") == 0) {
        array_init(&value);
        zval items;
        array_init(&items);
        add_assoc_zval(&value, "items", &items);
        add_assoc_string(&value, "pending", "");
    } else if (strcmp(field, "column_mode") == 0 || strcmp(field, "index") == 0 || strcmp(field, "lock") == 0 ||
        strcmp(field, "agg_fn") == 0 || strcmp(field, "agg") == 0 || strcmp(field, "alias") == 0 ||
        strcmp(field, "key_name") == 0) {
        ZVAL_EMPTY_STRING(&value);
    } else {
        array_init(&value);
    }
    model_state_property_set(object, field, &value);
    zval_ptr_dtor(&value);
}
