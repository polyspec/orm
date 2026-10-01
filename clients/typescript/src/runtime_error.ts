export class OrmError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'OrmError';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 원인과 실패한 transaction 끝을 함께 보고한다(docs/interfaces.md). */
export function rollbackFailed(cause: unknown, rollback: unknown): OrmError {
  return new OrmError('CONFIG', `transaction failed (${errorText(cause)}) and rollback failed (${errorText(rollback)})`, cause);
}

/** 오류가 하나면 그 오류, 여럿이면 message를 모은 CONFIG, 없으면 undefined다. */
export function joinedErrors(errors: readonly unknown[]): unknown {
  if (errors.length <= 1) return errors[0];
  return new OrmError('CONFIG', errors.map(errorText).join('; '), errors[0]);
}
