// The test entry point of the TypeScript client. package.json exports it as
// `@polyspec/orm-typescript/testing` only under the condition `orm-test`, so a
// process resolves it only when Node runs with `--conditions=orm-test`; the
// package entry point does not export it.
import { armRollbackFault, type Db } from './database.js';

/**
 * Arms a test fault on the connection of db: the next rollback of a
 * transaction whose callback failed runs, and then reports a FAULT error as
 * its rollback error, so the transaction throws a ROLLBACK error that keeps
 * the callback error and the fault. The fault stays armed until such a
 * rollback consumes it.
 */
export function failNextRollback(db: Db): void {
  armRollbackFault(db);
}
