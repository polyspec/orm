/*
 * The catalog connection of SCH-6a (PHP Polyspec\Orm\Catalog). It follows the PHP client (packages/php/src/Catalog.php): the same
 * SQL, the same sessions and the same error codes. Connection setup is the PHP library's Orm::parseDsn and Orm::connect, which
 * build the PDO handle of the Db that the extension implements (db.c); the catalog operations are here.
 */
#include "dbspec.h"

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
    if (strcmp(dialect, "postgres") == 0) return "SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0),(a.attidentity<>''),pg_get_expr(d.adbin,d.adrelid),(d.adbin IS NOT NULL) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=? AND c.relname=? AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum";
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

/* A bounded result as the PHP client's query(): the names, the native type names (upper case) and the rows, all arrays the
 * caller releases. It fails with CATALOG_LIMIT when the rows or the bytes of values are over the budget. */
static bool cat_query(zval *db, zval *pdo, const char *sql, zval *args, zend_long max_rows, zend_long max_bytes,
                      zval *names, zval *types, zval *rows)
{
    array_init(names);
    array_init(types);
    array_init(rows);
    zval q, st, r;
    ZVAL_STRING(&q, sql);
    bool ok = pdo_call(pdo, "prepare", &st, 1, &q, NULL);
    zval_ptr_dtor(&q);
    if (!ok) goto driver;
    ok = pdo_call(&st, "execute", &r, 1, args, NULL);
    if (!ok) goto driver_st;
    zval_ptr_dtor(&r);
    zval count;
    ok = pdo_call(&st, "columnCount", &count, 0, NULL, NULL);
    if (!ok) goto driver_st;
    for (zend_long i = 0; i < Z_LVAL(count); i++) {
        zval index, meta;
        ZVAL_LONG(&index, i);
        ok = pdo_call(&st, "getColumnMeta", &meta, 1, &index, NULL);
        if (!ok) goto driver_st_count;
        zval *name = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "name", 4) : NULL;
        zval *native = Z_TYPE(meta) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL(meta), "native_type", 11) : NULL;
        add_next_index_str(names, name != NULL && Z_TYPE_P(name) == IS_STRING ? zend_string_copy(Z_STR_P(name)) : ZSTR_EMPTY_ALLOC());
        zend_string *type = native != NULL && Z_TYPE_P(native) == IS_STRING ? zend_string_toupper(Z_STR_P(native)) : ZSTR_EMPTY_ALLOC();
        add_next_index_str(types, type);
        zval_ptr_dtor(&meta);
    }
    zval_ptr_dtor(&count);
    zend_long budget = 0;
    for (;;) {
        zval mode, row;
        ZVAL_LONG(&mode, CAT_PDO_FETCH_NUM);
        ok = pdo_call(&st, "fetch", &row, 1, &mode, NULL);
        if (!ok) goto driver_st;
        if (Z_TYPE(row) == IS_FALSE) {
            break;
        }
        if (zend_hash_num_elements(Z_ARRVAL_P(rows)) == max_rows) {
            zval_ptr_dtor(&row);
            zval_ptr_dtor(&st);
            db_throw_orm("CATALOG_LIMIT", "result has more than %ld rows", (long)max_rows);
            return false;
        }
        zval *v;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(row), v) {
            budget += Z_TYPE_P(v) == IS_STRING ? (zend_long)Z_STRLEN_P(v) : 8;
        } ZEND_HASH_FOREACH_END();
        if (budget > max_bytes) {
            zval_ptr_dtor(&row);
            zval_ptr_dtor(&st);
            db_throw_orm("CATALOG_LIMIT", "result has more than %ld bytes of values", (long)max_bytes);
            return false;
        }
        add_next_index_zval(rows, &row);
    }
    zval_ptr_dtor(&st);
    return true;
driver_st_count:
    zval_ptr_dtor(&count);
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

