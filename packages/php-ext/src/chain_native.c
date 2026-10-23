/* Native implementation of Polyspec\\Orm\\Chain (packages/php/src/Chain.php). */
#include "php.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "chain_native.h"
#include "validator.h"

zend_class_entry *polyspec_chain_ce;

static void chain_fail(zend_string *message)
{
    zend_string *exception_name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(exception_name);
    if (ce == NULL) {
        zend_throw_error(NULL, "Class \"%s\" not found", ZSTR_VAL(exception_name));
        zend_string_release(exception_name);
        zend_string_release(message);
        return;
    }
    zend_string_release(exception_name);
    zval ex, args[2], rv;
    object_init_ex(&ex, ce);
    ZVAL_STRING(&args[0], "CONFIG");
    ZVAL_STR_COPY(&args[1], message);
    ZVAL_UNDEF(&rv);
    ZVAL_UNDEF(&rv);
    zend_call_method(Z_OBJ(ex), ce, NULL, ZEND_STRL("__construct"), &rv, 2, &args[0], &args[1]);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (!Z_ISUNDEF(rv)) zval_ptr_dtor(&rv);
    if (EG(exception) == NULL) zend_throw_exception_object(&ex); else zval_ptr_dtor(&ex);
    zend_string_release(message);
}

static zend_string *chain_pascal(zend_string *snake)
{
    smart_str out = {0}; bool upper = true;
    for (size_t i = 0; i < ZSTR_LEN(snake); i++) {
        unsigned char c = (unsigned char)ZSTR_VAL(snake)[i];
        if (c == '_') { upper = true; continue; }
        smart_str_appendc(&out, upper && c >= 'a' && c <= 'z' ? (char)(c - 32) : (char)c);
        upper = false;
    }
    smart_str_0(&out); return out.s ? out.s : zend_string_init("", 0, 0);
}

static zend_string *chain_snake(zend_string *pascal)
{
    smart_str out = {0};
    for (size_t i = 0; i < ZSTR_LEN(pascal); i++) {
        unsigned char c = (unsigned char)ZSTR_VAL(pascal)[i];
        if (i && c >= 'A' && c <= 'Z') smart_str_appendc(&out, '_');
        smart_str_appendc(&out, c >= 'A' && c <= 'Z' ? (char)(c + 32) : (char)c);
    }
    smart_str_0(&out); return out.s ? out.s : zend_string_init("", 0, 0);
}

static void chain_words(zend_string *name, zval *out)
{
    array_init(out); size_t start = 0;
    for (size_t i = 0; i <= ZSTR_LEN(name); i++) {
        if (i < ZSTR_LEN(name) && !(ZSTR_VAL(name)[i] >= 'A' && ZSTR_VAL(name)[i] <= 'Z')) continue;
        if (i > start) add_next_index_stringl(out, ZSTR_VAL(name) + start, i - start);
        start = i;
    }
}

static zval *field(zval *array, const char *key)
{
    return Z_TYPE_P(array) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key)) : NULL;
}

static zend_string *column_for(zval *meta, zend_string *pascal)
{
    zval *columns = field(meta, "columns");
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY) return ZSTR_EMPTY_ALLOC();
    zend_string *key; zend_ulong idx; zend_string *found = ZSTR_EMPTY_ALLOC();
    ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(columns), idx, key) {
        (void)idx;
        if (key == NULL) continue;
        zend_string *candidate = chain_pascal(key);
        bool same = zend_string_equals(candidate, pascal);
        zend_string_release(candidate);
        if (same) { zend_string_release(found); found = zend_string_copy(key); }
    } ZEND_HASH_FOREACH_END();
    return found;
}

static bool call_static(zend_string *class_name, const char *method, zval *result, uint32_t argc, zval *argv)
{
    smart_str call = {0}; smart_str_append(&call, class_name); smart_str_appends(&call, "::"); smart_str_appends(&call, method); smart_str_0(&call);
    zval fn; ZVAL_STR(&fn, call.s);
    zend_result rc = call_user_function(EG(function_table), NULL, &fn, result, argc, argv);
    zval_ptr_dtor(&fn);
    return rc == SUCCESS && EG(exception) == NULL;
}

