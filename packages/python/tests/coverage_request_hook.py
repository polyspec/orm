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
    "same_handle_child_hook_once",
    "relation_scope",
    "insert_assign",
    "upsert_scope",
    "loaded_row_writes",
    "invalid_param",
    "restore_key",
    "restore_condition",
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

    # Requirements: INT-78, PRT-2.
    def test_same_handle_child_hook_once(self):
        self.each_item(
            "same_handle_child_hook_once",
            lambda item: run_case("same_handle_child_hook_once", item),
        )

    # Requirements: INT-78.
    def test_relation_scope(self):
        self.each_item("relation_scope", lambda item: run_case("relation_scope", item))

    # Requirements: PRT-4, PRT-5, PRT-41.
    def test_insert_assign(self):
        self.each_item("insert_assign", lambda item: run_case("insert_assign", item))

    # Requirements: INT-78, PRT-4, PRT-6.
    def test_upsert_scope(self):
        self.each_item("upsert_scope", lambda item: run_case("upsert_scope", item))

    # Requirements: CFG-21, INT-36, INT-37, PLN-16.
    def test_loaded_row_writes(self):
        self.each_item(
            "loaded_row_writes", lambda item: run_case("loaded_row_writes", item)
        )

    # Requirements: PRT-65.
    def test_invalid_param(self):
        self.each_item("invalid_param", lambda item: run_case("invalid_param", item))

    # Requirements: DIA-161.
    def test_restore_key(self):
        self.each_item("restore_key", lambda item: run_case("restore_key", item))

    # Requirements: DIA-161, INT-38.
    def test_restore_condition(self):
        self.each_item(
            "restore_condition", lambda item: run_case("restore_condition", item)
        )

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
