# The check that importing polyspec.orm does not load its test entry point polyspec.orm.testing, which a consumer's test
# imports by its name to inject faults. Shared by test_statement_fault_entry and test_rollback_fault.
import subprocess
import sys


def assert_import_does_not_load_testing(test) -> None:
    """Runs a fresh interpreter that imports polyspec.orm and polyspec.orm.database, and requires that
    polyspec.orm.testing is not in its sys.modules."""
    loaded = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, polyspec.orm, polyspec.orm.database; "
            'print("polyspec.orm.testing" in sys.modules)',
        ],
        capture_output=True,
        text=True,
    )
    test.assertEqual(loaded.returncode, 0, loaded.stderr)
    test.assertEqual(loaded.stdout.strip(), "False")
