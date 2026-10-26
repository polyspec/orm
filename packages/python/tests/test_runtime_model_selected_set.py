import json
import unittest

from polyspec.orm.engine import model_of_documents, parse_document_set
from . import testcase
from .coverage_case import REPOSITORY_ROOT


class RuntimeModelSelectedSetTest(unittest.TestCase):
    # Requirements: PRT-9, DBS-68.
    def test_default_select_set_excludes_only_select_explicit(self):
        fixture_path = REPOSITORY_ROOT / "contracts/fixtures/bench/dbspec-set.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        owned = [
            (fixture_path.parent / name).read_text(encoding="utf-8")
            for name in fixture["documents"]
        ]
        external = [
            (fixture_path.parent / name).read_text(encoding="utf-8")
            for name in fixture["external"]
        ]
        model = model_of_documents(parse_document_set(owned, external))
        author = model.entities["author"]
        selected = [field.name for field in author.fields if field.selected]
        explicit = [
            "description",
            "email_blind_index",
            "phone_blind_index",
            "ip",
            "gz_extend",
            "json_setting",
            "jsons_tags",
            "base64_extra",
            "serialize_data",
            "aes_key_version",
        ]
        expected = [field.name for field in author.fields if field.name not in explicit]
        self.assertEqual(selected, expected)


if __name__ == "__main__":
    testcase.main()
