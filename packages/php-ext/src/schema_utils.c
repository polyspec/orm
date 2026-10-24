/* Native schema inspection and installation for Polyspec\\Orm\\SchemaUtils. */
#include "dbspec.h"

#include "Zend/zend_smart_str.h"

static zend_class_entry *schema_utils_ce;
static zend_class_entry *schema_ce;

static bool schema_utils_require_schema(zval *schema, const char *method)
{
    if (schema_ce == NULL) {
        zend_string *name = zend_string_init("Polyspec\\Orm\\Schema", sizeof("Polyspec\\Orm\\Schema") - 1, 0);
        schema_ce = zend_lookup_class(name);
        zend_string_release(name);
    }
    if (schema_ce == NULL) return false;
    if (instanceof_function(Z_OBJCE_P(schema), schema_ce)) return true;
    zend_type_error("SchemaUtils::%s expects a Schema", method);
    return false;
}

static bool schema_utils_call(zval *object, const char *method, zval *result, uint32_t argc, zval *argv)
{
    ZVAL_UNDEF(result);
    zval function;
    ZVAL_STRING(&function, method);
    zend_result status = call_user_function(NULL, object, &function, result, argc, argv);
    zval_ptr_dtor(&function);
    return status == SUCCESS && EG(exception) == NULL;
}

static zval *schema_utils_db(zval *object)
{
    zval rv;
    return zend_read_property(schema_utils_ce, Z_OBJ_P(object), "db", sizeof("db") - 1, true, &rv);
}

static bool schema_utils_static(const char *method, zval *result, uint32_t argc, zval *argv)
{
    char function[128];
    snprintf(function, sizeof(function), "Polyspec\\Orm\\Dbspec\\Dbspec::%s", method);
    return scall(function, result, argc, argv);
}

static bool schema_utils_target(zval *documents, zval *target)
{
    zval manifest_args[1], manifest_result;
    ZVAL_COPY(&manifest_args[0], documents);
    bool ok = schema_utils_static("manifest", &manifest_result, 1, manifest_args);
    zval_ptr_dtor(&manifest_args[0]);
    if (!ok) return false;
    zval *manifest = zend_read_property(Z_OBJCE(manifest_result), Z_OBJ(manifest_result), "manifest", sizeof("manifest") - 1, true, NULL);
    if (Z_TYPE_P(manifest) != IS_OBJECT) {
        zval_ptr_dtor(&manifest_result);
        db_throw_orm("SCHEMA_INVALID", "the document set has diagnostics");
        return false;
    }
    zval external;
    array_init(&external);
    zval *document;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(documents), document) {
        zval *is_external = zend_read_property(Z_OBJCE_P(document), Z_OBJ_P(document), "external", sizeof("external") - 1, true, NULL);
        if (!zend_is_true(is_external)) continue;
        zval emitted, args[1];
        ZVAL_COPY(&args[0], document);
        if (!schema_utils_static("emit", &emitted, 1, args)) {
            zval_ptr_dtor(&args[0]);
            zval_ptr_dtor(&external);
            zval_ptr_dtor(&manifest_result);
            return false;
        }
        zval_ptr_dtor(&args[0]);
        zval *name = zend_read_property(Z_OBJCE_P(document), Z_OBJ_P(document), "name", sizeof("name") - 1, true, NULL);
        if (Z_TYPE_P(name) != IS_STRING || Z_TYPE(emitted) != IS_STRING) {
            zval_ptr_dtor(&emitted);
            zval_ptr_dtor(&external);
            zval_ptr_dtor(&manifest_result);
            db_throw_orm("INTERNAL", "external document name or text is not a string");
            return false;
        }
        zend_hash_update(Z_ARRVAL(external), Z_STR_P(name), &emitted);
    } ZEND_HASH_FOREACH_END();
    zval schema_text, parse_args[2], parsed;
    zval *text = zend_read_property(Z_OBJCE_P(manifest), Z_OBJ_P(manifest), "schemaText", sizeof("schemaText") - 1, true, NULL);
    ZVAL_COPY(&schema_text, text);
    ZVAL_COPY(&parse_args[0], &schema_text);
    ZVAL_COPY(&parse_args[1], &external);
    ok = schema_utils_static("parse", &parsed, 2, parse_args);
    zval_ptr_dtor(&parse_args[0]);
    zval_ptr_dtor(&parse_args[1]);
    zval_ptr_dtor(&schema_text);
    zval_ptr_dtor(&external);
    zval_ptr_dtor(&manifest_result);
    if (!ok) return false;
    zval *parsed_document = zend_read_property(Z_OBJCE(parsed), Z_OBJ(parsed), "document", sizeof("document") - 1, true, NULL);
    if (Z_TYPE_P(parsed_document) != IS_OBJECT) {
        zval_ptr_dtor(&parsed);
        db_throw_orm("SCHEMA_INVALID", "the rendered manifest has diagnostics");
        return false;
    }
    ZVAL_COPY(target, parsed_document);
    zval_ptr_dtor(&parsed);
    return true;
}

