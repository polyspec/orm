/* Native non-query operations for Polyspec\\Orm\\Utils. */
#include "dbspec.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_interfaces.h"

int dbs_cmp_table_name(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp((*(table *const *)a)->name, (*(table *const *)b)->name);
}

bool dbs_call_method(zval *object, const char *method, zval *result, uint32_t argc, zval *argv)
{
    zval function;
    ZVAL_STRING(&function, method);
    zend_result status = call_user_function(NULL, object, &function, result, argc, argv);
    zval_ptr_dtor(&function);
    return status == SUCCESS && EG(exception) == NULL;
}

bool dbs_model_meta(zval *model, zval *meta)
{
    zend_call_method(NULL, Z_OBJCE_P(model), NULL, "meta", sizeof("meta") - 1, meta, 0, NULL, NULL);
    return EG(exception) == NULL && Z_TYPE_P(meta) == IS_ARRAY;
}

bool dbs_bind_db_utils(zval *instance, zend_class_entry *ce, zval *db, zval *utils, const char *name)
{
    zend_string *db_name = zend_string_init("Polyspec\\Orm\\Db", sizeof("Polyspec\\Orm\\Db") - 1, 0);
    zend_class_entry *db_ce = zend_lookup_class(db_name);
    zend_string_release(db_name);
    zend_string *utils_name = zend_string_init("Polyspec\\Orm\\Utils", sizeof("Polyspec\\Orm\\Utils") - 1, 0);
    zend_class_entry *utils_ce = zend_lookup_class(utils_name);
    zend_string_release(utils_name);
    if (db_ce == NULL || utils_ce == NULL || !instanceof_function(Z_OBJCE_P(db), db_ce)
        || !instanceof_function(Z_OBJCE_P(utils), utils_ce)) {
        zend_type_error("%s expects a Db and Utils", name);
        return false;
    }
    zend_update_property(ce, Z_OBJ_P(instance), "db", sizeof("db") - 1, db);
    zend_update_property(ce, Z_OBJ_P(instance), "u", sizeof("u") - 1, utils);
    return true;
}

bool dbs_identifier(zend_string *value, bool allow_dots)
{
    if (ZSTR_LEN(value) == 0) return false;
    const unsigned char *text = (const unsigned char *)ZSTR_VAL(value);
    if (!((text[0] >= 'A' && text[0] <= 'Z') || (text[0] >= 'a' && text[0] <= 'z') || text[0] == '_')) return false;
    for (size_t i = 1; i < ZSTR_LEN(value); i++) {
        unsigned char ch = text[i];
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_') continue;
        if (allow_dots && ch == '.') continue;
        return false;
    }
    return true;
}

static zend_class_entry *utils_ce;

static bool utils_call(zval *object, const char *method, zval *result, uint32_t argc, zval *argv)
{
    ZVAL_UNDEF(result);
    return dbs_call_method(object, method, result, argc, argv);
}

static zval *utils_db(zval *object)
{
    zval rv;
    return zend_read_property(utils_ce, Z_OBJ_P(object), "db", sizeof("db") - 1, true, &rv);
}

