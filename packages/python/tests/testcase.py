# The progress report and the per-case deadline of the Python tests, the format of packages/go/testcase, tests/testcase.mts
# and packages/rust/testcase:
#
#   RUN <case> deadline=<deadline>
#   STEP <case> elapsed=<elapsed>: <step>
#   PASS <case> elapsed=<elapsed>
#   FAIL <case> elapsed=<elapsed>: <reason>
#   SKIP <case> elapsed=<elapsed>
#
# Every Python test runs through CaseRunner, a unittest runner: a test module ends with `main()` of this module, and
# `python -m packages.python.tests.testcase discover ...` runs a discovered tree, so each unittest case writes these lines
# under its id. A case's deadline is the `deadline` attribute of its class (COMPUTE when the class names none). The deadline
# is wall-clock time: it is a timer that ends a stalled case, not a limit on the case's own computation. Python cannot
# interrupt a running thread, so a case that is still running GRACE after its deadline gets its FAIL line and the process
# ends with exit code 1, as the other implementations end a case that did not stop; the later cases do not run.
import os
import sys
import threading
import time
import traceback
import unittest
from typing import Any, Optional

# The deadline classes. A case uses the class of the work it does; a case that takes longer than its class states its own
# deadline with the reason in a comment.
# COMPUTE: a case that computes in memory and reads repository files. The largest (the parse and emit of the dbspec stress
# document) ends within seconds, so a case past one minute has stalled.
COMPUTE = 60.0
# DATABASE: a case that connects to a database of TEST_ENV and runs a bounded number of statements, including creating and
# dropping the database and waiting for locks on a shared server.
DATABASE = 120.0
# PROCESS: a case that runs a child process (go, php, a cargo binary, node); `go run` compiles for minutes on an empty
# build cache.
PROCESS = 300.0
# GRACE: how long after its deadline a case still running is failed and the process ended.
GRACE = 5.0

_output = threading.Lock()


def _emit(line: str) -> None:
    with _output:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


def warning(message: str) -> None:
    """Writes `WARNING <message>`: a performance measurement above its documented bound, which is not a failure."""
    _emit(f'WARNING {message}')


def _trim(value: float) -> str:
    text = f'{value:.3f}'.rstrip('0').rstrip('.')
    return text or '0'


def duration(seconds: float) -> str:
    """Seconds in the String form of Go's time.Duration (1m0s, 1.5s, 12ms), the form of the other implementations."""
    ms = seconds * 1000
    if round(ms * 1000) < 1000:
        return f'{round(ms * 1000)}µs'
    if round(ms) < 1000:
        return f'{round(ms)}ms'
    total = round(ms) / 1000
    if total < 60:
        return f'{_trim(total)}s'
    hours = int(total // 3600)
    minutes = int((total % 3600) // 60)
    rest = total - hours * 3600 - minutes * 60
    return f'{f"{hours}h" if hours else ""}{minutes}m{_trim(rest)}s'


class _Running:
    def __init__(self, name: str, deadline: float) -> None:
        self.name = name
        self.deadline = deadline
        self.started = time.monotonic()
        self.failure: Optional[str] = None
        self.skipped = False
        self.watchdog = threading.Timer(deadline + GRACE, self._expire)
        self.watchdog.daemon = True

    def elapsed(self) -> str:
        return duration(time.monotonic() - self.started)

    def _expire(self) -> None:
        _emit(f'FAIL {self.name} elapsed={self.elapsed()}: deadline {duration(self.deadline)} exceeded '
              'and the case did not stop')
        os._exit(1)


_current: Optional[_Running] = None


def step(text: str) -> None:
    """Writes a STEP line of the running case."""
    if _current is None:
        raise RuntimeError('step outside a case')
    _emit(f'STEP {_current.name} elapsed={_current.elapsed()}: {text}')


def _reason(err: Any) -> str:
    kind, value, _ = err
    lines = traceback.format_exception_only(kind, value)
    return ' '.join(line.strip() for line in lines).replace('\n', ' ') or kind.__name__


class CaseResult(unittest.TextTestResult):
    """A unittest result that writes the RUN, PASS, FAIL and SKIP lines of each case; the tracebacks and the summary
    stay on unittest's stream."""

    def __init__(self, stream: Any, descriptions: bool, verbosity: int) -> None:
        super().__init__(stream, descriptions, verbosity)
        # The case lines replace the dots and the verbose names.
        self.dots = False
        self.showAll = False

    def startTest(self, test: unittest.TestCase) -> None:  # noqa: N802 - unittest's method name
        global _current
        super().startTest(test)
        deadline = float(getattr(test, 'deadline', COMPUTE))
        if not deadline > 0:
            raise ValueError(f'case {test.id()}: deadline {deadline} is not positive')
        _current = _Running(test.id(), deadline)
        _emit(f'RUN {_current.name} deadline={duration(deadline)}')
        _current.watchdog.start()

    def _fail(self, test: unittest.TestCase, reason: str) -> None:
        if _current is not None and _current.name == test.id() and _current.failure is None:
            _current.failure = reason

    def addFailure(self, test: unittest.TestCase, err: Any) -> None:  # noqa: N802
        super().addFailure(test, err)
        self._fail(test, _reason(err))

    def addError(self, test: unittest.TestCase, err: Any) -> None:  # noqa: N802
        super().addError(test, err)
        if _current is None or _current.name != test.id():
            # An error outside a case (a module or class fixture, an import) is a case of its own.
            _emit(f'RUN {test.id()} deadline={duration(COMPUTE)}')
            _emit(f'FAIL {test.id()} elapsed=0µs: {_reason(err)}')
            return
        self._fail(test, _reason(err))

    def addSubTest(self, test: unittest.TestCase, subtest: unittest.TestCase, err: Any) -> None:  # noqa: N802
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._fail(test, f'{subtest.id()[len(test.id()):].strip()}: {_reason(err)}')

    def addUnexpectedSuccess(self, test: unittest.TestCase) -> None:  # noqa: N802
        super().addUnexpectedSuccess(test)
        self._fail(test, 'unexpected success')

    def addSkip(self, test: unittest.TestCase, reason: str) -> None:  # noqa: N802
        super().addSkip(test, reason)
        if _current is None or _current.name != test.id():
            # A skipped class or module never starts its cases.
            _emit(f'RUN {test.id()} deadline={duration(COMPUTE)}')
            _emit(f'SKIP {test.id()} elapsed=0µs')
            return
        _current.skipped = True

    def stopTest(self, test: unittest.TestCase) -> None:  # noqa: N802
        global _current
        running = _current
        _current = None
        if running is not None:
            running.watchdog.cancel()
            if running.failure is not None:
                _emit(f'FAIL {running.name} elapsed={running.elapsed()}: {running.failure}')
            elif running.skipped:
                _emit(f'SKIP {running.name} elapsed={running.elapsed()}')
            else:
                _emit(f'PASS {running.name} elapsed={running.elapsed()}')
        super().stopTest(test)


class CaseRunner(unittest.TextTestRunner):
    """The unittest runner of every Python test: TextTestRunner with CaseResult."""
    resultclass = CaseResult


def main(module: Optional[str] = '__main__', **options: Any) -> None:
    """unittest.main with CaseRunner; a test module ends with it."""
    unittest.main(module=module, testRunner=CaseRunner, **options)


if __name__ == '__main__':
    # `python -m packages.python.tests.testcase discover ...` runs a discovered tree through CaseRunner. The tests import
    # this module as packages.python.tests.testcase, so the run uses that module, whose state step() reads, and not
    # this __main__ copy.
    from packages.python.tests import testcase as harness
    harness.main(module=None)
