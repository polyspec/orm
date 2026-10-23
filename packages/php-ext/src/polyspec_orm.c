/*
 * Module of the polyspec_orm extension. It uses the arginfo generated from its one stub, src/polyspec_orm.stub.php, to
 * register the classes of Polyspec\Orm\Dbspec, and implements their constructors, methods, and Dbspec's static methods the same as the PHP client (packages/php/src/Dbspec).
 * The same arginfo registers Polyspec\Orm\Code, the error codes of docs/spec/errors.yaml, whose block of the stub orm-gen errors writes.
 */
#include "dbspec.h"
#include "ext/pdo/php_pdo_driver.h"
#include "php_ini.h"
#include "ext/standard/info.h"
#include "ext/json/php_json.h"
#include "ext/spl/spl_exceptions.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_closures.h"
#include "codec.h"
#include "validator.h"
#include "planner.h"
#include "collection.h"
#include "polyspec_orm_arginfo.h"
#include "model_types.h"
#include "model_native_methods.h"
#include "model_output.h"
#include "model_query.h"
#include "model_dsl.h"
#include "model_read.h"
#include "model_write.h"
#include "model_assembly.h"
#include "runtime_model.h"
#include "chain_native.h"
#include "registry_native.h"

/* Holds one method's arena. */
#define ENTER() dbs_arena arena_; dbs_arena *saved_; dbs_enter(&arena_, &saved_)
#define LEAVE() dbs_leave(&arena_, saved_)

static str zs(zend_string *z)
{
    return (str){ZSTR_VAL(z), ZSTR_LEN(z)};
}

/* The constructor writes properties like a PHP assignment: the engine enforces the type and readonly rules. */
static void init_prop(zval *self, const char *name, zval *v)
{
    /* Stops at the first failure, as a PHP constructor does. */
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

/* Array arguments are received as zval and copied like a PHP assignment (does not touch the refcount of immutable arrays). */
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Diagnostic, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Document, __construct)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_UseLine, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Table, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Column, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnType, __construct)
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

/* Writes the values as a string, like implode(',', $parameters). */
ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnType, text)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnType, isInteger)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *name = obj_get(ZEND_THIS, "name");
    if (name == NULL) {
        RETURN_THROWS();
    }
    str n = zs(Z_STR_P(name));
    RETURN_BOOL(str_eqc(n, "i16") || str_eqc(n, "i32") || str_eqc(n, "i64"));
}

ZEND_METHOD(Polyspec_Orm_Dbspec_PrimaryKey, __construct)
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

/* UniqueKey, Index, and Check have the shape (string, array|string, array = []). */
ZEND_METHOD(Polyspec_Orm_Dbspec_UniqueKey, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Index, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_IndexColumn, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ForeignKey, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ForeignKey, changesChildRows)
{
    ZEND_PARSE_PARAMETERS_NONE();
    zval *d = obj_get(ZEND_THIS, "onDelete"), *u = obj_get(ZEND_THIS, "onUpdate");
    if (d == NULL || u == NULL) {
        RETURN_THROWS();
    }
    RETURN_BOOL(!zend_string_equals_literal(Z_STR_P(d), "restrict") || !zend_string_equals_literal(Z_STR_P(u), "restrict"));
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Check, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Settings, __construct)
{
    zval *comments = NULL;
    ZEND_PARSE_PARAMETERS_START(0, 1)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
    ZEND_PARSE_PARAMETERS_END();
    init_array(ZEND_THIS, "comments", comments);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, __construct)
{
    zend_string *kind, *form = NULL;
    zval *arguments, *comments = NULL, *exclude = NULL, *include = NULL, *requires = NULL;
    ZEND_PARSE_PARAMETERS_START(2, 7)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(arguments)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(comments)
        Z_PARAM_ARRAY_OR_NULL(exclude)
        Z_PARAM_ARRAY_OR_NULL(include)
        Z_PARAM_STR_OR_NULL(form)
        Z_PARAM_ARRAY_OR_NULL(requires)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "kind", kind);
    init_array(ZEND_THIS, "arguments", arguments);
    init_array(ZEND_THIS, "comments", comments);
    init_array_or_null(ZEND_THIS, "exclude", exclude);
    init_array_or_null(ZEND_THIS, "include", include);
    init_str_or_null(ZEND_THIS, "form", form);
    init_array_or_null(ZEND_THIS, "requires", requires);
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

/* C implementation of Setting::records. If arguments[1] is missing, there is no audit column. */
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, records)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, excluded)
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
            zend_type_error("Polyspec\\Orm\\Dbspec\\Table::$columns holds %s, not Polyspec\\Orm\\Dbspec\\Column", zend_zval_value_name(c));
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Setting, auditLine)
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
    if (!in_strs(arguments, &args, "Polyspec\\Orm\\Dbspec\\Setting::$arguments")) {
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
        ok = in_strs(columns, &names, "Polyspec\\Orm\\Dbspec\\Setting::auditLine(): $columns");
    }
    if (ok) {
        str line = setting_audit_line(&s, ZSTR_VAL(list), columns == NULL ? NULL : &names);
        RETVAL_STR(str_zend(line));
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Diagram, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Placement, __construct)
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

