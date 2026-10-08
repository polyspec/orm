# dbspec: 이 저장소의 schema 언어 (docs/dbspec.md). read_dbspec_file은 signature를
# 확인하고 문서 파일을 읽는다. parse_dbspec는 문서를 선언된 문서 집합과 함께 검사하고,
# emit_dbspec는 parse된 문서를 canonical form으로 쓴다. dbspec_manifest는 문서 집합의
# manifest text, schema text와 그 hash를 낸다.
from polyspec.orm.dbspec.emit import CANONICAL, MANIFEST, SCHEMA, default_text, emit_document, \
    type_text
from polyspec.orm.dbspec.file import DBSPEC_SIGNATURE, read_dbspec_bytes, read_dbspec_file
from polyspec.orm.dbspec.manifest import check_set, dbspec_manifest, external_differences
from polyspec.orm.dbspec.model import DbspecColumn, DbspecDefault, DbspecDiagnostic, \
    DbspecDocument, DbspecTable, DbspecType
from polyspec.orm.dbspec.parse import RESERVED, parse_document, parse_dbspec, valid_name, \
    well_formed

__all__ = ['CANONICAL', 'DBSPEC_SIGNATURE', 'MANIFEST', 'RESERVED', 'SCHEMA',
           'DbspecColumn', 'DbspecDefault', 'DbspecDiagnostic', 'DbspecDocument',
           'DbspecTable', 'DbspecType', 'check_set', 'default_text', 'dbspec_manifest',
           'emit_dbspec', 'emit_document', 'external_differences', 'parse_document',
           'parse_dbspec', 'read_dbspec_bytes', 'read_dbspec_file', 'type_text',
           'valid_name', 'well_formed']


def emit_dbspec(document: DbspecDocument) -> str:
    """문서를 canonical form으로 쓴다: parse된 canonical text를 다시 쓰면 같은 text다."""
    return emit_document(document, CANONICAL)
