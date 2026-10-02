//go:build ormtest

package orm

// FailNextRollback arms a test fault on the connection of db and on every
// handle of that connection. The next rollback of a transaction whose
// callback failed runs, and then reports a FAULT error as its rollback error,
// so the transaction returns a ROLLBACK error that keeps the callback error
// and the fault. The fault stays armed until such a rollback consumes it.
// This function exists only in a build with the tag ormtest.
func FailNextRollback(db *DB) {
	db.m.rollbackFault.Store(true)
}
