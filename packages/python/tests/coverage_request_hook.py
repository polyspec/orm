# request_hook coverage: each case of test_request_hook.RequestHookTest runs on a new case database of the selected
# database (ORM_FEATURE_DATABASE), as the request_hook coverage of Go, PHP, TypeScript and Rust does. The database of
# ORM_FEATURE_DSN is neither read nor written.
import contextlib
import unittest

from .case_database import case_database
from .coverage_case import feature_database, run_cases
from .test_request_hook import RequestHookTest

CASES = (
    "without_hook",
    "read_filter",
    "insert_assign",
    "loaded_row_writes",
    "invalid_param",
    "restore_key",
    "restore_condition",
    "restore_no_key",
    "restore_rewritten_key",
    "restore_hook_set_key",
)


class CoverageRequestHook(RequestHookTest):
    """The cases of RequestHookTest on a case database of the selected dialect."""

    def database(self) -> str:
        driver, _ = feature_database()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        return stack.enter_context(case_database(driver, self.dir, "orm_hook"))


def run_case(name: str) -> None:
    suite = unittest.TestSuite([CoverageRequestHook(f"test_{name}")])
    result = unittest.TestResult()
    suite.run(result)
    problems = [text for _, text in result.errors + result.failures]
    if problems or result.testsRun != 1:
        raise AssertionError(f"{name}: {result.testsRun} run; " + "\n".join(problems))


if __name__ == "__main__":
    run_cases({name: (lambda name=name: run_case(name)) for name in CASES})