/* An integer of a metadata row: a native integer, or text that holds one (Catalog::intValue). */
static bool cat_int(zval *v, zend_long *out)
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
    if (cat_try_exec(pdo, "ROLLBACK")) {
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
    if (cat_try_exec(pdo, "ROLLBACK")) {
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

static bool cat_cell_value(zval *v, zend_string *type, zval *out)
{
    if (Z_TYPE_P(v) != IS_STRING) {
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
        if (!cat_int(v, &n)) return false;
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
    ok = pdo_call(&st, "execute", &ok_ret, 1, args, NULL);
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
    if (!cat_query(db, pdo, cat_kind_sql(dialect), &args, 2, CAT_METADATA_BYTES, &kind_names, &kind_types, &kind_rows)) {
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
    if (!cat_query(db, pdo, cat_columns_sql(dialect), &col_args, CAT_METADATA_ROWS, CAT_METADATA_BYTES, &col_names, &col_types, &col_rows)) {
        zval_ptr_dtor(&col_args);
        return false;
    }
    zval_ptr_dtor(&col_names);
    zval_ptr_dtor(&col_types);

    ncols = zend_hash_num_elements(Z_ARRVAL(col_rows));
    cols = ecalloc(ncols ? ncols : 1, sizeof(cat_col));
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
                       &index_names, &index_types, &index_rows)) {
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
        zval cargs[7], column;
        ZVAL_STR_COPY(&cargs[0], col->name);
        ZVAL_STR_COPY(&cargs[1], col->type);
        ZVAL_BOOL(&cargs[2], col->nullable);
        ZVAL_BOOL(&cargs[3], col->generated);
        ZVAL_BOOL(&cargs[4], col->automatic);
        if (col->def) ZVAL_STR_COPY(&cargs[5], col->def); else ZVAL_NULL(&cargs[5]);
        ZVAL_BOOL(&cargs[6], col->expression);
        bool made = newobj("Polyspec\\Orm\\CatalogColumn", &column, 7, cargs);
        for (int a = 0; a < 7; a++) zval_ptr_dtor(&cargs[a]);
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
static bool cat_convert_rows(zval *rows, zval *types, zval *out)
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
            if (t == NULL || Z_TYPE_P(t) != IS_STRING || !cat_cell_value(cell, Z_STR_P(t), &v)) {
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
            db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: expected 1..1024 UTF-8 bytes without NUL");
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
    bool ok = cat_query(db, pdo, ZSTR_VAL(sql.s), &args, limit + 1, CAT_PAGE_BYTES, &names, &types, &rows);
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
    zval converted;
    ok = cat_convert_rows(&rows, &native_types, &converted);
    zval_ptr_dtor(&native_types);
    zval_ptr_dtor(&rows);
    if (!ok) {
        zval_ptr_dtor(&metadata);
        return false;
    }
    bool has_more = zend_hash_num_elements(Z_ARRVAL(converted)) > (uint32_t)limit;
    zval page_rows;
    array_init(&page_rows);
    zend_ulong taken = 0;
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL(converted), row) {
        if (taken == (zend_ulong)limit) break;
        Z_TRY_ADDREF_P(row);
        add_next_index_zval(&page_rows, row);
        taken++;
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

/* A date of the dbspec form YYYY-MM-DD from 0001-01-01 to 9999-12-31 (Catalog::dateText). */
static bool cat_date_text(const char *s, size_t n, zval *out)
{
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (n != 10 || s[4] != '-' || s[7] != '-') {
        cat_refuse("date is not YYYY-MM-DD");
        return false;
    }
    int y = 0, m = 0, d = 0;
    for (int i = 0; i < 10; i++) {
        if (i == 4 || i == 7) continue;
        if (!cat_digit(s[i])) {
            cat_refuse("date is not YYYY-MM-DD");
            return false;
        }
    }
    y = (s[0] - '0') * 1000 + (s[1] - '0') * 100 + (s[2] - '0') * 10 + (s[3] - '0');
    m = (s[5] - '0') * 10 + (s[6] - '0');
    d = (s[8] - '0') * 10 + (s[9] - '0');
    bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    int last = (m == 2 && leap) ? 29 : (m >= 1 && m <= 12 ? days[m - 1] : 0);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > last) {
        cat_refuse("date outside 0001-01-01 to 9999-12-31");
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
        cat_refuse("time is not a time of day");
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
            cat_refuse("time is not a time of day");
            return false;
        }
        p++;
        size_t fd = 0;
        while (p < n && cat_digit(s[p]) && fd < 6) { frac[fd++] = s[p++]; }
        if (fd == 0 || p != n) {
            cat_refuse("time is not a time of day");
            return false;
        }
    }
    if (h > 23 || mi > 59 || se > 59) {
        cat_refuse("time outside 00:00:00 to 23:59:59.999999");
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
        cat_refuse("datetime has no date and time");
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

/* A PDO grid cell: typed by the native type of its PostgreSQL column, or by the value that SQLite holds for it (cat_grid_pdo). */
static bool cat_grid_pdo_cell(zval *v, const char *dialect, const char *native, bool blob, zval *cell)
{
    zval kind, value;
    bool ok;
    ZVAL_NULL(&kind);
    ZVAL_NULL(&value);
    if (Z_TYPE_P(v) == IS_NULL) {
        ZVAL_STRING(&kind, "null");
        ZVAL_NULL(&value);
        ok = true;
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "FLOAT4") == 0) {
        ok = cat_float_cell(v, true, &kind, &value);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "FLOAT8") == 0) {
        ok = cat_float_cell(v, false, &kind, &value);
    } else if (strcmp(dialect, "postgres") == 0 && strcmp(native, "NUMERIC") == 0) {
        ZVAL_STRING(&kind, "decimal");
        ok = cat_grid_text(v, &value);
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

/* A MySQL grid cell from its mysqli field: the type, the UNSIGNED flag and the charset (MYSQLI_BINARY charset 63). */
static bool cat_grid_mysql_cell(zval *v, zend_long type, zend_long flags, zend_long charsetnr, zval *cell)
{
    zval kind, value;
    bool ok;
    ZVAL_NULL(&kind);
    ZVAL_NULL(&value);
    bool unsigned_ = (flags & 32) != 0; /* MYSQLI_UNSIGNED_FLAG */
    if (Z_TYPE_P(v) == IS_NULL) {
        ZVAL_STRING(&kind, "null");
        ZVAL_NULL(&value);
        ok = true;
    } else if (type == 4) { /* MYSQLI_TYPE_FLOAT */
        ok = cat_float_cell(v, true, &kind, &value);
    } else if (type == 5) { /* MYSQLI_TYPE_DOUBLE */
        ok = cat_float_cell(v, false, &kind, &value);
    } else if (type == 7) { /* MYSQLI_TYPE_TIMESTAMP */
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
    } else if (type == 1 || type == 2 || type == 3 || type == 8 || type == 9 || type == 13) { /* TINY SHORT LONG LONGLONG INT24 YEAR */
        ok = cat_integer_cell(v, unsigned_, &kind, &value);
    } else {
        ok = cat_bytes_or_text(v, charsetnr == 63, &kind, &value);
    }
    if (!ok) {
        zval_ptr_dtor(&kind);
        return false;
    }
    return cat_grid_cell_object(&kind, &value, cell);
}


/* Applies the same row and byte budget to every Catalog grid driver before converting its row. */
static bool cat_grid_budget(zval *rows, zval *row, zend_long max_rows, zend_long max_bytes, zend_long *budget)
{
    if (zend_hash_num_elements(Z_ARRVAL_P(rows)) == (uint32_t)max_rows) {
        zval_ptr_dtor(row);
        db_throw_orm("CATALOG_LIMIT", "result has more than %ld rows", (long)max_rows);
        return false;
    }
    zval *value;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), value) {
        *budget += Z_TYPE_P(value) == IS_STRING ? (zend_long)Z_STRLEN_P(value) : 8;
    } ZEND_HASH_FOREACH_END();
    if (*budget > max_bytes) {
        zval_ptr_dtor(row);
        db_throw_orm("CATALOG_LIMIT", "result has more than %ld bytes of values", (long)max_bytes);
        return false;
    }
    return true;
}

/* The PDO grid query of PostgreSQL and SQLite: one bounded statement, each cell typed by its column or by its value. */
static bool cat_grid_pdo(zval *db, const char *dialect, zval *pdo, zval *sql, zval *args, zend_long max_rows, zend_long max_bytes,
                         zval *names, zval *rows)
{
    array_init(names);
    array_init(rows);
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
        if (!cat_grid_budget(rows, &row, max_rows, max_bytes, &budget)) goto fail_natives;
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
        add_next_index_zval(rows, &cells);
    }
    for (zend_long i = 0; i < ncols; i++) zend_string_release(natives[i]);
    efree(natives);
    zval_ptr_dtor(&count);
    zval_ptr_dtor(&st);
    return true;
fail_natives:
    for (zend_long i = 0; i < ncols; i++) zend_string_release(natives[i]);
    efree(natives);
    zval_ptr_dtor(&count);
fail_st:
    zval_ptr_dtor(&st);
fail_names:
    zval_ptr_dtor(names);
    zval_ptr_dtor(rows);
    return false;
}

/* Takes the pending mysqli error as an OrmException (OrmException::fromMysqli); other pending errors are kept. */
static void cat_mysqli_error(void)
{
    if (EG(exception) == NULL || strcmp(ZSTR_VAL(EG(exception)->ce->name), "mysqli_sql_exception") != 0) {
        return;
    }
    zval ex, mapped;
    ZVAL_OBJ(&ex, EG(exception));
    EG(exception) = NULL;
    if (scall("Polyspec\\Orm\\OrmException::fromMysqli", &mapped, 1, &ex)) {
        zend_throw_exception_object(&mapped);
    }
    zval_ptr_dtor(&ex);
}

/* Ends a failed mysqli grid query: ROLLBACK, the cause stays the pending error, and a failed rollback is OrmException::rollback. */
static void cat_mysqli_abort(zval *link)
{
    cat_mysqli_error();
    zval cause;
    ZVAL_OBJ(&cause, EG(exception));
    EG(exception) = NULL;
    zval ret;
    if (pdo_call(link, "rollback", &ret, 0, NULL, NULL)) {
        zval_ptr_dtor(&ret);
        EG(exception) = Z_OBJ(cause);
        return;
    }
    cat_mysqli_error();
    zval rollback_error;
    ZVAL_OBJ(&rollback_error, EG(exception));
    EG(exception) = NULL;
    zval args[2], rolled;
    ZVAL_COPY_VALUE(&args[0], &cause);
    ZVAL_COPY_VALUE(&args[1], &rollback_error);
    if (scall("Polyspec\\Orm\\OrmException::rollback", &rolled, 2, args)) {
        zend_throw_exception_object(&rolled);
    }
    zval_ptr_dtor(&cause);
    zval_ptr_dtor(&rollback_error);
}

/* The MySQL grid query on the grid connection: one read-only transaction, a prepared statement, and the flags of its fields. */
static bool cat_grid_mysqli(zval *link, zval *sql, zval *args, zend_long max_rows, zend_long max_bytes, zval *names, zval *rows)
{
    array_init(names);
    array_init(rows);
    zval ret, flag, stmt, result, fields;
    ZVAL_LONG(&flag, 4); /* MYSQLI_TRANS_START_READ_ONLY */
    if (!pdo_call(link, "begin_transaction", &ret, 1, &flag, NULL)) goto abort;
    zval_ptr_dtor(&ret);
    if (!pdo_call(link, "prepare", &stmt, 1, sql, NULL)) goto abort;
    uint32_t nargs = zend_hash_num_elements(Z_ARRVAL_P(args));
    if (nargs > 0) {
        zval *bind = ecalloc(nargs + 1, sizeof(zval));
        smart_str types = {0};
        zval *a;
        uint32_t k = 1;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(args), a) {
            switch (Z_TYPE_P(a)) {
            case IS_LONG: case IS_TRUE: case IS_FALSE: smart_str_appendc(&types, 'i'); break;
            case IS_DOUBLE: smart_str_appendc(&types, 'd'); break;
            default: smart_str_appendc(&types, 's'); break;
            }
            ZVAL_COPY(&bind[k++], a);
        } ZEND_HASH_FOREACH_END();
        smart_str_0(&types);
        ZVAL_STR(&bind[0], types.s);
        bool bound = cat_call_n(&stmt, "bind_param", &ret, nargs + 1, bind);
        for (uint32_t j = 0; j <= nargs; j++) zval_ptr_dtor(&bind[j]);
        efree(bind);
        if (!bound) goto abort;
        zval_ptr_dtor(&ret);
    }
    if (!pdo_call(&stmt, "execute", &ret, 0, NULL, NULL)) goto abort_stmt;
    zval_ptr_dtor(&ret);
    if (!pdo_call(&stmt, "get_result", &result, 0, NULL, NULL)) goto abort_stmt;
    if (Z_TYPE(result) != IS_OBJECT) {
        zval_ptr_dtor(&result);
        db_throw_orm("DRIVER", "the grid query returned no result set");
        goto abort_stmt;
    }
    if (!pdo_call(&result, "fetch_fields", &fields, 0, NULL, NULL)) goto abort_result;
    uint32_t nfields = zend_hash_num_elements(Z_ARRVAL(fields));
    for (uint32_t i = 0; i < nfields; i++) {
        zval *field = zend_hash_index_find(Z_ARRVAL(fields), i);
        zval rv, *name = catalog_prop(field, "name", &rv);
        add_next_index_str(names, zend_string_copy(Z_STR_P(name)));
    }
    zend_long budget = 0;
    for (;;) {
        zval row;
        if (!pdo_call(&result, "fetch_row", &row, 0, NULL, NULL)) goto abort_fields;
        if (Z_TYPE(row) == IS_NULL) break;
        if (!cat_grid_budget(rows, &row, max_rows, max_bytes, &budget)) goto abort_fields;
        zval cells;
        array_init(&cells);
        zend_ulong i = 0;
        zval *value;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL(row), value) {
            zval *field = zend_hash_index_find(Z_ARRVAL(fields), i);
            zval r1, r2, r3, *type_v, *flags_v, *cs_v;
            type_v = catalog_prop(field, "type", &r1);
            flags_v = catalog_prop(field, "flags", &r2);
            cs_v = catalog_prop(field, "charsetnr", &r3);
            zval cell;
            if (!cat_grid_mysql_cell(value, Z_LVAL_P(type_v), Z_LVAL_P(flags_v), Z_LVAL_P(cs_v), &cell)) {
                zval_ptr_dtor(&cells);
                zval_ptr_dtor(&row);
                goto abort_fields;
            }
            add_next_index_zval(&cells, &cell);
            i++;
        } ZEND_HASH_FOREACH_END();
        zval_ptr_dtor(&row);
        add_next_index_zval(rows, &cells);
    }
    zval_ptr_dtor(&fields);
    zval_ptr_dtor(&result);
    zval_ptr_dtor(&stmt);
    zval_ptr_dtor(&ret);
    if (!pdo_call(link, "commit", &ret, 0, NULL, NULL)) {
        cat_mysqli_error();
        zval_ptr_dtor(names);
        zval_ptr_dtor(rows);
        return false;
    }
    zval_ptr_dtor(&ret);
    return true;
abort_fields:
    zval_ptr_dtor(&fields);
abort_result:
    zval_ptr_dtor(&result);
abort_stmt:
    zval_ptr_dtor(&stmt);
abort:
    cat_mysqli_abort(link);
    zval_ptr_dtor(names);
    zval_ptr_dtor(rows);
    return false;
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
    if (cat_try_exec(pdo, "ROLLBACK")) {
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
    /* The outcome is unknown: the transaction is ended, and a failed ROLLBACK becomes the cause of the error. */
    zval cause = mapped;
    zend_string *text = zend_strpprintf(0, "commit outcome unknown; do not retry: %s", Z_STRVAL(message));
    if (!cat_try_exec(pdo, "ROLLBACK")) {
        zval rb_native, rb_mapped, rb_message;
        ZVAL_OBJ(&rb_native, EG(exception));
        EG(exception) = NULL;
        if (pdo_call(db, "driverError", &rb_mapped, 1, &rb_native, NULL) && pdo_call(&rb_mapped, "getMessage", &rb_message, 0, NULL, NULL)) {
            zend_string *joined = zend_strpprintf(0, "%s; rollback failed: %s", ZSTR_VAL(text), Z_STRVAL(rb_message));
            zend_string_release(text);
            text = joined;
            zval_ptr_dtor(&cause);
            ZVAL_COPY_VALUE(&cause, &rb_mapped);
            zval_ptr_dtor(&rb_message);
        } else {
            zval_ptr_dtor(&rb_mapped);
        }
        zval_ptr_dtor(&rb_native);
    }
    zval args[3], unknown;
    ZVAL_STRING(&args[0], "ROW_COMMIT_INDETERMINATE");
    ZVAL_STR(&args[1], text);
    ZVAL_COPY_VALUE(&args[2], &cause);
    if (newobj("Polyspec\\Orm\\OrmException", &unknown, 3, args)) {
        zend_throw_exception_object(&unknown);
    }
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&cause);
    zval_ptr_dtor(&message);
    return false;
}

