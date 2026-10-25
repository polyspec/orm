#include "php.h"
#include "Zend/zend_exceptions.h"
#include "dbspec.h"
#include "codec.h"
#include "orm_exception_object.h"
#include <string.h>

static zend_class_entry *aes_keyring_ce;
static zend_class_entry *aes_rotation_status_ce;

static void discard_result(zval *result)
{
    zval_ptr_dtor(result);
    ZVAL_UNDEF(result);
}

static bool aes_fail(const char *code, zend_string *message)
{
    orm_throw_exception(code, message);
    zend_string_release(message);
    return false;
}

static bool aes_failf(const char *code, const char *format, zend_long value)
{
    zend_string *message = strpprintf(0, format, value);
    return aes_fail(code, message);
}

static int aes_key_bucket_compare(Bucket *left, Bucket *right)
{
    if (Z_TYPE(left->val) == IS_LONG && Z_TYPE(right->val) == IS_LONG) {
        return (Z_LVAL(left->val) > Z_LVAL(right->val)) - (Z_LVAL(left->val) < Z_LVAL(right->val));
    }
    return dbs_compare_values(&left->val, &right->val);
}

static zend_long parse_stored_version(zval *value, bool *valid)
{
    *valid = false;
    if (Z_TYPE_P(value) == IS_LONG) {
        zend_long version = Z_LVAL_P(value);
        *valid = version > 0 && version <= 2147483647;
        return version;
    }
    if (Z_TYPE_P(value) != IS_STRING || Z_STRLEN_P(value) == 0) return 0;
    zend_long version = 0;
    for (size_t i = 0; i < Z_STRLEN_P(value); i++) {
        unsigned char ch = (unsigned char)Z_STRVAL_P(value)[i];
        if (ch < '0' || ch > '9') return 0;
        unsigned digit = ch - '0';
        if (version > (2147483647 - digit) / 10) return 0;
        version = version * 10 + digit;
    }
    *valid = version > 0;
    return version;
}

ZEND_METHOD(Polyspec_Orm_AesKeyring, __construct)
{
    HashTable *keys;
    zend_long current_version;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(keys)
        Z_PARAM_LONG(current_version)
    ZEND_PARSE_PARAMETERS_END();

    zend_ulong index;
    zend_string *key;
    zval *secret;
    ZEND_HASH_FOREACH_KEY_VAL(keys, index, key, secret) {
        zend_long version = key == NULL ? (zend_long)index : 0;
        if (key != NULL || version < 1 || Z_TYPE_P(secret) != IS_STRING || Z_STRLEN_P(secret) == 0) {
            if (key != NULL) {
                zend_string *message = strpprintf(0, "AES version %s has no key", ZSTR_VAL(key));
                aes_fail("CONFIG", message);
            } else {
                aes_failf("CONFIG", "AES version %ld has no key", version);
            }
            RETURN_THROWS();
        }
    } ZEND_HASH_FOREACH_END();
    if (current_version < 1 || !zend_hash_index_exists(keys, (zend_ulong)current_version)) {
        aes_failf("CONFIG", "AES version %ld is not declared", current_version);
        RETURN_THROWS();
    }
    zval key_values, current_value;
    ZVAL_ARR(&key_values, zend_array_dup(keys));
    ZVAL_LONG(&current_value, current_version);
    zend_update_property(aes_keyring_ce, Z_OBJ_P(ZEND_THIS), "keys", sizeof("keys") - 1, &key_values);
    zval_ptr_dtor(&key_values);
    if (EG(exception) != NULL) RETURN_THROWS();
    zend_update_property(aes_keyring_ce, Z_OBJ_P(ZEND_THIS), "currentVersion", sizeof("currentVersion") - 1, &current_value);
    if (EG(exception) != NULL) RETURN_THROWS();
}

