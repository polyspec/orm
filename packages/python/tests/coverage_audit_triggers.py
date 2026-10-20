# audit_triggers coverage: the audit fixtures are installed with schema install and written in the order of
# packages/go/orm/coverage_audit_triggers_test.go and packages/ts/tests/coverage_audit_triggers.mjs, then the history
# tables that the triggers wrote are checked. At the end, even after a failure, the installed tables and the PostgreSQL
# trigger functions are dropped, so the database is as it was.
import os
import tempfile
from pathlib import Path

from polyspec.orm import Db
from polyspec.orm.errors import OrmError
from .coverage_case import (
    REPOSITORY_ROOT,
    expect_equal,
    native_query,
    CoverageCase,
    coverage_main,
    table_exists,
    with_cleanup,
)
from .test_sqlite import generate_document

FIXTURES = REPOSITORY_ROOT / "contracts" / "fixtures"
# The tables that each fixture creates.
AUDIT_TABLES = ["audit", "item", "item_history"]
AUDIT_COLUMNS_TABLES = ["audit", "card", "card_history", "tag", "tag_history"]
RESTORE_TABLES = ["audit", "label", "membership", "membership_history"]
STATE = {}


def models_of(fixture: str):
    """The generated models of one fixture document, generated once per run."""
    if fixture not in STATE:
        if "dir" not in STATE:
            STATE["dir"] = tempfile.TemporaryDirectory(prefix="orm-coverage-audit-")
        STATE[fixture] = generate_document(
            os.path.join(STATE["dir"].name, Path(fixture).stem), FIXTURES / fixture
        )
    return STATE[fixture]


def audit_source(actor: str):
    """An audit source that gives actor as the audit value (the connection option auditSource)."""
    return lambda: {"actor": actor}


def item_history(m, db):
    """The item_history rows in history_id order, each as change, previous audit seq, seq, title, audit seq and whether it is deleted."""
    history = (
        m.ItemHistory().connect(db).add_all_columns().order_by_history_id_asc().gets()
    )
    return [
        [
            h.get_change(),
            h.get_previous_audit_seq(),
            h.get_seq(),
            h.get_title(),
            h.get_audit_seq(),
            h.get_deleted_at() is not None,
        ]
        for h in history.values()
    ]


def code_of(run):
    try:
        run()
    except OrmError as error:
        return error.code
    except Exception as error:  # noqa: BLE001 - the case compares the error itself
        return error
    return None


def drop_tables(driver: str, dsn: str, tables, audited) -> None:
    """Drops tables, the audit record table after the tables that refer to it, and on PostgreSQL the trigger functions of
    the audited tables."""
    quote = (lambda n: f"`{n}`") if driver == "mysql" else (lambda n: f'"{n}"')
    statements = [
        f"DROP TABLE IF EXISTS {quote(t)}"
        for t in [*[t for t in tables if t != "audit"], "audit"]
    ]
    if driver == "postgres":
        for table in audited:
            for event in ("audit_insert", "audit_update", "audit_delete"):
                statements.append(f'DROP FUNCTION IF EXISTS "{table}${event}"()')
    native_query(driver, dsn, statements)


def text_rows(driver: str, dsn: str, sql: str):
    """The column names and the rows of a query as text; NULL is 'NULL'."""
    (rows,) = native_query(driver, dsn, [sql])
    columns = list(rows[0]) if rows else []
    return columns, [
        ["NULL" if v is None else str(v) for v in row.values()] for row in rows
    ]


def with_installed(item, fixture: str, tables, audited, body) -> None:
    """Installs the fixture on the selected database and runs body(db, driver, dsn); the tables and the trigger
    functions are dropped afterwards even when it failed. The tables do not exist before the case nor remain after."""
    driver, dsn = item
    for table in tables:
        expect_equal(
            table_exists(driver, dsn, table), False, f"table {table} before the case"
        )
    models = models_of(fixture)
    db = Db.connect_schema(dsn, models.SCHEMA, {"auditSource": audit_source("default")})
    try:
        expect_equal(db.driver, driver, "the driver")

        def run():
            db.utils().schema().install(models.SCHEMA)
            body(db, driver, dsn)

        with_cleanup(run, lambda: drop_tables(driver, dsn, tables, audited))
    finally:
        db.close()
    for table in tables:
        expect_equal(
            table_exists(driver, dsn, table), False, f"table {table} after the case"
        )


