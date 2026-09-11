# Local PostgreSQL for the S6 lanes (macOS, Homebrew postgresql@17)

Data dir `/opt/orm-pg` (outside the repo, declared here, no symlinks), superuser `orm`, trust auth on localhost, port 5432, timezone UTC.
```sh
initdb -D /opt/orm-pg -U orm --auth=trust -E UTF8
pg_ctl -D /opt/orm-pg -l /opt/orm-pg/pg.log -o "-p 5432 -c timezone=UTC" start
psql -h localhost -U orm postgres -c "CREATE DATABASE orm_bench"
psql -h localhost -U orm orm_bench -q -f bench/sql/author.pg.sql
psql -h localhost -U orm orm_bench -q -f bench/sql/seed.pg.sql      # 100k rows, ~2s
```
URLs: Go `postgres://orm@127.0.0.1:5432/orm_bench?sslmode=disable`, Rust `postgres://orm@localhost:5432/orm_bench`, PHP `pgsql:host=localhost;port=5432;dbname=orm_bench;user=orm`.
SQLite: `sqlite3 <file> < bench/sql/author.sqlite.sql && sqlite3 <file> < bench/sql/seed.sqlite.sql` (~0.5s).
The aes_hex_* columns are NULL in both seeds: MySQL fills them with AES_ENCRYPT, the other databases get them from the executor's host-side AES on write.
