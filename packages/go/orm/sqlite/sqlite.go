// Package sqlite registers the SQLite driver with the executor. Import it for
// its side effect in a program that opens a "sqlite" database:
//
//	import _ "github.com/polyspec/orm/packages/go/orm/sqlite"
//
// It is a separate package so a MySQL-only program does not link modernc's
// SQLite (several megabytes of transpiled C, plus a package init that reads
// /etc/services).
package sqlite

import (
	"errors"
	"strings"

	sqlite "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/orm"
)

func init() {
	orm.RegisterDriver("sqlite", "sqlite", mapErr)
	orm.RegisterSQLiteVersion(sqlite3.SQLITE_VERSION)
}

// mapErr names the conditions that docs/spec/errors.yaml maps, and the executor
// reports the remaining driver errors as DRIVER. SQLITE_BUSY reports a lock that another connection
// still held when the busy_timeout wait ended, so it is CANCELED.
func mapErr(err error) error {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return err
	}
	if code := sqliteCode(se.Code(), se.Error()); code != "" {
		return &ir.Error{Code: code, Msg: se.Error()}
	}
	return err
}

// sqliteCode is the ORM code of a SQLite extended result code n, or "" when the executor reports the error as DRIVER.
func sqliteCode(n int, msg string) string {
	if n&0xff == 5 { // SQLITE_BUSY and its extended forms
		return orm.CodeCanceled
	}
	switch n {
	case 6, 262: // SQLITE_LOCKED / SQLITE_LOCKED_SHAREDCACHE: no row-lock deadlock, so DRIVER (errors.yaml)
		return orm.CodeDriver
	case 2067, 1555: // SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY
		return orm.CodeDuplicateKey
	case 787: // SQLITE_CONSTRAINT_FOREIGNKEY
		return orm.CodeForeignKey
	case 1811: // SQLITE_CONSTRAINT_TRIGGER: a RESTRICT action is an FK error, and a trigger RAISE is DRIVER
		if strings.Contains(msg, "FOREIGN KEY constraint failed") {
			return orm.CodeForeignKey
		}
	case 275: // SQLITE_CONSTRAINT_CHECK
		return orm.CodeConstraint
	case 9: // SQLITE_INTERRUPT: the statement was cancelled
		return orm.CodeCanceled
	}
	if n&0xff == 8 { // SQLITE_READONLY and its extended forms
		return orm.CodeReadOnly
	}
	return ""
}
