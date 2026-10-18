/* This is a generated file, edit the .stub.php file instead.
 * Stub hash: dd2876f6e048909e051ee82e062de4567d49dcb6 */

static zend_class_entry *register_class_Polyspec_Orm_Native_Code(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Native", "Code", NULL);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval const_VERSION_MISMATCH_value;
	zend_string *const_VERSION_MISMATCH_value_str = zend_string_init("VERSION_MISMATCH", strlen("VERSION_MISMATCH"), 1);
	ZVAL_STR(&const_VERSION_MISMATCH_value, const_VERSION_MISMATCH_value_str);
	zend_string *const_VERSION_MISMATCH_name = zend_string_init_interned("VERSION_MISMATCH", sizeof("VERSION_MISMATCH") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_VERSION_MISMATCH_name, &const_VERSION_MISMATCH_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_VERSION_MISMATCH_name);

	zval const_SCHEMA_HASH_MISMATCH_value;
	zend_string *const_SCHEMA_HASH_MISMATCH_value_str = zend_string_init("SCHEMA_HASH_MISMATCH", strlen("SCHEMA_HASH_MISMATCH"), 1);
	ZVAL_STR(&const_SCHEMA_HASH_MISMATCH_value, const_SCHEMA_HASH_MISMATCH_value_str);
	zend_string *const_SCHEMA_HASH_MISMATCH_name = zend_string_init_interned("SCHEMA_HASH_MISMATCH", sizeof("SCHEMA_HASH_MISMATCH") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SCHEMA_HASH_MISMATCH_name, &const_SCHEMA_HASH_MISMATCH_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SCHEMA_HASH_MISMATCH_name);

	zval const_SCHEMA_INVALID_value;
	zend_string *const_SCHEMA_INVALID_value_str = zend_string_init("SCHEMA_INVALID", strlen("SCHEMA_INVALID"), 1);
	ZVAL_STR(&const_SCHEMA_INVALID_value, const_SCHEMA_INVALID_value_str);
	zend_string *const_SCHEMA_INVALID_name = zend_string_init_interned("SCHEMA_INVALID", sizeof("SCHEMA_INVALID") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SCHEMA_INVALID_name, &const_SCHEMA_INVALID_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SCHEMA_INVALID_name);

	zval const_DIALECT_UNKNOWN_value;
	zend_string *const_DIALECT_UNKNOWN_value_str = zend_string_init("DIALECT_UNKNOWN", strlen("DIALECT_UNKNOWN"), 1);
	ZVAL_STR(&const_DIALECT_UNKNOWN_value, const_DIALECT_UNKNOWN_value_str);
	zend_string *const_DIALECT_UNKNOWN_name = zend_string_init_interned("DIALECT_UNKNOWN", sizeof("DIALECT_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_DIALECT_UNKNOWN_name, &const_DIALECT_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_DIALECT_UNKNOWN_name);

	zval const_IR_INVALID_value;
	zend_string *const_IR_INVALID_value_str = zend_string_init("IR_INVALID", strlen("IR_INVALID"), 1);
	ZVAL_STR(&const_IR_INVALID_value, const_IR_INVALID_value_str);
	zend_string *const_IR_INVALID_name = zend_string_init_interned("IR_INVALID", sizeof("IR_INVALID") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_IR_INVALID_name, &const_IR_INVALID_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_IR_INVALID_name);

	zval const_CAPABILITY_UNSUPPORTED_value;
	zend_string *const_CAPABILITY_UNSUPPORTED_value_str = zend_string_init("CAPABILITY_UNSUPPORTED", strlen("CAPABILITY_UNSUPPORTED"), 1);
	ZVAL_STR(&const_CAPABILITY_UNSUPPORTED_value, const_CAPABILITY_UNSUPPORTED_value_str);
	zend_string *const_CAPABILITY_UNSUPPORTED_name = zend_string_init_interned("CAPABILITY_UNSUPPORTED", sizeof("CAPABILITY_UNSUPPORTED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CAPABILITY_UNSUPPORTED_name, &const_CAPABILITY_UNSUPPORTED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CAPABILITY_UNSUPPORTED_name);

	zval const_ENTITY_UNKNOWN_value;
	zend_string *const_ENTITY_UNKNOWN_value_str = zend_string_init("ENTITY_UNKNOWN", strlen("ENTITY_UNKNOWN"), 1);
	ZVAL_STR(&const_ENTITY_UNKNOWN_value, const_ENTITY_UNKNOWN_value_str);
	zend_string *const_ENTITY_UNKNOWN_name = zend_string_init_interned("ENTITY_UNKNOWN", sizeof("ENTITY_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_ENTITY_UNKNOWN_name, &const_ENTITY_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_ENTITY_UNKNOWN_name);

	zval const_COLUMN_UNKNOWN_value;
	zend_string *const_COLUMN_UNKNOWN_value_str = zend_string_init("COLUMN_UNKNOWN", strlen("COLUMN_UNKNOWN"), 1);
	ZVAL_STR(&const_COLUMN_UNKNOWN_value, const_COLUMN_UNKNOWN_value_str);
	zend_string *const_COLUMN_UNKNOWN_name = zend_string_init_interned("COLUMN_UNKNOWN", sizeof("COLUMN_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_COLUMN_UNKNOWN_name, &const_COLUMN_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_COLUMN_UNKNOWN_name);

	zval const_RELATION_UNKNOWN_value;
	zend_string *const_RELATION_UNKNOWN_value_str = zend_string_init("RELATION_UNKNOWN", strlen("RELATION_UNKNOWN"), 1);
	ZVAL_STR(&const_RELATION_UNKNOWN_value, const_RELATION_UNKNOWN_value_str);
	zend_string *const_RELATION_UNKNOWN_name = zend_string_init_interned("RELATION_UNKNOWN", sizeof("RELATION_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_RELATION_UNKNOWN_name, &const_RELATION_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_RELATION_UNKNOWN_name);

	zval const_INDEX_UNKNOWN_value;
	zend_string *const_INDEX_UNKNOWN_value_str = zend_string_init("INDEX_UNKNOWN", strlen("INDEX_UNKNOWN"), 1);
	ZVAL_STR(&const_INDEX_UNKNOWN_value, const_INDEX_UNKNOWN_value_str);
	zend_string *const_INDEX_UNKNOWN_name = zend_string_init_interned("INDEX_UNKNOWN", sizeof("INDEX_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_INDEX_UNKNOWN_name, &const_INDEX_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_INDEX_UNKNOWN_name);

	zval const_COLUMN_ALIAS_CONFLICT_value;
	zend_string *const_COLUMN_ALIAS_CONFLICT_value_str = zend_string_init("COLUMN_ALIAS_CONFLICT", strlen("COLUMN_ALIAS_CONFLICT"), 1);
	ZVAL_STR(&const_COLUMN_ALIAS_CONFLICT_value, const_COLUMN_ALIAS_CONFLICT_value_str);
	zend_string *const_COLUMN_ALIAS_CONFLICT_name = zend_string_init_interned("COLUMN_ALIAS_CONFLICT", sizeof("COLUMN_ALIAS_CONFLICT") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_COLUMN_ALIAS_CONFLICT_name, &const_COLUMN_ALIAS_CONFLICT_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_COLUMN_ALIAS_CONFLICT_name);

	zval const_OPERATOR_UNKNOWN_value;
	zend_string *const_OPERATOR_UNKNOWN_value_str = zend_string_init("OPERATOR_UNKNOWN", strlen("OPERATOR_UNKNOWN"), 1);
	ZVAL_STR(&const_OPERATOR_UNKNOWN_value, const_OPERATOR_UNKNOWN_value_str);
	zend_string *const_OPERATOR_UNKNOWN_name = zend_string_init_interned("OPERATOR_UNKNOWN", sizeof("OPERATOR_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_OPERATOR_UNKNOWN_name, &const_OPERATOR_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_OPERATOR_UNKNOWN_name);

	zval const_FUNCTION_UNKNOWN_value;
	zend_string *const_FUNCTION_UNKNOWN_value_str = zend_string_init("FUNCTION_UNKNOWN", strlen("FUNCTION_UNKNOWN"), 1);
	ZVAL_STR(&const_FUNCTION_UNKNOWN_value, const_FUNCTION_UNKNOWN_value_str);
	zend_string *const_FUNCTION_UNKNOWN_name = zend_string_init_interned("FUNCTION_UNKNOWN", sizeof("FUNCTION_UNKNOWN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_FUNCTION_UNKNOWN_name, &const_FUNCTION_UNKNOWN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_FUNCTION_UNKNOWN_name);

	zval const_OPERATOR_NOT_ALLOWED_value;
	zend_string *const_OPERATOR_NOT_ALLOWED_value_str = zend_string_init("OPERATOR_NOT_ALLOWED", strlen("OPERATOR_NOT_ALLOWED"), 1);
	ZVAL_STR(&const_OPERATOR_NOT_ALLOWED_value, const_OPERATOR_NOT_ALLOWED_value_str);
	zend_string *const_OPERATOR_NOT_ALLOWED_name = zend_string_init_interned("OPERATOR_NOT_ALLOWED", sizeof("OPERATOR_NOT_ALLOWED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_OPERATOR_NOT_ALLOWED_name, &const_OPERATOR_NOT_ALLOWED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_OPERATOR_NOT_ALLOWED_name);

	zval const_OR_AT_GROUP_START_value;
	zend_string *const_OR_AT_GROUP_START_value_str = zend_string_init("OR_AT_GROUP_START", strlen("OR_AT_GROUP_START"), 1);
	ZVAL_STR(&const_OR_AT_GROUP_START_value, const_OR_AT_GROUP_START_value_str);
	zend_string *const_OR_AT_GROUP_START_name = zend_string_init_interned("OR_AT_GROUP_START", sizeof("OR_AT_GROUP_START") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_OR_AT_GROUP_START_name, &const_OR_AT_GROUP_START_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_OR_AT_GROUP_START_name);

	zval const_EMPTY_IN_value;
	zend_string *const_EMPTY_IN_value_str = zend_string_init("EMPTY_IN", strlen("EMPTY_IN"), 1);
	ZVAL_STR(&const_EMPTY_IN_value, const_EMPTY_IN_value_str);
	zend_string *const_EMPTY_IN_name = zend_string_init_interned("EMPTY_IN", sizeof("EMPTY_IN") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_EMPTY_IN_name, &const_EMPTY_IN_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_EMPTY_IN_name);

	zval const_ENTITY_NOT_JOINED_value;
	zend_string *const_ENTITY_NOT_JOINED_value_str = zend_string_init("ENTITY_NOT_JOINED", strlen("ENTITY_NOT_JOINED"), 1);
	ZVAL_STR(&const_ENTITY_NOT_JOINED_value, const_ENTITY_NOT_JOINED_value_str);
	zend_string *const_ENTITY_NOT_JOINED_name = zend_string_init_interned("ENTITY_NOT_JOINED", sizeof("ENTITY_NOT_JOINED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_ENTITY_NOT_JOINED_name, &const_ENTITY_NOT_JOINED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_ENTITY_NOT_JOINED_name);

	zval const_LIMIT_IN_RELATION_value;
	zend_string *const_LIMIT_IN_RELATION_value_str = zend_string_init("LIMIT_IN_RELATION", strlen("LIMIT_IN_RELATION"), 1);
	ZVAL_STR(&const_LIMIT_IN_RELATION_value, const_LIMIT_IN_RELATION_value_str);
	zend_string *const_LIMIT_IN_RELATION_name = zend_string_init_interned("LIMIT_IN_RELATION", sizeof("LIMIT_IN_RELATION") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_LIMIT_IN_RELATION_name, &const_LIMIT_IN_RELATION_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_LIMIT_IN_RELATION_name);

	zval const_NO_ROWS_value;
	zend_string *const_NO_ROWS_value_str = zend_string_init("NO_ROWS", strlen("NO_ROWS"), 1);
	ZVAL_STR(&const_NO_ROWS_value, const_NO_ROWS_value_str);
	zend_string *const_NO_ROWS_name = zend_string_init_interned("NO_ROWS", sizeof("NO_ROWS") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_NO_ROWS_name, &const_NO_ROWS_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_NO_ROWS_name);

	zval const_ROW_NOT_DELETED_value;
	zend_string *const_ROW_NOT_DELETED_value_str = zend_string_init("ROW_NOT_DELETED", strlen("ROW_NOT_DELETED"), 1);
	ZVAL_STR(&const_ROW_NOT_DELETED_value, const_ROW_NOT_DELETED_value_str);
	zend_string *const_ROW_NOT_DELETED_name = zend_string_init_interned("ROW_NOT_DELETED", sizeof("ROW_NOT_DELETED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_ROW_NOT_DELETED_name, &const_ROW_NOT_DELETED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_ROW_NOT_DELETED_name);

	zval const_BATCH_TOO_LARGE_value;
	zend_string *const_BATCH_TOO_LARGE_value_str = zend_string_init("BATCH_TOO_LARGE", strlen("BATCH_TOO_LARGE"), 1);
	ZVAL_STR(&const_BATCH_TOO_LARGE_value, const_BATCH_TOO_LARGE_value_str);
	zend_string *const_BATCH_TOO_LARGE_name = zend_string_init_interned("BATCH_TOO_LARGE", sizeof("BATCH_TOO_LARGE") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_BATCH_TOO_LARGE_name, &const_BATCH_TOO_LARGE_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_BATCH_TOO_LARGE_name);

	zval const_REVISION_CHANGED_value;
	zend_string *const_REVISION_CHANGED_value_str = zend_string_init("REVISION_CHANGED", strlen("REVISION_CHANGED"), 1);
	ZVAL_STR(&const_REVISION_CHANGED_value, const_REVISION_CHANGED_value_str);
	zend_string *const_REVISION_CHANGED_name = zend_string_init_interned("REVISION_CHANGED", sizeof("REVISION_CHANGED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_REVISION_CHANGED_name, &const_REVISION_CHANGED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_REVISION_CHANGED_name);

	zval const_COLUMN_UNSELECTED_value;
	zend_string *const_COLUMN_UNSELECTED_value_str = zend_string_init("COLUMN_UNSELECTED", strlen("COLUMN_UNSELECTED"), 1);
	ZVAL_STR(&const_COLUMN_UNSELECTED_value, const_COLUMN_UNSELECTED_value_str);
	zend_string *const_COLUMN_UNSELECTED_name = zend_string_init_interned("COLUMN_UNSELECTED", sizeof("COLUMN_UNSELECTED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_COLUMN_UNSELECTED_name, &const_COLUMN_UNSELECTED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_COLUMN_UNSELECTED_name);

	zval const_OPTIMISTIC_LOCK_value;
	zend_string *const_OPTIMISTIC_LOCK_value_str = zend_string_init("OPTIMISTIC_LOCK", strlen("OPTIMISTIC_LOCK"), 1);
	ZVAL_STR(&const_OPTIMISTIC_LOCK_value, const_OPTIMISTIC_LOCK_value_str);
	zend_string *const_OPTIMISTIC_LOCK_name = zend_string_init_interned("OPTIMISTIC_LOCK", sizeof("OPTIMISTIC_LOCK") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_OPTIMISTIC_LOCK_name, &const_OPTIMISTIC_LOCK_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_OPTIMISTIC_LOCK_name);

	zval const_WRITE_CONFLICT_value;
	zend_string *const_WRITE_CONFLICT_value_str = zend_string_init("WRITE_CONFLICT", strlen("WRITE_CONFLICT"), 1);
	ZVAL_STR(&const_WRITE_CONFLICT_value, const_WRITE_CONFLICT_value_str);
	zend_string *const_WRITE_CONFLICT_name = zend_string_init_interned("WRITE_CONFLICT", sizeof("WRITE_CONFLICT") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_WRITE_CONFLICT_name, &const_WRITE_CONFLICT_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_WRITE_CONFLICT_name);

	zval const_CODEC_DECODE_value;
	zend_string *const_CODEC_DECODE_value_str = zend_string_init("CODEC_DECODE", strlen("CODEC_DECODE"), 1);
	ZVAL_STR(&const_CODEC_DECODE_value, const_CODEC_DECODE_value_str);
	zend_string *const_CODEC_DECODE_name = zend_string_init_interned("CODEC_DECODE", sizeof("CODEC_DECODE") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CODEC_DECODE_name, &const_CODEC_DECODE_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CODEC_DECODE_name);

	zval const_CODEC_ENCODE_value;
	zend_string *const_CODEC_ENCODE_value_str = zend_string_init("CODEC_ENCODE", strlen("CODEC_ENCODE"), 1);
	ZVAL_STR(&const_CODEC_ENCODE_value, const_CODEC_ENCODE_value_str);
	zend_string *const_CODEC_ENCODE_name = zend_string_init_interned("CODEC_ENCODE", sizeof("CODEC_ENCODE") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CODEC_ENCODE_name, &const_CODEC_ENCODE_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CODEC_ENCODE_name);

	zval const_CODEC_UNSUPPORTED_value;
	zend_string *const_CODEC_UNSUPPORTED_value_str = zend_string_init("CODEC_UNSUPPORTED", strlen("CODEC_UNSUPPORTED"), 1);
	ZVAL_STR(&const_CODEC_UNSUPPORTED_value, const_CODEC_UNSUPPORTED_value_str);
	zend_string *const_CODEC_UNSUPPORTED_name = zend_string_init_interned("CODEC_UNSUPPORTED", sizeof("CODEC_UNSUPPORTED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CODEC_UNSUPPORTED_name, &const_CODEC_UNSUPPORTED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CODEC_UNSUPPORTED_name);

	zval const_CONFIG_value;
	zend_string *const_CONFIG_value_str = zend_string_init("CONFIG", strlen("CONFIG"), 1);
	ZVAL_STR(&const_CONFIG_value, const_CONFIG_value_str);
	zend_string *const_CONFIG_name = zend_string_init_interned("CONFIG", sizeof("CONFIG") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CONFIG_name, &const_CONFIG_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CONFIG_name);

	zval const_CANCELED_value;
	zend_string *const_CANCELED_value_str = zend_string_init("CANCELED", strlen("CANCELED"), 1);
	ZVAL_STR(&const_CANCELED_value, const_CANCELED_value_str);
	zend_string *const_CANCELED_name = zend_string_init_interned("CANCELED", sizeof("CANCELED") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CANCELED_name, &const_CANCELED_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CANCELED_name);

	zval const_ROLLBACK_value;
	zend_string *const_ROLLBACK_value_str = zend_string_init("ROLLBACK", strlen("ROLLBACK"), 1);
	ZVAL_STR(&const_ROLLBACK_value, const_ROLLBACK_value_str);
	zend_string *const_ROLLBACK_name = zend_string_init_interned("ROLLBACK", sizeof("ROLLBACK") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_ROLLBACK_name, &const_ROLLBACK_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_ROLLBACK_name);

	zval const_FAULT_value;
	zend_string *const_FAULT_value_str = zend_string_init("FAULT", strlen("FAULT"), 1);
	ZVAL_STR(&const_FAULT_value, const_FAULT_value_str);
	zend_string *const_FAULT_name = zend_string_init_interned("FAULT", sizeof("FAULT") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_FAULT_name, &const_FAULT_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_FAULT_name);

	zval const_SUBSCRIBER_value;
	zend_string *const_SUBSCRIBER_value_str = zend_string_init("SUBSCRIBER", strlen("SUBSCRIBER"), 1);
	ZVAL_STR(&const_SUBSCRIBER_value, const_SUBSCRIBER_value_str);
	zend_string *const_SUBSCRIBER_name = zend_string_init_interned("SUBSCRIBER", sizeof("SUBSCRIBER") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SUBSCRIBER_name, &const_SUBSCRIBER_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SUBSCRIBER_name);

	zval const_SCHEMA_DIFFERS_value;
	zend_string *const_SCHEMA_DIFFERS_value_str = zend_string_init("SCHEMA_DIFFERS", strlen("SCHEMA_DIFFERS"), 1);
	ZVAL_STR(&const_SCHEMA_DIFFERS_value, const_SCHEMA_DIFFERS_value_str);
	zend_string *const_SCHEMA_DIFFERS_name = zend_string_init_interned("SCHEMA_DIFFERS", sizeof("SCHEMA_DIFFERS") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SCHEMA_DIFFERS_name, &const_SCHEMA_DIFFERS_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SCHEMA_DIFFERS_name);

	zval const_INTERNAL_value;
	zend_string *const_INTERNAL_value_str = zend_string_init("INTERNAL", strlen("INTERNAL"), 1);
	ZVAL_STR(&const_INTERNAL_value, const_INTERNAL_value_str);
	zend_string *const_INTERNAL_name = zend_string_init_interned("INTERNAL", sizeof("INTERNAL") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_INTERNAL_name, &const_INTERNAL_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_INTERNAL_name);

	zval const_LOCK_NOT_AVAILABLE_value;
	zend_string *const_LOCK_NOT_AVAILABLE_value_str = zend_string_init("LOCK_NOT_AVAILABLE", strlen("LOCK_NOT_AVAILABLE"), 1);
	ZVAL_STR(&const_LOCK_NOT_AVAILABLE_value, const_LOCK_NOT_AVAILABLE_value_str);
	zend_string *const_LOCK_NOT_AVAILABLE_name = zend_string_init_interned("LOCK_NOT_AVAILABLE", sizeof("LOCK_NOT_AVAILABLE") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_LOCK_NOT_AVAILABLE_name, &const_LOCK_NOT_AVAILABLE_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_LOCK_NOT_AVAILABLE_name);

	zval const_DEADLOCK_value;
	zend_string *const_DEADLOCK_value_str = zend_string_init("DEADLOCK", strlen("DEADLOCK"), 1);
	ZVAL_STR(&const_DEADLOCK_value, const_DEADLOCK_value_str);
	zend_string *const_DEADLOCK_name = zend_string_init_interned("DEADLOCK", sizeof("DEADLOCK") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_DEADLOCK_name, &const_DEADLOCK_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_DEADLOCK_name);

	zval const_DUPLICATE_KEY_value;
	zend_string *const_DUPLICATE_KEY_value_str = zend_string_init("DUPLICATE_KEY", strlen("DUPLICATE_KEY"), 1);
	ZVAL_STR(&const_DUPLICATE_KEY_value, const_DUPLICATE_KEY_value_str);
	zend_string *const_DUPLICATE_KEY_name = zend_string_init_interned("DUPLICATE_KEY", sizeof("DUPLICATE_KEY") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_DUPLICATE_KEY_name, &const_DUPLICATE_KEY_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_DUPLICATE_KEY_name);

	zval const_FOREIGN_KEY_value;
	zend_string *const_FOREIGN_KEY_value_str = zend_string_init("FOREIGN_KEY", strlen("FOREIGN_KEY"), 1);
	ZVAL_STR(&const_FOREIGN_KEY_value, const_FOREIGN_KEY_value_str);
	zend_string *const_FOREIGN_KEY_name = zend_string_init_interned("FOREIGN_KEY", sizeof("FOREIGN_KEY") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_FOREIGN_KEY_name, &const_FOREIGN_KEY_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_FOREIGN_KEY_name);

	zval const_CONSTRAINT_value;
	zend_string *const_CONSTRAINT_value_str = zend_string_init("CONSTRAINT", strlen("CONSTRAINT"), 1);
	ZVAL_STR(&const_CONSTRAINT_value, const_CONSTRAINT_value_str);
	zend_string *const_CONSTRAINT_name = zend_string_init_interned("CONSTRAINT", sizeof("CONSTRAINT") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CONSTRAINT_name, &const_CONSTRAINT_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CONSTRAINT_name);

	zval const_READ_ONLY_value;
	zend_string *const_READ_ONLY_value_str = zend_string_init("READ_ONLY", strlen("READ_ONLY"), 1);
	ZVAL_STR(&const_READ_ONLY_value, const_READ_ONLY_value_str);
	zend_string *const_READ_ONLY_name = zend_string_init_interned("READ_ONLY", sizeof("READ_ONLY") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_READ_ONLY_name, &const_READ_ONLY_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_READ_ONLY_name);

	zval const_CONNECTION_LOST_value;
	zend_string *const_CONNECTION_LOST_value_str = zend_string_init("CONNECTION_LOST", strlen("CONNECTION_LOST"), 1);
	ZVAL_STR(&const_CONNECTION_LOST_value, const_CONNECTION_LOST_value_str);
	zend_string *const_CONNECTION_LOST_name = zend_string_init_interned("CONNECTION_LOST", sizeof("CONNECTION_LOST") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_CONNECTION_LOST_name, &const_CONNECTION_LOST_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_CONNECTION_LOST_name);

	zval const_DRIVER_value;
	zend_string *const_DRIVER_value_str = zend_string_init("DRIVER", strlen("DRIVER"), 1);
	ZVAL_STR(&const_DRIVER_value, const_DRIVER_value_str);
	zend_string *const_DRIVER_name = zend_string_init_interned("DRIVER", sizeof("DRIVER") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_DRIVER_name, &const_DRIVER_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_DRIVER_name);

	return class_entry;
}
