# model_writes coverage: create_parts runs the batch behaviour of CompositeAccount natively, model_write_cycle checks
# the ordered JSON text and the codec columns, which the model_writes recipe does not assert, and optimistic_update
# checks DSL-107, which the recipe does not assert either.

from polyspec.ordered_json import parse as parse_json
from polyspec.ordered_json import stringify as stringify_json
from polyspec.orm import StyledValue
from .models import models

from .coverage_case import (
    CoverageCase,
    connect_bench_author,
    coverage_main,
    error_code,
    expect_equal,
    run_on_empty_tenant,
    with_cleanup,
)

TENANT = 990002


# Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26.
def model_write_cycle(item):
    def case(_db, _account):
        def body():
            text = '{"b":1,"a":[],"c":{},"n":1.50}'
            rollback = RuntimeError("rollback ordered JSON text probe")

            def ordered_json_probe():
                row = models.Author().connect(_db).add_all_columns().get_by_seq(1)
                expect_equal(row is not None, True, "seed author row 1 exists")
                row.set_json_setting(StyledValue.value(parse_json(text))).update()
                stored = models.Author().connect(_db).add_all_columns().get_by_seq(1)
                expect_equal(
                    stored is not None, True, "seed author row 1 remains after update"
                )
                expect_equal(
                    stringify_json(stored.get_json_setting().payload()),
                    text,
                    "ordered JSON text round trip",
                )
                raise rollback

            try:
                _db.transaction(ordered_json_probe, {"retry": 0})
            except RuntimeError as error:
                expect_equal(
                    error is rollback,
                    True,
                    "ordered JSON probe rolls back its row update",
                )
            else:
                raise AssertionError(
                    "ordered JSON text probe transaction unexpectedly committed"
                )

            codec_rollback = RuntimeError("rollback codec columns probe")

            def codec_column_probe():
                row = models.Author().connect(_db).add_all_columns().get_by_seq(1)
                expect_equal(
                    row is not None, True, "seed author row 1 exists for codec columns"
                )
                row.set_ip("10.0.0.1").set_gz_extend(
                    StyledValue.value("compressed text")
                )
                row.set_base64_extra(StyledValue.value("plain")).update()
                stored = models.Author().connect(_db).add_all_columns().get_by_seq(1)
                expect_equal(
                    stored is not None, True, "author row remains after codec update"
                )
                expect_equal(stored.get_ip(), "10.0.0.1", "ip codec column round trip")
                expect_equal(
                    stored.get_gz_extend().payload(),
                    "compressed text",
                    "gz codec column round trip",
                )
                expect_equal(
                    stored.get_base64_extra().payload(),
                    "plain",
                    "base64 codec column round trip",
                )
                expect_equal(
                    models.Author().connect(_db).ip("10.0.0.1").get_count(),
                    1,
                    "ip codec equality",
                )
                expect_equal(
                    error_code(lambda: stored.set_ip("10. 0.0.1").update()),
                    "CODEC_ENCODE",
                    "ip rejects embedded whitespace",
                )
                raise codec_rollback

            try:
                _db.transaction(codec_column_probe, {"retry": 0})
            except RuntimeError as error:
                expect_equal(
                    error is codec_rollback,
                    True,
                    "codec columns probe rolls back its row update",
                )
            else:
                raise AssertionError(
                    "codec columns probe transaction unexpectedly committed"
                )

        body()

    run_on_empty_tenant(
        models,
        item,
        TENANT,
        case,
        aes_key="bench-salt",
        blind_index_key="bench-blind-index",
    )
    optimistic_update(item)


def optimistic_update(item):
    db, author, _, _ = connect_bench_author(models, item, all_columns=True)
    try:
        before = author().get_by_seq(1)
        stale = author().get_by_seq(1)
        sentinel = RuntimeError("rollback the optimistic update probe")
        caught = None

        def work():
            fresh = author().get_by_seq(1)
            fresh.set_name("optimistic-update-probe").update(True)
            expect_equal(
                error_code(lambda: stale.set_name("stale-probe").update(True)),
                "OPTIMISTIC_LOCK",
                "a stale model revision rejects the update",
            )
            raise sentinel

        try:
            db.transaction(work, {"retry": 0})
        except RuntimeError as error:
            caught = error
        expect_equal(caught is sentinel, True, "the probe transaction rolled back")
        after = author().get_by_seq(1)
        expect_equal(after.get_name(), before.get_name(), "rollback restores the row")
        expect_equal(
            after.get_updated_ts(),
            before.get_updated_ts(),
            "rollback restores updated_ts",
        )
    finally:
        db.close()


