# Runs the shared case of contracts/fixtures/identity_load.json with the Python client. For compile cases, the three dialects'
# Engine compiles the request and compares the statement or errors, and for execute cases a new case database is used for each database,
# installs the fixture and then compiles each step's request with that database's Engine and runs it with Db.execute, and finally
# reads the load_probe rows with the native driver using the file's read SQL and compares them. MySQL and PostgreSQL
# require ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and the case fails if a variable is missing.
import contextlib
import copy
import json
import os
import signal
import sqlite3
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from . import testcase

import psycopg

from .runner_connect import mysql_connect
from .server_database import server_database

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.schema import Schema  # noqa: E402
from .vector_case import VectorCase, vector_tests  # noqa: E402

CASES = json.loads((ROOT / "contracts" / "fixtures" / "identity_load.json").read_text())
MODEL = model_of_documents(parse_document_set([(ROOT / CASES["fixture"]).read_text()]))
SCHEMA = Schema(
    manifest_text=MODEL.manifest_text,
    manifest_hash=MODEL.manifest_hash,
    external_text=MODEL.external_text,
)
DIALECTS = ("mysql", "postgres", "sqlite")
DSN_VARIABLES = {"mysql": "ORM_TEST_MYSQL_DSN", "postgres": "ORM_TEST_POSTGRES_DSN"}
# Wall-clock deadline of one case (one database): it ends only a case whose database work has stalled.
CASE_SECONDS = 60
RAN = set()  # The (case, dialect) pair that was started.
TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-identity-load-")


def tearDownModule():
    """Fails if not every case in the file was run."""
    TEMP["dir"].cleanup()
    expected = {
        (case["id"], dialect) for case in CASES["cases"] for dialect in DIALECTS
    }
    missing = sorted(expected - RAN)
    if missing:
        raise AssertionError(f"identity load cases did not run: {missing}")


class CaseTimeout(Exception):
    pass


@contextlib.contextmanager
def deadline(seconds: int, name: str):
    """Raises CaseTimeout if the case does not finish within seconds."""

    def expire(_signum, _frame):
        raise CaseTimeout(f"{name} did not finish within {seconds}s")

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def compile_request(dialect: str, request: dict) -> dict:
    """Compiles the request with the dialect's Engine, adding the fixture's manifest_hash to it."""
    if "manifest_hash" in request:
        raise AssertionError("request already holds manifest_hash")
    return Engine(MODEL, dialect).compile(
        {"manifest_hash": MODEL.manifest_hash, **copy.deepcopy(request)}
    )


def statements(plan: dict) -> list:
    """For each plan step: role, SQL, bind slot (source, the number of the param slot, type), and table."""
    out = []
    for step in plan["steps"]:
        slots = []
        for slot in step["bind_slots"]:
            s = {"from": slot["from"]}
            if slot["from"] == "param":
                s["param"] = slot["param"]
            if slot["col_type"]:
                s["type"] = slot["col_type"]
            slots.append(s)
        out.append(
            {
                "role": step["role"],
                "sql": step["sql"],
                "slots": slots,
                "tables": step["tables"],
            }
        )
    return out


def check_error(error, code: str, message: str) -> None:
    if (
        not isinstance(error, OrmError)
        or error.code != code
        or not str(error).endswith(message)
    ):
        raise AssertionError(f"error = {error!r}; want {code} {message!r}")


def required_dsn(dialect: str) -> str:
    value = os.environ.get(DSN_VARIABLES[dialect])
    if not value:
        raise AssertionError(
            f"{DSN_VARIABLES[dialect]} is required for the {dialect} identity load cases; "
            f"run make orm-test-servers and source its env file, which exports it"
        )
    return value


@contextlib.contextmanager
def case_database(dialect: str):
    """Creates an empty case database, gives its DSN, and drops it when finished."""
    if dialect == "sqlite":
        path = os.path.join(TEMP["dir"].name, f"{uuid.uuid4().hex}.sqlite3")
        try:
            yield f"sqlite://{path}"
        finally:
            if os.path.exists(path):
                os.remove(path)
        return
    dsn = required_dsn(dialect)
    name = f"orm_t120_{os.getpid()}_{uuid.uuid4().hex[:8]}"
    with server_database(dialect, dsn, name) as case_dsn:
        yield case_dsn