static bool schema_utils_introspect(zval *db, zval *pdo, zval *driver, zval *transaction, zval *result)
{
    catalog_observer_scope scope;
    dbs_catalog_observer_enter(&scope, db, transaction);
    zval args[3];
    ZVAL_COPY(&args[0], pdo);
    ZVAL_COPY(&args[1], driver);
    ZVAL_STRING(&args[2], "schema");
    bool ok = schema_utils_static("introspect", result, 3, args);
    for (size_t i = 0; i < 3; i++) zval_ptr_dtor(&args[i]);
    dbs_catalog_observer_leave(&scope);
    return ok;
}

static bool schema_utils_differences(zval *live, zval *unsupported, zval *documents, zval *target, const char *method,
    const char *code)
{
    zval args[3], differences;
    uint32_t argc = 3;
    ZVAL_COPY(&args[0], live);
    ZVAL_COPY(&args[1], unsupported);
    ZVAL_COPY(&args[2], target);
    if (strcmp(method, "externalDifferences") == 0) {
        argc = 2;
        zval_ptr_dtor(&args[1]);
        ZVAL_COPY(&args[1], documents);
    }
    bool ok = schema_utils_static(method, &differences, argc, args);
    for (size_t i = 0; i < argc; i++) zval_ptr_dtor(&args[i]);
    if (!ok) return false;
    bool found = Z_TYPE(differences) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL(differences)) != 0;
    if (found) {
        smart_str message = {0};
        zval *difference;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(differences), difference) {
            if (message.s != NULL) smart_str_appends(&message, "; ");
            zend_string *text = zval_get_string(difference);
            smart_str_append(&message, text);
            zend_string_release(text);
        } ZEND_HASH_FOREACH_END();
        smart_str_0(&message);
        db_throw_orm(code, "%s", message.s == NULL ? "schema differs" : ZSTR_VAL(message.s));
        smart_str_free(&message);
    }
    zval_ptr_dtor(&differences);
    return !found;
}

typedef struct {
    zval *db;
    zval *pdo;
    zval *driver;
    zval *documents;
    zval *target;
    zval *statements;
} schema_install_context;

typedef struct {
    zval *db;
    zval *pdo;
    zval *driver;
    zval *documents;
    zval *target;
    zval *transaction;
} schema_add_context;

static bool schema_utils_run(zval *db, const char *kind_name, zval *tables, zval *transaction, const char *sql);

