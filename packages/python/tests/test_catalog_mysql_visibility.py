import unittest

from . import testcase
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogConnection,
    CatalogTableMetadata,
    _Session,
)
from polyspec.orm.database import parse_dsn
from polyspec.orm.errors import OrmError, codes


class CatalogMysqlVisibilityTest(unittest.TestCase):
    def test_public_insert_verifies_mysql_trigger_visibility(self):
        # Requirements: INT-119.
        metadata = CatalogTableMetadata(
            table={"namespace": "app", "name": "visibility_probe"},
            kind="table",
            columns=[
                CatalogColumn("id", "BIGINT", False, False),
                CatalogColumn("value", "VARCHAR(32)", False, False),
            ],
            primary_key=["id"],
            reliable_row_identity=True,
        )

        def fixture(*, partial_revokes=0, direct_trigger_grant=True):
            state = {"inserted": False, "queries": []}

            class Connection:
                def cursor(self):
                    return Cursor(self)

                def close(self):
                    pass

            class Cursor:
                def __init__(self, connection):
                    self.connection = connection
                    self.description = None
                    self.rowcount = 0
                    self.lastrowid = None
                    self.rows = []

                def execute(self, sql, params):
                    state["queries"].append(sql)
                    self.description = None
                    self.rows = []
                    self.rowcount = 0
                    if sql == "SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)":
                        self.description = [("partial_revokes", 8)]
                        self.rows = [(partial_revokes,)]
                    elif sql == "SELECT CURRENT_USER()":
                        self.description = [("CURRENT_USER()", 253)]
                        self.rows = [("orm@localhost",)]
                    elif "information_schema.USER_PRIVILEGES" in sql:
                        self.description = [("PRIVILEGE_TYPE", 253)]
                        self.rows = [("TRIGGER",)] if direct_trigger_grant else []
                    elif sql.startswith("SELECT ENGINE"):
                        self.description = [("ENGINE", 253)]
                        self.rows = [("InnoDB",)]
                    elif sql.startswith("SELECT TRIGGER_NAME"):
                        self.description = [("TRIGGER_NAME", 253)]
                    elif sql.startswith("SELECT TABLE_TYPE"):
                        self.description = [("TABLE_TYPE", 253)]
                        self.rows = [("BASE TABLE",)]
                    elif sql.startswith("SELECT c.COLUMN_NAME"):
                        self.description = [
                            (name, 253)
                            for name in (
                                "COLUMN_NAME",
                                "COLUMN_TYPE",
                                "IS_NULLABLE",
                                "GENERATED",
                                "ORDINAL_POSITION",
                                "AUTO_KEY",
                                "COLUMN_DEFAULT",
                                "EXPRESSION_DEFAULT",
                            )
                        ]
                        self.rows = [
                            ("id", "BIGINT", 0, 0, 1, 0, None, 0),
                            ("value", "VARCHAR(32)", 0, 0, 0, 0, None, 0),
                        ]
                    elif sql.startswith("SELECT `id`,`value` FROM"):
                        self.description = [("id", 8), ("value", 253)]
                        if self.connection_inserted:
                            self.rows = [(1, "visible")]
                    elif sql.startswith("INSERT INTO"):
                        self.connection_inserted = True
                        self.rowcount = 1
                    self.index = 0

                @property
                def connection_inserted(self):
                    return state["inserted"]

                @connection_inserted.setter
                def connection_inserted(self, value):
                    state["inserted"] = value

                def fetchone(self):
                    if self.index >= len(self.rows):
                        return None
                    row = self.rows[self.index]
                    self.index += 1
                    return row

                def close(self):
                    pass

            class Wrapper:
                connection = Connection()

                def close(self):
                    self.connection.close()

            catalog = CatalogConnection(parse_dsn("mysql://user:pass@localhost/app"))
            catalog._open = lambda: _Session("mysql", Wrapper())
            return catalog, state

        direct, direct_state = fixture()
        result = direct.insert_row(metadata, [("id", 1), ("value", "visible")])
        self.assertEqual(result.rows, [[1, "visible"]])
        self.assertTrue(
            any(
                "information_schema.USER_PRIVILEGES" in sql
                for sql in direct_state["queries"]
            )
        )
        self.assertTrue(
            any(sql.startswith("INSERT INTO") for sql in direct_state["queries"])
        )

        for scenario, options in (
            ("role-only TRIGGER grant", {"direct_trigger_grant": False}),
            ("enabled partial revokes", {"partial_revokes": 1}),
        ):
            catalog, state = fixture(**options)
            with self.subTest(scenario=scenario), self.assertRaises(OrmError) as raised:
                catalog.insert_row(metadata, [("id", 1), ("value", "visible")])
            self.assertEqual(raised.exception.code, codes.ROW_MUTATION_UNSUPPORTED)
            self.assertFalse(
                any(sql.startswith("INSERT INTO") for sql in state["queries"])
            )
            if scenario == "enabled partial revokes":
                self.assertNotIn("SELECT CURRENT_USER()", state["queries"])
            else:
                self.assertTrue(
                    any(
                        "information_schema.USER_PRIVILEGES" in sql
                        for sql in state["queries"]
                    )
                )


if __name__ == "__main__":
    testcase.main()
