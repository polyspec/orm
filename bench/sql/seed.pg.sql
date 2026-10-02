-- Seed for PostgreSQL: the same 100k author rows as the MySQL seed (same formulas), plus the related tables.
-- Run after scripts/bench-db.sh installs schema/bench.dbs. Sessions must use UTC.
INSERT INTO "user" ("seq", "name") SELECT i, 'user-' || i FROM generate_series(1, 5000) AS s(i);
INSERT INTO "service" ("seq", "name") SELECT i, 'service-' || i FROM generate_series(1, 100) AS s(i) UNION ALL SELECT 999, 'service-999';
INSERT INTO "service_region" ("seq", "service_seq", "name") SELECT i, (i - 1) % 100 + 1, 'module-' || i FROM generate_series(1, 10) AS s(i);
INSERT INTO "service_member" ("seq", "service_seq", "user_seq") SELECT i, (i - 1) % 100 + 1, i FROM generate_series(1, 5000) AS s(i);
INSERT INTO "author" ("name", "description", "is_close", "is_display", "display_start_dt", "display_end_dt", "is_allday",
  "target_club_reader_count", "success_count", "reader_count", "read_count", "photo_url", "user_seq", "service_seq",
  "service_region_seq", "service_member_seq", "start_dt", "end_dt", "uuid", "is_single_work", "like_count", "aes_key_version", "aes_hex_email", "aes_hex_phone", "email_blind_index", "phone_blind_index")
SELECT 'author-' || i, 'desc-' || i || ' ' || repeat('x', 200),
  i % 7 = 0, i % 3 <> 0, '2026-01-01', '2027-01-01', i % 2 = 1,
  2, i % 7, i % 11, i % 1000, 'https://cdn/' || i || '.jpg', i % 5000 + 1, i % 100 + 1,
  i % 10 + 1, i % 5000 + 1, '2026-06-01', '2026-12-31', gen_random_uuid()::text, i % 4 = 0, i % 97,
  1, NULL, NULL, NULL, NULL   -- encrypted and blind-index values are filled by seedaes
FROM generate_series(1, 100000) AS s(i);
SELECT setval(pg_get_serial_sequence('"user"', 'seq'), (SELECT MAX("seq") FROM "user"));
SELECT setval(pg_get_serial_sequence('"service"', 'seq'), (SELECT MAX("seq") FROM "service"));
SELECT setval(pg_get_serial_sequence('"service_region"', 'seq'), (SELECT MAX("seq") FROM "service_region"));
SELECT setval(pg_get_serial_sequence('"service_member"', 'seq'), (SELECT MAX("seq") FROM "service_member"));
