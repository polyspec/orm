package orm

import "context"

// ReadForTest는 statement_events_test.go의 server_transactions case가 쓴다. sqlText를 연결에서
// utility statement로 실행하고 첫 행을 dest에 읽는다. statement는 event를 publish한다.
func ReadForTest(d *DB, sqlText string, dest ...any) error {
	return (runner{d: d, q: d.sql}).scan(context.Background(), KindUtility, nil, sqlText, nil, dest...)
}
