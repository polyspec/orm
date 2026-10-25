/*
 * Polyspec\Orm\Engine and Polyspec\Orm\Assemble of the PHP library (packages/php/src/Engine.php, Assemble.php) in C.
 *
 * Engine compiles the requests of one runtime model and one database: validation, planning, and the value-free request
 * shape as the key of a size-limited plan cache. Assemble stamps the steps of a plan with the styled cells that
 * Codec::decodeRows converts and indexes every assemble node in place.
 */
#include "engine_native.h"
#include "codec.h"
#include "runtime_model.h"
#include "ext/json/php_json.h"
#include "Zend/zend_smart_str.h"

zend_class_entry *polyspec_engine_ce;
zend_class_entry *polyspec_assemble_ce;

#define ENGINE_RETAINED_PLACEHOLDERS 65535

static zend_class_entry *engine_class(const char *name)
{
    zend_string *n = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(n);
    zend_string_release(n);
    if (ce == NULL && EG(exception) == NULL) {
        zend_throw_error(NULL, "Class \"%s\" not found", name);
    }
    return ce;
}

/* new $class(...$argv) into ret; false with an exception on failure. */
static bool engine_new(const char *class_name, zval *ret, uint32_t argc, zval *argv)
{
    zend_class_entry *ce = engine_class(class_name);
    if (ce == NULL) {
        return false;
    }
    if (object_init_ex(ret, ce) != SUCCESS) {
        return false;
    }
    if (ce->constructor != NULL) {
        zval rv;
        ZVAL_UNDEF(&rv);
        zend_call_known_function(ce->constructor, Z_OBJ_P(ret), ce, &rv, argc, argv, NULL);
        zval_ptr_dtor(&rv);
    }
    if (EG(exception) != NULL) {
        zval_ptr_dtor(ret);
        ZVAL_UNDEF(ret);
        return false;
    }
    return true;
}

/* $object->$method(...$argv) into ret; false with an exception on failure. */
static bool engine_call(zval *object, const char *method, zval *ret, uint32_t argc, zval *argv)
{
    zval fn;
    ZVAL_STRING(&fn, method);
    ZVAL_UNDEF(ret);
    zend_result r = call_user_function(NULL, object, &fn, ret, argc, argv);
    zval_ptr_dtor(&fn);
    if (r != SUCCESS || EG(exception) != NULL) {
        zval_ptr_dtor(ret);
        ZVAL_UNDEF(ret);
        return false;
    }
    return true;
}

/* The property of this object, read in the scope of Engine; NULL when it is missing. */
static zval *engine_prop(zval *self, const char *name)
{
    zval *p = zend_read_property(polyspec_engine_ce, Z_OBJ_P(self), name, strlen(name), 1, &EG(uninitialized_zval));
    return p == NULL || Z_TYPE_P(p) == IS_UNDEF ? NULL : p;
}

/* ---- Assemble ---- */