/* Result class of the two properties: a private constructor, valid (value) and invalid (diagnostics). value is a borrowed value. */
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
    ZEND_METHOD(Polyspec_Orm_Dbspec_##cls, __construct) \
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
    ZEND_METHOD(Polyspec_Orm_Dbspec_##cls, invalid) \
    { \
        zval *diagnostics; \
        ZEND_PARSE_PARAMETERS_START(1, 1) \
            Z_PARAM_ARRAY(diagnostics) \
        ZEND_PARSE_PARAMETERS_END(); \
        result_invalid(return_value, dbs_ce_##cls, first, diagnostics, what); \
    }

#define Z_PARAM_NULLABLE_OBJ(ce) Z_PARAM_OBJECT_OF_CLASS_OR_NULL(value, ce)
#define Z_PARAM_NULLABLE_ARRAY Z_PARAM_ARRAY_OR_NULL(value)

/* ParseResult: the document, its positions and no diagnostics, or the diagnostics with no document and no positions.
 * The values it puts are owned: obj_put takes them, so a borrowed value is copied first. */
static void parse_result(zval *out, zval *document, zval *diagnostics, zval *positions)
{
    obj_new(out, dbs_ce_ParseResult);
    if (document == NULL) {
        obj_put_null(out, "document");
    } else {
        obj_put(out, "document", document);
    }
    obj_put(out, "diagnostics", diagnostics);
    if (positions == NULL) {
        obj_put_null(out, "positions");
    } else {
        obj_put(out, "positions", positions);
    }
}

ZEND_METHOD(Polyspec_Orm_Dbspec_ParseResult, __construct)
{
    zval *document, *diagnostics, *positions;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(document, dbs_ce_Document)
        Z_PARAM_ARRAY(diagnostics)
        Z_PARAM_ARRAY_OR_NULL(positions)
    ZEND_PARSE_PARAMETERS_END();
    zval null_;
    ZVAL_NULL(&null_);
    init_prop(ZEND_THIS, "document", document != NULL ? document : &null_);
    init_prop(ZEND_THIS, "diagnostics", diagnostics);
    init_prop(ZEND_THIS, "positions", positions != NULL ? positions : &null_);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_ParseResult, valid)
{
    zval *document, *positions;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(document, dbs_ce_Document)
        Z_PARAM_ARRAY(positions)
    ZEND_PARSE_PARAMETERS_END();
    zval doc_copy, pos_copy, empty;
    ZVAL_COPY(&doc_copy, document);
    ZVAL_COPY(&pos_copy, positions);
    ZVAL_EMPTY_ARRAY(&empty);
    parse_result(return_value, &doc_copy, &empty, &pos_copy);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_ParseResult, invalid)
{
    zval *diagnostics;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    if (zend_hash_num_elements(Z_ARRVAL_P(diagnostics)) == 0) {
        zend_throw_exception_ex(spl_ce_LogicException, 0, "An invalid parse result needs a diagnostic");
        return;
    }
    zval list;
    ZVAL_COPY(&list, diagnostics);
    parse_result(return_value, NULL, &list, NULL);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Position, __construct)
{
    zend_string *kind;
    zval *path;
    zend_long line, column;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(path)
        Z_PARAM_LONG(line)
        Z_PARAM_LONG(column)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "kind", kind);
    init_array(ZEND_THIS, "path", path);
    init_long(ZEND_THIS, "line", line);
    init_long(ZEND_THIS, "column", column);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Token, __construct)
{
    zend_long line, start, end;
    zend_string *cls;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_LONG(line)
        Z_PARAM_LONG(start)
        Z_PARAM_LONG(end)
        Z_PARAM_STR(cls)
    ZEND_PARSE_PARAMETERS_END();
    init_long(ZEND_THIS, "line", line);
    init_long(ZEND_THIS, "start", start);
    init_long(ZEND_THIS, "end", end);
    init_str(ZEND_THIS, "class", cls);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Analysis, __construct)
{
    zval *document, *positions, *diagnostics, *tokens;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(document, dbs_ce_Document)
        Z_PARAM_ARRAY_OR_NULL(positions)
        Z_PARAM_ARRAY(diagnostics)
        Z_PARAM_ARRAY(tokens)
    ZEND_PARSE_PARAMETERS_END();
    zval null_;
    ZVAL_NULL(&null_);
    init_prop(ZEND_THIS, "document", document != NULL ? document : &null_);
    init_prop(ZEND_THIS, "positions", positions != NULL ? positions : &null_);
    init_prop(ZEND_THIS, "diagnostics", diagnostics);
    init_prop(ZEND_THIS, "tokens", tokens);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_FormatResult, __construct)
{
    zend_string *text;
    zval *diagnostics;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR_OR_NULL(text)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    zval null_;
    ZVAL_NULL(&null_);
    if (text != NULL) {
        init_str(ZEND_THIS, "text", text);
    } else {
        init_prop(ZEND_THIS, "text", &null_);
    }
    init_prop(ZEND_THIS, "diagnostics", diagnostics);
}

/* Names (Names.php): the renderer names of a table, and the column whose renderer name is a given name. */
static bool names_bool_prop(zval *obj, const char *name)
{
    return zend_is_true(obj_get(obj, name));
}

/* The renderer names that a table writes: the type CHECK of each column that has one, then the triggers of immutable
 * and audit, each setting in order (Names::ofTable). */
static void names_of_table(zval *table, strs *names)
{
    str table_name = zs(Z_STR_P(obj_get(table, "name")));
    zval *columns = obj_get(table, "columns");
    zval *c;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), c) {
        ZVAL_DEREF(c);
        str column_name = zs(Z_STR_P(obj_get(c, "name")));
        str type_name = zs(Z_STR_P(obj_get(obj_get(c, "type"), "name")));
        if (!names_bool_prop(c, "identity") && !str_eqc(type_name, "text") && !str_eqc(type_name, "bytes")) {
            PUSH(*names, dbs_renderer_name(table_name, column_name));
        }
    } ZEND_HASH_FOREACH_END();
    zval *settings = obj_get(table, "settings");
    if (Z_TYPE_P(settings) != IS_OBJECT) {
        return;
    }
    zval *list = obj_get(settings, "settings");
    zval *s;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(list), s) {
        ZVAL_DEREF(s);
        str kind = zs(Z_STR_P(obj_get(s, "kind")));
        if (str_eqc(kind, "immutable")) {
            PUSH(*names, dbs_renderer_name(table_name, SL("immutable_update")));
            PUSH(*names, dbs_renderer_name(table_name, SL("immutable_delete")));
        } else if (str_eqc(kind, "audit")) {
            PUSH(*names, dbs_renderer_name(table_name, SL("audit_insert")));
            PUSH(*names, dbs_renderer_name(table_name, SL("audit_update")));
            PUSH(*names, dbs_renderer_name(table_name, SL("audit_delete")));
        }
    } ZEND_HASH_FOREACH_END();
}

/* One element of Names::column: 1 when its renderer name is the name (out gets it), 0 when not, -1 when it is not a
 * string (a TypeError, as strict types give the renderer). */
static int names_match(str table, str name, zval *e, zval *out)
{
    ZVAL_DEREF(e);
    if (Z_TYPE_P(e) != IS_STRING) {
        zend_type_error("Polyspec\\Orm\\Dbspec\\Names::column(): Argument #3 ($columns) must contain only strings, %s given", zend_zval_value_name(e));
        return -1;
    }
    if (!str_eq(dbs_renderer_name(table, zs(Z_STR_P(e))), name)) {
        return 0;
    }
    ZVAL_COPY(out, e);
    return 1;
}

/* Names::column: the first element whose renderer name is $name, or null; it stops at the first match, as the PHP loop
 * does, so a later element of an iterator is not read. */
static void names_column(zval *iterable, str table, str name, zval *out)
{
    ZVAL_NULL(out);
    if (Z_TYPE_P(iterable) == IS_ARRAY) {
        HashTable *ht = Z_ARRVAL_P(iterable);
        HashPosition pos;
        zval *e;
        for (zend_hash_internal_pointer_reset_ex(ht, &pos); (e = zend_hash_get_current_data_ex(ht, &pos)) != NULL; zend_hash_move_forward_ex(ht, &pos)) {
            if (names_match(table, name, e, out) != 0) {
                return;
            }
        }
        return;
    }
    zend_class_entry *ce = Z_OBJCE_P(iterable);
    zend_object_iterator *it = ce->get_iterator(ce, iterable, 0);
    if (it == NULL) {
        return;
    }
    it->funcs->rewind(it);
    while (EG(exception) == NULL && it->funcs->valid(it) == SUCCESS) {
        zval *e = it->funcs->get_current_data(it);
        if (e != NULL && names_match(table, name, e, out) != 0) {
            break;
        }
        it->funcs->move_forward(it);
    }
    zend_iterator_dtor(it);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Names, render)
{
    zend_string *table, *suffix;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(table)
        Z_PARAM_STR(suffix)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    RETVAL_STR(str_zend(dbs_renderer_name(zs(table), zs(suffix))));
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Names, ofTable)
{
    zval *table;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(table, dbs_ce_Table)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    strs names = {0};
    names_of_table(table, &names);
    zv_strs(return_value, &names);
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Names, column)
{
    zend_string *table, *name;
    zval *columns;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(table)
        Z_PARAM_STR(name)
        Z_PARAM_ITERABLE(columns)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    zval found;
    names_column(columns, zs(table), zs(name), &found);
    LEAVE();
    if (EG(exception) != NULL) {
        zval_ptr_dtor(&found);
        RETURN_THROWS();
    }
    RETVAL_COPY_VALUE(&found);
}

RESULT_CLASS(ManifestResult, "manifest", Z_PARAM_NULLABLE_OBJ(dbs_ce_Manifest), "manifest")
RESULT_CLASS(RenderResult, "statements", Z_PARAM_NULLABLE_ARRAY, "render")
RESULT_CLASS(PlanParseResult, "plan", Z_PARAM_NULLABLE_OBJ(dbs_ce_Plan), "plan parse")
RESULT_CLASS(PlanStepsResult, "steps", Z_PARAM_NULLABLE_ARRAY, "plan steps")
RESULT_CLASS(ChainResult, "plans", Z_PARAM_NULLABLE_ARRAY, "chain")
RESULT_CLASS(DiffResult, "changes", Z_PARAM_NULLABLE_ARRAY, "diff")
RESULT_CLASS(ComparisonResult, "differences", Z_PARAM_NULLABLE_ARRAY, "comparison")

ZEND_METHOD(Polyspec_Orm_Dbspec_ReadResult, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ReadResult, valid)
{
    zend_string *text;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(text)
    ZEND_PARSE_PARAMETERS_END();
    zval v;
    ZVAL_STR(&v, text);
    result_valid(return_value, dbs_ce_ReadResult, "text", &v);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_ReadResult, invalid)
{
    zval *diagnostics;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    result_invalid(return_value, dbs_ce_ReadResult, "text", diagnostics, "read");
}

