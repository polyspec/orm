//go:build ormtest

package orm

import "time"

// FailNextRollback는 db의 connection과 그 connection의 모든 handle에 test fault를
// 설정한다. callback이 실패한 다음 transaction의 rollback은 실행된 뒤 rollback
// 오류로 FAULT 오류를 보고하므로, transaction은 callback 오류와 fault를 가진
// ROLLBACK 오류를 반환한다. fault는 그런 rollback이 소비할 때까지 남는다.
// 이 함수는 build tag ormtest가 있는 build에만 있다.
func FailNextRollback(db *DB) {
	db.m.rollbackFault.Store(true)
}

// FailNextStatement는 db의 connection과 그 connection의 모든 handle에 test fault를
// 설정한다. 다음 statement는 database에 보내지 않고 code와 message를 가진 오류로
// 실패하며, 그 오류는 statement가 끝날 때 statement event에 실린다. transaction
// control statement는 fault를 소비하지 않는다. 설정된 fault는 새 fault로 바뀐다.
// code나 message가 비어 있으면 panic하고 아무것도 설정하지 않는다.
// 이 함수는 build tag ormtest가 있는 build에만 있다.
func FailNextStatement(db *DB, code, message string) {
	if code == "" || message == "" {
		panic("orm: FailNextStatement needs a nonempty code and message")
	}
	db.m.statementFault.Store(&stmtFault{code: code, msg: message})
}

// FixClock는 db의 connection과 그 connection의 모든 handle의 executor clock을
// clock 시각으로 고정한다. clock은 UTC의 `YYYY-MM-DD HH:MM:SS.ffffff` text다.
// 형식이 다르면 panic하고 아무것도 설정하지 않는다(docs/protocol.md "Test clock").
// 이 함수는 build tag ormtest가 있는 build에만 있다.
func FixClock(db *DB, clock string) {
	t, err := time.ParseInLocation("2006-01-02 15:04:05.000000", clock, time.UTC)
	if err != nil {
		panic("orm: FixClock needs a YYYY-MM-DD HH:MM:SS.ffffff clock: " + err.Error())
	}
	db.m.fixedClock.Store(&t)
}

// LastAffected는 db의 connection과 그 모든 handle에서 마지막으로 성공한 write 결과의
// affected와 true를 돌려준다. 성공한 write가 없었으면 0과 false다(docs/protocol.md
// "Test write result"). 이 함수는 build tag ormtest가 있는 build에만 있다.
func LastAffected(db *DB) (int64, bool) {
	n := db.m.lastAffected.Load()
	return n - 1, n > 0
}
