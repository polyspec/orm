/* Native implementations of PHP library value and internal classes. */
#include "php.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"

static zend_class_entry *native_find_class(const char *name, size_t length)
{
    zend_string *class_name = zend_string_init(name, length, 0);
    zend_class_entry *ce = zend_lookup_class(class_name);
    zend_string_release(class_name);
    return ce;
}

static bool native_config_error(const char *message)
{
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return false;
    zval error, args[2], rv;
    object_init_ex(&error, ce);
    ZVAL_STRING(&args[0], "CONFIG");
    ZVAL_STRING(&args[1], message);
    zend_call_known_function(ce->constructor, Z_OBJ(error), ce, &rv, 2, args, NULL);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&error);
        return false;
    }
    zend_throw_exception_object(&error);
    return false;
}

static bool native_call(const char *name, zval *result, uint32_t argc, zval *args)
{
    zval function;
    ZVAL_STRING(&function, name);
    int status = call_user_function(EG(function_table), NULL, &function, result, argc, args);
    zval_ptr_dtor(&function);
    return status == SUCCESS && EG(exception) == NULL;
}

static bool native_cancellation_error(const char *code, const char *message)
{
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\OrmException"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) return false;
    zval error, args[2], rv;
    object_init_ex(&error, ce);
    ZVAL_STRING(&args[0], code);
    ZVAL_STRING(&args[1], message);
    zend_call_known_function(ce->constructor, Z_OBJ(error), ce, &rv, 2, args, NULL);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]); zval_ptr_dtor(&rv);
    if (EG(exception) != NULL) { zval_ptr_dtor(&error); return false; }
    zend_throw_exception_object(&error);
    return false;
}

