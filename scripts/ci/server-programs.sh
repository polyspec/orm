#!/bin/sh
# make install-server-programs installs, on the Linux runner of CI, the programs from which make test-servers starts
# the servers of the database checks, as it does locally: MySQL 8.4.11 from the Ubuntu packages, PostgreSQL 17 and
# PgBouncer from the PostgreSQL apt repository, and ProxySQL 3.0.9 from its Ubuntu 24.04 arm64 package, checked by its
# sha256, whose dependencies Ubuntu 26.04 provides. make test-servers finds mysqld at its package path
# /usr/sbin/mysqld on PATH. The image loads an AppArmor profile for /usr/sbin/mysqld that allows only /var/lib/mysql;
# it is removed because the servers keep their data in .runtime/servers. In a GitHub Actions job the PostgreSQL bin
# directory is added to GITHUB_PATH.
set -eu
sudo apt-get update -q >/dev/null
sudo apt-get install -y -q postgresql-common sqlite3 mysql-server-core mysql-client-core >/dev/null
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
sudo apt-get install -y -q postgresql-17 pgbouncer >/dev/null
curl -fsSL -o /tmp/proxysql.deb https://repo.proxysql.com/ProxySQL/proxysql-3.0.x/noble/proxysql_3.0.9-ubuntu24_arm64.deb
echo 'e12b272107f1ac65ae8a9f9015a9c696b7b2f78b6ad35f84b5ce086449eb2a0f  /tmp/proxysql.deb' | sha256sum -c -
sudo apt-get install -y -q /tmp/proxysql.deb >/dev/null
if sudo grep -qs '^/usr/sbin/mysqld ' /sys/kernel/security/apparmor/profiles; then
  printf /usr/sbin/mysqld | sudo tee /sys/kernel/security/apparmor/.remove >/dev/null
fi
test "$(command -v mysqld)" = /usr/sbin/mysqld
mysqld --version | grep -E ' Ver 8\.4\.11[- ]'
proxysql --version | grep -F 'ProxySQL version 3.0.9-'
# The PostgreSQL apt repository keeps only the newest minor release of PostgreSQL 17 and of PgBouncer, so the major
# release is what can be pinned; the versions are printed for the record of the run.
/usr/lib/postgresql/17/bin/postgres --version | grep -E '^postgres \(PostgreSQL\) 17\.'
pgbouncer --version | head -n 1
sqlite3 --version
if [ -n "${GITHUB_PATH:-}" ]; then echo /usr/lib/postgresql/17/bin >> "$GITHUB_PATH"; fi
