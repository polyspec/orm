// Package sqlite registers the SQLite driver with the executor. Import it for
// its side effect in a program that opens a "sqlite" database:
//
//	import _ "github.com/polyspec/orm/clients/go/orm/sqlite"
//
// It is a separate package so a MySQL-only program does not link modernc's
// SQLite (several megabytes of transpiled C, plus a package init that reads
// /etc/services).
package sqlite

import (
	"errors"

	sqlite "modernc.org/sqlite"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/ir"
)

func init() { orm.RegisterDriver("sqlite", "sqlite", mapErr) }

// mapErr names the conditions docs/errors.yaml maps; everything else keeps
// the driver's own error. SQLITE_BUSY reports a lock that another connection
// still held when the busy_timeout wait ended, so it is CANCELED.
func mapErr(err error) error {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return err
	}
	if se.Code()&0xff == 5 { // SQLITE_BUSY and its extended forms
		return &ir.Error{Code: orm.CodeCanceled, Msg: se.Error()}
	}
	switch se.Code() {
	case 6, 262: // SQLITE_LOCKED / SQLITE_LOCKED_SHAREDCACHE
		return &ir.Error{Code: orm.CodeDeadlock, Msg: se.Error()}
	case 2067, 1555: // SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY
		return &ir.Error{Code: orm.CodeDuplicateKey, Msg: se.Error()}
	case 787, 1811: // SQLITE_CONSTRAINT_FOREIGNKEY / _VTab
		return &ir.Error{Code: orm.CodeForeignKey, Msg: se.Error()}
	case 275: // SQLITE_CONSTRAINT_CHECK
		return &ir.Error{Code: orm.CodeConstraint, Msg: se.Error()}
	case 9: // SQLITE_INTERRUPT: the statement was cancelled
		return &ir.Error{Code: orm.CodeCanceled, Msg: se.Error()}
	}
	return err
}