# contracts/fixtures/audit.dbs: the writes of a transaction that received an audit record (auditCase of
# packages/ts/tests/restore_case.mjs).
def audit_history(item):
    m = models_of("audit.dbs")

    def body(db, driver, dsn):
        item = lambda: m.Item().connect(db)  # noqa: E731
        expect_equal(
            code_of(lambda: item().set_title("outside").create()),
            "CONFIG",
            "insert without an audit",
        )
        for name, options in (
            ("without an audit source", {}),
            (
                "with a source value that is no column",
                {"auditSource": lambda: {"reason": "x"}},
            ),
        ):
            other = Db.connect_schema(dsn, m.SCHEMA, options)
            try:
                expect_equal(
                    code_of(
                        lambda: other.transaction(
                            lambda: None, {"audit": {"actor": "x"}}
                        )
                    ),
                    "CONFIG",
                    f"an audit transaction of a connection {name}",
                )
            finally:
                other.close()
        unavailable = RuntimeError("no request")

        def failing_source():
            raise unavailable

        failing = Db.connect_schema(dsn, m.SCHEMA, {"auditSource": failing_source})
        try:
            expect_equal(
                code_of(lambda: failing.transaction(lambda: None, {"audit": {}})),
                unavailable,
                "an audit transaction whose source fails returns the source error",
            )
        finally:
            failing.close()
        expect_equal(
            code_of(lambda: db.transaction(lambda: None, {"audit": {"reason": "x"}})),
            "CONFIG",
            "an audit value that is no column",
        )
        seq = []

        def create():
            seq.append(item().set_title("first").create().get_seq())
            expect_equal(
                code_of(
                    lambda: db.transaction(lambda: None, {"audit": {"actor": "nested"}})
                ),
                "CONFIG",
                "a nested transaction with an audit",
            )
            # A nested transaction uses the outer audit.
            db.transaction(
                lambda: item().set_seq(seq[0]).set_title("second").update(),
                {"retry": 0},
            )

        db.transaction(create, {"audit": {"actor": "create"}, "retry": 0})
        expect_equal(
            code_of(lambda: item().set_seq(seq[0]).set_title("third").update()),
            "CONFIG",
            "update without an audit",
        )
        # An audit transaction without values records the defaults only.
        db.transaction(
            lambda: item().set_seq(seq[0]).delete(), {"audit": {}, "retry": 0}
        )
        failed = RuntimeError("callback failed")

        def fail():
            raise failed

        expect_equal(
            code_of(
                lambda: db.transaction(
                    fail, {"audit": {"actor": "rolled back"}, "retry": 0}
                )
            ),
            failed,
            "a failed callback returns its error",
        )
        try:
            native_query(
                driver, dsn, ["INSERT INTO item (title, audit_seq) VALUES ('raw', 999)"]
            )
            raw = None
        except Exception as error:  # noqa: BLE001 - any driver error of the refused insert
            raw = error
        if raw is None:
            raise AssertionError(
                "a raw insert that names no audit record succeeded; the foreign key rejects it"
            )
        audits = m.Audit().connect(db).order_by_seq_asc().gets()
        expect_equal(
            [[a.get_seq(), a.get_actor()] for a in audits.values()],
            [[1, "create"], [2, "default"]],
            "audit records",
        )
        expect_equal(
            item_history(m, db),
            [
                ["insert", None, seq[0], "first", 1, False],
                ["update", 1, seq[0], "second", 1, False],
                ["update", 1, seq[0], "second", 2, True],
            ],
            "item_history in history_id order",
        )

    with_installed(item, "audit.dbs", AUDIT_TABLES, ["item"], body)


# Every transaction entry point takes the audit: the transaction of the connection and of a handle of it (a handle
# that with_request_hook derives) insert the audit record whose key the audited writes write, and a nested
# transaction takes no audit. The handle shares the audit source of its connection.
def audit_transaction_entry_points(item):
    m = models_of("audit.dbs")

    def body(db, driver, dsn):
        seq = db.transaction(
            lambda: m.Item().set_title("first").create().get_seq(),
            {"audit": {"actor": "transaction"}, "retry": 0},
        )
        handle = db.with_request_hook(lambda request, add_param, params: request)

        def update():
            row = m.Item().seq(seq).get()
            row.set_title("second").update()

        handle.transaction(update, {"audit": {"actor": "handle"}, "retry": 0})
        expect_equal(
            code_of(
                lambda: db.transaction(
                    lambda: db.transaction(
                        lambda: None, {"audit": {"actor": "nested"}}
                    ),
                    {"audit": {}, "retry": 0},
                )
            ),
            "CONFIG",
            "a nested transaction with an audit",
        )
        expect_equal(
            item_history(m, db),
            [
                ["insert", None, seq, "first", 1, False],
                ["update", 1, seq, "second", 2, False],
            ],
            "item_history in history_id order",
        )
        audits = m.Audit().connect(db).order_by_seq_asc().gets()
        expect_equal(
            [[a.get_seq(), a.get_actor()] for a in audits.values()],
            [[1, "transaction"], [2, "handle"]],
            "audit records",
        )

    with_installed(item, "audit.dbs", AUDIT_TABLES, ["item"], body)


