"""The generated-model ops of the recipe helper (docs/spec/feature-coverage.md FCV-4 model ops, FCV-14). Each op calls the
generated model that its model name names, through the connection that model.connect bound. A model or a column without
an entry here fails the case by name, so no recipe passes on a call that the helper does not make."""

from polyspec.orm import Db
from polyspec.orm.bind_check import fulltext_boolean
from polyspec.orm.engine import Engine
from polyspec.orm.names import ChainKey

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
    "like_count": ("add_column_like_count", "get_like_count"),
    "uuid": ("add_column_uuid", "get_uuid"),
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


# The order, getter and lock methods of the CompositeAccount model ops, by recipe column and lock name.
_COMPOSITE_ORDERS = {
    "tenant_id": "order_by_tenant_id_asc",
    "account_id": "order_by_account_id_asc",
    "name": "order_by_name_asc",
}
_COMPOSITE_GETTERS = {
    "tenant_id": "get_tenant_id",
    "account_id": "get_account_id",
    "name": "get_name",
}
# The getters of the CompositeMembership columns that a relation of a CompositeAccount query reads, by recipe column.
_COMPOSITE_MEMBERSHIP_GETTERS = {
    "tenant_id": "get_tenant_id",
    "account_id": "get_account_id",
    "role": "get_role",
}
_LOCKS = {
    "update": "for_update",
    "share": "for_share",
    "update_nowait": "for_update_no_wait",
    "share_nowait": "for_share_no_wait",
}


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
        for index, column in enumerate(sorted(where)):
            if index > 0:
                model.and_()
            if column == "tenant_id":
                model.tenant_id(where[column])
            elif column == "account_id":
                model.account_id(where[column])
            else:
                raise AssertionError(
                    f"CompositeAccount column {column} has no recipe filter"
                )
        return model

    def composite_membership_set(db, values):
        model = models.CompositeMembership().connect(db)
        for column in sorted(values):
            if column == "tenant_id":
                model.set_tenant_id(values[column])
            elif column == "account_id":
                model.set_account_id(values[column])
            elif column == "role":
                model.set_role(values[column])
            else:
                raise AssertionError(
                    f"CompositeMembership column {column} has no recipe setter"
                )
        return model

    def composite_membership_filter(db, where):
        model = models.CompositeMembership().connect(db)
        for index, column in enumerate(sorted(where)):
            if index > 0:
                model.and_()
            if column == "tenant_id":
                model.tenant_id(where[column])
            else:
                raise AssertionError(
                    f"CompositeMembership column {column} has no recipe filter"
                )
        return model

    def composite_tuples(model, tuples, context, after):
        """Narrows the chain by the tuples of the composite key through its generated tuple filter, joined by and to the
        equalities before it when after is true (DSL-82)."""
        if tuples["columns"] != ["tenant_id", "account_id"]:
            raise AssertionError(
                f"CompositeAccount tuple {tuples['columns']} has no recipe filter"
            )
        groups = []
        for tuple_ in tuples["values"]:
            if len(tuple_) != 2:
                raise AssertionError(
                    f"a CompositeAccount tuple has {len(tuple_)} values, not 2"
                )
            groups.append([value_of(item, context) for item in tuple_])
        if after:
            model.and_()
        return model.tuple_tenant_id_with_account_id(groups)

    def composite_membership_relation(relation, db):
        """The CompositeMembership child of a CompositeAccount relation: one match call per pair in the written order,
        connected to the connection of the query when connect is true (INT-87)."""
        if relation["model"] != "CompositeMembership":
            raise AssertionError(
                f"CompositeAccount relation {relation['model']} has no recipe entry"
            )
        child = models.CompositeMembership()
        for pair in relation["match"]:
            if pair == ["tenant_id", "tenant_id"]:
                child = child.match_tenant_id_with_tenant_id()
            elif pair == ["account_id", "account_id"]:
                child = child.match_account_id_with_account_id()
            else:
                raise AssertionError(
                    f"CompositeMembership match {pair} has no recipe entry"
                )
        alias = relation.get("alias")
        if alias == "memberships":
            child = child.alias_memberships()
        elif alias is not None:
            raise AssertionError(
                f"CompositeMembership alias {alias} has no recipe entry"
            )
        if relation["connect"]:
            child = child.connect(db)
        return child

    def composite_membership_children(row, relation):
        """The CompositeMembership rows of one parent: through the generated getter of the alias, or of the result name of a
        relation without one. A parent without a child gives none."""
        many = relation.get("many", False)
        if relation.get("alias") == "memberships":
            result = row.get_memberships()
        elif many:
            result = row.get_composite_membership_models()
        else:
            result = row.get_composite_membership_model()
        if result is None:
            return []
        return list(result.values()) if many else [result]

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
        if step["model"] == "CompositeMembership":
            rows = [
                composite_membership_set(db, values_of(row, context))
                for row in step["rows"]
            ]
            count = (
                models.CompositeMembership().connect(db).creates(rows, step["batch"])
            )
            return {"value": {"int": str(count)}}
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
        if step["model"] == "Author":
            # The row of key, its set columns changed, then one update of the row (Update).
            row = chain(db, values_of(step["key"], context), []).get()
            if row is None:
                raise AssertionError("Author update: the key names no row")
            for column, value in sorted(values_of(step["set"], context).items()):
                if (
                    column == "like_count"
                    and isinstance(value, int)
                    and not isinstance(value, bool)
                ):
                    row.set_like_count(value)
                elif column == "uuid" and isinstance(value, str):
                    row.set_uuid(value)
                else:
                    raise AssertionError(f"Author column {column} has no recipe update")
            row.update()
            return {}
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
        if step["model"] == "User":
            # The User rows of where, which is the seq only (the referenced-user case of constraint_errors).
            where = values_of(step["where"], context)
            if (
                sorted(where) != ["seq"]
                or not isinstance(where["seq"], int)
                or isinstance(where["seq"], bool)
            ):
                raise AssertionError("User delete: the recipe condition is seq only")
            models.User().connect(db).seq(where["seq"]).gets().delete()
            return {}
        composite_filter(db, values_of(step["where"], context)).gets().delete()
        return {}

    def model_count(step, context):
        db = connection(step["connection"], context)
        if step["model"] == "Author":
            return {
                "value": _wrap(
                    chain(db, values_of(step.get("where"), context), []).get_count()
                )
            }
        if step["model"] == "CompositeMembership":
            return {
                "value": {
                    "int": str(
                        composite_membership_filter(
                            db, values_of(step.get("where"), context)
                        ).get_count()
                    )
                }
            }
        return {
            "value": {
                "int": str(
                    composite_filter(
                        db, values_of(step.get("where"), context)
                    ).get_count()
                )
            }
        }

    def model_get_by(step, context):
        db = connection(step["connection"], context)
        if step["model"] == "Author":
            # The key and the where are one chain: the equalities, the projection of columns, then the terminal get.
            where = step["where"] if "where" in step else step["key"]
            found = chain(db, values_of(where, context), step["columns"]).get()
            if found is None:
                return {"rows": []}
            return {
                "rows": [
                    [
                        _wrap(getattr(found, COLUMNS[column][1])())
                        for column in step["columns"]
                    ]
                ]
            }
        if "where" in step:
            raise AssertionError(f"model {step['model']} has no recipe where")
        row = composite_key(db, values_of(step["key"], context))
        if row is None:
            return {"rows": []}
        return {"rows": [[_column_wrap(row, column) for column in step["columns"]]]}

    def note_reader_query(db, step):
        """model.query on NoteReader with its relation to the external SharedNote: each row is the seq of a reader and the
        title of its shared note, and a reader without a note contributes no row (FCV-4)."""
        relation = step.get("relation")
        if relation is None:
            raise AssertionError("NoteReader model.query needs its relation")
        if (
            relation["model"] != "SharedNote"
            or relation["match"] != [["shared_note_seq", "seq"]]
            or relation["columns"] != ["title"]
        ):
            raise AssertionError(f"NoteReader relation {relation} has no recipe entry")
        if step["columns"] != ["seq"] or step["order"] != ["seq"] or step["where"]:
            raise AssertionError("NoteReader query has no recipe entry for this shape")
        m = (
            models.NoteReader()
            .connect(db)
            .relation(models.SharedNote().match_shared_note_seq_with_seq())
            .order_by_seq_asc()
        )
        rows = []
        for row in m.gets().values():
            child = row.get_shared_note_model()
            if child is None:
                continue
            rows.append(
                [_wrap(row.to_array()["seq"]), _wrap(child.to_array()["title"])]
            )
        return {"rows": rows}

    def model_query(step, context):
        db = connection(step["connection"], context)
        if step["model"] == "NoteReader":
            return note_reader_query(db, step)
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
                    [
                        _wrap(getattr(row, COLUMNS[column][1])())
                        for column in step["columns"]
                    ]
                    for row in model.gets().values()
                ]
            }
        where = values_of(step.get("where"), context)
        model = composite_filter(db, where)
        if "tuples" in step:
            model = composite_tuples(model, step["tuples"], context, bool(where))
        for column in step.get("order", []):
            if column not in _COMPOSITE_ORDERS:
                raise AssertionError(
                    f"CompositeAccount column {column} has no recipe order"
                )
            getattr(model, _COMPOSITE_ORDERS[column])()
        # Each child row of the relation gives one output row; a parent row without a child gives none.
        relation = step.get("relation")
        if relation is not None:
            child = composite_membership_relation(relation, db)
            model = (
                model.relations(child)
                if relation.get("many", False)
                else model.relation(child)
            )
        # The lock of a model.query (INT-47): a lock outside a transaction is refused with CONFIG.
        if "lock" in step:
            if step["lock"] not in _LOCKS:
                raise AssertionError(f"lock {step['lock']} is not a lock of the recipe")
            getattr(model, _LOCKS[step["lock"]])()
        out = []
        for row in model.gets().values():
            cells = [_column_wrap(row, column) for column in step["columns"]]
            if relation is None:
                out.append(cells)
                continue
            for child in composite_membership_children(row, relation):
                out.append(
                    cells
                    + [
                        _composite_membership_wrap(child, column)
                        for column in relation["columns"]
                    ]
                )
        return {"rows": out}

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
        if column not in _COMPOSITE_GETTERS:
            raise AssertionError(
                f"CompositeAccount column {column} has no recipe getter"
            )
        return _wrap(getattr(row, _COMPOSITE_GETTERS[column])())

    def _composite_membership_wrap(row, column):
        if column not in _COMPOSITE_MEMBERSHIP_GETTERS:
            raise AssertionError(
                f"CompositeMembership column {column} has no recipe getter"
            )
        return _wrap(getattr(row, _COMPOSITE_MEMBERSHIP_GETTERS[column])())

    def query_search(step, context):
        """query.search (FCV-4, PRT-75): a count with a fulltext_boolean chain key over the columns. The statement is compiled
        with the engine of the case dialect (DIA-187 refuses SQLite); a blank text runs on the case connection, where the bind
        check refuses it with IR_INVALID (DIA-6)."""
        db = connection(step["connection"], context)
        if step["model"] != "Author":
            raise AssertionError(f"model {step['model']} has no query.search entry")
        author = models.Author().connect(db)
        author.core.where_chain(
            "",
            [ChainKey(op="fulltext_boolean", columns=tuple(step["columns"]))],
            [step["text"]],
        )
        built = author.core.build("count")
        plan = Engine(author.core.ent.model.runtime, context["database"]).compile(
            built.finish()
        )
        # The value is the one the statement binds: the transform that the plan declares for its slot (DIA-6 declares
        # fulltext_boolean on MySQL only; PostgreSQL binds the text as it is).
        slots = plan["steps"][0]["bind_slots"]
        boolean = bool(slots) and slots[0]["transform"] == "fulltext_boolean"
        value = fulltext_boolean(step["text"]) if boolean else step["text"]
        if boolean and value == "":
            author.get_count()
            raise AssertionError(
                "query.search ran a blank text without a bind-check error"
            )
        return {"sql": plan["steps"][0]["sql"], "params": [{"text": value}]}

    return {
        "model.connect": model_connect,
        "query.search": query_search,
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
