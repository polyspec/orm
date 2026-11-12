# The set parse (docs/spec/dbspec.md "Parsing a set"): every text of one document set is named by the
# header its parse reads and parsed with the texts of all other named documents as its use documents.
from __future__ import annotations

import dataclasses
from dataclasses import dataclass

from polyspec.orm.dbspec.model import DbspecDiagnostic, DbspecDocument, DbspecPosition
from polyspec.orm.dbspec.parse import (
    _ParseContext,
    _check_arguments,
    _parse_text,
    parse_dbspec,
)

__all__ = ["DbspecSetDocument", "parse_dbspec_set"]


@dataclass(frozen=True)
class DbspecSetDocument:
    """The result of one text of a set: the name the parser reads from its header, empty when the
    header fails; whether the text is external; and what one parse of the text returns, its
    document and positions or its diagnostics. A text whose name an earlier text has is not parsed
    and carries the one diagnostic name.duplicate."""

    name: str
    external: bool
    document: DbspecDocument | None
    positions: list[DbspecPosition] | None
    diagnostics: list[DbspecDiagnostic]


def _header_name(text: str) -> str:
    # The name the parser's header step reads; empty when the header fails.
    return _parse_text(text, _ParseContext({}), []).document.name


def parse_dbspec_set(owned, external) -> tuple[DbspecSetDocument, ...]:
    """Parses the texts of one document set (docs/spec/dbspec.md "Parsing a set"), one result per text,
    owned first, each in set order. A text whose name an earlier text has is not parsed and its
    result carries name.duplicate; every other text is parsed with
    the texts of all other named documents as the documents its use lines name."""
    entries = [(text, False) for text in owned] + [(text, True) for text in external]
    names = []
    named = {}
    parse = []
    results = {}
    for index, (text, is_external) in enumerate(entries):
        _check_arguments(text, {})
        name = _header_name(text)
        names.append(name)
        if name != "":
            if name in named:
                results[index] = (
                    None,
                    None,
                    [
                        DbspecDiagnostic(
                            "name.duplicate",
                            1,
                            10,
                            f"document {name} appears twice in the document set",
                        )
                    ],
                )
                continue
            named[name] = text
        parse.append(index)
    for index in parse:
        text, is_external = entries[index]
        others = {n: t for n, t in named.items() if n != names[index]}
        document, positions, found = parse_dbspec(text, others)
        if document is not None:
            document = dataclasses.replace(document, external=is_external)
        results[index] = (document, positions, found)
    return tuple(
        DbspecSetDocument(names[i], is_external, *results[i])
        for i, (_text, is_external) in enumerate(entries)
    )