#define VALID_OBJ(cls, first, vce) \
    ZEND_METHOD(Polyspec_Orm_Dbspec_##cls, valid) \
    { \
        zval *value; \
        ZEND_PARSE_PARAMETERS_START(1, 1) \
            Z_PARAM_OBJECT_OF_CLASS(value, vce) \
        ZEND_PARSE_PARAMETERS_END(); \
        result_valid(return_value, dbs_ce_##cls, first, value); \
    }

#define VALID_ARRAY(cls, first) \
    ZEND_METHOD(Polyspec_Orm_Dbspec_##cls, valid) \
    { \
        zval *value; \
        ZEND_PARSE_PARAMETERS_START(1, 1) \
            Z_PARAM_ARRAY(value) \
        ZEND_PARSE_PARAMETERS_END(); \
        result_valid(return_value, dbs_ce_##cls, first, value); \
    }

VALID_OBJ(ManifestResult, "manifest", dbs_ce_Manifest)
VALID_ARRAY(RenderResult, "statements")
VALID_OBJ(PlanParseResult, "plan", dbs_ce_Plan)
VALID_ARRAY(PlanStepsResult, "steps")
VALID_ARRAY(ChainResult, "plans")
VALID_ARRAY(DiffResult, "changes")
VALID_ARRAY(ComparisonResult, "differences")

ZEND_METHOD(Polyspec_Orm_Dbspec_Manifest, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidExportResult, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidImportResult, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidImportResult, valid)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_MermaidImportResult, invalid)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_IntrospectResult, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Plan, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_PlanStep, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Effect, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Effect, repeat)
{
    ZEND_PARSE_PARAMETERS_NONE();
    obj_new(return_value, dbs_ce_Effect);
    obj_put_str(return_value, "kind", SL("repeat"));
    obj_put_str(return_value, "table", SL(""));
    obj_put_str(return_value, "name", SL(""));
    obj_put_bool(return_value, "present", true);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Effect, text)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_NullCheck, __construct)
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
    ZEND_METHOD(Polyspec_Orm_Dbspec_##cls, __construct) \
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Unsupported, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_TableRename, __construct)
{
    zend_string *old, *new_;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(old)
        Z_PARAM_STR(new_)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "old", old);
    init_str(ZEND_THIS, "new", new_);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnRename, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ColumnName, __construct)
{
    zend_string *table, *name;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(table)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "table", table);
    init_str(ZEND_THIS, "name", name);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_ApplyEvent, __construct)
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

/* Sets message and previous, as in Exception::__construct($message, 0, $previous). */
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ApplyError, __construct)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_ApplyCleanupError, __construct)
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

/* The declared document set: every name maps to a text. Another entry throws, as parse does. */
static bool declared_set_valid(zval *documents)
{
    zend_string *key;
    zval *source;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(documents), key, source) {
        ZVAL_DEREF(source);
        if (key == NULL || Z_TYPE_P(source) != IS_STRING) {
            zend_throw_exception(spl_ce_InvalidArgumentException, "The declared document set maps document names to texts", 0);
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

static void declared_set_build(zval *documents, smap *set)
{
    zend_string *key;
    zval *source;
    ZEND_HASH_FOREACH_STR_KEY_VAL(Z_ARRVAL_P(documents), key, source) {
        ZVAL_DEREF(source);
        str *t = dbs_alloc(sizeof *t);
        *t = zs(Z_STR_P(source));
        smap_set(set, zs(key), t);
    } ZEND_HASH_FOREACH_END();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, analyze)
{
    zend_string *text;
    zval *documents;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(text)
        Z_PARAM_ARRAY(documents)
    ZEND_PARSE_PARAMETERS_END();
    if (!declared_set_valid(documents)) {
        RETURN_THROWS();
    }
    ENTER();
    smap set = {0};
    declared_set_build(documents, &set);
    diags found = {0};
    dposv decls = {0};
    dtokv tokens = {0};
    document *d = dbs_analyze(zs(text), &set, &found, &decls, &tokens);
    zval dl, tz;
    zv_diags(&dl, &found);
    zv_tokens(&tz, &tokens);
    obj_new(return_value, dbs_ce_Analysis);
    if (d != NULL) {
        zval dz, pz;
        out_document(d, &dz);
        zv_positions(&pz, &decls);
        obj_put(return_value, "document", &dz);
        obj_put(return_value, "positions", &pz);
    } else {
        obj_put_null(return_value, "document");
        obj_put_null(return_value, "positions");
    }
    obj_put(return_value, "diagnostics", &dl);
    obj_put(return_value, "tokens", &tz);
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, format)
{
    zend_string *text;
    zval *documents;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(text)
        Z_PARAM_ARRAY(documents)
    ZEND_PARSE_PARAMETERS_END();
    if (!declared_set_valid(documents)) {
        RETURN_THROWS();
    }
    ENTER();
    smap set = {0};
    declared_set_build(documents, &set);
    diags found = {0};
    dposv decls = {0};
    document *d = dbs_parse(zs(text), &set, &found, &decls);
    zval dl;
    zv_diags(&dl, &found);
    obj_new(return_value, dbs_ce_FormatResult);
    if (d != NULL) {
        obj_put_str(return_value, "text", dbs_emit(d, VIEW_CANONICAL));
    } else {
        obj_put_null(return_value, "text");
    }
    obj_put(return_value, "diagnostics", &dl);
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, parse)
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
    dposv decls = {0};
    document *d = dbs_parse(zs(text), &set, &found, &decls);
    zval dl;
    zv_diags(&dl, &found);
    if (d != NULL) {
        zval dz, pz;
        out_document(d, &dz);
        zv_positions(&pz, &decls);
        parse_result(return_value, &dz, &dl, &pz);
    } else {
        parse_result(return_value, NULL, &dl, NULL);
    }
    LEAVE();
}

/* Line and column (in code points) of the first invalid UTF-8 byte. Lines are split on LF. */
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

/* ------------------------------------------------------------------ sets */

ZEND_METHOD(Polyspec_Orm_Dbspec_SetFile, __construct)
{
    zend_string *path, *bytes;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(path)
        Z_PARAM_STR(bytes)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "path", path);
    init_str(ZEND_THIS, "bytes", bytes);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_SetError, __construct)
{
    zend_string *rule, *path, *message;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_STR(rule)
        Z_PARAM_STR(path)
        Z_PARAM_STR(message)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "rule", rule);
    init_str(ZEND_THIS, "path", path);
    init_str(ZEND_THIS, "message", message);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_SetResult, __construct)
{
    zval *documents, *external, *errors;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY_OR_NULL(documents)
        Z_PARAM_ARRAY_OR_NULL(external)
        Z_PARAM_ARRAY(errors)
    ZEND_PARSE_PARAMETERS_END();
    init_array_or_null(ZEND_THIS, "documents", documents);
    init_array_or_null(ZEND_THIS, "external", external);
    init_prop(ZEND_THIS, "errors", errors);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_SetResult, valid)
{
    zval *documents, *external;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(documents)
        Z_PARAM_ARRAY(external)
    ZEND_PARSE_PARAMETERS_END();
    obj_new(return_value, dbs_ce_SetResult);
    zval d, e, none;
    ZVAL_COPY(&d, documents);
    ZVAL_COPY(&e, external);
    ZVAL_EMPTY_ARRAY(&none);
    obj_put(return_value, "documents", &d);
    obj_put(return_value, "external", &e);
    obj_put(return_value, "errors", &none);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_SetResult, invalid)
{
    zval *errors;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(errors)
    ZEND_PARSE_PARAMETERS_END();
    if (zend_hash_num_elements(Z_ARRVAL_P(errors)) == 0) {
        zend_throw_exception(spl_ce_LogicException, "An invalid set result needs an error", 0);
        RETURN_THROWS();
    }
    obj_new(return_value, dbs_ce_SetResult);
    zval list;
    ZVAL_COPY(&list, errors);
    obj_put_null(return_value, "documents");
    obj_put_null(return_value, "external");
    obj_put(return_value, "errors", &list);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, readSet)
{
    zend_string *path;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(path)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    dbs_read_set(path, return_value);
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_SetDocument, __construct)
{
    zend_string *name;
    bool external;
    zval *document, *positions, *diagnostics;
    ZEND_PARSE_PARAMETERS_START(5, 5)
        Z_PARAM_STR(name)
        Z_PARAM_BOOL(external)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(document, dbs_ce_Document)
        Z_PARAM_ARRAY_OR_NULL(positions)
        Z_PARAM_ARRAY(diagnostics)
    ZEND_PARSE_PARAMETERS_END();
    init_str(ZEND_THIS, "name", name);
    init_bool(ZEND_THIS, "external", external);
    init_obj_or_null(ZEND_THIS, "document", document != NULL ? Z_OBJ_P(document) : NULL);
    init_array_or_null(ZEND_THIS, "positions", positions);
    init_array(ZEND_THIS, "diagnostics", diagnostics);
}

