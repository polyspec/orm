/*
 * The state of a Polyspec\Orm\Model object in C (T182-6, group 1): the same fields as packages/php/src/Model.php, each
 * held as the PHP value that the client holds (an array, an object, a string or an integer). The object wraps the state
 * in its zend_object, which is the last member, so the free functions can release every field before the object goes.
 * The class is not registered until it is complete (every method has its body, T182-6-5).
 */
#ifndef POLYSPEC_ORM_MODEL_STATE_H
#define POLYSPEC_ORM_MODEL_STATE_H

#include "php.h"

typedef struct model_state {
    /* private ?Db $conn = null */
    zval conn;
    /* private ?Model $groupOf = null */
    zval group_of;
    /* private ?\Throwable $error = null */
    zval error;
    /* private array $where = ['items' => [], 'pending' => ''] */
    zval where;
    /* private ?array $on = null */
    zval on;
    /* private array $joins = [] */
    zval joins;
    /* private array $relations = [] */
    zval relations;
    /* private string $columnMode = '' */
    zend_string *column_mode;
    /* private array $addColumns = [] */
    zval add_columns;
    /* private array $removeColumns = [] */
    zval remove_columns;
    /* private array $outputs = [] */
    zval outputs;
    /* private array $order = [] */
    zval order;
    /* private array $groupBy = [] */
    zval group_by;
    /* private ?array $limit = null */
    zval limit;
    /* private string $index = '' */
    zend_string *index;
    /* private string $lock = '' */
    zend_string *lock;
    /* private string $aggFn = '' */
    zend_string *agg_fn;
    /* private string $agg = '' */
    zend_string *agg;
    /* private array $matches = [] */
    zval matches;
    /* private string $alias = '' */
    zend_string *alias;
    /* private bool $parentNode = false */
    bool parent_node;
    /* private ?array $possible = null */
    zval possible;
    /* private int $groupLimit = 0 */
    zend_long group_limit;
    /* private bool $deleteLock = false */
    bool delete_lock;
    /* private ?array $expectedRevision = null */
    zval expected_revision;
    /* private string $keyName = '' */
    zend_string *key_name;
    /* private ?\Closure $fetchKey = null */
    zval fetch_key;
    /* private ?\Closure $fetchValue = null */
    zval fetch_value;
    /* private array $sets = [] */
    zval sets;
    /* private array $news = [] */
    zval news;
    /* private ?Model $duplication = null */
    zval duplication;
    /* private array $values = [] */
    zval values;
    /* private ?array $row = null */
    zval row;
    /* the object that holds the state; it is the last member */
    zend_object std;
} model_state;

/* The state of a Model object. */
model_state *model_state_of(zend_object *object);

/* The object of the state: the handlers create and release it with every field in its default state. */
zend_object *model_state_create(zend_class_entry *ce);
void model_state_destroy(zend_object *object);

/* One free function per field: each releases the field's value and sets its default state again. */
void model_state_free_conn(model_state *s);
void model_state_free_group_of(model_state *s);
void model_state_free_error(model_state *s);
void model_state_free_where(model_state *s);
void model_state_free_on(model_state *s);
void model_state_free_joins(model_state *s);
void model_state_free_relations(model_state *s);
void model_state_free_column_mode(model_state *s);
void model_state_free_add_columns(model_state *s);
void model_state_free_remove_columns(model_state *s);
void model_state_free_outputs(model_state *s);
void model_state_free_order(model_state *s);
void model_state_free_group_by(model_state *s);
void model_state_free_limit(model_state *s);
void model_state_free_index(model_state *s);
void model_state_free_lock(model_state *s);
void model_state_free_agg_fn(model_state *s);
void model_state_free_agg(model_state *s);
void model_state_free_matches(model_state *s);
void model_state_free_alias(model_state *s);
void model_state_free_parent_node(model_state *s);
void model_state_free_possible(model_state *s);
void model_state_free_group_limit(model_state *s);
void model_state_free_delete_lock(model_state *s);
void model_state_free_expected_revision(model_state *s);
void model_state_free_key_name(model_state *s);
void model_state_free_fetch_key(model_state *s);
void model_state_free_fetch_value(model_state *s);
void model_state_free_sets(model_state *s);
void model_state_free_news(model_state *s);
void model_state_free_duplication(model_state *s);
void model_state_free_values(model_state *s);
void model_state_free_row(model_state *s);

#endif
