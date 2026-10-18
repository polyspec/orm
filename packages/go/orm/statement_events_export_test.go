package orm

import "context"

// ReadForTest is used by the server_transactions case of statement_events_test.go. It runs sqlText
// on the connection as a utility statement and reads the first row into dest. The statement publishes an event.
func ReadForTest(d *DB, sqlText string, dest ...any) error {
	return (runner{d: d, q: d.sql}).scan(context.Background(), KindUtility, nil, sqlText, nil, dest...)
}