static bool schema_utils_add_body(zval *db, void *opaque, zval *result)
{
    schema_add_context *base = opaque;
    zval transaction;
    ZVAL_UNDEF(&transaction);
    if (base->transaction != NULL) ZVAL_COPY(&transaction, base->transaction);
    else if (!schema_utils_call(db, "transactionNumber", &transaction, 0, NULL)) return false;
    schema_add_context active = *base;
    active.transaction = &transaction;
    schema_add_context *context = &active;
    zval live;
    ZVAL_UNDEF(&live);
    if (!schema_utils_introspect(db, context->pdo, context->driver, context->transaction, &live)) {
        zval_ptr_dtor(&transaction);
        return false;
    }
    zval *live_document = zend_read_property(Z_OBJCE(live), Z_OBJ(live), "document", sizeof("document") - 1, true, NULL);
    zval *unsupported = zend_read_property(Z_OBJCE(live), Z_OBJ(live), "unsupported", sizeof("unsupported") - 1, true, NULL);
    if (!schema_utils_differences(live_document, unsupported, context->documents, context->target,
            "externalDifferences", "CONFIG")) {
        zval_ptr_dtor(&live);
        zval_ptr_dtor(&transaction);
        return false;
    }
    zval args[4], plan;
    ZVAL_COPY(&args[0], live_document);
    ZVAL_COPY(&args[1], unsupported);
    ZVAL_COPY(&args[2], context->target);
    ZVAL_COPY(&args[3], context->driver);
    bool ok = schema_utils_static("addTablesAndColumnsSteps", &plan, 4, args);
    for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    if (!ok) {
        zval_ptr_dtor(&live);
        return false;
    }
    zval *added = zend_hash_index_find(Z_ARRVAL(plan), 0);
    zval *steps = zend_hash_index_find(Z_ARRVAL(plan), 1);
    zval *differences = zend_hash_index_find(Z_ARRVAL(plan), 2);
    if (differences == NULL || Z_TYPE_P(differences) != IS_ARRAY) {
        db_throw_orm("INTERNAL", "schema evolution plan is malformed");
        ok = false;
        goto plan_done;
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(differences)) != 0) {
        smart_str message = {0};
        zval *difference;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(differences), difference) {
            if (message.s != NULL) smart_str_appends(&message, "; ");
            zend_string *text = zval_get_string(difference);
            smart_str_append(&message, text);
            zend_string_release(text);
        } ZEND_HASH_FOREACH_END();
        smart_str_0(&message);
        db_throw_orm("SCHEMA_DIFFERS", "the existing tables differ beyond supported additions: %s",
            message.s == NULL ? "" : ZSTR_VAL(message.s));
        smart_str_free(&message);
        ok = false;
        goto plan_done;
    }
    if (steps == NULL || Z_TYPE_P(steps) != IS_ARRAY || added == NULL || Z_TYPE_P(added) != IS_ARRAY) {
        db_throw_orm("INTERNAL", "schema evolution plan is malformed");
        ok = false;
        goto plan_done;
    }
    zval *step;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(steps), step) {
        zval *sql = zend_read_property(Z_OBJCE_P(step), Z_OBJ_P(step), "statement", sizeof("statement") - 1, true, NULL);
        zval *effect = zend_read_property(Z_OBJCE_P(step), Z_OBJ_P(step), "effect", sizeof("effect") - 1, true, NULL);
        zval *table = zend_read_property(Z_OBJCE_P(effect), Z_OBJ_P(effect), "table", sizeof("table") - 1, true, NULL);
        zval kind, tables, run_args[4], ignored;
        ZVAL_STRING(&kind, "schema");
        array_init(&tables);
        if (Z_TYPE_P(table) == IS_STRING && Z_STRLEN_P(table) > 0) add_next_index_str(&tables, zend_string_copy(Z_STR_P(table)));
        ZVAL_COPY(&run_args[0], &kind);
        ZVAL_COPY(&run_args[1], &tables);
        ZVAL_COPY(&run_args[2], context->transaction);
        ZVAL_COPY(&run_args[3], sql);
        ok = schema_utils_call(db, "run", &ignored, 4, run_args);
        for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&run_args[i]);
        zval_ptr_dtor(&kind);
        zval_ptr_dtor(&tables);
        if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
        if (!ok) break;
    } ZEND_HASH_FOREACH_END();
    if (!ok) goto plan_done;
    if (zend_hash_num_elements(Z_ARRVAL_P(steps)) != 0) {
        zval_ptr_dtor(&live);
        ZVAL_UNDEF(&live);
        if (!schema_utils_introspect(db, context->pdo, context->driver, context->transaction, &live)) {
            ok = false;
            goto plan_done;
        }
        live_document = zend_read_property(Z_OBJCE(live), Z_OBJ(live), "document", sizeof("document") - 1, true, NULL);
        unsupported = zend_read_property(Z_OBJCE(live), Z_OBJ(live), "unsupported", sizeof("unsupported") - 1, true, NULL);
    }
    ok = schema_utils_differences(live_document, unsupported, context->documents, context->target,
        "installedDifferences", "CONFIG");
    if (ok) ZVAL_COPY(result, added);
plan_done:
    zval_ptr_dtor(&plan);
    if (!Z_ISUNDEF(live)) zval_ptr_dtor(&live);
    zval_ptr_dtor(&transaction);
    return ok && EG(exception) == NULL;
}

static bool schema_utils_sqlite_foreign_key_check(zval *db, zval *transaction)
{
    zval kind, tables, args[5], rows;
    ZVAL_STRING(&kind, "schema");
    array_init(&tables);
    ZVAL_COPY(&args[0], &kind);
    ZVAL_COPY(&args[1], &tables);
    ZVAL_COPY(&args[2], transaction);
    ZVAL_STRING(&args[3], "SELECT COUNT(*) FROM pragma_foreign_key_check");
    array_init(&args[4]);
    bool ok = schema_utils_call(db, "fetch", &rows, 5, args);
    for (size_t i = 0; i < 5; i++) zval_ptr_dtor(&args[i]);
    zval_ptr_dtor(&kind);
    zval_ptr_dtor(&tables);
    if (!ok) return false;
    zval *row = Z_TYPE(rows) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL(rows), 0) : NULL;
    zval *count = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 0) : NULL;
    if (count != NULL && zval_get_long(count) > 0) {
        db_throw_orm("INTERNAL", "the rebuilt tables break %lld foreign keys", (long long)zval_get_long(count));
        ok = false;
    }
    zval_ptr_dtor(&rows);
    return ok;
}

