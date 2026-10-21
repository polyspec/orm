# Conformance runner (Python). Runs every vector against the bench database and prints
# {"<vector>": {"statements": [{"sql", "binds", "kind", "tables", "transaction", "error"}],
# "result": …}} with the same chains, result shapes, and masking as runner_go. Each
# statement is its statement event: transaction is renumbered from 1 in order of appearance
# within the vector, null outside a transaction, and error is the code of the statement's
# error or null. Result maps are written with sorted keys and the top level is sorted by
# vector name, as the Go encoder writes them.
#
# Usage: python3 packages/python/testing/conformance/runner_python.py --models DIR --dsn URI [--vector NAME]...
# DIR holds the models.py that orm-gen writes from contracts/fixtures/bench/bench.dbs (conformance-python-models).
# Each --vector selects one vector by name; without one every vector runs.
import datetime
import json
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
bench = Author = CompositeAccount = Service = ServiceMember = ServiceRegion = None
User = SoftRecord = Task = HexCell = TimeCell = DayCell = ClockCell = UpsertCell = (
    UuidCell
) = BindCell = SoftLink = NoteReader = SharedNote = AuditRecord = AuditedNote = None

log = []
transactions = {}
mask_seqs = set()
mask_ts = set()

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
        if v in mask_ts:
            return "$TS"
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


def mask(seqs, *times):
    for s in seqs:
        mask_seqs.add(int(s))
    for t in times:
        mask_ts.add(t)
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


def derived_integer(value):
    if isinstance(value, bool):
        raise ValueError("invalid derived integer")
    if isinstance(value, int):
        if -(2**63) <= value < 2**63:
            return value
    if (
        isinstance(value, str)
        and value.lstrip("-").isdigit()
        and (value == "0" or value.lstrip("-")[0] != "0")
    ):
        integer = int(value)
        if -(2**63) <= integer < 2**63:
            return integer
    raise ValueError("invalid derived integer")


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
        return go_float(value)
    if isinstance(value, Decimal):
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
    global \
        bench, \
        Author, \
        CompositeAccount, \
        Service, \
        ServiceMember, \
        ServiceRegion, \
        User, \
        SoftRecord, \
        Task, \
        HexCell, \
        TimeCell, \
        DayCell, \
        ClockCell, \
        UpsertCell, \
        UuidCell, \
        BindCell, \
        SoftLink, \
        NoteReader, \
        SharedNote, \
        AuditRecord, \
        AuditedNote
    # The models generated from contracts/fixtures/bench/bench.dbs are compiled from their source and
    # registered as models; the client itself is the one installed into the interpreter.
    source = os.path.join(MODELS_DIR, "models.py")
    generated = types.ModuleType("models")
    generated.__file__ = source
    sys.modules["models"] = generated
    with open(source, encoding="utf-8") as file:
        exec(compile(file.read(), source, "exec"), generated.__dict__)

    bench = generated
    Author, CompositeAccount, Service, ServiceMember, ServiceRegion = (
        bench.Author,
        bench.CompositeAccount,
        bench.Service,
        bench.ServiceMember,
        bench.ServiceRegion,
    )
    User, SoftRecord, Task, HexCell = (
        bench.User,
        bench.SoftRecord,
        bench.Task,
        bench.HexCell,
    )
    TimeCell = bench.TimeCell
    DayCell = bench.DayCell
    ClockCell = bench.ClockCell
    UpsertCell = bench.UpsertCell
    UuidCell = bench.UuidCell
    BindCell = bench.BindCell
    NoteReader = bench.NoteReader
    SharedNote = bench.SharedNote
    SoftLink = bench.SoftLink
    AuditRecord = bench.AuditRecord
    AuditedNote = bench.AuditedNote


