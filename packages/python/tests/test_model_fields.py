# Generated models type their fields with the value types of docs/dbspec.md "Runtime model", as the Go, PHP, TypeScript
# and Rust models do: each getter returns the type of its column, None for a null column, and each setter takes it; a
# getter whose value has another type raises TypeError, as a typed PHP getter and a TypeScript getter do. The cases
# read the committed bench models (polyspec.orm.models.models) through typing.get_type_hints.
import datetime
import typing
import unittest

from polyspec.orm import StyledValue
from polyspec.orm.models import models
from . import testcase

# (model, column, getter type, setter type) for every column category of the bench models.
CASES = [
    (models.Author, "seq", int, int),
    (models.Author, "target_club_reader_count", int, int),
    (models.Author, "is_close", bool, bool),
    (models.Author, "name", str, str),
    (models.Author, "description", str | None, str | None),
    (models.Author, "price", str | None, str | None),
    (models.Author, "created_ts", str, str | datetime.date),
    (models.Author, "display_start_dt", str | None, str | datetime.date | None),
    (models.Author, "aes_hex_email", str | None, str | None),
    (models.Author, "ip", str | None, str | None),
    (models.Author, "gz_extend", StyledValue, StyledValue),
    (models.Author, "json_setting", StyledValue, StyledValue),
    (models.TimeCell, "clock", str, str),
]


class ModelFieldsTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def test_field_types(self):
        for model, column, getter, setter in CASES:
            with self.subTest(column=f"{model.__name__}.{column}"):
                got = typing.get_type_hints(getattr(model, f"get_{column}"))
                self.assertEqual(got.get("return"), getter, "the getter type")
                hints = typing.get_type_hints(getattr(model, f"set_{column}"))
                self.assertEqual(hints.get("value"), setter, "the setter type")

    def test_getter_checks_its_value(self):
        author = models.Author()
        author.core.values["seq"] = "7"
        with self.assertRaisesRegex(
            TypeError, r"^author\.seq holds a value of type str, not int$"
        ):
            author.get_seq()
        author.core.values["seq"] = True
        with self.assertRaisesRegex(TypeError, r"holds a value of type bool, not int"):
            author.get_seq()
        author.core.values["seq"] = 7
        self.assertEqual(author.get_seq(), 7)
        author.core.values["description"] = None
        self.assertIsNone(author.get_description())
        author.core.values["name"] = None
        with self.assertRaisesRegex(
            TypeError, r"^author\.name holds a value of type NoneType, not str$"
        ):
            author.get_name()


if __name__ == "__main__":
    testcase.main()
