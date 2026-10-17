# Thin-slice demo (Python): one statement in every client language, one JSON.
# stdout: the result as JSON. stderr: p50 of the generated client and of the
# same SQL through PyMySQL directly.
#
#   python3 packages/python/examples/thin_slice/main.py
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import unquote, urlparse, parse_qs

ITERATIONS = 500
AES_KEY = "bench-salt"


def dsn() -> str:
    """The seeded bench database that ORM_BENCH_MYSQL_DSN names; without it the program ends before any connection."""
    value = os.environ.get("ORM_BENCH_MYSQL_DSN", "")
    if value == "":
        print(
            "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run",
            file=sys.stderr,
        )
        sys.exit(1)
    return value


def p50(f) -> int:
    """Runs f ITERATIONS times and returns the median elapsed time in microseconds."""
    samples = []
    for _ in range(ITERATIONS):
        start = time.perf_counter_ns()
        f()
        samples.append((time.perf_counter_ns() - start) // 1000)
    samples.sort()
    return samples[len(samples) // 2]


def main() -> None:
    target = dsn()
    # The client and the native driver load after the check, so a missing DSN ends the program without them.
    from polyspec.orm.models.models import Author, connect
    import pymysql

    url = urlparse(target)
    last = {"sql": "", "binds": []}

    def on_statement(event) -> None:
        last["sql"] = event.sql
        last["binds"] = [AES_KEY if value == "$SECRET" else value for value in event.binds]

    db = connect(target, aesKey=AES_KEY, blindIndexKey="bench-blind-index")
    try:
        db.subscribe(on_statement)
        now = datetime(2026, 9, 11, 0, 0, 0, tzinfo=timezone.utc)

        def query():
            return (
                Author()
                .connect(db)
                .service_seq(7)
                .and_is_close(False)
                .and_(lambda q: q.is_display(True).or_(lambda q: q.is_display(False).and_lt_display_start_dt(now)))
                .and_seq([6, 106, 206, 306, 406])
                .order_by_seq_desc()
                .limit(0, 3)
                .gets()
            )

        rows = query()
        out = [
            {
                "is_display": r.get_is_display(),
                "like_count": r.get_like_count(),
                "name": r.get_name(),
                "seq": r.get_seq(),
            }
            for r in rows
        ]
        print(json.dumps(out, separators=(",", ":"), sort_keys=True, ensure_ascii=False))

        client = p50(lambda: list(query()))
        params = parse_qs(url.query)
        connection_args = {
            "user": unquote(url.username or ""),
            "password": unquote(url.password or ""),
            "database": url.path.lstrip("/"),
        }
        if "socket" in params:
            connection_args["unix_socket"] = params["socket"][0]
        else:
            connection_args["host"] = url.hostname
            connection_args["port"] = url.port or 3306
        raw = pymysql.connect(**connection_args)
        try:
            with raw.cursor() as cursor:
                native = p50(lambda: cursor.execute(last["sql"], last["binds"]) and cursor.fetchall())
        finally:
            raw.close()
        print(f"python: client p50 {client}µs, native p50 {native}µs ({ITERATIONS} iterations)", file=sys.stderr)
    finally:
        db.close()


if __name__ == "__main__":
    main()
