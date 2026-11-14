# The step output of the Python tests. The results are unittest's own: every Python test runs through CaseRunner, a
# TextTestRunner that prints each case's `... ok`, `FAIL`, `ERROR` or `skipped` line and its tracebacks as unittest does. A
# test module ends with `main()` of this module, and `python -m legacy.packages.python.tests.testcase discover ...` runs a
# discovered tree. A step is a line of the running case's output (stdout), as the other implementations print their steps.
#
# No clock ends a case (T474): a machine under load runs the same work more slowly, and the result of a case must not change
# with that load. A case ends when its work ends; a run that does not end is stopped with its run.
import sys
import threading
import unittest
from typing import Any, Optional, TextIO

_output = threading.Lock()


def _emit(line: str) -> None:
    with _output:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def warning(message: str) -> None:
    """Writes `WARNING <message>`: a performance measurement above its documented bound, which is not a failure."""
    _emit(f"WARNING {message}")


def _trim(value: float) -> str:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text or "0"


def duration(seconds: float) -> str:
    """Seconds in the String form of Go's time.Duration (1m0s, 1.5s, 12ms), the form of the other implementations."""
    ms = seconds * 1000
    if round(ms * 1000) < 1000:
        return f"{round(ms * 1000)}µs"
    if round(ms) < 1000:
        return f"{round(ms)}ms"
    total = round(ms) / 1000
    if total < 60:
        return f"{_trim(total)}s"
    hours = int(total // 3600)
    minutes = int((total % 3600) // 60)
    rest = total - hours * 3600 - minutes * 60
    return f"{f'{hours}h' if hours else ''}{minutes}m{_trim(rest)}s"


_current: Optional[str] = None


def step(text: str) -> None:
    """Writes a step line of the running case."""
    if _current is None:
        raise RuntimeError("step outside a case")
    _emit(text)


class CaseResult(unittest.TextTestResult):
    """A unittest result that records the running case, whose steps step() writes; the reporting is unittest's own."""

    def startTest(self, test: unittest.TestCase) -> None:
        global _current
        super().startTest(test)
        _current = test.id()

    def stopTest(self, test: unittest.TestCase) -> None:
        global _current
        _current = None
        super().stopTest(test)


class CaseRunner(unittest.TextTestRunner):
    """The unittest runner of every Python test: TextTestRunner with CaseResult."""

    resultclass = CaseResult


def main(
    module: Optional[str] = "__main__", stream: Optional[TextIO] = None, **options: Any
) -> None:
    """unittest.main with CaseRunner, one line per case (verbosity 2); a test module ends with it. The report goes to
    stream, stderr by default as TextTestRunner writes it; a caller that reads stdout passes sys.stdout."""
    options.setdefault("verbosity", 2)
    runner = (
        CaseRunner
        if stream is None
        else CaseRunner(stream=stream, verbosity=options["verbosity"])
    )
    unittest.main(module=module, testRunner=runner, **options)


if __name__ == "__main__":
    # `python -m legacy.packages.python.tests.testcase discover ...` runs a discovered tree through CaseRunner. The tests import
    # this module as legacy.packages.python.tests.testcase, so the run uses that module, whose state step() reads, and not
    # this __main__ copy.
    from legacy.packages.python.tests import testcase as harness

    harness.main(module=None)
