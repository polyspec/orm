# request_hook coverage: each case of test_request_hook.RequestHookTest runs on a new case database of the selected
# database (ORM_FEATURE_DATABASE), as the request_hook coverage of Go, PHP, TypeScript and Rust does. The database of
# ORM_FEATURE_DSN is neither read nor written.
import contextlib
import unittest

from .case_database import case_database
from .coverage_case import CoverageCase, coverage_main
from .test_request_hook import RequestHookTest

CASES = (
    "without_hook",
    "read_filter",
    "relation_scope",
    "invalid_param",
    "restore_no_key",
    "restore_rewritten_key",
    "restore_hook_set_key",
    "restore_rewritten_key_set_scope",
)


def coverage_request_hook_class(driver: str) -> type:
    """The cases of RequestHookTest on a case database of the database item of this run. Built per item, so unittest
    discovers no class without its driver."""

    class CoverageRequestHook(RequestHookTest):
        def database(self) -> str:
            stack = contextlib.ExitStack()
            self.addCleanup(stack.close)
            return stack.enter_context(case_database(driver, self.dir, "orm_hook"))

    return CoverageRequestHook


def run_case(name: str, item) -> None:
    suite = unittest.TestSuite([coverage_request_hook_class(item[0])(f"test_{name}")])
    result = unittest.TestResult()
    suite.run(result)
    problems = [text for _, text in result.errors + result.failures]
    if problems or result.testsRun != 1:
        raise AssertionError(f"{name}: {result.testsRun} run; " + "\n".join(problems))


class CoverageTest(CoverageCase):
    # Requirements: INT-78.
    def test_without_hook(self):
        self.each_item("without_hook", lambda item: run_case("without_hook", item))

    # Requirements: INT-78, PRT-2.
    def test_read_filter(self):
        self.each_item("read_filter", lambda item: run_case("read_filter", item))

    # Requirements: INT-78.
    def test_relation_scope(self):
        self.each_item("relation_scope", lambda item: run_case("relation_scope", item))

    # Requirements: PRT-65.
    def test_invalid_param(self):
        self.each_item("invalid_param", lambda item: run_case("invalid_param", item))

    # Requirements: DIA-161.
    def test_restore_no_key(self):
        self.each_item("restore_no_key", lambda item: run_case("restore_no_key", item))

    # Requirements: DIA-161.
    def test_restore_rewritten_key(self):
        self.each_item(
            "restore_rewritten_key",
            lambda item: run_case("restore_rewritten_key", item),
        )

    # Requirements: DIA-161.
    def test_restore_rewritten_key_set_scope(self):
        self.each_item(
            "restore_rewritten_key_set_scope",
            lambda item: run_case("restore_rewritten_key_set_scope", item),
        )

    # Requirements: DIA-161.
    def test_restore_hook_set_key(self):
        self.each_item(
            "restore_hook_set_key", lambda item: run_case("restore_hook_set_key", item)
        )


if __name__ == "__main__":
    coverage_main(CoverageTest)