/* Dbspec::parseSet (docs/spec/dbspec.md "Parsing a set"), the twin of the PHP client's: each text's name is the name the
 * parser's header step reads; a text whose name an earlier text has is not parsed and carries `name.duplicate`;
 * every other text is parsed with the texts of all other named documents, an external one marked external. */
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, parseSet)
{
    zval *owned, *external;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY(owned)
        Z_PARAM_ARRAY(external)
    ZEND_PARSE_PARAMETERS_END();
    zval *lists[2] = {owned, external};
    zval *source;
    for (int l = 0; l < 2; l++) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(lists[l]), source) {
            ZVAL_DEREF(source);
            if (Z_TYPE_P(source) != IS_STRING) {
                zend_throw_exception(spl_ce_InvalidArgumentException, "A document set holds texts", 0);
                RETURN_THROWS();
            }
        } ZEND_HASH_FOREACH_END();
    }
    ENTER();
    size_t count = zend_hash_num_elements(Z_ARRVAL_P(owned)) + zend_hash_num_elements(Z_ARRVAL_P(external));
    str *texts = dbs_alloc(sizeof(str) * (count + 1));
    str *names = dbs_alloc(sizeof(str) * (count + 1));
    bool *externals = dbs_alloc(sizeof(bool) * (count + 1));
    bool *parsed = dbs_alloc(sizeof(bool) * (count + 1));
    size_t n = 0;
    for (int l = 0; l < 2; l++) {
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(lists[l]), source) {
            ZVAL_DEREF(source);
            texts[n] = zs(Z_STR_P(source));
            externals[n] = l == 1;
            n++;
        } ZEND_HASH_FOREACH_END();
    }
    smap named = {0};
    for (size_t i = 0; i < n; i++) {
        names[i] = dbs_header_name(texts[i]);
        if (names[i].n > 0) {
            if (smap_has(&named, names[i])) {
                continue;
            }
            smap_set(&named, names[i], &texts[i]);
        }
        parsed[i] = true;
    }
    array_init_size(return_value, (uint32_t)n);
    for (size_t i = 0; i < n; i++) {
        zval o;
        obj_new(&o, dbs_ce_SetDocument);
        obj_put_str(&o, "name", names[i]);
        obj_put_bool(&o, "external", externals[i]);
        if (!parsed[i]) {
            diags repeated = {0};
            diag d = {SL("name.duplicate"), 1, 10, fmt("document %S appears twice in the document set", names[i])};
            PUSH(repeated, d);
            zval dl;
            zv_diags(&dl, &repeated);
            obj_put_null(&o, "document");
            obj_put_null(&o, "positions");
            obj_put(&o, "diagnostics", &dl);
            add_next_index_zval(return_value, &o);
            continue;
        }
        smap others = {0};
        SMAP_EACH(&named, k) {
            if (!str_eq(named.e[k].key, names[i])) {
                smap_set(&others, named.e[k].key, named.e[k].val);
            }
        }
        diags found = {0};
        dposv decls = {0};
        document *d = dbs_parse(texts[i], &others, &found, &decls);
        zval dl;
        zv_diags(&dl, &found);
        if (d != NULL) {
            d->external = externals[i];
            zval dz, pz;
            out_document(d, &dz);
            zv_positions(&pz, &decls);
            obj_put(&o, "document", &dz);
            obj_put(&o, "positions", &pz);
        } else {
            obj_put_null(&o, "document");
            obj_put_null(&o, "positions");
        }
        obj_put(&o, "diagnostics", &dl);
        add_next_index_zval(return_value, &o);
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, readBytes)
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

/* Polyspec\Orm\Codec (packages/php-ext/src/codec.c). */
ZEND_METHOD(Polyspec_Orm_Codec, blindIndex)
{
    zval *v;
    zend_string *key;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ZVAL(v)
        Z_PARAM_STR(key)
    ZEND_PARSE_PARAMETERS_END();
    codec_blind_index(v, key, return_value);
}

ZEND_METHOD(Polyspec_Orm_Codec, decode)
{
    HashTable *styles;
    zval *raw;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(styles)
        Z_PARAM_ZVAL(raw)
    ZEND_PARSE_PARAMETERS_END();
    codec_decode(styles, raw, return_value);
}

ZEND_METHOD(Polyspec_Orm_Codec, encode)
{
    HashTable *styles;
    zval *styled;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(styles)
        Z_PARAM_OBJECT(styled)
    ZEND_PARSE_PARAMETERS_END();
    codec_encode(styles, styled, return_value);
}

ZEND_METHOD(Polyspec_Orm_Codec, isHostStyle)
{
    zend_string *style;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(style)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(codec_is_host_style(style));
}

ZEND_METHOD(Polyspec_Orm_Codec, hostEncode)
{
    zval *v;
    HashTable *styles;
    zend_string *aes_key;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ZVAL(v)
        Z_PARAM_ARRAY_HT(styles)
        Z_PARAM_STR(aes_key)
    ZEND_PARSE_PARAMETERS_END();
    codec_host_encode(v, styles, aes_key, return_value);
}

ZEND_METHOD(Polyspec_Orm_Codec, hostDecode)
{
    zval *raw;
    HashTable *styles;
    zend_string *aes_key;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ZVAL(raw)
        Z_PARAM_ARRAY_HT(styles)
        Z_PARAM_STR(aes_key)
    ZEND_PARSE_PARAMETERS_END();
    codec_host_decode(raw, styles, aes_key, return_value);
}

ZEND_METHOD(Polyspec_Orm_Codec, decodeRows)
{
    zval *rows_zv, *config;
    HashTable *cells;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_ARRAY_EX2(rows_zv, 0, 1, 1)
        Z_PARAM_ARRAY_HT(cells)
        Z_PARAM_OBJECT(config)
    ZEND_PARSE_PARAMETERS_END();
    codec_decode_rows(Z_ARRVAL_P(rows_zv), cells, config);
}

/* Polyspec\Orm\Validator (packages/php-ext/src/validator.c). */
ZEND_METHOD(Polyspec_Orm_Validator, __construct)
{
    zval *model;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT(model)
    ZEND_PARSE_PARAMETERS_END();
    validator_construct(ZEND_THIS, model);
}

ZEND_METHOD(Polyspec_Orm_Validator, opAllowed)
{
    HashTable *col;
    zend_string *op;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(col)
        Z_PARAM_STR(op)
    ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(validator_op_allowed(col, op));
}

ZEND_METHOD(Polyspec_Orm_Validator, validate)
{
    HashTable *r;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY_HT(r)
    ZEND_PARSE_PARAMETERS_END();
    validator_validate(ZEND_THIS, r);
}

ZEND_METHOD(Polyspec_Orm_Validator, restoreKey)
{
    HashTable *ent, *r;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(ent)
        Z_PARAM_ARRAY_HT(r)
    ZEND_PARSE_PARAMETERS_END();
    validator_restore_key(ent, r, return_value);
}