/* Runs one bounded query with the values of a PHP array as parameters (a mysql safety check). */
static bool cat_query_params(zval *db, zval *pdo, const char *sql, zval *args, zend_long max_rows, zval *rows)
{
    zval names, types;
    if (!cat_query(db, pdo, sql, args, max_rows, CAT_METADATA_BYTES, &names, &types, rows)) {
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

/* The primary-key lookup of a descriptor: at most two rows, locked where the server locks (Catalog::lookup). */
static bool cat_lookup(zval *db, const char *dialect, zval *pdo, zval *metadata, zval *keys, bool lock, zval *rows)
{
    zval rv_pk, rv_table, rv_cols;
    zval *pk = catalog_prop(metadata, "primaryKey", &rv_pk);
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
    smart_str_appends(&sql, " WHERE ");
    first = true;
    zval *key;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), key) {
        if (!first) smart_str_appends(&sql, " AND ");
        first = false;
        cat_quote(&sql, Z_STR_P(key), dialect);
        smart_str_appends(&sql, "=?");
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&sql, " LIMIT 2");
    if (lock && strcmp(dialect, "sqlite") != 0) {
        smart_str_appends(&sql, " FOR UPDATE");
    }
    smart_str_0(&sql);
    zval got_names, got_types, raw;
    bool ok = cat_query(db, pdo, ZSTR_VAL(sql.s), keys, 2, CAT_PAGE_BYTES, &got_names, &got_types, &raw);
    smart_str_free(&sql);
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
    ok = cat_convert_rows(&raw, &native_types, rows);
    zval_ptr_dtor(&raw);
    zval_ptr_dtor(&native_types);
    return ok;
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
static bool cat_changes(zval *metadata, zval *values, const char *code, zval *out)
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
    if (!cat_query(db, pdo, sql, args, 2, CAT_PAGE_BYTES, &names, &types, &raw)) return false;
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
    bool ok = cat_convert_rows(&raw, &types, rows);
    zval_ptr_dtor(&types);
    zval_ptr_dtor(&raw);
    return ok;
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
        bool locked = cat_query(db, pdo, ZSTR_VAL(lock.s), &none, 1, CAT_PAGE_BYTES, &names, &types, &rows);
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
        bool first_predicate = true;
        zval *pair;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
            zend_long index = Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0));
            zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
            zval nrv, *name = catalog_prop(zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)index), "name", &nrv);
            if (!first_predicate) smart_str_appends(&locator_sql, " AND ");
            first_predicate = false;
            cat_quote(&locator_sql, Z_STR_P(name), dialect);
            if (Z_TYPE_P(value) == IS_NULL) {
                smart_str_appends(&locator_sql, " IS NULL");
            } else {
                smart_str_appends(&locator_sql, "=?");
                Z_TRY_ADDREF_P(value);
                add_next_index_zval(&locator_args, value);
            }
        } ZEND_HASH_FOREACH_END();
        if (first_predicate) smart_str_appends(&locator_sql, "1=1");
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
        bool first = true;
        zval *pair;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
            zend_long index = Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0));
            zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
            zval nrv, *name = catalog_prop(zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)index), "name", &nrv);
            if (!first) smart_str_appendc(&sql, ',');
            first = false;
            cat_quote(&sql, Z_STR_P(name), dialect);
            Z_TRY_ADDREF_P(value);
            add_next_index_zval(&args, value);
        } ZEND_HASH_FOREACH_END();
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
    zval pdo;
    ZVAL_UNDEF(&pdo);
    zval rv_db;
    zval *db = cat_db(ZEND_THIS, &rv_db);
    zval result;
    if (cat_begin_write(db, ZSTR_VAL(dialect), &pdo)) {
        bool ok = cat_insert_body(db, ZSTR_VAL(dialect), &pdo, declared, &changes, &keys,
                                  &generated_key_indexes, &result);
        if (ok) {
            if (cat_commit(db, &pdo)) {
                RETVAL_COPY_VALUE(&result);
            } else {
                zval_ptr_dtor(&result);
            }
        } else {
            cat_abort(db, &pdo);
        }
        zval_ptr_dtor(&pdo);
    }
    zval_ptr_dtor(&keys);
    zval_ptr_dtor(&generated_key_indexes);
    zval_ptr_dtor(&changes);
    zval_ptr_dtor(&key_indexes);
}