/* Assemble::cells: the styled cells of one indexed node, without its joined nodes, for Codec::decodeRows. */
static bool assemble_cells(HashTable *node, zval *model, zval *out)
{
    zval *entities = zend_read_property(Z_OBJCE_P(model), Z_OBJ_P(model), "entities", sizeof("entities") - 1, 1,
        &EG(uninitialized_zval));
    zval *entity_name = zend_hash_str_find(node, "entity", sizeof("entity") - 1);
    zval *entity = entities != NULL && Z_TYPE_P(entities) == IS_ARRAY && entity_name != NULL && Z_TYPE_P(entity_name) == IS_STRING
        ? zend_hash_find(Z_ARRVAL_P(entities), Z_STR_P(entity_name)) : NULL;
    zval *aes_version = entity != NULL && Z_TYPE_P(entity) == IS_ARRAY
        ? zend_hash_str_find(Z_ARRVAL_P(entity), "aes_version", sizeof("aes_version") - 1) : NULL;
    if (aes_version == NULL || Z_TYPE_P(aes_version) != IS_STRING) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::cells(): the entity of the node has no aes_version");
        return false;
    }
    zval *columns = zend_hash_str_find(node, "columns", sizeof("columns") - 1);
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::cells(): the node has no columns");
        return false;
    }
    zval version;
    ZVAL_NULL(&version);
    zval *column;
    if (Z_STRLEN_P(aes_version) > 0) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval *name = Z_TYPE_P(column) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(column), "column", sizeof("column") - 1) : NULL;
            if (name != NULL && Z_TYPE_P(name) == IS_STRING && zend_string_equals(Z_STR_P(name), Z_STR_P(aes_version))) {
                zval *index = zend_hash_str_find(Z_ARRVAL_P(column), "index", sizeof("index") - 1);
                if (index != NULL) {
                    ZVAL_COPY(&version, index);
                }
                break;
            }
        } ZEND_HASH_FOREACH_END();
    }
    array_init(out);
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        if (Z_TYPE_P(column) != IS_ARRAY) {
            continue;
        }
        zval *styles = zend_hash_str_find(Z_ARRVAL_P(column), "styles", sizeof("styles") - 1);
        if (styles == NULL || !zend_is_true(styles)) {
            continue;
        }
        zval *index = zend_hash_str_find(Z_ARRVAL_P(column), "index", sizeof("index") - 1);
        zval *host = zend_hash_str_find(Z_ARRVAL_P(column), "host", sizeof("host") - 1);
        zval *codec = zend_hash_str_find(Z_ARRVAL_P(column), "codec", sizeof("codec") - 1);
        if (index == NULL || host == NULL || Z_TYPE_P(host) != IS_ARRAY || codec == NULL) {
            zval_ptr_dtor(&version);
            zval_ptr_dtor(out);
            zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::cells(): a styled column is not indexed");
            return false;
        }
        bool aes = false;
        zval *style;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(host), style) {
            if (Z_TYPE_P(style) == IS_STRING && zend_string_equals_literal(Z_STR_P(style), "aes")) {
                aes = true;
                break;
            }
        } ZEND_HASH_FOREACH_END();
        zval cell;
        array_init_size(&cell, 5);
        Z_TRY_ADDREF_P(index);
        add_next_index_zval(&cell, index);
        Z_TRY_ADDREF_P(host);
        add_next_index_zval(&cell, host);
        Z_TRY_ADDREF_P(codec);
        add_next_index_zval(&cell, codec);
        add_next_index_bool(&cell, aes);
        Z_TRY_ADDREF(version);
        add_next_index_zval(&cell, &version);
        add_next_index_zval(out, &cell);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&version);
    return true;
}

/* Assemble::indexNode: idx (name => position), hidden, the split of each styled column into host and codec stages, and a
 * process-unique node number, on the node and every child node, in place. */
static bool assemble_index_node(zval *node)
{
    SEPARATE_ARRAY(node);
    HashTable *a = Z_ARRVAL_P(node);
    zval *columns = zend_hash_str_find(a, "columns", sizeof("columns") - 1);
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): an assemble node has no columns");
        return false;
    }
    SEPARATE_ARRAY(columns);
    zval idx, hidden;
    array_init(&idx);
    array_init(&hidden);
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        if (Z_TYPE_P(column) != IS_ARRAY) {
            continue;
        }
        zval *name = zend_hash_str_find(Z_ARRVAL_P(column), "name", sizeof("name") - 1);
        zval *index = zend_hash_str_find(Z_ARRVAL_P(column), "index", sizeof("index") - 1);
        if (name == NULL || Z_TYPE_P(name) != IS_STRING || index == NULL) {
            zval_ptr_dtor(&idx);
            zval_ptr_dtor(&hidden);
            zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): a column of an assemble node has no name or index");
            return false;
        }
        Z_TRY_ADDREF_P(index);
        zend_symtable_update(Z_ARRVAL(idx), Z_STR_P(name), index);
        zval *is_hidden = zend_hash_str_find(Z_ARRVAL_P(column), "hidden", sizeof("hidden") - 1);
        if (is_hidden != NULL && zend_is_true(is_hidden)) {
            zval yes;
            ZVAL_TRUE(&yes);
            zend_symtable_update(Z_ARRVAL(hidden), Z_STR_P(name), &yes);
        }
        zval *styles = zend_hash_str_find(Z_ARRVAL_P(column), "styles", sizeof("styles") - 1);
        if (styles != NULL && zend_is_true(styles)) {
            if (Z_TYPE_P(styles) != IS_ARRAY) {
                zval_ptr_dtor(&idx);
                zval_ptr_dtor(&hidden);
                zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): the styles of a column are not a list");
                return false;
            }
            zval host, codec;
            array_init(&host);
            array_init(&codec);
            zval *style;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(styles), style) {
                if (Z_TYPE_P(style) != IS_STRING) {
                    zval_ptr_dtor(&host);
                    zval_ptr_dtor(&codec);
                    zval_ptr_dtor(&idx);
                    zval_ptr_dtor(&hidden);
                    zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): a style of a column is not a string");
                    return false;
                }
                Z_TRY_ADDREF_P(style);
                add_next_index_zval(codec_is_host_style(Z_STR_P(style)) ? &host : &codec, style);
            } ZEND_HASH_FOREACH_END();
            SEPARATE_ARRAY(column);
            zend_hash_str_update(Z_ARRVAL_P(column), "host", sizeof("host") - 1, &host);
            zend_hash_str_update(Z_ARRVAL_P(column), "codec", sizeof("codec") - 1, &codec);
        }
    } ZEND_HASH_FOREACH_END();
    zend_hash_str_update(a, "idx", sizeof("idx") - 1, &idx);
    zval *nodes = zend_read_static_property(polyspec_assemble_ce, "nodes", sizeof("nodes") - 1, 0);
    if (nodes == NULL || Z_TYPE_P(nodes) != IS_LONG) {
        zval_ptr_dtor(&hidden);
        zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::$nodes is not an int");
        return false;
    }
    zval next;
    ZVAL_LONG(&next, Z_LVAL_P(nodes) + 1);
    zend_update_static_property(polyspec_assemble_ce, "nodes", sizeof("nodes") - 1, &next);
    zend_hash_str_update(a, "node", sizeof("node") - 1, &next);
    zend_hash_str_update(a, "hidden", sizeof("hidden") - 1, &hidden);
    zval *children = zend_hash_str_find(a, "children", sizeof("children") - 1);
    if (children != NULL && Z_TYPE_P(children) == IS_ARRAY) {
        SEPARATE_ARRAY(children);
        zval *child;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(children), child) {
            if (Z_TYPE_P(child) != IS_ARRAY) {
                continue;
            }
            SEPARATE_ARRAY(child);
            zval *assemble = zend_hash_str_find(Z_ARRVAL_P(child), "assemble", sizeof("assemble") - 1);
            if (assemble != NULL && Z_TYPE_P(assemble) != IS_NULL && !assemble_index_node(assemble)) {
                return false;
            }
        } ZEND_HASH_FOREACH_END();
    }
    return true;
}