ZEND_METHOD(Polyspec_Orm_Validator, paramUses)
{
    HashTable *r;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY_HT(r)
    ZEND_PARSE_PARAMETERS_END();
    validator_param_uses(ZEND_THIS, r, return_value);
}

ZEND_METHOD(Polyspec_Orm_Validator, functionType)
{
    zend_string *name;
    HashTable *col;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(name)
        Z_PARAM_ARRAY_HT_OR_NULL(col)
    ZEND_PARSE_PARAMETERS_END();
    validator_function_type(name, col, return_value);
}

ZEND_METHOD(Polyspec_Orm_Validator, intervalType)
{
    zend_string *name;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    validator_interval_type(name, return_value);
}

ZEND_METHOD(Polyspec_Orm_Validator, conflictKey)
{
    HashTable *ent, *set;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_ARRAY_HT(ent)
        Z_PARAM_ARRAY_HT(set)
    ZEND_PARSE_PARAMETERS_END();
    validator_conflict_key(ent, set, return_value);
}

/* Polyspec\Orm\Planner (packages/php-ext/src/planner.c). */
ZEND_METHOD(Polyspec_Orm_Planner, __construct)
{
    zval *model, *dialect;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT(model)
        Z_PARAM_OBJECT(dialect)
    ZEND_PARSE_PARAMETERS_END();
    planner_construct(ZEND_THIS, model, dialect);
}

ZEND_METHOD(Polyspec_Orm_Planner, compile)
{
    HashTable *r;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY_HT(r)
    ZEND_PARSE_PARAMETERS_END();
    planner_compile(ZEND_THIS, r, return_value);
}

/* Calls a PHP function by name. On failure (exception), false. */
static bool call_function(const char *name, zval *ret, uint32_t argc, zval *argv)
{
    zval fn;
    ZVAL_STRING(&fn, name);
    zend_result r = call_user_function(NULL, NULL, &fn, ret, argc, argv);
    zval_ptr_dtor(&fn);
    return r == SUCCESS && EG(exception) == NULL;
}

/* Reads with file_get_contents with is_dir and warnings suppressed, as the PHP client does; the failure reason is the message of error_get_last. */
ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, readFile)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, emit)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, render)
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

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, manifest)
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

/* --------------------------------------------------------------- plans */