/* Locks and validates the original snapshot before either mutation path writes its row. */
static bool cat_locked_original(zval *db, const char *dialect, zval *pdo, zval *original, zval *keys, zval *descriptor)
{
    zval rv_m, *metadata = catalog_prop(original, "metadata", &rv_m);
    zval rv_t, *table = catalog_prop(metadata, "table", &rv_t);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    zval current;
    if (!cat_lookup(db, dialect, pdo, metadata, keys, true, &current)) return false;
    if (!cat_describe(db, dialect, pdo, Z_STR_P(ns), Z_STR_P(tname), descriptor)) {
        zval_ptr_dtor(&current);
        return false;
    }
    if (zend_compare(descriptor, metadata) != 0) {
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

static bool cat_update_body(zval *db, const char *dialect, zval *pdo, zval *original, zval *changes, zval *updated, zval *keys,
                            zval *new_keys, zval *out)
{
    zval rv_m, *metadata = catalog_prop(original, "metadata", &rv_m);
    zval rv_t, *table = catalog_prop(metadata, "table", &rv_t);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    zval descriptor;
    if (!cat_locked_original(db, dialect, pdo, original, keys, &descriptor)) return false;
    zval rv_cols, *columns = catalog_prop(&descriptor, "columns", &rv_cols);
    smart_str sql = {0};
    smart_str_appends(&sql, "UPDATE ");
    cat_quote(&sql, Z_STR_P(ns), dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, Z_STR_P(tname), dialect);
    smart_str_appends(&sql, " SET ");
    zval args;
    array_init(&args);
    bool first = true;
    zval *pair;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(changes), pair) {
        zend_long index = Z_LVAL_P(zend_hash_index_find(Z_ARRVAL_P(pair), 0));
        zval *value = zend_hash_index_find(Z_ARRVAL_P(pair), 1);
        zval nrv, *name = catalog_prop(zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong)index), "name", &nrv);
        if (!first) smart_str_appendc(&sql, ',');
        first = false;
        cat_quote(&sql, Z_STR_P(name), dialect);
        smart_str_appends(&sql, "=?");
        Z_TRY_ADDREF_P(value);
        add_next_index_zval(&args, value);
    } ZEND_HASH_FOREACH_END();
    smart_str_appends(&sql, " WHERE ");
    first = true;
    zval *key;
    zval rv_pk, *pk = catalog_prop(metadata, "primaryKey", &rv_pk);
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), key) {
        if (!first) smart_str_appends(&sql, " AND ");
        first = false;
        cat_quote(&sql, Z_STR_P(key), dialect);
        smart_str_appends(&sql, "=?");
    } ZEND_HASH_FOREACH_END();
    zval *k;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(keys), k) {
        Z_TRY_ADDREF_P(k);
        add_next_index_zval(&args, k);
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&sql);
    zend_long affected = 0;
    bool ok = cat_exec(db, pdo, ZSTR_VAL(sql.s), &args, &affected);
    smart_str_free(&sql);
    zval_ptr_dtor(&args);
    if (!ok) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    if (affected > 1 || (affected == 0 && strcmp(dialect, "mysql") != 0)) {
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_WRITE_MISMATCH", "unexpected affected row count %ld", (long)affected);
        return false;
    }
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
    if (!cat_descriptor_unchanged(db, dialect, pdo, ns, tname, &descriptor)) {
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
    ok = cat_result(&descriptor, &after, out);
    zval_ptr_dtor(&after);
    zval_ptr_dtor(&descriptor);
    return ok;
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
    zval pdo;
    ZVAL_UNDEF(&pdo);
    zval rv_db;
    zval *db = cat_db(ZEND_THIS, &rv_db);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zval result;
    if (cat_begin_write(db, ZSTR_VAL(dialect), &pdo)) {
        bool ok = cat_update_body(db, ZSTR_VAL(dialect), &pdo, original, &changes, &updated, &keys, &new_keys, &result);
        if (ok) {
            if (cat_commit(db, &pdo)) {
                RETVAL_COPY_VALUE(&result);
            } else {
                zval_ptr_dtor(&result);
            }
        } else {
            cat_abort(db, &pdo);
        }
        zval_ptr_dtor(&pdo);
    }
    zval_ptr_dtor(&keys);
    zval_ptr_dtor(&new_keys);
    zval_ptr_dtor(&updated);
    zval_ptr_dtor(&changes);
}

