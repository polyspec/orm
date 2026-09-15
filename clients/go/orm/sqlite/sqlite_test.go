package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/clients/go/orm"
)

func TestMapErrPreservesSQLiteConstraintContract(t *testing.T) {
	db, err := sql.Open("sqlite", "file:orm-sqlite-error-contract?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), code TEXT NOT NULL UNIQUE); INSERT INTO parent(id) VALUES (1); INSERT INTO child(parent_id, code) VALUES (1, 'one')`); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		stmt string
		want string
	}{
		{name: "duplicate", stmt: `INSERT INTO child(parent_id, code) VALUES (1, 'one')`, want: orm.CodeDuplicateKey},
		{name: "foreign key", stmt: `INSERT INTO child(parent_id, code) VALUES (99, 'two')`, want: orm.CodeForeignKey},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := db.ExecContext(ctx, tt.stmt)
			if err == nil {
				t.Fatal("statement unexpectedly succeeded")
			}
			mapped := mapErr(err)
			if got := orm.ErrorCode(mapped); got != tt.want {
				t.Fatalf("mapped SQLite error code = %q, want %q: %v", got, tt.want, mapped)
			}
			if errors.Is(mapped, err) {
				t.Fatal("mapped error must be the ORM error boundary, not the driver error")
			}
		})
	}
}
