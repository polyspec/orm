#!/bin/sh
# MySQL driver(mysqlnd, pdo_mysql, mysqli)를 load하지 않은 PHP로
# packages/php/tests/SqliteWithoutMysqlTest.php를 PHPUnit으로 실행한다(N17). `php -n`은 ini가 load하는 shared
# module을 모두 빼고, 이 script는 client가 SQLite에서 쓰는 확장과 PHPUnit이 요구하는 확장(dom, libxml, xml,
# xmlwriter, tokenizer; EXTENSIONS) 가운데 compile되어 있지 않은 것만 `-d extension=`으로 명시해 load한다. MySQL driver가 PHP에 compile되어 있으면
# `-n`으로 뺄 수 없으므로 이유를 출력하고 실패한다: 이 검사는 driver가 shared module인 선언된
# Linux runner(.github/runner)에서 CI가
# 실행한다. make php-without-mysql-check가 이 script를 장기 작업으로 tests/run-long.mts에서 기한 없이
# 실행해 시작, 출력, 종료 코드, 결과와 걸린 시간을 보고하고, 안쪽 PHP case도 자기 줄과 기한을 가진다.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
EXTENSIONS="pdo pdo_sqlite openssl zlib ctype mbstring libxml dom xml xmlwriter tokenizer"
DRIVERS="mysqlnd pdo_mysql mysqli"

COMPILED=$(php -n -m | tr 'A-Z' 'a-z')
compiled() { printf '%s\n' "$COMPILED" | grep -qx "$1"; }

for driver in $DRIVERS; do
  if compiled "$driver"; then
    echo "php-without-mysql: $(command -v php) compiles $driver in, so php -n cannot leave it out; this check runs on the Linux runner $(cat "$ROOT/.github/runner"), whose MySQL drivers are shared modules" >&2
    exit 1
  fi
done

set --
for extension in $EXTENSIONS; do
  compiled "$extension" || set -- "$@" -d "extension=$extension"
done
echo "php $(php -n -r 'echo PHP_VERSION;') -n $*"
exec php -n "$@" "$ROOT/vendor-php/bin/phpunit" --configuration "$ROOT/packages/php/phpunit.xml.dist" "$ROOT/packages/php/tests/SqliteWithoutMysqlTest.php"