static zend_class_entry *native_cancellation_ce(void)
{
    zend_string *name = zend_string_init("Polyspec\\Orm\\Cancellation", sizeof("Polyspec\\Orm\\Cancellation") - 1, 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    return ce;
}

static zval *native_cancellation_property(zval *self, const char *name, size_t length, zval *rv)
{
    return zend_read_property(native_cancellation_ce(), Z_OBJ_P(self), name, length, true, rv);
}

static void native_cancellation_set(zval *self, const char *name, size_t length, zval *value)
{
    zend_update_property(native_cancellation_ce(), Z_OBJ_P(self), name, length, value);
}

static bool native_cancellation_stream(zval *self, zval *stream)
{
    zval state_rv, path_rv, stream_pid_rv, pid, args[2], opened;
    zval *path = native_cancellation_property(self, "statePath", sizeof("statePath") - 1, &path_rv);
    zval *stored = native_cancellation_property(self, "state", sizeof("state") - 1, &state_rv);
    zval *stream_pid = native_cancellation_property(self, "streamPid", sizeof("streamPid") - 1, &stream_pid_rv);
    if (path == NULL || Z_TYPE_P(path) != IS_STRING || stored == NULL) {
        return native_config_error("cancellation state file is not initialized");
    }
    if (!native_call("getmypid", &pid, 0, NULL) || Z_TYPE(pid) != IS_LONG) return false;
    if (Z_TYPE_P(stored) == IS_RESOURCE && stream_pid != NULL && Z_TYPE_P(stream_pid) == IS_LONG
        && Z_LVAL_P(stream_pid) == Z_LVAL(pid)) {
        ZVAL_COPY(stream, stored);
        zval_ptr_dtor(&pid);
        return true;
    }
    ZVAL_COPY(&args[0], path); ZVAL_STRING(&args[1], "c+b");
    bool opened_ok = native_call("fopen", &opened, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (!opened_ok || Z_TYPE(opened) != IS_RESOURCE) {
        if (Z_TYPE(opened) != IS_UNDEF) zval_ptr_dtor(&opened);
        zval_ptr_dtor(&pid);
        return native_config_error("cannot reopen the private cancellation state file");
    }
    zval old_stream;
    if (Z_TYPE_P(stored) == IS_RESOURCE) ZVAL_COPY(&old_stream, stored); else ZVAL_UNDEF(&old_stream);
    native_cancellation_set(self, "state", sizeof("state") - 1, &opened);
    native_cancellation_set(self, "streamPid", sizeof("streamPid") - 1, &pid);
    if (Z_TYPE(old_stream) == IS_RESOURCE) {
        zval closed, close_arg; ZVAL_COPY(&close_arg, &old_stream);
        if (native_call("fclose", &closed, 1, &close_arg)) zval_ptr_dtor(&closed);
        zval_ptr_dtor(&close_arg);
        zval_ptr_dtor(&old_stream);
    }
    ZVAL_COPY(stream, &opened);
    zval_ptr_dtor(&opened); zval_ptr_dtor(&pid);
    return true;
}

static bool native_cancellation_lock(zval *stream, zend_long mode)
{
    zval args[2], result;
    ZVAL_COPY(&args[0], stream); ZVAL_LONG(&args[1], mode);
    bool ok = native_call("flock", &result, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (ok) { ok = zend_is_true(&result); zval_ptr_dtor(&result); }
    return ok;
}

static bool native_cancellation_unlock(zval *stream)
{
    return native_cancellation_lock(stream, 3);
}

static bool native_cancellation_seek(zval *stream, zend_long offset, zend_long whence)
{
    zval args[3], result;
    ZVAL_COPY(&args[0], stream); ZVAL_LONG(&args[1], offset); ZVAL_LONG(&args[2], whence);
    bool ok = native_call("fseek", &result, 3, args);
    for (int index = 0; index < 3; index++) zval_ptr_dtor(&args[index]);
    if (ok) { ok = Z_TYPE(result) == IS_LONG && Z_LVAL(result) == 0; zval_ptr_dtor(&result); }
    return ok;
}

static bool native_cancellation_read_byte(zval *stream, zend_long offset, unsigned char *byte)
{
    zval args[2], result;
    if (!native_cancellation_seek(stream, offset, 0)) return false;
    ZVAL_COPY(&args[0], stream); ZVAL_LONG(&args[1], 1);
    bool ok = native_call("fread", &result, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (ok) {
        ok = Z_TYPE(result) == IS_STRING && Z_STRLEN(result) == 1;
        if (ok) *byte = (unsigned char) Z_STRVAL(result)[0];
        zval_ptr_dtor(&result);
    }
    return ok;
}

static bool native_cancellation_write_byte(zval *stream, zend_long offset, unsigned char byte)
{
    zval args[2], result, flushed;
    char content = (char) byte;
    if (!native_cancellation_seek(stream, offset, 0)) return false;
    ZVAL_COPY(&args[0], stream); ZVAL_STRINGL(&args[1], &content, 1);
    bool ok = native_call("fwrite", &result, 2, args);
    zval_ptr_dtor(&args[0]); zval_ptr_dtor(&args[1]);
    if (ok) { ok = Z_TYPE(result) == IS_LONG && Z_LVAL(result) == 1; zval_ptr_dtor(&result); }
    if (ok) {
        ZVAL_COPY(&args[0], stream);
        ok = native_call("fflush", &flushed, 1, args);
        zval_ptr_dtor(&args[0]);
        if (ok) { ok = zend_is_true(&flushed); zval_ptr_dtor(&flushed); }
    }
    return ok;
}

static bool native_cancellation_size(zval *stream, zend_long *size)
{
    zval args[1], result;
    if (!native_cancellation_seek(stream, 0, 2)) return false;
    ZVAL_COPY(&args[0], stream);
    bool ok = native_call("ftell", &result, 1, args);
    zval_ptr_dtor(&args[0]);
    if (ok) { ok = Z_TYPE(result) == IS_LONG && Z_LVAL(result) >= 1; if (ok) *size = Z_LVAL(result); zval_ptr_dtor(&result); }
    return ok;
}

static bool native_cancellation_update(zval *self, zend_long slot, bool active, bool reject_cancelled, zend_long *flags)
{
    zval stream;
    unsigned char header = 0;
    if (!native_cancellation_stream(self, &stream)) return false;
    bool ok = native_cancellation_lock(&stream, 2) && native_cancellation_read_byte(&stream, 0, &header);
    if (!ok) {
        native_cancellation_unlock(&stream); zval_ptr_dtor(&stream);
        return native_config_error("cannot read the private cancellation state file");
    }
    if (reject_cancelled && (header & 2) != 0) {
        native_cancellation_unlock(&stream); zval_ptr_dtor(&stream);
        return native_cancellation_error("CANCELED", "statement was cancelled");
    }
    if (slot > 0 && !native_cancellation_write_byte(&stream, slot, active ? 1 : 0)) ok = false;
    zend_long size = 1;
    if (ok) ok = native_cancellation_size(&stream, &size);
    bool any_active = slot == 0 && active;
    for (zend_long index = 1; ok && index < size; index++) {
        unsigned char value = 0;
        ok = native_cancellation_read_byte(&stream, index, &value);
        any_active = any_active || value == 1;
    }
    if (ok) {
        header = (unsigned char) ((header & 2) | (any_active ? 1 : 0));
        ok = native_cancellation_write_byte(&stream, 0, header);
        if (flags != NULL) *flags = header;
    }
    bool unlocked = native_cancellation_unlock(&stream);
    zval_ptr_dtor(&stream);
    if (!ok || !unlocked) return native_config_error("cannot update the private cancellation state file");
    return true;
}

static bool native_cancellation_read_flags(zval *self, zend_long *flags)
{
    zval stream;
    unsigned char header = 0;
    if (!native_cancellation_stream(self, &stream)) return false;
    bool ok = native_cancellation_lock(&stream, 1) && native_cancellation_read_byte(&stream, 0, &header);
    bool unlocked = native_cancellation_unlock(&stream);
    zval_ptr_dtor(&stream);
    if (!ok || !unlocked) return native_config_error("cannot read the private cancellation state file");
    *flags = header;
    return true;
}

ZEND_METHOD(Polyspec_Orm_Cancellation, __construct)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval directory, prefix, temp_args[2], path, mode, chmod_args[2], chmod_result, initial_args[2], initial, written;
    if (!native_call("sys_get_temp_dir", &directory, 0, NULL)) RETURN_THROWS();
    ZVAL_STRING(&prefix, "orm-cancel-");
    ZVAL_COPY(&temp_args[0], &directory);
    ZVAL_COPY(&temp_args[1], &prefix);
    bool made = native_call("tempnam", &path, 2, temp_args);
    zval_ptr_dtor(&temp_args[0]); zval_ptr_dtor(&temp_args[1]);
    zval_ptr_dtor(&directory); zval_ptr_dtor(&prefix);
    if (!made || Z_TYPE(path) != IS_STRING) RETURN_THROWS();
    ZVAL_COPY(&chmod_args[0], &path); ZVAL_LONG(&mode, 0600); ZVAL_COPY(&chmod_args[1], &mode);
    bool secured = native_call("chmod", &chmod_result, 2, chmod_args);
    zval_ptr_dtor(&chmod_args[0]); zval_ptr_dtor(&chmod_args[1]); zval_ptr_dtor(&mode);
    bool mode_ok = secured && zend_is_true(&chmod_result);
    if (secured) zval_ptr_dtor(&chmod_result);
    if (!mode_ok) {
        zval unlink_result;
        zval args[1]; ZVAL_COPY(&args[0], &path); native_call("unlink", &unlink_result, 1, args);
        zval_ptr_dtor(&args[0]); if (Z_TYPE(unlink_result) != IS_UNDEF) zval_ptr_dtor(&unlink_result);
        zval_ptr_dtor(&path);
        native_config_error("cannot create a private cancellation state file");
        RETURN_THROWS();
    }
    ZVAL_STRING(&initial, "c+b");
    ZVAL_COPY(&initial_args[0], &path); ZVAL_COPY(&initial_args[1], &initial);
    bool opened = native_call("fopen", &written, 2, initial_args);
    zval_ptr_dtor(&initial_args[0]); zval_ptr_dtor(&initial_args[1]); zval_ptr_dtor(&initial);
    if (!opened || Z_TYPE(written) != IS_RESOURCE) {
        zval unlink_result, args[1]; ZVAL_COPY(&args[0], &path); native_call("unlink", &unlink_result, 1, args);
        zval_ptr_dtor(&args[0]); if (Z_TYPE(unlink_result) != IS_UNDEF) zval_ptr_dtor(&unlink_result);
        if (Z_TYPE(written) != IS_UNDEF) zval_ptr_dtor(&written);
        zval_ptr_dtor(&path);
        native_config_error("cannot initialize the cancellation state file");
        RETURN_THROWS();
    }
    char initial_byte = 0;
    ZVAL_UNDEF(&initial);
    ZVAL_COPY(&initial_args[0], &written); ZVAL_STRINGL(&initial_args[1], &initial_byte, 1);
    bool wrote = native_call("fwrite", &initial, 2, initial_args);
    zval_ptr_dtor(&initial_args[0]); zval_ptr_dtor(&initial_args[1]);
    if (wrote) {
        wrote = Z_TYPE(initial) == IS_LONG && Z_LVAL(initial) == 1;
        zval_ptr_dtor(&initial);
    }
    ZVAL_COPY(&initial_args[0], &written);
    bool flushed = wrote && native_call("fflush", &initial, 1, initial_args) && zend_is_true(&initial);
    if (Z_TYPE(initial) != IS_UNDEF) zval_ptr_dtor(&initial);
    zval_ptr_dtor(&initial_args[0]);
    if (!flushed) {
        zval close_arg, close_result; ZVAL_COPY(&close_arg, &written);
        if (native_call("fclose", &close_result, 1, &close_arg)) zval_ptr_dtor(&close_result);
        zval_ptr_dtor(&close_arg);
        zval unlink_result, args[1]; ZVAL_COPY(&args[0], &path); native_call("unlink", &unlink_result, 1, args);
        zval_ptr_dtor(&args[0]); if (Z_TYPE(unlink_result) != IS_UNDEF) zval_ptr_dtor(&unlink_result);
        zval_ptr_dtor(&written); zval_ptr_dtor(&path);
        native_config_error("cannot initialize the cancellation state file");
        RETURN_THROWS();
    }
    native_cancellation_set(ZEND_THIS, "state", sizeof("state") - 1, &written);
    zval pid;
    if (!native_call("getmypid", &pid, 0, NULL) || Z_TYPE(pid) != IS_LONG) {
        zval_ptr_dtor(&written); zval_ptr_dtor(&path);
        RETURN_THROWS();
    }
    native_cancellation_set(ZEND_THIS, "ownerPid", sizeof("ownerPid") - 1, &pid);
    native_cancellation_set(ZEND_THIS, "streamPid", sizeof("streamPid") - 1, &pid);
    zval_ptr_dtor(&pid);
    zval_ptr_dtor(&written);
    native_cancellation_set(ZEND_THIS, "statePath", sizeof("statePath") - 1, &path);
    zval_ptr_dtor(&path);
    array_init(&mode); native_cancellation_set(ZEND_THIS, "cancelQueries", sizeof("cancelQueries") - 1, &mode); zval_ptr_dtor(&mode);
    array_init(&mode); native_cancellation_set(ZEND_THIS, "connectionSlots", sizeof("connectionSlots") - 1, &mode); zval_ptr_dtor(&mode);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Cancellation, __destruct)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv, args[1], exists, removed, stream_rv, close_result, pid_rv, pid;
    zval *path = native_cancellation_property(ZEND_THIS, "statePath", sizeof("statePath") - 1, &rv);
    if (path == NULL || Z_TYPE_P(path) != IS_STRING || Z_STRLEN_P(path) == 0) RETURN_NULL();
    zval *stream = native_cancellation_property(ZEND_THIS, "state", sizeof("state") - 1, &stream_rv);
    if (stream != NULL && Z_TYPE_P(stream) == IS_RESOURCE) {
        ZVAL_COPY(&args[0], stream);
        if (native_call("fclose", &close_result, 1, args)) zval_ptr_dtor(&close_result);
        zval_ptr_dtor(&args[0]);
    }
    zval *owner = native_cancellation_property(ZEND_THIS, "ownerPid", sizeof("ownerPid") - 1, &pid_rv);
    if (!native_call("getmypid", &pid, 0, NULL)) RETURN_THROWS();
    bool same_process = owner != NULL && Z_TYPE_P(owner) == IS_LONG && Z_TYPE(pid) == IS_LONG
        && Z_LVAL_P(owner) == Z_LVAL(pid);
    zval_ptr_dtor(&pid);
    if (!same_process) RETURN_NULL();
    ZVAL_COPY(&args[0], path);
    bool checked = native_call("file_exists", &exists, 1, args);
    if (checked && zend_is_true(&exists)) {
        if (!native_call("unlink", &removed, 1, args)) { zval_ptr_dtor(&exists); zval_ptr_dtor(&args[0]); RETURN_THROWS(); }
        zval_ptr_dtor(&removed);
    }
    if (checked) zval_ptr_dtor(&exists);
    zval_ptr_dtor(&args[0]);
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Cancellation, begin)
{
    zend_long slot = 0, flags = 0;
    ZEND_PARSE_PARAMETERS_START(0, 1)
        Z_PARAM_OPTIONAL
        Z_PARAM_LONG(slot)
    ZEND_PARSE_PARAMETERS_END();
    if (!native_cancellation_update(ZEND_THIS, slot, true, true, &flags)) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Cancellation, registerCancelQuery)
{
    zend_long connection_id;
    zval *query = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_LONG(connection_id)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(query, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();
    if (connection_id <= 0) {
        native_cancellation_error("CONFIG", "cancellation connection id must be positive");
        RETURN_THROWS();
    }
    zval slots_rv, queries_rv;
    zval *slots = native_cancellation_property(ZEND_THIS, "connectionSlots", sizeof("connectionSlots") - 1, &slots_rv);
    zval *queries = native_cancellation_property(ZEND_THIS, "cancelQueries", sizeof("cancelQueries") - 1, &queries_rv);
    if (slots == NULL || Z_TYPE_P(slots) != IS_ARRAY || queries == NULL || Z_TYPE_P(queries) != IS_ARRAY) {
        native_cancellation_error("CONFIG", "cancellation callbacks are not initialized");
        RETURN_THROWS();
    }
    zval *existing = zend_hash_index_find(Z_ARRVAL_P(slots), (zend_ulong) connection_id);
    zend_long slot;
    if (existing != NULL && Z_TYPE_P(existing) == IS_LONG) {
        slot = Z_LVAL_P(existing);
    } else {
        zval stream;
        if (!native_cancellation_stream(ZEND_THIS, &stream)) RETURN_THROWS();
        if (!native_cancellation_lock(&stream, 2)) { zval_ptr_dtor(&stream); RETURN_THROWS(); }
        zval args[1], length;
        bool sized = native_cancellation_seek(&stream, 0, 2);
        ZVAL_COPY(&args[0], &stream);
        sized = sized && native_call("ftell", &length, 1, args);
        zval_ptr_dtor(&args[0]);
        if (!sized || Z_TYPE(length) != IS_LONG || Z_LVAL(length) < 1) {
            if (sized) zval_ptr_dtor(&length);
            native_cancellation_unlock(&stream); zval_ptr_dtor(&stream);
            native_cancellation_error("CONFIG", "cannot allocate a cancellation connection slot");
            RETURN_THROWS();
        }
        slot = Z_LVAL(length);
        zval_ptr_dtor(&length);
        if (!native_cancellation_write_byte(&stream, slot, 0) || !native_cancellation_unlock(&stream)) {
            zval_ptr_dtor(&stream);
            native_cancellation_error("CONFIG", "cannot allocate a cancellation connection slot");
            RETURN_THROWS();
        }
        zval_ptr_dtor(&stream);
        zval value; ZVAL_LONG(&value, slot);
        zend_hash_index_update(Z_ARRVAL_P(slots), (zend_ulong) connection_id, &value);
    }
    zval *existing_query = zend_hash_index_find(Z_ARRVAL_P(queries), (zend_ulong) slot);
    if (query != NULL) {
        zval copy; ZVAL_COPY(&copy, query);
        zend_hash_index_update(Z_ARRVAL_P(queries), (zend_ulong) slot, &copy);
    } else if (existing_query == NULL) {
        zval null_value; ZVAL_NULL(&null_value);
        zend_hash_index_update(Z_ARRVAL_P(queries), (zend_ulong) slot, &null_value);
    }
    RETURN_LONG(slot);
}

ZEND_METHOD(Polyspec_Orm_Cancellation, cancel)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval stream, queries_rv;
    zend_long size = 1;
    unsigned char header = 0;
    if (!native_cancellation_stream(ZEND_THIS, &stream)) RETURN_THROWS();
    if (!native_cancellation_lock(&stream, 2) || !native_cancellation_read_byte(&stream, 0, &header)) {
        native_cancellation_unlock(&stream); zval_ptr_dtor(&stream);
        native_cancellation_error("CONFIG", "cannot read the private cancellation state file");
        RETURN_THROWS();
    }
    if ((header & 2) != 0) {
        native_cancellation_unlock(&stream); zval_ptr_dtor(&stream); RETURN_NULL();
    }
    if (!native_cancellation_size(&stream, &size)
        || !native_cancellation_write_byte(&stream, 0, (unsigned char) (header | 2))) {
        native_cancellation_unlock(&stream); zval_ptr_dtor(&stream);
        native_cancellation_error("CONFIG", "cannot update the private cancellation state file");
        RETURN_THROWS();
    }
    zval *queries = native_cancellation_property(ZEND_THIS, "cancelQueries", sizeof("cancelQueries") - 1, &queries_rv);
    for (zend_long slot = 1; slot < size; slot++) {
        unsigned char active = 0;
        if (!native_cancellation_read_byte(&stream, slot, &active)) {
            native_cancellation_unlock(&stream); zval_ptr_dtor(&stream);
            native_cancellation_error("CONFIG", "cannot read a cancellation connection slot");
            RETURN_THROWS();
        }
        zval *query = queries != NULL && Z_TYPE_P(queries) == IS_ARRAY
            ? zend_hash_index_find(Z_ARRVAL_P(queries), (zend_ulong) slot) : NULL;
        if (active == 1 && query != NULL && Z_TYPE_P(query) == IS_OBJECT) {
            zval result;
            if (call_user_function(NULL, NULL, query, &result, 0, NULL) != SUCCESS || EG(exception) != NULL) {
                native_cancellation_unlock(&stream); zval_ptr_dtor(&stream); RETURN_THROWS();
            }
            zval_ptr_dtor(&result);
        }
    }
    bool unlocked = native_cancellation_unlock(&stream);
    zval_ptr_dtor(&stream);
    if (!unlocked) {
        native_cancellation_error("CONFIG", "cannot release the cancellation state lock");
        RETURN_THROWS();
    }
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Cancellation, end)
{
    zend_long slot = 0;
    ZEND_PARSE_PARAMETERS_START(0, 1)
        Z_PARAM_OPTIONAL
        Z_PARAM_LONG(slot)
    ZEND_PARSE_PARAMETERS_END();
    if (!native_cancellation_update(ZEND_THIS, slot, false, false, NULL)) RETURN_THROWS();
    RETURN_NULL();
}

ZEND_METHOD(Polyspec_Orm_Cancellation, isCancelled)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_long flags = 0;
    if (!native_cancellation_read_flags(ZEND_THIS, &flags)) RETURN_THROWS();
    RETURN_BOOL((flags & 2) != 0);
}

ZEND_METHOD(Polyspec_Orm_Cancellation, statePath)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv;
    zval *path = native_cancellation_property(ZEND_THIS, "statePath", sizeof("statePath") - 1, &rv);
    RETURN_COPY(path);
}

