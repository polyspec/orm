/*
 * 확장 orm_dbspec의 module이다. stubs/orm_dbspec.stub.php에서 만든 arginfo로 Orm\Dbspec\Native의 class를
 * 등록하고, 그 생성자와 메서드, Dbspec의 정적 메서드를 PHP client(clients/php/src/Dbspec)와 같게 구현한다.
 */
#include "dbspec.h"
#include "php_ini.h"
#include "ext/standard/info.h"
#include "ext/spl/spl_exceptions.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "orm_dbspec_arginfo.h"

#define ORM_DBSPEC_VERSION "0.0.2"

/* 메서드 하나의 arena를 둔다. */
#define ENTER() dbs_arena arena_; dbs_arena *saved_; dbs_enter(&arena_, &saved_)
#define LEAVE() dbs_leave(&arena_, saved_)

static str zs(zend_string *z)
{
    return (str){ZSTR_VAL(z), ZSTR_LEN(z)};
}

/* 생성자가 property를 PHP 대입처럼 쓴다: type과 readonly 규칙을 엔진이 지킨다. */
static void init_prop(zval *self, const char *name, zval *v)
{
    /* PHP 생성자처럼 첫 실패에서 멈춘다. */
    if (EG(exception) != NULL) {
        return;
    }
    zend_update_property(Z_OBJCE_P(self), Z_OBJ_P(self), name, strlen(name), v);
}

static void init_str(zval *self, const char *name, zend_string *s)
{
    zval v;
    ZVAL_STR(&v, s);
    init_prop(self, name, &v);
}

static void init_long(zval *self, const char *name, zend_long n)
{
    zval v;
    ZVAL_LONG(&v, n);
    init_prop(self, name, &v);
}

static void init_bool(zval *self, const char *name, bool b)
{
    zval v;
    ZVAL_BOOL(&v, b);
    init_prop(self, name, &v);
}

static void init_str_or_null(zval *self, const char *name, zend_string *s)
{
    zval v;
    if (s == NULL) {
        ZVAL_NULL(&v);
    } else {
        ZVAL_STR(&v, s);
    }
    init_prop(self, name, &v);
}

/* 배열 인자는 zval로 받아 PHP 대입처럼 복사한다(불변 배열의 참조 수를 건드리지 않는다). */
static void init_array(zval *self, const char *name, zval *array)
{
    zval v;
    if (array == NULL) {
        ZVAL_EMPTY_ARRAY(&v);
        init_prop(self, name, &v);
    } else {
        init_prop(self, name, array);
    }
}

static void init_array_or_null(zval *self, const char *name, zval *array)
{
    zval v;
    if (array == NULL) {
        ZVAL_NULL(&v);
        init_prop(self, name, &v);
    } else {
        init_prop(self, name, array);
    }
}

static void init_obj_or_null(zval *self, const char *name, zend_object *o)
{
    zval v;
    if (o == NULL) {
        ZVAL_NULL(&v);
    } else {
        ZVAL_OBJ(&v, o);
    }
    init_prop(self, name, &v);
}

/* ------------------------------------------------------------ model classes */

ZEND_METHOD(Orm_Dbspec_Native_Diagnostic, __construct)
{
    zend_string *rule, *message;
    zend_long line, column;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_STR(rule)
        Z_PARAM_LONG(line)
        Z_PARAM_LONG(column)
        Z_PARAM_STR(message)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "rule", rule);
    init_long(ZEND_THIS, "line", line);
    init_long(ZEND_THIS, "column", column);
    init_str(ZEND_THIS, "message", message);
}

ZEND_METHOD(Orm_Dbspec_Native_Document, __construct)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
}

ZEND_METHOD(Orm_Dbspec_Native_UseLine, __construct)
{
    zend_string *document;
    zval *tables, *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(document)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "document", document);
    init_array(ZEND_THIS, "tables", tables);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_Table, __construct)
{
    zend_string *name;
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_STR(name)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_Column, __construct)
{
    zend_string *name, *def;
    zend_object *type;
    bool nullable, identity;
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(5, 6)
        Z_PARAM_STR(name)
        Z_PARAM_OBJ_OF_CLASS(type, dbs_ce_ColumnType)
        Z_PARAM_BOOL(nullable)
        Z_PARAM_BOOL(identity)
        Z_PARAM_STR_OR_NULL(def)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_obj_or_null(ZEND_THIS, "type", type);
    init_bool(ZEND_THIS, "nullable", nullable);
    init_bool(ZEND_THIS, "identity", identity);
    init_str_or_null(ZEND_THIS, "default", def);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_ColumnType, __construct)
{
    zend_string *name;
    zval *parameters = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_STR(name)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(parameters)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_array(ZEND_THIS, "parameters", parameters);
}

/* implode(',', $parameters)처럼 값을 문자열로 쓴다. */
ZEND_METHOD(Orm_Dbspec_Native_ColumnType, text)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *name = obj_get(ZEND_THIS, "name"), *params = obj_get(ZEND_THIS, "parameters");
    if (name == NULL || params == NULL) {
        RETURN_THROWS();
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(params)) == 0) {
        RETURN_COPY(name);
    }
    smart_str b = {0};
    smart_str_append(&b, Z_STR_P(name));
    smart_str_appendc(&b, '(');
    bool first = true;
    zval *p;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(params), p) {
        if (!first) {
            smart_str_appendc(&b, ',');
        }
        first = false;
        zend_string *s = zval_try_get_string(p);
        if (s == NULL) {
            smart_str_free(&b);
            RETURN_THROWS();
        }
        smart_str_append(&b, s);
        zend_string_release(s);
    } ZEND_HASH_FOREACH_END();
    smart_str_appendc(&b, ')');
    RETURN_STR(smart_str_extract(&b));
}

ZEND_METHOD(Orm_Dbspec_Native_ColumnType, isInteger)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *name = obj_get(ZEND_THIS, "name");
    if (name == NULL) {
        RETURN_THROWS();
    }
    str n = zs(Z_STR_P(name));
    RETURN_BOOL(str_eqc(n, "i16") || str_eqc(n, "i32") || str_eqc(n, "i64"));
}

ZEND_METHOD(Orm_Dbspec_Native_PrimaryKey, __construct)
{
    zval *columns, *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_ARRAY(columns)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_array(ZEND_THIS, "columns", columns);
    init_array(ZEND_THIS, "comments", comments);
}

