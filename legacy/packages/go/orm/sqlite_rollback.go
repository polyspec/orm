package orm

import (
	"database/sql"
	"sync/atomic"
)

// rollbackWatch learns from SQLite's rollback hook that SQLite rolled the transaction of a connection back by itself, as it
// does after RAISE(ROLLBACK), an I/O error or a full disk. A ROLLBACK sent after that fails with "no transaction is active"
// and would stack a rollback failure on the error that ended the transaction, so it is not sent (INT-155). SQLite has no
// other API that tells it apart: the driver does not expose sqlite3_get_autocommit.
type rollbackWatch struct {
	rolled atomic.Bool
	set    bool
}

// watchRollback sets the rollback hook of conn, a SQLite connection inside its transaction.
func watchRollback(conn *sql.Conn) (*rollbackWatch, error) {
	w := &rollbackWatch{}
	hook := registeredSQLiteRollbackHook()
	if hook == nil {
		return w, nil
	}
	markdown := false
	err := conn.Raw(func(driverConn any) error {
		// A flowmark session keeps its transaction open after a failed statement, so it has no rollback to learn of.
		if _, markdown = driverConn.(*mdConn); markdown {
			return nil
		}
		return hook(driverConn, func() { w.rolled.Store(true) })
	})
	if err != nil {
		return w, mapDriverErr(err, "")
	}
	w.set = !markdown
	return w, nil
}

// open reports whether the transaction is still open, so that ROLLBACK has a transaction to end. A connection without a
// watch (MySQL, PostgreSQL) is open.
func (w *rollbackWatch) open() bool {
	return w == nil || !w.rolled.Load()
}

// stop clears the rollback hook of conn before the connection goes back to the pool.
func (w *rollbackWatch) stop(conn *sql.Conn) error {
	if w == nil || !w.set {
		return nil
	}
	w.set = false
	hook := registeredSQLiteRollbackHook()
	if err := conn.Raw(func(driverConn any) error { return hook(driverConn, nil) }); err != nil {
		return mapDriverErr(err, "")
	}
	return nil
}
