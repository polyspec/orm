package dialects

import (
	"fmt"
	"strings"
)

// mariadbProbes are the facts of MariaDB 11.8, a server of the MySQL dialect (DIA-200). Each MySQL probe has a twin of the same
// topic and fact, mariadb.<topic>.<fact>, that runs its body on the MariaDB server: a twin that holds proves the MySQL fact on
// MariaDB too. Where MariaDB answers otherwise, mariadbFacts states the MariaDB fact in place of the twin under the same ID, so
// the difference is a probe of its own and the rules of docs/spec/dialects.md cite it.
func mariadbProbes() []Probe {
	own := map[string]Probe{}
	for _, probe := range mariadbFacts() {
		own[probe.ID] = probe
	}
	var probes []Probe
	for _, twin := range mysqlProbes() {
		id := "mariadb." + strings.TrimPrefix(twin.ID, "mysql.")
		if probe, ok := own[id]; ok {
			probes = append(probes, probe)
			delete(own, id)
			continue
		}
		probes = append(probes, Probe{ID: id, DB: "mariadb", Fact: twin.Fact, Fixture: twin.Fixture, Run: twin.Run})
	}
	// The facts of MariaDB that no MySQL probe has a twin of.
	for _, probe := range mariadbFacts() {
		if _, ok := own[probe.ID]; ok {
			probes = append(probes, probe)
		}
	}
	return probes
}