ZEND_METHOD(Polyspec_Orm_Config, __construct)
{
    zend_string *aes_key = ZSTR_EMPTY_ALLOC(), *blind_index_key = ZSTR_EMPTY_ALLOC();
    zend_long aes_version = 1, pool_size = 0, statement_timeout_ms = 0, pool_idle_size = 0, pool_lifetime_ms = 0;
    zend_long plan_cache_size = 256, statement_cache_size = 256;
    HashTable empty_keys;
    HashTable *aes_keys = NULL;
    bool owns_empty_keys = false;
    zval *audit_source = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 11)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(aes_key)
        Z_PARAM_STR(blind_index_key)
        Z_PARAM_LONG(aes_version)
        Z_PARAM_ARRAY_HT(aes_keys)
        Z_PARAM_LONG(pool_size)
        Z_PARAM_LONG(statement_timeout_ms)
        Z_PARAM_LONG(pool_idle_size)
        Z_PARAM_LONG(pool_lifetime_ms)
        Z_PARAM_LONG(plan_cache_size)
        Z_PARAM_LONG(statement_cache_size)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(audit_source, zend_ce_closure)
    ZEND_PARSE_PARAMETERS_END();

    if (aes_keys == NULL) {
        zend_hash_init(&empty_keys, 0, NULL, ZVAL_PTR_DTOR, 0);
        aes_keys = &empty_keys;
        owns_empty_keys = true;
    }

    /* The stub arginfo supplies the PHP defaults; parse variables are initialized to those same values. */
    if (aes_version < 1 || plan_cache_size < 1 || statement_cache_size < 1) {
        native_config_error("AES version and cache sizes must be positive");
        if (owns_empty_keys) zend_hash_destroy(&empty_keys);
        RETURN_THROWS();
    }
    zval *selected = zend_hash_index_find(aes_keys, (zend_ulong)aes_version);
    if (ZSTR_LEN(aes_key) != 0 && zend_hash_num_elements(aes_keys) != 0
        && (selected == NULL || Z_TYPE_P(selected) != IS_STRING || !zend_string_equals(Z_STR_P(selected), aes_key))) {
        zend_string *message = strpprintf(0, "aesKey differs from aesKeys[" ZEND_LONG_FMT "]", aes_version);
        native_config_error(ZSTR_VAL(message));
        zend_string_release(message);
        if (owns_empty_keys) zend_hash_destroy(&empty_keys);
        RETURN_THROWS();
    }
    bool release_resolved_key = false;
    zend_string *resolved_key = ZSTR_LEN(aes_key) != 0 ? aes_key
        : (selected != NULL && Z_TYPE_P(selected) == IS_STRING ? Z_STR_P(selected) : (release_resolved_key = true, ZSTR_EMPTY_ALLOC()));
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zend_update_property_str(o->ce, o, ZEND_STRL("aesKey"), resolved_key);
    zend_update_property_str(o->ce, o, ZEND_STRL("blindIndexKey"), blind_index_key);
    zend_update_property_long(o->ce, o, ZEND_STRL("aesVersion"), aes_version);
    zval v;
    ZVAL_ARR(&v, zend_array_dup(aes_keys));
    zend_update_property(o->ce, o, ZEND_STRL("aesKeys"), &v);
    zval_ptr_dtor(&v);
    zend_update_property_long(o->ce, o, ZEND_STRL("poolSize"), pool_size);
    zend_update_property_long(o->ce, o, ZEND_STRL("statementTimeoutMs"), statement_timeout_ms);
    zend_update_property_long(o->ce, o, ZEND_STRL("poolIdleSize"), pool_idle_size);
    zend_update_property_long(o->ce, o, ZEND_STRL("poolLifetimeMs"), pool_lifetime_ms);
    zend_update_property_long(o->ce, o, ZEND_STRL("planCacheSize"), plan_cache_size);
    zend_update_property_long(o->ce, o, ZEND_STRL("statementCacheSize"), statement_cache_size);
    if (audit_source == NULL) zend_update_property_null(o->ce, o, ZEND_STRL("auditSource"));
    else zend_update_property(o->ce, o, ZEND_STRL("auditSource"), audit_source);
    if (release_resolved_key) zend_string_release(resolved_key);
    if (owns_empty_keys) zend_hash_destroy(&empty_keys);
}

