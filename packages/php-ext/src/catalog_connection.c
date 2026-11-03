/*
 * The catalog connection of SCH-6a (PHP Polyspec\Orm\Catalog). It follows the PHP client (packages/php/src/Catalog.php): the same
 * SQL, the same sessions and the same error codes. Connection setup is the PHP library's Orm::parseDsn and Orm::connect, which
 * build the PDO handle of the Db that the extension implements (db.c); the catalog operations are here.
 */
#include "dbspec.h"
#include <errno.h>
#include <ctype.h>

zend_class_entry *catalog_ce;
zend_class_entry *catalog_ce_metadata, *catalog_ce_result, *catalog_ce_table_page, *catalog_ce_snapshot;

#define CAT_METADATA_ROWS 2048
#define CAT_METADATA_BYTES (4 << 20)
#define CAT_PAGE_BYTES (8 << 20)
#define CAT_SNAPSHOT_BYTES (8 << 20)
#define CAT_DEFAULT_ROWS 100000
#define CAT_DEFAULT_BYTES (64 << 20)
#define CAT_SQL_BYTES (256 << 10)
#define CAT_PDO_FETCH_NUM 3 /* PDO::FETCH_NUM */

/* The native relation kind and the columns of a relation by dialect (Catalog::KIND_SQL and Catalog::COLUMNS_SQL). */
static const char *cat_kind_sql(const char *dialect)
{
    if (strcmp(dialect, "mysql") == 0) return "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?";
    if (strcmp(dialect, "postgres") == 0) return "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? AND c.relname=?";
    return "SELECT type FROM pragma_table_list WHERE schema=? AND name=?";
}

static const char *cat_columns_sql(const char *dialect)
{
    if (strcmp(dialect, "mysql") == 0) return "SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE(pk.ORDINAL_POSITION,0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.CONSTRAINT_SCHEMA=c.TABLE_SCHEMA AND pk.TABLE_NAME=c.TABLE_NAME AND pk.COLUMN_NAME=c.COLUMN_NAME AND pk.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION";
    if (strcmp(dialect, "postgres") == 0) return "SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0),(a.attidentity<>''),CASE WHEN length(a.attgenerated)=0 THEN pg_get_expr(d.adbin,d.adrelid) END,(d.adbin IS NOT NULL AND length(a.attgenerated)=0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=? AND c.relname=? AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum";
    return "SELECT name,type,NOT \"notnull\",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?,?) ORDER BY cid";
}

/* ---- errors ---------------------------------------------------------------------------------------------------------------- */

/* Replaces the pending PDOException with the OrmException that the driver error maps to (Db::driverError). */
static void cat_driver_error(zval *db)
{
    zval ex, mapped;
    ZVAL_OBJ(&ex, EG(exception));
    EG(exception) = NULL;
    if (pdo_call(db, "driverError", &mapped, 1, &ex, NULL)) {
        zend_throw_exception_object(&mapped);
    }
    zval_ptr_dtor(&ex);
}

/* ---- statements ------------------------------------------------------------------------------------------------------------ */

/* Runs one statement without parameters on the PDO handle. On failure the PDOException stays pending. */
static bool cat_try_exec(zval *pdo, const char *sql)
{
    zval arg, ret;
    ZVAL_STRING(&arg, sql);
    bool ok = pdo_call(pdo, "exec", &ret, 1, &arg, NULL);
    zval_ptr_dtor(&arg);
    if (ok) {
        zval_ptr_dtor(&ret);
    }
    return ok;
}

/* Sends ROLLBACK when the transaction is still open (Catalog::endTransaction). SQLite rolls a transaction back by itself after
 * some errors, such as RAISE(ROLLBACK) or an I/O error, and a ROLLBACK then fails with "no transaction is active" (INT-155). */
static bool cat_try_rollback(zval *pdo)
{
    zend_string *name = zend_string_init("Pdo\\Sqlite", sizeof("Pdo\\Sqlite") - 1, 0);
    zend_class_entry *sqlite_ce = zend_lookup_class_ex(name, NULL, ZEND_FETCH_CLASS_NO_AUTOLOAD);
    zend_string_release(name);
    if (sqlite_ce != NULL && Z_TYPE_P(pdo) == IS_OBJECT && instanceof_function(Z_OBJCE_P(pdo), sqlite_ce)) {
        zval open;
        if (!pdo_call(pdo, "inTransaction", &open, 0, NULL, NULL)) return false;
        bool in_transaction = zend_is_true(&open);
        zval_ptr_dtor(&open);
        if (!in_transaction) return true;
    }
    return cat_try_exec(pdo, "ROLLBACK");
}

static bool cat_call_n(zval *obj, const char *name, zval *ret, uint32_t argc, zval *argv);

/* Executes a prepared statement with its arguments. A PHP bool is bound as a bool (DIA-29): the execute of an array binds a
 * false as the empty string, which MySQL and SQLite refuse for a boolean column. So when an argument is a bool, every
 * argument is bound by its type, as the PHP client does: a bool with PDO::PARAM_BOOL, null with PDO::PARAM_NULL and the
 * others with PDO::PARAM_STR. Without a bool the arguments go to execute as before. */
static bool cat_execute(zval *st, zval *args, zval *ret)
{
    zval *v;
    bool has_bool = false;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(args), v) {
        if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) has_bool = true;
    } ZEND_HASH_FOREACH_END();
    if (!has_bool) {
        return pdo_call(st, "execute", ret, 1, args, NULL);
    }
    zend_long index = 0;
    bool ok = true;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(args), v) {
        zval bind[3];
        ZVAL_LONG(&bind[0], ++index);
        ZVAL_COPY(&bind[1], v);
        if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) {
            ZVAL_LONG(&bind[2], 5); /* PDO::PARAM_BOOL */
        } else {
            ZVAL_LONG(&bind[2], Z_TYPE_P(v) == IS_NULL ? 0 : 2); /* PDO::PARAM_NULL, PDO::PARAM_STR */
        }
        zval r;
        ok = cat_call_n(st, "bindValue", &r, 3, bind);
        zval_ptr_dtor(&bind[1]);
        if (!ok) break;
        zval_ptr_dtor(&r);
    } ZEND_HASH_FOREACH_END();
    if (!ok) return false;
    return pdo_call(st, "execute", ret, 0, NULL, NULL);
}

/* The MySQL buffering attribute of the PDO connection: Pdo\Mysql on PHP 8.4 and later, the PDO constant before. */
static zend_long cat_mysql_buffered_attr(void)
{
    zval *c = zend_get_constant_str("Pdo\\Mysql::ATTR_USE_BUFFERED_QUERY", sizeof("Pdo\\Mysql::ATTR_USE_BUFFERED_QUERY") - 1);
    if (c == NULL) {
        c = zend_get_constant_str("PDO::MYSQL_ATTR_USE_BUFFERED_QUERY", sizeof("PDO::MYSQL_ATTR_USE_BUFFERED_QUERY") - 1);
    }
    return c != NULL && Z_TYPE_P(c) == IS_LONG ? Z_LVAL_P(c) : 1000;
}

/* Turns the buffering of the next MySQL statement on or off: an unbuffered statement streams its rows as they are fetched. */
static bool cat_mysql_buffered(zval *pdo, bool on)
{
    zval attr, value, ret;
    ZVAL_LONG(&attr, cat_mysql_buffered_attr());
    ZVAL_BOOL(&value, on);
    if (!pdo_call(pdo, "setAttribute", &ret, 2, &attr, &value)) return false;
    zval_ptr_dtor(&ret);
    return true;
}

/* The connection id of the PDO MySQL connection: a budget stop kills the running query by it. */
static bool cat_mysql_connection_id(zval *pdo, zend_long *id)
{
    zval q, st, r, mode, row;
    *id = 0;
    ZVAL_STRING(&q, "SELECT CONNECTION_ID()");
    bool ok = pdo_call(pdo, "prepare", &st, 1, &q, NULL);
    zval_ptr_dtor(&q);
    if (!ok) return false;
    ok = pdo_call(&st, "execute", &r, 0, NULL, NULL);
    if (!ok) {
        zval_ptr_dtor(&st);
        return false;
    }
    zval_ptr_dtor(&r);
    ZVAL_LONG(&mode, CAT_PDO_FETCH_NUM);
    ok = pdo_call(&st, "fetch", &row, 1, &mode, NULL);
    zval_ptr_dtor(&st);
    if (!ok) return false;
    if (Z_TYPE(row) == IS_ARRAY) {
        zval *v = zend_hash_index_find(Z_ARRVAL(row), 0);
        if (v != NULL && Z_TYPE_P(v) == IS_LONG) {
            *id = Z_LVAL_P(v);
        } else if (v != NULL && Z_TYPE_P(v) == IS_STRING) {
            *id = ZEND_STRTOL(Z_STRVAL_P(v), NULL, 10);
        }
    }
    zval_ptr_dtor(&row);
    return true;
}

/* Kills the running query of a connection id through a connection of its own, which ends with the kill: the killed query ends
 * with an error on its own connection, which keeps the connection that the stop rolls back. */
static bool cat_kill_thread(zval *owner, zend_long id)
{
    zval rv_dsn, *dsn = catalog_prop(owner, "dsn", &rv_dsn);
    zval config, args[2], killer, pdo, ret;
    if (!newobj("Polyspec\\Orm\\Config", &config, 0, NULL)) return false;
    ZVAL_COPY_VALUE(&args[0], dsn);
    ZVAL_COPY_VALUE(&args[1], &config);
    bool connected = scall("Polyspec\\Orm\\Orm::connect", &killer, 2, args);
    zval_ptr_dtor(&config);
    if (!connected) return false;
    bool ok = pdo_call(&killer, "pdo", &pdo, 0, NULL, NULL);
    if (ok) {
        char sql[64];
        snprintf(sql, sizeof(sql), "KILL QUERY %ld", (long)id);
        ok = cat_try_exec(&pdo, sql);
        zval_ptr_dtor(&pdo);
    }
    if (pdo_call(&killer, "close", &ret, 0, NULL, NULL)) zval_ptr_dtor(&ret);
    zval_ptr_dtor(&killer);
    return ok && EG(exception) == NULL;
}

/* Kills the query that runs on the connection id of the PDO connection of a catalog's Db. */
static bool cat_kill_query(zval *db, zend_long id)
{
    zval rv_s, *state = catalog_prop(db, "state", &rv_s);
    zval rv_o, *owner = zend_read_property(Z_OBJCE_P(state), Z_OBJ_P(state), "catalogOwner", sizeof("catalogOwner") - 1, true, &rv_o);
    if (Z_TYPE_P(owner) != IS_OBJECT) {
        db_throw_orm("DRIVER", "the catalog that owns the connection is unknown");
        return false;
    }
    return cat_kill_thread(owner, id);
}

/* Adds a fetched row to a bounded result. It returns 0 when the row fits, 1 when the rows are over the budget and 2 when
 * the bytes of values are; a row that does not fit is released. */
static int cat_bound_row(zval *rows, zval *row, zend_long max_rows, zend_long max_bytes, zend_long *budget)
{
    if ((zend_long)zend_hash_num_elements(Z_ARRVAL_P(rows)) == max_rows) {
        zval_ptr_dtor(row);
        return 1;
    }
    zval *v;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), v) {
        *budget += Z_TYPE_P(v) == IS_STRING ? (zend_long)Z_STRLEN_P(v) : 8;
    } ZEND_HASH_FOREACH_END();
    if (*budget > max_bytes) {
        zval_ptr_dtor(row);
        return 2;
    }
    add_next_index_zval(rows, row);
    return 0;
}

static void cat_limit_throw(int kind, zend_long max_rows, zend_long max_bytes)
{
    if (kind == 1) {
        db_throw_orm("CATALOG_LIMIT", "result has more than %ld rows", (long)max_rows);
    } else {
        db_throw_orm("CATALOG_LIMIT", "result has more than %ld bytes of values", (long)max_bytes);
    }
}

/* The column names and the upper-case native type names of an executed statement. */
static bool cat_statement_columns(zval *st, zval *names, zval *types)
{
    zval count;
    if (!pdo_call(st, "columnCount", &count, 0, NULL, NULL)) return false;
    for (zend_long i = 0; i < Z_LVAL(count); i++) {
        zval index, meta;
        ZVAL_LONG(&index, i);
        if (!pdo_call(st, "getColumnMeta", &meta, 1, &index, NULL)) {
            zval_ptr_dtor(&count);
            return false;
        }
        zval *name = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "name", 4) : NULL;
        zval *native = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "native_type", 11) : NULL;
        add_next_index_str(names, name != NULL && Z_TYPE_P(name) == IS_STRING ? zend_string_copy(Z_STR_P(name)) : ZSTR_EMPTY_ALLOC());
        zend_string *type = native != NULL && Z_TYPE_P(native) == IS_STRING ? zend_string_toupper(Z_STR_P(native)) : ZSTR_EMPTY_ALLOC();
        add_next_index_str(types, type);
        zval_ptr_dtor(&meta);
    }
    zval_ptr_dtor(&count);
    return true;
}

#define CAT_CURSOR "orm_read_ext"
#define CAT_CURSOR_CHUNK 256

/* Closes the read cursor, and clears the exception of a close that fails because the read was stopped. */
static void cat_cursor_close_quiet(zval *pdo)
{
    zval q, r;
    ZVAL_STRING(&q, "CLOSE " CAT_CURSOR);
    if (pdo_call(pdo, "exec", &r, 1, &q, NULL)) {
        zval_ptr_dtor(&r);
    } else {
        zend_clear_exception();
    }
    zval_ptr_dtor(&q);
}

/* Closes the read cursor after a driver error, and keeps that error as the pending exception. */
static void cat_cursor_close_keep(zval *pdo)
{
    bool had = EG(exception) != NULL;
    zval saved;
    if (had) {
        ZVAL_OBJ(&saved, EG(exception));
        EG(exception) = NULL;
    }
    cat_cursor_close_quiet(pdo);
    if (had) EG(exception) = Z_OBJ(saved);
}

static zend_long cat_cells_size(zval *cells);

/* Converts one fetched row into the cells that a bounded read keeps, by the dialect and the native types of its columns; it
 * returns false with the exception thrown. */
typedef bool (*cat_row_convert)(zval *row, zval *types, const char *dialect, zval *cells);

/* Bounds one fetched row as cat_bound_row does, after converting it: the row limit is checked first, and the byte budget
 * counts the converted cells (INT-115). It returns false with the exception of a failed conversion thrown, and otherwise
 * sets *limit to 0, or to the kind of budget that the row exceeds. The fetched row is released. */
static bool cat_convert_bound(zval *rows, zval *row, zval *types, const char *dialect, cat_row_convert convert,
                              zend_long max_rows, zend_long max_bytes, zend_long *budget, int *limit)
{
    if ((zend_long)zend_hash_num_elements(Z_ARRVAL_P(rows)) == max_rows) {
        zval_ptr_dtor(row);
        *limit = 1;
        return true;
    }
    zval cells;
    bool made = convert(row, types, dialect, &cells);
    zval_ptr_dtor(row);
    if (!made) return false;
    *budget += cat_cells_size(&cells);
    if (*budget > max_bytes) {
        zval_ptr_dtor(&cells);
        *limit = 2;
        return true;
    }
    add_next_index_zval(rows, &cells);
    *limit = 0;
    return true;
}

/* A PostgreSQL read without parameters through a cursor, in chunks of 256 rows: a budget stop leaves the rest of the
 * result unread and closes the cursor. With convert, each row is converted as it is read and the byte budget counts its
 * cells (INT-115), the text of a decimal or temporal grid cell rather than the driver value it came from. */
static bool cat_cursor_query(zval *db, zval *pdo, const char *sql, zend_long max_rows, zend_long max_bytes,
                             zval *names, zval *types, zval *rows, cat_row_convert convert)
{
    zval q, r;
    zend_string *declare = zend_strpprintf(0, "DECLARE %s NO SCROLL CURSOR FOR %s", CAT_CURSOR, sql);
    ZVAL_STR(&q, declare);
    bool ok = pdo_call(pdo, "exec", &r, 1, &q, NULL);
    zval_ptr_dtor(&q);
    if (!ok) goto driver;
    zval_ptr_dtor(&r);
    zend_long budget = 0;
    zend_long fetched = CAT_CURSOR_CHUNK;
    bool described = false;
    while (fetched == CAT_CURSOR_CHUNK) {
        zval fq, st, mode;
        zend_string *fetch_sql = zend_strpprintf(0, "FETCH FORWARD %d FROM %s", CAT_CURSOR_CHUNK, CAT_CURSOR);
        ZVAL_STR(&fq, fetch_sql);
        ok = pdo_call(pdo, "prepare", &st, 1, &fq, NULL);
        zval_ptr_dtor(&fq);
        if (!ok) goto driver_cursor;
        ok = pdo_call(&st, "execute", &r, 0, NULL, NULL);
        if (!ok) {
            zval_ptr_dtor(&st);
            goto driver_cursor;
        }
        zval_ptr_dtor(&r);
        if (!described) {
            if (!cat_statement_columns(&st, names, types)) {
                zval_ptr_dtor(&st);
                goto driver_cursor;
            }
            described = true;
        }
        fetched = 0;
        ZVAL_LONG(&mode, CAT_PDO_FETCH_NUM);
        for (;;) {
            zval row;
            ok = pdo_call(&st, "fetch", &row, 1, &mode, NULL);
            if (!ok) {
                zval_ptr_dtor(&st);
                goto driver_cursor;
            }
            if (Z_TYPE(row) == IS_FALSE) break;
            fetched++;
            int limit;
            if (convert == NULL) {
                limit = cat_bound_row(rows, &row, max_rows, max_bytes, &budget);
            } else if (!cat_convert_bound(rows, &row, types, "postgres", convert, max_rows, max_bytes, &budget, &limit)) {
                /* The conversion error is the one reported and stays pending through the close; names and rows stay the
                 * caller's, as after a read. */
                zval_ptr_dtor(&st);
                cat_cursor_close_keep(pdo);
                zval_ptr_dtor(types);
                return false;
            }
            if (limit != 0) {
                zval_ptr_dtor(&st);
                cat_cursor_close_quiet(pdo);
                cat_limit_throw(limit, max_rows, max_bytes);
                return false;
            }
        }
        zval_ptr_dtor(&st);
    }
    ZVAL_STRING(&q, "CLOSE " CAT_CURSOR);
    ok = pdo_call(pdo, "exec", &r, 1, &q, NULL);
    zval_ptr_dtor(&q);
    if (!ok) goto driver;
    zval_ptr_dtor(&r);
    return true;
driver_cursor:
    cat_cursor_close_keep(pdo);
driver:
    cat_driver_error(db);
    zval_ptr_dtor(names);
    zval_ptr_dtor(types);
    zval_ptr_dtor(rows);
    return false;
}

/* Binds the parameters by their PHP types, as the PDO client does for MySQL and SQLite: execute() would bind each as a string,
 * and a MySQL or SQLite comparison or result type would follow the string. */
static bool cat_bind_typed(zval *st, zval *args)
{
    zend_long index = 1;
    zval *v;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(args), v) {
        zend_long type = Z_TYPE_P(v) == IS_NULL ? 0 : Z_TYPE_P(v) == IS_LONG ? 1 : (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) ? 5 : 2;
        zval argv[3], ret;
        ZVAL_LONG(&argv[0], index++);
        ZVAL_COPY(&argv[1], v);
        ZVAL_LONG(&argv[2], type);
        bool ok = cat_call_n(st, "bindValue", &ret, 3, argv);
        zval_ptr_dtor(&argv[1]);
        if (!ok) return false;
        zval_ptr_dtor(&ret);
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* A bounded result as the PHP client's query(): the names, the native type names (upper case) and the rows, all arrays the
 * caller releases. It fails with CATALOG_LIMIT when the rows or the bytes of values are over the budget. A MySQL statement
 * streams its rows unbuffered, and a budget stop kills it by its connection id; a PostgreSQL statement without parameters
 * reads through a cursor. */
static bool cat_query_body(zval *db, zval *pdo, const char *sql, zval *args, zend_long max_rows, zend_long max_bytes,
                           zval *names, zval *types, zval *rows, cat_row_convert convert);

/* A PostgreSQL statement with parameters is rewritten: PDO binds only ? placeholders, so each $n becomes ? and its parameter
 * follows in the order of the placeholders (a repeated $n binds its value again). */
static bool cat_pg_rewrite(zend_string *sql, zval *args, zend_string **out_sql, zval *out_args)
{
    smart_str s = {0};
    array_init(out_args);
    const char *p = ZSTR_VAL(sql), *end = p + ZSTR_LEN(sql);
    while (p < end) {
        if (*p == '$' && p + 1 < end && p[1] >= '0' && p[1] <= '9') {
            const char *q = p + 1;
            zend_ulong n = 0;
            while (q < end && *q >= '0' && *q <= '9') {
                n = n * 10 + (zend_ulong)(*q - '0');
                q++;
            }
            zval *v = n >= 1 ? zend_hash_index_find(Z_ARRVAL_P(args), n - 1) : NULL;
            if (v == NULL) {
                smart_str_free(&s);
                zval_ptr_dtor(out_args);
                db_throw_orm("DRIVER", "placeholder $%lu has no parameter", (unsigned long)n);
                return false;
            }
            Z_TRY_ADDREF_P(v);
            add_next_index_zval(out_args, v);
            smart_str_appendc(&s, '?');
            p = q;
        } else {
            smart_str_appendc(&s, *p);
            p++;
        }
    }
    smart_str_0(&s);
    *out_sql = smart_str_extract(&s);
    return true;
}

static bool cat_has_pg_placeholder(const char *sql)
{
    for (const char *p = sql; *p != '\0'; p++) {
        if (*p == '$' && p[1] >= '0' && p[1] <= '9') return true;
    }
    return false;
}

/* A bounded result as the PHP client's query(), with the PostgreSQL placeholders of a statement with parameters rewritten. */
static bool cat_query(zval *db, zval *pdo, const char *sql, zval *args, zend_long max_rows, zend_long max_bytes,
                      zval *names, zval *types, zval *rows, cat_row_convert convert)
{
    array_init(names);
    array_init(types);
    array_init(rows);
    zval driver;
    if (!pdo_call(db, "driver", &driver, 0, NULL, NULL)) {
        cat_driver_error(db);
        zval_ptr_dtor(names);
        zval_ptr_dtor(types);
        zval_ptr_dtor(rows);
        return false;
    }
    bool postgres = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR_P(&driver), "postgres");
    zval_ptr_dtor(&driver);
    if (!postgres || zend_hash_num_elements(Z_ARRVAL_P(args)) == 0 || !cat_has_pg_placeholder(sql)) {
        return cat_query_body(db, pdo, sql, args, max_rows, max_bytes, names, types, rows, convert);
    }
    zend_string *source = zend_string_init(sql, strlen(sql), 0);
    zend_string *rewritten = NULL;
    zval rewritten_args;
    bool rewrote = cat_pg_rewrite(source, args, &rewritten, &rewritten_args);
    zend_string_release(source);
    if (!rewrote) {
        zval_ptr_dtor(names);
        zval_ptr_dtor(types);
        zval_ptr_dtor(rows);
        return false;
    }
    bool ok = cat_query_body(db, pdo, ZSTR_VAL(rewritten), &rewritten_args, max_rows, max_bytes, names, types, rows, convert);
    zend_string_release(rewritten);
    zval_ptr_dtor(&rewritten_args);
    return ok;
}

static bool cat_query_body(zval *db, zval *pdo, const char *sql, zval *args, zend_long max_rows, zend_long max_bytes,
                           zval *names, zval *types, zval *rows, cat_row_convert convert)
{
    zval driver;
    if (!pdo_call(db, "driver", &driver, 0, NULL, NULL)) goto driver;
    bool postgres = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR_P(&driver), "postgres");
    bool mysql = Z_TYPE(driver) == IS_STRING && zend_string_equals_literal(Z_STR_P(&driver), "mysql");
    zval_ptr_dtor(&driver);
    if (postgres && zend_hash_num_elements(Z_ARRVAL_P(args)) == 0) {
        return cat_cursor_query(db, pdo, sql, max_rows, max_bytes, names, types, rows, convert);
    }
    zend_long connection_id = 0;
    if (mysql && !cat_mysql_connection_id(pdo, &connection_id)) goto driver;
    zval q, st, r;
    ZVAL_STRING(&q, sql);
    bool ok = pdo_call(pdo, "prepare", &st, 1, &q, NULL);
    zval_ptr_dtor(&q);
    if (!ok) goto driver;
    /* MySQL and SQLite bind each parameter by its PHP type; execute() would bind every one as a string. */
    bool typed = !postgres && zend_hash_num_elements(Z_ARRVAL_P(args)) > 0;
    if (typed && !cat_bind_typed(&st, args)) goto driver_st;
    if (mysql && !cat_mysql_buffered(pdo, false)) goto driver_st;
    ok = typed ? pdo_call(&st, "execute", &r, 0, NULL, NULL) : cat_execute(&st, args, &r);
    if (mysql && !cat_mysql_buffered(pdo, true)) {
        if (ok) zval_ptr_dtor(&r);
        goto driver_st;
    }
    if (!ok) goto driver_st;
    zval_ptr_dtor(&r);
    if (!cat_statement_columns(&st, names, types)) goto driver_st;
    zend_long budget = 0;
    for (;;) {
        zval mode, row;
        ZVAL_LONG(&mode, CAT_PDO_FETCH_NUM);
        ok = pdo_call(&st, "fetch", &row, 1, &mode, NULL);
        if (!ok) goto driver_st;
        if (Z_TYPE(row) == IS_FALSE) break;
        int limit;
        if (convert == NULL) {
            limit = cat_bound_row(rows, &row, max_rows, max_bytes, &budget);
        } else if (!cat_convert_bound(rows, &row, types, postgres ? "postgres" : mysql ? "mysql" : "sqlite", convert, max_rows,
                                      max_bytes, &budget, &limit)) {
            limit = -1;
        }
        if (limit != 0) {
            /* A failed conversion stops the read as a budget does, and its error is the one reported. */
            zend_object *failure = NULL;
            if (limit < 0) {
                failure = EG(exception);
                EG(exception) = NULL;
            }
            if (mysql && connection_id > 0 && !cat_kill_query(db, connection_id)) {
                if (failure != NULL) OBJ_RELEASE(failure);
                zval_ptr_dtor(&st);
                goto driver;
            }
            /* The killed query ends its read with an error, the expected end of a stop, so that error is cleared. */
            if (pdo_call(&st, "closeCursor", &r, 0, NULL, NULL)) {
                zval_ptr_dtor(&r);
            } else {
                zend_clear_exception();
            }
            zval_ptr_dtor(&st);
            if (failure != NULL) {
                EG(exception) = failure;
            } else {
                cat_limit_throw(limit, max_rows, max_bytes);
            }
            return false;
        }
    }
    if (!pdo_call(&st, "closeCursor", &r, 0, NULL, NULL)) goto driver_st;
    zval_ptr_dtor(&r);
    zval_ptr_dtor(&st);
    return true;
