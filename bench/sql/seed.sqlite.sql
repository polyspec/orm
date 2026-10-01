-- Seed for SQLite: the same 100k author rows as the MySQL seed (same formulas). Run after scripts/bench-db.sh installs schema/bench.dbspec.
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