static bool class_meta(zend_string *class_name, zval *meta)
{
    return call_static(class_name, "meta", meta, 0, NULL);
}

PHP_METHOD(Polyspec_Orm_Chain, words)
{
    zend_string *name; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    chain_words(name, return_value);
}
PHP_METHOD(Polyspec_Orm_Chain, pascal)
{
    zend_string *name; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(chain_pascal(name));
}
PHP_METHOD(Polyspec_Orm_Chain, snake)
{
    zend_string *name; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(chain_snake(name));
}
static zend_string *join_words(zval *words, uint32_t from, uint32_t to)
{
    smart_str out = {0};
    for (uint32_t i = from; i < to; i++) {
        zval *w = zend_hash_index_find(Z_ARRVAL_P(words), i);
        if (w && Z_TYPE_P(w) == IS_STRING) smart_str_append(&out, Z_STR_P(w));
    }
    smart_str_0(&out); return out.s ? out.s : zend_string_init("", 0, 0);
}

static const char *engine_operator(const char *op)
{
    if (!strcmp(op, "")) return "eq";
    if (!strcmp(op, "ne")) return "not_eq";
    if (!strcmp(op, "ge")) return "gte";
    if (!strcmp(op, "le")) return "lte";
    if (!strcmp(op, "lk")) return "contains";
    if (!strcmp(op, "lb")) return "contains_binary";
    if (!strcmp(op, "between")) return "between";
    return op;
}

static bool allowed(zval *column, const char *op)
{
    zend_string *operation = zend_string_init(op, strlen(op), 0);
    bool result = Z_TYPE_P(column) == IS_ARRAY && validator_op_allowed(Z_ARRVAL_P(column), operation);
    zend_string_release(operation); return result;
}

static void result_key(zval *out, const char *conn, const char *op, zend_string *column, zval *columns, zend_string *compare)
{
    array_init(out);
    add_assoc_string(out, "conn", (char *)conn);
    add_assoc_string(out, "op", (char *)op);
    if (column && ZSTR_LEN(column)) add_assoc_str(out, "column", zend_string_copy(column)); else add_assoc_string(out, "column", "");
    if (columns) add_assoc_zval(out, "columns", columns); else { zval a; array_init(&a); add_assoc_zval(out, "columns", &a); }
    add_assoc_str(out, "compare", compare && ZSTR_LEN(compare) ? zend_string_copy(compare) : zend_string_init("", 0, 0));
}

static bool word_eq(zval *words, uint32_t i, const char *text)
{
    zval *v = zend_hash_index_find(Z_ARRVAL_P(words), i);
    return v && Z_TYPE_P(v) == IS_STRING && zend_string_equals_cstr(Z_STR_P(v), text, strlen(text));
}

static zval *column_metadata(zval *meta, zend_string *name)
{
    zval *columns = field(meta, "columns");
    if (!columns || Z_TYPE_P(columns) != IS_ARRAY) return NULL;
    return zend_hash_find(Z_ARRVAL_P(columns), name);
}

static zend_string *listed_column(zval *schema, zend_string *pascal)
{
    if (!schema || Z_TYPE_P(schema) != IS_ARRAY) return ZSTR_EMPTY_ALLOC();
    zval *meta;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(schema), meta) {
        if (Z_TYPE_P(meta) == IS_ARRAY) {
            zend_string *found = column_for(meta, pascal);
            if (ZSTR_LEN(found)) return found;
            zend_string_release(found);
        }
    } ZEND_HASH_FOREACH_END();
    return ZSTR_EMPTY_ALLOC();
}

static bool function_column(zval *column)
{
    zval *codec = field(column, "codec"), *type = field(column, "type");
    if (!codec || Z_TYPE_P(codec) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0 || !type || Z_TYPE_P(type) != IS_STRING) return false;
    return zend_string_equals_literal(Z_STR_P(type), "date") || zend_string_equals_literal(Z_STR_P(type), "datetime");
}

static void fail_text(const char *text)
{
    chain_fail(zend_string_init(text, strlen(text), 0));
}