driver_st:
    zval_ptr_dtor(&st);
driver:
    cat_driver_error(db);
    zval_ptr_dtor(names);
    zval_ptr_dtor(types);
    zval_ptr_dtor(rows);
    return false;
}

/* ---- values ---------------------------------------------------------------------------------------------------------------- */

static bool cat_utf8_valid(const char *s, size_t n)
{
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;
    while (i < n) {
        unsigned char c = p[i];
        size_t len;
        uint32_t cp;
        if (c < 0x80) { i++; continue; }
        if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1F; }
        else if (c >= 0xE0 && c <= 0xEF) { len = 3; cp = c & 0x0F; }
        else if (c >= 0xF0 && c <= 0xF4) { len = 4; cp = c & 0x07; }
        else return false;
        if (i + len > n) return false;
        for (size_t k = 1; k < len; k++) {
            if ((p[i + k] & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (p[i + k] & 0x3F);
        }
        if ((len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF))) return false;
        i += len;
    }
    return true;
}

/* Whether a namespace, table or column name is 1..1024 UTF-8 bytes without NUL (Catalog::checkName). */
static bool cat_name_ok(zend_string *name)
{
    return ZSTR_LEN(name) != 0 && ZSTR_LEN(name) <= 1024 && memchr(ZSTR_VAL(name), 0, ZSTR_LEN(name)) == NULL
        && cat_utf8_valid(ZSTR_VAL(name), ZSTR_LEN(name));
}

/* Throws TABLE_REFERENCE_INVALID unless the name is valid. */
static void cat_check_name(zend_string *name)
{
    if (!cat_name_ok(name)) {
        db_throw_orm("TABLE_REFERENCE_INVALID", "expected 1..1024 UTF-8 bytes without NUL");
    }
}

/* Throws ROW_SNAPSHOT_INVALID for a name of a descriptor that is not valid, with the TABLE_REFERENCE_INVALID of that name as its
 * message and its previous (INT-109), as the PHP library does. */
static void cat_throw_descriptor_name(void)
{
    zval cause;
    zend_string *reason = zend_string_init("expected 1..1024 UTF-8 bytes without NUL", sizeof("expected 1..1024 UTF-8 bytes without NUL") - 1, 0);
    bool built = orm_exception_object(NULL, "TABLE_REFERENCE_INVALID", reason, &cause);
    zend_string_release(reason);
    if (!built) {
        return;
    }
    zend_string *message = zend_string_init(
        "invalid original row or descriptor: TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL",
        sizeof("invalid original row or descriptor: TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL") - 1, 0);
    orm_throw_exception_previous("ROW_SNAPSHOT_INVALID", message, Z_OBJ(cause));
    zend_string_release(message);
}

/* The text of a metadata value, or TABLE_METADATA_INVALID (Catalog::text). */
static zend_string *cat_text(zval *v)
{
    if (Z_TYPE_P(v) != IS_STRING) {
        db_throw_orm("TABLE_METADATA_INVALID", "expected text, got %s", zend_zval_type_name(v));
        return NULL;
    }
    return Z_STR_P(v);
}

/* A boolean of a metadata row: a native boolean, or integer or text 0 and 1 (Catalog::boolValue). */
static bool cat_bool(zval *v, bool *out)
{
    if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) { *out = Z_TYPE_P(v) == IS_TRUE; return true; }
    if (Z_TYPE_P(v) == IS_LONG && (Z_LVAL_P(v) == 0 || Z_LVAL_P(v) == 1)) { *out = Z_LVAL_P(v) == 1; return true; }
    if (Z_TYPE_P(v) == IS_STRING && Z_STRLEN_P(v) == 1 && (Z_STRVAL_P(v)[0] == '0' || Z_STRVAL_P(v)[0] == '1')) {
        *out = Z_STRVAL_P(v)[0] == '1';
        return true;
    }
    db_throw_orm("TABLE_METADATA_INVALID", "expected a boolean");
    return false;
}

/* An integer of a metadata row or a cell: a native integer, or text that holds one; false for any other value. */
static bool cat_parse_int(zval *v, zend_long *out)
{
    if (Z_TYPE_P(v) == IS_LONG) { *out = Z_LVAL_P(v); return true; }
    if (Z_TYPE_P(v) == IS_STRING) {
        const char *p = Z_STRVAL_P(v);
        size_t n = Z_STRLEN_P(v), i = 0;
        bool neg = n > 0 && p[0] == '-';
        if (neg) i = 1;
        if (i < n && n - i <= 18) {
            zend_long r = 0;
            for (; i < n && p[i] >= '0' && p[i] <= '9'; i++) r = r * 10 + (p[i] - '0');
            if (i == n) { *out = neg ? -r : r; return true; }
        }
    }
    return false;
}

/* An integer of a metadata row: a native integer, or text that holds one (Catalog::intValue). */
static bool cat_int(zval *v, zend_long *out)
{
    if (cat_parse_int(v, out)) return true;
    db_throw_orm("TABLE_METADATA_INVALID", "expected an integer, got %s", zend_zval_type_name(v));
    return false;
}

/* ---- sessions -------------------------------------------------------------------------------------------------------------- */

/* Opens the read-only transaction of a session on the Db's PDO handle (Catalog::begin). SQLite sets query_only itself. */
static bool cat_begin_read(zval *db, const char *dialect, zval *pdo)
{
    if (!pdo_call(db, "pdo", pdo, 0, NULL, NULL)) {
        return false;
    }
    if (strcmp(dialect, "sqlite") == 0 && !cat_try_exec(pdo, "PRAGMA query_only = ON")) {
        cat_driver_error(db);
        return false;
    }
    const char *begin = strcmp(dialect, "mysql") == 0 ? "START TRANSACTION READ ONLY"
        : strcmp(dialect, "postgres") == 0 ? "BEGIN READ ONLY" : "BEGIN";
    if (!cat_try_exec(pdo, begin)) {
        cat_driver_error(db);
        return false;
    }
    return true;
}

/* Ends a failed session: ROLLBACK, and the cause stays the pending error. A failed ROLLBACK becomes OrmException::rollback(cause, driver error). */
static void cat_abort(zval *db, zval *pdo)
{
    zval cause;
    ZVAL_OBJ(&cause, EG(exception));
    EG(exception) = NULL;
    if (cat_try_rollback(pdo)) {
        EG(exception) = Z_OBJ(cause);
        return;
    }
    cat_driver_error(db);
    zval mapped;
    ZVAL_OBJ(&mapped, EG(exception));
    EG(exception) = NULL;
    zval args[2], rolled;
    ZVAL_COPY_VALUE(&args[0], &cause);
    ZVAL_COPY_VALUE(&args[1], &mapped);
    if (scall("Polyspec\\Orm\\OrmException::rollback", &rolled, 2, args)) {
        zend_throw_exception_object(&rolled);
    }
    zval_ptr_dtor(&cause);
    zval_ptr_dtor(&mapped);
}

/* Ends a successful read session with ROLLBACK; a failure is ROW_ROLLBACK_FAILED with the driver error as its previous error. */
static bool cat_end_read(zval *db, zval *pdo)
{
    if (cat_try_rollback(pdo)) {
        return true;
    }
    zval previous, mapped, message, args[3], ex;
    ZVAL_OBJ(&previous, EG(exception));
    EG(exception) = NULL;
    if (pdo_call(db, "driverError", &mapped, 1, &previous, NULL) && pdo_call(&mapped, "getMessage", &message, 0, NULL, NULL)) {
        ZVAL_STRING(&args[0], "ROW_ROLLBACK_FAILED");
        zend_string *text = zend_strpprintf(0, "rollback: %s", Z_STRVAL(message));
        ZVAL_STR(&args[1], text);
        ZVAL_COPY_VALUE(&args[2], &previous);
        if (newobj("Polyspec\\Orm\\OrmException", &ex, 3, args)) {
            zend_throw_exception_object(&ex);
        }
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&args[1]);
        zval_ptr_dtor(&message);
        zval_ptr_dtor(&mapped);
    }
    zval_ptr_dtor(&previous);
    return false;
}

static void cat_quote(smart_str *out, zend_string *name, const char *dialect)
{
    const char *mark = strcmp(dialect, "mysql") == 0 ? "`" : "\"";
    smart_str_appends(out, mark);
    for (size_t i = 0; i < ZSTR_LEN(name); i++) {
        if (ZSTR_VAL(name)[i] == mark[0]) smart_str_appendc(out, mark[0]);
        smart_str_appendc(out, ZSTR_VAL(name)[i]);
    }
    smart_str_appends(out, mark);
}

static bool cat_cell_value(zval *v, zend_string *type, const char *dialect, zval *out)
{
    if (Z_TYPE_P(v) != IS_STRING) {
        if (Z_TYPE_P(v) == IS_DOUBLE && (strcmp(ZSTR_VAL(type), "REAL") == 0 || strcmp(ZSTR_VAL(type), "FLOAT") == 0
                || strcmp(ZSTR_VAL(type), "FLOAT4") == 0)) {
            ZVAL_DOUBLE(out, (double)(float)Z_DVAL_P(v));
            return true;
        }
        ZVAL_COPY(out, v);
        return true;
    }
    const char *t = ZSTR_VAL(type);
    bool integer = strcmp(t, "LONG") == 0 || strcmp(t, "LONGLONG") == 0 || strcmp(t, "SHORT") == 0 || strcmp(t, "TINY") == 0
        || strcmp(t, "INT24") == 0 || strcmp(t, "YEAR") == 0;
    if (!integer && strstr(t, "POINT") == NULL && strstr(t, "BLOB") == NULL && strstr(t, "BINARY") == NULL
        && strstr(t, "BYTEA") == NULL && strstr(t, "DECIMAL") == NULL && strstr(t, "NUMERIC") == NULL
        && strstr(t, "MONEY") == NULL && strcmp(t, "NEWDECIMAL") != 0 && strstr(t, "INT") != NULL) {
        integer = true;
    }
    if (integer) {
        zend_long n;
        if (!cat_parse_int(v, &n)) {
            /* SQLite keeps a text that is not an integer as stored, in an INTEGER column too (INT-152). */
            if (strcmp(dialect, "sqlite") == 0) {
                ZVAL_COPY(out, v);
                return true;
            }
            db_throw_orm("TABLE_METADATA_INVALID", "expected an integer, got %s", zend_zval_type_name(v));
            return false;
        }
        ZVAL_LONG(out, n);
        return true;
    }
    if (strstr(t, "BLOB") != NULL || strstr(t, "BINARY") != NULL || strstr(t, "BYTEA") != NULL || strstr(t, "DECIMAL") != NULL
        || strstr(t, "NUMERIC") != NULL || strstr(t, "MONEY") != NULL || strcmp(t, "NEWDECIMAL") == 0) {
        ZVAL_COPY(out, v);
        return true;
    }
    if (!cat_utf8_valid(Z_STRVAL_P(v), Z_STRLEN_P(v))) {
        db_throw_orm("CATALOG_VALUE", "text of native type \"%s\" is not valid UTF-8", t);
        return false;
    }
    ZVAL_COPY(out, v);
    return true;
}


/* The quoted identifier of the dialect, with its quote mark doubled inside it (Catalog::quote). */

static bool cat_exec(zval *db, zval *pdo, const char *sql, zval *args, zend_long *affected)
{
    zval q, st, ok_ret, count;
    ZVAL_STRING(&q, sql);
    bool ok = pdo_call(pdo, "prepare", &st, 1, &q, NULL);
    zval_ptr_dtor(&q);
    if (!ok) {
        cat_driver_error(db);
        return false;
    }
    zval empty;
    if (args == NULL) {
        array_init(&empty);
        args = &empty;
    }
    ok = cat_execute(&st, args, &ok_ret);
    if (!ok) {
        cat_driver_error(db);
        zval_ptr_dtor(&st);
        if (args == &empty) zval_ptr_dtor(&empty);
        return false;
    }
    zval_ptr_dtor(&ok_ret);
    ok = pdo_call(&st, "rowCount", &count, 0, NULL, NULL);
    if (args == &empty) zval_ptr_dtor(&empty);
    zval_ptr_dtor(&st);
    if (!ok) {
        cat_driver_error(db);
        return false;
    }
    if (affected != NULL) {
        *affected = Z_LVAL(count);
    }
    zval_ptr_dtor(&count);
    return true;
}


/* The value of a result cell of a native type (Catalog::value): integers, floats and binary keep their type, text must be UTF-8. */

/* ---- the metadata of a table ------------------------------------------------------------------------------------------------ */

/* Name of the catalog kind of the native relation kind (Catalog::kind). */
static bool cat_kind(const char *dialect, const char *native, const char **kind)
{
    if ((strcmp(dialect, "mysql") == 0 && strcmp(native, "BASE TABLE") == 0) || (strcmp(dialect, "postgres") == 0 && strcmp(native, "r") == 0)
        || (strcmp(dialect, "sqlite") == 0 && strcmp(native, "table") == 0)) { *kind = "table"; return true; }
    if ((strcmp(dialect, "mysql") == 0 && (strcmp(native, "VIEW") == 0 || strcmp(native, "SYSTEM VIEW") == 0))
        || (strcmp(dialect, "postgres") == 0 && strcmp(native, "v") == 0) || (strcmp(dialect, "sqlite") == 0 && strcmp(native, "view") == 0)) { *kind = "view"; return true; }
    if (strcmp(dialect, "postgres") == 0 && strcmp(native, "p") == 0) { *kind = "partitioned"; return true; }
    if (strcmp(dialect, "postgres") == 0 && strcmp(native, "m") == 0) { *kind = "materialized_view"; return true; }
    if (strcmp(dialect, "postgres") == 0 && strcmp(native, "f") == 0) { *kind = "foreign"; return true; }
    if (strcmp(dialect, "sqlite") == 0 && strcmp(native, "virtual") == 0) { *kind = "virtual"; return true; }
    if (strcmp(dialect, "sqlite") == 0 && strcmp(native, "shadow") == 0) { *kind = "shadow"; return true; }
    db_throw_orm("TABLE_KIND_UNSUPPORTED", "relation kind %s of %s", native, dialect);
    return false;
}

/* The table reference {namespace, name} of a PHP array, with its names checked (Catalog::tableRef). */
static bool cat_table_ref(zval *table, zend_string **ns, zend_string **name)
{
    zval *n, *m;
    if (zend_hash_num_elements(Z_ARRVAL_P(table)) != 2
        || (n = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9)) == NULL || Z_TYPE_P(n) != IS_STRING
        || (m = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4)) == NULL || Z_TYPE_P(m) != IS_STRING) {
        db_throw_orm("TABLE_REFERENCE_INVALID", "a table is {namespace, name}");
        return false;
    }
    cat_check_name(Z_STR_P(n));
    if (EG(exception)) return false;
    cat_check_name(Z_STR_P(m));
    if (EG(exception)) return false;
    *ns = Z_STR_P(n);
    *name = Z_STR_P(m);
    return true;
}

typedef struct {
    zend_string *name, *type, *def;
    bool nullable, generated, automatic, expression;
    zend_long check_precision; /* the CHECK fraction digits of a SQLite TIME or DATETIME column, -1 when none */
} cat_col;

typedef struct {
    zend_long ordinal;
    size_t index;
} cat_key;

static void cat_col_free(cat_col *c)
{
    if (c->name) zend_string_release(c->name);
    if (c->type) zend_string_release(c->type);
    if (c->def) zend_string_release(c->def);
}

/* The fraction digits of a GLOB '[0-9]...' of a CHECK clause: n classes are n digits; -1 when no GLOB of that form. */
static zend_long cat_check_glob_digits(const char *clause)
{
    for (const char *g = strstr(clause, "GLOB '"); g != NULL; g = strstr(g + 1, "GLOB '")) {
        const char *p = g + 6;
        zend_long n = 0;
        while (strncmp(p, "[0-9]", 5) == 0) {
            p += 5;
            n++;
        }
        if (*p == '\'') return n;
    }
    return -1;
}

/* The fraction digits that the CHECK of a SQLite column fixes, as Go reads them (Catalog::checkPrecision): a GLOB of n
 * [0-9] classes is n digits, and an IS time( or IS datetime( check is zero digits. -1 when no CHECK names the column. */
static zend_long cat_check_precision(zend_string *table_sql, zend_string *column)
{
    smart_str quoted = {0};
    smart_str_appendc(&quoted, '"');
    for (size_t c = 0; c < ZSTR_LEN(column); c++) {
        if (ZSTR_VAL(column)[c] == '"') smart_str_appendc(&quoted, '"');
        smart_str_appendc(&quoted, ZSTR_VAL(column)[c]);
    }
    smart_str_appendc(&quoted, '"');
    zend_string *needle = smart_str_extract(&quoted);
    zend_long result = -1;
    const char *s = ZSTR_VAL(table_sql);
    size_t len = ZSTR_LEN(table_sql);
    for (size_t p = 0; p + 5 <= len && result < 0; p++) {
        if (zend_binary_strncasecmp(s + p, len - p, "CHECK", 5, 5) != 0) continue;
        size_t q = p + 5;
        while (q < len && isspace((unsigned char)s[q])) q++;
        if (q >= len || s[q] != '(') continue;
        size_t start = q + 1, i = start;
        int depth = 1;
        while (i < len && depth > 0) {
            if (s[i] == '(') {
                depth++;
            } else if (s[i] == ')') {
                depth--;
            }
            i++;
        }
        if (depth != 0) continue;
        zend_string *clause = zend_string_init(s + start, i - 1 - start, 0);
        if (strstr(ZSTR_VAL(clause), ZSTR_VAL(needle)) != NULL) {
            zend_long digits = cat_check_glob_digits(ZSTR_VAL(clause));
            if (digits >= 0) {
                result = digits;
            } else if (strstr(ZSTR_VAL(clause), "IS time(") != NULL || strstr(ZSTR_VAL(clause), "IS datetime(") != NULL) {
                result = 0;
            }
        }
        zend_string_release(clause);
    }
    zend_string_release(needle);
    return result;
}

/* The descriptor of a table inside a read session (Catalog::describe): the columns in physical order, the primary key in
 * constraint order and the reliable row identity, as a CatalogTableMetadata object in out. */
static bool cat_describe(zval *db, const char *dialect, zval *pdo, zend_string *ns, zend_string *name, zval *out)
{
    bool sqlite = strcmp(dialect, "sqlite") == 0;
    bool ok = false;
    const char *kind = NULL;
    zval args, kind_names, kind_types, kind_rows, col_args, col_names, col_types, col_rows;
    cat_col *cols = NULL;
    cat_key *keys = NULL;
    size_t ncols = 0, nkeys = 0;
    ZVAL_UNDEF(&col_args);
    ZVAL_UNDEF(&col_rows);

    if (sqlite && strcmp(ZSTR_VAL(ns), "main") != 0) {
        db_throw_orm("TABLE_NAMESPACE_UNSUPPORTED", "SQLite requires main");
        return false;
    }
    array_init(&args);
    add_next_index_str(&args, zend_string_copy(ns));
    add_next_index_str(&args, zend_string_copy(name));
    if (!cat_query(db, pdo, cat_kind_sql(dialect), &args, 2, CAT_METADATA_BYTES, &kind_names, &kind_types, &kind_rows, NULL)) {
        zval_ptr_dtor(&args);
        return false;
    }
    zval_ptr_dtor(&kind_names);
    zval_ptr_dtor(&kind_types);
    if (zend_hash_num_elements(Z_ARRVAL(kind_rows)) == 0) {
        db_throw_orm("TABLE_NOT_FOUND", "%s.%s", ZSTR_VAL(ns), ZSTR_VAL(name));
        goto out_kind;
    }
    if (zend_hash_num_elements(Z_ARRVAL(kind_rows)) != 1) {
        db_throw_orm("TABLE_METADATA_INVALID", "ambiguous relation");
        goto out_kind;
    }
    zval *kind_row = zend_hash_index_find(Z_ARRVAL(kind_rows), 0);
    if (Z_TYPE_P(kind_row) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(kind_row)) != 1) {
        db_throw_orm("TABLE_METADATA_INVALID", "ambiguous relation");
        goto out_kind;
    }
    zend_string *native = cat_text(zend_hash_index_find(Z_ARRVAL_P(kind_row), 0));
    if (native == NULL || !cat_kind(dialect, ZSTR_VAL(native), &kind)) {
        goto out_kind;
    }
    zval_ptr_dtor(&kind_rows);
    zval_ptr_dtor(&args);

    /* SQLite table-valued pragmas take the table name first and the schema second. */
    array_init(&col_args);
    add_next_index_str(&col_args, zend_string_copy(sqlite ? name : ns));
    add_next_index_str(&col_args, zend_string_copy(sqlite ? ns : name));
    if (!cat_query(db, pdo, cat_columns_sql(dialect), &col_args, CAT_METADATA_ROWS, CAT_METADATA_BYTES, &col_names, &col_types, &col_rows, NULL)) {
        zval_ptr_dtor(&col_args);
        return false;
    }
    zval_ptr_dtor(&col_names);
    zval_ptr_dtor(&col_types);

    ncols = zend_hash_num_elements(Z_ARRVAL(col_rows));
    cols = ecalloc(ncols ? ncols : 1, sizeof(cat_col));
    for (size_t q = 0; q < (ncols ? ncols : 1); q++) cols[q].check_precision = -1;
    keys = ecalloc(ncols ? ncols : 1, sizeof(cat_key));
    size_t i = 0;
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(col_rows), row) {
        if (Z_TYPE_P(row) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(row)) != 8) {
            db_throw_orm("TABLE_METADATA_INVALID", "column shape of %d values", Z_TYPE_P(row) == IS_ARRAY ? (int)zend_hash_num_elements(Z_ARRVAL_P(row)) : 0);
            goto out_cols;
        }
        zval *c[8];
        for (int k = 0; k < 8; k++) c[k] = zend_hash_index_find(Z_ARRVAL_P(row), k);
        zend_string *cname = cat_text(c[0]);
        if (cname == NULL) goto out_cols;
        cat_check_name(cname);
        if (EG(exception)) goto out_cols;
        zend_string *ctype = cat_text(c[1]);
        if (ctype == NULL) goto out_cols;
        cat_col *col = &cols[i];
        if (!cat_bool(c[2], &col->nullable) || !cat_bool(c[3], &col->generated) || !cat_bool(c[5], &col->automatic)
            || !cat_bool(c[7], &col->expression)) goto out_cols;
        zend_long ordinal;
        if (!cat_int(c[4], &ordinal)) goto out_cols;
        if (Z_TYPE_P(c[6]) != IS_NULL && Z_TYPE_P(c[6]) != IS_STRING) {
            db_throw_orm("TABLE_METADATA_INVALID", "default expression of column \"%s\" is %s", ZSTR_VAL(cname), zend_zval_type_name(c[6]));
            goto out_cols;
        }
        for (size_t k = 0; k < i; k++) {
            if (zend_string_equals(cols[k].name, cname)) {
                db_throw_orm("TABLE_METADATA_INVALID", "duplicate column \"%s\"", ZSTR_VAL(cname));
                goto out_cols;
            }
        }
        if (ordinal < 0) {
            db_throw_orm("TABLE_METADATA_INVALID", "negative key ordinal");
            goto out_cols;
        }
        col->name = zend_string_copy(cname);
        col->type = zend_string_copy(ctype);
        col->def = Z_TYPE_P(c[6]) == IS_STRING ? zend_string_copy(Z_STR_P(c[6])) : NULL;
        if (ordinal > 0) {
            keys[nkeys].ordinal = ordinal;
            keys[nkeys].index = i;
            nkeys++;
        }
        i++;
    } ZEND_HASH_FOREACH_END();
    ncols = i;

    /* On SQLite the CHECK of a TIME or DATETIME column fixes its fraction digits (Catalog::describeTable). */
    if (sqlite && kind != NULL && strcmp(kind, "table") == 0) {
        zval sql_arg, sql_args, sql_names, sql_types, sql_rows;
        ZVAL_STR_COPY(&sql_arg, name);
        array_init(&sql_args);
        add_next_index_zval(&sql_args, &sql_arg);
        bool read_sql = cat_query(db, pdo, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", &sql_args, 1,
                                  CAT_METADATA_BYTES, &sql_names, &sql_types, &sql_rows, NULL);
        zval_ptr_dtor(&sql_args);
        if (!read_sql) goto out_cols;
        zval *table_row = zend_hash_index_find(Z_ARRVAL(sql_rows), 0);
        zval *table_sql = table_row != NULL && Z_TYPE_P(table_row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(table_row), 0) : NULL;
        if (table_sql != NULL && Z_TYPE_P(table_sql) == IS_STRING) {
            for (size_t k = 0; k < ncols; k++) {
                if (zend_string_equals_literal_ci(cols[k].type, "TIME") || zend_string_equals_literal_ci(cols[k].type, "DATETIME")) {
                    cols[k].check_precision = cat_check_precision(Z_STR_P(table_sql), cols[k].name);
                }
            }
        }
        zval_ptr_dtor(&sql_names);
        zval_ptr_dtor(&sql_types);
        zval_ptr_dtor(&sql_rows);
    }

    /* The key ordinals are 1..n in constraint order. */
    for (size_t a = 1; a < nkeys; a++) {
        cat_key k = keys[a];
        size_t b = a;
        while (b > 0 && keys[b - 1].ordinal > k.ordinal) {
            keys[b] = keys[b - 1];
            b--;
        }
        keys[b] = k;
    }
    for (size_t a = 0; a < nkeys; a++) {
        if (keys[a].ordinal != (zend_long)(a + 1)) {
            db_throw_orm("TABLE_METADATA_INVALID", "key order");
            goto out_cols;
        }
    }

    /* A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated by the database. */
    if (sqlite && strcmp(kind, "table") == 0 && nkeys == 1 && strcasecmp(ZSTR_VAL(cols[keys[0].index].type), "INTEGER") == 0) {
        zval index_args, index_names, index_types, index_rows;
        array_init(&index_args);
        add_next_index_str(&index_args, zend_string_copy(name));
        add_next_index_str(&index_args, zend_string_copy(ns));
        if (!cat_query(db, pdo, "SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'", &index_args, 1, CAT_METADATA_BYTES,
                       &index_names, &index_types, &index_rows, NULL)) {
            zval_ptr_dtor(&index_args);
            goto out_cols;
        }
        zval_ptr_dtor(&index_args);
        zval_ptr_dtor(&index_names);
        zval_ptr_dtor(&index_types);
        zval *index_row = zend_hash_index_find(Z_ARRVAL(index_rows), 0);
        zend_long count;
        if (zend_hash_num_elements(Z_ARRVAL(index_rows)) != 1 || Z_TYPE_P(index_row) != IS_ARRAY
            || zend_hash_num_elements(Z_ARRVAL_P(index_row)) != 1 || !cat_int(zend_hash_index_find(Z_ARRVAL_P(index_row), 0), &count)) {
            zval_ptr_dtor(&index_rows);
            db_throw_orm("TABLE_METADATA_INVALID", "primary index count");
            goto out_cols;
        }
        zval_ptr_dtor(&index_rows);
        if (count == 0) {
            cols[keys[0].index].nullable = false;
            cols[keys[0].index].automatic = true;
        }
    }

    bool reliable = (strcmp(kind, "table") == 0 || strcmp(kind, "partitioned") == 0) && nkeys > 0;
    zval table_ref, columns, primary_key;
    array_init(&table_ref);
    add_assoc_str(&table_ref, "namespace", zend_string_copy(ns));
    add_assoc_str(&table_ref, "name", zend_string_copy(name));
    array_init(&columns);
    array_init(&primary_key);
    for (size_t k = 0; k < ncols; k++) {
        cat_col *col = &cols[k];
        zval cargs[8], column;
        ZVAL_STR_COPY(&cargs[0], col->name);
        ZVAL_STR_COPY(&cargs[1], col->type);
        ZVAL_BOOL(&cargs[2], col->nullable);
        ZVAL_BOOL(&cargs[3], col->generated);
        ZVAL_BOOL(&cargs[4], col->automatic);
        if (col->def) ZVAL_STR_COPY(&cargs[5], col->def); else ZVAL_NULL(&cargs[5]);
        ZVAL_BOOL(&cargs[6], col->expression);
        if (col->check_precision >= 0) ZVAL_LONG(&cargs[7], col->check_precision); else ZVAL_NULL(&cargs[7]);
        bool made = newobj("Polyspec\\Orm\\CatalogColumn", &column, 8, cargs);
        for (int a = 0; a < 8; a++) zval_ptr_dtor(&cargs[a]);
        if (!made) {
            zval_ptr_dtor(&columns);
            zval_ptr_dtor(&primary_key);
            zval_ptr_dtor(&table_ref);
            goto out_cols;
        }
        add_next_index_zval(&columns, &column);
        if (!col->nullable) {
            /* key membership is decided below */
        } else {
            for (size_t a = 0; a < nkeys; a++) {
                if (keys[a].index == k) reliable = false;
            }
        }
    }
    for (size_t a = 0; a < nkeys; a++) {
        add_next_index_str(&primary_key, zend_string_copy(cols[keys[a].index].name));
    }
    zval margs[5];
    ZVAL_COPY_VALUE(&margs[0], &table_ref);
    ZVAL_STRING(&margs[1], kind);
    ZVAL_COPY_VALUE(&margs[2], &columns);
    ZVAL_COPY_VALUE(&margs[3], &primary_key);
    ZVAL_BOOL(&margs[4], reliable);
    ok = newobj("Polyspec\\Orm\\CatalogTableMetadata", out, 5, margs);
    zval_ptr_dtor(&margs[1]);
    zval_ptr_dtor(&table_ref);
    zval_ptr_dtor(&columns);
    zval_ptr_dtor(&primary_key);

