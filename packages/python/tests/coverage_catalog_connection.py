# catalog_connection coverage (Requirements: SCH-5, SCH-6a): runs the two shared cases against the bench database that the
# feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through connect_catalog. The read case only reads; the
# mutation case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
import os
import unittest

from polyspec.orm import connect_catalog
from polyspec.orm.catalog import GridCell

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
        self.driver = os.environ.get("ORM_FEATURE_DATABASE", "")
        self.assertIn(
            self.driver,
            ("mysql", "postgres", "sqlite"),
            "ORM_FEATURE_DATABASE is required; run it through make feature-check",
        )
        self.catalog = connect_catalog(os.environ["ORM_FEATURE_DSN"])
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

    def test_closed_connection(self):
        self.catalog.close()
        with self.assertRaisesRegex(Exception, "CATALOG_CLOSED"):
            self.catalog.current_namespace()
        with self.assertRaisesRegex(Exception, "CATALOG_CLOSED"):
            self.catalog.read_only_query("SELECT 1", [])

    def test_mysql_timestamp_refused(self):
        if self.driver != "mysql":
            self.skipTest("MySQL TIMESTAMP")
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
    unittest.main()
