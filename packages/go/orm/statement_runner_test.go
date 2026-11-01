package orm_test

import (
	"fmt"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Checks the statement runner of INT-150 on SQLite, MySQL, and PostgreSQL. utils().Run calls its function with a
// transaction frame: outside a transaction it opens one and ends it without retry, and inside a transaction it joins
// that one, so the statement events of the joined statement carry the transaction of the outer begin and no second
// begin is sent. The frame's Run sends SELECT 1 and returns its rows. A statement the database refuses fails with the
// database error code, not CONFIG. A non-text statement cannot be passed to the typed Go Run, so no CONFIG case is
// written for it here.

// statementRunnerCount returns the number of events of kind.
func statementRunnerCount(events []orm.StatementEvent, kind string) int {
	n := 0
	for _, e := range events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

// statementRunnerFirstNumber reads the first column of the first row as an integer, whatever type the driver returned.
func statementRunnerFirstNumber(t *testing.T, rows [][]any) int64 {
	t.Helper()
	if len(rows) != 1 || len(rows[0]) != 1 {
		t.Fatalf("SELECT 1 returned %d rows; want one row of one column", len(rows))
	}
	switch v := rows[0][0].(type) {
	case int64:
		return v
	case int32:
		return int64(v)
	case []byte:
		var n int64
		if _, err := fmt.Sscan(string(v), &n); err != nil {
			t.Fatalf("SELECT 1 returned %q: %v", v, err)
		}
		return n
	case string:
		var n int64
		if _, err := fmt.Sscan(v, &n); err != nil {
			t.Fatalf("SELECT 1 returned %q: %v", v, err)
		}
		return n
	default:
		t.Fatalf("SELECT 1 returned %T %v", v, v)
	}
	return 0
}

func statementRunnerCase(t *testing.T, driver string) {
	db, err := orm.Connect(newDatabase(t, driver), orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	events, unsubscribe := subscribeStatementEvents(t, db)
	defer unsubscribe()

	// Outside a transaction, utils().Run opens one and the frame's Run returns the rows of SELECT 1.
	var outside orm.StatementResult
	err = db.Utils().Run(func(f *orm.TxFrame) error {
		res, err := f.Run(orm.KindSelect, nil, "SELECT 1")
		outside = res
		return err
	})
	if err != nil {
		t.Fatalf("%s: utils().Run outside a transaction: %v", driver, err)
	}
	if n := statementRunnerFirstNumber(t, outside.Rows); n != 1 {
		t.Fatalf("%s: utils().Run outside a transaction returned %d; want 1", driver, n)
	}
	if n := statementRunnerCount(*events, orm.KindBegin); n != 1 {
		t.Fatalf("%s: utils().Run outside a transaction sent %d begin statements; want 1", driver, n)
	}
	selects := 0
	for _, e := range *events {
		if e.Kind == orm.KindSelect && e.SQL == "SELECT 1" {
			selects++
			if e.Transaction == 0 {
				t.Fatalf("%s: the SELECT 1 event is outside a transaction", driver)
			}
		}
	}
	if selects != 1 {
		t.Fatalf("%s: SELECT 1 recorded %d statement events; want 1", driver, selects)
	}

	// Inside a transaction, utils().Run joins it: no second begin is sent, and the statement runs in the outer transaction.
	*events = nil
	var inside orm.StatementResult
	err = db.Transaction(func() error {
		return db.Utils().Run(func(f *orm.TxFrame) error {
			res, err := f.Run(orm.KindSelect, nil, "SELECT 1")
			inside = res
			return err
		})
	}, orm.Retry(0))
	if err != nil {
		t.Fatalf("%s: utils().Run inside a transaction: %v", driver, err)
	}
	if n := statementRunnerFirstNumber(t, inside.Rows); n != 1 {
		t.Fatalf("%s: utils().Run inside a transaction returned %d; want 1", driver, n)
	}
	if n := statementRunnerCount(*events, orm.KindBegin); n != 1 {
		t.Fatalf("%s: utils().Run inside a transaction sent %d begin statements; want 1 (the outer transaction only)", driver, n)
	}
	var begin, query *orm.StatementEvent
	for i := range *events {
		e := &(*events)[i]
		switch {
		case e.Kind == orm.KindBegin && begin == nil:
			begin = e
		case e.Kind == orm.KindSelect && e.SQL == "SELECT 1":
			query = e
		}
	}
	if begin == nil || query == nil || query.Transaction != begin.Transaction {
		t.Fatalf("%s: the SELECT 1 inside a transaction did not run in the outer transaction", driver)
	}

	// A statement the database refuses fails with the database error code, not CONFIG.
	err = db.Utils().Run(func(f *orm.TxFrame) error {
		_, err := f.Run(orm.KindSelect, []string{"statement_runner_missing"}, "SELECT * FROM statement_runner_missing")
		return err
	})
	if err == nil {
		t.Fatalf("%s: a SELECT of a missing table succeeded", driver)
	}
	if orm.ErrorCode(err) == orm.CodeConfig {
		t.Fatalf("%s: a SELECT of a missing table failed with CONFIG: %v", driver, err)
	}
}

// Requirements: INT-150, INT-77.
func TestStatementRunnerSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	statementRunnerCase(t, "sqlite")
}

func TestStatementRunnerMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	statementRunnerCase(t, "mysql")
}

func TestStatementRunnerPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	statementRunnerCase(t, "postgres")
}
