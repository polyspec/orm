# SchemaUtils.install of a set whose document has use lines: the schema text of the set keeps the
# use lines of its external documents, and install compares the database with it like any other
# set (packages/orm-npm/src/dbspec/compare.ts isSchemaText, docs/schema.md "Schema installation").
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.dbspec import parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.compare import is_schema_text  # noqa: E402
from polyspec.orm.engine.model import model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.schema import Schema  # noqa: E402

AUDIT = ('dbspec 1 audit\n\n'
         'table audit {\n  seq i64 identity\n  action varchar(64)\n  primary key (seq)\n}\n')
REQUESTS = ('dbspec 1 requests\n\nuse audit { audit }\n\n'
            'table ip_block {\n  seq i64 identity\n  audit_seq i64\n  primary key (seq)\n'
            '  index ix_ip_block_audit (audit_seq)\n'
            '  foreign key fk_ip_block_audit (audit_seq) references audit (seq) on delete restrict on update restrict\n'
            '}\n')


def schema_of(texts, external_texts=()) -> Schema:
    model = model_of_documents(parse_document_set(texts, external_texts))
    return Schema(manifest_text=model.manifest_text, manifest_hash=model.manifest_hash,
                  external_text=model.external_text)


class SchemaInstallUsesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='orm-schema-uses-')
        self.addCleanup(self.tmp.cleanup)

    def test_a_schema_text_with_use_lines_is_a_schema_text(self):
        document, diagnostics = parse_dbspec(
            'dbspec 1 schema\n\nuse audit { audit }\n\n'
            'table ip_block {\n  seq i64 identity\n  primary key (seq)\n}\n', {'audit': AUDIT})
        self.assertEqual(list(diagnostics), [])
        self.assertTrue(is_schema_text(document))

    def test_installs_a_set_that_uses_an_external_document(self):
        path = os.path.join(self.tmp.name, 'uses.sqlite3')
        audit = schema_of([AUDIT])
        db = Db.connect_schema(f'sqlite://{path}', audit)
        try:
            db.utils().schema().install(audit)
        finally:
            db.close()
        requests = schema_of([REQUESTS], [AUDIT])
        db = Db.connect_schema(f'sqlite://{path}', requests)
        try:
            db.utils().schema().install(requests)
            # 두 번째 install은 같은 database를 확인만 한다(idempotent).
            db.utils().schema().install(requests)
        finally:
            db.close()
        with sqlite3.connect(path) as conn:
            tables = sorted(r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('audit', 'ip_block')"))
        self.assertEqual(tables, ['audit', 'ip_block'])


if __name__ == '__main__':
    unittest.main()