static bool cat_delete_body(zval *db, const char *dialect, zval *pdo, zval *original, zval *keys, zend_long *affected_out)
{
    zval rv_m, *metadata = catalog_prop(original, "metadata", &rv_m);
    zval rv_t, *table = catalog_prop(metadata, "table", &rv_t);
    zval *ns = zend_hash_str_find(Z_ARRVAL_P(table), "namespace", 9);
    zval *tname = zend_hash_str_find(Z_ARRVAL_P(table), "name", 4);
    zval descriptor;
    if (!cat_locked_original(db, dialect, pdo, original, keys, &descriptor)) return false;
    smart_str sql = {0};
    smart_str_appends(&sql, "DELETE FROM ");
    cat_quote(&sql, Z_STR_P(ns), dialect);
    smart_str_appendc(&sql, '.');
    cat_quote(&sql, Z_STR_P(tname), dialect);
    smart_str_appends(&sql, " WHERE ");
    zval rv_pk, *pk = catalog_prop(metadata, "primaryKey", &rv_pk);
    bool first = true;
    zval *key;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(pk), key) {
        if (!first) smart_str_appends(&sql, " AND ");
        first = false;
        cat_quote(&sql, Z_STR_P(key), dialect);
        smart_str_appends(&sql, "=?");
    } ZEND_HASH_FOREACH_END();
    smart_str_0(&sql);
    zend_long affected = 0;
    bool ok = cat_exec(db, pdo, ZSTR_VAL(sql.s), keys, &affected);
    smart_str_free(&sql);
    if (!ok) {
        zval_ptr_dtor(&descriptor);
        return false;
    }
    if (affected != 1) {
        zval_ptr_dtor(&descriptor);
        db_throw_orm("ROW_WRITE_MISMATCH", "expected exactly one deleted row, got %ld", (long)affected);
        return false;
    }
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
    bool unchanged = cat_descriptor_unchanged(db, dialect, pdo, ns, tname, &descriptor);
    zval_ptr_dtor(&descriptor);
    if (!unchanged) {
        return false;
    }
    *affected_out = affected;
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
    zval pdo;
    ZVAL_UNDEF(&pdo);
    zval rv_db;
    zval *db = cat_db(ZEND_THIS, &rv_db);
    zend_string *dialect = cat_dialect(ZEND_THIS);
    zend_long affected = 0;
    if (cat_begin_write(db, ZSTR_VAL(dialect), &pdo)) {
        bool ok = cat_delete_body(db, ZSTR_VAL(dialect), &pdo, original, &keys, &affected);
        if (ok) {
            if (cat_commit(db, &pdo)) {
                RETVAL_LONG(affected);
            }
        } else {
            cat_abort(db, &pdo);
        }
        zval_ptr_dtor(&pdo);
    }
    zval_ptr_dtor(&keys);
}

