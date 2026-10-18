//go:build ormtest

package orm

import "time"

// FailNextRollback sets a test fault on the connection of db and on all of its handles.
// After a transaction whose callback failed, the rollback runs first, and then the rollback
// reports a FAULT error, so the transaction returns both the callback error and the fault as
// a ROLLBACK error. The fault remains until such a rollback consumes it.
// This function exists only in builds with the ormtest build tag.
func FailNextRollback(db *DB) {
	db.m.rollbackFault.Store(true)
}

// FailNextStatement sets a test fault on the connection of db and on all of its handles.
// The next statement fails without being sent to the database, with an error that has the code and message,
// and that error is attached to the statement event when the statement ends. A transaction
// control statement does not consume the fault. A set fault is replaced by the new fault.
// If code or message is empty, it panics and sets nothing.
// This function exists only in builds with the ormtest build tag.
func FailNextStatement(db *DB, code, message string) {
	if code == "" || message == "" {
		panic("orm: FailNextStatement needs a nonempty code and message")
	}
	db.m.statementFault.Store(&stmtFault{code: code, msg: message})
}

// FixClock fixes the executor clock of the connection of db and of all of its handles
// to the clock time. The clock is UTC text in the form `YYYY-MM-DD HH:MM:SS.ffffff`.
// If the format differs, it panics and sets nothing (docs/protocol.md "Test clock").
// This function exists only in builds with the ormtest build tag.
func FixClock(db *DB, clock string) {
	t, err := time.ParseInLocation("2006-01-02 15:04:05.000000", clock, time.UTC)
	if err != nil {
		panic("orm: FixClock needs a YYYY-MM-DD HH:MM:SS.ffffff clock: " + err.Error())
	}
	db.m.fixedClock.Store(&t)
}

// LastAffected returns the affected count of the last successful write result on the connection of db and on all of its handles,
// along with true. If there was no successful write, it returns 0 and false (docs/protocol.md
// "Test write result"). This function exists only in builds with the ormtest build tag.
func LastAffected(db *DB) (int64, bool) {
	n := db.m.lastAffected.Load()
	return n - 1, n > 0
}
