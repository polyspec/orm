# catalog_connection coverage runs the two shared cases against the bench database that the
# feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through connect_catalog. The read case only reads; the
# mutation case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
# Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, INT-97, INT-101, INT-102, INT-103, INT-104, INT-109, INT-112, INT-113, INT-114, INT-115, INT-121, INT-123, INT-136, INT-117.
# Its SQLite path also checks generated primary keys in a temporary file, outside the bench database.
import io
import os
import secrets
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from polyspec.orm import OrmError, codes, connect_catalog
from polyspec.orm.catalog import CatalogConnection, GridCell
from polyspec.orm.codec import decode as decode_styled
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
        self.dsn = dsn
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

    # Requirements: INT-101, INT-136, INT-117.
    # Requirements: INT-115.
    def test_read(self):
        with self.assertRaises(Exception):
            connect_catalog("unsupported://host/database")
        with tempfile.TemporaryDirectory(prefix="orm-catalog-missing-") as directory:
            missing = Path(directory) / "missing.sqlite"
            with self.assertRaises(Exception):
                connect_catalog(f"sqlite://{missing}")
            self.assertFalse(missing.exists(), "catalog connection must not create a missing SQLite database")
        driver = self.driver
        namespace = self.catalog.current_namespace()
        author = {"namespace": namespace, "name": "author"}
        meta = self.catalog.describe_table(author)
        self.assertEqual(meta.primary_key, ["seq"])
        self.assertTrue(meta.reliable_row_identity)
        self.assertIn("start_dt", [c.name for c in meta.columns])
        self._assert_qualified_table_metadata(namespace)
        page = self.catalog.table_page(author, 3, 0)
        self.assertEqual(page.order_by, ["seq"])
        self.assertTrue(page.has_more)
        self.assertEqual(len(page.result.rows), 3)
        self.assertEqual(page.result.columns, [column.name for column in meta.columns])
        for limit, offset in ((0, 0), (1001, 0), (1, 1_000_001)):
            with self.assertRaises(Exception):
                self.catalog.table_page(author, limit, offset)
        count = self.catalog.read_only_query(
            f"SELECT COUNT(*) FROM {quote('user', driver)}", []
        )
        self.assertEqual(int(count.rows[0][0]), 5000)
        if driver == "mysql":
            import pymysql

            url = urlsplit(self.dsn)
            query = parse_qs(url.query)
            name = f"catalog_readonly_{os.getpid()}_{secrets.token_hex(4)}"
            function = f"{name}_fn"
            native = pymysql.connect(
                host=url.hostname or "localhost",
                port=url.port or 3306,
                user=unquote(url.username or ""),
                password=unquote(url.password or ""),
                database=unquote(url.path.lstrip("/")),
                unix_socket=query.get("socket", [None])[0],
                autocommit=True,
            )
            try:
                with native.cursor() as cursor:
                    cursor.execute(f"CREATE TABLE {quote(name, driver)} (n INTEGER NOT NULL)")
                    cursor.execute(f"INSERT INTO {quote(name, driver)} VALUES (7)")
                    cursor.execute(
                        f"CREATE FUNCTION {quote(function, driver)}() RETURNS INTEGER DETERMINISTIC "
                        f"MODIFIES SQL DATA BEGIN UPDATE {quote(name, driver)} SET n=n+1; RETURN 1; END"
                    )
                with self.assertRaises(Exception, msg="a database-enforced read-only scope allowed a function to write"):
                    self.catalog.read_only_grid_query(f"SELECT {quote(function, driver)}()", [])
            finally:
                try:
                    with native.cursor() as cursor:
                        cursor.execute(f"DROP FUNCTION IF EXISTS {quote(function, driver)}")
                        cursor.execute(f"DROP TABLE IF EXISTS {quote(name, driver)}")
                finally:
                    native.close()
        else:
            read_only_sql = (
                "SELECT current_setting('transaction_read_only')"
                if driver == "postgres"
                else "SELECT query_only FROM pragma_query_only"
            )
            read_only_state = self.catalog.read_only_query(read_only_sql, [])
            self.assertEqual(read_only_state.rows, [["on" if driver == "postgres" else 1]])
        if driver == "mysql":
            classification = self.catalog.read_only_query(
                "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'TABLES'",
                [],
            )
            self.assertEqual(classification.rows, [["SYSTEM VIEW"]])
            system_view = self.catalog.describe_table(
                {"namespace": "information_schema", "name": "TABLES"}
            )
            self.assertEqual(system_view.kind, "view")
            self.assertTrue(system_view.columns)
            self.assertEqual(system_view.primary_key, [])
            self.assertFalse(system_view.reliable_row_identity)
        self._assert_temporal_default_precision()
        plain_rows = "SELECT 'alpha' AS value UNION ALL SELECT 'beta' AS value"
        exact_rows = self.catalog.read_only_query(
            plain_rows, [], max_rows=2, max_bytes=128
        )
        self.assertEqual(exact_rows.rows, [["alpha"], ["beta"]])
        with self.assertRaises(OrmError) as plain_row_limit:
            self.catalog.read_only_query(plain_rows, [], max_rows=1, max_bytes=128)
        self.assertEqual(plain_row_limit.exception.code, codes.CATALOG_LIMIT)
        exact_bytes_sql = "SELECT 'abc' AS value"
        exact_bytes = self.catalog.read_only_query(
            exact_bytes_sql, [], max_rows=2, max_bytes=3
        )
        self.assertEqual(exact_bytes.rows, [["abc"]])
        with self.assertRaises(OrmError) as plain_byte_limit:
            self.catalog.read_only_query(exact_bytes_sql, [], max_rows=2, max_bytes=2)
        self.assertEqual(plain_byte_limit.exception.code, codes.CATALOG_LIMIT)
        with self.assertRaises(OrmError) as row_limit:
            self.catalog.read_only_grid_query(
                "SELECT 'abc' AS value UNION ALL SELECT 'def'",
                [],
                max_rows=1,
                max_bytes=1024,
            )
        self.assertEqual(row_limit.exception.code, codes.CATALOG_LIMIT)
        with self.assertRaises(OrmError) as byte_limit:
            self.catalog.read_only_grid_query(
                "SELECT 'abc' AS value", [], max_rows=2, max_bytes=2
            )
        self.assertEqual(byte_limit.exception.code, codes.CATALOG_LIMIT)
        with self.assertRaisesRegex(Exception, "QUERY_READ_ONLY"):
            self.catalog.read_only_query(
                f"UPDATE {quote('user', driver)} SET name = name WHERE seq = 1", []
            )
        for sql in (
            "SELECT ';' AS value /* ; */",
            "WITH values_cte AS (SELECT 1 AS value) SELECT value FROM values_cte",
        ):
            self.catalog.read_only_grid_query(sql, [])
        read_only_refusals = [
            "COMMIT",
            "CALL missing_catalog_procedure()",
            "SELECT 1 INTO catalog_forbidden",
            "SELECT 1 FOR UPDATE",
            "SELECT 1; SELECT 2",
            "WITH changed AS (UPDATE user SET name=name WHERE seq=1 RETURNING seq) SELECT seq FROM changed",
        ]
        if driver == "postgres":
            read_only_refusals.extend(
                (
                    "SELECT " + " UNION ALL ".join(["1"] * 200),
                    "SELECT " + "+".join(["1"] * 200),
                )
            )
        for sql in read_only_refusals:
            with self.assertRaises(OrmError, msg=f"read-only grid query accepted {sql}") as refusal:
                self.catalog.read_only_grid_query(sql, [])
            self.assertEqual(refusal.exception.code, codes.QUERY_READ_ONLY, sql)
        self.test_grid_cells()

    def _assert_qualified_table_metadata(self, namespace):
        url = urlsplit(self.dsn)
        query = parse_qs(url.query)
        name = f"catalog_metadata_{os.getpid()}_{secrets.token_hex(4)}"
        if self.driver == "sqlite":
            native = sqlite3.connect(unquote(url.path))
        elif self.driver == "mysql":
            import pymysql

            native = pymysql.connect(
                host=url.hostname or "localhost",
                port=url.port or 3306,
                user=unquote(url.username or ""),
                password=unquote(url.password or ""),
                database=unquote(url.path.lstrip("/")),
                unix_socket=query.get("socket", [None])[0],
                autocommit=True,
            )
        else:
            import psycopg

            native = psycopg.connect(
                host=query.get("host", [url.hostname or "localhost"])[-1],
                port=url.port or 5432,
                user=unquote(url.username or ""),
                password=unquote(url.password or ""),
                dbname=unquote(url.path.lstrip("/")),
                autocommit=True,
            )
        qualified = f"{quote(namespace, self.driver)}.{quote(name, self.driver)}" if self.driver != "sqlite" else quote(name, self.driver)

        def execute(sql):
            if self.driver == "mysql":
                with native.cursor() as cursor:
                    cursor.execute(sql)
            else:
                native.execute(sql)

        try:
            execute(
                f"CREATE TABLE {qualified} (a BIGINT NOT NULL, b BIGINT NOT NULL, note VARCHAR(50), "
                "g BIGINT GENERATED ALWAYS AS (a+1) STORED, PRIMARY KEY (b,a))"
            )
            metadata = self.catalog.describe_table({"namespace": namespace, "name": name})
            want_native_types = {
                "mysql": ["bigint", "bigint", "varchar(50)", "bigint"],
                "postgres": ["bigint", "bigint", "character varying(50)", "bigint"],
                "sqlite": ["BIGINT", "BIGINT", "VARCHAR(50)", "BIGINT"],
            }[self.driver]
            self.assertEqual([column.name for column in metadata.columns], ["a", "b", "note", "g"])
            self.assertEqual([column.native_type for column in metadata.columns], want_native_types)
            self.assertEqual(metadata.primary_key, ["b", "a"])
            self.assertTrue(metadata.columns[2].nullable)
            self.assertTrue(metadata.columns[3].generated)
            self.assertTrue(metadata.reliable_row_identity)
        finally:
            execute(f"DROP TABLE IF EXISTS {qualified}")
            native.close()

    def _assert_temporal_default_precision(self):
        url = urlsplit(self.dsn)
        query = parse_qs(url.query)
        if self.driver == "mysql":
            import pymysql

            native = pymysql.connect(
                host=url.hostname or "localhost",
                port=url.port or 3306,
                user=unquote(url.username or ""),
                password=unquote(url.password or ""),
                database=unquote(url.path.lstrip("/")),
                unix_socket=query.get("socket", [None])[0],
                autocommit=True,
            )
            columns = "id BIGINT NOT NULL PRIMARY KEY, t0 TIME NULL, dt0 DATETIME NULL, t3 TIME(3) NULL, dt3 DATETIME(3) NULL"
        elif self.driver == "postgres":
            import psycopg

            native = psycopg.connect(
                host=query.get("host", [url.hostname or "localhost"])[-1],
                port=url.port or 5432,
                user=unquote(url.username or ""),
                password=unquote(url.password or ""),
                dbname=unquote(url.path.lstrip("/")),
                autocommit=True,
            )
            columns = (
                "id BIGINT NOT NULL PRIMARY KEY, t0 TIME WITHOUT TIME ZONE NULL, "
                "dt0 TIMESTAMP WITHOUT TIME ZONE NULL, t3 TIME(3) WITHOUT TIME ZONE NULL, "
                "dt3 TIMESTAMP(3) WITHOUT TIME ZONE NULL"
            )
        else:
            native = sqlite3.connect(unquote(url.path), isolation_level=None)
            columns = (
                "id INTEGER NOT NULL PRIMARY KEY, "
                't0 TIME NOT NULL CHECK (length("t0") = 8 AND "t0" IS time("t0") AND "t0" < \'24:00:00\'), '
                'dt0 DATETIME NOT NULL CHECK (length("dt0") = 19 AND "dt0" IS datetime("dt0") AND substr("dt0", 12, 2) < \'24\'), '
                't3 TIME NOT NULL CHECK (length("t3") = 12 AND substr("t3", 1, 8) IS time(substr("t3", 1, 8)) AND "t3" < \'24:00:00\' AND substr("t3", 9, 1) = \'.\' AND substr("t3", 10) GLOB \'[0-9][0-9][0-9]\'), '
                'dt3 DATETIME NOT NULL CHECK (length("dt3") = 23 AND substr("dt3", 1, 19) IS datetime(substr("dt3", 1, 19)) AND substr("dt3", 12, 2) < \'24\' AND substr("dt3", 20, 1) = \'.\' AND substr("dt3", 21) GLOB \'[0-9][0-9][0-9]\')'
            )
        name = f"catalog_temporal_precision_{os.getpid()}_{secrets.token_hex(4)}"
        qualified = f"{quote(self.catalog.current_namespace(), self.driver)}.{quote(name, self.driver)}"
        invalid = quote(f"{name}_invalid", self.driver)
        try:
            with native.cursor() as cursor:
                cursor.execute(f"DROP TABLE IF EXISTS {qualified}")
                cursor.execute(f"CREATE TABLE {qualified} ({columns})")
                metadata = self.catalog.describe_table(
                    {"namespace": self.catalog.current_namespace(), "name": name}
                )
                with self.assertRaises(OrmError):
                    self.catalog.insert_row(
                        metadata,
                        [
                            ("id", 2),
                            ("t0", "12:34:56"),
                            ("dt0", "2026-01-02 03:04:05"),
                            ("t3", "12:34:56.1234"),
                            ("dt3", "2026-01-02 03:04:05.1234"),
                        ],
                    )
                unchanged = self.catalog.read_only_query(
                    f"SELECT COUNT(*) FROM {qualified} WHERE id=2", []
                )
                self.assertEqual(int(unchanged.rows[0][0]), 0)
                t0 = "12:34:56.123456" if self.driver == "postgres" else "12:34:56"
                dt0 = (
                    "2026-01-02 03:04:05.123456"
                    if self.driver == "postgres"
                    else "2026-01-02 03:04:05"
                )
                inserted = self.catalog.insert_row(
                    metadata,
                    [
                        ("id", 1),
                        ("t0", t0),
                        ("dt0", dt0),
                        ("t3", "12:34:56.123"),
                        ("dt3", "2026-01-02 03:04:05.123"),
                    ],
                )
                self.assertEqual(len(inserted.rows), 1)
                page = self.catalog.table_page(
                    {"namespace": self.catalog.current_namespace(), "name": name}, 1, 0
                )
                values = page.result.rows[0][1:]
                fractions = (
                    [
                        len(value.split(".", 1)[1]) if "." in value else 0
                        for value in values
                    ]
                    if self.driver == "sqlite"
                    else [
                        getattr(value, "microsecond", getattr(value, "microseconds", 0))
                        for value in values
                    ]
                )
                self.assertEqual(
                    (
                        [0, 0, 3, 3]
                        if self.driver == "sqlite"
                        else [0, 0, 123000, 123000]
                    )
                    if self.driver == "mysql"
                    else [0, 0, 3, 3]
                    if self.driver == "sqlite"
                    else [123456, 123456, 123000, 123000],
                    fractions,
                    f"{self.driver}: temporal table reads use native defaults and declared precision",
                )
                if self.driver == "mysql":
                    with self.assertRaises(
                        Exception, msg="MySQL rejects temporal precision above 6"
                    ) as rejected:
                        cursor.execute(
                            f"CREATE TABLE {invalid} (id BIGINT PRIMARY KEY, t TIME(7))"
                        )
                    self.assertIn("precision", str(rejected.exception).lower())
        finally:
            try:
                with native.cursor() as cursor:
                    cursor.execute(f"DROP TABLE IF EXISTS {qualified}")
                    cursor.execute(f"DROP TABLE IF EXISTS {invalid}")
            finally:
                native.close()

    # Requirements: COD-31, INT-4, INT-8.
    def test_model_read_null_and_empty_text(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(prefix="orm-null-empty-model-") as directory:
            models = generate(
                directory, root / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
            )
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
                self.catalog.insert_row(
                    metadata, [("seq", seq), ("label", "null-v"), ("body", None)]
                )
                self.catalog.insert_row(
                    metadata, [("seq", seq - 1), ("label", "empty"), ("body", "")]
                )
                null_read = models.BindCell().connect(db).seq(seq).get()
                empty_read = models.BindCell().connect(db).seq(seq - 1).get()
                self.assertIsNone(
                    null_read.get_body(),
                    "SQL NULL remains None when read through the model",
                )
                self.assertEqual(
                    empty_read.get_body(),
                    "",
                    "empty text remains an empty string when read through the model",
                )
                with self.assertRaises(OrmError) as empty_json:
                    decode_styled(["ordered_json"], "")
                self.assertEqual(empty_json.exception.code, codes.CODEC_DECODE)
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

    # Requirements: DBS-113, INT-106, INT-108, INT-109, INT-110, INT-111.
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
        bad_page = self.catalog.table_page(table, 1000, 0)
        bad_page.order_by = []
        with self.assertRaises(OrmError) as raised:
            self.catalog.row_snapshot_from_page(bad_page, 0)
        self.assertEqual(raised.exception.code, codes.ROW_SNAPSHOT_INVALID)

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

        original = find("catalog")
        self.assertEqual(original.metadata.primary_key, ["tenant_id", "account_id"])
        self.assertEqual(original.keys(), [TENANT, 1])
        original_cells = list(original.cells)
        original_revision = original.revision
        for values in [
            [("name", "first"), ("name", "second")],
            [("absent", "value")],
            [("name", None)],
            [("name", "x" * 192)],
        ]:
            with self.assertRaises(OrmError) as raised:
                self.catalog.update_row(original, values)
            self.assertEqual(raised.exception.code, codes.ROW_UPDATE_INVALID)
        self.assertEqual(find("catalog").revision, original_revision)
        updated = self.catalog.update_row(original, [("name", "catalog-updated")])
        self.assertEqual(len(updated.rows), 1)
        self.assertEqual(original.cells, original_cells)
        self.assertEqual(original.revision, original_revision)
        with self.assertRaises(OrmError) as raised:
            self.catalog.update_row(original, [("name", "stale")])
        self.assertEqual(raised.exception.code, codes.ROW_CONFLICT)
        self.assertEqual(
            self.catalog.read_only_query(
                f"SELECT name FROM {account} WHERE tenant_id = ? AND account_id = ?",
                [TENANT, 1],
            ).rows,
            [["catalog-updated"]],
        )
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

    def test_grid_column_and_row_order(self):
        result = self.catalog.read_only_grid_query(
            "SELECT 1 AS seq, 'a' AS label UNION ALL SELECT 2, 'b' UNION ALL SELECT 3, 'c' UNION ALL SELECT 4, 'd' ORDER BY seq DESC",
            [],
        )
        self.assertEqual(result.columns, ["seq", "label"])
        rows = [[(cell.kind, cell.value) for cell in row] for row in result.rows]
        self.assertEqual(
            rows,
            [
                [("integer", 4), ("text", "d")],
                [("integer", 3), ("text", "c")],
                [("integer", 2), ("text", "b")],
                [("integer", 1), ("text", "a")],
            ],
        )


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        feature_cases = {
            "catalog_read": "test_read",
            "catalog_plain_query_bounds": "test_read",
            "catalog_grid_column_and_row_order": "test_grid_column_and_row_order",
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
                case_id: lambda item, method_name=method_name: run_case(
                    method_name, item
                )
                for case_id, method_name in feature_cases.items()
            }
        )