/* ---- the methods of Polyspec\Orm\Catalog ----------------------------------------------------------------------------------- */


/* The MySQL target of the grid connection, read from the DSN (Catalog::mysqlTarget). */
static bool cat_mysql_target(zend_string *dsn, zval *parsed, zval *out)
{
    zval arg, parts;
    ZVAL_STR_COPY(&arg, dsn);
    bool ok = scall("parse_url", &parts, 1, &arg);
    zval_ptr_dtor(&arg);
    if (!ok || Z_TYPE(parts) != IS_ARRAY) {
        zval_ptr_dtor(&parts);
        db_throw_orm("CONFIG", "invalid DSN URI");
        return false;
    }
    zval *query = zend_hash_str_find(Z_ARRVAL(parts), "query", 5);
    zval socket;
    ZVAL_NULL(&socket);
    if (query != NULL && Z_TYPE_P(query) == IS_STRING) {
        const char *p = Z_STRVAL_P(query);
        size_t n = Z_STRLEN_P(query);
        size_t start = 0;
        for (size_t i = 0; i <= n; i++) {
            if (i < n && p[i] != '&') continue;
            const char *pair = p + start;
            size_t plen = i - start;
            const char *eq = memchr(pair, '=', plen);
            size_t klen = eq ? (size_t)(eq - pair) : plen;
            if (klen == 6 && memcmp(pair, "socket", 6) == 0 && eq != NULL) {
                zval raw, decoded, dargs[1];
                ZVAL_STRINGL(&raw, eq + 1, plen - klen - 1);
                ZVAL_COPY_VALUE(&dargs[0], &raw);
                if (scall("urldecode", &decoded, 1, dargs)) {
                    zval_ptr_dtor(&socket);
                    ZVAL_COPY_VALUE(&socket, &decoded);
                }
                zval_ptr_dtor(&raw);
            }
            start = i + 1;
        }
    }
    array_init(out);
    zval *host = zend_hash_str_find(Z_ARRVAL(parts), "host", 4);
    zval *port = zend_hash_str_find(Z_ARRVAL(parts), "port", 4);
    zval *user = zend_hash_str_find(Z_ARRVAL(parts), "user", 4);
    zval *pass = zend_hash_str_find(Z_ARRVAL(parts), "pass", 4);
    zval *path = zend_hash_str_find(Z_ARRVAL(parts), "path", 4);
    if (host != NULL && Z_TYPE_P(host) == IS_STRING) add_assoc_str(out, "host", zend_string_copy(Z_STR_P(host)));
    else add_assoc_null(out, "host");
    add_assoc_long(out, "port", port != NULL && Z_TYPE_P(port) == IS_LONG ? Z_LVAL_P(port) : 3306);
    zval raw_user, raw_pass, decoded;
    if (user != NULL && Z_TYPE_P(user) == IS_STRING) ZVAL_COPY(&raw_user, user); else ZVAL_EMPTY_STRING(&raw_user);
    if (scall("rawurldecode", &decoded, 1, &raw_user)) { add_assoc_zval(out, "user", &decoded); }
    if (pass != NULL && Z_TYPE_P(pass) == IS_STRING) ZVAL_COPY(&raw_pass, pass); else ZVAL_EMPTY_STRING(&raw_pass);
    if (scall("rawurldecode", &decoded, 1, &raw_pass)) { add_assoc_zval(out, "password", &decoded); }
    zval_ptr_dtor(&raw_user);
    zval_ptr_dtor(&raw_pass);
    const char *db_path = path != NULL && Z_TYPE_P(path) == IS_STRING ? Z_STRVAL_P(path) : "";
    size_t db_len = path != NULL && Z_TYPE_P(path) == IS_STRING ? Z_STRLEN_P(path) : 0;
    while (db_len > 0 && *db_path == '/') { db_path++; db_len--; }
    add_assoc_stringl(out, "database", db_path, db_len);
    add_assoc_zval(out, "socket", &socket);
    zval *ssl_ca = zend_hash_index_find(Z_ARRVAL_P(parsed), 5);
    if (ssl_ca != NULL && Z_TYPE_P(ssl_ca) == IS_STRING) {
        add_assoc_str(out, "sslCa", zend_string_copy(Z_STR_P(ssl_ca)));
    } else {
        add_assoc_null(out, "sslCa");
    }
    zval_ptr_dtor(&parts);
    return true;
}

static bool cat_constant_long(const char *name, zend_long *value)
{
    zval arg, result;
    ZVAL_STRING(&arg, name);
    bool ok = scall("constant", &result, 1, &arg);
    zval_ptr_dtor(&arg);
    if (!ok) return false;
    if (Z_TYPE(result) != IS_LONG) {
        zval_ptr_dtor(&result);
        db_throw_orm("CONFIG", "mysqli constant %s is not an integer", name);
        return false;
    }
    *value = Z_LVAL(result);
    zval_ptr_dtor(&result);
    return true;
}

