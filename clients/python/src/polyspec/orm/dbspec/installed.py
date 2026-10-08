"""installed_differences: the differences between the document of an installed set and the target
schema of the set, as clients/typescript/src/dbspec/add_tables_and_columns.ts lists them. Only the
tables that the set declares are compared; an object the introspection could not read in such a
table is a difference by itself, and then the table is not compared (docs/schema.md "Schema
installation")."""
from polyspec.orm.dbspec.compare import compare_schemas
from polyspec.orm.dbspec.model import DbspecDocument


def qualified(table: str, name: str) -> str:
    return table if name == '' else f'{table}.{name}'


def schema_document(tables) -> DbspecDocument:
    return DbspecDocument('schema', (), tuple(tables), (), ())


def compare_set(live: DbspecDocument, unsupported, target: DbspecDocument):
    """Returns the declared tables by name, the source document of the set's tables in the database,
    the comparison (or None) and the differences so far."""
    declared = {t.name: t for t in target.tables}
    differences: list = []
    for u in unsupported:
        if u['table'] in declared:
            differences.append(f"unsupported_{u['kind']} {qualified(u['table'], u['name'])}: {u['reason']}")
    if differences:
        return declared, None, None, differences
    source = schema_document([t for t in live.tables if t.name in declared])
    comparison = compare_schemas(source, target)
    for d in comparison['diagnostics']:
        differences.append(f'{d.rule}: {d.message}')
    return declared, source, comparison, differences


def installed_differences(live: DbspecDocument, unsupported, target: DbspecDocument) -> list:
    """The differences of the installed set `live` (its introspected document and the objects it
    could not read) from the set's `target` schema text, as "<kind> <table>[.<name>]" lines."""
    _, _, comparison, differences = compare_set(live, unsupported, target)
    for d in (comparison['differences'] or []) if comparison is not None else []:
        differences.append(f"{d['kind']} {qualified(d['table'], d['name'])}")
    return differences