/* UniqueKey, Index, Check는 (string, array|string, array = []) 모양이다. */
ZEND_METHOD(Orm_Dbspec_Native_UniqueKey, __construct)
{
    zend_string *name;
    zval *columns, *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(name)
        Z_PARAM_ARRAY(columns)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_array(ZEND_THIS, "columns", columns);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_Index, __construct)
{
    zend_string *name;
    zval *columns, *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(name)
        Z_PARAM_ARRAY(columns)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_array(ZEND_THIS, "columns", columns);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_IndexColumn, __construct)
{
    zend_string *name;
    bool descending;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(name)
        Z_PARAM_BOOL(descending)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_bool(ZEND_THIS, "descending", descending);
}

ZEND_METHOD(Orm_Dbspec_Native_ForeignKey, __construct)
{
    zend_string *name, *table, *on_delete, *on_update;
    zval *columns, *refs, *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(6, 7)
        Z_PARAM_STR(name)
        Z_PARAM_ARRAY(columns)
        Z_PARAM_STR(table)
        Z_PARAM_ARRAY(refs)
        Z_PARAM_STR(on_delete)
        Z_PARAM_STR(on_update)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_array(ZEND_THIS, "columns", columns);
    init_str(ZEND_THIS, "table", table);
    init_array(ZEND_THIS, "referencedColumns", refs);
    init_str(ZEND_THIS, "onDelete", on_delete);
    init_str(ZEND_THIS, "onUpdate", on_update);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_ForeignKey, changesChildRows)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *d = obj_get(ZEND_THIS, "onDelete"), *u = obj_get(ZEND_THIS, "onUpdate");
    if (d == NULL || u == NULL) {
        RETURN_THROWS();
    }
    RETURN_BOOL(!zend_string_equals_literal(Z_STR_P(d), "restrict") || !zend_string_equals_literal(Z_STR_P(u), "restrict"));
}

ZEND_METHOD(Orm_Dbspec_Native_Check, __construct)
{
    zend_string *name, *expression;
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 3)
        Z_PARAM_STR(name)
        Z_PARAM_STR(expression)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_str(ZEND_THIS, "expression", expression);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_Settings, __construct)
{
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_Setting, __construct)
{
    zend_string *kind;
    zval *arguments, *comments = NULL, *exclude = NULL, *include = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 5)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(arguments)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
        Z_PARAM_ARRAY_OR_NULL(exclude)
        Z_PARAM_ARRAY_OR_NULL(include)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "kind", kind);
    init_array(ZEND_THIS, "arguments", arguments);
    init_array(ZEND_THIS, "comments", comments);
    init_array_or_null(ZEND_THIS, "exclude", exclude);
    init_array_or_null(ZEND_THIS, "include", include);
}

/* in_array($column, $list, true) */
static bool strict_in(zval *list, zend_string *column)
{
    zval *e;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(list), e) {
        ZVAL_DEREF(e);
        if (Z_TYPE_P(e) == IS_STRING && zend_string_equals(Z_STR_P(e), column)) {
            return true;
        }
    } ZEND_HASH_FOREACH_END();
    return false;
}

/* Setting::records의 C 구현이다. arguments[1]이 없으면 audit column이 없는 것이다. */
static bool setting_zrecords(zval *self, zend_string *column, bool *ok)
{
    zval *arguments = obj_get(self, "arguments"), *exclude = obj_get(self, "exclude"), *include = obj_get(self, "include");
    *ok = arguments != NULL && exclude != NULL && include != NULL;
    if (!*ok) {
        return false;
    }
    zval *audit = zend_hash_index_find(Z_ARRVAL_P(arguments), 1);
    if (audit != NULL) {
        ZVAL_DEREF(audit);
        if (Z_TYPE_P(audit) == IS_STRING && zend_string_equals(Z_STR_P(audit), column)) {
            return true;
        }
    }
    if (Z_TYPE_P(exclude) == IS_ARRAY) {
        return !strict_in(exclude, column);
    }
    if (Z_TYPE_P(include) == IS_ARRAY) {
        return strict_in(include, column);
    }
    return true;
}

ZEND_METHOD(Orm_Dbspec_Native_Setting, records)
{
    zend_string *column;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(column)
    ZEND_PARSE_PARAMETERS_END();
    bool ok;
    bool records = setting_zrecords(ZEND_THIS, column, &ok);
    if (!ok) {
        RETURN_THROWS();
    }
    RETURN_BOOL(records);
}

ZEND_METHOD(Orm_Dbspec_Native_Setting, excluded)
{
    zend_object *table;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJ_OF_CLASS(table, dbs_ce_Table)
    ZEND_PARSE_PARAMETERS_END();
    zval tz;
    ZVAL_OBJ(&tz, table);
    zval *columns = obj_get(&tz, "columns");
    if (columns == NULL) {
        RETURN_THROWS();
    }
    array_init(return_value);
    zval *c;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), c) {
        ZVAL_DEREF(c);
        if (Z_TYPE_P(c) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(c), dbs_ce_Column)) {
            zend_type_error("Orm\\Dbspec\\Native\\Table::$columns holds %s, not Orm\\Dbspec\\Native\\Column", zend_zval_value_name(c));
            RETURN_THROWS();
        }
        zval *name = obj_get(c, "name");
        if (name == NULL) {
            RETURN_THROWS();
        }
        bool ok;
        if (!setting_zrecords(ZEND_THIS, Z_STR_P(name), &ok)) {
            if (!ok) {
                RETURN_THROWS();
            }
            add_next_index_str(return_value, zend_string_copy(Z_STR_P(name)));
        }
    } ZEND_HASH_FOREACH_END();
}

ZEND_METHOD(Orm_Dbspec_Native_Setting, auditLine)
{
    zend_string *list;
    zval *columns;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(list)
        Z_PARAM_ARRAY_OR_NULL(columns)
    ZEND_PARSE_PARAMETERS_END();
    zval *arguments = obj_get(ZEND_THIS, "arguments");
    if (arguments == NULL) {
        RETURN_THROWS();
    }
    ENTER();
    strs args;
    if (!in_strs(arguments, &args, "Orm\\Dbspec\\Native\\Setting::$arguments")) {
        LEAVE();
        RETURN_THROWS();
    }
    while (args.n < 5) {
        PUSH(args, SL(""));
    }
    setting s = {0};
    s.args = args;
    strs names = {0};
    bool ok = true;
    if (columns != NULL) {
        ok = in_strs(columns, &names, "Orm\\Dbspec\\Native\\Setting::auditLine(): $columns");
    }
    if (ok) {
        str line = setting_audit_line(&s, ZSTR_VAL(list), columns == NULL ? NULL : &names);
        RETVAL_STR(str_zend(line));
    }
    LEAVE();
}

