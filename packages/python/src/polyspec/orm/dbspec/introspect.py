# Reads the connection's database as a dbspec document (docs/spec/dialects.md "Introspection").
# The dialect reader fills the neutral catalog with a fixed number of catalog queries, and the catalog
# builds and parses the document.
from __future__ import annotations

from typing import Protocol

from polyspec.orm.dbspec.introspect_catalog import Catalog, CatalogRow
from polyspec.orm.dbspec.introspect_mysql import read_mysql
from polyspec.orm.dbspec.introspect_postgres import read_postgres
from polyspec.orm.dbspec.introspect_sqlite import read_sqlite

__all__ = ["Connection", "introspect_catalog", "introspect_dbspec"]


class Connection(Protocol):
    """A connection of this client: execute(sql, values) returns the list of rows."""

    def execute(self, sql: str, values: list) -> list: ...


_READERS = {"mysql": read_mysql, "postgres": read_postgres, "sqlite": read_sqlite}

# The servers of each dialect (DIA-200): MySQL and MariaDB are the servers of the mysql dialect, PostgreSQL and SQLite
# each the server of its own.
_SERVERS = {
    "mysql": ("mysql", "mariadb"),
    "postgres": ("postgres",),
    "sqlite": ("sqlite",),
}


def _check_server(dialect: str, server: str) -> None:
    """Refuses a dialect other than mysql, postgres and sqlite, naming the dialect, and a server that is not a server of
    the dialect, naming the server (DBS-174)."""
    if dialect not in _READERS:
        raise TypeError(f"unknown dbspec dialect {dialect}")
    if server not in _SERVERS[dialect]:
        raise TypeError(
            f"dbspec: server {server} is not a server of the dialect {dialect}"
        )


def introspect_dbspec(
    connection: Connection, dialect: str, server: str, name: str
) -> dict:
    """Reads the connection's current database (MySQL), current schema (PostgreSQL), or main
    database (SQLite) as one dbspec document named `name`. The number of catalog queries
    does not depend on the number of tables. The connection is one that returns a list of rows through execute(sql, values)
    for this client. server is the server that the connection reached, which the caller read when it connected
    (DIA-203): mysql or mariadb for mysql, postgres for postgres and sqlite for sqlite; the introspection reads no
    version."""
    _check_server(dialect, server)
    if not isinstance(name, str):
        raise TypeError("dbspec document name must be a string")

    def query(sql: str) -> list:
        return [CatalogRow(sql, row) for row in connection.execute(sql, [])["rows"]]

    return introspect_catalog(query, dialect, server, name)


def introspect_catalog(query, dialect: str, server: str, name: str) -> dict:
    """Sends the catalog queries as queries and reads the same document as introspect_dbspec."""
    _check_server(dialect, server)
    if dialect == "mysql":
        catalog: Catalog = read_mysql(query, server)
    else:
        catalog = _READERS[dialect](query)
    document, unsupported = catalog.document(name)
    return {"document": document, "unsupported": [dict(u) for u in unsupported]}