static zend_string *check_operator(zval *meta, zend_string *column, const char *op, zend_string *compare)
{
    zval *col = column_metadata(meta, column);
    zval *entity = field(meta, "entity");
    const char *entity_name = entity && Z_TYPE_P(entity) == IS_STRING ? Z_STRVAL_P(entity) : "";
    if (!col || Z_TYPE_P(col) != IS_ARRAY) return NULL;
    if (compare && ZSTR_LEN(compare)) {
        char engine[32]; snprintf(engine, sizeof(engine), "%s_col", engine_operator(op));
        zval *codec = field(col, "codec");
        if (!allowed(col, engine) || (codec && Z_TYPE_P(codec) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0))
            return strpprintf(0, "%s.%s cannot be compared with a column", entity_name, ZSTR_VAL(column));
        return NULL;
    }
    bool ok = allowed(col, engine_operator(op));
    if ((!strcmp(op, "") || !strcmp(op, "ne")) && allowed(col, "is_null")) ok = true;
    if ((!strcmp(op, "") || !strcmp(op, "gt") || !strcmp(op, "lt") || !strcmp(op, "ge") || !strcmp(op, "le")) && function_column(col)) ok = true;
    if (ok) return NULL;
    return strpprintf(0, "%s.%s does not accept the %s operator", entity_name, ZSTR_VAL(column), !strcmp(op, "") ? "equality" : op);
}

static zend_string *word_concat(zval *words, uint32_t from, uint32_t to)
{
    return join_words(words, from, to);
}

static bool candidate_add(zval *candidates, zval *errors, zval *meta, zend_string *column, const char *op, zend_string *compare)
{
    zend_string *error = check_operator(meta, column, op, compare);
    if (error) { add_next_index_str(errors, strpprintf(0, "CONFIG: %s", ZSTR_VAL(error))); zend_string_release(error); return false; }
    zval key, cols; array_init(&cols);
    result_key(&key, "", op, column, &cols, compare);
    add_next_index_zval(candidates, &key); return true;
}

static bool tuple_candidate(zval *meta, zval *words, uint32_t from, uint32_t end, const char *op, zval *candidates, zval *errors)
{
    zval cols; array_init(&cols); uint32_t part = from; bool valid = true;
    for (uint32_t i = from; i <= end; i++) {
        if (i < end && !word_eq(words, i, "With")) continue;
        zend_string *pascal = word_concat(words, part, i);
        zend_string *column = column_for(meta, pascal); zend_string_release(pascal);
        if (!ZSTR_LEN(column)) { zend_string_release(column); valid = false; }
        else add_next_index_str(&cols, column);
        part = i + 1;
    }
    zval *entity = field(meta, "entity");
    const char *entity_name = entity && Z_TYPE_P(entity) == IS_STRING ? Z_STRVAL_P(entity) : "";
    if (!valid || zend_hash_num_elements(Z_ARRVAL(cols)) < 2) {
        zval_ptr_dtor(&cols);
        add_next_index_str(errors, strpprintf(0, "CONFIG: a tuple needs two or more columns of %s joined by With", entity_name));
        return false;
    }
    zval *name; ZEND_HASH_FOREACH_VAL(Z_ARRVAL(cols), name) {
        zval *col = column_metadata(meta, Z_STR_P(name));
        zval *codec = col ? field(col, "codec") : NULL;
        if (!col || !codec || Z_TYPE_P(codec) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(codec)) != 0 || !allowed(col, "in")) {
            add_next_index_str(errors, strpprintf(0, "%s.%s cannot be used in a tuple", entity_name, Z_STRVAL_P(name)));
            zval_ptr_dtor(&cols); return false;
        }
    } ZEND_HASH_FOREACH_END();
    zval key; array_init(&key); add_assoc_string(&key, "conn", ""); add_assoc_string(&key, "op", (char *)op);
    add_assoc_string(&key, "column", ""); add_assoc_zval(&key, "columns", &cols); add_assoc_string(&key, "compare", "");
    add_next_index_zval(candidates, &key); return true;
}

