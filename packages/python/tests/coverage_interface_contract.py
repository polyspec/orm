# interface_contract coverage: `node tests/interfaces/check/main.mts -language python` from the repository root finds
# every symbol of the common interface contract in the Python client, as the interface_contract coverage of Go, PHP,
# TypeScript and Rust does for its client.
import subprocess

from .coverage_case import REPOSITORY_ROOT, CoverageCase, coverage_main


def interface_symbols():
    result = subprocess.run(
        ["node", "tests/interfaces/check/main.mts", "-language", "python"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        timeout=280,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"interface check failed ({result.returncode}): {result.stdout}{result.stderr}"
        )


class CoverageTest(CoverageCase):
    def test_interface_symbols(self):
        self.each_item("interface_symbols", interface_symbols)


if __name__ == "__main__":
    coverage_main(CoverageTest)
