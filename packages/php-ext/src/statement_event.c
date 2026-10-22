/*
 * Polyspec\Orm\StatementEvent (packages/php/src/StatementEvent.php) in C: one statement that the connection sent. Its
 * constructor stores the seven properties in order; the constants are the stub's. The class is final and readonly, so the
 * engine enforces the writes: a property is written once, by the constructor.
 */
#include "dbspec.h"

ZEND_METHOD(Polyspec_Orm_StatementEvent, __construct)
{
    zend_string *sql, *kind;
    zval *binds, *tables;
    double elapsed;
    zend_long transaction;
    bool transaction_null;
    zval *error;
    ZEND_PARSE_PARAMETERS_START(7, 7)
        Z_PARAM_STR(sql)
        Z_PARAM_ARRAY(binds)
        Z_PARAM_STR(kind)
        Z_PARAM_ARRAY(tables)
        Z_PARAM_DOUBLE(elapsed)
        Z_PARAM_LONG_OR_NULL(transaction, transaction_null)
        Z_PARAM_OBJECT_OR_NULL(error)
    ZEND_PARSE_PARAMETERS_END();
    zend_object *o = Z_OBJ_P(ZEND_THIS);
    zval v;
    zend_update_property_str(o->ce, o, ZEND_STRL("sql"), sql);
    ZVAL_COPY(&v, binds);
    zend_update_property(o->ce, o, ZEND_STRL("binds"), &v);
    zval_ptr_dtor(&v);
    zend_update_property_str(o->ce, o, ZEND_STRL("kind"), kind);
    ZVAL_COPY(&v, tables);
    zend_update_property(o->ce, o, ZEND_STRL("tables"), &v);
    zval_ptr_dtor(&v);
    zend_update_property_double(o->ce, o, ZEND_STRL("elapsed"), elapsed);
    if (transaction_null) {
        zend_update_property_null(o->ce, o, ZEND_STRL("transaction"));
    } else {
        zend_update_property_long(o->ce, o, ZEND_STRL("transaction"), transaction);
    }
    if (error == NULL) {
        zend_update_property_null(o->ce, o, ZEND_STRL("error"));
    } else {
        zend_update_property(o->ce, o, ZEND_STRL("error"), error);
    }
}
