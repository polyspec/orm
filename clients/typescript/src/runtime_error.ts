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

/** The error of a callback that failed and whose rollback failed too. */
export function rollbackError(callback: unknown, rollback: unknown): OrmError {
  const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
  return new OrmError('ROLLBACK', `callback failed (${text(callback)}) and rollback failed (${text(rollback)})`, callback, rollback);
}
