-- Seed for MySQL: the same 100k battle rows as the PostgreSQL and SQLite seeds.
-- Run after bench/sql/battle.sql. AES and blind-index columns are filled by seedaes.
SET SESSION cte_max_recursion_depth = 100000;

INSERT INTO `user` (`seq`, `name`)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
SELECT i, CONCAT('user-', i) FROM n;

INSERT INTO `service` (`seq`, `name`)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
SELECT i, CONCAT('service-', i) FROM n
UNION ALL SELECT 999, 'service-999';

INSERT INTO `service_module` (`seq`, `service_seq`, `name`)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
SELECT i, (i - 1) % 100 + 1, CONCAT('module-', i) FROM n;

INSERT INTO `service_member` (`seq`, `service_seq`, `user_seq`)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
SELECT i, (i - 1) % 100 + 1, i FROM n;

INSERT INTO `battle` (`name`, `description`, `is_close`, `is_display`, `display_start_dt`, `display_end_dt`, `is_allday`,
  `target_team_player_count`, `success_count`, `player_count`, `read_count`, `cover_url`, `user_seq`, `service_seq`,
  `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`, `uuid`, `is_single_play`, `like_count`,
  `aes_key_version`, `aes_hex_email`, `aes_hex_phone`, `email_blind_index`, `phone_blind_index`)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
SELECT CONCAT('battle-', i), CONCAT('desc-', i, ' ', REPEAT('x', 200)),
  i % 7 = 0, i % 3 <> 0, '2026-01-01', '2027-01-01', i % 2 = 1,
  2, i % 7, i % 11, i % 1000, CONCAT('https://cdn/', i, '.jpg'), i % 5000 + 1, i % 100 + 1,
  i % 10 + 1, i % 5000 + 1, '2026-06-01', '2026-12-31', UUID(), i % 4 = 0, i % 97,
  1, NULL, NULL, NULL, NULL
FROM n;