# Requirements: DIA-26, COD-15.
def ordered_json_repeated_member_name(item):
    driver, dsn = item
    _db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    text = '{"a":1,"b":2,"a":3}'
    rollback = RuntimeError("rollback repeated member name probe")

    def probe():
        row = models.Author().connect(_db).add_all_columns().get_by_seq(1)
        expect_equal(
            row is not None, True, "seed author row 1 exists for repeated member names"
        )
        row.set_json_setting(StyledValue.value(parse_json(text))).update()
        stored = models.Author().connect(_db).add_all_columns().get_by_seq(1)
        expect_equal(
            stored is not None,
            True,
            "seed author row 1 remains after repeated member name update",
        )
        expect_equal(
            stored.get_json_setting().payload().raw,
            text,
            "repeated member name text round trip",
        )
        raise rollback

    try:
        _db.transaction(probe, {"retry": 0})
    except RuntimeError as error:
        expect_equal(
            error is rollback,
            True,
            "repeated member name probe rolls back its row update",
        )
    else:
        raise AssertionError(
            "repeated member name probe transaction unexpectedly committed"
        )
    finally:
        _db.close()


class CoverageTest(CoverageCase):
    # Requirements: DSL-104, INT-35, PRT-41.
    def test_create_parts(self):
        tenant = TENANT + 1

        def case(_db, account):
            events = []
            unsubscribe = _db.subscribe(events.append)
            try:
                refused = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(1)
                    .set_name("refused")
                ]
                expect_equal(
                    error_code(lambda: account().creates(refused, 0)),
                    "CONFIG",
                    "batch zero error",
                )
                expect_equal(events, [], "refused batch sends no statements")
                limit = 999 if _db.driver == "sqlite" else 65535
                oversized = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(8)
                    .set_name("oversized")
                    for _ in range(limit // 3 + 1)
                ]
                expect_equal(
                    error_code(lambda: account().creates(oversized, len(oversized))),
                    "BATCH_TOO_LARGE",
                    "over-limit batch is refused",
                )
                expect_equal(events, [], "over-limit batch sends no statements")

                labels = [
                    "ordered-5",
                    "ordered-4",
                    "ordered-3",
                    "ordered-2",
                    "ordered-1",
                ]
                rows = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(i + 1)
                    .set_name(label)
                    for i, label in enumerate(labels)
                ]
                expect_equal(account().creates(rows, 2), 5, "rows inserted")
                inserts = [event for event in events if event.kind == "insert"]
                expect_equal(
                    [len(event.binds) // 3 for event in inserts],
                    [2, 2, 1],
                    "INSERT batch sizes",
                )
                stored = account().tenant_id(tenant).order_by_account_id_asc().gets()
                expect_equal(
                    [row.get_name() for row in stored], labels, "stored row order"
                )

                account().tenant_id(tenant).gets().delete()
                events.clear()
                account().set_tenant_id(tenant).set_account_id(99).set_name(
                    "existing"
                ).create()
                events.clear()
                failing = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(key)
                    .set_name(f"rollback-{key}")
                    for key in (10, 11, 12, 13, 99)
                ]
                expect_equal(
                    error_code(lambda: account().creates(failing, 2)),
                    "DUPLICATE_KEY",
                    "third batch conflicts with sentinel",
                )
                failed_inserts = [event for event in events if event.kind == "insert"]
                expect_equal(
                    [len(event.binds) // 3 for event in failed_inserts],
                    [2, 2, 1],
                    "failing INSERT batches",
                )
                expect_equal(
                    account().tenant_id(tenant).get_count(),
                    1,
                    "failed call rolls back earlier batches",
                )
                expect_equal(
                    account().get_by_tenant_id_and_account_id(tenant, 99).get_name(),
                    "existing",
                    "sentinel survives rollback",
                )
            finally:
                try:
                    unsubscribe()
                finally:
                    account().tenant_id(tenant).gets().delete()

            def assert_clean():
                account().tenant_id(tenant).gets().delete()
                expect_equal(
                    account().tenant_id(tenant).get_count(), 0, "case leaves no rows"
                )

            with_cleanup(
                assert_clean,
                lambda: account().tenant_id(tenant).gets().delete(),
            )

        self.each_item(
            "create_parts", lambda item: run_on_empty_tenant(models, item, tenant, case)
        )

    # Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-107, PLN-27.
    def test_model_write_cycle(self):
        self.each_item("model_write_cycle", model_write_cycle)

    # Requirements: DIA-26, COD-15.
    def test_ordered_json_repeated_member_name(self):
        self.each_item(
            "ordered_json_repeated_member_name", ordered_json_repeated_member_name
        )


if __name__ == "__main__":
    coverage_main(CoverageTest)
