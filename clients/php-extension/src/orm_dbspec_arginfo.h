/* This is a generated file, edit the .stub.php file instead.
 * Stub hash: 168d98d02408042e56a0c6a57ed608ec559d6429 */

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Diagnostic___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, rule, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, line, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, message, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Document___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_UseLine___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, document, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, tables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Table___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Column___construct, 0, 0, 5)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, type, Orm\\Dbspec\\\116ative\\ColumnType, 0)
	ZEND_ARG_TYPE_INFO(0, nullable, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, identity, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, default, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ColumnType___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, parameters, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_ColumnType_text, 0, 0, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_ColumnType_isInteger, 0, 0, _IS_BOOL, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_PrimaryKey___construct, 0, 0, 1)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_UniqueKey___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_Index___construct arginfo_class_Orm_Dbspec_Native_UniqueKey___construct

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_IndexColumn___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, descending, _IS_BOOL, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ForeignKey___construct, 0, 0, 6)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, referencedColumns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, onDelete, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, onUpdate, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_ForeignKey_changesChildRows arginfo_class_Orm_Dbspec_Native_ColumnType_isInteger

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Check___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, expression, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Settings___construct, 0, 0, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Setting___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, arguments, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, exclude, IS_ARRAY, 1, "null")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, include, IS_ARRAY, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Setting_records, 0, 1, _IS_BOOL, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Setting_excluded, 0, 1, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, table, Orm\\Dbspec\\\116ative\\Table, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Setting_auditLine, 0, 2, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, list, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, columns, IS_ARRAY, 1)
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_Diagram___construct arginfo_class_Orm_Dbspec_Native_Table___construct

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Placement___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, x, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, y, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, comments, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ReadResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ReadResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ReadResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ParseResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ParseResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\ParseResult, 0)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ParseResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\ParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Manifest___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, manifestText, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, schemaText, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, manifestHash, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, schemaHash, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, externalText, IS_STRING, 0, "\'\'")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ManifestResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, manifest, Orm\\Dbspec\\\116ative\\Manifest, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ManifestResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\ManifestResult, 0)
	ZEND_ARG_OBJ_INFO(0, manifest, Orm\\Dbspec\\\116ative\\Manifest, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ManifestResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\ManifestResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_RenderResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, statements, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_RenderResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\RenderResult, 0)
	ZEND_ARG_TYPE_INFO(0, statements, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_RenderResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\RenderResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Plan___construct, 0, 0, 8)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, from, IS_STRING, 1)
	ZEND_ARG_TYPE_INFO(0, renameTables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, renameColumns, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, dropTables, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, dropColumns, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, schema, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, to, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanStep___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, statement, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, rollback, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, irreversible, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, effect, Orm\\Dbspec\\\116ative\\Effect, 0)
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, restore, IS_STRING, 0, "\'\'")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, rollbackRestore, IS_STRING, 0, "\'\'")
	ZEND_ARG_OBJ_INFO_WITH_DEFAULT_VALUE(0, restoreIf, Orm\\Dbspec\\\116ative\\Effect, 1, "null")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, nullChecks, IS_ARRAY, 0, "[]")
	ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, finalize, _IS_BOOL, 0, "false")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Effect___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, present, _IS_BOOL, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Effect_repeat, 0, 0, Orm\\Dbspec\\\116ative\\Effect, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_Effect_text arginfo_class_Orm_Dbspec_Native_ColumnType_text

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_NullCheck___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, column, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, default, IS_STRING, 1)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Change___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_Difference___construct arginfo_class_Orm_Dbspec_Native_Change___construct

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_Unsupported___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, reason, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_TableRename___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, old, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, new, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ColumnRename___construct, 0, 0, 3)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, old, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, new, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ColumnName___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, table, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ApplyEvent___construct, 0, 0, 5)
	ZEND_ARG_TYPE_INFO(0, kind, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plan, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, step, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, steps, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, statement, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ApplyError___construct, 0, 0, 4)
	ZEND_ARG_TYPE_INFO(0, code_, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plan, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, step, IS_LONG, 0)
	ZEND_ARG_TYPE_INFO(0, detail, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO_WITH_DEFAULT_VALUE(0, previous, Throwable, 1, "null")
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ApplyCleanupError___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, failure, Throwable, 0)
	ZEND_ARG_TYPE_INFO(0, cleanup, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanParseResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, plan, Orm\\Dbspec\\\116ative\\Plan, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanParseResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\PlanParseResult, 0)
	ZEND_ARG_OBJ_INFO(0, plan, Orm\\Dbspec\\\116ative\\Plan, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanParseResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\PlanParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanStepsResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, steps, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanStepsResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\PlanStepsResult, 0)
	ZEND_ARG_TYPE_INFO(0, steps, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanStepsResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\PlanStepsResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ChainResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ChainResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\ChainResult, 0)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ChainResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\ChainResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_DiffResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, changes, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_DiffResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\DiffResult, 0)
	ZEND_ARG_TYPE_INFO(0, changes, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_DiffResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\DiffResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_ComparisonResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, differences, IS_ARRAY, 1)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ComparisonResult_valid, 0, 1, Orm\\Dbspec\\\116ative\\ComparisonResult, 0)
	ZEND_ARG_TYPE_INFO(0, differences, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_ComparisonResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\ComparisonResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_MermaidExportResult___construct, 0, 0, 2)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, dropped, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_MermaidImportResult___construct, 0, 0, 3)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 1)
	ZEND_ARG_TYPE_INFO(0, dropped, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_MermaidImportResult_valid, 0, 2, Orm\\Dbspec\\\116ative\\MermaidImportResult, 0)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, dropped, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_MermaidImportResult_invalid, 0, 1, Orm\\Dbspec\\\116ative\\MermaidImportResult, 0)
	ZEND_ARG_TYPE_INFO(0, diagnostics, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_IntrospectResult___construct, 0, 0, 2)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, unsupported, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_parse, 0, 2, Orm\\Dbspec\\\116ative\\ParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_readFile, 0, 1, Orm\\Dbspec\\\116ative\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, path, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_readBytes, 0, 2, Orm\\Dbspec\\\116ative\\ReadResult, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, bytes, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_emit, 0, 1, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_render, 0, 2, Orm\\Dbspec\\\116ative\\RenderResult, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_introspect, 0, 3, Orm\\Dbspec\\\116ative\\IntrospectResult, 0)
	ZEND_ARG_OBJ_INFO(0, connection, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_manifest, 0, 1, Orm\\Dbspec\\\116ative\\ManifestResult, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_externalDifferences, 0, 2, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, live, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, documents, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_parsePlan, 0, 1, Orm\\Dbspec\\\116ative\\PlanParseResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_emitPlan, 0, 1, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, plan, Orm\\Dbspec\\\116ative\\Plan, 0)
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_Dbspec_chain arginfo_class_Orm_Dbspec_Native_ChainResult_valid

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_diff, 0, 2, Orm\\Dbspec\\\116ative\\DiffResult, 0)
	ZEND_ARG_OBJ_INFO(0, source, Orm\\Dbspec\\\116ative\\Document, 1)
	ZEND_ARG_OBJ_INFO(0, plan, Orm\\Dbspec\\\116ative\\Plan, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_compareSchemas, 0, 2, Orm\\Dbspec\\\116ative\\ComparisonResult, 0)
	ZEND_ARG_OBJ_INFO(0, source, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_OBJ_INFO(0, target, Orm\\Dbspec\\\116ative\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_installedDifferences, 0, 3, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, live, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, unsupported, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, target, Orm\\Dbspec\\\116ative\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_addTablesAndColumnsSteps, 0, 4, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, live, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, unsupported, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, target, Orm\\Dbspec\\\116ative\\Document, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_planSteps, 0, 3, Orm\\Dbspec\\\116ative\\PlanStepsResult, 0)
	ZEND_ARG_OBJ_INFO(0, source, Orm\\Dbspec\\\116ative\\Document, 1)
	ZEND_ARG_OBJ_INFO(0, plan, Orm\\Dbspec\\\116ative\\Plan, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_apply, 0, 5, IS_VOID, 0)
	ZEND_ARG_OBJ_INFO(0, connection, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, plans, IS_ARRAY, 0)
	ZEND_ARG_OBJ_INFO(0, now, Closure, 0)
	ZEND_ARG_OBJ_INFO(0, events, Closure, 1)
ZEND_END_ARG_INFO()

#define arginfo_class_Orm_Dbspec_Native_Dbspec_recover arginfo_class_Orm_Dbspec_Native_Dbspec_apply

#define arginfo_class_Orm_Dbspec_Native_Dbspec_rollback arginfo_class_Orm_Dbspec_Native_Dbspec_apply

#define arginfo_class_Orm_Dbspec_Native_Dbspec_finalize arginfo_class_Orm_Dbspec_Native_Dbspec_apply

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_exportMermaid, 0, 1, Orm\\Dbspec\\\116ative\\MermaidExportResult, 0)
	ZEND_ARG_OBJ_INFO(0, document, Orm\\Dbspec\\\116ative\\Document, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_OBJ_INFO_EX(arginfo_class_Orm_Dbspec_Native_Dbspec_importMermaid, 0, 2, Orm\\Dbspec\\\116ative\\MermaidImportResult, 0)
	ZEND_ARG_TYPE_INFO(0, text, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanApply___construct, 0, 0, 0)
ZEND_END_ARG_INFO()

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_class_Orm_Dbspec_Native_PlanApply_effectOn, 0, 3, _IS_BOOL, 0)
	ZEND_ARG_OBJ_INFO(0, c, PDO, 0)
	ZEND_ARG_TYPE_INFO(0, dialect, IS_STRING, 0)
	ZEND_ARG_OBJ_INFO(0, e, Orm\\Dbspec\\\116ative\\Effect, 0)