/* Assemble::decodeCells: the styled cells of a node and of its joined nodes, appended to out. */
static bool assemble_decode_cells(HashTable *node, HashTable *out, zval *model)
{
    zval cells;
    if (!assemble_cells(node, model, &cells)) {
        return false;
    }
    zval *cell;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(cells), cell) {
        Z_TRY_ADDREF_P(cell);
        zend_hash_next_index_insert(out, cell);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&cells);
    zval *children = zend_hash_str_find(node, "children", sizeof("children") - 1);
    if (children == NULL || Z_TYPE_P(children) != IS_ARRAY) {
        return true;
    }
    zval *child;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(children), child) {
        zval *kind = Z_TYPE_P(child) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(child), "kind", sizeof("kind") - 1) : NULL;
        if (kind == NULL || Z_TYPE_P(kind) != IS_STRING || !zend_string_equals_literal(Z_STR_P(kind), "join")) {
            continue;
        }
        zval *assemble = zend_hash_str_find(Z_ARRVAL_P(child), "assemble", sizeof("assemble") - 1);
        if (assemble == NULL || Z_TYPE_P(assemble) != IS_ARRAY) {
            zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): a join child has no assemble node");
            return false;
        }
        if (!assemble_decode_cells(Z_ARRVAL_P(assemble), out, model)) {
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* Assemble::index(array &$plan, RuntimeModel $model): stamps every step with 'decode' and indexes its assemble node. */
bool assemble_index(zval *plan, zval *model)
{
    ZVAL_DEREF(plan);
    if (Z_TYPE_P(plan) != IS_ARRAY) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): the plan is not an array");
        return false;
    }
    SEPARATE_ARRAY(plan);
    zval *steps = zend_hash_str_find(Z_ARRVAL_P(plan), "steps", sizeof("steps") - 1);
    if (steps == NULL || Z_TYPE_P(steps) != IS_ARRAY) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): the plan has no steps");
        return false;
    }
    SEPARATE_ARRAY(steps);
    zval *step;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(steps), step) {
        if (Z_TYPE_P(step) != IS_ARRAY) {
            zend_throw_error(NULL, "Polyspec\\Orm\\Assemble::index(): a step of the plan is not an array");
            return false;
        }
        SEPARATE_ARRAY(step);
        zval decode;
        array_init(&decode);
        zval *assemble = zend_hash_str_find(Z_ARRVAL_P(step), "assemble", sizeof("assemble") - 1);
        if (assemble != NULL && Z_TYPE_P(assemble) != IS_NULL) {
            if (!assemble_index_node(assemble) || !assemble_decode_cells(Z_ARRVAL_P(assemble), Z_ARRVAL(decode), model)) {
                zval_ptr_dtor(&decode);
                return false;
            }
        }
        zend_hash_str_update(Z_ARRVAL_P(step), "decode", sizeof("decode") - 1, &decode);
    } ZEND_HASH_FOREACH_END();
    return true;
}

