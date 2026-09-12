package orm

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

func TestRotateAESRowUpdatesAllAESColumnsAndVersion(t *testing.T) {
	keys, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	email, err := HostEncode("email@example.test", []string{"aes", "hex"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	phone, err := HostEncode("01012345678", []string{"aes", "hex"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	row := map[string]any{"seq": int64(7), "aes_key_version": int32(1), "aes_hex_email": email, "aes_hex_phone": phone}
	rotated, err := RotateAESRow(row, "aes_key_version", []AESRotationColumn{
		{Name: "aes_hex_email", Styles: []string{"aes", "hex"}},
		{Name: "aes_hex_phone", Styles: []string{"aes", "hex"}},
	}, 2, keys)
	if err != nil {
		t.Fatal(err)
	}
	if rotated["aes_key_version"] != int32(2) {
		t.Fatalf("version = %#v", rotated["aes_key_version"])
	}
	for _, c := range []struct{ name, plain string }{
		{"aes_hex_email", "email@example.test"}, {"aes_hex_phone", "01012345678"},
	} {
		decoded, err := hostDecode(rotated[c.name], []string{"aes", "hex"}, "new")
		if err != nil || decoded != c.plain {
			t.Fatalf("%s = %q, %v", c.name, decoded, err)
		}
	}
	if row["aes_hex_email"].(string) == rotated["aes_hex_email"].(string) {
		t.Fatal("email was not re-encrypted")
	}
	if row["aes_hex_phone"].(string) == rotated["aes_hex_phone"].(string) {
		t.Fatal("phone was not re-encrypted")
	}
}

func TestRotateAESRowDoesNotReturnPartialResult(t *testing.T) {
	keys, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	row := map[string]any{"aes_key_version": int32(1), "aes_hex_email": "not-hex"}
	if _, err := RotateAESRow(row, "aes_key_version", []AESRotationColumn{{Name: "aes_hex_email", Styles: []string{"aes", "hex"}}}, 2, keys); err == nil {
		t.Fatal("invalid ciphertext was accepted")
	}
	if row["aes_key_version"] != int32(1) {
		t.Fatal("input row was changed")
	}
}

func TestRotateAESRowsRollsBackOnMidBatchFailureAndResumes(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "rotation-failure.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	ctx := context.Background()
	if _, err := sqlDB.ExecContext(ctx, `CREATE TABLE rotation_failure (id INTEGER PRIMARY KEY, aes_key_version INTEGER NOT NULL, aes_hex_value TEXT)`); err != nil {
		t.Fatal(err)
	}
	oldValue, err := HostEncode("rotation-value", []string{"aes", "hex"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 2; id++ {
		if _, err := sqlDB.ExecContext(ctx, `INSERT INTO rotation_failure (id, aes_key_version, aes_hex_value) VALUES (?, 1, ?)`, id, oldValue); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := sqlDB.ExecContext(ctx, `CREATE TRIGGER rotation_failure_interrupt BEFORE UPDATE ON rotation_failure WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'rotation interruption'); END`); err != nil {
		t.Fatal(err)
	}
	db := &DB{SQL: sqlDB, driver: "sqlite", stmts: map[string]*sql.Stmt{}}
	keyring, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	spec := AESRotationSpec{Table: "rotation_failure", PrimaryKeys: []string{"id"}, VersionColumn: "aes_key_version", Columns: []AESRotationColumn{{Name: "aes_hex_value", Styles: []string{"aes", "hex"}}}, BatchSize: 2}
	if changed, err := db.RotateAESRows(ctx, db, spec, keyring); err == nil || changed != 0 || !strings.Contains(err.Error(), "rotation interruption") {
		t.Fatalf("mid-batch failure: changed=%d err=%v", changed, err)
	}
	var pending int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM rotation_failure WHERE aes_key_version = 1`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 2 {
		t.Fatalf("failed rotation partially committed: pending=%d", pending)
	}
	if _, err := sqlDB.ExecContext(ctx, `DROP TRIGGER rotation_failure_interrupt`); err != nil {
		t.Fatal(err)
	}
	if changed, err := db.RotateAESRows(ctx, db, spec, keyring); err != nil || changed != 2 {
		t.Fatalf("resume: changed=%d err=%v", changed, err)
	}
	if changed, err := db.RotateAESRows(ctx, db, spec, keyring); err != nil || changed != 0 {
		t.Fatalf("repeat: changed=%d err=%v", changed, err)
	}
}

func TestRotateAESRowsConcurrentCallLeavesNoMixedVersions(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "rotation-concurrent.sqlite") + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	first, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	ctx := context.Background()
	if _, err := first.ExecContext(ctx, `CREATE TABLE rotation_concurrent (id INTEGER PRIMARY KEY, aes_key_version INTEGER NOT NULL, aes_hex_value TEXT)`); err != nil {
		t.Fatal(err)
	}
	value, err := HostEncode("concurrent-value", []string{"aes", "hex"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 4; id++ {
		if _, err := first.ExecContext(ctx, `INSERT INTO rotation_concurrent (id, aes_key_version, aes_hex_value) VALUES (?, 1, ?)`, id, value); err != nil {
			t.Fatal(err)
		}
	}
	keyring, err := NewAESKeyring(map[int32]string{1: "old", 2: "new"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	spec := AESRotationSpec{Table: "rotation_concurrent", PrimaryKeys: []string{"id"}, VersionColumn: "aes_key_version", Columns: []AESRotationColumn{{Name: "aes_hex_value", Styles: []string{"aes", "hex"}}}, BatchSize: 4}
	dbs := []*DB{{SQL: first, driver: "sqlite", stmts: map[string]*sql.Stmt{}}, {SQL: second, driver: "sqlite", stmts: map[string]*sql.Stmt{}}}
	results := make(chan struct {
		changed int
		err     error
	}, len(dbs))
	var wg sync.WaitGroup
	for _, db := range dbs {
		wg.Add(1)
		go func(db *DB) {
			defer wg.Done()
			changed, err := db.RotateAESRows(ctx, db, spec, keyring)
			results <- struct {
				changed int
				err     error
			}{changed, err}
		}(db)
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for result := range results {
		if result.err == nil {
			if result.changed != 0 && result.changed != 4 {
				t.Fatalf("concurrent rotation changed=%d", result.changed)
			}
			succeeded++
		}
	}
	if succeeded == 0 {
		t.Fatal("both concurrent rotations failed")
	}
	var pending int
	if err := first.QueryRowContext(ctx, `SELECT COUNT(*) FROM rotation_concurrent WHERE aes_key_version <> 2`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("concurrent rotation left %d rows pending", pending)
	}
}