static bool parse_key(zval *meta, zval *schema, zval *words, uint32_t start, uint32_t end, zval *out)
{
    if (start == end) { fail_text("a condition key is empty"); return false; }
    zend_string *text = word_concat(words, start, end);
    zval candidates, errors; array_init(&candidates); array_init(&errors);
    zend_string *col = column_for(meta, text);
    if (ZSTR_LEN(col)) candidate_add(&candidates, &errors, meta, col, "", NULL);
    zend_string_release(col);

    static const struct { const char *word; const char *op; } leading[] = {
        {"Ne", "ne"}, {"Eq", ""}, {"Gt", "gt"}, {"Lt", "lt"}, {"Ge", "ge"}, {"Le", "le"},
        {"Lk", "lk"}, {"Lb", "lb"}, {"Between", "between"}
    };
    if (end - start > 1) {
        for (size_t n = 0; n < sizeof(leading)/sizeof(leading[0]); n++) {
            if (!word_eq(words, start, leading[n].word)) continue;
            if (!strcmp(leading[n].word, "Ne") && word_eq(words, start + 1, "Tuple")) {
                tuple_candidate(meta, words, start + 2, end, "ne_tuple", &candidates, &errors);
            } else {
                zend_string *rest = word_concat(words, start + 1, end);
                col = column_for(meta, rest);
                if (ZSTR_LEN(col)) candidate_add(&candidates, &errors, meta, col, leading[n].op, NULL);
                zend_string_release(col); zend_string_release(rest);
            }
            break;
        }
    }
    if (word_eq(words, start, "Tuple")) tuple_candidate(meta, words, start + 1, end, "tuple", &candidates, &errors);

    static const struct { const char *word; const char *op; } compare_ops[] = {
        {"Eq", ""}, {"Ne", "ne"}, {"Gt", "gt"}, {"Lt", "lt"}, {"Ge", "ge"}, {"Le", "le"}
    };
    for (uint32_t i = start + 1; i + 1 < end; i++) {
        const char *op = NULL;
        for (size_t n = 0; n < sizeof(compare_ops)/sizeof(compare_ops[0]); n++) if (word_eq(words, i, compare_ops[n].word)) { op = compare_ops[n].op; break; }
        if (!op) continue;
        zend_string *left = word_concat(words, start, i), *right = word_concat(words, i + 1, end);
        zend_string *left_col = column_for(meta, left);
        if (ZSTR_LEN(left_col)) {
            zend_string *right_col = schema ? listed_column(schema, right) : ZSTR_EMPTY_ALLOC();
            if (!schema) {
                zval *hash = field(meta, "manifest_hash");
                if (hash && Z_TYPE_P(hash) == IS_STRING) {
                    zval arg, models; ZVAL_STR_COPY(&arg, Z_STR_P(hash)); ZVAL_UNDEF(&models);
                    zend_string *registry = zend_string_init(ZEND_STRL("Polyspec\\Orm\\Registry"), 0);
                    if (call_static(registry, "models", &models, 1, &arg) && Z_TYPE(models) == IS_ARRAY) {
                        zval *class_name; ZEND_HASH_FOREACH_VAL(Z_ARRVAL(models), class_name) {
                            if (Z_TYPE_P(class_name) != IS_STRING) continue;
                            zval model_meta; ZVAL_UNDEF(&model_meta);
                            if (class_meta(Z_STR_P(class_name), &model_meta)) {
                                zend_string *f = column_for(&model_meta, right);
                                zval_ptr_dtor(&model_meta);
                                if (ZSTR_LEN(f)) { zend_string_release(right_col); right_col = f; break; }
                                zend_string_release(f);
                            }
                            if (EG(exception) != NULL) break;
                        } ZEND_HASH_FOREACH_END();
                        zval_ptr_dtor(&models);
                    }
                    zval_ptr_dtor(&arg); zend_string_release(registry);
                }
            }
            if (EG(exception) != NULL) {
                zend_string_release(right_col); zend_string_release(left_col); zend_string_release(left); zend_string_release(right);
                zval_ptr_dtor(&candidates); zval_ptr_dtor(&errors); zend_string_release(text); return false;
            }
            if (ZSTR_LEN(right_col)) candidate_add(&candidates, &errors, meta, left_col, op, right_col);
            else {
                zend_string *msg = strpprintf(0, "no model has the column %s", ZSTR_VAL(right));
                add_next_index_str(&errors, zend_string_copy(msg));
                zend_string_release(msg);
            }
            zend_string_release(right_col);
        }
        zend_string_release(left_col); zend_string_release(left); zend_string_release(right);
    }

    uint32_t count = zend_hash_num_elements(Z_ARRVAL(candidates));
    zval *first = zend_hash_index_find(Z_ARRVAL(candidates), 0);
    if (count == 1 && first && Z_TYPE_P(first) == IS_ARRAY) {
        ZVAL_COPY(out, first); zval_ptr_dtor(&candidates); zval_ptr_dtor(&errors); zend_string_release(text); return true;
    }
    if (count == 0 && zend_hash_num_elements(Z_ARRVAL(errors)) > 0) {
        smart_str joined = {0}; zval *error; uint32_t n = 0;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(errors), error) {
            if (n++) smart_str_appends(&joined, "; ");
            if (Z_TYPE_P(error) == IS_STRING) smart_str_append(&joined, Z_STR_P(error));
        } ZEND_HASH_FOREACH_END(); smart_str_0(&joined);
        chain_fail(strpprintf(0, "%s: %s", ZSTR_VAL(text), joined.s ? ZSTR_VAL(joined.s) : ""));
        if (joined.s) zend_string_release(joined.s);
    } else if (count == 0) {
        zval *entity = field(meta, "entity");
        chain_fail(strpprintf(0, "%s is not a column of %s", ZSTR_VAL(text), entity && Z_TYPE_P(entity) == IS_STRING ? Z_STRVAL_P(entity) : ""));
    } else {
        chain_fail(strpprintf(0, "%s has more than one meaning", ZSTR_VAL(text)));
    }
    zval_ptr_dtor(&candidates); zval_ptr_dtor(&errors); zend_string_release(text); return false;
}

