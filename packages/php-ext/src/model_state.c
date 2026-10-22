/*
 * The state of a Polyspec\Orm\Model object in C (T182-6, group 1); see model_state.h. Every field has one free function, which
 * releases the field's value and sets the field's default state again. model_state_init sets each field to its default
 * through those functions, so the defaults are written in one place each.
 */
#include "model_state.h"
#include "Zend/zend_objects_API.h"

static zend_object_handlers model_state_handlers;

model_state *model_state_of(zend_object *object)
{
    return (model_state *)((char *)object - XtOffsetOf(model_state, std));
}

/* Frees the value of a zval field and sets it to null: the default of the nullable object and array fields. */
static void free_to_null(zval *field)
{
    zval_ptr_dtor(field);
    ZVAL_NULL(field);
}

/* Frees the value of a zval field and sets it to the empty array: the default of the list and map fields. */
static void free_to_array(zval *field)
{
    zval_ptr_dtor(field);
    ZVAL_EMPTY_ARRAY(field);
}

/* Frees a string field and sets it to the empty string, which is interned and needs no release. */
static void free_to_string(zend_string **field)
{
    if (*field != NULL) {
        zend_string_release(*field);
    }
    *field = ZSTR_EMPTY_ALLOC();
}

void model_state_free_conn(model_state *s) { free_to_null(&s->conn); }
void model_state_free_group_of(model_state *s) { free_to_null(&s->group_of); }
void model_state_free_error(model_state *s) { free_to_null(&s->error); }

/* private array $where = ['items' => [], 'pending' => ''] */
void model_state_free_where(model_state *s)
{
    zval_ptr_dtor(&s->where);
    array_init(&s->where);
    zval items;
    ZVAL_EMPTY_ARRAY(&items);
    add_assoc_zval(&s->where, "items", &items);
    add_assoc_stringl(&s->where, "pending", "", 0);
}

void model_state_free_on(model_state *s) { free_to_null(&s->on); }
void model_state_free_joins(model_state *s) { free_to_array(&s->joins); }
void model_state_free_relations(model_state *s) { free_to_array(&s->relations); }
void model_state_free_column_mode(model_state *s) { free_to_string(&s->column_mode); }
void model_state_free_add_columns(model_state *s) { free_to_array(&s->add_columns); }
void model_state_free_remove_columns(model_state *s) { free_to_array(&s->remove_columns); }
void model_state_free_outputs(model_state *s) { free_to_array(&s->outputs); }
void model_state_free_order(model_state *s) { free_to_array(&s->order); }
void model_state_free_group_by(model_state *s) { free_to_array(&s->group_by); }
void model_state_free_limit(model_state *s) { free_to_null(&s->limit); }
void model_state_free_index(model_state *s) { free_to_string(&s->index); }
void model_state_free_lock(model_state *s) { free_to_string(&s->lock); }
void model_state_free_agg_fn(model_state *s) { free_to_string(&s->agg_fn); }
void model_state_free_agg(model_state *s) { free_to_string(&s->agg); }
void model_state_free_matches(model_state *s) { free_to_array(&s->matches); }
void model_state_free_alias(model_state *s) { free_to_string(&s->alias); }
void model_state_free_parent_node(model_state *s) { s->parent_node = false; }
void model_state_free_possible(model_state *s) { free_to_null(&s->possible); }
void model_state_free_group_limit(model_state *s) { s->group_limit = 0; }
void model_state_free_delete_lock(model_state *s) { s->delete_lock = false; }
void model_state_free_expected_revision(model_state *s) { free_to_null(&s->expected_revision); }
void model_state_free_key_name(model_state *s) { free_to_string(&s->key_name); }
void model_state_free_fetch_key(model_state *s) { free_to_null(&s->fetch_key); }
void model_state_free_fetch_value(model_state *s) { free_to_null(&s->fetch_value); }
void model_state_free_sets(model_state *s) { free_to_array(&s->sets); }
void model_state_free_news(model_state *s) { free_to_array(&s->news); }
void model_state_free_duplication(model_state *s) { free_to_null(&s->duplication); }
void model_state_free_values(model_state *s) { free_to_array(&s->values); }
void model_state_free_row(model_state *s) { free_to_null(&s->row); }

