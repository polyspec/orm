-- Seed for SQLite: the same 100k author rows as the MySQL seed (same formulas). Run after scripts/bench-db.sh installs contracts/fixtures/bench/bench.dbs.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
INSERT INTO "author" ("name", "description", "is_close", "is_display", "display_start_dt", "display_end_dt", "is_allday",
  "target_club_reader_count", "success_count", "reader_count", "read_count", "photo_url", "user_seq", "service_seq",
  "service_region_seq", "service_member_seq", "start_dt", "end_dt", "uuid", "is_single_work", "like_count", "aes_key_version", "aes_hex_email", "aes_hex_phone", "email_blind_index", "phone_blind_index",
  "created_ts", "updated_ts")
SELECT 'author-' || i, 'desc-' || i || ' ' || replace(hex(zeroblob(100)), '00', 'x'),
  i % 7 = 0, i % 3 <> 0, '2026-01-01 00:00:00.000000', '2027-01-01 00:00:00.000000', i % 2,
  2, i % 7, i % 11, i % 1000, 'https://cdn/' || i || '.jpg', i % 5000 + 1, i % 100 + 1,
  i % 10 + 1, i % 5000 + 1, '2026-06-01 00:00:00.000000', '2026-12-31 00:00:00.000000', lower(hex(randomblob(16))), i % 4 = 0, i % 97,
  1, NULL, NULL, NULL, NULL,
  strftime('%Y-%m-%d %H:%M:%f', 'now') || '000', strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'
FROM n;
INSERT INTO "user" ("seq", "name") SELECT DISTINCT "user_seq", 'user-' || "user_seq" FROM "author";
INSERT INTO "service" ("seq", "name") SELECT DISTINCT "service_seq", 'service-' || "service_seq" FROM "author" UNION ALL SELECT 999, 'service-999';
INSERT INTO "service_region" ("seq", "service_seq", "name") SELECT "service_region_seq", MIN("service_seq"), 'module-' || "service_region_seq" FROM "author" GROUP BY "service_region_seq";
INSERT INTO "service_member" ("seq", "service_seq", "user_seq") SELECT "service_member_seq", MIN("service_seq"), MIN("user_seq") FROM "author" GROUP BY "service_member_seq";

-- hex_cell holds raw hex cells that no encoder writes: decoding each one is CODEC_DECODE
-- (vector hex_malformed, docs/spec/codec.md "Decoding is exact").
INSERT INTO "hex_cell" ("seq", "label", "value") VALUES (1, 'white-space', ' 4F'), (2, 'odd-length', '686');

-- The authors of service 100 hold a price unless their seq is a multiple of 3, so an order
-- on price meets NULL and values (vector order_nulls, docs/spec/dialects.md). DECIMALINT(13,3)
-- stores the value times 1000 (docs/spec/dialects.md).
UPDATE "author" SET "price" = "seq" % 7 * 1000 WHERE "service_seq" = 100 AND "seq" % 3 <> 0;

-- The external table shared_note, which bench_shared.dbs owns, and the owned note_reader rows that reference it.
INSERT INTO shared_note (seq, title) VALUES (1, 'note-1'), (2, 'note-2'), (3, 'note-3');
INSERT INTO note_reader (seq, shared_note_seq) VALUES (1, 1), (2, 1), (3, 3);