ZEND_METHOD(Orm_Dbspec_Native_Diagram, __construct)
{
    zend_string *name;
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_STR(name)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Orm_Dbspec_Native_Placement, __construct)
{
    zend_string *table;
    zend_long x, y;
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(3, 4)
        Z_PARAM_STR(table)
        Z_PARAM_LONG(x)
        Z_PARAM_LONG(y)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "table", table);
    init_long(ZEND_THIS, "x", x);
    init_long(ZEND_THIS, "y", y);
    init_array(ZEND_THIS, "comments", comments);
}

/* ------------------------------------------------------------- results */

/* 두 property의 결과 class: 비공개 생성자, valid(값)와 invalid(diagnostics). value는 빌린 값이다. */
static void result_valid(zval *return_value, zend_class_entry *ce, const char *first, zval *value)
{
    obj_new(return_value, ce);
    zval copy;
    ZVAL_COPY(&copy, value);
    obj_put(return_value, first, &copy);
    zval empty;
    ZVAL_EMPTY_ARRAY(&empty);
    obj_put(return_value, "diagnostics", &empty);
}

static void result_invalid(zval *return_value, zend_class_entry *ce, const char *first, zval *diagnostics, const char *what)
{
    if (zend_hash_num_elements(Z_ARRVAL_P(diagnostics)) == 0) {
        zend_throw_exception_ex(spl_ce_LogicException, 0, "An invalid %s result needs a diagnostic", what);
        return;
    }
    obj_new(return_value, ce);
    obj_put_null(return_value, first);
    zval list;
    ZVAL_COPY(&list, diagnostics);
    obj_put(return_value, "diagnostics", &list);
}

