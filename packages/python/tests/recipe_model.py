"""The generated-model ops of the recipe helper (docs/spec/feature-coverage.md FCV-4 model ops, FCV-14). Each op calls the
generated model that its model name names, through the connection that model.connect bound. A model or a column without
an entry here fails the case by name, so no recipe passes on a call that the helper does not make."""

from polyspec.orm import Db

from .models import models

# The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
BENCH_KEYS = {"aesKey": "bench-salt", "blindIndexKey": "bench-blind-index"}


# The Author equality conditions that the recipes name, by column: the condition method of the chain grammar.
CONDITIONS = {
    "seq": "seq",
    "user_seq": "user_seq",
    "service_seq": "service_seq",
    "service_region_seq": "service_region_seq",
    "service_member_seq": "service_member_seq",
}

# The Author columns that a recipe may read, by column: the method that adds it to the projection, and its getter.
COLUMNS = {
    "seq": ("add_column_seq", "get_seq"),
    "name": ("add_column_name", "get_name"),
    "user_seq": ("add_column_user_seq", "get_user_seq"),
    "service_seq": ("add_column_service_seq", "get_service_seq"),
    "service_region_seq": ("add_column_service_region_seq", "get_service_region_seq"),
    "service_member_seq": ("add_column_service_member_seq", "get_service_member_seq"),
    "read_count": ("add_column_read_count", "get_read_count"),
}

# The Author orders that a recipe may name, by column: a name is ascending, and a name with a leading "-" is descending (FCV-4).
ORDERS = {
    "seq": "order_by_seq_asc",
    "name": "order_by_name_asc",
    "-seq": "order_by_seq_desc",
    "-name": "order_by_name_desc",
}


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

    def chain(db, where, columns):
        """Applies the equalities of where, ANDed in the order of their column names, then the projection of columns (an
        empty list keeps the default columns of the model)."""
        model = models.Author().connect(db)
        # The int equalities come first in name order; the bool equality of is_close is and_is_close after them (the chain has
        # no bool condition that opens it). The equalities are ANDed, so the order of the conditions does not change the rows.
        names = sorted(where)
        ordered = [c for c in names if not isinstance(where[c], bool)] + [
            c for c in names if isinstance(where[c], bool)
        ]
        for index, column in enumerate(ordered):
            if isinstance(where[column], bool):
                if column != "is_close" or index == 0:
                    raise AssertionError(
                        f"Author column {column}: a bool equality needs the is_close column after an int equality"
                    )
                model.and_is_close(where[column])
                continue
            condition = CONDITIONS.get(column)
            if condition is None:
                raise AssertionError(f"Author column {column} has no recipe condition")
            if not isinstance(where[column], int):
                raise AssertionError(f"Author column {column}: want an int wrapper")
            if index > 0:
                model.and_()
            getattr(model, condition)(where[column])
        if columns:
            model.remove_all_columns()
            for column in columns:
                if column not in COLUMNS:
                    raise AssertionError(f"Author column {column} has no recipe column")
                getattr(model, COLUMNS[column][0])()
        return model

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
        if step["model"] == "Author":
            return {"value": _wrap(chain(db, values_of(step.get("where"), context), []).get_count())}
        return {
            "value": {
                "int": str(
                    composite_filter(db, values_of(step.get("where"), context)).get_count()
                )
            }
        }

    def model_get_by(step, context):
        db = connection(step["connection"], context)
        if "where" in step:
            if step["model"] != "Author":
                raise AssertionError(f"model {step['model']} has no recipe where")
            found = chain(db, values_of(step["where"], context), step["columns"]).get()
            if found is None:
                return {"rows": []}
            return {"rows": [[_wrap(getattr(found, COLUMNS[column][1])()) for column in step["columns"]]]}
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
        if step["model"] == "Author":
            model = chain(db, values_of(step.get("where"), context), step["columns"])
            for column in step.get("order", []):
                if column not in ORDERS:
                    raise AssertionError(f"Author column {column} has no recipe order")
                getattr(model, ORDERS[column])()
            offset = step.get("offset", 0)
            limit = step.get("limit", 0)
            if limit > 0 or offset > 0:
                model.limit(offset, limit)
            return {
                "rows": [
                    [_wrap(getattr(row, COLUMNS[column][1])()) for column in step["columns"]]
                    for row in model.gets().values()
                ]
            }
        rows = composite_filter(db, values_of(step.get("where"), context)).gets().values()
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
