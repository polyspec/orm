# Deploying ormd (PHP only)

`ormd` compiles IR into plans over a unix socket; it never touches the database. One process per
host is enough (plans are cached in APCu per PHP worker after the first compile of each statement shape).

- Socket: `-socket` must be an absolute path in a directory owned by the PHP user; ormd creates it
  with mode 0600, so run ormd **as the PHP user** (`www-data`) or in its group. Never symlink the socket.
- Schema: `-schema` is the same `schema.json` the PHP classes were generated from; a mismatch makes
  every request fail with `SCHEMA_HASH_MISMATCH` (fix by redeploying both together — there is no reload).
- Units: `deploy/ormd.service` (systemd) and `deploy/com.orm.ormd.plist` (launchd). Binary names carry the
  version (`ormd-0.0.1-linux-amd64`, built by `scripts/build-artifacts.sh`).