#define RESULT_CLASS(cls, first, ZPARAM, what) \
    ZEND_METHOD(Orm_Dbspec_Native_##cls, __construct) \
    { \
        zval *value, *diagnostics; \
        ZEND_PARSE_PARAMETERS_START(2, 2) \
            ZPARAM \
            Z_PARAM_ARRAY(diagnostics) \
        ZEND_PARSE_PARAMETERS_END(); \
        zval null_; \
        ZVAL_NULL(&null_); \
        init_prop(ZEND_THIS, first, value != NULL ? value : &null_); \
        init_prop(ZEND_THIS, "diagnostics", diagnostics); \
    } \
    ZEND_METHOD(Orm_Dbspec_Native_##cls, invalid) \
    { \
        zval *diagnostics; \
        ZEND_PARSE_PARAMETERS_START(1, 1) \
            Z_PARAM_ARRAY(diagnostics) \
        ZEND_PARSE_PARAMETERS_END(); \
        result_invalid(return_value, dbs_ce_##cls, first, diagnostics, what); \
    }

#define Z_PARAM_NULLABLE_OBJ(ce) Z_PARAM_OBJECT_OF_CLASS_OR_NULL(value, ce)
#define Z_PARAM_NULLABLE_ARRAY Z_PARAM_ARRAY_OR_NULL(value)

RESULT_CLASS(ParseResult, "document", Z_PARAM_NULLABLE_OBJ(dbs_ce_Document), "parse")
RESULT_CLASS(ManifestResult, "manifest", Z_PARAM_NULLABLE_OBJ(dbs_ce_Manifest), "manifest")
RESULT_CLASS(RenderResult, "statements", Z_PARAM_NULLABLE_ARRAY, "render")
RESULT_CLASS(PlanParseResult, "plan", Z_PARAM_NULLABLE_OBJ(dbs_ce_Plan), "plan parse")
RESULT_CLASS(PlanStepsResult, "steps", Z_PARAM_NULLABLE_ARRAY, "plan steps")
RESULT_CLASS(ChainResult, "plans", Z_PARAM_NULLABLE_ARRAY, "chain")
RESULT_CLASS(DiffResult, "changes", Z_PARAM_NULLABLE_ARRAY, "diff")
RESULT_CLASS(ComparisonResult, "differences", Z_PARAM_NULLABLE_ARRAY, "comparison")

ZEND_METHOD(Orm_Dbspec_Native_ReadResult, __construct)
{
    zend_string *text;
    zval *diagnostics;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR_OR_NULL(text)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    init_str_or_null(ZEND_THIS, "text", text);
    init_prop(ZEND_THIS, "diagnostics", diagnostics);
}

ZEND_METHOD(Orm_Dbspec_Native_ReadResult, valid)
{
    zend_string *text;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(text)
    ZEND_PARSE_PARAMETERS_END();
    zval v;
    ZVAL_STR(&v, text);
    result_valid(return_value, dbs_ce_ReadResult, "text", &v);
}

ZEND_METHOD(Orm_Dbspec_Native_ReadResult, invalid)
{
    zval *diagnostics;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    result_invalid(return_value, dbs_ce_ReadResult, "text", diagnostics, "read");
}

#define VALID_OBJ(cls, first, vce) \
    ZEND_METHOD(Orm_Dbspec_Native_##cls, valid) \
    { \
        zval *value; \
        ZEND_PARSE_PARAMETERS_START(1, 1) \
            Z_PARAM_OBJECT_OF_CLASS(value, vce) \
        ZEND_PARSE_PARAMETERS_END(); \
        result_valid(return_value, dbs_ce_##cls, first, value); \
    }

#define VALID_ARRAY(cls, first) \
    ZEND_METHOD(Orm_Dbspec_Native_##cls, valid) \
    { \
        zval *value; \
        ZEND_PARSE_PARAMETERS_START(1, 1) \
            Z_PARAM_ARRAY(value) \
        ZEND_PARSE_PARAMETERS_END(); \
        result_valid(return_value, dbs_ce_##cls, first, value); \
    }

VALID_OBJ(ParseResult, "document", dbs_ce_Document)
VALID_OBJ(ManifestResult, "manifest", dbs_ce_Manifest)
VALID_ARRAY(RenderResult, "statements")
VALID_OBJ(PlanParseResult, "plan", dbs_ce_Plan)
VALID_ARRAY(PlanStepsResult, "steps")
VALID_ARRAY(ChainResult, "plans")
VALID_ARRAY(DiffResult, "changes")
VALID_ARRAY(ComparisonResult, "differences")

ZEND_METHOD(Orm_Dbspec_Native_Manifest, __construct)
{
    zend_string *manifest_text, *schema_text, *manifest_hash, *schema_hash, *external_text = NULL;
    ZEND_PARSE_PARAMETERS_START(4, 5)
        Z_PARAM_STR(manifest_text)
        Z_PARAM_STR(schema_text)
        Z_PARAM_STR(manifest_hash)
        Z_PARAM_STR(schema_hash)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(external_text)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "manifestText", manifest_text);
    init_str(ZEND_THIS, "schemaText", schema_text);
    init_str(ZEND_THIS, "manifestHash", manifest_hash);
    init_str(ZEND_THIS, "schemaHash", schema_hash);
    init_str(ZEND_THIS, "externalText", external_text != NULL ? external_text : ZSTR_EMPTY_ALLOC());
}

ZEND_METHOD(Orm_Dbspec_Native_MermaidExportResult, __construct)
{
    zend_string *text;
    zval *dropped;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(text)
        Z_PARAM_ARRAY(dropped)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "text", text);
    init_array(ZEND_THIS, "dropped", dropped);
}

ZEND_METHOD(Orm_Dbspec_Native_MermaidImportResult, __construct)
{
    zend_object *document;
    zval *dropped, *diagnostics;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJ_OF_CLASS_OR_NULL(document, dbs_ce_Document)
        Z_PARAM_ARRAY(dropped)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    init_obj_or_null(ZEND_THIS, "document", document);
    init_array(ZEND_THIS, "dropped", dropped);
    init_array(ZEND_THIS, "diagnostics", diagnostics);
}

ZEND_METHOD(Orm_Dbspec_Native_MermaidImportResult, valid)
{
    zval *document;
    zval *dropped;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(document, dbs_ce_Document)
        Z_PARAM_ARRAY(dropped)
    ZEND_PARSE_PARAMETERS_END();
    obj_new(return_value, dbs_ce_MermaidImportResult);
    zval doc, list;
    ZVAL_COPY(&doc, document);
    obj_put(return_value, "document", &doc);
    ZVAL_COPY(&list, dropped);
    obj_put(return_value, "dropped", &list);
    zval empty;
    ZVAL_EMPTY_ARRAY(&empty);
    obj_put(return_value, "diagnostics", &empty);
}

ZEND_METHOD(Orm_Dbspec_Native_MermaidImportResult, invalid)
{
    zval *diagnostics;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    if (zend_hash_num_elements(Z_ARRVAL_P(diagnostics)) == 0) {
        zend_throw_exception(spl_ce_LogicException, "An invalid Mermaid import result needs a diagnostic", 0);
        RETURN_THROWS();
    }
    obj_new(return_value, dbs_ce_MermaidImportResult);
    obj_put_null(return_value, "document");
    zval empty, list;
    ZVAL_EMPTY_ARRAY(&empty);
    obj_put(return_value, "dropped", &empty);
    ZVAL_COPY(&list, diagnostics);
    obj_put(return_value, "diagnostics", &list);
}

ZEND_METHOD(Orm_Dbspec_Native_IntrospectResult, __construct)
{
    zend_object *document;
    zval *unsupported;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJ_OF_CLASS(document, dbs_ce_Document)
        Z_PARAM_ARRAY(unsupported)
    ZEND_PARSE_PARAMETERS_END();
    init_obj_or_null(ZEND_THIS, "document", document);
    init_array(ZEND_THIS, "unsupported", unsupported);
}

/* ------------------------------------------------------------ plan values */

ZEND_METHOD(Orm_Dbspec_Native_Plan, __construct)
{
    zend_string *name, *from, *to;
    zval *rename_tables, *rename_columns, *drop_tables, *drop_columns;
    zend_object *schema;
    ZEND_PARSE_PARAMETERS_START(8, 8)
        Z_PARAM_STR(name)
        Z_PARAM_STR_OR_NULL(from)
        Z_PARAM_ARRAY(rename_tables)
        Z_PARAM_ARRAY(rename_columns)
        Z_PARAM_ARRAY(drop_tables)
        Z_PARAM_ARRAY(drop_columns)
        Z_PARAM_OBJ_OF_CLASS(schema, dbs_ce_Document)
        Z_PARAM_STR(to)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_str_or_null(ZEND_THIS, "from", from);
    init_array(ZEND_THIS, "renameTables", rename_tables);
    init_array(ZEND_THIS, "renameColumns", rename_columns);
    init_array(ZEND_THIS, "dropTables", drop_tables);
    init_array(ZEND_THIS, "dropColumns", drop_columns);
    init_obj_or_null(ZEND_THIS, "schema", schema);
    init_str(ZEND_THIS, "to", to);
}

ZEND_METHOD(Orm_Dbspec_Native_PlanStep, __construct)
{
    zend_string *statement, *rollback, *irreversible, *restore = NULL, *rollback_restore = NULL;
    zend_object *effect, *restore_if = NULL;
    zval *null_checks = NULL;
    bool finalize = false;
    ZEND_PARSE_PARAMETERS_START(4, 9)
        Z_PARAM_STR(statement)
        Z_PARAM_STR(rollback)
        Z_PARAM_STR(irreversible)
        Z_PARAM_OBJ_OF_CLASS(effect, dbs_ce_Effect)
        Z_PARAM_OPTIONAL
        Z_PARAM_STR(restore)
        Z_PARAM_STR(rollback_restore)
        Z_PARAM_OBJ_OF_CLASS_OR_NULL(restore_if, dbs_ce_Effect)
        Z_PARAM_ARRAY(null_checks)
        Z_PARAM_BOOL(finalize)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "statement", statement);
    init_str(ZEND_THIS, "rollback", rollback);
    init_str(ZEND_THIS, "irreversible", irreversible);
    init_obj_or_null(ZEND_THIS, "effect", effect);
    init_str(ZEND_THIS, "restore", restore != NULL ? restore : ZSTR_EMPTY_ALLOC());
    init_str(ZEND_THIS, "rollbackRestore", rollback_restore != NULL ? rollback_restore : ZSTR_EMPTY_ALLOC());
    init_obj_or_null(ZEND_THIS, "restoreIf", restore_if);
    init_array(ZEND_THIS, "nullChecks", null_checks);
    init_bool(ZEND_THIS, "finalize", finalize);
}

ZEND_METHOD(Orm_Dbspec_Native_Effect, __construct)
{
    zend_string *kind, *table, *name;
    bool present;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_STR(kind)
        Z_PARAM_STR(table)
        Z_PARAM_STR(name)
        Z_PARAM_BOOL(present)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "kind", kind);
    init_str(ZEND_THIS, "table", table);
    init_str(ZEND_THIS, "name", name);
    init_bool(ZEND_THIS, "present", present);
}

ZEND_METHOD(Orm_Dbspec_Native_Effect, repeat)
{
    ZEND_PARSE_PARAMETERS_NONE();
    obj_new(return_value, dbs_ce_Effect);
    obj_put_str(return_value, "kind", SL("repeat"));
    obj_put_str(return_value, "table", SL(""));
    obj_put_str(return_value, "name", SL(""));
    obj_put_bool(return_value, "present", true);
}

ZEND_METHOD(Orm_Dbspec_Native_Effect, text)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *kind = obj_get(ZEND_THIS, "kind"), *table = obj_get(ZEND_THIS, "table"), *name = obj_get(ZEND_THIS, "name"),
         *present = obj_get(ZEND_THIS, "present");
    if (kind == NULL || table == NULL || name == NULL || present == NULL) {
        RETURN_THROWS();
    }
    if (zend_string_equals_literal(Z_STR_P(kind), "repeat")) {
        RETURN_STRING("repeat");
    }
    smart_str b = {0};
    smart_str_appends(&b, Z_TYPE_P(present) == IS_TRUE ? "present " : "absent ");
    smart_str_append(&b, Z_STR_P(kind));
    if (Z_STRLEN_P(table) > 0) {
        smart_str_appendc(&b, ' ');
        smart_str_append(&b, Z_STR_P(table));
    }
    if (Z_STRLEN_P(name) > 0) {
        smart_str_appendc(&b, ' ');
        smart_str_append(&b, Z_STR_P(name));
    }
    RETURN_STR(smart_str_extract(&b));
}

ZEND_METHOD(Orm_Dbspec_Native_NullCheck, __construct)
{
    zend_string *table, *column, *def;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(table)
        Z_PARAM_STR(column)
        Z_PARAM_STR_OR_NULL(def)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "table", table);
    init_str(ZEND_THIS, "column", column);
    init_str_or_null(ZEND_THIS, "default", def);
}

#define KIND_TABLE_NAME(cls) \
    ZEND_METHOD(Orm_Dbspec_Native_##cls, __construct) \
    { \
        zend_string *kind, *table, *name; \
        ZEND_PARSE_PARAMETERS_START(3, 3) \
            Z_PARAM_STR(kind) \
            Z_PARAM_STR(table) \
            Z_PARAM_STR(name) \
        ZEND_PARSE_PARAMETERS_END(); \
        init_str(ZEND_THIS, "kind", kind); \
        init_str(ZEND_THIS, "table", table); \
        init_str(ZEND_THIS, "name", name); \
    }

KIND_TABLE_NAME(Change)
KIND_TABLE_NAME(Difference)

ZEND_METHOD(Orm_Dbspec_Native_Unsupported, __construct)
{
    zend_string *kind, *table, *name, *reason;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_STR(kind)
        Z_PARAM_STR(table)
        Z_PARAM_STR(name)
        Z_PARAM_STR(reason)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "kind", kind);
    init_str(ZEND_THIS, "table", table);
    init_str(ZEND_THIS, "name", name);
    init_str(ZEND_THIS, "reason", reason);
}

ZEND_METHOD(Orm_Dbspec_Native_TableRename, __construct)
{
    zend_string *old, *new_;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(old)
        Z_PARAM_STR(new_)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "old", old);
    init_str(ZEND_THIS, "new", new_);
}

