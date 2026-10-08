"""add_tables_and_columns_steps: the add-only steps that take an installed set to a newer schema
version, as packages/orm-npm/src/dbspec/add_tables_and_columns.ts computes them. Tables are created
and columns and indexes added; anything else is a difference and no step (docs/schema.md "Adding
tables and columns")."""
from __future__ import annotations

from polyspec.orm.dbspec.emit import CANONICAL, emit_document
from polyspec.orm.dbspec.model import DbspecDocument, Unsupported
from polyspec.orm.dbspec.installed import compare_set, qualified
from polyspec.orm.dbspec.manifest import dbspec_manifest
from polyspec.orm.dbspec.plan import plan_to
from polyspec.orm.dbspec.plan_steps import plan_steps


def add_tables_and_columns_steps(live: DbspecDocument, unsupported: list[Unsupported], target: DbspecDocument, dialect: str) -> dict:
    """The names added (tables, then their added columns and indexes in order), the steps that add
    them, and the differences that refuse the upgrade (the steps are empty then)."""
    declared, source, comparison, differences = compare_set(live, unsupported, target)

    def none() -> dict:
        return {'added': [], 'steps': [], 'differences': differences}

    if source is None or comparison is None:
        return none()
    adding: set = set()
    for d in comparison['differences'] or []:
        kind, table, name = d['kind'], d['table'], d['name']
        if kind == 'create_table':
            adding.add(table)
            continue
        if kind == 'add_column':
            column = next((c for c in declared[table].columns if c.name == name), None)
            if column is None or column.identity or (not column.nullable and column.default is None):
                differences.append(f'add_column {qualified(table, name)} without null or default')
                continue
            adding.add(qualified(table, name))
            continue
        if kind == 'add_index':
            # an index does not refuse the existing rows, so it is added to a table that exists too
            adding.add(qualified(table, name))
            continue
        if kind == 'add_unique':
            # a unique key can fail on the existing rows, so the plan and apply handle it
            differences.append(f'add_unique {qualified(table, name)}: a missing unique key can fail on the '
                               f'existing rows; add it with a plan')
            continue
        differences.append(f'{kind} {qualified(table, name)}')
    if differences or not adding:
        return none()
    # the added tables and columns and indexes: table name order, then column order, then index order
    added: list = []
    for t in target.tables:
        if t.name in adding:
            added.append(t.name)
            continue
        names = [qualified(t.name, c.name) for c in t.columns] + [qualified(t.name, i.name) for i in t.indexes]
        added.extend(n for n in names if n in adding)
    failed: list = []
    from_hash = None
    if len(source.tables) > 0:
        manifest, diagnostics = dbspec_manifest([source])
        failed = list(diagnostics)
        if manifest is not None:
            from_hash = manifest.schema_hash
    steps: list = []
    if not failed:
        # the target may be the schema text of a set that uses external documents, so the plan is
        # made from the target document and not parsed from text
        planned = plan_to({'name': 'add_tables_and_columns', 'from': from_hash, 'rename_tables': [],
                           'rename_columns': [], 'drop_tables': [], 'drop_columns': []},
                          target, emit_document(target, CANONICAL))
        failed = list(planned['diagnostics'])
        if planned['plan'] is not None:
            written = plan_steps(source if len(source.tables) > 0 else None, planned['plan'], dialect)
            failed = list(written['diagnostics'])
            steps = written['steps'] or []
    for d in failed:
        differences.append(f'{d.rule}: {d.message}')
    if differences:
        return none()
    return {'added': added, 'steps': steps, 'differences': []}
