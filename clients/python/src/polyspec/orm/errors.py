# OrmError: 실행 중 오류의 code와 message를 함께 전달한다.
# code 목록은 docs/interfaces.md가 정의한다.


class OrmError(Exception):
    """A failure of the library with its stable error code."""

    def __init__(self, code: str, message: str, cause: object = None,
                 rollback: object = None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.cause = cause
        # ROLLBACK 오류의 rollback 실패; 그 원인은 cause다.
        if rollback is not None:
            self.rollback = rollback


def _error_text(error: object) -> str:
    if isinstance(error, Exception):
        return str(error)
    return str(error)


def rollback_failed(cause: object, rollback: object) -> OrmError:
    """transaction이나 savepoint를 끝낸 원인과 실패한 rollback을 하나의
    ROLLBACK 오류로 보고한다 (docs/interfaces.md). cause는 원인이고
    rollback은 rollback 오류다. ROLLBACK 오류는 retry하지 않는다."""
    return OrmError('ROLLBACK', f'transaction failed ({_error_text(cause)}) '
                                f'and rollback failed ({_error_text(rollback)})',
                    cause, rollback)


def joined_errors(errors: list) -> object:
    """오류가 하나면 그 오류, 여럿이면 message를 모은 CONFIG, 없으면 None이다."""
    if len(errors) <= 1:
        return errors[0] if errors else None
    return OrmError('CONFIG', '; '.join(_error_text(error) for error in errors),
                    errors[0])
