/* Native Markdown IR executor adapter, equivalent to packages/php/src/Markdown.php. */
#include "markdown_native.h"
#include "codec.h"
#include "engine_native.h"
#include "model_assembly.h"
#include "orm_exception_object.h"
#include "param_check_native.h"
#include "validator.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "ext/json/php_json.h"
#include "ext/standard/base64.h"
#include <string.h>
#include <stdarg.h>

zend_class_entry *polyspec_markdown_ce;
zend_class_entry *polyspec_markdown_links_ce;

static bool md_answer_errorf(const char *format, ...);
static bool md_list_same(zval *left, zval *right);

static zval *md_find(zval *value, const char *key)
{
    ZVAL_DEREF(value);
    if (Z_TYPE_P(value) == IS_ARRAY) return zend_hash_str_find(Z_ARRVAL_P(value), key, strlen(key));
    if (Z_TYPE_P(value) == IS_OBJECT) return zend_read_property(Z_OBJCE_P(value), Z_OBJ_P(value), key, strlen(key), 1, NULL);
    return NULL;
}

static zval *md_index(zval *value, zend_ulong index)
{
    ZVAL_DEREF(value);
    return Z_TYPE_P(value) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(value), index) : NULL;
}

static void md_add_copy(zval *array, const char *key, zval *value)
{
    zval copy;
    ZVAL_COPY(&copy, value);
    zend_hash_str_update(Z_ARRVAL_P(array), key, strlen(key), &copy);
}

static void md_add_index_copy(zval *array, zval *value)
{
    zval copy;
    ZVAL_COPY(&copy, value);
    add_next_index_zval(array, &copy);
}

