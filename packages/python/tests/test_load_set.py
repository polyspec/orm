# RuntimeModel.load_set returns the parsed documents of a generated schema value, as PHP's
# RuntimeModel::loadSet does: the documents of the manifest text, then those of the external
# text marked external (T163).
import tempfile
import unittest
from unittest import mock

from polyspec.orm import OrmError, RuntimeModel
from polyspec.orm.database import Db
from polyspec.orm.dbspec.manifest import dbspec_manifest
from polyspec.orm.engine import model as engine_model
from polyspec.orm.model import register_model
from polyspec.orm.schema import Schema
from . import testcase

OWNED = "dbspec 1 shop\n\nuse core { account }\n\ntable item {\n  seq i64\n  account_seq i64\n  primary key (seq)\n  index ix_item_account (account_seq)\n  foreign key fk_item_account (account_seq) references account (seq) on delete restrict on update restrict\n}\n"
SECOND = "dbspec 1 registry\n\ntable note {\n  seq i64\n  primary key (seq)\n}\n"
EXTERNAL = "dbspec 1 core\n\ntable account {\n  seq i64\n  primary key (seq)\n}\n"


class LoadSetTest(unittest.TestCase):
    # Requirements: SCH-12.
    def test_returns_the_documents_with_the_external_ones_marked(self):
        documents = RuntimeModel.load_set(OWNED, EXTERNAL)
        self.assertEqual(
            [(d.name, d.external) for d in documents], [("shop", False), ("core", True)]
        )
        self.assertEqual([t.name for t in documents[0].tables], ["item"])
        with self.assertRaises(OrmError) as caught:
            RuntimeModel.load_set(OWNED, "table account {}\n")
        self.assertEqual(caught.exception.code, "SCHEMA_INVALID")

    def test_an_empty_external_text_has_no_external_document(self):
        self.assertEqual(
            [d.name for d in RuntimeModel.load_set(EXTERNAL, "")], ["core"]
        )

    # Requirements: DBS-156, SCH-12.
    def test_a_text_without_a_header_is_schema_invalid(self):
        with self.assertRaises(OrmError) as caught:
            RuntimeModel.load_set("table item {}\n", "")
        self.assertEqual(caught.exception.code, "SCHEMA_INVALID")


class ModelRegistryTest(unittest.TestCase):
    """A process builds the model of a manifest once (DBS-104): a second registration of the same texts and hash, on any
    connection, and a second load_set of the same texts parse nothing."""

    # Requirements: DBS-104.
    def test_the_same_schema_is_parsed_once(self):
        documents = RuntimeModel.load_set(SECOND, "")
        manifest, diagnostics = dbspec_manifest(documents)
        self.assertEqual(diagnostics, ())
        schema = Schema(manifest.manifest_text, manifest.manifest_hash)
        parse = mock.patch.object(
            engine_model,
            "parse_document_set",
            wraps=engine_model.parse_document_set,
        )
        folder = tempfile.TemporaryDirectory(prefix="orm-model-registry-")
        self.addCleanup(folder.cleanup)
        connections = [Db(f"sqlite://{folder.name}/{i}.sqlite") for i in range(2)]
        try:
            with parse as parsed:
                first = register_model(schema.manifest_text, schema.manifest_hash)
                built = parsed.call_count
                self.assertLessEqual(built, 1)
                register_model(schema.manifest_text, schema.manifest_hash)
                for db in connections:
                    db.register(schema)
                RuntimeModel.load_set(schema.manifest_text, "")
                RuntimeModel.load_set(schema.manifest_text, "")
                self.assertEqual(
                    parsed.call_count, built, "a registered schema is not parsed again"
                )
        finally:
            for db in connections:
                db.close()
        self.assertIs(
            register_model(schema.manifest_text, schema.manifest_hash).runtime,
            first.runtime,
        )

    # Requirements: DBS-104.
    def test_a_known_text_under_another_hash_is_still_refused(self):
        documents = RuntimeModel.load_set(SECOND, "")
        manifest, _ = dbspec_manifest(documents)
        register_model(manifest.manifest_text, manifest.manifest_hash)
        with self.assertRaises(OrmError) as caught:
            register_model(manifest.manifest_text, "sha256:" + "0" * 64)
        self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")


if __name__ == "__main__":
    testcase.main()
