# OrmError: carries the code and message of an error during execution together.
# The code list is defined by docs/interfaces.md.

from polyspec.orm import codes


class OrmError(Exception):
    """A failure of the library with its stable error code."""

    def __init__(
        self, code: str, message: str, cause: object = None, rollback: object = None
    ):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.cause = cause
        # ROLLBACK error: a rollback failure; its cause is cause.
        if rollback is not None:
            self.rollback = rollback


def _error_text(error: object) -> str:
    if isinstance(error, Exception):
        return str(error)
    return str(error)


def rollback_failed(cause: object, rollback: object) -> OrmError:
    """Reports the cause that ended a transaction or savepoint, and a failed rollback,
    as a single ROLLBACK error (docs/interfaces.md). cause is the cause, and
    rollback is the rollback error. A ROLLBACK error is not retried."""
    return OrmError(
        codes.ROLLBACK,
        f"transaction failed ({_error_text(cause)}) "
        f"and rollback failed ({_error_text(rollback)})",
        cause,
        rollback,
    )


def joined_errors(errors: list) -> object:
    """If there is one error, that error; if there are several, a CONFIG error that collects their messages; if none, None."""
    if len(errors) <= 1:
        return errors[0] if errors else None
    return OrmError(
        codes.CONFIG, "; ".join(_error_text(error) for error in errors), errors[0]
    )