ZEND_METHOD(Polyspec_Orm_Config, keyring)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zval rv, *keys = zend_read_property(o->ce, o, ZEND_STRL("aesKeys"), 1, &rv);
    zval *version = zend_read_property(o->ce, o, ZEND_STRL("aesVersion"), 1, &rv);
    zval *key = zend_read_property(o->ce, o, ZEND_STRL("aesKey"), 1, &rv);
    zval key_array;
    if (zend_hash_num_elements(Z_ARRVAL_P(keys)) == 0) {
        if (Z_STRLEN_P(key) == 0) {
            native_config_error("secret aes is not configured");
            RETURN_THROWS();
        }
        array_init(&key_array);
        Z_TRY_ADDREF_P(key);
        zend_hash_index_update(Z_ARRVAL(key_array), (zend_ulong)Z_LVAL_P(version), key);
        keys = &key_array;
    } else {
        ZVAL_COPY(&key_array, keys);
    }
    zend_string *name = zend_string_init(ZEND_STRL("Polyspec\\Orm\\AesKeyring"), 0);
    zend_class_entry *ce = zend_lookup_class(name);
    zend_string_release(name);
    if (ce == NULL) {
        zval_ptr_dtor(&key_array);
        RETURN_THROWS();
    }
    object_init_ex(return_value, ce);
    zval args[2], rv_call;
    ZVAL_COPY_VALUE(&args[0], &key_array);
    ZVAL_COPY(&args[1], version);
    zend_call_known_function(ce->constructor, Z_OBJ_P(return_value), ce, &rv_call, 2, args, NULL);
    zval_ptr_dtor(&args[0]);
    zval_ptr_dtor(&args[1]);
    zval_ptr_dtor(&rv_call);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_TxFrame, __construct)
{
    zval *db;
    bool read_only;
    zend_string *isolation;
    zend_long number;
    zend_class_entry *db_ce = native_find_class(ZEND_STRL("Polyspec\\Orm\\Db"));
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_OBJECT_OF_CLASS(db, db_ce)
        Z_PARAM_BOOL(read_only)
        Z_PARAM_STR(isolation)
        Z_PARAM_LONG(number)
    ZEND_PARSE_PARAMETERS_END();
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zend_update_property(o->ce, o, ZEND_STRL("db"), db);
    zend_update_property_bool(o->ce, o, ZEND_STRL("readOnly"), read_only);
    zend_update_property_str(o->ce, o, ZEND_STRL("isolation"), isolation);
    zend_update_property_long(o->ce, o, ZEND_STRL("number"), number);
    zend_class_entry *fiber_ce = native_find_class(ZEND_STRL("Fiber"));
    zend_function *get_current = fiber_ce == NULL ? NULL
        : zend_hash_str_find_ptr(&fiber_ce->function_table, ZEND_STRL("getcurrent"));
    if (get_current == NULL) {
        zend_throw_error(NULL, "Fiber::getCurrent is unavailable");
        RETURN_THROWS();
    }
    zval flow;
    ZVAL_UNDEF(&flow);
    zend_call_known_function(get_current, NULL, fiber_ce, &flow, 0, NULL, NULL);
    if (EG(exception) != NULL) {
        if (!Z_ISUNDEF(flow)) zval_ptr_dtor(&flow);
        RETURN_THROWS();
    }
    zend_update_property(o->ce, o, ZEND_STRL("flow"), &flow);
    zval_ptr_dtor(&flow);
}

