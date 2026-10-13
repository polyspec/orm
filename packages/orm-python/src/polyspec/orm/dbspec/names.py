"""The names that the renderer writes (docs/dbspec.md "Names"): the plain form
<table>$<suffix> when it has at most 63 bytes, otherwise its first 54 bytes, a $
and the first 8 lowercase hexadecimal digits of its SHA-256."""
import hashlib
import re

MAX_NAME_BYTES = 63
_HASH_DIGITS = 8
_PREFIX_BYTES = MAX_NAME_BYTES - 1 - _HASH_DIGITS
_NAME = re.compile(r'[a-z][a-z0-9_]*\Z')


def _resolved(name: str) -> bool:
    return _NAME.match(name) is not None and len(name.encode('utf-8')) <= MAX_NAME_BYTES


def renderer_name(table: str, suffix: str) -> str:
    """The name that the renderer writes for the suffix (a column or an event) of table."""
    plain = f'{table}${suffix}'
    if len(plain.encode('utf-8')) <= MAX_NAME_BYTES:
        return plain
    digest = hashlib.sha256(plain.encode('utf-8')).hexdigest()
    return f'{plain[:_PREFIX_BYTES]}${digest[:_HASH_DIGITS]}'


def rendered_column(table: str, name: str, columns) -> 'str | None':
    """The column among columns whose renderer name is name, or None. Recomputes each
    name; never splits name on $."""
    for column in columns:
        if renderer_name(table, column) == name:
            return column
    return None


def generated_names(table) -> list:
    """The renderer names of a parsed table as (name, token-or-None) pairs: the type CHECK of
    each column that has one, and the triggers of immutable and audit. A table or a column
    whose name is malformed has none."""
    if not _resolved(table.name.t):
        return []
    out = []
    for column in table.columns:
        if column.identity is None and column.type is not None \
                and column.type.kind not in ('text', 'bytes') and _resolved(column.name.t):
            out.append((renderer_name(table.name.t, column.name.t), column.name))
    settings = table.settings.entries if table.settings is not None else []
    for s in settings:
        events = {'immutable': ('immutable_update', 'immutable_delete'),
                  'audit': ('audit_insert', 'audit_update', 'audit_delete')}.get(s.kind, ())
        for event in events:
            out.append((renderer_name(table.name.t, event), s.kw))
    return out
