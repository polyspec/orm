# conformance_verification coverage: the Python conformance runner runs the read-only vectors conditions_values and
# relations on the selected database, and each output equals, as a JSON value, the expectation recorded for that
# database, as the conformance_verification coverage of Go, PHP, TypeScript and Rust does. The runner imports the
# committed bench models, which make python-model-check keeps equal to the generator output.
import json
import subprocess
import sys

from .coverage_case import REPOSITORY_ROOT, expect_equal, CoverageCase, coverage_main

VECTOR_FILES = {
    "mysql": "vectors.json",
    "postgres": "vectors.postgres.json",
    "sqlite": "vectors.sqlite.json",
}
SELECTED = ["conditions_values", "relations"]
MODELS = REPOSITORY_ROOT / "packages" / "python" / "src" / "polyspec" / "orm" / "models"


def conformance_vector(item):
    driver, dsn = item
    recorded = json.loads(
        (REPOSITORY_ROOT / "tests" / "conformance" / VECTOR_FILES[driver]).read_text(
            encoding="utf-8"
        )
    )
    arguments = [
        sys.executable,
        str(
            REPOSITORY_ROOT
            / "packages"
            / "python"
            / "testing"
            / "conformance"
            / "runner_python.py"
        ),
    ]
    arguments += ["--models", str(MODELS), "--dsn", dsn]
    for name in SELECTED:
        arguments += ["--vector", name]
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=240)
    if result.returncode != 0:
        raise AssertionError(f"runner_python failed: {result.stderr}")
    output = json.loads(result.stdout)
    expect_equal(list(output), SELECTED, "the vectors the runner ran")
    for name in SELECTED:
        vectors = [v for v in recorded["vectors"] if v["name"] == name]
        expect_equal(
            len(vectors), 1, f"{VECTOR_FILES[driver]} records vector {name} once"
        )
        expect_equal(
            output[name],
            vectors[0]["expect"],
            f"vector {name} against its {driver} expectation",
        )


class CoverageTest(CoverageCase):
    def test_conformance_vector(self):
        self.each_item("conformance_vector", conformance_vector)


if __name__ == "__main__":
    coverage_main(CoverageTest)
