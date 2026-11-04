# interface_contract coverage: `node tests/interfaces/check/main.mts -language python` from the repository root finds
# every symbol of the common interface contract in the Python client, as the interface_contract coverage of Go, PHP,
# TypeScript and Rust does for its client. It stays native (FCV-2): a binding surface, and it has no database.
import os
import subprocess
import sys
import unittest

from .coverage_case import REPOSITORY_ROOT


def interface_symbols():
    result = subprocess.run(
        ["node", "tests/interfaces/check/main.mts", "-language", "python"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        timeout=280,
        env={**os.environ, "ORM_PYTHON": sys.executable},
    )
    if result.returncode != 0:
        raise AssertionError(
            f"interface check failed ({result.returncode}): {result.stdout}{result.stderr}"
        )


class CoverageTest(unittest.TestCase):
    # Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64.
    def test_interface_symbols(self):
        interface_symbols()
        # The line the feature checker reads (FCV-12); a run outside the checker names no file.
        path = os.environ.get("ORM_RECIPE_RESULTS")
        if path:
            with open(path, "w", encoding="utf-8") as results:
                results.write("CASE interface_symbols PASS\n")


if __name__ == "__main__":
    unittest.main()