static bool schema_utils_sqlite_add_body(zval *db, schema_add_context *context, zval *result)
{
    zval empty_tables, no_transaction;
    array_init(&empty_tables);
    ZVAL_NULL(&no_transaction);
    if (!schema_utils_run(db, "utility", &empty_tables, &no_transaction, "PRAGMA foreign_keys = OFF")) {
        zval_ptr_dtor(&empty_tables);
        zval_ptr_dtor(&no_transaction);
        return false;
    }
    zval_ptr_dtor(&empty_tables);

    zval transaction;
    ZVAL_UNDEF(&transaction);
    if (!schema_utils_call(db, "nextTransaction", &transaction, 0, NULL)) {
        zval_ptr_dtor(&no_transaction);
        return false;
    }
    array_init(&empty_tables);
    bool began = schema_utils_run(db, "begin", &empty_tables, &transaction, "BEGIN IMMEDIATE");
    zval_ptr_dtor(&empty_tables);
    zval primary;
    ZVAL_UNDEF(&primary);
    bool ok = began;
    if (!began) {
        ZVAL_OBJ(&primary, take_exception());
    } else {
        schema_add_context active = *context;
        active.transaction = &transaction;
        ok = schema_utils_add_body(db, &active, result);
        if (ok) ok = schema_utils_sqlite_foreign_key_check(db, &transaction);
        if (!ok) {
            ZVAL_OBJ(&primary, take_exception());
            array_init(&empty_tables);
            bool rolled_back = schema_utils_run(db, "rollback", &empty_tables, &transaction, "ROLLBACK");
            zval_ptr_dtor(&empty_tables);
            if (!rolled_back) {
                zval rollback;
                ZVAL_OBJ(&rollback, take_exception());
                zval args[2], combined;
                ZVAL_COPY(&args[0], &primary);
                ZVAL_COPY(&args[1], &rollback);
                if (scall("Polyspec\\Orm\\OrmException::rollback", &combined, 2, args)) {
                    zval_ptr_dtor(&primary);
                    ZVAL_COPY_VALUE(&primary, &combined);
                }
                zval_ptr_dtor(&args[0]);
                zval_ptr_dtor(&args[1]);
                zval_ptr_dtor(&rollback);
            }
        } else {
            array_init(&empty_tables);
            ok = schema_utils_run(db, "commit", &empty_tables, &transaction, "COMMIT");
            zval_ptr_dtor(&empty_tables);
            if (!ok) ZVAL_OBJ(&primary, take_exception());
        }
    }
    array_init(&empty_tables);
    bool restored = schema_utils_run(db, "utility", &empty_tables, &no_transaction, "PRAGMA foreign_keys = ON");
    zval_ptr_dtor(&empty_tables);
    zval_ptr_dtor(&no_transaction);
    zval_ptr_dtor(&transaction);
    if (!restored) {
        if (!Z_ISUNDEF(primary)) zval_ptr_dtor(&primary);
        return false;
    }
    if (!Z_ISUNDEF(primary)) {
        zend_throw_exception_object(&primary);
        return false;
    }
    return ok && EG(exception) == NULL;
}

static bool schema_utils_run(zval *db, const char *kind_name, zval *tables, zval *transaction, const char *sql)
{
    zval kind, query, args[4], result;
    ZVAL_STRING(&kind, kind_name);
    ZVAL_STRING(&query, sql);
    ZVAL_COPY(&args[0], &kind);
    ZVAL_COPY(&args[1], tables);
    ZVAL_COPY(&args[2], transaction);
    ZVAL_COPY(&args[3], &query);
    bool ok = schema_utils_call(db, "run", &result, 4, args);
    for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
    zval_ptr_dtor(&kind);
    zval_ptr_dtor(&query);
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    return ok;
}

