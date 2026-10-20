# An update or delete with an expected revision (docs/spec/dsl.md "Writes", expect_revision) on a SQLite file of each
# case: a match updates and bumps the revision or deletes, a mismatch fails with REVISION_CHANGED and changes nothing.
import tempfile
import unittest
from pathlib import Path

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

from .test_sqlite import generate_document
from . import testcase

DOCUMENT = "dbspec 1 revision\n\ntable note {\n  seq i64 identity\n  label varchar(32)\n  revision i64\n  primary key (seq)\n}\n"


class RevisionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-revision-")
        cls.addClassCleanup(tmp.cleanup)
        cls.work = Path(tmp.name)
        document = cls.work / "revision.dbs"
        document.write_text(DOCUMENT, encoding="utf-8")
        cls.models = generate_document(str(cls.work / "models"), document)

    def setUp(self):
        self.db = self.models.connect(
            f"sqlite://{self.work}/{self._testMethodName}.sqlite3"
        )
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)
        self.seq = (
            self.models.Note()
            .connect(self.db)
            .set_label("first")
            .set_revision(3)
            .create()
            .get_seq()
        )

    def stored(self):
        return [
            (row.get_label(), row.get_revision())
            for row in self.models.Note().connect(self.db).gets()
        ]

    def code(self, fn):
        try:
            fn()
        except OrmError as e:
            return e.code
        return None

    # The test of DSL-108, DSL-114 (docs/spec).
    def test_update_match_bumps_the_revision(self):
        self.models.Note().connect(self.db).set_seq(self.seq).set_label(
            "second"
        ).expect_revision("revision", 3).update()
        self.assertEqual(self.stored(), [("second", 4)])

    # The test of DSL-108, DSL-114 (docs/spec).
    def test_update_mismatch_changes_nothing(self):
        note = self.models.Note().connect(self.db).set_seq(self.seq).set_label("stale")
        self.assertEqual(
            self.code(lambda: note.expect_revision("revision", 2).update()),
            codes.REVISION_CHANGED,
        )
        self.assertEqual(self.stored(), [("first", 3)])

    # The test of DSL-108, DSL-114 (docs/spec).
    def test_delete_match_deletes(self):
        self.models.Note().connect(self.db).set_seq(self.seq).expect_revision(
            "revision", 3
        ).delete()
        self.assertEqual(self.stored(), [])

    # The test of DSL-108, DSL-114 (docs/spec).
    def test_delete_mismatch_changes_nothing(self):
        note = self.models.Note().connect(self.db).set_seq(self.seq)
        self.assertEqual(
            self.code(lambda: note.expect_revision("revision", 4).delete()),
            codes.REVISION_CHANGED,
        )
        self.assertEqual(self.stored(), [("first", 3)])


if __name__ == "__main__":
    testcase.main()
