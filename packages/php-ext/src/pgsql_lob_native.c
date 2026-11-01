#include "php.h"
#include "main/php_streams.h"
#include "pgsql_lob_native.h"
#include <string.h>

typedef struct {
    zval lob;
    zval connection;
    zend_string *oid;
} orm_pgsql_lob_stream_data;

/* Bytes that one lo_put statement sends. */
#define ORM_PGSQL_LOB_CHUNK ((size_t) 65536)

static bool orm_pgsql_lob_call(const char *name, zval *result, uint32_t argc, zval *args)
{
    zval callable;
    ZVAL_STRING(&callable, name);
    ZVAL_UNDEF(result);
    zend_result status = call_user_function(EG(function_table), NULL, &callable, result, argc, args);
    zval_ptr_dtor(&callable);
    return status == SUCCESS && EG(exception) == NULL;
}

/* Calls the large-object function name with the stream's large object and argument, which it releases; result holds
 * its return value. False when the call fails. */
static bool orm_pgsql_lob_call_on(orm_pgsql_lob_stream_data *data, const char *name, zval *argument, zval *result)
{
    zval args[2];
    ZVAL_COPY(&args[0], &data->lob);
    ZVAL_COPY_VALUE(&args[1], argument);
    bool called = orm_pgsql_lob_call(name, result, 2, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    return called;
}

/* Writes count bytes at offset through lo_put on the connection: the bytea is sent as its hex text form, so no NUL byte
 * reaches a PHP function argument (pg_lo_write refuses them on PHP 8.5). False when the statement fails. */
static bool orm_pgsql_lob_put(orm_pgsql_lob_stream_data *data, zend_long offset, const char *buffer, size_t count)
{
    static const char digits[] = "0123456789abcdef";
    zend_string *hex = zend_string_alloc(2 + 2 * count, 0);
    ZSTR_VAL(hex)[0] = '\\';
    ZSTR_VAL(hex)[1] = 'x';
    for (size_t i = 0; i < count; i++) {
        unsigned char byte = (unsigned char) buffer[i];
        ZSTR_VAL(hex)[2 + 2 * i] = digits[byte >> 4];
        ZSTR_VAL(hex)[3 + 2 * i] = digits[byte & 0x0f];
    }
    ZSTR_VAL(hex)[2 + 2 * count] = '\0';

    zval params;
    array_init(&params);
    zval oid_value, offset_value, hex_value;
    ZVAL_STR_COPY(&oid_value, data->oid);
    add_next_index_zval(&params, &oid_value);
    ZVAL_STR(&offset_value, zend_long_to_str(offset));
    add_next_index_zval(&params, &offset_value);
    ZVAL_STR(&hex_value, hex);
    add_next_index_zval(&params, &hex_value);

    zval args[3], result;
    ZVAL_COPY(&args[0], &data->connection);
    ZVAL_STRING(&args[1], "SELECT lo_put($1::oid, $2::bigint, $3::bytea)");
    ZVAL_COPY_VALUE(&args[2], &params);
    bool called = orm_pgsql_lob_call("pg_query_params", &result, 3, args);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&args[2]);
    bool ok = called && Z_TYPE(result) != IS_FALSE;
    if (called) {
        zval_ptr_dtor(&result);
    }
    return ok;
}

/* Moves the large object's position to offset from its start. */
static bool orm_pgsql_lob_seek_to(orm_pgsql_lob_stream_data *data, zend_long offset)
{
    zval args[3], result;
    ZVAL_COPY(&args[0], &data->lob);
    ZVAL_LONG(&args[1], offset);
    ZVAL_LONG(&args[2], SEEK_SET);
    bool called = orm_pgsql_lob_call("pg_lo_seek", &result, 3, args);
    zval_ptr_dtor(&args[0]);
    bool ok = called && Z_TYPE(result) == IS_TRUE;
    if (called) {
        zval_ptr_dtor(&result);
    }
    return ok;
}

static ssize_t orm_pgsql_lob_write(php_stream *stream, const char *buffer, size_t count)
{
    orm_pgsql_lob_stream_data *data = stream->abstract;
    zval tell_arg, position;
    ZVAL_COPY(&tell_arg, &data->lob);
    bool told = orm_pgsql_lob_call("pg_lo_tell", &position, 1, &tell_arg);
    zval_ptr_dtor(&tell_arg);
    if (!told || Z_TYPE(position) != IS_LONG || Z_LVAL(position) < 0) {
        if (told) {
            zval_ptr_dtor(&position);
        }
        return -1;
    }
    zend_long start = Z_LVAL(position);
    zval_ptr_dtor(&position);

    size_t written = 0;
    while (written < count) {
        size_t chunk = count - written;
        if (chunk > ORM_PGSQL_LOB_CHUNK) {
            chunk = ORM_PGSQL_LOB_CHUNK;
        }
        if (!orm_pgsql_lob_put(data, start + (zend_long) written, buffer + written, chunk)) {
            break;
        }
        written += chunk;
    }
    if (written == 0 && count > 0) {
        return -1;
    }
    if (!orm_pgsql_lob_seek_to(data, start + (zend_long) written)) {
        return -1;
    }
    return (ssize_t) written;
}