static bool schema_utils_install_body(zval *db, void *opaque, zval *result)
{
    schema_install_context *context = opaque;
    zval transaction, live;
    ZVAL_UNDEF(&transaction);
    ZVAL_UNDEF(&live);
    bool ok = schema_utils_call(db, "transactionNumber", &transaction, 0, NULL);
    if (ok) ok = schema_utils_introspect(db, context->pdo, context->driver, &transaction, &live);
    zval *live_document = ok ? zend_read_property(Z_OBJCE(live), Z_OBJ(live), "document", sizeof("document") - 1, true, NULL) : NULL;
    zval *unsupported = ok ? zend_read_property(Z_OBJCE(live), Z_OBJ(live), "unsupported", sizeof("unsupported") - 1, true, NULL) : NULL;
    if (ok) ok = schema_utils_differences(live_document, unsupported, context->documents, context->target,
        "externalDifferences", "CONFIG");
    if (!ok) goto finish;

    zval found;
    array_init(&found);
    zval present, missing;
    array_init(&present);
    array_init(&missing);
    zval *tables = zend_read_property(Z_OBJCE_P(context->target), Z_OBJ_P(context->target), "tables", sizeof("tables") - 1, true, NULL);
    zval *table;
    zval *live_tables = zend_read_property(Z_OBJCE_P(live_document), Z_OBJ_P(live_document), "tables", sizeof("tables") - 1, true, NULL);
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(live_tables), table) {
        zval *name = zend_read_property(Z_OBJCE_P(table), Z_OBJ_P(table), "name", sizeof("name") - 1, true, NULL);
        if (Z_TYPE_P(name) == IS_STRING) {
            zval present_flag;
            ZVAL_TRUE(&present_flag);
            zend_hash_update(Z_ARRVAL(found), Z_STR_P(name), &present_flag);
        }
    } ZEND_HASH_FOREACH_END();
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(unsupported), table) {
        zval *name = zend_read_property(Z_OBJCE_P(table), Z_OBJ_P(table), "table", sizeof("table") - 1, true, NULL);
        if (Z_TYPE_P(name) == IS_STRING) {
            zval present_flag;
            ZVAL_TRUE(&present_flag);
            zend_hash_update(Z_ARRVAL(found), Z_STR_P(name), &present_flag);
        }
    } ZEND_HASH_FOREACH_END();
    bool any_present = false, any_missing = false;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(tables), table) {
        zval *name = zend_read_property(Z_OBJCE_P(table), Z_OBJ_P(table), "name", sizeof("name") - 1, true, NULL);
        if (Z_TYPE_P(name) != IS_STRING) continue;
        if (zend_hash_exists(Z_ARRVAL(found), Z_STR_P(name))) {
            any_present = true;
            add_next_index_str(&present, zend_string_copy(Z_STR_P(name)));
        } else {
            any_missing = true;
            add_next_index_str(&missing, zend_string_copy(Z_STR_P(name)));
        }
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&found);
    if (any_present && any_missing) {
        smart_str names = {0};
        zval *name;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(present), name) {
            if (names.s != NULL) smart_str_appends(&names, ", ");
            smart_str_append(&names, Z_STR_P(name));
        } ZEND_HASH_FOREACH_END();
        smart_str_0(&names);
        db_throw_orm("CONFIG", "the database holds only some tables of the document set: %s",
            names.s == NULL ? "" : ZSTR_VAL(names.s));
        smart_str_free(&names);
        zval_ptr_dtor(&present);
        zval_ptr_dtor(&missing);
        ok = false;
        goto finish;
    }
    zval_ptr_dtor(&present);
    zval_ptr_dtor(&missing);
    if (any_missing) {
        zval *statement;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(context->statements), statement) {
            zval *sql = zend_hash_index_find(Z_ARRVAL_P(statement), 0);
            zval *name = zend_hash_index_find(Z_ARRVAL_P(statement), 1);
            zval kind, affected, args[4], ignored;
            ZVAL_STRING(&kind, "schema");
            array_init(&affected);
            if (Z_TYPE_P(name) == IS_STRING) add_next_index_str(&affected, zend_string_copy(Z_STR_P(name)));
            ZVAL_COPY(&args[0], &kind);
            ZVAL_COPY(&args[1], &affected);
            ZVAL_COPY(&args[2], &transaction);
            ZVAL_COPY(&args[3], sql);
            ok = schema_utils_call(db, "run", &ignored, 4, args);
            for (size_t i = 0; i < 4; i++) zval_ptr_dtor(&args[i]);
            zval_ptr_dtor(&kind);
            zval_ptr_dtor(&affected);
            if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
            if (!ok) break;
        } ZEND_HASH_FOREACH_END();
        if (!ok) goto finish;
        zval_ptr_dtor(&live);
        ZVAL_UNDEF(&live);
        ok = schema_utils_introspect(db, context->pdo, context->driver, &transaction, &live);
        if (!ok) goto finish;
        live_document = zend_read_property(Z_OBJCE(live), Z_OBJ(live), "document", sizeof("document") - 1, true, NULL);
        unsupported = zend_read_property(Z_OBJCE(live), Z_OBJ(live), "unsupported", sizeof("unsupported") - 1, true, NULL);
    }
    ok = schema_utils_differences(live_document, unsupported, context->documents, context->target,
        "installedDifferences", "CONFIG");
finish:
    if (!Z_ISUNDEF(live)) zval_ptr_dtor(&live);
    if (!Z_ISUNDEF(transaction)) zval_ptr_dtor(&transaction);
    if (ok) ZVAL_NULL(result);
    return ok && EG(exception) == NULL;
}

static bool schema_utils_identifier(zend_string *value)
{
    if (ZSTR_LEN(value) == 0) return false;
    const unsigned char *text = (const unsigned char *)ZSTR_VAL(value);
    if (!((text[0] >= 'A' && text[0] <= 'Z') || (text[0] >= 'a' && text[0] <= 'z') || text[0] == '_')) return false;
    for (size_t i = 1; i < ZSTR_LEN(value); i++) {
        unsigned char ch = text[i];
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_') continue;
        return false;
    }
    return true;
}

