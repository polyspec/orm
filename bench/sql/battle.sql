-- S0 bench schema: subset of `battle` + two aes_hex columns.
CREATE DATABASE IF NOT EXISTS orm_bench DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE orm_bench;
DROP TABLE IF EXISTS battle;
CREATE TABLE battle (
  seq bigint unsigned NOT NULL AUTO_INCREMENT,
  name varchar(191) NOT NULL,
  description text NULL,
  created_ts timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_ts timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  is_close tinyint unsigned NOT NULL DEFAULT 0,
  is_display tinyint unsigned NOT NULL DEFAULT 0,
  display_start_dt datetime(6) NULL,
  display_end_dt datetime(6) NULL,
  is_allday tinyint unsigned NOT NULL DEFAULT 0,
  target_team_player_count int unsigned NOT NULL DEFAULT 0,
  success_count int unsigned NOT NULL DEFAULT 0,
  player_count int unsigned NOT NULL DEFAULT 0,
  read_count int unsigned NOT NULL DEFAULT 0,
  cover_url varchar(191) NULL,
  user_seq bigint unsigned NOT NULL,
  service_seq bigint unsigned NOT NULL,
  service_module_seq bigint unsigned NOT NULL,
  service_member_seq bigint unsigned NOT NULL,
  start_dt datetime(6) NOT NULL,
  end_dt datetime(6) NOT NULL,
  uuid varchar(36) NULL,
  is_single_play tinyint unsigned NOT NULL DEFAULT 0,
  like_count int unsigned NOT NULL DEFAULT 0,
  aes_key_version int NOT NULL DEFAULT 1,
  aes_hex_email varchar(255) NULL,
  aes_hex_phone varchar(255) NULL,
  price decimal(13,3) NULL,
  ip varbinary(16) NULL,
  gz_extend blob NULL,
  json_setting json NULL,
  jsons_tags text NULL,
  base64_extra text NULL,
  serialize_data text NULL,
  PRIMARY KEY (seq),
  UNIQUE KEY uuid_UNIQUE (uuid),
  KEY ik (service_module_seq, is_close, is_display, is_allday),
  KEY ix_service (service_seq, is_close),
  KEY ix_user (user_seq, is_close),
  FULLTEXT KEY ft_name_description (name, description)
) ENGINE=InnoDB;

-- 100k rows, 100 services x 1000 rows, deterministic content.
SET SESSION cte_max_recursion_depth = 200000;
INSERT INTO battle (name, description, is_close, is_display, display_start_dt, display_end_dt, is_allday,
  target_team_player_count, success_count, player_count, read_count, cover_url, user_seq, service_seq,
  service_module_seq, service_member_seq, start_dt, end_dt, uuid, is_single_play, like_count, aes_key_version, aes_hex_email, aes_hex_phone)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
SELECT CONCAT('battle-', i), CONCAT('desc-', i, ' ', REPEAT('x', 200)),
  i % 7 = 0, i % 3 <> 0, '2026-01-01', '2027-01-01', i % 2,
  2, i % 7, i % 11, i % 1000, CONCAT('https://cdn/', i, '.jpg'), i % 5000 + 1, i % 100 + 1,
  i % 10 + 1, i % 5000 + 1, '2026-06-01', '2026-12-31', UUID(), i % 4 = 0, i % 97, 1,
  HEX(AES_ENCRYPT(CONCAT('user', i, '@example.com'), 'bench-salt')),
  HEX(AES_ENCRYPT(CONCAT('010-', LPAD(i, 8, '0')), 'bench-salt'))
FROM n;
ANALYZE TABLE battle;
SELECT COUNT(*) AS rows_, MIN(seq), MAX(seq) FROM battle;

-- Related tables (schema/bench.mmd) so joins/relations can be exercised.
DROP TABLE IF EXISTS user; DROP TABLE IF EXISTS service; DROP TABLE IF EXISTS service_module; DROP TABLE IF EXISTS service_member;
CREATE TABLE user (seq bigint unsigned NOT NULL AUTO_INCREMENT, name varchar(191) NOT NULL, PRIMARY KEY (seq)) ENGINE=InnoDB;
CREATE TABLE service (seq bigint unsigned NOT NULL AUTO_INCREMENT, name varchar(191) NOT NULL, PRIMARY KEY (seq)) ENGINE=InnoDB;
CREATE TABLE service_module (seq bigint unsigned NOT NULL AUTO_INCREMENT, service_seq bigint unsigned NOT NULL, name varchar(191) NOT NULL, PRIMARY KEY (seq), KEY ix_service (service_seq)) ENGINE=InnoDB;
CREATE TABLE service_member (seq bigint unsigned NOT NULL AUTO_INCREMENT, service_seq bigint unsigned NOT NULL, user_seq bigint unsigned NOT NULL, PRIMARY KEY (seq), KEY ix_service (service_seq), KEY ix_user (user_seq)) ENGINE=InnoDB;
INSERT INTO user (seq, name) SELECT DISTINCT user_seq, CONCAT('user-', user_seq) FROM battle;
INSERT INTO service (seq, name) SELECT DISTINCT service_seq, CONCAT('service-', service_seq) FROM battle;
INSERT INTO service_module (seq, service_seq, name) SELECT service_module_seq, MIN(service_seq), CONCAT('module-', service_module_seq) FROM battle GROUP BY service_module_seq;
INSERT INTO service_member (seq, service_seq, user_seq) SELECT service_member_seq, MIN(service_seq), MIN(user_seq) FROM battle GROUP BY service_member_seq;
