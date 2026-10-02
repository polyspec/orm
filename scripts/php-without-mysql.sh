#!/bin/sh
# Runs clients/php/tests/sqlite_without_mysql.php in the official PHP image,
# which has pdo_sqlite and no pdo_mysql (N17). The repository is mounted read
# only at its absolute path; the case writes only below the temporary directory
# of the container. Every run reports its start, its result and its elapsed time.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
IMAGE=docker.io/library/php:8.5.10-cli-trixie@sha256:df50257c90ad9a53052fb4e9c6fdba8262cf72ca9e9a048b7c89f74c8d23fc0d
echo "RUN php-without-mysql: $IMAGE"
started=$(date +%s)
if container run --rm --mount "type=bind,source=$ROOT,target=$ROOT,readonly" "$IMAGE" php "$ROOT/clients/php/tests/sqlite_without_mysql.php"; then
	echo "PASS php-without-mysql $(( $(date +%s) - started ))s"
else
	code=$?
	echo "FAIL php-without-mysql: exit $code $(( $(date +%s) - started ))s"
	exit "$code"
fi
