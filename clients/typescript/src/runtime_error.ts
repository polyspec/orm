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
 * transaction이나 savepoint를 끝낸 원인과 실패한 rollback을 하나의 ROLLBACK 오류로 보고한다
 * (docs/interfaces.md). cause는 원인이고 rollback은 rollback 오류다. ROLLBACK 오류는 retry하지 않는다.
 */
export function rollbackFailed(cause: unknown, rollback: unknown): OrmError {
  return new OrmError('ROLLBACK', `transaction failed (${errorText(cause)}) and rollback failed (${errorText(rollback)})`, cause, rollback);
}

/** 오류가 하나면 그 오류, 여럿이면 message를 모은 CONFIG, 없으면 undefined다. */
export function joinedErrors(errors: readonly unknown[]): unknown {
  if (errors.length <= 1) return errors[0];
  return new OrmError('CONFIG', errors.map(errorText).join('; '), errors[0]);
}