ZEND_METHOD(Polyspec_Orm_Assemble, index)
{
    zval *plan, *model;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_EX2(plan, 0, 1, 0)
        Z_PARAM_OBJECT_OF_CLASS(model, polyspec_runtime_model_ce)
    ZEND_PARSE_PARAMETERS_END();
    if (!assemble_index(plan, model)) {
        RETURN_THROWS();
    }
}

ZEND_METHOD(Polyspec_Orm_Assemble, cells)
{
    HashTable *node;
    zval *model;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(node)
        Z_PARAM_OBJECT_OF_CLASS(model, polyspec_runtime_model_ce)
    ZEND_PARSE_PARAMETERS_END();
    if (!assemble_cells(node, model, return_value)) {
        RETURN_THROWS();
    }
}

/* ---- Engine ---- */

/* new Engine($model, $dialect, $cacheSize): a Validator of the model and a Planner of the model and the Dialect. */
static bool engine_construct(zval *self, zval *model, zend_string *dialect, zend_long cache_size)
{
    zval validator, planner, dialect_object, name;
    if (!engine_new("Polyspec\\Orm\\Validator", &validator, 1, model)) {
        return false;
    }
    ZVAL_STR_COPY(&name, dialect);
    bool ok = engine_new("Polyspec\\Orm\\Dialect", &dialect_object, 1, &name);
    zval_ptr_dtor(&name);
    if (!ok) {
        zval_ptr_dtor(&validator);
        return false;
    }
    zval pargs[2];
    ZVAL_COPY_VALUE(&pargs[0], model);
    ZVAL_COPY_VALUE(&pargs[1], &dialect_object);
    ok = engine_new("Polyspec\\Orm\\Planner", &planner, 2, pargs);
    zval_ptr_dtor(&dialect_object);
    if (!ok) {
        zval_ptr_dtor(&validator);
        return false;
    }
    zval size;
    ZVAL_LONG(&size, cache_size);
    zend_update_property(polyspec_engine_ce, Z_OBJ_P(self), "model", sizeof("model") - 1, model);
    zend_update_property(polyspec_engine_ce, Z_OBJ_P(self), "cacheSize", sizeof("cacheSize") - 1, &size);
    zend_update_property(polyspec_engine_ce, Z_OBJ_P(self), "validator", sizeof("validator") - 1, &validator);
    zend_update_property(polyspec_engine_ce, Z_OBJ_P(self), "planner", sizeof("planner") - 1, &planner);
    zval_ptr_dtor(&validator);
    zval_ptr_dtor(&planner);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Engine, __construct)
{
    zval *model;
    zend_string *dialect;
    zend_long cache_size;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS(model, polyspec_runtime_model_ce)
        Z_PARAM_STR(dialect)
        Z_PARAM_LONG(cache_size)
    ZEND_PARSE_PARAMETERS_END();
    if (!engine_construct(ZEND_THIS, model, dialect, cache_size)) {
        RETURN_THROWS();
    }
}