out_cols:
    for (size_t k = 0; k < ncols; k++) cat_col_free(&cols[k]);
    efree(cols);
    efree(keys);
    zval_ptr_dtor(&col_rows);
    zval_ptr_dtor(&col_args);
    return ok;
out_kind:
    zval_ptr_dtor(&kind_rows);
    zval_ptr_dtor(&args);
    return false;
}

/* ---- read-only queries ---------------------------------------------------------------------------------------------------- */

static const char *cat_write_words[] = {
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "CALL",
    "DO", "INTO", "LOCK", "SHARE", "PROCEDURE", "LOAD", "COPY", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "ANALYZE", NULL
};

static bool cat_is_write_word(const char *w, size_t n)
{
    for (const char **x = cat_write_words; *x != NULL; x++) {
        if (strlen(*x) == n && strncmp(*x, w, n) == 0) return true;
    }
    return false;
}

static bool cat_letter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
static bool cat_digit(char c) { return c >= '0' && c <= '9'; }

/* The index after the literal or identifier that starts at start (Catalog::skipQuoted); -1 when it is not terminated. */
static ssize_t cat_skip_quoted(const char *q, size_t n, size_t start, char quote, bool backslash)
{
    for (size_t i = start + 1; i < n; i++) {
        if (backslash && q[i] == '\\') {
            i++;
        } else if (q[i] == quote) {
            if (i + 1 < n && q[i + 1] == quote) {
                i++;
                continue;
            }
            return (ssize_t)(i + 1);
        }
    }
    return -1;
}

/* Checks one read query (Catalog::validateReadOnly): one SELECT, WITH or VALUES statement with at most one trailing semicolon,
 * and no keyword of a write. Literals, quoted identifiers and comments are skipped; a MySQL executable comment is refused.
 * On refusal the QUERY_READ_ONLY error is thrown. */
static bool cat_validate_read_only(zend_string *sql, const char *dialect)
{
    const char *q = ZSTR_VAL(sql);
    size_t n = ZSTR_LEN(sql);
    bool mysql = strcmp(dialect, "mysql") == 0;
    size_t tokens = 0;
    bool semicolon = false;
    char first[8] = {0};
    size_t first_len = 0;
    if (n == 0 || n > CAT_SQL_BYTES) goto refuse;
    for (size_t i = 0; i < n;) {
        char c = q[i];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
            i++;
            continue;
        }
        if (c == '-' && i + 1 < n && q[i + 1] == '-') {
            const char *nl = memchr(q + i, '\n', n - i);
            if (nl == NULL) break;
            i = (size_t)(nl - q) + 1;
            continue;
        }
        if (c == '/' && i + 1 < n && q[i + 1] == '*') {
            if (i + 2 < n && (q[i + 2] == '!' || (q[i + 2] == 'M' && i + 3 < n && q[i + 3] == '!'))) goto refuse;
            size_t k = i + 2;
            while (k + 1 < n && !(q[k] == '*' && q[k + 1] == '/')) k++;
            if (k + 1 >= n) goto refuse;
            i = k + 2;
            continue;
        }
        if (c == '\'' || c == '"' || c == '`') {
            ssize_t next = cat_skip_quoted(q, n, i, c, mysql && c != '`');
            if (next < 0) goto refuse;
            i = (size_t)next;
            if (semicolon) goto refuse;
            tokens++;
            continue;
        }
        if (c == '_' || cat_letter(c)) {
            size_t j = i;
            while (j < n && (q[j] == '_' || q[j] == '$' || cat_letter(q[j]) || cat_digit(q[j]))) j++;
            if (semicolon) goto refuse;
            size_t len = j - i;
            char upper[64];
            if (len >= sizeof(upper)) {
                /* longer than any keyword of the list, so it is not one */
                len = sizeof(upper) - 1;
            }
            for (size_t k = 0; k < len; k++) upper[k] = (char)((q[i + k] >= 'a' && q[i + k] <= 'z') ? q[i + k] - 32 : q[i + k]);
            upper[len] = '\0';
            if (tokens == 0) {
                first_len = len < sizeof(first) ? len : sizeof(first);
                memcpy(first, upper, first_len);
            }
            if (cat_is_write_word(upper, len)) goto refuse;
            tokens++;
            i = j;
            continue;
        }
        if (cat_digit(c)) {
            size_t j = i;
            while (j < n && (q[j] == '.' || q[j] == '_' || cat_letter(q[j]) || cat_digit(q[j]))) j++;
            if (semicolon) goto refuse;
            tokens++;
            i = j;
            continue;
        }
        if (c == ';') {
            /* only one trailing semicolon: nothing may follow it */
            if (tokens == 0 || semicolon) goto refuse;
            semicolon = true;
            i++;
            continue;
        }
        i++;
    }
    if (tokens == 0) goto refuse;
    bool first_ok = (first_len == 6 && memcmp(first, "SELECT", 6) == 0) || (first_len == 4 && memcmp(first, "WITH", 4) == 0)
        || (first_len == 6 && memcmp(first, "VALUES", 6) == 0);
    if (!first_ok) goto refuse;
    return true;
refuse:
    db_throw_orm("QUERY_READ_ONLY", "expected one supported non-locking read query");
    return false;
}

/* A bound parameter: null, bool, int, text or a finite float (Catalog::param). */
static bool cat_param(zval *v)
{
    switch (Z_TYPE_P(v)) {
    case IS_NULL: case IS_TRUE: case IS_FALSE: case IS_LONG: case IS_STRING:
        return true;
    case IS_DOUBLE:
        if (!zend_finite(Z_DVAL_P(v))) {
            db_throw_orm("CATALOG_PARAM", "parameter is not finite");
            return false;
        }
        return true;
    default:
        db_throw_orm("CATALOG_PARAM", "parameter has unsupported type %s", zend_zval_type_name(v));
        return false;
    }
}

/* Converts the cells of a bounded result with the native type of each column (Catalog::convertRows). */
static bool cat_convert_rows(zval *rows, zval *types, const char *dialect, zval *out)
{
    array_init(out);
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        zval converted;
        array_init(&converted);
        zend_ulong i = 0;
        zval *cell;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), cell) {
            zval *t = zend_hash_index_find(Z_ARRVAL_P(types), i);
            zval v;
            if (t == NULL || Z_TYPE_P(t) != IS_STRING || !cat_cell_value(cell, Z_STR_P(t), dialect, &v)) {
                zval_ptr_dtor(&converted);
                zval_ptr_dtor(out);
                return false;
            }
            add_next_index_zval(&converted, &v);
            i++;
        } ZEND_HASH_FOREACH_END();
        add_next_index_zval(out, &converted);
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* ---- cell keys and revisions ----------------------------------------------------------------------------------------------- */

/* The canonical text of one cell: its type and its exact value (Catalog::cellKey). A float compares by its bits. */
static bool cat_cell_key(zval *cell, smart_str *out)
{
    switch (Z_TYPE_P(cell)) {
    case IS_NULL: smart_str_appendc(out, 'n'); return true;
    case IS_TRUE: smart_str_appends(out, "b1"); return true;
    case IS_FALSE: smart_str_appends(out, "b0"); return true;
    case IS_LONG: smart_str_appendc(out, 'i'); smart_str_append_long(out, Z_LVAL_P(cell)); return true;
    case IS_DOUBLE: {
        if (!zend_finite(Z_DVAL_P(cell))) {
            db_throw_orm("ROW_SNAPSHOT_INVALID", "non-finite float cell");
            return false;
        }
        uint64_t bits;
        double d = Z_DVAL_P(cell);
        memcpy(&bits, &d, sizeof bits);
        smart_str_appendc(out, 'f');
        smart_str_append_printf(out, "%016llx", (unsigned long long)bits);
        return true;
    }
    case IS_STRING:
        smart_str_appendc(out, 's');
        smart_str_append_long(out, (zend_long)Z_STRLEN_P(cell));
        smart_str_appendc(out, ':');
        smart_str_appendl(out, Z_STRVAL_P(cell), Z_STRLEN_P(cell));
        return true;
    default:
        db_throw_orm("ROW_SNAPSHOT_INVALID", "unsupported cell type %s", zend_zval_type_name(cell));
        return false;
    }
}

/* One checked row against its descriptor: one cell per column, no NULL in a non-null column, supported values (Catalog::checkCells). */
static bool cat_check_cells(zval *metadata, zval *cells)
{
    zval rv, *columns = catalog_prop(metadata, "columns", &rv);
    uint32_t ncols = zend_hash_num_elements(Z_ARRVAL_P(columns));
    if (zend_hash_num_elements(Z_ARRVAL_P(cells)) != ncols) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "row has %d cells for %d columns", (int)zend_hash_num_elements(Z_ARRVAL_P(cells)), (int)ncols);
        return false;
    }
    zend_ulong i = 0;
    zval *cell;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(cells), cell) {
        zval crv, *column = zend_hash_index_find(Z_ARRVAL_P(columns), i);
        zval *nullable = catalog_prop(column, "nullable", &crv);
        if (Z_TYPE_P(cell) == IS_NULL && Z_TYPE_P(nullable) != IS_TRUE) {
            zval nrv, *name = catalog_prop(column, "name", &nrv);
            db_throw_orm("ROW_SNAPSHOT_INVALID", "NULL in non-null column \"%s\"", Z_STRVAL_P(name));
            return false;
        }
        smart_str key = {0};
        bool ok = cat_cell_key(cell, &key);
        smart_str_free(&key);
        if (!ok) return false;
        i++;
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* The SHA-256 revision of a descriptor and a row (Catalog::revision): json_encode of the tag, the descriptor and the cell keys,
 * bounded by the snapshot budget, hashed with sha256. */
static bool cat_revision(zval *metadata, zval *cells, zval *out)
{
    zval keys;
    array_init(&keys);
    zval *cell;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(cells), cell) {
        smart_str key = {0};
        if (!cat_cell_key(cell, &key)) {
            smart_str_free(&key);
            zval_ptr_dtor(&keys);
            return false;
        }
        smart_str_0(&key);
        add_next_index_stringl(&keys, ZSTR_VAL(key.s), ZSTR_LEN(key.s));
        smart_str_free(&key);
    } ZEND_HASH_FOREACH_END();
    zval tuple;
    array_init(&tuple);
    add_next_index_string(&tuple, "orm-catalog-row-v1");
    Z_TRY_ADDREF_P(metadata);
    add_next_index_zval(&tuple, metadata);
    add_next_index_zval(&tuple, &keys);
    zval json_args[2], encoded;
    ZVAL_COPY_VALUE(&json_args[0], &tuple);
    ZVAL_LONG(&json_args[1], 4194304); /* JSON_THROW_ON_ERROR */
    bool ok = scall("json_encode", &encoded, 2, json_args);
    zval_ptr_dtor(&tuple);
    if (!ok) {
        return false;
    }
    if (Z_STRLEN(encoded) > CAT_SNAPSHOT_BYTES) {
        zval_ptr_dtor(&encoded);
        db_throw_orm("ROW_SNAPSHOT_LIMIT", "original row encoding exceeds its budget");
        return false;
    }
    zval hash_args[2], digest;
    ZVAL_STRING(&hash_args[0], "sha256");
    ZVAL_COPY_VALUE(&hash_args[1], &encoded);
    ok = scall("hash", &digest, 2, hash_args);
    zval_ptr_dtor(&hash_args[0]);
    zval_ptr_dtor(&encoded);
    if (ok) {
        ZVAL_COPY_VALUE(out, &digest);
    }
    return ok;
}

/* The primary-key column indexes of a descriptor (Catalog::descriptorKeys); a descriptor without a reliable identity is refused. */
static bool cat_descriptor_keys(zval *metadata, zval *out)
{
    zval rv_kind, rv_rel, rv_pk, rv_cols;
    zval *kind = catalog_prop(metadata, "kind", &rv_kind);
    zval *reliable = catalog_prop(metadata, "reliableRowIdentity", &rv_rel);
    zval *pk = catalog_prop(metadata, "primaryKey", &rv_pk);
    zval *columns = catalog_prop(metadata, "columns", &rv_cols);
    if (!(zend_string_equals_literal(Z_STR_P(kind), "table") || zend_string_equals_literal(Z_STR_P(kind), "partitioned"))) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: the relation is not a table");
        return false;
    }
    if (Z_TYPE_P(reliable) != IS_TRUE || zend_hash_num_elements(Z_ARRVAL_P(pk)) == 0 || zend_hash_num_elements(Z_ARRVAL_P(columns)) == 0
        || zend_hash_num_elements(Z_ARRVAL_P(columns)) > 2048) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: no reliable row identity");
        return false;
    }
    array_init(out);
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval crv, *name = catalog_prop(column, "name", &crv);
        if (!cat_name_ok(Z_STR_P(name))) {
            zval_ptr_dtor(out);
            cat_throw_descriptor_name();
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    zval *key;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), key) {
        zend_ulong idx = 0;
        bool found = false;
        zval *col;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), col) {
            zval crv, *name = catalog_prop(col, "name", &crv);
            if (zend_string_equals(Z_STR_P(name), Z_STR_P(key))) {
                zval nrv, *nullable = catalog_prop(col, "nullable", &nrv);
                if (Z_TYPE_P(nullable) == IS_TRUE) {
                    zval_ptr_dtor(out);
                    db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: key column is missing or nullable");
                    return false;
                }
                add_next_index_long(out, (zend_long)idx);
                found = true;
                break;
            }
            idx++;
        } ZEND_HASH_FOREACH_END();
        if (!found) {
            zval_ptr_dtor(out);
            db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: key column is missing or nullable");
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* The names of the columns of a descriptor, as an array of strings. */
static void cat_column_names(zval *metadata, zval *out)
{
    zval rv, *columns = catalog_prop(metadata, "columns", &rv);
    array_init(out);
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval nrv, *name = catalog_prop(column, "name", &nrv);
        add_next_index_str(out, zend_string_copy(Z_STR_P(name)));
    } ZEND_HASH_FOREACH_END();
}

/* The page of a table in primary-key order, read in an open read session (Catalog::tablePage). */
static bool cat_named_result(zval *names, zval *rows, zval *out);
static bool cat_described_rows(zval *rows, zval *metadata, const char *dialect);

static bool cat_table_page(zval *db, const char *dialect, zval *pdo, zend_string *ns, zend_string *name, zend_long limit, zend_long offset, zval *out)
{
    zval metadata;
    if (!cat_describe(db, dialect, pdo, ns, name, &metadata)) {
        return false;
    }
    zval rv_columns, rv_pk, *columns = catalog_prop(&metadata, "columns", &rv_columns), *pk = catalog_prop(&metadata, "primaryKey", &rv_pk);
    if (zend_hash_num_elements(Z_ARRVAL_P(columns)) == 0) {
        zval_ptr_dtor(&metadata);
        db_throw_orm("TABLE_PAGE_UNSUPPORTED", "relation has no selectable columns");
        return false;
    }
    smart_str sql = {0};
    smart_str_appends(&sql, "SELECT ");
    zval *column;
    bool first = true;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval nrv, *cname = catalog_prop(column, "name", &nrv);
        if (!first) smart_str_appendc(&sql, ',');
        first = false;
        cat_quote(&sql, Z_STR_P(cname), dialect);
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&sql, " FROM ");
    cat_quote(&sql, ns, dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, name, dialect);
    if (zend_hash_num_elements(Z_ARRVAL_P(pk)) > 0) {
        smart_str_appends(&sql, " ORDER BY ");
        first = true;
        zval *key;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), key) {
            if (!first) smart_str_appendc(&sql, ',');
            first = false;
            cat_quote(&sql, Z_STR_P(key), dialect);
        } ZEND_HASH_FOREACH_END();
    }
    smart_str_appends(&sql, " LIMIT ");
    smart_str_append_long(&sql, limit + 1);
    smart_str_appends(&sql, " OFFSET ");
    smart_str_append_long(&sql, offset);
    smart_str_0(&sql);

    zval args, names, types, rows;
    array_init(&args);
    bool ok = cat_query(db, pdo, ZSTR_VAL(sql.s), &args, limit + 1, CAT_PAGE_BYTES, &names, &types, &rows, NULL);
    zval_ptr_dtor(&args);
    smart_str_free(&sql);
    if (!ok) {
        zval_ptr_dtor(&metadata);
        return false;
    }
    zval_ptr_dtor(&types);
    zval expected;
    cat_column_names(&metadata, &expected);
    bool same_names = zend_compare(&names, &expected) == 0;
    zval_ptr_dtor(&expected);
    zval_ptr_dtor(&names);
    if (!same_names) {
        zval_ptr_dtor(&rows);
        zval_ptr_dtor(&metadata);
        db_throw_orm("TABLE_PAGE_METADATA_CHANGED", "prepared columns differ from descriptor");
        return false;
    }
    zval again;
    if (!cat_describe(db, dialect, pdo, ns, name, &again)) {
        zval_ptr_dtor(&rows);
        zval_ptr_dtor(&metadata);
        return false;
    }
    bool unchanged = zend_compare(&again, &metadata) == 0;
    zval_ptr_dtor(&again);
    if (!unchanged) {
        zval_ptr_dtor(&rows);
        zval_ptr_dtor(&metadata);
        db_throw_orm("TABLE_PAGE_METADATA_CHANGED", "descriptor changed during read");
        return false;
    }
    /* The native type of each column converts its cells. */
    zval native_types;
    array_init(&native_types);
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval nrv, *native = catalog_prop(column, "nativeType", &nrv);
        add_next_index_str(&native_types, zend_string_copy(Z_STR_P(native)));
    } ZEND_HASH_FOREACH_END();
    /* The sentinel row is cut before conversion, so a value past the page is never read. */
    bool has_more = zend_hash_num_elements(Z_ARRVAL(rows)) > (uint32_t)limit;
    zval kept;
    array_init(&kept);
    zend_ulong taken = 0;
    zval *raw_row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), raw_row) {
        if (taken == (zend_ulong)limit) break;
        Z_TRY_ADDREF_P(raw_row);
        add_next_index_zval(&kept, raw_row);
        taken++;
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&rows);
    zval converted;
    ok = cat_convert_rows(&kept, &native_types, dialect, &converted) && cat_described_rows(&converted, &metadata, dialect);
    zval_ptr_dtor(&native_types);
    zval_ptr_dtor(&kept);
    if (!ok) {
        zval_ptr_dtor(&metadata);
        return false;
    }
    zval page_rows;
    array_init(&page_rows);
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(converted), row) {
        Z_TRY_ADDREF_P(row);
        add_next_index_zval(&page_rows, row);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&converted);
    zval column_names;
    cat_column_names(&metadata, &column_names);
    zval result;
    ok = cat_named_result(&column_names, &page_rows, &result);
    zval_ptr_dtor(&column_names);
    zval_ptr_dtor(&page_rows);
    if (!ok) {
        zval_ptr_dtor(&metadata);
        return false;
    }
    zval page_args[6];
    ZVAL_COPY_VALUE(&page_args[0], &metadata);
    ZVAL_COPY_VALUE(&page_args[1], &result);
    ZVAL_LONG(&page_args[2], limit);
    ZVAL_LONG(&page_args[3], offset);
    ZVAL_COPY(&page_args[4], pk);
    ZVAL_BOOL(&page_args[5], has_more);
    ok = newobj("Polyspec\\Orm\\CatalogTablePage", out, 6, page_args);
    zval_ptr_dtor(&page_args[4]);
    zval_ptr_dtor(&result);
    zval_ptr_dtor(&metadata);
    return ok;
}

/* ---- grid cells (SCH-6a) ---------------------------------------------------------------------------------------------------- */

static void cat_refuse(const char *message)
{
    db_throw_orm("CATALOG_VALUE", "unsupported grid value: %s", message);
}

/* A date or time that the grid cannot state (GRID_TEMPORAL_VALUE, as Catalog::dateText and its siblings state). */
static void cat_refuse_temporal(const char *message)
{
    db_throw_orm("GRID_TEMPORAL_VALUE", "unsupported grid value: %s", message);
}