ZEND_METHOD(Polyspec_Orm_TxFrame, recordInserted)
{
    zval *frame, *request, *id;
    zend_class_entry *frame_ce = native_find_class(ZEND_STRL("Polyspec\\Orm\\TxFrame"));
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(frame, frame_ce)
        Z_PARAM_OBJECT(request)
        Z_PARAM_ZVAL(id)
    ZEND_PARSE_PARAMETERS_END();
    if (frame == NULL || Z_TYPE_P(id) == IS_NULL) RETURN_NULL();

    zval rv, *ir = zend_read_property(Z_OBJCE_P(request), Z_OBJ_P(request), ZEND_STRL("ir"), 1, &rv);
    if (Z_TYPE_P(ir) != IS_ARRAY) RETURN_NULL();
    zval *kind = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("kind"));
    zval *rows = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("rows"));
    if (kind == NULL || Z_TYPE_P(kind) != IS_STRING || !zend_string_equals_literal(Z_STR_P(kind), "insert")
        || (rows != NULL && Z_TYPE_P(rows) != IS_NULL)) RETURN_NULL();

    zend_long key;
    if (Z_TYPE_P(id) == IS_LONG) {
        key = Z_LVAL_P(id);
    } else if (Z_TYPE_P(id) == IS_STRING && Z_STRLEN_P(id) > 0) {
        key = 0;
        for (size_t i = 0; i < Z_STRLEN_P(id); i++) {
            unsigned char digit = (unsigned char)Z_STRVAL_P(id)[i] - '0';
            if (digit > 9) RETURN_NULL();
            if (key > (ZEND_LONG_MAX - digit) / 10) key = ZEND_LONG_MAX;
            else key = key * 10 + digit;
        }
    } else {
        RETURN_NULL();
    }
    if (key <= 0) RETURN_NULL();

    zval *hash = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("manifest_hash"));
    zval *entity_name = zend_hash_str_find(Z_ARRVAL_P(ir), ZEND_STRL("entity"));
    if (hash == NULL || Z_TYPE_P(hash) != IS_STRING || entity_name == NULL || Z_TYPE_P(entity_name) != IS_STRING) {
        RETURN_NULL();
    }
    zend_class_entry *registry_ce = native_find_class(ZEND_STRL("Polyspec\\Orm\\Registry"));
    if (registry_ce == NULL) RETURN_NULL();
    zend_function *model_fn = zend_hash_str_find_ptr(&registry_ce->function_table, ZEND_STRL("model"));
    if (model_fn == NULL) RETURN_NULL();
    zval model_arg, runtime;
    ZVAL_UNDEF(&runtime);
    ZVAL_COPY(&model_arg, hash);
    zend_call_known_function(model_fn, NULL, registry_ce, &runtime, 1, &model_arg, NULL);
    zval_ptr_dtor(&model_arg);
    if (EG(exception) != NULL) {
        if (!Z_ISUNDEF(runtime)) zval_ptr_dtor(&runtime);
        RETURN_THROWS();
    }
    zval entity_arg, entity;
    ZVAL_COPY(&entity_arg, entity_name);
    zend_call_method_with_1_params(Z_OBJ(runtime), Z_OBJCE(runtime), NULL, "entity", &entity, &entity_arg);
    zval_ptr_dtor(&entity_arg);
    zval_ptr_dtor(&runtime);
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&entity);
        RETURN_THROWS();
    }
    if (Z_TYPE(entity) != IS_ARRAY) {
        zval_ptr_dtor(&entity);
        RETURN_NULL();
    }
    zval *identity = zend_hash_str_find(Z_ARRVAL(entity), ZEND_STRL("identity"));
    bool has_identity = identity != NULL && Z_TYPE_P(identity) == IS_STRING && Z_STRLEN_P(identity) > 0;
    zval_ptr_dtor(&entity);
    if (!has_identity) RETURN_NULL();

    zval inserted_rv, *inserted = zend_read_property(Z_OBJCE_P(frame), Z_OBJ_P(frame), ZEND_STRL("inserted"), 1, &inserted_rv);
    zval updated;
    if (Z_TYPE_P(inserted) == IS_ARRAY) {
        ZVAL_COPY(&updated, inserted);
        SEPARATE_ARRAY(&updated);
    } else {
        array_init(&updated);
    }
    zval *existing = zend_hash_find(Z_ARRVAL(updated), Z_STR_P(entity_name));
    zval entity_set;
    if (existing != NULL && Z_TYPE_P(existing) == IS_ARRAY) {
        ZVAL_COPY(&entity_set, existing);
        SEPARATE_ARRAY(&entity_set);
    } else {
        array_init(&entity_set);
    }
    zval truth;
    ZVAL_TRUE(&truth);
    zend_hash_index_update(Z_ARRVAL(entity_set), (zend_ulong)key, &truth);
    zend_hash_update(Z_ARRVAL(updated), Z_STR_P(entity_name), &entity_set);
    zend_update_property(Z_OBJCE_P(frame), Z_OBJ_P(frame), ZEND_STRL("inserted"), &updated);
    zval_ptr_dtor(&updated);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Meet, kind)
{
    zend_string *type;
    zend_long scale, precision;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(type)
        Z_PARAM_LONG(scale)
        Z_PARAM_LONG(precision)
    ZEND_PARSE_PARAMETERS_END();

    if (zend_string_equals_literal(type, "i16") || zend_string_equals_literal(type, "i32")
        || zend_string_equals_literal(type, "i64")) {
        RETURN_STRING("integer");
    }
    if (zend_string_equals_literal(type, "varchar") || zend_string_equals_literal(type, "text")) {
        RETURN_STRING("string");
    }
    if (zend_string_equals_literal(type, "decimal")) {
        RETURN_STR(zend_strpprintf(0, "decimal scale " ZEND_LONG_FMT, scale));
    }
    if (zend_string_equals_literal(type, "time") || zend_string_equals_literal(type, "datetime")) {
        RETURN_STR(zend_strpprintf(0, "%s precision " ZEND_LONG_FMT, ZSTR_VAL(type), precision));
    }
    RETURN_STR_COPY(type);
}
