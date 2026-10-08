// TypeScript client의 test entry point다. package.json은 이것을 condition
// `orm-test`에서만 `@polyspec/orm/testing`으로 export하므로, process는
// Node가 `--conditions=orm-test`로 실행될 때만 이것을 resolve한다. package entry
// point는 이것을 export하지 않는다.
import { armRollbackFault, type Db } from './database.js';

/**
 * db의 connection에 test fault를 설정한다: callback이 실패한 다음 transaction의
 * rollback은 실행된 뒤 rollback 오류로 FAULT 오류를 보고하므로, transaction은
 * callback 오류와 fault를 가진 ROLLBACK 오류를 throw한다. fault는 그런 rollback이
 * 소비할 때까지 남는다.
 */
export function failNextRollback(db: Db): void {
  armRollbackFault(db);
}
