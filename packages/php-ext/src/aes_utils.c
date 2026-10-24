/* Native AES version status and rotation for Polyspec\Orm\AesUtils. */
#include "dbspec.h"
#include "Zend/zend_interfaces.h"

static zend_class_entry *aes_utils_ce;
static zend_class_entry *aes_keyring_ce;
static zend_class_entry *aes_model_ce;

static zend_class_entry *aes_utils_class(const char *name)
{
    zend_string *class_name = zend_string_init(name, strlen(name), 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool aes_utils_method(zval *object, const char *method, zval *result, uint32_t argc, zval *argv)
{
    return dbs_call_method(object, method, result, argc, argv);
}

static zval *aes_utils_value(zval *array, const char *key)
{
    if (array == NULL || Z_TYPE_P(array) != IS_ARRAY) return NULL;
    zval *value = zend_hash_str_find(Z_ARRVAL_P(array), key, strlen(key));
    if (value != NULL) ZVAL_DEREF(value);
    return value;
}

static zval *aes_utils_index(zval *array, zend_ulong index)
{
    if (array == NULL || Z_TYPE_P(array) != IS_ARRAY) return NULL;
    zval *value = zend_hash_index_find(Z_ARRVAL_P(array), index);
    if (value != NULL) ZVAL_DEREF(value);
    return value;
}

static bool aes_utils_contains(zval *values, const char *name)
{
    if (values == NULL || Z_TYPE_P(values) != IS_ARRAY) return false;
    zval *value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(values), value) {
        ZVAL_DEREF(value);
        if (Z_TYPE_P(value) == IS_STRING && zend_string_equals_cstr(Z_STR_P(value), name, strlen(name))) return true;
    } ZEND_HASH_FOREACH_END();
    return false;
}

static bool aes_utils_spec(zval *db, zval *model, zval *spec)
{
    zval unsupported, operation;
    ZVAL_STRING(&operation, "aes rotation");
    bool supported = aes_utils_method(db, "unsupportedOnMarkdown", &unsupported, 1, &operation);
    zval_ptr_dtor(&operation);
    if (!supported) return false;
    zval_ptr_dtor(&unsupported);

    zval meta;
    ZVAL_UNDEF(&meta);
    if (!dbs_model_meta(model, &meta)) {
        if (EG(exception) == NULL) db_throw_orm("INTERNAL", "model meta() did not return an array");
        return false;
    }
    zval *table = aes_utils_value(&meta, "table");
    zval *keys = aes_utils_value(&meta, "pk");
    zval *version = aes_utils_value(&meta, "aes_version");
    zval *entity = aes_utils_value(&meta, "entity");
    zval *all_columns = aes_utils_value(&meta, "columns");
    if (table == NULL || Z_TYPE_P(table) != IS_STRING || keys == NULL || Z_TYPE_P(keys) != IS_ARRAY
        || version == NULL || Z_TYPE_P(version) != IS_STRING || entity == NULL || Z_TYPE_P(entity) != IS_STRING
        || all_columns == NULL || Z_TYPE_P(all_columns) != IS_ARRAY) {
        zval_ptr_dtor(&meta);
        db_throw_orm("INTERNAL", "model meta() has invalid AES rotation declarations");
        return false;
    }

    zval columns;
    array_init(&columns);
    zend_string *name;
    zend_ulong index;
    zval *column;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(all_columns), index, name, column) {
        (void)index;
        ZVAL_DEREF(column);
        zval *codec = aes_utils_value(column, "codec");
        if (!aes_utils_contains(codec, "aes")) continue;
        if (name == NULL) {
            zval_ptr_dtor(&columns);
            zval_ptr_dtor(&meta);
            db_throw_orm("INTERNAL", "AES column metadata has no name");
            return false;
        }
        zval styles;
        array_init(&styles);
        if (aes_utils_contains(codec, "aes")) add_next_index_string(&styles, "aes");
        if (aes_utils_contains(codec, "hex")) add_next_index_string(&styles, "hex");
        zval entry;
        array_init(&entry);
        add_assoc_str(&entry, "name", zend_string_copy(name));
        add_assoc_zval(&entry, "styles", &styles);
        add_next_index_zval(&columns, &entry);
    } ZEND_HASH_FOREACH_END();

    if (Z_STRLEN_P(version) == 0 || zend_hash_num_elements(Z_ARRVAL(columns)) == 0) {
        zval_ptr_dtor(&columns);
        zend_string *shown = zend_string_copy(Z_STR_P(entity));
        zval_ptr_dtor(&meta);
        db_throw_orm("CONFIG", "entity %s has no AES columns with a key version", ZSTR_VAL(shown));
        zend_string_release(shown);
        return false;
    }
    array_init(spec);
    add_assoc_str(spec, "table", zend_string_copy(Z_STR_P(table)));
    zval key_copy;
    ZVAL_COPY(&key_copy, keys);
    add_assoc_zval(spec, "keys", &key_copy);
    add_assoc_str(spec, "version", zend_string_copy(Z_STR_P(version)));
    add_assoc_zval(spec, "columns", &columns);
    zval_ptr_dtor(&meta);
    return true;
}

