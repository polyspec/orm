package orm

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/polyspec/orm/engine/ir"
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

func TestIsTransactionFinishedRecognizesORMTransactionState(t *testing.T) {
	if !IsTransactionFinished(&ir.Error{Code: CodeConfig, Msg: "transaction already finished"}) {
		t.Fatal("finished transaction error was not recognized")
	}
	if IsTransactionFinished(&ir.Error{Code: CodeConfig, Msg: "other configuration error"}) {
		t.Fatal("unrelated configuration error was recognized")
	}
}