ZEND_END_ARG_INFO()

ZEND_METHOD(Orm_Dbspec_Native_Diagnostic, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Document, __construct);
ZEND_METHOD(Orm_Dbspec_Native_UseLine, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Table, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Column, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ColumnType, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ColumnType, text);
ZEND_METHOD(Orm_Dbspec_Native_ColumnType, isInteger);
ZEND_METHOD(Orm_Dbspec_Native_PrimaryKey, __construct);
ZEND_METHOD(Orm_Dbspec_Native_UniqueKey, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Index, __construct);
ZEND_METHOD(Orm_Dbspec_Native_IndexColumn, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ForeignKey, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ForeignKey, changesChildRows);
ZEND_METHOD(Orm_Dbspec_Native_Check, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Settings, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Setting, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Setting, records);
ZEND_METHOD(Orm_Dbspec_Native_Setting, excluded);
ZEND_METHOD(Orm_Dbspec_Native_Setting, auditLine);
ZEND_METHOD(Orm_Dbspec_Native_Diagram, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Placement, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ReadResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ReadResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_ReadResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_ParseResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ParseResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_ParseResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_Manifest, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ManifestResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ManifestResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_ManifestResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_RenderResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_RenderResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_RenderResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_Plan, __construct);
ZEND_METHOD(Orm_Dbspec_Native_PlanStep, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Effect, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Effect, repeat);
ZEND_METHOD(Orm_Dbspec_Native_Effect, text);
ZEND_METHOD(Orm_Dbspec_Native_NullCheck, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Change, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Difference, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Unsupported, __construct);
ZEND_METHOD(Orm_Dbspec_Native_TableRename, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ColumnRename, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ColumnName, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ApplyEvent, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ApplyError, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ApplyCleanupError, __construct);
ZEND_METHOD(Orm_Dbspec_Native_PlanParseResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_PlanParseResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_PlanParseResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_PlanStepsResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_PlanStepsResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_PlanStepsResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_ChainResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ChainResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_ChainResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_DiffResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_DiffResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_DiffResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_ComparisonResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_ComparisonResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_ComparisonResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_MermaidExportResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_MermaidImportResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_MermaidImportResult, valid);
ZEND_METHOD(Orm_Dbspec_Native_MermaidImportResult, invalid);
ZEND_METHOD(Orm_Dbspec_Native_IntrospectResult, __construct);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, parse);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, readFile);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, readBytes);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, emit);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, render);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, introspect);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, manifest);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, externalDifferences);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, parsePlan);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, emitPlan);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, chain);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, diff);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, compareSchemas);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, installedDifferences);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, addTablesAndColumnsSteps);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, planSteps);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, apply);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, recover);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, rollback);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, finalize);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, exportMermaid);
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, importMermaid);
ZEND_METHOD(Orm_Dbspec_Native_PlanApply, __construct);
ZEND_METHOD(Orm_Dbspec_Native_PlanApply, effectOn);