static bool md_call_method(zval *object, const char *method, zval *result, uint32_t argc, zval *args)
{
    zend_string *lower = zend_string_init(method, strlen(method), 0);
    zend_str_tolower(ZSTR_VAL(lower), ZSTR_LEN(lower));
    zend_function *fn = zend_hash_find_ptr(&Z_OBJCE_P(object)->function_table, lower);
    zend_string_release(lower);
    if (fn == NULL) {
        zend_throw_error(NULL, "%s::%s is not available", ZSTR_VAL(Z_OBJCE_P(object)->name), method);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, Z_OBJ_P(object), Z_OBJCE_P(object), result, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool md_call_static(const char *class_name, const char *method, zval *result, uint32_t argc, zval *args)
{
    zend_string *name = zend_string_init(class_name, strlen(class_name), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return false;
    zend_string *lower = zend_string_init(method, strlen(method), 0);
    zend_str_tolower(ZSTR_VAL(lower), ZSTR_LEN(lower));
    zend_function *fn = zend_hash_find_ptr(&ce->function_table, lower);
    zend_string_release(lower);
    if (fn == NULL) {
        zend_throw_error(NULL, "%s::%s is not available", ZSTR_VAL(ce->name), method);
        return false;
    }
    ZVAL_UNDEF(result);
    zend_call_known_function(fn, NULL, ce, result, argc, args, NULL);
    return EG(exception) == NULL;
}

static bool md_instanceof(zval *value, const char *class_name)
{
    if (Z_TYPE_P(value) != IS_OBJECT) return false;
    zend_string *name = zend_string_init(class_name, strlen(class_name), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    return ce != NULL && instanceof_function(Z_OBJCE_P(value), ce);
}

static bool md_error(const char *code, zend_string *message)
{
    zval error;
    bool ok = orm_exception_object("class Polyspec\\Orm\\OrmException is not loaded", code, message, &error);
    zend_string_release(message);
    if (!ok) return false;
    zend_throw_exception_object(&error);
    return false;
}

static bool md_json_error(zval *value, zend_string **out)
{
    smart_str text = {0};
    if (php_json_encode(&text, value, 0) != SUCCESS) return false;
    smart_str_0(&text);
    *out = text.s == NULL ? zend_string_init("null", 4, 0) : text.s;
    return true;
}

static bool md_obj(zval *value)
{
    return Z_TYPE_P(value) == IS_ARRAY && (zend_hash_num_elements(Z_ARRVAL_P(value)) == 0 || !zend_array_is_list(Z_ARRVAL_P(value)));
}

static bool md_get_entity(zval *model, zval *query, zval **entity)
{
    zval *entities = md_find(model, "entities");
    zval *name = md_find(query, "entity");
    if (entities == NULL || Z_TYPE_P(entities) != IS_ARRAY || name == NULL || Z_TYPE_P(name) != IS_STRING) return false;
    *entity = zend_hash_find(Z_ARRVAL_P(entities), Z_STR_P(name));
    return *entity != NULL && Z_TYPE_P(*entity) == IS_ARRAY;
}

static zval *md_column(zval *entity, zval *name)
{
    zval *columns = md_find(entity, "columns");
    zval *column;
    if (columns == NULL || Z_TYPE_P(columns) != IS_ARRAY || Z_TYPE_P(name) != IS_STRING) return NULL;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval *candidate = md_find(column, "name");
        if (candidate != NULL && Z_TYPE_P(candidate) == IS_STRING && zend_string_equals(Z_STR_P(candidate), Z_STR_P(name))) return column;
    } ZEND_HASH_FOREACH_END();
    return NULL;
}

void polyspec_markdown_register(zend_class_entry *markdown_ce, zend_class_entry *markdown_links_ce)
{
    polyspec_markdown_ce = markdown_ce;
    polyspec_markdown_links_ce = markdown_links_ce;
}

ZEND_METHOD(Polyspec_Orm_Markdown, beginMessage)
{
    bool read_only;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_BOOL(read_only) ZEND_PARSE_PARAMETERS_END();
    array_init(return_value);
    add_assoc_string(return_value, "op", "begin");
    if (read_only) add_assoc_bool(return_value, "read_only", true);
}

ZEND_METHOD(Polyspec_Orm_Markdown, unsupported)
{
    zend_string *surface;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_STR(surface) ZEND_PARSE_PARAMETERS_END();
    zval args[2];
    ZVAL_STRING(&args[0], "CAPABILITY_UNSUPPORTED");
    ZVAL_STR(&args[1], strpprintf(0, "%s is not supported by the markdown IR executor", ZSTR_VAL(surface)));
    zend_class_entry *ce = polyspec_markdown_ce;
    (void)ce;
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *exception_ce = zend_lookup_class(name);
    zend_string_release(name);
    if (exception_ce == NULL) { zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); RETURN_THROWS(); }
    object_init_ex(return_value, exception_ce);
    zval rv;
    zend_call_known_function(exception_ce->constructor, Z_OBJ_P(return_value), exception_ce, &rv, 2, args, NULL);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) { zval_ptr_dtor(return_value); RETURN_THROWS(); }
}

static bool md_is_host_style(zend_string *style)
{
    return zend_string_equals_literal(style, "aes") || zend_string_equals_literal(style, "hex") || zend_string_equals_literal(style, "ip");
}

static bool md_param(zval *db, zval *config, zval *zone, zend_long index, zval *value, zval *uses, zval *out)
{
    zval *use = Z_TYPE_P(uses) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(uses), 0) : NULL;
    zval *type = use == NULL ? NULL : md_find(use, "type");
    zval *column = use == NULL ? NULL : md_find(use, "column");
    zval type_result;
    if (use != NULL) {
        if (!md_call_static("Polyspec\\Orm\\ParamCheck", "useSlotType", &type_result, 1, use)) return false;
    } else {
        ZVAL_EMPTY_STRING(&type_result);
    }

    zval current;
    ZVAL_COPY(&current, value);
    if (column != NULL && Z_TYPE_P(column) == IS_ARRAY && Z_TYPE_P(value) != IS_NULL) {
        zval *styles = md_find(column, "codec");
        bool host = false;
        zval *style;
        if (styles != NULL && Z_TYPE_P(styles) == IS_ARRAY) {
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(styles), style) {
                if (Z_TYPE_P(style) == IS_STRING && md_is_host_style(Z_STR_P(style))) { host = true; break; }
            } ZEND_HASH_FOREACH_END();
        }
        if (host) {
            zval *aes_key = Z_TYPE_P(config) == IS_OBJECT ? zend_read_property(Z_OBJCE_P(config), Z_OBJ_P(config), ZEND_STRL("aesKey"), 1, NULL) : md_find(config, "aesKey");
            zval host_styles; array_init(&host_styles);
            if (styles != NULL && Z_TYPE_P(styles) == IS_ARRAY) {
                zval *style;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(styles), style) {
                    if (Z_TYPE_P(style) == IS_STRING && md_is_host_style(Z_STR_P(style))) md_add_index_copy(&host_styles, style);
                } ZEND_HASH_FOREACH_END();
            }
            if (aes_key == NULL || Z_TYPE_P(aes_key) != IS_STRING ||
                !codec_host_encode(&current, Z_ARRVAL(host_styles), Z_STR_P(aes_key), out)) {
                zval_ptr_dtor(&host_styles); zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
            }
            zval_ptr_dtor(&host_styles); zval_ptr_dtor(&current);
            ZVAL_COPY(&current, out);
            zval_ptr_dtor(out);
            ZVAL_UNDEF(out);
        }
    }

    if (Z_TYPE_P(&current) == IS_OBJECT && md_instanceof(&current, "DateTimeInterface")) {
        zval create_args[1], instant, tz_args[1], localized, format_args[1], formatted;
        ZVAL_COPY(&create_args[0], &current);
        if (!md_call_static("DateTimeImmutable", "createFromInterface", &instant, 1, create_args)) {
            zval_ptr_dtor(&create_args[0]); zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
        }
        zval_ptr_dtor(&create_args[0]);
        ZVAL_COPY(&tz_args[0], zone);
        if (!md_call_method(&instant, "setTimezone", &localized, 1, tz_args)) {
            zval_ptr_dtor(&tz_args[0]); zval_ptr_dtor(&instant); zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
        }
        zval_ptr_dtor(&tz_args[0]);
        const char *pattern = "Y-m-d H:i:s.u";
        if (type != NULL && Z_TYPE_P(type) == IS_STRING && zend_string_equals_literal(Z_STR_P(type), "date")) pattern = "Y-m-d";
        else if (type != NULL && Z_TYPE_P(type) == IS_STRING && zend_string_equals_literal(Z_STR_P(type), "time")) pattern = "H:i:s.u";
        ZVAL_STRING(&format_args[0], pattern);
        if (!md_call_method(&localized, "format", &formatted, 1, format_args)) {
            zval_ptr_dtor(&format_args[0]); zval_ptr_dtor(&localized); zval_ptr_dtor(&instant); zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
        }
        zval_ptr_dtor(&format_args[0]); zval_ptr_dtor(&localized); zval_ptr_dtor(&instant);
        zval_ptr_dtor(&current); ZVAL_COPY_VALUE(&current, &formatted);
    } else if (Z_TYPE_P(&current) == IS_OBJECT && md_instanceof(&current, "Polyspec\\Orm\\Bytes")) {
        zval *bytes = zend_read_property(Z_OBJCE(current), Z_OBJ(current), ZEND_STRL("bytes"), 1, NULL);
        if (bytes == NULL || Z_TYPE_P(bytes) != IS_STRING) {
            zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
        }
        zend_string *encoded = php_base64_encode((unsigned char *)Z_STRVAL_P(bytes), Z_STRLEN_P(bytes));
        zval_ptr_dtor(&current); ZVAL_STR(&current, encoded);
    } else if (Z_TYPE_P(&current) == IS_STRING && type != NULL && Z_TYPE_P(type) == IS_STRING &&
        (zend_string_equals_literal(Z_STR_P(type), "date") || zend_string_equals_literal(Z_STR_P(type), "time") || zend_string_equals_literal(Z_STR_P(type), "datetime"))) {
        zval args[4], formatted;
        ZVAL_COPY(&args[0], &current); ZVAL_COPY(&args[1], type); ZVAL_LONG(&args[2], 6); ZVAL_COPY(&args[3], zone);
        if (!md_call_static("Polyspec\\Orm\\Db", "timeValue", &formatted, 4, args)) {
            for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
            zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
        }
        for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
        zval_ptr_dtor(&current); ZVAL_COPY_VALUE(&current, &formatted);
    } else if (Z_TYPE_P(&current) == IS_STRING && type != NULL && Z_TYPE_P(type) == IS_STRING && zend_string_equals_literal(Z_STR_P(type), "bytes")) {
        zend_string *encoded = php_base64_encode((unsigned char *)Z_STRVAL(current), Z_STRLEN(current));
        zval_ptr_dtor(&current); ZVAL_STR(&current, encoded);
    } else if (Z_TYPE_P(&current) != IS_NULL && Z_TYPE_P(&current) != IS_STRING && Z_TYPE_P(&current) != IS_LONG &&
        Z_TYPE_P(&current) != IS_DOUBLE && Z_TYPE_P(&current) != IS_TRUE && Z_TYPE_P(&current) != IS_FALSE) {
        const char *type_name = zend_zval_type_name(&current);
        md_error("CODEC_ENCODE", strpprintf(0, "parameter " ZEND_LONG_FMT " (%s) has no JSON form", index, type_name));
        zval_ptr_dtor(&current); zval_ptr_dtor(&type_result); return false;
    }
    ZVAL_COPY_VALUE(out, &current);
    zval_ptr_dtor(&type_result);
    return EG(exception) == NULL;
}