static bool schema_utils_bool(zval *db, zend_string *sql, zval *args, zval *result)
{
    zval surface, ignored;
    ZVAL_STRING(&surface, "schema inspection");
    bool supported = schema_utils_call(db, "unsupportedOnMarkdown", &ignored, 1, &surface);
    zval_ptr_dtor(&surface);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    if (!supported) return false;
    zval kind, tables, transaction, call_args[5], rows;
    ZVAL_STRING(&kind, "schema");
    array_init(&tables);
    ZVAL_NULL(&transaction);
    ZVAL_COPY(&call_args[0], &kind);
    ZVAL_COPY(&call_args[1], &tables);
    ZVAL_COPY(&call_args[2], &transaction);
    ZVAL_STR_COPY(&call_args[3], sql);
    ZVAL_COPY(&call_args[4], args);
    bool ok = schema_utils_call(db, "fetch", &rows, 5, call_args);
    for (size_t i = 0; i < 5; i++) zval_ptr_dtor(&call_args[i]);
    zval_ptr_dtor(&kind);
    zval_ptr_dtor(&tables);
    if (!ok) return false;
    zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
    zval *value = row != NULL && Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 0) : NULL;
    ZVAL_BOOL(result, value != NULL && zend_is_true(value));
    zval_ptr_dtor(&rows);
    return true;
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, __construct)
{
    zval *db, *utils;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(db)
        Z_PARAM_OBJECT(utils)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *db_name = zend_string_init("Polyspec\\Orm\\Db", sizeof("Polyspec\\Orm\\Db") - 1, 0);
    zend_class_entry *db_ce = zend_lookup_class(db_name);
    zend_string_release(db_name);
    zend_string *utils_name = zend_string_init("Polyspec\\Orm\\Utils", sizeof("Polyspec\\Orm\\Utils") - 1, 0);
    zend_class_entry *utils_ce = zend_lookup_class(utils_name);
    zend_string_release(utils_name);
    if (db_ce == NULL || utils_ce == NULL || !instanceof_function(Z_OBJCE_P(db), db_ce)
        || !instanceof_function(Z_OBJCE_P(utils), utils_ce)) {
        zend_type_error("SchemaUtils expects a Db and Utils");
        RETURN_THROWS();
    }
    zend_update_property(schema_utils_ce, Z_OBJ_P(ZEND_THIS), "db", sizeof("db") - 1, db);
    zend_update_property(schema_utils_ce, Z_OBJ_P(ZEND_THIS), "u", sizeof("u") - 1, utils);
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, register)
{
    zval *schema;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(schema)
    ZEND_PARSE_PARAMETERS_END();
    if (!schema_utils_require_schema(schema, "register")) RETURN_THROWS();
    zval args[1], result;
    ZVAL_COPY(&args[0], schema);
    bool ok = schema_utils_call(schema_utils_db(ZEND_THIS), "registerSet", &result, 1, args);
    zval_ptr_dtor(&args[0]);
    if (!ok) RETURN_THROWS();
    if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, install)
{
    zval *schema;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(schema)
    ZEND_PARSE_PARAMETERS_END();
    if (!schema_utils_require_schema(schema, "install")) RETURN_THROWS();
    zval *db = schema_utils_db(ZEND_THIS);
    zval surface, ignored;
    ZVAL_STRING(&surface, "schema install (flowmark install creates a corpus)");
    bool ok = schema_utils_call(db, "unsupportedOnMarkdown", &ignored, 1, &surface);
    zval_ptr_dtor(&surface);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    if (!ok) RETURN_THROWS();
    if (!schema_utils_call(schema, "verify", &ignored, 0, NULL)) RETURN_THROWS();
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);

    zval driver, documents, render, target, pdo, statements;
    ZVAL_UNDEF(&driver);
    ZVAL_UNDEF(&documents);
    ZVAL_UNDEF(&render);
    ZVAL_UNDEF(&target);
    ZVAL_UNDEF(&pdo);
    ZVAL_UNDEF(&statements);
    if (!schema_utils_call(db, "driver", &driver, 0, NULL)
        || !schema_utils_call(schema, "documents", &documents, 0, NULL)) goto failed;
    zval render_args[2];
    ZVAL_COPY(&render_args[0], &documents);
    ZVAL_COPY(&render_args[1], &driver);
    ok = schema_utils_static("render", &render, 2, render_args);
    zval_ptr_dtor(&render_args[0]);
    zval_ptr_dtor(&render_args[1]);
    if (!ok) goto failed;
    zval *rendered_statements = zend_read_property(Z_OBJCE(render), Z_OBJ(render), "statements", sizeof("statements") - 1, true, NULL);
    if (Z_TYPE_P(rendered_statements) != IS_ARRAY) {
        db_throw_orm("SCHEMA_INVALID", "the document set has diagnostics");
        goto failed;
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(rendered_statements)) == 0) {
        db_throw_orm("CONFIG", "the document set has no tables");
        goto failed;
    }
    if (!schema_utils_render_statements(&documents, Z_STR(driver), &statements)) {
        if (EG(exception) == NULL) db_throw_orm("INTERNAL", "the renderer did not return its table mapping");
        goto failed;
    }
    if (!schema_utils_target(&documents, &target) || !schema_utils_call(db, "pdo", &pdo, 0, NULL)) goto failed;

    bool mysql = zend_string_equals_literal(Z_STR(driver), "mysql");
    if (mysql) {
        zval active_args[1], active;
        ZVAL_COPY(&active_args[0], db);
        ok = scall("Polyspec\\Orm\\Db::activeFor", &active, 1, active_args);
        zval_ptr_dtor(&active_args[0]);
        if (!ok) goto failed;
        bool is_active = Z_TYPE(active) != IS_NULL;
        zval_ptr_dtor(&active);
        if (is_active) {
            db_throw_orm("CONFIG", "MySQL commits schema statements implicitly; install outside a transaction");
            goto failed;
        }
    }
    schema_install_context context = {db, &pdo, &driver, &documents, &target, &statements};
    if (mysql) {
        ZVAL_NULL(return_value);
        ok = schema_utils_install_body(db, &context, return_value);
    } else {
        ok = db_transaction_native(db, schema_utils_install_body, &context, return_value);
    }
    if (!ok) goto failed;
    zval register_args[1], registered;
    ZVAL_COPY(&register_args[0], schema);
    ok = schema_utils_call(db, "registerSet", &registered, 1, register_args);
    zval_ptr_dtor(&register_args[0]);
    if (!Z_ISUNDEF(registered)) zval_ptr_dtor(&registered);
    if (!ok) goto failed;
    if (!Z_ISUNDEF(driver)) zval_ptr_dtor(&driver);
    if (!Z_ISUNDEF(documents)) zval_ptr_dtor(&documents);
    if (!Z_ISUNDEF(render)) zval_ptr_dtor(&render);
    if (!Z_ISUNDEF(target)) zval_ptr_dtor(&target);
    if (!Z_ISUNDEF(pdo)) zval_ptr_dtor(&pdo);
    if (!Z_ISUNDEF(statements)) zval_ptr_dtor(&statements);
    RETURN_NULL();