static const zend_function_entry class_Orm_Dbspec_Native_Diagnostic_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Diagnostic, __construct, arginfo_class_Orm_Dbspec_Native_Diagnostic___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Document_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Document, __construct, arginfo_class_Orm_Dbspec_Native_Document___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_UseLine_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_UseLine, __construct, arginfo_class_Orm_Dbspec_Native_UseLine___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Table_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Table, __construct, arginfo_class_Orm_Dbspec_Native_Table___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Column_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Column, __construct, arginfo_class_Orm_Dbspec_Native_Column___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ColumnType_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ColumnType, __construct, arginfo_class_Orm_Dbspec_Native_ColumnType___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_ColumnType, text, arginfo_class_Orm_Dbspec_Native_ColumnType_text, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_ColumnType, isInteger, arginfo_class_Orm_Dbspec_Native_ColumnType_isInteger, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_PrimaryKey_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_PrimaryKey, __construct, arginfo_class_Orm_Dbspec_Native_PrimaryKey___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_UniqueKey_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_UniqueKey, __construct, arginfo_class_Orm_Dbspec_Native_UniqueKey___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Index_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Index, __construct, arginfo_class_Orm_Dbspec_Native_Index___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_IndexColumn_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_IndexColumn, __construct, arginfo_class_Orm_Dbspec_Native_IndexColumn___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ForeignKey_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ForeignKey, __construct, arginfo_class_Orm_Dbspec_Native_ForeignKey___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_ForeignKey, changesChildRows, arginfo_class_Orm_Dbspec_Native_ForeignKey_changesChildRows, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Check_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Check, __construct, arginfo_class_Orm_Dbspec_Native_Check___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Settings_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Settings, __construct, arginfo_class_Orm_Dbspec_Native_Settings___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Setting_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Setting, __construct, arginfo_class_Orm_Dbspec_Native_Setting___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_Setting, records, arginfo_class_Orm_Dbspec_Native_Setting_records, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_Setting, excluded, arginfo_class_Orm_Dbspec_Native_Setting_excluded, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_Setting, auditLine, arginfo_class_Orm_Dbspec_Native_Setting_auditLine, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Diagram_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Diagram, __construct, arginfo_class_Orm_Dbspec_Native_Diagram___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Placement_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Placement, __construct, arginfo_class_Orm_Dbspec_Native_Placement___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ReadResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ReadResult, __construct, arginfo_class_Orm_Dbspec_Native_ReadResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_ReadResult, valid, arginfo_class_Orm_Dbspec_Native_ReadResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_ReadResult, invalid, arginfo_class_Orm_Dbspec_Native_ReadResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ParseResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ParseResult, __construct, arginfo_class_Orm_Dbspec_Native_ParseResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_ParseResult, valid, arginfo_class_Orm_Dbspec_Native_ParseResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_ParseResult, invalid, arginfo_class_Orm_Dbspec_Native_ParseResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Manifest_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Manifest, __construct, arginfo_class_Orm_Dbspec_Native_Manifest___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ManifestResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ManifestResult, __construct, arginfo_class_Orm_Dbspec_Native_ManifestResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_ManifestResult, valid, arginfo_class_Orm_Dbspec_Native_ManifestResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_ManifestResult, invalid, arginfo_class_Orm_Dbspec_Native_ManifestResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_RenderResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_RenderResult, __construct, arginfo_class_Orm_Dbspec_Native_RenderResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_RenderResult, valid, arginfo_class_Orm_Dbspec_Native_RenderResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_RenderResult, invalid, arginfo_class_Orm_Dbspec_Native_RenderResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Plan_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Plan, __construct, arginfo_class_Orm_Dbspec_Native_Plan___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_PlanStep_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_PlanStep, __construct, arginfo_class_Orm_Dbspec_Native_PlanStep___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Effect_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Effect, __construct, arginfo_class_Orm_Dbspec_Native_Effect___construct, ZEND_ACC_PUBLIC)
	ZEND_ME(Orm_Dbspec_Native_Effect, repeat, arginfo_class_Orm_Dbspec_Native_Effect_repeat, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Effect, text, arginfo_class_Orm_Dbspec_Native_Effect_text, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_NullCheck_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_NullCheck, __construct, arginfo_class_Orm_Dbspec_Native_NullCheck___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Change_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Change, __construct, arginfo_class_Orm_Dbspec_Native_Change___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Difference_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Difference, __construct, arginfo_class_Orm_Dbspec_Native_Difference___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Unsupported_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Unsupported, __construct, arginfo_class_Orm_Dbspec_Native_Unsupported___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_TableRename_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_TableRename, __construct, arginfo_class_Orm_Dbspec_Native_TableRename___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ColumnRename_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ColumnRename, __construct, arginfo_class_Orm_Dbspec_Native_ColumnRename___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ColumnName_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ColumnName, __construct, arginfo_class_Orm_Dbspec_Native_ColumnName___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ApplyEvent_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ApplyEvent, __construct, arginfo_class_Orm_Dbspec_Native_ApplyEvent___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ApplyError_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ApplyError, __construct, arginfo_class_Orm_Dbspec_Native_ApplyError___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ApplyCleanupError_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ApplyCleanupError, __construct, arginfo_class_Orm_Dbspec_Native_ApplyCleanupError___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_PlanParseResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_PlanParseResult, __construct, arginfo_class_Orm_Dbspec_Native_PlanParseResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_PlanParseResult, valid, arginfo_class_Orm_Dbspec_Native_PlanParseResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_PlanParseResult, invalid, arginfo_class_Orm_Dbspec_Native_PlanParseResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_PlanStepsResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_PlanStepsResult, __construct, arginfo_class_Orm_Dbspec_Native_PlanStepsResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_PlanStepsResult, valid, arginfo_class_Orm_Dbspec_Native_PlanStepsResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_PlanStepsResult, invalid, arginfo_class_Orm_Dbspec_Native_PlanStepsResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ChainResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ChainResult, __construct, arginfo_class_Orm_Dbspec_Native_ChainResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_ChainResult, valid, arginfo_class_Orm_Dbspec_Native_ChainResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_ChainResult, invalid, arginfo_class_Orm_Dbspec_Native_ChainResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_DiffResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_DiffResult, __construct, arginfo_class_Orm_Dbspec_Native_DiffResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_DiffResult, valid, arginfo_class_Orm_Dbspec_Native_DiffResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_DiffResult, invalid, arginfo_class_Orm_Dbspec_Native_DiffResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_ComparisonResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_ComparisonResult, __construct, arginfo_class_Orm_Dbspec_Native_ComparisonResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_ComparisonResult, valid, arginfo_class_Orm_Dbspec_Native_ComparisonResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_ComparisonResult, invalid, arginfo_class_Orm_Dbspec_Native_ComparisonResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_MermaidExportResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_MermaidExportResult, __construct, arginfo_class_Orm_Dbspec_Native_MermaidExportResult___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_MermaidImportResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_MermaidImportResult, __construct, arginfo_class_Orm_Dbspec_Native_MermaidImportResult___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_MermaidImportResult, valid, arginfo_class_Orm_Dbspec_Native_MermaidImportResult_valid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_MermaidImportResult, invalid, arginfo_class_Orm_Dbspec_Native_MermaidImportResult_invalid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_IntrospectResult_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_IntrospectResult, __construct, arginfo_class_Orm_Dbspec_Native_IntrospectResult___construct, ZEND_ACC_PUBLIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_Dbspec_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_Dbspec, parse, arginfo_class_Orm_Dbspec_Native_Dbspec_parse, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, readFile, arginfo_class_Orm_Dbspec_Native_Dbspec_readFile, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, readBytes, arginfo_class_Orm_Dbspec_Native_Dbspec_readBytes, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, emit, arginfo_class_Orm_Dbspec_Native_Dbspec_emit, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, render, arginfo_class_Orm_Dbspec_Native_Dbspec_render, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, introspect, arginfo_class_Orm_Dbspec_Native_Dbspec_introspect, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, manifest, arginfo_class_Orm_Dbspec_Native_Dbspec_manifest, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, externalDifferences, arginfo_class_Orm_Dbspec_Native_Dbspec_externalDifferences, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, parsePlan, arginfo_class_Orm_Dbspec_Native_Dbspec_parsePlan, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, emitPlan, arginfo_class_Orm_Dbspec_Native_Dbspec_emitPlan, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, chain, arginfo_class_Orm_Dbspec_Native_Dbspec_chain, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, diff, arginfo_class_Orm_Dbspec_Native_Dbspec_diff, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, compareSchemas, arginfo_class_Orm_Dbspec_Native_Dbspec_compareSchemas, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, installedDifferences, arginfo_class_Orm_Dbspec_Native_Dbspec_installedDifferences, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, addTablesAndColumnsSteps, arginfo_class_Orm_Dbspec_Native_Dbspec_addTablesAndColumnsSteps, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, planSteps, arginfo_class_Orm_Dbspec_Native_Dbspec_planSteps, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, apply, arginfo_class_Orm_Dbspec_Native_Dbspec_apply, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, recover, arginfo_class_Orm_Dbspec_Native_Dbspec_recover, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, rollback, arginfo_class_Orm_Dbspec_Native_Dbspec_rollback, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, finalize, arginfo_class_Orm_Dbspec_Native_Dbspec_finalize, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, exportMermaid, arginfo_class_Orm_Dbspec_Native_Dbspec_exportMermaid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_ME(Orm_Dbspec_Native_Dbspec, importMermaid, arginfo_class_Orm_Dbspec_Native_Dbspec_importMermaid, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static const zend_function_entry class_Orm_Dbspec_Native_PlanApply_methods[] = {
	ZEND_ME(Orm_Dbspec_Native_PlanApply, __construct, arginfo_class_Orm_Dbspec_Native_PlanApply___construct, ZEND_ACC_PRIVATE)
	ZEND_ME(Orm_Dbspec_Native_PlanApply, effectOn, arginfo_class_Orm_Dbspec_Native_PlanApply_effectOn, ZEND_ACC_PUBLIC|ZEND_ACC_STATIC)
	ZEND_FE_END
};

static zend_class_entry *register_class_Orm_Dbspec_Native_Diagnostic(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Diagnostic", class_Orm_Dbspec_Native_Diagnostic_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_rule_default_value;
	ZVAL_UNDEF(&property_rule_default_value);
	zend_string *property_rule_name = zend_string_init("rule", sizeof("rule") - 1, 1);
	zend_declare_typed_property(class_entry, property_rule_name, &property_rule_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_rule_name);

	zval property_line_default_value;
	ZVAL_UNDEF(&property_line_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_LINE), &property_line_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));

	zval property_column_default_value;
	ZVAL_UNDEF(&property_column_default_value);
	zend_string *property_column_name = zend_string_init("column", sizeof("column") - 1, 1);
	zend_declare_typed_property(class_entry, property_column_name, &property_column_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_LONG));
	zend_string_release(property_column_name);

	zval property_message_default_value;
	ZVAL_UNDEF(&property_message_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_MESSAGE), &property_message_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Document(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Document", class_Orm_Dbspec_Native_Document_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_UseLine(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "UseLine", class_Orm_Dbspec_Native_UseLine_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_Table(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Table", class_Orm_Dbspec_Native_Table_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_columns_default_value;
	ZVAL_EMPTY_ARRAY(&property_columns_default_value);
	zend_string *property_columns_name = zend_string_init("columns", sizeof("columns") - 1, 1);
	zend_declare_typed_property(class_entry, property_columns_name, &property_columns_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_columns_name);

	zval property_primaryKey_default_value;
	ZVAL_NULL(&property_primaryKey_default_value);
	zend_string *property_primaryKey_name = zend_string_init("primaryKey", sizeof("primaryKey") - 1, 1);
	zend_string *property_primaryKey_class_Orm_Dbspec_Native_PrimaryKey = zend_string_init("Orm\\Dbspec\\\116ative\\PrimaryKey", sizeof("Orm\\Dbspec\\\116ative\\PrimaryKey")-1, 1);
	zend_declare_typed_property(class_entry, property_primaryKey_name, &property_primaryKey_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_primaryKey_class_Orm_Dbspec_Native_PrimaryKey, 0, MAY_BE_NULL));
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
	zend_string *property_settings_class_Orm_Dbspec_Native_Settings = zend_string_init("Orm\\Dbspec\\\116ative\\Settings", sizeof("Orm\\Dbspec\\\116ative\\Settings")-1, 1);
	zend_declare_typed_property(class_entry, property_settings_name, &property_settings_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_settings_class_Orm_Dbspec_Native_Settings, 0, MAY_BE_NULL));
	zend_string_release(property_settings_name);

	zval property_closingComments_default_value;
	ZVAL_EMPTY_ARRAY(&property_closingComments_default_value);
	zend_string *property_closingComments_name = zend_string_init("closingComments", sizeof("closingComments") - 1, 1);
	zend_declare_typed_property(class_entry, property_closingComments_name, &property_closingComments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_closingComments_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Column(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Column", class_Orm_Dbspec_Native_Column_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_type_default_value;
	ZVAL_UNDEF(&property_type_default_value);
	zend_string *property_type_class_Orm_Dbspec_Native_ColumnType = zend_string_init("Orm\\Dbspec\\\116ative\\ColumnType", sizeof("Orm\\Dbspec\\\116ative\\ColumnType")-1, 1);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_TYPE), &property_type_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_type_class_Orm_Dbspec_Native_ColumnType, 0, 0));

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

