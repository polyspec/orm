package dialects

import (
	"context"
	"database/sql"
	"strconv"
	"strings"

	"github.com/go-sql-driver/mysql"
)

func mysqlProbes() []Probe {
	p := func(id, fact string, run func(e *Env)) Probe {
		return Probe{ID: "mysql." + id, DB: "mysql", Fact: fact, Run: run}
	}
	utc := "SET time_zone = '+00:00'"
	return []Probe{
		p("env.server", "the server is MySQL 8.4 in strict mode with lower_case_table_names=1", func(e *Env) {
			version := e.Value("SELECT VERSION()")
			e.Check(strings.HasPrefix(version, "8.4."), "version %s", version)
			mode := e.Value("SELECT @@sql_mode")
			e.Check(strings.Contains(mode, "STRICT_TRANS_TABLES"), "sql_mode %s", mode)
			e.Want("SELECT @@lower_case_table_names", "1")
			e.Note("version=%s sql_mode=%s log_bin=%s log_bin_trust_function_creators=%s time_zone=%s system_time_zone=%s explicit_defaults_for_timestamp=%s",
				version, mode, e.Value("SELECT @@log_bin"), e.Value("SELECT @@log_bin_trust_function_creators"),
				e.Value("SELECT @@time_zone"), e.Value("SELECT @@system_time_zone"), e.Value("SELECT @@explicit_defaults_for_timestamp"))
		}),
		// Integers and booleans.
		p("int.tinyint_range", "TINYINT rejects 128 in strict mode (1264)", func(e *Env) {
			e.Exec("CREATE TABLE t (a tinyint)", "INSERT INTO t VALUES (127)")
			e.Fails("INSERT INTO t VALUES (128)", "1264")
		}),
		p("int.unsigned_rejects_negative", "INT UNSIGNED rejects -1 and accepts 4294967295", func(e *Env) {
			e.Exec("CREATE TABLE t (a int unsigned)", "INSERT INTO t VALUES (4294967295)")
			e.Fails("INSERT INTO t VALUES (-1)", "1264")
		}),
		p("int.bigint_unsigned_exceeds_signed", "BIGINT UNSIGNED stores 18446744073709551615, beyond signed 64-bit", func(e *Env) {
			e.Exec("CREATE TABLE t (a bigint unsigned)", "INSERT INTO t VALUES (18446744073709551615)")
			e.Want("SELECT a FROM t", "18446744073709551615")
		}),
		p("int.display_width_dropped", "COLUMN_TYPE drops integer display width except tinyint(1)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int(11), b tinyint(1), c bigint(20))")
			e.WantRows("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION", "int,tinyint(1),bigint")
		}),
		p("bool.alias_tinyint", "BOOLEAN is TINYINT(1) and stores 2 and -1", func(e *Env) {
			e.Exec("CREATE TABLE t (b boolean)", "INSERT INTO t VALUES (2), (-1), (TRUE)")
			e.Want("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "tinyint(1)")
			e.WantRows("SELECT b FROM t ORDER BY b", "-1,1,2")
		}),
		// Exact and approximate numbers.
		p("decimal.scale_rounds", "DECIMAL(4,2) rounds 1.235 to 1.24 and -1.235 to -1.24 (half away from zero)", func(e *Env) {
			e.Exec("CREATE TABLE t (n int, d decimal(4,2))", "INSERT INTO t VALUES (1, 1.235), (2, -1.235), (3, '1.225')")
			e.WantRows("SELECT d FROM t ORDER BY n", "1.24,-1.24,1.23")
		}),
		p("decimal.overflow_rejected", "DECIMAL(4,2) rejects 100 (1264)", func(e *Env) {
			e.Exec("CREATE TABLE t (d decimal(4,2))")
			e.Fails("INSERT INTO t VALUES (100)", "1264")
		}),
		p("decimal.precision_limits", "DECIMAL precision is at most 65 (1426) and scale at most 30 (1425)", func(e *Env) {
			e.Exec("CREATE TABLE t (d decimal(65,30))")
			e.Fails("CREATE TABLE u (d decimal(66,0))", "1426")
			e.Fails("CREATE TABLE v (d decimal(65,31))", "1425")
		}),
		p("float.single_precision", "FLOAT is 4-byte single precision; DOUBLE is 8-byte", func(e *Env) {
			e.Exec("CREATE TABLE t (f float, d double)", "INSERT INTO t VALUES (0.1, 0.1)")
			e.Want("SELECT CAST(f AS DOUBLE) FROM t", "0.10000000149011612")
			e.Want("SELECT d FROM t", "0.1")
		}),
		p("float.no_infinity", "DOUBLE has no infinity or NaN literal; 1e309 is rejected (1367)", func(e *Env) {
			e.Exec("CREATE TABLE t (d double)")
			e.Fails("INSERT INTO t VALUES (1e309)", "1367")
		}),
		// Character and binary strings.
		p("varchar.length_in_characters", "VARCHAR(3) counts characters: accepts three Hangul syllables, rejects abcd (1406)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(3))", "INSERT INTO t VALUES ('가나다')")
			e.Fails("INSERT INTO t VALUES ('abcd')", "1406")
		}),
		p("varchar.trailing_spaces_truncated", "VARCHAR(3) accepts 'abc   ' by removing the excess trailing spaces", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(3))", "INSERT INTO t VALUES ('abc   ')")
			e.Want("SELECT CONCAT('[', v, ']') FROM t", "[abc]")
		}),
		p("varchar.max_length", "utf8mb4 VARCHAR is at most 16383 characters (1074)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(16383)) DEFAULT CHARSET=utf8mb4")
			e.Fails("CREATE TABLE u (v varchar(16384)) DEFAULT CHARSET=utf8mb4", "1074")
		}),
		p("char.trailing_spaces_removed", "CHAR(5) removes trailing spaces on read", func(e *Env) {
			e.Exec("CREATE TABLE t (c char(5))", "INSERT INTO t VALUES ('ab  ')")
			e.Want("SELECT CONCAT('[', c, ']') FROM t", "[ab]")
		}),
		p("text.max_bytes", "TEXT holds at most 65535 bytes (1406)", func(e *Env) {
			e.Exec("CREATE TABLE t (v text)", "INSERT INTO t VALUES (REPEAT('a', 65535))")
			e.Fails("INSERT INTO t VALUES (REPEAT('a', 65536))", "1406")
		}),
		p("text.literal_default_needs_expression", "TEXT rejects DEFAULT 'x' (1101) and accepts DEFAULT ('x')", func(e *Env) {
			e.Fails("CREATE TABLE t (v text DEFAULT 'x')", "1101")
			e.Exec("CREATE TABLE u (v text DEFAULT ('x'))")
		}),
		p("text.index_needs_prefix", "an index on TEXT requires a prefix length (1170)", func(e *Env) {
			e.Fails("CREATE TABLE t (v text, KEY ix (v))", "1170")
		}),
		p("text.nul_preserved", "text stores U+0000", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(5))")
			e.ExecArgs("INSERT INTO t VALUES (?)", "a\x00b")
			e.Want("SELECT LENGTH(v) FROM t", "3")
		}),
		p("index.max_key_bytes", "an index key is at most 3072 bytes: utf8mb4 VARCHAR(768) is accepted and VARCHAR(769) rejected (1071)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(768), KEY ix (v)) DEFAULT CHARSET=utf8mb4")
			e.Fails("CREATE TABLE u (v varchar(769), KEY ix (v)) DEFAULT CHARSET=utf8mb4", "1071")
		}),
		p("binary.zero_padded", "BINARY(4) pads 'ab' with zero bytes", func(e *Env) {
			e.Exec("CREATE TABLE t (b binary(4))", "INSERT INTO t VALUES ('ab')")
			e.Want("SELECT HEX(b) FROM t", "61620000")
		}),
		p("varbinary.length_enforced", "VARBINARY(2) rejects three bytes (1406)", func(e *Env) {
			e.Exec("CREATE TABLE t (b varbinary(2))")
			e.Fails("INSERT INTO t VALUES ('abc')", "1406")
		}),
		// Date and time.
		p("timestamp.range_2038", "TIMESTAMP accepts 1970-01-01 00:00:01..2038-01-19 03:14:07 UTC and rejects 2038-01-20 (1292)", func(e *Env) {
			e.Exec(utc, "CREATE TABLE t (ts timestamp NULL)", "INSERT INTO t VALUES ('2038-01-19 03:14:07'), ('1970-01-01 00:00:01')")
			e.Fails("INSERT INTO t VALUES ('2038-01-20 00:00:00')", "1292")
			e.Fails("INSERT INTO t VALUES ('1970-01-01 00:00:00')", "1292")
		}),
		p("timestamp.session_time_zone", "TIMESTAMP converts between the session time zone and UTC", func(e *Env) {
			e.Exec(utc, "CREATE TABLE t (ts timestamp NULL)", "INSERT INTO t VALUES ('2020-01-01 00:00:00')", "SET time_zone = '+09:00'")
			e.Want("SELECT ts FROM t", "2020-01-01 09:00:00")
		}),
		p("datetime.no_conversion", "DATETIME keeps the written wall-clock value when the session time zone changes", func(e *Env) {
			e.Exec(utc, "CREATE TABLE t (d datetime)", "INSERT INTO t VALUES ('2020-01-01 00:00:00')", "SET time_zone = '+09:00'")
			e.Want("SELECT d FROM t", "2020-01-01 00:00:00")
		}),
		p("datetime.offset_literal_converted", "DATETIME converts a literal with an offset to the session time zone", func(e *Env) {
			e.Exec(utc, "CREATE TABLE t (d datetime)", "INSERT INTO t VALUES ('2020-01-01 09:00:00+09:00')")
			e.Want("SELECT d FROM t", "2020-01-01 00:00:00")
		}),
		p("datetime.range", "DATETIME accepts 0001-01-01 and 9999-12-31 23:59:59", func(e *Env) {
			e.Exec("CREATE TABLE t (d datetime)", "INSERT INTO t VALUES ('0001-01-01 00:00:00'), ('9999-12-31 23:59:59')")
			e.WantRows("SELECT d FROM t ORDER BY d", "0001-01-01 00:00:00,9999-12-31 23:59:59")
		}),
		p("datetime.fraction_rounds", "DATETIME(0) rounds .5 seconds up", func(e *Env) {
			e.Exec("CREATE TABLE t (d datetime)", "INSERT INTO t VALUES ('2020-01-01 00:00:00.5')")
			e.Want("SELECT d FROM t", "2020-01-01 00:00:01")
		}),
		p("datetime.max_precision", "fractional seconds precision is at most 6 (1426)", func(e *Env) {
			e.Fails("CREATE TABLE t (d datetime(7))", "1426")
		}),
		p("datetime.default_precision_must_match", "DATETIME(6) DEFAULT CURRENT_TIMESTAMP without (6) is rejected (1067)", func(e *Env) {
			e.Fails("CREATE TABLE t (d datetime(6) DEFAULT CURRENT_TIMESTAMP)", "1067")
			e.Exec("CREATE TABLE u (d datetime(6) DEFAULT CURRENT_TIMESTAMP(6))")
		}),
		p("current_timestamp.session_time_zone", "DATETIME DEFAULT CURRENT_TIMESTAMP stores the session wall clock, so +09:00 is nine hours after +00:00", func(e *Env) {
			e.Exec("CREATE TABLE t (z varchar(3), d datetime DEFAULT CURRENT_TIMESTAMP)", utc, "INSERT INTO t (z) VALUES ('utc')",
				"SET time_zone = '+09:00'", "INSERT INTO t (z) VALUES ('kst')")
			minutes, _ := strconv.Atoi(e.Value("SELECT TIMESTAMPDIFF(MINUTE, (SELECT d FROM t WHERE z = 'utc'), (SELECT d FROM t WHERE z = 'kst'))"))
			e.Check(minutes >= 539 && minutes <= 541, "difference %d minutes", minutes)
		}),
		p("time.interval_range", "TIME is an interval from -838:59:59 to 838:59:59; 839:00:00 is rejected (1292)", func(e *Env) {
			e.Exec("CREATE TABLE t (v time)", "INSERT INTO t VALUES ('838:59:59')")
			e.Fails("INSERT INTO t VALUES ('839:00:00')", "1292")
		}),
		p("date.zero_rejected", "strict mode rejects 0000-00-00 (1292)", func(e *Env) {
			e.Exec("CREATE TABLE t (d date)")
			e.Fails("INSERT INTO t VALUES ('0000-00-00')", "1292")
		}),
		// UUID, enum and JSON.
		p("uuid.no_type", "MySQL has no UUID type (1064)", func(e *Env) {
			e.Fails("CREATE TABLE t (u uuid)", "1064")
		}),
		p("enum.rejects_unknown", "ENUM rejects a value outside its list (1265)", func(e *Env) {
			e.Exec("CREATE TABLE t (v enum('a','b'))")
			e.Fails("INSERT INTO t VALUES ('c')", "1265")
		}),
		p("enum.not_null_first_value_default", "an omitted NOT NULL ENUM without DEFAULT stores its first value", func(e *Env) {
			e.Exec("CREATE TABLE t (x int, v enum('b','a') NOT NULL)", "INSERT INTO t (x) VALUES (1)")
			e.Want("SELECT v FROM t", "b")
		}),
		p("enum.sorts_by_position", "ENUM sorts by list position, not by text", func(e *Env) {
			e.Exec("CREATE TABLE t (v enum('b','a'))", "INSERT INTO t VALUES ('a'), ('b')")
			e.WantRows("SELECT v FROM t ORDER BY v", "b,a")
		}),
		p("json.normalizes", "JSON keeps the last duplicate key and reorders members", func(e *Env) {
			e.Exec("CREATE TABLE t (j json)", `INSERT INTO t VALUES ('{"b":1,"a":1,"a":2}')`)
			e.Want("SELECT j FROM t", `{"a": 2, "b": 1}`)
		}),
		// Null, defaults and catalog text.
		p("default.catalog_text", "COLUMN_DEFAULT shows literals unquoted and expression defaults with DEFAULT_GENERATED", func(e *Env) {
			e.Exec("CREATE TABLE t (a varchar(5) DEFAULT 'x', b int DEFAULT 0, c text DEFAULT ('y'), d datetime(6) DEFAULT CURRENT_TIMESTAMP(6), u varchar(36) DEFAULT (uuid()))")
			e.WantRows("SELECT COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION",
				`x|,0|,_utf8mb4\'y\'|DEFAULT_GENERATED,CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED,uuid()|DEFAULT_GENERATED`)
		}),
		p("not_null.missing_value_rejected", "an omitted NOT NULL column without DEFAULT is rejected (1364)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int NOT NULL, b int)")
			e.Fails("INSERT INTO t (b) VALUES (1)", "1364")
		}),
		// Identity.
		p("auto_increment.explicit_value_advances", "AUTO_INCREMENT continues after an explicit larger key", func(e *Env) {
			e.Exec("CREATE TABLE t (id bigint AUTO_INCREMENT PRIMARY KEY, v int)", "INSERT INTO t VALUES (100, 1)", "INSERT INTO t (v) VALUES (2)")
			e.Want("SELECT MAX(id) FROM t", "101")
		}),
		p("auto_increment.rollback_leaves_gap", "a rolled-back insert consumes an AUTO_INCREMENT value", func(e *Env) {
			e.Exec("CREATE TABLE t (id bigint AUTO_INCREMENT PRIMARY KEY, v int)", "BEGIN", "INSERT INTO t (v) VALUES (1)", "ROLLBACK", "INSERT INTO t (v) VALUES (2)")
			e.Want("SELECT id FROM t", "2")
		}),
		p("auto_increment.requires_key", "an AUTO_INCREMENT column must be the first column of a key (1075)", func(e *Env) {
			e.Fails("CREATE TABLE t (a int AUTO_INCREMENT, b int, PRIMARY KEY (b))", "1075")
		}),
		// Generated columns.
		p("generated.catalog_expression", "VIRTUAL and STORED generated columns are reported with a normalized expression", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a+1) VIRTUAL, c int AS (a*2) STORED)")
			e.WantRows("SELECT GENERATION_EXPRESSION, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' AND ORDINAL_POSITION > 1 ORDER BY ORDINAL_POSITION",
				"(`a` + 1)|VIRTUAL GENERATED,(`a` * 2)|STORED GENERATED")
		}),
		p("generated.explicit_value_rejected", "an explicit value for a generated column is rejected (3105)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int AS (a+1))")
			e.Fails("INSERT INTO t (a, b) VALUES (1, 2)", "3105")
		}),
		// Keys and indexes.
		p("pk.name_is_primary", "a primary key constraint name is discarded; the catalog reports PRIMARY", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT pk_custom PRIMARY KEY (a))")
			e.Want("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "PRIMARY")
		}),
		p("index.primary_name_reserved", "an index cannot be named PRIMARY (1280)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)")
			e.Fails("CREATE INDEX `PRIMARY` ON t (a)", "1280")
		}),
		p("index.descending", "a DESC index key is stored and reported as COLLATION D", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int, KEY ix (a DESC, b))")
			e.WantRows("SELECT COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY SEQ_IN_INDEX", "D,A")
		}),
		p("index.partial_rejected", "MySQL has no partial index (1064)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)")
			e.Fails("CREATE INDEX ix ON t (a) WHERE a > 0", "1064")
		}),
		p("index.functional", "a functional index key has COLUMN_NAME NULL and a normalized EXPRESSION", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, KEY ix ((a+1)))")
			e.WantRows("SELECT COLUMN_NAME, EXPRESSION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "NULL|(`a` + 1)")
		}),
		p("index.prefix", "a prefix index key is reported as SUB_PART", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(100), KEY ix (v(10)))")
			e.Want("SELECT SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "10")
		}),
		p("index.name_table_scope", "index names are scoped to their table", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int, KEY ix (a))", "CREATE TABLE t2 (a int, KEY ix (a))")
		}),
		p("index.name_max_length", "an index name over 64 characters is rejected (1059)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE INDEX "+strings.Repeat("i", 64)+" ON t (a)")
			e.Fails("CREATE INDEX "+strings.Repeat("j", 65)+" ON t (a)", "1059")
		}),
		p("unique.nulls_distinct", "a unique key accepts several NULLs", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, UNIQUE KEY uq (a))", "INSERT INTO t VALUES (NULL), (NULL)")
		}),
		p("check.name_schema_scope", "CHECK names are unique in the database (3822)", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int, CONSTRAINT ck CHECK (a > 0))")
			e.Fails("CREATE TABLE t2 (a int, CONSTRAINT ck CHECK (a > 0))", "3822")
		}),
		p("fk.name_schema_scope", "foreign key names are unique in the database (1826)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE c1 (pid int, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id))")
			e.Fails("CREATE TABLE c2 (pid int, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id))", "1826")
		}),
		// Collation.
		p("collation.default_accent_case_insensitive", "the default utf8mb4 collation utf8mb4_0900_ai_ci makes a = A = á in a unique key (1062)", func(e *Env) {
			e.Want("SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()", "utf8mb4_0900_ai_ci")
			e.Exec("CREATE TABLE t (v varchar(5), UNIQUE KEY uq (v)) DEFAULT CHARSET=utf8mb4", "INSERT INTO t VALUES ('a')")
			e.Want("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "utf8mb4_0900_ai_ci")
			e.Fails("INSERT INTO t VALUES ('A')", "1062")
			e.Fails("INSERT INTO t VALUES ('á')", "1062")
		}),
		p("collation.utf8mb4_bin_pads", "utf8mb4_bin is PAD SPACE: 'a' and 'a ' collide in a unique key (1062)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(5) COLLATE utf8mb4_bin, UNIQUE KEY uq (v))", "INSERT INTO t VALUES ('a'), ('A')")
			e.Fails("INSERT INTO t VALUES ('a ')", "1062")
		}),
		p("collation.utf8mb4_0900_bin_codepoint", "utf8mb4_0900_bin is NO PAD and orders by code point", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(5) COLLATE utf8mb4_0900_bin, UNIQUE KEY uq (v))",
				"INSERT INTO t VALUES ('a'), ('a '), ('A'), ('á'), ('B'), ('Z'), ('_')")
			e.WantRows("SELECT CONCAT('[', v, ']') FROM t ORDER BY v", "[A],[B],[Z],[_],[a],[a ],[á]")
			e.Want("SELECT CONCAT(CHARACTER_SET_NAME, ' ', COLLATION_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "utf8mb4 utf8mb4_0900_bin")
		}),
		// Foreign keys.
		p("fk.set_default_acts_as_restrict", "InnoDB accepts and records ON DELETE SET DEFAULT but rejects the parent delete (1451)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "INSERT INTO p VALUES (0), (1)",
				"CREATE TABLE c (pid int DEFAULT 0, FOREIGN KEY (pid) REFERENCES p (id) ON DELETE SET DEFAULT)", "INSERT INTO c VALUES (1)")
			e.Want("SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "SET DEFAULT")
			e.Fails("DELETE FROM p WHERE id = 1", "1451")
		}),
		p("fk.deferrable_rejected", "MySQL has no DEFERRABLE foreign key (1064)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)")
			e.Fails("CREATE TABLE c (pid int, FOREIGN KEY (pid) REFERENCES p (id) DEFERRABLE INITIALLY DEFERRED)", "1064")
		}),
		p("fk.match_full_not_enforced", "MATCH FULL is recorded as MATCH_OPTION FULL, omitted by SHOW CREATE TABLE, and a partly NULL key is accepted", func(e *Env) {
			e.Exec("CREATE TABLE p (a int, b int, PRIMARY KEY (a, b))", "INSERT INTO p VALUES (1, 1)",
				"CREATE TABLE c (a int, b int, CONSTRAINT fk FOREIGN KEY (a, b) REFERENCES p (a, b) MATCH FULL ON DELETE CASCADE)",
				"INSERT INTO c VALUES (1, NULL), (1, 1)", "DELETE FROM p")
			e.Want("SELECT MATCH_OPTION FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "FULL")
			e.Want("SELECT COUNT(*) FROM c", "1")
			var table, create string
			if e.Err == nil {
				if err := e.Conn.QueryRowContext(e.Ctx, "SHOW CREATE TABLE c").Scan(&table, &create); err != nil {
					e.fail("SHOW CREATE TABLE c: %v", err)
				}
			}
			e.Check(!strings.Contains(create, "MATCH"), "SHOW CREATE TABLE contains MATCH: %s", create)
		}),
		p("fk.rule_catalog", "REFERENTIAL_CONSTRAINTS reports an omitted action as NO ACTION and a written RESTRICT as RESTRICT", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)",
				"CREATE TABLE c (a int, b int, CONSTRAINT fk_a FOREIGN KEY (a) REFERENCES p (id), CONSTRAINT fk_b FOREIGN KEY (b) REFERENCES p (id) ON DELETE RESTRICT ON UPDATE CASCADE)")
			e.WantRows("SELECT CONCAT(UPDATE_RULE, ' ', DELETE_RULE) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME", "NO ACTION NO ACTION,CASCADE RESTRICT")
		}),
		p("fk.child_index_created", "a foreign key creates an index on the child columns named after the constraint", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE c (pid int, CONSTRAINT fk_c FOREIGN KEY (pid) REFERENCES p (id))")
			e.Want("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'c'", "fk_c")
		}),
		p("fk.type_mismatch_rejected", "an INT column cannot reference a BIGINT key (3780)", func(e *Env) {
			e.Exec("CREATE TABLE p (id bigint PRIMARY KEY)")
			e.Fails("CREATE TABLE c (pid int, FOREIGN KEY (pid) REFERENCES p (id))", "3780")
		}),
		p("fk.cascade_skips_triggers", "a row deleted by ON DELETE CASCADE does not fire the child's DELETE trigger", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)",
				"CREATE TABLE c (id int PRIMARY KEY, pid int, FOREIGN KEY (pid) REFERENCES p (id) ON DELETE CASCADE)",
				"CREATE TABLE log (id int)",
				"CREATE TRIGGER c_del AFTER DELETE ON c FOR EACH ROW INSERT INTO log VALUES (OLD.id)",
				"INSERT INTO p VALUES (1)", "INSERT INTO c VALUES (10, 1)", "DELETE FROM p WHERE id = 1")
			e.Want("SELECT COUNT(*) FROM c", "0")
			e.Want("SELECT COUNT(*) FROM log", "0")
		}),
		// CHECK.
		p("check.enforced_null_passes", "CHECK is enforced (3819) and NULL passes", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a > 0))", "INSERT INTO t VALUES (NULL), (1)")
			e.Fails("INSERT INTO t VALUES (0)", "3819")
		}),
		p("check.not_enforced_option", "CHECK ... NOT ENFORCED is stored and not applied", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a > 0) NOT ENFORCED)", "INSERT INTO t VALUES (0)")
			e.Want("SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'ck'", "NO")
		}),
		p("check.catalog_text", "CHECK_CLAUSE is normalized text with quoted identifiers", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, v varchar(5), CONSTRAINT ck1 CHECK (a IN (1,2)), CONSTRAINT ck2 CHECK (v IN ('x','y')))")
			e.WantRows("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME",
				"(`a` in (1,2)),(`v` in (_utf8mb4\\'x\\',_utf8mb4\\'y\\'))")
		}),
		p("check.bool_column_rejected", "a bool column alone is not a CHECK expression (3812)", func(e *Env) {
			e.Fails("CREATE TABLE t (f tinyint(1), CONSTRAINT ck CHECK (f))", "3812")
		}),
		p("check.not_pushed_down", "CHECK_CLAUSE pushes NOT into comparisons, IS NULL and AND or OR (De Morgan)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int, CONSTRAINT ck1 CHECK (NOT (a > 1 AND b < 2)), CONSTRAINT ck2 CHECK (NOT (b IS NULL)))")
			e.WantRows("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME",
				"((`a` <= 1) or (`b` >= 2)),(`b` is not null)")
		}),
		p("check.between_kept", "CHECK_CLAUSE keeps BETWEEN and writes a negative literal as -(n)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a BETWEEN -5 AND 5))")
			e.Want("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "(`a` between -(5) and 5)")
		}),
		p("check.string_escaped_twice", "CHECK_CLAUSE escapes a string literal as MySQL text and then escapes that text again", func(e *Env) {
			e.Exec("CREATE TABLE t (s varchar(32), CONSTRAINT ck CHECK (s <> 'it''s \\\\ x'))")
			e.Want("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "(`s` <> _utf8mb4\\'it\\\\\\'s \\\\\\\\ x\\')")
		}),
		p("check.alter_rewrites_introducers", "ALTER TABLE writes CHECK_CLAUSE again: a literal that meets an ascii column takes _ascii and a literal that meets a time column loses its introducer", func(e *Env) {
			const q = "SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME"
			e.Exec("CREATE TABLE t (a char(36) CHARACTER SET ascii COLLATE ascii_bin, t time, CONSTRAINT ck1 CHECK (REGEXP_LIKE(a, '^x$', 'c')), CONSTRAINT ck2 CHECK (t < '24:00:00'))")
			e.WantRows(q, "regexp_like(`a`,_utf8mb4\\'^x$\\',_utf8mb4\\'c\\'),(`t` < _utf8mb4\\'24:00:00\\')")
			e.Exec("ALTER TABLE t ADD INDEX ix (t)")
			e.WantRows(q, "regexp_like(`a`,_ascii\\'^x$\\',_utf8mb4\\'c\\'),(`t` < \\'24:00:00\\')")
		}),
		p("check.alter_writes_time_precision", "ALTER TABLE writes a time literal that meets a time(p) column with p fraction digits", func(e *Env) {
			e.Exec("CREATE TABLE t (a time(3), CONSTRAINT ck CHECK (a < '24:00:00'))", "ALTER TABLE t ADD INDEX ix (a)")
			e.Want("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "(`a` < \\'24:00:00.000\\')")
		}),
		p("check.fk_action_column_rejected", "a column of a foreign key with a referential action cannot appear in a CHECK (3823)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)")
			e.Fails("CREATE TABLE c (pid int, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id) ON DELETE SET NULL, CONSTRAINT ck CHECK (pid > 0))", "3823")
		}),
		p("check.nondeterministic_rejected", "a CHECK cannot call NOW() (3814)", func(e *Env) {
			e.Fails("CREATE TABLE t (d datetime, CONSTRAINT ck CHECK (d < NOW()))", "3814")
		}),
		// Comments.
		p("comment.column_limit", "a column comment is at most 1024 characters (1629)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int COMMENT '" + strings.Repeat("c", 1024) + "')")
			e.Fails("CREATE TABLE u (a int COMMENT '"+strings.Repeat("c", 1025)+"')", "1629")
		}),
		p("comment.table_limit", "a table comment is at most 2048 characters (1628)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int) COMMENT '" + strings.Repeat("c", 2048) + "'")
			e.Fails("CREATE TABLE u (a int) COMMENT '"+strings.Repeat("c", 2049)+"'", "1628")
		}),
		// Identifiers.
		p("ident.max_length", "a table name is at most 64 characters (1059)", func(e *Env) {
			e.Exec("CREATE TABLE " + strings.Repeat("t", 64) + " (a int)")
			e.Fails("CREATE TABLE "+strings.Repeat("u", 65)+" (a int)", "1059")
		}),
		p("ident.column_case_insensitive", "column names are case-insensitive (1060)", func(e *Env) {
			e.Fails("CREATE TABLE t (a int, A int)", "1060")
		}),
		p("ident.table_case_server_setting", "with lower_case_table_names=1, Foo is stored as foo and foo is the same table (1050)", func(e *Env) {
			e.Want("SELECT @@lower_case_table_names", "1")
			e.Exec("CREATE TABLE Foo (a int)")
			e.Want("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'foo'", "foo")
			e.Fails("CREATE TABLE foo (a int)", "1050")
		}),
		// Update-time stamping.
		p("on_update.fires_on_change", "ON UPDATE CURRENT_TIMESTAMP sets the column when another column changes", func(e *Env) {
			e.Exec("CREATE TABLE t (id int PRIMARY KEY, a int, ts datetime(6) DEFAULT '2000-01-01 00:00:00' ON UPDATE CURRENT_TIMESTAMP(6))",
				"INSERT INTO t (id, a) VALUES (1, 1)", "UPDATE t SET a = 2")
			e.Want("SELECT ts <> '2000-01-01 00:00:00' FROM t", "1")
		}),
		p("on_update.skipped_when_unchanged", "ON UPDATE CURRENT_TIMESTAMP does not fire when no column value changes", func(e *Env) {
			e.Exec("CREATE TABLE t (id int PRIMARY KEY, a int, ts datetime(6) DEFAULT '2000-01-01 00:00:00' ON UPDATE CURRENT_TIMESTAMP(6))",
				"INSERT INTO t (id, a) VALUES (1, 1)", "UPDATE t SET a = 1", "UPDATE t SET a = a")
			e.Want("SELECT ts FROM t", "2000-01-01 00:00:00.000000")
		}),
		p("on_update.explicit_value_kept", "an explicit value for the ON UPDATE column wins", func(e *Env) {
			e.Exec("CREATE TABLE t (id int PRIMARY KEY, a int, ts datetime(6) DEFAULT '2000-01-01 00:00:00' ON UPDATE CURRENT_TIMESTAMP(6))",
				"INSERT INTO t (id, a) VALUES (1, 1)", "UPDATE t SET a = 2, ts = '2001-01-01 00:00:00'")
			e.Want("SELECT ts FROM t", "2001-01-01 00:00:00.000000")
		}),
		// Triggers.
		p("trigger.no_statement_level", "MySQL has no FOR EACH STATEMENT trigger (1064)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)")
			e.Fails("CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH STATEMENT SET @x = 1", "1064")
		}),
		p("trigger.no_truncate_event", "MySQL has no TRUNCATE trigger event (1064)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)")
			e.Fails("CREATE TRIGGER tg BEFORE TRUNCATE ON t FOR EACH ROW SET @x = 1", "1064")
		}),
		p("trigger.truncate_skips_delete_trigger", "TRUNCATE TABLE does not fire DELETE triggers", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE TABLE log (a int)",
				"CREATE TRIGGER tg AFTER DELETE ON t FOR EACH ROW INSERT INTO log VALUES (OLD.a)",
				"INSERT INTO t VALUES (1), (2)", "TRUNCATE TABLE t")
			e.Want("SELECT COUNT(*) FROM log", "0")
		}),
		p("trigger.zero_rows_not_fired", "a row trigger does not fire for an UPDATE that matches no row", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)",
				"CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable'",
				"UPDATE t SET a = 1 WHERE a = 0")
		}),
		p("trigger.new_assignable", "a BEFORE UPDATE trigger can assign NEW columns", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, ts datetime)", "INSERT INTO t VALUES (1, NULL)",
				"CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW SET NEW.ts = '2001-01-01 00:00:00'", "UPDATE t SET a = 2")
			e.Want("SELECT ts FROM t", "2001-01-01 00:00:00")
		}),
		p("trigger.update_fires_when_unchanged", "a BEFORE UPDATE row trigger fires when no value changes", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, ts datetime)", "INSERT INTO t VALUES (1, '2000-01-01 00:00:00')",
				"CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW SET NEW.ts = '2001-01-01 00:00:00'", "UPDATE t SET a = a")
			e.Want("SELECT ts FROM t", "2001-01-01 00:00:00")
		}),
		p("trigger.body_catalog_verbatim", "ACTION_STATEMENT returns the trigger body exactly as written, comments included", func(e *Env) {
			body := "BEGIN\n  -- note\n  SET NEW.a = NEW.a + 1;\nEND"
			e.Exec("CREATE TABLE t (a int)", "CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW "+body)
			e.Want("SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()", body)
			e.Want("SELECT CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION, ' ', ACTION_ORIENTATION) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()", "BEFORE INSERT ROW")
		}),
		p("trigger.name_schema_scope", "trigger names are unique in the database (1359)", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int)", "CREATE TABLE t2 (a int)", "CREATE TRIGGER tg BEFORE INSERT ON t1 FOR EACH ROW SET @x = 1")
			e.Fails("CREATE TRIGGER tg BEFORE INSERT ON t2 FOR EACH ROW SET @x = 1", "1359")
		}),
		p("trigger.binlog_privilege_1419", "with binary logging on and log_bin_trust_function_creators=0, a login without SUPER cannot create a trigger (1419)", func(e *Env) {
			e.Want("SELECT @@log_bin", "1")
			e.Want("SELECT @@log_bin_trust_function_creators", "0")
			e.Exec("CREATE TABLE t (a int)")
			if e.Err != nil {
				return
			}
			user := "'" + e.Name + "'@'127.0.0.1'"
			for _, s := range []string{"CREATE USER " + user + " IDENTIFIED BY ''", "GRANT ALL ON `" + e.Name + "`.* TO " + user} {
				if _, err := e.Admin.ExecContext(e.Ctx, s); err != nil {
					e.fail("%s: %v", s, err)
					return
				}
			}
			cfg := mysql.NewConfig()
			cfg.User, cfg.Net, cfg.Addr, cfg.DBName = e.Name, "tcp", e.Extra["addr"], e.Name
			conn, closeDB, err := openMySQLConn(e.Ctx, cfg)
			if err != nil {
				e.fail("connect as %s: %v", user, err)
				return
			}
			defer closeDB()
			other := &Env{Ctx: e.Ctx, Conn: conn, DB: "mysql"}
			other.Fails("CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW SET @x = 1", "1419")
			e.Merge(other)
		}),
		// Audit context.
		p("context.user_variable_session_scope", "a user variable read by a trigger survives COMMIT for the rest of the session", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE TABLE log (op varchar(10))",
				"CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW INSERT INTO log VALUES (@`orm.op`)",
				"BEGIN", "SET @`orm.op` = 'x'", "INSERT INTO t VALUES (1)", "COMMIT")
			e.Want("SELECT op FROM log", "x")
			e.Want("SELECT @`orm.op`", "x")
			other := e.Other()
			other.Want("SELECT @`orm.op`", "NULL")
			e.Merge(other)
		}),
		// DDL transactions.
		p("ddl.implicit_commit", "CREATE TABLE commits the open transaction", func(e *Env) {
			e.Exec("CREATE TABLE a (v int)", "BEGIN", "INSERT INTO a VALUES (1)", "CREATE TABLE b (v int)", "ROLLBACK")
			e.Want("SELECT COUNT(*) FROM a", "1")
		}),
		p("ddl.atomic_statement", "a failed DROP TABLE of two tables drops neither (1051)", func(e *Env) {
			e.Exec("CREATE TABLE a (v int)")
			e.Fails("DROP TABLE a, missing", "1051")
			e.Want("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'a'", "1")
		}),
		// Proposed neutral renderings.
		p("render.bool_check", "TINYINT(1) with CHECK (b IN (0,1)) rejects 2 (3819)", func(e *Env) {
			e.Exec("CREATE TABLE t (b tinyint(1), CONSTRAINT t_b_bool CHECK (b IN (0,1)))", "INSERT INTO t VALUES (0), (1), (NULL)")
			e.Fails("INSERT INTO t VALUES (2)", "3819")
		}),
		p("render.time_of_day_check", "TIME(6) with CHECK (v >= '00:00:00' AND v < '24:00:00') accepts only a time of day (3819)", func(e *Env) {
			e.Exec("CREATE TABLE t (v time(6), CONSTRAINT t_v_time CHECK (v >= '00:00:00' AND v < '24:00:00'))", "INSERT INTO t VALUES ('23:59:59.999999'), ('00:00:00')")
			e.Fails("INSERT INTO t VALUES ('24:00:00')", "3819")
			e.Fails("INSERT INTO t VALUES ('-00:00:01')", "3819")
		}),
		p("render.datetime_utc_session", "with time_zone '+00:00', NOW(6) and a DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) value equal UTC_TIMESTAMP(6) in the same statement", func(e *Env) {
			e.Exec(utc, "CREATE TABLE t (a int, d datetime(6) DEFAULT CURRENT_TIMESTAMP(6))", "INSERT INTO t (a) VALUES (1)")
			e.Want("SELECT NOW(6) = UTC_TIMESTAMP(6)", "1")
			e.Want("SELECT d <= UTC_TIMESTAMP(6) AND d > UTC_TIMESTAMP(6) - INTERVAL 1 MINUTE FROM t", "1")
		}),
		p("render.timestamp_conversion", "MODIFY from TIMESTAMP to DATETIME in a '+00:00' session keeps the UTC wall clock of each instant", func(e *Env) {
			e.Exec("SET time_zone = '+09:00'", "CREATE TABLE t (d timestamp(6) NULL)", "INSERT INTO t VALUES ('2020-01-01 09:00:00')",
				utc, "ALTER TABLE t MODIFY d datetime(6) NULL")
			e.Want("SELECT CONCAT(COLUMN_TYPE, ' ', (SELECT d FROM t)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "datetime(6) 2020-01-01 00:00:00.000000")
		}),
		p("render.uuid_check", "CHAR(36) ascii_bin with a REGEXP_LIKE CHECK accepts only lower-case canonical UUID text (3819)", func(e *Env) {
			e.Exec("CREATE TABLE t (u char(36) CHARACTER SET ascii COLLATE ascii_bin, CONSTRAINT t_u_uuid CHECK (REGEXP_LIKE(u, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')))",
				"INSERT INTO t VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')")
			e.Fails("INSERT INTO t VALUES ('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')", "3819")
		}),
		// Views and sequences.
		p("sequence.unsupported", "MySQL has no CREATE SEQUENCE (1064)", func(e *Env) {
			e.Fails("CREATE SEQUENCE s", "1064")
		}),
		p("view.definition_rewritten", "VIEW_DEFINITION is rewritten with qualified names and aliases", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE VIEW v AS select a from t where a>1")
			want := "select `" + e.Name + "`.`t`.`a` AS `a` from `" + e.Name + "`.`t` where (`" + e.Name + "`.`t`.`a` > 1)"
			e.Want("SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()", want)
		}),
	}
}

// openMySQLConn opens one connection with cfg.
func openMySQLConn(ctx context.Context, cfg *mysql.Config) (*sql.Conn, func(), error) {
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, nil, err
	}
	db := sql.OpenDB(connector)
	conn, err := db.Conn(ctx)
	if err != nil {
		db.Close()
		return nil, nil, err
	}
	return conn, func() { conn.Close(); db.Close() }, nil
}
