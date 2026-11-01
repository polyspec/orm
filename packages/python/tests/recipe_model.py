"""The generated-model ops of the recipe helper (docs/spec/feature-coverage.md FCV-4 model ops, FCV-14). Each op calls the
generated model that its model name names, through the connection that model.connect bound. A model or a column without
an entry here fails the case by name, so no recipe passes on a call that the helper does not make."""

from polyspec.orm import Db

from .models import models

# The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
BENCH_KEYS = {"aesKey": "bench-salt", "blindIndexKey": "bench-blind-index"}


def _wrap(value):
    if isinstance(value, bool):
        raise AssertionError(f"no recipe wrapper for {value!r}")
    if isinstance(value, int):
        return {"int": str(value)}
    return {"text": value}


def model_ops(native, database_value, step_argument):
    """The model op table of the recipe helper; the helpers are the recipe value conversions it shares with the catalog ops."""

    def value_of(value, context):
        return native(database_value(step_argument(value, context), context))

    def values_of(object_, context):
        return {key: value_of(item, context) for key, item in (object_ or {}).items()}

    def connection(name, context):
        if name not in context["bound"]:
            raise AssertionError(
                f"model op: connection {name} is not bound by model.connect"
            )
        return context["bound"][name]

    def composite_set(db, values):
        model = models.CompositeAccount().connect(db)
        for column in sorted(values):
            if column == "tenant_id":
                model.set_tenant_id(values[column])
            elif column == "account_id":
                model.set_account_id(values[column])
            elif column == "name":
                model.set_name(values[column])
            else:
                raise AssertionError(
                    f"CompositeAccount column {column} has no recipe setter"
                )
        return model

    def composite_filter(db, where):
        model = models.CompositeAccount().connect(db)
        for column in sorted(where):
            if column == "tenant_id":
                model.tenant_id(where[column])
            elif column == "account_id":
                model.account_id(where[column])
            else:
                raise AssertionError(
                    f"CompositeAccount column {column} has no recipe filter"
                )
        return model

    def composite_key(db, key):
        return (
            models.CompositeAccount()
            .connect(db)
            .get_by_tenant_id_and_account_id(key["tenant_id"], key["account_id"])
        )

    def model_connect(step, context):
        # The case schema is registered on the connection, as the statement-event ops need it (FCV-4, model.connect).
        options = dict(BENCH_KEYS)
        if "pool_size" in step:
            options["poolSize"] = step["pool_size"]
        db = Db.connect_schema(context["dsn"], context["schema"], options)
        context.setdefault("closers", []).append(db.close)
        return {"bind": db}

    def model_create(step, context):
        model = composite_set(
            connection(step["connection"], context), values_of(step["values"], context)
        )
        model.create()
        # With `as`, the created model is bound on the connection it was made on (FCV-4, model.create).
        return {"bind": model} if "as" in step else {}

    def model_creates(step, context):
        db = connection(step["connection"], context)
        rows = [composite_set(db, values_of(row, context)) for row in step["rows"]]
        count = models.CompositeAccount().connect(db).creates(rows, step["batch"])
        return {"value": {"int": str(count)}}

    def model_save(step, context):
        composite_set(
            connection(step["connection"], context), values_of(step["values"], context)
        ).save()
        return {}

    def model_duplicate_create(step, context):
        db = connection(step["connection"], context)
        model = composite_set(db, values_of(step["values"], context))
        model.duplication(
            composite_set(db, values_of(step["duplication"], context))
        ).create()
        return {}

    def model_update(step, context):
        db = connection(step["connection"], context)
        row = composite_key(db, values_of(step["key"], context))
        if row is None:
            raise AssertionError("model.update: the key names no row")
        for column, value in sorted(values_of(step["set"], context).items()):
            if column != "name":
                raise AssertionError(
                    f"CompositeAccount column {column} has no recipe update"
                )
            row.set_name(value)
        row.update()
        return {}

    def model_delete(step, context):
        db = connection(step["connection"], context)
        composite_filter(db, values_of(step["where"], context)).gets().delete()
        return {}

    def model_count(step, context):
        db = connection(step["connection"], context)
        return {
            "value": {
                "int": str(
                    composite_filter(db, values_of(step["where"], context)).get_count()
                )
            }
        }

    def model_get_by(step, context):
        db = connection(step["connection"], context)
        if step["model"] == "Author":
            author = (
                models.Author()
                .connect(db)
                .get_by_seq(values_of(step["key"], context)["seq"])
            )
            rows = (
                []
                if author is None
                else [[_wrap(author.get_read_count()) for _ in step["columns"]]]
            )
            return {"rows": rows}
        row = composite_key(db, values_of(step["key"], context))
        if row is None:
            return {"rows": []}
        return {"rows": [[_column_wrap(row, column) for column in step["columns"]]]}

    def model_query(step, context):
        db = connection(step["connection"], context)
        rows = composite_filter(db, values_of(step["where"], context)).gets().values()
        return {
            "rows": [
                [_column_wrap(row, column) for column in step["columns"]]
                for row in rows
            ]
        }

    def model_arithmetic(step, context):
        db = connection(step["connection"], context)
        if step["column"] != "read_count":
            raise AssertionError(
                f"Author column {step['column']} has no recipe arithmetic"
            )
        row = (
            models.Author()
            .connect(db)
            .get_by_seq(values_of(step["key"], context)["seq"])
        )
        if row is None:
            raise AssertionError("model.arithmetic: the key names no row")
        amount = value_of(step["amount"], context)
        if step["operation"] == "plus":
            row.plus_read_count(amount)
        else:
            row.minus_read_count(amount)
        row.update()
        return {}

    def _column_wrap(row, column):
        if column != "name":
            raise AssertionError(
                f"CompositeAccount column {column} has no recipe getter"
            )
        return _wrap(row.get_name())

    return {
        "model.connect": model_connect,
        "model.create": model_create,
        "model.creates": model_creates,
        "model.save": model_save,
        "model.duplicate_create": model_duplicate_create,
        "model.update": model_update,
        "model.delete": model_delete,
        "model.count": model_count,
        "model.get_by": model_get_by,
        "model.query": model_query,
        "model.arithmetic": model_arithmetic,
    }
