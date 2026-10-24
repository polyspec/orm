"""Measure Python hot-path reads against the same SQL through PyMySQL.

No fixed reference is recorded for Python yet, so the measurement is diagnostic only.
"""

import os
import platform
import statistics
import sys
import time
from urllib.parse import parse_qs, unquote, urlsplit

import pymysql
import pymysql.cursors
from polyspec.orm.models import models

from .coverage_case import CoverageCase, coverage_main

WARMUP = 100
PAIRS = 1000


def required_dsn():
    dsn = os.environ.get("ORM_BENCH_MYSQL_DSN")
    if not dsn:
        raise RuntimeError(
            "ORM_BENCH_MYSQL_DSN is required; run this case with the seeded MySQL bench database"
        )
    url = urlsplit(dsn)
    if url.scheme != "mysql":
        raise RuntimeError(f"ORM_BENCH_MYSQL_DSN must use mysql:, got {url.scheme!r}")
    return url


def native_connection(url):
    query = parse_qs(url.query)
    return pymysql.connect(
        host=url.hostname or "localhost",
        port=url.port or 3306,
        unix_socket=query.get("socket", [None])[0],
        user=unquote(url.username or ""),
        password=unquote(url.password or ""),
        database=unquote(url.path.lstrip("/")),
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )


def native_for(connection, query):
    statement = query.get_query()
    sql, binds = statement["sql"], statement["binds"]

    def run():
        with connection.cursor() as cursor:
            cursor.execute(sql, binds)
            return [
                (int(values[0]), values[1])
                for values in (tuple(row.values()) for row in cursor.fetchall())
            ]

    return run


def client_rows(query):
    return [(row.get_seq(), row.get_name()) for row in query.gets().values()]


def measure(name, client, native, expected_rows):
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
        f"PERF hot_path_gate python {name}: native p50={native_p50 / 1000:.1f}µs "
        f"client p50={client_p50 / 1000:.1f}µs ratio={ratio:.2f} "
        f"samples={PAIRS} cpu={cpu_ms:.1f}ms wall={wall_ms:.1f}ms "
        f"machine={platform.platform()} reference=not-recorded",
        file=sys.stderr,
        flush=True,
    )


def hot_path_gate():
    url = required_dsn()
    dsn = url.geturl()
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    native = native_connection(url)
    try:

        def pk():
            return (
                models.Author()
                .connect(db)
                .seq(42)
                .add_column_seq()
                .add_column_name()
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
                .add_column_seq()
                .add_column_name()
            )

        measure("pk", lambda: client_rows(pk()), native_for(native, pk()), 1)
        measure(
            "list100",
            lambda: client_rows(list100()),
            native_for(native, list100()),
            100,
        )
    finally:
        native.close()
        db.close()


class CoverageTest(CoverageCase):
    def test_hot_path_gate(self):
        self.each_item("hot_path_gate", lambda _item: hot_path_gate())


if __name__ == "__main__":
    coverage_main(CoverageTest)
