import * as codes from './codes.js';
export class OrmError extends Error {
  /** The rollback error of a ROLLBACK error, whose cause is the callback error. */
  public readonly rollback?: unknown;

  public constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
    rollback?: unknown,
  ) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'OrmError';
    if (rollback !== undefined) this.rollback = rollback;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reports the cause that ended the transaction or savepoint, and a failed rollback, as a single ROLLBACK error
 * (docs/spec/interfaces.md). cause is the cause, and rollback is the rollback error. A ROLLBACK error is not retried.
 */
export function rollbackFailed(cause: unknown, rollback: unknown): OrmError {
  return new OrmError(codes.ROLLBACK, `transaction failed (${errorText(cause)}) and rollback failed (${errorText(rollback)})`, cause, rollback);
}

/** If there is one error, that error; if there are several, a CONFIG that gathers their messages; if none, undefined. */
export function joinedErrors(errors: readonly unknown[]): unknown {
  if (errors.length <= 1) return errors[0];
  return new OrmError(codes.CONFIG, errors.map(errorText).join('; '), errors[0]);
}