static bool parse_chain(zval *meta, zval *schema, zend_string *name, zval *out)
{
    zval words; chain_words(name, &words);
    uint32_t count = zend_hash_num_elements(Z_ARRVAL(words));
    if (!count) { zval_ptr_dtor(&words); fail_text("empty condition name"); return false; }
    array_init(out); uint32_t start = 0; const char *conn = "";
    for (uint32_t i = 0; i <= count; i++) {
        bool delimiter = i < count && (word_eq(&words, i, "And") || word_eq(&words, i, "Or"));
        if (i < count && !delimiter) continue;
        zval key;
        if (!parse_key(meta, schema, &words, start, i, &key)) {
            zval_ptr_dtor(&words); zval_ptr_dtor(out); ZVAL_UNDEF(out); return false;
        }
        add_assoc_string(&key, "conn", (char *)conn); add_next_index_zval(out, &key);
        if (i < count) { conn = word_eq(&words, i, "And") ? "and" : "or"; start = i + 1; }
    }
    zval_ptr_dtor(&words); return true;
}

static bool order_keys(zval *meta, zend_string *name, zval *out)
{
    zval words; chain_words(name, &words); uint32_t count = zend_hash_num_elements(Z_ARRVAL(words)), start = 0;
    array_init(out);
    for (uint32_t i = 0; i <= count; i++) {
        if (i < count && !word_eq(&words, i, "And")) continue;
        uint32_t size = i - start;
        if (size < 2 || !(word_eq(&words, i - 1, "Asc") || word_eq(&words, i - 1, "Desc"))) {
            zval_ptr_dtor(&words); zval_ptr_dtor(out); ZVAL_UNDEF(out);
            chain_fail(strpprintf(0, "orderBy%s: each key needs a column and Asc or Desc", ZSTR_VAL(name))); return false;
        }
        zend_string *pascal = word_concat(&words, start, i - 1);
        zend_string *column = column_for(meta, pascal); zend_string_release(pascal);
        if (!ZSTR_LEN(column)) {
            zval *entity = field(meta, "entity");
            zend_string *missing = join_words(&words, start, i - 1);
            zend_string *message = strpprintf(0, "orderBy%s: %s is not a column of %s", ZSTR_VAL(name), ZSTR_VAL(missing),
                entity && Z_TYPE_P(entity) == IS_STRING ? Z_STRVAL_P(entity) : "");
            zend_string_release(missing);
            zval_ptr_dtor(&words); zval_ptr_dtor(out); ZVAL_UNDEF(out);
            chain_fail(message);
            zend_string_release(column); return false;
        }
        zval item; array_init(&item); add_assoc_str(&item, "column", column); add_assoc_bool(&item, "desc", word_eq(&words, i - 1, "Desc"));
        add_next_index_zval(out, &item); start = i + 1;
    }
    zval_ptr_dtor(&words); return true;
}