/* The MySQL grid connection of a catalog: a mysqli connection opened on first use with the target of the DSN. */
static bool cat_grid_link(zval *self, zval *link)
{
    zval rv, *current = catalog_prop(self, "gridLink", &rv);
    if (Z_TYPE_P(current) == IS_OBJECT) {
        ZVAL_COPY(link, current);
        return true;
    }
    zval rv_t, *target = catalog_prop(self, "mysqlTarget", &rv_t);
    if (Z_TYPE_P(target) != IS_ARRAY) {
        db_throw_orm("CONFIG", "the catalog connection has no MySQL target");
        return false;
    }
    zval *host = zend_hash_str_find(Z_ARRVAL_P(target), "host", 4);
    zval *port = zend_hash_str_find(Z_ARRVAL_P(target), "port", 4);
    zval *user = zend_hash_str_find(Z_ARRVAL_P(target), "user", 4);
    zval *password = zend_hash_str_find(Z_ARRVAL_P(target), "password", 8);
    zval *database = zend_hash_str_find(Z_ARRVAL_P(target), "database", 8);
    zval *socket = zend_hash_str_find(Z_ARRVAL_P(target), "socket", 6);
    zval *ssl_ca = zend_hash_str_find(Z_ARRVAL_P(target), "sslCa", 6);
    zval made, ret, charset, time_zone;
    ZVAL_UNDEF(&made);
    bool ok = scall("mysqli_init", &made, 0, NULL);
    if (!ok) goto failed;
    zend_long flags = 0;
    if (ssl_ca != NULL && Z_TYPE_P(ssl_ca) == IS_STRING) {
        zval ssl_args[6], ssl_ret;
        ZVAL_COPY(&ssl_args[0], &made);
        ZVAL_NULL(&ssl_args[1]);
        ZVAL_NULL(&ssl_args[2]);
        ZVAL_COPY(&ssl_args[3], ssl_ca);
        ZVAL_NULL(&ssl_args[4]);
        ZVAL_NULL(&ssl_args[5]);
        ok = scall("mysqli_ssl_set", &ssl_ret, 6, ssl_args);
        for (int i = 0; i < 6; i++) zval_ptr_dtor(&ssl_args[i]);
        if (ok) zval_ptr_dtor(&ssl_ret);
        if (!ok) goto failed;
        zend_long verify_option;
        if (!cat_constant_long("MYSQLI_OPT_SSL_VERIFY_SERVER_CERT", &verify_option)
            || !cat_constant_long("MYSQLI_CLIENT_SSL", &flags)) {
            goto failed;
        }
        zval option_args[3], option_ret;
        ZVAL_COPY(&option_args[0], &made);
        ZVAL_LONG(&option_args[1], verify_option);
        ZVAL_LONG(&option_args[2], 1);
        ok = scall("mysqli_options", &option_ret, 3, option_args);
        zval_ptr_dtor(&option_args[0]);
        zval_ptr_dtor(&option_args[1]);
        zval_ptr_dtor(&option_args[2]);
        if (ok) zval_ptr_dtor(&option_ret);
        if (!ok) goto failed;
    }
    zval connect_args[8], connect_ret;
    ZVAL_COPY(&connect_args[0], &made);
    if (host != NULL && Z_TYPE_P(host) == IS_STRING) ZVAL_COPY(&connect_args[1], host); else ZVAL_STRING(&connect_args[1], "localhost");
    ZVAL_COPY(&connect_args[2], user);
    ZVAL_COPY(&connect_args[3], password);
    ZVAL_COPY(&connect_args[4], database);
    ZVAL_COPY(&connect_args[5], port);
    ZVAL_COPY(&connect_args[6], socket);
    ZVAL_LONG(&connect_args[7], flags);
    ok = scall("mysqli_real_connect", &connect_ret, 8, connect_args);
    for (int i = 0; i < 8; i++) zval_ptr_dtor(&connect_args[i]);
    if (!ok) goto failed;
    if (Z_TYPE(connect_ret) == IS_FALSE) {
        zval_ptr_dtor(&connect_ret);
        db_throw_orm("DRIVER", "the MySQL grid connection failed");
        goto failed;
    }
    zval_ptr_dtor(&connect_ret);
    ZVAL_STRING(&charset, "utf8mb4");
    ok = pdo_call(&made, "set_charset", &ret, 1, &charset, NULL);
    zval_ptr_dtor(&charset);
    if (!ok) {
        cat_mysqli_error();
        zval_ptr_dtor(&made);
        return false;
    }
    zval_ptr_dtor(&ret);
    ZVAL_STRING(&time_zone, "SET time_zone = '+00:00'");
    ok = pdo_call(&made, "query", &ret, 1, &time_zone, NULL);
    zval_ptr_dtor(&time_zone);
    if (!ok) {
        cat_mysqli_error();
        zval_ptr_dtor(&made);
        return false;
    }
    zval_ptr_dtor(&ret);
    init_prop(self, "gridLink", &made);
    ZVAL_COPY(link, &made);
    zval_ptr_dtor(&made);
    return true;

failed:
    cat_mysqli_error();
    if (Z_TYPE(made) == IS_OBJECT) zval_ptr_dtor(&made);
    return false;
}

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
    zval target;
    if (strcmp(Z_STRVAL_P(driver), "mysql") == 0) {
        if (!cat_mysql_target(dsn, &parsed, &target)) {
            goto out_parsed;
        }
    } else {
        ZVAL_NULL(&target);
    }
    if (!newobj("Polyspec\\Orm\\Config", &config, 0, NULL)) {
        zval_ptr_dtor(&target);
        goto out_parsed;
    }
    ZVAL_COPY_VALUE(&connect_args[0], &dsn_arg);
    ZVAL_COPY_VALUE(&connect_args[1], &config);
    bool connected = scall("Polyspec\\Orm\\Orm::connect", &db, 2, connect_args);
    zval_ptr_dtor(&config);
    if (!connected) {
        zval_ptr_dtor(&target);
        goto out_parsed;
    }
    object_init_ex(return_value, catalog_ce);
    init_prop(return_value, "db", &db);
    init_str(return_value, "dialect", zend_string_copy(Z_STR_P(driver)));
    init_prop(return_value, "mysqlTarget", &target);
    zval no_link;
    ZVAL_NULL(&no_link);
    init_prop(return_value, "gridLink", &no_link);
    zval_ptr_dtor(&target);
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
    zval rv, ret, rv_link;
    zend_object *grid_error = NULL;
    zend_object *db_error = NULL;
    zval *link = catalog_prop(ZEND_THIS, "gridLink", &rv_link);
    if (Z_TYPE_P(link) == IS_OBJECT) {
        if (pdo_call(link, "close", &ret, 0, NULL, NULL)) {
            zval_ptr_dtor(&ret);
        } else if (EG(exception) != NULL) {
            grid_error = EG(exception);
            EG(exception) = NULL;
        }
        zval no_link;
        ZVAL_NULL(&no_link);
        init_prop(ZEND_THIS, "gridLink", &no_link);
    }
    zval *db = catalog_prop(ZEND_THIS, "db", &rv);
    if (pdo_call(db, "close", &ret, 0, NULL, NULL)) {
        zval_ptr_dtor(&ret);
    } else if (EG(exception) != NULL) {
        db_error = EG(exception);
        EG(exception) = NULL;
    }
    if (grid_error != NULL && db_error != NULL) {
        zval args[2], combined;
        ZVAL_OBJ(&args[0], grid_error);
        ZVAL_OBJ(&args[1], db_error);
        if (scall("Polyspec\\Orm\\OrmException::withCleanup", &combined, 2, args)) {
            zend_throw_exception_object(&combined);
        }
        OBJ_RELEASE(grid_error);
        OBJ_RELEASE(db_error);
    } else if (grid_error != NULL) {
        zval error;
        ZVAL_OBJ(&error, grid_error);
        zend_throw_exception_object(&error);
    } else if (db_error != NULL) {
        zval error;
        ZVAL_OBJ(&error, db_error);
        zend_throw_exception_object(&error);
    }
}

