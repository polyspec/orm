"""Measure full-row Python hot-path reads against the same SQL through the native driver.

No fixed reference is recorded for Python yet, so the measurement is diagnostic only.
"""

import os
import platform
import statistics
import sys
import time
from datetime import datetime
from decimal import Decimal
from urllib.parse import parse_qs, unquote, urlsplit

from polyspec.orm.codec import host_decode
from polyspec.orm.models import models


WARMUP = 100
PAIRS = 1000
NATIVE_AUTHOR_COLUMNS = (
    "a__seq",
    "a__name",
    "a__created_ts",
    "a__updated_ts",
    "a__is_close",
    "a__is_display",
    "a__display_start_dt",
    "a__display_end_dt",
    "a__is_allday",
    "a__target_club_reader_count",
    "a__success_count",
    "a__reader_count",
    "a__read_count",
    "a__photo_url",
    "a__user_seq",
    "a__service_seq",
    "a__service_region_seq",
    "a__service_member_seq",
    "a__start_dt",
    "a__end_dt",
    "a__uuid",
    "a__is_single_work",
    "a__like_count",
    "a__aes_hex_email",
    "a__aes_hex_phone",
    "a__price",
    "a__aes_key_version",
)


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
            columns = tuple(column[0] for column in cursor.description or ())
            if columns != NATIVE_AUTHOR_COLUMNS:
                raise AssertionError(
                    f"native author projection is {columns!r}, want {NATIVE_AUTHOR_COLUMNS!r}"
                )
            rows = cursor.fetchall()
            return [typed_native_row(row) for row in rows]

    return run


def typed_native_values(row):
    if len(row) != 27:
        raise AssertionError(f"native author row has {len(row)} columns, want 27")

    def native_datetime(value):
        if value is None or isinstance(value, datetime):
            return value
        return datetime.fromisoformat(str(value).replace(" ", "T"))

    def native_bool(value, name):
        if value is True or value == 1:
            return True
        if value is False or value == 0:
            return False
        raise AssertionError(f"native {name} is not a boolean cell: {value!r}")

    aes_version = int(row[26])
    if aes_version != 1:
        raise AssertionError(
            f"native AES key version {aes_version} differs from benchmark key version 1"
        )

    values = (
        int(row[0]),
        str(row[1]),
        native_datetime(row[2]),
        native_datetime(row[3]),
        native_bool(row[4], "is_close"),
        native_bool(row[5], "is_display"),
        native_datetime(row[6]),
        native_datetime(row[7]),
        native_bool(row[8], "is_allday"),
        int(row[9]),
        int(row[10]),
        int(row[11]),
        int(row[12]),
        None if row[13] is None else str(row[13]),
        int(row[14]),
        int(row[15]),
        int(row[16]),
        int(row[17]),
        native_datetime(row[18]),
        native_datetime(row[19]),
        None if row[20] is None else str(row[20]),
        native_bool(row[21], "is_single_work"),
        int(row[22]),
        host_decode(row[23], ["aes", "hex"], "bench-salt"),
        host_decode(row[24], ["aes", "hex"], "bench-salt"),
        None if row[25] is None else Decimal(row[25]),
        aes_version,
    )
    return values


def typed_native_row(row):
    values = typed_native_values(row)
    return values[0], values[1]


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
                .seq(42)
                .limit(0, 1)
            )

        def list100():
            return (
                models.Author()
                .connect(db)
                .service_seq(7)
                .and_is_close(False)
                .order_by_seq_desc()
                .limit(0, 100)
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