failed:
    if (!Z_ISUNDEF(driver)) zval_ptr_dtor(&driver);
    if (!Z_ISUNDEF(documents)) zval_ptr_dtor(&documents);
    if (!Z_ISUNDEF(render)) zval_ptr_dtor(&render);
    if (!Z_ISUNDEF(target)) zval_ptr_dtor(&target);
    if (!Z_ISUNDEF(pdo)) zval_ptr_dtor(&pdo);
    if (!Z_ISUNDEF(statements)) zval_ptr_dtor(&statements);
    RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, addTablesAndColumns)
{
    zval *schema;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(schema)
    ZEND_PARSE_PARAMETERS_END();
    if (!schema_utils_require_schema(schema, "addTablesAndColumns")) RETURN_THROWS();
    zval *db = schema_utils_db(ZEND_THIS);
    zval surface, ignored;
    ZVAL_STRING(&surface, "addTablesAndColumns (schema evolution follows the flowmark migration rules)");
    bool ok = schema_utils_call(db, "unsupportedOnMarkdown", &ignored, 1, &surface);
    zval_ptr_dtor(&surface);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    if (!ok) RETURN_THROWS();
    if (!schema_utils_call(schema, "verify", &ignored, 0, NULL)) RETURN_THROWS();
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);

    zval driver, documents, target, pdo;
    ZVAL_UNDEF(&driver);
    ZVAL_UNDEF(&documents);
    ZVAL_UNDEF(&target);
    ZVAL_UNDEF(&pdo);
    if (!schema_utils_call(db, "driver", &driver, 0, NULL)
        || !schema_utils_call(schema, "documents", &documents, 0, NULL)
        || !schema_utils_target(&documents, &target)
        || !schema_utils_call(db, "pdo", &pdo, 0, NULL)) goto add_failed;

    bool postgres = zend_string_equals_literal(Z_STR(driver), "postgres");
    bool mysql = zend_string_equals_literal(Z_STR(driver), "mysql");
    if (!postgres) {
        zval active_args[1], active;
        ZVAL_COPY(&active_args[0], db);
        ok = scall("Polyspec\\Orm\\Db::activeFor", &active, 1, active_args);
        zval_ptr_dtor(&active_args[0]);
        if (!ok) goto add_failed;
        bool is_active = Z_TYPE(active) != IS_NULL;
        zval_ptr_dtor(&active);
        if (is_active) {
            db_throw_orm("CONFIG", "%s adds tables and columns outside a transaction: MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table", ZSTR_VAL(Z_STR(driver)));
            goto add_failed;
        }
    }

    schema_add_context context = {db, &pdo, &driver, &documents, &target, NULL};
    if (postgres || mysql) {
        if (postgres) ok = db_transaction_native(db, schema_utils_add_body, &context, return_value);
        else ok = schema_utils_add_body(db, &context, return_value);
        if (!ok) goto add_failed;
    } else {
        zval result;
        ZVAL_UNDEF(&result);
        ok = schema_utils_sqlite_add_body(db, &context, &result);
        if (!ok) {
            if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
            goto add_failed;
        }
        ZVAL_COPY_VALUE(return_value, &result);
    }
    if (!Z_ISUNDEF(driver)) zval_ptr_dtor(&driver);
    if (!Z_ISUNDEF(documents)) zval_ptr_dtor(&documents);
    if (!Z_ISUNDEF(target)) zval_ptr_dtor(&target);
    if (!Z_ISUNDEF(pdo)) zval_ptr_dtor(&pdo);
    return;
