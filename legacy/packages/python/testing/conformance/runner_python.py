# Conformance runner (Python). Runs the bodies that no recipe step reaches, the generated-method and the fixed-clock
# bodies (tests/conformance/README.md), against a database and prints
# {"<vector>": {"statements": [{"sql", "binds", "kind", "tables", "transaction", "error"}],
# "result": …}} with the same chains, result shapes, and masking as runner_go. Each
# statement is its statement event: transaction is renumbered from 1 in order of appearance
# within the vector, null outside a transaction, and error is the code of the statement's
# error or null. Result maps are written with sorted keys and the top level is sorted by
# vector name, as the Go encoder writes them.
#
# Usage: python3 legacy/packages/python/testing/conformance/runner_python.py --models DIR --dsn URI [--vector NAME]...
# DIR holds the models.py that orm-gen writes from contracts/fixtures/bench/bench.dbs (conformance-python-models).
# Each --vector selects one vector by name; without one every vector runs.
import datetime
import json
import math
import os
import sys
import types
from decimal import Decimal


USAGE = "usage: runner_python.py --models DIR --dsn URI [--vector NAME]..."


def parse_args(args):
    dsn = None
    models = None
    vectors = []
    i = 0
    while i < len(args):
        flag = args[i]
        value = args[i + 1] if i + 1 < len(args) else ""
        if value == "":
            print(f"{flag} requires a nonempty value; {USAGE}", file=sys.stderr)
            sys.exit(2)
        if flag == "--dsn" and dsn is None:
            dsn = value
        elif flag == "--models" and models is None:
            models = value
        elif flag == "--vector":
            if value in vectors:
                print(f"vector {value} is selected twice", file=sys.stderr)
                sys.exit(2)
            vectors.append(value)
        else:
            print(f"unexpected argument {flag}; {USAGE}", file=sys.stderr)
            sys.exit(2)
        i += 2
    if dsn is None:
        print(
            f"--dsn is required; {USAGE}; give the DSN of the bench database with --dsn",
            file=sys.stderr,
        )
        sys.exit(2)
    if models is None:
        print(
            f"--models is required; {USAGE}; run make conformance-python-models, which writes the models",
            file=sys.stderr,
        )
        sys.exit(2)
    return dsn, models, vectors


# Set by main() from the arguments; importing this module parses nothing.
DSN, MODELS_DIR, SELECTED = None, None, []
bench = Author = Service = ServiceMember = HexCell = ClockCell = UpsertCell = None

log = []
transactions = {}
mask_seqs = set()

BIG = 2**53 - 1


def pad(n, width=2):
    return str(n).rjust(width, "0")


def time_text(d):
    return (
        f"{d.year}-{pad(d.month)}-{pad(d.day)} {pad(d.hour)}:{pad(d.minute)}:{pad(d.second)}."
        f"{pad(d.microsecond // 1000, 3)}000"
    )


def norm(v):
    """Renders a bound value the way every runner does."""
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        if v > BIG or v < -BIG:
            raise ValueError("integer query bind exceeds the exact JSON range")
        return "$SEQ" if v in mask_seqs else v
    if isinstance(v, datetime.datetime):
        return norm(time_text(v))
    if isinstance(v, (bytes, bytearray)):
        if bytes(v[:8]) == b"ORM-AES2" and bytes(v[8:9]) == b"\0":
            if len(v) < 9 + 12 + 16:
                raise ValueError("invalid AES ciphertext bind")
            return "$AES"
        return norm(bytes(v).decode("utf-8"))
    if isinstance(v, str):
        if v.startswith("ORM-AES2"):
            raise ValueError("invalid AES ciphertext bind")
        if v.lower().startswith("4f524d2d41455332"):
            if len(v) % 2 != 0 or any(c not in "0123456789abcdefABCDEF" for c in v):
                raise ValueError("invalid hex AES ciphertext bind")
            decoded = bytes.fromhex(v)
            if decoded[:9] != b"ORM-AES2\0" or len(decoded) < 9 + 12 + 16:
                raise ValueError("invalid hex AES ciphertext bind")
            return "$AES"
    return v


def code_of(error):
    if error is None:
        return None
    value = getattr(error, "code", None)
    if isinstance(value, str) and value != "":
        return value
    return str(error)


