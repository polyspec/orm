"""Measure Python hot-path reads against the same SQL through the feature's native driver.

No fixed reference is recorded for Python yet, so the measurement is diagnostic only.
"""

import os
import platform
import statistics
import sys
import time
from urllib.parse import parse_qs, unquote, urlsplit

from polyspec.orm.models import models


WARMUP = 100
PAIRS = 1000


def feature_item(item):
    dsn = os.environ.get("ORM_FEATURE_DSN")
    database = os.environ.get("ORM_FEATURE_DATABASE")
    if not dsn or not database:
        raise RuntimeError(
            "ORM_FEATURE_DSN and ORM_FEATURE_DATABASE are required; run this case through make feature-check"
        )
    if item is None or item != (database, dsn):
        raise RuntimeError(
            "the coverage item differs from ORM_FEATURE_DSN or ORM_FEATURE_DATABASE"
        )
    expected_scheme = {
        "mysql": "mysql",
        "postgres": "postgres",
        "sqlite": "sqlite",
    }.get(database)
    url = urlsplit(dsn)
    if expected_scheme is None or url.scheme != expected_scheme:
        raise RuntimeError(
            f"ORM_FEATURE_DSN scheme {url.scheme!r} does not match {database}"
        )
    return database, dsn, url


def native_connection(database, dsn, url):
    if database == "sqlite":
        import sqlite3

        return sqlite3.connect(unquote(url.path), isolation_level=None)
    if database == "postgres":
        import psycopg

        return psycopg.connect(dsn, autocommit=True)
    import pymysql

    query = parse_qs(url.query)
    return pymysql.connect(
        host=url.hostname or "localhost",
        port=url.port or 3306,
        unix_socket=query.get("socket", [None])[0],
        user=unquote(url.username or ""),
        password=unquote(url.password or ""),
        database=unquote(url.path.lstrip("/")),
        autocommit=True,
    )


def native_for(database, connection, query):
    statement = query.get_query()
    sql, binds = statement["sql"], statement["binds"]

    def run():
        with connection.cursor() as cursor:
            cursor.execute(sql, binds)
            rows = cursor.fetchall()
            return [(int(row[0]), row[1]) for row in rows]

    return run


def client_rows(query):
    return [(row.get_seq(), row.get_name()) for row in query.gets().values()]


def measure(database, name, client, native, expected_rows):
    client_result = client()
    native_result = native()
    if client_result != native_result:
        raise AssertionError(f"{name}: client rows differ from native rows")
    if len(client_result) != expected_rows:
        raise AssertionError(
            f"{name}: got {len(client_result)} rows, want {expected_rows}"
        )

    for _ in range(WARMUP):
        native()
        client()
    native_ns = []
    client_ns = []
    ratios = []
    cpu_start = time.process_time_ns()
    wall_start = time.perf_counter_ns()
    for index in range(PAIRS):
        if index % 2 == 0:
            started = time.perf_counter_ns()
            native()
            n = time.perf_counter_ns() - started
            started = time.perf_counter_ns()
            client()
            c = time.perf_counter_ns() - started
        else:
            started = time.perf_counter_ns()
            client()
            c = time.perf_counter_ns() - started
            started = time.perf_counter_ns()
            native()
            n = time.perf_counter_ns() - started
        native_ns.append(n)
        client_ns.append(c)
        ratios.append(c / n)
    wall_ms = (time.perf_counter_ns() - wall_start) / 1_000_000
    cpu_ms = (time.process_time_ns() - cpu_start) / 1_000_000
    native_p50 = statistics.median(native_ns)
    client_p50 = statistics.median(client_ns)
    ratio = statistics.median(ratios)
    print(
        f"PERF hot_path_gate python {database} {name}: native p50={native_p50 / 1000:.1f}µs "
        f"client p50={client_p50 / 1000:.1f}µs ratio={ratio:.2f} "
        f"samples={PAIRS} cpu={cpu_ms:.1f}ms wall={wall_ms:.1f}ms "
        f"machine={platform.platform()} reference=not-recorded",
        file=sys.stderr,
        flush=True,
    )


def hot_path_gate(item):
    database, dsn, url = feature_item(item)
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    if db.driver != database:
        db.close()
        raise RuntimeError(f"client opened {db.driver}, want {database}")
    native = native_connection(database, dsn, url)
    try:

        def pk():
            return (
                models.Author()
                .connect(db)
                .remove_all_columns()
                .remove_column_user_seq()
                .remove_column_service_seq()
                .remove_column_service_region_seq()
                .remove_column_service_member_seq()
                .seq(42)
                .add_column_seq()
                .add_column_name()
                .limit(0, 1)
            )

        def list100():
            return (
                models.Author()
                .connect(db)
                .remove_all_columns()
                .remove_column_user_seq()
                .remove_column_service_seq()
                .remove_column_service_region_seq()
                .remove_column_service_member_seq()
                .service_seq(7)
                .and_is_close(False)
                .order_by_seq_desc()
                .limit(0, 100)
                .add_column_seq()
                .add_column_name()
            )

        measure(
            database,
            "pk",
            lambda: client_rows(pk()),
            native_for(database, native, pk()),
            1,
        )
        measure(
            database,
            "list100",
            lambda: client_rows(list100()),
            native_for(database, native, list100()),
            100,
        )
    finally:
        native.close()
        db.close()


def feature_hot_path_gate():
    database = os.environ.get("ORM_FEATURE_DATABASE")
    dsn = os.environ.get("ORM_FEATURE_DSN")
    return hot_path_gate((database, dsn))