static void diags_result(zval *return_value, zend_class_entry *ce, const char *first, zval *value, const diags *d)
{
    zv_result(return_value, ce, first, value, d);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, externalDifferences)
{
    zval *live, *documents;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(live, dbs_ce_Document)
        Z_PARAM_ARRAY(documents)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *l;
    documentv set;
    if (in_document(live, &l) && in_documents(documents, &set, "the document set")) {
        strs out = external_differences(l, &set);
        zv_strs(return_value, &out);
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, parsePlan)
{
    zend_string *text;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_STR(text)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    diags d = {0};
    plan *p = plan_parse(zs(text), &d);
    if (p != NULL) {
        zval pz;
        out_plan(p, &pz);
        diags_result(return_value, dbs_ce_PlanParseResult, "plan", &pz, &d);
    } else {
        diags_result(return_value, dbs_ce_PlanParseResult, "plan", NULL, &d);
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, emitPlan)
{
    zval *zplan;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(zplan, dbs_ce_Plan)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    plan *p;
    if (in_plan(zplan, &p)) {
        RETVAL_STR(str_zend(plan_emit(p)));
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, chain)
{
    zval *plans;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_ARRAY(plans)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    planv in;
    if (in_plans(plans, &in, "the plans")) {
        planv out;
        diags d = {0};
        if (plan_chain(&in, &out, &d)) {
            zval list;
            if (out.n == 0) {
                ZVAL_EMPTY_ARRAY(&list);
            } else {
                array_init_size(&list, (uint32_t)out.n);
                for (size_t i = 0; i < out.n; i++) {
                    zval pz;
                    out_plan(out.v[i], &pz);
                    add_next_index_zval(&list, &pz);
                }
            }
            diags_result(return_value, dbs_ce_ChainResult, "plans", &list, &d);
        } else {
            diags_result(return_value, dbs_ce_ChainResult, "plans", NULL, &d);
        }
    }
    LEAVE();
}

/* A source that is null or a Document. */
static bool in_source(zval *source, document **out)
{
    *out = NULL;
    return source == NULL || in_document(source, out);
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, diff)
{
    zval *source, *zplan;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(source, dbs_ce_Document)
        Z_PARAM_OBJECT_OF_CLASS(zplan, dbs_ce_Plan)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *src;
    plan *p;
    if (in_source(source, &src) && in_plan(zplan, &p)) {
        changev changes;
        diags d = {0};
        if (plan_diff(src, p, &changes, &d)) {
            zval list;
            out_changes(&changes, dbs_ce_Change, &list);
            diags_result(return_value, dbs_ce_DiffResult, "changes", &list, &d);
        } else {
            diags_result(return_value, dbs_ce_DiffResult, "changes", NULL, &d);
        }
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, compareSchemas)
{
    zval *source, *target;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_OBJECT_OF_CLASS(source, dbs_ce_Document)
        Z_PARAM_OBJECT_OF_CLASS(target, dbs_ce_Document)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *s, *t;
    if (in_document(source, &s) && in_document(target, &t)) {
        changev differences;
        diags d = {0};
        if (schema_compare(s, t, &differences, &d)) {
            zval list;
            out_changes(&differences, dbs_ce_Difference, &list);
            diags_result(return_value, dbs_ce_ComparisonResult, "differences", &list, &d);
        } else {
            diags_result(return_value, dbs_ce_ComparisonResult, "differences", NULL, &d);
        }
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, installedDifferences)
{
    zval *live, *unsupported_list, *target;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS(live, dbs_ce_Document)
        Z_PARAM_ARRAY(unsupported_list)
        Z_PARAM_OBJECT_OF_CLASS(target, dbs_ce_Document)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *l, *t;
    unsupportedv u;
    if (in_document(live, &l) && in_unsupported(unsupported_list, &u, "the unsupported objects") && in_document(target, &t)) {
        strs out = installed_differences(l, &u, t);
        zv_strs(return_value, &out);
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, addTablesAndColumnsSteps)
{
    zval *live, *unsupported_list, *target;
    zend_string *dialect_name;
    ZEND_PARSE_PARAMETERS_START(4, 4)
        Z_PARAM_OBJECT_OF_CLASS(live, dbs_ce_Document)
        Z_PARAM_ARRAY(unsupported_list)
        Z_PARAM_OBJECT_OF_CLASS(target, dbs_ce_Document)
        Z_PARAM_STR(dialect_name)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *l, *t;
    unsupportedv u;
    if (in_document(live, &l) && in_unsupported(unsupported_list, &u, "the unsupported objects") && in_document(target, &t)) {
        strs added, differences;
        planstepv steps;
        add_tables_and_columns_steps(l, &u, t, zs(dialect_name), &added, &steps, &differences);
        if (!dbs_failed()) {
            zval a, s, d;
            zv_strs(&a, &added);
            out_steps(&steps, &s);
            zv_strs(&d, &differences);
            array_init_size(return_value, 3);
            add_next_index_zval(return_value, &a);
            add_next_index_zval(return_value, &s);
            add_next_index_zval(return_value, &d);
        }
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, planSteps)
{
    zval *source, *zplan;
    zend_string *dialect_name;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(source, dbs_ce_Document)
        Z_PARAM_OBJECT_OF_CLASS(zplan, dbs_ce_Plan)
        Z_PARAM_STR(dialect_name)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    dialect dl;
    document *src;
    plan *p;
    if (dbs_dialect(zs(dialect_name), &dl) && in_source(source, &src) && in_plan(zplan, &p)) {
        planstepv steps;
        diags d = {0};
        if (plan_steps(src, p, dl, &steps, &d)) {
            if (!dbs_failed()) {
                zval list;
                out_steps(&steps, &list);
                diags_result(return_value, dbs_ce_PlanStepsResult, "steps", &list, &d);
            }
        } else {
            diags_result(return_value, dbs_ce_PlanStepsResult, "steps", NULL, &d);
        }
    }
    LEAVE();
}

/* --------------------------------------------------------------- Mermaid */

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, exportMermaid)
{
    zval *zdoc;
    ZEND_PARSE_PARAMETERS_START(1, 1)
        Z_PARAM_OBJECT_OF_CLASS(zdoc, dbs_ce_Document)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    document *d;
    if (in_document(zdoc, &d)) {
        unsupportedv dropped;
        str text = mermaid_export(d, &dropped);
        zval list;
        out_unsupported(&dropped, &list);
        obj_new(return_value, dbs_ce_MermaidExportResult);
        obj_put_str(return_value, "text", text);
        obj_put(return_value, "dropped", &list);
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, importMermaid)
{
    zend_string *text, *name;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STR(text)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    unsupportedv dropped = {0};
    diags d = {0};
    document *doc = mermaid_import(zs(text), zs(name), &dropped, &d);
    if (!dbs_failed()) {
        obj_new(return_value, dbs_ce_MermaidImportResult);
        zval list, diagnostics;
        if (doc != NULL) {
            zval dz;
            out_document(doc, &dz);
            obj_put(return_value, "document", &dz);
            out_unsupported(&dropped, &list);
        } else {
            obj_put_null(return_value, "document");
            ZVAL_EMPTY_ARRAY(&list);
        }
        obj_put(return_value, "dropped", &list);
        zv_diags(&diagnostics, &d);
        obj_put(return_value, "diagnostics", &diagnostics);
    }
    LEAVE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_Dbspec, introspect)
{
    zval *connection;
    zend_string *dialect_name, *name;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS(connection, php_pdo_get_dbh_ce())
        Z_PARAM_STR(dialect_name)
        Z_PARAM_STR(name)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    dialect d;
    unsupportedv unsupported = {0};
    document *doc = dbs_dialect(zs(dialect_name), &d) ? dbs_introspect(connection, d, zs(name), &unsupported) : NULL;
    if (doc != NULL && !dbs_failed()) {
        obj_new(return_value, dbs_ce_IntrospectResult);
        zval dz, list;
        out_document(doc, &dz);
        obj_put(return_value, "document", &dz);
        out_unsupported(&unsupported, &list);
        obj_put(return_value, "unsupported", &list);
    }
    LEAVE();
}

/* Dbspec's apply commands, and those of PlanApply, which the PHP client's Dbspec calls and which take the same arguments. */
#define APPLY_METHOD(cls, op) \
ZEND_METHOD(Polyspec_Orm_Dbspec_##cls, op) \
{ \
    zval *connection, *plans, *now, *events = NULL; \
    zend_string *dialect_name; \
    ZEND_PARSE_PARAMETERS_START(5, 5) \
        Z_PARAM_OBJECT_OF_CLASS(connection, php_pdo_get_dbh_ce()) \
        Z_PARAM_STR(dialect_name) \
        Z_PARAM_ARRAY(plans) \
        Z_PARAM_OBJECT_OF_CLASS(now, zend_ce_closure) \
        Z_PARAM_OBJECT_OF_CLASS_OR_NULL(events, zend_ce_closure) \
    ZEND_PARSE_PARAMETERS_END(); \
    ENTER(); \
    dbs_apply(#op, connection, zs(dialect_name), plans, now, events); \
    LEAVE(); \
}

APPLY_METHOD(Dbspec, apply)
APPLY_METHOD(Dbspec, recover)
APPLY_METHOD(Dbspec, rollback)
APPLY_METHOD(Dbspec, finalize)
APPLY_METHOD(PlanApply, apply)
APPLY_METHOD(PlanApply, recover)
APPLY_METHOD(PlanApply, rollback)
APPLY_METHOD(PlanApply, finalize)

ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, __construct)
{
    ZEND_PARSE_PARAMETERS_NONE();
}

ZEND_METHOD(Polyspec_Orm_Dbspec_PlanApply, effectOn)
{
    zval *connection, *e;
    zend_string *dialect_name;
    ZEND_PARSE_PARAMETERS_START(3, 3)
        Z_PARAM_OBJECT_OF_CLASS(connection, php_pdo_get_dbh_ce())
        Z_PARAM_STR(dialect_name)
        Z_PARAM_OBJECT_OF_CLASS(e, dbs_ce_Effect)
    ZEND_PARSE_PARAMETERS_END();
    ENTER();
    effect in = {0};
    zval *kind = obj_get(e, "kind"), *table = obj_get(e, "table"), *name = obj_get(e, "name"), *present = obj_get(e, "present");
    bool held = false;
    if (kind != NULL && table != NULL && name != NULL && present != NULL) {
        in.kind = str_z(Z_STR_P(kind));
        in.table = str_z(Z_STR_P(table));
        in.name = str_z(Z_STR_P(name));
        in.present = Z_TYPE_P(present) == IS_TRUE;
        if (dbs_effect_on(connection, zs(dialect_name), &in, &held)) {
            RETVAL_BOOL(held);
        }
    }
    LEAVE();
}

/* PlanApply::EFFECT_QUERIES: persistent immutable array of effect-kind queries per dialect */
static void effect_queries_constant(void)
{
    HashTable *outer = pemalloc(sizeof(HashTable), 1);
    zend_hash_init(outer, 3, NULL, NULL, 1);
    HashTable *inner = NULL;
    const char *current = NULL;
    for (const dbs_effect_query *q = dbs_effect_queries; ; q++) {
        if (q->dialect == NULL || current == NULL || strcmp(q->dialect, current) != 0) {
            if (inner != NULL) {
                GC_ADD_FLAGS(inner, IS_ARRAY_IMMUTABLE);
                zval v;
                ZVAL_ARR(&v, inner);
                Z_TYPE_FLAGS(v) = 0;
                zend_hash_add_new(outer, zend_string_init_interned(current, strlen(current), 1), &v);
            }
            if (q->dialect == NULL) {
                break;
            }
            current = q->dialect;
            inner = pemalloc(sizeof(HashTable), 1);
            zend_hash_init(inner, 8, NULL, NULL, 1);
        }
        zval v;
        ZVAL_INTERNED_STR(&v, zend_string_init_interned(q->query, strlen(q->query), 1));
        zend_hash_add_new(inner, zend_string_init_interned(q->kind, strlen(q->kind), 1), &v);
    }
    GC_ADD_FLAGS(outer, IS_ARRAY_IMMUTABLE);
    zval value;
    ZVAL_ARR(&value, outer);
    Z_TYPE_FLAGS(value) = 0;
    zend_string *cname = zend_string_init_interned("EFFECT_QUERIES", sizeof("EFFECT_QUERIES") - 1, 1);
    zend_declare_typed_class_constant(dbs_ce_PlanApply, cname, &value, ZEND_ACC_PUBLIC, NULL, (zend_type)ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
}

/* ------------------------------------------------------------------ module */

/* Declares an array constant that gen_stub cannot write as a persistent immutable array. */
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

static void string_map_constant(zend_class_entry *ce, const char *name, const char *const *keys,
    const char *const *values, size_t n, uint32_t flags)
{
    HashTable *ht = pemalloc(sizeof(HashTable), 1);
    zend_hash_init(ht, (uint32_t)n, NULL, NULL, 1);
    for (size_t i = 0; i < n; i++) {
        zval value;
        ZVAL_INTERNED_STR(&value, zend_string_init_interned(values[i], strlen(values[i]), 1));
        zend_hash_add_new(ht, zend_string_init_interned(keys[i], strlen(keys[i]), 1), &value);
    }
    GC_ADD_FLAGS(ht, IS_ARRAY_IMMUTABLE);
    zval value;
    ZVAL_ARR(&value, ht);
    Z_TYPE_FLAGS(value) = 0;
    zend_string *constant_name = zend_string_init_interned(name, strlen(name), 1);
    zend_declare_typed_class_constant(ce, constant_name, &value, flags, NULL,
        (zend_type) ZEND_TYPE_INIT_MASK(MAY_BE_ARRAY));
}

static void model_where_default(zend_class_entry *ce)
{
    uint32_t index = (uint32_t)ce->default_properties_count;
    for (uint32_t i = 0; i < (uint32_t)ce->default_properties_count; i++) {
        zend_property_info *info = ce->properties_info_table[i];
        const char *class_name, *property_name;
        if (info != NULL && info->ce == ce &&
            zend_unmangle_property_name(info->name, &class_name, &property_name) == SUCCESS &&
            strcmp(property_name, "where") == 0) {
            index = i;
            break;
        }
    }
    if (index == (uint32_t)ce->default_properties_count) {
        zend_error(E_CORE_ERROR, "Polyspec\\Orm\\Model::$where property metadata is missing");
        return;
    }
    if (ce->default_properties_table == NULL) {
        zend_error(E_CORE_ERROR, "Polyspec\\Orm\\Model default property table is missing");
        return;
    }
    HashTable *items = pemalloc(sizeof(HashTable), 1);
    zend_hash_init(items, 0, NULL, NULL, 1);
    GC_ADD_FLAGS(items, IS_ARRAY_IMMUTABLE);
    zval items_value;
    ZVAL_ARR(&items_value, items);
    Z_TYPE_FLAGS(items_value) = 0;

    HashTable *where = pemalloc(sizeof(HashTable), 1);
    zend_hash_init(where, 2, NULL, NULL, 1);
    zend_hash_add_new(where, zend_string_init_interned("items", sizeof("items") - 1, 1), &items_value);
    zval pending;
    ZVAL_EMPTY_STRING(&pending);
    zend_hash_add_new(where, zend_string_init_interned("pending", sizeof("pending") - 1, 1), &pending);
    GC_ADD_FLAGS(where, IS_ARRAY_IMMUTABLE);
    ZVAL_ARR(&ce->default_properties_table[index], where);
    Z_TYPE_FLAGS(ce->default_properties_table[index]) = 0;
}

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

static PHP_MINIT_FUNCTION(polyspec_orm)
{
    register_class_Polyspec_Orm_Code();
    register_class_Polyspec_Orm_Codec();
    register_class_Polyspec_Orm_Validator();
    register_class_Polyspec_Orm_Planner();
    register_class_Polyspec_Orm_StatementEvent();
    collection_init(
        register_class_Polyspec_Orm_Collection(zend_ce_aggregate, zend_ce_countable, php_json_serializable_ce),
        register_class_Polyspec_Orm_CollectionIterator(zend_ce_iterator),
        register_class_Polyspec_Orm_CollectionDeleteCallback()
    );
    polyspec_request_ce = register_class_Polyspec_Orm_Request();
    polyspec_styled_value_ce = register_class_Polyspec_Orm_StyledValue(php_json_serializable_ce);
    polyspec_page_ce = register_class_Polyspec_Orm_Page();
    polyspec_func_ce = register_class_Polyspec_Orm_Func();
    polyspec_pending_time_ce = register_class_Polyspec_Orm_PendingTime();
    zend_class_entry *runtime_model_ce = register_class_Polyspec_Orm_RuntimeModel();
    static const char *const styled_stages[] = {"ordered_json", "serialize", "yaml", "gz", "base64"};
    static const char *const host_stages[] = {"aes", "hex", "ip"};
    array_constant(runtime_model_ce, "STYLED_STAGES", styled_stages, NULL, COUNT(styled_stages));
    array_constant(runtime_model_ce, "HOST_STAGES", host_stages, NULL, COUNT(host_stages));
    polyspec_runtime_model_register(runtime_model_ce);
    zend_class_entry *registry_ce = register_class_Polyspec_Orm_Registry();
    zend_class_entry *schema_ce = register_class_Polyspec_Orm_Schema();
    polyspec_registry_schema_register(registry_ce, schema_ce);
    zend_class_entry *model_metadata_ce = register_class_Polyspec_Orm_ModelMetadata();
    zend_class_entry *model_ce = register_class_Polyspec_Orm_Model(php_json_serializable_ce, model_metadata_ce);
    model_where_default(model_ce);
    model_native_init(model_ce);
    zend_class_entry *chain_ce = register_class_Polyspec_Orm_Chain();
    static const char *const leading_keys[] = {"Ne", "Eq", "Gt", "Lt", "Ge", "Le", "Lk", "Lb", "Between"};
    static const char *const leading_values[] = {"ne", "", "gt", "lt", "ge", "le", "lk", "lb", "between"};
    static const char *const compare_keys[] = {"Eq", "Ne", "Gt", "Lt", "Ge", "Le"};
    static const char *const compare_values[] = {"", "ne", "gt", "lt", "ge", "le"};
    static const char *const engine_keys[] = {"", "ne", "gt", "lt", "ge", "le", "lk", "lb", "between"};
    static const char *const engine_values[] = {"eq", "not_eq", "gt", "lt", "gte", "lte", "contains", "contains_binary", "between"};
    string_map_constant(chain_ce, "LEADING", leading_keys, leading_values, COUNT(leading_keys), ZEND_ACC_PRIVATE);
    string_map_constant(chain_ce, "COMPARE", compare_keys, compare_values, COUNT(compare_keys), ZEND_ACC_PRIVATE);
    string_map_constant(chain_ce, "ENGINE_OP", engine_keys, engine_values, COUNT(engine_keys), ZEND_ACC_PUBLIC);
    polyspec_chain_register(chain_ce);
    static const char *const operator_keys[] = {"", "ne", "gt", "lt", "ge", "le", "lk", "lb"};
    static const char *const operator_values[] = {"eq", "not_eq", "gt", "lt", "gte", "lte", "contains", "contains_binary"};
    string_map_constant(model_ce, "OPERATORS", operator_keys, operator_values, COUNT(operator_keys), ZEND_ACC_PRIVATE);
    zend_class_entry *creates_ce = register_class_Polyspec_Orm_ModelCreatesCallback();
    zend_class_entry *restore_ce = register_class_Polyspec_Orm_ModelRestoreHook();
    zend_class_entry *restore_or_create_ce = register_class_Polyspec_Orm_ModelRestoreOrCreateCallback();
    zend_class_entry *delete_ce = register_class_Polyspec_Orm_ModelDeleteCallback();
    model_write_init(creates_ce, restore_ce, restore_or_create_ce, delete_ce);
    zend_class_entry *frame_ce = register_class_Polyspec_Orm_Frame();
    zend_class_entry *assembly_ce = register_class_Polyspec_Orm_Assembly();
    zend_class_entry *group_row_ce = register_class_Polyspec_Orm_GroupRow(php_json_serializable_ce);
    zend_class_entry *group_rows_ce = register_class_Polyspec_Orm_GroupRows(zend_ce_countable, zend_ce_aggregate, php_json_serializable_ce);
    zend_class_entry *group_rows_iterator_ce = register_class_Polyspec_Orm_GroupRowsIterator(zend_ce_iterator);
    polyspec_model_assembly_register(frame_ce, assembly_ce, group_row_ce, group_rows_ce, group_rows_iterator_ce);
    polyspec_styled_value_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    polyspec_page_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    polyspec_func_ce->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    /* Db::DRIVERS, the array constant gen_stub cannot write (db.c implements the class). */
    static const char *const drivers[] = {"mysql", "postgres", "sqlite"};
    array_constant(register_class_Polyspec_Orm_Db(), "DRIVERS", drivers, NULL, COUNT(drivers));
    dbs_ce_Diagnostic = register_class_Polyspec_Orm_Dbspec_Diagnostic();
    dbs_ce_Document = register_class_Polyspec_Orm_Dbspec_Document();
    dbs_ce_UseLine = register_class_Polyspec_Orm_Dbspec_UseLine();
    dbs_ce_Table = register_class_Polyspec_Orm_Dbspec_Table();
    dbs_ce_Column = register_class_Polyspec_Orm_Dbspec_Column();
    dbs_ce_ColumnType = register_class_Polyspec_Orm_Dbspec_ColumnType();
    dbs_ce_PrimaryKey = register_class_Polyspec_Orm_Dbspec_PrimaryKey();
    dbs_ce_UniqueKey = register_class_Polyspec_Orm_Dbspec_UniqueKey();
    dbs_ce_Index = register_class_Polyspec_Orm_Dbspec_Index();
    dbs_ce_IndexColumn = register_class_Polyspec_Orm_Dbspec_IndexColumn();
    dbs_ce_ForeignKey = register_class_Polyspec_Orm_Dbspec_ForeignKey();
    dbs_ce_Check = register_class_Polyspec_Orm_Dbspec_Check();
    dbs_ce_Settings = register_class_Polyspec_Orm_Dbspec_Settings();
    dbs_ce_Setting = register_class_Polyspec_Orm_Dbspec_Setting();
    dbs_ce_Diagram = register_class_Polyspec_Orm_Dbspec_Diagram();
    dbs_ce_Placement = register_class_Polyspec_Orm_Dbspec_Placement();
    dbs_ce_Position = register_class_Polyspec_Orm_Dbspec_Position();
    dbs_ce_ReadResult = register_class_Polyspec_Orm_Dbspec_ReadResult();
    dbs_ce_ParseResult = register_class_Polyspec_Orm_Dbspec_ParseResult();
    dbs_ce_Analysis = register_class_Polyspec_Orm_Dbspec_Analysis();
    dbs_ce_Token = register_class_Polyspec_Orm_Dbspec_Token();
    dbs_ce_Names = register_class_Polyspec_Orm_Dbspec_Names();
    dbs_ce_FormatResult = register_class_Polyspec_Orm_Dbspec_FormatResult();
    dbs_ce_Manifest = register_class_Polyspec_Orm_Dbspec_Manifest();
    dbs_ce_ManifestResult = register_class_Polyspec_Orm_Dbspec_ManifestResult();
    dbs_ce_RenderResult = register_class_Polyspec_Orm_Dbspec_RenderResult();
    dbs_ce_Plan = register_class_Polyspec_Orm_Dbspec_Plan();
    dbs_ce_PlanStep = register_class_Polyspec_Orm_Dbspec_PlanStep();
    dbs_ce_Effect = register_class_Polyspec_Orm_Dbspec_Effect();
    dbs_ce_NullCheck = register_class_Polyspec_Orm_Dbspec_NullCheck();
    dbs_ce_Change = register_class_Polyspec_Orm_Dbspec_Change();
    dbs_ce_Difference = register_class_Polyspec_Orm_Dbspec_Difference();
    dbs_ce_Unsupported = register_class_Polyspec_Orm_Dbspec_Unsupported();
    dbs_ce_TableRename = register_class_Polyspec_Orm_Dbspec_TableRename();
    dbs_ce_ColumnRename = register_class_Polyspec_Orm_Dbspec_ColumnRename();
    dbs_ce_ColumnName = register_class_Polyspec_Orm_Dbspec_ColumnName();
    dbs_ce_ApplyEvent = register_class_Polyspec_Orm_Dbspec_ApplyEvent();
    dbs_ce_ApplyError = register_class_Polyspec_Orm_Dbspec_ApplyError(spl_ce_RuntimeException);
    dbs_ce_ApplyCleanupError = register_class_Polyspec_Orm_Dbspec_ApplyCleanupError(spl_ce_RuntimeException);
    dbs_ce_PlanParseResult = register_class_Polyspec_Orm_Dbspec_PlanParseResult();
    dbs_ce_PlanStepsResult = register_class_Polyspec_Orm_Dbspec_PlanStepsResult();
    dbs_ce_ChainResult = register_class_Polyspec_Orm_Dbspec_ChainResult();
    dbs_ce_DiffResult = register_class_Polyspec_Orm_Dbspec_DiffResult();
    dbs_ce_ComparisonResult = register_class_Polyspec_Orm_Dbspec_ComparisonResult();
    dbs_ce_MermaidExportResult = register_class_Polyspec_Orm_Dbspec_MermaidExportResult();
    dbs_ce_MermaidImportResult = register_class_Polyspec_Orm_Dbspec_MermaidImportResult();
    dbs_ce_IntrospectResult = register_class_Polyspec_Orm_Dbspec_IntrospectResult();
    dbs_ce_Dbspec = register_class_Polyspec_Orm_Dbspec_Dbspec();
    dbs_ce_PlanApply = register_class_Polyspec_Orm_Dbspec_PlanApply();
    dbs_ce_SetFile = register_class_Polyspec_Orm_Dbspec_SetFile();
    dbs_ce_SetError = register_class_Polyspec_Orm_Dbspec_SetError();
    dbs_ce_SetResult = register_class_Polyspec_Orm_Dbspec_SetResult();
    dbs_ce_SetDocument = register_class_Polyspec_Orm_Dbspec_SetDocument();

    /* A PHP readonly class does not accept dynamic properties. Internal classes keep that flag separately. */
#define DBS_NO_DYNAMIC(n) if (dbs_ce_##n->ce_flags & ZEND_ACC_READONLY_CLASS) dbs_ce_##n->ce_flags |= ZEND_ACC_NO_DYNAMIC_PROPERTIES;
    DBS_CLASSES(DBS_NO_DYNAMIC)
#undef DBS_NO_DYNAMIC

    static const char *const simple[] = {"i16", "i32", "i64", "bool", "f64", "text", "bytes", "uuid", "date"};
    static const char *const parameterized[] = {"decimal", "varchar", "time", "datetime"};
    static const zend_long arity[] = {2, 1, 1, 1};
    static const char *const actions[] = {"restrict", "cascade", "set_null"};
    static const char *const kinds[] = {"entity", "updated", "soft_delete", "select_explicit", "codec", "aes_version", "blind_index", "navigation", "markdown", "store",
        "key_prefix", "title", "body", "order", "checkbox", "state_machine", "immutable", "audit"};
    static const char *const stages[] = {"ordered_json", "aes", "hex", "gz", "base64", "serialize", "yaml", "ip"};
    static const char *const store_kinds[] = {"files", "document", "block"};
    static const zend_long store_arguments[] = {1, 2, 3};
    array_constant(dbs_ce_ColumnType, "SIMPLE", simple, NULL, COUNT(simple));
    array_constant(dbs_ce_ColumnType, "PARAMETERIZED", parameterized, arity, COUNT(parameterized));
    array_constant(dbs_ce_ForeignKey, "ACTIONS", actions, NULL, COUNT(actions));
    array_constant(dbs_ce_Setting, "KINDS", kinds, NULL, COUNT(kinds));
    array_constant(dbs_ce_Setting, "CODEC_STAGES", stages, NULL, COUNT(stages));
    array_constant(dbs_ce_Setting, "STORE_ARGUMENTS", store_kinds, store_arguments, COUNT(store_kinds));
    effect_queries_constant();
    return SUCCESS;
}

static PHP_MINFO_FUNCTION(polyspec_orm)
{
    php_info_print_table_start();
    php_info_print_table_row(2, "polyspec_orm", "enabled");
    php_info_print_table_row(2, "version", PHP_POLYSPEC_ORM_VERSION);
    php_info_print_table_end();
}

static const zend_module_dep polyspec_orm_deps[] = {
    ZEND_MOD_REQUIRED("spl")
    ZEND_MOD_REQUIRED("hash")
    ZEND_MOD_REQUIRED("pdo")
    ZEND_MOD_REQUIRED("json")
    ZEND_MOD_END
};

zend_module_entry polyspec_orm_module_entry = {
    STANDARD_MODULE_HEADER_EX,
    NULL,
    polyspec_orm_deps,
    "polyspec_orm",
    NULL,
    PHP_MINIT(polyspec_orm),
    NULL,
    NULL,
    NULL,
    PHP_MINFO(polyspec_orm),
    PHP_POLYSPEC_ORM_VERSION,
    STANDARD_MODULE_PROPERTIES,
};

#ifdef COMPILE_DL_POLYSPEC_ORM
#ifdef ZTS
ZEND_TSRMLS_CACHE_DEFINE()
#endif
ZEND_GET_MODULE(polyspec_orm)
#endif