static zend_class_entry *register_class_Orm_Dbspec_Native_ColumnType(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ColumnType", class_Orm_Dbspec_Native_ColumnType_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_parameters_default_value;
	ZVAL_UNDEF(&property_parameters_default_value);
	zend_string *property_parameters_name = zend_string_init("parameters", sizeof("parameters") - 1, 1);
	zend_declare_typed_property(class_entry, property_parameters_name, &property_parameters_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_parameters_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_PrimaryKey(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "PrimaryKey", class_Orm_Dbspec_Native_PrimaryKey_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_UniqueKey(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "UniqueKey", class_Orm_Dbspec_Native_UniqueKey_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

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

static zend_class_entry *register_class_Orm_Dbspec_Native_Index(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Index", class_Orm_Dbspec_Native_Index_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

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

static zend_class_entry *register_class_Orm_Dbspec_Native_IndexColumn(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "IndexColumn", class_Orm_Dbspec_Native_IndexColumn_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_descending_default_value;
	ZVAL_UNDEF(&property_descending_default_value);
	zend_string *property_descending_name = zend_string_init("descending", sizeof("descending") - 1, 1);
	zend_declare_typed_property(class_entry, property_descending_name, &property_descending_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_descending_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_ForeignKey(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ForeignKey", class_Orm_Dbspec_Native_ForeignKey_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

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

static zend_class_entry *register_class_Orm_Dbspec_Native_Check(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Check", class_Orm_Dbspec_Native_Check_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

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

static zend_class_entry *register_class_Orm_Dbspec_Native_Settings(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Settings", class_Orm_Dbspec_Native_Settings_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_Setting(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Setting", class_Orm_Dbspec_Native_Setting_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_INCLUDE), &property_include_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY|MAY_BE_NULL));

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Diagram(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Diagram", class_Orm_Dbspec_Native_Diagram_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_comments_default_value;
	ZVAL_UNDEF(&property_comments_default_value);
	zend_string *property_comments_name = zend_string_init("comments", sizeof("comments") - 1, 1);
	zend_declare_typed_property(class_entry, property_comments_name, &property_comments_default_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_comments_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Placement(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Placement", class_Orm_Dbspec_Native_Placement_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ReadResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ReadResult", class_Orm_Dbspec_Native_ReadResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ParseResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ParseResult", class_Orm_Dbspec_Native_ParseResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Orm_Dbspec_Native_Document = zend_string_init("Orm\\Dbspec\\\116ative\\Document", sizeof("Orm\\Dbspec\\\116ative\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Orm_Dbspec_Native_Document, 0, MAY_BE_NULL));
	zend_string_release(property_document_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Manifest(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Manifest", class_Orm_Dbspec_Native_Manifest_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ManifestResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ManifestResult", class_Orm_Dbspec_Native_ManifestResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_manifest_default_value;
	ZVAL_UNDEF(&property_manifest_default_value);
	zend_string *property_manifest_name = zend_string_init("manifest", sizeof("manifest") - 1, 1);
	zend_string *property_manifest_class_Orm_Dbspec_Native_Manifest = zend_string_init("Orm\\Dbspec\\\116ative\\Manifest", sizeof("Orm\\Dbspec\\\116ative\\Manifest")-1, 1);
	zend_declare_typed_property(class_entry, property_manifest_name, &property_manifest_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_manifest_class_Orm_Dbspec_Native_Manifest, 0, MAY_BE_NULL));
	zend_string_release(property_manifest_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_RenderResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "RenderResult", class_Orm_Dbspec_Native_RenderResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_Plan(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Plan", class_Orm_Dbspec_Native_Plan_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_from_default_value;
	ZVAL_UNDEF(&property_from_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_FROM), &property_from_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING|MAY_BE_NULL));

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
	zend_string *property_schema_class_Orm_Dbspec_Native_Document = zend_string_init("Orm\\Dbspec\\\116ative\\Document", sizeof("Orm\\Dbspec\\\116ative\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_schema_name, &property_schema_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_schema_class_Orm_Dbspec_Native_Document, 0, 0));
	zend_string_release(property_schema_name);

	zval property_to_default_value;
	ZVAL_UNDEF(&property_to_default_value);
	zend_string *property_to_name = zend_string_init("to", sizeof("to") - 1, 1);
	zend_declare_typed_property(class_entry, property_to_name, &property_to_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_to_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_PlanStep(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "PlanStep", class_Orm_Dbspec_Native_PlanStep_methods);
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
	zend_string *property_effect_class_Orm_Dbspec_Native_Effect = zend_string_init("Orm\\Dbspec\\\116ative\\Effect", sizeof("Orm\\Dbspec\\\116ative\\Effect")-1, 1);
	zend_declare_typed_property(class_entry, property_effect_name, &property_effect_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_effect_class_Orm_Dbspec_Native_Effect, 0, 0));
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
	zend_string *property_restoreIf_class_Orm_Dbspec_Native_Effect = zend_string_init("Orm\\Dbspec\\\116ative\\Effect", sizeof("Orm\\Dbspec\\\116ative\\Effect")-1, 1);
	zend_declare_typed_property(class_entry, property_restoreIf_name, &property_restoreIf_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_restoreIf_class_Orm_Dbspec_Native_Effect, 0, MAY_BE_NULL));
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

static zend_class_entry *register_class_Orm_Dbspec_Native_Effect(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Effect", class_Orm_Dbspec_Native_Effect_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_present_default_value;
	ZVAL_UNDEF(&property_present_default_value);
	zend_string *property_present_name = zend_string_init("present", sizeof("present") - 1, 1);
	zend_declare_typed_property(class_entry, property_present_name, &property_present_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_BOOL));
	zend_string_release(property_present_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_NullCheck(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "NullCheck", class_Orm_Dbspec_Native_NullCheck_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_Change(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Change", class_Orm_Dbspec_Native_Change_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Difference(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Difference", class_Orm_Dbspec_Native_Difference_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Unsupported(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Unsupported", class_Orm_Dbspec_Native_Unsupported_methods);
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
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	zval property_reason_default_value;
	ZVAL_UNDEF(&property_reason_default_value);
	zend_string *property_reason_name = zend_string_init("reason", sizeof("reason") - 1, 1);
	zend_declare_typed_property(class_entry, property_reason_name, &property_reason_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_reason_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_TableRename(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "TableRename", class_Orm_Dbspec_Native_TableRename_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ColumnRename(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ColumnRename", class_Orm_Dbspec_Native_ColumnRename_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ColumnName(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ColumnName", class_Orm_Dbspec_Native_ColumnName_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_table_default_value;
	ZVAL_UNDEF(&property_table_default_value);
	zend_string *property_table_name = zend_string_init("table", sizeof("table") - 1, 1);
	zend_declare_typed_property(class_entry, property_table_name, &property_table_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(property_table_name);

	zval property_name_default_value;
	ZVAL_UNDEF(&property_name_default_value);
	zend_declare_typed_property(class_entry, ZSTR_KNOWN(ZEND_STR_NAME), &property_name_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_ApplyEvent(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ApplyEvent", class_Orm_Dbspec_Native_ApplyEvent_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ApplyError(zend_class_entry *class_entry_RuntimeException)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ApplyError", class_Orm_Dbspec_Native_ApplyError_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ApplyCleanupError(zend_class_entry *class_entry_RuntimeException)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ApplyCleanupError", class_Orm_Dbspec_Native_ApplyCleanupError_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, class_entry_RuntimeException, ZEND_ACC_FINAL);

	zval property_cleanup_default_value;
	ZVAL_UNDEF(&property_cleanup_default_value);
	zend_string *property_cleanup_name = zend_string_init("cleanup", sizeof("cleanup") - 1, 1);
	zend_declare_typed_property(class_entry, property_cleanup_name, &property_cleanup_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_cleanup_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_PlanParseResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "PlanParseResult", class_Orm_Dbspec_Native_PlanParseResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_plan_default_value;
	ZVAL_UNDEF(&property_plan_default_value);
	zend_string *property_plan_name = zend_string_init("plan", sizeof("plan") - 1, 1);
	zend_string *property_plan_class_Orm_Dbspec_Native_Plan = zend_string_init("Orm\\Dbspec\\\116ative\\Plan", sizeof("Orm\\Dbspec\\\116ative\\Plan")-1, 1);
	zend_declare_typed_property(class_entry, property_plan_name, &property_plan_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_plan_class_Orm_Dbspec_Native_Plan, 0, MAY_BE_NULL));
	zend_string_release(property_plan_name);

	zval property_diagnostics_default_value;
	ZVAL_UNDEF(&property_diagnostics_default_value);
	zend_string *property_diagnostics_name = zend_string_init("diagnostics", sizeof("diagnostics") - 1, 1);
	zend_declare_typed_property(class_entry, property_diagnostics_name, &property_diagnostics_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_diagnostics_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_PlanStepsResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "PlanStepsResult", class_Orm_Dbspec_Native_PlanStepsResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ChainResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ChainResult", class_Orm_Dbspec_Native_ChainResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_DiffResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "DiffResult", class_Orm_Dbspec_Native_DiffResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_ComparisonResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "ComparisonResult", class_Orm_Dbspec_Native_ComparisonResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_MermaidExportResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "MermaidExportResult", class_Orm_Dbspec_Native_MermaidExportResult_methods);
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

static zend_class_entry *register_class_Orm_Dbspec_Native_MermaidImportResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "MermaidImportResult", class_Orm_Dbspec_Native_MermaidImportResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Orm_Dbspec_Native_Document = zend_string_init("Orm\\Dbspec\\\116ative\\Document", sizeof("Orm\\Dbspec\\\116ative\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Orm_Dbspec_Native_Document, 0, MAY_BE_NULL));
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

static zend_class_entry *register_class_Orm_Dbspec_Native_IntrospectResult(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "IntrospectResult", class_Orm_Dbspec_Native_IntrospectResult_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL|ZEND_ACC_READONLY_CLASS);

	zval property_document_default_value;
	ZVAL_UNDEF(&property_document_default_value);
	zend_string *property_document_name = zend_string_init("document", sizeof("document") - 1, 1);
	zend_string *property_document_class_Orm_Dbspec_Native_Document = zend_string_init("Orm\\Dbspec\\\116ative\\Document", sizeof("Orm\\Dbspec\\\116ative\\Document")-1, 1);
	zend_declare_typed_property(class_entry, property_document_name, &property_document_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_CLASS(property_document_class_Orm_Dbspec_Native_Document, 0, 0));
	zend_string_release(property_document_name);

	zval property_unsupported_default_value;
	ZVAL_UNDEF(&property_unsupported_default_value);
	zend_string *property_unsupported_name = zend_string_init("unsupported", sizeof("unsupported") - 1, 1);
	zend_declare_typed_property(class_entry, property_unsupported_name, &property_unsupported_default_value, ZEND_ACC_PUBLIC|ZEND_ACC_READONLY, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
	zend_string_release(property_unsupported_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_Dbspec(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "Dbspec", class_Orm_Dbspec_Native_Dbspec_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	zval const_SIGNATURE_value;
	zend_string *const_SIGNATURE_value_str = zend_string_init("dbspec ", strlen("dbspec "), 1);
	ZVAL_STR(&const_SIGNATURE_value, const_SIGNATURE_value_str);
	zend_string *const_SIGNATURE_name = zend_string_init_interned("SIGNATURE", sizeof("SIGNATURE") - 1, 1);
	zend_declare_typed_class_constant(class_entry, const_SIGNATURE_name, &const_SIGNATURE_value, ZEND_ACC_PUBLIC, NULL, (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_STRING));
	zend_string_release(const_SIGNATURE_name);

	return class_entry;
}

static zend_class_entry *register_class_Orm_Dbspec_Native_PlanApply(void)
{
	zend_class_entry ce, *class_entry;

	INIT_NS_CLASS_ENTRY(ce, "Orm\\Dbspec\\Native", "PlanApply", class_Orm_Dbspec_Native_PlanApply_methods);
	class_entry = zend_register_internal_class_with_flags(&ce, NULL, ZEND_ACC_FINAL);

	return class_entry;
}
