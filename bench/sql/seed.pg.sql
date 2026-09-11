-- Seed for PostgreSQL: the same 100k battle rows as bench/sql/battle.sql (same formulas), plus the related tables.
-- Run after bench/sql/battle.pg.sql. Sessions must use UTC.
INSERT INTO "battle" ("name", "description", "is_close", "is_display", "display_start_dt", "display_end_dt", "is_allday",
  "target_team_player_count", "success_count", "player_count", "read_count", "cover_url", "user_seq", "service_seq",
  "service_module_seq", "service_member_seq", "start_dt", "end_dt", "uuid", "is_single_play", "like_count", "aes_hex_email", "aes_hex_phone")
SELECT 'battle-' || i, 'desc-' || i || ' ' || repeat('x', 200),
  i % 7 = 0, i % 3 <> 0, '2026-01-01', '2027-01-01', i % 2 = 1,
  2, i % 7, i % 11, i % 1000, 'https://cdn/' || i || '.jpg', i % 5000 + 1, i % 100 + 1,
  i % 10 + 1, i % 5000 + 1, '2026-06-01', '2026-12-31', gen_random_uuid()::text, i % 4 = 0, i % 97,
  NULL, NULL   -- aes_hex_* are filled by the executor's host-side AES on write; the seed leaves them NULL
FROM generate_series(1, 100000) AS s(i);
INSERT INTO "user" ("seq", "name") SELECT DISTINCT "user_seq", 'user-' || "user_seq" FROM "battle";
INSERT INTO "service" ("seq", "name") SELECT DISTINCT "service_seq", 'service-' || "service_seq" FROM "battle";
INSERT INTO "service_module" ("seq", "service_seq", "name") SELECT "service_module_seq", MIN("service_seq"), 'module-' || "service_module_seq" FROM "battle" GROUP BY "service_module_seq";
INSERT INTO "service_member" ("seq", "service_seq", "user_seq") SELECT "service_member_seq", MIN("service_seq"), MIN("user_seq") FROM "battle" GROUP BY "service_member_seq";
SELECT setval(pg_get_serial_sequence('"user"', 'seq'), (SELECT MAX("seq") FROM "user"));
SELECT setval(pg_get_serial_sequence('"service"', 'seq'), (SELECT MAX("seq") FROM "service"));
SELECT setval(pg_get_serial_sequence('"service_module"', 'seq'), (SELECT MAX("seq") FROM "service_module"));
SELECT setval(pg_get_serial_sequence('"service_member"', 'seq'), (SELECT MAX("seq") FROM "service_member"));
