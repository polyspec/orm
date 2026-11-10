# The empty database, schema or file of a dbspec case and the connection rules, which dbspec_apply.py runs on. It checks that what remains after the drop is nothing.
import contextlib
import os
import sqlite3

import psycopg

from .runner_connect import Adapter, mysql_connect

CONNECTION_RULES = {
    "mysql": ["SET time_zone = '+00:00'"],
    "postgres": ["SET TimeZone = 'UTC'"],
    "sqlite": ["PRAGMA foreign_keys = ON"],
}


@contextlib.contextmanager
def case_database(dialect, name, dsn, sqlite_dir):
    """Creates the case's empty database, schema or file and gives its connection. Fails if anything remains after the drop."""
    if dialect == "sqlite":
        path = os.path.join(sqlite_dir, name + ".sqlite")
        connection = sqlite3.connect(path, isolation_level=None)
        try:
            yield connection
        finally:
            connection.close()
            if os.path.exists(path):
                os.remove(path)
        return
    if dialect == "mysql":
        admin = mysql_connect(dsn, None)
        Adapter(admin).execute(f"CREATE DATABASE `{name}`")
        try:
            connection = mysql_connect(dsn, name)
            try:
                yield connection
            finally:
                connection.close()
        finally:
            # One session with foreign_key_checks = 0 (DIA-212), closed after the drop, so no later statement runs
            # without the checks.
            drop = mysql_connect(dsn, None)
            try:
                Adapter(drop).execute("SET SESSION foreign_key_checks = 0")
                Adapter(drop).execute(f"DROP DATABASE `{name}`")
            finally:
                drop.close()
            left = Adapter(admin).execute(
                "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s",
                (name,),
            )
            admin.close()
            assert left["rows"][0][0] == 0, f"database {name} remains after cleanup"
        return
    admin = psycopg.connect(dsn, autocommit=True)
    Adapter(admin).execute(f'CREATE SCHEMA "{name}"')
    try:
        connection = psycopg.connect(dsn, autocommit=True)
        try:
            Adapter(connection).execute("SET client_min_messages = warning")
            Adapter(connection).execute(f'SET search_path TO "{name}"')
            yield connection
        finally:
            connection.close()
    finally:
        # A case that needs a second schema creates it as <schema>_b.
        Adapter(admin).execute(f'DROP SCHEMA IF EXISTS "{name}_b" CASCADE')
        Adapter(admin).execute(f'DROP SCHEMA "{name}" CASCADE')
        left = Adapter(admin).execute(
            "SELECT COUNT(*) FROM pg_namespace WHERE nspname IN (%s, %s)",
            (name, f"{name}_b"),
        )
        admin.close()
        assert left["rows"][0][0] == 0, f"schema {name} remains after cleanup"
