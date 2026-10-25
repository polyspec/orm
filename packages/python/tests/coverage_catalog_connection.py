# catalog_connection coverage runs the two shared cases against the bench database that the
# feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through connect_catalog. The read case only reads; the
# mutation case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
# Requirements: SCH-3, SCH-5, SCH-6a, INT-103, INT-109, INT-113, INT-114, INT-123.
# Its SQLite path also checks generated primary keys in a temporary file, outside the bench database.
import io
import os
import secrets
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from polyspec.orm import connect_catalog
from polyspec.orm.catalog import GridCell
from .coverage_case import run_cases
from .test_sqlite import generate

TENANT = 990005

# One row of typed grid cells per dialect (docs/spec/interfaces.md, "Rust native grid query specification"): float cells hold
# their IEEE-754 bits, UNSIGNED integers are unsigned cells, and date, time and datetime cells hold dbspec text.
GRID_CELLS = {
    "mysql": (
        "SELECT CAST(1.5 AS FLOAT) AS f, CAST(1.5 AS DOUBLE) AS d, CAST(18446744073709551615 AS UNSIGNED) AS u, "
        "CAST(-7 AS SIGNED) AS i, CAST(1.50 AS DECIMAL(10,2)) AS dv, CAST('ab' AS BINARY) AS b, CAST(NULL AS DATE) AS n, "
        "CAST('2024-02-29' AS DATE) AS dt, CAST('12:34:56.5' AS TIME(6)) AS tm, "
        "CAST('2024-02-29 01:02:03.5' AS DATETIME(6)) AS dtm",
        [
            GridCell("float32", 0x3FC00000),
            GridCell("float64", 0x3FF8000000000000),
            GridCell("unsigned", 2**64 - 1),
            GridCell("integer", -7),
            GridCell("decimal", "1.50"),
            GridCell("binary", b"ab"),
            GridCell("null"),
            GridCell("date", "2024-02-29"),
            GridCell("time", "12:34:56.500000"),
            GridCell("datetime", "2024-02-29 01:02:03.500000"),
        ],
    ),
    "postgres": (
        "SELECT 1.5::real AS f, 1.5::double precision AS d, 'NaN'::double precision AS nan, 'NaN'::real AS nanf, "
        "9223372036854775807::bigint AS i, 2.50::numeric(10,2) AS dec, '\\x6162'::bytea AS b, NULL::date AS n, "
        "'2024-02-29'::date AS dt, '12:34:56.5'::time AS tm, '2024-02-29 01:02:03.5'::timestamp AS dtm",
        [
            GridCell("float32", 0x3FC00000),
            GridCell("float64", 0x3FF8000000000000),
            GridCell("float64", 0x7FF8000000000000),
            GridCell("float32", 0x7FC00000),
            GridCell("integer", 9223372036854775807),
            GridCell("decimal", "2.50"),
            GridCell("binary", b"ab"),
            GridCell("null"),
            GridCell("date", "2024-02-29"),
            GridCell("time", "12:34:56.500000"),
            GridCell("datetime", "2024-02-29 01:02:03.500000"),
        ],
    ),
    "sqlite": (
        "SELECT 1.5 AS d, 7 AS i, 'x' AS t, X'6162' AS b, NULL AS n",
        [
            GridCell("float64", 0x3FF8000000000000),
            GridCell("integer", 7),
            GridCell("text", "x"),
            GridCell("binary", b"ab"),
            GridCell("null"),
        ],
    ),
}

# Values that the grid query refuses with CATALOG_VALUE, as the Rust grid refuses them.
GRID_REFUSED = {
    "mysql": ["SELECT CAST('-01:00:00' AS TIME(6)) AS t"],
    "postgres": [
        "SELECT '2024-01-01 00:00:00+00'::timestamptz AS t",
        "SELECT '00:00:00+00'::timetz AS t",
        "SELECT '24:00:00'::time AS t",
        "SELECT 'infinity'::date AS t",
    ],
    "sqlite": [],
}


def quote(name, driver):
    return f"`{name}`" if driver == "mysql" else f'"{name}"'