def read_rows(dialect: str, dsn: str) -> list:
    """Reads the load_probe rows with the native driver using the file's read SQL."""
    sql = CASES["read"][dialect]
    if dialect == "sqlite":
        connection = sqlite3.connect(urlsplit(dsn).path)
        try:
            rows = connection.execute(sql).fetchall()
        finally:
            connection.close()
    elif dialect == "mysql":
        connection = mysql_connect(dsn, urlsplit(dsn).path.lstrip("/"))
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                rows = cursor.fetchall()
        finally:
            connection.close()
    else:
        with psycopg.connect(dsn, autocommit=True) as connection:
            rows = connection.execute(sql).fetchall()
    return [[row[0], row[1]] for row in rows]


def run_execute_case(dialect: str, case: dict) -> None:
    with case_database(dialect) as dsn:
        db = Db.connect_schema(dsn, SCHEMA)
        try:
            db.utils().schema().install(SCHEMA)
            for i, step in enumerate(case["steps"]):
                plan = compile_request(dialect, step["request"])
                try:
                    db.execute(plan["steps"][0], list(step["params"]))
                except Exception as error:  # noqa: BLE001
                    if "error" not in step:
                        raise AssertionError(f"step {i}: execute: {error!r}") from error
                    try:
                        check_error(error, step["error"], step["message"])
                    except AssertionError as mismatch:
                        raise AssertionError(f"step {i}: {mismatch}") from error
                    continue
                if "error" in step:
                    raise AssertionError(
                        f"step {i}: execute succeeded; want {step['error']} {step['message']!r}"
                    )
        finally:
            db.close()
        got = read_rows(dialect, dsn)
        if got != case["expected"]["rows"]:
            raise AssertionError(f"rows = {got}, want {case['expected']['rows']}")


def compile_case(case: dict) -> list:
    """Runs a compile case in the three dialects and returns the reason from each dialect that failed."""
    expected = case["expected"]
    reasons = []
    for dialect in DIALECTS:
        RAN.add((case["id"], dialect))
        try:
            plan = compile_request(dialect, case["input"])
        except Exception as error:  # noqa: BLE001
            if "error" not in expected:
                reasons.append(f"{dialect}: compile: {error!r}")
                continue
            try:
                check_error(error, expected["error"], expected["message"])
            except AssertionError as mismatch:
                reasons.append(f"{dialect}: {mismatch}")
            continue
        if "error" in expected:
            reasons.append(
                f"{dialect}: compile succeeded; want {expected['error']} {expected['message']!r}"
            )
            continue
        got = statements(plan)
        if not expected.get(dialect) or got != expected[dialect]:
            reasons.append(
                f"{dialect} statements: got {json.dumps(got)} want {json.dumps(expected.get(dialect))}"
            )
    return reasons


def execute_case(case: dict) -> list:
    """Runs an execute case in a new case database per database, within the deadline, and
    returns the reasons for the databases that failed. One database's failure does not block another."""
    reasons = []
    for dialect in DIALECTS:
        RAN.add((case["id"], dialect))
        started = time.monotonic()
        try:
            with deadline(CASE_SECONDS, f"{case['id']} on {dialect}"):
                run_execute_case(dialect, case)
        except Exception as error:  # noqa: BLE001
            reasons.append(
                f"{dialect}: {type(error).__name__}: {error} "
                f"(elapsed={time.monotonic() - started:.3f}s)"
            )
    return reasons


def check_case(test: unittest.TestCase, case: dict) -> None:
    """Runs one case of the file; testcase.py reports it under the case id."""
    name = case["id"]
    if case["operation"] == "compile":
        reasons = compile_case(case)
    elif case["operation"] == "execute":
        reasons = execute_case(case)
    else:
        reasons = [f"unknown operation {case['operation']!r}"]
    if reasons:
        test.fail(f"{name}: " + "; ".join(reasons))


class Case(VectorCase):
    """A case of the vector file of this module."""

    deadline = testcase.DATABASE


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the file, named by the case id."""
    tests.addTests(vector_tests(Case, CASES["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