# contracts/fixtures/audit_columns.dbs: card leaves secret out with exclude (secret), and tag records only label and the
# audit columns with include (label). The audit triggers record the client's insert, update and soft delete with the
# chosen columns only, and the history tables hold only the recorded columns.
def audit_selected_columns(item):
    m = models_of("audit_columns.dbs")

    def body(db, driver, dsn):
        keys = {}

        def first():
            keys["seq"] = (
                m.Card().set_title("first").set_secret("s1").create().get_seq()
            )
            keys["id"] = m.Tag().set_label("x").set_color("red").create().get_id()
            m.Card().seq(keys["seq"]).get().set_title("second").set_secret(
                "s2"
            ).update()

        def second():
            m.Card().seq(keys["seq"]).get().delete()
            m.Tag().id(keys["id"]).get().set_color("blue").update()

        db.transaction(first, {"audit": {"actor": "first"}, "retry": 0})
        db.transaction(second, {"audit": {"actor": "second"}, "retry": 0})
        change = "`change`" if driver == "mysql" else '"change"'
        seq = str(keys["seq"])
        columns, _ = text_rows(
            driver, dsn, "SELECT * FROM card_history ORDER BY history_id"
        )
        expect_equal(
            columns,
            [
                "history_id",
                "change",
                "previous_audit_seq",
                "seq",
                "title",
                "audit_seq",
                "deleted_at",
            ],
            "card_history columns",
        )
        _, rows = text_rows(
            driver,
            dsn,
            f"SELECT {change}, previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' "
            "ELSE 'deleted' END AS state FROM card_history ORDER BY history_id",
        )
        expect_equal(
            rows,
            [
                ["insert", "NULL", seq, "first", "1", "live"],
                ["update", "1", seq, "second", "1", "live"],
                ["update", "1", seq, "second", "2", "deleted"],
            ],
            "card_history in history_id order",
        )
        columns, _ = text_rows(
            driver, dsn, "SELECT * FROM tag_history ORDER BY history_id"
        )
        expect_equal(
            columns,
            ["history_id", "change", "previous_audit_seq", "label", "audit_seq"],
            "tag_history columns",
        )
        _, rows = text_rows(
            driver,
            dsn,
            f"SELECT {change}, previous_audit_seq, label, audit_seq FROM tag_history ORDER BY history_id",
        )
        expect_equal(
            rows,
            [["insert", "NULL", "x", "1"], ["update", "1", "x", "2"]],
            "tag_history in history_id order",
        )

    with_installed(
        item, "audit_columns.dbs", AUDIT_COLUMNS_TABLES, ["card", "tag"], body
    )


