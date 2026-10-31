# conformance_verification coverage: the Python conformance runner runs only the selected vectors on the selected
# database, and each output equals, as a JSON value, the expectation recorded for that database. The runner imports
# the committed bench models, which make python-model-check keeps equal to the generator output. The creates_and_save
# vector removes the rows it creates.
import json
import subprocess
import sys

from .coverage_case import REPOSITORY_ROOT, CoverageCase, coverage_main, expect_equal

VECTOR_FILES = {
    "mysql": "vectors.json",
    "postgres": "vectors.postgres.json",
    "sqlite": "vectors.sqlite.json",
}
SELECTED = ["conditions_values", "creates_and_save", "functions", "relations"]
MODELS = REPOSITORY_ROOT / "packages" / "python" / "tests" / "models"


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
    result = subprocess.run(
        arguments, check=False, capture_output=True, text=True, timeout=240
    )
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
    # Requirements: DIA-37, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14.
    def test_conformance_vector(self):
        self.each_item("conformance_vector", conformance_vector)


if __name__ == "__main__":
    coverage_main(CoverageTest)