add_failed:
    if (!Z_ISUNDEF(driver)) zval_ptr_dtor(&driver);
    if (!Z_ISUNDEF(documents)) zval_ptr_dtor(&documents);
    if (!Z_ISUNDEF(target)) zval_ptr_dtor(&target);
    if (!Z_ISUNDEF(pdo)) zval_ptr_dtor(&pdo);
    RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, exists)
{
    zend_string *schema;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(schema)
    ZEND_PARSE_PARAMETERS_END();
    if (!schema_utils_identifier(schema)) {
        db_throw_orm("CONFIG", "identifier %s is invalid", ZSTR_VAL(schema));
        RETURN_THROWS();
    }
    zval driver;
    if (!schema_utils_call(schema_utils_db(ZEND_THIS), "driver", &driver, 0, NULL)) RETURN_THROWS();
    zend_string *sql;
    zval args;
    array_init(&args);
    if (zend_string_equals_literal(Z_STR(driver), "postgres")) {
        sql = zend_string_init("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)", sizeof("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)") - 1, 0);
        add_next_index_str(&args, zend_string_copy(schema));
    } else if (zend_string_equals_literal(Z_STR(driver), "mysql")) {
        sql = zend_string_init("SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)", sizeof("SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)") - 1, 0);
        add_next_index_str(&args, zend_string_copy(schema));
    } else {
        sql = zend_string_init("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", sizeof("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')") - 1, 0);
        smart_str pattern = {0};
        for (size_t index = 0; index < ZSTR_LEN(schema); index++) {
            if (ZSTR_VAL(schema)[index] == '_') smart_str_appends(&pattern, "\\_");
            else smart_str_appendc(&pattern, ZSTR_VAL(schema)[index]);
        }
        smart_str_appends(&pattern, "\\_\\_%");
        smart_str_0(&pattern);
        add_next_index_str(&args, pattern.s);
    }
    zval_ptr_dtor(&driver);
    bool ok = schema_utils_bool(schema_utils_db(ZEND_THIS), sql, &args, return_value);
    zend_string_release(sql);
    zval_ptr_dtor(&args);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, installed)
{
    zend_string *schema, *table;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(schema)
        Z_PARAM_STR(table)
    ZEND_PARSE_PARAMETERS_END();
    if (!schema_utils_identifier(schema) || !schema_utils_identifier(table)) {
        db_throw_orm("CONFIG", "schema or table identifier is invalid");
        RETURN_THROWS();
    }
    zval driver;
    if (!schema_utils_call(schema_utils_db(ZEND_THIS), "driver", &driver, 0, NULL)) RETURN_THROWS();
    zend_string *sql;
    zval args;
    array_init(&args);
    if (zend_string_equals_literal(Z_STR(driver), "postgres")) {
        sql = zend_string_init("SELECT to_regclass($1) IS NOT NULL", sizeof("SELECT to_regclass($1) IS NOT NULL") - 1, 0);
        add_next_index_str(&args, strpprintf(0, "%s.%s", ZSTR_VAL(schema), ZSTR_VAL(table)));
    } else if (zend_string_equals_literal(Z_STR(driver), "mysql")) {
        sql = zend_string_init("SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)", sizeof("SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)") - 1, 0);
        add_next_index_str(&args, zend_string_copy(schema));
        add_next_index_str(&args, zend_string_copy(table));
    } else {
        sql = zend_string_init("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)", sizeof("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)") - 1, 0);
        add_next_index_str(&args, strpprintf(0, "%s__%s", ZSTR_VAL(schema), ZSTR_VAL(table)));
    }
    zval_ptr_dtor(&driver);
    bool ok = schema_utils_bool(schema_utils_db(ZEND_THIS), sql, &args, return_value);
    zend_string_release(sql);
    zval_ptr_dtor(&args);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_SchemaUtils, empty)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval driver, args;
    if (!schema_utils_call(schema_utils_db(ZEND_THIS), "driver", &driver, 0, NULL)) RETURN_THROWS();
    array_init(&args);
    zend_string *sql;
    if (zend_string_equals_literal(Z_STR(driver), "postgres")) {
        sql = zend_string_init("SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))", sizeof("SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))") - 1, 0);
    } else if (zend_string_equals_literal(Z_STR(driver), "mysql")) {
        sql = zend_string_init("SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())", sizeof("SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())") - 1, 0);
    } else {
        sql = zend_string_init("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' ESCAPE '\\')", sizeof("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' ESCAPE '\\')") - 1, 0);
    }
    zval_ptr_dtor(&driver);
    bool ok = schema_utils_bool(schema_utils_db(ZEND_THIS), sql, &args, return_value);
    zend_string_release(sql);
    zval_ptr_dtor(&args);
    if (!ok) RETURN_THROWS();
}

void schema_utils_set_class(zend_class_entry *ce)
{
    schema_utils_ce = ce;
}
