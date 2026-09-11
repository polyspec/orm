#!/bin/sh
# Generates tests/codec/aes-vectors.json from the local MySQL: what HEX(AES_ENCRYPT(v, key)) yields
# for a set of plaintexts and keys, so host-side AES (PostgreSQL/SQLite executors, docs/dialects.md)
# can be checked byte for byte. Requires block_encryption_mode = aes-128-ecb (the default).
set -eu
cd "$(dirname "$0")/../.."
SOCK=${ORM_MYSQL_SOCK:-/tmp/mysql.sock}
mysql -uroot -S "$SOCK" orm_bench -N -e "
SELECT JSON_OBJECT('mode', @@block_encryption_mode, 'vectors', JSON_ARRAYAGG(JSON_OBJECT('key', k, 'plain', p, 'hex', HEX(AES_ENCRYPT(p, k)))))
FROM (
  SELECT 'bench-salt' k, 'user42@example.com' p UNION ALL
  SELECT 'bench-salt', '' UNION ALL
  SELECT 'bench-salt', '한글 텍스트' UNION ALL
  SELECT 'bench-salt', REPEAT('x', 16) UNION ALL
  SELECT 'bench-salt', REPEAT('y', 17) UNION ALL
  SELECT 'a-much-longer-key-than-sixteen-bytes', 'fold me' UNION ALL
  SELECT 'k', 'short key' UNION ALL
  SELECT '0123456789abcdef', 'exact 16 byte key'
) t;" > tests/codec/aes-vectors.json
python3 -m json.tool tests/codec/aes-vectors.json > /dev/null && echo "wrote tests/codec/aes-vectors.json"
