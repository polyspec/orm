//go:build physical

package ormgen

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	_ "github.com/go-sql-driver/mysql"
)

// openMySQL opens the MySQL database named by ORM_TOOLS_MYSQL_DSN.
func openMySQL(t *testing.T) (*sql.DB, context.Context) {
	t.Helper()
	dsn := os.Getenv("ORM_TOOLS_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TOOLS_MYSQL_DSN is required; physical DB tests never skip")
	}
	db, _, err := openToolDB(dsn)
	if err != nil {
		t.Fatalf("open MySQL: %v", err)
	}
	return db, context.Background()
}

// TestMySQLTextColumnLiteralDefault verifies that TEXT columns with literal defaults
// use the expression form DEFAULT ('value') on MySQL 8.4+.
func TestMySQLTextColumnLiteralDefault(t *testing.T) {
	db, ctx := openMySQL(t)
	defer db.Close()

	source := "erDiagram\n" +
		"  text_default_table {\n" +
		"    bigint       id      PK \"auto\"\n" +
		"    text         content \"=hello\"\n" +
		"  }\n"

	m := buildLiveDiffManifest(t, source)
	create, err := renderCreateDDL(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}

	// Verify that TEXT defaults use expression form: DEFAULT ('hello')
	if !strings.Contains(create, "DEFAULT ('hello')") {
		t.Fatalf("TEXT column default should use DEFAULT ('value') syntax on MySQL:\n%s", create)
	}

	// Verify that it doesn't use bare default: DEFAULT hello
	if strings.Contains(create, "DEFAULT hello") {
		t.Fatalf("TEXT column should not use bare literal default on MySQL:\n%s", create)
	}

	dropTableIfExists(t, ctx, db, "text_default_table")
	defer dropTableIfExists(t, ctx, db, "text_default_table")
	if err := executeMigration(ctx, db, "mysql", create); err != nil {
		t.Fatalf("MySQL rejected the DDL:\n%s\n%v", create, err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO `text_default_table` () VALUES ()"); err != nil {
		t.Fatalf("insert without content: %v", err)
	}
	var content string
	if err := db.QueryRowContext(ctx, "SELECT `content` FROM `text_default_table`").Scan(&content); err != nil || content != "hello" {
		t.Fatalf("content = %q, %v; want the default hello", content, err)
	}
}

// TestMySQLSchemaDatabaseCreation verifies that MySQL creates the database when
// a schema-qualified table is declared.
func TestMySQLSchemaDatabaseCreation(t *testing.T) {
	db, ctx := openMySQL(t)
	defer db.Close()

	source := "erDiagram\n" +
		"  schema_table {\n" +
		"    bigint       id      PK \"auto\"\n" +
		"    varchar(191) name\n" +
		"  }\n" +
		"  %% orm:table entity=schema_table name=my_schema.schema_table\n"

	m := buildLiveDiffManifest(t, source)
	create, err := renderCreateDDL(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}

	// Verify that CREATE DATABASE is in the DDL
	if !strings.Contains(create, "CREATE DATABASE IF NOT EXISTS") {
		t.Fatalf("MySQL DDL should create database for schema-qualified tables:\n%s", create)
	}

	if !strings.Contains(create, "`my_schema`") {
		t.Fatalf("MySQL DDL should name the schema 'my_schema':\n%s", create)
	}

	// Execute the migration to verify it works
	dropSchemaIfExists(t, ctx, db, "my_schema")
	defer dropSchemaIfExists(t, ctx, db, "my_schema")

	if err := executeMigration(ctx, db, "mysql", create); err != nil {
		t.Fatalf("Failed to execute migration:\n%s\nError: %v", create, err)
	}

	// Verify the database was created
	var dbname string
	if err := db.QueryRowContext(ctx, "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'my_schema'").Scan(&dbname); err != nil {
		t.Fatalf("Schema 'my_schema' was not created: %v", err)
	}
}

// TestMySQLImmutableTriggers verifies that immutable triggers are generated and work on MySQL.
func TestMySQLImmutableTriggers(t *testing.T) {
	db, ctx := openMySQL(t)
	defer db.Close()

	source := "erDiagram\n" +
		"  immutable_table {\n" +
		"    bigint       id      PK \"auto\"\n" +
		"    varchar(191) name\n" +
		"  }\n" +
		"  %% orm:immutable entity=immutable_table\n"

	m := buildLiveDiffManifest(t, source)
	create, err := renderCreateDDL(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}

	// Verify that triggers are created
	if !strings.Contains(strings.ToLower(create), "create trigger") {
		t.Fatalf("MySQL DDL should create immutable triggers:\n%s", create)
	}

	if !strings.Contains(strings.ToUpper(create), "BEFORE UPDATE") && !strings.Contains(strings.ToUpper(create), "BEFORE DELETE") {
		t.Fatalf("MySQL DDL should create BEFORE UPDATE/DELETE triggers:\n%s", create)
	}

	// Clean up
	dropTableIfExists(t, ctx, db, "immutable_table")
	defer dropTableIfExists(t, ctx, db, "immutable_table")

	// Execute the migration
	if err := executeMigration(ctx, db, "mysql", create); err != nil {
		t.Fatalf("Failed to execute migration:\n%s\nError: %v", create, err)
	}

	// Insert a row outside of a transaction so it commits
	if _, err := db.ExecContext(ctx, "INSERT INTO `immutable_table` (`name`) VALUES ('test')"); err != nil {
		t.Fatalf("Insert failed: %v", err)
	}

	// Try to update - should be rejected by trigger
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx, "UPDATE `immutable_table` SET `name` = 'updated' WHERE `id` = 1")
	if err == nil {
		t.Fatal("UPDATE on immutable table should be rejected by trigger")
	}
	if !strings.Contains(err.Error(), "45000") && !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("UPDATE error should mention immutable table: %v", err)
	}

	// Rollback the failed transaction
	tx.Rollback()

	// Try to delete in a separate transaction - should also be rejected
	tx, err = db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx, "DELETE FROM `immutable_table` WHERE `id` = 1")
	if err == nil {
		t.Fatal("DELETE on immutable table should be rejected by trigger")
	}
	if !strings.Contains(err.Error(), "45000") && !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("DELETE error should mention immutable table or 45000 SQLSTATE: %v", err)
	}
}

func dropTableIfExists(t *testing.T, ctx context.Context, db *sql.DB, table string) {
	t.Helper()
	_, _ = db.ExecContext(ctx, "DROP TABLE IF EXISTS `"+table+"`")
}

func dropSchemaIfExists(t *testing.T, ctx context.Context, db *sql.DB, schema string) {
	t.Helper()
	_, _ = db.ExecContext(ctx, "DROP DATABASE IF EXISTS `"+schema+"`")
}
