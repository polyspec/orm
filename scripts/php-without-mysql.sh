#!/bin/sh
# pdo_sqlite는 있고 pdo_mysql은 없는 공식 PHP image에서
# clients/php/tests/sqlite_without_mysql.php를 실행한다(N17). repository는 같은
# 절대 path에 읽기 전용으로 mount되고, case는 container의 임시 directory 아래에만
# 쓴다. make php-without-mysql-check가 이 script를 tests/run-case.mjs로 감싸 시작,
# 결과, 걸린 시간과 기한을 보고하고, 안쪽 PHP case도 자기 줄을 출력한다.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
IMAGE=docker.io/library/php:8.5.10-cli-trixie@sha256:df50257c90ad9a53052fb4e9c6fdba8262cf72ca9e9a048b7c89f74c8d23fc0d
echo "image $IMAGE"
exec container run --rm --mount "type=bind,source=$ROOT,target=$ROOT,readonly" "$IMAGE" php "$ROOT/clients/php/tests/sqlite_without_mysql.php"