ZEND_METHOD(Polyspec_Orm_AesKeyring, versions)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval rv;
    zval *keys = zend_read_property(aes_keyring_ce, Z_OBJ_P(ZEND_THIS), "keys", sizeof("keys") - 1, 1, &rv);
    array_init_size(return_value, zend_hash_num_elements(Z_ARRVAL_P(keys)));
    zend_ulong index;
    zend_string *key;
    ZEND_HASH_FOREACH_KEY(Z_ARRVAL_P(keys), index, key) {
        if (key == NULL) add_next_index_long(return_value, (zend_long)index);
    } ZEND_HASH_FOREACH_END();
    zend_hash_sort(Z_ARRVAL_P(return_value), aes_key_bucket_compare, 1);
}

ZEND_METHOD(Polyspec_Orm_AesKeyring, key)
{
    zend_long version;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_LONG(version)
    ZEND_PARSE_PARAMETERS_END();
    zval rv;
    zval *keys = zend_read_property(aes_keyring_ce, Z_OBJ_P(ZEND_THIS), "keys", sizeof("keys") - 1, 1, &rv);
    zval *key = zend_hash_index_find(Z_ARRVAL_P(keys), (zend_ulong)version);
    if (key == NULL) {
        aes_failf("CONFIG", "AES version %ld is not declared", version);
        RETURN_THROWS();
    }
    RETURN_STR_COPY(Z_STR_P(key));
}

ZEND_METHOD(Polyspec_Orm_AesKeyring, storedVersion)
{
    zval *value;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ZVAL(value)
    ZEND_PARSE_PARAMETERS_END();
    bool valid;
    zend_long version = parse_stored_version(value, &valid);
    if (!valid) {
        zend_string *shown = zval_get_string(value);
        zend_string *message = strpprintf(0, "aes version %s is not a positive 32-bit integer", ZSTR_VAL(shown));
        zend_string_release(shown);
        aes_fail("CODEC_DECODE", message);
        RETURN_THROWS();
    }
    RETURN_LONG(version);
}

