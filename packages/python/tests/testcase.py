# The per-case deadline and the step output of the Python tests. The results are unittest's own: every Python test runs
# through CaseRunner, a TextTestRunner that prints each case's `... ok`, `FAIL`, `ERROR` or `skipped` line and its
# tracebacks as unittest does. A test module ends with `main()` of this module, and
# `python -m packages.python.tests.testcase discover ...` runs a discovered tree. A step is a line of the running case's
# output (stdout), as the other implementations print their steps.
#
# A case's deadline is the `deadline` attribute of its class (COMPUTE when the class names none). The deadline is
# wall-clock time: it is a timer that ends a stalled case, not a limit on the case's own computation. Python cannot
# interrupt a running thread, so a case that is still running GRACE after its deadline gets a line on stderr and the
# process ends with exit code 1, as the other implementations end a case that did not stop; the later cases do not run.
import os
import sys
import threading
import unittest
from typing import Any, Optional, TextIO

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
# STEP_BUDGET and FIXED_BUDGET: the deadline of a case that applies its steps one after another is STEP_BUDGET for each step
# plus FIXED_BUDGET for the work around them (the Go testcase package's StepBudget). The MySQL stress plan applies its steps at
# 28 to 35 ms a step on the slowest CI runs, so 250 ms is several times the slowest step rate: an upper bound, and a stuck step
# is found by StepGuard long before.
STEP_BUDGET = 0.25
FIXED_BUDGET = 60.0


def step_budget(steps: int) -> float:
    """The deadline of a case that applies `steps` steps one after another."""
    return steps * STEP_BUDGET + FIXED_BUDGET


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


class _Running:
    def __init__(self, name: str, deadline: float) -> None:
        self.name = name
        self.deadline = deadline
        self.watchdog = threading.Timer(deadline + GRACE, self._expire)
        self.watchdog.daemon = True

    def _expire(self) -> None:
        with _output:
            sys.stderr.write(
                f"{self.name}: deadline {duration(self.deadline)} exceeded and the case did not stop\n"
            )
            sys.stderr.flush()
        os._exit(1)


_current: Optional[_Running] = None


def stall_text(limit: float) -> str:
    """The failure text of a case whose StepGuard saw no step within `limit` seconds; every runtime writes the same text."""
    return f"no step was applied within {_trim(limit)}s"


def budget_text(budget: float) -> str:
    """The failure text of a case that kept applying steps past its step `budget` seconds (StepGuard); every runtime
    writes the same text."""
    return f"step budget {_trim(budget)}s exceeded"


class StepGuard:
    """Ends a case with a step deadline (the Go testcase package's StepGuard): at its step `budget` seconds, and when
    progress is not called within `stall` seconds. Each progress restarts the stall limit, so a long case that keeps applying
    steps is ended only by its budget, while a stuck step is ended by the stall limit. Python cannot interrupt the running
    thread, so the guard writes `<name>: <text>` on stderr and ends the process, as a case past its deadline ends; stop
    releases the guard."""

    def __init__(self, name: str, budget: float, stall: float) -> None:
        self.name = name
        self.stall = stall
        self._lock = threading.Lock()
        self._stalled: Optional[threading.Timer] = None
        self._spent: Optional[threading.Timer] = threading.Timer(
            budget, self._expire, (budget_text(budget),)
        )
        self._spent.daemon = True
        self._spent.start()
        self.progress()

    def _expire(self, text: str) -> None:
        with _output:
            sys.stderr.write(f"{self.name}: {text}\n")
            sys.stderr.flush()
        os._exit(1)

    def progress(self) -> None:
        with self._lock:
            if self._spent is None:
                return
            if self._stalled is not None:
                self._stalled.cancel()
            self._stalled = threading.Timer(
                self.stall, self._expire, (stall_text(self.stall),)
            )
            self._stalled.daemon = True
            self._stalled.start()

    def stop(self) -> None:
        with self._lock:
            for timer in (self._stalled, self._spent):
                if timer is not None:
                    timer.cancel()
            self._stalled = None
            self._spent = None


def step(text: str) -> None:
    """Writes a step line of the running case."""
    if _current is None:
        raise RuntimeError("step outside a case")
    _emit(text)


class CaseResult(unittest.TextTestResult):
    """A unittest result that arms the deadline of each case; the reporting is unittest's own."""

    def startTest(self, test: unittest.TestCase) -> None:
        global _current
        super().startTest(test)
        deadline = float(getattr(test, "deadline", COMPUTE))
        if not deadline > 0:
            raise ValueError(f"case {test.id()}: deadline {deadline} is not positive")
        _current = _Running(test.id(), deadline)
        _current.watchdog.start()

    def stopTest(self, test: unittest.TestCase) -> None:
        global _current
        running = _current
        _current = None
        if running is not None:
            running.watchdog.cancel()
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
    # `python -m packages.python.tests.testcase discover ...` runs a discovered tree through CaseRunner. The tests import
    # this module as packages.python.tests.testcase, so the run uses that module, whose state step() reads, and not
    # this __main__ copy.
    from packages.python.tests import testcase as harness

    harness.main(module=None)