static bool utils_new_subutility(zval *instance, const char *class_name, zval *result)
{
    zval args[2];
    ZVAL_COPY(&args[0], utils_db(instance));
    ZVAL_COPY(&args[1], instance);
    bool ok = newobj(class_name, result, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    return ok;
}

static bool utils_active_frame(zval *db, zval *frame)
{
    zval argument;
    ZVAL_COPY(&argument, db);
    bool ok = scall("Polyspec\\Orm\\Db::activeFor", frame, 1, &argument);
    zval_ptr_dtor(&argument);
    return ok;
}

static bool utils_active_transaction(zval *db, zval *transaction)
{
    return utils_call(db, "transactionNumber", transaction, 0, NULL);
}

static bool utils_fetch_call(zval *db, const char *kind, size_t kind_len, zval *tables, zval *transaction,
                             zend_string *sql, zval *args, zval *rows)
{
    zval call_args[5];
    ZVAL_STRINGL(&call_args[0], kind, kind_len);
    ZVAL_COPY(&call_args[1], tables);
    ZVAL_COPY(&call_args[2], transaction);
    ZVAL_STR_COPY(&call_args[3], sql);
    ZVAL_COPY(&call_args[4], args);
    bool ok = utils_call(db, "fetch", rows, 5, call_args);
    for (size_t i = 0; i < 5; i++) zval_ptr_dtor(&call_args[i]);
    return ok;
}

static bool utils_fetch(zval *db, zval *tables, zval *transaction, zend_string *sql, zval *args, zval *rows)
{
    return utils_fetch_call(db, "utility", sizeof("utility") - 1, tables, transaction, sql, args, rows);
}

static bool utils_valid_key(zend_string *key)
{
    if (ZSTR_LEN(key) == 0 || ZSTR_LEN(key) > 64) return false;
    const unsigned char *text = (const unsigned char *)ZSTR_VAL(key);
    for (size_t i = 0; i < ZSTR_LEN(key); i++) {
        unsigned char ch = text[i];
        bool valid = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
            || (ch >= '0' && ch <= '9') || ch == '_' || (i > 0 && ch == '.');
        if (!valid) return false;
    }
    return true;
}

static bool utils_driver(zval *db, zval *driver)
{
    return utils_call(db, "driver", driver, 0, NULL) && Z_TYPE_P(driver) == IS_STRING;
}

static bool utils_unsupported(zval *db, const char *surface)
{
    zval argument, ignored;
    ZVAL_STRING(&argument, surface);
    bool ok = utils_call(db, "unsupportedOnMarkdown", &ignored, 1, &argument);
    zval_ptr_dtor(&argument);
    if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    return ok;
}

static bool utils_key_or_throw(zend_string *key, const char *kind)
{
    if (utils_valid_key(key)) return true;
    db_throw_orm("CONFIG", "%s key %s is invalid", kind, ZSTR_VAL(key));
    return false;
}

static bool utils_get_frame(zval *db, const char *name, zval *frame)
{
    if (!utils_active_frame(db, frame)) return false;
    if (Z_TYPE_P(frame) != IS_OBJECT) {
        db_throw_orm("CONFIG", "%s requires an active transaction of the connection", name);
        return false;
    }
    return true;
}

static bool utils_call_closure(zval *closure, zval *result)
{
    zend_fcall_info fci;
    zend_fcall_info_cache fcc;
    if (zend_fcall_info_init(closure, 0, &fci, &fcc, NULL, NULL) != SUCCESS) return false;
    fci.retval = result;
    fci.params = NULL;
    fci.param_count = 0;
    return zend_call_function(&fci, &fcc) == SUCCESS && EG(exception) == NULL;
}

ZEND_METHOD(Polyspec_Orm_Utils, __construct)
{
    zval *db;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(db)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *name = zend_string_init("Polyspec\\Orm\\Db", sizeof("Polyspec\\Orm\\Db") - 1, 0);
    zend_class_entry *db_ce = zend_lookup_class(name);
    zend_string_release(name);
    if (db_ce == NULL || !instanceof_function(Z_OBJCE_P(db), db_ce)) {
        zend_type_error("Utils expects a Db");
        RETURN_THROWS();
    }
    zend_update_property(utils_ce, Z_OBJ_P(ZEND_THIS), "db", sizeof("db") - 1, db);
}

ZEND_METHOD(Polyspec_Orm_Utils, active)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!utils_active_frame(db, &frame)) RETURN_THROWS();
    if (Z_TYPE(frame) == IS_NULL) {
        db_throw_orm("CONFIG", "%s requires an active transaction of the connection", ZSTR_VAL(name));
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    ZVAL_COPY_VALUE(return_value, &frame);
}

ZEND_METHOD(Polyspec_Orm_Utils, run)
{
    zval *closure;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(closure, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!utils_active_frame(db, &frame)) RETURN_THROWS();
    bool active = Z_TYPE(frame) != IS_NULL;
    zval_ptr_dtor(&frame);
    if (active) {
        if (!utils_call_closure(closure, return_value)) RETURN_THROWS();
        return;
    }
    zval args[6];
    ZVAL_COPY(&args[0], closure);
    ZVAL_EMPTY_STRING(&args[1]);
    ZVAL_FALSE(&args[2]);
    ZVAL_LONG(&args[3], 0);
    ZVAL_LONG(&args[4], 0);
    ZVAL_NULL(&args[5]);
    bool ok = utils_call(db, "transaction", return_value, 6, args);
    for (size_t i = 0; i < 6; i++) zval_ptr_dtor(&args[i]);
    if (!ok) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Utils, read)
{
    zend_string *kind, *sql;
    zval *tables, *args;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_STR(sql)
        Z_PARAM_ARRAY(args)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    zval transaction, rows;
    ZVAL_UNDEF(&transaction);
    ZVAL_UNDEF(&rows);
    if (!utils_active_transaction(db, &transaction)) RETURN_THROWS();
    bool ok = utils_fetch_call(db, ZSTR_VAL(kind), ZSTR_LEN(kind), tables, &transaction, sql, args, &rows);
    zval_ptr_dtor(&transaction);
    if (!ok) RETURN_THROWS();
    zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
    zval *value = row == NULL || Z_TYPE_P(row) != IS_ARRAY ? NULL : zend_hash_index_find(Z_ARRVAL_P(row), 0);
    if (value == NULL) ZVAL_FALSE(return_value);
    else ZVAL_COPY(return_value, value);
    zval_ptr_dtor(&rows);
}