static bool md_check_param_uses(zend_long index, zval *value, zval *uses, zval *zone)
{
    if (Z_TYPE_P(uses) != IS_ARRAY) return true;
    zval *use;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(uses), use) {
        zval slot, ignored;
        if (!md_call_static("Polyspec\\Orm\\ParamCheck", "useSlotType", &slot, 1, use)) return false;
        zval assign_args[3]; ZVAL_LONG(&assign_args[0], index); ZVAL_COPY(&assign_args[1], value); ZVAL_COPY(&assign_args[2], &slot);
        bool assigned = md_call_static("Polyspec\\Orm\\ParamCheck", "checkAssign", &ignored, 3, assign_args);
        zval_ptr_dtor(&ignored); zval_ptr_dtor(&assign_args[1]); zval_ptr_dtor(&assign_args[2]);
        if (!assigned) { zval_ptr_dtor(&slot); return false; }
        bool host = false;
        zval *column = md_find(use, "column"), *styles = column == NULL ? NULL : md_find(column, "codec"), *style;
        if (styles != NULL && Z_TYPE_P(styles) == IS_ARRAY) {
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(styles), style) {
                if (Z_TYPE_P(style) == IS_STRING && md_is_host_style(Z_STR_P(style))) { host = true; break; }
            } ZEND_HASH_FOREACH_END();
        }
        if (!host) {
            zval check_args[4], checked;
            ZVAL_LONG(&check_args[0], index); ZVAL_COPY(&check_args[1], value); ZVAL_COPY(&check_args[2], &slot); ZVAL_COPY(&check_args[3], zone);
            bool checked_ok = md_call_static("Polyspec\\Orm\\ParamCheck", "check", &checked, 4, check_args);
            zval_ptr_dtor(&checked); for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&check_args[i]);
            if (!checked_ok) { zval_ptr_dtor(&slot); return false; }
        }
        zval_ptr_dtor(&slot);
    } ZEND_HASH_FOREACH_END();
    return true;
}

static bool md_call(zval *db, zval *request, zval *answer, zval *model)
{
    zval *ir = md_find(request, "ir"), *params = md_find(request, "params");
    zval *hash = ir == NULL ? NULL : md_find(ir, "manifest_hash");
    if (ir == NULL || Z_TYPE_P(ir) != IS_ARRAY || params == NULL || Z_TYPE_P(params) != IS_ARRAY || hash == NULL || Z_TYPE_P(hash) != IS_STRING) {
        zend_throw_error(NULL, "Markdown::call received an invalid Request");
        return false;
    }
    zval model_args[1]; ZVAL_COPY(&model_args[0], hash);
    if (!md_call_method(db, "registeredModel", model, 1, model_args)) { zval_ptr_dtor(&model_args[0]); return false; }
    zval_ptr_dtor(&model_args[0]);

    zval shape; ZVAL_ARR(&shape, zend_array_dup(Z_ARRVAL_P(ir)));
    if (!zend_hash_str_exists(Z_ARRVAL(shape), "n_params", sizeof("n_params") - 1)) {
        zval n; ZVAL_LONG(&n, zend_hash_num_elements(Z_ARRVAL_P(params)));
        zend_hash_str_update(Z_ARRVAL(shape), "n_params", sizeof("n_params") - 1, &n);
    }
    zend_class_entry *validator_ce;
    zend_string *validator_name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\Validator"), 0);
    validator_ce = zend_lookup_class(validator_name); zend_string_release(validator_name);
    if (validator_ce == NULL) { zval_ptr_dtor(&shape); return false; }
    zval validator;
    object_init_ex(&validator, validator_ce);
    if (EG(exception) != NULL || !validator_construct(&validator, model) || !validator_validate(&validator, Z_ARRVAL(shape))) {
        zval_ptr_dtor(&validator); zval_ptr_dtor(&shape); return false;
    }
    zval uses;
    if (!validator_param_uses(&validator, Z_ARRVAL(shape), &uses)) { zval_ptr_dtor(&validator); zval_ptr_dtor(&shape); return false; }
    zval_ptr_dtor(&validator); zval_ptr_dtor(&shape);

    zval zone, config; ZVAL_UNDEF(&zone); ZVAL_UNDEF(&config);
    if (!md_call_method(db, "zone", &zone, 0, NULL) || !md_call_method(db, "config", &config, 0, NULL)) {
        if (Z_TYPE(zone) != IS_UNDEF) zval_ptr_dtor(&zone);
        zval_ptr_dtor(&uses); return false;
    }
    zval message; array_init(&message);
    zval *version = md_find(ir, "ir_version");
    if (version != NULL) md_add_copy(&message, "ir_version", version);
    if (hash != NULL) md_add_copy(&message, "manifest_hash", hash);
    zval request_shape; ZVAL_ARR(&request_shape, zend_array_dup(Z_ARRVAL_P(ir)));
    if (!zend_hash_str_exists(Z_ARRVAL(request_shape), "n_params", sizeof("n_params") - 1)) {
        zval n; ZVAL_LONG(&n, zend_hash_num_elements(Z_ARRVAL_P(params)));
        zend_hash_str_update(Z_ARRVAL(request_shape), "n_params", sizeof("n_params") - 1, &n);
    }
    md_add_copy(&message, "request", &request_shape);
    zval_ptr_dtor(&request_shape);
    zval encoded_params; array_init_size(&encoded_params, zend_hash_num_elements(Z_ARRVAL_P(params)));
    zval *param_value; zend_ulong index; zend_string *key;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(params), index, key, param_value) {
        zval *param_uses = md_index(&uses, (zend_long)index);
        zval empty_uses; ZVAL_EMPTY_ARRAY(&empty_uses);
        if (param_uses == NULL) param_uses = &empty_uses;
        if (!md_check_param_uses((zend_long)index, param_value, param_uses, &zone)) break;
        zval param; ZVAL_UNDEF(&param);
        if (!md_param(db, &config, &zone, (zend_long)index, param_value, param_uses, &param)) {
            break;
        }
        if (key != NULL) zend_hash_update(Z_ARRVAL(encoded_params), key, &param);
        else zend_hash_index_update(Z_ARRVAL(encoded_params), index, &param);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&uses); zval_ptr_dtor(&zone); zval_ptr_dtor(&config);
    if (EG(exception) != NULL) { zval_ptr_dtor(&encoded_params); zval_ptr_dtor(&message); return false; }
    zend_hash_str_update(Z_ARRVAL(message), "params", sizeof("params") - 1, &encoded_params);
    zval clock, now, format_arg;
    ZVAL_UNDEF(&clock);
    ZVAL_STRING(&format_arg, "Y-m-d H:i:s.u");
    if (!md_call_method(db, "clock", &clock, 0, NULL) || !md_call_method(&clock, "format", &now, 1, &format_arg)) {
        if (Z_TYPE(clock) != IS_UNDEF) zval_ptr_dtor(&clock);
        zval_ptr_dtor(&format_arg); zval_ptr_dtor(&message); return false;
    }
    zval_ptr_dtor(&format_arg); zval_ptr_dtor(&clock);
    zend_hash_str_update(Z_ARRVAL(message), "now", sizeof("now") - 1, &now);
    zval session;
    if (!md_call_method(db, "markdownSession", &session, 0, NULL)) { zval_ptr_dtor(&message); return false; }
    zval call_args[1]; ZVAL_COPY(&call_args[0], &message);
    bool ok = md_call_method(&session, "call", answer, 1, call_args);
    zval_ptr_dtor(&call_args[0]); zval_ptr_dtor(&session); zval_ptr_dtor(&message);
    return ok;
}

