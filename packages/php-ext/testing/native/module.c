#include "dbspec.h"
#include "parent_slot_sql.h"
#include "ext/spl/spl_exceptions.h"

static int mermaid_test_mode;
static zval *mermaid_test_cause;

document *mermaid_test_catalog_document(catalog *c, str name, unsupportedv *out)
{
    if (mermaid_test_mode == 1) {
        dbs_throw_code(
            spl_ce_RuntimeException,
            str_c("synthetic catalog document build failure"),
            DBS_CATALOG_DOCUMENT_BUILD_CODE
        );
        return NULL;
    }
    if (mermaid_test_mode == 2) {
        zval cause;
        ZVAL_COPY(&cause, mermaid_test_cause);
        zend_throw_exception_object(&cause);
        return NULL;
    }
    return catalog_document(c, name, out);
}

ZEND_BEGIN_ARG_INFO_EX(arginfo_mermaid_test_import, 0, 0, 1)
    ZEND_ARG_TYPE_INFO(0, mode, IS_LONG, 0)
    ZEND_ARG_INFO(0, cause)
ZEND_END_ARG_INFO()

PHP_FUNCTION(mermaid_test_import)
{
    zend_long mode;
    zval *cause = NULL;
    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_LONG(mode)
        Z_PARAM_OPTIONAL
        Z_PARAM_OBJECT(cause)
    ZEND_PARSE_PARAMETERS_END();

    if ((mode != 1 && mode != 2) || (mode == 2 && cause == NULL)) {
        zend_value_error("mermaid_test_import needs mode 1, or mode 2 and a Throwable");
        RETURN_THROWS();
    }
    if (mode == 2 && !instanceof_function(Z_OBJCE_P(cause), zend_ce_throwable)) {
        zend_type_error("mermaid_test_import cause must implement Throwable");
        RETURN_THROWS();
    }

    mermaid_test_mode = (int)mode;
    mermaid_test_cause = cause;
    dbs_arena arena = {0}, *saved = NULL;
    dbs_enter(&arena, &saved);
    unsupportedv dropped = {0};
    diags diagnostics = {0};
    str text = str_c("erDiagram\n    account {\n        i64 id PK\n    }\n");
    document *result = mermaid_import(text, str_c("imported"), &dropped, &diagnostics);
    mermaid_test_mode = 0;
    mermaid_test_cause = NULL;
    if (EG(exception) != NULL) {
        dbs_leave(&arena, saved);
        RETURN_THROWS();
    }
    array_init(return_value);
    add_assoc_bool(return_value, "document", result != NULL);
    add_assoc_long(return_value, "diagnostics", diagnostics.n);
    dbs_leave(&arena, saved);
}

ZEND_BEGIN_ARG_INFO_EX(arginfo_expand_numbered_parent_slots_test, 0, 0, 0)
ZEND_END_ARG_INFO()

PHP_FUNCTION(expand_numbered_parent_slots_test)
{
    ZEND_PARSE_PARAMETERS_NONE();
    RETURN_STR(expand_numbered_parent_slots("SELECT '$' AS sign WHERE id = $1 AND status = $2", sizeof("SELECT '$' AS sign WHERE id = $1 AND status = $2") - 1, 1, 2, 1));
}

const zend_function_entry native_test_functions[] = {
    ZEND_FE(mermaid_test_import, arginfo_mermaid_test_import)
    ZEND_FE(expand_numbered_parent_slots_test, arginfo_expand_numbered_parent_slots_test)
    ZEND_FE_END
};