static zend_string *aes_utils_quote(zend_string *identifier, bool mysql)
{
    smart_str quoted = {0};
    smart_str_appendc(&quoted, mysql ? '`' : '"');
    smart_str_append(&quoted, identifier);
    smart_str_appendc(&quoted, mysql ? '`' : '"');
    smart_str_0(&quoted);
    return quoted.s;
}

static void aes_utils_quote_append(smart_str *sql, zend_string *identifier, bool mysql)
{
    zend_string *quoted = aes_utils_quote(identifier, mysql);
    smart_str_append(sql, quoted);
    zend_string_release(quoted);
}

static bool aes_utils_driver(zval *db, bool *mysql, bool *postgres)
{
    zval driver;
    if (!aes_utils_method(db, "driver", &driver, 0, NULL)) return false;
    *mysql = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR(driver), "mysql");
    *postgres = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR(driver), "postgres");
    zval_ptr_dtor(&driver);
    return true;
}

static bool aes_utils_spec_driver(zval *db, zval *model, zval *spec, bool *mysql, bool *postgres)
{
    ZVAL_UNDEF(spec);
    if (!aes_utils_spec(db, model, spec)) return false;
    if (!aes_utils_driver(db, mysql, postgres)) {
        zval_ptr_dtor(spec);
        return false;
    }
    return true;
}

static bool aes_utils_require_model_keyring(zval *model, zval *keyring, const char *method)
{
    if (aes_model_ce == NULL) aes_model_ce = aes_utils_class("Polyspec\\Orm\\Model");
    if (aes_model_ce == NULL || !instanceof_function(Z_OBJCE_P(model), aes_model_ce)) {
        zend_type_error("AesUtils::%s expects a Model", method);
        return false;
    }
    if (aes_keyring_ce == NULL) aes_keyring_ce = aes_utils_class("Polyspec\\Orm\\AesKeyring");
    if (aes_keyring_ce == NULL || !instanceof_function(Z_OBJCE_P(keyring), aes_keyring_ce)) {
        zend_type_error("AesUtils::%s expects an AesKeyring", method);
        return false;
    }
    return true;
}

static bool aes_utils_fetch(zval *db, zval *tables, zend_string *sql, zval *args, zval *rows)
{
    zval tx, argv[5];
    ZVAL_UNDEF(&tx);
    if (!aes_utils_method(db, "transactionNumber", &tx, 0, NULL)) return false;
    ZVAL_STRING(&argv[0], "utility");
    ZVAL_COPY(&argv[1], tables);
    ZVAL_COPY_VALUE(&argv[2], &tx);
    ZVAL_STR_COPY(&argv[3], sql);
    uint32_t argc = 4;
    if (args != NULL) {
        ZVAL_COPY(&argv[4], args);
        argc = 5;
    }
    bool ok = aes_utils_method(db, "fetch", rows, argc, argv);
    for (uint32_t i = 0; i < argc; i++) zval_ptr_dtor(&argv[i]);
    return ok;
}

