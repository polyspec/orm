/* This is a generated file, edit the .stub.php file instead.
 * Stub hash: 4daa671381dcc1e0424a64c7cbafcbb303bf239b */

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Diagnostic___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, rule, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, line, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, message, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Position___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, path, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, line, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_LONG, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Document___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_UseLine___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, document, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, tables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Table___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Column___construct, 0, 0, 5)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, type, Polyspec\\Orm\\Dbspec\\ColumnType, 0)
	ZEND_ARG_TYPE_INFO(0, nullable, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, identity, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, default, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ColumnType___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, parameters, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ColumnType_text, 0, 0, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ColumnType_isInteger, 0, 0, _IS_BOOL, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PrimaryKey___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_UniqueKey___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Index___construct arginfo_class_Polyspec_Orm_Dbspec_UniqueKey___construct

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_IndexColumn___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, descending, _IS_BOOL, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ForeignKey___construct, 0, 0, 6)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, referencedColumns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, onDelete, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, onUpdate, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_ForeignKey_changesChildRows arginfo_class_Polyspec_Orm_Dbspec_ColumnType_isInteger

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Check___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, expression, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Settings___construct, 0, 0, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Setting___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, arguments, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, exclude, IS_ARRAY, 1, "null")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, include, IS_ARRAY, 1, "null")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, form, IS_STRING, 1, "null")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, requires, IS_ARRAY, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Setting_records, 0, 1, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Setting_excluded, 0, 1, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, table, Polyspec\\Orm\\Dbspec\\Table, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Setting_auditLine, 0, 2, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, list, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 1)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Diagram___construct arginfo_class_Polyspec_Orm_Dbspec_Table___construct

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Placement___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, x, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, y, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ReadResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ReadResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ReadResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_SetFile___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, path, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, bytes, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_SetError___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, rule, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, path, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, message, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_SetResult___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, external, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, errors, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_SetResult_valid, 0, 2, Polyspec\\Orm\\Dbspec\\SetResult, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, external, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_SetResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\SetResult, 0)
	ZEND_ARG_TYPE_INFO(0, errors, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_SetDocument___construct, 0, 0, 5)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, external, _IS_BOOL, 0)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 1)
	ZEND_ARG_TYPE_INFO(0, positions, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ParseResult___construct, 0, 0, 3)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, positions, IS_ARRAY, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ParseResult_valid, 0, 2, Polyspec\\Orm\\Dbspec\\ParseResult, 0)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, positions, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ParseResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\ParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Token___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, line, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, start, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, end, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, class, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Analysis___construct, 0, 0, 4)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 1)
	ZEND_ARG_TYPE_INFO(0, positions, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, tokens, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_FormatResult___construct arginfo_class_Polyspec_Orm_Dbspec_ReadResult___construct

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Names_render, 0, 2, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, suffix, IS_STRING, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Names_ofTable arginfo_class_Polyspec_Orm_Dbspec_Setting_excluded

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Names_column, 0, 3, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_OBJ_TYPE_MASK(0, columns, Traversable, MAY_BE_ARRAY, NULL)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Manifest___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, manifestText, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, schemaText, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, manifestHash, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, schemaHash, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, externalText, IS_STRING, 0, "\'\'")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ManifestResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, manifest, Polyspec\\Orm\\Dbspec\\Manifest, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ManifestResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\ManifestResult, 0)
	ZEND_ARG_OBJ_INFO(0, manifest, Polyspec\\Orm\\Dbspec\\Manifest, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ManifestResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\ManifestResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_RenderResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, statements, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_RenderResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\RenderResult, 0)
	ZEND_ARG_TYPE_INFO(0, statements, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_RenderResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\RenderResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Plan___construct, 0, 0, 8)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, from, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, renameTables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, renameColumns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, dropTables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, dropColumns, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, schema, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, to, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanStep___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, statement, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, rollback, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, irreversible, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, effect, Polyspec\\Orm\\Dbspec\\Effect, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, restore, IS_STRING, 0, "\'\'")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, rollbackRestore, IS_STRING, 0, "\'\'")
	ZEND_ARG_OBJ_INFO_WITH_DEFAULT_VALUE(0, restoreIf, Polyspec\\Orm\\Dbspec\\Effect, 1, "null")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, nullChecks, IS_ARRAY, 0, "[]")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, finalize, _IS_BOOL, 0, "false")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Effect___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, present, _IS_BOOL, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Effect_repeat, 0, 0, Polyspec\\Orm\\Dbspec\\Effect, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Effect_text arginfo_class_Polyspec_Orm_Dbspec_ColumnType_text

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_NullCheck___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, default, IS_STRING, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Change___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Difference___construct arginfo_class_Polyspec_Orm_Dbspec_Change___construct

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Unsupported___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, reason, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_TableRename___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, old, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, new, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ColumnRename___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, old, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, new, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ColumnName___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ApplyEvent___construct, 0, 0, 5)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plan, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, step, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, steps, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, statement, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ApplyError___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, code_, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plan, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, step, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, detail, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO_WITH_DEFAULT_VALUE(0, previous, Throwable, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ApplyCleanupError___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, failure, Throwable, 0)
	ZEND_ARG_TYPE_INFO(0, cleanup, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanParseResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, plan, Polyspec\\Orm\\Dbspec\\Plan, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanParseResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\PlanParseResult, 0)
	ZEND_ARG_OBJ_INFO(0, plan, Polyspec\\Orm\\Dbspec\\Plan, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanParseResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\PlanParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanStepsResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, steps, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanStepsResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\PlanStepsResult, 0)
	ZEND_ARG_TYPE_INFO(0, steps, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanStepsResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\PlanStepsResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ChainResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ChainResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\ChainResult, 0)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ChainResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\ChainResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_DiffResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, changes, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_DiffResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\DiffResult, 0)
	ZEND_ARG_TYPE_INFO(0, changes, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_DiffResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\DiffResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ComparisonResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, differences, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ComparisonResult_valid, 0, 1, Polyspec\\Orm\\Dbspec\\ComparisonResult, 0)
	ZEND_ARG_TYPE_INFO(0, differences, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_ComparisonResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\ComparisonResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_MermaidExportResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, dropped, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_MermaidImportResult___construct, 0, 0, 3)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 1)
	ZEND_ARG_TYPE_INFO(0, dropped, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_MermaidImportResult_valid, 0, 2, Polyspec\\Orm\\Dbspec\\MermaidImportResult, 0)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, dropped, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_MermaidImportResult_invalid, 0, 1, Polyspec\\Orm\\Dbspec\\MermaidImportResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_IntrospectResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, unsupported, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_parse, 0, 2, Polyspec\\Orm\\Dbspec\\ParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_analyze, 0, 2, Polyspec\\Orm\\Dbspec\\Analysis, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_format, 0, 2, Polyspec\\Orm\\Dbspec\\FormatResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_readFile, 0, 1, Polyspec\\Orm\\Dbspec\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, path, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_readBytes, 0, 2, Polyspec\\Orm\\Dbspec\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, bytes, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_readSet, 0, 1, Polyspec\\Orm\\Dbspec\\SetResult, 0)
	ZEND_ARG_TYPE_INFO(0, path, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_parseSet, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, owned, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, external, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_emit, 0, 1, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_render, 0, 2, Polyspec\\Orm\\Dbspec\\RenderResult, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_introspect, 0, 3, Polyspec\\Orm\\Dbspec\\IntrospectResult, 0)
	ZEND_ARG_OBJ_INFO(0, connection, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_manifest, 0, 1, Polyspec\\Orm\\Dbspec\\ManifestResult, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_externalDifferences, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, live, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_parsePlan, 0, 1, Polyspec\\Orm\\Dbspec\\PlanParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_emitPlan, 0, 1, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, plan, Polyspec\\Orm\\Dbspec\\Plan, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Dbspec_chain arginfo_class_Polyspec_Orm_Dbspec_ChainResult_valid

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_diff, 0, 2, Polyspec\\Orm\\Dbspec\\DiffResult, 0)
	ZEND_ARG_OBJ_INFO(0, source, Polyspec\\Orm\\Dbspec\\Document, 1)
	ZEND_ARG_OBJ_INFO(0, plan, Polyspec\\Orm\\Dbspec\\Plan, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_compareSchemas, 0, 2, Polyspec\\Orm\\Dbspec\\ComparisonResult, 0)
	ZEND_ARG_OBJ_INFO(0, source, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_OBJ_INFO(0, target, Polyspec\\Orm\\Dbspec\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_installedDifferences, 0, 3, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, live, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, unsupported, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, target, Polyspec\\Orm\\Dbspec\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_addTablesAndColumnsSteps, 0, 4, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, live, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, unsupported, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, target, Polyspec\\Orm\\Dbspec\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_planSteps, 0, 3, Polyspec\\Orm\\Dbspec\\PlanStepsResult, 0)
	ZEND_ARG_OBJ_INFO(0, source, Polyspec\\Orm\\Dbspec\\Document, 1)
	ZEND_ARG_OBJ_INFO(0, plan, Polyspec\\Orm\\Dbspec\\Plan, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_apply, 0, 5, IS_VOID, 0)
	ZEND_ARG_OBJ_INFO(0, connection, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, now, Closure, 0)
	ZEND_ARG_OBJ_INFO(0, events, Closure, 1)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_Dbspec_recover arginfo_class_Polyspec_Orm_Dbspec_Dbspec_apply

#define arginfo_class_Polyspec_Orm_Dbspec_Dbspec_rollback arginfo_class_Polyspec_Orm_Dbspec_Dbspec_apply

#define arginfo_class_Polyspec_Orm_Dbspec_Dbspec_finalize arginfo_class_Polyspec_Orm_Dbspec_Dbspec_apply

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_exportMermaid, 0, 1, Polyspec\\Orm\\Dbspec\\MermaidExportResult, 0)
	ZEND_ARG_OBJ_INFO(0, document, Polyspec\\Orm\\Dbspec\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_Dbspec_importMermaid, 0, 2, Polyspec\\Orm\\Dbspec\\MermaidImportResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanApply___construct, 0, 0, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanApply_apply, 0, 5, IS_VOID, 0)
	ZEND_ARG_OBJ_INFO(0, c, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, now, Closure, 0)
	ZEND_ARG_OBJ_INFO(0, events, Closure, 1)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Dbspec_PlanApply_recover arginfo_class_Polyspec_Orm_Dbspec_PlanApply_apply

#define arginfo_class_Polyspec_Orm_Dbspec_PlanApply_rollback arginfo_class_Polyspec_Orm_Dbspec_PlanApply_apply

