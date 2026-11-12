# The MySQL connection of a DSN and the Adapter that introspect_dbspec takes, shared by the dbspec runners and tests.
# The introspection runner is invoked by path and imports this module by file name; the apply runner and test modules
# are imported as packages from the repository root and use `.runner_connect`.
from urllib.parse import unquote, urlsplit

import pymysql


def mysql_connect(dsn: str, database: str | None = None):
    """A MySQL connection to the server that dsn names, in autocommit, with database selected when it is given."""
    url = urlsplit(dsn)
    return pymysql.connect(
        host=url.hostname,
        port=url.port,
        user=unquote(url.username or ""),
        password=unquote(url.password or ""),
        database=database,
        autocommit=True,
    )


class Adapter:
    """Connection used by introspect_dbspec: execute(sql, values) returns {'rows': [...]}."""

    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, values=()):
        cursor = self.connection.cursor()
        try:
            if values:
                cursor.execute(sql, values)
            else:
                cursor.execute(sql)
            rows = cursor.fetchall() if cursor.description else []
        finally:
            cursor.close()
        return {"rows": [list(row) for row in rows]}