static bool md_out_col(zval *model, zval *query, zval *entity, bool groups, zend_string *name, zend_long index, zval *out)
{
    zval column_name; ZVAL_STR_COPY(&column_name, name);
    if (groups && zend_string_equals_literal(name, "row_count")) {
        array_init(out); add_assoc_long(out, "index", index); add_assoc_str(out, "name", zend_string_copy(name)); add_assoc_string(out, "type", "i64");
        zval_ptr_dtor(&column_name); return true;
    }
    zval *subcols = md_find(query, "columns");
    zval *submap = subcols == NULL ? NULL : md_find(subcols, "sub");
    zval *sub = submap != NULL && Z_TYPE_P(submap) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(submap), name) : NULL;
    if (!groups && sub != NULL) {
        zval *agg = md_find(sub, "agg");
        const char *type = "text";
        if (agg != NULL && Z_TYPE_P(agg) == IS_STRING && zend_string_equals_literal(Z_STR_P(agg), "count")) type = "i64";
        else if (agg != NULL && Z_TYPE_P(agg) == IS_STRING && zend_string_equals_literal(Z_STR_P(agg), "avg")) type = "f64";
        else {
            zval *subquery = md_find(sub, "query"), *subentity = NULL, *subcolumn = md_find(sub, "column");
            if (subquery != NULL && subcolumn != NULL && md_get_entity(model, subquery, &subentity)) {
                zval *field = md_column(subentity, subcolumn), *field_type = field == NULL ? NULL : md_find(field, "type");
                if (field_type != NULL && Z_TYPE_P(field_type) == IS_STRING) type = Z_STRVAL_P(field_type);
            }
        }
        array_init(out); add_assoc_long(out, "index", index); add_assoc_str(out, "name", zend_string_copy(name)); add_assoc_string(out, "type", type);
        zval_ptr_dtor(&column_name); return true;
    }
    zval *fnmap = subcols == NULL ? NULL : md_find(subcols, "fn");
    zval *function = fnmap != NULL && Z_TYPE_P(fnmap) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(fnmap), name) : NULL;
    if (!groups && function != NULL) {
        zval *field_name = md_find(function, "column"), *field = field_name == NULL ? NULL : md_column(entity, field_name), *fn = md_find(function, "fn");
        zval *fn_name = fn == NULL ? NULL : md_find(fn, "name");
        if (field == NULL || fn_name == NULL) { zval_ptr_dtor(&column_name); zval *missing_entity = md_find(query, "entity");
            return md_answer_errorf("%s is missing from validated column-function metadata", missing_entity != NULL && Z_TYPE_P(missing_entity) == IS_STRING ? Z_STRVAL_P(missing_entity) : "?"); }
        zval args[2], type;
        ZVAL_COPY(&args[0], fn_name); ZVAL_COPY(&args[1], field);
        if (!md_call_static("Polyspec\\Orm\\Validator", "functionType", &type, 2, args)) {
            zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&column_name); return false;
        }
        zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
        array_init(out); add_assoc_long(out, "index", index); add_assoc_str(out, "name", zend_string_copy(name)); add_assoc_str(out, "column", zend_string_copy(Z_STR_P(field_name))); md_add_copy(out, "type", &type); zval_ptr_dtor(&type);
        zval_ptr_dtor(&column_name); return true;
    }
    zval *column = md_column(entity, &column_name);
    if (column == NULL) {
        zval *entity_name = md_find(query, "entity");
        const char *ent_name = entity_name != NULL && Z_TYPE_P(entity_name) == IS_STRING ? Z_STRVAL_P(entity_name) : "?";
        zval_ptr_dtor(&column_name);
        return md_answer_errorf("%s answers %s, which is no output of the request", ent_name, ZSTR_VAL(name));
    }
    zval *type = md_find(column, "type"), *styles = md_find(column, "codec");
    array_init(out); add_assoc_long(out, "index", index); add_assoc_str(out, "name", zend_string_copy(name)); add_assoc_str(out, "column", zend_string_copy(name));
    if (type != NULL) md_add_copy(out, "type", type); else add_assoc_string(out, "type", "text");
    if (styles != NULL && Z_TYPE_P(styles) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(styles)) > 0) md_add_copy(out, "styles", styles);
    zval_ptr_dtor(&column_name); return true;
}

static bool md_relation_items(zval *value, zval *query, zend_string *rel, zval *out)
{
    if (value == NULL || Z_TYPE_P(value) == IS_NULL) { array_init(out); return true; }
    if (Z_TYPE_P(value) != IS_ARRAY) {
        zend_string *encoded = NULL;
        if (!md_json_error(value, &encoded)) return md_answer_errorf("relation %s answers a value that is not JSON", ZSTR_VAL(rel));
        bool ok = md_answer_errorf("relation %s answers %s, not rows", ZSTR_VAL(rel), ZSTR_VAL(encoded)); zend_string_release(encoded); return ok;
    }
    zval *key_by = md_find(query, "key_by");
    if ((key_by != NULL && Z_TYPE_P(key_by) == IS_STRING && Z_STRLEN_P(key_by) != 0) || zend_array_is_list(Z_ARRVAL_P(value))) {
        ZVAL_ARR(out, zend_array_dup(Z_ARRVAL_P(value)));
    } else {
        array_init_size(out, 1); md_add_index_copy(out, value);
    }
    return true;
}