# contracts/fixtures/restore.dbs: restore brings back the soft-deleted rows of an audited table with a unique key and
# an exclude list and of a table without audit (restoreCase of packages/ts/tests/restore_case.mjs). An audit record's
# key may skip the numbers of failed transactions differently on each database, so it is found by its actor.
def soft_delete_restore(item):
    m = models_of("restore.dbs")

    def body(db, driver, dsn):
        def audit_seq(actor):
            rows = list(m.Audit().connect(db).actor(actor).gets().values())
            expect_equal(len(rows), 1, f"audit records of {actor}")
            return rows[0].get_seq()

        def membership_columns(row):
            return [
                row.get_seq(),
                row.get_team_id(),
                row.get_member_id(),
                row.get_note(),
                row.get_audit_seq(),
                row.get_deleted_at(),
            ]

        keys = {}

        def create():
            keys["seq"] = (
                m.Membership()
                .connect(db)
                .set_team_id(1)
                .set_member_id(2)
                .set_note("n1")
                .create()
                .get_seq()
            )
            keys["id"] = (
                m.Label().connect(db).set_name("red").set_color("x").create().get_id()
            )

        def delete():
            m.Membership().connect(db).set_seq(keys["seq"]).delete()
            m.Label().connect(db).set_id(keys["id"]).delete()

        db.transaction(create, {"audit": {"actor": "create"}, "retry": 0})
        db.transaction(delete, {"audit": {"actor": "delete"}, "retry": 0})
        seq, label_id = keys["seq"], keys["id"]
        expect_equal(
            code_of(
                lambda: db.transaction(
                    lambda: (
                        m.Membership()
                        .connect(db)
                        .set_team_id(1)
                        .set_member_id(2)
                        .create()
                    ),
                    {"audit": {"actor": "duplicate"}, "retry": 0},
                )
            ),
            "DUPLICATE_KEY",
            "insert of the key of a soft-deleted row",
        )
        expect_equal(
            m.Label().connect(db).name("red").get(),
            None,
            "default read of a soft-deleted row",
        )
        expect_equal(
            code_of(
                lambda: (
                    m.Membership().connect(db).set_team_id(1).set_member_id(2).restore()
                )
            ),
            "CONFIG",
            "restore of an audited row without an audit",
        )
        # A set value outside the key is a new value written into the restored row.
        restored = db.transaction(
            lambda: (
                m.Membership()
                .connect(db)
                .set_team_id(1)
                .set_member_id(2)
                .set_note("n2")
                .restore()
            ),
            {"audit": {"actor": "restore"}, "retry": 0},
        )
        expect_equal(
            membership_columns(restored),
            [seq, 1, 2, "n2", audit_seq("restore"), None],
            "restored membership",
        )
        again = db.transaction(
            lambda: m.Membership().connect(db).set_seq(seq).set_note("n3").restore(),
            {"audit": {"actor": "again"}, "retry": 0},
        )
        expect_equal(
            membership_columns(again),
            membership_columns(restored),
            "restore of a row that is not deleted returns the unchanged row",
        )
        label = m.Label().connect(db).set_name("red").set_color("y").restore()
        expect_equal(
            [
                label.get_id(),
                label.get_name(),
                label.get_color(),
                label.get_deleted_at(),
            ],
            [label_id, "red", "y", None],
            "restored label",
        )
        expect_equal(
            code_of(lambda: m.Label().connect(db).set_name("blue").restore()),
            "NO_ROWS",
            "restore of an absent row",
        )
        expect_equal(
            code_of(lambda: m.Label().connect(db).set_color("x").restore()),
            "IR_INVALID",
            "restore without the values of a key",
        )
        expect_equal(
            code_of(lambda: m.Label().connect(db).restore()),
            "IR_INVALID",
            "restore without key values",
        )
        create_seq, remove_seq, restore_seq = (
            audit_seq("create"),
            audit_seq("delete"),
            audit_seq("restore"),
        )
        history = (
            m.MembershipHistory()
            .connect(db)
            .add_all_columns()
            .order_by_history_id_asc()
            .gets()
        )
        expect_equal(
            [
                [
                    h.get_change(),
                    h.get_previous_audit_seq(),
                    h.get_seq(),
                    h.get_team_id(),
                    h.get_member_id(),
                    h.get_audit_seq(),
                    "live" if h.get_deleted_at() is None else "deleted",
                ]
                for h in history.values()
            ],
            [
                ["insert", None, seq, 1, 2, create_seq, "live"],
                ["update", create_seq, seq, 1, 2, remove_seq, "deleted"],
                ["update", remove_seq, seq, 1, 2, restore_seq, "live"],
            ],
            "membership_history in history_id order",
        )
        expect_equal(
            m.Audit().connect(db).actor("duplicate").get_count(),
            0,
            "audit records of the failed transaction",
        )
        expect_equal(m.Label().connect(db).get_count(), 1, "live labels")

    with_installed(item, "restore.dbs", RESTORE_TABLES, ["membership"], body)


def tearDownModule():
    if "dir" in STATE:
        STATE["dir"].cleanup()


class CoverageTest(CoverageCase):
    # Requirements: CFG-8, DBS-87, DBS-88, DBS-89, DBS-93, DBS-117, DSL-118, DSL-126.
    def test_audit_history(self):
        self.each_item("audit_history", audit_history)

    # Requirements: DBS-85, DBS-88, DBS-93, DBS-94, DBS-96.
    def test_audit_selected_columns(self):
        self.each_item("audit_selected_columns", audit_selected_columns)

    # Requirements: CFG-8, DBS-87, DBS-88, DBS-93, DSL-126.
    def test_audit_transaction_entry_points(self):
        self.each_item("audit_transaction_entry_points", audit_transaction_entry_points)

    # Requirements: DBS-67, DBS-87, DBS-88, DBS-93, DBS-96, DBS-117, DIA-161, INT-38.
    def test_soft_delete_restore(self):
        self.each_item("soft_delete_restore", soft_delete_restore)


if __name__ == "__main__":
    coverage_main(CoverageTest)