/* A date of the dbspec form YYYY-MM-DD from 0001-01-01 to 9999-12-31 (Catalog::dateText). */
static bool cat_date_text(const char *s, size_t n, zval *out)
{
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (n != 10 || s[4] != '-' || s[7] != '-') {
        cat_refuse_temporal("date is not YYYY-MM-DD");
        return false;
    }
    int y = 0, m = 0, d = 0;
    for (int i = 0; i < 10; i++) {
        if (i == 4 || i == 7) continue;
        if (!cat_digit(s[i])) {
            cat_refuse_temporal("date is not YYYY-MM-DD");
            return false;
        }
    }
    y = (s[0] - '0') * 1000 + (s[1] - '0') * 100 + (s[2] - '0') * 10 + (s[3] - '0');
    m = (s[5] - '0') * 10 + (s[6] - '0');
    d = (s[8] - '0') * 10 + (s[9] - '0');
    bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    int last = (m == 2 && leap) ? 29 : (m >= 1 && m <= 12 ? days[m - 1] : 0);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > last) {
        cat_refuse_temporal("date outside 0001-01-01 to 9999-12-31");
        return false;
    }
    ZVAL_STRINGL(out, s, n);
    return true;
}

/* A time of the dbspec form HH:MM:SS.ffffff from 00:00:00 to 23:59:59.999999 (Catalog::timeText). */
static bool cat_time_text(const char *s, size_t n, zval *out)
{
    size_t i = 0;
    size_t hd = 0;
    while (i < n && cat_digit(s[i]) && hd < 3) { i++; hd++; }
    if (hd < 2 || i >= n || s[i] != ':' || i + 6 > n || !cat_digit(s[i + 1]) || !cat_digit(s[i + 2]) || s[i + 3] != ':'
        || !cat_digit(s[i + 4]) || !cat_digit(s[i + 5])) {
        cat_refuse_temporal("time is not a time of day");
        return false;
    }
    int h = 0;
    for (size_t k = 0; k < hd; k++) h = h * 10 + (s[k] - '0');
    int mi = (s[i + 1] - '0') * 10 + (s[i + 2] - '0');
    int se = (s[i + 4] - '0') * 10 + (s[i + 5] - '0');
    size_t p = i + 6;
    char frac[7] = "000000";
    if (p < n) {
        if (s[p] != '.') {
            cat_refuse_temporal("time is not a time of day");
            return false;
        }
        p++;
        size_t fd = 0;
        while (p < n && cat_digit(s[p]) && fd < 6) { frac[fd++] = s[p++]; }
        if (fd == 0 || p != n) {
            cat_refuse_temporal("time is not a time of day");
            return false;
        }
    }
    if (h > 23 || mi > 59 || se > 59) {
        cat_refuse_temporal("time outside 00:00:00 to 23:59:59.999999");
        return false;
    }
    zend_string *text = zend_strpprintf(0, "%02d:%02d:%02d.%s", h, mi, se, frac);
    ZVAL_STR(out, text);
    return true;
}

/* A datetime of the dbspec form YYYY-MM-DD HH:MM:SS.ffffff (Catalog::dateTimeText). */
static bool cat_datetime_text(const char *s, size_t n, zval *out)
{
    const char *sp = memchr(s, ' ', n);
    if (sp == NULL) {
        cat_refuse_temporal("datetime has no date and time");
        return false;
    }
    zval date, time;
    if (!cat_date_text(s, (size_t)(sp - s), &date)) return false;
    if (!cat_time_text(sp + 1, n - (size_t)(sp - s) - 1, &time)) {
        zval_ptr_dtor(&date);
        return false;
    }
    zend_string *text = zend_strpprintf(0, "%s %s", Z_STRVAL(date), Z_STRVAL(time));
    zval_ptr_dtor(&date);
    zval_ptr_dtor(&time);
    ZVAL_STR(out, text);
    return true;
}

/* ---- described temporal cells (INT-103, INT-117) ---------------------------------------------------------------------------- */

/*
 * The temporal kind of a native type of a described MySQL or PostgreSQL column (Catalog::temporalKind): 'd' for a date,
 * 't' for a time and 'x' for a datetime, by the first word of the type; 0 for every other type and every SQLite type.
 */
static char cat_temporal_kind(const char *dialect, const char *type)
{
    if (strcmp(dialect, "sqlite") == 0) return 0;
    size_t n = strcspn(type, "( ");
    if (zend_binary_strncasecmp(type, n, "DATE", 4, 4) == 0 && n == 4) return 'd';
    if (zend_binary_strncasecmp(type, n, "TIME", 4, 4) == 0 && n == 4) return 't';
    if (strcmp(dialect, "mysql") == 0 && n == 8 && zend_binary_strncasecmp(type, n, "DATETIME", 8, 8) == 0) return 'x';
    if (strcmp(dialect, "postgres") == 0 && n == 9 && zend_binary_strncasecmp(type, n, "TIMESTAMP", 9, 9) == 0) return 'x';
    return 0;
}

/* A MySQL TIMESTAMP or a PostgreSQL timestamptz or timetz column (Catalog::isZonedColumn): the time zone it follows is one
 * that dbspec declares for no column (INT-103). */
static bool cat_zoned_column(const char *dialect, const char *type)
{
    size_t n = strcspn(type, "( ");
    bool stamp = n == 9 && zend_binary_strncasecmp(type, n, "TIMESTAMP", 9, 9) == 0;
    bool clock = n == 4 && zend_binary_strncasecmp(type, n, "TIME", 4, 4) == 0;
    const char *rest = type + n;
    if (*rest == '(') {
        if (rest[1] < '0' || rest[1] > '6' || rest[2] != ')') return false;
        rest += 3;
    }
    if (strcmp(dialect, "mysql") == 0) return stamp && *rest == '\0';
    return strcmp(dialect, "postgres") == 0 && (stamp || clock) && strcasecmp(rest, " with time zone") == 0;
}

/*
 * The fraction digits of a described temporal column (Catalog::declaredPrecision): the digits of the first "(n)" of its
 * native type, and otherwise the default of the database, 0 on MySQL and 6 on PostgreSQL.
 */
static zend_long cat_declared_precision(const char *dialect, const char *type)
{
    for (const char *open = strchr(type, '('); open != NULL; open = strchr(open + 1, '(')) {
        const char *p = open + 1;
        zend_long digits = 0;
        while (cat_digit(*p) && digits < 1000000) digits = digits * 10 + (*p++ - '0');
        if (p > open + 1 && *p == ')') return digits;
    }
    return strcmp(dialect, "postgres") == 0 ? 6 : 0;
}

/*
 * A temporal value of a described column in its declared precision p (Catalog::describedTemporal): exactly p fraction
 * digits, which drops the fraction when p is 0. A non-zero digit beyond p fails with GRID_TEMPORAL_PRECISION.
 */
static bool cat_described_temporal(zval *value, char kind, zend_long precision, zval *out)
{
    const char *s = Z_STRVAL_P(value);
    size_t n = Z_STRLEN_P(value);
    if (kind == 'd') return cat_date_text(s, n, out);
    zval text;
    if (!(kind == 't' ? cat_time_text(s, n, &text) : cat_datetime_text(s, n, &text))) return false;
    const char *t = Z_STRVAL(text);
    size_t length = Z_STRLEN(text);
    size_t dot = (size_t)((const char *)zend_memrchr(t, '.', length) - t);
    size_t end = (size_t)precision > length - dot - 1 ? length : dot + 1 + (size_t)precision;
    for (size_t i = end; i < length; i++) {
        if (t[i] != '0') {
            db_throw_orm("GRID_TEMPORAL_PRECISION", "temporal value \"%s\" has more fraction digits than its precision " ZEND_LONG_FMT,
                         s, precision);
            zval_ptr_dtor(&text);
            return false;
        }
    }
    ZVAL_STRINGL(out, t, precision == 0 ? dot : end);
    zval_ptr_dtor(&text);
    return true;
}

/*
 * Converts the converted rows of a read of a described table in place (Catalog::describedRows): a MySQL or PostgreSQL
 * date, time or timestamp cell becomes its dbspec text with exactly the fraction digits of its column. On failure the
 * rows are released, as cat_convert_rows releases its output.
 */
/* A boolean column by its native type: tinyint(1) on MySQL, boolean on PostgreSQL and SQLite (DIA-29). */
static bool cat_is_bool_column(const char *dialect, const char *native)
{
    const char *want = strcmp(dialect, "mysql") == 0 ? "tinyint(1)" : "boolean";
    return strcasecmp(native, want) == 0;
}

/* A value of a boolean column as a bool: an integer 0 or 1 becomes false or true, null and bools stay; any other value fails. */
static bool cat_described_bool(zval *cell, zval *out)
{
    if (Z_TYPE_P(cell) == IS_NULL || Z_TYPE_P(cell) == IS_TRUE || Z_TYPE_P(cell) == IS_FALSE) {
        ZVAL_COPY(out, cell);
        return true;
    }
    if (Z_TYPE_P(cell) == IS_LONG && (Z_LVAL_P(cell) == 0 || Z_LVAL_P(cell) == 1)) {
        ZVAL_BOOL(out, Z_LVAL_P(cell) == 1);
        return true;
    }
    db_throw_orm("CATALOG_VALUE", "a boolean column holds a value that is not a boolean");
    return false;
}

static bool cat_described_rows(zval *rows, zval *metadata, const char *dialect)
{
    zval rv_cols, *columns = catalog_prop(metadata, "columns", &rv_cols);
    zval described;
    array_init(&described);
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        zval out_row;
        array_init(&out_row);
        zend_ulong i = 0;
        zval *cell;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), cell) {
            zval *column = zend_hash_index_find(Z_ARRVAL_P(columns), i++);
            zval trv, *native = column == NULL ? NULL : catalog_prop(column, "nativeType", &trv);
            if (native != NULL && Z_TYPE_P(native) == IS_STRING && Z_TYPE_P(cell) != IS_NULL && cat_zoned_column(dialect, Z_STRVAL_P(native))) {
                cat_refuse("a column of this type follows a time zone");
                zval_ptr_dtor(&out_row);
                zval_ptr_dtor(&described);
                zval_ptr_dtor(rows);
                return false;
            }
            char kind = native != NULL && Z_TYPE_P(native) == IS_STRING && Z_TYPE_P(cell) == IS_STRING
                ? cat_temporal_kind(dialect, Z_STRVAL_P(native)) : 0;
            zend_long precision = kind != 0 ? cat_declared_precision(dialect, Z_STRVAL_P(native)) : 0;
            if (kind == 0 && native != NULL && Z_TYPE_P(native) == IS_STRING && Z_TYPE_P(cell) == IS_STRING && strcmp(dialect, "sqlite") == 0
                && (zend_string_equals_literal_ci(Z_STR_P(native), "TIME") || zend_string_equals_literal_ci(Z_STR_P(native), "DATETIME"))) {
                kind = zend_string_equals_literal_ci(Z_STR_P(native), "TIME") ? 't' : 'x';
                zval prv, *cp = catalog_prop(column, "checkPrecision", &prv);
                precision = Z_TYPE_P(cp) == IS_LONG ? Z_LVAL_P(cp) : 0;
            }
            zval v;
            if (native != NULL && Z_TYPE_P(native) == IS_STRING && cat_is_bool_column(dialect, Z_STRVAL_P(native))) {
                /* A boolean column is read as a bool by its column type (DIA-29). */
                if (!cat_described_bool(cell, &v)) {
                    zval_ptr_dtor(&out_row);
                    zval_ptr_dtor(&described);
                    zval_ptr_dtor(rows);
                    return false;
                }
            } else if (kind == 0) {
                ZVAL_COPY(&v, cell);
            } else if (!cat_described_temporal(cell, kind, precision, &v)) {
                zval_ptr_dtor(&out_row);
                zval_ptr_dtor(&described);
                zval_ptr_dtor(rows);
                return false;
            }
            add_next_index_zval(&out_row, &v);
        } ZEND_HASH_FOREACH_END();
        add_next_index_zval(&described, &out_row);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(rows);
    ZVAL_COPY_VALUE(rows, &described);
    return true;
}

/* A text value of a cell, which the grid takes as a string (Catalog::gridText). */
static bool cat_grid_text(zval *v, zval *out)
{
    if (Z_TYPE_P(v) != IS_STRING) {
        cat_refuse("expected text");
        return false;
    }
    ZVAL_COPY(out, v);
    return true;
}

/* A float cell: the IEEE-754 bits of the value as hexadecimal, 8 digits for float32, 16 for float64. */
static bool cat_float_cell(zval *v, bool single, zval *kind_out, zval *value_out)
{
    double d;
    if (Z_TYPE_P(v) == IS_DOUBLE) d = Z_DVAL_P(v);
    else if (Z_TYPE_P(v) == IS_LONG) d = (double)Z_LVAL_P(v);
    else if (Z_TYPE_P(v) == IS_STRING && zend_string_equals_literal_ci(Z_STR_P(v), "NaN")) {
        d = NAN;
    }
    else if (Z_TYPE_P(v) == IS_STRING && is_numeric_string(Z_STRVAL_P(v), Z_STRLEN_P(v), NULL, NULL, 0)) d = zend_strtod(Z_STRVAL_P(v), NULL);
    else {
        cat_refuse("expected a number");
        return false;
    }
    if (single) {
        float f = (float)d;
        uint32_t bits;
        memcpy(&bits, &f, sizeof bits);
        ZVAL_STRING(kind_out, "float32");
        ZVAL_NEW_STR(value_out, zend_strpprintf(0, "%08x", bits));
    } else {
        uint64_t bits;
        memcpy(&bits, &d, sizeof bits);
        ZVAL_STRING(kind_out, "float64");
        ZVAL_NEW_STR(value_out, zend_strpprintf(0, "%016llx", (unsigned long long)bits));
    }
    return true;
}

/* An integer cell: a PHP integer, or text that holds one. An UNSIGNED column is decimal digits, exact over the whole range. */
static bool cat_integer_cell(zval *v, bool unsigned_, zval *kind_out, zval *value_out)
{
    if (Z_TYPE_P(v) == IS_LONG) {
        if (unsigned_) {
            ZVAL_STRING(kind_out, "unsigned");
            ZVAL_NEW_STR(value_out, zend_strpprintf(0, "%llu", (unsigned long long)(uint64_t)Z_LVAL_P(v)));
        } else {
            ZVAL_STRING(kind_out, "integer");
            ZVAL_LONG(value_out, Z_LVAL_P(v));
        }
        return true;
    }
    if (Z_TYPE_P(v) != IS_STRING) {
        cat_refuse("expected an integer");
        return false;
    }
    const char *p = Z_STRVAL_P(v);
    size_t n = Z_STRLEN_P(v);
    if (unsigned_) {
        for (size_t i = 0; i < n; i++) {
            if (!cat_digit(p[i])) {
                cat_refuse("unsigned integer text is not digits");
                return false;
            }
        }
        if (n == 0) {
            cat_refuse("unsigned integer text is empty");
            return false;
        }
        ZVAL_STRINGL(kind_out, "unsigned", 8);
        ZVAL_STRINGL(value_out, p, n);
        return true;
    }
    zend_long n64 = 0;
    if (n == 0 || is_numeric_string(p, n, &n64, NULL, 0) != IS_LONG) {
        /* Digits beyond the signed range are an unsigned value, whatever the column reports. */
        bool digits = n > 0;
        for (size_t i = 0; digits && i < n; i++) digits = cat_digit(p[i]);
        if (digits) {
            ZVAL_STRINGL(kind_out, "unsigned", 8);
            ZVAL_STRINGL(value_out, p, n);
            return true;
        }
        cat_refuse("integer text is outside the signed 64-bit range");
        return false;
    }
    ZVAL_STRING(kind_out, "integer");
    ZVAL_LONG(value_out, n64);
    return true;
}

/* A grid cell: the cell kind and its value, which the caller builds into a CatalogGridCell. Binary values are bytes; a text value
 * must be UTF-8. */
static bool cat_bytes_or_text(zval *v, bool binary, zval *kind_out, zval *value_out)
{
    if (Z_TYPE_P(v) != IS_STRING) {
        cat_refuse("expected text or binary data");
        return false;
    }
    if (binary) {
        ZVAL_STRING(kind_out, "binary");
    } else {
        ZVAL_STRING(kind_out, "text");
        if (!cat_utf8_valid(Z_STRVAL_P(v), Z_STRLEN_P(v))) {
            cat_refuse("text is not valid UTF-8");
            return false;
        }
    }
    ZVAL_COPY(value_out, v);
    return true;
}

/* Calls a method with any number of arguments (mysqli's bind_param takes its types and values as separate arguments). */
static bool cat_call_n(zval *obj, const char *name, zval *ret, uint32_t argc, zval *argv)
{
    zval callable;
    array_init(&callable);
    Z_TRY_ADDREF_P(obj);
    add_next_index_zval(&callable, obj);
    add_next_index_string(&callable, name);
    bool ok = call_user_function(NULL, NULL, &callable, ret, argc, argv) == SUCCESS && EG(exception) == NULL;
    zval_ptr_dtor(&callable);
    if (!ok && Z_TYPE_P(ret) != IS_UNDEF) {
        ZVAL_UNDEF(ret);
    }
    return ok;
}

/* The PHP-level read of a bytea stream, or a binary string: its bytes. */
static bool cat_bytes_value(zval *v, zval *out)
{
    if (Z_TYPE_P(v) == IS_STRING) {
        ZVAL_COPY(out, v);
        return true;
    }
    if (Z_TYPE_P(v) != IS_RESOURCE) {
        cat_refuse("expected binary data");
        return false;
    }
    zval stream = *v, data, close_ret;
    Z_TRY_ADDREF(stream);
    zval args[1];
    ZVAL_COPY_VALUE(&args[0], &stream);
    bool ok = scall("stream_get_contents", &data, 1, args);
    zval fclose_args[1];
    ZVAL_COPY_VALUE(&fclose_args[0], &stream);
    scall("fclose", &close_ret, 1, fclose_args);
    zval_ptr_dtor(&stream);
    if (!ok || Z_TYPE(data) != IS_STRING) {
        zval_ptr_dtor(&data);
        cat_refuse("binary stream could not be read");
        return false;
    }
    ZVAL_COPY_VALUE(out, &data);
    return true;
}

/* Creates a CatalogResult with one consistent array ownership path for every result producer. */
static bool cat_named_result(zval *names, zval *rows, zval *out)
{
    zval args[2];
    ZVAL_COPY(&args[0], names);
    ZVAL_COPY(&args[1], rows);
    bool ok = newobj("Polyspec\\Orm\\CatalogResult", out, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    return ok;
}

/* Transfers a typed Catalog grid value into the public cell DTO using one ownership path for every driver. */
static bool cat_grid_cell_object(zval *kind, zval *value, zval *cell)
{
    zval args[2];
    ZVAL_COPY_VALUE(&args[0], kind);
    ZVAL_COPY_VALUE(&args[1], value);
    bool made = newobj("Polyspec\\Orm\\CatalogGridCell", cell, 2, args);
    zval_ptr_dtor(kind);
    zval_ptr_dtor(value);
    return made;
}

/* The grid cell of a NULL value. */
static bool cat_grid_null_cell(zval *cell)
{
    zval kind, value;
    ZVAL_STRING(&kind, "null");
    ZVAL_NULL(&value);
    return cat_grid_cell_object(&kind, &value, cell);
}

/* A PDO grid cell: typed by the native type of its PostgreSQL column, or by the value that SQLite holds for it (cat_grid_pdo). */
static bool cat_grid_pdo_cell(zval *v, const char *dialect, const char *native, bool blob, zval *cell)
{
    if (Z_TYPE_P(v) == IS_NULL) {
        return cat_grid_null_cell(cell);
    }
    zval kind, value;
    bool ok;
    ZVAL_NULL(&kind);
    ZVAL_NULL(&value);
    if (strcmp(dialect, "postgres") == 0 && strcmp(native, "FLOAT4") == 0) {
        ok = cat_float_cell(v, true, &kind, &value);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "FLOAT8") == 0) {
        ok = cat_float_cell(v, false, &kind, &value);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "NUMERIC") == 0) {
        ZVAL_STRING(&kind, "decimal");
        ok = cat_grid_text(v, &value);
        /* PostgreSQL writes NaN and the infinities of numeric as text. */
        if (ok && (strcmp(Z_STRVAL(value), "NaN") == 0 || strstr(Z_STRVAL(value), "Infinity") != NULL)) {
            cat_refuse("PostgreSQL numeric is not finite");
            ok = false;
        }
    } else if (strcmp(dialect, "postgres") == 0 && (strcmp(native, "TIMESTAMPTZ") == 0 || strcmp(native, "TIMETZ") == 0)) {
        cat_refuse("PostgreSQL timestamptz and timetz are unsupported");
        ok = false;
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "DATE") == 0) {
        ZVAL_STRING(&kind, "date");
        zval text;
        ok = cat_grid_text(v, &text) && cat_date_text(Z_STRVAL(text), Z_STRLEN(text), &value);
        zval_ptr_dtor(&text);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "TIME") == 0) {
        ZVAL_STRING(&kind, "time");
        zval text;
        ok = cat_grid_text(v, &text) && cat_time_text(Z_STRVAL(text), Z_STRLEN(text), &value);
        zval_ptr_dtor(&text);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "TIMESTAMP") == 0) {
        ZVAL_STRING(&kind, "datetime");
        zval text;
        ok = cat_grid_text(v, &text) && cat_datetime_text(Z_STRVAL(text), Z_STRLEN(text), &value);
        zval_ptr_dtor(&text);
    } else if (strcmp(dialect, "postgres") == 0 && (strcmp(native, "INT2") == 0 || strcmp(native, "INT4") == 0 || strcmp(native, "INT8") == 0)) {
        ok = cat_integer_cell(v, false, &kind, &value);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "BYTEA") == 0) {
        ZVAL_STRING(&kind, "binary");
        ok = cat_bytes_value(v, &value);
    } else if (Z_TYPE_P(v) == IS_TRUE || Z_TYPE_P(v) == IS_FALSE) {
        ZVAL_STRING(&kind, "boolean");
        ZVAL_COPY(&value, v);
        ok = true;
    } else if (Z_TYPE_P(v) == IS_LONG) {
        ok = cat_integer_cell(v, false, &kind, &value);
    } else if (Z_TYPE_P(v) == IS_DOUBLE) {
        ok = cat_float_cell(v, false, &kind, &value);
    } else if (Z_TYPE_P(v) == IS_STRING) {
        ok = cat_bytes_or_text(v, blob, &kind, &value);
    } else {
        cat_refuse("unsupported driver value");
        ok = false;
    }
    if (!ok) {
        zval_ptr_dtor(&kind);
        return false;
    }
    return cat_grid_cell_object(&kind, &value, cell);
}

/* The type number of the upper-cased name that pdo_mysql reports for a column, or -1 for a string type. */
static zend_long cat_mysql_type(const char *native)
{
    static const struct { const char *name; zend_long type; } types[] = {
        {"DECIMAL", 0}, {"TINY", 1}, {"SHORT", 2}, {"LONG", 3}, {"FLOAT", 4}, {"DOUBLE", 5}, {"TIMESTAMP", 7}, {"LONGLONG", 8},
        {"INT24", 9}, {"DATE", 10}, {"TIME", 11}, {"DATETIME", 12}, {"YEAR", 13}, {"NEWDECIMAL", 246},
    };
    for (size_t i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
        if (strcmp(native, types[i].name) == 0) return types[i].type;
    }
    return -1;
}

/* A MySQL grid cell from the type of its column, its UNSIGNED flag and its binary charset. */
static bool cat_grid_mysql_cell(zval *v, zend_long type, bool unsigned_, bool binary, zval *cell)
{
    if (Z_TYPE_P(v) == IS_NULL) {
        return cat_grid_null_cell(cell);
    }
    zval kind, value;
    bool ok;
    ZVAL_NULL(&kind);
    ZVAL_NULL(&value);
    if (type == 4) { /* FLOAT */
        ok = cat_float_cell(v, true, &kind, &value);
    } else if (type == 5) { /* DOUBLE */
        ok = cat_float_cell(v, false, &kind, &value);
    } else if (type == 7) { /* TIMESTAMP */
        cat_refuse("MySQL TIMESTAMP follows a time zone");
        ok = false;
    } else if (type == 10 || type == 11 || type == 12) { /* DATE, TIME, DATETIME */
        zval text;
        ok = cat_grid_text(v, &text);
        if (ok) {
            ok = type == 10 ? cat_date_text(Z_STRVAL(text), Z_STRLEN(text), &value)
                : type == 11 ? cat_time_text(Z_STRVAL(text), Z_STRLEN(text), &value)
                : cat_datetime_text(Z_STRVAL(text), Z_STRLEN(text), &value);
            ZVAL_STRING(&kind, type == 10 ? "date" : type == 11 ? "time" : "datetime");
        }
        zval_ptr_dtor(&text);
    } else if (type == 0 || type == 246) { /* DECIMAL, NEWDECIMAL */
        ZVAL_STRING(&kind, "decimal");
        ok = cat_grid_text(v, &value);
    } else if (type == 13) { /* YEAR: an integer-valued MySQL type with no grid cell (INT-103) */
        cat_refuse("MySQL YEAR has no grid cell");
        ok = false;
    } else if (type == 1 || type == 2 || type == 3 || type == 8 || type == 9) { /* TINY SHORT LONG LONGLONG INT24 */
        ok = cat_integer_cell(v, unsigned_, &kind, &value);
    } else {
        /* The bytes of a column whose charset the server did not report are its binary value (INT-157). */
        ok = cat_bytes_or_text(v, binary || (Z_TYPE_P(v) == IS_STRING && !cat_utf8_valid(Z_STRVAL_P(v), Z_STRLEN_P(v))), &kind, &value);
    }
    if (!ok) {
        zval_ptr_dtor(&kind);
        return false;
    }
    return cat_grid_cell_object(&kind, &value, cell);
}