static bool md_layout(zval *model, zval *query, bool groups, zval *rows, zval *out)
{
    zval *entity = NULL;
    if (!md_get_entity(model, query, &entity)) {
        return md_answer_errorf("the runtime model has no entity for the validated request");
    }
    zval *join_list = md_find(query, "joins"), *rel_list = md_find(query, "relations");
    zval joins, rels; array_init(&joins); array_init(&rels);
    zval *item;
    if (join_list != NULL && Z_TYPE_P(join_list) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(join_list), item) {
            zval *rel = md_find(item, "rel"); if (rel != NULL && Z_TYPE_P(rel) == IS_STRING) md_add_copy(&joins, Z_STRVAL_P(rel), item);
        } ZEND_HASH_FOREACH_END();
    }
    if (rel_list != NULL && Z_TYPE_P(rel_list) == IS_ARRAY) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rel_list), item) {
            zval *rel = md_find(item, "rel"); if (rel != NULL && Z_TYPE_P(rel) == IS_STRING) md_add_copy(&rels, Z_STRVAL_P(rel), item);
        } ZEND_HASH_FOREACH_END();
    }
    array_init(out);
    zval *entity_name = md_find(query, "entity"); if (entity_name != NULL) md_add_copy(out, "entity", entity_name);
    zval columns, keys, children; array_init(&columns); array_init(&keys); array_init(&children);
    zval *first = rows != NULL && Z_TYPE_P(rows) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(rows), 0) : NULL;
    zval outputs; array_init(&outputs);
    bool has_outputs = false;
    if (first == NULL && groups) {
        zval *group_by = md_find(query, "group_by"), *name;
        if (group_by != NULL && Z_TYPE_P(group_by) == IS_ARRAY) {
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(group_by), name) { md_add_index_copy(&outputs, name); } ZEND_HASH_FOREACH_END();
        }
        add_next_index_string(&outputs, "row_count"); has_outputs = true;
    } else if (first != NULL) {
        if (!md_obj(first)) {
            zval *name = md_find(query, "entity");
            return md_answer_errorf("a row of %s is not a JSON object", name != NULL ? Z_STRVAL_P(name) : "?");
        }
        zval *value; zend_string *key; zend_ulong numeric;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(first), numeric, key, value) {
            (void)value;
            zend_string *name = key != NULL ? key : strpprintf(0, ZEND_LONG_FMT, (zend_long)numeric);
            bool skip = zend_hash_exists(Z_ARRVAL(joins), name) || zend_hash_exists(Z_ARRVAL(rels), name);
            if (!skip) { zval n; ZVAL_STR_COPY(&n, name); add_next_index_zval(&outputs, &n); }
            if (key == NULL) zend_string_release(name);
        } ZEND_HASH_FOREACH_END(); has_outputs = true;
    }
    if (has_outputs) {
        zval *name; zend_ulong output_index = 0;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(outputs), name) {
            if (Z_TYPE_P(name) != IS_STRING) continue;
            zval col;
            if (!md_out_col(model, query, entity, groups, Z_STR_P(name), (zend_long)output_index, &col)) { zval_ptr_dtor(&outputs); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&columns); zval_ptr_dtor(&keys); zval_ptr_dtor(&children); zval_ptr_dtor(out); return false; }
            add_next_index_zval(&columns, &col); output_index++;
        } ZEND_HASH_FOREACH_END();
        zval *key_names = groups ? md_find(query, "group_by") : md_find(entity, "pk");
        if (key_names != NULL && Z_TYPE_P(key_names) == IS_ARRAY) {
            zval *key_name; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(key_names), key_name) {
                zend_long found = -1; zval *candidate; zend_ulong idx = 0;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL(outputs), candidate) { if (Z_TYPE_P(candidate) == IS_STRING && Z_TYPE_P(key_name) == IS_STRING && zend_string_equals(Z_STR_P(candidate), Z_STR_P(key_name))) { found = (zend_long)idx; break; } idx++; } ZEND_HASH_FOREACH_END();
                if (found < 0) { zval *ename = md_find(query, "entity"); zval_ptr_dtor(&outputs); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&columns); zval_ptr_dtor(&keys); zval_ptr_dtor(&children); zval_ptr_dtor(out); return md_answer_errorf("%s answers no %s, a key of its rows", ename != NULL ? Z_STRVAL_P(ename) : "?", Z_STRVAL_P(key_name)); }
                zval key; array_init(&key); md_add_copy(&key, "column", key_name); add_assoc_long(&key, "index", found); add_next_index_zval(&keys, &key);
            } ZEND_HASH_FOREACH_END();
        }
    }
    add_assoc_zval(out, "columns", &columns); add_assoc_zval(out, "key", &keys);

    if (join_list != NULL && Z_TYPE_P(join_list) == IS_ARRAY) {
        zval *join; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(join_list), join) {
            zval *rel = md_find(join, "rel"), *child_query = md_find(join, "query");
            if (rel == NULL || Z_TYPE_P(rel) != IS_STRING || child_query == NULL) continue;
            zval child_rows; array_init(&child_rows);
            if (rows != NULL && Z_TYPE_P(rows) == IS_ARRAY) {
                zval *row; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
                    zval *child = md_obj(row) ? md_find(row, Z_STRVAL_P(rel)) : NULL;
                    if (child != NULL && Z_TYPE_P(child) != IS_NULL) { md_add_index_copy(&child_rows, child); break; }
                } ZEND_HASH_FOREACH_END();
            }
            zval child_asm;
            if (!md_layout(model, child_query, false, &child_rows, &child_asm)) { zval_ptr_dtor(&child_rows); zval_ptr_dtor(&outputs); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&children); zval_ptr_dtor(out); return false; }
            zval child; array_init(&child); md_add_copy(&child, "rel", rel); add_assoc_string(&child, "kind", "join"); add_assoc_zval(&child, "assemble", &child_asm); add_next_index_zval(&children, &child); zval_ptr_dtor(&child_rows);
        } ZEND_HASH_FOREACH_END();
    }
    if (rel_list != NULL && Z_TYPE_P(rel_list) == IS_ARRAY) {
        zval *relation; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rel_list), relation) {
            zval *rel = md_find(relation, "rel"), *child_query = md_find(relation, "query"), *rel_keys = md_find(relation, "keys");
            if (rel == NULL || Z_TYPE_P(rel) != IS_STRING || child_query == NULL) continue;
            zval child_rows; array_init(&child_rows);
            if (rows != NULL && Z_TYPE_P(rows) == IS_ARRAY) {
                zval *row; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
                    zval *value = md_obj(row) ? md_find(row, Z_STRVAL_P(rel)) : NULL;
                    zval items;
                    if (!md_relation_items(value, child_query, Z_STR_P(rel), &items)) { zval_ptr_dtor(&child_rows); zval_ptr_dtor(&outputs); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&children); zval_ptr_dtor(out); return false; }
                    if (zend_hash_num_elements(Z_ARRVAL(items)) > 0) { zval *item0 = zend_hash_index_find(Z_ARRVAL(items), 0); md_add_index_copy(&child_rows, item0); zval_ptr_dtor(&items); break; }
                    zval_ptr_dtor(&items);
                } ZEND_HASH_FOREACH_END();
            }
            zval child_asm;
            if (!md_layout(model, child_query, false, &child_rows, &child_asm)) { zval_ptr_dtor(&child_rows); zval_ptr_dtor(&outputs); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&children); zval_ptr_dtor(out); return false; }
            zval child; array_init(&child); md_add_copy(&child, "rel", rel);
            zval *kind = md_find(relation, "kind"); if (kind != NULL) md_add_copy(&child, "kind", kind);
            zval *flatten = md_find(child_query, "flatten"); add_assoc_bool(&child, "flatten", flatten != NULL && zend_is_true(flatten));
            add_assoc_zval(&child, "assemble", &child_asm);
            zval *target = NULL; md_get_entity(model, child_query, &target);
            zval parent_keys, child_keys; ZVAL_UNDEF(&parent_keys); ZVAL_UNDEF(&child_keys);
            zval *pk_parent = md_find(entity, "pk"), *pk_target = target == NULL ? NULL : md_find(target, "pk");
            if (rel_keys != NULL && Z_TYPE_P(rel_keys) == IS_ARRAY) {
                array_init(&parent_keys); array_init(&child_keys); zval *pair;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rel_keys), pair) { zval *left = md_find(pair, "left"), *right = md_find(pair, "right"); if (left) md_add_index_copy(&parent_keys, left); if (right) md_add_index_copy(&child_keys, right); } ZEND_HASH_FOREACH_END();
            }
            bool default_cascade = pk_parent != NULL && Z_TYPE(parent_keys) == IS_ARRAY && md_list_same(pk_parent, &parent_keys);
            bool child_diff = pk_target != NULL && Z_TYPE(child_keys) == IS_ARRAY && !md_list_same(pk_target, &child_keys);
            zval *no_cascade = md_find(child_query, "no_cascade_delete"); add_assoc_bool(&child, "cascade", (no_cascade == NULL || !zend_is_true(no_cascade)) && default_cascade && child_diff);
            if (Z_TYPE(parent_keys) != IS_UNDEF) zval_ptr_dtor(&parent_keys); if (Z_TYPE(child_keys) != IS_UNDEF) zval_ptr_dtor(&child_keys);
            add_next_index_zval(&children, &child); zval_ptr_dtor(&child_rows);
        } ZEND_HASH_FOREACH_END();
    }
    add_assoc_zval(out, "children", &children);
    zval_ptr_dtor(&outputs); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels);
    return EG(exception) == NULL;
}

