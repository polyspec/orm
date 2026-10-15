# interface_contract coverage: `node tests/interfaces/check/main.mts -language python` from the repository root finds
# every symbol of the common interface contract in the Python client, as the interface_contract coverage of Go, PHP,
# TypeScript and Rust does for its client.
import subprocess

from .coverage_case import REPOSITORY_ROOT, run_cases


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


if __name__ == "__main__":
    run_cases({"interface_symbols": interface_symbols})
