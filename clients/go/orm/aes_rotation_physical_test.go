//go:build physical

package orm

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

func TestPhysicalAESRotation(t *testing.T) {
	targets := []struct{ driver, dsn string }{
		{"mysql", os.Getenv("ORM_MIGRATION_MYSQL_DSN")},
		{"postgres", os.Getenv("ORM_MIGRATION_POSTGRES_DSN")},
		{"sqlite", filepath.Join(t.TempDir(), "aes.sqlite")},
	}
	for _, target := range targets {
		t.Run(target.driver, func(t *testing.T) {
			if target.dsn == "" {
				t.Skip("physical database DSN is not configured")
			}
			testPhysicalAESRotation(t, target.driver, target.dsn)
		})
	}
}

func testPhysicalAESRotation(t *testing.T, driver, dsn string) {
	ctx := context.Background()
	sqlDriver := driver
	if driver == "postgres" {
		sqlDriver = "pgx"
	}
	sqlDB, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	if err := sqlDB.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	table := "orm_aes_rotation_test"
	q := func(name string) string {
		if driver == "mysql" {
			return "`" + name + "`"
		}
		return `"` + name + `"`
	}
	_, _ = sqlDB.ExecContext(ctx, "DROP TABLE IF EXISTS "+q(table))
	t.Cleanup(func() { _, _ = sqlDB.ExecContext(ctx, "DROP TABLE IF EXISTS "+q(table)) })
	if _, err := sqlDB.ExecContext(ctx, "CREATE TABLE "+q(table)+" ("+q("id")+" BIGINT PRIMARY KEY, "+q("aes_key_version")+" INTEGER NOT NULL, "+q("aes_hex_email")+" VARCHAR(255), "+q("aes_hex_phone")+" VARCHAR(255))"); err != nil {
		t.Fatal(err)
	}
	oldKey, newKey := "rotation-key-v1", "rotation-key-v2"
	email, err := HostEncode("member@example.test", []string{"aes", "hex"}, oldKey)
	if err != nil {
		t.Fatal(err)
	}
	phone, err := HostEncode("01012345678", []string{"aes", "hex"}, oldKey)
	if err != nil {
		t.Fatal(err)
	}
	ph := "?"
	if driver == "postgres" {
		ph = "$1, $2, $3, $4"
	} else {
		ph = "?, ?, ?, ?"
	}
	if _, err := sqlDB.ExecContext(ctx, "INSERT INTO "+q(table)+" ("+q("id")+", "+q("aes_key_version")+", "+q("aes_hex_email")+", "+q("aes_hex_phone")+") VALUES ("+ph+")", 1, 1, email, phone); err != nil {
		t.Fatal(err)
	}
	db := &DB{SQL: sqlDB, driver: driver, stmts: map[string]*sql.Stmt{}}
	keyring, err := NewAESKeyring(map[int32]string{1: oldKey, 2: newKey}, 2)
	if err != nil {
		t.Fatal(err)
	}
	spec := AESRotationSpec{Table: table, PrimaryKey: "id", VersionColumn: "aes_key_version", Columns: []AESRotationColumn{{Name: "aes_hex_email", Styles: []string{"aes", "hex"}}, {Name: "aes_hex_phone", Styles: []string{"aes", "hex"}}}}
	before, err := db.AESStatus(ctx, db, spec, keyring)
	if err != nil || before.Total != 1 || before.Pending != 1 || before.Versions[1] != 1 {
		t.Fatalf("before status: %#v, %v", before, err)
	}
	changed, err := db.RotateAESRows(ctx, db, spec, keyring)
	if err != nil || changed != 1 {
		t.Fatalf("rotate: changed=%d err=%v", changed, err)
	}
	after, err := db.AESStatus(ctx, db, spec, keyring)
	if err != nil || after.Pending != 0 || after.Versions[2] != 1 {
		t.Fatalf("after status: %#v, %v", after, err)
	}
	repeated, err := db.RotateAESRows(ctx, db, spec, keyring)
	if err != nil || repeated != 0 {
		t.Fatalf("repeat: changed=%d err=%v", repeated, err)
	}
	var storedVersion int32
	var storedEmail, storedPhone string
	if err := sqlDB.QueryRowContext(ctx, "SELECT "+q("aes_key_version")+", "+q("aes_hex_email")+", "+q("aes_hex_phone")+" FROM "+q(table)+" WHERE "+q("id")+" = 1").Scan(&storedVersion, &storedEmail, &storedPhone); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]struct{ stored, want string }{"email": {storedEmail, "member@example.test"}, "phone": {storedPhone, "01012345678"}} {
		plain, err := hostDecode(value.stored, []string{"aes", "hex"}, newKey)
		if err != nil || plain != value.want {
			t.Fatalf("%s decode: value=%v err=%v", name, plain, err)
		}
	}
	if storedVersion != 2 {
		t.Fatalf("stored version=%d", storedVersion)
	}
	if _, err := hostDecode(storedEmail, []string{"aes", "hex"}, oldKey); err == nil {
		t.Fatal("old key decoded rotated value")
	}
}
