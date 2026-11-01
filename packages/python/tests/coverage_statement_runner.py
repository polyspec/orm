# statement_runner coverage: the statement runner case of test_statement_runner.py runs on a new case database of the
# selected database (ORM_FEATURE_DATABASE), as the statement_runner coverage of Go, PHP, TypeScript and Rust does. The bench
# database is neither read nor written.
# Requirements: INT-150.
from .coverage_case import CoverageCase, coverage_main
from . import test_statement_runner


def run_statement_runner(item):
    driver, _ = item
    case = test_statement_runner.StatementRunnerTest("test_runner_mysql")
    case.setUp()
    try:
        case.server_case(driver, case.assert_runner_outside_and_inside)
        case.server_case(driver, case.assert_frame_rows_and_config)
    finally:
        case.doCleanups()


class CoverageTest(CoverageCase):
    # Requirements: INT-150.
    def test_statement_runner(self):
        self.each_item("statement_runner", run_statement_runner)


if __name__ == "__main__":
    coverage_main(CoverageTest)