ZEND_METHOD(Polyspec_Orm_AesUtils, __construct)
{
    zval *db, *utils;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(db)
        Z_PARAM_OBJECT(utils)
    ZEND_PARSE_PARAMETERS_END();
    if (!dbs_bind_db_utils(ZEND_THIS, aes_utils_ce, db, utils, "AesUtils")) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_AesUtils, status)
{
    zval *model, *keyring;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(model)
        Z_PARAM_OBJECT(keyring)
    ZEND_PARSE_PARAMETERS_END();
    if (!aes_utils_require_model_keyring(model, keyring, "status")) RETURN_THROWS();
    zval rv_db, rv_version;
    zval *db = zend_read_property(aes_utils_ce, Z_OBJ_P(ZEND_THIS), "db", sizeof("db") - 1, true, &rv_db);
    zval *version_value = zend_read_property(aes_keyring_ce, Z_OBJ_P(keyring), "currentVersion", sizeof("currentVersion") - 1, true, &rv_version);
    zend_long current = zval_get_long(version_value);
    zval spec;
    bool mysql, postgres;
    if (!aes_utils_spec_driver(db, model, &spec, &mysql, &postgres)) RETURN_THROWS();
    zval *table = aes_utils_value(&spec, "table"), *version = aes_utils_value(&spec, "version");
    smart_str sql = {0};
    smart_str_appends(&sql, "SELECT ");
    aes_utils_quote_append(&sql, Z_STR_P(version), mysql);
    smart_str_appends(&sql, ", COUNT(*) FROM ");
    aes_utils_quote_append(&sql, Z_STR_P(table), mysql);
    smart_str_appends(&sql, " GROUP BY ");
    aes_utils_quote_append(&sql, Z_STR_P(version), mysql);
    smart_str_appends(&sql, " ORDER BY ");
    aes_utils_quote_append(&sql, Z_STR_P(version), mysql);
    smart_str_0(&sql);
    zval tables, rows;
    array_init(&tables);
    add_next_index_str(&tables, zend_string_copy(Z_STR_P(table)));
    zval args;
    array_init(&args);
    ZVAL_UNDEF(&rows);
    bool fetched = aes_utils_fetch(db, &tables, sql.s, &args, &rows);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&tables);
    smart_str_free(&sql);
    if (!fetched) { zval_ptr_dtor(&spec); RETURN_THROWS(); }

    zval versions;
    array_init(&versions);
    zend_long total = 0, pending = 0;
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row) {
        ZVAL_DEREF(row);
        zend_long stored = zval_get_long(aes_utils_index(row, 0));
        zend_long count = zval_get_long(aes_utils_index(row, 1));
        zval amount;
        ZVAL_LONG(&amount, count);
        zend_hash_index_update(Z_ARRVAL(versions), (zend_ulong)stored, &amount);
        total += count;
        if (stored != current) pending += count;
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&rows);
    zval ctor[4];
    ZVAL_LONG(&ctor[0], current);
    ZVAL_LONG(&ctor[1], total);
    ZVAL_LONG(&ctor[2], pending);
    ZVAL_COPY_VALUE(&ctor[3], &versions);
    bool made = newobj("Polyspec\\Orm\\AesRotationStatus", return_value, 4, ctor);
    zval_ptr_dtor(&ctor[3]);
    zval_ptr_dtor(&spec);
    if (!made) ZVAL_UNDEF(return_value);
    (void)postgres;
}

typedef struct {
    zval *statement;
    zval *args;
} aes_update_context;

