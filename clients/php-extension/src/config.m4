dnl 확장 orm_dbspec(dbspec 인터페이스의 C 구현)의 build 설정이다. phpize, ./configure, make로 build하고, PIE는
dnl composer.json의 php-ext.build-path인 이 directory에서 같은 단계를 실행한다.
PHP_ARG_ENABLE([orm-dbspec], [whether to enable orm_dbspec],
  [AS_HELP_STRING([--enable-orm-dbspec], [Enable orm_dbspec, the dbspec interface of orm])], [yes])

if test "$PHP_ORM_DBSPEC" != "no"; then
  PHP_NEW_EXTENSION([orm_dbspec],
    [orm_dbspec.c convert.c util.c model.c literal.c expression.c parse.c emit.c render.c plan.c steps.c catalog.c mermaid.c],
    [$ext_shared],, [-std=gnu11 -Wall -Wextra -Wno-unused-parameter])
  PHP_ADD_EXTENSION_DEP([orm_dbspec], [spl])
  PHP_ADD_EXTENSION_DEP([orm_dbspec], [hash])
  PHP_ADD_EXTENSION_DEP([orm_dbspec], [pdo])
fi
