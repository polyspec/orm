# The conformance vectors of one database as unittest cases, one for each vector, named by the vector name.
# The runner packages/python/testing/conformance/runner_python.py runs every vector once, in the order of tests/conformance/vectors.json,
# against the bench database of the dialect (BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN or BENCH_SQLITE_DSN, which
# make run-databases and make check create), with the models that orm-gen writes from
# contracts/fixtures/bench/dbspec-set.json (packages/python/src/polyspec/orm/models, kept current by
# make python-model-check). Each case compares the output of its vector with the expectation recorded for that
# database, as tests/conformance/check/main.mts compares it: numbers by their exact value.
# A whole run, not one vector at a time, gives the recorded statements, since a vector's first use of a
# connection depends on the vectors before it (Makefile, conformance-check).
import json
import os
import subprocess
import sys
from decimal import Decimal

from .coverage_case import REPOSITORY_ROOT
from .vector_case import vector_tests

RUNNER = REPOSITORY_ROOT / "tests" / "conformance" / "runner_python.py"
MODELS = REPOSITORY_ROOT / "packages" / "python" / "src" / "polyspec" / "orm" / "models"
VECTORS = REPOSITORY_ROOT / "tests" / "conformance"


def exact(text):
    """JSON with every number as a Decimal, so 1, 1.0 and 1e0 are the same value."""
    return json.loads(text, parse_float=Decimal, parse_int=Decimal)


def vectors(dialect):
    """The vectors of vectors.json with the expectations of the dialect, in the order of vectors.json."""
    declared = exact((VECTORS / "vectors.json").read_text(encoding="utf-8"))["vectors"]
    if dialect == "mysql":
        return declared
    recorded = exact((VECTORS / f"vectors.{dialect}.json").read_text(encoding="utf-8"))[
        "vectors"
    ]
    expect = {v["name"]: v["expect"] for v in recorded}
    names = [v["name"] for v in declared]
    if sorted(expect) != sorted(names) or len(expect) != len(recorded):
        raise AssertionError(
            f"vectors.{dialect}.json does not name the vectors of vectors.json once each"
        )
    return [{**v, "expect": expect[v["name"]]} for v in declared]


class Run:
    """The output of one runner run over every vector, by vector name."""

    def __init__(self, dialect):
        self.dialect = dialect
        self.output = None

    def start(self):
        variable = f"BENCH_{self.dialect.upper()}_DSN"
        dsn = os.environ.get(variable, "")
        if dsn == "":
            raise RuntimeError(
                f"{variable} is required; run the test through make run-databases or make check, which create the "
                "bench database of the run; conformance tests never skip"
            )
        result = subprocess.run(
            [sys.executable, str(RUNNER), "--models", str(MODELS), "--dsn", dsn],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"runner_python.py on {self.dialect} exited with {result.returncode}: "
                + result.stderr.replace(dsn, "[redacted]")[-2000:]
            )
        self.output = exact(result.stdout)


def check(run):
    """The check of a case: the runner printed the vector, and its output is the recorded expectation."""

    def compare(test, vector):
        if run.output is None:
            raise AssertionError(f"the runner did not run on {run.dialect}")
        if vector.get("expect") is None:
            raise AssertionError(f"{vector['name']} has no expectation recorded")
        if vector["name"] not in run.output:
            raise AssertionError(f"the runner printed no output for {vector['name']}")
        test.assertEqual(run.output[vector["name"]], vector["expect"])

    return compare


def conformance_tests(dialect, kind):
    """The suite of the vectors of the dialect and the Run that setUpModule starts."""
    run = Run(dialect)
    suite = vector_tests(
        kind, vectors(dialect), check(run), lambda vector: vector["name"]
    )
    return run, suite