/* Engine::for: the engine shared by the generated model of a manifest hash and by the dialect. */
ZEND_METHOD(Polyspec_Orm_Engine, for)
{
    zend_string *hash, *dialect;
    zend_long cache_size;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(hash)
        Z_PARAM_STR(dialect)
        Z_PARAM_LONG(cache_size)
    ZEND_PARSE_PARAMETERS_END();
    zval *engines = zend_read_static_property(polyspec_engine_ce, "engines", sizeof("engines") - 1, 0);
    if (engines == NULL || Z_TYPE_P(engines) != IS_ARRAY) {
        zend_throw_error(NULL, "Polyspec\\Orm\\Engine::$engines is not an array");
        RETURN_THROWS();
    }
    smart_str key = {0};
    smart_str_append(&key, hash);
    smart_str_appendc(&key, '\0');
    smart_str_append(&key, dialect);
    zend_string *k = smart_str_extract(&key);
    zval *found = zend_symtable_find(Z_ARRVAL_P(engines), k);
    if (found != NULL) {
        zend_string_release(k);
        RETURN_COPY(found);
    }
    zval hash_value, model, engine;
    ZVAL_STR_COPY(&hash_value, hash);
    ZVAL_UNDEF(&model);
    zval fn;
    ZVAL_STRING(&fn, "Polyspec\\Orm\\Registry::model");
    zend_result r = call_user_function(NULL, NULL, &fn, &model, 1, &hash_value);
    zval_ptr_dtor(&fn);
    zval_ptr_dtor(&hash_value);
    if (r != SUCCESS || EG(exception) != NULL) {
        zend_string_release(k);
        RETURN_THROWS();
    }
    object_init_ex(&engine, polyspec_engine_ce);
    if (!engine_construct(&engine, &model, dialect, cache_size)) {
        zval_ptr_dtor(&engine);
        zval_ptr_dtor(&model);
        zend_string_release(k);
        RETURN_THROWS();
    }
    zval_ptr_dtor(&model);
    zval map;
    ZVAL_COPY(&map, engines);
    SEPARATE_ARRAY(&map);
    Z_ADDREF(engine);
    zend_symtable_update(Z_ARRVAL(map), k, &engine);
    zend_update_static_property(polyspec_engine_ce, "engines", sizeof("engines") - 1, &map);
    zval_ptr_dtor(&map);
    zend_string_release(k);
    RETURN_COPY_VALUE(&engine);
}

/* $this->validator->validate($ir). */
static bool engine_validate(zval *self, zval *ir)
{
    zval *validator = engine_prop(self, "validator");
    zval rv;
    if (validator == NULL || !engine_call(validator, "validate", &rv, 1, ir)) {
        return false;
    }
    zval_ptr_dtor(&rv);
    return true;
}

