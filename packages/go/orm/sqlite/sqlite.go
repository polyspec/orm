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

// mapErr names the conditions that docs/spec/errors.yaml maps, and reports the remaining SQLite errors as DRIVER.
// SQLITE_BUSY reports a lock that another connection still held when the busy_timeout wait ended, so it is CANCELED.
// Every message ends with the name of the extended result code (INT-154).
func mapErr(err error) error {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return err
	}
	return &ir.Error{Code: sqliteCode(se), Msg: se.Error() + resultCodeSuffix(se.Code())}
}

// sqliteCode is the code of the error catalog for a SQLite error.
func sqliteCode(se *sqlite.Error) string {
	if se.Code()&0xff == 5 { // SQLITE_BUSY and its extended forms
		return orm.CodeCanceled
	}
	switch se.Code() {
	case 6, 262: // SQLITE_LOCKED / SQLITE_LOCKED_SHAREDCACHE
		return orm.CodeDeadlock
	case 2067, 1555: // SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY
		return orm.CodeDuplicateKey
	case 787: // SQLITE_CONSTRAINT_FOREIGNKEY
		return orm.CodeForeignKey
	case 1811: // SQLITE_CONSTRAINT_TRIGGER: a RESTRICT action is an FK error, and a trigger RAISE is DRIVER
		if strings.Contains(se.Error(), "FOREIGN KEY constraint failed") {
			return orm.CodeForeignKey
		}
	case 275: // SQLITE_CONSTRAINT_CHECK
		return orm.CodeConstraint
	case 9: // SQLITE_INTERRUPT: the statement was cancelled
		return orm.CodeCanceled
	}
	if se.Code()&0xff == 8 { // SQLITE_READONLY and its extended forms
		return orm.CodeReadOnly
	}
	return orm.CodeDriver
}
