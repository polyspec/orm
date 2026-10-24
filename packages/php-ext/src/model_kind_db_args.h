#ifndef POLYSPEC_ORM_MODEL_KIND_DB_ARGS_H
#define POLYSPEC_ORM_MODEL_KIND_DB_ARGS_H

#define MODEL_PARSE_KIND_AND_DB() \
    static const char *const scalar_types[] = {"string", NULL}; \
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS(); \
    zend_string *kind; \
    zval *db; \
    ZEND_PARSE_PARAMETERS_START(2, 2) \
        Z_PARAM_STR(kind) \
        Z_PARAM_OBJECT(db) \
    ZEND_PARSE_PARAMETERS_END()

#endif
