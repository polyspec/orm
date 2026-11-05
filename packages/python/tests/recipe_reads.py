"""The run-time read of a recipe step (FCV-4): a key of a step or of its outcome that the helper never reads asserts
nothing, so a run records what it reads and an unread key fails the case by name."""

from __future__ import annotations

from typing import Any

# Keys that the format holds for the reader of the recipe or for the runner of the step, which no op reads; expect_unnamed
# is the outcome of a driver with unnamed parameters, which this runtime does not have.
_ANNOTATIONS = frozenset({"op", "only", "reason", "expect_unnamed"})


class _Recording(dict):
    """A step or an outcome that records the keys read from it, and every key when it is read whole."""

    def __init__(self, value: dict, read: set[str], prefix: str) -> None:
        super().__init__(value)
        self._read = read
        self._prefix = prefix

    def _mark(self, key: Any) -> None:
        if isinstance(key, str):
            self._read.add(self._prefix + key)

    def _mark_all(self) -> None:
        for key in dict.keys(self):
            self._mark(key)

    def __getitem__(self, key: Any) -> Any:
        self._mark(key)
        return super().__getitem__(key)

    def get(self, key: Any, default: Any = None) -> Any:
        self._mark(key)
        return super().get(key, default)

    def __contains__(self, key: object) -> bool:
        self._mark(key)
        return super().__contains__(key)

    def items(self) -> Any:
        self._mark_all()
        return super().items()

    def values(self) -> Any:
        self._mark_all()
        return super().values()

    def __eq__(self, other: object) -> bool:
        self._mark_all()
        return super().__eq__(other)

    def __ne__(self, other: object) -> bool:
        self._mark_all()
        return super().__ne__(other)

    __hash__ = None  # type: ignore[assignment]


class _Expect(dict):
    """The expect of a step: the outcome of the database of the run records its reads."""

    def __init__(self, value: dict, database: str, read: set[str]) -> None:
        super().__init__(value)
        self._database = database
        self._read = read

    def __getitem__(self, key: Any) -> Any:
        outcome = super().__getitem__(key)
        if key == self._database and isinstance(outcome, dict):
            return _Recording(outcome, self._read, "expect.")
        return outcome

    def get(self, key: Any, default: Any = None) -> Any:
        return self[key] if key in self else default


class ReadStep(_Recording):
    """A step of a run, with check for what stayed unread at its end."""

    def __init__(self, raw: dict, database: str) -> None:
        super().__init__(raw, set(), "")
        self._raw = raw
        self._database = database

    def __getitem__(self, key: Any) -> Any:
        value = super().__getitem__(key)
        if key == "expect" and isinstance(value, dict):
            return _Expect(value, self._database, self._read)
        return value

    def get(self, key: Any, default: Any = None) -> Any:
        if key == "expect" and dict.__contains__(self, key):
            return self[key]
        return super().get(key, default)

    def outcome(self, value: Any) -> Any:
        """The resolved outcome of the database, which records its reads as the outcome of the step does."""
        return (
            _Recording(value, self._read, "expect.")
            if isinstance(value, dict)
            else value
        )

    def _unread_outcome(self) -> list[str]:
        outcome = self._raw.get("expect", {}).get(self._database)
        if not isinstance(outcome, dict):
            return []
        return [f"expect.{key}" for key in outcome if f"expect.{key}" not in self._read]

    def _fail(self, unread: list[str]) -> None:
        if unread:
            raise AssertionError(
                f"the helper did not read {', '.join(unread)} of {self._raw['op']}"
            )

    def check_outcome(self) -> None:
        """After an op that ended with its expected error: what the op did not reach is not asked of it."""
        self._fail(self._unread_outcome())

    def check(self) -> None:
        keys = [
            key
            for key in self._raw
            if key not in _ANNOTATIONS and key not in self._read
        ]
        self._fail(keys + self._unread_outcome())