static zend_string *schema_column(zend_string *hash, zend_string *pascal)
{
    zval arg, models; ZVAL_STR_COPY(&arg, hash); ZVAL_UNDEF(&models);
    zend_string *registry = zend_string_init(ZEND_STRL("Polyspec\\Orm\\Registry"), 0);
    if (!call_static(registry, "models", &models, 1, &arg) || Z_TYPE(models) != IS_ARRAY) {
        zval_ptr_dtor(&arg); zend_string_release(registry); if (!Z_ISUNDEF(models)) zval_ptr_dtor(&models); return ZSTR_EMPTY_ALLOC();
    }
    zend_string *result = ZSTR_EMPTY_ALLOC(); zval *class_name;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(models), class_name) {
        if (Z_TYPE_P(class_name) != IS_STRING) continue;
        zval meta; ZVAL_UNDEF(&meta);
        if (class_meta(Z_STR_P(class_name), &meta)) {
            zend_string *candidate = column_for(&meta, pascal); zval_ptr_dtor(&meta);
            if (ZSTR_LEN(candidate)) { zend_string_release(result); result = candidate; break; }
            zend_string_release(candidate);
        }
        if (EG(exception) != NULL) break;
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&models); zval_ptr_dtor(&arg); zend_string_release(registry); return result;
}

static zend_string *side_column(zval *side, zval *other, zend_string *pascal)
{
    if (Z_TYPE_P(side) == IS_ARRAY) return column_for(side, pascal);
    if (Z_TYPE_P(other) != IS_ARRAY) { fail_text("a column pair needs the model of one side"); return ZSTR_EMPTY_ALLOC(); }
    zval *hash = field(other, "manifest_hash");
    if (!hash || Z_TYPE_P(hash) != IS_STRING) { fail_text("a column pair needs the model of one side"); return ZSTR_EMPTY_ALLOC(); }
    return schema_column(Z_STR_P(hash), pascal);
}

static bool pair_of(zval *left, zval *right, zend_string *name, zval *schema, zval *out)
{
    zval words; chain_words(name, &words); uint32_t count = zend_hash_num_elements(Z_ARRVAL(words));
    uint32_t found = 0; zend_string *best_left = NULL, *best_right = NULL;
    for (uint32_t i = 0; i < count; i++) {
        if (!word_eq(&words, i, "With")) continue;
        zend_string *lp = word_concat(&words, 0, i), *rp = word_concat(&words, i + 1, count);
        zend_string *l = Z_TYPE_P(left) == IS_ARRAY ? column_for(left, lp) :
            (schema ? listed_column(schema, lp) : side_column(left, right, lp));
        if (EG(exception) != NULL) {
            zend_string_release(lp); zend_string_release(rp); zend_string_release(l);
            if (best_left) zend_string_release(best_left); if (best_right) zend_string_release(best_right);
            zval_ptr_dtor(&words); return false;
        }
        zend_string *r = Z_TYPE_P(right) == IS_ARRAY ? column_for(right, rp) :
            (schema ? listed_column(schema, rp) : side_column(right, left, rp));
        zend_string_release(lp); zend_string_release(rp);
        if (EG(exception) != NULL) {
            zend_string_release(l); zend_string_release(r);
            if (best_left) zend_string_release(best_left); if (best_right) zend_string_release(best_right);
            zval_ptr_dtor(&words); return false;
        }
        if (ZSTR_LEN(l) && ZSTR_LEN(r)) { found++; if (best_left) zend_string_release(best_left); if (best_right) zend_string_release(best_right); best_left = l; best_right = r; }
        else { zend_string_release(l); zend_string_release(r); }
    }
    zval_ptr_dtor(&words);
    if (found != 1) {
        if (best_left) zend_string_release(best_left); if (best_right) zend_string_release(best_right);
        chain_fail(found ? strpprintf(0, "%s has more than one meaning", ZSTR_VAL(name)) : strpprintf(0, "%s is not <column>With<column>", ZSTR_VAL(name))); return false;
    }
    array_init(out); add_index_str(out, 0, best_left); add_index_str(out, 1, best_right); return true;
}

