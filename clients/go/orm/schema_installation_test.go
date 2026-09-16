package orm

import (
	"context"
	"database/sql"
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestTransactionProvidesCanonicalSchemaInstallation(t *testing.T) {
	method, ok := reflect.TypeOf((*Tx)(nil)).MethodByName("InstallSchema")
	if !ok {
		t.Fatal("transaction is missing InstallSchema(context.Context, []byte) error")
	}
	want := reflect.FuncOf(
		[]reflect.Type{reflect.TypeOf((*Tx)(nil)), reflect.TypeOf((*context.Context)(nil)).Elem(), reflect.TypeOf([]byte{})},
		[]reflect.Type{reflect.TypeOf((*error)(nil)).Elem()},
		false,
	)
	if method.Type != want {
		t.Fatalf("InstallSchema signature = %s, want %s", method.Type, want)
	}
}

func TestInstallSchemaUsesTheBoundSQLiteDialect(t *testing.T) {
	diagram := `erDiagram
%% orm:table entity=counter name=sample.counter
  counter {
    bigint seq PK "auto"
    varchar(120) label
  }
`
	document, err := schema.Parse(diagram)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(document)
	if err != nil {
		t.Fatal(err)
	}
	manifestJSON, err := manifest.MarshalIndent()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := sql.Open("sqlite", "file:"+t.TempDir()+"/schema.sqlite?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	db := &DB{SQL: sqlDB, driver: "sqlite", stmts: map[string]*sql.Stmt{}}
	tx, err := Begin(context.Background(), db, TransactionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := tx.InstallSchema(context.Background(), manifestJSON); err != nil {
		t.Fatal(err)
	}
	if db.EngineFor(manifest.SchemaHash) == nil {
		t.Fatalf("installed schema %s was not registered with the ORM database", manifest.SchemaHash)
	}
	installed, err := tx.SchemaInstalled(context.Background(), "sample", "counter")
	if err != nil {
		t.Fatal(err)
	}
	if !installed {
		t.Fatal("canonical schema was not installed")
	}
}