ZEND_METHOD(Polyspec_Orm_Utils, exec)
{
    zend_string *kind, *sql;
    zval *tables, *args = NULL;
    ZEND_PARSE_PARAMETERS_START(3, 4)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_STR(sql)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(args)
    ZEND_PARSE_PARAMETERS_END();
    zval empty;
    if (args == NULL) {
        array_init(&empty);
        args = &empty;
    }
    zval *db = utils_db(ZEND_THIS);
    zval transaction, rows;
    ZVAL_UNDEF(&transaction);
    ZVAL_UNDEF(&rows);
    if (!utils_active_transaction(db, &transaction)) {
        if (args == &empty) zval_ptr_dtor(&empty);
        RETURN_THROWS();
    }
    bool ok = utils_fetch_call(db, ZSTR_VAL(kind), ZSTR_LEN(kind), tables, &transaction, sql, args, &rows);
    zval_ptr_dtor(&transaction);
    if (args == &empty) zval_ptr_dtor(&empty);
    if (!ok) RETURN_THROWS();
    zval_ptr_dtor(&rows);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Utils, lock)
{
    zend_string *key;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(key)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    if (!utils_unsupported(db, "lock")) RETURN_THROWS();
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!utils_get_frame(db, "lock", &frame)) {
        if (!Z_ISUNDEF(frame)) zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    if (!utils_key_or_throw(key, "lock")) {
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    zval driver;
    ZVAL_UNDEF(&driver);
    if (!utils_driver(db, &driver)) {
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    zval transaction;
    zval rv;
    zval *number = zend_read_property(Z_OBJCE(frame), Z_OBJ(frame), "number", sizeof("number") - 1, true, &rv);
    ZVAL_COPY(&transaction, number);
    zval tables, args, rows;
    array_init(&tables);
    array_init(&args);
    ZVAL_UNDEF(&rows);
    bool ok = true;
    if (zend_string_equals_literal(Z_STR(driver), "mysql")) {
        add_next_index_str(&args, zend_string_copy(key));
        zend_string *sql = zend_string_init("SELECT GET_LOCK(?, 50)", sizeof("SELECT GET_LOCK(?, 50)") - 1, 0);
        ok = utils_fetch(db, &tables, &transaction, sql, &args, &rows);
        zend_string_release(sql);
        if (ok) {
            zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
            zval *value = row == NULL || Z_TYPE_P(row) != IS_ARRAY ? NULL : zend_hash_index_find(Z_ARRVAL_P(row), 0);
            if (value == NULL || zval_get_long(value) != 1) {
                db_throw_orm("DEADLOCK", "lock %s was not acquired", ZSTR_VAL(key));
                ok = false;
            } else {
                zval rv_locks;
                zval *locks = zend_read_property(Z_OBJCE(frame), Z_OBJ(frame), "locks", sizeof("locks") - 1, true, &rv_locks);
                if (Z_TYPE_P(locks) != IS_ARRAY) {
                    db_throw_orm("INTERNAL", "transaction lock collection is not an array");
                    ok = false;
                } else {
                    SEPARATE_ARRAY(locks);
                    add_next_index_str(locks, zend_string_copy(key));
                }
            }
        }
        if (!Z_ISUNDEF(rows)) zval_ptr_dtor(&rows);
    } else if (zend_string_equals_literal(Z_STR(driver), "postgres")) {
        add_next_index_str(&args, zend_string_copy(key));
        zend_string *sql = zend_string_init("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", sizeof("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") - 1, 0);
        ok = utils_fetch(db, &tables, &transaction, sql, &args, &rows);
        zend_string_release(sql);
        if (!Z_ISUNDEF(rows)) zval_ptr_dtor(&rows);
    } else {
        zval argument, ignored;
        ZVAL_STRING(&argument, "update");
        ok = utils_call(db, "acquireSQLiteRowLock", &ignored, 1, &argument);
        zval_ptr_dtor(&argument);
        if (!Z_ISUNDEF(ignored)) zval_ptr_dtor(&ignored);
    }
    zval_ptr_dtor(&driver);
    zval_ptr_dtor(&tables);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&transaction);
    zval_ptr_dtor(&frame);
    if (!ok) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Utils, setLocal)
{
    zend_string *key, *value;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(key)
        Z_PARAM_STR(value)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    if (!utils_unsupported(db, "setLocal")) RETURN_THROWS();
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!utils_get_frame(db, "setLocal", &frame)) {
        if (!Z_ISUNDEF(frame)) zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    if (!utils_key_or_throw(key, "local")) {
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    zval driver;
    ZVAL_UNDEF(&driver);
    if (!utils_driver(db, &driver)) {
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    zval rv_number;
    zval *number = zend_read_property(Z_OBJCE(frame), Z_OBJ(frame), "number", sizeof("number") - 1, true, &rv_number);
    zval transaction;
    ZVAL_COPY(&transaction, number);
    zval tables, args, rows;
    array_init(&tables);
    array_init(&args);
    ZVAL_UNDEF(&rows);
    bool ok = true;
    zend_string *sql = NULL;
    if (zend_string_equals_literal(Z_STR(driver), "postgres")) {
        sql = zend_string_init("SELECT set_config($1, $2, true)", sizeof("SELECT set_config($1, $2, true)") - 1, 0);
        add_next_index_str(&args, zend_string_copy(key));
        add_next_index_str(&args, zend_string_copy(value));
    } else if (zend_string_equals_literal(Z_STR(driver), "mysql")) {
        sql = strpprintf(0, "SET @`orm.%s` = ?", ZSTR_VAL(key));
        add_next_index_str(&args, zend_string_copy(value));
    }
    if (sql != NULL) {
        ok = utils_fetch(db, &tables, &transaction, sql, &args, &rows);
        zend_string_release(sql);
        if (!Z_ISUNDEF(rows)) zval_ptr_dtor(&rows);
    }
    if (ok) {
        zval rv_locals;
        zval *locals = zend_read_property(Z_OBJCE(frame), Z_OBJ(frame), "locals", sizeof("locals") - 1, true, &rv_locals);
        if (Z_TYPE_P(locals) != IS_ARRAY) {
            db_throw_orm("INTERNAL", "transaction local collection is not an array");
            ok = false;
        } else {
            SEPARATE_ARRAY(locals);
            zval copy;
            ZVAL_STR_COPY(&copy, value);
            zend_hash_update(Z_ARRVAL_P(locals), key, &copy);
        }
    }
    zval_ptr_dtor(&driver);
    zval_ptr_dtor(&tables);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&transaction);
    zval_ptr_dtor(&frame);
    if (!ok) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Utils, local)
{
    zend_string *key;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(key)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    if (!utils_unsupported(db, "local")) RETURN_THROWS();
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!utils_get_frame(db, "local", &frame)) {
        if (!Z_ISUNDEF(frame)) zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    if (!utils_key_or_throw(key, "local")) {
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    zval rv_locals;
    zval *locals = zend_read_property(Z_OBJCE(frame), Z_OBJ(frame), "locals", sizeof("locals") - 1, true, &rv_locals);
    zval *local = Z_TYPE_P(locals) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(locals), key) : NULL;
    if (local == NULL) {
        db_throw_orm("NO_ROWS", "local value %s is not set", ZSTR_VAL(key));
        zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    ZVAL_COPY(return_value, local);
    zval_ptr_dtor(&frame);
}

ZEND_METHOD(Polyspec_Orm_Utils, wasInserted)
{
    zend_string *entity;
    zend_long sequence;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(entity)
        Z_PARAM_LONG(sequence)
    ZEND_PARSE_PARAMETERS_END();
    zval *db = utils_db(ZEND_THIS);
    zval frame;
    ZVAL_UNDEF(&frame);
    if (!utils_get_frame(db, "wasInserted", &frame)) {
        if (!Z_ISUNDEF(frame)) zval_ptr_dtor(&frame);
        RETURN_THROWS();
    }
    if (ZSTR_LEN(entity) == 0 || sequence <= 0) {
        zval_ptr_dtor(&frame);
        db_throw_orm("CONFIG", "inserted entity and positive key are required");
        RETURN_THROWS();
    }
    zval rv_inserted;
    zval *inserted = zend_read_property(Z_OBJCE(frame), Z_OBJ(frame), "inserted", sizeof("inserted") - 1, true, &rv_inserted);
    zval *keys = Z_TYPE_P(inserted) == IS_ARRAY ? zend_hash_find(Z_ARRVAL_P(inserted), entity) : NULL;
    bool inserted_key = keys != NULL && Z_TYPE_P(keys) == IS_ARRAY
        && zend_hash_index_exists(Z_ARRVAL_P(keys), (zend_ulong)sequence);
    zval_ptr_dtor(&frame);
    RETURN_BOOL(inserted_key);
}

ZEND_METHOD(Polyspec_Orm_Utils, backendWaitingForLock)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *db = utils_db(ZEND_THIS);
    if (!utils_unsupported(db, "backendWaitingForLock")) RETURN_THROWS();
    zval driver;
    ZVAL_UNDEF(&driver);
    if (!utils_driver(db, &driver)) RETURN_THROWS();
    if (!zend_string_equals_literal(Z_STR(driver), "postgres")) {
        zval_ptr_dtor(&driver);
        RETURN_FALSE;
    }
    zval transaction, tables, args, rows;
    ZVAL_UNDEF(&transaction);
    ZVAL_UNDEF(&rows);
    if (!utils_active_transaction(db, &transaction)) {
        zval_ptr_dtor(&driver);
        RETURN_THROWS();
    }
    array_init(&tables);
    array_init(&args);
    zend_string *clear_sql = zend_string_init("SELECT pg_stat_clear_snapshot()", sizeof("SELECT pg_stat_clear_snapshot()") - 1, 0);
    bool ok = utils_fetch(db, &tables, &transaction, clear_sql, &args, &rows);
    zend_string_release(clear_sql);
    if (!Z_ISUNDEF(rows)) zval_ptr_dtor(&rows);
    if (ok) {
        ZVAL_UNDEF(&rows);
        zend_string *sql = zend_string_init(
            "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE "
            "a.datname=current_database() AND a.pid<>pg_backend_pid() AND NOT l.granted)",
            sizeof("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE "
            "a.datname=current_database() AND a.pid<>pg_backend_pid() AND NOT l.granted)") - 1,
            0
        );
        ok = utils_fetch(db, &tables, &transaction, sql, &args, &rows);
        zend_string_release(sql);
    }
    zval_ptr_dtor(&driver);
    zval_ptr_dtor(&transaction);
    zval_ptr_dtor(&tables);
    zval_ptr_dtor(&args);
    if (!ok) {
        if (!Z_ISUNDEF(rows)) zval_ptr_dtor(&rows);
        RETURN_THROWS();
    }
    zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
    zval *value = row == NULL || Z_TYPE_P(row) != IS_ARRAY ? NULL : zend_hash_index_find(Z_ARRVAL_P(row), 0);
    bool waiting = value != NULL && (Z_TYPE_P(value) == IS_TRUE
        || (Z_TYPE_P(value) == IS_STRING && (zend_string_equals_literal(Z_STR_P(value), "t")
        || zend_string_equals_literal(Z_STR_P(value), "1")))
        || (Z_TYPE_P(value) == IS_LONG && Z_LVAL_P(value) == 1));
    zval_ptr_dtor(&rows);
    RETURN_BOOL(waiting);
}

ZEND_METHOD(Polyspec_Orm_Utils, schema)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!utils_new_subutility(ZEND_THIS, "Polyspec\\Orm\\SchemaUtils", return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Utils, privileges)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!utils_new_subutility(ZEND_THIS, "Polyspec\\Orm\\PrivilegeUtils", return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Utils, aes)
{
    ZEND_PARSE_PARAMETERS_NONE();
    if (!utils_new_subutility(ZEND_THIS, "Polyspec\\Orm\\AesUtils", return_value)) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_Utils, stats)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *db = utils_db(ZEND_THIS);
    if (!utils_call(db, "stats", return_value, 0, NULL)) RETURN_THROWS();
}

void utils_set_class(zend_class_entry *ce)
{
    utils_ce = ce;
}