ZEND_METHOD(Polyspec_Orm_AesKeyring, rotateRow)
{
    HashTable *row, *columns;
    zend_string *version_column;
    zend_long target_version;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_ARRAY_HT(row)
        Z_PARAM_STR(version_column)
        Z_PARAM_ARRAY_HT(columns)
        Z_PARAM_LONG(target_version)
    ZEND_PARSE_PARAMETERS_END();

    zval *stored = zend_hash_find(row, version_column);
    if (stored == NULL) {
        zend_string *message = strpprintf(0, "AES version column %s is missing", ZSTR_VAL(version_column));
        aes_fail("INTERNAL", message);
        RETURN_THROWS();
    }
    zval rv, *keys = zend_read_property(aes_keyring_ce, Z_OBJ_P(ZEND_THIS), "keys", sizeof("keys") - 1, 1, &rv);
    ZVAL_ARR(return_value, zend_array_dup(row));
    bool changed = false;
    zend_string *old_key = NULL, *new_key = NULL;
    zval *column;
    ZEND_HASH_FOREACH_VAL(columns, column) {
        if (Z_TYPE_P(column) != IS_ARRAY) {
            discard_result(return_value);
            aes_fail("INTERNAL", zend_string_init(ZEND_STRL("AES column declaration is invalid"), 0));
            RETURN_THROWS();
        }
        zval *name_value = zend_hash_str_find(Z_ARRVAL_P(column), "name", sizeof("name") - 1);
        zval *styles_value = zend_hash_str_find(Z_ARRVAL_P(column), "styles", sizeof("styles") - 1);
        if (name_value == NULL || Z_TYPE_P(name_value) != IS_STRING || styles_value == NULL || Z_TYPE_P(styles_value) != IS_ARRAY) {
            discard_result(return_value);
            aes_fail("INTERNAL", zend_string_init(ZEND_STRL("AES column declaration is invalid"), 0));
            RETURN_THROWS();
        }
        zend_string *name = Z_STR_P(name_value);
        zval *cell = zend_hash_find(row, name);
        if (cell == NULL) {
            discard_result(return_value);
            zend_string *message = strpprintf(0, "AES column %s is missing", ZSTR_VAL(name));
            aes_fail("INTERNAL", message);
            RETURN_THROWS();
        }
        if (Z_TYPE_P(cell) == IS_NULL) continue;
        if (old_key == NULL) {
            bool valid;
            zend_long old_version = parse_stored_version(stored, &valid);
            if (!valid) {
                discard_result(return_value);
                zend_string *shown = zval_get_string(stored);
                zend_string *message = strpprintf(0, "aes version %s is not a positive 32-bit integer", ZSTR_VAL(shown));
                zend_string_release(shown);
                aes_fail("CODEC_DECODE", message);
                RETURN_THROWS();
            }
            zval *old_secret = zend_hash_index_find(Z_ARRVAL_P(keys), (zend_ulong)old_version);
            zval *new_secret = zend_hash_index_find(Z_ARRVAL_P(keys), (zend_ulong)target_version);
            if (old_secret == NULL) {
                discard_result(return_value);
                aes_failf("CONFIG", "AES version %ld is not declared", old_version);
                RETURN_THROWS();
            }
            if (new_secret == NULL) {
                discard_result(return_value);
                aes_failf("CONFIG", "AES version %ld is not declared", target_version);
                RETURN_THROWS();
            }
            old_key = zend_string_copy(Z_STR_P(old_secret));
            new_key = zend_string_copy(Z_STR_P(new_secret));
        }
        zval plain, encoded;
        if (!codec_host_decode(cell, Z_ARRVAL_P(styles_value), old_key, &plain)) {
            discard_result(return_value);
            zend_string_release(old_key);
            zend_string_release(new_key);
            RETURN_THROWS();
        }
        if (!codec_host_encode(&plain, Z_ARRVAL_P(styles_value), new_key, &encoded)) {
            zval_ptr_dtor(&plain);
            discard_result(return_value);
            zend_string_release(old_key);
            zend_string_release(new_key);
            RETURN_THROWS();
        }
        zval_ptr_dtor(&plain);
        zend_hash_update(Z_ARRVAL_P(return_value), name, &encoded);
        changed = true;
    } ZEND_HASH_FOREACH_END();
    if (old_key != NULL) {
        zend_string_release(old_key);
        zend_string_release(new_key);
    }
    if (changed) {
        zval version_value;
        ZVAL_LONG(&version_value, target_version);
        zend_hash_update(Z_ARRVAL_P(return_value), version_column, &version_value);
    }
}

ZEND_METHOD(Polyspec_Orm_AesRotationStatus, __construct)
{
    zend_long current, total, pending;
    zval *versions;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_LONG(current)
        Z_PARAM_LONG(total)
        Z_PARAM_LONG(pending)
        Z_PARAM_ARRAY(versions)
    ZEND_PARSE_PARAMETERS_END();
    zval current_value, total_value, pending_value;
    ZVAL_LONG(&current_value, current);
    ZVAL_LONG(&total_value, total);
    ZVAL_LONG(&pending_value, pending);
    zend_update_property(aes_rotation_status_ce, Z_OBJ_P(ZEND_THIS), "current", sizeof("current") - 1, &current_value);
    zend_update_property(aes_rotation_status_ce, Z_OBJ_P(ZEND_THIS), "total", sizeof("total") - 1, &total_value);
    zend_update_property(aes_rotation_status_ce, Z_OBJ_P(ZEND_THIS), "pending", sizeof("pending") - 1, &pending_value);
    zend_update_property(aes_rotation_status_ce, Z_OBJ_P(ZEND_THIS), "versions", sizeof("versions") - 1, versions);
}

void aes_keyring_set_class(zend_class_entry *ce)
{
    aes_keyring_ce = ce;
}

void aes_rotation_status_set_class(zend_class_entry *ce)
{
    aes_rotation_status_ce = ce;
}