PHP_METHOD(Polyspec_Orm_Chain, functionColumn)
{
    zval *column; ZEND_PARSE_PARAMETERS_START(1,1) Z_PARAM_ARRAY(column) ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(function_column(column));
}
PHP_METHOD(Polyspec_Orm_Chain, parseMeta)
{
    zval *meta, *schema; zend_string *name;
    ZEND_PARSE_PARAMETERS_START(3,3) Z_PARAM_ARRAY(meta) Z_PARAM_ARRAY(schema) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    if (!parse_chain(meta, schema, name, return_value)) RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_Chain, parse)
{
    zend_string *class_name, *name; ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_STR(class_name) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval meta; ZVAL_UNDEF(&meta);
    if (!class_meta(class_name, &meta)) RETURN_THROWS();
    if (!parse_chain(&meta, NULL, name, return_value)) { zval_ptr_dtor(&meta); RETURN_THROWS(); }
    zval_ptr_dtor(&meta);
}
PHP_METHOD(Polyspec_Orm_Chain, orderMeta)
{
    zval *meta; zend_string *name; ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_ARRAY(meta) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    if (!order_keys(meta, name, return_value)) RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_Chain, order)
{
    zend_string *class_name, *name; ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_STR(class_name) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval meta; ZVAL_UNDEF(&meta); if (!class_meta(class_name, &meta)) RETURN_THROWS();
    if (!order_keys(&meta, name, return_value)) { zval_ptr_dtor(&meta); RETURN_THROWS(); }
    zval_ptr_dtor(&meta);
}
PHP_METHOD(Polyspec_Orm_Chain, columnName)
{
    zval *meta; zend_string *pascal; ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_ARRAY(meta) Z_PARAM_STR(pascal) ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(column_for(meta, pascal));
}
PHP_METHOD(Polyspec_Orm_Chain, schemaColumnName)
{
    zend_string *hash, *pascal; ZEND_PARSE_PARAMETERS_START(2,2) Z_PARAM_STR(hash) Z_PARAM_STR(pascal) ZEND_PARSE_PARAMETERS_END();
    RETURN_STR(schema_column(hash, pascal));
}
PHP_METHOD(Polyspec_Orm_Chain, pair)
{
    zval *left, *right; zend_string *name;
    ZEND_PARSE_PARAMETERS_START(3,3) Z_PARAM_ARRAY_OR_NULL(left) Z_PARAM_ARRAY_OR_NULL(right) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval left_null, right_null;
    if (left == NULL) { ZVAL_NULL(&left_null); left = &left_null; }
    if (right == NULL) { ZVAL_NULL(&right_null); right = &right_null; }
    if (!pair_of(left, right, name, NULL, return_value)) RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_Chain, pairMeta)
{
    zval *left, *right, *schema; zend_string *name;
    ZEND_PARSE_PARAMETERS_START(4,4) Z_PARAM_ARRAY_OR_NULL(left) Z_PARAM_ARRAY_OR_NULL(right) Z_PARAM_ARRAY(schema) Z_PARAM_STR(name) ZEND_PARSE_PARAMETERS_END();
    zval left_null, right_null;
    if (left == NULL) { ZVAL_NULL(&left_null); left = &left_null; }
    if (right == NULL) { ZVAL_NULL(&right_null); right = &right_null; }
    if (!pair_of(left, right, name, schema, return_value)) RETURN_THROWS();
}

void polyspec_chain_register(zend_class_entry *ce)
{
    polyspec_chain_ce = ce;
}