ZEND_METHOD(Orm_Dbspec_Native_ColumnRename, __construct)
{
    zend_string *table, *old, *new_;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(table)
        Z_PARAM_STR(old)
        Z_PARAM_STR(new_)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "table", table);
    init_str(ZEND_THIS, "old", old);
    init_str(ZEND_THIS, "new", new_);
}

ZEND_METHOD(Orm_Dbspec_Native_ColumnName, __construct)
{
    zend_string *table, *name;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(table)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "table", table);
    init_str(ZEND_THIS, "name", name);
}

ZEND_METHOD(Orm_Dbspec_Native_ApplyEvent, __construct)
{
    zend_string *kind, *plan, *statement;
    zend_long step, steps;
    ZEND_PARSE_PARAMETERS_START(5, 5)
        Z_PARAM_STR(kind)
        Z_PARAM_STR(plan)
        Z_PARAM_LONG(step)
        Z_PARAM_LONG(steps)
        Z_PARAM_STR(statement)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "kind", kind);
    init_str(ZEND_THIS, "plan", plan);
    init_long(ZEND_THIS, "step", step);
    init_long(ZEND_THIS, "steps", steps);
    init_str(ZEND_THIS, "statement", statement);
}

/* Exception::__construct($message, 0, $previous)처럼 message와 previous를 둔다. */
static void exception_init(zval *self, zend_string *message, zend_object *previous)
{
    zval m;
    ZVAL_STR(&m, message);
    zend_update_property_ex(zend_ce_exception, Z_OBJ_P(self), ZSTR_KNOWN(ZEND_STR_MESSAGE), &m);
    if (previous != NULL) {
        zval p;
        ZVAL_OBJ(&p, previous);
        zend_update_property_ex(zend_ce_exception, Z_OBJ_P(self), ZSTR_KNOWN(ZEND_STR_PREVIOUS), &p);
    }
}

ZEND_METHOD(Orm_Dbspec_Native_ApplyError, __construct)
{
    zend_string *code, *plan, *detail;
    zend_long step;
    zend_object *previous = NULL;
    ZEND_PARSE_PARAMETERS_START(4, 5)
        Z_PARAM_STR(code)
        Z_PARAM_STR(plan)
        Z_PARAM_LONG(step)
        Z_PARAM_STR(detail)
        Z_PARAM_OPTIONAL
        Z_PARAM_OBJ_OF_CLASS_OR_NULL(previous, zend_ce_throwable)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "code_", code);
    init_str(ZEND_THIS, "plan", plan);
    init_long(ZEND_THIS, "step", step);
    init_str(ZEND_THIS, "detail", detail);
    smart_str b = {0};
    smart_str_append(&b, code);
    if (ZSTR_LEN(plan) > 0) {
        smart_str_appendc(&b, ' ');
        smart_str_append(&b, plan);
    }
    if (zend_string_equals_literal(code, "failed") || zend_string_equals_literal(code, "interrupted")
        || (zend_string_equals_literal(code, "session") && ZSTR_LEN(plan) > 0)) {
        smart_str_appends(&b, " at step ");
        smart_str_append_long(&b, step);
    }
    if (ZSTR_LEN(detail) > 0) {
        smart_str_appends(&b, ": ");
        smart_str_append(&b, detail);
    }
    if (previous != NULL) {
        zval pz, rv;
        ZVAL_OBJ(&pz, previous);
        zend_call_method_with_0_params(previous, previous->ce, NULL, "getmessage", &rv);
        if (EG(exception) != NULL) {
            smart_str_free(&b);
            RETURN_THROWS();
        }
        smart_str_appends(&b, ": ");
        if (Z_TYPE(rv) == IS_STRING) {
            smart_str_append(&b, Z_STR(rv));
        }
        zval_ptr_dtor(&rv);
    }
    zend_string *message = smart_str_extract(&b);
    exception_init(ZEND_THIS, message, previous);
    zend_string_release(message);
}

