// The test entry point of the TypeScript client. package.json maps this to `@polyspec/orm/testing` only under the condition
// `orm-test`, so the process
// resolves this only when Node runs with `--conditions=orm-test`. The package entry
// point does not export it.
import { armFixedClock, armRollbackFault, armStatementFault, readLastAffected, type Db } from './database.js';

/**
 * Sets a test fault on the connection of db: after the callback fails, the next transaction's
 * rollback runs, and then reports a FAULT error as the rollback error, so the transaction
 * throws the callback error and a ROLLBACK error that carries the fault. The fault remains until such a rollback
 * consumes it.
 */
export function failNextRollback(db: Db): void {
  armRollbackFault(db);
}

/**
 * Sets a statement fault on the connection of db: the next query, model, or schema statement is
 * not sent; it is rejected with an OrmError of the given code and message, and that statement's event carries the error.
 * Transaction control statements do not consume the fault. Setting it again replaces the previous fault.
 * If code or message is an empty string, it throws a TypeError and sets nothing.
 */
export function failNextStatement(db: Db, code: string, message: string): void {
  if (typeof code !== 'string' || code === '') throw new TypeError('failNextStatement: code must be a nonempty string');
  if (typeof message !== 'string' || message === '') throw new TypeError('failNextStatement: message must be a nonempty string');
  armStatementFault(db, code, message);
}

/**
 * Fixes the executor clock of the connection of db to the clock time. clock is UTC text in the form YYYY-MM-DD HH:MM:SS.ffffff.
 * If the form differs, it throws a TypeError and sets nothing (docs/spec/protocol.md "Test clock").
 */
export function fixClock(db: Db, clock: string): void {
  const m = typeof clock === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/.exec(clock) : null;
  if (m === null) throw new TypeError('fixClock: clock must be YYYY-MM-DD HH:MM:SS.ffffff');
  const millis = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  armFixedClock(db, millis * 1000 + Number(m[7]));
}

/**
 * The affected count of the last successful write result on the connection of db. If there has been no successful write, null.
 * (docs/spec/protocol.md "Test write result").
 */
export function lastAffected(db: Db): number | null {
  return readLastAffected(db);
}
