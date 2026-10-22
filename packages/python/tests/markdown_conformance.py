# markdown IR executor conformance (tests/markdown/README.md): runs every case of tests/markdown/cases.json, in that order,
# with the Python client against one flowmark server of the flowmark build that FLOWMARK points to. The build
# must be the build pinned by flowmark.version; if it is missing or a different build, the run fails (it is not skipped).
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from .test_sqlite import generate
from .vector_case import VectorCase, vector_tests
from polyspec.orm import Collection, Model, OrmError
from polyspec.orm.values import orm
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


CONFORMANCE_DIR = ROOT / "tests" / "markdown"
FLOWMARK_MODULE = "github.com/polyspec/flowmark"
CORPUS = "conformance"
# Deadline of one case. Past it, the server is stopped to drop the connection, so the case fails with CONNECTION_LOST.
CASE_TIMEOUT_S = 60
LISTENING = re.compile(
    r"\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)"
)


class Stop(Exception):
    """The error that the callback raises to roll back the transaction."""


class Served:
    """The started flowmark server, its corpus, and the connection."""

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
    """The flowmark binary that FLOWMARK points to. The main module of its build info must be the flowmark of flowmark.version,
    otherwise it fails."""
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
            f"orm-install-flowmark, which installs the flowmark {pin} pinned in "
            f"tests/markdown/flowmark.version"
        )
    if main[2] != FLOWMARK_MODULE or main[3] != pin:
        raise AssertionError(
            f"FLOWMARK {binary} is {main[2]!r} {main[3]!r}, not the pinned {FLOWMARK_MODULE} {pin}; "
            f"run make orm-install-flowmark, or give FLOWMARK a build of a flowmark checkout at that "
            f"revision"
        )
    return binary


def array_form(m: Model) -> dict:
    """The array form (to_array) of the model. The Python model holds date as the YYYY-MM-DD text of README "Results"."""
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
    """Comparison of JSON values. bool differs from numbers, and numbers are compared by value."""
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
    """Installs corpus/ as a new corpus, starts its server and connects to it. Anything to clean up goes into cleanups."""
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
    s.binary = binary
    s.server = server
    try:
        s.db = models.connect(s.dsn(CORPUS, token))
    except OrmError as error:
        stderr.seek(0)
        raise AssertionError(f"connect: {error}; stderr:\n{stderr.read()}") from None
    cleanups.append(s.db.close)
    return s


def code_of(run) -> str | None:
    """The orm code of the error that run raises, or None when it returns."""
    try:
        run()
    except OrmError as error:
        return error.code
    return None


def refused_install(s: Served, name: str) -> dict:
    """The code that flowmark install prints when it refuses tests/markdown/refused/<name>.dbs, {"error": code}; an
    install that succeeds is {"error": None}."""
    with tempfile.TemporaryDirectory(prefix="orm-markdown-refused-") as root:
        directory = Path(root) / name
        (directory / "dbspec").mkdir(parents=True)
        shutil.copyfile(
            CONFORMANCE_DIR / "refused" / f"{name}.dbs",
            directory / "dbspec" / f"{name}.dbs",
        )
        installed = subprocess.run(
            [s.binary, "install", str(directory)], capture_output=True, text=True
        )
    if installed.returncode == 0:
        return {"error": None}
    match = re.search(
        r"^flowmark install: ([A-Z_]+):", installed.stdout + installed.stderr, re.M
    )
    if match is None:
        raise AssertionError(
            f"flowmark install {directory}: exit {installed.returncode} without a refusal code\n{installed.stdout}{installed.stderr}"
        )
    return {"error": match.group(1)}