def main():
    global DSN, MODELS_DIR, SELECTED
    DSN, MODELS_DIR, SELECTED = parse_args(sys.argv[1:])
    load_models()
    from polyspec.orm.aes import AesKeyring
    from polyspec.orm.values import orm

    db = bench.connect(
        DSN,
        aesKey="bench-salt",
        blindIndexKey="bench-blind-index",
        auditSource=lambda: {},
    )
    db.subscribe(on_event)
    global log, transactions, mask_seqs, mask_ts
    out = {}
    declared = set()
    write_vectors = {
        "write_cycle",
        "now_defaults",
        "required_columns",
        "creates_and_save",
        "delete_recursive",
        "contains_ascii_fold",
        "contains_binary_code_point",
        "datetime_p0_roundtrip",
        "time_p3_roundtrip",
        "date_roundtrip",
        "date_null",
        "upsert_one_key",
        "affected_counts",
        "uuid_roundtrip",
        "clock_truncate_write",
        "clock_compare_six_digits",
    }

    def run(name, fn):
        declared.add(name)
        if SELECTED and name not in SELECTED:
            return
        global log, transactions, mask_seqs, mask_ts
        log, transactions, mask_seqs, mask_ts = [], {}, set(), set()
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

    # The vectors below follow packages/ts/testing/conformance/runner_typescript.mts, one function per vector.
    run(
        "conditions_connectors",
        lambda: picks(
            author()
            .service_seq(7)
            .and_is_close(False)
            .or_()
            .read_count(6)
            .order_by_seq_asc()
            .limit(0, 3)
            .gets(),
            *cols,
        ),
    )

    run(
        "conditions_group",
        lambda: picks(
            author()
            .service_seq(7)
            .and_(
                lambda q: q.is_display(False).or_(
                    lambda q2: q2.is_close(True).and_gt_read_count(500)
                )
            )
            .order_by_seq_desc()
            .limit(0, 3)
            .gets(),
            *cols,
        ),
    )

    run(
        "conditions_leading_group",
        lambda: picks(
            author()
            .and_(lambda q: q.is_display(False).or_is_close(True))
            .and_service_seq(7)
            .order_by_seq_desc()
            .limit(0, 3)
            .gets(),
            *cols,
        ),
    )

    run(
        "conditions_leading_prefix",
        lambda: picks(
            author()
            .and_service_seq(7)
            .and_gt_read_count(990)
            .order_by_seq_desc()
            .limit(0, 3)
            .gets(),
            *cols,
        ),
    )

    def conditions_values():
        queries = [
            author().service_seq([7, 8]).and_ne_is_close(True),
            author().service_seq(7).and_uuid(None),
            author().service_seq(7).and_ne_photo_url(None),
            author().service_seq(7).and_ne_read_count([6, 106, 206]),
            author().service_seq(7).and_between_read_count([100, 200]),
            author().service_seq(7).and_lk_name("uthor-10"),
            author().service_seq(7).and_lb_name("Author-10"),
            author().service_seq(7).and_ge_read_count(990),
            author().service_seq(7).and_le_read_count(10),
            author().service_seq(7).and_lt_seq(1000),
        ]
        return [q.get_count() for q in queries]

    run("conditions_values", conditions_values)

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

    def expression_forms():
        count = (
            author()
            .service_seq(7)
            .and_not(lambda q: q.is_close(True).or_gt_read_count(500))
            .get_count()
        )
        rows = (
            author()
            .not_(lambda q: q.is_display(False))
            .and_service_seq(7)
            .order_by_seq_desc()
            .limit(0, 3)
            .gets()
        )
        or_count = (
            author().service_seq(7).or_not(lambda q: q.lt_read_count(990)).get_count()
        )
        return {
            "count": count,
            "rows": picks(rows, "seq", "is_display"),
            "or_count": or_count,
        }

    run("expression_forms", expression_forms)

    def columns():
        none = Service().connect(db).remove_all_columns().get_by_seq(7)
        added = (
            author()
            .remove_all_columns()
            .add_column_name()
            .add_column_start_dt_alias_start_year(orm.year())
            .get_by_seq(42)
        )
        removed = Service().connect(db).remove_column_name().get_by_seq(7)
        return [
            none.to_array(),
            pick(added, "seq", "name", "start_year"),
            removed.to_array(),
        ]

    run("columns", columns)

    def joins():
        service = Service().on(lambda s: s.gt_seq(0)).name("service-7")
        rows = (
            author()
            .remove_all_columns()
            .add_column_name()
            .join_service_seq_with_seq(service)
            .is_close(False)
            .and_(lambda q: q.is_display(True).or_(service))
            .order_by_seq_asc()
            .limit(0, 2)
            .gets()
        )
        member = ServiceMember()
        compared = (
            author()
            .join_service_member_seq_with_seq(member)
            .service_seq(7)
            .and_success_count_lt_seq(member)
            .get_count()
        )
        left = (
            author()
            .left_join_service_region_seq_with_seq(ServiceRegion().alias_module())
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 1)
            .gets()
        )
        return {
            "rows": rows.to_array_list()
            if hasattr(rows, "to_array_list")
            else [r.to_array() for r in rows.values()],
            "compared": compared,
            "module": pick(left.first().get_module(), "seq", "name"),
        }

    run("joins", joins)

    def relations():
        rows = (
            author()
            .remove_all_columns()
            .add_column_name()
            .add_column_is_close()
            .relation(
                User()
                .match_user_seq_with_seq()
                .alias_writer()
                .relations(
                    Author()
                    .match_seq_with_user_seq()
                    .remove_all_columns()
                    .order_by_seq_desc()
                    .group_limit(2)
                )
            )
            .relation(
                Service()
                .match_service_seq_with_seq()
                .relations(
                    ServiceMember()
                    .match_seq_with_service_seq()
                    .remove_all_columns()
                    .order_by_seq_asc()
                    .group_limit(2)
                    .key_name_user_seq()
                )
            )
            .relation(
                ServiceRegion()
                .match_service_region_seq_with_seq()
                .possible_is_close(True)
                .parent_node()
            )
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 3)
            .gets()
        )
        return [r.to_array() for r in rows.values()]

    run("relations", relations)

    def relation_empty():
        rows = (
            author()
            .relations(ServiceMember().match_user_seq_with_user_seq())
            .gets_by_seq(-1)
        )
        return len(rows.values())

    run("relation_empty", relation_empty)

    def relation_null_key():
        try:
            rows = (
                User()
                .connect(db)
                .relations(Author().match_seq_with_user_seq().key_name_price())
                .seq(100)
                .gets()
            )
        except Exception as error:  # noqa: BLE001 - every library error is the result of the vector
            return {"error": code_of(error), "message": str(error)}
        return len(rows.values())

    run("relation_null_key", relation_null_key)

    # shared_note is a table of the external document bench_shared: it is read through its entity, and a
    # write fails with CONFIG before any statement (docs/spec/dbspec.md "External documents").
    def external_read():
        readers = (
            NoteReader()
            .connect(db)
            .relation(SharedNote().match_shared_note_seq_with_seq())
            .order_by_seq_asc()
            .gets()
        )
        related = [
            [r.get_seq(), r.get_shared_note_model().get_title()]
            for r in readers.values()
        ]
        notes = (
            SharedNote()
            .connect(db)
            .seq(NoteReader().add_column_shared_note_seq())
            .order_by_seq_asc()
            .gets()
        )
        write = None
        try:
            SharedNote().connect(db).set_seq(9).set_title("written").create()
        except Exception as error:  # noqa: BLE001 - every library error is the result of the vector
            write = code_of(error)
        return {
            "relation": related,
            "subquery": [n.get_title() for n in notes.values()],
            "write": write,
        }

    run("external_read", external_read)

    def subqueries():
        users = (
            User()
            .connect(db)
            .add_column_read_total(
                lambda u: (
                    Author().sum_read_count().user_seq_eq_seq(u).and_service_seq(7)
                )
            )
            .seq(Author().add_column_user_seq().service_seq(7).and_ge_read_count(906))
            .order_by_seq_asc()
            .gets()
        )
        return [
            [u.get_seq(), derived_integer(u.get_read_total())] for u in users.values()
        ]

    run("subqueries", subqueries)

    def aggregates():
        total = author().service_seq(7).sum_read_count().get_sum()
        average = author().service_seq(7).avg_like_count().get_avg()
        import struct

        if struct.pack(">d", average).hex() != "404805c28f5c28f6":
            raise ValueError(
                f"aggregate average has unexpected binary64 value: {average}"
            )
        groups = (
            author()
            .service_seq(7)
            .group_by_is_close()
            .order_by_is_close_asc()
            .gets_count()
        )
        page = (
            author()
            .service_seq(7)
            .remove_all_columns()
            .order_by_seq_asc()
            .gets_page(3, 4)
        )
        return {
            "sum": total,
            "avg": f"{average:.4f}",
            "groups": groups.to_array(),
            "page": {
                "keys": list(page["items"].keys()),
                "total": page["totalCount"],
                "pages": page["totalPages"],
                "page": page["page"],
                "per_page": page["perPage"],
            },
        }

    run("aggregates", aggregates)

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

    def audit_lazy():
        # An audited transaction inserts its audit record right before its first write of an audited
        # table: reads and an update that matches no row leave no record, and the create inserts one.
        # The transaction is rolled back at the end, so the database is the same as at the start.
        class Boom(Exception):
            pass

        result = {}
        failed = None
        try:

            def body():
                result["before"] = AuditRecord().get_count()
                result["read"] = AuditedNote().label("audit-lazy").get_count()
                AuditedNote().set_seq(-1).set_label("audit-none").update()
                result["unchanged"] = AuditRecord().get_count()
                created = AuditedNote().set_label("audit-lazy").create()
                mask([created.get_seq()])
                result["written"] = AuditRecord().get_count()
                raise Boom()

            db.transaction(body, {"audit": {"request_id": "audit-lazy"}, "retry": 0})
        except Boom as error:
            failed = error
        result["rolled_back"] = failed is not None
        result["after"] = AuditRecord().connect(db).get_count()
        return result

    run("audit_lazy", audit_lazy)

    def functions():
        queries = [
            author().service_seq(7).and_eq_start_dt(orm.day_of_week(), 2),
            author().service_seq(7).and_start_dt(orm.year(), 2026),
            author().service_seq(7).and_gt_start_dt(orm.days_ago(36500)),
            author().service_seq(7).and_lt_start_dt(orm.months_later(1200)),
        ]
        counts = [q.get_count() for q in queries]
        rows = (
            author()
            .remove_all_columns()
            .add_column_start_dt_alias_start_month(orm.month())
            .order_by_start_dt_asc(orm.year())
            .order_by_seq_asc()
            .gets_by_seq([42, 43])
        )
        return {
            "counts": counts,
            "months": [derived_integer(r.get_start_month()) for r in rows.values()],
        }

    run("functions", functions)

    def errors():
        errs = []

        def attempt(fn):
            errs.append(caught(lambda: fn()))

        attempt(lambda: author().name("a").is_close(True).gets())
        attempt(lambda: author().name("a").and_().gets())
        attempt(lambda: author().seq([]).gets())
        attempt(lambda: Author().name("a").gets())
        attempt(lambda: author().for_update().gets())
        attempt(lambda: author().join_user_seq_with_seq(User().connect(db)).gets())
        attempt(lambda: author().limit(0, 1).gets_page(1, 10))
        attempt(
            lambda: (
                author()
                .relation(User().match_user_seq_with_seq().limit(0, 1))
                .gets_by_seq(42)
            )
        )
        attempt(lambda: author().name("a").or_(User()).gets())
        return errs

    run("errors", errors)

    def get_query():
        st = (
            author()
            .service_seq(7)
            .and_lk_name("x")
            .and_aes_hex_email("user7@example.com")
            .order_by_seq_desc()
            .limit(0, 5)
            .get_query()
        )
        return {"sql": st["sql"], "binds": [norm(b) for b in st["binds"]]}

    run("get_query", get_query)

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

    def write_cycle():
        start = "2026-06-01 00:00:00.000000"
        created = (
            author()
            .set_name("cycle")
            .set_user_seq(1)
            .set_service_seq(999)
            .set_service_region_seq(1)
            .set_service_member_seq(1)
            .set_start_dt(start)
            .set_end_dt(start)
            .set_price("12.500")
            .set_ip("10.0.0.1")
            .set_aes_hex_email("cycle@example.com")
            .set_json_setting(bench_styled({"a": 1}))
            .set_serialize_data(bench_styled({"k": "v"}))
            .new_label("created")
            .create()
        )
        seq = created.get_seq()
        mask([seq])
        created_array = created.to_array()
        created_array["seq"] = "$SEQ"
        loaded = author().add_all_columns().get_by_seq(seq)
        mask([], loaded.get_updated_ts())
        loaded.set_name("cycle-2").plus_read_count(3).update(True)
        stale = caught(lambda: loaded.set_name("stale").update(True))
        again = author().add_all_columns().get_by_seq(seq)
        updated = pick(
            again,
            "name",
            "read_count",
            "price",
            "ip",
            "aes_hex_email",
            "json_setting",
            "serialize_data",
            "start_dt",
        )
        again.delete()
        gone = caught(lambda: author().get_by_seq(seq))
        return {
            "created": created_array,
            "updated": updated,
            "stale": stale,
            "deleted": gone,
        }

    run("write_cycle", write_cycle)

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

    def required_columns():
        def failure(fn):
            try:
                fn()
            except Exception as error:  # noqa: BLE001
                return {"error": code_of(error), "message": str(error)}
            return None

        missing_state = failure(lambda: Task().connect(db).set_title("draft").create())
        missing_title = failure(lambda: Task().connect(db).set_state("open").create())
        created = Task().connect(db).set_title("draft").set_state("open").create()
        mask([created.get_seq()])
        created.delete()
        return {"missing_state": missing_state, "missing_title": missing_title}

    run("required_columns", required_columns)

    def creates_and_save():
        rows = [
            CompositeAccount().set_tenant_id(900).set_account_id(1).set_name("a"),
            CompositeAccount().set_tenant_id(900).set_account_id(2).set_name("b"),
            CompositeAccount().set_tenant_id(901).set_account_id(1).set_name("c"),
        ]
        inserted = CompositeAccount().connect(db).creates(rows, 2)
        CompositeAccount().connect(db).set_tenant_id(900).set_account_id(1).set_name(
            "dup"
        ).duplication(CompositeAccount().set_name("updated")).create()
        CompositeAccount().connect(db).set_tenant_id(900).set_account_id(2).set_name(
            "saved"
        ).save()
        pairs = (
            CompositeAccount()
            .connect(db)
            .tuple_tenant_id_with_account_id([[900, 1], [900, 2]])
            .order_by_account_id_asc()
            .gets()
        )
        everything = (
            CompositeAccount()
            .connect(db)
            .tenant_id([900, 901])
            .order_by_tenant_id_asc()
            .order_by_account_id_asc()
            .gets()
        )
        everything.delete()
        left = CompositeAccount().connect(db).tenant_id([900, 901]).get_count()
        return {"inserted": inserted, "pairs": pairs.to_array(), "left": left}

    run("creates_and_save", creates_and_save)

    def creates_batch():
        """creates(rows, batch) runs each batch of batch rows as one multi-row INSERT in one transaction; a batch
        that is not a positive integer is CONFIG before any statement (docs/spec/protocol.md)."""
        rows = [
            CompositeAccount().set_tenant_id(903).set_account_id(i + 1).set_name(name)
            for i, name in enumerate(["a", "b", "c", "d", "e"])
        ]
        inserted = CompositeAccount().connect(db).creates(rows, 2)
        zero = caught(lambda: CompositeAccount().connect(db).creates(rows, 0))
        count = CompositeAccount().connect(db).tenant_id([903]).get_count()
        CompositeAccount().connect(db).tenant_id(
            [903]
        ).order_by_account_id_asc().gets().delete()
        return {"inserted": inserted, "zero": zero, "count": count}

    run("creates_batch", creates_batch)

    def creates_batch_too_large():
        """A batch whose binds exceed the bind limit is BATCH_TOO_LARGE before any statement: 21846 rows of three
        columns bind 65538 parameters, over the limit of every dialect."""
        rows = [
            CompositeAccount().set_tenant_id(904).set_account_id(i + 1).set_name("n")
            for i in range(21846)
        ]
        code = caught(lambda: CompositeAccount().connect(db).creates(rows, len(rows)))
        count = CompositeAccount().connect(db).tenant_id([904]).get_count()
        return {"code": code, "count": count}

    run("creates_batch_too_large", creates_batch_too_large)

    def contains_vector(cond, *patterns):
        """Creates rows Apple, apple, Évian, évian, x_y for tenant 902, collects the account_id that each pattern selects with cond, then deletes them."""
        rows = [
            CompositeAccount().set_tenant_id(902).set_account_id(i + 1).set_name(name)
            for i, name in enumerate(["Apple", "apple", "Évian", "évian", "x_y"])
        ]
        CompositeAccount().connect(db).creates(rows, len(rows))
        matches = [
            picks(
                cond(CompositeAccount().connect(db).tenant_id(902), p)
                .order_by_account_id_asc()
                .gets(),
                "account_id",
            )
            for p in patterns
        ]
        CompositeAccount().connect(db).tenant_id(
            902
        ).order_by_account_id_asc().gets().delete()
        return matches

    run(
        "contains_ascii_fold",
        lambda: contains_vector(lambda q, p: q.and_lk_name(p), "PPL", "ÉV", "_", ""),
    )
    run(
        "contains_binary_code_point",
        lambda: contains_vector(lambda q, p: q.and_lb_name(p), "pp", "É", "PPL", "_"),
    )

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

    def transactions_vector():
        class Boom(Exception):
            pass

        events = []
        failed = None
        try:

            def outer():
                Service().set_name("tx-outer").create()
                try:

                    def inner():
                        Service().set_name("tx-inner").create()
                        raise Boom()

                    db.transaction(inner)
                    events.append(False)
                except Boom:
                    events.append(True)
                events.append(Service().name(["tx-outer", "tx-inner"]).get_count())
                locked = Service().name("tx-outer").for_update().gets()
                events.append(len(locked.values()))
                db.utils().lock("conformance")
                db.utils().set_local("ormtest.actor", "runner")
                events.append(db.utils().local("ormtest.actor"))
                raise Boom()

            db.transaction(outer, {"retry": 0})
        except Boom as error:
            failed = error
        events.append(failed is not None)
        events.append(Service().connect(db).name(["tx-outer", "tx-inner"]).get_count())
        return events

    run("transactions", transactions_vector)

    def restore():
        class Boom(Exception):
            pass

        result = {}
        failed = None
        try:

            def body():
                created = SoftRecord().set_name("restore").create()
                seq = created.get_seq()
                mask([seq])
                created.set_deleted_at("2026-01-02 03:04:05.000000").update()
                result["hidden"] = caught(lambda: SoftRecord().get_by_seq(seq))
                for name, value in [("restored", "restore-2"), ("again", "ignored")]:
                    array = (
                        SoftRecord().set_seq(seq).set_name(value).restore().to_array()
                    )
                    array["seq"] = "$SEQ"
                    result[name] = array
                result["missing"] = caught(lambda: SoftRecord().set_seq(0).restore())
                raise Boom()

            db.transaction(body, {"retry": 0})
        except Boom as error:
            failed = error
        if failed is None:
            raise RuntimeError("restore transaction did not roll back")
        result["left"] = SoftRecord().connect(db).name("restore").get_count()
        return result

    run("restore", restore)

    def restore_or_create():
        # restore_or_create restores the soft-deleted row of its key, refuses a live row with ROW_NOT_DELETED and creates a
        # missing key (docs/operations/usage.md "Restore or create a row"). The transaction rolls back at the end.
        class Boom(Exception):
            pass

        result = {}
        failed = None
        try:

            def body():
                created = SoftLink().set_code("roc-1").set_label("first").create()
                mask([created.get_seq()])
                created.set_deleted_at("2026-01-02 03:04:05.000000").update()
                restored = (
                    SoftLink()
                    .set_code("roc-1")
                    .set_label("second")
                    .restore_or_create()
                    .to_array()
                )
                restored["seq"] = "$SEQ"
                result["restored"] = restored
                result["live"] = caught(
                    lambda: (
                        SoftLink()
                        .set_code("roc-1")
                        .set_label("third")
                        .restore_or_create()
                    )
                )
                made = SoftLink().set_code("roc-2").set_label("new").restore_or_create()
                mask([made.get_seq()])
                created_row = made.to_array()
                created_row["seq"] = "$SEQ"
                result["created"] = created_row
                raise Boom()

            db.transaction(body, {"retry": 0})
        except Boom as error:
            failed = error
        if failed is None:
            raise RuntimeError("restore_or_create transaction did not roll back")
        result["left"] = SoftLink().connect(db).get_count()
        return result

    run("restore_or_create", restore_or_create)

    def expect_revision():
        # expect_revision makes an update or a delete write only while author 42's like_count still holds the expected
        # revision; an update stores revision + 1, and a mismatch is REVISION_CHANGED and writes nothing (docs/spec/dsl.md
        # "Writes"). The transaction rolls back at the end.
        class Boom(Exception):
            pass

        result = {}
        failed = None

        def read():
            row = Author().get_by_seq(42)
            return {"name": row.get_name(), "like_count": row.get_like_count()}

        try:

            def body():
                result["before"] = read()
                revision = result["before"]["like_count"]
                Author().set_seq(42).set_name("revision-1").expect_revision(
                    "like_count", revision
                ).update()
                result["updated"] = read()
                result["update_mismatch"] = caught(
                    lambda: (
                        Author()
                        .set_seq(42)
                        .set_name("revision-stale")
                        .expect_revision("like_count", revision)
                        .update()
                    )
                )
                result["after_mismatch"] = read()
                result["delete_mismatch"] = caught(
                    lambda: (
                        Author()
                        .set_seq(42)
                        .expect_revision("like_count", revision)
                        .delete()
                    )
                )
                result["kept"] = Author().seq(42).get_count()
                result["delete_match"] = caught(
                    lambda: (
                        Author()
                        .set_seq(42)
                        .expect_revision("like_count", revision + 1)
                        .delete()
                    )
                )
                result["deleted"] = Author().seq(42).get_count()
                raise Boom()

            db.transaction(body, {"retry": 0})
        except Boom as error:
            failed = error
        if failed is None:
            raise RuntimeError("expect_revision transaction did not roll back")
        result["left"] = Author().connect(db).seq(42).get_count()
        return result

    run("expect_revision", expect_revision)

    def joins_soft_deleted():
        # A joined soft_record row that is soft deleted meets no parent: the inner join drops the parent and the left
        # join gives it a null child. The transaction rolls back at the end, so the database is as it was.
        class Boom(Exception):
            pass

        names = ["soft-join-live", "soft-join-deleted"]
        result = {}
        failed = None
        try:

            def body():
                for name in names:
                    service = Service().set_name(name).create()
                    record = SoftRecord().set_name(name).create()
                    mask([service.get_seq(), record.get_seq()])
                    if name == "soft-join-deleted":
                        record.set_deleted_at("2026-01-02 03:04:05.000000").update()
                inner = (
                    Service()
                    .join_name_with_name(SoftRecord().alias_record())
                    .name(names)
                    .order_by_name_asc()
                    .gets()
                )
                result["inner"] = picks(inner, "name")
                left = (
                    Service()
                    .left_join_name_with_name(SoftRecord().alias_record())
                    .name(names)
                    .order_by_name_asc()
                    .gets()
                )
                result["left"] = [
                    {"name": row.get_name(), "record": pick(row.get_record(), "name")}
                    for row in left.values()
                ]
                raise Boom()

            db.transaction(body, {"retry": 0})
        except Boom as error:
            failed = error
        if failed is None:
            raise RuntimeError("joins_soft_deleted transaction did not roll back")
        return result

    run("joins_soft_deleted", joins_soft_deleted)

    def column_pairs():
        # Two compared columns meet as dbspec check operands do (docs/spec/dbspec.md "Checks"): a comparison of two
        # columns, a column in a subquery column, a join and a relation run when their columns meet, here i32 with i64
        # and text with varchar, and fail with OPERATOR_NOT_ALLOWED before any statement when they do not.
        result = {}
        s1 = Service()
        result["col_i32_i64"] = (
            author().join_service_seq_with_seq(s1).read_count_lt_seq(s1).get_count()
        )
        s2 = Service()
        result["col_text_varchar"] = (
            author().join_service_seq_with_seq(s2).description_ne_name(s2).get_count()
        )
        result["in_i32_i64"] = author().like_count(User().add_column_seq()).get_count()
        result["join_i32_i64"] = (
            author().join_read_count_with_seq(Service()).get_count()
        )
        result["relation_i32_i64"] = len(
            author()
            .relation(Service().match_like_count_with_seq())
            .order_by_seq_asc()
            .limit(0, 2)
            .gets()
            .values()
        )
        s3 = Service()
        result["col_varchar_i64"] = caught(
            lambda: author().join_service_seq_with_seq(s3).name_eq_seq(s3).get_count()
        )
        s4 = Service()
        result["col_decimal_i64"] = caught(
            lambda: author().join_service_seq_with_seq(s4).price_eq_seq(s4).get_count()
        )
        result["in_varchar_i64"] = caught(
            lambda: author().name(User().add_column_seq()).get_count()
        )
        result["join_varchar_i64"] = caught(
            lambda: author().join_name_with_seq(Service()).get_count()
        )
        result["relation_varchar_i64"] = caught(
            lambda: (
                author().relation(Service().match_name_with_seq()).limit(0, 1).gets()
            )
        )
        return result

    run("column_pairs", column_pairs)

    def relative_time_out_of_range():
        # A relative time function outside 0001-01-01 to 9999-12-31, or with an interval no database represents, is NULL, so
        # a comparison and its negation both match no row. secondsAgo takes an integer in every client, so 1e15 seconds
        # stands for an interval past every bound.
        counts = {}
        for name, f in [
            ("seconds_ago", orm.seconds_ago(1000000000000000)),
            ("days_later", orm.days_later(4000000)),
            ("months_ago", orm.months_ago(200000)),
        ]:
            counts[name] = [
                author().and_gt_start_dt(f).get_count(),
                author().and_le_start_dt(f).get_count(),
            ]
        return counts

    run("relative_time_out_of_range", relative_time_out_of_range)

    def aes_status():
        keyring = AesKeyring({1: "bench-salt"}, 1)
        status = db.utils().aes().status(Author(), keyring)
        versions = sorted(f"{v}:{n}" for v, n in status.versions.items())
        return {
            "current": status.current,
            "pending": status.pending,
            "versions": ",".join(versions),
        }

    run("aes_status", aes_status)

    def hex_malformed():
        # the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
        return {
            "white_space": caught(lambda: HexCell().connect(db).get_by_seq(1)),
            "odd_length": caught(lambda: HexCell().connect(db).get_by_seq(2)),
        }

    run("hex_malformed", hex_malformed)

    # A datetime(p) or time(p) value is bound with exactly p fraction digits, the form the SQLite CHECK of the column
    # requires (docs/spec/dialects.md); zeros past p are dropped. Each vector inserts, reads the row back by the same
    # parameter and deletes it.
    at = "2026-06-01 12:34:56.000000"

    def datetime_p0_roundtrip():
        created = TimeCell().connect(db).set_at(at).set_clock("10:11:12").create()
        mask([created.get_seq()])
        rows = TimeCell().connect(db).at(at).gets()
        created.delete()
        return picks(rows, "clock")

    run("datetime_p0_roundtrip", datetime_p0_roundtrip)

    def time_p3_roundtrip():
        created = (
            TimeCell().connect(db).set_at(at).set_clock("10:11:12.345000").create()
        )
        mask([created.get_seq()])
        rows = TimeCell().connect(db).clock("10:11:12.345").gets()
        created.delete()
        return picks(rows, "clock")

    run("time_p3_roundtrip", time_p3_roundtrip)

    # A date and a time(0) column read back as their text form; the driver's own types (a date, a timedelta from
    # PyMySQL, a datetime.time from psycopg) are the codec's input, so the rows come back as text.
    def date_roundtrip():
        created = (
            DayCell()
            .connect(db)
            .set_label("date")
            .set_day("2026-06-01")
            .set_at_time("10:11:12")
            .create()
        )
        mask([created.get_seq()])
        rows = DayCell().connect(db).label("date").gets()
        created.delete()
        return picks(rows, "day", "at_time")

    run("date_roundtrip", date_roundtrip)

    def date_null():
        created = DayCell().connect(db).set_label("nil").create()
        mask([created.get_seq()])
        rows = DayCell().connect(db).label("nil").gets()
        created.delete()
        return picks(rows, "day", "at_time")

    run("date_null", date_null)

    # An upsert has exactly one conflict key (docs/spec/protocol.md 1): upsert_cell leaves its identity primary key out, so
    # the unique key on code is the one key that can meet the row; an insert that does not assign code is IR_INVALID
    # before any statement.
    def upsert_one_key():
        created = (
            UpsertCell()
            .connect(db)
            .set_code("k1")
            .set_label("first")
            .duplication(UpsertCell().set_label("second"))
            .create()
        )
        mask([created.get_seq()])
        inserted = UpsertCell().connect(db).code("k1").gets()
        UpsertCell().connect(db).set_code("k1").set_label("other").duplication(
            UpsertCell().set_label("second")
        ).create()
        updated = UpsertCell().connect(db).code("k1").gets()
        unassigned = None
        try:
            UpsertCell().connect(db).set_label("none").duplication(
                UpsertCell().set_label("second")
            ).create()
        except Exception as error:  # noqa: BLE001
            unassigned = {"error": code_of(error), "message": str(error)}
        updated.delete()
        return {
            "inserted": picks(inserted, "label"),
            "updated": picks(updated, "label"),
            "unassigned": unassigned,
        }

    run("upsert_one_key", upsert_one_key)

    # A PostgreSQL uuid column is read as its text and a uuid value is bound as text cast to uuid, in one form in
    # every planner (docs/spec/dialects.md); the vector inserts, reads the row back by the same value and deletes it.
    def uuid_roundtrip():
        created = (
            UuidCell()
            .connect(db)
            .set_id("0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5")
            .create()
        )
        mask([created.get_seq()])
        rows = UuidCell().connect(db).id("0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5").gets()
        created.delete()
        return picks(rows, "id")

    run("uuid_roundtrip", uuid_roundtrip)

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

    # A value outside the logical type of its slot is CODEC_ENCODE before any statement (docs/spec/protocol.md §5
    # "Parameters"). A create that the client lets through is deleted, so the vector leaves the database as it
    # found it.
    def rejected(create):
        try:
            created = create()
        except Exception as error:  # noqa: BLE001 - every library error is the result of the vector
            return {"code": code_of(error)}
        mask([created.get_seq()])
        created.delete()
        return {"code": None}

    run(
        "datetime_precision_rejected",
        lambda: rejected(
            lambda: (
                TimeCell()
                .connect(db)
                .set_at("2026-06-01 12:34:56.500000")
                .set_clock("10:11:12")
                .create()
            )
        ),
    )
    run(
        "varchar_length_rejected",
        lambda: rejected(
            lambda: BindCell().connect(db).set_label("123456789").create()
        ),
    )
    run(
        "text_nul_rejected",
        lambda: rejected(
            lambda: BindCell().connect(db).set_label("nul").set_body("a\x00b").create()
        ),
    )
    run(
        "uuid_form_rejected",
        lambda: rejected(
            lambda: (
                BindCell()
                .connect(db)
                .set_label("uuid")
                .set_token("123E4567-E89B-12D3-A456-426614174000")
                .create()
            )
        ),
    )

    # A parameter that assigns NULL to a non-null column is CODEC_ENCODE before any statement (docs/spec/protocol.md §5
    # "Parameters"); creates binds each row value as a parameter.
    run(
        "null_into_not_null",
        lambda: {
            "code": caught(
                lambda: (
                    BindCell()
                    .connect(db)
                    .creates([BindCell().set_label("a"), BindCell().set_label(None)], 2)
                )
            )
        },
    )

    # A contains value NULL binds NULL, so `col LIKE NULL` matches no row (docs/spec/protocol.md §2).
    def contains_null():
        try:
            return {
                "code": None,
                "count": author().service_seq(7).and_lk_name(None).get_count(),
            }
        except Exception as error:  # noqa: BLE001 - every library error is the result of the vector
            return {"code": code_of(error), "count": None}

    run("contains_null", contains_null)

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

    def order_nulls():
        # the seed prices the authors of service 100 except a seq that is a multiple of 3 (benchmarks/sql/seed.*.sql)
        def priced():
            return (
                author()
                .remove_all_columns()
                .add_column_price()
                .service_seq(100)
                .and_lt_seq(500)
            )

        asc = [
            r.to_array()
            for r in priced().order_by_price_asc().order_by_seq_asc().gets().values()
        ]
        desc = [
            r.to_array()
            for r in priced().order_by_price_desc().order_by_seq_asc().gets().values()
        ]
        per_parent = {}
        for order in ("asc", "desc"):
            child = (
                Author()
                .match_seq_with_user_seq()
                .remove_all_columns()
                .add_column_price()
            )
            if order == "asc":
                child.order_by_price_asc()
            else:
                child.order_by_price_desc()
            users = (
                User()
                .connect(db)
                .relations(child.order_by_seq_asc().group_limit(2))
                .seq(100)
                .gets()
            )
            per_parent[order] = [u.to_array() for u in users.values()]
        return {
            "asc": asc,
            "desc": desc,
            "limit_per_parent": per_parent,
        }

    run("order_nulls", order_nulls)

    def scalar_column_subquery():
        # user 100 has the authors 99 (price NULL) and 5099 (price 3.000) under seq 10000 (benchmarks/sql/seed.*.sql)
        out = {}
        for order in ("asc", "desc"):

            def sub(u, order=order):
                child = (
                    Author()
                    .remove_all_columns()
                    .add_column_name()
                    .user_seq_eq_seq(u)
                    .and_lt_seq(10000)
                )
                if order == "asc":
                    child.order_by_price_asc()
                else:
                    child.order_by_price_desc()
                return child.order_by_seq_asc().limit(0, 1)

            users = User().connect(db).add_column_read_total(sub).seq(100).gets()
            out[order] = [[u.get_seq(), u.get_read_total()] for u in users.values()]
        return out

    run("scalar_column_subquery", scalar_column_subquery)

    def relations_flatten():
        # a flattened region of a closed author (seq, name and service_seq collide with the parent; absent for an open author) that holds a flattened service (seq and name collide) with its service members
        rows = (
            author()
            .remove_all_columns()
            .add_column_name()
            .add_column_is_close()
            .relation(
                ServiceRegion()
                .match_service_region_seq_with_seq()
                .possible_is_close(True)
                .parent_node()
                .relation(
                    Service()
                    .match_service_seq_with_seq()
                    .parent_node()
                    .relations(
                        ServiceMember()
                        .match_seq_with_service_seq()
                        .remove_all_columns()
                        .order_by_seq_asc()
                        .group_limit(2)
                    )
                )
            )
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 8)
            .gets()
        )
        return [r.to_array() for r in rows.values()]

    run("relations_flatten", relations_flatten)

    db.close()
    unknown = [name for name in SELECTED if name not in declared]
    if unknown:
        print(f"unknown vector {', '.join(unknown)}", file=sys.stderr)
        sys.exit(2)
    text = encode(dict(sorted(out.items())))
    sys.stdout.write(go_escape(text) + "\n")


def bench_styled(value):
    from polyspec.orm.styled_value import StyledValue

    return StyledValue.value(value)


if __name__ == "__main__":
    main()