/* The bytes that the cells of one row count against a result budget (INT-115): the bytes of a text, decimal, date, time,
 * datetime or binary grid cell and of a string value, and 8 for every other cell, null included. */
static zend_long cat_cells_size(zval *cells)
{
    zend_long size = 0;
    zval *cell;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(cells), cell) {
        if (Z_TYPE_P(cell) != IS_OBJECT) {
            size += Z_TYPE_P(cell) == IS_STRING ? (zend_long)Z_STRLEN_P(cell) : 8;
            continue;
        }
        zval rk, rv;
        zval *kind = catalog_prop(cell, "kind", &rk);
        zval *value = catalog_prop(cell, "value", &rv);
        bool textual = Z_TYPE_P(kind) == IS_STRING && Z_TYPE_P(value) == IS_STRING
            && (zend_string_equals_literal(Z_STR_P(kind), "text") || zend_string_equals_literal(Z_STR_P(kind), "decimal")
                || zend_string_equals_literal(Z_STR_P(kind), "date") || zend_string_equals_literal(Z_STR_P(kind), "time")
                || zend_string_equals_literal(Z_STR_P(kind), "datetime") || zend_string_equals_literal(Z_STR_P(kind), "binary"));
        size += textual ? (zend_long)Z_STRLEN_P(value) : 8;
    } ZEND_HASH_FOREACH_END();
    return size;
}

/* The row budget of every Catalog grid driver, checked before a row is converted; a row past it is released. */
static bool cat_grid_row_limit(zval *rows, zval *row, zend_long max_rows)
{
    if (zend_hash_num_elements(Z_ARRVAL_P(rows)) == (uint32_t)max_rows) {
        zval_ptr_dtor(row);
        db_throw_orm("CATALOG_LIMIT", "result has more than %ld rows", (long)max_rows);
        return false;
    }
    return true;
}

/* The byte budget of every Catalog grid driver, counted on the converted cells of a row (INT-115); cells past it are
 * released. */
static bool cat_grid_cells_budget(zval *cells, zend_long max_bytes, zend_long *budget)
{
    *budget += cat_cells_size(cells);
    if (*budget > max_bytes) {
        zval_ptr_dtor(cells);
        db_throw_orm("CATALOG_LIMIT", "result has more than %ld bytes of values", (long)max_bytes);
        return false;
    }
    return true;
}

/* The grid cells of one PostgreSQL row, by the native type of each column, as the buffered read converts them. */
static bool cat_grid_postgres_row(zval *row, zval *types, const char *dialect, zval *cells)
{
    array_init(cells);
    zend_ulong i = 0;
    zval *value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), value) {
        zval *native = zend_hash_index_find(Z_ARRVAL_P(types), i);
        zval cell;
        if (!cat_grid_pdo_cell(value, dialect, Z_STRVAL_P(native), false, &cell)) {
            zval_ptr_dtor(cells);
            return false;
        }
        add_next_index_zval(cells, &cell);
        i++;
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* The PDO grid query of PostgreSQL and SQLite: one bounded statement, each cell typed by its column or by its value. */
/* A PostgreSQL grid read without parameters: the cursor converts each row into its cells as it reads it, within the budget. */
static bool cat_grid_pdo_cursor(zval *db, zval *pdo, zval *sql, zend_long max_rows, zend_long max_bytes, zval *names, zval *rows)
{
    zval types;
    array_init(&types);
    zval_ptr_dtor(rows);
    array_init(rows);
    if (!cat_cursor_query(db, pdo, Z_STRVAL_P(sql), max_rows, max_bytes, names, &types, rows, cat_grid_postgres_row)) {
        return false;
    }
    zval_ptr_dtor(&types);
    return true;
}

static bool cat_grid_mysql(zval *db, zval *pdo, zval *sql, zval *args, zend_long max_rows, zend_long max_bytes, zval *names, zval *rows);

static bool cat_grid_pdo(zval *db, const char *dialect, zval *pdo, zval *sql, zval *args, zend_long max_rows, zend_long max_bytes,
                         zval *names, zval *rows)
{
    array_init(names);
    array_init(rows);
    if (strcmp(dialect, "mysql") == 0) {
        return cat_grid_mysql(db, pdo, sql, args, max_rows, max_bytes, names, rows);
    }
    if (strcmp(dialect, "postgres") == 0 && zend_hash_num_elements(Z_ARRVAL_P(args)) == 0) {
        return cat_grid_pdo_cursor(db, pdo, sql, max_rows, max_bytes, names, rows);
    }
    zval st, ret, count;
    bool ok = pdo_call(pdo, "prepare", &st, 1, sql, NULL);
    if (!ok) {
        cat_driver_error(db);
        goto fail_names;
    }
    ok = pdo_call(&st, "execute", &ret, 1, args, NULL);
    if (!ok) {
        cat_driver_error(db);
        goto fail_st;
    }
    zval_ptr_dtor(&ret);
    ok = pdo_call(&st, "columnCount", &count, 0, NULL, NULL);
    if (!ok) {
        cat_driver_error(db);
        goto fail_st;
    }
    zend_long ncols = Z_LVAL(count);
    zend_string **natives = ecalloc(ncols > 0 ? ncols : 1, sizeof(zend_string *));
    for (zend_long i = 0; i < ncols; i++) {
        zval index, meta;
        ZVAL_LONG(&index, i);
        if (!pdo_call(&st, "getColumnMeta", &meta, 1, &index, NULL)) {
            cat_driver_error(db);
            goto fail_natives;
        }
        zval *name = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "name", 4) : NULL;
        zval *native = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "native_type", 11) : NULL;
        add_next_index_str(names, name != NULL && Z_TYPE_P(name) == IS_STRING ? zend_string_copy(Z_STR_P(name)) : ZSTR_EMPTY_ALLOC());
        natives[i] = native != NULL && Z_TYPE_P(native) == IS_STRING ? zend_string_toupper(Z_STR_P(native)) : ZSTR_EMPTY_ALLOC();
        zval_ptr_dtor(&meta);
    }
    zend_long budget = 0;
    for (;;) {
        zval mode, row;
        ZVAL_LONG(&mode, CAT_PDO_FETCH_NUM);
        if (!pdo_call(&st, "fetch", &row, 1, &mode, NULL)) {
            cat_driver_error(db);
            goto fail_natives;
        }
        if (Z_TYPE(row) == IS_FALSE) break;
        if (!cat_grid_row_limit(rows, &row, max_rows)) goto fail_natives;
        zval cells;
        array_init(&cells);
        for (zend_ulong i = 0; i < zend_hash_num_elements(Z_ARRVAL(row)); i++) {
            zval *value = zend_hash_index_find(Z_ARRVAL(row), i);
            const char *native = ZSTR_VAL(natives[i]);
            bool blob = false;
            if (strcmp(dialect, "sqlite") == 0) {
                /* SQLite types the value: the type of this row's value, and a blob by its flag. */
                zval index, meta;
                ZVAL_LONG(&index, (zend_long)i);
                if (!pdo_call(&st, "getColumnMeta", &meta, 1, &index, NULL)) {
                    cat_driver_error(db);
                    zval_ptr_dtor(&cells);
                    zval_ptr_dtor(&row);
                    goto fail_natives;
                }
                zval *flags = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "flags", 5) : NULL;
                zval *cell_native = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "native_type", 11) : NULL;
                zend_string *cn = cell_native != NULL && Z_TYPE_P(cell_native) == IS_STRING ? zend_string_toupper(Z_STR_P(cell_native)) : NULL;
                native = cn ? ZSTR_VAL(cn) : "";
                if (flags != NULL && Z_TYPE_P(flags) == IS_ARRAY) {
                    zval *f;
                    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(flags), f) {
                        if (Z_TYPE_P(f) == IS_STRING && zend_string_equals_literal(Z_STR_P(f), "blob")) blob = true;
                    } ZEND_HASH_FOREACH_END();
                }
                zval cell;
                bool made = cat_grid_pdo_cell(value, dialect, native, blob, &cell);
                if (cn) zend_string_release(cn);
                zval_ptr_dtor(&meta);
                if (!made) {
                    zval_ptr_dtor(&cells);
                    zval_ptr_dtor(&row);
                    goto fail_natives;
                }
                add_next_index_zval(&cells, &cell);
                continue;
            }
            zval cell;
            if (!cat_grid_pdo_cell(value, dialect, native, blob, &cell)) {
                zval_ptr_dtor(&cells);
                zval_ptr_dtor(&row);
                goto fail_natives;
            }
            add_next_index_zval(&cells, &cell);
        }
        zval_ptr_dtor(&row);
        if (!cat_grid_cells_budget(&cells, max_bytes, &budget)) goto fail_natives;
        add_next_index_zval(rows, &cells);
    }
    for (zend_long i = 0; i < ncols; i++) zend_string_release(natives[i]);
    efree(natives);
    zval_ptr_dtor(&count);
    zval_ptr_dtor(&st);
    return true;
fail_natives:
    for (zend_long i = 0; i < ncols; i++) {
        if (natives[i] != NULL) zend_string_release(natives[i]);
    }
    efree(natives);
    zval_ptr_dtor(&count);
fail_st:
    zval_ptr_dtor(&st);
fail_names:
    zval_ptr_dtor(names);
    zval_ptr_dtor(rows);
    return false;
}

/* Whether an OrmException has this code. */
static bool cat_code_is(zend_object *error, const char *name)
{
    zval rv;
    zval *code = zend_read_property(error->ce, error, "code_", sizeof("code_") - 1, true, &rv);
    bool same = Z_TYPE_P(code) == IS_STRING && strcmp(Z_STRVAL_P(code), name) == 0;
    if (code == &rv) zval_ptr_dtor(&rv);
    return same;
}

/* A READ_ONLY error of a MySQL grid query is the query that the read-only transaction refuses: QUERY_READ_ONLY, with the driver
 * error as its previous error. */
static void cat_grid_read_only_error(void)
{
    if (EG(exception) == NULL || !cat_code_is(EG(exception), "READ_ONLY")) return;

    zval previous, args[3], wrapped;
    ZVAL_OBJ(&previous, EG(exception));
    EG(exception) = NULL;
    ZVAL_STRING(&args[0], "QUERY_READ_ONLY");
    ZVAL_STRING(&args[1], "the database rejected a read-only grid query");
    ZVAL_COPY_VALUE(&args[2], &previous);
    if (newobj("Polyspec\\Orm\\OrmException", &wrapped, 3, args)) zend_throw_exception_object(&wrapped);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&previous);
}

/* Prepares and runs a MySQL statement that streams its rows, each parameter bound by its PHP type. */
static bool cat_mysql_streamed(zval *pdo, zval *sql, zval *args, zval *st)
{
    if (!pdo_call(pdo, "prepare", st, 1, sql, NULL)) return false;
    zval r;
    bool typed = zend_hash_num_elements(Z_ARRVAL_P(args)) > 0;
    bool ok = (!typed || cat_bind_typed(st, args)) && cat_mysql_buffered(pdo, false);
    if (ok) {
        ok = typed ? pdo_call(st, "execute", &r, 0, NULL, NULL) : cat_execute(st, args, &r);
        if (ok) zval_ptr_dtor(&r);
        if (!cat_mysql_buffered(pdo, true)) ok = false;
    }
    if (!ok) zval_ptr_dtor(st);
    return ok;
}

/* The MySQL column of a grid query (Catalog::mysqlGridColumns). */
typedef struct {
    zend_long type;
    bool unsigned_;
    bool binary;
} cat_mysql_column;

#define CAT_MYSQL_TYPES_TABLE "orm_grid_column_types"

/* Whether a lower-case MySQL column type names a binary string. */
static bool cat_mysql_binary_type(const char *type)
{
    static const char *const binary[] = {"binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"};
    for (size_t i = 0; i < sizeof(binary) / sizeof(binary[0]); i++) {
        size_t n = strlen(binary[i]);
        if (strncmp(type, binary[i], n) == 0 && !isalnum((unsigned char)type[n]) && type[n] != '_') return true;
    }
    return false;
}

/* Sets the flag and the charset of each column from the column types of the result, as the server derives them
 * (Catalog::mysqlResultTypes): a temporary table of the query, under WHERE FALSE, holds no row. A READ ONLY transaction
 * refuses the statement, so the read transaction ends around it, and the server refuses a stored function that writes
 * while the table is created. A server that refuses the statement leaves the cells to their values (INT-157). */
static void cat_mysql_result_types(zval *pdo, zval *sql, zval *args, cat_mysql_column *columns, size_t count)
{
    size_t length = Z_STRLEN_P(sql);
    while (length > 0 && strchr(" \t\r\n;", Z_STRVAL_P(sql)[length - 1]) != NULL) length--;
    smart_str create = {0};
    smart_str_appends(&create, "CREATE TEMPORARY TABLE " CAT_MYSQL_TYPES_TABLE " AS WITH q(");
    for (size_t i = 0; i < count; i++) {
        if (i > 0) smart_str_appendc(&create, ',');
        smart_str_appendc(&create, 'c');
        smart_str_append_unsigned(&create, i);
    }
    smart_str_appends(&create, ") AS (\n");
    smart_str_appendl(&create, Z_STRVAL_P(sql), length);
    smart_str_appends(&create, "\n) SELECT * FROM q WHERE FALSE");
    smart_str_0(&create);
    zval text, st;
    ZVAL_STR(&text, create.s);
    bool created = cat_mysql_streamed(pdo, &text, args, &st);
    zval_ptr_dtor(&text);
    if (created) {
        zval r;
        if (pdo_call(&st, "closeCursor", &r, 0, NULL, NULL)) zval_ptr_dtor(&r);
        zval_ptr_dtor(&st);
        zval show, shown;
        ZVAL_STRING(&show, "SHOW COLUMNS FROM " CAT_MYSQL_TYPES_TABLE);
        if (pdo_call(pdo, "query", &shown, 1, &show, NULL)) {
            zval mode, rows;
            ZVAL_LONG(&mode, 3); /* PDO::FETCH_NUM */
            if (pdo_call(&shown, "fetchAll", &rows, 1, &mode, NULL)) {
                size_t at = 0;
                zval *row;
                ZEND_HASH_FOREACH_VAL(Z_ARRVAL(rows), row) {
                    zval *type = at < count && Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 1) : NULL;
                    if (type != NULL && Z_TYPE_P(type) == IS_STRING) {
                        zend_string *lower = zend_string_tolower(Z_STR_P(type));
                        columns[at].unsigned_ = strstr(ZSTR_VAL(lower), "unsigned") != NULL;
                        columns[at].binary = cat_mysql_binary_type(ZSTR_VAL(lower));
                        zend_string_release(lower);
                    }
                    at++;
                } ZEND_HASH_FOREACH_END();
                zval_ptr_dtor(&rows);
            }
            zval_ptr_dtor(&shown);
        }
        zval_ptr_dtor(&show);
        if (EG(exception) != NULL) zend_clear_exception();
        cat_try_exec(pdo, "DROP TEMPORARY TABLE " CAT_MYSQL_TYPES_TABLE);
    }
    if (EG(exception) != NULL) zend_clear_exception();
}

/* The columns of a MySQL grid query (Catalog::mysqlGridColumns). The query runs once with sql_select_limit 0, which gives
 * its columns and no row; each column takes its flag and charset from the server (cat_mysql_result_types). The caller
 * releases *columns. */
static bool cat_mysql_grid_columns(zval *db, zval *pdo, zval *sql, zval *args, zval *names, cat_mysql_column **columns, zend_long *count)
{
    *columns = NULL;
    *count = 0;
    if (!cat_try_exec(pdo, "SET SESSION sql_select_limit = 0")) {
        cat_driver_error(db);
        return false;
    }
    zval st, metas;
    array_init(&metas);
    bool ok = cat_mysql_streamed(pdo, sql, args, &st);
    if (ok) {
        zval n;
        ok = pdo_call(&st, "columnCount", &n, 0, NULL, NULL);
        for (zend_long i = 0; ok && i < Z_LVAL(n); i++) {
            zval index, meta;
            ZVAL_LONG(&index, i);
            ok = pdo_call(&st, "getColumnMeta", &meta, 1, &index, NULL);
            if (ok) add_next_index_zval(&metas, &meta);
        }
        zval r;
        if (ok && pdo_call(&st, "closeCursor", &r, 0, NULL, NULL)) zval_ptr_dtor(&r);
        zval_ptr_dtor(&st);
    }
    if (!ok || EG(exception) != NULL) {
        ok = false;
        cat_driver_error(db);
    }
    /* The session limit returns to its default also after a failure, whose error stays the one reported. */
    zend_object *failure = EG(exception);
    EG(exception) = NULL;
    bool reset = cat_try_exec(pdo, "SET SESSION sql_select_limit = DEFAULT");
    if (failure != NULL) {
        zend_clear_exception();
        EG(exception) = failure;
    } else if (!reset) {
        cat_driver_error(db);
        ok = false;
    }
    if (!ok) {
        zval_ptr_dtor(&metas);
        return false;
    }
    *count = zend_hash_num_elements(Z_ARRVAL(metas));
    *columns = ecalloc(*count > 0 ? *count : 1, sizeof(cat_mysql_column));
    zval *meta;
    zend_long at = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(metas), meta) {
        zval *name = Z_TYPE_P(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(meta), "name", 4) : NULL;
        zval *native = Z_TYPE_P(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(meta), "native_type", 11) : NULL;
        const char *column_name = name != NULL && Z_TYPE_P(name) == IS_STRING ? Z_STRVAL_P(name) : "";
        add_next_index_string(names, column_name);
        zend_string *upper = native != NULL && Z_TYPE_P(native) == IS_STRING ? zend_string_toupper(Z_STR_P(native)) : ZSTR_EMPTY_ALLOC();
        cat_mysql_column *column = &(*columns)[at++];
        column->type = cat_mysql_type(ZSTR_VAL(upper));
        zend_string_release(upper);
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&metas);
    if (!cat_try_exec(pdo, "COMMIT")) {
        cat_driver_error(db);
        efree(*columns);
        *columns = NULL;
        return false;
    }
    cat_mysql_result_types(pdo, sql, args, *columns, *count);
    if (!cat_try_exec(pdo, "START TRANSACTION READ ONLY")) {
        cat_driver_error(db);
        efree(*columns);
        *columns = NULL;
        return false;
    }
    return true;
}

/* Reads a MySQL grid query on the PDO connection: it streams the rows, so that a budget stops the read before the rest of the
 * result, and a stop kills the query, whose cursor then ends with an interrupted error that is the expected end of a stop. */
static bool cat_grid_mysql(zval *db, zval *pdo, zval *sql, zval *args, zend_long max_rows, zend_long max_bytes, zval *names, zval *rows)
{
    cat_mysql_column *columns = NULL;
    zend_long count = 0;
    zend_long connection_id = 0;
    zval st;
    bool opened = false;
    bool ok = cat_mysql_grid_columns(db, pdo, sql, args, names, &columns, &count);
    if (ok && !cat_mysql_connection_id(pdo, &connection_id)) {
        cat_driver_error(db);
        ok = false;
    }
    if (ok) {
        opened = cat_mysql_streamed(pdo, sql, args, &st);
        if (!opened) {
            cat_driver_error(db);
            ok = false;
        }
    }
    zend_long budget = 0;
    while (ok) {
        zval mode, row;
        ZVAL_LONG(&mode, CAT_PDO_FETCH_NUM);
        if (!pdo_call(&st, "fetch", &row, 1, &mode, NULL)) {
            cat_driver_error(db);
            ok = false;
            break;
        }
        if (Z_TYPE(row) == IS_FALSE) break;
        if (!cat_grid_row_limit(rows, &row, max_rows)) {
            ok = false;
            break;
        }
        zval cells;
        array_init(&cells);
        for (zend_ulong i = 0; ok && i < zend_hash_num_elements(Z_ARRVAL(row)); i++) {
            zval cell;
            ok = cat_grid_mysql_cell(zend_hash_index_find(Z_ARRVAL(row), i), columns[i].type, columns[i].unsigned_, columns[i].binary, &cell);
            if (ok) add_next_index_zval(&cells, &cell);
        }
        zval_ptr_dtor(&row);
        if (!ok) {
            zval_ptr_dtor(&cells);
            break;
        }
        if (!cat_grid_cells_budget(&cells, max_bytes, &budget)) {
            ok = false;
            break;
        }
        add_next_index_zval(rows, &cells);
    }
    if (columns != NULL) efree(columns);
    if (opened) {
        zend_object *failure = EG(exception);
        EG(exception) = NULL;
        zval r;
        if (!ok && failure != NULL && cat_code_is(failure, "CATALOG_LIMIT") && !cat_kill_query(db, connection_id)) {
            zend_clear_exception();
        }
        if (pdo_call(&st, "closeCursor", &r, 0, NULL, NULL)) zval_ptr_dtor(&r);
        if (ok && EG(exception) != NULL) {
            cat_driver_error(db);
            ok = false;
        } else {
            zend_clear_exception();
            EG(exception) = failure;
        }
        zval_ptr_dtor(&st);
    }
    if (!ok) {
        cat_grid_read_only_error();
        zval_ptr_dtor(names);
        zval_ptr_dtor(rows);
    }
    return ok;
}

/* The Db of the connection and its dialect, read from the catalog object. */
static zval *cat_db(zval *self, zval *rv)
{
    return catalog_prop(self, "db", rv);
}

static bool cat_open(zval *self)
{
    zval rv_closed;
    zval *closed = catalog_prop(self, "closed", &rv_closed);
    if (Z_TYPE_P(closed) == IS_TRUE) {
        db_throw_orm("CATALOG_CLOSED", "catalog connection is closed");
        return false;
    }
    return true;
}

static zend_string *cat_dialect(zval *self)
{
    zval rv;
    zval *d = catalog_prop(self, "dialect", &rv);
    return Z_STR_P(d);
}

/* Validates shared input and copies read-only query parameters before either Catalog query path starts. */
static bool cat_read_only_inputs(zval *self, zend_string *sql, zval *params, zend_long *max_rows, zend_long *max_bytes,
                                 zval *db_rv, zval **db, zend_string **dialect, zval *args)
{
    if (!cat_open(self)) return false;
    *db = cat_db(self, db_rv);
    *dialect = cat_dialect(self);
    if (!cat_validate_read_only(sql, ZSTR_VAL(*dialect))) return false;
    if (*max_rows < 0 || *max_bytes < 0) {
        db_throw_orm("QUERY_LIMIT_INVALID", "limits must not be negative");
        return false;
    }
    if (*max_rows == 0) *max_rows = CAT_DEFAULT_ROWS;
    if (*max_bytes == 0) *max_bytes = CAT_DEFAULT_BYTES;
    array_init(args);
    if (params != NULL) {
        zval *param;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(params), param) {
            if (!cat_param(param)) {
                zval_ptr_dtor(args);
                return false;
            }
            Z_TRY_ADDREF_P(param);
            add_next_index_zval(args, param);
        } ZEND_HASH_FOREACH_END();
    }
    return true;
}

#define CAT_PARSE_READ_ONLY_INPUTS() \
    zend_string *sql; \
    zval *params = NULL; \
    zend_long max_rows = 0, max_bytes = 0; \
    ZEND_PARSE_PARAMETERS_START(1, 4) \
        Z_PARAM_STR(sql) \
        Z_PARAM_OPTIONAL \
        Z_PARAM_ARRAY(params) \
        Z_PARAM_LONG(max_rows) \
        Z_PARAM_LONG(max_bytes) \
    ZEND_PARSE_PARAMETERS_END(); \
    zval rv; \
    zval *db; \
    zend_string *dialect; \
    zval args; \
    if (!cat_read_only_inputs(ZEND_THIS, sql, params, &max_rows, &max_bytes, &rv, &db, &dialect, &args)) return

/* ---- writes (SCH-6a) -------------------------------------------------------------------------------------------------------- */

/* Opens a writable transaction (Catalog::begin, writable): SQLite takes the write lock at once. */
static bool cat_begin_write(zval *db, const char *dialect, zval *pdo)
{
    if (!pdo_call(db, "pdo", pdo, 0, NULL, NULL)) {
        return false;
    }
    if (strcmp(dialect, "sqlite") == 0 && !cat_try_exec(pdo, "PRAGMA query_only = OFF")) {
        cat_driver_error(db);
        return false;
    }
    const char *begin = strcmp(dialect, "mysql") == 0 ? "START TRANSACTION"
        : strcmp(dialect, "postgres") == 0 ? "BEGIN" : "BEGIN IMMEDIATE";
    if (!cat_try_exec(pdo, begin)) {
        cat_driver_error(db);
        return false;
    }
    return true;
}

/* Throws the cause (owned) after a ROLLBACK. A failed ROLLBACK throws OrmException::rollback(cause, rollback error) (Catalog::rollback). */
static void cat_rollback_throw(zval *db, zval *pdo, zval *cause)
{
    if (cat_try_rollback(pdo)) {
        zend_throw_exception_object(cause);
        return;
    }
    zval rollback_native, rollback_mapped;
    ZVAL_OBJ(&rollback_native, EG(exception));
    EG(exception) = NULL;
    if (pdo_call(db, "driverError", &rollback_mapped, 1, &rollback_native, NULL)) {
        zval args[2], rolled;
        ZVAL_COPY_VALUE(&args[0], cause);
        ZVAL_COPY_VALUE(&args[1], &rollback_mapped);
        if (scall("Polyspec\\Orm\\OrmException::rollback", &rolled, 2, args)) {
            zend_throw_exception_object(&rolled);
        }
        zval_ptr_dtor(&rollback_mapped);
    }
    zval_ptr_dtor(&rollback_native);
    zval_ptr_dtor(cause);
}

