# markdown IR executor conformance (tests/markdown/README.md): tests/markdown/cases.json의 모든 case를 그 순서대로,
# FLOWMARK가 가리키는 flowmark build의 server 하나에 대해 Python client로 실행한다. 그 build는 flowmark.version이
# 고정한 build여야 하고, 없거나 다른 build이면 실행은 실패한다(건너뛰지 않는다).
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[3]

from .test_sqlite import generate  # noqa: E402
from .vector_case import VectorCase, vector_tests  # noqa: E402

from polyspec.orm import Collection, Model, OrmError  # noqa: E402

CONFORMANCE_DIR = ROOT / "tests" / "markdown"
FLOWMARK_MODULE = "github.com/polyspec/flowmark"
CORPUS = "conformance"
# case 하나의 deadline이다. 넘으면 server를 멈춰 연결을 끊으므로 case는 CONNECTION_LOST로 실패한다.
CASE_TIMEOUT_S = 60
LISTENING = re.compile(
    r"\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)"
)


class Stop(Exception):
    """transaction을 rollback시키려고 callback이 던지는 오류다."""


class Served:
    """시작한 flowmark server와 그 corpus, 그리고 연결이다."""

    def __init__(self, models, directory: Path, port: str, token: str):
        self.models = models
        self.dir = directory
        self.port = port
        self.token = token
        self.db = None

    def dsn(self, corpus: str, token: str) -> str:
        return f"markdown://127.0.0.1:{self.port}/{corpus}?token={token}"


def load_cases() -> list:
    doc = json.loads((CONFORMANCE_DIR / "cases.json").read_text())
    seen = set()
    for case in doc["cases"]:
        if not case.get("id") or case["id"] in seen:
            raise AssertionError(
                f"cases.json: case id {case.get('id')!r} is empty or repeated"
            )
        seen.add(case["id"])
    return doc["cases"]


def pinned_flowmark() -> str:
    """FLOWMARK가 가리키는 flowmark binary다. build 정보의 main module이 flowmark.version의 flowmark가
    아니면 실패한다."""
    pin = (CONFORMANCE_DIR / "flowmark.version").read_text().strip()
    binary = os.environ.get("FLOWMARK", "")
    if binary == "":
        raise AssertionError(
            f"FLOWMARK is not set; run make markdown-conformance-check, which passes the path of "
            f"the flowmark {pin} pinned in tests/markdown/flowmark.version"
        )
    info = subprocess.run(
        ["go", "version", "-m", binary], capture_output=True, text=True
    )
    main = next(
        (
            line.split("\t")
            for line in info.stdout.splitlines()
            if line.startswith("\tmod\t")
        ),
        None,
    )
    if info.returncode != 0 or main is None:
        raise AssertionError(
            f"FLOWMARK {binary} is no Go build of a module ({info.stderr.strip()}); run make "
            f"install-flowmark, which installs the flowmark {pin} pinned in "
            f"tests/markdown/flowmark.version"
        )
    if main[2] != FLOWMARK_MODULE or main[3] != pin:
        raise AssertionError(
            f"FLOWMARK {binary} is {main[2]!r} {main[3]!r}, not the pinned {FLOWMARK_MODULE} {pin}; "
            f"run make install-flowmark, or give FLOWMARK a build of a flowmark checkout at that "
            f"revision"
        )
    return binary


def array_form(m: Model) -> dict:
    """model의 array form(to_array)이다. Python model은 date를 README "Results"의 YYYY-MM-DD text로 가진다."""
    out = m.to_array()
    related = m.core.row.related if m.core.row is not None else {}
    for name in out:
        child = related.get(name)
        if isinstance(child, Model):
            out[name] = array_form(child)
        elif isinstance(child, Collection):
            out[name] = [array_form(row) for row in child.values()]
    return out


def same(actual, expect) -> bool:
    """JSON 값의 비교다. bool은 숫자와 다르고, 숫자는 값으로 비교한다."""
    if isinstance(expect, bool) or isinstance(actual, bool):
        return (
            isinstance(expect, bool) and isinstance(actual, bool) and actual == expect
        )
    if isinstance(expect, (int, float)):
        return isinstance(actual, (int, float)) and actual == expect
    if isinstance(expect, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expect)
            and all(same(a, e) for a, e in zip(actual, expect))
        )
    if isinstance(expect, dict):
        return (
            isinstance(actual, dict)
            and list(actual) == list(expect)
            and all(same(actual[k], expect[k]) for k in expect)
        )
    return type(actual) is type(expect) and actual == expect


