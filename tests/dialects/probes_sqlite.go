package dialects

import (
	"strings"
	"time"
)

func sqliteProbes() []Probe {
	p := func(id, fact string, run func(e *Env)) Probe {
		return Probe{ID: "sqlite." + id, DB: "sqlite", Fact: fact, Run: run}
	}
	return []Probe{
		p("env.library", "the Go probe driver links SQLite 3.37 or later, which has STRICT tables", func(e *Env) {
			v := e.Value("SELECT sqlite_version()")
			e.Check(v >= "3.37" && len(v) >= 6, "sqlite_version %s", v)
			e.Want("PRAGMA foreign_keys", "0")
			e.Note("sqlite_version=%s", v)
		}),
		// Type affinity.
		p("type.affinity_unenforced", "an ordinary table stores any value in any declared type", func(e *Env) {
			e.Exec("CREATE TABLE t (a INTEGER, b varchar(3), c smallint, d int unsigned)",
				"INSERT INTO t VALUES ('x', 'abcdef', 99999999999, -1)")
			e.Want("SELECT typeof(a) || ' ' || length(b) || ' ' || c || ' ' || d FROM t", "text 6 99999999999 -1")
		}),
		p("type.affinity_from_name", "affinity comes from substrings of the declared name: DECIMALINT and FLOATING POINT are INTEGER, DECIMAL and BOOLEAN are NUMERIC", func(e *Env) {
			e.Exec("CREATE TABLE t (a DECIMALINT(4,2), b DECIMAL(4,2), c BOOLEAN, d \"FLOATING POINT\", e DATETIME)",
				"INSERT INTO t VALUES ('12', 1.235, 2, '1.0', '2020-01-01')")
			e.Want("SELECT typeof(a) || ' ' || b || ' ' || c || ' ' || typeof(d) || ' ' || typeof(e) FROM t", "integer 1.235 2 integer text")
		}),
		p("strict.enforces_types", "a STRICT table rejects a value of another storage class", func(e *Env) {
			e.Exec("CREATE TABLE t (a INTEGER, b TEXT) STRICT")
			e.Fails("INSERT INTO t VALUES ('x', 'y')", "cannot store TEXT value in INTEGER column")
		}),
		p("strict.type_names_limited", "a STRICT table accepts only INT, INTEGER, REAL, TEXT, BLOB and ANY", func(e *Env) {
			e.Fails("CREATE TABLE t (a varchar(10)) STRICT", "unknown datatype")
		}),
		p("varchar.length_unenforced", "VARCHAR(3) stores six characters", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(3))", "INSERT INTO t VALUES ('abcdef')")
			e.Want("SELECT v FROM t", "abcdef")
		}),
		p("text.nul_preserved", "text stores U+0000; length() stops at it", func(e *Env) {
			e.Exec("CREATE TABLE t (v TEXT)")
			e.ExecArgs("INSERT INTO t VALUES (?)", "a\x00b")
			e.Want("SELECT length(CAST(v AS BLOB)) || ' ' || length(v) FROM t", "3 1")
		}),
		p("float.infinity", "REAL stores infinity", func(e *Env) {
			e.Want("SELECT typeof(9e999) || ' ' || (9e999 > 1e308)", "real 1")
		}),
		// Date and time.
		p("datetime.text_unvalidated", "a DATETIME column stores any text", func(e *Env) {
			e.Exec("CREATE TABLE t (d DATETIME)", "INSERT INTO t VALUES ('not a date')")
			e.Want("SELECT d FROM t", "not a date")
		}),
		p("datetime.now_is_utc", "datetime('now') and CURRENT_TIMESTAMP are UTC without fraction; strftime %f has three digits", func(e *Env) {
			before := time.Now().UTC().Truncate(time.Second)
			got := e.Value("SELECT datetime('now')")
			after := time.Now().UTC()
			at, err := time.Parse("2006-01-02 15:04:05", got)
			e.Check(err == nil && !at.Before(before) && !at.After(after), "datetime('now') %s not between %s and %s", got, before, after)
			e.Want("SELECT length(CURRENT_TIMESTAMP) || ' ' || length(strftime('%Y-%m-%d %H:%M:%f', 'now'))", "19 23")
		}),
		p("bool.literals", "TRUE and FALSE are the integers 1 and 0", func(e *Env) {
			e.Want("SELECT typeof(TRUE) || ' ' || TRUE || ' ' || FALSE", "integer 1 0")
		}),
		p("enum.type_name_rejected", "a type name with string arguments such as enum('a','b') is a syntax error", func(e *Env) {
			e.Fails("CREATE TABLE t (v enum('a','b'))", "syntax error")
		}),
		p("json.text_kept", "JSON is text: the value is stored as written and json() keeps duplicate keys", func(e *Env) {
			e.Exec("CREATE TABLE t (j json)", `INSERT INTO t VALUES ('{"b":1, "a":1,"a":2}')`)
			e.Want("SELECT j FROM t", `{"b":1, "a":1,"a":2}`)
			e.Want("SELECT json(j) FROM t", `{"b":1,"a":1,"a":2}`)
		}),
		// Null, defaults and catalog text.
		p("default.catalog_text", "PRAGMA table_info returns the default text as written", func(e *Env) {
			e.Exec("CREATE TABLE t (a varchar(5) DEFAULT 'x', b int DEFAULT 0, c TEXT DEFAULT CURRENT_TIMESTAMP, d int DEFAULT (1+1), f TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'))")
			e.WantRows("SELECT dflt_value FROM pragma_table_info('t') ORDER BY cid", `'x',0,CURRENT_TIMESTAMP,1+1,strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'`)
		}),
		p("default.expression_needs_parentheses", "an expression default must be parenthesized", func(e *Env) {
			e.Fails("CREATE TABLE t (a int DEFAULT 1+1)", "syntax error")
		}),
		p("not_null.missing_value_rejected", "an omitted NOT NULL column without DEFAULT is rejected", func(e *Env) {
			e.Exec("CREATE TABLE t (a int NOT NULL, b int)")
			e.Fails("INSERT INTO t (b) VALUES (1)", "NOT NULL constraint failed")
		}),
		// Identity.
		p("pk.nullable_non_integer", "a non-INTEGER PRIMARY KEY column of a rowid table accepts NULL", func(e *Env) {
			e.Exec("CREATE TABLE t (a TEXT PRIMARY KEY)", "INSERT INTO t VALUES (NULL), (NULL)")
			e.Want("SELECT COUNT(*) FROM t WHERE a IS NULL", "2")
			e.Want("SELECT \"notnull\" FROM pragma_table_info('t')", "0")
		}),
		p("autoincrement.explicit_value_advances", "AUTOINCREMENT continues after an explicit larger key", func(e *Env) {
			e.Exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v int)", "INSERT INTO t VALUES (100, 1)", "INSERT INTO t (v) VALUES (2)")
			e.Want("SELECT MAX(id) FROM t", "101")
		}),
		p("autoincrement.rollback_no_gap", "a rolled-back insert does not consume an AUTOINCREMENT value", func(e *Env) {
			e.Exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v int)", "BEGIN", "INSERT INTO t (v) VALUES (1)", "ROLLBACK", "INSERT INTO t (v) VALUES (2)")
			e.Want("SELECT id FROM t", "1")
		}),
		p("rowid.reused_without_autoincrement", "INTEGER PRIMARY KEY without AUTOINCREMENT reuses the largest deleted key; AUTOINCREMENT does not", func(e *Env) {
			e.Exec("CREATE TABLE r (id INTEGER PRIMARY KEY, v int)", "INSERT INTO r VALUES (1, 1), (2, 2)", "DELETE FROM r WHERE id = 2", "INSERT INTO r (v) VALUES (3)",
				"CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, v int)", "INSERT INTO a VALUES (1, 1), (2, 2)", "DELETE FROM a WHERE id = 2", "INSERT INTO a (v) VALUES (3)")
			e.Want("SELECT (SELECT MAX(id) FROM r) || ' ' || (SELECT MAX(id) FROM a)", "2 3")
		}),
		p("autoincrement.integer_only", "AUTOINCREMENT is allowed only on INTEGER PRIMARY KEY", func(e *Env) {
			e.Fails("CREATE TABLE t (id BIGINT PRIMARY KEY AUTOINCREMENT)", "AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY")
		}),
		// Generated columns.
		p("generated.virtual_and_stored", "VIRTUAL and STORED generated columns exist; table_xinfo marks them hidden 2 and 3 without the expression", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int AS (a+1) VIRTUAL, c int GENERATED ALWAYS AS (a*2) STORED)", "INSERT INTO t (a) VALUES (1)")
			e.WantRows("SELECT hidden FROM pragma_table_xinfo('t') ORDER BY cid", "0,2,3")
			e.Want("SELECT b || ' ' || c FROM t", "2 2")
		}),
		p("generated.explicit_value_rejected", "an explicit value for a generated column is rejected", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int AS (a+1))")
			e.Fails("INSERT INTO t (a, b) VALUES (1, 2)", "cannot INSERT into generated column")
		}),
		// Keys and indexes.
		p("pk.name_not_reported", "a primary key constraint name is kept only in the CREATE TABLE text", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int, CONSTRAINT pk_custom PRIMARY KEY (a, b))")
			e.Want("SELECT name || ' ' || origin FROM pragma_index_list('t')", "sqlite_autoindex_t_1 pk")
		}),
		p("index.descending", "a DESC index key is reported by index_xinfo", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, b int)", "CREATE INDEX ix ON t (a DESC, b)")
			e.WantRows("SELECT \"desc\" FROM pragma_index_xinfo('ix') WHERE key = 1 ORDER BY seqno", "1,0")
		}),
		p("index.partial_expression", "partial and expression indexes exist; the catalog reports cid -2 and the text only in sqlite_master", func(e *Env) {
			sql := "CREATE INDEX ix ON t (a+1) WHERE a > 0"
			e.Exec("CREATE TABLE t (a int)", sql)
			e.Want("SELECT partial FROM pragma_index_list('t')", "1")
			e.Want("SELECT cid || ' ' || coalesce(name, 'NULL') FROM pragma_index_info('ix')", "-2 NULL")
			e.Want("SELECT sql FROM sqlite_master WHERE name = 'ix'", sql)
		}),
		p("index.name_database_scope", "index names are unique in the database", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int)", "CREATE TABLE t2 (a int)", "CREATE INDEX ix ON t1 (a)")
			e.Fails("CREATE INDEX ix ON t2 (a)", "index ix already exists")
		}),
		p("constraint.duplicate_names_accepted", "two constraints of one table may have the same name", func(e *Env) {
			e.Exec("CREATE TABLE t (a int CONSTRAINT c CHECK (a > 0), b int CONSTRAINT c CHECK (b > 0))")
		}),
		p("unique.nulls_distinct", "a unique key accepts several NULLs", func(e *Env) {
			e.Exec("CREATE TABLE t (a int UNIQUE)", "INSERT INTO t VALUES (NULL), (NULL)")
		}),
		// Collation.
		p("collation.binary_codepoint", "the default BINARY collation is case, accent and space sensitive and orders UTF-8 by code point", func(e *Env) {
			e.Exec("CREATE TABLE t (v TEXT UNIQUE)", "INSERT INTO t VALUES ('a'), ('a '), ('A'), ('á'), ('B'), ('Z'), ('_')")
			e.WantRows("SELECT '[' || v || ']' FROM t ORDER BY v", "[A],[B],[Z],[_],[a],[a ],[á]")
		}),
		p("collation.nocase_ascii_only", "NOCASE folds ASCII letters only", func(e *Env) {
			e.Exec("CREATE TABLE t (v TEXT COLLATE NOCASE UNIQUE)", "INSERT INTO t VALUES ('a'), ('á'), ('Á')")
			e.Fails("INSERT INTO t VALUES ('A')", "UNIQUE constraint failed")
		}),
		// Foreign keys.
		p("fk.off_by_default", "foreign keys are not enforced until PRAGMA foreign_keys = ON on the connection", func(e *Env) {
			e.Exec("CREATE TABLE p (id INTEGER PRIMARY KEY)", "CREATE TABLE c (pid int REFERENCES p (id))", "INSERT INTO c VALUES (1)", "PRAGMA foreign_keys = ON")
			e.Fails("INSERT INTO c VALUES (2)", "FOREIGN KEY constraint failed")
			other := e.Other()
			other.Want("PRAGMA foreign_keys", "0")
			e.Merge(other)
		}),
		p("fk.pragma_ignored_in_transaction", "PRAGMA foreign_keys has no effect inside a transaction", func(e *Env) {
			e.Exec("BEGIN", "PRAGMA foreign_keys = ON")
			e.Want("PRAGMA foreign_keys", "0")
			e.Exec("ROLLBACK")
		}),
		p("fk.deferrable", "a DEFERRABLE INITIALLY DEFERRED foreign key is checked at COMMIT", func(e *Env) {
			e.Exec("PRAGMA foreign_keys = ON", "CREATE TABLE p (id INTEGER PRIMARY KEY)",
				"CREATE TABLE c (pid int REFERENCES p (id) DEFERRABLE INITIALLY DEFERRED)", "BEGIN", "INSERT INTO c VALUES (1)")
			e.Fails("COMMIT", "FOREIGN KEY constraint failed")
			e.Exec("ROLLBACK")
		}),
		p("fk.match_not_enforced", "MATCH FULL is accepted and a partly NULL composite key is not rejected", func(e *Env) {
			e.Exec("PRAGMA foreign_keys = ON", "CREATE TABLE p (a int, b int, PRIMARY KEY (a, b))",
				"CREATE TABLE c (a int, b int, FOREIGN KEY (a, b) REFERENCES p (a, b) MATCH FULL)", "INSERT INTO c VALUES (1, NULL)")
			e.Want("SELECT \"match\" FROM pragma_foreign_key_list('c')", "NONE")
		}),
		p("fk.names_not_reported", "PRAGMA foreign_key_list has no constraint name column", func(e *Env) {
			e.Exec("CREATE TABLE p (id INTEGER PRIMARY KEY)", "CREATE TABLE c (pid int, CONSTRAINT fk_custom FOREIGN KEY (pid) REFERENCES p (id) ON DELETE SET NULL)")
			e.WantRows("SELECT name FROM pragma_table_info('pragma_foreign_key_list')", "id,seq,table,from,to,on_update,on_delete,match")
			e.Want("SELECT id || ' ' || \"table\" || ' ' || \"from\" || ' ' || \"to\" || ' ' || on_update || ' ' || on_delete FROM pragma_foreign_key_list('c')", "0 p pid id NO ACTION SET NULL")
		}),
		p("fk.cascade_fires_triggers", "a row deleted by ON DELETE CASCADE fires the child's DELETE trigger", func(e *Env) {
			e.Exec("PRAGMA foreign_keys = ON", "CREATE TABLE p (id INTEGER PRIMARY KEY)",
				"CREATE TABLE c (id INTEGER PRIMARY KEY, pid int REFERENCES p (id) ON DELETE CASCADE)", "CREATE TABLE log (id int)",
				"CREATE TRIGGER c_del AFTER DELETE ON c FOR EACH ROW BEGIN INSERT INTO log VALUES (OLD.id); END",
				"INSERT INTO p VALUES (1)", "INSERT INTO c VALUES (10, 1)", "DELETE FROM p WHERE id = 1")
			e.Want("SELECT COUNT(*) FROM log", "1")
		}),
		// CHECK.
		p("check.enforced_null_passes", "CHECK is enforced and NULL passes", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, CONSTRAINT ck CHECK (a > 0))", "INSERT INTO t VALUES (NULL), (1)")
			e.Fails("INSERT INTO t VALUES (0)", "CHECK constraint failed")
		}),
		p("check.text_verbatim", "a CHECK expression is kept only as written in the CREATE TABLE text", func(e *Env) {
			sql := "CREATE TABLE t (v TEXT, CONSTRAINT ck CHECK (v IN ('x','y')))"
			e.Exec(sql)
			e.Want("SELECT sql FROM sqlite_master WHERE name = 't'", sql)
		}),
		p("check.nondeterministic_rejected", "a CHECK that calls date('now') fails when evaluated", func(e *Env) {
			e.Exec("CREATE TABLE t (d TEXT, CONSTRAINT ck CHECK (d < date('now')))")
			e.Fails("INSERT INTO t VALUES ('2000-01-01')", "non-deterministic")
		}),
		// Comments.
		p("comment.no_object", "SQLite has no COMMENT statement; SQL comments stay in the CREATE TABLE text", func(e *Env) {
			sql := "CREATE TABLE t (\n  a int -- note\n)"
			e.Exec(sql)
			e.Fails("COMMENT ON TABLE t IS 'x'", "syntax error")
			e.Want("SELECT sql FROM sqlite_master WHERE name = 't'", sql)
		}),
		// Identifiers and namespaces.
		p("ident.no_length_limit", "a 200-character table name is accepted", func(e *Env) {
			e.Exec("CREATE TABLE " + strings.Repeat("t", 200) + " (a int)")
		}),
		p("ident.case_insensitive", "column names are case-insensitive", func(e *Env) {
			e.Fails("CREATE TABLE t (a int, A int)", "duplicate column name")
		}),
		p("namespace.attached_databases", "a qualified name refers to an attached database", func(e *Env) {
			e.Fails("CREATE TABLE s.t (a int)", "unknown database s")
		}),
		// Update-time stamping and triggers.
		p("on_update.unsupported", "SQLite has no ON UPDATE column clause", func(e *Env) {
			e.Fails("CREATE TABLE t (ts TEXT ON UPDATE CURRENT_TIMESTAMP)", "syntax error")
		}),
		p("trigger.no_statement_level", "SQLite has no FOR EACH STATEMENT trigger", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)")
			e.Fails("CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH STATEMENT BEGIN SELECT 1; END", "syntax error")
		}),
		p("trigger.new_read_only", "a trigger cannot assign NEW; stamping needs a separate UPDATE", func(e *Env) {
			e.Exec("CREATE TABLE t (a int, ts TEXT)")
			e.Fails("CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW BEGIN SET NEW.ts = 'x'; END", "syntax error")
			e.Exec("INSERT INTO t VALUES (1, NULL)",
				"CREATE TRIGGER tg AFTER UPDATE ON t FOR EACH ROW BEGIN UPDATE t SET ts = '2001-01-01' WHERE rowid = NEW.rowid; END",
				"UPDATE t SET a = a")
			e.Want("SELECT ts FROM t", "2001-01-01")
		}),
		p("trigger.delete_all_fires_row_triggers", "DELETE without WHERE fires a DELETE trigger per row; SQLite has no TRUNCATE", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE TABLE log (a int)",
				"CREATE TRIGGER tg AFTER DELETE ON t FOR EACH ROW BEGIN INSERT INTO log VALUES (OLD.a); END",
				"INSERT INTO t VALUES (1), (2)", "DELETE FROM t")
			e.Want("SELECT COUNT(*) FROM log", "2")
			e.Fails("TRUNCATE TABLE t", "syntax error")
		}),
		p("trigger.zero_rows_not_fired", "a row trigger does not fire for an UPDATE that matches no row", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)",
				"CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'immutable'); END",
				"UPDATE t SET a = 1 WHERE a = 0")
		}),
		p("trigger.dropped_with_table", "DROP TABLE drops its triggers", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW BEGIN SELECT 1; END", "DROP TABLE t")
			e.Want("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'", "0")
		}),
		p("trigger.catalog_verbatim", "sqlite_master keeps the CREATE TRIGGER text as written", func(e *Env) {
			sql := "CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW BEGIN\n  -- note\n  SELECT 1;\nEND"
			e.Exec("CREATE TABLE t (a int)", sql)
			e.Want("SELECT sql FROM sqlite_master WHERE name = 'tg'", sql)
		}),
		p("trigger.name_database_scope", "trigger names are unique in the database", func(e *Env) {
			e.Exec("CREATE TABLE t1 (a int)", "CREATE TABLE t2 (a int)", "CREATE TRIGGER tg AFTER INSERT ON t1 BEGIN SELECT 1; END")
			e.Fails("CREATE TRIGGER tg AFTER INSERT ON t2 BEGIN SELECT 1; END", "trigger tg already exists")
		}),
		// Audit context.
		p("context.temp_table_not_visible", "a trigger of a main table that reads a TEMP table is created but fails when it fires", func(e *Env) {
			e.Exec("CREATE TEMP TABLE ctx (op TEXT)", "INSERT INTO ctx VALUES ('x')", "CREATE TABLE t (a int)", "CREATE TABLE log (op TEXT)",
				"CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW BEGIN INSERT INTO log SELECT op FROM ctx; END")
			e.Fails("INSERT INTO t VALUES (1)", "no such table: main.ctx")
		}),
		p("context.main_table_shared", "a context row in a main table is visible to other connections after COMMIT", func(e *Env) {
			e.Exec("CREATE TABLE ctx (k TEXT PRIMARY KEY, v TEXT NOT NULL)", "BEGIN", "INSERT INTO ctx VALUES ('op', 'x')", "COMMIT")
			other := e.Other()
			other.Want("SELECT v FROM ctx WHERE k = 'op'", "x")
			e.Merge(other)
		}),
		// DDL transactions.
		p("ddl.transactional", "CREATE TABLE is rolled back with its transaction", func(e *Env) {
			e.Exec("BEGIN", "CREATE TABLE a (v int)", "ROLLBACK")
			e.Want("SELECT COUNT(*) FROM sqlite_master WHERE name = 'a'", "0")
		}),
		p("alter.limited", "ALTER TABLE cannot change a column, and ADD COLUMN rejects a non-constant default", func(e *Env) {
			e.Exec("CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)")
			e.Fails("ALTER TABLE t ALTER COLUMN a TYPE TEXT", "syntax error")
			e.Fails("ALTER TABLE t ADD COLUMN ts TEXT DEFAULT CURRENT_TIMESTAMP", "Cannot add a column with non-constant default")
		}),
		// Proposed neutral renderings.
		p("render.integer_check", "CHECK (typeof(a) IN ('integer','null') AND a BETWEEN ...) enforces an integer range and storage class", func(e *Env) {
			e.Exec("CREATE TABLE t (a smallint, CONSTRAINT t_a_i16 CHECK (typeof(a) IN ('integer', 'null') AND a BETWEEN -32768 AND 32767))",
				"INSERT INTO t VALUES ('12'), (NULL), (32767)")
			e.Fails("INSERT INTO t VALUES (32768)", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES ('x')", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES (1.5)", "CHECK constraint failed")
			e.Want("SELECT typeof(a) FROM t WHERE a = 12", "integer")
		}),
		p("render.varchar_check", "CHECK (length(v) <= 3) enforces a length in characters", func(e *Env) {
			e.Exec("CREATE TABLE t (v varchar(3), CONSTRAINT t_v_len CHECK (length(v) <= 3))", "INSERT INTO t VALUES ('가나다'), (NULL)")
			e.Fails("INSERT INTO t VALUES ('abcd')", "CHECK constraint failed")
		}),
		p("render.bool_check", "CHECK (b IN (0,1)) rejects 2 and text", func(e *Env) {
			e.Exec("CREATE TABLE t (b BOOLEAN, CONSTRAINT t_b_bool CHECK (b IN (0, 1)))", "INSERT INTO t VALUES (TRUE), (FALSE), (NULL)")
			e.Fails("INSERT INTO t VALUES (2)", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES ('x')", "CHECK constraint failed")
		}),
		p("render.decimal_check", "DECIMALINT(4,2) with an integer range CHECK rejects a real value and an overflow", func(e *Env) {
			e.Exec("CREATE TABLE t (d DECIMALINT(4,2), CONSTRAINT t_d_dec CHECK (typeof(d) IN ('integer', 'null') AND d BETWEEN -9999 AND 9999))", "INSERT INTO t VALUES (1235), (-9999)")
			e.Fails("INSERT INTO t VALUES (1.5)", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES (10000)", "CHECK constraint failed")
		}),
		p("render.date_check", "CHECK (d IS date(d)) accepts only valid YYYY-MM-DD text or NULL", func(e *Env) {
			e.Exec("CREATE TABLE t (d DATE, CONSTRAINT t_d_date CHECK (d IS date(d)))", "INSERT INTO t VALUES ('2020-02-29'), (NULL)")
			e.Fails("INSERT INTO t VALUES ('2021-02-29')", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES ('x')", "CHECK constraint failed")
		}),
		p("render.time_check", "time() returns 24:00:00 and 24:00:01 unchanged, so CHECK (v IS time(v) AND v < '24:00:00') is needed for a time of day", func(e *Env) {
			e.Want("SELECT time('24:00:00') || ' ' || time('24:00:01') || ' ' || coalesce(time('25:00:00'), 'NULL')", "24:00:00 24:00:01 NULL")
			e.Exec("CREATE TABLE t (v TIME, CONSTRAINT t_v_time CHECK (v IS time(v) AND v < '24:00:00'))", "INSERT INTO t VALUES ('23:59:59'), (NULL)")
			e.Fails("INSERT INTO t VALUES ('24:00:00')", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES ('7:00')", "CHECK constraint failed")
		}),
		p("render.uuid_check", "a GLOB CHECK accepts only lower-case canonical UUID text", func(e *Env) {
			e.Exec("CREATE TABLE t (u TEXT, CONSTRAINT t_u_uuid CHECK (u GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'))", "INSERT INTO t VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')")
			e.Fails("INSERT INTO t VALUES ('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')", "CHECK constraint failed")
			e.Fails("INSERT INTO t VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a111')", "CHECK constraint failed")
		}),
		// Views and sequences.
		p("sequence.unsupported", "SQLite has no CREATE SEQUENCE", func(e *Env) {
			e.Fails("CREATE SEQUENCE s", "syntax error")
		}),
		p("view.text_verbatim", "sqlite_master keeps the CREATE VIEW text as written", func(e *Env) {
			sql := "CREATE VIEW v AS select a from t where a>1"
			e.Exec("CREATE TABLE t (a int)", sql)
			e.Want("SELECT sql FROM sqlite_master WHERE name = 'v'", sql)
		}),
	}
}