static bool aes_utils_execute_update(zval *db, void *context, zval *result)
{
    (void)db;
    aes_update_context *update = context;
    zend_ulong index;
    zval *value;
    ZEND_HASH_FOREACH_NUM_KEY_VAL(Z_ARRVAL_P(update->args), index, value) {
        zval bind_args[3], bound;
        ZVAL_UNDEF(&bound);
        ZVAL_LONG(&bind_args[0], (zend_long)index + 1);
        ZVAL_COPY(&bind_args[1], value);
        zend_long type = 2;
        if (Z_TYPE_P(value) == IS_NULL) {
            type = 0;
        } else if (Z_TYPE_P(value) == IS_LONG) {
            type = 1;
        } else {
            zend_class_entry *bytes_ce = aes_utils_class("Polyspec\\Orm\\Bytes");
            if (bytes_ce != NULL && Z_TYPE_P(value) == IS_OBJECT && instanceof_function(Z_OBJCE_P(value), bytes_ce)) {
                zval rv;
                zval *bytes = zend_read_property(bytes_ce, Z_OBJ_P(value), "bytes", sizeof("bytes") - 1, true, &rv);
                if (bytes != NULL && Z_TYPE_P(bytes) == IS_STRING) {
                    zval_ptr_dtor(&bind_args[1]);
                    ZVAL_COPY(&bind_args[1], bytes);
                    type = 3;
                }
            }
        }
        ZVAL_LONG(&bind_args[2], type);
        bool bound_ok = aes_utils_method(update->statement, "bindValue", &bound, 3, bind_args);
        zval_ptr_dtor(&bind_args[1]);
        zval_ptr_dtor(&bound);
        if (!bound_ok) return false;
    } ZEND_HASH_FOREACH_END();
    zval executed;
    ZVAL_UNDEF(&executed);
    if (!aes_utils_method(update->statement, "execute", &executed, 0, NULL)) return false;
    zval_ptr_dtor(&executed);
    zval affected;
    ZVAL_UNDEF(&affected);
    if (!aes_utils_method(update->statement, "rowCount", &affected, 0, NULL)) return false;
    ZVAL_COPY_VALUE(result, &affected);
    return true;
}

typedef struct {
    zval *spec;
    zval *keyring;
    zval *db;
    zend_long current;
    zend_long rotated;
    zend_long key_count;
    bool mysql;
    bool postgres;
    zend_string *select_sql;
    zend_string *update_sql;
    zend_string *prepare_sql;
} aes_rotation_context;

static void aes_append_placeholder(smart_str *sql, bool postgres, zend_long index)
{
    if (postgres) {
        smart_str_appendc(sql, '$');
        smart_str_append_long(sql, index);
    } else {
        smart_str_appendc(sql, '?');
    }
}