/* Commits a writable transaction (Catalog::write). A rejected commit rolls back as ROW_COMMIT_REJECTED. Any other commit failure
 * is an unknown outcome: ROW_COMMIT_INDETERMINATE, never retried. */
static bool cat_commit(zval *db, zval *pdo)
{
    if (cat_try_exec(pdo, "COMMIT")) {
        return true;
    }
    zval native, mapped, message, code_rv;
    ZVAL_OBJ(&native, EG(exception));
    EG(exception) = NULL;
    if (!pdo_call(db, "driverError", &mapped, 1, &native, NULL)) {
        zval_ptr_dtor(&native);
        return false;
    }
    zval_ptr_dtor(&native);
    zval *code = catalog_prop(&mapped, "code_", &code_rv);
    static const char *const rejected_codes[] = {"DUPLICATE_KEY", "FOREIGN_KEY", "CONSTRAINT", "DEADLOCK", NULL};
    bool rejected = false;
    for (const char *const *c = rejected_codes; *c != NULL && !rejected; c++) {
        rejected = strcmp(Z_STRVAL_P(code), *c) == 0;
    }
    if (!pdo_call(&mapped, "getMessage", &message, 0, NULL, NULL)) {
        zval_ptr_dtor(&mapped);
        return false;
    }
    if (rejected) {
        zend_string *text = zend_strpprintf(0, "native commit rejected: %s", Z_STRVAL(message));
        zval args[3], cause;
        ZVAL_STRING(&args[0], "ROW_COMMIT_REJECTED");
        ZVAL_STR(&args[1], text);
        ZVAL_COPY_VALUE(&args[2], &mapped);
        if (newobj("Polyspec\\Orm\\OrmException", &cause, 3, args)) {
            cat_rollback_throw(db, pdo, &cause);
        }
        zval_ptr_dtor(&args[0]);
        zval_ptr_dtor(&args[1]);
        zval_ptr_dtor(&mapped);
        zval_ptr_dtor(&message);
        return false;
    }
    /* The outcome is unknown: preserve a failed ROLLBACK separately from the original commit cause. */
    zval cause = mapped;
    zval rollback;
    ZVAL_NULL(&rollback);
    zend_string *text = zend_strpprintf(0, "commit outcome unknown; do not retry: %s", Z_STRVAL(message));
    if (!cat_try_rollback(pdo)) {
        zval rb_native, rb_mapped, rb_message;
        ZVAL_OBJ(&rb_native, EG(exception));
        EG(exception) = NULL;
        ZVAL_UNDEF(&rb_mapped);
        if (pdo_call(db, "driverError", &rb_mapped, 1, &rb_native, NULL)) {
            if (pdo_call(&rb_mapped, "getMessage", &rb_message, 0, NULL, NULL)) {
                zend_string *joined = zend_strpprintf(0, "%s; rollback failed: %s", ZSTR_VAL(text), Z_STRVAL(rb_message));
                zend_string_release(text);
                text = joined;
                zval_ptr_dtor(&rb_message);
            }
            ZVAL_COPY_VALUE(&rollback, &rb_mapped);
        } else if (!Z_ISUNDEF(rb_mapped)) {
            zval_ptr_dtor(&rb_mapped);
        }
        zval_ptr_dtor(&rb_native);
    }
    zval args[4], unknown;
    ZVAL_STRING(&args[0], "ROW_COMMIT_INDETERMINATE");
    ZVAL_STR(&args[1], text);
    ZVAL_COPY(&args[2], &cause);
    ZVAL_COPY(&args[3], &rollback);
    if (newobj("Polyspec\\Orm\\OrmException", &unknown, 4, args)) {
        zend_throw_exception_object(&unknown);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
    zval_ptr_dtor(&args[3]);
    zval_ptr_dtor(&cause);
    zval_ptr_dtor(&rollback);
    zval_ptr_dtor(&message);
    return false;
}

typedef bool (*cat_write_operation)(zval *db, const char *dialect, zval *pdo, void *context, zval *result);

/* Runs every Catalog mutation body in the same commit/rollback boundary. */
static bool cat_write_transaction(zval *db, const char *dialect, cat_write_operation operation, void *context, zval *result)
{
    zval pdo;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_write(db, dialect, &pdo)) return false;
    bool ok = operation(db, dialect, &pdo, context, result);
    if (ok) {
        if (!cat_commit(db, &pdo)) {
            zval_ptr_dtor(result);
            ok = false;
        }
    } else {
        cat_abort(db, &pdo);
    }
    zval_ptr_dtor(&pdo);
    return ok;
}

/* Runs one bounded query with the values of a PHP array as parameters (a mysql safety check). */
static bool cat_query_params(zval *db, zval *pdo, const char *sql, zval *args, zend_long max_rows, zval *rows)
{
    zval names, types;
    if (!cat_query(db, pdo, sql, args, max_rows, CAT_METADATA_BYTES, &names, &types, rows, NULL)) {
        return false;
    }
    zval_ptr_dtor(&names);
    zval_ptr_dtor(&types);
    return true;
}

/* The MySQL row-change safety rule (Catalog::mysqlSafety): partial revokes off, the account holds TRIGGER on the table, the table
 * is InnoDB and has no triggers. A rule that cannot be verified is ROW_MUTATION_UNSUPPORTED. */
static bool cat_mysql_safety(zval *db, zval *pdo, zval *metadata)
{
    zval rv_t, *table = catalog_prop(metadata, "table", &rv_t);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    zval rows, args;

    zval none;
    array_init(&none);
    bool queried = cat_query_params(db, pdo, "SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)", &none, 1, &rows);
    zval_ptr_dtor(&none);
    if (!queried) return false;
    bool partial_off = zend_hash_num_elements(Z_ARRVAL(rows)) == 1;
    if (partial_off) {
        zval *r0 = zend_hash_index_find(Z_ARRVAL(rows), 0);
        zval *cell = Z_TYPE_P(r0) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(r0), 0) : NULL;
        partial_off = cell != NULL && zval_get_long(cell) == 0 && (Z_TYPE_P(cell) == IS_LONG || (Z_TYPE_P(cell) == IS_STRING
            && zend_string_equals_literal(Z_STR_P(cell), "0")));
    }
    zval_ptr_dtor(&rows);
    if (!partial_off) {
        db_throw_orm("ROW_MUTATION_UNSUPPORTED", "MySQL partial-revoke visibility requires verification");
        return false;
    }

    zval user_none;
    array_init(&user_none);
    bool user_queried = cat_query_params(db, pdo, "SELECT CURRENT_USER()", &user_none, 1, &rows);
    zval_ptr_dtor(&user_none);
    if (!user_queried) return false;
    zval *account = NULL;
    if (zend_hash_num_elements(Z_ARRVAL(rows)) == 1) {
        zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
        account = Z_TYPE_P(row) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(row), 0) : NULL;
    }
    const char *at = account != NULL && Z_TYPE_P(account) == IS_STRING ? strrchr(Z_STRVAL_P(account), '@') : NULL;
    if (at == NULL) {
        zval_ptr_dtor(&rows);
        db_throw_orm("ROW_MUTATION_UNSUPPORTED", "unverifiable MySQL account");
        return false;
    }
    smart_str grantee = {0};
    smart_str_appendc(&grantee, '\'');
    smart_str_appendl(&grantee, Z_STRVAL_P(account), (size_t)(at - Z_STRVAL_P(account)));
    smart_str_appends(&grantee, "'@'");
    smart_str_appends(&grantee, at + 1);
    smart_str_appendc(&grantee, '\'');
    smart_str_0(&grantee);
    zval_ptr_dtor(&rows);

    zval grant_args[6];
    for (int i = 0; i < 6; i++) ZVAL_UNDEF(&grant_args[i]);
    ZVAL_STR(&grant_args[0], zend_string_copy(grantee.s));
    ZVAL_STR(&grant_args[1], zend_string_copy(grantee.s));
    ZVAL_COPY(&grant_args[2], ns);
    ZVAL_STR(&grant_args[3], zend_string_copy(grantee.s));
    ZVAL_COPY(&grant_args[4], ns);
    ZVAL_COPY(&grant_args[5], tname);
    zval grant_list;
    array_init(&args);
    for (int i = 0; i < 6; i++) add_next_index_zval(&args, &grant_args[i]);
    bool ok = cat_query_params(db, pdo,
        "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' "
        "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' "
        "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
        &args, 16, &grant_list);
    zval_ptr_dtor(&args);
    smart_str_free(&grantee);
    if (!ok) return false;
    bool trigger = false;
    zval *g;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(grant_list), g) {
        zval *cell = Z_TYPE_P(g) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(g)) == 1 ? zend_hash_index_find(Z_ARRVAL_P(g), 0) : NULL;
        if (cell != NULL && Z_TYPE_P(cell) == IS_STRING && zend_string_equals_literal(Z_STR_P(cell), "TRIGGER")) trigger = true;
    } ZEND_HASH_FOREACH_END();
    zval_ptr_dtor(&grant_list);
    if (!trigger) {
        db_throw_orm("ROW_MUTATION_UNSUPPORTED", "MySQL trigger visibility is unverified");
        return false;
    }

    zval engine_args;
    array_init(&engine_args);
    Z_TRY_ADDREF_P(ns);
    add_next_index_zval(&engine_args, ns);
    Z_TRY_ADDREF_P(tname);
    add_next_index_zval(&engine_args, tname);
    if (!cat_query_params(db, pdo, "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", &engine_args, 2, &rows)) {
        zval_ptr_dtor(&engine_args);
        return false;
    }
    zval_ptr_dtor(&engine_args);
    bool innodb = zend_hash_num_elements(Z_ARRVAL(rows)) == 1;
    if (innodb) {
        zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
        zval *cell = Z_TYPE_P(row) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(row)) == 1 ? zend_hash_index_find(Z_ARRVAL_P(row), 0) : NULL;
        innodb = cell != NULL && Z_TYPE_P(cell) == IS_STRING && strcasecmp(Z_STRVAL_P(cell), "InnoDB") == 0;
    }
    zval_ptr_dtor(&rows);
    if (!innodb) {
        db_throw_orm("ROW_MUTATION_UNSUPPORTED", "MySQL requires InnoDB");
        return false;
    }

    zval trigger_args;
    array_init(&trigger_args);
    Z_TRY_ADDREF_P(ns);
    add_next_index_zval(&trigger_args, ns);
    Z_TRY_ADDREF_P(tname);
    add_next_index_zval(&trigger_args, tname);
    if (!cat_query_params(db, pdo,
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1",
            &trigger_args, 1, &rows)) {
        zval_ptr_dtor(&trigger_args);
        return false;
    }
    zval_ptr_dtor(&trigger_args);
    bool no_triggers = zend_hash_num_elements(Z_ARRVAL(rows)) == 0;
    zval_ptr_dtor(&rows);
    if (!no_triggers) {
        db_throw_orm("ROW_MUTATION_UNSUPPORTED", "MySQL triggers require effect verification");
        return false;
    }
    return true;
}

/* Appends a primary-key WHERE clause and its arguments in descriptor key order. */
static void cat_key_predicate(smart_str *sql, zval *metadata, const char *dialect, zval *keys, zval *args)
{
    zval rv_pk, *pk = catalog_prop(metadata, "primaryKey", &rv_pk);
    smart_str_appends(sql, " WHERE ");
    bool first = true;
    zval *key;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), key) {
        if (!first) smart_str_appends(sql, " AND ");
        first = false;
        cat_quote(sql, Z_STR_P(key), dialect);
        smart_str_appends(sql, "=?");
    } ZEND_HASH_FOREACH_END();
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), key) {
        Z_TRY_ADDREF_P(key);
        add_next_index_zval(args, key);
    } ZEND_HASH_FOREACH_END();
}

typedef enum {
    CAT_CHANGE_COLUMNS,
    CAT_CHANGE_ASSIGNMENTS,
    CAT_CHANGE_LOCATOR,
} cat_change_mode;

/* Serializes validated Catalog changes and binds their values for insert, update and locator predicates. */
static bool cat_append_changes(smart_str *sql, zval *columns, zval *changes, const char *dialect, zval *args,
                               cat_change_mode mode)
{
    bool first = true;
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
        zend_long index = Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0));
        zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
        zval nrv, *name = catalog_prop(zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)index), "name", &nrv);
        if (!first) smart_str_appends(sql, mode == CAT_CHANGE_LOCATOR ? " AND " : ",");
        first = false;
        cat_quote(sql, Z_STR_P(name), dialect);
        if (mode == CAT_CHANGE_ASSIGNMENTS) smart_str_appends(sql, "=?");
        if (mode == CAT_CHANGE_LOCATOR && Z_TYPE_P(value) == IS_NULL) {
            smart_str_appends(sql, " IS NULL");
        } else {
            if (mode == CAT_CHANGE_LOCATOR) smart_str_appends(sql, "=?");
            Z_TRY_ADDREF_P(value);
            add_next_index_zval(args, value);
        }
    } ZEND_HASH_FOREACH_END();
    return !first;
}

/* The primary-key lookup of a descriptor: at most two rows, locked where the server locks (Catalog::lookup). */
static bool cat_lookup(zval *db, const char *dialect, zval *pdo, zval *metadata, zval *keys, bool lock, zval *rows)
{
    zval rv_table, rv_cols;
    zval *table = catalog_prop(metadata, "table", &rv_table);
    zval *columns = catalog_prop(metadata, "columns", &rv_cols);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    zval names, native_types;
    array_init(&names);
    array_init(&native_types);
    smart_str sql = {0};
    smart_str_appends(&sql, "SELECT ");
    bool first = true;
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval nrv, trv;
        zval *name = catalog_prop(column, "name", &nrv);
        zval *native = catalog_prop(column, "nativeType", &trv);
        if (!first) smart_str_appendc(&sql, ',');
        first = false;
        cat_quote(&sql, Z_STR_P(name), dialect);
        add_next_index_str(&names, zend_string_copy(Z_STR_P(name)));
        add_next_index_str(&native_types, zend_string_copy(Z_STR_P(native)));
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&sql, " FROM ");
    cat_quote(&sql, Z_STR_P(ns), dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, Z_STR_P(tname), dialect);
    zval key_args;
    array_init(&key_args);
    cat_key_predicate(&sql, metadata, dialect, keys, &key_args);
    smart_str_appends(&sql, " LIMIT 2");
    if (lock && strcmp(dialect, "sqlite") != 0) {
        smart_str_appends(&sql, " FOR UPDATE");
    }
    smart_str_0(&sql);
    zval got_names, got_types, raw;
    bool ok = cat_query(db, pdo, ZSTR_VAL(sql.s), &key_args, 2, CAT_PAGE_BYTES, &got_names, &got_types, &raw, NULL);
    smart_str_free(&sql);
    zval_ptr_dtor(&key_args);
    if (!ok) {
        zval_ptr_dtor(&names);
        zval_ptr_dtor(&native_types);
        return false;
    }
    zval_ptr_dtor(&got_types);
    bool same = zend_compare(&got_names, &names) == 0;
    zval_ptr_dtor(&got_names);
    zval_ptr_dtor(&names);
    if (!same) {
        zval_ptr_dtor(&raw);
        zval_ptr_dtor(&native_types);
        db_throw_orm("TABLE_PAGE_METADATA_CHANGED", "prepared columns differ from descriptor");
        return false;
    }
    ok = cat_convert_rows(&raw, &native_types, dialect, rows);
    zval_ptr_dtor(&raw);
    zval_ptr_dtor(&native_types);
    return ok && cat_described_rows(rows, metadata, dialect);
}

/* A cell equal in type and exact value to another (Catalog::sameRow of one cell). */
static bool cat_same_cell(zval *a, zval *b)
{
    smart_str ka = {0}, kb = {0};
    bool same = false;
    if (cat_cell_key(a, &ka) && cat_cell_key(b, &kb)) {
        smart_str_0(&ka);
        smart_str_0(&kb);
        same = ZSTR_LEN(ka.s) == ZSTR_LEN(kb.s) && memcmp(ZSTR_VAL(ka.s), ZSTR_VAL(kb.s), ZSTR_LEN(ka.s)) == 0;
    }
    smart_str_free(&ka);
    smart_str_free(&kb);
    return same;
}

/* Verifies the submitted cells against a row returned for a Catalog insert. */
static bool cat_check_inserted_values(zval *metadata, zval *row, zval *changes, bool name_mismatch)
{
    zval rv_cols, *columns = catalog_prop(metadata, "columns", &rv_cols);
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
        zend_long index = Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0));
        zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
        zval *stored = zend_hash_index_find(Z_ARRVAL_P(row), (zend_ulong)index);
        if (!cat_same_cell(stored, value)) {
            if (name_mismatch) {
                zval nrv, *name = catalog_prop(zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)index), "name", &nrv);
                db_throw_orm("ROW_WRITE_MISMATCH", "stored inserted values of \"%s\" differ", Z_STRVAL_P(name));
            } else {
                db_throw_orm("ROW_WRITE_MISMATCH", "inserted values differ");
            }
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* Converts the pending error into a new error with code and the message prefix; the original error is its previous one. */
static void cat_rewrap(const char *code, const char *prefix)
{
    if (EG(exception) == NULL) return;
    zval previous, msg_zv, args[3], wrapped;
    ZVAL_OBJ(&previous, EG(exception));
    EG(exception) = NULL;
    zval message_out;
    if (!pdo_call(&previous, "getMessage", &message_out, 0, NULL, NULL)) {
        zval_ptr_dtor(&previous);
        return;
    }
    zend_string *text = zend_strpprintf(0, "%s%s", prefix, Z_STRVAL(message_out));
    zval_ptr_dtor(&message_out);
    ZVAL_STRING(&args[0], code);
    ZVAL_STR(&args[1], text);
    ZVAL_COPY_VALUE(&args[2], &previous);
    if (newobj("Polyspec\\Orm\\OrmException", &wrapped, 3, args)) {
        zend_throw_exception_object(&wrapped);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&previous);
    (void)msg_zv;
}

/* The assignments of a change: each named column's index and its normalized value, as [index, value] pairs (Catalog::changes). */
static bool cat_exceeds_char_limit(zval *column, zval *value)
{
    if (Z_TYPE_P(value) != IS_STRING) return false;
    zval rv, *native = catalog_prop(column, "nativeType", &rv);
    if (Z_TYPE_P(native) != IS_STRING) {
        return false;
    }
    const char *text = Z_STRVAL_P(native);
    size_t length = Z_STRLEN_P(native);
    size_t prefix = 0;
    bool binary = false;
    if (length >= sizeof("varchar") - 1
        && zend_binary_strncasecmp(text, length, "varchar", sizeof("varchar") - 1, sizeof("varchar") - 1) == 0) {
        prefix = sizeof("varchar") - 1;
    } else if (length >= sizeof("character varying") - 1
               && zend_binary_strncasecmp(text, length, "character varying", sizeof("character varying") - 1,
                                          sizeof("character varying") - 1) == 0) {
        prefix = sizeof("character varying") - 1;
    } else if (length >= sizeof("varbinary") - 1
               && zend_binary_strncasecmp(text, length, "varbinary", sizeof("varbinary") - 1, sizeof("varbinary") - 1) == 0) {
        prefix = sizeof("varbinary") - 1;
        binary = true;
    } else if (length >= sizeof("binary") - 1
               && zend_binary_strncasecmp(text, length, "binary", sizeof("binary") - 1, sizeof("binary") - 1) == 0) {
        prefix = sizeof("binary") - 1;
        binary = true;
    } else {
        return false;
    }
    const char *open = memchr(text, '(', length);
    if (open == NULL || (size_t)(open - text) != prefix) return false;
    const char *close = memchr(open + 1, ')', length - (size_t)(open + 1 - text));
    if (close == NULL || close == open + 1) return false;
    zend_ulong limit = 0;
    for (const char *digit = open + 1; digit < close; digit++) {
        if (*digit < '0' || *digit > '9' || limit > ((zend_ulong)-1 - 9) / 10) return false;
        limit = limit * 10 + (zend_ulong)(*digit - '0');
    }
    zend_ulong actual = Z_STRLEN_P(value);
    if (!binary) {
        actual = utf8_count((str){Z_STRVAL_P(value), Z_STRLEN_P(value)});
    }
    return actual > limit;
}

static bool cat_changes_map(zval *metadata, zval *values, const char *code, zval *out);

/* The named changes of a write: a list of [name, value] pairs, which may repeat a name (refused as the code states), or a map
 * of column name => value, which has distinct names. */
/* The fraction digits of a temporal value that a write names beyond the precision of its column (Catalog::checkWritePrecision):
 * a refusal with CODEC_ENCODE before the write. The changes are [index, value] pairs. */
static bool cat_check_write_precision(const char *dialect, zval *metadata, zval *changes)
{
    bool sqlite = strcmp(dialect, "sqlite") == 0;
    zval rv_c, *columns = catalog_prop(metadata, "columns", &rv_c);
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
        zval *index_v = zend_hash_index_find(Z_ARRVAL_P(pair), 0);
        zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
        if (index_v == NULL || value == NULL || Z_TYPE_P(value) != IS_STRING) continue;
        zval *column = zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)Z_LVAL_P(index_v));
        if (column == NULL) continue;
        zval rv_n, *native_v = catalog_prop(column, "nativeType", &rv_n);
        zval rv_p, *check = catalog_prop(column, "checkPrecision", &rv_p);
        if (Z_TYPE_P(native_v) != IS_STRING) continue;
        bool temporal = sqlite
            ? (zend_string_equals_literal_ci(Z_STR_P(native_v), "TIME") || zend_string_equals_literal_ci(Z_STR_P(native_v), "DATETIME"))
            : cat_temporal_kind(dialect, Z_STRVAL_P(native_v)) != 0;
        if (!temporal) continue;
        const char *dot = memchr(Z_STRVAL_P(value), '.', Z_STRLEN_P(value));
        if (dot == NULL) continue;
        zend_long precision;
        if (sqlite) {
            /* A SQLite column with no CHECK fixes no precision, so it has no write to refuse. */
            if (Z_TYPE_P(check) != IS_LONG) continue;
            precision = Z_LVAL_P(check);
        } else {
            precision = cat_declared_precision(dialect, Z_STRVAL_P(native_v));
        }
        size_t first = (size_t)(dot - Z_STRVAL_P(value)) + 1;
        for (size_t d = first + (size_t)precision; d < Z_STRLEN_P(value); d++) {
            if (Z_STRVAL_P(value)[d] != '0') {
                db_throw_orm("CODEC_ENCODE", "temporal value \"%s\" has more fraction digits than its precision " ZEND_LONG_FMT,
                             Z_STRVAL_P(value), precision);
                return false;
            }
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

static bool cat_changes(zval *metadata, zval *values, const char *code, zval *out)
{
    if (!zend_array_is_list(Z_ARRVAL_P(values)) || zend_hash_num_elements(Z_ARRVAL_P(values)) == 0) {
        return cat_changes_map(metadata, values, code, out);
    }
    zval map;
    array_init(&map);
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(values), pair) {
        zval *name = Z_TYPE_P(pair) == IS_ARRAY && zend_hash_num_elements(Z_ARRVAL_P(pair)) == 2
            ? zend_hash_index_find(Z_ARRVAL_P(pair), 0) : NULL;
        zval *value = Z_TYPE_P(pair) == IS_ARRAY ? zend_hash_index_find(Z_ARRVAL_P(pair), 1) : NULL;
        if (name == NULL || value == NULL || Z_TYPE_P(name) != IS_STRING) {
            zval_ptr_dtor(&map);
            db_throw_orm(code, "an assignment is a [name, value] pair");
            return false;
        }
        if (zend_symtable_exists(Z_ARRVAL(map), Z_STR_P(name))) {
            zval_ptr_dtor(&map);
            db_throw_orm(code, "duplicate column \"%s\"", ZSTR_VAL(Z_STR_P(name)));
            return false;
        }
        Z_TRY_ADDREF_P(value);
        zend_symtable_update(Z_ARRVAL(map), Z_STR_P(name), value);
    } ZEND_HASH_FOREACH_END();
    bool ok = cat_changes_map(metadata, &map, code, out);
    zval_ptr_dtor(&map);
    return ok;
}

static bool cat_changes_map(zval *metadata, zval *values, const char *code, zval *out)
{
    zval rv_cols, *columns = catalog_prop(metadata, "columns", &rv_cols);
    uint32_t ncols = zend_hash_num_elements(Z_ARRVAL_P(columns));
    uint32_t nvalues = zend_hash_num_elements(Z_ARRVAL_P(values));
    if (nvalues == 0 || nvalues > ncols) {
        db_throw_orm(code, "invalid column assignments");
        return false;
    }
    zend_string *key;
    zend_ulong num;
    zval *value;
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(values), num, key, value) {
        if (!cat_param(value)) return false;
    } ZEND_HASH_FOREACH_END();
    array_init(out);
    ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(values), num, key, value) {
        if (key == NULL) {
            db_throw_orm(code, "unknown column \"%ld\"", (long)num);
            zval_ptr_dtor(out);
            return false;
        }
        zend_ulong index = 0;
        bool found = false;
        zval *column;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval nrv, *name = catalog_prop(column, "name", &nrv);
            if (zend_string_equals(Z_STR_P(name), key)) {
                found = true;
                zval grv, *generated = catalog_prop(column, "generated", &grv);
                zval nrv2, *nullable = catalog_prop(column, "nullable", &nrv2);
                if (Z_TYPE_P(generated) == IS_TRUE) {
                    db_throw_orm(code, "generated column \"%s\" is not writable", ZSTR_VAL(key));
                    zval_ptr_dtor(out);
                    return false;
                }
                if (Z_TYPE_P(value) == IS_NULL && Z_TYPE_P(nullable) != IS_TRUE) {
                    db_throw_orm(code, "NULL in non-null column \"%s\"", ZSTR_VAL(key));
                    zval_ptr_dtor(out);
                    return false;
                }
                if (cat_exceeds_char_limit(column, value)) {
                    db_throw_orm(code, "value exceeds the declared capacity of column \"%s\"", ZSTR_VAL(key));
                    zval_ptr_dtor(out);
                    return false;
                }
                break;
            }
            index++;
        } ZEND_HASH_FOREACH_END();
        if (!found) {
            db_throw_orm(code, "unknown column \"%s\"", ZSTR_VAL(key));
            zval_ptr_dtor(out);
            return false;
        }
        zval pair;
        array_init(&pair);
        add_next_index_long(&pair, (zend_long)index);
        Z_TRY_ADDREF_P(value);
        add_next_index_zval(&pair, value);
        add_next_index_zval(out, &pair);
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* The column names of a descriptor as an array, for a result. */
static bool cat_result(zval *metadata, zval *rows, zval *out)
{
    zval names;
    cat_column_names(metadata, &names);
    bool ok = cat_named_result(&names, rows, out);
    zval_ptr_dtor(&names);
    return ok;
}

