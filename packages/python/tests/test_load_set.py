# RuntimeModel.load_set returns the parsed documents of a generated schema value, as PHP's
# RuntimeModel::loadSet does: the documents of the manifest text, then those of the external
# text marked external (T163).
import unittest

from polyspec.orm import OrmError, RuntimeModel
from . import testcase

OWNED = "dbspec 1 shop\n\nuse core { account }\n\ntable item {\n  seq i64\n  account_seq i64\n  primary key (seq)\n  index ix_item_account (account_seq)\n  foreign key fk_item_account (account_seq) references account (seq) on delete restrict on update restrict\n}\n"
EXTERNAL = "dbspec 1 core\n\ntable account {\n  seq i64\n  primary key (seq)\n}\n"


class LoadSetTest(unittest.TestCase):
    def test_returns_the_documents_with_the_external_ones_marked(self):
        documents = RuntimeModel.load_set(OWNED, EXTERNAL)
        self.assertEqual(
            [(d.name, d.external) for d in documents], [("shop", False), ("core", True)]
        )
        self.assertEqual([t.name for t in documents[0].tables], ["item"])

    def test_an_empty_external_text_has_no_external_document(self):
        self.assertEqual(
            [d.name for d in RuntimeModel.load_set(EXTERNAL, "")], ["core"]
        )

    def test_a_text_without_a_header_is_schema_invalid(self):
        with self.assertRaises(OrmError) as caught:
            RuntimeModel.load_set("table item {}\n", "")
        self.assertEqual(caught.exception.code, "SCHEMA_INVALID")


if __name__ == "__main__":
    testcase.main()
