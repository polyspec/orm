# dbspec: this repository's schema language (docs/spec/dbspec.md). read_dbspec_file checks the signature
# and reads the document file. parse_dbspec checks the document together with its declared document set,
# emit_dbspec writes a parsed document in canonical form. dbspec_manifest produces the manifest text of the document set,
# the schema text, and their hashes.
from polyspec.orm.dbspec.emit import (
    CANONICAL,
    MANIFEST,
    SCHEMA,
    default_text,
    emit_document,
    type_text,
)
from polyspec.orm.dbspec.render import (
    UUID_PATTERN,
    Renderer,
    render_dbspec,
    render_dbspec_statements,
)
from polyspec.orm.dbspec.installed import installed_differences
from polyspec.orm.dbspec.add_tables import add_tables_and_columns_steps
from polyspec.orm.dbspec.file import (
    DBSPEC_SIGNATURE,
    read_dbspec_bytes,
    read_dbspec_file,
)
from polyspec.orm.dbspec.set_file import (
    DBSPEC_SET_NAME,
    DbspecSet,
    DbspecSetError,
    DbspecSetFile,
    read_dbspec_set,
)
from polyspec.orm.dbspec.set_parse import DbspecSetDocument, parse_dbspec_set
from polyspec.orm.dbspec.manifest import (
    check_set,
    dbspec_manifest,
    external_differences,
)
from polyspec.orm.dbspec.model import (
    DbspecAnalysis,
    DbspecColumn,
    DbspecDefault,
    DbspecDiagnostic,
    DbspecDocument,
    DbspecPosition,
    DbspecTable,
    DbspecToken,
    DbspecType,
)
from polyspec.orm.dbspec.parse import (
    RESERVED,
    analyze_dbspec,
    format_dbspec,
    parse_document,
    parse_dbspec,
    valid_name,
    well_formed,
)

__all__ = [
    "CANONICAL",
    "add_tables_and_columns_steps",
    "installed_differences",
    "DBSPEC_SET_NAME",
    "DBSPEC_SIGNATURE",
    "DbspecSet",
    "DbspecSetDocument",
    "DbspecSetError",
    "DbspecSetFile",
    "MANIFEST",
    "RESERVED",
    "SCHEMA",
    "UUID_PATTERN",
    "DbspecAnalysis",
    "DbspecColumn",
    "DbspecToken",
    "analyze_dbspec",
    "format_dbspec",
    "DbspecDefault",
    "DbspecDiagnostic",
    "DbspecDocument",
    "DbspecPosition",
    "DbspecTable",
    "DbspecType",
    "Renderer",
    "check_set",
    "default_text",
    "dbspec_manifest",
    "emit_dbspec",
    "emit_document",
    "external_differences",
    "parse_document",
    "parse_dbspec",
    "read_dbspec_bytes",
    "read_dbspec_file",
    "parse_dbspec_set",
    "read_dbspec_set",
    "render_dbspec",
    "render_dbspec_statements",
    "type_text",
    "valid_name",
    "well_formed",
]


def emit_dbspec(document: DbspecDocument) -> str:
    """Writes the document in canonical form: rewriting the parsed canonical text yields the same text."""
    return emit_document(document, CANONICAL)
