package dialects

import (
	"strconv"
	"strings"
)

// fourByteText returns n pseudo-random characters from U+20000..U+2A6DF,
// each four bytes in UTF-8, so the text has little repetition to compress.
func fourByteText(n int) string {
	var b strings.Builder
	x := uint32(2463534242)
	for i := 0; i < n; i++ {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		b.WriteRune(rune(0x20000 + x%0xA6E0))
	}
	return b.String()
}

func postgresProbes() []Probe {
	p := func(id, fact string, run func(e *Env)) Probe {
		return Probe{ID: "postgres." + id, DB: "postgres", Fact: fact, Run: run}
	}
	return []Probe{
		p("env.server", "the server is PostgreSQL 17 with database collation C", func(e *Env) {
			n, _ := strconv.Atoi(e.Value("SHOW server_version_num"))
			e.Check(n >= 170000 && n < 180000, "server_version_num %d", n)
			e.Want("SELECT datcollate FROM pg_database WHERE datname = current_database()", "C")
			e.Note("version=%s TimeZone=%s max_identifier_length=%s", e.Value("SHOW server_version"), e.Value("SHOW TimeZone"), e.Value("SHOW max_identifier_length"))
		}),
		// Integers and booleans.
		p("int.no_unsigned", "PostgreSQL has no UNSIGNED modifier (42601)", func(e *Env) {
			e.Fails("CREATE TABLE t (a int unsigned)", "42601")
		}),
		p("int.no_tinyint", "PostgreSQL has no TINYINT or MEDIUMINT type (42704)", func(e *Env) {
			e.Fails("CREATE TABLE t (a tinyint)", "42704")
			e.Fails("CREATE TABLE u (a mediumint)", "42704")
		}),
		p("int.smallint_range", "SMALLINT rejects 32768 (22003)", func(e *Env) {
			e.Exec("CREATE TABLE t (a smallint)", "INSERT INTO t VALUES (32767)")
			e.Fails("INSERT INTO t VALUES (32768)", "22003")
		}),
		p("bool.rejects_integer", "BOOLEAN rejects the integer 2 (42804)", func(e *Env) {
			e.Exec("CREATE TABLE t (b boolean)", "INSERT INTO t VALUES (true)")
			e.Fails("INSERT INTO t VALUES (2)", "42804")
		}),
		// Exact and approximate numbers.
		p("numeric.scale_rounds", "NUMERIC(4,2) rounds 1.235 to 1.24 and -1.235 to -1.24 (half away from zero)", func(e *Env) {
			e.Exec("CREATE TABLE t (n int, d numeric(4,2))", "INSERT INTO t VALUES (1, 1.235), (2, -1.235), (3, 1.225)")
			e.WantRows("SELECT d::text FROM t ORDER BY n", "1.24,-1.24,1.23")
		}),
		p("numeric.overflow_rejected", "NUMERIC(4,2) rejects 100 (22003)", func(e *Env) {
			e.Exec("CREATE TABLE t (d numeric(4,2))")
			e.Fails("INSERT INTO t VALUES (100)", "22003")
		}),
		p("numeric.precision_limits", "NUMERIC precision is at most 1000 (22023); a negative scale is accepted", func(e *Env) {
			e.Exec("CREATE TABLE t (d numeric(1000,0), n numeric(3,-1))", "INSERT INTO t (n) VALUES (1234)")
			e.Want("SELECT n::text FROM t", "1230")
			e.Fails("CREATE TABLE u (d numeric(1001,0))", "22023")
		}),
		p("float.real_single_precision", "REAL is 4-byte single precision; DOUBLE PRECISION is 8-byte", func(e *Env) {
			e.Want("SELECT 0.1::real::double precision::text", "0.10000000149011612")
			e.Want("SELECT 0.1::double precision::text", "0.1")
		}),
		p("float.nan_infinity", "DOUBLE PRECISION stores NaN and Infinity", func(e *Env) {
			e.Exec("CREATE TABLE t (d double precision)", "INSERT INTO t VALUES ('NaN'), ('Infinity')")
			e.WantRows("SELECT d::text FROM t ORDER BY d", "Infinity,NaN")
		}),
		// Character and binary strings.
		p("varchar.length_in_characters", "VARCHAR(3) counts characters: accepts three Hangul syllables, rejects abcd (22001)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(3))", "INSERT INTO t VALUES ('가나다')")
			e.Fails("INSERT INTO t VALUES ('abcd')", "22001")
		}),
		p("varchar.trailing_spaces_truncated", "VARCHAR(3) accepts 'abc   ' by removing the excess trailing spaces", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(3))", "INSERT INTO t VALUES ('abc   ')")
			e.Want("SELECT '[' || v || ']' FROM t", "[abc]")
		}),
		p("varchar.max_length", "VARCHAR length is at most 10485760 (22023)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(10485760))")
			e.Fails("CREATE TABLE u (v varchar(10485761))", "22023")
		}),
		p("char.padded", "CHAR(5) returns its value padded with spaces", func(e *Env) {
			e.Exec("CREATE TABLE t (c char(5))", "INSERT INTO t VALUES ('ab')")
			e.Want("SELECT c FROM t", "ab   ")
		}),
		p("text.unlimited", "TEXT stores 1 MiB", func(e *Env) {
			e.Exec("CREATE TABLE t (v text)", "INSERT INTO t VALUES (repeat('a', 1048576))")
			e.Want("SELECT length(v) FROM t", "1048576")
		}),
		p("text.nul_rejected", "text cannot store U+0000 (22021)", func(e *Env) {
			e.Exec("CREATE TABLE t (v text)")
			e.Fails("INSERT INTO t VALUES ($1)", "22021", "a\x00b")
		}),
		p("index.btree_entry_limit", "a B-tree entry over 2704 bytes is rejected at insert (54000)", func(e *Env) {
			e.Exec("CREATE TABLE t (v text)", "CREATE INDEX ix ON t (v)")
			e.Fails("INSERT INTO t SELECT string_agg(md5(i::text), '') FROM generate_series(1, 200) AS i", "54000")
		}),
		p("index.varchar_640_four_byte_fits", "a B-tree entry of 640 four-byte characters with little repetition fits", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(640) COLLATE \"C\")", "CREATE INDEX ix ON t (v)")
			e.ExecArgs("INSERT INTO t VALUES ($1)", fourByteText(640))
			e.Want("SELECT octet_length(v) FROM t", "2560")
		}),
		p("bytea.no_length", "BYTEA takes no length (42601)", func(e *Env) {
			e.Fails("CREATE TABLE t (b bytea(4))", "42601")
		}),
		// Date and time.
		p("timestamp.ignores_offset", "TIMESTAMP WITHOUT TIME ZONE drops the offset of a literal", func(e *Env) {
			e.Exec("SET TIME ZONE 'UTC'", "CREATE TABLE t (d timestamp)", "INSERT INTO t VALUES ('2020-01-01 09:00:00+09:00')")
			e.Want("SELECT d::text FROM t", "2020-01-01 09:00:00")
		}),
		p("timestamptz.session_time_zone", "TIMESTAMPTZ stores an instant and displays it in the session time zone", func(e *Env) {
			e.Exec("SET TIME ZONE 'UTC'", "CREATE TABLE t (d timestamptz)", "INSERT INTO t VALUES ('2020-01-01 00:00:00')", "SET TIME ZONE 'Asia/Seoul'")
			e.Want("SELECT d::text FROM t", "2020-01-01 09:00:00+09")
		}),
		p("timestamp.range", "TIMESTAMP accepts 0001-01-01, 9999-12-31 and infinity", func(e *Env) {
			e.Exec("CREATE TABLE t (d timestamp)", "INSERT INTO t VALUES ('0001-01-01 00:00:00'), ('9999-12-31 23:59:59'), ('infinity')")
			e.WantRows("SELECT d::text FROM t ORDER BY d", "0001-01-01 00:00:00,9999-12-31 23:59:59,infinity")
		}),
		p("timestamp.fraction_rounds", "TIMESTAMP(0) rounds .5 seconds up", func(e *Env) {
			e.Exec("CREATE TABLE t (d timestamp(0))", "INSERT INTO t VALUES ('2020-01-01 00:00:00.5')")
			e.Want("SELECT d::text FROM t", "2020-01-01 00:00:01")
		}),
		p("timestamp.precision_capped", "TIMESTAMP(7) is reduced to precision 6", func(e *Env) {
			e.Exec("CREATE TABLE t (d timestamp(7))")
			e.Want("SELECT datetime_precision FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 't'", "6")
		}),
		p("time.day_range", "TIME accepts 24:00:00 and rejects 25:00:00 (22008)", func(e *Env) {
			e.Exec("CREATE TABLE t (v time)", "INSERT INTO t VALUES ('24:00:00')")
			e.Fails("INSERT INTO t VALUES ('25:00:00')", "22008")
		}),
		p("now.transaction_start", "now() returns the transaction start time for every statement of the transaction", func(e *Env) {
			e.Exec("BEGIN")
			first := e.Value("SELECT now()::text")
			e.Exec("CREATE TABLE t (a int)", "INSERT INTO t SELECT generate_series(1, 1000)")
			e.Want("SELECT now()::text", first)
			e.Want("SELECT now() = transaction_timestamp()", "true")
			e.Exec("COMMIT")
		}),
		// UUID, enum and JSON.
		p("uuid.native_normalized", "UUID accepts braces and upper case and returns lower case", func(e *Env) {
			e.Exec("CREATE TABLE t (u uuid)", "INSERT INTO t VALUES ('{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}')")
			e.Want("SELECT u::text FROM t", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")
		}),
		p("enum.type_object", "ENUM is a named type object: unknown values fail (22P02), columns report USER-DEFINED, order follows the list", func(e *Env) {
			e.Exec("CREATE TYPE mood AS ENUM ('b', 'a')", "CREATE TABLE t (v mood)", "INSERT INTO t VALUES ('a'), ('b')")
			e.Fails("INSERT INTO t VALUES ('c')", "22P02")
			e.Want("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 't'", "USER-DEFINED")
			e.WantRows("SELECT t.v::text FROM t ORDER BY t.v", "b,a")
			e.WantRows("SELECT enumlabel FROM pg_enum WHERE enumtypid = 'mood'::regtype ORDER BY enumsortorder", "b,a")
		}),
		p("json.text_jsonb_normalized", "JSON keeps the text; JSONB keeps the last duplicate key and reorders members", func(e *Env) {
			e.Exec("CREATE TABLE t (j json, b jsonb)", `INSERT INTO t VALUES ('{"b":1,"a":1,"a":2}', '{"b":1,"a":1,"a":2}')`)
			e.Want("SELECT j::text FROM t", `{"b":1,"a":1,"a":2}`)
			e.Want("SELECT b::text FROM t", `{"a": 2, "b": 1}`)
		}),
		// Null, defaults and catalog text.
		p("default.catalog_text", "pg_get_expr returns defaults with casts and normalized expressions", func(e *Env) {
			e.Exec("CREATE TABLE t (a varchar(5) DEFAULT 'x', b int DEFAULT 0, c text DEFAULT ('y'), d timestamp(6) DEFAULT CURRENT_TIMESTAMP, f int DEFAULT (1+1), g timestamptz DEFAULT now())")
			e.WantRows("SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 't'::regclass ORDER BY a.attnum",
				"'x'::character varying,0,'y'::text,CURRENT_TIMESTAMP,(1 + 1),now()")
		}),
		p("not_null.missing_value_rejected", "an omitted NOT NULL column without DEFAULT is rejected (23502)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int NOT NULL, b int)")
			e.Fails("INSERT INTO t (b) VALUES (1)", "23502")
		}),
		// Identity.
		p("identity.by_default_not_advanced", "GENERATED BY DEFAULT AS IDENTITY does not advance past an explicit key; the next default collides (23505)", func(e *Env) {
			e.Exec("CREATE TABLE t (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v int)", "INSERT INTO t VALUES (1, 1)")
			e.Fails("INSERT INTO t (v) VALUES (2)", "23505")
		}),
		p("identity.always_rejects_explicit", "GENERATED ALWAYS AS IDENTITY rejects an explicit key (428C9) unless OVERRIDING SYSTEM VALUE", func(e *Env) {
			e.Exec("CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v int)")
			e.Fails("INSERT INTO t VALUES (1, 1)", "428C9")
			e.Exec("INSERT INTO t OVERRIDING SYSTEM VALUE VALUES (5, 1)")
			e.Want("SELECT identity_generation FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 't' AND column_name = 'id'", "ALWAYS")
		}),
		p("identity.rollback_leaves_gap", "a rolled-back insert consumes an identity value", func(e *Env) {
			e.Exec("CREATE TABLE t (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v int)", "BEGIN", "INSERT INTO t (v) VALUES (1)", "ROLLBACK", "INSERT INTO t (v) VALUES (2)")
			e.Want("SELECT id FROM t", "2")
		}),
		p("serial.sequence_default", "SERIAL is a sequence default, not an identity column", func(e *Env) {
			e.Exec("CREATE TABLE t (id serial PRIMARY KEY)")
			e.Want("SELECT column_default || ' ' || is_identity FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 't'", "nextval('t_id_seq'::regclass) NO")
		}),
		// Generated columns.
		p("generated.stored_only", "PostgreSQL 17 has STORED generated columns only; VIRTUAL is rejected (42601)", func(e *Env) {
			e.Fails("CREATE TABLE u (a int, b int GENERATED ALWAYS AS (a+1) VIRTUAL)", "42601")
			e.Exec("CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a+1) STORED)")
			e.Want("SELECT attgenerated::text || ' ' || pg_get_expr(d.adbin, d.adrelid) FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 't'::regclass AND a.attname = 'b'", "s (a + 1)")
		}),
		p("generated.explicit_value_rejected", "an explicit value for a generated column is rejected (428C9)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a+1) STORED)")
			e.Fails("INSERT INTO t (a, b) VALUES (1, 2)", "428C9")
		}),
		// Keys and indexes.
		p("pk.name_kept", "a primary key constraint keeps its name", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT pk_custom PRIMARY KEY (a))")
			e.Want("SELECT conname FROM pg_constraint WHERE conrelid = 't'::regclass", "pk_custom")
		}),
		p("index.descending_partial_expression", "indexes support DESC, expressions and WHERE; pg_get_indexdef returns normalized text", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int)", "CREATE INDEX ix ON t (a DESC, (b+1)) WHERE a > 0")
			e.Want("SELECT pg_get_indexdef('ix'::regclass)", "CREATE INDEX ix ON "+e.Name+".t USING btree (a DESC, ((b + 1))) WHERE (a > 0)")
			e.Want("SELECT indkey::text || ' ' || pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = 'ix'::regclass", "1 0 (a > 0)")
		}),
		p("index.prefix_rejected", "an index key with a length is read as a function call (42883)", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(100))")
			e.Fails("CREATE INDEX ix ON t (v(10))", "42883")
		}),
		p("index.name_schema_scope", "index names are unique in the schema (42P07)", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int)", "CREATE TABLE t2 (a int)", "CREATE INDEX ix ON t1 (a)")
			e.Fails("CREATE INDEX ix ON t2 (a)", "42P07")
		}),
		p("unique.name_schema_scope", "a unique constraint name is an index name and is unique in the schema (42P07)", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int, CONSTRAINT uq UNIQUE (a))")
			e.Fails("CREATE TABLE t2 (a int, CONSTRAINT uq UNIQUE (a))", "42P07")
		}),
		p("check.name_table_scope", "CHECK names are scoped to their table", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int, CONSTRAINT ck CHECK (a > 0))", "CREATE TABLE t2 (a int, CONSTRAINT ck CHECK (a > 0))")
		}),
		p("unique.nulls_not_distinct_option", "a unique key accepts several NULLs unless declared NULLS NOT DISTINCT (23505)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int UNIQUE)", "INSERT INTO t VALUES (NULL), (NULL)", "CREATE TABLE u (a int UNIQUE NULLS NOT DISTINCT)", "INSERT INTO u VALUES (NULL)")
			e.Fails("INSERT INTO u VALUES (NULL)", "23505")
		}),
		// Collation.
		p("collation.c_codepoint", "collation C is case, accent and space sensitive and orders by code point", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(5) UNIQUE)", "INSERT INTO t VALUES ('a'), ('a '), ('A'), ('á'), ('B'), ('Z'), ('_')")
			e.WantRows("SELECT '[' || v || ']' FROM t ORDER BY v", "[A],[B],[Z],[_],[a],[a ],[á]")
			e.Exec(`CREATE TABLE u (v text COLLATE "C", w text)`)
			e.WantRows("SELECT a.attname || ' ' || coalesce(c.collname, 'NULL') FROM pg_attribute a LEFT JOIN pg_collation c ON c.oid = a.attcollation WHERE a.attrelid = 'u'::regclass AND a.attnum > 0 ORDER BY a.attnum", "v C,w default")
		}),
		// Foreign keys.
		p("fk.no_child_index", "a foreign key creates no index on the child columns", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE c (pid int REFERENCES p (id))")
			e.Want("SELECT COUNT(*) FROM pg_index WHERE indrelid = 'c'::regclass", "0")
		}),
		p("fk.deferrable", "a DEFERRABLE INITIALLY DEFERRED foreign key is checked at COMMIT (23503)", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE c (pid int REFERENCES p (id) DEFERRABLE INITIALLY DEFERRED)", "BEGIN", "INSERT INTO c VALUES (1)")
			e.Fails("COMMIT", "23503")
		}),
		p("fk.match_full", "MATCH FULL rejects a partly NULL composite key (23503); MATCH SIMPLE accepts it", func(e *Env) {
			e.Exec("CREATE TABLE p (a int, b int, PRIMARY KEY (a, b))",
				"CREATE TABLE c (a int, b int, FOREIGN KEY (a, b) REFERENCES p (a, b) MATCH FULL)",
				"CREATE TABLE s (a int, b int, FOREIGN KEY (a, b) REFERENCES p (a, b))", "INSERT INTO s VALUES (1, NULL)")
			e.Fails("INSERT INTO c VALUES (1, NULL)", "23503")
		}),
		p("fk.set_default", "ON DELETE SET DEFAULT is supported", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)", "INSERT INTO p VALUES (0), (1)",
				"CREATE TABLE c (pid int DEFAULT 0 REFERENCES p (id) ON DELETE SET DEFAULT)", "INSERT INTO c VALUES (1)", "DELETE FROM p WHERE id = 1")
			e.Want("SELECT pid FROM c", "0")
		}),
		p("fk.cascade_fires_triggers", "a row deleted by ON DELETE CASCADE fires the child's DELETE trigger", func(e *Env) {
			e.Exec("CREATE TABLE p (id int PRIMARY KEY)",
				"CREATE TABLE c (id int PRIMARY KEY, pid int REFERENCES p (id) ON DELETE CASCADE)",
				"CREATE TABLE log (id int)",
				"CREATE FUNCTION c_del() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO log VALUES (OLD.id); RETURN OLD; END$$",
				"CREATE TRIGGER c_del AFTER DELETE ON c FOR EACH ROW EXECUTE FUNCTION c_del()",
				"INSERT INTO p VALUES (1)", "INSERT INTO c VALUES (10, 1)", "DELETE FROM p WHERE id = 1")
			e.Want("SELECT COUNT(*) FROM log", "1")
		}),
		p("fk.type_mismatch_allowed", "an INTEGER column may reference a BIGINT key", func(e *Env) {
			e.Exec("CREATE TABLE p (id bigint PRIMARY KEY)", "CREATE TABLE c (pid int REFERENCES p (id))")
		}),
		// CHECK.
		p("check.enforced_null_passes", "CHECK is enforced (23514) and NULL passes", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a > 0))", "INSERT INTO t VALUES (NULL), (1)")
			e.Fails("INSERT INTO t VALUES (0)", "23514")
		}),
		p("check.normalized_text", "pg_get_constraintdef rewrites IN as = ANY (ARRAY[...]) with casts", func(e *Env) {
			e.Exec("CREATE TABLE t (v text, CONSTRAINT ck CHECK (v IN ('x','y')))")
			e.Want("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck'", "CHECK ((v = ANY (ARRAY['x'::text, 'y'::text])))")
		}),
		p("check.nondeterministic_allowed", "a CHECK may call now()", func(e *Env) {
			e.Exec("CREATE TABLE t (d timestamptz, CONSTRAINT ck CHECK (d < now()))")
		}),
		p("check.not_valid", "ADD CONSTRAINT ... NOT VALID keeps violating rows and is recorded as not validated", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "INSERT INTO t VALUES (0)", "ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0) NOT VALID")
			e.Want("SELECT convalidated FROM pg_constraint WHERE conname = 'ck'", "false")
		}),
		// Comments.
		p("comment.unlimited", "COMMENT ON stores 5000 characters in pg_description", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "COMMENT ON COLUMN t.a IS '"+strings.Repeat("c", 5000)+"'", "COMMENT ON TABLE t IS '"+strings.Repeat("d", 5000)+"'")
			e.Want("SELECT length(col_description('t'::regclass, 1)) || ' ' || length(obj_description('t'::regclass, 'pg_class'))", "5000 5000")
		}),
		// Identifiers.
		p("ident.truncated_to_63", "an identifier over 63 bytes is truncated with a notice; names equal in 63 bytes collide (42P07)", func(e *Env) {
			e.Exec("CREATE TABLE " + strings.Repeat("t", 70) + " (a int)")
			e.Want("SELECT length(relname) FROM pg_class WHERE relname LIKE 'ttt%' AND relnamespace = current_schema()::regnamespace", "63")
			e.Fails("CREATE TABLE "+strings.Repeat("t", 63)+"zzz (a int)", "42P07")
		}),
		p("ident.case_folding", "unquoted names fold to lower case (42701); quoted names are case-sensitive", func(e *Env) {
			e.Exec(`CREATE TABLE t ("a" int, "A" int)`)
			e.Fails("CREATE TABLE u (a int, A int)", "42701")
		}),
		p("namespace.relname_per_schema", "a table name is unique per schema only; pg_class has one row per schema", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", `CREATE SCHEMA "`+e.Name+`_b"`, `CREATE TABLE "`+e.Name+`_b".t (a int)`)
			e.Want("SELECT COUNT(*) FROM pg_class WHERE relname = 't' AND relnamespace IN ($1::regnamespace, $2::regnamespace)", "2", e.Name, e.Name+"_b")
		}),
		// Update-time stamping.
		p("on_update.unsupported", "PostgreSQL has no ON UPDATE column clause (42601)", func(e *Env) {
			e.Fails("CREATE TABLE t (ts timestamp ON UPDATE CURRENT_TIMESTAMP)", "42601")
		}),
		p("trigger.update_fires_when_unchanged", "a BEFORE UPDATE row trigger fires when no value changes", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, ts timestamp)", "INSERT INTO t VALUES (1, '2000-01-01')",
				"CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.ts := '2001-01-01'; RETURN NEW; END$$",
				"CREATE TRIGGER stamp BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION stamp()", "UPDATE t SET a = a")
			e.Want("SELECT ts::text FROM t", "2001-01-01 00:00:00")
		}),
		// Triggers.
		p("trigger.statement_fires_on_zero_rows", "a FOR EACH STATEMENT trigger fires for an UPDATE that matches no row (P0001)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)",
				"CREATE FUNCTION reject() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$",
				"CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH STATEMENT EXECUTE FUNCTION reject()")
			e.Fails("UPDATE t SET a = 1 WHERE false", "P0001")
		}),
		p("trigger.row_skips_zero_rows", "a FOR EACH ROW trigger does not fire for an UPDATE that matches no row", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)",
				"CREATE FUNCTION reject() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$",
				"CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION reject()", "UPDATE t SET a = 1 WHERE false")
		}),
		p("trigger.truncate_event", "a BEFORE TRUNCATE statement trigger fires (P0001)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)",
				"CREATE FUNCTION reject() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$",
				"CREATE TRIGGER tg BEFORE TRUNCATE ON t FOR EACH STATEMENT EXECUTE FUNCTION reject()")
			e.Fails("TRUNCATE t", "P0001")
		}),
		p("trigger.function_separate_object", "a trigger function is a schema object that remains after its table is dropped", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)",
				"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$",
				"CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()", "DROP TABLE t")
			e.Want("SELECT COUNT(*) FROM pg_proc WHERE proname = 'f' AND pronamespace = current_schema()::regnamespace", "1")
		}),
		p("trigger.name_table_scope", "trigger names are scoped to their table", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int)", "CREATE TABLE t2 (a int)",
				"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$",
				"CREATE TRIGGER tg BEFORE INSERT ON t1 FOR EACH ROW EXECUTE FUNCTION f()",
				"CREATE TRIGGER tg BEFORE INSERT ON t2 FOR EACH ROW EXECUTE FUNCTION f()")
		}),
		p("trigger.catalog_text", "prosrc returns the function body as written; pg_get_triggerdef returns normalized text", func(e *Env) {
			body := "\nBEGIN\n  -- note\n  NEW.a := NEW.a + 1;\n  RETURN NEW;\nEND\n"
			e.Exec("CREATE TABLE t (a int)",
				"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$"+body+"$$",
				"create trigger tg before insert on t for each row execute procedure f()")
			e.Want("SELECT prosrc FROM pg_proc WHERE proname = 'f' AND pronamespace = current_schema()::regnamespace", body)
			e.Want("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'tg'", "CREATE TRIGGER tg BEFORE INSERT ON "+e.Name+".t FOR EACH ROW EXECUTE FUNCTION f()")
		}),
		// Audit context.
		p("context.set_config_local", "set_config(..., true) is visible to triggers until COMMIT; afterwards the setting reads as an empty string, and NULL in a session that never set it", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE TABLE log (op text)",
				"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO log VALUES (current_setting('orm.op', true)); RETURN NEW; END$$",
				"CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
				"BEGIN")
			e.Want("SELECT set_config('orm.op', 'x', true)", "x")
			e.Exec("INSERT INTO t VALUES (1)", "COMMIT")
			e.Want("SELECT op FROM log", "x")
			e.Want("SELECT current_setting('orm.op', true)", "")
			other := e.Other()
			other.Want("SELECT current_setting('orm.op', true)", "NULL")
			e.Merge(other)
		}),
		// DDL transactions.
		p("ddl.transactional", "CREATE TABLE is rolled back with its transaction", func(e *Env) {
			e.Exec("BEGIN", "CREATE TABLE a (v int)", "ROLLBACK")
			e.Want("SELECT to_regclass('a') IS NULL", "true")
		}),
		p("ddl.concurrent_index_outside_transaction", "CREATE INDEX CONCURRENTLY cannot run in a transaction block (25001)", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "BEGIN")
			e.Fails("CREATE INDEX CONCURRENTLY ix ON t (a)", "25001")
			e.Exec("ROLLBACK")
		}),
		// Proposed neutral renderings.
		p("render.timestamp_utc_session", "with TimeZone UTC, CURRENT_TIMESTAMP cast to timestamp equals now() AT TIME ZONE 'UTC'", func(e *Env) {
			e.Exec("SET TIME ZONE 'UTC'")
			e.Want("SELECT CURRENT_TIMESTAMP::timestamp = (now() AT TIME ZONE 'UTC')", "true")
			e.Exec("CREATE TABLE t (a int, d timestamp(6) DEFAULT CURRENT_TIMESTAMP)", "BEGIN", "INSERT INTO t (a) VALUES (1)")
			e.Want("SELECT d = (now() AT TIME ZONE 'UTC') FROM t", "true")
			e.Exec("COMMIT")
		}),
		p("render.timestamptz_conversion", "ALTER COLUMN TYPE timestamp USING d AT TIME ZONE 'UTC' converts a timestamptz instant to its UTC wall clock", func(e *Env) {
			e.Exec("SET TIME ZONE 'Asia/Seoul'", "CREATE TABLE t (d timestamptz(6))", "INSERT INTO t VALUES ('2020-01-01 09:00:00+09')",
				"ALTER TABLE t ALTER COLUMN d TYPE timestamp(6) USING d AT TIME ZONE 'UTC'")
			e.Want("SELECT d::text FROM t", "2020-01-01 00:00:00")
			e.Want("SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 't'::regclass AND attname = 'd'", "timestamp(6) without time zone")
		}),
		p("render.time_of_day_check", "TIME with CHECK (v < '24:00:00') rejects 24:00:00 (23514)", func(e *Env) {
			e.Exec("CREATE TABLE t (v time(6), CONSTRAINT t_v_time CHECK (v < '24:00:00'))", "INSERT INTO t VALUES ('23:59:59.999999')")
			e.Fails("INSERT INTO t VALUES ('24:00:00')", "23514")
		}),
		// Views and sequences.
		p("sequence.object", "CREATE SEQUENCE creates a schema object", func(e *Env) {
			e.Exec("CREATE SEQUENCE s")
			e.Want("SELECT nextval('s')", "1")
		}),
		p("view.definition_normalized", "pg_get_viewdef returns a normalized query text", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE VIEW v AS select a from t where a>1")
			e.Want("SELECT pg_get_viewdef('v'::regclass)", " SELECT a\n   FROM t\n  WHERE (a > 1);")
		}),
	}
}