static bool aes_utils_rotate_batch(zval *db, void *context, zval *result)
{
    aes_rotation_context *rotation = context;
next_batch:
    ;
    zval *spec = rotation->spec;
    zval *table = aes_utils_value(spec, "table");
    zval *version = aes_utils_value(spec, "version");
    zval *keys = aes_utils_value(spec, "keys");
    zval *columns = aes_utils_value(spec, "columns");
    zval tables, args, rows;
    array_init(&tables);
    add_next_index_str(&tables, zend_string_copy(Z_STR_P(table)));
    array_init(&args);
    add_next_index_long(&args, rotation->current);
    ZVAL_UNDEF(&rows);
    bool fetched = aes_utils_fetch(db, &tables, rotation->select_sql, &args, &rows);
    zval_ptr_dtor(&args);
    if (!fetched) {
        zval_ptr_dtor(&tables);
        return false;
    }
    if (zend_hash_num_elements(Z_ARRVAL(rows)) == 0) {
        zval_ptr_dtor(&rows);
        zval_ptr_dtor(&tables);
        ZVAL_LONG(result, rotation->rotated);
        return true;
    }
    bool full_batch = zend_hash_num_elements(Z_ARRVAL(rows)) == 1000;

    zval pdo, statement;
    if (!aes_utils_method(db, "pdo", &pdo, 0, NULL)) {
        zval_ptr_dtor(&rows);
        zval_ptr_dtor(&tables);
        return false;
    }
    zval prepare_arg;
    ZVAL_STR_COPY(&prepare_arg, rotation->prepare_sql);
    bool prepared = aes_utils_method(&pdo, "prepare", &statement, 1, &prepare_arg);
    zval_ptr_dtor(&prepare_arg);
    zval_ptr_dtor(&pdo);
    if (!prepared) {
        zval_ptr_dtor(&rows);
        zval_ptr_dtor(&tables);
        return false;
    }

    bool ok = true;
    zval *values;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), values) {
        zval row;
        array_init(&row);
        zval *value;
        zend_long position = 0;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), value) {
            zend_string *name = Z_STR_P(value);
            zval *cell = aes_utils_index(values, (zend_ulong)position++);
            if (cell != NULL) {
                zval copy;
                ZVAL_COPY(&copy, cell);
                zend_hash_update(Z_ARRVAL(row), name, &copy);
            }
        } ZEND_HASH_FOREACH_END();
        zval *stored = aes_utils_index(values, (zend_ulong)rotation->key_count);
        if (stored != NULL) {
            zval copy;
            ZVAL_COPY(&copy, stored);
            zend_hash_update(Z_ARRVAL(row), Z_STR_P(version), &copy);
        }
        zend_ulong column_index = 0;
        zval *column;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval *name = aes_utils_value(column, "name");
            zval *cell = aes_utils_index(values, (zend_ulong)(rotation->key_count + 1 + column_index));
            if (name != NULL && cell != NULL) {
                zval copy;
                ZVAL_COPY(&copy, cell);
                zend_hash_update(Z_ARRVAL(row), Z_STR_P(name), &copy);
            }
            column_index++;
        } ZEND_HASH_FOREACH_END();

        zval rotate_args[4], after;
        ZVAL_COPY(&rotate_args[0], &row);
        ZVAL_COPY(&rotate_args[1], version);
        ZVAL_COPY(&rotate_args[2], columns);
        ZVAL_LONG(&rotate_args[3], rotation->current);
        ok = aes_utils_method(rotation->keyring, "rotateRow", &after, 4, rotate_args);
        for (size_t i = 0; i < 3; i++) zval_ptr_dtor(&rotate_args[i]);
        if (!ok) {
            zval_ptr_dtor(&row);
            break;
        }

        zval update_args;
        array_init(&update_args);
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval *name = aes_utils_value(column, "name");
            zval *cell = name == NULL ? NULL : aes_utils_value(&after, Z_STRVAL_P(name));
            if (cell == NULL) {
                db_throw_orm("INTERNAL", "AES rotation omitted an encrypted column");
                ok = false;
                break;
            }
            zval copy;
            ZVAL_COPY(&copy, cell);
            add_next_index_zval(&update_args, &copy);
        } ZEND_HASH_FOREACH_END();
        if (ok) add_next_index_long(&update_args, rotation->current);
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), value) {
            zend_string *name = Z_STR_P(value);
            zval *cell = aes_utils_value(&row, ZSTR_VAL(name));
            if (cell == NULL) {
                db_throw_orm("INTERNAL", "AES rotation row omitted a primary key");
                ok = false;
                break;
            }
            zval copy;
            ZVAL_COPY(&copy, cell);
            add_next_index_zval(&update_args, &copy);
        } ZEND_HASH_FOREACH_END();
        if (ok && stored != NULL) {
            zval copy;
            ZVAL_COPY(&copy, stored);
            add_next_index_zval(&update_args, &copy);
        }
        zval_ptr_dtor(&after);
        if (!ok) {
            zval_ptr_dtor(&update_args);
            zval_ptr_dtor(&row);
            break;
        }
        aes_update_context update = {&statement, &update_args};
        zval kind, transaction, sql, changed;
        ZVAL_STRING(&kind, "utility");
        ZVAL_STR_COPY(&sql, rotation->update_sql);
        ZVAL_UNDEF(&transaction);
        ZVAL_UNDEF(&changed);
        ok = aes_utils_method(db, "transactionNumber", &transaction, 0, NULL)
            && db_observed_native(db, &kind, &tables, &transaction, &sql, &update_args,
                aes_utils_execute_update, &update, &changed);
        zval_ptr_dtor(&kind);
        zval_ptr_dtor(&transaction);
        zval_ptr_dtor(&sql);
        zval_ptr_dtor(&update_args);
        if (!ok) {
            zval_ptr_dtor(&row);
            break;
        }
        if (zval_get_long(&changed) != 1) {
            zval message;
            ZVAL_STR(&message, strpprintf(0, "aes rotation of %s changed %lld rows", Z_STRVAL_P(table), (long long)zval_get_long(&changed)));
            zval conflict_args[1], conflict;
            ZVAL_COPY_VALUE(&conflict_args[0], &message);
            bool made = scall("Polyspec\\Orm\\Orm::transactionConflict", &conflict, 1, conflict_args);
            zval_ptr_dtor(&message);
            if (made && Z_TYPE(conflict) == IS_OBJECT) {
                zend_throw_exception_object(&conflict);
            } else if (EG(exception) == NULL) {
                db_throw_orm("INTERNAL", "transaction conflict error could not be created");
            }
            ok = false;
            zval_ptr_dtor(&changed);
            zval_ptr_dtor(&row);
            break;
        }
        zval_ptr_dtor(&changed);
        zval_ptr_dtor(&row);
        rotation->rotated++;
    } ZEND_HASH_FOREACH_END();

    zval close_result;
    if (!aes_utils_method(&statement, "closeCursor", &close_result, 0, NULL)) ok = false;
    zval_ptr_dtor(&close_result);
    zval_ptr_dtor(&statement);
    zval_ptr_dtor(&rows);
    zval_ptr_dtor(&tables);
    if (ok && full_batch) goto next_batch;
    if (ok) {
        ZVAL_LONG(result, rotation->rotated);
    }
    return ok;
}

