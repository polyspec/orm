dnl The build of the extension polyspec_orm (the dbspec interface in C): phpize, ./configure and make, which PIE runs
dnl in this directory, the php-ext.build-path of composer.json.
PHP_ARG_ENABLE([polyspec-orm], [whether to enable polyspec_orm],
  [AS_HELP_STRING([--enable-polyspec-orm], [Enable polyspec_orm, the dbspec interface of orm])], [yes])
PHP_ARG_ENABLE([polyspec-orm-mermaid-test], [whether to enable the private Mermaid boundary test module],
  [AS_HELP_STRING([--enable-polyspec-orm-mermaid-test], [Enable test-only Mermaid fault injection])], [no], [no])

if test "$PHP_POLYSPEC_ORM" != "no"; then
  dnl The version of the extension is the version of its package: composer.json lies beside src/, in the package and in the build of kit.
  PHP_POLYSPEC_ORM_VERSION=`sed -n 's/.*"version": *"\([[^"]]*\)".*/\1/p' "$srcdir/../composer.json"`
  AC_DEFINE_UNQUOTED([PHP_POLYSPEC_ORM_VERSION], ["$PHP_POLYSPEC_ORM_VERSION"], [The version of the package])
  POLYSPEC_ORM_TEST_SOURCES=""
  POLYSPEC_ORM_TEST_CFLAGS=""
  if test "$PHP_POLYSPEC_ORM_MERMAID_TEST" != "no"; then
    POLYSPEC_ORM_TEST_SOURCES="mermaid_test.c"
    POLYSPEC_ORM_TEST_CFLAGS="-DPOLYSPEC_ORM_MERMAID_TEST"
  fi
  PHP_NEW_EXTENSION([polyspec_orm],
    [polyspec_orm.c orm.c orm_exception.c aes_keyring.c aes_utils.c privilege_utils.c utils.c schema_utils.c codec.c statement_event.c model_types.c model_helpers.c model_state.c model_chain.c model_native_methods.c model_output.c model_query.c model_dsl.c model_read.c model_write.c model_assembly.c runtime_model.c chain_native.c registry_native.c engine_native.c validator.c planner.c collection.c db.c convert.c util.c model.c literal.c expression.c parse.c emit.c render.c plan.c steps.c catalog.c catalog_connection.c mermaid.c introspect.c apply.c set.c $POLYSPEC_ORM_TEST_SOURCES],
    [$ext_shared],, [-std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter $POLYSPEC_ORM_TEST_CFLAGS])
  dnl codec.c inflates and deflates the gz stage with libz (zlib.h, -lz).
  AC_CHECK_HEADER([zlib.h], [], [AC_MSG_ERROR([polyspec_orm needs the zlib headers (zlib.h)])])
  AC_CHECK_LIB([z], [deflateInit2_], [PHP_ADD_LIBRARY([z], 1, POLYSPEC_ORM_SHARED_LIBADD)], [AC_MSG_ERROR([polyspec_orm needs libz])])
  PHP_SUBST([POLYSPEC_ORM_SHARED_LIBADD])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [spl])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [hash])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [pdo])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [json])
fi