/* Sets every field to its default, through its free function: each field is undefined until its function runs. */
static void model_state_init(model_state *s)
{
    ZVAL_UNDEF(&s->conn);
    ZVAL_UNDEF(&s->group_of);
    ZVAL_UNDEF(&s->error);
    ZVAL_UNDEF(&s->where);
    ZVAL_UNDEF(&s->on);
    ZVAL_UNDEF(&s->joins);
    ZVAL_UNDEF(&s->relations);
    ZVAL_UNDEF(&s->add_columns);
    ZVAL_UNDEF(&s->remove_columns);
    ZVAL_UNDEF(&s->outputs);
    ZVAL_UNDEF(&s->order);
    ZVAL_UNDEF(&s->group_by);
    ZVAL_UNDEF(&s->limit);
    ZVAL_UNDEF(&s->matches);
    ZVAL_UNDEF(&s->possible);
    ZVAL_UNDEF(&s->expected_revision);
    ZVAL_UNDEF(&s->fetch_key);
    ZVAL_UNDEF(&s->fetch_value);
    ZVAL_UNDEF(&s->sets);
    ZVAL_UNDEF(&s->news);
    ZVAL_UNDEF(&s->duplication);
    ZVAL_UNDEF(&s->values);
    ZVAL_UNDEF(&s->row);
    s->column_mode = NULL;
    s->index = NULL;
    s->lock = NULL;
    s->agg_fn = NULL;
    s->agg = NULL;
    s->alias = NULL;
    s->key_name = NULL;
    model_state_free_conn(s);
    model_state_free_group_of(s);
    model_state_free_error(s);
    model_state_free_where(s);
    model_state_free_on(s);
    model_state_free_joins(s);
    model_state_free_relations(s);
    model_state_free_column_mode(s);
    model_state_free_add_columns(s);
    model_state_free_remove_columns(s);
    model_state_free_outputs(s);
    model_state_free_order(s);
    model_state_free_group_by(s);
    model_state_free_limit(s);
    model_state_free_index(s);
    model_state_free_lock(s);
    model_state_free_agg_fn(s);
    model_state_free_agg(s);
    model_state_free_matches(s);
    model_state_free_alias(s);
    model_state_free_parent_node(s);
    model_state_free_possible(s);
    model_state_free_group_limit(s);
    model_state_free_delete_lock(s);
    model_state_free_expected_revision(s);
    model_state_free_key_name(s);
    model_state_free_fetch_key(s);
    model_state_free_fetch_value(s);
    model_state_free_sets(s);
    model_state_free_news(s);
    model_state_free_duplication(s);
    model_state_free_values(s);
    model_state_free_row(s);
}

zend_object *model_state_create(zend_class_entry *ce)
{
    model_state *s = zend_object_alloc(sizeof(model_state), ce);
    zend_object_std_init(&s->std, ce);
    object_properties_init(&s->std, ce);
    model_state_handlers = std_object_handlers;
    model_state_handlers.offset = XtOffsetOf(model_state, std);
    model_state_handlers.free_obj = model_state_destroy;
    s->std.handlers = &model_state_handlers;
    model_state_init(s);
    return &s->std;
}

/* Releases every field, then the object. */
void model_state_destroy(zend_object *object)
{
    model_state *s = model_state_of(object);
    model_state_free_conn(s);
    model_state_free_group_of(s);
    model_state_free_error(s);
    model_state_free_where(s);
    model_state_free_on(s);
    model_state_free_joins(s);
    model_state_free_relations(s);
    model_state_free_column_mode(s);
    model_state_free_add_columns(s);
    model_state_free_remove_columns(s);
    model_state_free_outputs(s);
    model_state_free_order(s);
    model_state_free_group_by(s);
    model_state_free_limit(s);
    model_state_free_index(s);
    model_state_free_lock(s);
    model_state_free_agg_fn(s);
    model_state_free_agg(s);
    model_state_free_matches(s);
    model_state_free_alias(s);
    model_state_free_possible(s);
    model_state_free_expected_revision(s);
    model_state_free_key_name(s);
    model_state_free_fetch_key(s);
    model_state_free_fetch_value(s);
    model_state_free_sets(s);
    model_state_free_news(s);
    model_state_free_duplication(s);
    model_state_free_values(s);
    model_state_free_row(s);
    zend_object_std_dtor(object);
}
