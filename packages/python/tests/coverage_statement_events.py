# statement_events coverage: every case of tests/events/vectors.json runs on a new case database of the selected
# database (ORM_FEATURE_DATABASE) and its events are compared with the expected ones (statement_events.py), as the
# statement_events coverage of Go, PHP, TypeScript and Rust does. The bench database is neither read nor written.
from . import statement_events
from .case_database import case_database
from .coverage_case import CoverageCase, coverage_main


def run_statement_events(item):
    driver, _ = item
    statement_events.setUpModule()
    try:
        failures = []
        for case in statement_events.VECTORS["cases"]:
            try:
                with case_database(
                    driver, statement_events.STATE["directory"].name, "orm_events"
                ) as dsn:
                    failures += [
                        f"{case['id']}/{driver}: {p}"
                        for p in statement_events.run_case(case, driver, dsn)
                    ]
            except Exception as error:  # noqa: BLE001 - the case reports every vector's error
                failures.append(
                    f"{case['id']}/{driver}: {type(error).__name__}: {error}"
                )
        if failures:
            raise AssertionError("\n".join(failures))
    finally:
        statement_events.tearDownModule()


class CoverageTest(CoverageCase):
    def test_statement_events(self):
        self.each_item("statement_events", run_statement_events)


if __name__ == "__main__":
    coverage_main(CoverageTest)
