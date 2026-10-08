//go:build ormtest

package orm

// FailNextRollback는 db의 connection과 그 connection의 모든 handle에 test fault를
// 설정한다. callback이 실패한 다음 transaction의 rollback은 실행된 뒤 rollback
// 오류로 FAULT 오류를 보고하므로, transaction은 callback 오류와 fault를 가진
// ROLLBACK 오류를 반환한다. fault는 그런 rollback이 소비할 때까지 남는다.
// 이 함수는 build tag ormtest가 있는 build에만 있다.
func FailNextRollback(db *DB) {
	db.m.rollbackFault.Store(true)
}