def serve(binary: str, workdir: Path, models, cleanups: list) -> Served:
    """corpus/를 새 corpus로 install하고 그 server를 시작해 연결한다. 끝낼 일은 cleanups에 넣는다."""
    directory = workdir / CORPUS
    (directory / "dbspec").mkdir(parents=True)
    shutil.copyfile(
        CONFORMANCE_DIR / "corpus" / "dbspec" / "conformance.dbs",
        directory / "dbspec" / "conformance.dbs",
    )
    print(f"STEP flowmark install {directory}", flush=True)
    installed = subprocess.run(
        [binary, "install", str(directory)], capture_output=True, text=True
    )
    if installed.returncode != 0:
        raise AssertionError(
            f"flowmark install: exit {installed.returncode}\n{installed.stdout}{installed.stderr}"
        )
    print(f"STEP flowmark serve {directory} --port 0", flush=True)
    stderr = open(workdir / "serve.stderr", "w+")
    server = subprocess.Popen(
        [binary, "serve", str(directory), "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=stderr,
        text=True,
    )

    def stop():
        if server.poll() is None:
            server.terminate()
        server.wait()
        server.stdout.close()
        stderr.close()

    cleanups.append(stop)
    line = server.stdout.readline().rstrip("\n")
    match = LISTENING.fullmatch(line)
    if match is None or match.group(2) != CORPUS:
        stderr.seek(0)
        raise AssertionError(
            f"flowmark serve printed {line!r}, not its listening line; stderr:\n{stderr.read()}"
        )
    token = json.loads((directory / ".flowmark" / "server.json").read_text())["token"]
    s = Served(models, directory, match.group(1), token)
    s.server = server
    try:
        s.db = models.connect(s.dsn(CORPUS, token))
    except OrmError as error:
        stderr.seek(0)
        raise AssertionError(f"connect: {error}; stderr:\n{stderr.read()}") from None
    cleanups.append(s.db.close)
    return s


def conformance_cases() -> dict:
    """cases.json의 id마다 그 case를 실행하는 함수다."""

    def insert_one(s):
        m = (
            s.models.People()
            .connect(s.db)
            .set_name("Ann")
            .set_email("ann@example.com")
            .set_age(30)
            .set_score("1.50")
            .create()
        )
        return {"id": m.get_id()}

    def insert_rows(s):
        People = s.models.People
        bob = (
            People()
            .set_name("Bob")
            .set_email("bob@example.com")
            .set_age(25)
            .set_score("2.00")
        )
        cara = People().set_name("Cara").set_email(None).set_age(None).set_score("0.50")
        return People().connect(s.db).creates([bob, cara])

    def insert_rows_tasks(s):
        Tasks = s.models.Tasks
        rows = [
            Tasks()
            .set_owner("P1")
            .set_title("write spec")
            .set_points(3)
            .set_due("2026-10-01"),
            Tasks().set_owner("P1").set_title("review").set_points(5).set_due(None),
            Tasks()
            .set_owner("P2")
            .set_title("ship")
            .set_points(8)
            .set_due("2026-10-05"),
        ]
        return Tasks().connect(s.db).creates(rows)

    def insert_identity(s):
        m = s.models.Logs().connect(s.db).set_task("T1").set_note("started").create()
        return {"id": m.get_id()}

    def one(s):
        return array_form(
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .add_column_name()
            .add_column_email()
            .add_column_age()
            .add_column_active()
            .add_column_score()
            .id("P1")
            .get()
        )

    def one_no_rows(s):
        return s.models.People().connect(s.db).id("P9").get()

    def all_(s):
        rows = (
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .add_column_name()
            .add_column_age()
            .order_by_name_desc()
            .gets()
        )
        return [array_form(m) for m in rows.values()]

    def count(s):
        return s.models.Tasks().connect(s.db).owner("P1").get_count()

    def group_count(s):
        return (
            s.models.Tasks()
            .connect(s.db)
            .group_by_owner()
            .order_by_owner_asc()
            .gets_count()
            .to_array()
        )

    def group_count_no_rows(s):
        return (
            s.models.Tasks()
            .connect(s.db)
            .owner("P9")
            .group_by_owner()
            .order_by_owner_asc()
            .gets_count()
            .to_array()
        )

    def sum_(s):
        return s.models.Tasks().connect(s.db).sum_points().get_sum()

    def avg(s):
        return s.models.People().connect(s.db).avg_age().get_avg()

    def paginate(s):
        page = (
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .add_column_name()
            .order_by_name_asc()
            .gets_page(2, 2)
        )
        return {
            "items": [array_form(m) for m in page["items"].values()],
            "total_count": page["totalCount"],
            "total_pages": page["totalPages"],
        }

    def join(s):
        rows = (
            s.models.Tasks()
            .connect(s.db)
            .remove_all_columns()
            .add_column_title()
            .join_owner_with_id(
                s.models.People().remove_all_columns().add_column_name()
            )
            .order_by_title_asc()
            .gets()
        )
        return [array_form(m) for m in rows.values()]

    def relation_many(s):
        return array_form(
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .add_column_name()
            .relations(
                s.models.Tasks()
                .remove_all_columns()
                .add_column_due()
                .match_id_with_owner()
                .order_by_title_asc()
            )
            .id("P1")
            .get()
        )

    def relation_one(s):
        return array_form(
            s.models.Tasks()
            .connect(s.db)
            .remove_all_columns()
            .add_column_title()
            .relation(
                s.models.People()
                .remove_all_columns()
                .add_column_name()
                .match_owner_with_id()
            )
            .id("T3")
            .get()
        )

    def update(s):
        s.models.People().connect(s.db).id("P2").get().set_age(26).update()
        return array_form(
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .add_column_age()
            .id("P2")
            .get()
        )

    def update_optimistic_conflict(s):
        stale = s.models.People().connect(s.db).id("P2").get()
        fresh = s.models.People().connect(s.db).id("P2").get()
        fresh.set_name("Bobby").update()
        return stale.set_age(27).update(True)

    def insert_on_duplicate(s):
        People = s.models.People
        m = (
            People()
            .connect(s.db)
            .set_name("Ann B")
            .set_email("ann@example.com")
            .duplication(People().set_name("Ann B"))
            .create()
        )
        read = People().connect(s.db).id("P1").get()
        return {"created": m.get_id(), "name": read.get_name()}

    def delete(s):
        s.models.Tasks().connect(s.db).id("T2").get().delete()
        return s.models.Tasks().connect(s.db).get_count()

    def delete_referenced(s):
        return s.models.Tasks().connect(s.db).id("T1").get().delete()

    def soft_delete(s):
        s.models.People().connect(s.db).id("P3").get().delete()
        return s.models.People().connect(s.db).get_count()

    def restore(s):
        m = s.models.People().connect(s.db).set_id("P3").restore()
        return {
            "id": m.get_id(),
            "name": m.get_name(),
            "count": s.models.People().connect(s.db).get_count(),
        }

    def transaction_commit(s):
        s.db.transaction(
            lambda: s.models.Logs().set_task("T3").set_note("committed").create()
        )
        return s.models.Logs().connect(s.db).get_count()

    def transaction_rollback(s):
        def body():
            s.models.Logs().set_task("T3").set_note("rolled back").create()
            raise Stop()

        try:
            s.db.transaction(body)
        except Stop:
            return s.models.Logs().connect(s.db).get_count()
        raise AssertionError("the transaction ended without its callback's error")

    def savepoint_rollback(s):
        def inner():
            s.models.Logs().set_task("T3").set_note("inner").create()
            raise Stop()

        def outer():
            s.models.Logs().set_task("T3").set_note("outer").create()
            try:
                s.db.transaction(inner)
            except Stop:
                return
            raise AssertionError("the savepoint ended without its callback's error")

        s.db.transaction(outer)
        return [
            m.get_note()
            for m in s.models.Logs().connect(s.db).order_by_id_asc().gets().values()
        ]

    def read_only_write(s):
        return s.db.transaction(
            lambda: s.models.Logs().set_task("T3").set_note("read only").create(),
            {"readOnly": True},
        )

    def lock_update(s):
        return s.db.transaction(
            lambda: array_form(
                s.models.People()
                .connect(s.db)
                .remove_all_columns()
                .id("P1")
                .for_update()
                .get()
            )
        )

    def lock_nowait(s):
        return s.db.transaction(
            lambda: s.models.People().connect(s.db).id("P1").for_update_no_wait().get()
        )

    def get_query(s):
        return s.models.People().connect(s.db).get_query()

    def isolation(s):
        return s.db.transaction(lambda: None, {"isolation": "serializable"})

    def write_conflict(s):
        def body():
            s.models.People().id("P1").get().set_name("Ann C").update()
            # engine 밖의 편집: transaction이 쓸 file을 commit 전에 바꾼다.
            path = s.dir / "people.flowmark.md"
            text = path.read_text()
            if "Cara" not in text:
                raise AssertionError(f"{path} holds no Cara to edit:\n{text}")
            path.write_text(text.replace("Cara", "Carol", 1))

        code = None
        try:
            s.db.transaction(body)
        except OrmError as error:
            code = error.code
        read = s.models.People().connect(s.db).id("P1").get()
        return {"error": code, "name": read.get_name()}

    def transaction_retry_commit(s):
        # A transaction that reads P1 and writes its own name back, with retry options: the commit's code
        # (None when it commits) and how many times the callback ran. WRITE_CONFLICT is never retried,
        # DEADLOCK is (contracts/fixtures/ir_answers.json).
        runs = []

        def body():
            runs.append(1)
            m = s.models.People().id("P1").get()
            m.set_name(m.get_name()).update()

        code = None
        try:
            s.db.transaction(body, {"retry": 3})
        except OrmError as error:
            code = error.code
        return {"error": code, "runs": len(runs)}

    def connect_mismatch(corpus_of, token_of):
        def run(s):
            db = s.models.connect(s.dsn(corpus_of(s), token_of(s)))
            db.close()

        return run

    return {
        "insert_one": insert_one,
        "insert_rows": insert_rows,
        "insert_rows_tasks": insert_rows_tasks,
        "insert_identity": insert_identity,
        "one": one,
        "one_no_rows": one_no_rows,
        "all": all_,
        "count": count,
        "group_count": group_count,
        "group_count_no_rows": group_count_no_rows,
        "sum": sum_,
        "avg": avg,
        "paginate": paginate,
        "join": join,
        "relation_many": relation_many,
        "relation_one": relation_one,
        "update": update,
        "update_optimistic_conflict": update_optimistic_conflict,
        "insert_on_duplicate": insert_on_duplicate,
        "delete": delete,
        "delete_referenced": delete_referenced,
        "soft_delete": soft_delete,
        "restore": restore,
        "transaction_commit": transaction_commit,
        "transaction_rollback": transaction_rollback,
        "savepoint_rollback": savepoint_rollback,
        "read_only_write": read_only_write,
        "lock_update": lock_update,
        "lock_nowait": lock_nowait,
        "get_query": get_query,
        "isolation": isolation,
        "write_conflict": write_conflict,
        "transaction_retry_commit": transaction_retry_commit,
        "connect_corpus_mismatch": connect_mismatch(
            lambda s: "other", lambda s: s.token
        ),
        "connect_token_mismatch": connect_mismatch(
            lambda s: CORPUS, lambda s: "0" * 32
        ),
    }


def run_case(s: Served, case: dict, run) -> str | None:
    """case 하나를 실행하고 실패의 이유를, 통과하면 None을 돌려준다."""
    stopped = []

    def expire():
        stopped.append(True)
        s.server.kill()

    timer = threading.Timer(CASE_TIMEOUT_S, expire)
    timer.start()
    try:
        try:
            got = run(s)
        except OrmError as error:
            got = {"error": error.code}
            cause = error
        else:
            cause = None
    except Exception as error:  # noqa: BLE001
        return f"failed without an orm code: {type(error).__name__}: {error}"
    finally:
        timer.cancel()
    if stopped:
        return f"did not end within {CASE_TIMEOUT_S}s; the server was stopped"
    actual = json.loads(json.dumps(got))
    if not same(actual, case["expect"]):
        return f"got {json.dumps(actual)}, want {json.dumps(case['expect'])} (error {cause})"
    return None


STATE: dict = {}


def setUpModule():
    """Starts the server of the pinned flowmark build on a new corpus; the cases of cases.json run against it."""
    STATE["cleanups"] = []
    STATE["workdir"] = Path(tempfile.mkdtemp(prefix="orm-markdown-conformance-"))
    try:
        binary = pinned_flowmark()
        ids = [case["id"] for case in load_cases()]
        funcs = conformance_cases()
        missing = [i for i in ids if i not in funcs]
        extra = sorted(i for i in funcs if i not in ids)
        if missing or extra:
            raise AssertionError(
                f"cases.json and the Python cases differ: missing in Python {missing}, "
                f"not in cases.json {extra}"
            )
        models = generate(
            str(STATE["workdir"] / "models"),
            CONFORMANCE_DIR / "corpus" / "dbspec" / "dbspec-set.json",
        )
        STATE["funcs"] = funcs
        STATE["served"] = serve(binary, STATE["workdir"], models, STATE["cleanups"])
    except BaseException:
        tearDownModule()
        raise


def tearDownModule():
    for cleanup in reversed(STATE["cleanups"]):
        cleanup()
    shutil.rmtree(STATE["workdir"], ignore_errors=True)


def check_case(test: unittest.TestCase, case: dict) -> None:
    """Runs one case on the server. A later case reads the corpus state that the cases before it made, so after a
    failure the later cases fail with the case that stopped them."""
    if "stopped" in STATE:
        test.fail(
            f"not run: {STATE['stopped']} failed, and this case reads the corpus state it leaves"
        )
    reason = run_case(STATE["served"], case, STATE["funcs"][case["id"]])
    if reason is not None:
        STATE["stopped"] = case["id"]
        test.fail(reason)


class Case(VectorCase):
    """A case of the vector file of this module."""

    deadline = testcase.PROCESS


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of cases.json, named by the case id, in the order of the file."""
    tests.addTests(vector_tests(Case, load_cases(), check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