/* The primary-key values of a row, in constraint order, taken by the key indexes. */
static void cat_pick(zval *cells, zval *indexes, zval *out)
{
    array_init(out);
    zval *ix;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(indexes), ix) {
        zval *cell = zend_hash_index_find(Z_ARRVAL_P(cells), (zend_ulong)Z_LVAL_P(ix));
        Z_TRY_ADDREF_P(cell);
        add_next_index_zval(out, cell);
    } ZEND_HASH_FOREACH_END();
}

/* The row-check of a current row against the original cells (Catalog::checkCurrent). */
static bool cat_check_current(zval *current, zval *original)
{
    uint32_t n = zend_hash_num_elements(Z_ARRVAL_P(current));
    if (n == 0) {
        db_throw_orm("ROW_CONFLICT", "original row is missing");
        return false;
    }
    if (n > 1) {
        db_throw_orm("ROW_IDENTITY_AMBIGUOUS", "key selected multiple rows");
        return false;
    }
    zval *row = zend_hash_index_find(Z_ARRVAL_P(current), 0);
    if (zend_hash_num_elements(Z_ARRVAL_P(row)) != zend_hash_num_elements(Z_ARRVAL_P(original))) {
        db_throw_orm("ROW_CONFLICT", "original values changed");
        return false;
    }
    zval *a, *b;
    zend_ulong i = 0;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), a) {
        b = zend_hash_index_find(Z_ARRVAL_P(original), i++);
        if (!cat_same_cell(a, b)) {
            db_throw_orm("ROW_CONFLICT", "original values changed");
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

/* A bounded insert-owned row read with the descriptor's exact projection (Catalog::query and Catalog::sameNames). */
static bool cat_insert_rows(zval *db, const char *dialect, zval *pdo, zval *metadata, const char *sql, zval *args, zval *rows)
{
    zval names, types, raw, expected;
    if (!cat_query(db, pdo, sql, args, 2, CAT_PAGE_BYTES, &names, &types, &raw, NULL)) return false;
    cat_column_names(metadata, &expected);
    bool same = zend_compare(&names, &expected) == 0;
    zval_ptr_dtor(&expected);
    zval_ptr_dtor(&names);
    if (!same) {
        zval_ptr_dtor(&types);
        zval_ptr_dtor(&raw);
        db_throw_orm("TABLE_PAGE_METADATA_CHANGED", "prepared columns differ from descriptor");
        return false;
    }
    bool ok = cat_convert_rows(&raw, &types, dialect, rows);
    zval_ptr_dtor(&types);
    zval_ptr_dtor(&raw);
    return ok && cat_described_rows(rows, metadata, dialect);
}

/* The row selected by the MySQL key/default strategy after one insert. */
static bool cat_mysql_inserted_keys(zval *db, zval *pdo, zval *metadata, zval *changes, zval *generated_key_indexes,
                                    const char *locator_sql, zval *locator_args, zval *keys)
{
    zval rows;
    if (locator_sql != NULL) {
        if (!cat_insert_rows(db, "mysql", pdo, metadata, locator_sql, locator_args, &rows)) return false;
        if (zend_hash_num_elements(Z_ARRVAL(rows)) != 1) {
            zval_ptr_dtor(&rows);
            db_throw_orm("ROW_IDENTITY_AMBIGUOUS", "expected exactly one inserted locator row");
            return false;
        }
    } else {
        zval rv_cols, *columns = catalog_prop(metadata, "columns", &rv_cols);
        zval identity;
        ZVAL_UNDEF(&identity);
        bool automatic = false;
        zval *generated_index;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(generated_key_indexes), generated_index) {
            zval *column = zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)Z_LVAL_P(generated_index));
            zval arv, *is_auto = catalog_prop(column, "automaticKey", &arv);
            automatic = automatic || Z_TYPE_P(is_auto) == IS_TRUE;
        } ZEND_HASH_FOREACH_END();
        if (automatic) {
            if (!pdo_call(pdo, "lastInsertId", &identity, 0, NULL, NULL)) {
                cat_driver_error(db);
                return false;
            }
            bool valid = false;
            if (Z_TYPE(identity) == IS_LONG) {
                valid = Z_LVAL(identity) > 0;
            } else if (Z_TYPE(identity) == IS_STRING && Z_STRLEN(identity) != 0) {
                valid = true;
                bool nonzero = false;
                for (size_t i = 0; i < Z_STRLEN(identity); i++) {
                    char digit = Z_STRVAL(identity)[i];
                    if (digit < '0' || digit > '9') valid = false;
                    if (digit != '0') nonzero = true;
                }
                valid = valid && nonzero;
            }
            if (!valid) {
                zval_ptr_dtor(&identity);
                db_throw_orm("ROW_WRITE_MISMATCH", "insert acknowledgement mismatch");
                return false;
            }
        }
        zval key_indexes, args;
        if (!cat_descriptor_keys(metadata, &key_indexes)) {
            if (!Z_ISUNDEF(identity)) zval_ptr_dtor(&identity);
            return false;
        }
        array_init(&args);
        smart_str sql = {0};
        smart_str_appends(&sql, "SELECT ");
        bool first = true;
        zval *column;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval nrv, *name = catalog_prop(column, "name", &nrv);
            if (!first) smart_str_appendc(&sql, ',');
            first = false;
            cat_quote(&sql, Z_STR_P(name), "mysql");
        } ZEND_HASH_FOREACH_END();
        smart_str_appends(&sql, " FROM ");
        zval rv_table, *table = catalog_prop(metadata, "table", &rv_table);
        zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
        zval *table_name = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
        cat_quote(&sql, Z_STR_P(ns), "mysql");
        smart_str_appendc(&sql, '.');
        cat_quote(&sql, Z_STR_P(table_name), "mysql");
        smart_str_appends(&sql, " WHERE ");
        bool first_predicate = true;
        zval *key_index;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(key_indexes), key_index) {
            zend_long index = Z_LVAL_P(key_index);
            zval *key_column = zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)index);
            zval nrv, arv, *name = catalog_prop(key_column, "name", &nrv);
            zval *is_auto = catalog_prop(key_column, "automaticKey", &arv);
            zval *provided = NULL;
            zval *pair;
            ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
                if (Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0)) == index) {
                    provided = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
                    break;
                }
            } ZEND_HASH_FOREACH_END();
            if (!first_predicate) smart_str_appends(&sql, " AND ");
            first_predicate = false;
            cat_quote(&sql, Z_STR_P(name), "mysql");
            if (provided != NULL || Z_TYPE_P(is_auto) == IS_TRUE) {
                smart_str_appends(&sql, "=?");
                zval *value = provided != NULL ? provided : &identity;
                Z_TRY_ADDREF_P(value);
                add_next_index_zval(&args, value);
            } else {
                smart_str_appends(&sql, "=DEFAULT(");
                cat_quote(&sql, Z_STR_P(name), "mysql");
                smart_str_appendc(&sql, ')');
            }
        } ZEND_HASH_FOREACH_END();
        smart_str_appends(&sql, " LIMIT 2 FOR UPDATE");
        smart_str_0(&sql);
        bool ok = cat_insert_rows(db, "mysql", pdo, metadata, ZSTR_VAL(sql.s), &args, &rows);
        smart_str_free(&sql);
        zval_ptr_dtor(&args);
        zval_ptr_dtor(&key_indexes);
        if (!Z_ISUNDEF(identity)) zval_ptr_dtor(&identity);
        if (!ok) return false;
        if (zend_hash_num_elements(Z_ARRVAL(rows)) != 1) {
            zval_ptr_dtor(&rows);
            db_throw_orm("ROW_WRITE_MISMATCH", "expected one generated-key row");
            return false;
        }
    }
    zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
    if (!cat_check_inserted_values(metadata, row, changes, false)) {
        zval_ptr_dtor(&rows);
        return false;
    }
    zval key_indexes, generated;
    if (!cat_descriptor_keys(metadata, &key_indexes)) {
        zval_ptr_dtor(&rows);
        return false;
    }
    cat_pick(row, &key_indexes, &generated);
    zval_ptr_dtor(&key_indexes);
    zval_ptr_dtor(keys);
    ZVAL_COPY_VALUE(keys, &generated);
    zval_ptr_dtor(&rows);
    return true;
}

static bool cat_insert_body(zval *db, const char *dialect, zval *pdo, zval *declared, zval *changes, zval *keys,
                            zval *generated_key_indexes, zval *out)
{
    bool has_generated_keys = zend_hash_num_elements(Z_ARRVAL_P(generated_key_indexes)) != 0;
    zval rv_t, *table = catalog_prop(declared, "table", &rv_t);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    if (strcmp(dialect, "postgres") == 0) {
        smart_str lock = {0};
        smart_str_appends(&lock, "LOCK TABLE ");
        cat_quote(&lock, Z_STR_P(ns), dialect);
        smart_str_appendc(&lock, '.');
        cat_quote(&lock, Z_STR_P(tname), dialect);
        smart_str_appends(&lock, " IN ROW EXCLUSIVE MODE");
        smart_str_0(&lock);
        zval none;
        array_init(&none);
        zend_long affected;
        bool locked = cat_exec(db, pdo, ZSTR_VAL(lock.s), &none, &affected);
        zval_ptr_dtor(&none);
        smart_str_free(&lock);
        if (!locked) return false;
    }
    if (strcmp(dialect, "mysql") == 0 && has_generated_keys) {
        smart_str lock = {0};
        smart_str_appends(&lock, "SELECT 1 FROM ");
        cat_quote(&lock, Z_STR_P(ns), dialect);
        smart_str_appendc(&lock, '.');
        cat_quote(&lock, Z_STR_P(tname), dialect);
        smart_str_appends(&lock, " LIMIT 0 FOR UPDATE");
        smart_str_0(&lock);
        zval none, names, types, rows;
        array_init(&none);
        bool locked = cat_query(db, pdo, ZSTR_VAL(lock.s), &none, 1, CAT_PAGE_BYTES, &names, &types, &rows, NULL);
        zval_ptr_dtor(&none);
        smart_str_free(&lock);
        if (!locked) return false;
        zval_ptr_dtor(&names);
        zval_ptr_dtor(&types);
        zval_ptr_dtor(&rows);
    }
    if (!has_generated_keys) {
        zval existing;
        if (!cat_lookup(db, dialect, pdo, declared, keys, true, &existing)) return false;
        bool exists = zend_hash_num_elements(Z_ARRVAL(existing)) != 0;
        zval_ptr_dtor(&existing);
        if (exists) {
            db_throw_orm("ROW_CONFLICT", "insertion key already exists");
            return false;
        }
    }
    zval descriptor;
    if (!cat_describe(db, dialect, pdo, Z_STR_P(ns), Z_STR_P(tname), &descriptor)) return false;
    if (zend_compare(&descriptor, declared) != 0) {
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_SCHEMA_CHANGED", "insertion descriptor changed");
        return false;
    }
    if (strcmp(dialect, "mysql") == 0 && !cat_mysql_safety(db, pdo, &descriptor)) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    zval rv_cols, *columns = catalog_prop(&descriptor, "columns", &rv_cols);
    bool expression_key = false;
    zval *generated_index;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(generated_key_indexes), generated_index) {
        zval *column = zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)Z_LVAL_P(generated_index));
        zval erv, *expression = catalog_prop(column, "expressionDefault", &erv);
        expression_key = expression_key || Z_TYPE_P(expression) == IS_TRUE;
    } ZEND_HASH_FOREACH_END();
    bool mysql_locator = strcmp(dialect, "mysql") == 0 && expression_key;
    smart_str locator_sql = {0};
    zval locator_args;
    array_init(&locator_args);
    if (mysql_locator) {
        smart_str_appends(&locator_sql, "SELECT ");
        bool first_column = true;
        zval *column;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval nrv, *name = catalog_prop(column, "name", &nrv);
            if (!first_column) smart_str_appendc(&locator_sql, ',');
            first_column = false;
            cat_quote(&locator_sql, Z_STR_P(name), dialect);
        } ZEND_HASH_FOREACH_END();
        smart_str_appends(&locator_sql, " FROM ");
        cat_quote(&locator_sql, Z_STR_P(ns), dialect);
        smart_str_appendc(&locator_sql, '.');
        cat_quote(&locator_sql, Z_STR_P(tname), dialect);
        smart_str_appends(&locator_sql, " WHERE ");
        if (!cat_append_changes(&locator_sql, columns, changes, dialect, &locator_args, CAT_CHANGE_LOCATOR)) {
            smart_str_appends(&locator_sql, "1=1");
        }
        smart_str_appends(&locator_sql, " LIMIT 2 FOR UPDATE");
        smart_str_0(&locator_sql);
        zval before;
        if (!cat_insert_rows(db, dialect, pdo, &descriptor, ZSTR_VAL(locator_sql.s), &locator_args, &before)) {
            smart_str_free(&locator_sql);
            zval_ptr_dtor(&locator_args);
            zval_ptr_dtor(&descriptor);
            return false;
        }
        bool absent = zend_hash_num_elements(Z_ARRVAL(before)) == 0;
        zval_ptr_dtor(&before);
        if (!absent) {
            smart_str_free(&locator_sql);
            zval_ptr_dtor(&locator_args);
            zval_ptr_dtor(&descriptor);
            db_throw_orm("ROW_IDENTITY_AMBIGUOUS", "generated identity locator already matches rows");
            return false;
        }
    }
    smart_str sql = {0};
    smart_str_appends(&sql, "INSERT INTO ");
    cat_quote(&sql, Z_STR_P(ns), dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, Z_STR_P(tname), dialect);
    zval args;
    array_init(&args);
    if (zend_hash_num_elements(Z_ARRVAL_P(changes)) == 0) {
        smart_str_appends(&sql, strcmp(dialect, "mysql") == 0 ? "() VALUES()" : " DEFAULT VALUES");
    } else {
        smart_str_appends(&sql, " (");
        cat_append_changes(&sql, columns, changes, dialect, &args, CAT_CHANGE_COLUMNS);
        smart_str_appends(&sql, ") VALUES (");
        for (uint32_t k = 0; k < zend_hash_num_elements(Z_ARRVAL_P(changes)); k++) {
            if (k) smart_str_appendc(&sql, ',');
            smart_str_appendc(&sql, '?');
        }
        smart_str_appendc(&sql, ')');
    }
    bool returning = has_generated_keys && strcmp(dialect, "mysql") != 0;
    if (returning) {
        smart_str_appends(&sql, " RETURNING ");
        bool first_column = true;
        zval *column;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
            zval nrv, *name = catalog_prop(column, "name", &nrv);
            if (!first_column) smart_str_appendc(&sql, ',');
            first_column = false;
            cat_quote(&sql, Z_STR_P(name), dialect);
        } ZEND_HASH_FOREACH_END();
    }
    smart_str_0(&sql);
    bool ok;
    if (returning) {
        zval returned;
        ok = cat_insert_rows(db, dialect, pdo, &descriptor, ZSTR_VAL(sql.s), &args, &returned);
        if (ok) {
            if (zend_hash_num_elements(Z_ARRVAL(returned)) != 1) {
                zval_ptr_dtor(&returned);
                db_throw_orm("ROW_WRITE_MISMATCH", "expected one returned insert row");
                ok = false;
            } else {
                zval key_indexes, generated;
                if (!cat_descriptor_keys(&descriptor, &key_indexes)) {
                    zval_ptr_dtor(&returned);
                    ok = false;
                } else {
                    cat_pick(zend_hash_index_find(Z_ARRVAL(returned), 0), &key_indexes, &generated);
                    zval_ptr_dtor(&key_indexes);
                    zval_ptr_dtor(keys);
                    ZVAL_COPY_VALUE(keys, &generated);
                    zval_ptr_dtor(&returned);
                }
            }
        }
    } else {
        zend_long affected = 0;
        ok = cat_exec(db, pdo, ZSTR_VAL(sql.s), &args, &affected);
        if (ok && affected != 1) {
            db_throw_orm("ROW_WRITE_MISMATCH", "expected exactly one inserted row, got %ld", (long)affected);
            ok = false;
        }
        if (ok && has_generated_keys) {
            ok = cat_mysql_inserted_keys(db, pdo, &descriptor, changes, generated_key_indexes,
                                         mysql_locator ? ZSTR_VAL(locator_sql.s) : NULL, &locator_args, keys);
        }
    }
    smart_str_free(&sql);
    smart_str_free(&locator_sql);
    zval_ptr_dtor(&locator_args);
    zval_ptr_dtor(&args);
    if (!ok) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    zval after;
    if (!cat_lookup(db, dialect, pdo, &descriptor, keys, false, &after)) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    if (zend_hash_num_elements(Z_ARRVAL(after)) != 1) {
        zval_ptr_dtor(&after);
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_WRITE_MISMATCH", "expected exactly one inserted row");
        return false;
    }
    zval again;
    if (!cat_describe(db, dialect, pdo, Z_STR_P(ns), Z_STR_P(tname), &again)) {
        zval_ptr_dtor(&after);
        zval_ptr_dtor(&descriptor);
        return false;
    }
    bool unchanged = zend_compare(&again, &descriptor) == 0;
    zval_ptr_dtor(&again);
    if (!unchanged) {
        zval_ptr_dtor(&after);
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_SCHEMA_CHANGED", "insertion descriptor changed");
        return false;
    }
    zval *first_row = zend_hash_index_find(Z_ARRVAL(after), 0);
    if (!cat_check_inserted_values(&descriptor, first_row, changes, true)) {
        zval_ptr_dtor(&after);
        zval_ptr_dtor(&descriptor);
        return false;
    }
    ok = cat_result(&descriptor, &after, out);
    zval_ptr_dtor(&after);
    zval_ptr_dtor(&descriptor);
    return ok;
}

typedef struct {
    zval *declared;
    zval *changes;
    zval *keys;
    zval *generated_key_indexes;
} cat_insert_write_context;

static bool cat_insert_write(zval *db, const char *dialect, zval *pdo, void *opaque, zval *result)
{
    cat_insert_write_context *context = opaque;
    return cat_insert_body(db, dialect, pdo, context->declared, context->changes, context->keys,
                           context->generated_key_indexes, result);
}

ZEND_METHOD(Polyspec_Orm_Catalog, insertRow)
{
    zval *declared, *values;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(declared, catalog_ce_metadata)
        Z_PARAM_ARRAY(values)
    ZEND_PARSE_PARAMETERS_END();
    if (!cat_open(ZEND_THIS)) return;
    zval key_indexes;
    if (!cat_descriptor_keys(declared, &key_indexes)) return;
    zval changes;
    if (!cat_changes(declared, values, "ROW_INSERT_INVALID", &changes)) {
        zval_ptr_dtor(&key_indexes);
        return;
    }
    if (!cat_check_write_precision(ZSTR_VAL(cat_dialect(ZEND_THIS)), declared, &changes)) {
        zval_ptr_dtor(&changes);
        zval_ptr_dtor(&key_indexes);
        return;
    }
    zval rv_cols, *columns = catalog_prop(declared, "columns", &rv_cols);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zval keys;
    array_init(&keys);
    zval generated_key_indexes;
    array_init(&generated_key_indexes);
    zend_long mysql_auto_keys = 0;
    zval *ix;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(key_indexes), ix) {
        zend_long want = Z_LVAL_P(ix);
        zval *found = NULL;
        zval *pair;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(changes), pair) {
            if (Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0)) == want) {
                found = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
                break;
            }
        } ZEND_HASH_FOREACH_END();
        if (found == NULL) {
            zval *column = zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)want);
            zval nrv, *name = catalog_prop(column, "name", &nrv);
            zval arv, *automatic = catalog_prop(column, "automaticKey", &arv);
            zval drv, *default_expression = catalog_prop(column, "defaultExpression", &drv);
            if (Z_TYPE_P(automatic) == IS_TRUE || Z_TYPE_P(default_expression) != IS_NULL) {
                add_next_index_long(&generated_key_indexes, want);
                if (Z_TYPE_P(automatic) == IS_TRUE) mysql_auto_keys++;
                continue;
            }
            zval_ptr_dtor(&keys);
            zval_ptr_dtor(&generated_key_indexes);
            zval_ptr_dtor(&changes);
            zval_ptr_dtor(&key_indexes);
            db_throw_orm("ROW_INSERT_IDENTITY_REQUIRED", "explicit primary-key value of \"%s\" is required", Z_STRVAL_P(name));
            return;
        }
        Z_TRY_ADDREF_P(found);
        add_next_index_zval(&keys, found);
    } ZEND_HASH_FOREACH_END();
    if (strcmp(ZSTR_VAL(dialect), "mysql") == 0 && mysql_auto_keys > 1) {
        zval_ptr_dtor(&keys);
        zval_ptr_dtor(&generated_key_indexes);
        zval_ptr_dtor(&changes);
        zval_ptr_dtor(&key_indexes);
        db_throw_orm("ROW_INSERT_UNSUPPORTED", "multiple AUTO_INCREMENT identities");
        return;
    }
    zval rv_db;
    zval *db = cat_db(ZEND_THIS, &rv_db);
    zval result;
    cat_insert_write_context context = {declared, &changes, &keys, &generated_key_indexes};
    if (cat_write_transaction(db, ZSTR_VAL(dialect), cat_insert_write, &context, &result)) {
        RETVAL_COPY_VALUE(&result);
    }
    zval_ptr_dtor(&keys);
    zval_ptr_dtor(&generated_key_indexes);
    zval_ptr_dtor(&changes);
    zval_ptr_dtor(&key_indexes);
}

/* Locks and validates the original snapshot before either mutation path writes its row. */
typedef struct {
    zval metadata_rv;
    zval table_rv;
    zval *metadata;
    zval *ns;
    zval *tname;
} cat_snapshot_table;

static void cat_snapshot_table_names(zval *snapshot, cat_snapshot_table *table)
{
    table->metadata = catalog_prop(snapshot, "metadata", &table->metadata_rv);
    zval *definition = catalog_prop(table->metadata, "table", &table->table_rv);
    table->ns = zend_hash_str_find(Z_ARRVAL_P(definition), "namespace", 9);
    table->tname = zend_hash_str_find(Z_ARRVAL_P(definition), "name", 4);
}

static bool cat_locked_original(zval *db, const char *dialect, zval *pdo, zval *original, zval *keys,
                               cat_snapshot_table *table, zval *descriptor)
{
    zval current;
    if (!cat_lookup(db, dialect, pdo, table->metadata, keys, true, &current)) return false;
    if (!cat_describe(db, dialect, pdo, Z_STR_P(table->ns), Z_STR_P(table->tname), descriptor)) {
        zval_ptr_dtor(&current);
        return false;
    }
    if (zend_compare(descriptor, table->metadata) != 0) {
        zval_ptr_dtor(&current);
        zval_ptr_dtor(descriptor);
        db_throw_orm("ROW_SCHEMA_CHANGED", "original descriptor changed");
        return false;
    }
    zval rv_cells, *cells = catalog_prop(original, "cells", &rv_cells);
    if (!cat_check_current(&current, cells)) {
        zval_ptr_dtor(&current);
        zval_ptr_dtor(descriptor);
        return false;
    }
    zval_ptr_dtor(&current);
    if (strcmp(dialect, "mysql") == 0 && !cat_mysql_safety(db, pdo, descriptor)) {
        zval_ptr_dtor(descriptor);
        return false;
    }
    return true;
}

static bool cat_prepare_snapshot_mutation(zval *db, const char *dialect, zval *pdo, zval *original, zval *keys,
                                          cat_snapshot_table *table, zval *descriptor)
{
    cat_snapshot_table_names(original, table);
    return cat_locked_original(db, dialect, pdo, original, keys, table, descriptor);
}

/* Rechecks the descriptor after mutation so the result never mixes schema versions. */
static bool cat_descriptor_unchanged(zval *db, const char *dialect, zval *pdo, zval *ns, zval *tname,
                                     zval *descriptor)
{
    zval again;
    if (!cat_describe(db, dialect, pdo, Z_STR_P(ns), Z_STR_P(tname), &again)) return false;
    bool unchanged = zend_compare(&again, descriptor) == 0;
    zval_ptr_dtor(&again);
    if (!unchanged) db_throw_orm("ROW_SCHEMA_CHANGED", "original descriptor changed");
    return unchanged;
}

typedef enum {
    CAT_MUTATION_UPDATE,
    CAT_MUTATION_DELETE
} cat_mutation_kind;