// mariadbFacts are the MariaDB probes whose fact differs from the MySQL twin, and the probes MariaDB alone has.
func mariadbFacts() []Probe {
	p := func(id, fact string, run func(e *Env)) Probe {
		return Probe{ID: "mariadb." + id, DB: "mariadb", Fact: fact, Run: run}
	}
	return []Probe{
		p("env.server", "the server is MariaDB 11.8 in strict mode with lower_case_table_names=1", mysqlFamilyServer(func(version string) bool {
			return strings.HasPrefix(version, "11.8.") && strings.Contains(version, "-MariaDB")
		})),
		p("check.drop_constraint_shared_name", "a CHECK cannot share its name with a foreign key or a unique key of its table (1826), so DROP CONSTRAINT names one constraint", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)")
			e.Fails("CREATE TABLE c (id int PRIMARY KEY, pid int, a int, CONSTRAINT x FOREIGN KEY (pid) REFERENCES p (id), CONSTRAINT x CHECK (a > 0))", "1826")
			e.Fails("CREATE TABLE u (a int, CONSTRAINT y UNIQUE (a), CONSTRAINT y CHECK (a > 0))", "1826")
		}),
		p("session.statement_timeout", "MariaDB has no max_execution_time (1193): SESSION max_statement_time bounds every statement in seconds (1969)", func(e *Env) {
			e.Fails("SET SESSION max_execution_time = 237", "1193")
			e.Exec("SET SESSION max_statement_time = 0.237")
			e.Want("SELECT @@SESSION.max_statement_time", "0.237")
			e.Exec("CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)", "BEGIN", "UPDATE t SET id = 1 WHERE id = 1")
			other := e.Other()
			other.Exec("SET SESSION max_statement_time = 0.02")
			other.Fails("SELECT COUNT(*) FROM information_schema.COLLATIONS a, information_schema.COLLATIONS b, information_schema.COLLATIONS c", "1969")
			other.Fails("UPDATE t SET id = 1 WHERE id = 1", "1969")
			e.Merge(other)
			e.Exec("ROLLBACK")
		}),
		p("lock.share_clause", "LOCK IN SHARE MODE takes a shared row lock and takes NOWAIT, and MariaDB has no FOR SHARE (1064)", func(e *Env) {
			e.Exec("CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)", "BEGIN")
			e.Want("SELECT id FROM t WHERE id = 1 LOCK IN SHARE MODE", "1")
			e.Want("SELECT id FROM t WHERE id = 1 LOCK IN SHARE MODE NOWAIT", "1")
			e.Fails("SELECT id FROM t WHERE id = 1 FOR SHARE", "1064")
			e.Fails("SELECT id FROM t WHERE id = 1 FOR SHARE NOWAIT", "1064")
			e.Exec("ROLLBACK")
		}),
		p("catalog.key_ordinal_by_name", "a subquery that names the table by constants reads the primary-key ordinal as the join does, and only the join opens every table of every database", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int, c int, PRIMARY KEY (b, a))")
			database := e.Value("SELECT DATABASE()")
			e.WantRows(fmt.Sprintf(keyOrdinalJoin, database), "a|2,b|1,c|0")
			e.WantRows(fmt.Sprintf(keyOrdinalByName, database), "a|2,b|1,c|0")
			join := e.Column("EXPLAIN " + fmt.Sprintf(keyOrdinalJoin, database))
			e.Check(strings.Contains(join, "Scanned all databases"), "the join reads KEY_COLUMN_USAGE by name: %s", join)
			byName := e.Column("EXPLAIN " + fmt.Sprintf(keyOrdinalByName, database))
			e.Check(!strings.Contains(byName, "Scanned all databases") && strings.Count(byName, "Scanned 0 databases") == 2, "the subquery scans more than its table: %s", byName)
		}),
		p("lock.nowait_held", "a NOWAIT read of a row that another transaction locks fails at once with 1205, the number of a lock wait timeout", func(e *Env) {
			e.Exec("CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)", "BEGIN", "UPDATE t SET id = 1 WHERE id = 1")
			other := e.Other()
			other.Exec("BEGIN")
			other.Fails("SELECT id FROM t WHERE id = 1 FOR UPDATE NOWAIT", "1205")
			other.Fails("SELECT id FROM t WHERE id = 1 LOCK IN SHARE MODE NOWAIT", "1205")
			other.Exec("ROLLBACK")
			e.Merge(other)
			e.Exec("ROLLBACK")
		}),
		// Integers and numbers.
		p("int.display_width_dropped", "COLUMN_TYPE keeps the integer display width: int(11), tinyint(1), bigint(20)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int(11), b tinyint(1), c bigint(20), d int)")
			e.WantRows("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION", "int(11),tinyint(1),bigint(20),int(11)")
		}),
		p("decimal.precision_limits", "DECIMAL precision is at most 65 (1426) and scale at most 38 (1425), so DECIMAL(65,31) is accepted", func(e *Env) {
			e.Exec("CREATE TABLE t (d decimal(65,30))", "CREATE TABLE v (d decimal(65,38))")
			e.Fails("CREATE TABLE u (d decimal(66,0))", "1426")
			e.Fails("CREATE TABLE w (d decimal(65,39))", "1425")
		}),
		// Strings.
		p("text.literal_default_needs_expression", "TEXT accepts DEFAULT 'x' and DEFAULT ('x'), and COLUMN_DEFAULT reports both as the quoted literal", func(e *Env) {
			e.Exec("CREATE TABLE t (v text DEFAULT 'x', w text DEFAULT ('x'))")
			e.WantRows("SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION", "'x','x'")
		}),
		p("text.index_needs_prefix", "an index on TEXT without a prefix length is accepted with the prefix of 768 characters, which STATISTICS reports as SUB_PART", func(e *Env) {
			e.Exec("CREATE TABLE t (v text, KEY ix (v))")
			e.Want("SELECT SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "768")
		}),
		p("index.max_key_bytes", "an index on a utf8mb4 VARCHAR(769), beyond 3072 bytes, is accepted", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(768), KEY ix (v)) DEFAULT CHARSET=utf8mb4", "CREATE TABLE u (v varchar(769), KEY ix (v)) DEFAULT CHARSET=utf8mb4")
		}),
		// Date and time.
		p("timestamp.range_2038", "TIMESTAMP accepts 1970-01-01 00:00:01..2106-02-07 06:28:15 UTC and rejects 1970-01-01 00:00:00 and 2106-02-07 06:28:16 (1292)", func(e *Env) {
			e.Exec("SET time_zone = '+00:00'", "CREATE TABLE t (ts timestamp NULL)", "INSERT INTO t VALUES ('2038-01-20 00:00:00'), ('2106-02-07 06:28:15'), ('1970-01-01 00:00:01')")
			e.Fails("INSERT INTO t VALUES ('2106-02-07 06:28:16')", "1292")
			e.Fails("INSERT INTO t VALUES ('1970-01-01 00:00:00')", "1292")
		}),
		p("datetime.offset_literal_converted", "DATETIME rejects a literal with an offset (1292)", func(e *Env) {
			e.Exec("SET time_zone = '+00:00'", "CREATE TABLE t (d datetime)")
			e.Fails("INSERT INTO t VALUES ('2020-01-01 09:00:00+09:00')", "1292")
		}),
		p("datetime.fraction_rounds", "DATETIME(0) truncates .5 seconds", func(e *Env) {
			e.Exec("CREATE TABLE t (d datetime)", "INSERT INTO t VALUES ('2020-01-01 00:00:00.5'), ('2020-01-01 00:00:01.999999')")
			e.WantRows("SELECT d FROM t ORDER BY d", "2020-01-01 00:00:00,2020-01-01 00:00:01")
		}),
		p("datetime.default_precision_must_match", "DATETIME(6) DEFAULT CURRENT_TIMESTAMP without (6) is accepted as CURRENT_TIMESTAMP(6), which COLUMN_DEFAULT reports", func(e *Env) {
			e.Exec("CREATE TABLE t (d datetime(6) DEFAULT CURRENT_TIMESTAMP)")
			e.Want("SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "current_timestamp(6)")
		}),
		p("date.zero_rejected", "the default sql_mode of MariaDB accepts 0000-00-00, and NO_ZERO_DATE with strict mode rejects it (1292)", func(e *Env) {
			e.Exec("CREATE TABLE t (d date)", "INSERT INTO t VALUES ('0000-00-00')")
			e.Exec("SET SESSION sql_mode = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'")
			e.Fails("INSERT INTO t VALUES ('0000-00-00')", "1292")
		}),
		// UUID and JSON.
		p("uuid.no_type", "MariaDB has a UUID type, reported as DATA_TYPE uuid, whose ORDER BY is not the order of its text", func(e *Env) {
			e.Exec("CREATE TABLE t (u uuid)", "INSERT INTO t VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')")
			e.Want("SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "uuid")
			e.Want("SELECT u FROM t", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")
			e.Exec("CREATE TABLE o (u uuid)", "INSERT INTO o VALUES ('ffffffff-0000-4000-8000-000000000000'), ('0000000f-0000-4000-8000-000000000000'), ('7f000000-ffff-4fff-bfff-000000000001'), ('00000000-0000-4000-8000-00000000000f')")
			e.WantRows("SELECT u FROM o ORDER BY u", "0000000f-0000-4000-8000-000000000000,ffffffff-0000-4000-8000-000000000000,7f000000-ffff-4fff-bfff-000000000001,00000000-0000-4000-8000-00000000000f")
		}),
		p("json.normalizes", "JSON is LONGTEXT with a JSON_VALID CHECK: the text is kept as written, duplicate keys and member order included", func(e *Env) {
			e.Exec("CREATE TABLE t (j json)", `INSERT INTO t VALUES ('{"b":1,"a":1,"a":2}')`)
			e.Want("SELECT j FROM t", `{"b":1,"a":1,"a":2}`)
			e.Want("SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "longtext")
		}),
		// Defaults and generated columns.
		p("default.catalog_text", "COLUMN_DEFAULT quotes a literal with its SQL escapes, writes NULL for a NULL default, an expression default as its text and the clock as current_timestamp(p), and EXTRA has no DEFAULT_GENERATED", func(e *Env) {
			e.Exec("CREATE TABLE t (a varchar(5) DEFAULT 'x', b int DEFAULT 0, c text DEFAULT ('y'), d datetime(6) DEFAULT CURRENT_TIMESTAMP(6), u varchar(36) DEFAULT (uuid()), n varchar(5) DEFAULT NULL, s varchar(5) DEFAULT 'NULL', m int NOT NULL, k datetime DEFAULT CURRENT_TIMESTAMP, q varchar(9) DEFAULT 'a''b\\\\c\\n', r text DEFAULT 'a''b\\\\c', g decimal(5,2) DEFAULT -7.50)")
			e.WantRows("SELECT COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION",
				`'x'|,0|,'y'|,current_timestamp(6)|,uuid()|,NULL|,'NULL'|,NULL|,current_timestamp()|,'a''b\\c\n'|,'a\'b\\c'|,-7.50|`)
			e.Want("SELECT COLUMN_DEFAULT IS NULL FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' AND COLUMN_NAME = 'n'", "0")
			e.Want("SELECT COLUMN_DEFAULT IS NULL FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' AND COLUMN_NAME = 'm'", "1")
		}),
		p("generated.catalog_expression", "VIRTUAL and STORED generated columns are reported with their expression without outer parentheses", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a+1) VIRTUAL, c int AS (a*2) STORED)")
			e.WantRows("SELECT GENERATION_EXPRESSION, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION",
				"NULL|,`a` + 1|VIRTUAL GENERATED,`a` * 2|STORED GENERATED")
		}),
		p("generated.explicit_value_rejected", "an explicit value for a generated column is rejected in strict mode (1906)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int AS (a+1))")
			e.Fails("INSERT INTO t (a, b) VALUES (1, 2)", "1906")
		}),
		// Indexes.
		p("index.functional", "MariaDB has no functional index key (1064), and STATISTICS has no EXPRESSION column (1054)", func(e *Env) {
			e.Fails("CREATE TABLE t (a int, KEY ix ((a+1)))", "1064")
			e.Fails("SELECT EXPRESSION FROM information_schema.STATISTICS", "1054")
			e.Exec("CREATE TABLE u (a int, KEY ix (a))")
			e.Want("SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'u' AND COLUMN_NAME IS NULL", "0")
		}),
		// Faults and constraint names.
		p("fault.check_before_unique", "a row that breaks a CHECK and a unique key is refused with the CHECK fault, 4025 of SQLSTATE 23000", func(e *Env) {
			e.Exec("CREATE TABLE t (id int PRIMARY KEY, a int CHECK (a > 0))", "INSERT INTO t VALUES (1, 1)")
			e.Fails("INSERT INTO t VALUES (1, -1)", "4025")
			e.Fails("INSERT INTO t VALUES (1, 2)", "1062")
		}),
		p("check.name_schema_scope", "CHECK names are scoped to their table: two tables may each have a CHECK ck", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int, CONSTRAINT ck CHECK (a > 0))", "CREATE TABLE t2 (a int, CONSTRAINT ck CHECK (a > 0))")
			e.Want("SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'ck'", "2")
		}),
		p("fk.name_schema_scope", "foreign key names are unique in the database: a second fk is refused with 1005 (errno 121)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE c1 (pid int, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id))")
			e.Fails("CREATE TABLE c2 (pid int, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id))", "1005")
		}),
		// Collation.
		p("collation.default_accent_case_insensitive", "the default utf8mb4 collation utf8mb4_uca1400_ai_ci makes a = A = á in a unique key (1062)", func(e *Env) {
			e.Want("SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()", "utf8mb4_uca1400_ai_ci")
			e.Exec("CREATE TABLE t (v varchar(5), UNIQUE KEY uq (v)) DEFAULT CHARSET=utf8mb4", "INSERT INTO t VALUES ('a')")
			e.Want("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'", "utf8mb4_uca1400_ai_ci")
			e.Fails("INSERT INTO t VALUES ('A')", "1062")
			e.Fails("INSERT INTO t VALUES ('á')", "1062")
		}),
		// Foreign keys.
		p("fk.set_default_acts_as_restrict", "InnoDB accepts ON DELETE SET DEFAULT, records it as RESTRICT and rejects the parent delete (1451)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "INSERT INTO p VALUES (0), (1)",
				"CREATE TABLE c (pid int DEFAULT 0, FOREIGN KEY (pid) REFERENCES p (id) ON DELETE SET DEFAULT)", "INSERT INTO c VALUES (1)")
			e.Want("SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "RESTRICT")
			e.Fails("DELETE FROM p WHERE id = 1", "1451")
		}),
		p("fk.match_full_not_enforced", "MATCH FULL is recorded as MATCH_OPTION NONE, omitted by SHOW CREATE TABLE, and a partly NULL key is accepted", matchFullNotEnforced("NONE")),
		p("fk.rule_catalog", "REFERENTIAL_CONSTRAINTS reports an omitted action as RESTRICT and a written RESTRICT as RESTRICT", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)",
				"CREATE TABLE c (a int, b int, CONSTRAINT fk_a FOREIGN KEY (a) REFERENCES p (id), CONSTRAINT fk_b FOREIGN KEY (b) REFERENCES p (id) ON DELETE RESTRICT ON UPDATE CASCADE)")
			e.WantRows("SELECT CONCAT(UPDATE_RULE, ' ', DELETE_RULE) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME", "RESTRICT RESTRICT,CASCADE RESTRICT")
		}),
		p("fk.type_mismatch_rejected", "an INT column cannot reference a BIGINT key: 1005 (errno 150)", func(e *Env) {
			e.Exec("CREATE TABLE p (id bigint PRIMARY KEY)")
			e.Fails("CREATE TABLE c (pid int, FOREIGN KEY (pid) REFERENCES p (id))", "1005")
		}),
		// CHECK.
		p("check.enforced_null_passes", "CHECK is enforced (4025, SQLSTATE 23000) and NULL passes", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a > 0))", "INSERT INTO t VALUES (NULL), (1)")
			e.Fails("INSERT INTO t VALUES (0)", "4025")
		}),
		p("check.number_4025_not_a_check", "4025 is the CHECK fault on MariaDB, which has no AUTOEXTEND_SIZE (1064)", func(e *Env) {
			e.Fails("CREATE TABLE t (a int) AUTOEXTEND_SIZE=1M", "1064")
			e.Exec("CREATE TABLE u (a int, CONSTRAINT ck CHECK (a > 0))")
			e.Fails("INSERT INTO u VALUES (0)", "4025")
		}),
		p("check.not_enforced_option", "MariaDB has no NOT ENFORCED CHECK (1064), and TABLE_CONSTRAINTS has no ENFORCED column (1054)", func(e *Env) {
			e.Fails("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a > 0) NOT ENFORCED)", "1064")
			e.Fails("SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS", "1054")
		}),
		p("check.catalog_text", "CHECK_CLAUSE is the expression without outer parentheses and without a character set introducer", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, v varchar(5), CONSTRAINT ck1 CHECK (a IN (1,2)), CONSTRAINT ck2 CHECK (v IN ('x','y')))")
			e.WantRows("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME",
				"`a` in (1,2),`v` in ('x','y')")
		}),
		p("check.bool_column_rejected", "a bool column alone is a CHECK expression, which refuses 0 (4025)", func(e *Env) {
			e.Exec("CREATE TABLE t (f tinyint(1), CONSTRAINT ck CHECK (f))", "INSERT INTO t VALUES (1)")
			e.Fails("INSERT INTO t VALUES (0)", "4025")
		}),
		p("check.not_pushed_down", "CHECK_CLAUSE pushes NOT into comparisons and IS NULL and writes no inner parentheses", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int, CONSTRAINT ck1 CHECK (NOT (a > 1 AND b < 2)), CONSTRAINT ck2 CHECK (NOT (b IS NULL)))")
			e.WantRows("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME",
				"`a` <= 1 or `b` >= 2,`b` is not null")
		}),
		p("check.between_kept", "CHECK_CLAUSE keeps BETWEEN and writes a negative literal as -n", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a BETWEEN -5 AND 5))")
			e.Want("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "`a` between -5 and 5")
		}),
		p("check.string_escaped_twice", "CHECK_CLAUSE escapes a string literal once, as MariaDB text", func(e *Env) {
			e.Exec("CREATE TABLE t (s varchar(32), CONSTRAINT ck CHECK (s <> 'it''s \\\\ x'))")
			e.Want("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "`s` <> 'it\\'s \\\\ x'")
		}),
		p("check.alter_rewrites_introducers", "MariaDB has no REGEXP_LIKE (1305 outside a CHECK, 1901 in one), and ALTER TABLE leaves CHECK_CLAUSE as it was", func(e *Env) {
			const q = "SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME"
			e.Fails("SELECT REGEXP_LIKE('x', '^x$')", "1305")
			e.Fails("CREATE TABLE u (a char(36) CHARACTER SET ascii COLLATE ascii_bin, CONSTRAINT ck CHECK (REGEXP_LIKE(a, '^x$', 'c')))", "1901")
			e.Exec("CREATE TABLE t (a char(36) CHARACTER SET ascii COLLATE ascii_bin, t time, CONSTRAINT ck1 CHECK (a REGEXP '^x$'), CONSTRAINT ck2 CHECK (t < '24:00:00'))")
			e.WantRows(q, "`a` regexp '^x$',`t` < '24:00:00'")
			e.Exec("ALTER TABLE t ADD INDEX ix (t)")
			e.WantRows(q, "`a` regexp '^x$',`t` < '24:00:00'")
		}),
		p("check.alter_writes_time_precision", "ALTER TABLE leaves a time literal that meets a time(p) column as it was written", func(e *Env) {
			e.Exec("CREATE TABLE t (a time(3), CONSTRAINT ck CHECK (a < '24:00:00'))", "ALTER TABLE t ADD INDEX ix (a)")
			e.Want("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()", "`a` < '24:00:00'")
		}),
		p("check.fk_action_column_rejected", "a column of a foreign key with a referential action cannot appear in a CHECK (1901)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)")
			e.Fails("CREATE TABLE c (pid int, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id) ON DELETE SET NULL, CONSTRAINT ck CHECK (pid > 0))", "1901")
		}),
		p("check.nondeterministic_rejected", "a CHECK cannot call NOW() (1901)", func(e *Env) {
			e.Fails("CREATE TABLE t (d datetime, CONSTRAINT ck CHECK (d < NOW()))", "1901")
		}),
		// Identifiers.
		p("ident.max_length", "a table name is at most 64 characters (1103)", func(e *Env) {
			e.Exec("CREATE TABLE " + strings.Repeat("t", 64) + " (a int)")
			e.Fails("CREATE TABLE "+strings.Repeat("u", 65)+" (a int)", "1103")
		}),
		// DDL transactions.
		p("ddl.atomic_statement", "a DROP TABLE of two tables, one missing, drops the one that exists and fails (1051)", func(e *Env) {
			e.Exec("CREATE TABLE a (v int)")
			e.Fails("DROP TABLE a, missing", "1051")
			e.Want("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'a'", "0")
		}),
		// Renderings.
		p("render.bool_check", "TINYINT(1) with CHECK (b IN (0,1)) rejects 2 (4025)", func(e *Env) {
			e.Exec("CREATE TABLE t (b tinyint(1), CONSTRAINT t_b_bool CHECK (b IN (0,1)))", "INSERT INTO t VALUES (0), (1), (NULL)")
			e.Fails("INSERT INTO t VALUES (2)", "4025")
		}),
		p("render.time_of_day_check", "TIME(6) with CHECK (v >= '00:00:00' AND v < '24:00:00') accepts only a time of day (4025)", func(e *Env) {
			e.Exec("CREATE TABLE t (v time(6), CONSTRAINT t_v_time CHECK (v >= '00:00:00' AND v < '24:00:00'))", "INSERT INTO t VALUES ('23:59:59.999999'), ('00:00:00')")
			e.Fails("INSERT INTO t VALUES ('24:00:00')", "4025")
			e.Fails("INSERT INTO t VALUES ('-00:00:01')", "4025")
		}),
		p("render.uuid_bytes", "BINARY(16) with the CHECK length(u) = 16, which CHECK_CLAUSE writes as octet_length(`u`) = 16, orders its values by their bytes, and its default is x' and the lower-case hex of its bytes", uuidBytes("NULL", "octet_length(`u`) = 16", "x'0e2b5e8c3b0f4c599a0f6a2f2c2e1b10'")),
		p("uuid.binary_pads", "BINARY(16) pads a shorter value with zero bytes and refuses a longer one (1406)", func(e *Env) {
			e.Exec("CREATE TABLE t (u BINARY(16))", "INSERT INTO t VALUES (X'a0')")
			e.Want("SELECT CONCAT(LENGTH(u), ' ', LOWER(HEX(u))) FROM t", "16 a0000000000000000000000000000000")
			e.Fails("INSERT INTO t VALUES (X'000000000000000000000000000000000000')", "1406")
		}),
		// Views and sequences.
		p("sequence.unsupported", "MariaDB has CREATE SEQUENCE, a table of its own kind", func(e *Env) {
			e.Exec("CREATE SEQUENCE s")
			e.Want("SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 's'", "SEQUENCE")
			e.Want("SELECT NEXTVAL(s)", "1")
		}),
		p("view.definition_rewritten", "VIEW_DEFINITION is rewritten with qualified names and aliases, without parentheses around the condition", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE VIEW v AS select a from t where a>1")
			want := "select `" + e.Name + "`.`t`.`a` AS `a` from `" + e.Name + "`.`t` where `" + e.Name + "`.`t`.`a` > 1"
			e.Want("SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()", want)
		}),
	}
}