ZEND_METHOD(Orm_Dbspec_Native_ApplyCleanupError, __construct)
{
    zend_object *failure;
    zval *cleanup;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJ_OF_CLASS(failure, zend_ce_throwable)
        Z_PARAM_ARRAY(cleanup)
    ZEND_PARSE_PARAMETERS_END();
    init_prop(ZEND_THIS, "cleanup", cleanup);
    if (EG(exception) != NULL) {
        RETURN_THROWS();
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(cleanup)) == 0) {
        zend_throw_exception(spl_ce_InvalidArgumentException, "ApplyCleanupError needs at least one cleanup error", 0);
        RETURN_THROWS();
    }
    smart_str b = {0};
    zval rv;
    zend_call_method_with_0_params(failure, failure->ce, NULL, "getmessage", &rv);
    if (EG(exception) != NULL) {
        RETURN_THROWS();
    }
    if (Z_TYPE(rv) == IS_STRING) {
        smart_str_append(&b, Z_STR(rv));
    }
    zval_ptr_dtor(&rv);
    zval *e;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(cleanup), e) {
        ZVAL_DEREF(e);
        if (Z_TYPE_P(e) != IS_OBJECT || !instanceof_function(Z_OBJCE_P(e), zend_ce_throwable)) {
            smart_str_free(&b);
            zend_throw_error(NULL, "Call to a member function getMessage() on %s", zend_zval_type_name(e));
            RETURN_THROWS();
        }
        zend_call_method_with_0_params(Z_OBJ_P(e), Z_OBJCE_P(e), NULL, "getmessage", &rv);
        if (EG(exception) != NULL) {
            smart_str_free(&b);
            RETURN_THROWS();
        }
        smart_str_appends(&b, "; cleanup: ");
        if (Z_TYPE(rv) == IS_STRING) {
            smart_str_append(&b, Z_STR(rv));
        }
        zval_ptr_dtor(&rv);
    } ZEND_HASH_FOREACH_END();
    zend_string *message = smart_str_extract(&b);
    exception_init(ZEND_THIS, message, failure);
    zend_string_release(message);
}

/* ---------------------------------------------------------------- Dbspec */

ZEND_METHOD(Orm_Dbspec_Native_Dbspec, parse)
{
    zend_string *text;
    zval *documents;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(text)
        Z_PARAM_ARRAY(documents)
    ZEND_PARSE_PARAMETERS_END();
    zend_string *key;
    zval *source;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(documents), key, source) {
        ZVAL_DEREF(source);
        if (key == NULL || Z_TYPE_P(source) != IS_STRING) {
            zend_throw_exception(spl_ce_InvalidArgumentException, "The declared document set maps document names to texts", 0);
            RETURN_THROWS();
        }
    } ZEND_HASH_FOREACH_END();
    ENTER();
    smap set = {0};
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(documents), key, source) {
        ZVAL_DEREF(source);
        str *t = dbs_alloc(sizeof *t);
        *t = zs(Z_STR_P(source));
        smap_set(&set, zs(key), t);
    } ZEND_HASH_FOREACH_END();
    diags found = {0};
    document *d = dbs_parse(zs(text), &set, &found);
    if (d != NULL) {
        zval dz;
        out_document(d, &dz);
        zv_result(return_value, dbs_ce_ParseResult, "document", &dz, &found);
    } else {
        zv_result(return_value, dbs_ce_ParseResult, "document", NULL, &found);
    }
    LEAVE();
}

/* 첫 잘못된 UTF-8 byte의 줄과 칸(code point 단위)이다. 줄은 LF로 나눈다. */
static void invalid_utf8_position(str bytes, zend_long *line, zend_long *column)
{
    size_t valid = utf8_valid_prefix(bytes);
    *line = 1;
    *column = 1;
    for (size_t i = 0; i < valid; i++) {
        unsigned char b = (unsigned char)bytes.s[i];
        if ((b & 0xC0) == 0x80) {
            continue;
        }
        if (b == '\n') {
            (*line)++;
            *column = 1;
        } else {
            (*column)++;
        }
    }
}

static void read_bytes(zend_string *name, zend_string *bytes, zval *return_value)
{
    str b = zs(bytes);
    diags d = {0};
    if (!str_starts(b, "dbspec ")) {
        PUSH(d, mkdiag(SL("signature"), 1, 1, fmt("%S is not a dbspec document", zs(name))));
        zv_result(return_value, dbs_ce_ReadResult, "text", NULL, &d);
        return;
    }
    if (utf8_valid_prefix(b) < b.n) {
        zend_long line, column;
        invalid_utf8_position(b, &line, &column);
        PUSH(d, mkdiag(SL("encoding"), line, column, fmt("%S is not valid UTF-8", zs(name))));
        zv_result(return_value, dbs_ce_ReadResult, "text", NULL, &d);
        return;
    }
    zval text;
    ZVAL_STR_COPY(&text, bytes);
    zv_result(return_value, dbs_ce_ReadResult, "text", &text, &d);
}

ZEND_METHOD(Orm_Dbspec_Native_Dbspec, readBytes)
{
    zend_string *name, *bytes;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(name)
        Z_PARAM_STR(bytes)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    read_bytes(name, bytes, return_value);
    LEAVE();
}

/* PHP 함수를 이름으로 부른다. 실패(예외)면 false다. */
static bool call_function(const char *name, zval *ret, uint32_t argc, zval *argv)
{
    zval fn;
    ZVAL_STRING(&fn, name);
    zend_result r = call_user_function(NULL, NULL, &fn, ret, argc, argv);
    zval_ptr_dtor(&fn);
    return r == SUCCESS && EG(exception) == NULL;
}