ZEND_METHOD(Polyspec_Orm_AesUtils, rotate)
{
    zval *model, *keyring;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(model)
        Z_PARAM_OBJECT(keyring)
    ZEND_PARSE_PARAMETERS_END();
    if (!aes_utils_require_model_keyring(model, keyring, "rotate")) RETURN_THROWS();
    zval rv_db, spec;
    zval *db = zend_read_property(aes_utils_ce, Z_OBJ_P(ZEND_THIS), "db", sizeof("db") - 1, true, &rv_db);
    bool mysql, postgres;
    if (!aes_utils_spec_driver(db, model, &spec, &mysql, &postgres)) RETURN_THROWS();
    zval rv_current;
    zval *current_value = zend_read_property(aes_keyring_ce, Z_OBJ_P(keyring), "currentVersion", sizeof("currentVersion") - 1, true, &rv_current);
    zend_long current = zval_get_long(current_value);
    zval *table = aes_utils_value(&spec, "table");
    zval *version = aes_utils_value(&spec, "version");
    zval *keys = aes_utils_value(&spec, "keys");
    zval *columns = aes_utils_value(&spec, "columns");
    smart_str selected = {0}, updated = {0};
    smart_str_appends(&selected, "SELECT ");
    zend_long key_count = 0, position = 0;
    zval *key_value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), key_value) {
        zend_string *name = Z_STR_P(key_value);
        if (position++) smart_str_appends(&selected, ", ");
        aes_utils_quote_append(&selected, name, mysql);
        key_count++;
    } ZEND_HASH_FOREACH_END();
    if (position++) smart_str_appends(&selected, ", ");
    aes_utils_quote_append(&selected, Z_STR_P(version), mysql);
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval *name = aes_utils_value(column, "name");
        if (position++) smart_str_appends(&selected, ", ");
        aes_utils_quote_append(&selected, Z_STR_P(name), mysql);
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&selected, " FROM ");
    aes_utils_quote_append(&selected, Z_STR_P(table), mysql);
    smart_str_appends(&selected, " WHERE ");
    aes_utils_quote_append(&selected, Z_STR_P(version), mysql);
    smart_str_appends(&selected, " <> ");
    aes_append_placeholder(&selected, postgres, 1);
    smart_str_appends(&selected, " ORDER BY ");
    position = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), key_value) {
        zend_string *name = Z_STR_P(key_value);
        if (position++) smart_str_appends(&selected, ", ");
        aes_utils_quote_append(&selected, name, mysql);
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&selected, " LIMIT 1000");
    smart_str_0(&selected);

    smart_str_appends(&updated, "UPDATE ");
    aes_utils_quote_append(&updated, Z_STR_P(table), mysql);
    smart_str_appends(&updated, " SET ");
    position = 1;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval *name = aes_utils_value(column, "name");
        if (position > 1) smart_str_appends(&updated, ", ");
        aes_utils_quote_append(&updated, Z_STR_P(name), mysql);
        smart_str_appends(&updated, " = ");
        aes_append_placeholder(&updated, postgres, position++);
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&updated, ", ");
    aes_utils_quote_append(&updated, Z_STR_P(version), mysql);
    smart_str_appends(&updated, " = ");
    aes_append_placeholder(&updated, postgres, position++);
    smart_str_appends(&updated, " WHERE ");
    bool first_key = true;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), key_value) {
        zend_string *name = Z_STR_P(key_value);
        if (!first_key) smart_str_appends(&updated, " AND ");
        first_key = false;
        aes_utils_quote_append(&updated, name, mysql);
        smart_str_appends(&updated, " = ");
        aes_append_placeholder(&updated, postgres, position++);
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&updated, " AND ");
    aes_utils_quote_append(&updated, Z_STR_P(version), mysql);
    smart_str_appends(&updated, " = ");
    aes_append_placeholder(&updated, postgres, position);
    smart_str_0(&updated);

    smart_str prepare_sql = {0};
    if (postgres) {
        for (size_t i = 0; i < ZSTR_LEN(updated.s); i++) {
            if (ZSTR_VAL(updated.s)[i] == '$') {
                smart_str_appendc(&prepare_sql, '?');
                while (i + 1 < ZSTR_LEN(updated.s) && ZSTR_VAL(updated.s)[i + 1] >= '0' && ZSTR_VAL(updated.s)[i + 1] <= '9') i++;
            } else {
                smart_str_appendc(&prepare_sql, ZSTR_VAL(updated.s)[i]);
            }
        }
    } else {
        smart_str_append(&prepare_sql, updated.s);
    }
    smart_str_0(&prepare_sql);

    aes_rotation_context rotation = {
        .spec = &spec, .keyring = keyring, .db = db, .current = current, .rotated = 0,
        .key_count = key_count, .mysql = mysql, .postgres = postgres,
        .select_sql = selected.s, .update_sql = updated.s, .prepare_sql = prepare_sql.s
    };
    zval tx_result;
    ZVAL_UNDEF(&tx_result);
    bool ok = db_transaction_native(db, aes_utils_rotate_batch, &rotation, &tx_result);
    smart_str_free(&selected);
    smart_str_free(&updated);
    smart_str_free(&prepare_sql);
    zval_ptr_dtor(&spec);
    if (!ok) RETURN_THROWS();
    ZVAL_COPY_VALUE(return_value, &tx_result);
}

void aes_utils_set_class(zend_class_entry *ce)
{
    aes_utils_ce = ce;
}