static bool cat_mutation_statement(zval *db, const char *dialect, zval *pdo, smart_str *sql, zval *args,
                                   zval *descriptor, cat_mutation_kind kind, zend_long *affected_out)
{
    zend_long affected = 0;
    bool ok = cat_exec(db, pdo, ZSTR_VAL(sql->s), args, &affected);
    smart_str_free(sql);
    zval_ptr_dtor(args);
    if (!ok) {
        zval_ptr_dtor(descriptor);
        return false;
    }
    bool mismatch = kind == CAT_MUTATION_UPDATE
        ? affected > 1 || (affected == 0 && strcmp(dialect, "mysql") != 0)
        : affected != 1;
    if (mismatch) {
        zval_ptr_dtor(descriptor);
        if (kind == CAT_MUTATION_UPDATE) {
            db_throw_orm("ROW_WRITE_MISMATCH", "unexpected affected row count %ld", (long)affected);
        } else {
            db_throw_orm("ROW_WRITE_MISMATCH", "expected exactly one deleted row, got %ld", (long)affected);
        }
        return false;
    }
    if (affected_out != NULL) *affected_out = affected;
    return true;
}

static bool cat_update_body(zval *db, const char *dialect, zval *pdo, zval *original, zval *changes, zval *updated, zval *keys,
                            zval *new_keys, zval *out)
{
    cat_snapshot_table table;
    zval descriptor;
    if (!cat_prepare_snapshot_mutation(db, dialect, pdo, original, keys, &table, &descriptor)) return false;
    zval rv_cols, *columns = catalog_prop(&descriptor, "columns", &rv_cols);
    smart_str sql = {0};
    smart_str_appends(&sql, "UPDATE ");
    cat_quote(&sql, Z_STR_P(table.ns), dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, Z_STR_P(table.tname), dialect);
    smart_str_appends(&sql, " SET ");
    zval args;
    array_init(&args);
    cat_append_changes(&sql, columns, changes, dialect, &args, CAT_CHANGE_ASSIGNMENTS);
    cat_key_predicate(&sql, table.metadata, dialect, keys, &args);
    smart_str_0(&sql);
    if (!cat_mutation_statement(db, dialect, pdo, &sql, &args, &descriptor, CAT_MUTATION_UPDATE, NULL)) return false;
    zval after;
    if (!cat_lookup(db, dialect, pdo, &descriptor, new_keys, false, &after)) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    if (zend_hash_num_elements(Z_ARRVAL(after)) != 1) {
        uint32_t n = zend_hash_num_elements(Z_ARRVAL(after));
        zval_ptr_dtor(&after);
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_WRITE_MISMATCH", "expected exactly one updated row, got %u", n);
        return false;
    }
    if (!cat_descriptor_unchanged(db, dialect, pdo, table.ns, table.tname, &descriptor)) {
        zval_ptr_dtor(&after);
        zval_ptr_dtor(&descriptor);
        return false;
    }
    zval *first_row = zend_hash_index_find(Z_ARRVAL(after), 0);
    zend_ulong i = 0;
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval grv, *generated = catalog_prop(column, "generated", &grv);
        if (Z_TYPE_P(generated) != IS_TRUE) {
            zval *stored = zend_hash_index_find(Z_ARRVAL_P(first_row), i);
            zval *written = zend_hash_index_find(Z_ARRVAL_P(updated), i);
            if (!cat_same_cell(stored, written)) {
                zval nrv, *name = catalog_prop(column, "name", &nrv);
                zval_ptr_dtor(&after);
                zval_ptr_dtor(&descriptor);
                db_throw_orm("ROW_WRITE_MISMATCH", "stored ordinary values of \"%s\" differ", Z_STRVAL_P(name));
                return false;
            }
        }
        i++;
    } ZEND_HASH_FOREACH_END();
    bool ok = cat_result(&descriptor, &after, out);
    zval_ptr_dtor(&after);
    zval_ptr_dtor(&descriptor);
    return ok;
}

typedef struct {
    zval *original;
    zval *changes;
    zval *updated;
    zval *keys;
    zval *new_keys;
} cat_update_write_context;

static bool cat_update_write(zval *db, const char *dialect, zval *pdo, void *opaque, zval *result)
{
    cat_update_write_context *context = opaque;
    return cat_update_body(db, dialect, pdo, context->original, context->changes, context->updated,
                           context->keys, context->new_keys, result);
}

ZEND_METHOD(Polyspec_Orm_Catalog, updateRow)
{
    zval *original, *values;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(original, catalog_ce_snapshot)
        Z_PARAM_ARRAY(values)
    ZEND_PARSE_PARAMETERS_END();
    if (!cat_open(ZEND_THIS)) return;
    zval rv_m, rv_c, rv_cells, rv_idx;
    zval *metadata = catalog_prop(original, "metadata", &rv_m);
    zval *cells = catalog_prop(original, "cells", &rv_cells);
    zval *key_indexes = catalog_prop(original, "keyIndexes", &rv_idx);
    zval *columns = catalog_prop(metadata, "columns", &rv_c);
    if (zend_hash_num_elements(Z_ARRVAL_P(key_indexes)) == 0 || zend_hash_num_elements(Z_ARRVAL_P(cells)) != zend_hash_num_elements(Z_ARRVAL_P(columns))) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "the snapshot was not captured by rowSnapshotFromPage");
        return;
    }
    zval changes;
    if (!cat_changes(metadata, values, "ROW_UPDATE_INVALID", &changes)) return;
    if (!cat_check_write_precision(ZSTR_VAL(cat_dialect(ZEND_THIS)), metadata, &changes)) {
        zval_ptr_dtor(&changes);
        return;
    }
    zval updated;
    /* A copy: the changes must not change the original cells that the row check compares with. */
    ZVAL_ARR(&updated, zend_array_dup(Z_ARRVAL_P(cells)));
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(changes), pair) {
        zend_long index = Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0));
        zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
        Z_TRY_ADDREF_P(value);
        zend_hash_index_update(Z_ARRVAL(updated), (zend_ulong)index, value);
    } ZEND_HASH_FOREACH_END();
    if (!cat_check_cells(metadata, &updated)) {
        cat_rewrap("ROW_UPDATE_INVALID", "invalid updated row: ");
        zval_ptr_dtor(&updated);
        zval_ptr_dtor(&changes);
        return;
    }
    zval revision;
    if (!cat_revision(metadata, &updated, &revision)) {
        cat_rewrap("ROW_UPDATE_LIMIT", "updated row budget exceeded: ");
        zval_ptr_dtor(&updated);
        zval_ptr_dtor(&changes);
        return;
    }
    zval_ptr_dtor(&revision);
    zval keys, new_keys;
    cat_pick(cells, key_indexes, &keys);
    cat_pick(&updated, key_indexes, &new_keys);
    zval rv_db;
    zval *db = cat_db(ZEND_THIS, &rv_db);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zval result;
    cat_update_write_context context = {original, &changes, &updated, &keys, &new_keys};
    if (cat_write_transaction(db, ZSTR_VAL(dialect), cat_update_write, &context, &result)) {
        RETVAL_COPY_VALUE(&result);
    }
    zval_ptr_dtor(&keys);
    zval_ptr_dtor(&new_keys);
    zval_ptr_dtor(&updated);
    zval_ptr_dtor(&changes);
}

static bool cat_delete_body(zval *db, const char *dialect, zval *pdo, zval *original, zval *keys, zend_long *affected_out)
{
    cat_snapshot_table table;
    zval descriptor;
    if (!cat_prepare_snapshot_mutation(db, dialect, pdo, original, keys, &table, &descriptor)) return false;
    smart_str sql = {0};
    smart_str_appends(&sql, "DELETE FROM ");
    cat_quote(&sql, Z_STR_P(table.ns), dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, Z_STR_P(table.tname), dialect);
    zval args;
    array_init(&args);
    cat_key_predicate(&sql, table.metadata, dialect, keys, &args);
    smart_str_0(&sql);
    zend_long affected;
    if (!cat_mutation_statement(db, dialect, pdo, &sql, &args, &descriptor, CAT_MUTATION_DELETE, &affected)) return false;
    zval after;
    if (!cat_lookup(db, dialect, pdo, &descriptor, keys, false, &after)) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    bool remains = zend_hash_num_elements(Z_ARRVAL(after)) != 0;
    zval_ptr_dtor(&after);
    if (remains) {
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_WRITE_MISMATCH", "deleted row remains");
        return false;
    }
    bool unchanged = cat_descriptor_unchanged(db, dialect, pdo, table.ns, table.tname, &descriptor);
    zval_ptr_dtor(&descriptor);
    if (!unchanged) {
        return false;
    }
    *affected_out = affected;
    return true;
}

typedef struct {
    zval *original;
    zval *keys;
} cat_delete_write_context;

static bool cat_delete_write(zval *db, const char *dialect, zval *pdo, void *opaque, zval *result)
{
    cat_delete_write_context *context = opaque;
    zend_long affected;
    if (!cat_delete_body(db, dialect, pdo, context->original, context->keys, &affected)) return false;
    ZVAL_LONG(result, affected);
    return true;
}

ZEND_METHOD(Polyspec_Orm_Catalog, deleteRow)
{
    zval *original;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(original, catalog_ce_snapshot)
    ZEND_PARSE_PARAMETERS_END();
    if (!cat_open(ZEND_THIS)) return;
    zval rv_m, rv_idx, rv_cells;
    zval *metadata = catalog_prop(original, "metadata", &rv_m);
    zval *cells = catalog_prop(original, "cells", &rv_cells);
    zval *key_indexes = catalog_prop(original, "keyIndexes", &rv_idx);
    (void)metadata;
    if (zend_hash_num_elements(Z_ARRVAL_P(key_indexes)) == 0) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "the snapshot was not captured by rowSnapshotFromPage");
        return;
    }
    zval keys;
    cat_pick(cells, key_indexes, &keys);
    zval rv_db;
    zval *db = cat_db(ZEND_THIS, &rv_db);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zval result;
    cat_delete_write_context context = {original, &keys};
    if (cat_write_transaction(db, ZSTR_VAL(dialect), cat_delete_write, &context, &result)) {
        RETVAL_COPY_VALUE(&result);
    }
    zval_ptr_dtor(&keys);
}

/* ---- the methods of Polyspec\Orm\Catalog ----------------------------------------------------------------------------------- */


ZEND_METHOD(Polyspec_Orm_Catalog, connect)
{
    zend_string *dsn;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(dsn)
    ZEND_PARSE_PARAMETERS_END();
    if (strncasecmp(ZSTR_VAL(dsn), "markdown://", 11) == 0) {
        db_throw_orm("CONFIG", "CATALOG_DSN: a markdown corpus has no database catalog; give a mysql, postgres or sqlite DSN");
        return;
    }
    zval dsn_arg, parsed, connect_args[2], db, config;
    ZVAL_STR_COPY(&dsn_arg, dsn);
    if (!scall("Polyspec\\Orm\\Orm::parseDsn", &parsed, 1, &dsn_arg)) {
        zval_ptr_dtor(&dsn_arg);
        return;
    }
    zval *driver = zend_hash_index_find(Z_ARRVAL(parsed), 0);
    zval *pdo_dsn = zend_hash_index_find(Z_ARRVAL(parsed), 1);
    if (Z_TYPE_P(driver) != IS_STRING || Z_TYPE_P(pdo_dsn) != IS_STRING) {
        db_throw_orm("IR_INVALID", "the DSN parse of the PHP library has no driver and PDO DSN");
        goto out_parsed;
    }
    if (strcmp(Z_STRVAL_P(driver), "sqlite") == 0) {
        /* A symbolic link is not a regular file: the file must exist, and the connection never creates one. */
        zval path, link_r, file_r;
        ZVAL_STRINGL(&path, Z_STRVAL_P(pdo_dsn) + strlen("sqlite:"), Z_STRLEN_P(pdo_dsn) - strlen("sqlite:"));
        bool is_link = scall("is_link", &link_r, 1, &path) && Z_TYPE(link_r) == IS_TRUE;
        bool is_file = scall("is_file", &file_r, 1, &path) && Z_TYPE(file_r) == IS_TRUE;
        zval_ptr_dtor(&path);
        if (is_link || !is_file) {
            db_throw_orm("CONFIG", "CATALOG_SQLITE_FILE: expected an existing regular file");
            goto out_parsed;
        }
    }
    if (!newobj("Polyspec\\Orm\\Config", &config, 0, NULL)) {
        goto out_parsed;
    }
    ZVAL_COPY_VALUE(&connect_args[0], &dsn_arg);
    ZVAL_COPY_VALUE(&connect_args[1], &config);
    bool connected = scall("Polyspec\\Orm\\Orm::connect", &db, 2, connect_args);
    zval_ptr_dtor(&config);
    if (!connected) {
        goto out_parsed;
    }
    object_init_ex(return_value, catalog_ce);
    init_prop(return_value, "db", &db);
    zval rv_state, *state = catalog_prop(&db, "state", &rv_state);
    zend_update_property(Z_OBJCE_P(state), Z_OBJ_P(state), "catalogOwner", sizeof("catalogOwner") - 1, return_value);
    init_str(return_value, "dialect", zend_string_copy(Z_STR_P(driver)));
    init_str(return_value, "dsn", zend_string_copy(dsn));
    zval_ptr_dtor(&db);
out_parsed:
    zval_ptr_dtor(&parsed);
    zval_ptr_dtor(&dsn_arg);
}

ZEND_METHOD(Polyspec_Orm_Catalog, dialect)
{
    ZEND_PARSE_PARAMETERS_START(0, 0)
    ZEND_PARSE_PARAMETERS_END();
    zval rv;
    RETURN_COPY(catalog_prop(ZEND_THIS, "dialect", &rv));
}

ZEND_METHOD(Polyspec_Orm_Catalog, close)
{
    ZEND_PARSE_PARAMETERS_START(0, 0)
    ZEND_PARSE_PARAMETERS_END();
    zval rv_closed;
    zval *closed = catalog_prop(ZEND_THIS, "closed", &rv_closed);
    if (Z_TYPE_P(closed) == IS_TRUE) return;
    init_bool(ZEND_THIS, "closed", true);
    zval rv, ret;
    zval *db = catalog_prop(ZEND_THIS, "db", &rv);
    if (pdo_call(db, "close", &ret, 0, NULL, NULL)) {
        zval_ptr_dtor(&ret);
    }
}

ZEND_METHOD(Polyspec_Orm_Catalog, currentNamespace)
{
    ZEND_PARSE_PARAMETERS_START(0, 0)
    ZEND_PARSE_PARAMETERS_END();
    zval rv;
    if (!cat_open(ZEND_THIS)) return;
    zend_string *dialect = cat_dialect(ZEND_THIS);
    if (strcmp(ZSTR_VAL(dialect), "sqlite") == 0) {
        RETURN_STRING("main");
    }
    zval *db = cat_db(ZEND_THIS, &rv);
    const char *query = strcmp(ZSTR_VAL(dialect), "postgres") == 0 ? "SELECT current_schema()" : "SELECT DATABASE()";
    zval pdo, empty, names, types, rows;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        return;
    }
    array_init(&empty);
    bool ok = cat_query(db, &pdo, query, &empty, 2, CAT_METADATA_BYTES, &names, &types, &rows, NULL);
    zval_ptr_dtor(&empty);
    if (ok) {
        zval_ptr_dtor(&names);
        zval_ptr_dtor(&types);
        zval *row = zend_hash_index_find(Z_ARRVAL(rows), 0);
        if (zend_hash_num_elements(Z_ARRVAL(rows)) != 1 || Z_TYPE_P(row) != IS_ARRAY || zend_hash_num_elements(Z_ARRVAL_P(row)) != 1) {
            db_throw_orm("TABLE_NAMESPACE_UNAVAILABLE", "the connection reported no single namespace");
            ok = false;
        } else {
            zval *cell = zend_hash_index_find(Z_ARRVAL_P(row), 0);
            if (Z_TYPE_P(cell) != IS_STRING) {
                db_throw_orm("TABLE_NAMESPACE_UNAVAILABLE", "the connection reported no text namespace");
                ok = false;
            } else {
                cat_check_name(Z_STR_P(cell));
                ok = EG(exception) == NULL;
                if (ok) {
                    RETVAL_STR_COPY(Z_STR_P(cell));
                }
            }
        }
        zval_ptr_dtor(&rows);
    }
    if (ok) {
        cat_end_read(db, &pdo);
    } else {
        cat_abort(db, &pdo);
    }
    zval_ptr_dtor(&pdo);
}

ZEND_METHOD(Polyspec_Orm_Catalog, describeTable)
{
    zval *table;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(table)
    ZEND_PARSE_PARAMETERS_END();
    if (!cat_open(ZEND_THIS)) return;
    zend_string *ns, *name;
    if (!cat_table_ref(table, &ns, &name)) {
        return;
    }
    zval rv;
    zval *db = cat_db(ZEND_THIS, &rv);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zval pdo, meta;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        return;
    }
    bool ok = cat_describe(db, ZSTR_VAL(dialect), &pdo, ns, name, &meta);
    if (ok) {
        ok = cat_end_read(db, &pdo);
        if (ok) {
            RETVAL_COPY_VALUE(&meta);
        } else {
            zval_ptr_dtor(&meta);
        }
    } else {
        cat_abort(db, &pdo);
    }
    zval_ptr_dtor(&pdo);
}

ZEND_METHOD(Polyspec_Orm_Catalog, tablePage)
{
    zval *table;
    zend_long limit, offset;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY(table)
        Z_PARAM_LONG(limit)
        Z_PARAM_LONG(offset)
    ZEND_PARSE_PARAMETERS_END();
    if (!cat_open(ZEND_THIS)) return;
    zend_string *ns, *name;
    if (!cat_table_ref(table, &ns, &name)) {
        return;
    }
    if (limit < 1 || limit > 1000 || offset < 0 || offset > 1000000) {
        db_throw_orm("TABLE_PAGE_INVALID", "limit requires 1..1000 and offset 0..1000000");
        return;
    }
    zval rv;
    zval *db = cat_db(ZEND_THIS, &rv);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zval pdo, page;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        return;
    }
    bool ok = cat_table_page(db, ZSTR_VAL(dialect), &pdo, ns, name, limit, offset, &page);
    if (ok) {
        ok = cat_end_read(db, &pdo);
        if (ok) {
            RETVAL_COPY_VALUE(&page);
        } else {
            zval_ptr_dtor(&page);
        }
    } else {
        cat_abort(db, &pdo);
    }
    zval_ptr_dtor(&pdo);
}

ZEND_METHOD(Polyspec_Orm_Catalog, rowSnapshotFromPage)
{
    zval *page;
    zend_long index;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(page, catalog_ce_table_page)
        Z_PARAM_LONG(index)
    ZEND_PARSE_PARAMETERS_END();
    zval rv_meta, rv_result, rv_limit, rv_offset, rv_order, rv_more, rv_rows, rv_cols, rv_pk;
    zval *metadata = catalog_prop(page, "metadata", &rv_meta);
    zval *result = catalog_prop(page, "result", &rv_result);
    zend_long limit = Z_LVAL_P(catalog_prop(page, "limit", &rv_limit));
    zend_long offset = Z_LVAL_P(catalog_prop(page, "offset", &rv_offset));
    zval *order_by = catalog_prop(page, "orderBy", &rv_order);
    bool has_more = Z_TYPE_P(catalog_prop(page, "hasMore", &rv_more)) == IS_TRUE;
    zval *rows = catalog_prop(result, "rows", &rv_rows);
    zval *columns = catalog_prop(result, "columns", &rv_cols);
    zval *pk = catalog_prop(metadata, "primaryKey", &rv_pk);
    zval *table = catalog_prop(metadata, "table", &rv_pk);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    if (ns == NULL || tname == NULL || Z_TYPE_P(ns) != IS_STRING || Z_TYPE_P(tname) != IS_STRING
        || !cat_name_ok(Z_STR_P(ns)) || !cat_name_ok(Z_STR_P(tname))) {
        cat_throw_descriptor_name();
        return;
    }
    if (limit < 1 || limit > 1000 || offset < 0 || offset > 1000000) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid page bounds");
        return;
    }
    zend_long count = zend_hash_num_elements(Z_ARRVAL_P(rows));
    if (count > limit || (has_more && count != limit) || zend_compare(order_by, pk) != 0) {
        db_throw_orm("ROW_SNAPSHOT_INVALID", "page rows or order do not match its bounds");
        return;
    }
    zval key_indexes;
    if (!cat_descriptor_keys(metadata, &key_indexes)) {
        return;
    }
    zval expected;
    cat_column_names(metadata, &expected);
    bool same = zend_compare(columns, &expected) == 0;
    zval_ptr_dtor(&expected);
    if (!same) {
        zval_ptr_dtor(&key_indexes);
        db_throw_orm("ROW_SNAPSHOT_INVALID", "projection differs from descriptor");
        return;
    }
    if (index < 0 || index >= count) {
        zval_ptr_dtor(&key_indexes);
        db_throw_orm("ROW_SNAPSHOT_INVALID", "row index %ld outside the page", (long)index);
        return;
    }
    zval *cells_src = zend_hash_index_find(Z_ARRVAL_P(rows), (zend_ulong)index);
    zval cells;
    ZVAL_COPY(&cells, cells_src);
    if (!cat_check_cells(metadata, &cells)) {
        zval_ptr_dtor(&cells);
        zval_ptr_dtor(&key_indexes);
        return;
    }
    zval revision;
    if (!cat_revision(metadata, &cells, &revision)) {
        zval_ptr_dtor(&cells);
        zval_ptr_dtor(&key_indexes);
        return;
    }
    zval snap_args[4];
    ZVAL_COPY(&snap_args[0], metadata);
    ZVAL_COPY_VALUE(&snap_args[1], &cells);
    ZVAL_COPY_VALUE(&snap_args[2], &key_indexes);
    ZVAL_COPY_VALUE(&snap_args[3], &revision);
    zval snapshot;
    bool made = newobj("Polyspec\\Orm\\CatalogRowSnapshot", &snapshot, 4, snap_args);
    zval_ptr_dtor(&snap_args[0]);
    zval_ptr_dtor(&cells);
    zval_ptr_dtor(&key_indexes);
    zval_ptr_dtor(&revision);
    if (made) {
        RETVAL_COPY_VALUE(&snapshot);
    }
}

/* The catalog values of one row of a read query: a MySQL or PostgreSQL date, time or datetime is the text of its grid cell
 * (INT-153), and any other value its plain conversion (Catalog::queryValue). */
static bool cat_query_row(zval *row, zval *types, const char *dialect, zval *cells)
{
    array_init(cells);
    zend_ulong i = 0;
    zval *value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), value) {
        zval *t = zend_hash_index_find(Z_ARRVAL_P(types), i++);
        zval v;
        if (t == NULL || Z_TYPE_P(t) != IS_STRING) {
            db_throw_orm("TABLE_METADATA_INVALID", "a column has no native type");
            zval_ptr_dtor(cells);
            return false;
        }
        if (Z_TYPE_P(value) != IS_NULL && cat_temporal_kind(dialect, Z_STRVAL_P(t)) != 0) {
            zval cell, rv;
            if (!cat_grid_pdo_cell(value, dialect, Z_STRVAL_P(t), false, &cell)) {
                zval_ptr_dtor(cells);
                return false;
            }
            ZVAL_COPY(&v, catalog_prop(&cell, "value", &rv));
            zval_ptr_dtor(&cell);
        } else if (!cat_cell_value(value, Z_STR_P(t), dialect, &v)) {
            zval_ptr_dtor(cells);
            return false;
        }
        add_next_index_zval(cells, &v);
    } ZEND_HASH_FOREACH_END();
    return true;
}

ZEND_METHOD(Polyspec_Orm_Catalog, readOnlyQuery)
{
    CAT_PARSE_READ_ONLY_INPUTS();
    zval pdo;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        zval_ptr_dtor(&args);
        return;
    }
    zval names, types, rows, converted, result;
    if (!cat_query(db, &pdo, ZSTR_VAL(sql), &args, max_rows, max_bytes, &names, &types, &rows, cat_query_row)) {
        zval_ptr_dtor(&args);
        cat_abort(db, &pdo);
        zval_ptr_dtor(&pdo);
        return;
    }
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&types);
    ZVAL_COPY_VALUE(&converted, &rows);
    bool ok = cat_named_result(&names, &converted, &result);
    zval_ptr_dtor(&names);
    zval_ptr_dtor(&converted);
    if (!ok) {
        cat_abort(db, &pdo);
        zval_ptr_dtor(&pdo);
        return;
    }
    if (cat_end_read(db, &pdo)) {
        RETVAL_COPY_VALUE(&result);
    } else {
        zval_ptr_dtor(&result);
    }
    zval_ptr_dtor(&pdo);
}

ZEND_METHOD(Polyspec_Orm_Catalog, readOnlyGridQuery)
{
    CAT_PARSE_READ_ONLY_INPUTS();
    zval sql_zv;
    ZVAL_STR_COPY(&sql_zv, sql);
    zval names, rows, result;
    bool ok;
    zval pdo;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        zval_ptr_dtor(&args);
        zval_ptr_dtor(&sql_zv);
        return;
    }
    ok = cat_grid_pdo(db, ZSTR_VAL(dialect), &pdo, &sql_zv, &args, max_rows, max_bytes, &names, &rows);
    zval_ptr_dtor(&args);
    zval_ptr_dtor(&sql_zv);
    if (ok) {
        ok = cat_named_result(&names, &rows, &result);
        zval_ptr_dtor(&names);
        zval_ptr_dtor(&rows);
    }
    if (ok) {
        if (cat_end_read(db, &pdo)) {
            RETVAL_COPY_VALUE(&result);
        } else {
            zval_ptr_dtor(&result);
        }
    } else {
        cat_abort(db, &pdo);
    }
    zval_ptr_dtor(&pdo);
}

#undef CAT_PARSE_READ_ONLY_INPUTS