class CatalogConnectionCoverageTest(unittest.TestCase):
    def setUp(self):
        item = getattr(self, "coverage_item", None)
        if item is None:
            self.driver = os.environ.get("ORM_FEATURE_DATABASE", "")
            dsn = os.environ.get("ORM_FEATURE_DSN")
        else:
            self.driver, dsn = item
        self.assertIn(
            self.driver,
            ("mysql", "postgres", "sqlite"),
            "ORM_FEATURE_DATABASE is required; run it through make feature-check",
        )
        self.catalog = connect_catalog(dsn)
        self.assertEqual(
            self.catalog.dialect,
            self.driver,
            "ORM_FEATURE_DSN selects another database",
        )

    def tearDown(self):
        self.catalog.close()

    def test_read(self):
        driver = self.driver
        namespace = self.catalog.current_namespace()
        author = {"namespace": namespace, "name": "author"}
        meta = self.catalog.describe_table(author)
        self.assertEqual(meta.primary_key, ["seq"])
        self.assertTrue(meta.reliable_row_identity)
        self.assertIn("start_dt", [c.name for c in meta.columns])
        page = self.catalog.table_page(author, 3, 0)
        self.assertEqual(page.order_by, ["seq"])
        self.assertTrue(page.has_more)
        self.assertEqual(len(page.result.rows), 3)
        count = self.catalog.read_only_query(
            f"SELECT COUNT(*) FROM {quote('user', driver)}", []
        )
        self.assertEqual(int(count.rows[0][0]), 5000)
        with self.assertRaisesRegex(Exception, "QUERY_READ_ONLY"):
            self.catalog.read_only_query(
                f"UPDATE {quote('user', driver)} SET name = name WHERE seq = 1", []
            )
        self.test_grid_cells()

    # Requirements: INT-4, INT-8.
    def test_model_read_null_and_empty_text(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(prefix="orm-null-empty-model-") as directory:
            models = generate(directory, root / "contracts" / "fixtures" / "bench" / "dbspec-set.json")
            db = models.connect(
                self.coverage_item[1],
                aesKey="bench-salt",
                blindIndexKey="bench-blind-index",
            )
            seq = -1_000_000_000_000 - secrets.randbelow(1_000_000_000)
            table = {
                "namespace": self.catalog.current_namespace(),
                "name": "bind_cell",
            }
            metadata = self.catalog.describe_table(table)
            targets = {seq, seq - 1}
            try:
                self.catalog.insert_row(metadata, [("seq", seq), ("label", "null-v"), ("body", None)])
                self.catalog.insert_row(metadata, [("seq", seq - 1), ("label", "empty"), ("body", "")])
                null_read = models.BindCell().connect(db).seq(seq).get()
                empty_read = models.BindCell().connect(db).seq(seq - 1).get()
                self.assertIsNone(null_read.get_body(), "SQL NULL remains None when read through the model")
                self.assertEqual(empty_read.get_body(), "", "empty text remains an empty string when read through the model")
            finally:
                snapshots = []
                offset = 0
                while True:
                    page = self.catalog.table_page(table, 1000, offset)
                    key_index = page.column_index("seq")
                    snapshots.extend(
                        self.catalog.row_snapshot_from_page(page, index)
                        for index, row in enumerate(page.result.rows)
                        if row[key_index] in targets
                    )
                    if not page.has_more:
                        break
                    offset += len(page.result.rows)
                for snapshot in snapshots:
                    self.catalog.delete_row(snapshot)
                db.close()

    # Requirements: DBS-113.
    def test_row_mutation(self):
        driver = self.driver
        account = quote("composite_account", driver)
        count_sql = f"SELECT COUNT(*) FROM {account} WHERE tenant_id = {TENANT}"

        def tenant_rows():
            return int(self.catalog.read_only_query(count_sql, []).rows[0][0])

        self.assertEqual(tenant_rows(), 0)
        table = {
            "namespace": self.catalog.current_namespace(),
            "name": "composite_account",
        }
        meta = self.catalog.describe_table(table)
        inserted = self.catalog.insert_row(
            meta, [("tenant_id", TENANT), ("account_id", 1), ("name", "catalog")]
        )
        self.assertEqual(len(inserted.rows), 1)

        def find(want):
            page = self.catalog.table_page(table, 1000, 0)
            self.assertFalse(page.has_more)
            index = page.column_index("tenant_id")
            found = [
                i for i, row in enumerate(page.result.rows) if row[index] == TENANT
            ]
            self.assertEqual(len(found), 1)
            self.assertEqual(
                page.result.rows[found[0]][page.column_index("name")], want
            )
            return self.catalog.row_snapshot_from_page(page, found[0])

        updated = self.catalog.update_row(
            find("catalog"), [("name", "catalog-updated")]
        )
        self.assertEqual(len(updated.rows), 1)
        self.assertEqual(self.catalog.delete_row(find("catalog-updated")), 1)
        self.assertEqual(tenant_rows(), 0)
        if driver == "sqlite":
            with tempfile.TemporaryDirectory(
                prefix="orm-catalog-auto-key-"
            ) as directory:
                path = os.path.join(directory, "catalog.sqlite3")
                raw = sqlite3.connect(path)
                try:
                    raw.execute(
                        "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)"
                    )
                    raw.execute(
                        "CREATE TABLE literal_key (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL, PRIMARY KEY (tenant, seq))"
                    )
                    raw.execute(
                        "CREATE TABLE expression_key (seq TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY, n BIGINT NOT NULL UNIQUE, label TEXT NULL)"
                    )
                finally:
                    raw.close()
                catalog = connect_catalog(f"sqlite://{path}")
                try:
                    metadata = catalog.describe_table(
                        {"namespace": "main", "name": "sample"}
                    )
                    self.assertEqual(metadata.primary_key, ["id"])
                    self.assertTrue(metadata.columns[0].automatic_key)
                    self.assertIsNone(metadata.columns[0].default_expression)
                    inserted = catalog.insert_row(metadata, [("payload", "generated")])
                    self.assertEqual(inserted.rows, [[1, "generated"]])
                    stored = catalog.read_only_query(
                        'SELECT "id", "payload" FROM "sample"', []
                    )
                    self.assertEqual(stored.rows, [[1, "generated"]])

                    literal_table = {"namespace": "main", "name": "literal_key"}
                    literal_metadata = catalog.describe_table(literal_table)
                    literal = catalog.insert_row(
                        literal_metadata, [("tenant", 2), ("n", 50)]
                    )
                    literal_stored = catalog.read_only_query(
                        'SELECT "tenant", "seq", "n" FROM "literal_key"', []
                    )
                    self.assertEqual(literal.rows, [[2, "generated", 50]])
                    self.assertEqual(literal.rows, literal_stored.rows)

                    expression_table = {
                        "namespace": "main",
                        "name": "expression_key",
                    }
                    expression_metadata = catalog.describe_table(expression_table)
                    expression = catalog.insert_row(
                        expression_metadata, [("n", 1), ("label", None)]
                    )
                    expression_stored = catalog.read_only_query(
                        'SELECT "seq", "n", "label" FROM "expression_key"', []
                    )
                    self.assertRegex(expression.rows[0][0], r"[0-9a-f]{32}")
                    self.assertEqual(
                        expression.rows, [[expression.rows[0][0], 1, None]]
                    )
                    self.assertEqual(expression.rows, expression_stored.rows)
                finally:
                    catalog.close()

    def test_closed_connection(self):
        self.catalog.close()
        with self.assertRaisesRegex(Exception, "CATALOG_CLOSED"):
            self.catalog.current_namespace()
        with self.assertRaisesRegex(Exception, "CATALOG_CLOSED"):
            self.catalog.read_only_query("SELECT 1", [])

    def test_mysql_timestamp_refused(self):
        if self.driver != "mysql":
            self.assertEqual(
                self.driver,
                "mysql",
                "MySQL TIMESTAMP refusal must run on the MySQL bench database",
            )
        # A table that this test creates and drops: a grid query reads its TIMESTAMP column, which must be refused.
        import pymysql
        from polyspec.orm.database import parse_dsn

        url = parse_dsn(os.environ["ORM_FEATURE_DSN"]).url
        admin = pymysql.connect(
            host=url.hostname,
            port=url.port or 3306,
            user=url.username,
            password=url.password or "",
            database=url.path.lstrip("/"),
            autocommit=True,
        )
        table = "orm_catalog_grid_timestamp"
        try:
            with admin.cursor() as cursor:
                cursor.execute(f"DROP TABLE IF EXISTS `{table}`")
                cursor.execute(f"CREATE TABLE `{table}` (`ts` TIMESTAMP NULL)")
                # A NULL TIMESTAMP reads as a null cell; a value is what the grid refuses.
                cursor.execute(
                    f"INSERT INTO `{table}` (`ts`) VALUES ('2024-01-01 00:00:00')"
                )
            with self.assertRaisesRegex(Exception, "CATALOG_VALUE"):
                self.catalog.read_only_grid_query(f"SELECT `ts` FROM `{table}`", [])
        finally:
            with admin.cursor() as cursor:
                cursor.execute(f"DROP TABLE IF EXISTS `{table}`")
            admin.close()

    def test_grid_cells(self):
        sql, expected = GRID_CELLS[self.driver]
        result = self.catalog.read_only_grid_query(sql, [])
        self.assertEqual(len(result.rows), 1)
        self.assertEqual(result.rows[0], expected)
        for refused in GRID_REFUSED[self.driver]:
            with self.assertRaisesRegex(Exception, "CATALOG_VALUE"):
                self.catalog.read_only_grid_query(refused, [])


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        feature_cases = {
            "catalog_read": "test_read",
            "model_read_null_and_empty_text": "test_model_read_null_and_empty_text",
            "catalog_row_mutation": "test_row_mutation",
        }

        def run_case(method_name, item):
            case = CatalogConnectionCoverageTest(method_name)
            case.coverage_item = item
            suite = unittest.TestSuite([case])
            output = io.StringIO()
            result = unittest.TextTestRunner(stream=output).run(suite)
            if not result.wasSuccessful():
                sys.stderr.write(output.getvalue())
                raise AssertionError(f"{method_name} failed for {item[0]}")

        run_cases(
            {
                case_id: lambda item, method_name=method_name: run_case(method_name, item)
                for case_id, method_name in feature_cases.items()
            }
        )
