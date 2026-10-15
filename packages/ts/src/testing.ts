// TypeScript client의 test entry point다. package.json은 이것을 condition
// `orm-test`에서만 `@polyspec/orm/testing`으로 export하므로, process는
// Node가 `--conditions=orm-test`로 실행될 때만 이것을 resolve한다. package entry
// point는 이것을 export하지 않는다.
import { armFixedClock, armRollbackFault, armStatementFault, type Db } from './database.js';

/**
 * db의 connection에 test fault를 설정한다: callback이 실패한 다음 transaction의
 * rollback은 실행된 뒤 rollback 오류로 FAULT 오류를 보고하므로, transaction은
 * callback 오류와 fault를 가진 ROLLBACK 오류를 throw한다. fault는 그런 rollback이
 * 소비할 때까지 남는다.
 */
export function failNextRollback(db: Db): void {
  armRollbackFault(db);
}

/**
 * db의 connection에 statement fault를 설정한다: 다음 query, model 또는 schema statement는
 * 보내지 않고 code와 message의 OrmError로 거부되며, 그 statement의 event가 오류를 싣는다.
 * transaction control statement는 fault를 소비하지 않는다. 다시 설정하면 이전 fault를 대체한다.
 * code나 message가 빈 문자열이면 TypeError를 throw하고 아무것도 설정하지 않는다.
 */
export function failNextStatement(db: Db, code: string, message: string): void {
  if (typeof code !== 'string' || code === '') throw new TypeError('failNextStatement: code must be a nonempty string');
  if (typeof message !== 'string' || message === '') throw new TypeError('failNextStatement: message must be a nonempty string');
  armStatementFault(db, code, message);
}

/**
 * db의 connection의 executor clock을 clock 시각으로 고정한다. clock은 UTC의 `YYYY-MM-DD HH:MM:SS.ffffff` text다.
 * 형식이 다르면 TypeError를 throw하고 아무것도 설정하지 않는다(docs/protocol.md "Test clock").
 */
export function fixClock(db: Db, clock: string): void {
  const m = typeof clock === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/.exec(clock) : null;
  if (m === null) throw new TypeError('fixClock: clock must be YYYY-MM-DD HH:MM:SS.ffffff');
  const millis = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  armFixedClock(db, millis * 1000 + Number(m[7]));
}
