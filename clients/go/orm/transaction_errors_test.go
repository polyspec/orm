package orm

import (
	"database/sql"
	"errors"
	"testing"
)

func TestIsNoRowsRecognizesDatabaseNoRows(t *testing.T) {
	if !IsNoRows(sql.ErrNoRows) {
		t.Fatal("sql.ErrNoRows was not recognized")
	}
	if !IsNoRows(errors.Join(sql.ErrNoRows, errors.New("context"))) {
		t.Fatal("wrapped sql.ErrNoRows was not recognized")
	}
	if IsNoRows(errors.New("other error")) {
		t.Fatal("unrelated error was recognized as no rows")
	}
}