#define arginfo_class_Polyspec_Orm_Dbspec_PlanApply_finalize arginfo_class_Polyspec_Orm_Dbspec_PlanApply_apply

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Dbspec_PlanApply_effectOn, 0, 3, _IS_BOOL, 0)
	ZEND_ARG_OBJ_INFO(0, c, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, e, Polyspec\\Orm\\Dbspec\\Effect, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Codec_blindIndex, 0, 2, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, v, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, key, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Codec_decode, 0, 2, Polyspec\\Orm\\StyledValue, 0)
	ZEND_ARG_TYPE_INFO(0, styles, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, raw, IS_MIXED, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_TYPE_MASK_EX(arginfo_class_Polyspec_Orm_Codec_encode, 0, 2, Polyspec\\Orm\\Bytes, MAY_BE_STRING|MAY_BE_NULL)
	ZEND_ARG_TYPE_INFO(0, styles, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, v, Polyspec\\Orm\\StyledValue, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Codec_isHostStyle, 0, 1, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, style, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_TYPE_MASK_EX(arginfo_class_Polyspec_Orm_Codec_hostEncode, 0, 3, Polyspec\\Orm\\Bytes, MAY_BE_STRING|MAY_BE_NULL)
	ZEND_ARG_TYPE_INFO(0, v, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, styles, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, aesKey, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Codec_hostDecode, 0, 3, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, raw, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, styles, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, aesKey, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Codec_decodeRows, 0, 3, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(1, rows, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, cells, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, config, Polyspec\\Orm\\Config, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Validator___construct, 0, 0, 1)
	ZEND_ARG_OBJ_INFO(0, m, Polyspec\\Orm\\RuntimeModel, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_opAllowed, 0, 2, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, c, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, op, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_validate, 0, 1, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, r, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_restoreKey, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, ent, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, r, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_paramUses, 0, 1, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, r, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_functionType, 0, 2, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, col, IS_ARRAY, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_intervalType, 0, 1, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Validator_conflictKey, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, ent, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, set, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Planner___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, m, Polyspec\\Orm\\RuntimeModel, 0)
	ZEND_ARG_OBJ_INFO(0, d, Polyspec\\Orm\\Dialect, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Planner_compile arginfo_class_Polyspec_Orm_Validator_paramUses

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Polyspec_Orm_Db___construct, 0, 0, 4)
	ZEND_ARG_OBJ_INFO(0, pdo, PDO, 1)
	ZEND_ARG_TYPE_INFO(0, driver, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, config, Polyspec\\Orm\\Config, 0)
	ZEND_ARG_OBJ_INFO(0, zone, DateTimeZone, 0)
	ZEND_ARG_OBJ_INFO_WITH_DEFAULT_VALUE(0, md, Polyspec\\Orm\\MarkdownSession, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_registerSet, 0, 1, IS_VOID, 0)
	ZEND_ARG_OBJ_INFO(0, schema, Polyspec\\Orm\\Schema, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Db_driver arginfo_class_Polyspec_Orm_Dbspec_ColumnType_text

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_markdownSession, 0, 0, Polyspec\\Orm\\MarkdownSession, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_unsupportedOnMarkdown, 0, 1, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, surface, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_registeredModel, 0, 1, Polyspec\\Orm\\RuntimeModel, 0)
	ZEND_ARG_TYPE_INFO(0, hash, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_zone, 0, 0, DateTimeZone, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_config, 0, 0, Polyspec\\Orm\\Config, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_pdo, 0, 0, PDO, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_driverError, 0, 1, Polyspec\\Orm\\OrmException, 0)
	ZEND_ARG_OBJ_INFO(0, e, PDOException, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_utils, 0, 0, Polyspec\\Orm\\\125tils, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_stats, 0, 0, Polyspec\\Orm\\Stats, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_close, 0, 0, IS_VOID, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_withRequestHook, 0, 1, Polyspec\\Orm\\Db, 0)
	ZEND_ARG_OBJ_INFO(0, hook, Closure, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_subscribe, 0, 1, Closure, 0)
	ZEND_ARG_OBJ_INFO(0, subscriber, Closure, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_setListener, 0, 1, IS_VOID, 0)
	ZEND_ARG_OBJ_INFO(0, open, Closure, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_listener, 0, 0, Closure, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_notify, 0, 2, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, channel, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, payload, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_listen, 0, 1, Polyspec\\Orm\\Subscription, 0)
	ZEND_ARG_TYPE_INFO(0, channel, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_nextTransaction, 0, 0, IS_LONG, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_transactionNumber, 0, 0, IS_LONG, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_publish, 0, 7, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, tables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, transaction, IS_LONG, 1)
	ZEND_ARG_TYPE_INFO(0, sql, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, binds, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, start, IS_LONG, 0)
	ZEND_ARG_OBJ_INFO(0, error, Polyspec\\Orm\\OrmException, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_observed, 0, 6, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, tables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, transaction, IS_LONG, 1)
	ZEND_ARG_TYPE_INFO(0, sql, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, binds, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, send, Closure, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_run, 0, 4, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, tables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, transaction, IS_LONG, 1)
	ZEND_ARG_TYPE_INFO(0, sql, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, control, _IS_BOOL, 0, "false")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_fetch, 0, 4, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, tables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, transaction, IS_LONG, 1)
	ZEND_ARG_TYPE_INFO(0, sql, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, args, IS_ARRAY, 0, "[]")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, control, _IS_BOOL, 0, "false")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_bindLimit, 0, 1, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, driver, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_insertParts, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, rows, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, batch, IS_LONG, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_activeFor, 0, 1, Polyspec\\Orm\\TxFrame, 1)
	ZEND_ARG_OBJ_INFO(0, db, Polyspec\\Orm\\Db, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_resolve, 0, 1, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, conn, Polyspec\\Orm\\Db, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_inTransaction, 0, 2, IS_VOID, 0)
	ZEND_ARG_OBJ_INFO(0, conn, Polyspec\\Orm\\Db, 1)
	ZEND_ARG_OBJ_INFO(0, fn, Closure, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_transaction, 0, 1, IS_MIXED, 0)
	ZEND_ARG_OBJ_INFO(0, fn, Closure, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, isolation, IS_STRING, 0, "\'\'")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, readOnly, _IS_BOOL, 0, "false")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, timeoutMs, IS_LONG, 0, "0")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, retry, IS_LONG, 0, "3")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, audit, IS_ARRAY, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_select, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, frame, Polyspec\\Orm\\TxFrame, 1)
	ZEND_ARG_OBJ_INFO(0, r, Polyspec\\Orm\\Request, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_scalarOf, 0, 2, IS_MIXED, 0)
	ZEND_ARG_OBJ_INFO(0, frame, Polyspec\\Orm\\TxFrame, 1)
	ZEND_ARG_OBJ_INFO(0, r, Polyspec\\Orm\\Request, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Polyspec_Orm_Db_paginate arginfo_class_Polyspec_Orm_Db_select

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_writeOf, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, frame, Polyspec\\Orm\\TxFrame, 1)
	ZEND_ARG_OBJ_INFO(0, r, Polyspec\\Orm\\Request, 0)
	ZEND_ARG_OBJ_INFO_WITH_DEFAULT_VALUE(0, afterHook, Closure, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_execute, 0, 2, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, step, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, params, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_statement, 0, 1, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, r, Polyspec\\Orm\\Request, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Polyspec_Orm_Db_clock, 0, 0, DateTimeImmutable, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_timeValue, 0, 4, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, v, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, colType, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, precision, IS_LONG, 0)
	ZEND_ARG_OBJ_INFO(0, zone, DateTimeZone, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_acquireSQLiteRowLock, 0, 1, IS_VOID, 0)
	ZEND_ARG_TYPE_INFO(0, mode, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_TYPE_MASK_EX(arginfo_class_Polyspec_Orm_Db_rowKey, 0, 2, Polyspec\\Orm\\Bytes|DateTimeInterface, MAY_BE_LONG|MAY_BE_STRING|MAY_BE_BOOL|MAY_BE_NULL)
	ZEND_ARG_TYPE_INFO(0, row, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, refs, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_rowSlot, 0, 2, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, row, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, refs, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_sameScalar, 0, 2, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, a, IS_MIXED, 0)
	ZEND_ARG_TYPE_INFO(0, b, IS_MIXED, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Polyspec_Orm_Db_scalarText, 0, 1, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, v, IS_MIXED, 0)
ZEND_END_ARG_INFO()

ZEND_METHOD(Polyspec_Orm_Dbspec_Diagnostic, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Position, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Document, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_UseLine, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Table, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Column, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnType, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnType, text);
ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnType, isInteger);
ZEND_METHOD(Polyspec_Orm_Dbspec_PrimaryKey, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_UniqueKey, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Index, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_IndexColumn, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ForeignKey, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ForeignKey, changesChildRows);
ZEND_METHOD(Polyspec_Orm_Dbspec_Check, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Settings, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, records);
ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, excluded);
ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, auditLine);
ZEND_METHOD(Polyspec_Orm_Dbspec_Diagram, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Placement, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ReadResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ReadResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ReadResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_SetFile, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_SetError, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_SetResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_SetResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_SetResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_SetDocument, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ParseResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ParseResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ParseResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_Token, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Analysis, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_FormatResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Names, render);
ZEND_METHOD(Polyspec_Orm_Dbspec_Names, ofTable);
ZEND_METHOD(Polyspec_Orm_Dbspec_Names, column);
ZEND_METHOD(Polyspec_Orm_Dbspec_Manifest, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ManifestResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ManifestResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ManifestResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_RenderResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_RenderResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_RenderResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_Plan, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanStep, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Effect, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Effect, repeat);
ZEND_METHOD(Polyspec_Orm_Dbspec_Effect, text);
ZEND_METHOD(Polyspec_Orm_Dbspec_NullCheck, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Change, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Difference, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Unsupported, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_TableRename, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnRename, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnName, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ApplyEvent, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ApplyError, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ApplyCleanupError, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanParseResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanParseResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanParseResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanStepsResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanStepsResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanStepsResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ChainResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ChainResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ChainResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_DiffResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_DiffResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_DiffResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ComparisonResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_ComparisonResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_ComparisonResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidExportResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidImportResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidImportResult, valid);
ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidImportResult, invalid);
ZEND_METHOD(Polyspec_Orm_Dbspec_IntrospectResult, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, parse);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, analyze);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, format);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, readFile);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, readBytes);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, readSet);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, parseSet);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, emit);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, render);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, introspect);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, manifest);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, externalDifferences);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, parsePlan);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, emitPlan);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, chain);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, diff);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, compareSchemas);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, installedDifferences);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, addTablesAndColumnsSteps);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, planSteps);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, apply);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, recover);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, rollback);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, finalize);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, exportMermaid);
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, importMermaid);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, __construct);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, apply);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, recover);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, rollback);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, finalize);
ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, effectOn);
ZEND_METHOD(Polyspec_Orm_Codec, blindIndex);
ZEND_METHOD(Polyspec_Orm_Codec, decode);
ZEND_METHOD(Polyspec_Orm_Codec, encode);
ZEND_METHOD(Polyspec_Orm_Codec, isHostStyle);
ZEND_METHOD(Polyspec_Orm_Codec, hostEncode);
ZEND_METHOD(Polyspec_Orm_Codec, hostDecode);
ZEND_METHOD(Polyspec_Orm_Codec, decodeRows);
ZEND_METHOD(Polyspec_Orm_Validator, __construct);
ZEND_METHOD(Polyspec_Orm_Validator, opAllowed);
ZEND_METHOD(Polyspec_Orm_Validator, validate);
ZEND_METHOD(Polyspec_Orm_Validator, restoreKey);
ZEND_METHOD(Polyspec_Orm_Validator, paramUses);
ZEND_METHOD(Polyspec_Orm_Validator, functionType);
ZEND_METHOD(Polyspec_Orm_Validator, intervalType);
ZEND_METHOD(Polyspec_Orm_Validator, conflictKey);
ZEND_METHOD(Polyspec_Orm_Planner, __construct);
ZEND_METHOD(Polyspec_Orm_Planner, compile);
ZEND_METHOD(Polyspec_Orm_Db, __construct);
ZEND_METHOD(Polyspec_Orm_Db, registerSet);
ZEND_METHOD(Polyspec_Orm_Db, driver);
ZEND_METHOD(Polyspec_Orm_Db, markdownSession);
ZEND_METHOD(Polyspec_Orm_Db, unsupportedOnMarkdown);
ZEND_METHOD(Polyspec_Orm_Db, registeredModel);
ZEND_METHOD(Polyspec_Orm_Db, zone);
ZEND_METHOD(Polyspec_Orm_Db, config);
ZEND_METHOD(Polyspec_Orm_Db, pdo);
ZEND_METHOD(Polyspec_Orm_Db, driverError);
ZEND_METHOD(Polyspec_Orm_Db, utils);
ZEND_METHOD(Polyspec_Orm_Db, stats);
ZEND_METHOD(Polyspec_Orm_Db, close);
ZEND_METHOD(Polyspec_Orm_Db, withRequestHook);
ZEND_METHOD(Polyspec_Orm_Db, subscribe);
ZEND_METHOD(Polyspec_Orm_Db, setListener);
ZEND_METHOD(Polyspec_Orm_Db, listener);
ZEND_METHOD(Polyspec_Orm_Db, notify);
ZEND_METHOD(Polyspec_Orm_Db, listen);
ZEND_METHOD(Polyspec_Orm_Db, nextTransaction);
ZEND_METHOD(Polyspec_Orm_Db, transactionNumber);
ZEND_METHOD(Polyspec_Orm_Db, publish);
ZEND_METHOD(Polyspec_Orm_Db, observed);
ZEND_METHOD(Polyspec_Orm_Db, run);
ZEND_METHOD(Polyspec_Orm_Db, fetch);
ZEND_METHOD(Polyspec_Orm_Db, bindLimit);
ZEND_METHOD(Polyspec_Orm_Db, insertParts);
ZEND_METHOD(Polyspec_Orm_Db, activeFor);
ZEND_METHOD(Polyspec_Orm_Db, resolve);
ZEND_METHOD(Polyspec_Orm_Db, inTransaction);
ZEND_METHOD(Polyspec_Orm_Db, transaction);
ZEND_METHOD(Polyspec_Orm_Db, select);
ZEND_METHOD(Polyspec_Orm_Db, scalarOf);
ZEND_METHOD(Polyspec_Orm_Db, paginate);
ZEND_METHOD(Polyspec_Orm_Db, writeOf);
ZEND_METHOD(Polyspec_Orm_Db, execute);
ZEND_METHOD(Polyspec_Orm_Db, statement);
ZEND_METHOD(Polyspec_Orm_Db, clock);
ZEND_METHOD(Polyspec_Orm_Db, timeValue);
ZEND_METHOD(Polyspec_Orm_Db, acquireSQLiteRowLock);
ZEND_METHOD(Polyspec_Orm_Db, rowKey);
ZEND_METHOD(Polyspec_Orm_Db, rowSlot);
ZEND_METHOD(Polyspec_Orm_Db, sameScalar);
ZEND_METHOD(Polyspec_Orm_Db, scalarText);