ZEND_METHOD(Polyspec_Orm_Catalog, currentNamespace)
{
    ZEND_PARSE_PARAMETERS_START(0, 0)
    ZEND_PARSE_PARAMETERS_END();
    zval rv;
    zend_string *dialect = cat_dialect(ZEND_THIS);
    if (strcmp(ZSTR_VAL(dialect), "sqlite") == 0) {
        RETURN_STRING("main");
    }
    if (!cat_open(ZEND_THIS)) return;
    zval *db = cat_db(ZEND_THIS, &rv);
    const char *query = strcmp(ZSTR_VAL(dialect), "postgres") == 0 ? "SELECT current_schema()" : "SELECT DATABASE()";
    zval pdo, empty, names, types, rows;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        return;
    }
    array_init(&empty);
    bool ok = cat_query(db, &pdo, query, &empty, 2, CAT_METADATA_BYTES, &names, &types, &rows);
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
        db_throw_orm("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: expected 1..1024 UTF-8 bytes without NUL");
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

ZEND_METHOD(Polyspec_Orm_Catalog, readOnlyQuery)
{
    zend_string *sql;
    zval *params = NULL;
    zend_long max_rows = 0, max_bytes = 0;
    ZEND_PARSE_PARAMETERS_START(1, 4)
        Z_PARAM_STR(sql)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(params)
        Z_PARAM_LONG(max_rows)
        Z_PARAM_LONG(max_bytes)
    ZEND_PARSE_PARAMETERS_END();
    zval rv;
    zval *db;
    zend_string *dialect;
    zval args;
    if (!cat_read_only_inputs(ZEND_THIS, sql, params, &max_rows, &max_bytes, &rv, &db, &dialect, &args)) return;
    zval pdo;
    ZVAL_UNDEF(&pdo);
    if (!cat_begin_read(db, ZSTR_VAL(dialect), &pdo)) {
        zval_ptr_dtor(&args);
        return;
    }
    zval names, types, rows, converted, result;
    if (!cat_query(db, &pdo, ZSTR_VAL(sql), &args, max_rows, max_bytes, &names, &types, &rows)) {
        zval_ptr_dtor(&args);
        cat_abort(db, &pdo);
        zval_ptr_dtor(&pdo);
        return;
    }
    zval_ptr_dtor(&args);
    bool ok = cat_convert_rows(&rows, &types, &converted);
    zval_ptr_dtor(&rows);
    zval_ptr_dtor(&types);
    if (!ok) {
        zval_ptr_dtor(&names);
        cat_abort(db, &pdo);
        zval_ptr_dtor(&pdo);
        return;
    }
    ok = cat_named_result(&names, &converted, &result);
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
    zend_string *sql;
    zval *params = NULL;
    zend_long max_rows = 0, max_bytes = 0;
    ZEND_PARSE_PARAMETERS_START(1, 4)
        Z_PARAM_STR(sql)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(params)
        Z_PARAM_LONG(max_rows)
        Z_PARAM_LONG(max_bytes)
    ZEND_PARSE_PARAMETERS_END();
    zval rv;
    zval *db;
    zend_string *dialect;
    zval args;
    if (!cat_read_only_inputs(ZEND_THIS, sql, params, &max_rows, &max_bytes, &rv, &db, &dialect, &args)) return;
    zval sql_zv;
    ZVAL_STR_COPY(&sql_zv, sql);
    zval names, rows, result;
    bool ok;
    if (strcmp(ZSTR_VAL(dialect), "mysql") == 0) {
        zval link;
        if (!cat_grid_link(ZEND_THIS, &link)) {
            zval_ptr_dtor(&args);
            zval_ptr_dtor(&sql_zv);
            return;
        }
        ok = cat_grid_mysqli(&link, &sql_zv, &args, max_rows, max_bytes, &names, &rows);
        zval_ptr_dtor(&link);
        zval_ptr_dtor(&args);
        zval_ptr_dtor(&sql_zv);
        if (ok) {
            ok = cat_named_result(&names, &rows, &result);
            zval_ptr_dtor(&names);
            zval_ptr_dtor(&rows);
            if (ok) {
                RETVAL_COPY_VALUE(&result);
            }
        }
        return;
    }
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