static bool md_answer_errorf(const char *format, ...)
{
    va_list args; va_start(args, format); zend_string *detail = zend_vstrpprintf(0, format, args); va_end(args);
    zend_string *message = strpprintf(0, "the flowmark answer: %s", ZSTR_VAL(detail)); zend_string_release(detail);
    return md_error("INTERNAL", message);
}

static bool md_list_same(zval *left, zval *right)
{
    if (Z_TYPE_P(left) != IS_ARRAY || Z_TYPE_P(right) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(left)) != zend_hash_num_elements(Z_ARRVAL_P(right))) return false;
    zval *a, *b; zend_ulong index = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(left), a) {
        b = zend_hash_index_find(Z_ARRVAL_P(right), index++);
        if (b == NULL || !fast_is_identical_function(a, b)) return false;
    } ZEND_HASH_FOREACH_END();
    return true;
}

static bool md_relation_items(zval *value, zval *query, zend_string *rel, zval *out);
static bool md_rows(zval *config, zval *model, zval *query, zval *assembly, zval *rows, zval *out);

static bool md_answer_value(zval *value, zend_string *type, zend_string *where, zval *out)
{
    if (Z_TYPE_P(value) == IS_NULL) { ZVAL_NULL(out); return true; }
    bool ok = false;
    if (zend_string_equals_literal(type, "i16") || zend_string_equals_literal(type, "i32") || zend_string_equals_literal(type, "i64")) ok = Z_TYPE_P(value) == IS_LONG;
    else if (zend_string_equals_literal(type, "f64")) ok = Z_TYPE_P(value) == IS_LONG || Z_TYPE_P(value) == IS_DOUBLE;
    else if (zend_string_equals_literal(type, "bool")) ok = Z_TYPE_P(value) == IS_TRUE || Z_TYPE_P(value) == IS_FALSE;
    else ok = Z_TYPE_P(value) == IS_STRING;
    if (ok && zend_string_equals_literal(type, "bytes")) {
        zend_string *decoded = php_base64_decode_ex((unsigned char *)Z_STRVAL_P(value), Z_STRLEN_P(value), true);
        if (decoded == NULL) ok = false;
        else { ZVAL_STR(out, decoded); return true; }
    }
    if (!ok) {
        zend_string *encoded = NULL;
        if (!md_json_error(value, &encoded)) encoded = zend_string_init("null", sizeof("null") - 1, 0);
        md_answer_errorf("%s: the answer value %s is not a %s value", ZSTR_VAL(where), ZSTR_VAL(encoded), ZSTR_VAL(type));
        zend_string_release(encoded); return false;
    }
    if (zend_string_equals_literal(type, "f64") && Z_TYPE_P(value) == IS_LONG) ZVAL_DOUBLE(out, (double)Z_LVAL_P(value));
    else ZVAL_COPY(out, value);
    return true;
}

