dnl The build of the extension polyspec_orm (the dbspec interface in C): phpize, ./configure and make, which PIE runs
dnl in this directory, the php-ext.build-path of composer.json.
PHP_ARG_ENABLE([polyspec-orm], [whether to enable polyspec_orm],
  [AS_HELP_STRING([--enable-polyspec-orm], [Enable polyspec_orm, the dbspec interface of orm])], [yes])

if test "$PHP_POLYSPEC_ORM" != "no"; then
  dnl The version of the extension is the version of its package: composer.json lies beside src/, in the package and in the build of kit.
  PHP_POLYSPEC_ORM_VERSION=`sed -n 's/.*"version": *"\([[^"]]*\)".*/\1/p' "$srcdir/../composer.json"`
  AC_DEFINE_UNQUOTED([PHP_POLYSPEC_ORM_VERSION], ["$PHP_POLYSPEC_ORM_VERSION"], [The version of the package])
  PHP_NEW_EXTENSION([polyspec_orm],
    [polyspec_orm.c codec.c statement_event.c model_helpers.c model_state.c validator.c planner.c db.c convert.c util.c model.c literal.c expression.c parse.c emit.c render.c plan.c steps.c catalog.c mermaid.c introspect.c apply.c set.c],
    [$ext_shared],, [-std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter])
  dnl codec.c inflates and deflates the gz stage with libz (zlib.h, -lz).
  AC_CHECK_HEADER([zlib.h], [], [AC_MSG_ERROR([polyspec_orm needs the zlib headers (zlib.h)])])
  AC_CHECK_LIB([z], [deflateInit2_], [PHP_ADD_LIBRARY([z], 1, POLYSPEC_ORM_SHARED_LIBADD)], [AC_MSG_ERROR([polyspec_orm needs libz])])
  PHP_SUBST([POLYSPEC_ORM_SHARED_LIBADD])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [spl])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [hash])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [pdo])
  PHP_ADD_EXTENSION_DEP([polyspec_orm], [json])
fi
