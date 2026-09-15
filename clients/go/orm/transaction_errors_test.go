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

func TestErrorClassificationExposesMappedCodes(t *testing.T) {
	deadlock := &ir.Error{Code: CodeDeadlock, Msg: "deadlock"}
	duplicate := &ir.Error{Code: CodeDuplicateKey, Msg: "duplicate"}
	foreignKey := &ir.Error{Code: CodeForeignKey, Msg: "foreign key"}
	if ErrorCode(deadlock) != CodeDeadlock || !IsDeadlock(deadlock) {
		t.Fatal("deadlock code was not exposed")
	}
	if ErrorCode(duplicate) != CodeDuplicateKey || !IsDuplicateKey(duplicate) {
		t.Fatal("duplicate-key code was not exposed")
	}
	if ErrorCode(foreignKey) != CodeForeignKey || !IsForeignKey(foreignKey) {
		t.Fatal("foreign-key code was not exposed")
	}
	if ErrorCode(errors.New("other")) != "" || IsDuplicateKey(errors.New("other")) || IsForeignKey(errors.New("other")) {
		t.Fatal("unrelated error was classified")
	}
}