static bool md_rows(zval *config, zval *model, zval *query, zval *assembly, zval *rows, zval *out)
{
    if (Z_TYPE_P(rows) != IS_ARRAY || Z_TYPE_P(assembly) != IS_ARRAY) return md_answer_errorf("rows or assembly is not an array");
    zval *join_list = md_find(query, "joins"), *rel_list = md_find(query, "relations"), *columns = md_find(assembly, "columns"), *children = md_find(assembly, "children");
    zval joins, rels, child_assemblies; array_init(&joins); array_init(&rels); array_init(&child_assemblies);
    zval *item;
    if (join_list != NULL && Z_TYPE_P(join_list) == IS_ARRAY) ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(join_list), item) { zval *rel = md_find(item, "rel"); if (rel && Z_TYPE_P(rel) == IS_STRING) md_add_copy(&joins, Z_STRVAL_P(rel), item); } ZEND_HASH_FOREACH_END();
    if (rel_list != NULL && Z_TYPE_P(rel_list) == IS_ARRAY) ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rel_list), item) { zval *rel = md_find(item, "rel"); if (rel && Z_TYPE_P(rel) == IS_STRING) md_add_copy(&rels, Z_STRVAL_P(rel), item); } ZEND_HASH_FOREACH_END();
    if (children != NULL && Z_TYPE_P(children) == IS_ARRAY) ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(children), item) { zval *rel = md_find(item, "rel"), *assemble = md_find(item, "assemble"); if (rel && assemble && Z_TYPE_P(rel) == IS_STRING) md_add_copy(&child_assemblies, Z_STRVAL_P(rel), assemble); } ZEND_HASH_FOREACH_END();
    array_init_size(out, zend_hash_num_elements(Z_ARRVAL_P(rows)));
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        if (!md_obj(row)) { zval *entity_name = md_find(query, "entity"); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return md_answer_errorf("a row of %s is not a JSON object", entity_name && Z_TYPE_P(entity_name) == IS_STRING ? Z_STRVAL_P(entity_name) : "?"); }
        zval values, join_values, rel_values; array_init(&values); array_init(&join_values); array_init(&rel_values);
        zend_ulong value_index = 0; zend_string *key; zend_ulong numeric; zval *value;
        ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(row), numeric, key, value) {
            zend_string *name = key != NULL ? key : strpprintf(0, ZEND_LONG_FMT, (zend_long)numeric);
            zval *join = zend_hash_find(Z_ARRVAL(joins), name);
            zval *relation = zend_hash_find(Z_ARRVAL(rels), name);
            if (join != NULL) {
                zval *join_query = md_find(join, "query"), *child_asm = zend_hash_find(Z_ARRVAL(child_assemblies), name);
                if (Z_TYPE_P(value) == IS_NULL) { zval null; ZVAL_NULL(&null); zend_hash_update(Z_ARRVAL(join_values), name, &null); }
                else {
                    zval one, child_values;
                    array_init(&one); md_add_index_copy(&one, value);
                    if (join_query == NULL || child_asm == NULL || !md_rows(config, model, join_query, child_asm, &one, &child_values)) { zval_ptr_dtor(&one); if (key == NULL) zend_string_release(name); zval_ptr_dtor(&values); zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return false; }
                    zval_ptr_dtor(&one); zval *first = zend_hash_index_find(Z_ARRVAL(child_values), 0); zval copy; if (first != NULL) ZVAL_COPY(&copy, first); else ZVAL_NULL(&copy); zend_hash_update(Z_ARRVAL(join_values), name, &copy); zval_ptr_dtor(&child_values);
                }
            } else if (relation != NULL) {
                zval *rel_query = md_find(relation, "query"), *child_asm = zend_hash_find(Z_ARRVAL(child_assemblies), name), items, child_values;
                if (rel_query == NULL || child_asm == NULL || !md_relation_items(value, rel_query, name, &items) || !md_rows(config, model, rel_query, child_asm, &items, &child_values)) { if (key == NULL) zend_string_release(name); zval_ptr_dtor(&values); zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return false; }
                zend_hash_update(Z_ARRVAL(rel_values), name, &child_values); zval_ptr_dtor(&items);
            } else {
                zval *column = columns != NULL && Z_TYPE_P(columns) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(columns), value_index) : NULL;
                zval *column_name = column == NULL ? NULL : md_find(column, "name"), *type = column == NULL ? NULL : md_find(column, "type");
                zval *entity_name = md_find(query, "entity");
                if (column_name == NULL || type == NULL || Z_TYPE_P(column_name) != IS_STRING || !zend_string_equals(Z_STR_P(column_name), name) || Z_TYPE_P(type) != IS_STRING) {
                    const char *expected = column_name != NULL && Z_TYPE_P(column_name) == IS_STRING ? Z_STRVAL_P(column_name) : "no more outputs";
                    bool err = md_answer_errorf("a row of %s answers %s where its first row answers %s", entity_name != NULL ? Z_STRVAL_P(entity_name) : "?", ZSTR_VAL(name), expected);
                    if (key == NULL) zend_string_release(name); zval_ptr_dtor(&values); zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return err;
                }
                zval decoded; zend_string *where = strpprintf(0, "%s.%s", entity_name != NULL ? Z_STRVAL_P(entity_name) : "?", ZSTR_VAL(name));
                bool decoded_ok = md_answer_value(value, Z_STR_P(type), where, &decoded); zend_string_release(where);
                if (!decoded_ok) { if (key == NULL) zend_string_release(name); zval_ptr_dtor(&values); zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return false; }
                add_next_index_zval(&values, &decoded); value_index++;
            }
            if (key == NULL) zend_string_release(name);
        } ZEND_HASH_FOREACH_END();
        if (columns != NULL && Z_TYPE_P(columns) == IS_ARRAY && value_index != zend_hash_num_elements(Z_ARRVAL_P(columns))) { zval *entity_name = md_find(query, "entity"); zval_ptr_dtor(&values); zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return md_answer_errorf("a row of %s answers %" ZEND_LONG_FMT " outputs, its first row %" ZEND_LONG_FMT, entity_name != NULL ? Z_STRVAL_P(entity_name) : "?", (zend_long)value_index, (zend_long)zend_hash_num_elements(Z_ARRVAL_P(columns))); }
        zend_class_entry *links_ce = polyspec_markdown_links_ce;
        if (links_ce == NULL) { zval_ptr_dtor(&values); zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values); zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies); zval_ptr_dtor(out); return false; }
        zval links; object_init_ex(&links, links_ce);
        zend_update_property(links_ce, Z_OBJ(links), ZEND_STRL("joins"), &join_values);
        zend_update_property(links_ce, Z_OBJ(links), ZEND_STRL("rels"), &rel_values);
        zval_ptr_dtor(&join_values); zval_ptr_dtor(&rel_values);
        add_next_index_zval(&values, &links); add_next_index_zval(out, &values);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&joins); zval_ptr_dtor(&rels); zval_ptr_dtor(&child_assemblies);
    zval cell_args[2], cells;
    ZVAL_COPY(&cell_args[0], assembly); ZVAL_COPY(&cell_args[1], model);
    if (!md_call_static("Polyspec\\Orm\\Assemble", "cells", &cells, 2, cell_args)) { zval_ptr_dtor(&cell_args[0]); zval_ptr_dtor(&cell_args[1]); zval_ptr_dtor(out); return false; }
    zval_ptr_dtor(&cell_args[0]); zval_ptr_dtor(&cell_args[1]);
    if (Z_TYPE(cells) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL(cells)) > 0 && !codec_decode_rows(Z_ARRVAL_P(out), Z_ARRVAL(cells), config)) { zval_ptr_dtor(&cells); zval_ptr_dtor(out); return false; }
    zval_ptr_dtor(&cells);
    return EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Markdown, read)
{
    zval *db, *request;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_OBJECT(db) Z_PARAM_OBJECT(request) ZEND_PARSE_PARAMETERS_END();
    zval answer, model;
    if (!md_call(db, request, &answer, &model)) RETURN_THROWS();
    zval *ir = md_find(request, "ir"), *kind = ir == NULL ? NULL : md_find(ir, "kind");
    zval *rows = md_find(&answer, "rows");
    if (rows == NULL || Z_TYPE_P(rows) != IS_ARRAY || !zend_array_is_list(Z_ARRVAL_P(rows))) {
        const char *kind_name = kind != NULL && Z_TYPE_P(kind) == IS_STRING ? Z_STRVAL_P(kind) : "?";
        md_answer_errorf("a %s answer has no rows", kind_name); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS();
    }
    zval *count = md_find(&answer, "count");
    if (kind != NULL && Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "paginate") && (count == NULL || Z_TYPE_P(count) != IS_LONG)) {
        md_answer_errorf("a paginate answer has no count"); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS();
    }
    bool groups = kind != NULL && Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "group_count");
    zval assembly;
    if (!md_layout(&model, ir, groups, rows, &assembly)) { zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
    zval plan, steps, step; array_init(&plan); array_init(&steps); array_init(&step);
    if (kind != NULL) md_add_copy(&plan, "kind", kind);
    add_assoc_string(&step, "role", "main"); md_add_copy(&step, "assemble", &assembly); add_next_index_zval(&steps, &step); add_assoc_zval(&plan, "steps", &steps);
    if (!assemble_index(&plan, &model)) { zval_ptr_dtor(&assembly); zval_ptr_dtor(&plan); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
    zval *config = md_find(db, "config");
    zval *indexed_step = md_index(md_find(&plan, "steps"), 0);
    zval *indexed_assembly = indexed_step == NULL ? NULL : md_find(indexed_step, "assemble");
    zval main_rows;
    if (indexed_assembly == NULL || !md_rows(config, &model, ir, indexed_assembly, rows, &main_rows)) { zval_ptr_dtor(&assembly); zval_ptr_dtor(&plan); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
    zval result, empty_steps; array_init(&result); array_init(&empty_steps);
    md_add_copy(&result, "main", &main_rows); add_assoc_zval(&result, "steps", &empty_steps);
    zval *params = md_find(request, "params");
    if (params != NULL) md_add_copy(&result, "params", params); else { zval empty_params; array_init(&empty_params); add_assoc_zval(&result, "params", &empty_params); }
    add_assoc_bool(&result, "markdown", true);
    array_init_size(return_value, 3); add_next_index_zval(return_value, &plan); add_next_index_zval(return_value, &result);
    if (count != NULL && Z_TYPE_P(count) == IS_LONG) add_next_index_long(return_value, Z_LVAL_P(count)); else add_next_index_long(return_value, 0);
    zval_ptr_dtor(&assembly); zval_ptr_dtor(&answer); zval_ptr_dtor(&model);
}

ZEND_METHOD(Polyspec_Orm_Markdown, scalar)
{
    zval *db, *request;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_OBJECT(db) Z_PARAM_OBJECT(request) ZEND_PARSE_PARAMETERS_END();
    zval answer, model;
    if (!md_call(db, request, &answer, &model)) RETURN_THROWS();
    zval *ir = md_find(request, "ir"), *kind = ir == NULL ? NULL : md_find(ir, "kind");
    if (kind != NULL && Z_TYPE_P(kind) == IS_STRING && zend_string_equals_literal(Z_STR_P(kind), "count")) {
        zval *count = md_find(&answer, "count");
        if (count == NULL || Z_TYPE_P(count) != IS_LONG) { md_answer_errorf("a count answer has no count"); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
        RETVAL_COPY(count); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); return;
    }
    zval *value = md_find(&answer, "value");
    if (value == NULL) { md_answer_errorf("a %s answer has no value", kind != NULL ? Z_STRVAL_P(kind) : "?"); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
    if (Z_TYPE_P(value) != IS_NULL && Z_TYPE_P(value) != IS_LONG && Z_TYPE_P(value) != IS_DOUBLE && Z_TYPE_P(value) != IS_STRING) {
        zend_string *encoded = NULL; if (!md_json_error(value, &encoded)) encoded = zend_string_init("null", 4, 0);
        md_answer_errorf("the value %s is no number", ZSTR_VAL(encoded)); zend_string_release(encoded); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS();
    }
    RETVAL_COPY(value); zval_ptr_dtor(&answer); zval_ptr_dtor(&model);
}

ZEND_METHOD(Polyspec_Orm_Markdown, write)
{
    zval *db, *request;
    ZEND_PARSE_PARAMETERS_START(2, 2) Z_PARAM_OBJECT(db) Z_PARAM_OBJECT(request) ZEND_PARSE_PARAMETERS_END();
    zval answer, model;
    if (!md_call(db, request, &answer, &model)) RETURN_THROWS();
    zval *ir = md_find(request, "ir"), *kind = ir == NULL ? NULL : md_find(ir, "kind");
    const char *kind_name = kind != NULL && Z_TYPE_P(kind) == IS_STRING ? Z_STRVAL_P(kind) : "?";
    zval *affected = md_find(&answer, "affected");
    if (affected == NULL || Z_TYPE_P(affected) != IS_LONG) { md_answer_errorf("a %s answer has no affected", kind_name); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
    zval *keys = md_find(&answer, "keys");
    zval empty_keys;
    if (keys == NULL) { array_init(&empty_keys); keys = &empty_keys; }
    else if (Z_TYPE_P(keys) != IS_ARRAY || !zend_array_is_list(Z_ARRVAL_P(keys))) { md_answer_errorf("a %s answer has keys that are no list", kind_name); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS(); }
    zval values; array_init_size(&values, zend_hash_num_elements(Z_ARRVAL_P(keys)));
    zval *value; ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), value) {
        if (Z_TYPE_P(value) != IS_NULL && Z_TYPE_P(value) != IS_LONG && Z_TYPE_P(value) != IS_DOUBLE && Z_TYPE_P(value) != IS_STRING) {
            zend_string *encoded = NULL; if (!md_json_error(value, &encoded)) encoded = zend_string_init("null", 4, 0);
            md_answer_errorf("the value %s is no number", ZSTR_VAL(encoded)); zend_string_release(encoded); zval_ptr_dtor(&values); zval_ptr_dtor(&answer); zval_ptr_dtor(&model); RETURN_THROWS();
        }
        md_add_index_copy(&values, value);
    } ZEND_HASH_FOREACH_END();
    array_init_size(return_value, 2); add_next_index_zval(return_value, &values); add_next_index_long(return_value, Z_LVAL_P(affected));
    if (keys == &empty_keys) zval_ptr_dtor(&empty_keys);
    zval_ptr_dtor(&answer); zval_ptr_dtor(&model);
}

ZEND_METHOD(Polyspec_Orm_Markdown, links)
{
    zval *row;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ARRAY(row) ZEND_PARSE_PARAMETERS_END();
    zval *last = zend_hash_index_find(Z_ARRVAL_P(row), zend_hash_num_elements(Z_ARRVAL_P(row)) == 0 ? 0 : zend_hash_num_elements(Z_ARRVAL_P(row)) - 1);
    if (last != NULL && Z_TYPE_P(last) == IS_OBJECT && polyspec_markdown_links_ce != NULL && instanceof_function(Z_OBJCE_P(last), polyspec_markdown_links_ce)) RETURN_COPY(last);
    if (polyspec_markdown_links_ce == NULL) { zend_throw_error(NULL, "Polyspec\\Orm\\MarkdownLinks is not registered"); RETURN_THROWS(); }
    object_init_ex(return_value, polyspec_markdown_links_ce);
}