def conformance_cases() -> dict:
    """Function that runs each case of cases.json by its id."""

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
        return People().connect(s.db).creates([bob, cara], 2)

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
        return Tasks().connect(s.db).creates(rows, len(rows))

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
            # Edit outside the engine: changes the file the transaction will write before commit.
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

    def order_nulls(s):
        # NULL sorts before every value ascending and after every value descending (docs/spec/dialects.md DIA-156).
        def people():
            return s.models.People().connect(s.db).remove_all_columns().add_column_age()

        return {
            "asc": [array_form(m) for m in people().order_by_age_asc().gets().values()],
            "desc": [
                array_form(m) for m in people().order_by_age_desc().gets().values()
            ],
        }

    def order_random(s):
        # orderByRandom is supported and not seeded, so the case answers the keys sorted (DIA-182).
        rows = (
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .order_by_random()
            .gets()
        )
        return sorted(m.get_id() for m in rows.values())

    def primary_key_case(s):
        # The key t3 equals T3 without regard to case: a plain insert is DUPLICATE_KEY, and an on_duplicate insert
        # meets T3, which keeps its key (DIA-164).
        def tasks():
            return s.models.Tasks().connect(s.db)

        duplicate = code_of(
            lambda: (
                tasks()
                .set_id("t3")
                .set_owner("P2")
                .set_title("dup")
                .set_points(1)
                .create()
            )
        )
        tasks().set_id("t3").set_owner("P2").set_title("ship it").set_points(
            8
        ).duplication(s.models.Tasks().set_title("ship it")).create()
        met = array_form(tasks().remove_all_columns().add_column_title().id("T3").get())
        return {"duplicate": duplicate, "met": met, "count": tasks().get_count()}

    def tuple_in(s):
        # Two columns compared with a list of value groups, IN and NOT IN (DIA-168).
        pairs = [("T1", "P1"), ("T3", "P1")]

        def tasks():
            return s.models.Tasks().connect(s.db).remove_all_columns()

        return {
            "in": [
                array_form(m)
                for m in tasks()
                .tuple_id_with_owner(pairs)
                .order_by_id_asc()
                .gets()
                .values()
            ],
            "not_in": [
                array_form(m)
                for m in tasks()
                .ne_tuple_id_with_owner(pairs)
                .order_by_id_asc()
                .gets()
                .values()
            ],
        }

    def subquery_aggregate(s):
        # The sum of each person's task points as a scalar Sub aggregate, and the owners of a task through an IN
        # subquery (DIA-168).
        rows = (
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .add_column_task_points(
                lambda p: s.models.Tasks().sum_points().owner_eq_id(p)
            )
            .order_by_id_asc()
            .gets()
        )
        sums = [
            [
                m.get_id(),
                None if m.get_task_points() is None else int(m.get_task_points()),
            ]
            for m in rows.values()
        ]
        owners = (
            s.models.People()
            .connect(s.db)
            .remove_all_columns()
            .id(s.models.Tasks().add_column_owner())
            .order_by_id_asc()
            .gets()
        )
        return {"sums": sums, "owners": [array_form(m) for m in owners.values()]}

    def scalar_column_subquery(s):
        # The title of each person's first task, a column subquery with limit 1 and an order by the primary key;
        # without the limit it is IR_INVALID (DIA-169).
        def first(limited):
            def sub(p):
                q = (
                    s.models.Tasks()
                    .remove_all_columns()
                    .add_column_title()
                    .owner_eq_id(p)
                    .order_by_id_asc()
                )
                return q.limit(0, 1) if limited else q

            return (
                s.models.People()
                .connect(s.db)
                .remove_all_columns()
                .add_column_first_task(sub)
                .order_by_id_asc()
                .gets()
            )

        rows = first(True)
        return {
            "first": [[m.get_id(), m.get_first_task()] for m in rows.values()],
            "unlimited": code_of(lambda: first(False)),
        }

    def column_pairs(s):
        # varchar with varchar meet; i32 with varchar do not and are OPERATOR_NOT_ALLOWED (DIA-170).
        p = s.models.People()
        meet = (
            s.models.Tasks()
            .connect(s.db)
            .join_owner_with_id(p)
            .title_ne_name(p)
            .get_count()
        )
        q = s.models.People()
        refused = code_of(
            lambda: (
                s.models.Tasks()
                .connect(s.db)
                .join_owner_with_id(q)
                .points_eq_name(q)
                .get_count()
            )
        )
        return {"meet": meet, "refused": refused}

    def contains(s):
        # Lk: A-Z and a-z without regard to case, % literal (DIA-171).
        def people():
            return s.models.People().connect(s.db).remove_all_columns()

        return {
            "fold": [
                array_form(m)
                for m in people().lk_name("ANN").order_by_id_asc().gets().values()
            ],
            "literal": [
                array_form(m)
                for m in people().lk_name("%").order_by_id_asc().gets().values()
            ],
        }

    def contains_binary(s):
        # Lb: compared by code point (DIA-172).
        def people():
            return s.models.People().connect(s.db).remove_all_columns()

        return {
            "exact": [
                array_form(m)
                for m in people().lb_name("Ann").order_by_id_asc().gets().values()
            ],
            "folded": [
                array_form(m)
                for m in people().lb_name("ann").order_by_id_asc().gets().values()
            ],
        }

    def now_truncated(s):
        # The default now of joined, a datetime(0), holds no fraction, and a relative time function past 9999-12-31 is
        # NULL and matches no row (DIA-173).
        joined = s.models.People().connect(s.db).id("P1").get().get_joined()
        far = orm.seconds_later(1000000000000000)

        def people():
            return s.models.People().connect(s.db)

        return {
            "fraction": int(joined.partition(".")[2] or "0"),
            "out_of_range": [
                people().and_gt_joined(far).get_count(),
                people().and_le_joined(far).get_count(),
            ],
        }

    def index_read(s):
        # A read through the column of the index ix_tasks_owner, which the corpus derives in memory (DIA-176).
        rows = s.models.Tasks().connect(s.db).remove_all_columns().owner("P2").gets()
        return [array_form(m) for m in rows.values()]

    def force_index(s):
        # An index hint, which the corpus does not name: CAPABILITY_UNSUPPORTED (DIA-186).
        return (
            s.models.Tasks()
            .connect(s.db)
            .force_index_ix_tasks_owner()
            .owner("P1")
            .gets()
        )

    def unavailable_table(s):
        # A heading of another table in tasks.flowmark.md is format.block: a read of tasks fails CONSTRAINT naming the
        # file, and reads again once the file is restored (DIA-190).
        path = s.dir / "tasks.flowmark.md"
        text = path.read_bytes()
        path.write_bytes(text + b"\n## people row P1\n")
        broken = None
        names_file = False
        try:
            s.models.Tasks().connect(s.db).get_count()
        except OrmError as error:
            broken = error.code
            names_file = "tasks.flowmark.md" in str(error)
        path.write_bytes(text)
        restored = s.models.Tasks().connect(s.db).get_count()
        return {"broken": broken, "names_file": names_file, "restored": restored}

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
        "order_nulls": order_nulls,
        "order_random": order_random,
        "primary_key_case": primary_key_case,
        "tuple_in": tuple_in,
        "subquery_aggregate": subquery_aggregate,
        "scalar_column_subquery": scalar_column_subquery,
        "column_pairs": column_pairs,
        "contains": contains,
        "contains_binary": contains_binary,
        "now_truncated": now_truncated,
        "index_read": index_read,
        "force_index": force_index,
        "unavailable_table": unavailable_table,
        # A catalog with an aes column is a schema error on a corpus (DIA-178).
        "install_refuses_aes": lambda s: refused_install(s, "aes"),
        # A catalog with an audit setting is a schema error on a corpus (DIA-179).
        "install_refuses_audit": lambda s: refused_install(s, "audit"),
    }


def run_case(s: Served, case: dict, run) -> str | None:
    """Runs one case and returns the reason for a failure, or None if it passes."""
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
    except Exception as error:  # noqa: BLE001 - the case reports any error that is not an orm code
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