/* PHP client처럼 is_dir과 경고를 막은 file_get_contents로 읽고, 실패 이유는 error_get_last의 message다. */
ZEND_METHOD(Orm_Dbspec_Native_Dbspec, readFile)
{
    zend_string *path;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(path)
    ZEND_PARSE_PARAMETERS_END();
    zval arg, dir;
    ZVAL_STR(&arg, path);
    if (!call_function("is_dir", &dir, 1, &arg)) {
        RETURN_THROWS();
    }
    if (Z_TYPE(dir) == IS_TRUE) {
        zend_throw_exception_ex(spl_ce_RuntimeException, 0, "cannot read %s: is a directory", ZSTR_VAL(path));
        RETURN_THROWS();
    }
    zval bytes;
    int reporting = EG(error_reporting);
    EG(error_reporting) &= E_ERROR | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR | E_PARSE;
    bool called = call_function("file_get_contents", &bytes, 1, &arg);
    EG(error_reporting) = reporting;
    if (!called) {
        RETURN_THROWS();
    }
    if (Z_TYPE(bytes) != IS_STRING) {
        zval last;
        zend_string *reason = NULL;
        if (call_function("error_get_last", &last, 0, NULL) && Z_TYPE(last) == IS_ARRAY) {
            zval *m = zend_hash_str_find(Z_ARRVAL(last), "message", sizeof("message") - 1);
            if (m != NULL && Z_TYPE_P(m) == IS_STRING) {
                reason = zend_string_copy(Z_STR_P(m));
            }
        }
        zval_ptr_dtor(&last);
        if (reason == NULL) {
            reason = zend_string_init("cannot be read", sizeof("cannot be read") - 1, 0);
        }
        zend_string *message = zend_strpprintf(0, "cannot read %s: %s", ZSTR_VAL(path), ZSTR_VAL(reason));
        zend_throw_exception(spl_ce_RuntimeException, ZSTR_VAL(message), 0);
        zend_string_release(message);
        zend_string_release(reason);
        zval_ptr_dtor(&bytes);
        RETURN_THROWS();
    }
    ENTER();
    read_bytes(path, Z_STR(bytes), return_value);
    LEAVE();
    zval_ptr_dtor(&bytes);
}

ZEND_METHOD(Orm_Dbspec_Native_Dbspec, emit)
{
    zval *zdoc;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(zdoc, dbs_ce_Document)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *d;
    if (in_document(zdoc, &d)) {
        RETVAL_STR(str_zend(dbs_emit(d, VIEW_CANONICAL)));
    }
    LEAVE();
}

ZEND_METHOD(Orm_Dbspec_Native_Dbspec, render)
{
    zval *documents;
    zend_string *dialect_name;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(documents)
        Z_PARAM_STR(dialect_name)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    dialect d;
    documentv set;
    if (dbs_dialect(zs(dialect_name), &d) && in_documents(documents, &set, "the document set")) {
        documentv ordered;
        diags found = {0};
        dbs_set_check(&set, &ordered, &found);
        if (found.n > 0) {
            zv_result(return_value, dbs_ce_RenderResult, "statements", NULL, &found);
        } else {
            renderedv out = {0};
            render_statements(&set, d, &out);
            if (!dbs_failed()) {
                strs statements = {0};
                for (size_t i = 0; i < out.n; i++) {
                    PUSH(statements, out.v[i].statement);
                }
                zval list;
                zv_strs(&list, &statements);
                zv_result(return_value, dbs_ce_RenderResult, "statements", &list, &found);
            }
        }
    }
    LEAVE();
}

ZEND_METHOD(Orm_Dbspec_Native_Dbspec, manifest)
{
    zval *documents;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(documents)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    documentv set;
    if (in_documents(documents, &set, "the document set")) {
        manifest m;
        diags found = {0};
        if (dbs_manifest(&set, &m, &found)) {
            zval mz;
            obj_new(&mz, dbs_ce_Manifest);
            obj_put_str(&mz, "manifestText", m.manifest_text);
            obj_put_str(&mz, "schemaText", m.schema_text);
            obj_put_str(&mz, "manifestHash", m.manifest_hash);
            obj_put_str(&mz, "schemaHash", m.schema_hash);
            obj_put_str(&mz, "externalText", m.external_text);
            zv_result(return_value, dbs_ce_ManifestResult, "manifest", &mz, &found);
        } else {
            zv_result(return_value, dbs_ce_ManifestResult, "manifest", NULL, &found);
        }
    }
    LEAVE();
}

/* ------------------------------------------------------------------ module */