/* Engine::plan: the plan of a value-free request, from the plan cache of its shape. */
ZEND_METHOD(Polyspec_Orm_Engine, plan)
{
    zval *ir;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(ir)
    ZEND_PARSE_PARAMETERS_END();
    if (!engine_validate(ZEND_THIS, ir)) {
        RETURN_THROWS();
    }
    smart_str shape = {0};
    if (php_json_encode(&shape, ir, PHP_JSON_UNESCAPED_SLASHES | PHP_JSON_UNESCAPED_UNICODE | PHP_JSON_PRESERVE_ZERO_FRACTION) != SUCCESS) {
        smart_str_free(&shape);
        zend_throw_error(NULL, "Polyspec\\Orm\\Engine::plan(): the request shape does not encode as JSON");
        RETURN_THROWS();
    }
    zend_string *key = smart_str_extract(&shape);
    zval *plans = engine_prop(ZEND_THIS, "plans");
    if (plans == NULL || Z_TYPE_P(plans) != IS_ARRAY) {
        zend_string_release(key);
        zend_throw_error(NULL, "Polyspec\\Orm\\Engine::$plans is not an array");
        RETURN_THROWS();
    }
    zval *cached = zend_symtable_find(Z_ARRVAL_P(plans), key);
    if (cached != NULL) {
        zval result, map, cached_value;
        ZVAL_COPY(&result, cached);
        ZVAL_COPY(&map, plans);
        SEPARATE_ARRAY(&map);
        zend_symtable_del(Z_ARRVAL(map), key);
        ZVAL_COPY(&cached_value, &result);
        zend_symtable_update(Z_ARRVAL(map), key, &cached_value);
        zend_update_property(polyspec_engine_ce, Z_OBJ_P(ZEND_THIS), "plans", sizeof("plans") - 1, &map);
        zval_ptr_dtor(&map);
        zend_string_release(key);
        RETURN_COPY_VALUE(&result);
    }
    zval *planner = engine_prop(ZEND_THIS, "planner");
    zval *model = engine_prop(ZEND_THIS, "model");
    zval plan;
    if (planner == NULL || model == NULL || !engine_call(planner, "compile", &plan, 1, ir)) {
        zend_string_release(key);
        RETURN_THROWS();
    }
    if (!assemble_index(&plan, model)) {
        zval_ptr_dtor(&plan);
        zend_string_release(key);
        RETURN_THROWS();
    }
    zend_long placeholders = 0;
    zval *steps = zend_hash_str_find(Z_ARRVAL(plan), "steps", sizeof("steps") - 1);
    if (steps != NULL && Z_TYPE_P(steps) == IS_ARRAY) {
        zval *step;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(steps), step)
        {
            if (Z_TYPE_P(step) != IS_ARRAY) {
                continue;
            }
            zval *slots = zend_hash_str_find(Z_ARRVAL_P(step), "bind_slots", sizeof("bind_slots") - 1);
            if (slots != NULL && Z_TYPE_P(slots) == IS_ARRAY) {
                placeholders += (zend_long)zend_hash_num_elements(Z_ARRVAL_P(slots));
            }
        }
        ZEND_HASH_FOREACH_END();
    }
    if (placeholders <= ENGINE_RETAINED_PLACEHOLDERS) {
        zval map, placeholder_map, cached_plan, placeholder_count;
        ZVAL_COPY(&map, plans);
        SEPARATE_ARRAY(&map);
        ZVAL_COPY(&placeholder_map, engine_prop(ZEND_THIS, "placeholders"));
        SEPARATE_ARRAY(&placeholder_map);

        ZVAL_COPY(&cached_plan, &plan);
        zend_symtable_update(Z_ARRVAL(map), key, &cached_plan);
        ZVAL_LONG(&placeholder_count, placeholders);
        zend_symtable_update(Z_ARRVAL(placeholder_map), key, &placeholder_count);

        zend_long retained = zval_get_long(engine_prop(ZEND_THIS, "retained")) + placeholders;
        zval *size = engine_prop(ZEND_THIS, "cacheSize");
        zend_long cache_size = size != NULL && Z_TYPE_P(size) == IS_LONG ? Z_LVAL_P(size) : 0;
        while ((zend_long)zend_hash_num_elements(Z_ARRVAL(map)) > cache_size
            || retained > ENGINE_RETAINED_PLACEHOLDERS) {
            zend_string *oldest_string = NULL;
            zend_ulong oldest_index = 0;
            HashPosition pos;
            zend_hash_internal_pointer_reset_ex(Z_ARRVAL(map), &pos);
            int key_type = zend_hash_get_current_key_ex(Z_ARRVAL(map), &oldest_string, &oldest_index, &pos);
            if (key_type == HASH_KEY_IS_STRING) {
                zval *old_count = zend_symtable_find(Z_ARRVAL(placeholder_map), oldest_string);
                if (old_count != NULL) {
                    retained -= zval_get_long(old_count);
                    zend_symtable_del(Z_ARRVAL(placeholder_map), oldest_string);
                }
                zend_hash_del(Z_ARRVAL(map), oldest_string);
            } else if (key_type == HASH_KEY_IS_LONG) {
                zval *old_count = zend_hash_index_find(Z_ARRVAL(placeholder_map), oldest_index);
                if (old_count != NULL) {
                    retained -= zval_get_long(old_count);
                    zend_hash_index_del(Z_ARRVAL(placeholder_map), oldest_index);
                }
                zend_hash_index_del(Z_ARRVAL(map), oldest_index);
            } else {
                break;
            }
        }
        zval retained_value;
        ZVAL_LONG(&retained_value, retained);
        zend_update_property(polyspec_engine_ce, Z_OBJ_P(ZEND_THIS), "plans", sizeof("plans") - 1, &map);
        zend_update_property(polyspec_engine_ce, Z_OBJ_P(ZEND_THIS), "placeholders", sizeof("placeholders") - 1, &placeholder_map);
        zend_update_property(polyspec_engine_ce, Z_OBJ_P(ZEND_THIS), "retained", sizeof("retained") - 1, &retained_value);
        zval_ptr_dtor(&map);
        zval_ptr_dtor(&placeholder_map);
    }
    zend_string_release(key);
    RETURN_COPY_VALUE(&plan);
}

/* Engine::compile: validates and plans a request without caching or indexing. */
ZEND_METHOD(Polyspec_Orm_Engine, compile)
{
    zval *ir;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(ir)
    ZEND_PARSE_PARAMETERS_END();
    if (!engine_validate(ZEND_THIS, ir)) {
        RETURN_THROWS();
    }
    zval *planner = engine_prop(ZEND_THIS, "planner");
    if (planner == NULL || !engine_call(planner, "compile", return_value, 1, ir)) {
        RETURN_THROWS();
    }
}

void polyspec_engine_register(zend_class_entry *engine_ce, zend_class_entry *assemble_ce)
{
    polyspec_engine_ce = engine_ce;
    polyspec_assemble_ce = assemble_ce;
}