static const zend_function_entry class_Polyspec_Orm_Dbspec_Diagnostic_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Diagnostic, __construct, arginfo_class_Polyspec_Orm_Dbspec_Diagnostic___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Position_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Position, __construct, arginfo_class_Polyspec_Orm_Dbspec_Position___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Document_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Document, __construct, arginfo_class_Polyspec_Orm_Dbspec_Document___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_UseLine_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_UseLine, __construct, arginfo_class_Polyspec_Orm_Dbspec_UseLine___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Table_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Table, __construct, arginfo_class_Polyspec_Orm_Dbspec_Table___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Column_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Column, __construct, arginfo_class_Polyspec_Orm_Dbspec_Column___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ColumnType_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ColumnType, __construct, arginfo_class_Polyspec_Orm_Dbspec_ColumnType___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ColumnType, text, arginfo_class_Polyspec_Orm_Dbspec_ColumnType_text, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ColumnType, isInteger, arginfo_class_Polyspec_Orm_Dbspec_ColumnType_isInteger, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_PrimaryKey_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_PrimaryKey, __construct, arginfo_class_Polyspec_Orm_Dbspec_PrimaryKey___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_UniqueKey_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_UniqueKey, __construct, arginfo_class_Polyspec_Orm_Dbspec_UniqueKey___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Index_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Index, __construct, arginfo_class_Polyspec_Orm_Dbspec_Index___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_IndexColumn_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_IndexColumn, __construct, arginfo_class_Polyspec_Orm_Dbspec_IndexColumn___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ForeignKey_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ForeignKey, __construct, arginfo_class_Polyspec_Orm_Dbspec_ForeignKey___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ForeignKey, changesChildRows, arginfo_class_Polyspec_Orm_Dbspec_ForeignKey_changesChildRows, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Check_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Check, __construct, arginfo_class_Polyspec_Orm_Dbspec_Check___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Settings_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Settings, __construct, arginfo_class_Polyspec_Orm_Dbspec_Settings___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Setting_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Setting, __construct, arginfo_class_Polyspec_Orm_Dbspec_Setting___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Setting, records, arginfo_class_Polyspec_Orm_Dbspec_Setting_records, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Setting, excluded, arginfo_class_Polyspec_Orm_Dbspec_Setting_excluded, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Setting, auditLine, arginfo_class_Polyspec_Orm_Dbspec_Setting_auditLine, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Diagram_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Diagram, __construct, arginfo_class_Polyspec_Orm_Dbspec_Diagram___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Placement_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Placement, __construct, arginfo_class_Polyspec_Orm_Dbspec_Placement___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ReadResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ReadResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_ReadResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_ReadResult, valid, arginfo_class_Polyspec_Orm_Dbspec_ReadResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ReadResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_ReadResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_SetFile_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_SetFile, __construct, arginfo_class_Polyspec_Orm_Dbspec_SetFile___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_SetError_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_SetError, __construct, arginfo_class_Polyspec_Orm_Dbspec_SetError___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_SetResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_SetResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_SetResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_SetResult, valid, arginfo_class_Polyspec_Orm_Dbspec_SetResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_SetResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_SetResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_SetDocument_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_SetDocument, __construct, arginfo_class_Polyspec_Orm_Dbspec_SetDocument___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ParseResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ParseResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_ParseResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_ParseResult, valid, arginfo_class_Polyspec_Orm_Dbspec_ParseResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ParseResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_ParseResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Token_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Token, __construct, arginfo_class_Polyspec_Orm_Dbspec_Token___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Analysis_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Analysis, __construct, arginfo_class_Polyspec_Orm_Dbspec_Analysis___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_FormatResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_FormatResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_FormatResult___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Names_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Names, render, arginfo_class_Polyspec_Orm_Dbspec_Names_render, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Names, ofTable, arginfo_class_Polyspec_Orm_Dbspec_Names_ofTable, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Names, column, arginfo_class_Polyspec_Orm_Dbspec_Names_column, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Manifest_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Manifest, __construct, arginfo_class_Polyspec_Orm_Dbspec_Manifest___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ManifestResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ManifestResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_ManifestResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_ManifestResult, valid, arginfo_class_Polyspec_Orm_Dbspec_ManifestResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ManifestResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_ManifestResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_RenderResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_RenderResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_RenderResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_RenderResult, valid, arginfo_class_Polyspec_Orm_Dbspec_RenderResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_RenderResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_RenderResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Plan_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Plan, __construct, arginfo_class_Polyspec_Orm_Dbspec_Plan___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_PlanStep_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_PlanStep, __construct, arginfo_class_Polyspec_Orm_Dbspec_PlanStep___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Effect_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Effect, __construct, arginfo_class_Polyspec_Orm_Dbspec_Effect___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Effect, repeat, arginfo_class_Polyspec_Orm_Dbspec_Effect_repeat, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Effect, text, arginfo_class_Polyspec_Orm_Dbspec_Effect_text, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_NullCheck_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_NullCheck, __construct, arginfo_class_Polyspec_Orm_Dbspec_NullCheck___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Change_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Change, __construct, arginfo_class_Polyspec_Orm_Dbspec_Change___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Difference_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Difference, __construct, arginfo_class_Polyspec_Orm_Dbspec_Difference___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Unsupported_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Unsupported, __construct, arginfo_class_Polyspec_Orm_Dbspec_Unsupported___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_TableRename_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_TableRename, __construct, arginfo_class_Polyspec_Orm_Dbspec_TableRename___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ColumnRename_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ColumnRename, __construct, arginfo_class_Polyspec_Orm_Dbspec_ColumnRename___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ColumnName_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ColumnName, __construct, arginfo_class_Polyspec_Orm_Dbspec_ColumnName___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ApplyEvent_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ApplyEvent, __construct, arginfo_class_Polyspec_Orm_Dbspec_ApplyEvent___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ApplyError_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ApplyError, __construct, arginfo_class_Polyspec_Orm_Dbspec_ApplyError___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ApplyCleanupError_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ApplyCleanupError, __construct, arginfo_class_Polyspec_Orm_Dbspec_ApplyCleanupError___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_PlanParseResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_PlanParseResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_PlanParseResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanParseResult, valid, arginfo_class_Polyspec_Orm_Dbspec_PlanParseResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanParseResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_PlanParseResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_PlanStepsResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_PlanStepsResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_PlanStepsResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanStepsResult, valid, arginfo_class_Polyspec_Orm_Dbspec_PlanStepsResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanStepsResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_PlanStepsResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ChainResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ChainResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_ChainResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_ChainResult, valid, arginfo_class_Polyspec_Orm_Dbspec_ChainResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ChainResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_ChainResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_DiffResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_DiffResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_DiffResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_DiffResult, valid, arginfo_class_Polyspec_Orm_Dbspec_DiffResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_DiffResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_DiffResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_ComparisonResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_ComparisonResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_ComparisonResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_ComparisonResult, valid, arginfo_class_Polyspec_Orm_Dbspec_ComparisonResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_ComparisonResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_ComparisonResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_MermaidExportResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_MermaidExportResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_MermaidExportResult___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_MermaidImportResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_MermaidImportResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_MermaidImportResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_MermaidImportResult, valid, arginfo_class_Polyspec_Orm_Dbspec_MermaidImportResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_MermaidImportResult, invalid, arginfo_class_Polyspec_Orm_Dbspec_MermaidImportResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_IntrospectResult_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_IntrospectResult, __construct, arginfo_class_Polyspec_Orm_Dbspec_IntrospectResult___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_Dbspec_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, parse, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_parse, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, analyze, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_analyze, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, format, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_format, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, readFile, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_readFile, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, readBytes, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_readBytes, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, readSet, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_readSet, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, parseSet, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_parseSet, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, emit, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_emit, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, render, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_render, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, introspect, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_introspect, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, manifest, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_manifest, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, externalDifferences, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_externalDifferences, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, parsePlan, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_parsePlan, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, emitPlan, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_emitPlan, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, chain, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_chain, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, diff, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_diff, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, compareSchemas, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_compareSchemas, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, installedDifferences, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_installedDifferences, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, addTablesAndColumnsSteps, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_addTablesAndColumnsSteps, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, planSteps, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_planSteps, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, apply, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_apply, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, recover, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_recover, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, rollback, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_rollback, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, finalize, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_finalize, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, exportMermaid, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_exportMermaid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_Dbspec, importMermaid, arginfo_class_Polyspec_Orm_Dbspec_Dbspec_importMermaid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Dbspec_PlanApply_methods[] = {
	ZEND_ME(Polyspec_Orm_Dbspec_PlanApply, __construct, arginfo_class_Polyspec_Orm_Dbspec_PlanApply___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanApply, apply, arginfo_class_Polyspec_Orm_Dbspec_PlanApply_apply, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanApply, recover, arginfo_class_Polyspec_Orm_Dbspec_PlanApply_recover, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanApply, rollback, arginfo_class_Polyspec_Orm_Dbspec_PlanApply_rollback, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanApply, finalize, arginfo_class_Polyspec_Orm_Dbspec_PlanApply_finalize, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Dbspec_PlanApply, effectOn, arginfo_class_Polyspec_Orm_Dbspec_PlanApply_effectOn, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Codec_methods[] = {
	ZEND_ME(Polyspec_Orm_Codec, blindIndex, arginfo_class_Polyspec_Orm_Codec_blindIndex, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Codec, decode, arginfo_class_Polyspec_Orm_Codec_decode, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Codec, encode, arginfo_class_Polyspec_Orm_Codec_encode, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Codec, isHostStyle, arginfo_class_Polyspec_Orm_Codec_isHostStyle, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Codec, hostEncode, arginfo_class_Polyspec_Orm_Codec_hostEncode, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Codec, hostDecode, arginfo_class_Polyspec_Orm_Codec_hostDecode, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Codec, decodeRows, arginfo_class_Polyspec_Orm_Codec_decodeRows, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Validator_methods[] = {
	ZEND_ME(Polyspec_Orm_Validator, __construct, arginfo_class_Polyspec_Orm_Validator___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Validator, opAllowed, arginfo_class_Polyspec_Orm_Validator_opAllowed, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Validator, validate, arginfo_class_Polyspec_Orm_Validator_validate, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Validator, restoreKey, arginfo_class_Polyspec_Orm_Validator_restoreKey, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Validator, paramUses, arginfo_class_Polyspec_Orm_Validator_paramUses, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Validator, functionType, arginfo_class_Polyspec_Orm_Validator_functionType, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Validator, intervalType, arginfo_class_Polyspec_Orm_Validator_intervalType, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Validator, conflictKey, arginfo_class_Polyspec_Orm_Validator_conflictKey, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Planner_methods[] = {
	ZEND_ME(Polyspec_Orm_Planner, __construct, arginfo_class_Polyspec_Orm_Planner___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Planner, compile, arginfo_class_Polyspec_Orm_Planner_compile, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Polyspec_Orm_Db_methods[] = {
	ZEND_ME(Polyspec_Orm_Db, __construct, arginfo_class_Polyspec_Orm_Db___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, registerSet, arginfo_class_Polyspec_Orm_Db_registerSet, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, driver, arginfo_class_Polyspec_Orm_Db_driver, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, markdownSession, arginfo_class_Polyspec_Orm_Db_markdownSession, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, unsupportedOnMarkdown, arginfo_class_Polyspec_Orm_Db_unsupportedOnMarkdown, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, registeredModel, arginfo_class_Polyspec_Orm_Db_registeredModel, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, zone, arginfo_class_Polyspec_Orm_Db_zone, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, config, arginfo_class_Polyspec_Orm_Db_config, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, pdo, arginfo_class_Polyspec_Orm_Db_pdo, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, driverError, arginfo_class_Polyspec_Orm_Db_driverError, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, utils, arginfo_class_Polyspec_Orm_Db_utils, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, stats, arginfo_class_Polyspec_Orm_Db_stats, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, close, arginfo_class_Polyspec_Orm_Db_close, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, withRequestHook, arginfo_class_Polyspec_Orm_Db_withRequestHook, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, subscribe, arginfo_class_Polyspec_Orm_Db_subscribe, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, setListener, arginfo_class_Polyspec_Orm_Db_setListener, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, listener, arginfo_class_Polyspec_Orm_Db_listener, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, notify, arginfo_class_Polyspec_Orm_Db_notify, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, listen, arginfo_class_Polyspec_Orm_Db_listen, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, nextTransaction, arginfo_class_Polyspec_Orm_Db_nextTransaction, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, transactionNumber, arginfo_class_Polyspec_Orm_Db_transactionNumber, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, publish, arginfo_class_Polyspec_Orm_Db_publish, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, observed, arginfo_class_Polyspec_Orm_Db_observed, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, run, arginfo_class_Polyspec_Orm_Db_run, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, fetch, arginfo_class_Polyspec_Orm_Db_fetch, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, bindLimit, arginfo_class_Polyspec_Orm_Db_bindLimit, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, insertParts, arginfo_class_Polyspec_Orm_Db_insertParts, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, activeFor, arginfo_class_Polyspec_Orm_Db_activeFor, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, resolve, arginfo_class_Polyspec_Orm_Db_resolve, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, inTransaction, arginfo_class_Polyspec_Orm_Db_inTransaction, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, transaction, arginfo_class_Polyspec_Orm_Db_transaction, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, select, arginfo_class_Polyspec_Orm_Db_select, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, scalarOf, arginfo_class_Polyspec_Orm_Db_scalarOf, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, paginate, arginfo_class_Polyspec_Orm_Db_paginate, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, writeOf, arginfo_class_Polyspec_Orm_Db_writeOf, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, execute, arginfo_class_Polyspec_Orm_Db_execute, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, statement, arginfo_class_Polyspec_Orm_Db_statement, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, clock, arginfo_class_Polyspec_Orm_Db_clock, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, timeValue, arginfo_class_Polyspec_Orm_Db_timeValue, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, acquireSQLiteRowLock, arginfo_class_Polyspec_Orm_Db_acquireSQLiteRowLock, ZEND_ACC_PUBLIC)
	ZEND_ME(Polyspec_Orm_Db, rowKey, arginfo_class_Polyspec_Orm_Db_rowKey, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, rowSlot, arginfo_class_Polyspec_Orm_Db_rowSlot, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, sameScalar, arginfo_class_Polyspec_Orm_Db_sameScalar, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Polyspec_Orm_Db, scalarText, arginfo_class_Polyspec_Orm_Db_scalarText, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Diagnostic(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Diagnostic", class_Polyspec_Orm_Dbspec_Diagnostic_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_rule_default_value;
	ZVAL_UNDEF(&property_rule_default_value);
	zend_string *property_rule_name = zend_string_init("rule", sizeof("rule") - 1, 1);
	zend_declare_typed_property(class_entry, property_rule_name, &property_rule_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_rule_name);

	zval property_line_default_value;
	ZVAL_UNDEF(&property_line_default_value);
	zend_string *property_line_name = zend_string_init("line", sizeof("line") - 1, 1);
	zend_declare_typed_property(class_entry, property_line_name, &property_line_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_line_name);

	zval property_column_default_value;
	ZVAL_UNDEF(&property_column_default_value);
	zend_string *property_column_name = zend_string_init("column", sizeof("column") - 1, 1);
	zend_declare_typed_property(class_entry, property_column_name, &property_column_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_column_name);

	zval property_message_default_value;
	ZVAL_UNDEF(&property_message_default_value);
	zend_string *property_message_name = zend_string_init("message", sizeof("message") - 1, 1);
	zend_declare_typed_property(class_entry, property_message_name, &property_message_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_message_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Position(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Position", class_Polyspec_Orm_Dbspec_Position_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_path_default_value;
	ZVAL_UNDEF(&property_path_default_value);
	zend_string *property_path_name = zend_string_init("path", sizeof("path") - 1, 1);
	zend_declare_typed_property(class_entry, property_path_name, &property_path_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_path_name);

	zval property_line_default_value;
	ZVAL_UNDEF(&property_line_default_value);
	zend_string *property_line_name = zend_string_init("line", sizeof("line") - 1, 1);
	zend_declare_typed_property(class_entry, property_line_name, &property_line_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_line_name);

	zval property_column_default_value;
	ZVAL_UNDEF(&property_column_default_value);
	zend_string *property_column_name = zend_string_init("column", sizeof("column") - 1, 1);
	zend_declare_typed_property(class_entry, property_column_name, &property_column_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_column_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Document(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Document", class_Polyspec_Orm_Dbspec_Document_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_uses_default_value;
	ZVAL_EMPTY_ARRAY(&property_uses_default_value);
	zend_string *property_uses_name = zend_string_init("uses", sizeof("uses") - 1, 1);
	zend_declare_typed_property(class_entry, property_uses_name, &property_uses_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_uses_name);

	zval property_tables_default_value;
	ZVAL_EMPTY_ARRAY(&property_tables_default_value);
	zend_string *property_tables_name = zend_string_init("tables", sizeof("tables") - 1, 1);
	zend_declare_typed_property(class_entry, property_tables_name, &property_tables_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_tables_name);

	zval property_diagrams_default_value;
	ZVAL_EMPTY_ARRAY(&property_diagrams_default_value);
	zend_string *property_diagrams_name = zend_string_init("diagrams", sizeof("diagrams") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagrams_name, &property_diagrams_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagrams_name);

	zval property_trailingComments_default_value;
	ZVAL_EMPTY_ARRAY(&property_trailingComments_default_value);
	zend_string *property_trailingComments_name = zend_string_init("trailingComments", sizeof("trailingComments") - 1, 1);
	zend_declare_typed_property(class_entry, property_trailingComments_name, &property_trailingComments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_trailingComments_name);

	zval property_external_default_value;
	ZVAL_FALSE(&property_external_default_value);
	zend_string *property_external_name = zend_string_init("external", sizeof("external") - 1, 1);
	zend_declare_typed_property(class_entry, property_external_name, &property_external_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_external_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_UseLine(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "UseLine", class_Polyspec_Orm_Dbspec_UseLine_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_document_name);

	zval property_tables_default_value;
	ZVAL_UNDEF(&property_tables_default_value);
	zend_string *property_tables_name = zend_string_init("tables", sizeof("tables") - 1, 1);
	zend_declare_typed_property(class_entry, property_tables_name, &property_tables_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_tables_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Table(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Table", class_Polyspec_Orm_Dbspec_Table_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_columns_default_value;
	ZVAL_EMPTY_ARRAY(&property_columns_default_value);
	zend_string *property_columns_name = zend_string_init("columns", sizeof("columns") - 1, 1);
	zend_declare_typed_property(class_entry, property_columns_name, &property_columns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_columns_name);

	zval property_primaryKey_default_value;
	ZVAL_NULL(&property_primaryKey_default_value);
	zend_string *property_primaryKey_name = zend_string_init("primaryKey", sizeof("primaryKey") - 1, 1);
	zend_string *property_primaryKey_class_Polyspec_Orm_Dbspec_PrimaryKey = zend_string_init("Polyspec\\Orm\\Dbspec\\PrimaryKey", sizeof("Polyspec\\Orm\\Dbspec\\PrimaryKey")-1, 1);
	zend_declare_typed_property(class_entry, property_primaryKey_name, &property_primaryKey_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_primaryKey_class_Polyspec_Orm_Dbspec_PrimaryKey, 0, MAY_BE_NULL));
	zend_string_release(property_primaryKey_name);

	zval property_uniqueKeys_default_value;
	ZVAL_EMPTY_ARRAY(&property_uniqueKeys_default_value);
	zend_string *property_uniqueKeys_name = zend_string_init("uniqueKeys", sizeof("uniqueKeys") - 1, 1);
	zend_declare_typed_property(class_entry, property_uniqueKeys_name, &property_uniqueKeys_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_uniqueKeys_name);

	zval property_indexes_default_value;
	ZVAL_EMPTY_ARRAY(&property_indexes_default_value);
	zend_string *property_indexes_name = zend_string_init("indexes", sizeof("indexes") - 1, 1);
	zend_declare_typed_property(class_entry, property_indexes_name, &property_indexes_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_indexes_name);

	zval property_foreignKeys_default_value;
	ZVAL_EMPTY_ARRAY(&property_foreignKeys_default_value);
	zend_string *property_foreignKeys_name = zend_string_init("foreignKeys", sizeof("foreignKeys") - 1, 1);
	zend_declare_typed_property(class_entry, property_foreignKeys_name, &property_foreignKeys_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_foreignKeys_name);

	zval property_checks_default_value;
	ZVAL_EMPTY_ARRAY(&property_checks_default_value);
	zend_string *property_checks_name = zend_string_init("checks", sizeof("checks") - 1, 1);
	zend_declare_typed_property(class_entry, property_checks_name, &property_checks_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_checks_name);

	zval property_settings_default_value;
	ZVAL_NULL(&property_settings_default_value);
	zend_string *property_settings_name = zend_string_init("settings", sizeof("settings") - 1, 1);
	zend_string *property_settings_class_Polyspec_Orm_Dbspec_Settings = zend_string_init("Polyspec\\Orm\\Dbspec\\Settings", sizeof("Polyspec\\Orm\\Dbspec\\Settings")-1, 1);
	zend_declare_typed_property(class_entry, property_settings_name, &property_settings_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_settings_class_Polyspec_Orm_Dbspec_Settings, 0, MAY_BE_NULL));
	zend_string_release(property_settings_name);

	zval property_closingComments_default_value;
	ZVAL_EMPTY_ARRAY(&property_closingComments_default_value);
	zend_string *property_closingComments_name = zend_string_init("closingComments", sizeof("closingComments") - 1, 1);
	zend_declare_typed_property(class_entry, property_closingComments_name, &property_closingComments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_closingComments_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Column(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Column", class_Polyspec_Orm_Dbspec_Column_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_type_default_value;
	ZVAL_UNDEF(&property_type_default_value);
	zend_string *property_type_name = zend_string_init("type", sizeof("type") - 1, 1);
	zend_string *property_type_class_Polyspec_Orm_Dbspec_ColumnType = zend_string_init("Polyspec\\Orm\\Dbspec\\ColumnType", sizeof("Polyspec\\Orm\\Dbspec\\ColumnType")-1, 1);
	zend_declare_typed_property(class_entry, property_type_name, &property_type_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_type_class_Polyspec_Orm_Dbspec_ColumnType, 0, 0));
	zend_string_release(property_type_name);

	zval property_nullable_default_value;
	ZVAL_UNDEF(&property_nullable_default_value);
	zend_string *property_nullable_name = zend_string_init("nullable", sizeof("nullable") - 1, 1);
	zend_declare_typed_property(class_entry, property_nullable_name, &property_nullable_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_nullable_name);

	zval property_identity_default_value;
	ZVAL_UNDEF(&property_identity_default_value);
	zend_string *property_identity_name = zend_string_init("identity", sizeof("identity") - 1, 1);
	zend_declare_typed_property(class_entry, property_identity_name, &property_identity_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_identity_name);

	zval property_default_default_value;
	ZVAL_UNDEF(&property_default_default_value);
	zend_string *property_default_name = zend_string_init("default", sizeof("default") - 1, 1);
	zend_declare_typed_property(class_entry, property_default_name, &property_default_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));
	zend_string_release(property_default_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ColumnType(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ColumnType", class_Polyspec_Orm_Dbspec_ColumnType_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_parameters_default_value;
	ZVAL_UNDEF(&property_parameters_default_value);
	zend_string *property_parameters_name = zend_string_init("parameters", sizeof("parameters") - 1, 1);
	zend_declare_typed_property(class_entry, property_parameters_name, &property_parameters_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_parameters_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_PrimaryKey(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "PrimaryKey", class_Polyspec_Orm_Dbspec_PrimaryKey_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_columns_default_value;
	ZVAL_UNDEF(&property_columns_default_value);
	zend_string *property_columns_name = zend_string_init("columns", sizeof("columns") - 1, 1);
	zend_declare_typed_property(class_entry, property_columns_name, &property_columns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_columns_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_UniqueKey(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "UniqueKey", class_Polyspec_Orm_Dbspec_UniqueKey_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_columns_default_value;
	ZVAL_UNDEF(&property_columns_default_value);
	zend_string *property_columns_name = zend_string_init("columns", sizeof("columns") - 1, 1);
	zend_declare_typed_property(class_entry, property_columns_name, &property_columns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_columns_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Index(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Index", class_Polyspec_Orm_Dbspec_Index_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_columns_default_value;
	ZVAL_UNDEF(&property_columns_default_value);
	zend_string *property_columns_name = zend_string_init("columns", sizeof("columns") - 1, 1);
	zend_declare_typed_property(class_entry, property_columns_name, &property_columns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_columns_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_IndexColumn(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "IndexColumn", class_Polyspec_Orm_Dbspec_IndexColumn_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_descending_default_value;
	ZVAL_UNDEF(&property_descending_default_value);
	zend_string *property_descending_name = zend_string_init("descending", sizeof("descending") - 1, 1);
	zend_declare_typed_property(class_entry, property_descending_name, &property_descending_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_descending_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ForeignKey(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ForeignKey", class_Polyspec_Orm_Dbspec_ForeignKey_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_columns_default_value;
	ZVAL_UNDEF(&property_columns_default_value);
	zend_string *property_columns_name = zend_string_init("columns", sizeof("columns") - 1, 1);
	zend_declare_typed_property(class_entry, property_columns_name, &property_columns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_columns_name);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_referencedColumns_default_value;
	ZVAL_UNDEF(&property_referencedColumns_default_value);
	zend_string *property_referencedColumns_name = zend_string_init("referencedColumns", sizeof("referencedColumns") - 1, 1);
	zend_declare_typed_property(class_entry, property_referencedColumns_name, &property_referencedColumns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_referencedColumns_name);

	zval property_onDelete_default_value;
	ZVAL_UNDEF(&property_onDelete_default_value);
	zend_string *property_onDelete_name = zend_string_init("onDelete", sizeof("onDelete") - 1, 1);
	zend_declare_typed_property(class_entry, property_onDelete_name, &property_onDelete_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_onDelete_name);

	zval property_onUpdate_default_value;
	ZVAL_UNDEF(&property_onUpdate_default_value);
	zend_string *property_onUpdate_name = zend_string_init("onUpdate", sizeof("onUpdate") - 1, 1);
	zend_declare_typed_property(class_entry, property_onUpdate_name, &property_onUpdate_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_onUpdate_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Check(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Check", class_Polyspec_Orm_Dbspec_Check_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_expression_default_value;
	ZVAL_UNDEF(&property_expression_default_value);
	zend_string *property_expression_name = zend_string_init("expression", sizeof("expression") - 1, 1);
	zend_declare_typed_property(class_entry, property_expression_name, &property_expression_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_expression_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Settings(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Settings", class_Polyspec_Orm_Dbspec_Settings_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_settings_default_value;
	ZVAL_EMPTY_ARRAY(&property_settings_default_value);
	zend_string *property_settings_name = zend_string_init("settings", sizeof("settings") - 1, 1);
	zend_declare_typed_property(class_entry, property_settings_name, &property_settings_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_settings_name);

	zval property_closingComments_default_value;
	ZVAL_EMPTY_ARRAY(&property_closingComments_default_value);
	zend_string *property_closingComments_name = zend_string_init("closingComments", sizeof("closingComments") - 1, 1);
	zend_declare_typed_property(class_entry, property_closingComments_name, &property_closingComments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_closingComments_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Setting(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Setting", class_Polyspec_Orm_Dbspec_Setting_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_arguments_default_value;
	ZVAL_UNDEF(&property_arguments_default_value);
	zend_string *property_arguments_name = zend_string_init("arguments", sizeof("arguments") - 1, 1);
	zend_declare_typed_property(class_entry, property_arguments_name, &property_arguments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_arguments_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	zval property_exclude_default_value;
	ZVAL_UNDEF(&property_exclude_default_value);
	zend_string *property_exclude_name = zend_string_init("exclude", sizeof("exclude") - 1, 1);
	zend_declare_typed_property(class_entry, property_exclude_name, &property_exclude_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_exclude_name);

	zval property_include_default_value;
	ZVAL_UNDEF(&property_include_default_value);
	zend_string *property_include_name = zend_string_init("include", sizeof("include") - 1, 1);
	zend_declare_typed_property(class_entry, property_include_name, &property_include_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_include_name);

	zval property_form_default_value;
	ZVAL_UNDEF(&property_form_default_value);
	zend_string *property_form_name = zend_string_init("form", sizeof("form") - 1, 1);
	zend_declare_typed_property(class_entry, property_form_name, &property_form_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));
	zend_string_release(property_form_name);

	zval property_requires_default_value;
	ZVAL_UNDEF(&property_requires_default_value);
	zend_string *property_requires_name = zend_string_init("requires", sizeof("requires") - 1, 1);
	zend_declare_typed_property(class_entry, property_requires_name, &property_requires_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_requires_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Diagram(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Diagram", class_Polyspec_Orm_Dbspec_Diagram_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_placements_default_value;
	ZVAL_EMPTY_ARRAY(&property_placements_default_value);
	zend_string *property_placements_name = zend_string_init("placements", sizeof("placements") - 1, 1);
	zend_declare_typed_property(class_entry, property_placements_name, &property_placements_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_placements_name);

	zval property_closingComments_default_value;
	ZVAL_EMPTY_ARRAY(&property_closingComments_default_value);
	zend_string *property_closingComments_name = zend_string_init("closingComments", sizeof("closingComments") - 1, 1);
	zend_declare_typed_property(class_entry, property_closingComments_name, &property_closingComments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_closingComments_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Placement(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Placement", class_Polyspec_Orm_Dbspec_Placement_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_x_default_value;
	ZVAL_UNDEF(&property_x_default_value);
	zend_string *property_x_name = zend_string_init("x", sizeof("x") - 1, 1);
	zend_declare_typed_property(class_entry, property_x_name, &property_x_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_x_name);

	zval property_y_default_value;
	ZVAL_UNDEF(&property_y_default_value);
	zend_string *property_y_name = zend_string_init("y", sizeof("y") - 1, 1);
	zend_declare_typed_property(class_entry, property_y_name, &property_y_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_y_name);

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ReadResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ReadResult", class_Polyspec_Orm_Dbspec_ReadResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_text_default_value;
	ZVAL_UNDEF(&property_text_default_value);
	zend_string *property_text_name = zend_string_init("text", sizeof("text") - 1, 1);
	zend_declare_typed_property(class_entry, property_text_name, &property_text_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));
	zend_string_release(property_text_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_SetFile(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "SetFile", class_Polyspec_Orm_Dbspec_SetFile_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_path_default_value;
	ZVAL_UNDEF(&property_path_default_value);
	zend_string *property_path_name = zend_string_init("path", sizeof("path") - 1, 1);
	zend_declare_typed_property(class_entry, property_path_name, &property_path_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_path_name);

	zval property_bytes_default_value;
	ZVAL_UNDEF(&property_bytes_default_value);
	zend_string *property_bytes_name = zend_string_init("bytes", sizeof("bytes") - 1, 1);
	zend_declare_typed_property(class_entry, property_bytes_name, &property_bytes_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_bytes_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_SetError(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "SetError", class_Polyspec_Orm_Dbspec_SetError_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_rule_default_value;
	ZVAL_UNDEF(&property_rule_default_value);
	zend_string *property_rule_name = zend_string_init("rule", sizeof("rule") - 1, 1);
	zend_declare_typed_property(class_entry, property_rule_name, &property_rule_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_rule_name);

	zval property_path_default_value;
	ZVAL_UNDEF(&property_path_default_value);
	zend_string *property_path_name = zend_string_init("path", sizeof("path") - 1, 1);
	zend_declare_typed_property(class_entry, property_path_name, &property_path_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_path_name);

	zval property_message_default_value;
	ZVAL_UNDEF(&property_message_default_value);
	zend_string *property_message_name = zend_string_init("message", sizeof("message") - 1, 1);
	zend_declare_typed_property(class_entry, property_message_name, &property_message_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_message_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_SetResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "SetResult", class_Polyspec_Orm_Dbspec_SetResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_documents_default_value;
	ZVAL_UNDEF(&property_documents_default_value);
	zend_string *property_documents_name = zend_string_init("documents", sizeof("documents") - 1, 1);
	zend_declare_typed_property(class_entry, property_documents_name, &property_documents_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_documents_name);

	zval property_external_default_value;
	ZVAL_UNDEF(&property_external_default_value);
	zend_string *property_external_name = zend_string_init("external", sizeof("external") - 1, 1);
	zend_declare_typed_property(class_entry, property_external_name, &property_external_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_external_name);

	zval property_errors_default_value;
	ZVAL_UNDEF(&property_errors_default_value);
	zend_string *property_errors_name = zend_string_init("errors", sizeof("errors") - 1, 1);
	zend_declare_typed_property(class_entry, property_errors_name, &property_errors_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_errors_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_SetDocument(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "SetDocument", class_Polyspec_Orm_Dbspec_SetDocument_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_external_default_value;
	ZVAL_UNDEF(&property_external_default_value);
	zend_string *property_external_name = zend_string_init("external", sizeof("external") - 1, 1);
	zend_declare_typed_property(class_entry, property_external_name, &property_external_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_external_name);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Polyspec_Orm_Dbspec_Document = zend_string_init("Polyspec\\Orm\\Dbspec\\Document", sizeof("Polyspec\\Orm\\Dbspec\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Polyspec_Orm_Dbspec_Document, 0, MAY_BE_NULL));
	zend_string_release(property_document_name);

	zval property_positions_default_value;
	ZVAL_UNDEF(&property_positions_default_value);
	zend_string *property_positions_name = zend_string_init("positions", sizeof("positions") - 1, 1);
	zend_declare_typed_property(class_entry, property_positions_name, &property_positions_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_positions_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ParseResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ParseResult", class_Polyspec_Orm_Dbspec_ParseResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Polyspec_Orm_Dbspec_Document = zend_string_init("Polyspec\\Orm\\Dbspec\\Document", sizeof("Polyspec\\Orm\\Dbspec\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Polyspec_Orm_Dbspec_Document, 0, MAY_BE_NULL));
	zend_string_release(property_document_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	zval property_positions_default_value;
	ZVAL_UNDEF(&property_positions_default_value);
	zend_string *property_positions_name = zend_string_init("positions", sizeof("positions") - 1, 1);
	zend_declare_typed_property(class_entry, property_positions_name, &property_positions_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_positions_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Token(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Token", class_Polyspec_Orm_Dbspec_Token_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_line_default_value;
	ZVAL_UNDEF(&property_line_default_value);
	zend_string *property_line_name = zend_string_init("line", sizeof("line") - 1, 1);
	zend_declare_typed_property(class_entry, property_line_name, &property_line_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_line_name);

	zval property_start_default_value;
	ZVAL_UNDEF(&property_start_default_value);
	zend_string *property_start_name = zend_string_init("start", sizeof("start") - 1, 1);
	zend_declare_typed_property(class_entry, property_start_name, &property_start_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_start_name);

	zval property_end_default_value;
	ZVAL_UNDEF(&property_end_default_value);
	zend_string *property_end_name = zend_string_init("end", sizeof("end") - 1, 1);
	zend_declare_typed_property(class_entry, property_end_name, &property_end_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_end_name);

	zval property_class_default_value;
	ZVAL_UNDEF(&property_class_default_value);
	zend_string *property_class_name = zend_string_init("class", sizeof("class") - 1, 1);
	zend_declare_typed_property(class_entry, property_class_name, &property_class_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_class_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Analysis(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Analysis", class_Polyspec_Orm_Dbspec_Analysis_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Polyspec_Orm_Dbspec_Document = zend_string_init("Polyspec\\Orm\\Dbspec\\Document", sizeof("Polyspec\\Orm\\Dbspec\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Polyspec_Orm_Dbspec_Document, 0, MAY_BE_NULL));
	zend_string_release(property_document_name);

	zval property_positions_default_value;
	ZVAL_UNDEF(&property_positions_default_value);
	zend_string *property_positions_name = zend_string_init("positions", sizeof("positions") - 1, 1);
	zend_declare_typed_property(class_entry, property_positions_name, &property_positions_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_positions_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	zval property_tokens_default_value;
	ZVAL_UNDEF(&property_tokens_default_value);
	zend_string *property_tokens_name = zend_string_init("tokens", sizeof("tokens") - 1, 1);
	zend_declare_typed_property(class_entry, property_tokens_name, &property_tokens_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_tokens_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_FormatResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "FormatResult", class_Polyspec_Orm_Dbspec_FormatResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_text_default_value;
	ZVAL_UNDEF(&property_text_default_value);
	zend_string *property_text_name = zend_string_init("text", sizeof("text") - 1, 1);
	zend_declare_typed_property(class_entry, property_text_name, &property_text_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));
	zend_string_release(property_text_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Names(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Names", class_Polyspec_Orm_Dbspec_Names_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Manifest(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Manifest", class_Polyspec_Orm_Dbspec_Manifest_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_manifestText_default_value;
	ZVAL_UNDEF(&property_manifestText_default_value);
	zend_string *property_manifestText_name = zend_string_init("manifestText", sizeof("manifestText") - 1, 1);
	zend_declare_typed_property(class_entry, property_manifestText_name, &property_manifestText_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_manifestText_name);

	zval property_schemaText_default_value;
	ZVAL_UNDEF(&property_schemaText_default_value);
	zend_string *property_schemaText_name = zend_string_init("schemaText", sizeof("schemaText") - 1, 1);
	zend_declare_typed_property(class_entry, property_schemaText_name, &property_schemaText_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_schemaText_name);

	zval property_manifestHash_default_value;
	ZVAL_UNDEF(&property_manifestHash_default_value);
	zend_string *property_manifestHash_name = zend_string_init("manifestHash", sizeof("manifestHash") - 1, 1);
	zend_declare_typed_property(class_entry, property_manifestHash_name, &property_manifestHash_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_manifestHash_name);

	zval property_schemaHash_default_value;
	ZVAL_UNDEF(&property_schemaHash_default_value);
	zend_string *property_schemaHash_name = zend_string_init("schemaHash", sizeof("schemaHash") - 1, 1);
	zend_declare_typed_property(class_entry, property_schemaHash_name, &property_schemaHash_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_schemaHash_name);

	zval property_externalText_default_value;
	ZVAL_UNDEF(&property_externalText_default_value);
	zend_string *property_externalText_name = zend_string_init("externalText", sizeof("externalText") - 1, 1);
	zend_declare_typed_property(class_entry, property_externalText_name, &property_externalText_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_externalText_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ManifestResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ManifestResult", class_Polyspec_Orm_Dbspec_ManifestResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_manifest_default_value;
	ZVAL_UNDEF(&property_manifest_default_value);
	zend_string *property_manifest_name = zend_string_init("manifest", sizeof("manifest") - 1, 1);
	zend_string *property_manifest_class_Polyspec_Orm_Dbspec_Manifest = zend_string_init("Polyspec\\Orm\\Dbspec\\Manifest", sizeof("Polyspec\\Orm\\Dbspec\\Manifest")-1, 1);
	zend_declare_typed_property(class_entry, property_manifest_name, &property_manifest_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_manifest_class_Polyspec_Orm_Dbspec_Manifest, 0, MAY_BE_NULL));
	zend_string_release(property_manifest_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_RenderResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "RenderResult", class_Polyspec_Orm_Dbspec_RenderResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_statements_default_value;
	ZVAL_UNDEF(&property_statements_default_value);
	zend_string *property_statements_name = zend_string_init("statements", sizeof("statements") - 1, 1);
	zend_declare_typed_property(class_entry, property_statements_name, &property_statements_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_statements_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Plan(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Plan", class_Polyspec_Orm_Dbspec_Plan_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_from_default_value;
	ZVAL_UNDEF(&property_from_default_value);
	zend_string *property_from_name = zend_string_init("from", sizeof("from") - 1, 1);
	zend_declare_typed_property(class_entry, property_from_name, &property_from_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));
	zend_string_release(property_from_name);

	zval property_renameTables_default_value;
	ZVAL_UNDEF(&property_renameTables_default_value);
	zend_string *property_renameTables_name = zend_string_init("renameTables", sizeof("renameTables") - 1, 1);
	zend_declare_typed_property(class_entry, property_renameTables_name, &property_renameTables_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_renameTables_name);

	zval property_renameColumns_default_value;
	ZVAL_UNDEF(&property_renameColumns_default_value);
	zend_string *property_renameColumns_name = zend_string_init("renameColumns", sizeof("renameColumns") - 1, 1);
	zend_declare_typed_property(class_entry, property_renameColumns_name, &property_renameColumns_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_renameColumns_name);

	zval property_dropTables_default_value;
	ZVAL_UNDEF(&property_dropTables_default_value);
	zend_string *property_dropTables_name = zend_string_init("dropTables", sizeof("dropTables") - 1, 1);
	zend_declare_typed_property(class_entry, property_dropTables_name, &property_dropTables_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_dropTables_name);

	zval property_dropColumns_default_value;
	ZVAL_UNDEF(&property_dropColumns_default_value);
	zend_string *property_dropColumns_name = zend_string_init("dropColumns", sizeof("dropColumns") - 1, 1);
	zend_declare_typed_property(class_entry, property_dropColumns_name, &property_dropColumns_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_dropColumns_name);

	zval property_schema_default_value;
	ZVAL_UNDEF(&property_schema_default_value);
	zend_string *property_schema_name = zend_string_init("schema", sizeof("schema") - 1, 1);
	zend_string *property_schema_class_Polyspec_Orm_Dbspec_Document = zend_string_init("Polyspec\\Orm\\Dbspec\\Document", sizeof("Polyspec\\Orm\\Dbspec\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_schema_name, &property_schema_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_schema_class_Polyspec_Orm_Dbspec_Document, 0, 0));
	zend_string_release(property_schema_name);

	zval property_to_default_value;
	ZVAL_UNDEF(&property_to_default_value);
	zend_string *property_to_name = zend_string_init("to", sizeof("to") - 1, 1);
	zend_declare_typed_property(class_entry, property_to_name, &property_to_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_to_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_PlanStep(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "PlanStep", class_Polyspec_Orm_Dbspec_PlanStep_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_statement_default_value;
	ZVAL_UNDEF(&property_statement_default_value);
	zend_string *property_statement_name = zend_string_init("statement", sizeof("statement") - 1, 1);
	zend_declare_typed_property(class_entry, property_statement_name, &property_statement_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_statement_name);

	zval property_rollback_default_value;
	ZVAL_UNDEF(&property_rollback_default_value);
	zend_string *property_rollback_name = zend_string_init("rollback", sizeof("rollback") - 1, 1);
	zend_declare_typed_property(class_entry, property_rollback_name, &property_rollback_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_rollback_name);

	zval property_irreversible_default_value;
	ZVAL_UNDEF(&property_irreversible_default_value);
	zend_string *property_irreversible_name = zend_string_init("irreversible", sizeof("irreversible") - 1, 1);
	zend_declare_typed_property(class_entry, property_irreversible_name, &property_irreversible_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_irreversible_name);

	zval property_effect_default_value;
	ZVAL_UNDEF(&property_effect_default_value);
	zend_string *property_effect_name = zend_string_init("effect", sizeof("effect") - 1, 1);
	zend_string *property_effect_class_Polyspec_Orm_Dbspec_Effect = zend_string_init("Polyspec\\Orm\\Dbspec\\Effect", sizeof("Polyspec\\Orm\\Dbspec\\Effect")-1, 1);
	zend_declare_typed_property(class_entry, property_effect_name, &property_effect_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_effect_class_Polyspec_Orm_Dbspec_Effect, 0, 0));
	zend_string_release(property_effect_name);

	zval property_restore_default_value;
	ZVAL_UNDEF(&property_restore_default_value);
	zend_string *property_restore_name = zend_string_init("restore", sizeof("restore") - 1, 1);
	zend_declare_typed_property(class_entry, property_restore_name, &property_restore_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_restore_name);

	zval property_rollbackRestore_default_value;
	ZVAL_UNDEF(&property_rollbackRestore_default_value);
	zend_string *property_rollbackRestore_name = zend_string_init("rollbackRestore", sizeof("rollbackRestore") - 1, 1);
	zend_declare_typed_property(class_entry, property_rollbackRestore_name, &property_rollbackRestore_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_rollbackRestore_name);

	zval property_restoreIf_default_value;
	ZVAL_UNDEF(&property_restoreIf_default_value);
	zend_string *property_restoreIf_name = zend_string_init("restoreIf", sizeof("restoreIf") - 1, 1);
	zend_string *property_restoreIf_class_Polyspec_Orm_Dbspec_Effect = zend_string_init("Polyspec\\Orm\\Dbspec\\Effect", sizeof("Polyspec\\Orm\\Dbspec\\Effect")-1, 1);
	zend_declare_typed_property(class_entry, property_restoreIf_name, &property_restoreIf_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_restoreIf_class_Polyspec_Orm_Dbspec_Effect, 0, MAY_BE_NULL));
	zend_string_release(property_restoreIf_name);

	zval property_nullChecks_default_value;
	ZVAL_UNDEF(&property_nullChecks_default_value);
	zend_string *property_nullChecks_name = zend_string_init("nullChecks", sizeof("nullChecks") - 1, 1);
	zend_declare_typed_property(class_entry, property_nullChecks_name, &property_nullChecks_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_nullChecks_name);

	zval property_finalize_default_value;
	ZVAL_UNDEF(&property_finalize_default_value);
	zend_string *property_finalize_name = zend_string_init("finalize", sizeof("finalize") - 1, 1);
	zend_declare_typed_property(class_entry, property_finalize_name, &property_finalize_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_finalize_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Effect(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Effect", class_Polyspec_Orm_Dbspec_Effect_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_present_default_value;
	ZVAL_UNDEF(&property_present_default_value);
	zend_string *property_present_name = zend_string_init("present", sizeof("present") - 1, 1);
	zend_declare_typed_property(class_entry, property_present_name, &property_present_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_present_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_NullCheck(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "NullCheck", class_Polyspec_Orm_Dbspec_NullCheck_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_column_default_value;
	ZVAL_UNDEF(&property_column_default_value);
	zend_string *property_column_name = zend_string_init("column", sizeof("column") - 1, 1);
	zend_declare_typed_property(class_entry, property_column_name, &property_column_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_column_name);

	zval property_default_default_value;
	ZVAL_UNDEF(&property_default_default_value);
	zend_string *property_default_name = zend_string_init("default", sizeof("default") - 1, 1);
	zend_declare_typed_property(class_entry, property_default_name, &property_default_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));
	zend_string_release(property_default_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Change(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Change", class_Polyspec_Orm_Dbspec_Change_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Difference(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Difference", class_Polyspec_Orm_Dbspec_Difference_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Unsupported(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Unsupported", class_Polyspec_Orm_Dbspec_Unsupported_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	zval property_reason_default_value;
	ZVAL_UNDEF(&property_reason_default_value);
	zend_string *property_reason_name = zend_string_init("reason", sizeof("reason") - 1, 1);
	zend_declare_typed_property(class_entry, property_reason_name, &property_reason_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_reason_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_TableRename(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "TableRename", class_Polyspec_Orm_Dbspec_TableRename_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_old_default_value;
	ZVAL_UNDEF(&property_old_default_value);
	zend_string *property_old_name = zend_string_init("old", sizeof("old") - 1, 1);
	zend_declare_typed_property(class_entry, property_old_name, &property_old_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_old_name);

	zval property_new_default_value;
	ZVAL_UNDEF(&property_new_default_value);
	zend_string *property_new_name = zend_string_init("new", sizeof("new") - 1, 1);
	zend_declare_typed_property(class_entry, property_new_name, &property_new_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_new_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ColumnRename(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ColumnRename", class_Polyspec_Orm_Dbspec_ColumnRename_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_old_default_value;
	ZVAL_UNDEF(&property_old_default_value);
	zend_string *property_old_name = zend_string_init("old", sizeof("old") - 1, 1);
	zend_declare_typed_property(class_entry, property_old_name, &property_old_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_old_name);

	zval property_new_default_value;
	ZVAL_UNDEF(&property_new_default_value);
	zend_string *property_new_name = zend_string_init("new", sizeof("new") - 1, 1);
	zend_declare_typed_property(class_entry, property_new_name, &property_new_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_new_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ColumnName(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ColumnName", class_Polyspec_Orm_Dbspec_ColumnName_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_string *property_name_name = zend_string_init("name", sizeof("name") - 1, 1);
	zend_declare_typed_property(class_entry, property_name_name, &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_name_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ApplyEvent(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ApplyEvent", class_Polyspec_Orm_Dbspec_ApplyEvent_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_kind_default_value;
	ZVAL_UNDEF(&property_kind_default_value);
	zend_string *property_kind_name = zend_string_init("kind", sizeof("kind") - 1, 1);
	zend_declare_typed_property(class_entry, property_kind_name, &property_kind_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_kind_name);

	zval property_plan_default_value;
	ZVAL_UNDEF(&property_plan_default_value);
	zend_string *property_plan_name = zend_string_init("plan", sizeof("plan") - 1, 1);
	zend_declare_typed_property(class_entry, property_plan_name, &property_plan_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_plan_name);

	zval property_step_default_value;
	ZVAL_UNDEF(&property_step_default_value);
	zend_string *property_step_name = zend_string_init("step", sizeof("step") - 1, 1);
	zend_declare_typed_property(class_entry, property_step_name, &property_step_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_step_name);

	zval property_steps_default_value;
	ZVAL_UNDEF(&property_steps_default_value);
	zend_string *property_steps_name = zend_string_init("steps", sizeof("steps") - 1, 1);
	zend_declare_typed_property(class_entry, property_steps_name, &property_steps_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_steps_name);

	zval property_statement_default_value;
	ZVAL_UNDEF(&property_statement_default_value);
	zend_string *property_statement_name = zend_string_init("statement", sizeof("statement") - 1, 1);
	zend_declare_typed_property(class_entry, property_statement_name, &property_statement_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_statement_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ApplyError(zend_class_entry *class_entry_RuntimeException)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ApplyError", class_Polyspec_Orm_Dbspec_ApplyError_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, class_entry_RuntimeException, ZEND_ACC_FINAL);

	zval property_code__default_value;
	ZVAL_UNDEF(&property_code__default_value);
	zend_string *property_code__name = zend_string_init("code_", sizeof("code_") - 1, 1);
	zend_declare_typed_property(class_entry, property_code__name, &property_code__default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_code__name);

	zval property_plan_default_value;
	ZVAL_UNDEF(&property_plan_default_value);
	zend_string *property_plan_name = zend_string_init("plan", sizeof("plan") - 1, 1);
	zend_declare_typed_property(class_entry, property_plan_name, &property_plan_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_plan_name);

	zval property_step_default_value;
	ZVAL_UNDEF(&property_step_default_value);
	zend_string *property_step_name = zend_string_init("step", sizeof("step") - 1, 1);
	zend_declare_typed_property(class_entry, property_step_name, &property_step_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_step_name);

	zval property_detail_default_value;
	ZVAL_UNDEF(&property_detail_default_value);
	zend_string *property_detail_name = zend_string_init("detail", sizeof("detail") - 1, 1);
	zend_declare_typed_property(class_entry, property_detail_name, &property_detail_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_detail_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ApplyCleanupError(zend_class_entry *class_entry_RuntimeException)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ApplyCleanupError", class_Polyspec_Orm_Dbspec_ApplyCleanupError_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, class_entry_RuntimeException, ZEND_ACC_FINAL);

	zval property_cleanup_default_value;
	ZVAL_UNDEF(&property_cleanup_default_value);
	zend_string *property_cleanup_name = zend_string_init("cleanup", sizeof("cleanup") - 1, 1);
	zend_declare_typed_property(class_entry, property_cleanup_name, &property_cleanup_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_cleanup_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_PlanParseResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "PlanParseResult", class_Polyspec_Orm_Dbspec_PlanParseResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_plan_default_value;
	ZVAL_UNDEF(&property_plan_default_value);
	zend_string *property_plan_name = zend_string_init("plan", sizeof("plan") - 1, 1);
	zend_string *property_plan_class_Polyspec_Orm_Dbspec_Plan = zend_string_init("Polyspec\\Orm\\Dbspec\\Plan", sizeof("Polyspec\\Orm\\Dbspec\\Plan")-1, 1);
	zend_declare_typed_property(class_entry, property_plan_name, &property_plan_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_plan_class_Polyspec_Orm_Dbspec_Plan, 0, MAY_BE_NULL));
	zend_string_release(property_plan_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_PlanStepsResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "PlanStepsResult", class_Polyspec_Orm_Dbspec_PlanStepsResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_steps_default_value;
	ZVAL_UNDEF(&property_steps_default_value);
	zend_string *property_steps_name = zend_string_init("steps", sizeof("steps") - 1, 1);
	zend_declare_typed_property(class_entry, property_steps_name, &property_steps_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_steps_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ChainResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ChainResult", class_Polyspec_Orm_Dbspec_ChainResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_plans_default_value;
	ZVAL_UNDEF(&property_plans_default_value);
	zend_string *property_plans_name = zend_string_init("plans", sizeof("plans") - 1, 1);
	zend_declare_typed_property(class_entry, property_plans_name, &property_plans_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_plans_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_DiffResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "DiffResult", class_Polyspec_Orm_Dbspec_DiffResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_changes_default_value;
	ZVAL_UNDEF(&property_changes_default_value);
	zend_string *property_changes_name = zend_string_init("changes", sizeof("changes") - 1, 1);
	zend_declare_typed_property(class_entry, property_changes_name, &property_changes_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_changes_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_ComparisonResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "ComparisonResult", class_Polyspec_Orm_Dbspec_ComparisonResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_differences_default_value;
	ZVAL_UNDEF(&property_differences_default_value);
	zend_string *property_differences_name = zend_string_init("differences", sizeof("differences") - 1, 1);
	zend_declare_typed_property(class_entry, property_differences_name, &property_differences_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));
	zend_string_release(property_differences_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_MermaidExportResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "MermaidExportResult", class_Polyspec_Orm_Dbspec_MermaidExportResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_text_default_value;
	ZVAL_UNDEF(&property_text_default_value);
	zend_string *property_text_name = zend_string_init("text", sizeof("text") - 1, 1);
	zend_declare_typed_property(class_entry, property_text_name, &property_text_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_text_name);

	zval property_dropped_default_value;
	ZVAL_UNDEF(&property_dropped_default_value);
	zend_string *property_dropped_name = zend_string_init("dropped", sizeof("dropped") - 1, 1);
	zend_declare_typed_property(class_entry, property_dropped_name, &property_dropped_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_dropped_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_MermaidImportResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "MermaidImportResult", class_Polyspec_Orm_Dbspec_MermaidImportResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Polyspec_Orm_Dbspec_Document = zend_string_init("Polyspec\\Orm\\Dbspec\\Document", sizeof("Polyspec\\Orm\\Dbspec\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Polyspec_Orm_Dbspec_Document, 0, MAY_BE_NULL));
	zend_string_release(property_document_name);

	zval property_dropped_default_value;
	ZVAL_UNDEF(&property_dropped_default_value);
	zend_string *property_dropped_name = zend_string_init("dropped", sizeof("dropped") - 1, 1);
	zend_declare_typed_property(class_entry, property_dropped_name, &property_dropped_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_dropped_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_IntrospectResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "IntrospectResult", class_Polyspec_Orm_Dbspec_IntrospectResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Polyspec_Orm_Dbspec_Document = zend_string_init("Polyspec\\Orm\\Dbspec\\Document", sizeof("Polyspec\\Orm\\Dbspec\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Polyspec_Orm_Dbspec_Document, 0, 0));
	zend_string_release(property_document_name);

	zval property_unsupported_default_value;
	ZVAL_UNDEF(&property_unsupported_default_value);
	zend_string *property_unsupported_name = zend_string_init("unsupported", sizeof("unsupported") - 1, 1);
	zend_declare_typed_property(class_entry, property_unsupported_name, &property_unsupported_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_unsupported_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_Dbspec(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "Dbspec", class_Polyspec_Orm_Dbspec_Dbspec_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval const_SIGNATURE_value;
	zend_string *const_SIGNATURE_value_str = zend_string_init("dbspec ", strlen("dbspec "), 1);
	ZVAL_STR(&const_SIGNATURE_value, const_SIGNATURE_value_str);
	zend_string *const_SIGNATURE_name = zend_string_init_interned("SIGNATURE", sizeof("SIGNATURE") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SIGNATURE_name, &const_SIGNATURE_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SIGNATURE_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Dbspec_PlanApply(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm\\Dbspec", "PlanApply", class_Polyspec_Orm_Dbspec_PlanApply_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Code(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm", "Code", NULL);
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

static zend_class_entry *register_class_Polyspec_Orm_Codec(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm", "Codec", class_Polyspec_Orm_Codec_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Validator(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm", "Validator", class_Polyspec_Orm_Validator_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval const_IR_VERSION_value;
	ZVAL_LONG(&const_IR_VERSION_value, 1);
	zend_string *const_IR_VERSION_name = zend_string_init_interned("IR_VERSION", sizeof("IR_VERSION") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_IR_VERSION_name, &const_IR_VERSION_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(const_IR_VERSION_name);

	zval property_m_default_value;
	ZVAL_UNDEF(&property_m_default_value);
	zend_string *property_m_name = zend_string_init("m", sizeof("m") - 1, 1);
	zend_string *property_m_class_Polyspec_Orm_RuntimeModel = zend_string_init("Polyspec\\Orm\\RuntimeModel", sizeof("Polyspec\\Orm\\RuntimeModel")-1, 1);
	zend_declare_typed_property(class_entry, property_m_name, &property_m_default_value, ZEND_ACC_PRIVATE, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_m_class_Polyspec_Orm_RuntimeModel, 0, 0));
	zend_string_release(property_m_name);

	zval property_n_default_value;
	ZVAL_LONG(&property_n_default_value, 0);
	zend_string *property_n_name = zend_string_init("n", sizeof("n") - 1, 1);
	zend_declare_typed_property(class_entry, property_n_name, &property_n_default_value, ZEND_ACC_PRIVATE, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_n_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Planner(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm", "Planner", class_Polyspec_Orm_Planner_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_m_default_value;
	ZVAL_UNDEF(&property_m_default_value);
	zend_string *property_m_name = zend_string_init("m", sizeof("m") - 1, 1);
	zend_string *property_m_class_Polyspec_Orm_RuntimeModel = zend_string_init("Polyspec\\Orm\\RuntimeModel", sizeof("Polyspec\\Orm\\RuntimeModel")-1, 1);
	zend_declare_typed_property(class_entry, property_m_name, &property_m_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_m_class_Polyspec_Orm_RuntimeModel, 0, 0));
	zend_string_release(property_m_name);

	zval property_d_default_value;
	ZVAL_UNDEF(&property_d_default_value);
	zend_string *property_d_name = zend_string_init("d", sizeof("d") - 1, 1);
	zend_string *property_d_class_Polyspec_Orm_Dialect = zend_string_init("Polyspec\\Orm\\Dialect", sizeof("Polyspec\\Orm\\Dialect")-1, 1);
	zend_declare_typed_property(class_entry, property_d_name, &property_d_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_d_class_Polyspec_Orm_Dialect, 0, 0));
	zend_string_release(property_d_name);

	return class_entry;
}

static zend_class_entry *register_class_Polyspec_Orm_Db(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Polyspec\\Orm", "Db", class_Polyspec_Orm_Db_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval const_SECRET_value;
	zend_string *const_SECRET_value_str = zend_string_init("$SECRET", strlen("$SECRET"), 1);
	ZVAL_STR(&const_SECRET_value, const_SECRET_value_str);
	zend_string *const_SECRET_name = zend_string_init_interned("SECRET", sizeof("SECRET") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SECRET_name, &const_SECRET_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SECRET_name);

	zval const_NOW_value;
	zend_string *const_NOW_value_str = zend_string_init("$NOW", strlen("$NOW"), 1);
	ZVAL_STR(&const_NOW_value, const_NOW_value_str);
	zend_string *const_NOW_name = zend_string_init_interned("NOW", sizeof("NOW") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_NOW_name, &const_NOW_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_NOW_name);

	zval property_state_default_value;
	ZVAL_UNDEF(&property_state_default_value);
	zend_string *property_state_name = zend_string_init("state", sizeof("state") - 1, 1);
	zend_string *property_state_class_Polyspec_Orm_DbState = zend_string_init("Polyspec\\Orm\\DbState", sizeof("Polyspec\\Orm\\DbState")-1, 1);
	zend_declare_typed_property(class_entry, property_state_name, &property_state_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_state_class_Polyspec_Orm_DbState, 0, 0));
	zend_string_release(property_state_name);

	zval property_masks_default_value;
	ZVAL_UNDEF(&property_masks_default_value);
	zend_string *property_masks_name = zend_string_init("masks", sizeof("masks") - 1, 1);
	zend_declare_typed_property(class_entry, property_masks_name, &property_masks_default_value, ZEND_ACC_PRIVATE, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_masks_name);

	zval property_typed_default_value;
	ZVAL_UNDEF(&property_typed_default_value);
	zend_string *property_typed_name = zend_string_init("typed", sizeof("typed") - 1, 1);
	zend_declare_typed_property(class_entry, property_typed_name, &property_typed_default_value, ZEND_ACC_PRIVATE, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_typed_name);

	zval property_requestHook_default_value;
	ZVAL_UNDEF(&property_requestHook_default_value);
	zend_string *property_requestHook_name = zend_string_init("requestHook", sizeof("requestHook") - 1, 1);
	zend_string *property_requestHook_class_Closure = zend_string_init("Closure", sizeof("Closure")-1, 1);
	zend_declare_typed_property(class_entry, property_requestHook_name, &property_requestHook_default_value, ZEND_ACC_PRIVATE, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_requestHook_class_Closure, 0, MAY_BE_NULL));
	zend_string_release(property_requestHook_name);

	zval property_driver_default_value;
	ZVAL_UNDEF(&property_driver_default_value);
	zend_string *property_driver_name = zend_string_init("driver", sizeof("driver") - 1, 1);
	zend_declare_typed_property(class_entry, property_driver_name, &property_driver_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_driver_name);

	zval property_config_default_value;
	ZVAL_UNDEF(&property_config_default_value);
	zend_string *property_config_name = zend_string_init("config", sizeof("config") - 1, 1);
	zend_string *property_config_class_Polyspec_Orm_Config = zend_string_init("Polyspec\\Orm\\Config", sizeof("Polyspec\\Orm\\Config")-1, 1);
	zend_declare_typed_property(class_entry, property_config_name, &property_config_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_config_class_Polyspec_Orm_Config, 0, 0));
	zend_string_release(property_config_name);

	zval property_zone_default_value;
	ZVAL_UNDEF(&property_zone_default_value);
	zend_string *property_zone_name = zend_string_init("zone", sizeof("zone") - 1, 1);
	zend_string *property_zone_class_DateTimeZone = zend_string_init("DateTimeZone", sizeof("DateTimeZone")-1, 1);
	zend_declare_typed_property(class_entry, property_zone_name, &property_zone_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_zone_class_DateTimeZone, 0, 0));
	zend_string_release(property_zone_name);

	zval property_md_default_value;
	ZVAL_UNDEF(&property_md_default_value);
	zend_string *property_md_name = zend_string_init("md", sizeof("md") - 1, 1);
	zend_string *property_md_class_Polyspec_Orm_MarkdownSession = zend_string_init("Polyspec\\Orm\\MarkdownSession", sizeof("Polyspec\\Orm\\MarkdownSession")-1, 1);
	zend_declare_typed_property(class_entry, property_md_name, &property_md_default_value, ZEND_ACC_PRIVATE|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_md_class_Polyspec_Orm_MarkdownSession, 0, MAY_BE_NULL));
	zend_string_release(property_md_name);

	return class_entry;
}