/* gen_stub이 쓰지 못하는 배열 상수를 영속 불변 배열로 선언한다. */
static void array_constant(zend_class_entry *ce, const char *name, const char *const *keys, const zend_long *values, size_t n)
{
    HashTable *ht = pemalloc(sizeof(HashTable), 1);
    zend_hash_init(ht, (uint32_t)n, NULL, NULL, 1);
    for (size_t i = 0; i < n; i++) {
        zval v;
        if (values == NULL) {
            ZVAL_INTERNED_STR(&v, zend_string_init_interned(keys[i], strlen(keys[i]), 1));
            zend_hash_next_index_insert_new(ht, &v);
        } else {
            ZVAL_LONG(&v, values[i]);
            zend_hash_add_new(ht, zend_string_init_interned(keys[i], strlen(keys[i]), 1), &v);
        }
    }
    GC_ADD_FLAGS(ht, IS_ARRAY_IMMUTABLE);
    zval value;
    ZVAL_ARR(&value, ht);
    Z_TYPE_FLAGS(value) = 0;
    zend_string *cname = zend_string_init_interned(name, strlen(name), 1);
    zend_declare_typed_class_constant(ce, cname, &value, ZEND_ACC_PUBLIC, NULL, (zend_type)ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
}

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

static PHP_MINIT_FUNCTION(orm_dbspec)
{
    dbs_ce_Diagnostic = register_class_Orm_Dbspec_Native_Diagnostic();
    dbs_ce_Document = register_class_Orm_Dbspec_Native_Document();
    dbs_ce_UseLine = register_class_Orm_Dbspec_Native_UseLine();
    dbs_ce_Table = register_class_Orm_Dbspec_Native_Table();
    dbs_ce_Column = register_class_Orm_Dbspec_Native_Column();
    dbs_ce_ColumnType = register_class_Orm_Dbspec_Native_ColumnType();
    dbs_ce_PrimaryKey = register_class_Orm_Dbspec_Native_PrimaryKey();
    dbs_ce_UniqueKey = register_class_Orm_Dbspec_Native_UniqueKey();
    dbs_ce_Index = register_class_Orm_Dbspec_Native_Index();
    dbs_ce_IndexColumn = register_class_Orm_Dbspec_Native_IndexColumn();
    dbs_ce_ForeignKey = register_class_Orm_Dbspec_Native_ForeignKey();
    dbs_ce_Check = register_class_Orm_Dbspec_Native_Check();
    dbs_ce_Settings = register_class_Orm_Dbspec_Native_Settings();
    dbs_ce_Setting = register_class_Orm_Dbspec_Native_Setting();
    dbs_ce_Diagram = register_class_Orm_Dbspec_Native_Diagram();
    dbs_ce_Placement = register_class_Orm_Dbspec_Native_Placement();
    dbs_ce_ReadResult = register_class_Orm_Dbspec_Native_ReadResult();
    dbs_ce_ParseResult = register_class_Orm_Dbspec_Native_ParseResult();
    dbs_ce_Manifest = register_class_Orm_Dbspec_Native_Manifest();
    dbs_ce_ManifestResult = register_class_Orm_Dbspec_Native_ManifestResult();
    dbs_ce_RenderResult = register_class_Orm_Dbspec_Native_RenderResult();
    dbs_ce_Plan = register_class_Orm_Dbspec_Native_Plan();
    dbs_ce_PlanStep = register_class_Orm_Dbspec_Native_PlanStep();
    dbs_ce_Effect = register_class_Orm_Dbspec_Native_Effect();
    dbs_ce_NullCheck = register_class_Orm_Dbspec_Native_NullCheck();
    dbs_ce_Change = register_class_Orm_Dbspec_Native_Change();
    dbs_ce_Difference = register_class_Orm_Dbspec_Native_Difference();
    dbs_ce_Unsupported = register_class_Orm_Dbspec_Native_Unsupported();
    dbs_ce_TableRename = register_class_Orm_Dbspec_Native_TableRename();
    dbs_ce_ColumnRename = register_class_Orm_Dbspec_Native_ColumnRename();
    dbs_ce_ColumnName = register_class_Orm_Dbspec_Native_ColumnName();
    dbs_ce_ApplyEvent = register_class_Orm_Dbspec_Native_ApplyEvent();
    dbs_ce_ApplyError = register_class_Orm_Dbspec_Native_ApplyError(spl_ce_RuntimeException);
    dbs_ce_ApplyCleanupError = register_class_Orm_Dbspec_Native_ApplyCleanupError(spl_ce_RuntimeException);
    dbs_ce_PlanParseResult = register_class_Orm_Dbspec_Native_PlanParseResult();
    dbs_ce_PlanStepsResult = register_class_Orm_Dbspec_Native_PlanStepsResult();
    dbs_ce_ChainResult = register_class_Orm_Dbspec_Native_ChainResult();
    dbs_ce_DiffResult = register_class_Orm_Dbspec_Native_DiffResult();
    dbs_ce_ComparisonResult = register_class_Orm_Dbspec_Native_ComparisonResult();
    dbs_ce_MermaidExportResult = register_class_Orm_Dbspec_Native_MermaidExportResult();
    dbs_ce_MermaidImportResult = register_class_Orm_Dbspec_Native_MermaidImportResult();
    dbs_ce_IntrospectResult = register_class_Orm_Dbspec_Native_IntrospectResult();
    dbs_ce_Dbspec = register_class_Orm_Dbspec_Native_Dbspec();

    /* PHP의 readonly class는 동적 property를 받지 않는다. 내부 class는 그 flag를 따로 둔다. */
#define DBS_NO_DYNAMIC(n) if (dbs_ce_##n->ce_flags & ZEND_ACC_READONLY_CLASS) dbs_ce_##n->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    DBS_CLASSES(DBS_NO_DYNAMIC)
#undef DBS_NO_DYNAMIC

    static const char *const simple[] = {"i16", "i32", "i64", "bool", "f64", "text", "bytes", "uuid", "date"};
    static const char *const parameterized[] = {"decimal", "varchar", "time", "datetime"};
    static const zend_long arity[] = {2, 1, 1, 1};
    static const char *const actions[] = {"restrict", "cascade", "set_null"};
    static const char *const kinds[] = {"entity", "updated", "soft_delete", "select_explicit", "codec", "aes_version", "blind_index", "navigation", "immutable", "audit"};
    static const char *const stages[] = {"ordered_json", "aes", "hex", "gz", "base64", "serialize", "yaml", "ip"};
    array_constant(dbs_ce_ColumnType, "SIMPLE", simple, NULL, COUNT(simple));
    array_constant(dbs_ce_ColumnType, "PARAMETERIZED", parameterized, arity, COUNT(parameterized));
    array_constant(dbs_ce_ForeignKey, "ACTIONS", actions, NULL, COUNT(actions));
    array_constant(dbs_ce_Setting, "KINDS", kinds, NULL, COUNT(kinds));
    array_constant(dbs_ce_Setting, "CODEC_STAGES", stages, NULL, COUNT(stages));
    return SUCCESS;
}

static PHP_MINFO_FUNCTION(orm_dbspec)
{
    php_info_print_table_start();
    php_info_print_table_row(2, "orm_dbspec", "enabled");
    php_info_print_table_row(2, "version", ORM_DBSPEC_VERSION);
    php_info_print_table_end();
}

static const zend_module_dep orm_dbspec_deps[] = {
    ZEND_MOD_REQUIRED("spl")
    ZEND_MOD_REQUIRED("hash")
    ZEND_MOD_END
};

zend_module_entry orm_dbspec_module_entry = {
    STANDARD_MODULE_HEADER_EX,
    NULL,
    orm_dbspec_deps,
    "orm_dbspec",
    NULL,
    PHP_MINIT(orm_dbspec),
    NULL,
    NULL,
    NULL,
    PHP_MINFO(orm_dbspec),
    ORM_DBSPEC_VERSION,
    STANDARD_MODULE_PROPERTIES,
};

#ifdef COMPILE_DL_ORM_DBSPEC
#ifdef ZTS
ZEND_TSRMLS_CACHE_DEFINE()
#endif
ZEND_GET_MODULE(orm_dbspec)
#endif