def caught(fn):
    try:
        fn()
        return None
    except Exception as error:  # noqa: BLE001 - every library error is the result of the vector
        return code_of(error)


def mask(seqs):
    for s in seqs:
        mask_seqs.add(int(s))
    for s in log:
        s["binds"] = [norm(b) for b in s["binds"]]


def pick(m, *names):
    if m is None:
        return None
    row = m.to_array()
    out = {}
    for n in names:
        if n not in row:
            raise ValueError(f"missing selected field: {n}")
        out[n] = row[n]
    return out


def picks(rows, *names):
    return [pick(m, *names) for m in rows.values()]


def sorted_maps(v):
    """Writes every map of a result with sorted keys, as the Go encoder does."""
    if isinstance(v, dict):
        return {k: sorted_maps(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        return [sorted_maps(x) for x in v]
    return v


def on_event(e):
    transaction = None
    if e.transaction is not None:
        if e.transaction not in transactions:
            transactions[e.transaction] = len(transactions) + 1
        transaction = transactions[e.transaction]
    log.append(
        {
            "sql": e.sql,
            "binds": [norm(b) for b in e.binds],
            "kind": e.kind,
            "tables": list(e.tables),
            "transaction": transaction,
            "error": None if e.error is None else code_of(e.error),
        }
    )


def go_float(f):
    """Formats a float64 the way encoding/json does: shortest digits, no exponent in [1e-6, 1e21)."""
    if f == 0:
        return "0"
    text = repr(f)
    a = abs(f)
    if 1e-6 <= a < 1e21:
        if "e" not in text:
            return text[:-2] if text.endswith(".0") else text
        mantissa, exp = text.split("e")
        digits = mantissa.replace(".", "").replace("-", "")
        point = mantissa.replace("-", "").find(".")
        point = len(mantissa.replace("-", "")) if point < 0 else point
        shift = int(exp) + point
        sign = "-" if f < 0 else ""
        if shift <= 0:
            return sign + "0." + "0" * (-shift) + digits
        if shift >= len(digits):
            return sign + digits + "0" * (shift - len(digits))
        return sign + digits[:shift] + "." + digits[shift:]
    # exponent form with at least two exponent digits, as encoding/json writes it
    mantissa, _, exp = repr(f).partition("e")
    sign = "-" if exp.startswith("-") else "+"
    digits = exp.lstrip("+-").rjust(2, "0")
    return f"{mantissa}e{sign}{digits}"


def encode(value, indent=0):
    """Encodes the output the way the Go encoder does: one space per level, Go escapes."""
    pad_text = " " * indent
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{pad_text} {json.dumps(k, ensure_ascii=False)}: {encode(v, indent + 1)}"
            for k, v in value.items()
        ]
        return "{\n" + ",\n".join(items) + "\n" + pad_text + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        items = [f"{pad_text} {encode(v, indent + 1)}" for v in value]
        return "[\n" + ",\n".join(items) + "\n" + pad_text + "]"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite conformance result")
        return go_float(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("non-finite conformance result")
        return go_float(float(value))
    return json.dumps(value, ensure_ascii=False)


def go_escape(text):
    return (
        text.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def load_models():
    global bench, Author, Service, ServiceMember, HexCell, ClockCell, UpsertCell
    # The models generated from contracts/fixtures/bench/bench.dbs are compiled from their source and
    # registered as models; the client itself is the one installed into the interpreter.
    source = os.path.join(MODELS_DIR, "models.py")
    generated = types.ModuleType("models")
    generated.__file__ = source
    sys.modules["models"] = generated
    with open(source, encoding="utf-8") as file:
        exec(compile(file.read(), source, "exec"), generated.__dict__)

    bench = generated
    Author, Service, ServiceMember = bench.Author, bench.Service, bench.ServiceMember
    HexCell, ClockCell, UpsertCell = bench.HexCell, bench.ClockCell, bench.UpsertCell


def main():
    global DSN, MODELS_DIR, SELECTED
    DSN, MODELS_DIR, SELECTED = parse_args(sys.argv[1:])
    load_models()
    from polyspec.orm.values import orm

    db = bench.connect(
        DSN,
        aesKey="bench-salt",
        blindIndexKey="bench-blind-index",
        auditSource=lambda: {},
    )
    db.transaction(lambda: None, {"retry": 0})
    db.subscribe(on_event)
    global log, transactions, mask_seqs
    out = {}
    declared = set()
    write_vectors = {
        "now_defaults",
        "delete_recursive",
        "affected_counts",
        "clock_truncate_write",
        "clock_compare_six_digits",
    }

    def run(name, fn):
        declared.add(name)
        if SELECTED and name not in SELECTED:
            return
        global log, transactions, mask_seqs
        log, transactions, mask_seqs = [], {}, set()
        if name in write_vectors:
            result = db.transaction(fn, {"retry": 0})
        else:
            result = fn()
        out[name] = {
            "statements": [dict(s) for s in log],
            "result": sorted_maps(result),
        }

    def author():
        return Author().connect(db)

    cols = ["seq", "name", "is_close", "is_display", "read_count"]

    def terminal_by():
        one = author().get_by_seq(42)
        missing = caught(lambda: author().get_by_seq(-1))
        rows = (
            author()
            .order_by_seq_asc()
            .limit(0, 2)
            .gets_by_service_seq_and_is_close(7, False)
        )
        count = author().get_count_by_service_seq(7)
        return {
            "one": pick(one, *cols),
            "missing": missing,
            "rows": picks(rows, *cols),
            "count": count,
        }

    run("terminal_by", terminal_by)

    def terminal_reuse():
        q = author().service_seq(7).order_by_seq_asc().limit(0, 2)
        first = q.get_count_by_is_close(True)
        rows = q.gets()
        last = q.get_count()
        return [first, len(rows.values()), last]

    run("terminal_reuse", terminal_reuse)

    def relation_empty():
        rows = (
            author()
            .relations(ServiceMember().match_user_seq_with_user_seq())
            .gets_by_seq(-1)
        )
        return len(rows.values())

    run("relation_empty", relation_empty)

    def empty_reads():
        # The reads run in the order of the other runners, so the statements agree.
        get = author().seq(-1).get()
        get_by = author().get_by_seq(-1)
        gets = len(author().seq(-1).gets().values())
        groups = author().seq(-1).group_by_is_close().gets_count().to_array()
        page = author().seq(-1).remove_all_columns().order_by_seq_asc().gets_page(1, 10)
        return {
            "get": get,
            "get_by": get_by,
            "gets": gets,
            "gets_count": groups,
            "page": {
                "items": len(page["items"]),
                "total_count": page["totalCount"],
                "total_pages": page["totalPages"],
                "page": page["page"],
                "per_page": page["perPage"],
            },
            "count": author().seq(-1).get_count(),
            "sum": author().seq(-1).sum_read_count().get_sum(),
            "avg": author().seq(-1).avg_like_count().get_avg(),
            "null_rows": author().price(None).get_count(),
            "null_sum": author().price(None).sum_price().get_sum(),
            "null_avg": author().price(None).avg_price().get_avg(),
        }

    run("empty_reads", empty_reads)

    def aes_values():
        row = (
            author()
            .remove_all_columns()
            .add_column_aes_hex_email()
            .add_column_aes_hex_phone()
            .get_by_seq(42)
        )
        found = author().aes_hex_email("user42@example.com").get_count()
        return {"row": row.to_array(), "found": found}

    run("aes_values", aes_values)

    def now_defaults():
        import time

        before = time.time()
        start = "2026-06-01 00:00:00.000000"
        created = (
            author()
            .set_name("clock")
            .set_user_seq(1)
            .set_service_seq(999)
            .set_service_region_seq(1)
            .set_service_member_seq(1)
            .set_start_dt(start)
            .set_end_dt(start)
            .create()
        )
        seq = created.get_seq()
        mask([seq])
        loaded = author().get_by_seq(seq)
        created_ts = loaded.get_created_ts()
        updated_ts = loaded.get_updated_ts()
        parsed = datetime.datetime.strptime(created_ts, "%Y-%m-%d %H:%M:%S.%f").replace(
            tzinfo=datetime.timezone.utc
        )
        near = abs(parsed.timestamp() - before) < 60
        loaded.delete()
        return {
            "created_near_clock": near,
            "created_equals_updated": created_ts == updated_ts,
        }

    run("now_defaults", now_defaults)

    def delete_recursive():
        service = Service().connect(db).set_name("recursive").create()
        seq = service.get_seq()
        seqs = [seq]
        for i in range(2):
            member = (
                ServiceMember()
                .connect(db)
                .set_service_seq(seq)
                .set_user_seq(i + 1)
                .create()
            )
            seqs.append(member.get_seq())
        loaded = (
            Service()
            .connect(db)
            .relations(ServiceMember().match_seq_with_service_seq())
            .get_by_seq(seq)
        )
        members = len(loaded.get_service_member_models())
        mask(seqs)
        loaded.delete(True)
        left = ServiceMember().connect(db).get_count_by_service_seq(seq)
        service2 = caught(lambda: Service().connect(db).get_by_seq(seq))
        return {"members": members, "members_left": left, "service_left": service2}

    run("delete_recursive", delete_recursive)

    def hex_malformed():
        # the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
        return {
            "white_space": caught(lambda: HexCell().connect(db).get_by_seq(1)),
            "odd_length": caught(lambda: HexCell().connect(db).get_by_seq(2)),
        }

    run("hex_malformed", hex_malformed)

    # A write counts each written row once (docs/spec/protocol.md "Write"): an upsert is 1 whether it inserts or updates,
    # and an update counts the row it matched even when the row already holds the value. The count is read through
    # the test entry point (docs/spec/protocol.md "Test write result").
    from polyspec.orm.testing import last_affected

    def affected_counts():
        out = {}

        def upsert():
            return (
                UpsertCell()
                .connect(db)
                .set_code("c1")
                .set_label("x")
                .duplication(UpsertCell().set_label("y"))
                .create()
            )

        created = upsert()
        mask([created.get_seq()])
        out["upsert_inserted"] = last_affected(db)
        upsert()
        out["upsert_updated"] = last_affected(db)
        row = UpsertCell().connect(db).get_by_seq(created.get_seq())
        row.set_label("y").update()
        out["update_unchanged"] = last_affected(db)
        row.set_label("z").update()
        out["update_changed"] = last_affected(db)
        row.delete()
        return out

    run("affected_counts", affected_counts)

    # One statement has one clock (docs/spec/protocol.md "Clock"): the columns that an insert leaves to `default now`
    # hold that clock truncated to their digits, and a datetime(p) column compares with a clock at six digits. The
    # executor clock is fixed at .999999 through the test entry point, so a rounding clock shows as the next second;
    # MySQL writes its own clock, CURRENT_TIMESTAMP(p), which truncates. These vectors come last because the fixed
    # clock stays on the connection.
    from polyspec.orm.testing import fix_clock

    def clock_truncate_write():
        fix_clock(db, "2026-06-01 12:34:56.999999")
        created = ClockCell().connect(db).set_label("write").create()
        mask([created.get_seq()])
        row = ClockCell().connect(db).get_by_seq(created.get_seq())
        row.delete()
        at6 = row.get_at6()
        return {
            "at6_fixed": at6 == "2026-06-01 12:34:56.999999",
            "p0_truncated": row.get_at0() == at6[:19],
            "p3_truncated": row.get_at3() == at6[:23],
        }

    run("clock_truncate_write", clock_truncate_write)

    def clock_compare_six_digits():
        fix_clock(db, "2026-06-01 12:34:56.999999")
        created = (
            ClockCell()
            .connect(db)
            .set_label("compare")
            .set_at0("2026-06-01 12:34:56.000000")
            .set_at3("2026-06-01 12:34:56.999000")
            .set_at6("2026-06-01 12:34:56.000000")
            .create()
        )
        mask([created.get_seq()])
        ge_now = (
            ClockCell().connect(db).label("compare").and_ge_at0(orm.now()).get_count()
        )
        lt_now = (
            ClockCell().connect(db).label("compare").and_lt_at3(orm.now()).get_count()
        )
        created.delete()
        return {"at0_ge_now": ge_now, "at3_lt_now": lt_now}

    run("clock_compare_six_digits", clock_compare_six_digits)

    db.close()
    unknown = [name for name in SELECTED if name not in declared]
    if unknown:
        print(f"unknown vector {', '.join(unknown)}", file=sys.stderr)
        sys.exit(2)
    text = encode(dict(sorted(out.items())))
    sys.stdout.write(go_escape(text) + "\n")


if __name__ == "__main__":
    main()