static ssize_t orm_pgsql_lob_read(php_stream *stream, char *buffer, size_t count)
{
    if (count == 0) {
        return 0;
    }
    if (count > ZEND_LONG_MAX) {
        count = ZEND_LONG_MAX;
    }
    orm_pgsql_lob_stream_data *data = stream->abstract;
    zval argument, result;
    ZVAL_LONG(&argument, (zend_long) count);
    if (!orm_pgsql_lob_call_on(data, "pg_lo_read", &argument, &result)) {
        return -1;
    }
    if (Z_TYPE(result) != IS_STRING) {
        zval_ptr_dtor(&result);
        return -1;
    }
    size_t length = Z_STRLEN(result);
    if (length > count) {
        length = count;
    }
    if (length > 0) {
        memcpy(buffer, Z_STRVAL(result), length);
    }
    stream->eof = length < count;
    zval_ptr_dtor(&result);
    return (ssize_t) length;
}

static int orm_pgsql_lob_seek(php_stream *stream, zend_off_t offset, int whence, zend_off_t *new_offset)
{
    orm_pgsql_lob_stream_data *data = stream->abstract;
    zval seek_args[3], seek_result;
    ZVAL_COPY(&seek_args[0], &data->lob);
    ZVAL_LONG(&seek_args[1], (zend_long) offset);
    ZVAL_LONG(&seek_args[2], whence);
    if (!orm_pgsql_lob_call("pg_lo_seek", &seek_result, 3, seek_args)) {
        for (size_t i = 0; i < 3; i++) {
            zval_ptr_dtor(&seek_args[i]);
        }
        return -1;
    }
    for (size_t i = 0; i < 3; i++) {
        zval_ptr_dtor(&seek_args[i]);
    }
    bool seek_ok = zend_is_true(&seek_result);
    zval_ptr_dtor(&seek_result);
    if (!seek_ok) {
        return -1;
    }

    zval tell_arg, position;
    ZVAL_COPY(&tell_arg, &data->lob);
    if (!orm_pgsql_lob_call("pg_lo_tell", &position, 1, &tell_arg)) {
        zval_ptr_dtor(&tell_arg);
        return -1;
    }
    zval_ptr_dtor(&tell_arg);
    if (Z_TYPE(position) != IS_LONG || Z_LVAL(position) < 0) {
        zval_ptr_dtor(&position);
        return -1;
    }
    *new_offset = (zend_off_t) Z_LVAL(position);
    zval_ptr_dtor(&position);
    stream->eof = 0;
    return 0;
}

static int orm_pgsql_lob_close(php_stream *stream, int close_handle)
{
    (void) close_handle;
    orm_pgsql_lob_stream_data *data = stream->abstract;
    if (data == NULL) {
        return 0;
    }
    zval arg, result;
    ZVAL_COPY(&arg, &data->lob);
    bool called = orm_pgsql_lob_call("pg_lo_close", &result, 1, &arg);
    zval_ptr_dtor(&arg);
    int status = called && zend_is_true(&result) ? 0 : -1;
    if (called) {
        zval_ptr_dtor(&result);
    }
    zval_ptr_dtor(&data->lob);
    zval_ptr_dtor(&data->connection);
    zend_string_release(data->oid);
    efree(data);
    stream->abstract = NULL;
    return status;
}

static int orm_pgsql_lob_flush(php_stream *stream)
{
    (void) stream;
    return 0;
}

static const php_stream_ops orm_pgsql_lob_stream_ops = {
    orm_pgsql_lob_write,
    orm_pgsql_lob_read,
    orm_pgsql_lob_close,
    orm_pgsql_lob_flush,
    "polyspec_pgsql_lob",
    orm_pgsql_lob_seek,
    NULL,
    NULL,
    NULL
};

int orm_pgsql_lob_stream(zval *native_lob, zval *connection, zend_string *oid, zval *return_value)
{
    if (native_lob == NULL || Z_TYPE_P(native_lob) != IS_OBJECT || connection == NULL || oid == NULL || return_value == NULL) {
        return FAILURE;
    }
    zend_string *class_name = zend_string_init("PgSql\\Lob", sizeof("PgSql\\Lob") - 1, 0);
    zend_class_entry *lob_ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    if (lob_ce == NULL || !instanceof_function(Z_OBJCE_P(native_lob), lob_ce)) {
        return FAILURE;
    }
    orm_pgsql_lob_stream_data *data = emalloc(sizeof(*data));
    ZVAL_COPY(&data->lob, native_lob);
    ZVAL_COPY(&data->connection, connection);
    data->oid = zend_string_copy(oid);
    php_stream *stream = php_stream_alloc(&orm_pgsql_lob_stream_ops, data, NULL, "r+");
    if (stream == NULL) {
        zval_ptr_dtor(&data->lob);
        zval_ptr_dtor(&data->connection);
        zend_string_release(data->oid);
        efree(data);
        return FAILURE;
    }
    php_stream_to_zval(stream, return_value);
    return SUCCESS;
}
